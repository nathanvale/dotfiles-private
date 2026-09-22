// The closed Branch Station catalog for the five envelope commands of msb-workflow (help, discover, inspect, bind,
// recover) plus the usage refusal of a malformed `hook` invocation. Every public envelope outcome reaches exactly one
// declared station; the catalog owns each station's outcome, cause, effect, transaction, retry, guidance and wire
// handoff facts. The catalog test fails every declared row that no real public process has reached. The bare `hook`
// command is the documented exception: its deliveries are enumerated and proven in commands/hook.ts.

import { PINNED_BD_REVISION, PINNED_BD_VERSION } from "./adapters/beads.ts"
import { type CommandIdentity, commandDeclaration, type ExitCode, exitFor, type FailureClass } from "./command-contract.ts"
import type { DomainOutcome, EffectClass, TransactionState } from "./model.ts"

export type Guidance = "next-action" | "handoff" | "none"

export interface BranchStation {
	readonly station: string
	readonly commandIdentity: CommandIdentity
	readonly trigger: string
	readonly outcome: DomainOutcome
	readonly failureClass: FailureClass | null
	readonly causeCode: string | null
	readonly effectClass: EffectClass
	readonly transactionState: TransactionState
	readonly retryable: boolean
	readonly retryDelayMilliseconds: number | null
	readonly guidance: Guidance
	readonly exit: ExitCode
}

export interface StationObservation {
	readonly station: string
	readonly commandIdentity: CommandIdentity
}

type Row = readonly [station: string, commandIdentity: CommandIdentity, trigger: string, outcome: DomainOutcome, causeCode: string | null, transactionState: TransactionState, retryable: boolean, retryDelayMilliseconds: number | null, guidance: Guidance]

const INSPECT: CommandIdentity = "msb-workflow.inspect"
const BIND: CommandIdentity = "msb-workflow.bind"
const RECOVER: CommandIdentity = "msb-workflow.recover"
const ROUTED: readonly CommandIdentity[] = [INSPECT, BIND, RECOVER]
const READERS: readonly CommandIdentity[] = [BIND, RECOVER]
const ALL: readonly CommandIdentity[] = ["msb-workflow.help", "msb-workflow.discover", ...ROUTED, "msb-workflow.hook"]

const shared = (station: string, trigger: string, outcome: DomainOutcome, causeCode: string | null, transactionState: TransactionState, retryable: boolean, delay: number | null, guidance: Guidance, identities: readonly CommandIdentity[]): Row[] =>
	identities.map((identity) => [station, identity, trigger, outcome, causeCode, transactionState, retryable, delay, guidance] as const)

