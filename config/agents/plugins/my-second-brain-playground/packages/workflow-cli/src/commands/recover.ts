// `recover`: read this session's binding, verify its stored workspace against --workspace, repeat the store gate
// with the bound executable, read the Bead and the Gates now, and build the Resume Panel. Nothing is written. The
// hook reuses the same pipeline so compaction delivery and recover never disagree.

import type { BeadsReader } from "../adapters/beads.ts"
import type { RecoveryStore } from "../adapters/recovery.ts"
import type { Diagnostics } from "../diagnostics.ts"
import type { CommandOutcome, RecoveryBinding } from "../model.ts"
import { buildPanel, type PanelFacts } from "../recovery.ts"
import { beadOutcome, bindingInvalidOutcome, type CommandContext, isGitRepository, refusal, resolveSession, sessionOutcome, stateUnsafeOutcome, storeOutcome, success, unavailableOutcome } from "./shared.ts"

export interface RecoverRequest {
	readonly workspace: string
	readonly session: string | null
}

export type PanelRead = { readonly status: "ready"; readonly panel: PanelFacts; readonly binding: RecoveryBinding; readonly beads: BeadsReader } | { readonly status: "refused"; readonly outcome: CommandOutcome; readonly beads: BeadsReader | null }

export interface PanelOptions {
	readonly includePrime: boolean
}

/** The shared read pipeline: binding, store gate with the bound executable, Bead, Gates, optional prime, panel. */
export async function readPanel(store: RecoveryStore, context: CommandContext, workspace: string | null, session: string, diagnostics: Diagnostics, options: PanelOptions): Promise<PanelRead> {
	const read = store.readBinding(session, context.now().getTime())
	const shown = workspace ?? "<workspace>"
	if (read.status === "absent") return { status: "refused", outcome: refusal("binding-absent", `no binding exists for session ${session}`, `Bind this session first: msb-workflow bind --workspace ${shown} --bead <bead-id> --session ${session}`, `msb-workflow bind --workspace ${shown} --bead <bead-id> --session ${session}`, { bindingPath: store.bindingPath(session) }), beads: null }
	if (read.status === "unsafe") return { status: "refused", outcome: stateUnsafeOutcome(read.reason, shown), beads: null }
	if (read.status === "unavailable") return { status: "refused", outcome: unavailableOutcome(read.reason, shown), beads: null }
	if (read.status === "invalid") return { status: "refused", outcome: bindingInvalidOutcome(read.reason, store.bindingPath(session), shown, session), beads: null }
	const binding = read.binding
	if (workspace !== null && binding.workspace !== workspace) return { status: "refused", outcome: refusal("binding-workspace-mismatch", `session ${session} is bound to workspace ${binding.workspace}, not ${workspace}`, `Run recover with --workspace ${binding.workspace}, the workspace this session was bound to`, `msb-workflow recover --workspace ${binding.workspace} --session ${session}`, { boundWorkspace: binding.workspace }), beads: null }
	const beads = context.openBeads(binding.beadsExecutable, binding.workspace, context.cwd)
	// The store gate repeats with the bound executable; `bd context` joins it only inside a Git working directory.
	const storeRead = await beads.verifyStore(isGitRepository(context.cwd))
	const storeRefusal = storeOutcome(storeRead, binding.workspace)
	if (storeRefusal !== null || storeRead.status !== "verified") return { status: "refused", outcome: storeRefusal ?? unavailableOutcome("store did not verify", binding.workspace), beads }
	const beadRead = await beads.readBead(binding.beadId)
	const beadRefusal = beadOutcome(beadRead, binding.beadId, binding.workspace)
	if (beadRefusal !== null || beadRead.status !== "found") return { status: "refused", outcome: beadRefusal ?? unavailableOutcome("Bead did not read", binding.workspace), beads }
	const gates = await beads.readGates()
	if (gates.status === "unavailable") return { status: "refused", outcome: unavailableOutcome(gates.reason, binding.workspace), beads }
	const prime = options.includePrime ? await beads.readPrime() : null
	diagnostics.log("panel.built", { beadId: binding.beadId, stale: read.stale, prime: prime !== null })
	return { status: "ready", panel: buildPanel({ binding, stale: read.stale, store: storeRead.store, bead: beadRead.bead, gates: gates.gates, prime }), binding, beads }
}

export async function runRecover(request: RecoverRequest, context: CommandContext, stateHome: string, diagnostics: Diagnostics): Promise<{ outcome: CommandOutcome; knownSecretValues: readonly string[] }> {
	const session = resolveSession(request.session, context.env)
	if (session.status !== "resolved") return { outcome: sessionOutcome(session), knownSecretValues: [] }
	const store = context.openStore(stateHome)
	const read = await readPanel(store, context, request.workspace, session.session, diagnostics, { includePrime: false })
	const knownSecretValues = read.beads?.knownSecretValues() ?? []
	if (read.status === "refused") return { outcome: read.outcome, knownSecretValues }
	return { outcome: success("recovered", `Resume Panel for ${session.session} -> ${read.binding.beadId}`, { bindingPath: store.bindingPath(session.session), ...read.panel.facts }, read.panel.nextSafeAction), knownSecretValues }
}
