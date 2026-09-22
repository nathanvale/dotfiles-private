// `bind`: the one local write. Read the store, verify the Bead, take the workspace lock then the session lock, read
// any saved binding, then write the binding atomically. The same owner refreshes; a different Bead, a different
// workspace, malformed saved bytes, or an inherited-only identity against another owner refuses and preserves the
// saved bytes. No flag overrides that refusal. The one deliberate change of owner is `--from <saved-bead-id>`: an
// expected-owner compare-and-swap that names the Bead it replaces, in the same workspace, for an explicit session
// only, with the new Bead verified before any lock and the written binding read back before it is reported.

import { lstatSync, realpathSync } from "node:fs"
import { isAbsolute, relative, sep } from "node:path"
import type { BeadsReader } from "../adapters/beads.ts"
import type { BindingRead, RecoveryStore } from "../adapters/recovery.ts"
import type { Diagnostics } from "../diagnostics.ts"
import type { BeadFacts, CommandOutcome, GateFacts, JsonObject, RecoveryBinding, StoreFacts } from "../model.ts"
import { buildPanel, type PanelFacts, sameOwner } from "../recovery.ts"
import { RuntimeFailure } from "../runtime.ts"
import { beadOutcome, bindingInvalidOutcome, type CommandContext, refusal, resolveSession, sessionOutcome, stateUnsafeOutcome, storeOutcome, success, unavailableOutcome } from "./shared.ts"

export interface BindRequest {
	readonly workspace: string
	readonly beadId: string
	readonly session: string | null
	readonly evidence: string | null
	/** The saved Bead a switch replaces; null is an ordinary bind or refresh. */
	readonly from: string | null
}

type Evidence = { readonly status: "ok"; readonly path: string | null } | { readonly status: "invalid"; readonly reason: string }

/** --evidence must be a canonical regular file inside sourceRepository; absent means null. */
function canonicalEvidence(evidence: string | null, sourceRepository: string): Evidence {
	if (evidence === null) return { status: "ok", path: null }
	if (!isAbsolute(evidence) || /[\0\r\n]/.test(evidence)) return { status: "invalid", reason: "--evidence must be an absolute path" }
	try {
		const stat = lstatSync(evidence)
		if (stat.isSymbolicLink() || !stat.isFile()) return { status: "invalid", reason: "--evidence must be a regular file, not a symlink or directory" }
		if (realpathSync(evidence) !== evidence) return { status: "invalid", reason: "--evidence must be canonical (no symlinks in any segment)" }
	} catch {
		return { status: "invalid", reason: "--evidence does not exist or is not readable" }
	}
	const fromRepository = relative(sourceRepository, evidence)
	if (fromRepository === "" || fromRepository.startsWith(`..${sep}`) || fromRepository === ".." || isAbsolute(fromRepository)) return { status: "invalid", reason: `--evidence must be inside the source repository ${sourceRepository}` }
	return { status: "ok", path: evidence }
}

function writeOutcome(error: unknown, workspace: string, session: string): CommandOutcome {
	if (error instanceof RuntimeFailure && error.kind === "busy") return { station: "storage-busy", message: error.message, result: { station: "storage-busy", reason: error.message }, repairAction: "Another msb-workflow process holds this workspace or session lock; wait for it to finish and retry the same command", nextAction: `msb-workflow inspect --workspace ${workspace} --session ${session}`, availablePaths: [], handoffPrerequisites: [] }
	if (error instanceof RuntimeFailure && error.kind === "unsupported") return { station: "platform-unsupported", message: error.message, result: { station: "platform-unsupported", reason: error.message }, repairAction: "Run the helper on macOS, the only platform with an admitted lock Adapter; a Linux flock Adapter is a later unit", nextAction: `msb-workflow inspect --workspace ${workspace} --session ${session}`, availablePaths: [], handoffPrerequisites: [] }
	if (error instanceof RuntimeFailure && error.kind === "unsafe") return stateUnsafeOutcome(error.message, workspace)
	if (error instanceof RuntimeFailure && error.kind === "uncertain") return { station: "write-unknown", message: `the binding rename became visible but the write did not complete cleanly: ${error.message}`, result: { station: "write-unknown", reason: error.message }, repairAction: `Run msb-workflow recover --workspace ${workspace} --session ${session} to read the durable binding before deciding whether to bind again`, nextAction: `msb-workflow recover --workspace ${workspace} --session ${session}`, availablePaths: [], handoffPrerequisites: [] }
	const reason = error instanceof Error ? error.message : "binding write failed"
	return { station: "write-failed", message: reason, result: { station: "write-failed", reason }, repairAction: "Repair the private state directory (owner, mode 0700, free space), then retry the same bind", nextAction: `msb-workflow inspect --workspace ${workspace} --session ${session}`, availablePaths: [], handoffPrerequisites: [] }
}

