import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { readManifest, validateCandidate } from "../../src/engine.ts"
import { createRuntime, type SpawnOptions } from "../../src/runtime.ts"
import { cleanupFixtures, type Fixture, fixture, git, write } from "../helpers/harness.ts"
import { apply, candidate, data, must, preview, run, stewardEnvironment } from "../helpers/steward.ts"

// The candidate checker seam through real child processes: the checker child receives VAULT_NOTES_BIN (this plugin
// copy's bin/vault-notes unless the caller names one), a missing or hung checker refuses with the existing checker
// causes and leaves the stations unchanged, and the admitted path set may hold a deletion and a non-Markdown file.

setDefaultTimeout(60_000)

const hungCheckers: string[] = []

afterEach(() => {
	// A deadline kills the direct checker child only; the hung stub records its pid so the test can stop it.
	for (const pidFile of hungCheckers.splice(0)) {
		try {
			process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL")
		} catch {
			// Already gone.
		}
	}
	cleanupFixtures()
})

// Independent oracle: the plugin copy that contains this test file.
const PLUGIN_VAULT_NOTES = resolve(import.meta.dir, "../../../../bin/vault-notes")
const BUNDLE_LAUNCHER = resolve(import.meta.dir, "../../../../bin/vault-steward")

// Commit a vault checker that runs `${VAULT_NOTES_BIN:-vault-notes} check`, the shape the future vault shim takes.
// Returns the new base commit.
function shimChecker(f: Fixture): string {
	write(f.vault, "package.json", `${JSON.stringify({ private: true, scripts: { check: '"${VAULT_NOTES_BIN:-vault-notes}" check' } }, null, 2)}\n`)
	git(f.vault, "add", "--", "package.json")
	git(f.vault, "commit", "-m", "test: route the checker through VAULT_NOTES_BIN")
	return git(f.vault, "rev-parse", "HEAD")
}

// A stand-in vault-notes outside the vault: it records its argv, working directory and canonical root, then exits 1
// on a BROKEN candidate, hangs on a HANG candidate (recording its pid first), and passes otherwise.
function stubVaultNotes(f: Fixture): { bin: string; record: string; pidFile: string } {
	const bin = join(f.root, "tools", "vault-notes")
	const record = join(f.root, "vault-notes-calls.log")
	const pidFile = join(f.root, "hung-checker.pid")
	write(
		f.root,
		"tools/vault-notes",
		[
			"#!/bin/sh",
			`printf '%s|%s|%s\\n' "$*" "$(pwd -P)" "$VAULT_CANONICAL_ROOT" >> '${record}'`,
			`if [ -e HANG ]; then echo $$ > '${pidFile}'; exec sleep 60; fi`,
			'if [ -e BROKEN ]; then echo "stub vault-notes: broken" >&2; exit 1; fi',
			"exit 0",
			"",
		].join("\n"),
	)
	chmodSync(bin, 0o755)
	return { bin, record, pidFile }
}

// Commit a vault checker that records the VAULT_NOTES_BIN it received to $CHECKER_RECORD.
function recordingChecker(f: Fixture): string {
	write(f.vault, "check.ts", 'import { appendFileSync } from "node:fs"\nappendFileSync(process.env.CHECKER_RECORD ?? "", `${process.env.VAULT_NOTES_BIN ?? "<unset>"}\\n`)\n')
	git(f.vault, "add", "--", "check.ts")
	git(f.vault, "commit", "-m", "test: record the checker environment")
	return join(f.root, "checker-env.log")
}

function diagnosticsOf(message: string | undefined): Record<string, unknown> {
	const path = /checker diagnostics at (\S+)/.exec(message ?? "")?.[1]
	if (path === undefined) throw new Error(`no diagnostics path in ${message}`)
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
}

function inspectState(f: Fixture, worktree: string): Record<string, unknown> {
	return data(must(run(f, ["inspect", "--worktree", worktree]), "SUCCESS_UNCHANGED"))
}

