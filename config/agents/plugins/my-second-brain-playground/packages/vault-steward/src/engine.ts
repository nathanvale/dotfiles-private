// Policy and state transitions of the Vault Steward CLI. Every I/O call goes through the Runtime port; every refusal is
// a Refusal carrying a sealed reason and facts, rendered by a front door (legacy schemaVersion 1 today, Contract Core
// 2.0 in the next unit). The step order is the legacy sequence inventoried in CONTRACT.md 2.6.
import { createHash, randomUUID } from "node:crypto"
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path"
import { acquireLock, lockPath, ownerIsLive, releaseLock } from "./integration-lock.ts"
import {
	type CandidateState,
	type Completion,
	commitPattern,
	type EffectId,
	type Manifest,
	manifestName,
	type PreviewRecord,
	type Receipt,
	type RefusalFacts,
	type RefusalReason,
	runIdPattern,
	schemaVersion,
	type TransactionState,
	type ValidReceipt,
} from "./model.ts"
import type { Runtime, SpawnOutcome } from "./runtime.ts"

export class Refusal extends Error {
	constructor(
		readonly reason: RefusalReason,
		readonly facts: RefusalFacts = {},
		readonly transaction: TransactionState = "unchanged",
	) {
		super(reason)
	}
}

export function refuse(reason: RefusalReason, facts: RefusalFacts = {}, transaction: TransactionState = "unchanged"): never {
	throw new Refusal(reason, facts, transaction)
}

// Facts a Git failure inherits from the step that issued it (legacy GIT_FAILED extras and hazard H2 truthfulness).
interface GitContext {
	runId: string | null
	worktree?: string
	worktreeCreated?: boolean
	// The transaction state a failure of this step reports (default unchanged, or partial once the worktree exists).
	transaction?: TransactionState
	completedEffects?: EffectId[]
	uncertainEffects?: EffectId[]
}

function git(rt: Runtime, cwd: string, args: string[], context: GitContext): string {
	const result = started(rt.spawn(["git", "--no-optional-locks", ...args], { cwd }))
	if (result.exitCode !== 0) {
		const { transaction, ...facts } = context
		refuse("git-failed", { ...facts, detail: result.stderr.trim() }, transaction ?? (context.worktreeCreated ? "partially-completed" : "unchanged"))
	}
	return result.stdout.trim()
}

// Non-refusing Git read: exit code and output only, for evidence checks that tolerate failure.
export function gitQuiet(rt: Runtime, cwd: string, args: string[]): SpawnOutcome {
	return started(rt.spawn(["git", "--no-optional-locks", ...args], { cwd }))
}

// A child that could not start at all (for example a vanished cwd) is not a verdict; it propagates as unexpected.
function started(result: SpawnOutcome): SpawnOutcome {
	if (result.spawnError !== null) throw new Error(result.spawnError)
	return result
}

function splitNul(value: string): string[] {
	return value.split("\0").filter(Boolean)
}

export function samePaths(actual: string[], admitted: string[]): boolean {
	return actual.length === admitted.length && actual.every((path, index) => path === admitted[index])
}

export function overlappingPaths(left: string[], right: string[]): string[] {
	const rightSet = new Set(right)
	return left.filter((path) => rightSet.has(path))
}

function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex")
}

export function vaultIdentity(vault: string): string {
	return sha256Hex(vault).slice(0, 16)
}

function completionRef(runId: string): string {
	return `refs/vault-note-commits/${runId}`
}

function newRunId(): string {
	return `vnc-${randomUUID().replaceAll("-", "")}`
}

// ---------------------------------------------------------------------------------------------------------------------
// Pure policy

export function stateRoot(rt: Runtime): string {
	const home = rt.env.HOME
	const root = rt.env.XDG_STATE_HOME ?? (home ? join(home, ".local", "state") : "")
	if (!root || !isAbsolute(root)) refuse("state-home-missing")
	return join(root, "my-second-brain", "vault-note-commits")
}

function receiptPath(rt: Runtime, worktree: string): string {
	return join(stateRoot(rt), "receipts", `${sha256Hex(worktree)}.json`)
}

function configPath(rt: Runtime): string {
	const home = rt.env.HOME
	const configRoot = rt.env.XDG_CONFIG_HOME ?? (home ? join(home, ".config") : "")
	if (!configRoot || !isAbsolute(configRoot)) refuse("config-home-invalid")
	return join(configRoot, "my-second-brain-playground", "vault.json")
}

// Closed config schema: exactly {schemaVersion: 1, vault: <absolute>}.
export function configuredVaultFrom(payload: unknown): string | null {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null
	const record = payload as { schemaVersion?: unknown; vault?: unknown }
	if (record.schemaVersion !== 1 || typeof record.vault !== "string" || !isAbsolute(record.vault)) return null
	if (Object.keys(payload).sort().join(",") !== "schemaVersion,vault") return null
	return record.vault
}

export function configuredVault(rt: Runtime): string {
	const path = configPath(rt)
	let text: string
	try {
		text = rt.readText(path)
	} catch {
		refuse("config-absent", { detail: path })
	}
	let payload: unknown
	try {
		payload = JSON.parse(text)
	} catch {
		refuse("config-unparseable", { detail: path })
	}
	const vault = configuredVaultFrom(payload)
	if (vault === null) refuse("config-off-schema", { detail: path })
	return vault
}