const recoverAction = (workspace: string, session: string): string => `msb-workflow recover --workspace ${workspace} --session ${session}`
const switchAction = (saved: RecoveryBinding, beadId: string): string => `msb-workflow bind --workspace ${saved.workspace} --bead ${beadId} --from ${saved.beadId} --session ${saved.sessionIdentity}`

/** The one repair for a saved owner that differs: a Bead change names the verified switch; a workspace change has none. */
function ownerConflictRepair(saved: RecoveryBinding, binding: RecoveryBinding): string {
	if (saved.workspace !== binding.workspace) return `Recover the saved binding with --workspace ${saved.workspace} and continue ${saved.beadId}, or use a different session for ${binding.workspace}; a saved workspace is never switched`
	return `Recover the saved binding and continue ${saved.beadId}, or switch this session to ${binding.beadId} only through the verified switch that names the owner it replaces: ${switchAction(saved, binding.beadId)}; no flag replaces a saved owner without naming it`
}

interface LockedWrite {
	readonly store: RecoveryStore
	readonly binding: RecoveryBinding
	readonly source: "explicit" | "environment"
	/** The Bead the saved binding must name for a switch; null is an ordinary bind or refresh. */
	readonly from: string | null
	readonly diagnostics: Diagnostics
}

/** What the locked section decided: a refusal, an ordinary write (refreshed when the same owner was saved), or a switch
 * carrying the saved binding it replaced. */
type LockedResult = { readonly kind: "refused"; readonly outcome: CommandOutcome } | { readonly kind: "bound"; readonly refreshed: boolean } | { readonly kind: "switched"; readonly previous: RecoveryBinding }

const refused = (outcome: CommandOutcome): LockedResult => ({ kind: "refused", outcome })

function ownerConflict(input: LockedWrite, saved: RecoveryBinding): CommandOutcome {
	const { binding } = input
	// An expected refusal: the envelope carries it, so it stays below the warning level of the human stderr sink.
	input.diagnostics.log("binding.conflict", { savedBeadId: saved.beadId, requestedBeadId: binding.beadId, sessionSource: input.source })
	const detail = `session ${binding.sessionIdentity} is bound to ${saved.beadId} in ${saved.workspace}; requested ${binding.beadId} in ${binding.workspace}`
	const facts = { savedBeadId: saved.beadId, savedWorkspace: saved.workspace }
	if (input.source === "environment") return refusal("binding-inherited-conflict", `inherited session identity cannot replace a saved owner: ${detail}`, "An inherited CODEX_SESSION_ID is not worker ownership. Verify your own Harness session identity and pass it with --session; the saved binding is preserved", recoverAction(saved.workspace, binding.sessionIdentity), facts)
	return refusal("binding-owner-conflict", `saved binding names a different owner: ${detail}`, ownerConflictRepair(saved, binding), recoverAction(saved.workspace, binding.sessionIdentity), facts)
}

/** Read back after the rename: the durable bytes must parse to exactly the binding written, or the outcome is unknown. */
function assertReadBack(store: RecoveryStore, binding: RecoveryBinding): void {
	const read = store.readBinding(binding.sessionIdentity, Date.parse(binding.observedAt))
	if (read.status !== "available") throw new RuntimeFailure("uncertain", `read-back after the switch found the binding ${read.status}${read.status === "absent" ? "" : `: ${read.reason}`}`)
	if (JSON.stringify(read.binding) !== JSON.stringify(binding)) throw new RuntimeFailure("uncertain", `read-back after the switch returned a binding naming ${read.binding.beadId}, not the written ${binding.beadId}`)
}

/** Inside both locks with `--from`: the saved owner must be this session's Bead `from` in the same workspace; then
 * the binding is replaced and read back. Any other saved state refuses and preserves the bytes. */
