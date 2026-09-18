// Policy and state transitions of the Vault Steward CLI. Every I/O call goes through the Runtime port; every refusal is
// a Refusal carrying a sealed reason and facts, rendered by a front door (legacy schemaVersion 1 today, Contract Core
// 2.0 in the next unit). The step order is the legacy sequence inventoried in CONTRACT.md 2.6.
import { createHash, randomUUID } from "node:crypto"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { acquireLock, releaseLock } from "./integration-lock.ts"
import {
	type CandidateState,
	type Completion,
	commitPattern,
	type Manifest,
	manifestName,
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
}

function git(rt: Runtime, cwd: string, args: string[], context: GitContext): string {
	const result = started(rt.spawn(["git", "--no-optional-locks", ...args], { cwd }))
	if (result.exitCode !== 0) {
		refuse("git-failed", { ...context, detail: result.stderr.trim() }, context.worktreeCreated ? "partially-completed" : "unchanged")
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
	return manifest.schemaVersion === schemaVersion && runIdPattern.test(manifest.runId) && manifest.worktree === worktree && Array.isArray(manifest.paths)
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
		refuse("unexpected", { runId: plan.runId, worktree: context.worktree, worktreeCreated: true, detail: error instanceof Error ? error.message : String(error) }, "partially-completed")
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
	git(rt, manifest.worktree, ["commit", "-m", message], context(manifest))
	return { kind: "commit", commit: git(rt, manifest.worktree, ["rev-parse", "HEAD"], context(manifest)) }
}

// ---------------------------------------------------------------------------------------------------------------------
// Completion and integration (legacy phase D)

// Completion ref, receipt, then best-effort candidate removal. The receipt is the completion boundary.
function recordCompletion(rt: Runtime, manifest: Manifest, commit?: string): Completion {
	const code = commit ? "INTEGRATED" : "NO_CHANGES"
	const receipt = receiptPath(rt, manifest.worktree)
	try {
		git(rt, manifest.vault, ["update-ref", completionRef(manifest.runId), commit ?? manifest.baseCommit], context(manifest))
		rt.atomicPrivateJson(receipt, { ...manifest, code, ...(commit ? { commit } : {}) } satisfies Receipt)
	} catch {
		refuse("completion-record-failed", { ...candidateFacts(manifest, commit), afterFastForward: commit !== undefined }, "partially-completed")
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

function rebaseOntoMain(rt: Runtime, manifest: Manifest, commit: string, currentMain: string, vault: string): string {
	const ancestry = gitQuiet(rt, vault, ["merge-base", "--is-ancestor", manifest.baseCommit, currentMain])
	if (ancestry.exitCode !== 0) refuse("main-diverged", candidateFacts(manifest, commit))
	const mainChanges = splitNul(git(rt, vault, ["diff", "--name-only", "-z", manifest.baseCommit, currentMain, "--"], context(manifest))).sort()
	const overlap = overlappingPaths(mainChanges, manifest.paths)
	if (overlap.length > 0) refuse("semantic-overlap", { ...candidateFacts(manifest, commit), overlap })
	const rebased = gitQuiet(rt, manifest.worktree, ["rebase", "--onto", currentMain, manifest.baseCommit, commit])
	if (rebased.exitCode !== 0) {
		gitQuiet(rt, manifest.worktree, ["rebase", "--abort"])
		refuse("rebase-failed", candidateFacts(manifest, commit))
	}
	const integrated = git(rt, manifest.worktree, ["rev-parse", "HEAD"], context(manifest))
	const rebasedPaths = splitNul(git(rt, manifest.worktree, ["diff", "--name-only", "-z", `${integrated}^`, integrated, "--"], context(manifest))).sort()
	if (!samePaths(rebasedPaths, manifest.paths)) refuse("rebased-path-set-mismatch", { ...candidateFacts(manifest, integrated), afterRebase: true })
	runChecker(rt, manifest, true)
	// Hazard H3: whitespace is rechecked on the rebased commit (CONTRACT.md 4.2 A6).
	checkWhitespace(rt, manifest, [`${integrated}^`, integrated], { ...candidateFacts(manifest, integrated), afterRebase: true })
	return integrated
}

// Under the integration lock: receipt re-read, canonical checks, optional rebase, fast-forward, completion record.
export function integrate(rt: Runtime, manifest: Manifest, commit: string): IntegrationResult {
	return withLock(rt, manifest, () => {
		const completed = readReceipt(rt, manifest.worktree)
		if (completed) return { kind: "receipt", receipt: completed }
		const vault = rt.realpath(manifest.vault)
		if (git(rt, vault, ["branch", "--show-current"], context(manifest)) !== "main" || git(rt, vault, ["status", "--porcelain"], context(manifest))) {
			refuse("canonical-not-ready", candidateFacts(manifest, commit))
		}
		const currentMain = git(rt, vault, ["rev-parse", "HEAD"], context(manifest))
		const integrated = currentMain === manifest.baseCommit ? commit : rebaseOntoMain(rt, manifest, commit, currentMain, vault)
		const merged = gitQuiet(rt, vault, ["merge", "--ff-only", integrated])
		if (merged.exitCode !== 0 || git(rt, vault, ["rev-parse", "HEAD"], context(manifest)) !== integrated) {
			refuse("integration-unproved", candidateFacts(manifest, integrated), "unknown")
		}
		return { kind: "completion", completion: recordCompletion(rt, manifest, integrated) }
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
