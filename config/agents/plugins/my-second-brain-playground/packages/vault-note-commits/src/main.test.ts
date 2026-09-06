import { afterEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const sourceCommand = resolve(import.meta.dir, "main.ts")
const command = process.env.VAULT_NOTE_COMMITS_COMMAND ?? sourceCommand
const commandPrefix = command === sourceCommand ? [process.execPath, command] : [command]
const temporaryRoots: string[] = []

interface CommandResult {
	exitCode: number
	stdout: string
	stderr: string
	json: Record<string, unknown>
}

function run(cwd: string, arguments_: string[], environment: Record<string, string> = {}): CommandResult {
	const result = Bun.spawnSync([...commandPrefix, ...arguments_, "--json"], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...environment, GIT_TERMINAL_PROMPT: "0" },
	})
	const stdout = new TextDecoder().decode(result.stdout)
	return {
		exitCode: result.exitCode,
		stdout,
		stderr: new TextDecoder().decode(result.stderr),
		json: JSON.parse(stdout) as Record<string, unknown>,
	}
}

async function runAsync(cwd: string, arguments_: string[], environment: Record<string, string> = {}): Promise<CommandResult> {
	const child = Bun.spawn([...commandPrefix, ...arguments_, "--json"], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...environment, GIT_TERMINAL_PROMPT: "0" },
	})
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	])
	return { exitCode, stdout, stderr, json: JSON.parse(stdout) as Record<string, unknown> }
}

function git(cwd: string, ...arguments_: string[]): string {
	const result = Bun.spawnSync(["git", ...arguments_], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	})
	if (result.exitCode !== 0) {
		throw new Error(new TextDecoder().decode(result.stderr))
	}
	return new TextDecoder().decode(result.stdout).trim()
}

function write(root: string, path: string, contents: string): void {
	const target = join(root, path)
	mkdirSync(dirname(target), { recursive: true })
	writeFileSync(target, contents)
}

function fixture(): { root: string; vault: string; state: string; initialHead: string } {
	const root = mkdtempSync(join(tmpdir(), "vault-note-commits-test-"))
	temporaryRoots.push(root)
	const vault = join(root, "vault")
	const state = join(root, "state")
	mkdirSync(vault)
	git(vault, "init", "-b", "main")
	git(vault, "config", "user.name", "Vault Test")
	git(vault, "config", "user.email", "vault-test@example.invalid")
	write(vault, "package.json", `${JSON.stringify({ private: true, scripts: { check: "bun run check.ts" } }, null, 2)}\n`)
	write(
		vault,
		"check.ts",
		'import { existsSync } from "node:fs"\nif (existsSync("BROKEN")) { console.error("broken fixture"); process.exit(1) }\n',
	)
	write(vault, "README.md", "# Fixture vault\n")
	write(vault, "projects/demo/GOAL.md", "# Goal\n\nOpen.\n")
	git(vault, "add", "--", "package.json", "check.ts", "README.md", "projects/demo/GOAL.md")
	git(vault, "commit", "-m", "chore: initialize fixture")
	return { root, vault, state, initialHead: git(vault, "rev-parse", "HEAD") }
}

function begin(vault: string, state: string, paths: string[]): CommandResult {
	return run(
		vault,
		["begin", "--vault", vault, ...paths.flatMap((path) => ["--path", path])],
		{ XDG_STATE_HOME: state },
	)
}

function finish(vault: string, state: string, worktree: string, message = "docs: record vault update"): CommandResult {
	return run(vault, ["finish", "--worktree", worktree, "--message", message], { XDG_STATE_HOME: state })
}

