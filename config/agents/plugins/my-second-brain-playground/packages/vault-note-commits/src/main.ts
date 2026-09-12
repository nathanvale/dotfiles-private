import { createHash, randomUUID } from "node:crypto"
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

const schemaVersion = 1 as const
const manifestName = "vault-note-commit.json"
const runIdPattern = /^vnc-[a-f0-9]{32}$/
const invalidLockOwnerGraceMs = 1_000

type Command = "begin" | "finish" | "help"
type State = "none" | "partial" | "complete"

interface Manifest {
	schemaVersion: 1
	runId: string
	vault: string
	worktree: string
	commonGitDirectory: string
	baseCommit: string
	paths: string[]
}

interface Result {
	schemaVersion: 1
	ok: boolean
	command: Command
	code: string
	runId: string | null
	changedState: State
	sideEffects: string[]
	retrySafe: boolean
	nextAction: string
	worktree?: string
	commit?: string | undefined
	paths?: string[]
	receipt?: string
	originalCode?: "INTEGRATED" | "NO_CHANGES"
	diagnostics?: string[]
	diagnosticsPath?: string
}

interface Receipt extends Manifest {
	code: "INTEGRATED" | "NO_CHANGES"
	commit?: string
}

class Refusal extends Error {
	constructor(readonly result: Result) {
		super(result.code)
	}
}

function outcome(
	ok: boolean,
	command: Command,
	code: string,
	runId: string | null,
	nextAction: string,
	extra: Partial<Omit<Result, "schemaVersion" | "ok" | "command" | "code" | "runId" | "nextAction">> = {},
): Result {
	return {
		schemaVersion,
		ok,
		command,
		code,
		runId,
		changedState: "none",
		sideEffects: [],
		retrySafe: true,
		nextAction,
		...extra,
	}
}

function refuse(
	command: Command,
	code: string,
	runId: string | null,
	nextAction: string,
	extra: Parameters<typeof outcome>[5] = {},
): never {
	throw new Refusal(outcome(false, command, code, runId, nextAction, extra))
}

interface ProcessResult {
	exitCode: number
	stdout: string
	stderr: string
}

function run(command: string[], cwd: string): ProcessResult {
	const child = Bun.spawnSync(command, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	})
	return {
		exitCode: child.exitCode,
		stdout: new TextDecoder().decode(child.stdout),
		stderr: new TextDecoder().decode(child.stderr),
	}
}

function git(cwd: string, args: string[], command: "begin" | "finish", runId: string | null): string {
	const result = run(["git", "--no-optional-locks", ...args], cwd)
	if (result.exitCode !== 0) {
		refuse(
			command,
			"GIT_FAILED",
			runId,
			command === "begin"
				? "Confirm the vault is a healthy local Git checkout, then retry begin."
				: "Inspect the preserved candidate and local Git state before retrying finish.",
			command === "finish"
				? { changedState: "partial", sideEffects: ["candidate-worktree-preserved"], retrySafe: false }
				: {},
		)
	}
	return result.stdout.trim()
}

function splitNul(value: string): string[] {
	return value.split("\0").filter(Boolean)
}

function flags(args: string[], allowed: Set<string>, command: "begin" | "finish"): Map<string, string[]> {
	const parsed = new Map<string, string[]>()
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index]
		const value = args[index + 1]
		if (key === undefined || value === undefined || !allowed.has(key) || value.startsWith("--")) {
			refuse(command, "INVALID_USAGE", null, "Run vault-note-commits --help and use the documented flags.")
		}
		parsed.set(key, [...(parsed.get(key) ?? []), value])
	}
	return parsed
}

function one(parsed: Map<string, string[]>, key: string, command: "begin" | "finish"): string {
	const values = parsed.get(key) ?? []
	const value = values[0]
	if (values.length !== 1 || value === undefined) {
		refuse(command, "INVALID_USAGE", null, `Provide ${key} exactly once.`)
	}
	return value
}

function canonicalVault(input: string): string {
	let vault: string
	try {
		vault = realpathSync(input)
	} catch {
		refuse("begin", "VAULT_NOT_FOUND", null, "Provide an existing vault checkout with --vault.")
	}
	const top = git(vault, ["rev-parse", "--show-toplevel"], "begin", null)
	if (realpathSync(top) !== vault || git(vault, ["branch", "--show-current"], "begin", null) !== "main") {
		refuse("begin", "NOT_CANONICAL_MAIN", null, "Run begin from the root checkout while it has main checked out.")
	}
	return vault
}

