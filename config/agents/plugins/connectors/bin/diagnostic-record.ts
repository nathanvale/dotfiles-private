// Retained last-provider-failure observation: a safe, closed-shape record of
// the most recent classified provider-call failure for one connector AND one
// tenant, overwritten atomically under
// $XDG_STATE_HOME/connectors/diagnostics/<connector>/<tenant>/last-failure.json.
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
// Keyed by connector AND tenant, not connector alone: two different tenants
// sharing one connector must never overwrite each other's record. Still
// exactly one record per connector-tenant pair, overwritten, not a history --
// storage stays bounded, no new cleanup policy needed.
//
// transportCallId is NOT the outward envelope's `result.runId`: that id is
// generated lazily, inside bin/connectors.ts's emitAdapterEnvelope, at the
// moment the final envelope is assembled -- after the transport call this
// record is written from has already completed. No earlier-available,
// pre-generated invocation id exists anywhere in the current architecture to
// thread down instead. transportCallId is a distinct identifier, freshly
// generated once per routeTransport request() attempt. To make it actually
// joinable by an operator working only from the real CLI's own output (not
// just internally, inside the one process that holds both), runtime.ts also
// writes it as one fixed-prefix diagnostic line to the failing command's own
// stderr -- a supported, owned, documented output location that leaves the
// JSON envelope on stdout completely unchanged. See runtime.ts's own comment
// at the write site for the exact line shape.
import { ownedDirectory, type PrivateStateReason, readPrivateFile, stateRoot, writePrivateFile } from "./private-state.ts";
import type { EnvironmentSource } from "./safe-environment.ts";
import path from "node:path";

export type ObservedFailureKind = "process" | "tool-error" | "malformed";

export interface ProviderFailureRecord {
	readonly schemaVersion: 1;
	readonly connector: string;
	readonly tenant: string;
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
	readonly tenant: string;
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

export type Kept = { readonly kind: "retained" } | { readonly kind: "not-retained"; readonly reason: PrivateStateReason | "tenant-invalid" };

// A safe, generic path-segment check for tenant, independent of any one
// connector's own stricter tenant-slug pattern (Atlassian's own
// TENANT_PATTERN is already enforced before a write reaches here; this guard
// exists so this shared module never trusts that alone). Refuses anything
// that is not a single, lowercase, dash/underscore/digit path segment -- no
// `.`, `/`, or empty string, so a malformed caller can never traverse out of
// the connector's own diagnostics directory.
const SAFE_TENANT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function tenantPathSafe(tenant: string): boolean {
	return SAFE_TENANT.test(tenant);
}

function recordFile(env: EnvironmentSource, connector: string, tenant: string): string {
	return path.join(stateRoot(env), "connectors", "diagnostics", connector, tenant, "last-failure.json");
}

// Best-effort only: a failed write here never changes the outward
// TransportResult the caller already computed. Observability must not become
// a new way for the real call to fail.
export function recordProviderFailure(request: RecordFailureRequest): Kept {
	if (!tenantPathSafe(request.tenant)) return { kind: "not-retained", reason: "tenant-invalid" };
	const record: ProviderFailureRecord = {
		schemaVersion: 1,
		connector: request.connector,
		tenant: request.tenant,
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
	const file = recordFile(request.env, request.connector, request.tenant);
	const directory = ownedDirectory(path.dirname(file));
	if (!directory.ok) return { kind: "not-retained", reason: directory.reason };
	const written = writePrivateFile(file, `${JSON.stringify(record)}\n`);
	return written.ok ? { kind: "retained" } : { kind: "not-retained", reason: written.reason };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const RECORD_KEYS = ["schemaVersion", "connector", "tenant", "tool", "server", "cause", "kind", "exitCode", "stderrLength", "stdoutLength", "transportCallId", "observedAt"];
const KINDS: ReadonlySet<string> = new Set(["process", "tool-error", "malformed"]);

// Exactly RECORD_KEYS, no more, no fewer -- the closed-shape boundary itself,
// kept separate from what each field's own value must look like.
function hasClosedKeys(value: Record<string, unknown>): boolean {
	const keys = Object.keys(value);
	return keys.length === RECORD_KEYS.length && RECORD_KEYS.every((key) => keys.includes(key));
}

// The fixed schema literal and the plain string-identity fields, including the
// one closed-enum field (kind).
function scalarFieldsValid(value: Record<string, unknown>): boolean {
	return (
		value.schemaVersion === 1 &&
		typeof value.connector === "string" &&
		typeof value.tenant === "string" &&
		typeof value.tool === "string" &&
		typeof value.server === "string" &&
		typeof value.cause === "string" &&
		typeof value.kind === "string" &&
		KINDS.has(value.kind)
	);
}

// The two retained text-size counters and the nullable process exit code.
function numericFieldsValid(value: Record<string, unknown>): boolean {
	const exitCodeValid = value.exitCode === null || (typeof value.exitCode === "number" && Number.isInteger(value.exitCode));
	return exitCodeValid && typeof value.stderrLength === "number" && Number.isInteger(value.stderrLength) && typeof value.stdoutLength === "number" && Number.isInteger(value.stdoutLength);
}

// The correlation id and the observed timestamp -- the two fields a caller
// joins against, not merely stored facts about one attempt.
function transportFieldsValid(value: Record<string, unknown>): boolean {
	return typeof value.transportCallId === "string" && value.transportCallId.length > 0 && typeof value.observedAt === "string" && !Number.isNaN(Date.parse(value.observedAt));
}

function wellFormed(value: unknown): value is ProviderFailureRecord {
	if (!isObject(value) || !hasClosedKeys(value)) return false;
	return scalarFieldsValid(value) && numericFieldsValid(value) && transportFieldsValid(value);
}

// Read-only: never writes, repairs, or deletes. A malformed or absent record,
// or an unsafe tenant segment, all read as null; the caller has no retained
// failure to show either way. Callers that omit a tenant (doctor's existing
// one-argument form) never see this, by construction, not by this function
// silently guessing which tenant's record to show.
export function readProviderFailure(connector: string, tenant: string, env: EnvironmentSource): ProviderFailureRecord | null {
	if (!tenantPathSafe(tenant)) return null;
	const read = readPrivateFile(recordFile(env, connector, tenant));
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
