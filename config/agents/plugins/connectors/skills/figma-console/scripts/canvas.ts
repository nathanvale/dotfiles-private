// The only JavaScript reaching Console is generated here. Caller input is
// serialized data; no caller supplies source, a config path, or an endpoint.
import { bare, canonical, ConsoleRefusal, type Data, finite, NODE_ID, record } from "./model.ts";
import type { Profile } from "./profile.ts";

export const WRITES = ["create_text", "update_text", "create_variants", "create_tokens", "update_variable", "bind_fill"] as const;
export type CanvasWrite = typeof WRITES[number];
export type WriteName = CanvasWrite | "session_start" | "session_stop";
const scopes: Readonly<Record<string, readonly string[]>> = {
	FLOAT: ["GAP", "WIDTH_HEIGHT", "CORNER_RADIUS", "STROKE_FLOAT", "OPACITY", "FONT_SIZE", "LINE_HEIGHT", "LETTER_SPACING", "PARAGRAPH_SPACING", "PARAGRAPH_INDENT"],
	COLOR: ["TEXT_FILL", "FRAME_FILL", "SHAPE_FILL", "STROKE_COLOR", "EFFECT_COLOR"],
	STRING: ["TEXT_CONTENT", "FONT_FAMILY", "FONT_STYLE"],
	BOOLEAN: ["ALL_SCOPES"],
};
const keys = (input: Data, required: string[], optional: string[] = []): boolean => required.every((key) => input[key] !== undefined) && Object.keys(input).every((key) => required.includes(key) || optional.includes(key));
const node = (value: unknown): boolean => bare(value, NODE_ID);
const text = (value: unknown): boolean => typeof value === "string" && value.length > 0 && value.length <= 10000;
const rgb = (value: unknown): boolean => record(value) && keys(value, ["r", "g", "b"], ["a"]) && Object.values(value).every((item) => finite(item) && item >= 0 && item <= 1);
function token(value: unknown): boolean {
	if (!record(value) || !keys(value, ["name", "type", "value", "scopes"]) || !text(value.name) || typeof value.type !== "string") return false;
	const allowed = scopes[value.type];
	if (!allowed || !Array.isArray(value.scopes) || value.scopes.length === 0 || !value.scopes.every((scope: unknown) => typeof scope === "string" && allowed.includes(scope))) return false;
	return value.type === "COLOR" ? rgb(value.value) : value.type === "FLOAT" ? finite(value.value) : value.type === "STRING" ? text(value.value) : typeof value.value === "boolean";
}

const fontSize = (value: unknown): boolean => finite(value) && value > 0 && value <= 512;
const variants = (value: unknown): boolean => Array.isArray(value) && value.length >= 2 && value.length <= 10 && value.every(text) && new Set(value).size === value.length;
const tokens = (value: unknown): boolean => Array.isArray(value) && value.length > 0 && value.length <= 30 && value.every(token);
const alias = (value: unknown): boolean => record(value) && keys(value, ["type", "id"]) && value.type === "VARIABLE_ALIAS" && node(value.id);
const variableValue = (value: unknown): boolean => finite(value) || typeof value === "boolean" || text(value) || rgb(value) || alias(value);
// Each admitted write names its exact keys and one rule per key.
const INPUTS: Readonly<Record<WriteName, Readonly<Record<string, (value: unknown) => boolean>>>> = {
	session_start: {},
	session_stop: {},
	create_text: { parentId: node, text, name: text, fontFamily: text, fontStyle: text, fontSize },
	update_text: { nodeId: node, text, fontFamily: text, fontStyle: text, fontSize },
	create_variants: { parentId: node, name: text, variants },
	create_tokens: { collection: text, tokens },
	update_variable: { variableId: node, modeId: node, value: variableValue },
	bind_fill: { nodeId: node, variableId: node },
};

export function validateWrite(operation: string, input: Data): operation is WriteName {
	if (!Object.hasOwn(INPUTS, operation)) return false;
	const rules = Object.entries(INPUTS[operation as WriteName]);
	return keys(input, rules.map(([key]) => key)) && rules.every(([key, rule]) => rule(input[key]));
}

// Scope is the observed container for creation, not a caller-provided lock ID.
export function objectId(operation: WriteName, input: Data): string {
	if (operation === "session_start" || operation === "session_stop") return "session";
	if (operation === "create_tokens") return `collection:${input.collection}`;
	if (operation === "update_variable") return `variable:${input.variableId}`;
	return `node:${input.nodeId ?? input.parentId}`;
}

function guard(profile: Profile, identity: boolean): string {
	return `const expected = ${canonical({ fileKey: profile.fileKey, userId: profile.userId })};
if (figma.fileKey !== expected.fileKey) throw new Error("connector:file-mismatch");
${identity ? 'let user; try { user = figma.currentUser; } catch { throw new Error("connector:desktop-identity-unverified"); }\nif (!user || user.id !== expected.userId) throw new Error("connector:desktop-identity-mismatch");' : ""}`;
}