function configuredVault(): string {
	const configRoot = process.env.XDG_CONFIG_HOME ?? (process.env.HOME ? join(process.env.HOME, ".config") : "")
	if (!configRoot || !isAbsolute(configRoot)) {
		refuse("begin", "CONFIG_HOME_INVALID", null, "Set XDG_CONFIG_HOME to an absolute path or set HOME, then retry begin.")
	}
	const path = join(configRoot, "my-second-brain-playground", "vault.json")
	let payload: unknown
	try {
		payload = JSON.parse(readFileSync(path, "utf8"))
	} catch {
		refuse("begin", "CONFIG_MISSING", null, `Create ${path} with the playground vault path, then retry begin.`)
	}
	if (
		typeof payload !== "object" ||
		payload === null ||
		Array.isArray(payload) ||
		(payload as { schemaVersion?: unknown }).schemaVersion !== 1 ||
		typeof (payload as { vault?: unknown }).vault !== "string" ||
		!isAbsolute((payload as { vault: string }).vault) ||
		Object.keys(payload).sort().join(",") !== "schemaVersion,vault"
	) {
		refuse("begin", "CONFIG_INVALID", null, `Repair ${path} to contain only schemaVersion 1 and one absolute vault path.`)
	}
	return (payload as { vault: string }).vault
}

function admittedPath(vault: string, input: string): string {
	if (!input || isAbsolute(input)) {
		refuse("begin", "INVALID_PATH", null, "Use non-empty paths relative to the vault root.")
	}
	const target = resolve(vault, input)
	const path = relative(vault, target)
	if (!path || path === ".." || path.startsWith(`..${sep}`)) {
		refuse("begin", "INVALID_PATH", null, "Keep every admitted path inside the vault.")
	}
	let cursor = vault
	for (const component of path.split(sep)) {
		cursor = join(cursor, component)
		if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
			refuse("begin", "SYMLINK_PATH_UNSUPPORTED", null, "Use a path whose existing components are not symbolic links.")
		}
	}
	return path
}

function stateRoot(command: "begin" | "finish"): string {
	const root = process.env.XDG_STATE_HOME ?? (process.env.HOME ? join(process.env.HOME, ".local", "state") : "")
	if (!root || !isAbsolute(root)) refuse(command, "STATE_HOME_MISSING", null, "Set an absolute XDG_STATE_HOME or HOME, then retry.")
	return join(root, "my-second-brain", "vault-note-commits")
}

function receiptPath(worktree: string): string {
	return join(stateRoot("finish"), "receipts", `${createHash("sha256").update(worktree).digest("hex")}.json`)
}

function privateDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 })
	if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error("Unsafe state directory")
	chmodSync(path, 0o700)
}

function atomicPrivateJson(path: string, payload: unknown): void {
	privateDirectory(dirname(path))
	const temporary = `${path}.${randomUUID()}.tmp`
	const descriptor = openSync(temporary, "wx", 0o600)
	try {
		writeFileSync(descriptor, `${JSON.stringify(payload)}\n`)
		fsyncSync(descriptor)
	} finally {
		closeSync(descriptor)
	}
	renameSync(temporary, path)
	const directory = openSync(dirname(path), "r")
	try {
		fsyncSync(directory)
	} finally {
		closeSync(directory)
	}
}

function completionRef(runId: string): string {
	return `refs/vault-note-commits/${runId}`
}

function validateReceiptStorage(path: string): void {
	const metadata = lstatSync(path)
	const directory = lstatSync(dirname(path))
	if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600 ||
		!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700) {
		throw new Error("Unsafe receipt")
	}
}