// Path fencing without the filesystem: form, then containment. Symlink components are checked by admittedPath.
export function fencePath(vault: string, input: string): string {
	if (!input || isAbsolute(input)) refuse("path-form-invalid")
	const path = relative(vault, resolve(vault, input))
	if (!path || path === ".." || path.startsWith(`..${sep}`)) refuse("path-escapes-vault")
	return path
}

function admittedPath(rt: Runtime, vault: string, input: string): string {
	const path = fencePath(vault, input)
	let cursor = vault
	for (const component of path.split(sep)) {
		cursor = join(cursor, component)
		if (rt.fileFacts(cursor).kind === "symlink") refuse("path-symlink-component")
	}
	return path
}

function admittedPaths(rt: Runtime, vault: string, requested: string[]): string[] {
	return [...new Set(requested.map((path) => admittedPath(rt, vault, path)))].sort()
}

function validPathList(paths: unknown): paths is string[] {
	return (
		Array.isArray(paths) &&
		paths.length > 0 &&
		paths.every((entry) => typeof entry === "string" && entry && !isAbsolute(entry) && !entry.split(sep).includes("..")) &&
		samePaths(paths, [...new Set(paths)].sort())
	)
}

export function validateReceiptShape(receipt: Receipt): void {
	const keys = Object.keys(receipt).sort().join(",")
	const expectedKeys = ["schemaVersion", "runId", "vault", "worktree", "commonGitDirectory", "baseCommit", "paths", "code", ...(receipt.code === "INTEGRATED" ? ["commit"] : [])].sort().join(",")
	if (
		keys !== expectedKeys ||
		receipt.schemaVersion !== 1 ||
		typeof receipt.runId !== "string" ||
		!runIdPattern.test(receipt.runId) ||
		typeof receipt.worktree !== "string" ||
		typeof receipt.vault !== "string" ||
		!isAbsolute(receipt.vault) ||
		typeof receipt.commonGitDirectory !== "string" ||
		!isAbsolute(receipt.commonGitDirectory) ||
		typeof receipt.baseCommit !== "string" ||
		!commitPattern.test(receipt.baseCommit) ||
		!validPathList(receipt.paths) ||
		(receipt.code !== "INTEGRATED" && receipt.code !== "NO_CHANGES")
	) {
		throw new Error("Invalid receipt")
	}
}

export function manifestShapeValid(manifest: Manifest, worktree: string): boolean {
	return manifest.schemaVersion === schemaVersion && runIdPattern.test(manifest.runId) && manifest.worktree === worktree && validPathList(manifest.paths) && manifest.paths.every((path) => normalize(path) === path && !path.endsWith(sep))
}

// Git prints the offending content on the next line. Expose only file/line diagnostics.
export function whitespaceFindings(stdout: string): string[] {
	return stdout.split("\n").filter((line) => /^.+:\d+: (trailing whitespace|new blank line at EOF|space before tab in indent)\.$/.test(line))
}

// ---------------------------------------------------------------------------------------------------------------------
// Vault resolution and begin

export function canonicalVault(rt: Runtime, input: string): string {
	let vault: string
	try {
		vault = rt.realpath(input)
	} catch {
		refuse("vault-not-found")
	}
	const context = { runId: null }
	const top = git(rt, vault, ["rev-parse", "--show-toplevel"], context)
	if (rt.realpath(top) !== vault || git(rt, vault, ["branch", "--show-current"], context) !== "main") {
		refuse("not-canonical-main")
	}
	return vault
}

export interface CandidatePlan {
	vault: string
	vaultId: string
	runId: string
	stateRoot: string
	requestedWorktree: string
	paths: string[]
}

// Everything begin decides before its first effect, in the legacy order: fencing, run id, state root.
export function planCandidate(rt: Runtime, vault: string, requested: string[]): CandidatePlan {
	const paths = admittedPaths(rt, vault, requested)
	const runId = newRunId()
	const vaultId = vaultIdentity(vault)
	const root = stateRoot(rt)
	return { vault, vaultId, runId, stateRoot: root, requestedWorktree: join(root, vaultId, runId), paths }
}

export interface CreatedCandidate {
	manifest: Manifest
}