function switchOwner(input: LockedWrite, saved: Extract<BindingRead, { status: "absent" | "available" }>, from: string): LockedResult {
	const { store, binding } = input
	const session = binding.sessionIdentity
	if (saved.status === "absent") {
		const again = `msb-workflow bind --workspace ${binding.workspace} --bead ${binding.beadId} --session ${session}`
		return refused(refusal("binding-absent", `no binding exists for session ${session}; --from ${from} names no saved owner`, `Bind this session without --from: ${again}`, again, { bindingPath: store.bindingPath(session), from }))
	}
	if (saved.binding.workspace !== binding.workspace) return refused(ownerConflict(input, saved.binding))
	if (saved.binding.beadId !== from) {
		input.diagnostics.log("binding.switch-mismatch", { savedBeadId: saved.binding.beadId, from, requestedBeadId: binding.beadId })
		return refused(refusal("switch-from-mismatch", `saved binding for session ${session} names ${saved.binding.beadId}, not --from ${from}; ${binding.beadId} was not written`, `Recover the saved binding to read the current owner: a saved ${binding.beadId} means this switch already happened, and any other saved Bead must be named in --from before it can be replaced`, recoverAction(binding.workspace, session), { savedBeadId: saved.binding.beadId, from, requestedBeadId: binding.beadId }))
	}
	store.writeBinding(binding)
	assertReadBack(store, binding)
	input.diagnostics.log("binding.switched", { previousBeadId: from, beadId: binding.beadId })
	return { kind: "switched", previous: saved.binding }
}

/** Inside both locks: compare owners against any saved binding, then write. */
function lockedWrite(input: LockedWrite): LockedResult {
	const { store, binding } = input
	const saved = store.readBinding(binding.sessionIdentity, Date.parse(binding.observedAt))
	if (saved.status === "unsafe") return refused(stateUnsafeOutcome(saved.reason, binding.workspace))
	if (saved.status === "unavailable") throw new RuntimeFailure("unavailable", saved.reason)
	if (saved.status === "invalid") return refused(bindingInvalidOutcome(saved.reason, store.bindingPath(binding.sessionIdentity), binding.workspace, binding.sessionIdentity))
	if (input.from !== null) return switchOwner(input, saved, input.from)
	if (saved.status === "available" && !sameOwner(saved.binding, binding)) return refused(ownerConflict(input, saved.binding))
	store.writeBinding(binding)
	return { kind: "bound", refreshed: saved.status === "available" }
}

export type BindResult = { outcome: CommandOutcome; knownSecretValues: readonly string[] }

interface Owner {
	readonly store: StoreFacts
	readonly bead: BeadFacts
	readonly gates: readonly GateFacts[]
}

/** The read-only owner facts a bind needs: the store gate, the Bead, and the Gates; a refusal ends the bind. */
async function readOwner(beads: BeadsReader, request: BindRequest): Promise<Owner | CommandOutcome> {
	const storeRead = await beads.verifyStore(true)
	if (storeRead.status !== "verified") return storeOutcome(storeRead, request.workspace) ?? unavailableOutcome("store did not verify", request.workspace)
	const beadRead = await beads.readBead(request.beadId)
	if (beadRead.status !== "found") return beadOutcome(beadRead, request.beadId, request.workspace) ?? unavailableOutcome("Bead did not read", request.workspace)
	const gates = await beads.readGates()
	if (gates.status === "unavailable") return unavailableOutcome(gates.reason, request.workspace)
	return { store: storeRead.store, bead: beadRead.bead, gates: gates.gates }
}

function isOutcome(value: Owner | CommandOutcome): value is CommandOutcome {
	return "station" in value
}

interface Prepared {
	readonly session: string
	readonly source: "explicit" | "environment"
	readonly sourceRepository: string
	readonly evidencePath: string | null
}

/** Everything a bind resolves before touching Beads: the session, the Git top level, and the evidence pointer. A
 * switch needs an explicit session: an inherited identity never changes ownership, so it is refused here, before
 * any store read or lock. */
async function prepare(request: BindRequest, context: CommandContext): Promise<Prepared | CommandOutcome> {
	const session = resolveSession(request.session, context.env)
	if (session.status !== "resolved") return sessionOutcome(session)
	if (request.from !== null && session.source === "environment") return refusal("binding-inherited-conflict", `inherited session identity cannot switch a saved owner: --from ${request.from} to ${request.beadId} for session ${session.session}`, "An inherited CODEX_SESSION_ID is not worker ownership. Verify your own Harness session identity and pass it with --session; the saved binding is preserved", recoverAction(request.workspace, session.session), { from: request.from })
	const sourceRepository = await context.gitTopLevel(context.cwd)
	const again = `msb-workflow bind --workspace ${request.workspace} --bead ${request.beadId} --session ${session.session}`
	if (sourceRepository === null) return refusal("source-repository-missing", "bind must run inside a Git working directory; sourceRepository is derived from its top level", "Change into the source repository that owns this work (a worktree is fine) and bind again; there is no --source flag", `cd <source-repository> && ${again}`)
	const evidence = canonicalEvidence(request.evidence, sourceRepository)
	if (evidence.status === "invalid") return refusal("evidence-invalid", evidence.reason, `Pass --evidence as the canonical absolute path of a regular file inside ${sourceRepository}, or omit it`, again)
	return { session: session.session, source: session.source, sourceRepository, evidencePath: evidence.path }
}

