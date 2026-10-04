// Figma's closed operation catalogue: every hosted tool the adapter reaches,
// whether it reads or writes, and for each write the exact input shape, the
// object it acts on, the read that observes that object, and the evidence
// class that settles it. Tool names and input keys come from Figma's
// documented catalog and the authenticated tools/list of 2026-10-05. The
// registry's allow-list restates exactly these names.
//
// Not yet admitted, and still required: generate_figma_design (its effect is
// a provider-supplied capture script run in a browser outside this adapter)
// and weave_upload_asset (no admitted read observes a Weave asset). ADR 0005
// records the contract change each needs. upload_assets runs through the
// adapter-owned outbox in uploads.ts.
import { createHash } from "node:crypto";

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const short = (text: string): string => sha256(text).slice(0, 16);

export const SERVER = "figma-connectors";

export type Input = Readonly<Record<string, unknown>>;
export interface Call {
	readonly tool: string;
	readonly args: Record<string, unknown>;
}

// How a write is settled from read-back:
// marks: every requested value appears in the observed object.
// version: the observed object's version moved from the baseline.
// canceled: every observed run reports CANCELED.
// new-id: exactly one identifier outside the baseline, carrying the marks.
// reply-target: the reply names a created file that a read then finds.
// weave-run: the reply names runs a read then finds, or a quote that spent nothing.
// upload: uploads.ts observes the target page or nodes itself.
export type EvidenceClass = "marks" | "version" | "canceled" | "new-id" | "reply-target" | "weave-run" | "upload";

export interface WriteSpec {
	readonly keys: KeySpec;
	identity(input: Input): string;
	observe(input: Input): Call;
	marks(input: Input): string[];
	// Values the baseline must already show, such as the destination plan.
	require?(input: Input): string[];
	readonly evidence: EvidenceClass;
	// Arguments sent to Figma: the input less adapter-only keys.
	send?(input: Input): Record<string, unknown>;
	// A further input check the key shapes cannot express.
	valid?(input: Input): boolean;
	// The observing read sees only part of the object, so an unchanged read
	// never proves the write had no effect.
	readonly partial?: boolean;
}

