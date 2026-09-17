// `bind`: the one local write. Read the store, verify the Bead, take the workspace lock then the session lock, read
// any saved binding, then write the binding atomically. The same owner refreshes; a different Bead, a different
// workspace, malformed saved bytes, or an inherited-only identity against another owner refuses and preserves the
// saved bytes. No flag overrides that refusal.

import { lstatSync, realpathSync } from "node:fs"
import { isAbsolute, relative, sep } from "node:path"
import type { BeadsReader } from "../adapters/beads.ts"
import type { RecoveryStore } from "../adapters/recovery.ts"
import type { Diagnostics } from "../diagnostics.ts"
import type { BeadFacts, CommandOutcome, GateFacts, RecoveryBinding, StoreFacts } from "../model.ts"
import { buildPanel, sameOwner } from "../recovery.ts"
import { RuntimeFailure } from "../runtime.ts"
import { beadOutcome, bindingInvalidOutcome, type CommandContext, refusal, resolveSession, sessionOutcome, stateUnsafeOutcome, storeOutcome, success, unavailableOutcome } from "./shared.ts"

export interface BindRequest {
	readonly workspace: string
	readonly beadId: string
	readonly session: string | null
	readonly evidence: string | null
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

interface LockedWrite {
	readonly store: RecoveryStore
	readonly binding: RecoveryBinding
	readonly source: "explicit" | "environment"
	readonly diagnostics: Diagnostics
}

/** Inside both locks: compare owners against any saved binding, then write. Returns the refusal or null when written. */
function lockedWrite(input: LockedWrite): { readonly refusal: CommandOutcome | null; readonly refreshed: boolean } {
	const { store, binding } = input
	const saved = store.readBinding(binding.sessionIdentity, Date.parse(binding.observedAt))
	if (saved.status === "unsafe") return { refusal: stateUnsafeOutcome(saved.reason, binding.workspace), refreshed: false }
	if (saved.status === "unavailable") throw new RuntimeFailure("unavailable", saved.reason)
	if (saved.status === "invalid") return { refusal: bindingInvalidOutcome(saved.reason, store.bindingPath(binding.sessionIdentity), binding.workspace, binding.sessionIdentity), refreshed: false }
	if (saved.status === "available" && !sameOwner(saved.binding, binding)) {
		// An expected refusal: the envelope carries it, so it stays below the warning level of the human stderr sink.
		input.diagnostics.log("binding.conflict", { savedBeadId: saved.binding.beadId, requestedBeadId: binding.beadId, sessionSource: input.source })
		const detail = `session ${binding.sessionIdentity} is bound to ${saved.binding.beadId} in ${saved.binding.workspace}; requested ${binding.beadId} in ${binding.workspace}`
		if (input.source === "environment") return { refusal: refusal("binding-inherited-conflict", `inherited session identity cannot replace a saved owner: ${detail}`, "An inherited CODEX_SESSION_ID is not worker ownership. Verify your own Harness session identity and pass it with --session; the saved binding is preserved", `msb-workflow recover --workspace ${saved.binding.workspace} --session ${binding.sessionIdentity}`, { savedBeadId: saved.binding.beadId, savedWorkspace: saved.binding.workspace }), refreshed: false }
		return { refusal: refusal("binding-owner-conflict", `saved binding names a different owner: ${detail}`, "Recover the saved binding and continue that Bead, or use a different session for the new Bead; no flag replaces a saved owner and a deliberate task switch is a later verified protocol", `msb-workflow recover --workspace ${saved.binding.workspace} --session ${binding.sessionIdentity}`, { savedBeadId: saved.binding.beadId, savedWorkspace: saved.binding.workspace }), refreshed: false }
	}
	store.writeBinding(binding)
	return { refusal: null, refreshed: saved.status === "available" }
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

/** Everything a bind resolves before touching Beads: the session, the Git top level, and the evidence pointer. */
async function prepare(request: BindRequest, context: CommandContext): Promise<Prepared | CommandOutcome> {
	const session = resolveSession(request.session, context.env)
	if (session.status !== "resolved") return sessionOutcome(session)
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

export async function runBind(request: BindRequest, context: CommandContext, stateHome: string, diagnostics: Diagnostics): Promise<BindResult> {
	const prepared = await prepare(request, context)
	if ("station" in prepared) return { outcome: prepared, knownSecretValues: [] }
	const beads = context.openBeads(context.env.MSB_WORKFLOW_BD_EXECUTABLE ?? "", request.workspace, context.cwd)
	const secrets = (): readonly string[] => beads.knownSecretValues()
	const owner = await readOwner(beads, request)
	if (isOutcome(owner)) return { outcome: owner, knownSecretValues: secrets() }
	const binding = bindingFor(request, prepared, owner, context.now().toISOString())
	const recoveryStore = context.openStore(stateHome)
	diagnostics.log("bind.started", { beadId: request.beadId, sessionSource: prepared.source, executableDigest: owner.store.executableDigest })
	let written: { refusal: CommandOutcome | null; refreshed: boolean }
	try {
		written = await recoveryStore.withLocks(request.workspace, prepared.session, async () => lockedWrite({ store: recoveryStore, binding, source: prepared.source, diagnostics }))
	} catch (error) {
		// Also an expected outcome the envelope names in full; Contract Core allows exactly one human stderr line.
		diagnostics.log("bind.failed", { kind: error instanceof RuntimeFailure ? error.kind : "unknown" })
		return { outcome: writeOutcome(error, request.workspace, prepared.session), knownSecretValues: secrets() }
	}
	if (written.refusal !== null) return { outcome: written.refusal, knownSecretValues: secrets() }
	const panel = buildPanel({ binding, stale: false, store: owner.store, bead: owner.bead, gates: owner.gates, prime: null })
	diagnostics.log("bind.completed", { beadId: request.beadId, refreshed: written.refreshed })
	const message = `binding ${written.refreshed ? "refreshed" : "written"} for ${prepared.session} -> ${request.beadId}`
	return { outcome: success("bound", message, { bindingPath: recoveryStore.bindingPath(prepared.session), refreshed: written.refreshed, binding: { ...binding }, ...panel.facts }, panel.nextSafeAction), knownSecretValues: secrets() }
}
