import { createHash } from "node:crypto";

export type Data = Record<string, unknown>;
export const record = (value: unknown): value is Data => typeof value === "object" && value !== null && !Array.isArray(value);
export const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
// UTF-16 code-unit order, as the Desktop scripts sort: never locale collation.
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => record(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => order(a, b))) : item);
export const digest = (value: unknown): string => hash(canonical(value));
export const bare = (value: unknown, pattern: RegExp): value is string => typeof value === "string" && pattern.test(value);
export const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
export const NODE_ID = /^[A-Za-z0-9_:;.-]{1,200}$/;
export const ACCOUNT = /^[a-z][a-z0-9-]{0,31}$/;
export const FILE_KEY = /^[A-Za-z0-9]{8,64}$/;

export class ConsoleRefusal extends Error {
	constructor(readonly reason: string) { super(reason); }
}

// The closed causes the fixed source-owned scripts throw as `connector:<cause>`.
// The bridge relays a thrown script as `success:false` with its message, so a
// refused reply names the guard that stopped it. Any other text stays generic.
const SCRIPT_CAUSES: ReadonlySet<string> = new Set(["file-mismatch", "desktop-identity-unverified", "desktop-identity-mismatch", "snapshot-incomplete", "node-missing", "baseline-changed", "parent-invalid", "text-required", "variable-missing", "mode-missing", "fill-target-invalid", "fenced"]);
function refusedReply(value: Data): ConsoleRefusal {
	const cause = /connector:([a-z-]+)/.exec(JSON.stringify(value))?.[1];
	return new ConsoleRefusal(cause !== undefined && SCRIPT_CAUSES.has(cause) ? cause : "provider-refused");
}

// A failed MCPorter exit may still carry the tool's refused reply; only a
// named script guard survives it, so every other failure stays generic.
export function scriptRefusal(stdout: string): ConsoleRefusal | null {
	try { unwrap(stdout); } catch (error) { return error instanceof ConsoleRefusal && SCRIPT_CAUSES.has(error.reason) ? error : null; }
	return null;
}

// MCPorter and the upstream execute tool can each add one JSON/text wrapper.
export function unwrap(value: unknown, depth = 0): unknown {
	if (depth > 5) throw new ConsoleRefusal("reply-malformed");
	if (typeof value === "string") {
		let parsed: unknown;
		try { parsed = JSON.parse(value) as unknown; } catch { throw new ConsoleRefusal("reply-malformed"); }
		return unwrap(parsed, depth + 1);
	}
	if (!record(value)) return value;
	if (value.isError === true || value.error || value.success === false) throw refusedReply(value);
	if (Array.isArray(value.content)) {
		const text = value.content.filter((item: unknown) => record(item) && item.type === "text");
		if (text.length === 1 && record(text[0]) && typeof text[0].text === "string") return unwrap(text[0].text, depth + 1);
	}
	if (value.result !== undefined && (value.success === true || typeof value.result === "string")) return unwrap(value.result, depth + 1);
	return value;
}