function validateReceiptShape(receipt: Receipt): void {
	const keys = Object.keys(receipt).sort().join(",")
	const expectedKeys = ["schemaVersion", "runId", "vault", "worktree", "commonGitDirectory", "baseCommit", "paths", "code", ...(receipt.code === "INTEGRATED" ? ["commit"] : [])].sort().join(",")
	if (keys !== expectedKeys || receipt.schemaVersion !== 1 || typeof receipt.runId !== "string" || !runIdPattern.test(receipt.runId) ||
		typeof receipt.worktree !== "string" || typeof receipt.vault !== "string" || !isAbsolute(receipt.vault) ||
		typeof receipt.commonGitDirectory !== "string" || !isAbsolute(receipt.commonGitDirectory) ||
		typeof receipt.baseCommit !== "string" || !/^[a-f0-9]{40,64}$/.test(receipt.baseCommit) ||
		!Array.isArray(receipt.paths) || receipt.paths.length === 0 ||
		receipt.paths.some((entry) => typeof entry !== "string" || !entry || isAbsolute(entry) || entry.split(sep).includes("..")) ||
		!samePaths(receipt.paths, [...new Set(receipt.paths)].sort()) ||
		(receipt.code !== "INTEGRATED" && receipt.code !== "NO_CHANGES")) {
		throw new Error("Invalid receipt")
	}
}

function validateReceiptIdentity(receipt: Receipt, worktree: string): void {
	const vaultId = createHash("sha256").update(receipt.vault).digest("hex").slice(0, 16)
	if (worktree !== join(realpathSync(stateRoot("finish")), vaultId, receipt.runId)) throw new Error("Mismatched receipt identity")
	const common = run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], receipt.vault)
	if (common.exitCode !== 0 || common.stdout.trim() !== receipt.commonGitDirectory) throw new Error("Changed vault identity")
}

function validateReceiptGitEvidence(receipt: Receipt): void {
	const evidenceCommit = receipt.code === "INTEGRATED" ? receipt.commit : receipt.baseCommit
	if (typeof evidenceCommit !== "string" || !/^[a-f0-9]{40,64}$/.test(evidenceCommit)) throw new Error("Invalid completion commit")
	const reference = run(["git", "rev-parse", "--verify", completionRef(receipt.runId)], receipt.vault)
	if (reference.exitCode !== 0 || reference.stdout.trim() !== evidenceCommit) throw new Error("Mismatched completion reference")
	const ancestry = run(["git", "merge-base", "--is-ancestor", evidenceCommit, "main"], receipt.vault)
	if (ancestry.exitCode !== 0) throw new Error("Completion absent from main")
	if (receipt.code === "INTEGRATED") {
		const paths = run(["git", "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", evidenceCommit], receipt.vault)
		if (paths.exitCode !== 0 || !samePaths(splitNul(paths.stdout).sort(), receipt.paths)) throw new Error("Completion paths differ")
	}
}

function readReceipt(worktree: string): Result | undefined {
	const path = receiptPath(worktree)
	if (!existsSync(path)) return undefined
	try {
		validateReceiptStorage(path)
		const receipt = JSON.parse(readFileSync(path, "utf8")) as Receipt
		validateReceiptShape(receipt)
		if (receipt.worktree !== worktree) throw new Error("Mismatched receipt worktree")
		validateReceiptIdentity(receipt, worktree)
		validateReceiptGitEvidence(receipt)
		return outcome(true, "finish", "ALREADY_COMPLETED", receipt.runId, existsSync(worktree)
			? "Completion is recorded. Inspect the retained candidate before removing it; no new write was performed."
			: "The original finish completed. No new write was performed.", {
			originalCode: receipt.code, worktree, commit: receipt.commit, paths: receipt.paths, receipt: path,
		})
	} catch {
		refuse("finish", "RECEIPT_INVALID", null, "Preserve the receipt and inspect its identity and local Git evidence before continuing.", { retrySafe: false, receipt: path, worktree })
	}
}

function manifestPath(worktree: string, command: "begin" | "finish", runId: string | null): string {
	const gitDirectory = git(worktree, ["rev-parse", "--absolute-git-dir"], command, runId)
	return join(gitDirectory, manifestName)
}