function bindingFor(request: BindRequest, prepared: Prepared, owner: Owner, now: string): RecoveryBinding {
	return {
		schemaVersion: 3,
		sessionIdentity: prepared.session,
		workspace: request.workspace,
		storePath: owner.store.storePath,
		storePrefix: owner.store.prefix,
		beadsExecutable: owner.store.executable,
		beadsVersion: owner.store.version,
		beadId: request.beadId,
		beadObservedAt: owner.bead.updatedAt ?? now,
		sourceRepository: prepared.sourceRepository,
		evidencePath: prepared.evidencePath,
		observedAt: now,
	}
}

/** The switched result: the replaced owner's identifying facts beside B's panel; `readBack` records the read that
 * the switch requires before it may be reported. */
function switchedOutcome(previous: RecoveryBinding, binding: RecoveryBinding, bindingPath: string, panel: PanelFacts): CommandOutcome {
	const replaced: JsonObject = { beadId: previous.beadId, beadObservedAt: previous.beadObservedAt, observedAt: previous.observedAt, evidencePath: previous.evidencePath }
	return success("switched", `binding switched for ${binding.sessionIdentity}: ${previous.beadId} -> ${binding.beadId}`, { bindingPath, previous: replaced, readBack: true, ...panel.facts }, panel.nextSafeAction)
}

export async function runBind(request: BindRequest, context: CommandContext, stateHome: string, diagnostics: Diagnostics): Promise<BindResult> {
	const prepared = await prepare(request, context)
	if ("station" in prepared) return { outcome: prepared, knownSecretValues: [] }
	const beads = context.openBeads(context.env.MSB_WORKFLOW_BD_EXECUTABLE ?? "", request.workspace, context.cwd)
	const secrets = (): readonly string[] => beads.knownSecretValues()
	const owner = await readOwner(beads, request)
	if (isOutcome(owner)) return { outcome: owner, knownSecretValues: secrets() }
	const binding = bindingFor(request, prepared, owner, context.now().toISOString())
	const recoveryStore = context.openStore(stateHome)
	diagnostics.log("bind.started", { beadId: request.beadId, sessionSource: prepared.source, executableDigest: owner.store.executableDigest, ...(request.from === null ? {} : { from: request.from }) })
	let written: LockedResult
	try {
		written = await recoveryStore.withLocks(request.workspace, prepared.session, async () => lockedWrite({ store: recoveryStore, binding, source: prepared.source, from: request.from, diagnostics }))
	} catch (error) {
		// Also an expected outcome the envelope names in full; Contract Core allows exactly one human stderr line.
		diagnostics.log("bind.failed", { kind: error instanceof RuntimeFailure ? error.kind : "unknown" })
		return { outcome: writeOutcome(error, request.workspace, prepared.session), knownSecretValues: secrets() }
	}
	if (written.kind === "refused") return { outcome: written.outcome, knownSecretValues: secrets() }
	const panel = buildPanel({ binding, stale: false, store: owner.store, bead: owner.bead, gates: owner.gates, prime: null })
	const bindingPath = recoveryStore.bindingPath(prepared.session)
	if (written.kind === "switched") {
		diagnostics.log("bind.completed", { beadId: request.beadId, from: written.previous.beadId })
		return { outcome: switchedOutcome(written.previous, binding, bindingPath, panel), knownSecretValues: secrets() }
	}
	diagnostics.log("bind.completed", { beadId: request.beadId, refreshed: written.refreshed })
	const message = `binding ${written.refreshed ? "refreshed" : "written"} for ${prepared.session} -> ${request.beadId}`
	return { outcome: success("bound", message, { bindingPath, refreshed: written.refreshed, binding: { ...binding }, ...panel.facts }, panel.nextSafeAction), knownSecretValues: secrets() }
}
