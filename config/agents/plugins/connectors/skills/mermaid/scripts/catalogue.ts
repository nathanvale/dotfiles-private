// Mermaid's closed operation catalogue: every tool the Skill reaches, its
// tier (keyless or account), and whether it reads or writes. The registry's
// allow-lists restate these names; the operation names are the hosted
// server's own tool names from the 2026-09-26 live receipts. The account tools
// come from one authenticated tools/list whose output was truncated, so the
// catalogue claims only the six complete tool objects it saw and admits five:
// repair_mermaid_chart_diagram may associate a repair with a stored diagram,
// an effect no read-back here can observe, so it is neither a read nor a
// journaled write.

import { createHash } from "node:crypto";

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export const KEYLESS_SERVER = "mermaid";
export const ACCOUNT_SERVER = "mermaid-account";

export type Tier = "keyless" | "account";
export type Kind = "read" | "write";

const OPERATIONS: Readonly<Record<string, { tier: Tier; kind: Kind }>> = {
	validate_and_render_mermaid_diagram: { tier: "keyless", kind: "read" },
	get_diagram_title: { tier: "keyless", kind: "read" },
	get_diagram_summary: { tier: "keyless", kind: "read" },
	search_mermaid_icons: { tier: "keyless", kind: "read" },
	get_mermaid_syntax_document: { tier: "keyless", kind: "read" },
	list_mermaid_chart_projects: { tier: "account", kind: "read" },
	list_mermaid_chart_diagrams: { tier: "account", kind: "read" },
	get_mermaid_chart_diagram: { tier: "account", kind: "read" },
	create_mermaid_chart_diagram: { tier: "account", kind: "write" },
	update_mermaid_chart_diagram: { tier: "account", kind: "write" },
};

export type WriteOperation = "create_mermaid_chart_diagram" | "update_mermaid_chart_diagram";

export function operationSpec(operation: string): { tier: Tier; kind: Kind } | null {
	return Object.hasOwn(OPERATIONS, operation) ? (OPERATIONS[operation] ?? null) : null;
}

export const OPERATION_NAMES: readonly string[] = Object.keys(OPERATIONS);

// The whole catalogue, in declaration order, as `connectors schema` reports it.
export const OPERATION_CATALOGUE: readonly { name: string; tier: Tier; kind: Kind }[] = Object.entries(OPERATIONS).map(([name, spec]) => ({ name, ...spec }));

// A write's exact input. create names its destination project and a title,
// the subject its Object Identity needs; update names its diagram and
// project and at least one of title or code to change. clientName is the
// hosted server's required analytics field. No other key is admitted.
export interface CreateInput {
	readonly projectID: string;
	readonly title: string;
	readonly code?: string;
	readonly clientName: string;
}
export interface UpdateInput {
	readonly documentID: string;
	readonly projectID: string;
	readonly title?: string;
	readonly code?: string;
	readonly clientName: string;
}
export type WriteInput = { operation: "create_mermaid_chart_diagram"; input: CreateInput } | { operation: "update_mermaid_chart_diagram"; input: UpdateInput };

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CREATE_KEYS = { required: ["projectID", "title", "clientName"], optional: ["code"] } as const;
const UPDATE_KEYS = { required: ["documentID", "projectID", "clientName"], optional: ["title", "code"] } as const;

function hasShape(input: Readonly<Record<string, unknown>>, keys: { required: readonly string[]; optional: readonly string[] }): boolean {
	const allowed = new Set([...keys.required, ...keys.optional]);
	return keys.required.every((key) => key in input) && Object.keys(input).every((key) => allowed.has(key) && typeof input[key] === "string" && input[key] !== "");
}

// The pure check of a write's --input; null for anything else. The caller
// never echoes the rejected value.
export function writeInput(operation: string, input: Readonly<Record<string, unknown>> | null): WriteInput | null {
	if (input === null) return null;
	if (operation === "create_mermaid_chart_diagram") {
		if (!hasShape(input, CREATE_KEYS) || !IDENTIFIER.test(input.projectID as string)) return null;
		return { operation, input: input as unknown as CreateInput };
	}
	if (operation === "update_mermaid_chart_diagram") {
		if (!hasShape(input, UPDATE_KEYS) || !IDENTIFIER.test(input.documentID as string) || !IDENTIFIER.test(input.projectID as string)) return null;
		if (input.title === undefined && input.code === undefined) return null;
		return { operation, input: input as unknown as UpdateInput };
	}
	return null;
}

// The stable name of the object a write acts on: the diagram for an update,
// the destination project plus its title for a create. The title enters only
// as a digest, so journal records hold identifiers and digests alone.
export function objectIdentity(write: WriteInput): string {
	if (write.operation === "update_mermaid_chart_diagram") return `mermaid-diagram:${write.input.documentID}`;
	return `mermaid-project:${write.input.projectID}:title-sha256:${sha256(write.input.title).slice(0, 16)}`;
}