function begin(args: string[]): Result {
	const parsed = flags(args, new Set(["--vault", "--path"]), "begin")
	const vaultValues = parsed.get("--vault") ?? []
	if (vaultValues.length > 1) refuse("begin", "INVALID_USAGE", null, "Provide --vault at most once.")
	const vault = canonicalVault(vaultValues[0] ?? configuredVault())
	const requested = parsed.get("--path") ?? []
	if (requested.length === 0) refuse("begin", "INVALID_USAGE", null, "Provide at least one --path.")
	const paths = [...new Set(requested.map((path) => admittedPath(vault, path)))].sort()
	const runId = `vnc-${randomUUID().replaceAll("-", "")}`
	const vaultId = createHash("sha256").update(vault).digest("hex").slice(0, 16)
	const requestedWorktree = join(stateRoot("begin"), vaultId, runId)
	mkdirSync(dirname(requestedWorktree), { recursive: true, mode: 0o700 })
	chmodSync(stateRoot("begin"), 0o700)
	chmodSync(dirname(requestedWorktree), 0o700)
	const baseCommit = git(vault, ["rev-parse", "main"], "begin", runId)
	git(vault, ["worktree", "add", "--detach", requestedWorktree, baseCommit], "begin", runId)
	const worktree = realpathSync(requestedWorktree)
	const manifest: Manifest = {
		schemaVersion,
		runId,
		vault,
		worktree,
		commonGitDirectory: git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"], "begin", runId),
		baseCommit,
		paths,
	}
	const target = manifestPath(worktree, "begin", runId)
	writeFileSync(target, `${JSON.stringify(manifest)}\n`, { mode: 0o600 })
	chmodSync(target, 0o600)
	return outcome(true, "begin", "CANDIDATE_READY", runId, "Edit only the admitted paths in the returned worktree, then run finish.", {
		changedState: "partial",
		sideEffects: ["candidate-worktree-created"],
		worktree,
		paths,
	})
}

function readManifest(input: string): Manifest {
	let worktree: string
	try {
		worktree = realpathSync(input)
	} catch {
		refuse("finish", "CANDIDATE_NOT_FOUND", null, "Run begin to create a new candidate.")
	}
	let manifest: Manifest
	try {
		manifest = JSON.parse(readFileSync(manifestPath(worktree, "finish", null), "utf8")) as Manifest
	} catch (error) {
		if (error instanceof Refusal) throw error
		refuse("finish", "MANIFEST_INVALID", null, "Preserve the candidate and inspect its Git metadata before continuing.", {
			changedState: "partial",
			sideEffects: ["candidate-worktree-preserved"],
			retrySafe: false,
			worktree,
		})
	}
	if (
		manifest.schemaVersion !== schemaVersion ||
		!runIdPattern.test(manifest.runId) ||
		manifest.worktree !== worktree ||
		!Array.isArray(manifest.paths) ||
		git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"], "finish", manifest.runId) !==
			manifest.commonGitDirectory
	) {
		refuse("finish", "MANIFEST_INVALID", manifest.runId ?? null, "Preserve the candidate and inspect its Git metadata before continuing.", {
			changedState: "partial",
			sideEffects: ["candidate-worktree-preserved"],
			retrySafe: false,
			worktree,
		})
	}
	return manifest
}