// Snapshots retain all text roles in the target subtree and fresh Plugin API
// variables. They are baseline/readback evidence, never a parity acceptance.
// Ordering is by UTF-16 code unit on both sides: the plugin sandbox and Bun
// need not agree on locale collation.
const SNAPSHOT = `function order(a,b){return a<b?-1:a>b?1:0;}
async function observe() {
const variables = await figma.variables.getLocalVariablesAsync();
const collections = await figma.variables.getLocalVariableCollectionsAsync();
const vv = variables.map(v => ({id:v.id,name:v.name,resolvedType:v.resolvedType,scopes:v.scopes,valuesByMode:v.valuesByMode,variableCollectionId:v.variableCollectionId})).sort((a,b)=>order(a.id,b.id));
const cc = collections.map(c=>({id:c.id,name:c.name,modes:c.modes,defaultModeId:c.defaultModeId})).sort((a,b)=>order(a.id,b.id));
async function tree(n, depth) {
if (!n) return null; if(depth > 8) throw new Error("connector:snapshot-incomplete");
const result = {id:n.id,type:n.type,name:n.name};
for (const key of ["width","height","x","y","paddingTop","paddingRight","paddingBottom","paddingLeft","itemSpacing","layoutMode","characters","fontName","fontSize","fills","boundVariables"]) {
const v = n[key]; if(v !== undefined) result[key] = typeof v === "symbol" ? {kind:"mixed"} : v;
}
if ("children" in n) result.children = await Promise.all(n.children.map(c=>tree(c,depth+1)));
return result;
}
const id = input.nodeId || input.parentId;
const target = id ? await figma.getNodeByIdAsync(id) : null;
if(id && !target) throw new Error("connector:node-missing");
return {fileKey:figma.fileKey,source:"plugin-api-current",cached:false,variables:vv,collections:cc,node:await tree(target,0)};
}`;

// Each mutation reads its last value, checks the receipt's fence, then makes
// every effect synchronously, so an adjudication that fenced the receipt can
// never be overtaken by a mutation still running after its reply was lost.
const FENCE = `if (await figma.clientStorage.getAsync(fenceKey)) throw new Error("connector:fenced");`;
const MUTATE: Readonly<Record<CanvasWrite, string>> = {
	create_text: `const parent = await figma.getNodeByIdAsync(input.parentId); if (!parent || !("appendChild" in parent)) throw new Error("connector:parent-invalid"); await figma.loadFontAsync({family:input.fontFamily,style:input.fontStyle}); ${FENCE} const n=figma.createText(); parent.appendChild(n); n.name=input.name; n.fontName={family:input.fontFamily,style:input.fontStyle}; n.fontSize=input.fontSize; n.characters=input.text; return {created:[n.id]};`,
	update_text: `const n=await figma.getNodeByIdAsync(input.nodeId); if(!n || n.type!=="TEXT") throw new Error("connector:text-required"); await figma.loadFontAsync({family:input.fontFamily,style:input.fontStyle}); ${FENCE} n.fontName={family:input.fontFamily,style:input.fontStyle}; n.fontSize=input.fontSize; n.characters=input.text; return {updated:n.id};`,
	create_variants: `const parent=await figma.getNodeByIdAsync(input.parentId); if(!parent || !("appendChild" in parent)) throw new Error("connector:parent-invalid"); ${FENCE} const nodes=input.variants.map((v,i)=>{const n=figma.createComponent();parent.appendChild(n);n.name="State="+v;n.x=i*260;n.resize(240,48);return n;}); const set=figma.combineAsVariants(nodes,parent);set.name=input.name;return {created:[set.id,...nodes.map(n=>n.id)]};`,
	create_tokens: `${FENCE} const c=figma.variables.createVariableCollection(input.collection); const created=[];for(const t of input.tokens){const v=figma.variables.createVariable(t.name,c,t.type);v.scopes=t.scopes;v.setValueForMode(c.defaultModeId,t.value);created.push(v.id);}return {created,collectionId:c.id};`,
	update_variable: `const v=await figma.variables.getVariableByIdAsync(input.variableId); if(!v)throw new Error("connector:variable-missing");const c=await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);if(!c || !c.modes.some(m=>m.modeId===input.modeId))throw new Error("connector:mode-missing");${FENCE} v.setValueForMode(input.modeId,input.value);return {updated:v.id};`,
	bind_fill: `const n=await figma.getNodeByIdAsync(input.nodeId);const v=await figma.variables.getVariableByIdAsync(input.variableId);if(!n || !("fills" in n) || !v || v.resolvedType!=="COLOR")throw new Error("connector:fill-target-invalid");${FENCE} n.fills=[figma.variables.setBoundVariableForPaint({type:"SOLID",color:{r:0,g:0,b:0}},"color",v)];return {updated:n.id};`,
};

export function snapshotScript(profile: Profile, input: Data, identity = false): string {
	return `${guard(profile, identity)}\nconst input=${canonical(input)};\n${SNAPSHOT}\nreturn await observe();`;
}

// The receipt's fence lives in the bridge's own client storage on this
// device; it never changes the file.
const fence = (receiptId: string) => `const fenceKey=${JSON.stringify(`figma-console-fence:${receiptId}`)};`;

// Adjudication fences the receipt before it observes, so whatever it sees
// cannot be changed afterwards by that receipt's mutation.
export function fenceScript(profile: Profile, input: Data, receiptId: string): string {
	return `${guard(profile, true)}\nconst input=${canonical(input)};\n${fence(receiptId)}\n${SNAPSHOT}\nawait figma.clientStorage.setAsync(fenceKey, true);\nreturn await observe();`;
}

export function mutationScript(profile: Profile, operation: CanvasWrite, input: Data, baseline: unknown, receiptId: string): string {
	if (!validateWrite(operation, input)) throw new ConsoleRefusal("input-invalid");
	// Compare the complete current snapshot inside the SAME invocation before
	// the first effect. No structured write can fall back to the active file.
	return `${guard(profile, true)}\nconst input=${canonical(input)};\n${fence(receiptId)}\n${SNAPSHOT}
function stable(v){return JSON.stringify(v,(_k,x)=>x && typeof x==="object" && !Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>order(a,b))):x);}
if(stable(await observe())!==${JSON.stringify(canonical(baseline))})throw new Error("connector:baseline-changed");
async function mutate(){${MUTATE[operation]}}
const result=await mutate();return {result,after:await observe()};`;
}
