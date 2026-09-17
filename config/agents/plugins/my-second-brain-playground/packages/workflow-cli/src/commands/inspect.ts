// `inspect`: the read-only check of every prerequisite. It names each failed prerequisite with one repair and
// writes no binding, marker or lock file. The one write it shares with every routed command is the diagnostics run
// file in machine mode (the accepted reading of "without writing"), so the diagnostics-directory check below verifies
// the directory's safety, not its prior existence.

import { lstatSync } from "node:fs"
import type { RecoveryStore } from "../adapters/recovery.ts"
import { summarizeMarker } from "../compaction-marker.ts"
import type { Diagnostics } from "../diagnostics.ts"
import type { CommandOutcome, JsonObject } from "../model.ts"
import { stateAddresses } from "../runtime.ts"
import { type CommandContext, isGitRepository, refusal, resolveSession, sessionOutcome, success } from "./shared.ts"

export interface InspectRequest {
	readonly workspace: string
	readonly session: string | null
}

interface Check {
	readonly name: string
	readonly status: "pass" | "fail" | "skipped"
	readonly detail: string
	readonly repair: string | null
}

const pass = (name: string, detail: string): Check => ({ name, status: "pass", detail, repair: null })
const fail = (name: string, detail: string, repair: string): Check => ({ name, status: "fail", detail, repair })
const skipped = (name: string, detail: string): Check => ({ name, status: "skipped", detail, repair: null })

function directoryCheck(name: string, path: string, repair: string): Check {
	try {
		const stat = lstatSync(path)
		const uid = typeof process.geteuid === "function" ? process.geteuid() : stat.uid
		if (stat.isSymbolicLink() || !stat.isDirectory()) return fail(name, `${path} is not a real directory`, repair)
		if (stat.uid !== uid) return fail(name, `${path} is not owned by the effective user`, repair)
		if ((stat.mode & 0o777) !== 0o700) return fail(name, `${path} mode is not 0700`, repair)
		return pass(name, `${path} is a private 0700 directory`)
	} catch (error) {
		// Only an absent entry is "not yet"; an unreadable parent, a file in the path or a symlink loop is a failure.
		const code = (error as { code?: unknown }).code
		if (code === "ENOENT") return skipped(name, `${path} does not exist yet; it is created 0700 on first use`)
		return fail(name, `${path} is not accessible (${typeof code === "string" ? code : "lstat failed"})`, repair)
	}
}

interface StoreChecks {
	readonly checks: Check[]
	readonly unavailable: string | null
	/** Values observed under secret-pattern keys in the bd replies, for value redaction of the envelope. */
	readonly knownSecretValues: readonly string[]
}

async function storeChecks(context: CommandContext, request: InspectRequest): Promise<StoreChecks> {
	const executable = context.env.MSB_WORKFLOW_BD_EXECUTABLE ?? ""
	const beads = context.openBeads(executable, request.workspace, context.cwd)
	const read = await beads.verifyStore(isGitRepository(context.cwd))
	const knownSecretValues = beads.knownSecretValues()
	if (read.status === "verified") return { checks: [pass("executable", `${read.store.executable} (bd ${read.store.version}; sha256 ${read.store.executableDigest})`), pass("store", `${read.store.storePath} (prefix ${read.store.prefix}) agrees with where and config list`)], unavailable: null, knownSecretValues }
	if (read.status === "executable-invalid") return { checks: [fail("executable", read.reason, "Set MSB_WORKFLOW_BD_EXECUTABLE to the absolute path of the pinned bd 1.2.2 executable"), skipped("store", "not read because the executable failed")], unavailable: null, knownSecretValues }
	if (read.status === "mismatch") return { checks: [pass("executable", executable), fail("store", read.reason, "Select the workspace whose .beads store is the intended one and the pinned bd 1.2.2 at 6c124203e771")], unavailable: null, knownSecretValues }
	return { checks: [pass("executable", executable), fail("store", read.reason, "Check that the selected .beads store exists and no other bd process holds it, then retry")], unavailable: read.reason, knownSecretValues }
}

function stateRootCheck(stateHome: string): Check {
	const check = directoryCheck("state-root", stateHome, "Configure MSB_WORKFLOW_STATE_HOME as an existing absolute directory you own")
	// The root's mode is the operator's; only helper descendants must be 0700.
	return check.status === "fail" && /mode is not 0700/.test(check.detail) ? pass("state-root", `${stateHome} exists and is owned by the effective user`) : check
}