function changedPaths(worktree: string, baseCommit: string, runId: string): string[] {
	const tracked = splitNul(git(worktree, ["diff", "--name-only", "-z", baseCommit, "--"], "finish", runId))
	const untracked = splitNul(git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"], "finish", runId))
	return [...new Set([...tracked, ...untracked])].sort()
}

function samePaths(actual: string[], admitted: string[]): boolean {
	return actual.length === admitted.length && actual.every((path, index) => path === admitted[index])
}

function overlappingPaths(left: string[], right: string[]): string[] {
	const rightSet = new Set(right)
	return left.filter((path) => rightSet.has(path))
}

function pause(milliseconds: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function preserve(manifest: Manifest, code: string, nextAction: string, retrySafe = true, commit?: string): never {
	refuse("finish", code, manifest.runId, nextAction, {
		changedState: "partial",
		sideEffects: [commit ? "candidate-commit-preserved" : "candidate-worktree-preserved"],
		retrySafe,
		worktree: manifest.worktree,
		commit,
		paths: manifest.paths,
	})
}

function checkCandidate(manifest: Manifest): void {
	const result = run([process.execPath, "run", "check"], manifest.worktree)
	if (result.exitCode !== 0) {
		const diagnosticsPath = join(stateRoot("finish"), "diagnostics", `${manifest.runId}.json`)
		atomicPrivateJson(diagnosticsPath, { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr })
		refuse("finish", "CHECK_FAILED", manifest.runId, "Read the private checker diagnostics, fix the admitted files in the candidate, then retry finish.", {
			changedState: "partial", sideEffects: ["candidate-worktree-preserved", "checker-diagnostics-written"],
			worktree: manifest.worktree, paths: manifest.paths, diagnosticsPath,
		})
	}
}

function checkWhitespace(manifest: Manifest, committed: boolean): void {
	const result = run(["git", "-c", "core.whitespace=blank-at-eol,blank-at-eof,space-before-tab", "diff", "--check", ...(committed ? [manifest.baseCommit, "HEAD"] : ["--cached", manifest.baseCommit]), "--", ...manifest.paths], manifest.worktree)
	if (result.exitCode !== 0) {
		// Git prints the offending content on the next line. Expose only file/line diagnostics.
		const diagnostics = result.stdout.split("\n").filter((line) => /^.+:\d+: (trailing whitespace|new blank line at EOF|space before tab in indent)\.$/.test(line))
		refuse("finish", "FORMAT_FAILED", manifest.runId, "Fix the reported whitespace in the admitted candidate files, then retry finish.", {
			changedState: "partial", sideEffects: ["candidate-worktree-preserved"], worktree: manifest.worktree, paths: manifest.paths, diagnostics,
		})
	}
}

function candidateCommit(manifest: Manifest, message: string): string | undefined {
	const head = git(manifest.worktree, ["rev-parse", "HEAD"], "finish", manifest.runId)
	if (head !== manifest.baseCommit) {
		if (git(manifest.worktree, ["status", "--porcelain"], "finish", manifest.runId)) {
			preserve(manifest, "CANDIDATE_CHANGED_AFTER_COMMIT", "Inspect and restore the candidate to its committed state before retrying.", false, head)
		}
		const count = git(manifest.worktree, ["rev-list", "--count", `${manifest.baseCommit}..HEAD`], "finish", manifest.runId)
		const committed = splitNul(git(manifest.worktree, ["diff", "--name-only", "-z", `${manifest.baseCommit}..HEAD`, "--"], "finish", manifest.runId)).sort()
		if (count !== "1" || !samePaths(committed, manifest.paths)) {
			preserve(manifest, "CANDIDATE_HISTORY_INVALID", "Inspect the candidate history before continuing.", false, head)
		}
		checkCandidate(manifest)
		if (git(manifest.worktree, ["status", "--porcelain"], "finish", manifest.runId)) {
			preserve(manifest, "CHECK_CHANGED_CANDIDATE", "The checker changed the committed candidate. Inspect those changes before retrying.", false, head)
		}
		checkWhitespace(manifest, true)
		return head
	}
	const changed = changedPaths(manifest.worktree, manifest.baseCommit, manifest.runId)
	if (changed.length === 0) return undefined
	if (!samePaths(changed, manifest.paths)) {
		preserve(manifest, "PATH_SET_MISMATCH", "Change exactly the paths admitted by begin, then retry finish.")
	}
	checkCandidate(manifest)
	if (!samePaths(changedPaths(manifest.worktree, manifest.baseCommit, manifest.runId), manifest.paths)) {
		preserve(manifest, "PATH_SET_MISMATCH", "The checker changed the admitted file set. Inspect the candidate and restore the intended scope before retrying.")
	}
	git(manifest.worktree, ["add", "--", ...manifest.paths], "finish", manifest.runId)
	checkWhitespace(manifest, false)
	git(manifest.worktree, ["commit", "-m", message], "finish", manifest.runId)
	return git(manifest.worktree, ["rev-parse", "HEAD"], "finish", manifest.runId)
}

function complete(manifest: Manifest, commit?: string): Result {
	const code = commit ? "INTEGRATED" : "NO_CHANGES"
	const receipt = receiptPath(manifest.worktree)
	try {
		git(manifest.vault, ["update-ref", completionRef(manifest.runId), commit ?? manifest.baseCommit], "finish", manifest.runId)
		atomicPrivateJson(receipt, { ...manifest, code, ...(commit ? { commit } : {}) } satisfies Receipt)
	} catch {
		preserve(manifest, "COMPLETION_RECORD_FAILED", commit
			? "The commit reached main but its receipt could not be saved. Inspect main and the preserved candidate before retrying."
			: "No note changed but its receipt could not be saved. Preserve the candidate and inspect local state before retrying.", false, commit)
	}
	const removed = run(["git", "--no-optional-locks", "worktree", "remove", manifest.worktree], manifest.vault)
	return outcome(true, "finish", code, manifest.runId, removed.exitCode === 0
		? commit ? "Run remote sync separately when you want to publish main." : "No candidate changes were authored. This does not verify the freshness of canonical notes."
		: "Completion is recorded. Inspect the retained candidate before removing it.", {
		changedState: commit ? "complete" : "none",
		sideEffects: [...(commit ? ["canonical-main-fast-forwarded"] : []), "completion-reference-written", "completion-receipt-written", ...(removed.exitCode === 0 ? ["candidate-worktree-removed"] : [])],
		worktree: manifest.worktree, commit, paths: manifest.paths, receipt,
	})
}

function ownerIsLive(path: string): boolean {
	const ownerPath = join(path, "owner.json")
	let modified: number
	let contents: string
	try {
		modified = lstatSync(path).mtimeMs
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ENOENT")
	}
	try {
		modified = Math.max(modified, lstatSync(ownerPath).mtimeMs)
		contents = readFileSync(ownerPath, "utf8")
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) return true
		return Date.now() - modified < invalidLockOwnerGraceMs
	}
	let owner: unknown
	try {
		owner = JSON.parse(contents)
	} catch {
		return Date.now() - modified < invalidLockOwnerGraceMs
	}
	const pid = typeof owner === "object" && owner !== null && "pid" in owner ? owner.pid : undefined
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return Date.now() - modified < invalidLockOwnerGraceMs
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH")
	}
}