// The two begin effects: the detached candidate worktree, then its manifest. A failure after `worktree add` reports the
// worktree as created (hazard H2, CONTRACT.md 4.2 A5).
export function createCandidate(rt: Runtime, plan: CandidatePlan): CreatedCandidate {
	const context: GitContext = { runId: plan.runId }
	rt.makeDirectory(join(plan.stateRoot, plan.vaultId), 0o700)
	rt.chmod(plan.stateRoot, 0o700)
	rt.chmod(join(plan.stateRoot, plan.vaultId), 0o700)
	const baseCommit = git(rt, plan.vault, ["rev-parse", "main"], context)
	git(rt, plan.vault, ["worktree", "add", "--detach", plan.requestedWorktree, baseCommit], context)
	context.worktreeCreated = true
	context.worktree = plan.requestedWorktree
	context.completedEffects = ["candidate.worktree"]
	try {
		const worktree = rt.realpath(plan.requestedWorktree)
		context.worktree = worktree
		const manifest: Manifest = {
			schemaVersion,
			runId: plan.runId,
			vault: plan.vault,
			worktree,
			commonGitDirectory: git(rt, worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"], context),
			baseCommit,
			paths: plan.paths,
		}
		rt.writePrivateText(manifestPath(rt, worktree, context), `${JSON.stringify(manifest)}\n`)
		return { manifest }
	} catch (error) {
		if (error instanceof Refusal) throw error
		refuse("unexpected", { runId: plan.runId, worktree: context.worktree, worktreeCreated: true, completedEffects: ["candidate.worktree"], uncertainEffects: ["candidate.manifest"], detail: error instanceof Error ? error.message : String(error) }, "unknown")
	}
}

function manifestPath(rt: Runtime, worktree: string, context: GitContext): string {
	return join(git(rt, worktree, ["rev-parse", "--absolute-git-dir"], context), manifestName)
}

// ---------------------------------------------------------------------------------------------------------------------
// Receipts and manifests

function validateReceiptStorage(rt: Runtime, path: string): void {
	const file = rt.fileFacts(path)
	const directory = rt.fileFacts(join(path, ".."))
	if (file.kind !== "file" || file.mode !== 0o600 || directory.kind !== "directory" || directory.mode !== 0o700) throw new Error("Unsafe receipt")
}

function validateReceiptIdentity(rt: Runtime, receipt: Receipt, worktree: string): void {
	if (worktree !== join(rt.realpath(stateRoot(rt)), vaultIdentity(receipt.vault), receipt.runId)) throw new Error("Mismatched receipt identity")
	const common = rt.spawn(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: receipt.vault })
	if (common.exitCode !== 0 || common.stdout.trim() !== receipt.commonGitDirectory) throw new Error("Changed vault identity")
}

function validateReceiptGitEvidence(rt: Runtime, receipt: Receipt): void {
	const evidenceCommit = receipt.code === "INTEGRATED" ? receipt.commit : receipt.baseCommit
	if (typeof evidenceCommit !== "string" || !commitPattern.test(evidenceCommit)) throw new Error("Invalid completion commit")
	const reference = rt.spawn(["git", "rev-parse", "--verify", completionRef(receipt.runId)], { cwd: receipt.vault })
	if (reference.exitCode !== 0 || reference.stdout.trim() !== evidenceCommit) throw new Error("Mismatched completion reference")
	const ancestry = rt.spawn(["git", "merge-base", "--is-ancestor", evidenceCommit, "main"], { cwd: receipt.vault })
	if (ancestry.exitCode !== 0) throw new Error("Completion absent from main")
	if (receipt.code === "INTEGRATED") {
		const paths = rt.spawn(["git", "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", evidenceCommit], { cwd: receipt.vault })
		if (paths.exitCode !== 0 || !samePaths(splitNul(paths.stdout).sort(), receipt.paths)) throw new Error("Completion paths differ")
	}
}

// A valid receipt is the completion boundary: the caller short-circuits without any further spawn.
export function readReceipt(rt: Runtime, worktree: string): ValidReceipt | undefined {
	const path = receiptPath(rt, worktree)
	if (!rt.exists(path)) return undefined
	try {
		validateReceiptStorage(rt, path)
		const receipt = JSON.parse(rt.readText(path)) as Receipt
		validateReceiptShape(receipt)
		if (receipt.worktree !== worktree) throw new Error("Mismatched receipt worktree")
		validateReceiptIdentity(rt, receipt, worktree)
		validateReceiptGitEvidence(rt, receipt)
		return { receipt, path }
	} catch {
		refuse("receipt-invalid", { receipt: path, worktree })
	}
}

export function readManifest(rt: Runtime, input: string): Manifest {
	let worktree: string
	try {
		worktree = rt.realpath(input)
	} catch {
		refuse("candidate-not-found")
	}
	let manifest: Manifest
	try {
		manifest = JSON.parse(rt.readText(manifestPath(rt, worktree, { runId: null }))) as Manifest
	} catch (error) {
		if (error instanceof Refusal) throw error
		refuse("manifest-invalid", { runId: null, worktree })
	}
	if (!manifestShapeValid(manifest, worktree) || git(rt, worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { runId: manifest.runId }) !== manifest.commonGitDirectory) {
		refuse("manifest-invalid", { runId: manifest.runId ?? null, worktree })
	}
	return manifest
}

// ---------------------------------------------------------------------------------------------------------------------
// Candidate validation (legacy phase C)

function candidateFacts(manifest: Manifest, commit?: string): RefusalFacts {
	return { runId: manifest.runId, worktree: manifest.worktree, paths: manifest.paths, ...(commit ? { commit } : {}) }
}

function context(manifest: Manifest): GitContext {
	return { runId: manifest.runId, worktree: manifest.worktree }
}

function changedPaths(rt: Runtime, manifest: Manifest): string[] {
	const tracked = splitNul(git(rt, manifest.worktree, ["diff", "--name-only", "-z", manifest.baseCommit, "--"], context(manifest)))
	const untracked = splitNul(git(rt, manifest.worktree, ["ls-files", "--others", "--exclude-standard", "-z"], context(manifest)))
	return [...new Set([...tracked, ...untracked])].sort()
}

function canonicalRoot(rt: Runtime, manifest: Manifest): string {
	try {
		return rt.realpath(manifest.vault)
	} catch {
		return manifest.vault
	}
}

