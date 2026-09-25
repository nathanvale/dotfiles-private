// Public process seam for the guard and legacy rows: spawn the alias front door (or $VAULT_NOTE_COMMITS_COMMAND) against
// a fresh temp vault with the Unit 1 hook installed at .git/hooks/reference-transaction. Every expected code, exit,
// warning, and stream in the tests is a literal; nothing is read from the production modules.
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { HOOK_TEXT } from "../guard/hook-text.ts"

const sourceCommand = resolve(import.meta.dir, "../../src/legacy/main.ts")
const command = process.env.VAULT_NOTE_COMMITS_COMMAND ?? sourceCommand
const commandPrefix = command === sourceCommand ? [process.execPath, command] : [command]

export interface CommandResult {
	exitCode: number
	stdout: string
	stderr: string
	json: Record<string, unknown>
}

export interface Fixture {
	root: string
	vault: string
	state: string
	initialHead: string
	hookPath: string
}

const temporaryRoots: string[] = []

export function cleanupFixtures(): void {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
}

function spawnOptions(cwd: string, environment: Record<string, string>) {
	return { cwd, stdout: "pipe" as const, stderr: "pipe" as const, env: { ...process.env, ...environment, GIT_TERMINAL_PROMPT: "0" } }
}

export function runAlias(cwd: string, arguments_: string[], environment: Record<string, string> = {}, json = true): CommandResult {
	const result = Bun.spawnSync([...commandPrefix, ...arguments_, ...(json ? ["--json"] : [])], spawnOptions(cwd, environment))
	const stdout = new TextDecoder().decode(result.stdout)
	return { exitCode: result.exitCode, stdout, stderr: new TextDecoder().decode(result.stderr), json: json ? (JSON.parse(stdout) as Record<string, unknown>) : {} }
}

export async function runAliasAsync(cwd: string, arguments_: string[], environment: Record<string, string> = {}): Promise<CommandResult> {
	const child = Bun.spawn([...commandPrefix, ...arguments_, "--json"], spawnOptions(cwd, environment))
	const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
	return { exitCode, stdout, stderr, json: JSON.parse(stdout) as Record<string, unknown> }
}

export function git(cwd: string, ...arguments_: string[]): string {
	const result = Bun.spawnSync(["git", ...arguments_], spawnOptions(cwd, {}))
	if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
	return new TextDecoder().decode(result.stdout).trim()
}

// Git without throwing: exit code and stderr for denial rows.
export function gitResult(cwd: string, arguments_: string[], environment: Record<string, string> = {}): { exitCode: number; stderr: string } {
	const result = Bun.spawnSync(["git", ...arguments_], spawnOptions(cwd, environment))
	return { exitCode: result.exitCode, stderr: new TextDecoder().decode(result.stderr) }
}

export function write(root: string, path: string, contents: string): void {
	const target = join(root, path)
	mkdirSync(dirname(target), { recursive: true })
	writeFileSync(target, contents)
}

export function installHook(vault: string, text = HOOK_TEXT, hooksDirectory = join(vault, ".git", "hooks")): string {
	const hookPath = join(hooksDirectory, "reference-transaction")
	mkdirSync(hooksDirectory, { recursive: true })
	writeFileSync(hookPath, text)
	chmodSync(hookPath, 0o755)
	return hookPath
}

// A post-rewrite hook that adds an unadmitted file to a rebased commit. Once semantic overlap is ruled out this is the
// one way the rebased commit's path set can differ from the admitted set; it reaches that refusal through the public CLI.
export function installRewriteHook(vault: string): void {
	write(vault, ".git/hooks/post-rewrite", "#!/bin/sh\ncase \"$1\" in rebase) printf 'x\\n' > unexpected.md; git add unexpected.md; git commit -q --amend --no-edit ;; esac\nexit 0\n")
	chmodSync(join(vault, ".git/hooks/post-rewrite"), 0o700)
}

export function fixture(options: { hook?: boolean | string; hookSource?: string } = {}): Fixture {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "vault-steward-test-")))
	temporaryRoots.push(root)
	const vault = join(root, "vault")
	const state = join(root, "state")
	mkdirSync(vault)
	git(vault, "init", "-b", "main")
	git(vault, "config", "user.name", "Vault Test")
	git(vault, "config", "user.email", "vault-test@example.invalid")
	write(vault, "package.json", `${JSON.stringify({ private: true, scripts: { check: "bun run check.ts" } }, null, 2)}\n`)
	write(vault, "check.ts", 'import { existsSync } from "node:fs"\nif (existsSync("BROKEN")) { console.error("broken fixture"); process.exit(1) }\n')
	write(vault, "README.md", "# Fixture vault\n")
	write(vault, "projects/demo/GOAL.md", "# Goal\n\nOpen.\n")
	git(vault, "add", "--", "package.json", "check.ts", "README.md", "projects/demo/GOAL.md")
	git(vault, "commit", "-m", "chore: initialize fixture")
	const hook = options.hook ?? true
	const hookPath = hook === false ? join(vault, ".git", "hooks", "reference-transaction") : installHook(vault, hook === true ? HOOK_TEXT : hook)
	if (options.hookSource !== undefined) {
		write(vault, "scripts/git-hooks/reference-transaction", options.hookSource)
		git(vault, "add", "--", "scripts/git-hooks/reference-transaction")
		git(vault, "commit", "-m", "chore: hook source")
	}
	return { root, vault, state, initialHead: git(vault, "rev-parse", "HEAD"), hookPath }
}

export function begin(fixture: Fixture, paths: string[]): CommandResult {
	return runAlias(fixture.vault, ["begin", "--vault", fixture.vault, ...paths.flatMap((path) => ["--path", path])], { XDG_STATE_HOME: fixture.state })
}

export function finish(fixture: Fixture, worktree: string, message = "docs: record vault update"): CommandResult {
	return runAlias(fixture.vault, ["finish", "--worktree", worktree, "--message", message], { XDG_STATE_HOME: fixture.state })
}

export function finishAsync(fixture: Fixture, worktree: string, message = "docs: record vault update"): Promise<CommandResult> {
	return runAliasAsync(fixture.vault, ["finish", "--worktree", worktree, "--message", message], { XDG_STATE_HOME: fixture.state })
}

// The candidate worktree of a fresh begin with one authored change, ready to finish.
export function authoredCandidate(fixture: Fixture, path = "projects/demo/GOAL.md", contents = "# Goal\n\nCompleted.\n"): string {
	const started = begin(fixture, [path])
	if (started.json.code !== "CANDIDATE_READY") throw new Error(`begin failed: ${started.stdout}`)
	const worktree = started.json.worktree as string
	write(worktree, path, contents)
	return worktree
}

// The set of Git lock files under .git, for the L1 "lock set unchanged" method.
export function lockFiles(vault: string): string[] {
	const gitDirectory = join(vault, ".git")
	return readdirSync(gitDirectory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".lock"))
		.map((entry) => join(entry.parentPath, entry.name))
		.sort()
}