test("the checker child receives this plugin copy's vault-notes path from source and from the shipped bundle", () => {
	const f = fixture()
	const record = recordingChecker(f)
	const worktree = candidate(f)
	must(run(f, ["finish", "--preview", "--worktree", worktree, "--message", "docs: goal"], { CHECKER_RECORD: record, VAULT_NOTES_BIN: "" }), "SUCCESS_COMPLETED")
	const bundled = Bun.spawnSync([BUNDLE_LAUNCHER, "finish", "--preview", "--worktree", worktree, "--message", "docs: goal", "--json"], {
		cwd: f.vault,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...stewardEnvironment(f), CHECKER_RECORD: record, VAULT_NOTES_BIN: "", GIT_TERMINAL_PROMPT: "0" },
	})
	expect(JSON.parse(new TextDecoder().decode(bundled.stdout)).result.causeCode).toBe("SUCCESS_COMPLETED")
	// Two checker runs per preview here: the first preview commits, the second validates the committed candidate.
	expect(readFileSync(record, "utf8")).toBe(`${PLUGIN_VAULT_NOTES}\n${PLUGIN_VAULT_NOTES}\n`)
})

// The production deadline is observed in-process: a process test cannot wait two minutes.
test("the production checker spawn carries a 120 s deadline and the plugin copy's vault-notes path", () => {
	const f = fixture()
	const worktree = candidate(f)
	const base = createRuntime()
	const checkerSpawns: SpawnOptions[] = []
	const rt = {
		...base,
		env: { ...process.env, VAULT_NOTES_BIN: undefined },
		spawn(command: string[], options: SpawnOptions) {
			if (command[1] === "run" && command[2] === "check") checkerSpawns.push(options)
			return base.spawn(command, options)
		},
	}
	expect(validateCandidate(rt, readManifest(rt, worktree), "docs: goal").kind).toBe("commit")
	expect(checkerSpawns.map((options) => [options.cwd, options.timeoutMs, options.env?.VAULT_NOTES_BIN, options.env?.VAULT_CANONICAL_ROOT])).toEqual([[worktree, 120_000, PLUGIN_VAULT_NOTES, f.vault]])
})

test("a caller-named VAULT_NOTES_BIN reaches the checker, which calls it from the candidate", () => {
	const f = fixture()
	shimChecker(f)
	const stub = stubVaultNotes(f)
	const worktree = candidate(f)
	const env = { VAULT_NOTES_BIN: stub.bin }
	const previewId = data(must(run(f, ["finish", "--preview", "--worktree", worktree, "--message", "docs: goal"], env), "SUCCESS_COMPLETED")).previewId as string
	expect(readFileSync(stub.record, "utf8")).toBe(`check|${worktree}|${f.vault}\n`)
	must(run(f, ["finish", "--apply", "--preview-id", previewId, "--worktree", worktree], env), "SUCCESS_COMPLETED")
	expect(git(f.vault, "show", "HEAD:projects/demo/GOAL.md")).toBe("# Goal\n\nCompleted.")
})

test("a missing vault-notes refuses DOMAIN_CHECK_FAILED with exit 127 diagnostics and leaves every station unchanged", () => {
	const f = fixture()
	const base = shimChecker(f)
	const worktree = candidate(f)
	const before = inspectState(f, worktree)
	const refused = run(f, ["finish", "--preview", "--worktree", worktree, "--message", "docs: goal"], { VAULT_NOTES_BIN: join(f.root, "absent", "vault-notes") })
	expect(refused.exitCode).toBe(3)
	expect(refused.envelope?.result).toMatchObject({ causeCode: "DOMAIN_CHECK_FAILED", outcome: "refused", transactionState: "unchanged", nextAction: "vault-steward.finish-preview" })
	expect(diagnosticsOf(refused.envelope?.message)).toMatchObject({ exitCode: 127 })
	expect(git(worktree, "rev-parse", "HEAD")).toBe(base)
	expect(git(f.vault, "rev-parse", "main")).toBe(base)
	expect(inspectState(f, worktree)).toEqual(before)
})