function bindingCheck(store: RecoveryStore, request: InspectRequest, session: string, nowMilliseconds: number): Check {
	const binding = store.readBinding(session, nowMilliseconds)
	if (binding.status === "absent") return fail("binding", `no binding at ${store.bindingPath(session)}`, `Bind this session: msb-workflow bind --workspace ${request.workspace} --bead <bead-id> --session ${session}`)
	if (binding.status === "invalid") return fail("binding", `saved binding is not schema v3: ${binding.reason}`, `Move or delete ${store.bindingPath(session)} after reading it, then bind again`)
	if (binding.status !== "available") return fail("binding", binding.reason, "Repair the named private state entry (owner, mode 0600/0700, no symlink, one link)")
	if (binding.binding.workspace !== request.workspace) return fail("binding", `bound to workspace ${binding.binding.workspace}, not ${request.workspace}`, `Run commands with --workspace ${binding.binding.workspace}`)
	return pass("binding", `${binding.binding.beadId} in ${binding.binding.workspace}, observed ${binding.binding.observedAt} (${binding.stale ? "stale" : "fresh"})`)
}

function markerCheck(store: RecoveryStore, request: InspectRequest, session: string): Check {
	const marker = store.readMarker(session)
	if (marker.status !== "available") return fail("marker", marker.reason, `Move or delete ${store.markerPath(session)} after reading it`)
	const summary = summarizeMarker(marker.marker)
	if (summary.uncertain.length > 0) return fail("marker", `generations ${summary.uncertain.join(", ")} were claimed but never recorded delivered`, `Run msb-workflow recover --workspace ${request.workspace} --session ${session}; the next prompt hook emits a notice, not a panel`)
	return pass("marker", `pending ${summary.pending.length}, delivered ${summary.delivered}, notified ${summary.notified}`)
}

function lockFilesCheck(store: RecoveryStore, request: InspectRequest, session: string): Check {
	const lockFiles = store.checkLockFiles(request.workspace, session)
	const unsafe = lockFiles.filter((lock) => lock.status === "unsafe")
	if (unsafe.length > 0) return fail("lock-files", unsafe.map((lock) => `${lock.path}: ${lock.reason ?? "unsafe"}`).join("; "), "Remove the unsafe lock file; the helper recreates it 0600 on the next locked write")
	return pass("lock-files", lockFiles.map((lock) => `${lock.path}: ${lock.status}`).join("; "))
}

function bindingChecks(context: CommandContext, stateHome: string, request: InspectRequest, session: string | null): Check[] {
	const addresses = stateAddresses(stateHome)
	const checks: Check[] = [stateRootCheck(stateHome), directoryCheck("diagnostics-directory", addresses.diagnostics, "Repair the diagnostics directory to a private 0700 directory you own (a machine-mode run creates it 0700 when absent)")]
	if (session === null) return [...checks, skipped("binding", "no --session or CODEX_SESSION_ID supplied"), skipped("marker", "no session supplied"), skipped("lock-files", "no session supplied")]
	const store = context.openStore(stateHome)
	checks.push(bindingCheck(store, request, session, context.now().getTime()), markerCheck(store, request, session), lockFilesCheck(store, request, session))
	// The row is omitted only for an absent (ENOENT) directory, which is created 0700 by the first bind; an unreadable
	// (EACCES), looped (ELOOP) or non-directory sessions entry is a failed prerequisite, never a silent omission.
	const sessions = directoryCheck("sessions-directory", addresses.sessions, "Repair the sessions directory to a private 0700 directory you own")
	if (sessions.status !== "skipped") checks.push(sessions)
	return checks
}

export async function runInspect(request: InspectRequest, context: CommandContext, stateHome: string, diagnostics: Diagnostics): Promise<{ outcome: CommandOutcome; knownSecretValues: readonly string[] }> {
	const resolution = resolveSession(request.session, context.env)
	if (resolution.status === "conflict" || resolution.status === "invalid") return { outcome: sessionOutcome(resolution), knownSecretValues: [] }
	const session = resolution.status === "resolved" ? resolution.session : null
	const store = await storeChecks(context, request)
	const { knownSecretValues } = store
	const checks = [...store.checks, ...bindingChecks(context, stateHome, request, session)]
	const failed = checks.filter((check) => check.status === "fail")
	diagnostics.log("inspect.completed", { failed: failed.map((check) => check.name) })
	const result: JsonObject = { workspace: request.workspace, session, stateRoot: stateHome, checks: checks.map((check) => ({ ...check })) }
	if (failed.length === 0) return { outcome: success("inspected", "every prerequisite passed", result, session === null ? `msb-workflow bind --workspace ${request.workspace} --bead <bead-id> --session <id>` : `msb-workflow recover --workspace ${request.workspace} --session ${session}`), knownSecretValues }
	const first = failed[0] as Check
	if (store.unavailable !== null) return { outcome: { station: "beads-unavailable", message: store.unavailable, result: { station: "beads-unavailable", ...result }, repairAction: first.repair ?? "retry", nextAction: `msb-workflow inspect --workspace ${request.workspace}`, availablePaths: [], handoffPrerequisites: [] }, knownSecretValues }
	return { outcome: refusal("inspect-refused", `${failed.length} prerequisite(s) failed: ${failed.map((check) => check.name).join(", ")}`, first.repair ?? "Repair the first failed prerequisite", `msb-workflow inspect --workspace ${request.workspace}${session === null ? "" : ` --session ${session}`}`, result), knownSecretValues }
}