function finishAsync(vault: string, state: string, worktree: string, message: string): Promise<CommandResult> {
	return runAsync(vault, ["finish", "--worktree", worktree, "--message", message], { XDG_STATE_HOME: state })
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("begin and finish create one checked project-note commit on canonical main", () => {
	const { vault, state, initialHead } = fixture()
	const started = begin(vault, state, ["projects/new-project/README.md"])

	expect(started.exitCode).toBe(0)
	expect(started.stderr).toBe("")
	expect(started.json).toMatchObject({ ok: true, code: "CANDIDATE_READY" })
	const worktree = started.json.worktree as string
	write(worktree, "projects/new-project/README.md", "# New project\n")

	const finished = finish(vault, state, worktree, "docs: create new project")
	expect(finished.exitCode).toBe(0)
	expect(finished.stderr).toBe("")
	expect(finished.json).toMatchObject({ ok: true, code: "INTEGRATED" })
	const canonicalHead = git(vault, "rev-parse", "HEAD")
	expect(canonicalHead).not.toBe(initialHead)
	expect(git(vault, "rev-list", "--count", `${initialHead}..${canonicalHead}`)).toBe("1")
	expect(git(vault, "diff-tree", "--no-commit-id", "--name-only", "-r", canonicalHead)).toBe(
		"projects/new-project/README.md",
	)
	expect(readFileSync(join(vault, "projects/new-project/README.md"), "utf8")).toBe("# New project\n")
	expect(() => readFileSync(worktree)).toThrow()
})

test("begin discovers the playground vault from XDG config", () => {
	const { root, vault, state } = fixture()
	const config = join(root, "config")
	write(config, "my-second-brain-playground/vault.json", `${JSON.stringify({ schemaVersion: 1, vault })}\n`)
	const started = run(vault, ["begin", "--path", "projects/new-project/README.md"], {
		XDG_CONFIG_HOME: config,
		XDG_STATE_HOME: state,
	})

	expect(started.json).toMatchObject({ ok: true, code: "CANDIDATE_READY" })
})

test.each([".", "../vault", ""])("begin refuses relative configured vault %j without creating a candidate", (configured) => {
	const { root, vault, state, initialHead } = fixture()
	const config = join(root, "config")
	write(config, "my-second-brain-playground/vault.json", JSON.stringify({ schemaVersion: 1, vault: configured }))
	const started = run(vault, ["begin", "--path", "projects/new-project/README.md"], {
		XDG_CONFIG_HOME: config,
		XDG_STATE_HOME: state,
	})
	expect(started.exitCode).toBe(1)
	expect(started.stderr).toBe("")
	expect(started.json).toMatchObject({ ok: false, command: "begin", code: "CONFIG_INVALID", changedState: "none" })
	expect(existsSync(state)).toBe(false)
	expect(git(vault, "rev-parse", "HEAD")).toBe(initialHead)
})

test.each(["begin", "finish"])("%s retains its command identity for malformed flags", (activeCommand) => {
	const { vault, state } = fixture()
	for (const invalid of [["--unknown", "value"], ["--path"]]) {
		const refused = run(vault, [activeCommand, ...invalid], { XDG_STATE_HOME: state })
		expect(refused.exitCode).toBe(1)
		expect(refused.stderr).toBe("")
		expect(refused.json).toMatchObject({ ok: false, command: activeCommand, code: "INVALID_USAGE" })
	}
})

test.each(["begin", "finish"])("%s retains its command identity for invalid state roots", (activeCommand) => {
	const { vault } = fixture()
	const args = activeCommand === "begin"
		? ["begin", "--vault", vault, "--path", "projects/demo/GOAL.md"]
		: ["finish", "--worktree", join(vault, "candidate"), "--message", "docs: goal"]
	const refused = run(vault, args, { XDG_STATE_HOME: "relative-state" })
	expect(refused.exitCode).toBe(1)
	expect(refused.stderr).toBe("")
	expect(refused.json).toMatchObject({ ok: false, command: activeCommand, code: "STATE_HOME_MISSING" })
})

test("the same journey updates an existing goal note", () => {
	const { vault, state } = fixture()
	const started = begin(vault, state, ["projects/demo/GOAL.md"])
	const worktree = started.json.worktree as string
	write(worktree, "projects/demo/GOAL.md", "# Goal\n\nCompleted.\n")

	const finished = finish(vault, state, worktree, "docs: complete demo goal")
	expect(finished.json).toMatchObject({ ok: true, code: "INTEGRATED" })
	expect(readFileSync(join(vault, "projects/demo/GOAL.md"), "utf8")).toContain("Completed")
})

test("checker failure preserves the uncommitted candidate and canonical head", () => {
	const { vault, state, initialHead } = fixture()
	const started = begin(vault, state, ["BROKEN"])
	const worktree = started.json.worktree as string
	write(worktree, "BROKEN", "fail\n")

	const finished = finish(vault, state, worktree)
	expect(finished.exitCode).toBe(1)
	expect(finished.json).toMatchObject({
		ok: false,
		code: "CHECK_FAILED",
		changedState: "partial",
		worktree,
	})
	expect(git(vault, "rev-parse", "HEAD")).toBe(initialHead)
	expect(readFileSync(join(worktree, "BROKEN"), "utf8")).toBe("fail\n")
	const diagnostics = finished.json.diagnosticsPath as string
	expect(statSync(diagnostics).mode & 0o777).toBe(0o600)
	expect(JSON.parse(readFileSync(diagnostics, "utf8"))).toMatchObject({ exitCode: 1 })
	expect(readFileSync(diagnostics, "utf8")).toContain("broken fixture")
})

test("an out-of-scope change is preserved without touching canonical main", () => {
	const { vault, state, initialHead } = fixture()
	const started = begin(vault, state, ["projects/demo/GOAL.md"])
	const worktree = started.json.worktree as string
	write(worktree, "projects/demo/GOAL.md", "# Goal\n\nCompleted.\n")
	write(worktree, "unexpected.md", "outside scope\n")

	const finished = finish(vault, state, worktree)
	expect(finished.json).toMatchObject({ ok: false, code: "PATH_SET_MISMATCH", worktree })
	expect(git(vault, "rev-parse", "HEAD")).toBe(initialHead)
	expect(readFileSync(join(worktree, "unexpected.md"), "utf8")).toBe("outside scope\n")
})

test("dirty canonical state preserves a committed candidate for a safe retry", () => {
	const { vault, state, initialHead } = fixture()
	const started = begin(vault, state, ["projects/demo/GOAL.md"])
	const worktree = started.json.worktree as string
	write(worktree, "projects/demo/GOAL.md", "# Goal\n\nCompleted.\n")
	write(vault, "README.md", "# Nathan's staged draft\n")
	git(vault, "add", "--", "README.md")
	write(vault, "personal-draft.md", "Nathan's work\n")
	const originalStatus = git(vault, "status", "--short")

	const blocked = finish(vault, state, worktree)
	expect(blocked.json).toMatchObject({ ok: false, code: "CANONICAL_NOT_READY", worktree })
	expect(git(vault, "rev-parse", "HEAD")).toBe(initialHead)
	expect(readFileSync(join(vault, "personal-draft.md"), "utf8")).toBe("Nathan's work\n")
	expect(git(vault, "status", "--short")).toBe(originalStatus)
	const candidateCommit = git(worktree, "rev-parse", "HEAD")
	expect(candidateCommit).not.toBe(initialHead)

	git(vault, "restore", "--staged", "README.md")
	write(vault, "README.md", "# Fixture vault\n")
	rmSync(join(vault, "personal-draft.md"))
	const retried = finish(vault, state, worktree)
	expect(retried.json).toMatchObject({ ok: true, code: "INTEGRATED", commit: candidateCommit })
	expect(git(vault, "rev-list", "--count", `${initialHead}..main`)).toBe("1")
})

test("a live integration lock preserves the committed candidate for retry", () => {
	const { vault, state, initialHead } = fixture()
	const started = begin(vault, state, ["projects/demo/GOAL.md"])
	const worktree = started.json.worktree as string
	write(worktree, "projects/demo/GOAL.md", "# Goal\n\nCompleted.\n")
	const lock = join(vault, ".git", "vault-note-commits.lock")
	mkdirSync(lock)
	write(lock, "owner.json", `${JSON.stringify({ schemaVersion: 1, runId: "another", pid: process.pid })}\n`)

	const blocked = finish(vault, state, worktree)
	expect(blocked.json).toMatchObject({ ok: false, code: "INTEGRATION_BUSY", worktree })
	expect(git(vault, "rev-parse", "HEAD")).toBe(initialHead)
	const candidateCommit = git(worktree, "rev-parse", "HEAD")
	expect(candidateCommit).not.toBe(initialHead)

	rmSync(lock, { recursive: true })
	const retried = finish(vault, state, worktree)
	expect(retried.json).toMatchObject({ ok: true, code: "INTEGRATED", commit: candidateCommit })
})

test.each(["missing", "malformed", "invalid pid"])("finish recovers an abandoned lock with %s owner", (owner) => {
	const { vault, state, initialHead } = fixture()
	const worktree = begin(vault, state, ["projects/demo/GOAL.md"]).json.worktree as string
	const lock = join(vault, ".git", "vault-note-commits.lock")
	mkdirSync(lock)
	const past = new Date(Date.now() - 60_000)
	if (owner !== "missing") {
		write(lock, "owner.json", owner === "malformed" ? "{" : JSON.stringify({ pid: 0 }))
		utimesSync(join(lock, "owner.json"), past, past)
	}
	utimesSync(lock, past, past)
	const finished = finish(vault, state, worktree)
	expect(finished.exitCode).toBe(0)
	expect(finished.stderr).toBe("")
	expect(finished.json).toMatchObject({ ok: true, command: "finish", code: "NO_CHANGES" })
	expect(existsSync(lock)).toBe(false)
	expect(git(vault, "rev-parse", "HEAD")).toBe(initialHead)
})

test.each(["missing", "malformed"])("finish gives a fresh %s owner time to publish its live PID", async (owner) => {
	const { vault, state, initialHead } = fixture()
	const worktree = begin(vault, state, ["projects/demo/GOAL.md"]).json.worktree as string
	const lock = join(vault, ".git", "vault-note-commits.lock")
	mkdirSync(lock)
	if (owner === "malformed") write(lock, "owner.json", "{")
	const finishing = finishAsync(vault, state, worktree, "docs: unchanged candidate")
	await Bun.sleep(150)
	const liveOwner = JSON.stringify({ schemaVersion: 1, runId: "publishing-owner", pid: process.pid })
	write(lock, "owner.json", liveOwner)
	const finished = await finishing
	expect(finished.exitCode).toBe(1)
	expect(finished.json).toMatchObject({ ok: false, code: "INTEGRATION_BUSY" })
	expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe(liveOwner)
	expect(existsSync(worktree)).toBe(true)
	expect(git(vault, "rev-parse", "HEAD")).toBe(initialHead)
})

test("finish preserves an unreadable present owner even after the grace period", () => {
	const { vault, state, initialHead } = fixture()
	const worktree = begin(vault, state, ["projects/demo/GOAL.md"]).json.worktree as string
	const lock = join(vault, ".git", "vault-note-commits.lock")
	mkdirSync(join(lock, "owner.json"), { recursive: true })
	const past = new Date(Date.now() - 60_000)
	utimesSync(join(lock, "owner.json"), past, past)
	utimesSync(lock, past, past)
	const finished = finish(vault, state, worktree)
	expect(finished.exitCode).toBe(1)
	expect(finished.json).toMatchObject({ ok: false, code: "INTEGRATION_BUSY" })
	expect(statSync(join(lock, "owner.json")).isDirectory()).toBe(true)
	expect(existsSync(worktree)).toBe(true)
	expect(git(vault, "rev-parse", "HEAD")).toBe(initialHead)
})

test("an unexpected failure after integration is propagated instead of retried as lock contention", () => {
	const { root, vault, state, initialHead } = fixture()
	const worktree = begin(vault, state, ["projects/demo/GOAL.md"]).json.worktree as string
	write(worktree, "projects/demo/GOAL.md", "# Goal\n\nCompleted.\n")
	const moved = join(root, "moved-vault")
	write(vault, ".git/hooks/post-merge", '#!/bin/sh\n/bin/mv "$FAULT_VAULT" "$FAULT_MOVED"\n')
	chmodSync(join(vault, ".git/hooks/post-merge"), 0o700)
	const finished = run(vault, ["finish", "--worktree", worktree, "--message", "docs: complete goal"], {
		XDG_STATE_HOME: state, FAULT_VAULT: vault, FAULT_MOVED: moved,
	})
	expect(finished.exitCode).toBe(1)
	expect(finished.stderr).toBe("")
	expect(finished.json).toMatchObject({ ok: false, code: "UNEXPECTED_FAILURE", retrySafe: false })
	expect(git(moved, "rev-list", "--count", `${initialHead}..main`)).toBe("1")
	expect(readFileSync(join(moved, "projects/demo/GOAL.md"), "utf8")).toContain("Completed")
	expect(existsSync(worktree)).toBe(true)
})

test("lock cleanup failure preserves the original integration refusal", () => {
	const { vault, state, initialHead } = fixture()
	const worktree = begin(vault, state, ["projects/demo/GOAL.md"]).json.worktree as string
	write(worktree, "projects/demo/GOAL.md", "# Goal\n\nCompleted.\n")
	git(vault, "branch", "unrelated", initialHead)
	const lock = join(vault, ".git", "vault-note-commits.lock")
	write(vault, ".git/hooks/post-merge", '#!/bin/sh\ngit symbolic-ref HEAD refs/heads/unrelated\n/bin/chmod 000 "$FAULT_LOCK"\n')
	chmodSync(join(vault, ".git/hooks/post-merge"), 0o700)
	try {
		const finished = run(vault, ["finish", "--worktree", worktree, "--message", "docs: complete goal"], {
			XDG_STATE_HOME: state, FAULT_LOCK: lock,
		})
		expect(finished.exitCode).toBe(1)
		expect(finished.json).toMatchObject({ ok: false, command: "finish", code: "INTEGRATION_UNPROVED", retrySafe: false })
		expect(git(vault, "rev-list", "--count", `${initialHead}..main`)).toBe("1")
		expect(existsSync(worktree)).toBe(true)
	} finally {
		if (existsSync(lock)) chmodSync(lock, 0o700)
	}
})

test("begin rejects a path through an existing symbolic link", () => {
	const { root, vault, state, initialHead } = fixture()
	const outside = join(root, "outside")
	mkdirSync(outside)
	symlinkSync(outside, join(vault, "linked"))

	const started = begin(vault, state, ["linked/note.md"])
	expect(started.json).toMatchObject({ ok: false, code: "SYMLINK_PATH_UNSUPPORTED" })
	expect(git(vault, "rev-parse", "HEAD")).toBe(initialHead)
	expect(() => readFileSync(join(outside, "note.md"))).toThrow()
})

test("disjoint candidates from the same base both integrate", () => {
	const { vault, state, initialHead } = fixture()
	const first = begin(vault, state, ["projects/first/README.md"])
	const second = begin(vault, state, ["projects/second/README.md"])
	const firstWorktree = first.json.worktree as string
	const secondWorktree = second.json.worktree as string
	write(firstWorktree, "projects/first/README.md", "# First\n")
	write(secondWorktree, "projects/second/README.md", "# Second\n")

	expect(finish(vault, state, firstWorktree, "docs: add first project").json).toMatchObject({
		ok: true,
		code: "INTEGRATED",
	})
	const secondFinished = finish(vault, state, secondWorktree, "docs: add second project")
	expect(secondFinished.json).toMatchObject({ ok: true, code: "INTEGRATED" })
	expect(readFileSync(join(vault, "projects/first/README.md"), "utf8")).toBe("# First\n")
	expect(readFileSync(join(vault, "projects/second/README.md"), "utf8")).toBe("# Second\n")
	expect(git(vault, "rev-list", "--count", `${initialHead}..main`)).toBe("2")
	expect(() => readFileSync(secondWorktree)).toThrow()
})

test("simultaneous disjoint finishers both integrate", async () => {
	const { vault, state, initialHead } = fixture()
	const first = begin(vault, state, ["projects/first/README.md"])
	const second = begin(vault, state, ["projects/second/README.md"])
	const firstWorktree = first.json.worktree as string
	const secondWorktree = second.json.worktree as string
	write(firstWorktree, "projects/first/README.md", "# First\n")
	write(secondWorktree, "projects/second/README.md", "# Second\n")

	const results = await Promise.all([
		finishAsync(vault, state, firstWorktree, "docs: add first project"),
		finishAsync(vault, state, secondWorktree, "docs: add second project"),
	])
	expect(results.map((result) => result.json.code).sort()).toEqual(["INTEGRATED", "INTEGRATED"])
	expect(readFileSync(join(vault, "projects/first/README.md"), "utf8")).toBe("# First\n")
	expect(readFileSync(join(vault, "projects/second/README.md"), "utf8")).toBe("# Second\n")
	expect(git(vault, "rev-list", "--count", `${initialHead}..main`)).toBe("2")
})

test("candidates touching the same path stop for semantic resolution", () => {
	const { vault, state, initialHead } = fixture()
	const first = begin(vault, state, ["projects/demo/GOAL.md"])
	const second = begin(vault, state, ["projects/demo/GOAL.md"])
	const firstWorktree = first.json.worktree as string
	const secondWorktree = second.json.worktree as string
	write(firstWorktree, "projects/demo/GOAL.md", "# Goal\n\nFirst answer.\n")
	write(secondWorktree, "projects/demo/GOAL.md", "# Goal\n\nSecond answer.\n")

	expect(finish(vault, state, firstWorktree, "docs: record first answer").json).toMatchObject({
		ok: true,
		code: "INTEGRATED",
	})
	const blocked = finish(vault, state, secondWorktree, "docs: record second answer")
	expect(blocked.json).toMatchObject({ ok: false, code: "SEMANTIC_OVERLAP", worktree: secondWorktree })
	expect(readFileSync(join(vault, "projects/demo/GOAL.md"), "utf8")).toContain("First answer")
	expect(git(vault, "rev-list", "--count", `${initialHead}..main`)).toBe("1")
})

test("repeating finish after successful cleanup cannot duplicate the commit", () => {
	const { vault, state, initialHead } = fixture()
	const started = begin(vault, state, ["projects/demo/GOAL.md"])
	const worktree = started.json.worktree as string
	write(worktree, "projects/demo/GOAL.md", "# Goal\n\nCompleted.\n")

	const finished = finish(vault, state, worktree)
	expect(finished.json).toMatchObject({ ok: true, code: "INTEGRATED" })
	expect(existsSync(worktree)).toBe(false)
	const receipt = finished.json.receipt as string
	expect(statSync(receipt).mode & 0o777).toBe(0o600)
	expect(statSync(dirname(receipt)).mode & 0o777).toBe(0o700)
	expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({ commit: finished.json.commit, code: "INTEGRATED" })
	write(vault, "personal-draft.md", "Unrelated draft\n")
	const repeated = finish(vault, state, worktree)
	expect(repeated.exitCode).toBe(0)
	expect(repeated.stderr).toBe("")
	expect(repeated.json).toMatchObject({ ok: true, code: "ALREADY_COMPLETED", originalCode: "INTEGRATED", commit: finished.json.commit, changedState: "none", sideEffects: [] })
	expect(git(vault, "rev-list", "--count", `${initialHead}..main`)).toBe("1")
	expect(readFileSync(join(vault, "personal-draft.md"), "utf8")).toBe("Unrelated draft\n")
})

test("new-file EOF whitespace is rejected with a file and line before committing", () => {
	const { vault, state, initialHead } = fixture()
	const worktree = begin(vault, state, ["products/lamp.md"]).json.worktree as string
	write(worktree, "products/lamp.md", "# Lamp\n\n\n")
	const failed = finish(vault, state, worktree)
	expect(failed.exitCode).toBe(1)
	expect(failed.json).toMatchObject({ ok: false, code: "FORMAT_FAILED", worktree })
	expect(failed.json.diagnostics).toEqual(["products/lamp.md:2: new blank line at EOF."])
	expect(failed.stderr).toContain("products/lamp.md:2")
	expect(git(worktree, "rev-parse", "HEAD")).toBe(initialHead)
	expect(git(vault, "rev-parse", "HEAD")).toBe(initialHead)
	expect(readFileSync(join(worktree, "products/lamp.md"), "utf8")).toBe("# Lamp\n\n\n")
	write(worktree, "products/lamp.md", "# Lamp\n")
	expect(finish(vault, state, worktree).json).toMatchObject({ ok: true, code: "INTEGRATED" })
})

test("unchanged candidate completes without a commit and its no-op receipt can be retried", () => {
	const { vault, state, initialHead } = fixture()
	const worktree = begin(vault, state, ["projects/demo/GOAL.md"]).json.worktree as string
	const finished = finish(vault, state, worktree)
	expect(finished.exitCode).toBe(0)
	expect(finished.stderr).toBe("")
	expect(finished.json).toMatchObject({ ok: true, code: "NO_CHANGES", changedState: "none" })
	expect(finished.json.commit).toBeUndefined()
	expect(existsSync(worktree)).toBe(false)
	expect(git(vault, "rev-parse", "HEAD")).toBe(initialHead)
	expect(finish(vault, state, worktree).json).toMatchObject({ ok: true, code: "ALREADY_COMPLETED", originalCode: "NO_CHANGES", changedState: "none", sideEffects: [] })
	expect(git(vault, "rev-parse", "HEAD")).toBe(initialHead)
})

test("no-op means no authored changes even when canonical main moves", () => {
	const { vault, state } = fixture()
	const worktree = begin(vault, state, ["projects/demo/GOAL.md"]).json.worktree as string
	write(vault, "projects/demo/GOAL.md", "# Goal\n\nChanged concurrently.\n")
	git(vault, "add", "--", "projects/demo/GOAL.md")
	git(vault, "commit", "-m", "docs: concurrent goal")
	const head = git(vault, "rev-parse", "HEAD")
	expect(finish(vault, state, worktree).json).toMatchObject({ ok: true, code: "NO_CHANGES" })
	expect(git(vault, "rev-parse", "HEAD")).toBe(head)
})

test("partly unchanged declarations still refuse a path set mismatch", () => {
	const { vault, state, initialHead } = fixture()
	const worktree = begin(vault, state, ["projects/demo/GOAL.md", "products/lamp.md"]).json.worktree as string
	write(worktree, "products/lamp.md", "# Lamp\n")
	expect(finish(vault, state, worktree).json).toMatchObject({ ok: false, code: "PATH_SET_MISMATCH" })
	expect(git(vault, "rev-parse", "HEAD")).toBe(initialHead)
	expect(existsSync(worktree)).toBe(true)
})

test("missing and corrupt completion receipts cannot claim a successful retry", () => {
	const { vault, state } = fixture()
	const worktree = begin(vault, state, ["products/lamp.md"]).json.worktree as string
	write(worktree, "products/lamp.md", "# Lamp\n")
	const completed = finish(vault, state, worktree)
	const receipt = completed.json.receipt as string
	const original = readFileSync(receipt, "utf8")
	writeFileSync(receipt, "{broken")
	expect(finish(vault, state, worktree).json).toMatchObject({ ok: false, code: "RECEIPT_INVALID" })
	const forged = JSON.parse(original)
	forged.commit = git(vault, "rev-parse", "HEAD^")
	writeFileSync(receipt, JSON.stringify(forged))
	expect(finish(vault, state, worktree).json).toMatchObject({ ok: false, code: "RECEIPT_INVALID" })
	rmSync(receipt)
	expect(finish(vault, state, worktree).json).toMatchObject({ ok: false, code: "CANDIDATE_NOT_FOUND" })
})

test("a committed candidate is checked again on retry", () => {
	const { vault, state, initialHead } = fixture()
	const worktree = begin(vault, state, ["BROKEN"]).json.worktree as string
	write(worktree, "BROKEN", "fail\n")
	git(worktree, "add", "--", "BROKEN")
	git(worktree, "commit", "-m", "docs: candidate created outside helper")
	const failed = finish(vault, state, worktree)
	expect(failed.json).toMatchObject({ ok: false, code: "CHECK_FAILED" })
	expect(git(vault, "rev-parse", "HEAD")).toBe(initialHead)
	expect(readFileSync(join(worktree, "BROKEN"), "utf8")).toBe("fail\n")
})

test("receipt identity changes and symbolic links are refused", () => {
	const { root, vault, state } = fixture()
	const worktree = begin(vault, state, ["products/lamp.md"]).json.worktree as string
	write(worktree, "products/lamp.md", "# Lamp\n")
	const completed = finish(vault, state, worktree)
	const receipt = completed.json.receipt as string
	const original = readFileSync(receipt, "utf8")
	for (const change of [{ worktree: `${worktree}/../other` }, { paths: ["../outside"] }, { runId: "vnc-00000000000000000000000000000000" }, { code: "NO_CHANGES" }]) {
		writeFileSync(receipt, JSON.stringify({ ...JSON.parse(original), ...change }))
		expect(finish(vault, state, worktree).json).toMatchObject({ ok: false, code: "RECEIPT_INVALID" })
	}
	const elsewhere = join(root, "elsewhere.json")
	writeFileSync(elsewhere, original, { mode: 0o600 })
	rmSync(receipt)
	symlinkSync(elsewhere, receipt)
	expect(finish(vault, state, worktree).json).toMatchObject({ ok: false, code: "RECEIPT_INVALID" })
	expect(readFileSync(elsewhere, "utf8")).toBe(original)
})

test("a checker changing an unadmitted file cannot sneak it into integration", () => {
	const { vault, state } = fixture()
	write(vault, "check.ts", 'import { writeFileSync } from "node:fs"\nwriteFileSync("README.md", "checker mutation\\n")\n')
	git(vault, "add", "--", "check.ts")
	git(vault, "commit", "-m", "test: define checker mutation")
	const initialHead = git(vault, "rev-parse", "HEAD")
	const worktree = begin(vault, state, ["products/lamp.md"]).json.worktree as string
	write(worktree, "products/lamp.md", "# Lamp\n")
	expect(finish(vault, state, worktree).json).toMatchObject({ ok: false, code: "PATH_SET_MISMATCH" })
	expect(git(vault, "rev-parse", "HEAD")).toBe(initialHead)
	expect(git(worktree, "rev-parse", "HEAD")).toBe(initialHead)
	expect(readFileSync(join(worktree, "README.md"), "utf8")).toBe("checker mutation\n")
})