// `bun run check` inside the candidate. VAULT_CANONICAL_ROOT lets the vault checker resolve sibling links from a
// state-root candidate (Unit 1a). Failure output is kept private under the run store.
function runChecker(rt: Runtime, manifest: Manifest, afterRebase: boolean): void {
	const result = started(rt.spawn([rt.execPath, "run", "check"], {
		cwd: manifest.worktree,
		env: { ...rt.env, GIT_TERMINAL_PROMPT: "0", VAULT_CANONICAL_ROOT: canonicalRoot(rt, manifest) },
	}))
	if (result.exitCode !== 0) {
		const diagnosticsPath = join(stateRoot(rt), "diagnostics", `${manifest.runId}.json`)
		rt.atomicPrivateJson(diagnosticsPath, { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr })
		refuse(afterRebase ? "rebased-check-failed" : "check-failed", { ...candidateFacts(manifest), diagnosticsPath, afterRebase })
	}
}

function checkWhitespace(rt: Runtime, manifest: Manifest, range: string[], facts: RefusalFacts): void {
	const result = started(rt.spawn(["git", "-c", "core.whitespace=blank-at-eol,blank-at-eof,space-before-tab", "diff", "--check", ...range, "--", ...manifest.paths], { cwd: manifest.worktree }))
	if (result.exitCode !== 0) refuse("format-failed", { ...facts, diagnostics: whitespaceFindings(result.stdout) })
}