test("a hung checker is stopped at its deadline, refuses DOMAIN_CHECK_FAILED, and leaves every station unchanged", () => {
	const f = fixture()
	const base = shimChecker(f)
	const stub = stubVaultNotes(f)
	hungCheckers.push(stub.pidFile)
	const worktree = candidate(f, "HANG", "hang\n")
	const before = inspectState(f, worktree)
	const started = Date.now()
	const refused = run(f, ["finish", "--preview", "--worktree", worktree, "--message", "docs: hang"], { VAULT_NOTES_BIN: stub.bin, VAULT_STEWARD_FAULT: "checker-deadline=1500" })
	expect(Date.now() - started).toBeLessThan(20_000)
	expect(refused.exitCode).toBe(3)
	expect(refused.envelope?.result).toMatchObject({ causeCode: "DOMAIN_CHECK_FAILED", outcome: "refused", transactionState: "unchanged", nextAction: "vault-steward.finish-preview" })
	expect(refused.envelope?.message).toContain("the checker was stopped at its deadline")
	expect(diagnosticsOf(refused.envelope?.message)).toMatchObject({ exitCode: null, timedOut: true })
	expect(existsSync(stub.pidFile)).toBe(true)
	expect(git(worktree, "rev-parse", "HEAD")).toBe(base)
	expect(git(f.vault, "rev-parse", "main")).toBe(base)
	expect(inspectState(f, worktree)).toEqual(before)
})

test("a checker that hangs under the integration lock refuses DOMAIN_REBASED_CHECK_FAILED and releases the lock", () => {
	const f = fixture()
	shimChecker(f)
	const stub = stubVaultNotes(f)
	hungCheckers.push(stub.pidFile)
	const env = { VAULT_NOTES_BIN: stub.bin }
	const worktree = candidate(f)
	// main moves with a HANG file, so only the checker run on the rebased candidate (under the lock) hangs
	write(f.vault, "HANG", "hang\n")
	git(f.vault, "add", "--", "HANG")
	git(f.vault, "commit", "-m", "chore: hang the rebased checker")
	const mainBefore = git(f.vault, "rev-parse", "main")
	const previewId = data(must(run(f, ["finish", "--preview", "--worktree", worktree, "--message", "docs: goal"], env), "SUCCESS_COMPLETED")).previewId as string
	const candidateCommit = git(worktree, "rev-parse", "HEAD")
	const refused = run(f, ["finish", "--apply", "--preview-id", previewId, "--worktree", worktree], { ...env, VAULT_STEWARD_FAULT: "checker-deadline=1500" })
	expect(refused.envelope?.result).toMatchObject({ causeCode: "DOMAIN_REBASED_CHECK_FAILED", outcome: "failed", transactionState: "unchanged", nextAction: "vault-steward.finish-preview" })
	expect(diagnosticsOf(refused.envelope?.message)).toMatchObject({ exitCode: null, timedOut: true })
	expect(git(f.vault, "rev-parse", "main")).toBe(mainBefore)
	expect(git(worktree, "rev-parse", "HEAD")).toBe(candidateCommit)
	expect((inspectState(f, worktree).lock as { held: boolean }).held).toBe(false)
})

test("begin admits a deletion and a non-Markdown path; preview and apply commit both onto main", () => {
	const f = fixture()
	const started = must(run(f, ["begin", "--vault", f.vault, "--path", "projects/demo/GOAL.md", "--path", "assets/pixel.png"]), "SUCCESS_COMPLETED")
	const worktree = (data(started).candidate as { worktree: string; paths: string[] }).worktree
	expect((data(started).candidate as { paths: string[] }).paths).toEqual(["assets/pixel.png", "projects/demo/GOAL.md"])
	rmSync(join(worktree, "projects/demo/GOAL.md"))
	const pixel = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff])
	write(worktree, "assets/pixel.png", "")
	writeFileSync(join(worktree, "assets/pixel.png"), pixel)
	const previewId = preview(f, worktree, "chore: replace the goal with a pixel")
	const applied = must(apply(f, worktree, previewId), "SUCCESS_COMPLETED")
	const commit = (applied.result.data as { integration: { commit: string } }).integration.commit
	expect(git(f.vault, "rev-parse", "main")).toBe(commit)
	expect(git(f.vault, "diff-tree", "--no-commit-id", "--name-status", "-r", commit)).toBe("A\tassets/pixel.png\nD\tprojects/demo/GOAL.md")
	expect(readFileSync(join(f.vault, "assets/pixel.png"))).toEqual(pixel)
	expect(existsSync(join(f.vault, "projects/demo/GOAL.md"))).toBe(false)
})
