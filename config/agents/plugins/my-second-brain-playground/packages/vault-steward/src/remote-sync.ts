import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { gitQuiet, Refusal } from "./engine.ts"
import { acquireLock, releaseLock } from "./integration-lock.ts"
import type { EffectId, RefusalFacts } from "./model.ts"
import type { Runtime } from "./runtime.ts"

interface Upstream {
	remote: string
	branch: string
}

// Remote command output may contain credentials embedded in a URL. Publish our diagnosis, never raw transport output.
function remoteGit(rt: Runtime, vault: string, args: string[], facts: RefusalFacts = {}): string {
	const result = rt.spawn(["git", "--no-optional-locks", ...args], { cwd: vault, env: { ...rt.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes" }, timeoutMs: 20_000 })
	if (result.exitCode !== 0) throw new Refusal("git-failed", { ...facts, detail: `Remote ${args[0]} failed or timed out. Check connectivity and the vault remote's credentials; preserve the candidate and receipt.` })
	return result.stdout.trim()
}

function upstream(rt: Runtime, vault: string): Upstream {
	const remote = gitQuiet(rt, vault, ["config", "--get", "branch.main.remote"]).stdout.trim()
	const branch = gitQuiet(rt, vault, ["config", "--get", "branch.main.merge"]).stdout.trim()
	if (!remote || remote === "." || remote.startsWith("-") || branch !== "refs/heads/main") throw new Refusal("git-failed", { detail: "Configure main to track a named remote's refs/heads/main before using Vault Steward." })
	const fetch = gitQuiet(rt, vault, ["remote", "get-url", "--all", remote])
	const push = gitQuiet(rt, vault, ["remote", "get-url", "--push", "--all", remote])
	if (fetch.exitCode !== 0 || push.exitCode !== 0 || fetch.stdout.trim() !== push.stdout.trim() || fetch.stdout.trim().split("\n").length !== 1) throw new Refusal("git-failed", { detail: "The upstream must have one identical fetch and push URL; reconcile the remote configuration explicitly." })
	return { remote, branch }
}

function cleanMain(rt: Runtime, vault: string, facts: RefusalFacts): string {
	const branch = gitQuiet(rt, vault, ["branch", "--show-current"])
	const status = gitQuiet(rt, vault, ["status", "--porcelain", "--untracked-files=all"])
	if (branch.exitCode !== 0 || status.exitCode !== 0) throw new Refusal("git-failed", { ...facts, detail: "Canonical status could not be established; preserve the checkout and inspect Git." })
	if (branch.stdout.trim() !== "main" || status.stdout.trim()) throw new Refusal("canonical-not-ready", { ...facts, detail: "Synchronization preserves tracked and untracked work. Finish or preserve it before continuing." })
	const head = gitQuiet(rt, vault, ["rev-parse", "HEAD"])
	if (head.exitCode !== 0) throw new Refusal("git-failed", facts)
	return head.stdout.trim()
}

function fetchMain(rt: Runtime, vault: string, target: Upstream, facts: RefusalFacts): string {
	const observed = remoteGit(rt, vault, ["ls-remote", "--exit-code", "--refs", target.remote, target.branch], facts)
	const match = /^([a-f0-9]{40}|[a-f0-9]{64})\trefs\/heads\/main$/.exec(observed)
	if (!match) throw new Refusal("git-failed", { ...facts, detail: "Remote main could not be established. Inspect the upstream before retrying." })
	// Bind this observation before fetching ancestry objects. FETCH_HEAD is shared mutable state and cannot be evidence.
	remoteGit(rt, vault, ["fetch", "--no-write-fetch-head", "--no-tags", "--recurse-submodules=no", target.remote, target.branch], facts)
	if (gitQuiet(rt, vault, ["cat-file", "-e", `${match[1]}^{commit}`]).exitCode !== 0) throw new Refusal("git-failed", { ...facts, detail: "The observed remote commit could not be fetched. Inspect the upstream before retrying." })
	return match[1]!
}

function ancestor(rt: Runtime, vault: string, before: string, after: string): boolean {
	return gitQuiet(rt, vault, ["merge-base", "--is-ancestor", before, after]).exitCode === 0
}

function syncLocked(rt: Runtime, vault: string, facts: RefusalFacts, allowFastForward: boolean): EffectId[] {
	const before = cleanMain(rt, vault, facts)
	const target = upstream(rt, vault)
	const remote = fetchMain(rt, vault, target, facts)
	if (ancestor(rt, vault, remote, before)) return []
	if (!ancestor(rt, vault, before, remote)) throw new Refusal("main-diverged", { ...facts, detail: "Local and remote main diverged. Preserve both histories and reconcile them explicitly; synchronization never rebases or force-pushes." })
	if (!allowFastForward) throw new Refusal("preview-stale", { ...facts, detail: "Remote main advanced after preview. Run finish --preview again to refresh canonical main and bind a new plan." })
	const merge = gitQuiet(rt, vault, ["merge", "--ff-only", remote])
	const after = gitQuiet(rt, vault, ["rev-parse", "HEAD"])
	if (merge.exitCode === 0 && after.exitCode === 0 && after.stdout.trim() === remote) return ["main.fast-forward"]
	if (after.exitCode === 0 && after.stdout.trim() === before) throw new Refusal("git-failed", { ...facts, detail: "The remote fast-forward was refused without moving main. Inspect the canonical checkout." })
	throw new Refusal("git-failed", { ...facts, detail: "The remote fast-forward could not be established. Inspect main before continuing.", uncertainEffects: ["main.fast-forward"] }, "unknown")
}

// The same local integration lock serializes remote refresh with candidate applies. Fetch bookkeeping is excluded
// from domain effects; any movement of canonical main is inventoried and proven by read-back.
export function synchronizeMain(rt: Runtime, vault: string, facts: RefusalFacts = {}, allowFastForward = true): EffectId[] {
	// A current upstream needs no canonical write or lock. Keep preview preparation available while an apply holds
	// the integration lock; the existing preview binding still rejects any later main or candidate change.
	const before = cleanMain(rt, vault, facts)
	const target = upstream(rt, vault)
	const remote = fetchMain(rt, vault, target, facts)
	if (ancestor(rt, vault, remote, before)) return []
	if (!ancestor(rt, vault, before, remote)) throw new Refusal("main-diverged", { ...facts, detail: "Local and remote main diverged. Preserve both histories and reconcile explicitly." })
	if (!allowFastForward) throw new Refusal("preview-stale", { ...facts, detail: "Remote main advanced after preview. Run finish --preview again to refresh canonical main and bind a new plan." })
	const common = gitQuiet(rt, vault, ["rev-parse", "--git-common-dir"])
	if (common.exitCode !== 0) throw new Refusal("git-failed", facts)
	const lockRuntime: Runtime = { ...rt, faultPoint: (name) => rt.faultPoint(`sync-${name}`) }
	const lock = acquireLock(lockRuntime, resolve(vault, common.stdout.trim()), facts.runId ?? `sync-${randomUUID()}`)
	if (lock === null) throw new Refusal("integration-busy", facts)
	try {
		return syncLocked(rt, vault, facts, allowFastForward)
	} finally {
		releaseLock(lock)
	}
}

// A local receipt remains authoritative even when publication fails. Read remote main back before deciding whether
// push happened; an unavailable read-back is unknown and never authorizes re-integrating the candidate.
export function publishCommit(rt: Runtime, vault: string, commit: string, facts: RefusalFacts, completed: EffectId[]): EffectId[] {
	const knownState = completed.length > 0 ? "partially-completed" : "unchanged"
	let target: Upstream
	let remote: string
	try {
		cleanMain(rt, vault, facts)
		target = upstream(rt, vault)
		remote = fetchMain(rt, vault, target, facts)
	} catch (error) {
		const detail = error instanceof Refusal ? error.facts.detail : undefined
		throw new Refusal("git-failed", { ...facts, completedEffects: completed, detail: `Local completion is recorded, but publication could not start. ${detail ?? "Repair remote access."} Then repeat finish --apply or recover for this same worktree.` }, knownState)
	}
	if (ancestor(rt, vault, commit, remote)) return []
	if (!ancestor(rt, vault, remote, commit)) throw new Refusal("git-failed", { ...facts, completedEffects: completed, detail: "Local completion is recorded, but remote main has conflicting work. Preserve both histories and reconcile explicitly before repeating publication." }, knownState)
	let changedRemote: boolean | null = null
	try {
		const pushed = remoteGit(rt, vault, ["push", "--no-follow-tags", "--no-mirror", "--porcelain", target.remote, `${commit}:${target.branch}`], facts)
		changedRemote = pushed.split("\n").some((line) => /^[ *]\t/.test(line))
	} catch {
		// A rejected or disconnected push still needs independent read-back: the server may already have accepted it.
	}
	try {
		remote = fetchMain(rt, vault, target, facts)
	} catch {
		throw new Refusal("git-failed", { ...facts, completedEffects: completed, uncertainEffects: ["remote.push"], detail: "Local completion is recorded; the push outcome is unknown. Restore remote access and repeat the same apply or recover to inspect remote evidence before pushing." }, "unknown")
	}
	if (ancestor(rt, vault, commit, remote)) return changedRemote !== false ? ["remote.push"] : []
	throw new Refusal("git-failed", { ...facts, completedEffects: completed, detail: "Local completion is recorded, but remote main does not contain it. Resolve the rejected push, then repeat the same apply or recover; local integration will not replay." }, knownState)
}

export function afterSyncFailure(error: unknown, completed: EffectId[], facts: RefusalFacts = {}): never {
	if (completed.length === 0) throw error
	const original = error instanceof Refusal ? error : new Refusal("unexpected")
	throw new Refusal("git-failed", { ...facts, ...original.facts, completedEffects: [...new Set([...completed, ...(original.facts.completedEffects ?? [])])], detail: `Canonical main was synchronized before ${original.reason}: ${original.facts.detail ?? "inspect the candidate and retry its current stage"}` }, original.transaction === "unknown" ? "unknown" : "partially-completed")
}
