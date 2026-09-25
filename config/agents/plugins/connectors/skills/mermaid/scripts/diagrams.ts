// Read-back of Mermaid account replies. The authenticated receipt recorded
// input schemas only, so the reply shape here is an assumption the fixture
// states, not a live-qualified contract: the diagram or the diagram list,
// either as MCPorter's JSON output already unwrapped it from a JSON text
// content, or still inside a tool result's structured or single text content.
// A diagram names itself by documentID. Anything else is unrecognised, and a
// write read-back that cannot recognise its object never completes.

export interface Diagram {
	readonly documentID: string;
	readonly title: string | null;
	readonly code: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function payload(data: unknown): unknown {
	if (!isRecord(data) || (data.structuredContent === undefined && !Array.isArray(data.content))) return data;
	if (data.structuredContent !== undefined) return data.structuredContent;
	const content = Array.isArray(data.content) ? data.content : [];
	const [only] = content;
	if (content.length !== 1 || !isRecord(only) || only.type !== "text" || typeof only.text !== "string") return undefined;
	try {
		return JSON.parse(only.text);
	} catch {
		return undefined;
	}
}

function asDiagram(value: unknown): Diagram | null {
	if (!isRecord(value) || typeof value.documentID !== "string" || value.documentID === "") return null;
	const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : null);
	return { documentID: value.documentID, title: text("title"), code: text("code") };
}

export function diagramOf(data: unknown): Diagram | null {
	const body = payload(data);
	return asDiagram(isRecord(body) && isRecord(body.diagram) ? body.diagram : body);
}

export function diagramsOf(data: unknown): Diagram[] | null {
	const body = payload(data);
	const list = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.diagrams) ? body.diagrams : null;
	if (list === null) return null;
	const diagrams = list.map(asDiagram);
	return diagrams.every((diagram) => diagram !== null) ? (diagrams as Diagram[]) : null;
}
