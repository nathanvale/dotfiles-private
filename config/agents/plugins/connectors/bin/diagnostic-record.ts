// Retained last-provider-failure observation: a safe, closed-shape record of
// the most recent classified provider-call failure, overwritten atomically
// under $XDG_STATE_HOME/connectors/diagnostics/<connector>/last-failure.json.
// It never holds raw provider stderr, stdout, or message text, a stack, or
// any free-text field -- only the already-closed cause code the transport
// seam already computed, the exit code, text lengths, and the observed-kind.
// This makes an unclassified ("failed-unknown") provider failure explainable
// without a live rerun, while keeping the existing "provider text never
// crosses the transport seam" boundary intact: nothing here is new exposure,
// only retention of facts the seam already held and previously discarded.
import { ownedDirectory, type PrivateStateReason, readPrivateFile, stateRoot, writePrivateFile } from "./private-state.ts";
import type { EnvironmentSource } from "./safe-environment.ts";
import path from "node:path";

export type ObservedFailureKind = "process" | "tool-error" | "malformed";

export interface ProviderFailureRecord {
	readonly schemaVersion: 1;
	readonly connector: string;
	readonly tool: string;
	readonly server: string;
	readonly cause: string;
	readonly kind: ObservedFailureKind;
	readonly exitCode: number | null;
	readonly stderrLength: number;
	readonly stdoutLength: number;
	readonly observedAt: string;
}

export interface RecordFailureRequest {
	readonly connector: string;
	readonly tool: string;
	readonly server: string;
	readonly cause: string;
	readonly kind: ObservedFailureKind;
	readonly exitCode: number | null;
	readonly stderrLength: number;
	readonly stdoutLength: number;
	readonly env: EnvironmentSource;
	readonly observedAt: Date;
}

export type Kept = { readonly kind: "retained" } | { readonly kind: "not-retained"; readonly reason: PrivateStateReason };

function recordFile(env: EnvironmentSource, connector: string): string {
	return path.join(stateRoot(env), "connectors", "diagnostics", connector, "last-failure.json");
}

// Best-effort only: a failed write here never changes the outward
// TransportResult the caller already computed. Observability must not become
// a new way for the real call to fail.
export function recordProviderFailure(request: RecordFailureRequest): Kept {
	const record: ProviderFailureRecord = {
		schemaVersion: 1,
		connector: request.connector,
		tool: request.tool,
		server: request.server,
		cause: request.cause,
		kind: request.kind,
		exitCode: request.exitCode,
		stderrLength: request.stderrLength,
		stdoutLength: request.stdoutLength,
		observedAt: request.observedAt.toISOString(),
	};
	const file = recordFile(request.env, request.connector);
	const directory = ownedDirectory(path.dirname(file));
	if (!directory.ok) return { kind: "not-retained", reason: directory.reason };
	const written = writePrivateFile(file, `${JSON.stringify(record)}\n`);
	return written.ok ? { kind: "retained" } : { kind: "not-retained", reason: written.reason };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const RECORD_KEYS = ["schemaVersion", "connector", "tool", "server", "cause", "kind", "exitCode", "stderrLength", "stdoutLength", "observedAt"];
const KINDS: ReadonlySet<string> = new Set(["process", "tool-error", "malformed"]);

function wellFormed(value: unknown): value is ProviderFailureRecord {
	if (!isObject(value)) return false;
	const keys = Object.keys(value);
	if (keys.length !== RECORD_KEYS.length || !RECORD_KEYS.every((key) => keys.includes(key))) return false;
	const exitCodeValid = value.exitCode === null || (typeof value.exitCode === "number" && Number.isInteger(value.exitCode));
	return (
		value.schemaVersion === 1 &&
		typeof value.connector === "string" &&
		typeof value.tool === "string" &&
		typeof value.server === "string" &&
		typeof value.cause === "string" &&
		typeof value.kind === "string" &&
		KINDS.has(value.kind) &&
		exitCodeValid &&
		typeof value.stderrLength === "number" &&
		Number.isInteger(value.stderrLength) &&
		typeof value.stdoutLength === "number" &&
		Number.isInteger(value.stdoutLength) &&
		typeof value.observedAt === "string" &&
		!Number.isNaN(Date.parse(value.observedAt))
	);
}

// Read-only: never writes, repairs, or deletes. A malformed or absent record
// both read as null; the caller has no retained failure to show either way.
export function readProviderFailure(connector: string, env: EnvironmentSource): ProviderFailureRecord | null {
	const read = readPrivateFile(recordFile(env, connector));
	if (!read.ok) return null;
	try {
		const value: unknown = JSON.parse(read.text);
		return wellFormed(value) ? value : null;
	} catch {
		return null;
	}
}
