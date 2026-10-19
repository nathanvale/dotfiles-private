// Retained last-provider-failure observation: a safe, closed-shape record of
// the most recent classified provider-call failure, overwritten atomically
// under $XDG_STATE_HOME/connectors/diagnostics/<connector>/last-failure.json.
// It never holds raw provider stderr, stdout, or message text, a stack, or
// any free-text field -- only the already-closed cause code the transport
// seam already computed, the exit code, text lengths, the observed-kind, and
// a transportCallId. This retains recurrence, timing, and size for an
// unclassified ("failed-unknown") provider failure where none was kept
// before, while keeping the existing "provider text never crosses the
// transport seam" boundary intact: nothing here is new exposure, only
// retention of facts the seam already held and previously discarded. It does
// not explain an unclassified failure's cause; see ProviderFailureRecord's
// own doc comment for why, and doctorFailureView for how that limit is
// surfaced.
//
// transportCallId is NOT the outward envelope's `result.runId`: that id is
// generated lazily, inside bin/connectors.ts's emitAdapterEnvelope, at the
// moment the final envelope is assembled -- after the transport call this
// record is written from has already completed. No earlier-available,
// pre-generated invocation id exists anywhere in the current architecture to
// thread down instead. transportCallId is a distinct identifier, freshly
// generated once per routeTransport request() attempt, that at least lets a
// retained record be correlated to a specific attempt and distinguished from
// a different one -- the achievable part of "correlation" without changing
// the shared envelope-assembly timing used by every command, success or
// failure alike, which would be a materially larger, cross-cutting change.
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
	readonly transportCallId: string;
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
	readonly transportCallId: string;
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
		transportCallId: request.transportCallId,
		observedAt: request.observedAt.toISOString(),
	};
	const file = recordFile(request.env, request.connector);
	const directory = ownedDirectory(path.dirname(file));
	if (!directory.ok) return { kind: "not-retained", reason: directory.reason };
	const written = writePrivateFile(file, `${JSON.stringify(record)}\n`);
	return written.ok ? { kind: "retained" } : { kind: "not-retained", reason: written.reason };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const RECORD_KEYS = ["schemaVersion", "connector", "tool", "server", "cause", "kind", "exitCode", "stderrLength", "stdoutLength", "transportCallId", "observedAt"];
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
		typeof value.transportCallId === "string" &&
		value.transportCallId.length > 0 &&
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

// Classified causes (auth, not-found, capability, precondition, transport)
// already carried real meaning before this record existed; only the
// classifier's own "failed-unknown" default leaves the cause itself unknown.
// This view exists so a surface like `connectors.doctor` can show the safe
// facts together with an explicit, non-overstated limit and a human next
// step -- never a free-text field, never a claim of causal diagnosis.
export interface DoctorFailureView extends ProviderFailureRecord {
	readonly reasonKnown: boolean;
	readonly limit: string;
	readonly supportedNextAction: string;
}

const UNCLASSIFIED_LIMIT = "Recurrence, timing and output size are retained; the provider's own failure text is not kept, so this is not a causal diagnosis.";
const CLASSIFIED_LIMIT = "This cause was already classified by the existing failure translator before this record existed.";
const SUPPORTED_NEXT_ACTION = "An operator may manually rerun the same read-only preview with stderr captured to learn more; no automatic retry is performed by this plugin.";

export function doctorFailureView(record: ProviderFailureRecord): DoctorFailureView {
	const reasonKnown = record.cause !== "failed-unknown";
	return { ...record, reasonKnown, limit: reasonKnown ? CLASSIFIED_LIMIT : UNCLASSIFIED_LIMIT, supportedNextAction: SUPPORTED_NEXT_ACTION };
}