function acquireLock(manifest: Manifest): string {
	const lock = join(manifest.commonGitDirectory, "vault-note-commits.lock")
	for (let attempt = 0; attempt < 81; attempt++) {
		try {
			mkdirSync(lock, { mode: 0o700 })
			return lock
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
			if (existsSync(lock) && !ownerIsLive(lock)) {
				rmSync(lock, { recursive: true, force: true })
				continue
			}
			if (attempt < 80) {
				pause(25)
				continue
			}
			preserve(manifest, "INTEGRATION_BUSY", "Wait for the active finisher to release the local integration lock, then retry.")
		}
	}
	return preserve(manifest, "INTEGRATION_BUSY", "Remove the stale integration lock after inspection, then retry.", false)
}

function withLock<T>(manifest: Manifest, action: () => T): T {
	const lock = acquireLock(manifest)
	let result: T
	try {
		writeFileSync(join(lock, "owner.json"), `${JSON.stringify({ schemaVersion, runId: manifest.runId, pid: process.pid })}\n`, {
			mode: 0o600,
		})
		result = action()
	} catch (error) {
		try {
			rmSync(lock, { recursive: true, force: true })
		} catch {
			// Preserve the action failure when releasing the lock also fails.
		}
		throw error
	}
	rmSync(lock, { recursive: true, force: true })
	return result
}

function integrate(manifest: Manifest, commit: string): Result {
	return withLock(manifest, () => {
		const completed = readReceipt(manifest.worktree)
		if (completed) return completed
		const vault = realpathSync(manifest.vault)
		if (git(vault, ["branch", "--show-current"], "finish", manifest.runId) !== "main" ||
			git(vault, ["status", "--porcelain"], "finish", manifest.runId)) {
			preserve(manifest, "CANONICAL_NOT_READY", "Restore a clean canonical main checkout, then retry finish.", true, commit)
		}
		const currentMain = git(vault, ["rev-parse", "HEAD"], "finish", manifest.runId)
		let integratedCommit = commit
		if (currentMain !== manifest.baseCommit) {
			const ancestry = run(["git", "--no-optional-locks", "merge-base", "--is-ancestor", manifest.baseCommit, currentMain], vault)
			if (ancestry.exitCode !== 0) {
				preserve(manifest, "MAIN_DIVERGED", "Preserve the candidate and reconcile canonical main before continuing.", false, commit)
			}
			const mainChanges = splitNul(git(vault, ["diff", "--name-only", "-z", manifest.baseCommit, currentMain, "--"], "finish", manifest.runId)).sort()
			const overlap = overlappingPaths(mainChanges, manifest.paths)
			if (overlap.length > 0) {
				preserve(manifest, "SEMANTIC_OVERLAP", `Resolve the concurrent changes to ${overlap.join(", ")} with Nathan.`, false, commit)
			}
			const rebased = run(["git", "--no-optional-locks", "rebase", "--onto", currentMain, manifest.baseCommit, commit], manifest.worktree)
			if (rebased.exitCode !== 0) {
				run(["git", "--no-optional-locks", "rebase", "--abort"], manifest.worktree)
				preserve(manifest, "REBASE_FAILED", "Preserve the candidate and inspect its relationship to canonical main.", false, commit)
			}
			integratedCommit = git(manifest.worktree, ["rev-parse", "HEAD"], "finish", manifest.runId)
			const rebasedPaths = splitNul(git(manifest.worktree, ["diff", "--name-only", "-z", `${integratedCommit}^`, integratedCommit, "--"], "finish", manifest.runId)).sort()
			if (!samePaths(rebasedPaths, manifest.paths)) {
				preserve(manifest, "REBASED_PATH_SET_MISMATCH", "Preserve the candidate and inspect its rebased commit before continuing.", false, integratedCommit)
			}
			checkCandidate(manifest)
		}
		const merged = run(["git", "--no-optional-locks", "merge", "--ff-only", integratedCommit], vault)
		if (merged.exitCode !== 0 || git(vault, ["rev-parse", "HEAD"], "finish", manifest.runId) !== integratedCommit) {
			preserve(manifest, "INTEGRATION_UNPROVED", "Inspect canonical main and the candidate before taking another action.", false, integratedCommit)
		}
		return complete(manifest, integratedCommit)
	})
}