export type Check = (value: unknown) => boolean;
export interface KeySpec {
	readonly required: Readonly<Record<string, Check>>;
	readonly optional: Readonly<Record<string, Check>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text: Check = (value) => typeof value === "string" && value.length > 0;
const integer: Check = (value) => Number.isInteger(value);
const number: Check = (value) => typeof value === "number" && Number.isFinite(value);
const object: Check = (value) => isRecord(value);
const oneOf = (...values: string[]): Check => (value) => typeof value === "string" && values.includes(value);
const list = (item: Check): Check => (value) => Array.isArray(value) && value.length > 0 && value.every(item);
const shaped = (required: string[], optional: string[] = []): Check => (value) =>
	isRecord(value) && required.every((key) => text(value[key])) && Object.keys(value).every((key) => required.includes(key) || (optional.includes(key) && typeof value[key] === "string"));
const files = list(shaped(["path", "content"]));
// A Weave input: its nodeId and, optionally, a value of the input's own type.
const weaveInput: Check = (value) => isRecord(value) && text(value.nodeId) && Object.keys(value).every((key) => key === "nodeId" || key === "value");
const VERIFY_TOOLS = ["get_metadata", "get_design_context", "get_variable_defs"];
// Figma's documented upload types; an SVG becomes vectors, never a node fill.
const UPLOAD_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"];
const MAX_UPLOADS = 60;
const asset: Check = (value) => isRecord(value) && Object.keys(value).sort().join(",") === "contentType,path" && text(value.path) && (value.path as string).startsWith("/") && oneOf(...UPLOAD_TYPES)(value.contentType);
// Targets fill one existing node per raster asset; otherwise new frames land
// on a named page, so read-back has one observable place to look.
function uploadShape(input: Input): boolean {
	const assets = input.assets as { contentType: string }[];
	if (assets.length > MAX_UPLOADS) return false;
	if (input.nodeIds === undefined) return input.currentPageId !== undefined;
	return (input.nodeIds as string[]).length === assets.length && assets.every((item) => item.contentType !== "image/svg+xml");
}
const verify: Check = (value) => isRecord(value) && Object.keys(value).sort().join(",") === "contains,nodeId,tool" && oneOf(...VERIFY_TOOLS)(value.tool) && text(value.nodeId) && list(text)(value.contains);

const s = (input: Input, key: string): string => input[key] as string;
const node = (input: Input) => `figma-node:${s(input, "fileKey")}:${s(input, "nodeId")}`;
const codeConnectRead = (input: Input): Call => ({ tool: "get_code_connect_map", args: { fileKey: s(input, "fileKey"), nodeId: s(input, "nodeId") } });
const whoami = (): Call => ({ tool: "whoami", args: {} });

const WRITES: Readonly<Record<string, WriteSpec>> = {
	add_code_connect_map: {
		keys: { required: { fileKey: text, nodeId: text, source: text, componentName: text, label: text }, optional: { template: text, templateDataJson: text } },
		identity: node,
		observe: codeConnectRead,
		marks: (input) => [s(input, "componentName"), s(input, "source")],
		evidence: "marks",
	},
	send_code_connect_mappings: {
		keys: { required: { fileKey: text, nodeId: text, mappings: list(shaped(["nodeId", "componentName", "source", "label"], ["template", "templateDataJson"])) }, optional: { clientLanguages: text, clientFrameworks: text } },
		identity: node,
		observe: codeConnectRead,
		marks: (input) => (input.mappings as Record<string, string>[]).flatMap((mapping) => [mapping.componentName as string, mapping.source as string]),
		evidence: "marks",
	},
	create_generative_plugin: {
		keys: { required: { name: text, description: text, planKey: text }, optional: {} },
		identity: (input) => `figma-plan:${s(input, "planKey")}:generative-plugin:${short(s(input, "name"))}`,
		observe: () => ({ tool: "list_generative_plugins", args: {} }),
		marks: (input) => [s(input, "name")],
		evidence: "new-id",
	},
	create_shader: {
		keys: { required: { name: text, description: text, planKey: text, kind: oneOf("effect", "fill") }, optional: {} },
		identity: (input) => `figma-plan:${s(input, "planKey")}:shader:${short(s(input, "name"))}`,
		observe: () => ({ tool: "list_shaders", args: {} }),
		marks: (input) => [s(input, "name")],
		evidence: "new-id",
	},
	update_generative_plugin: {
		keys: { required: { id: text, commitMessage: text }, optional: { files, metadata: object } },
		identity: (input) => `figma-generative-plugin:${s(input, "id")}`,
		observe: (input) => ({ tool: "get_generative_plugin", args: { id: s(input, "id") } }),
		marks: () => [],
		evidence: "version",
	},
	update_shader: {
		keys: { required: { id: text, commitMessage: text, kind: oneOf("effect", "fill") }, optional: { files, metadata: object } },
		identity: (input) => `figma-shader:${s(input, "id")}`,
		observe: (input) => ({ tool: "get_shader", args: { id: s(input, "id") } }),
		marks: () => [],
		evidence: "version",
	},
	create_new_file: {
		keys: { required: { fileName: text, planKey: text, editorType: oneOf("design", "figjam", "slides") }, optional: { projectId: text } },
		identity: (input) => `figma-plan:${s(input, "planKey")}:project:${(input.projectId as string | undefined) ?? "drafts"}:file:${short(s(input, "fileName"))}`,
		observe: whoami,
		marks: () => [],
		require: (input) => [s(input, "planKey")],
		evidence: "reply-target",
	},
	generate_diagram: {
		keys: { required: { name: text, mermaidSyntax: text }, optional: { userIntent: text, planKey: text, useArchitectureLayoutCode: text, fileKey: text } },
		identity: (input) => (input.fileKey === undefined ? `figma-plan:${(input.planKey as string | undefined) ?? "default"}:diagram:${short(s(input, "name"))}` : `figma-file:${s(input, "fileKey")}`),
		observe: (input) => (input.fileKey === undefined ? whoami() : { tool: "get_metadata", args: { fileKey: s(input, "fileKey") } }),
		marks: (input) => (input.fileKey === undefined ? [] : [s(input, "name")]),
		require: (input) => (input.fileKey === undefined && input.planKey !== undefined ? [s(input, "planKey")] : []),
		evidence: "reply-target",
		partial: true,
	},
	use_figma: {
		keys: { required: { fileKey: text, code: text, description: text, verify }, optional: { skillNames: text } },
		identity: (input) => `figma-file:${s(input, "fileKey")}`,
		observe: (input) => {
			const target = input.verify as { tool: string; nodeId: string };
			return { tool: target.tool, args: { fileKey: s(input, "fileKey"), nodeId: target.nodeId } };
		},
		marks: (input) => [...((input.verify as { contains: string[] }).contains)],
		evidence: "marks",
		partial: true,
		send: (input) => Object.fromEntries(Object.entries(input).filter(([key]) => key !== "verify")),
	},
	upload_assets: {
		keys: { required: { fileKey: text, assets: list(asset) }, optional: { nodeIds: list(text), currentPageId: text, scaleMode: oneOf("FILL", "FIT", "TILE") } },
		identity: (input) => `figma-file:${s(input, "fileKey")}`,
		observe: (input) => ({ tool: "get_metadata", args: { fileKey: s(input, "fileKey"), nodeId: (input.currentPageId as string | undefined) ?? "" } }),
		marks: () => [],
		evidence: "upload",
		valid: uploadShape,
	},
	weave_cancel_tool_run: {
		keys: { required: { recipeId: text, runIds: list(text) }, optional: {} },
		identity: (input) => `weave-recipe:${s(input, "recipeId")}`,
		observe: (input) => ({ tool: "weave_get_tool_run_output", args: { recipeId: s(input, "recipeId"), runIds: input.runIds } }),
		marks: () => [],
		evidence: "canceled",
	},
	weave_run_tool: {
		keys: { required: { recipeId: text }, optional: { version: integer, inputs: list(weaveInput), numberOfRuns: integer, acknowledgedCost: number } },
		identity: (input) => `weave-recipe:${s(input, "recipeId")}`,
		observe: (input) => ({ tool: "weave_get_tool_run_output", args: { recipeId: s(input, "recipeId") } }),
		marks: () => [],
		evidence: "weave-run",
		valid: (input) => input.numberOfRuns === undefined || ((input.numberOfRuns as number) >= 1 && (input.numberOfRuns as number) <= 10),
	},
};

const READS = [
	"whoami",
	"get_metadata",
	"get_design_context",
	"get_screenshot",
	"get_variable_defs",
	"download_assets",
	"get_motion_context",
	"get_figjam",
	"get_libraries",
	"search_design_system",
	"get_code_connect_map",
	"get_code_connect_suggestions",
	"get_context_for_code_connect",
	"list_generative_plugins",
	"get_generative_plugin",
	"list_shaders",
	"get_shader",
	"list_file_shaders",
	"weave_list_tools",
	"weave_get_tool_inputs",
	"weave_get_tool_run_output",
] as const;

export type Kind = "read" | "write";

export function operationKind(operation: string): Kind | null {
	if ((READS as readonly string[]).includes(operation)) return "read";
	return Object.hasOwn(WRITES, operation) ? "write" : null;
}

export const OPERATION_NAMES: readonly string[] = [...READS, ...Object.keys(WRITES)];

// The whole catalogue, as `connectors schema` reports it.
export const OPERATION_CATALOGUE: readonly { name: string; kind: Kind }[] = OPERATION_NAMES.map((name) => ({ name, kind: operationKind(name) as Kind }));

export interface WriteInput {
	readonly operation: string;
	readonly input: Input;
	readonly spec: WriteSpec;
}

function hasShape(input: Input, keys: KeySpec): boolean {
	return Object.entries(keys.required).every(([key, check]) => check(input[key])) && Object.keys(input).every((key) => (Object.hasOwn(keys.required, key) ? true : Object.hasOwn(keys.optional, key) && (keys.optional[key] as Check)(input[key])));
}

// The pure check of a write's --input; null for anything else. The caller
// never echoes the rejected value.
export function writeInput(operation: string, input: Input | null): WriteInput | null {
	const spec = Object.hasOwn(WRITES, operation) ? WRITES[operation] : undefined;
	if (spec === undefined || input === null || !hasShape(input, spec.keys) || (spec.valid !== undefined && !spec.valid(input))) return null;
	return { operation, input, spec };
}

export const sendArgs = (write: WriteInput): Record<string, unknown> => (write.spec.send ? write.spec.send(write.input) : { ...write.input });

// The input keys a write accepts, for a refusal's repair text.
export function acceptedKeys(operation: string): string | null {
	const spec = Object.hasOwn(WRITES, operation) ? WRITES[operation] : undefined;
	if (spec === undefined) return null;
	const optional = Object.keys(spec.keys.optional);
	return `${operation} needs ${Object.keys(spec.keys.required).join(", ")}${optional.length ? `, with optional ${optional.join(", ")}` : ""}; no other key is admitted`;
}