// Hazard H1 evidence: main already contains this commit with exactly the admitted paths (CONTRACT.md 4.2 A4, 3.9).
function mainContains(rt: Runtime, manifest: Manifest, commit: string): boolean {
	const vault = canonicalRoot(rt, manifest)
	const ancestry = gitQuiet(rt, vault, ["merge-base", "--is-ancestor", commit, "refs/heads/main"])
	if (ancestry.exitCode !== 0) return false
	const paths = gitQuiet(rt, vault, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", commit])
	return paths.exitCode === 0 && samePaths(splitNul(paths.stdout).sort(), manifest.paths)
}

// Evidence that this worktree produced its HEAD: the newest HEAD reflog entry is a commit made here on top of the base
// (one commit, parent equal to the base) or the `rebase (pick)` entry the engine's own `rebase --onto` leaves. A HEAD
// merely moved onto some main commit (`checkout --detach main`, or a no-op `git rebase main` that ends on
// `rebase (start)`) is never completion evidence (review findings 1 and 5).
function candidateProducedHead(rt: Runtime, manifest: Manifest): boolean {
	const subject = gitQuiet(rt, manifest.worktree, ["reflog", "show", "-1", "--format=%gs", "HEAD"]).stdout.trim()
	if (/^rebase \(pick\)/.test(subject)) return true
	if (!/^commit\b/.test(subject)) return false
	const parent = gitQuiet(rt, manifest.worktree, ["rev-parse", "HEAD^"])
	const count = gitQuiet(rt, manifest.worktree, ["rev-list", "--count", `${manifest.baseCommit}..HEAD`])
	return parent.exitCode === 0 && parent.stdout.trim() === manifest.baseCommit && count.exitCode === 0 && count.stdout.trim() === "1"
}

function validateCommittedCandidate(rt: Runtime, manifest: Manifest, head: string): CandidateState {
	// A crashed finish always leaves the candidate clean, so the clean check precedes any recovery evidence.
	if (git(rt, manifest.worktree, ["status", "--porcelain"], context(manifest))) refuse("candidate-changed-after-commit", candidateFacts(manifest, head))
	if (candidateProducedHead(rt, manifest) && mainContains(rt, manifest, head)) return { kind: "already-on-main", commit: head }
	const count = git(rt, manifest.worktree, ["rev-list", "--count", `${manifest.baseCommit}..HEAD`], context(manifest))
	const committed = splitNul(git(rt, manifest.worktree, ["diff", "--name-only", "-z", `${manifest.baseCommit}..HEAD`, "--"], context(manifest))).sort()
	if (count !== "1" || !samePaths(committed, manifest.paths)) refuse("candidate-history-invalid", candidateFacts(manifest, head))
	runChecker(rt, manifest, false)
	if (git(rt, manifest.worktree, ["status", "--porcelain"], context(manifest))) refuse("check-changed-candidate", candidateFacts(manifest, head))
	checkWhitespace(rt, manifest, [manifest.baseCommit, "HEAD"], candidateFacts(manifest))
	return { kind: "commit", commit: head }
}

// Validate the candidate and create (or reuse) its single commit. Never touches canonical main.
export function validateCandidate(rt: Runtime, manifest: Manifest, message: string): CandidateState {
	const head = git(rt, manifest.worktree, ["rev-parse", "HEAD"], context(manifest))
	if (head !== manifest.baseCommit) return validateCommittedCandidate(rt, manifest, head)
	const changed = changedPaths(rt, manifest)
	if (changed.length === 0) return { kind: "no-changes" }
	if (!samePaths(changed, manifest.paths)) refuse("path-set-mismatch", candidateFacts(manifest))
	runChecker(rt, manifest, false)
	if (!samePaths(changedPaths(rt, manifest), manifest.paths)) refuse("path-set-changed-by-checker", candidateFacts(manifest))
	git(rt, manifest.worktree, ["add", "--", ...manifest.paths], context(manifest))
	checkWhitespace(rt, manifest, ["--cached", manifest.baseCommit], candidateFacts(manifest))
	// A failure inside `commit` leaves the candidate commit's existence unestablished.
	try {
		git(rt, manifest.worktree, ["commit", "-m", message], { ...context(manifest), transaction: "unknown", uncertainEffects: ["candidate.commit"] })
	} catch (error) {
		if (error instanceof Refusal) throw error
		refuse("unexpected", { ...candidateFacts(manifest), uncertainEffects: ["candidate.commit"], detail: error instanceof Error ? error.message : String(error) }, "unknown")
	}
	return { kind: "commit", commit: git(rt, manifest.worktree, ["rev-parse", "HEAD"], context(manifest)) }
}

// ---------------------------------------------------------------------------------------------------------------------
// Completion and integration (legacy phase D)

// Completion ref, receipt, then best-effort candidate removal. The receipt is the completion boundary.
function recordCompletion(rt: Runtime, manifest: Manifest, commit?: string, completedBefore: EffectId[] = []): Completion {
	const code = commit ? "INTEGRATED" : "NO_CHANGES"
	const receipt = receiptPath(rt, manifest.worktree)
	const completed: EffectId[] = [...completedBefore]
	try {
		git(rt, manifest.vault, ["update-ref", completionRef(manifest.runId), commit ?? manifest.baseCommit], context(manifest))
		completed.push("completion.ref")
		rt.faultPoint("before-receipt")
		rt.atomicPrivateJson(receipt, { ...manifest, code, ...(commit ? { commit } : {}) } satisfies Receipt)
	} catch {
		refuse("completion-record-failed", { ...candidateFacts(manifest, commit), afterFastForward: commit !== undefined, completedEffects: completed }, completed.length > 0 ? "partially-completed" : "unchanged")
	}
	const removed = gitQuiet(rt, manifest.vault, ["worktree", "remove", manifest.worktree])
	return { code, commit, receipt, removed: removed.exitCode === 0 }
}

function withLock<T>(rt: Runtime, manifest: Manifest, action: () => T): T {
	const lock = acquireLock(rt, manifest.commonGitDirectory, manifest.runId)
	if (lock === null) refuse("integration-busy", candidateFacts(manifest))
	let result: T
	try {
		result = action()
	} catch (error) {
		try {
			releaseLock(lock)
		} catch {
			// Preserve the action failure when releasing the lock also fails.
		}
		throw error
	}
	releaseLock(lock)
	return result
}

export type IntegrationResult = { kind: "receipt"; receipt: ValidReceipt } | { kind: "completion"; completion: Completion }

interface MainObservation {
	observedMain: string
	rebase: boolean
}

// Where canonical main stands relative to the candidate base: unchanged, or moved without touching the admitted paths.
// Refuses main-diverged and semantic-overlap; the same check runs at preview time and again under the lock.
function observeMainAt(rt: Runtime, manifest: Manifest, commit: string | undefined, vault: string, currentMain: string): MainObservation {
	if (currentMain === manifest.baseCommit || commit === undefined) return { observedMain: currentMain, rebase: false }
	const ancestry = gitQuiet(rt, vault, ["merge-base", "--is-ancestor", manifest.baseCommit, currentMain])
	if (ancestry.exitCode !== 0) refuse("main-diverged", candidateFacts(manifest, commit))
	const mainChanges = splitNul(git(rt, vault, ["diff", "--name-only", "-z", manifest.baseCommit, currentMain, "--"], context(manifest))).sort()
	const overlap = overlappingPaths(mainChanges, manifest.paths)
	if (overlap.length > 0) refuse("semantic-overlap", { ...candidateFacts(manifest, commit), overlap })
	return { observedMain: currentMain, rebase: true }
}

// Preview-time observation outside the lock, against refs/heads/main itself (the vault may be on another branch).
function observeMain(rt: Runtime, manifest: Manifest, commit: string | undefined): MainObservation {
	const vault = canonicalRoot(rt, manifest)
	const currentMain = git(rt, vault, ["rev-parse", "refs/heads/main"], context(manifest))
	return observeMainAt(rt, manifest, commit, vault, currentMain)
}

function performRebase(rt: Runtime, manifest: Manifest, commit: string, currentMain: string): string {
	const rebased = gitQuiet(rt, manifest.worktree, ["rebase", "--onto", currentMain, manifest.baseCommit, commit])
	if (rebased.exitCode !== 0) {
		gitQuiet(rt, manifest.worktree, ["rebase", "--abort"])
		refuse("rebase-failed", candidateFacts(manifest, commit))
	}
	const integrated = git(rt, manifest.worktree, ["rev-parse", "HEAD"], context(manifest))
	try {
		const rebasedPaths = splitNul(git(rt, manifest.worktree, ["diff", "--name-only", "-z", `${integrated}^`, integrated, "--"], context(manifest))).sort()
		if (!samePaths(rebasedPaths, manifest.paths)) refuse("rebased-path-set-mismatch", { ...candidateFacts(manifest, integrated), afterRebase: true })
		runChecker(rt, manifest, true)
		// Hazard H3: whitespace is rechecked on the rebased commit (CONTRACT.md 4.2 A6).
		checkWhitespace(rt, manifest, [`${integrated}^`, integrated], { ...candidateFacts(manifest, integrated), afterRebase: true })
	} catch (error) {
		// A refusal after the rebase restores the pre-rebase commit (a HEAD-only write the gate never sees) so the
		// candidate is truly unchanged and the next preview plans the rebase again (allowed difference A8).
		gitQuiet(rt, manifest.worktree, ["checkout", "--detach", commit])
		throw error
	}
	return integrated
}

// Fast-forward canonical main to the integrated commit and prove it by read-back. A failed merge whose ancestry check
// proves main did not move is safe to roll back to the pre-rebase candidate; a failed read-back remains unknown.
function fastForward(rt: Runtime, manifest: Manifest, vault: string, original: string, integrated: string): void {
	rt.faultPoint("before-ff-merge")
	const merged = gitQuiet(rt, vault, ["merge", "--ff-only", integrated])
	rt.faultPoint("after-ff-merge")
	const readBack: GitContext = { ...context(manifest), transaction: "unknown", uncertainEffects: ["main.fast-forward"] }
	const observed = git(rt, vault, ["rev-parse", "HEAD"], readBack)
	if (merged.exitCode === 0 && observed === integrated) return
	if (merged.exitCode !== 0 && gitQuiet(rt, vault, ["merge-base", "--is-ancestor", integrated, "main"]).exitCode !== 0) {
		if (integrated !== original) gitQuiet(rt, manifest.worktree, ["checkout", "--detach", original])
		refuse("integration-unproved", candidateFacts(manifest, original), "unchanged")
	}
	refuse("integration-unproved", { ...candidateFacts(manifest, integrated), uncertainEffects: ["main.fast-forward"] }, "unknown")
}

function canonicalReady(rt: Runtime, manifest: Manifest, commit: string | undefined): string {
	const vault = rt.realpath(manifest.vault)
	if (git(rt, vault, ["branch", "--show-current"], context(manifest)) !== "main" || git(rt, vault, ["status", "--porcelain"], context(manifest))) {
		refuse("canonical-not-ready", candidateFacts(manifest, commit))
	}
	return vault
}

// Under the integration lock: receipt re-read, canonical checks, optional rebase, fast-forward, completion record.
export function integrate(rt: Runtime, manifest: Manifest, commit: string): IntegrationResult {
	return withLock(rt, manifest, () => {
		const completed = readReceipt(rt, manifest.worktree)
		if (completed) return { kind: "receipt", receipt: completed }
		const vault = canonicalReady(rt, manifest, commit)
		const currentMain = git(rt, vault, ["rev-parse", "HEAD"], context(manifest))
		const observation = observeMainAt(rt, manifest, commit, vault, currentMain)
		const integrated = observation.rebase ? performRebase(rt, manifest, commit, currentMain) : commit
		fastForward(rt, manifest, vault, commit, integrated)
		return { kind: "completion", completion: recordCompletion(rt, manifest, integrated, ["main.fast-forward"]) }
	})
}

// The no-changes completion and the hazard H1 record share one shape: under the lock, re-read the receipt, else record.
export function completeWithoutIntegration(rt: Runtime, manifest: Manifest, commit?: string): IntegrationResult {
	return withLock(rt, manifest, () => {
		const completed = readReceipt(rt, manifest.worktree)
		if (completed) return { kind: "receipt", receipt: completed }
		return { kind: "completion", completion: recordCompletion(rt, manifest, commit) }
	})
}

// ---------------------------------------------------------------------------------------------------------------------
// Preview and apply (CONTRACT.md 3.7, 3.8)

function previewPath(rt: Runtime, runId: string): string {
	return join(stateRoot(rt), "previews", `${runId}.json`)
}

function previewIdentity(runId: string, observedMain: string, candidateCommit: string | null): string {
	return `preview-${runId}-${observedMain.slice(0, 12)}-${candidateCommit === null ? "none" : candidateCommit.slice(0, 12)}`
}

// The plan an apply is bound to: an integrate plan for a commit, or the no-changes completion.
export function planPreview(rt: Runtime, manifest: Manifest, state: CandidateState, createdBy: string): PreviewRecord {
	const commit = state.kind === "no-changes" ? null : state.commit
	const observation = observeMain(rt, manifest, commit ?? undefined)
	const expectedEffects: EffectId[] = commit === null ? ["completion.receipt", "completion.ref"] : ["completion.receipt", "completion.ref", "main.fast-forward"]
	return {
		schemaVersion,
		previewId: previewIdentity(manifest.runId, observation.observedMain, commit),
		runId: manifest.runId,
		worktree: manifest.worktree,
		commonGitDirectory: manifest.commonGitDirectory,
		baseCommit: manifest.baseCommit,
		candidateCommit: commit,
		observedMain: observation.observedMain,
		paths: manifest.paths,
		plan: { kind: commit === null ? "no-changes" : "integrate", rebase: observation.rebase, expectedEffects },
		consumed: false,
		createdBy,
	}
}

export function writePreview(rt: Runtime, record: PreviewRecord): string {
	const path = previewPath(rt, record.runId)
	rt.atomicPrivateJson(path, record)
	return path
}

function previewShapeValid(record: PreviewRecord): boolean {
	const keys = Object.keys(record)
		.filter((key) => key !== "consumedBy")
		.sort()
		.join(",")
	return (
		keys === "baseCommit,candidateCommit,commonGitDirectory,consumed,createdBy,observedMain,paths,plan,previewId,runId,schemaVersion,worktree" &&
		record.schemaVersion === 1 &&
		typeof record.previewId === "string" &&
		runIdPattern.test(record.runId) &&
		typeof record.worktree === "string" &&
		commitPattern.test(record.baseCommit) &&
		(record.candidateCommit === null || commitPattern.test(record.candidateCommit)) &&
		commitPattern.test(record.observedMain) &&
		Array.isArray(record.paths) &&
		typeof record.plan === "object" &&
		record.plan !== null &&
		(record.plan.kind === "integrate" || record.plan.kind === "no-changes") &&
		typeof record.plan.rebase === "boolean" &&
		Array.isArray(record.plan.expectedEffects) &&
		typeof record.consumed === "boolean"
	)
}

// The stored preview of a candidate: absent, or a validated record (an unreadable or off-shape record refuses).
export function readPreview(rt: Runtime, runId: string): { present: false } | { present: true; path: string; record: PreviewRecord } {
	const path = previewPath(rt, runId)
	if (!rt.exists(path)) return { present: false }
	let record: PreviewRecord
	try {
		record = JSON.parse(rt.readText(path)) as PreviewRecord
		if (!previewShapeValid(record)) throw new Error("Invalid preview")
	} catch {
		refuse("preview-invalid", { runId, detail: path })
	}
	return { present: true, path, record }
}

// Read-only binding of an apply to its preview (CONTRACT.md 3.8 step 1): present, unconsumed, same identity, and the
// candidate exactly as previewed.
export function bindPreview(rt: Runtime, manifest: Manifest, previewId: string): PreviewRecord {
	const stored = readPreview(rt, manifest.runId)
	const facts = candidateFacts(manifest)
	if (!stored.present) refuse("preview-not-found", facts)
	const { record } = stored
	if (record.consumed) refuse("preview-consumed", { ...facts, detail: record.previewId })
	if (record.previewId !== previewId || record.worktree !== manifest.worktree) refuse("preview-stale", { ...facts, detail: `preview ${record.previewId} supersedes ${previewId}` })
	const head = git(rt, manifest.worktree, ["rev-parse", "HEAD"], context(manifest))
	if (head !== (record.candidateCommit ?? manifest.baseCommit)) refuse("preview-stale", { ...facts, detail: `candidate HEAD ${head} differs from the previewed commit` })
	if (git(rt, manifest.worktree, ["status", "--porcelain"], context(manifest))) refuse("preview-stale", { ...facts, detail: "candidate worktree is dirty" })
	return record
}

function consumePreview(rt: Runtime, record: PreviewRecord, consumedBy: string): void {
	rt.atomicPrivateJson(previewPath(rt, record.runId), { ...record, consumed: true, consumedBy })
}

function prunePreview(rt: Runtime, runId: string): void {
	try {
		rt.removeTree(previewPath(rt, runId))
	} catch {
		// The receipt is the completion boundary; a leftover consumed preview is harmless.
	}
}

// Apply under the lock (CONTRACT.md 3.8 steps 3 to 9). Every refusal before consumption leaves the preview reusable;
// after consumption every exit is a failure with state from effect evidence.
export function applyPreview(rt: Runtime, manifest: Manifest, record: PreviewRecord, consumedBy: string): IntegrationResult {
	return withLock(rt, manifest, () => {
		const completed = readReceipt(rt, manifest.worktree)
		if (completed) return { kind: "receipt", receipt: completed }
		const commit = record.candidateCommit ?? undefined
		const vault = canonicalReady(rt, manifest, commit)
		rt.faultPoint("after-lock")
		// Re-bind under the lock: an apply that bound before another consumer's crash refuses consumed here, and one
		// bound before a newer preview (an amended candidate re-previewed) refuses stale instead of integrating the
		// superseded commit over the newer record.
		const fresh = bindPreview(rt, manifest, record.previewId)
		const currentMain = git(rt, vault, ["rev-parse", "HEAD"], context(manifest))
		if (currentMain !== fresh.observedMain) refuse("preview-stale", { ...candidateFacts(manifest, commit), detail: `main moved from ${fresh.observedMain} to ${currentMain}` })
		consumePreview(rt, fresh, consumedBy)
		rt.faultPoint("after-consume")
		try {
			if (commit === undefined) {
				const completion = recordCompletion(rt, manifest)
				prunePreview(rt, manifest.runId)
				return { kind: "completion", completion }
			}
			const integrated = fresh.plan.rebase ? performRebase(rt, manifest, commit, currentMain) : commit
				fastForward(rt, manifest, vault, commit, integrated)
			const completion = recordCompletion(rt, manifest, integrated, ["main.fast-forward"])
			prunePreview(rt, manifest.runId)
			return { kind: "completion", completion }
		} catch (error) {
			if (error instanceof Refusal) throw error
			refuse("unexpected", { ...candidateFacts(manifest, commit), detail: error instanceof Error ? error.message : String(error) }, "unknown")
		}
	})
}

// ---------------------------------------------------------------------------------------------------------------------
// Inspect and recover (CONTRACT.md 3.5, 3.9)

export interface ReceiptView {
	present: boolean
	valid: boolean
	code: "INTEGRATED" | "NO_CHANGES" | null
	path: string | null
	receipt: ValidReceipt | null
}

// The receipt as evidence, never as a refusal: inspect reports validity instead of stopping on it.
export function receiptView(rt: Runtime, worktree: string): ReceiptView {
	const path = receiptPath(rt, worktree)
	if (!rt.exists(path)) return { present: false, valid: false, code: null, path: null, receipt: null }
	try {
		const valid = readReceipt(rt, worktree)
		return valid === undefined ? { present: false, valid: false, code: null, path: null, receipt: null } : { present: true, valid: true, code: valid.receipt.code, path, receipt: valid }
	} catch {
		return { present: true, valid: false, code: null, path, receipt: null }
	}
}

export interface ManifestView {
	present: boolean
	valid: boolean
	manifest: Manifest | null
	worktreeExists: boolean
}

export function manifestView(rt: Runtime, input: string): ManifestView {
	try {
		return { present: true, valid: true, manifest: readManifest(rt, input), worktreeExists: true }
	} catch (error) {
		if (error instanceof Refusal && error.reason === "candidate-not-found") return { present: false, valid: false, manifest: null, worktreeExists: false }
		if (error instanceof Refusal && error.reason === "manifest-invalid") return { present: error.facts.runId !== null, valid: false, manifest: null, worktreeExists: true }
		throw error
	}
}

export interface CandidateView {
	head: string | null
	committed: boolean
	dirty: boolean
}

export function candidateView(rt: Runtime, manifest: Manifest): CandidateView {
	const head = gitQuiet(rt, manifest.worktree, ["rev-parse", "HEAD"])
	const sha = head.exitCode === 0 ? head.stdout.trim() : null
	const status = gitQuiet(rt, manifest.worktree, ["status", "--porcelain"])
	return { head: sha, committed: sha !== null && sha !== manifest.baseCommit, dirty: status.exitCode === 0 && status.stdout.trim() !== "" }
}

export interface MainView {
	head: string | null
	containsCandidateCommit: boolean | null
	overlap: string[]
}

export function mainView(rt: Runtime, manifest: Manifest, candidate: CandidateView): MainView {
	const vault = canonicalRoot(rt, manifest)
	const head = gitQuiet(rt, vault, ["rev-parse", "refs/heads/main"])
	if (head.exitCode !== 0) return { head: null, containsCandidateCommit: null, overlap: [] }
	const mainSha = head.stdout.trim()
	const contains = candidate.committed && candidate.head !== null ? mainContains(rt, manifest, candidate.head) : null
	let overlap: string[] = []
	if (mainSha !== manifest.baseCommit) {
		const changes = gitQuiet(rt, vault, ["diff", "--name-only", "-z", manifest.baseCommit, mainSha, "--"])
		if (changes.exitCode === 0) overlap = overlappingPaths(splitNul(changes.stdout).sort(), manifest.paths)
	}
	return { head: mainSha, containsCandidateCommit: contains, overlap }
}

export interface LockView {
	held: boolean
	ownerPid: number | null
	ownerRunId: string | null
	live: boolean | null
}

export function lockView(rt: Runtime, commonGitDirectory: string): LockView {
	const lock = lockPath(commonGitDirectory)
	if (rt.fileFacts(lock).kind !== "directory") return { held: false, ownerPid: null, ownerRunId: null, live: null }
	let ownerPid: number | null = null
	let ownerRunId: string | null = null
	try {
		const owner = JSON.parse(rt.readText(join(lock, "owner.json"))) as { pid?: unknown; runId?: unknown }
		ownerPid = typeof owner.pid === "number" ? owner.pid : null
		ownerRunId = typeof owner.runId === "string" ? owner.runId : null
	} catch {
		// An unreadable owner is reported as held with unknown identity.
	}
	return { held: true, ownerPid, ownerRunId, live: ownerIsLive(rt, lock) }
}

// The completion evidence recover needs: the candidate's current HEAD proven on main with exactly the admitted paths, or
// a no-changes completion whose ref already points at the base (a crash between the ref and the receipt).
export type RecoveryEvidence = { kind: "integrated"; commit: string } | { kind: "no-changes" } | { kind: "unprovable"; detail: string }

export function recoveryEvidence(rt: Runtime, manifest: Manifest): RecoveryEvidence {
	const candidate = candidateView(rt, manifest)
	if (candidate.dirty) return { kind: "unprovable", detail: "the candidate worktree is dirty; a crashed finish always leaves it clean" }
	if (candidate.committed && candidate.head !== null) {
		if (!candidateProducedHead(rt, manifest)) return { kind: "unprovable", detail: `candidate HEAD ${candidate.head} was not produced by this candidate (no commit or rebase reflog entry)` }
		return mainContains(rt, manifest, candidate.head) ? { kind: "integrated", commit: candidate.head } : { kind: "unprovable", detail: `main does not contain candidate HEAD ${candidate.head} with exactly the admitted paths` }
	}
	const reference = gitQuiet(rt, canonicalRoot(rt, manifest), ["rev-parse", "--verify", completionRef(manifest.runId)])
	if (reference.exitCode === 0 && reference.stdout.trim() === manifest.baseCommit) return { kind: "no-changes" }
	return { kind: "unprovable", detail: candidate.head === null ? "candidate worktree HEAD is unreadable" : "the candidate has no commit and no completion reference points at its base" }
}

// Record completion evidence under the lock; never replays the fast-forward.
export function recoverCandidate(rt: Runtime, manifest: Manifest): IntegrationResult {
	return withLock(rt, manifest, () => {
		const completed = readReceipt(rt, manifest.worktree)
		if (completed) return { kind: "receipt", receipt: completed }
		const evidence = recoveryEvidence(rt, manifest)
		if (evidence.kind === "unprovable") refuse("recovery-unprovable", { ...candidateFacts(manifest), detail: evidence.detail })
		try {
			const completion = recordCompletion(rt, manifest, evidence.kind === "integrated" ? evidence.commit : undefined)
			prunePreview(rt, manifest.runId)
			return { kind: "completion", completion }
		} catch (error) {
			if (error instanceof Refusal) throw error
			refuse("unexpected", { ...candidateFacts(manifest), detail: error instanceof Error ? error.message : String(error) }, "unknown")
		}
	})
}