const ROWS: readonly Row[] = [
	["help-shown", "msb-workflow.help", "--help requested", "success", null, "unchanged", false, null, "none"],
	["discovery-shown", "msb-workflow.discover", "--discover requested", "success", null, "unchanged", false, null, "none"],
	...shared("usage-refused", "No arguments, unknown command, unknown option, a missing or malformed required option, or `hook` with any extra argument", "refused", "USAGE_INVALID_INVOCATION", "unchanged", false, null, "next-action", ALL),
	...shared("state-root-refused", "The explicit state root is empty, relative, missing, a symlink, a non-directory, or owned by another user", "refused", "DOMAIN_STATE_ROOT_UNSAFE", "unchanged", false, null, "next-action", ROUTED),
	...shared("workspace-refused", "--workspace is not an existing canonical absolute directory", "refused", "DOMAIN_WORKSPACE_INVALID", "unchanged", false, null, "next-action", ROUTED),
	...shared("session-invalid", "The session token from --session or CODEX_SESSION_ID does not match the closed grammar", "refused", "DOMAIN_SESSION_INVALID", "unchanged", false, null, "next-action", ROUTED),
	...shared("session-conflict", "--session and CODEX_SESSION_ID are both present and differ", "refused", "DOMAIN_SESSION_CONFLICT", "unchanged", false, null, "next-action", ROUTED),
	...shared("internal-failure", "An unexpected exception before any durable write", "failed", "INTERNAL_UNEXPECTED", "unchanged", false, null, "handoff", ROUTED),
	...shared("beads-unavailable", "A native bd read failed to start, timed out, returned no JSON, or returned an error value that names no absent Bead (no_beads_directory, contention, unclassified)", "failed", "UNAVAILABLE_BEADS_READ", "unchanged", true, 1000, "next-action", ROUTED),
	...shared("executable-refused", "The bd executable named by MSB_WORKFLOW_BD_EXECUTABLE or the binding was not accepted: it must be exactly the pinned absolute canonical path, a regular executable file, and hash to the pinned SHA-256 before any bd read; unset, relative, another path, a symlink, missing, not executable, or another digest all refuse", "refused", "DOMAIN_EXECUTABLE_INVALID", "unchanged", false, null, "next-action", READERS),
	...shared("store-mismatch", `bd version is not ${PINNED_BD_VERSION} at ${PINNED_BD_REVISION}, where.path is not <workspace>/.beads, the prefix disagrees with effective configuration, or context is redirected`, "refused", "DOMAIN_STORE_MISMATCH", "unchanged", false, null, "next-action", READERS),
	...shared("state-unsafe", "A private state ancestor, lock file, marker, or binding has unsafe ownership, type, mode, link count, or identity", "refused", "DOMAIN_STATE_UNSAFE", "unchanged", false, null, "next-action", READERS),
	...shared("binding-invalid", "The saved binding is not one bounded schema-v3 object: malformed bytes, duplicate keys, unknown or missing fields, null identities, or future skew", "refused", "SCHEMA_BINDING_INVALID", "unchanged", false, null, "next-action", READERS),
	...shared("bead-missing", "The pinned bd reports the named Bead absent from the selected store", "refused", "DOMAIN_BEAD_MISSING", "unchanged", false, null, "next-action", READERS),
	...shared("binding-absent", "No binding exists for the selected session: recover has nothing to rebuild, and bind --from has no saved owner to replace, so nothing is written", "refused", "DOMAIN_BINDING_ABSENT", "unchanged", false, null, "next-action", READERS),
	["inspected", INSPECT, "Every prerequisite passed: executable, store, state root, binding, marker and lock files", "success", null, "unchanged", false, null, "next-action"],
	["inspect-refused", INSPECT, "At least one prerequisite failed; each failure and one repair are named in the result", "refused", "DOMAIN_PREREQUISITE_FAILED", "unchanged", false, null, "next-action"],
	["source-repository-missing", BIND, "bind ran outside a Git working directory, so sourceRepository cannot be derived", "refused", "DOMAIN_SOURCE_REPOSITORY_MISSING", "unchanged", false, null, "next-action"],
	["evidence-invalid", BIND, "--evidence is not a canonical regular file inside sourceRepository", "refused", "DOMAIN_EVIDENCE_INVALID", "unchanged", false, null, "next-action"],
	["binding-owner-conflict", BIND, "A saved binding for this session names a different Bead without --from, or a different workspace with or without it; the saved bytes are preserved and the repair names the verified switch", "refused", "DOMAIN_BINDING_OWNERSHIP_CONFLICT", "unchanged", false, null, "next-action"],
	["binding-inherited-conflict", BIND, "The session came only from CODEX_SESSION_ID and either a saved binding names a different owner or --from asks for a switch; an inherited identity is not worker ownership", "refused", "DOMAIN_SESSION_INHERITED_CONFLICT", "unchanged", false, null, "next-action"],
	["switch-from-mismatch", BIND, "--from was given and the saved binding for this session and workspace names a Bead other than --from; the saved bytes are preserved and the result carries savedBeadId (a saved Bead equal to --bead means the switch already happened)", "refused", "DOMAIN_SWITCH_FROM_MISMATCH", "unchanged", false, null, "next-action"],
	["storage-busy", BIND, "A cooperating process held the workspace or session flock for the complete 2,000 ms bound", "failed", "UNAVAILABLE_STORAGE_BUSY", "unchanged", true, 2000, "next-action"],
	["platform-unsupported", BIND, "The selected platform has no admitted process-lock Adapter", "failed", "UNAVAILABLE_LOCK_UNSUPPORTED", "unchanged", false, null, "next-action"],
	["write-failed", BIND, "The binding write failed before the rename became visible; nothing changed", "failed", "UNAVAILABLE_WRITE_FAILED", "unchanged", true, null, "next-action"],
	["write-unknown", BIND, "The binding write failed after the rename became visible; the durable state is unknown until recover reads it", "unknown", "INTERNAL_WRITE_OUTCOME_UNKNOWN", "unknown", false, null, "next-action"],
	["bound", BIND, "The binding was written or the same owner refreshed", "success", null, "completed", false, null, "next-action"],
	["switched", BIND, "--from named the saved owner in the same workspace for an explicit session, the new Bead verified, and the binding was replaced atomically and read back", "success", null, "completed", false, null, "next-action"],
	["recovered", RECOVER, "The binding was read, every native read agreed, and the Resume Panel was built from current facts", "success", null, "unchanged", false, null, "next-action"],
	["binding-workspace-mismatch", RECOVER, "The stored workspace differs from --workspace", "refused", "DOMAIN_BINDING_WORKSPACE_MISMATCH", "unchanged", false, null, "next-action"],
]

function failureClassOf(causeCode: string | null): FailureClass | null {
	if (causeCode === null) return null
	const prefix = causeCode.slice(0, causeCode.indexOf("_")).toLowerCase()
	if (prefix === "usage" || prefix === "domain" || prefix === "schema" || prefix === "internal" || prefix === "unavailable") return prefix
	throw new Error(`cause code without a failure-class prefix: ${causeCode}`)
}

function toStation(row: Row): BranchStation {
	const [station, commandIdentity, trigger, outcome, causeCode, transactionState, retryable, retryDelayMilliseconds, guidance] = row
	const failureClass = failureClassOf(causeCode)
	return { station, commandIdentity, trigger, outcome, failureClass, causeCode, effectClass: commandDeclaration(commandIdentity).effectClass, transactionState, retryable, retryDelayMilliseconds, guidance, exit: exitFor(failureClass) }
}

function stationKey(observation: StationObservation): string {
	return `${observation.commandIdentity}#${observation.station}`
}

const BY_KEY: ReadonlyMap<string, BranchStation> = (() => {
	const map = new Map<string, BranchStation>()
	for (const row of ROWS) {
		const station = toStation(row)
		const key = stationKey(station)
		if (map.has(key)) throw new Error(`duplicate station declaration: ${key}`)
		map.set(key, station)
	}
	return map
})()

/** The closed declared set, in declaration order; the catalog test enumerates it and reaches every entry. */
export const STATIONS: readonly BranchStation[] = [...BY_KEY.values()]

export function stationFor(observation: StationObservation): BranchStation {
	const station = BY_KEY.get(stationKey(observation))
	if (station === undefined) throw new Error(`undeclared branch station: ${stationKey(observation)}`)
	return station
}