function finish(args: string[]): Result {
	const parsed = flags(args, new Set(["--worktree", "--message"]), "finish")
	const worktree = one(parsed, "--worktree", "finish")
	const message = one(parsed, "--message", "finish").trim()
	if (!message || message.includes("\n")) refuse("finish", "INVALID_USAGE", null, "Provide one non-empty commit subject with --message.")
	if (!isAbsolute(worktree) || resolve(worktree) !== worktree) refuse("finish", "INVALID_USAGE", null, "Use the exact absolute worktree path returned by begin.")
	const completed = readReceipt(worktree)
	if (completed) return completed
	const manifest = readManifest(worktree)
	const commit = candidateCommit(manifest, message)
	return commit ? integrate(manifest, commit) : withLock(manifest, () => readReceipt(worktree) ?? complete(manifest))
}

const usage = `Vault Note Commits

Usage:
  vault-note-commits begin [--vault <path>] --path <relative-path> [--path <relative-path>...] [--json]
  vault-note-commits finish --worktree <path> --message <subject> [--json]

begin creates a detached candidate worktree from local main. finish admits exactly the declared paths,
runs bun run check and Git whitespace checks including new files, creates one commit,
and integrates it into a clean canonical main checkout.
Disjoint candidates rebase onto newer local main; overlapping paths stop for semantic resolution.
Unchanged candidates return NO_CHANGES without a commit. Partially changed declared sets still refuse.
Completion receipts are stored in private XDG state before candidate cleanup. Retry finish with the
same absolute worktree path to recover ALREADY_COMPLETED, originalCode, and the original commit.
Retries perform no new write. A crash before receipt persistence still requires inspection.
Without --vault, begin reads ~/.config/my-second-brain-playground/vault.json (or XDG_CONFIG_HOME).
Remote sync is a separate operation.`

function runCommand(command: string, args: string[]): Result {
	if (command === "begin") return begin(args)
	if (command === "finish") return finish(args)
	return refuse("help", "INVALID_USAGE", null, "Run vault-note-commits --help.")
}

function failureResult(command: string | undefined, error: unknown): Result {
	if (error instanceof Refusal) return error.result
	const safeCommand = command === "begin" || command === "finish" ? command : "help"
	return outcome(false, safeCommand, "UNEXPECTED_FAILURE", null, "Preserve any candidate worktree and inspect the local error before retrying.", { retrySafe: false })
}

function printFailure(result: Result, json: boolean): void {
	if (json) console.log(JSON.stringify(result))
	else console.error(`${result.code}: ${result.nextAction}`)
	if (result.diagnostics?.length) console.error(result.diagnostics.join("\n"))
	process.exitCode = 1
}

function main(): void {
	const raw = process.argv.slice(2)
	const json = raw.includes("--json")
	const args = raw.filter((argument) => argument !== "--json")
	const command = args.shift()
	if (command === "--help" || command === "-h" || command === undefined) {
		console.log(usage)
		return
	}
	try {
		const result = runCommand(command, args)
		console.log(json ? JSON.stringify(result) : `${result.code}: ${result.nextAction}`)
	} catch (error) {
		printFailure(failureResult(command, error), json)
	}
}

main()
