import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { readManifest, validateCandidate } from "../../src/engine.ts"
import { createRuntime, type SpawnOptions } from "../../src/runtime.ts"
import { cleanupFixtures, type Fixture, fixture, git, write } from "../helpers/harness.ts"
import { apply, candidate, data, type Envelope, must, preview, run, stewardEnvironment } from "../helpers/steward.ts"

// The candidate checker seam through real child processes: the checker child always receives the running plugin copy's
// bin/vault-notes as VAULT_NOTES_BIN (a caller value is replaced), a missing vault-notes or a hung checker refuses with
// the existing checker causes and leaves the stations unchanged, and the admitted path set may hold a deletion and a
// non-Markdown file.

setDefaultTimeout(60_000)

const hungCheckers: string[] = []

afterEach(() => {
	// The deadline abandons the run: only the direct `bun run check` child is killed, so the hung checker records its
	// pid for the test to stop it.
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
const PLUGIN_ROOT = resolve(import.meta.dir, "../../../..")
const PLUGIN_VAULT_NOTES = join(PLUGIN_ROOT, "bin", "vault-notes")
const BUNDLE_LAUNCHER = join(PLUGIN_ROOT, "bin", "vault-steward")
// A caller value the engine must replace.
const STALE_VAULT_NOTES = "/stale/caller/vault-notes"

// Commit a vault checker that runs `${VAULT_NOTES_BIN:-vault-notes} check`, the shape the future vault shim takes.
// Returns the new base commit.
function shimChecker(f: Fixture): string {
	write(f.vault, "package.json", `${JSON.stringify({ private: true, scripts: { check: '"${VAULT_NOTES_BIN:-vault-notes}" check' } }, null, 2)}\n`)
	git(f.vault, "add", "--", "package.json")
	git(f.vault, "commit", "-m", "test: route the checker through VAULT_NOTES_BIN")
	return git(f.vault, "rev-parse", "HEAD")
}

// Commit a vault checker that records the VAULT_NOTES_BIN it received to $CHECKER_RECORD, and hangs on a HANG
// candidate after recording its pid to $CHECKER_PID.
function recordingChecker(f: Fixture): { record: string; pidFile: string; base: string } {
	write(
		f.vault,
		"check.ts",
		[
			'import { appendFileSync, existsSync, writeFileSync } from "node:fs"',
			'appendFileSync(process.env.CHECKER_RECORD ?? "", `${process.env.VAULT_NOTES_BIN ?? "<unset>"}\\n`)',
			'if (existsSync("HANG")) { writeFileSync(process.env.CHECKER_PID ?? "", String(process.pid)); await Bun.sleep(60_000) }',
			"",
		].join("\n"),
	)
	git(f.vault, "add", "--", "check.ts")
	git(f.vault, "commit", "-m", "test: record the checker environment")
	return { record: join(f.root, "checker-env.log"), pidFile: join(f.root, "hung-checker.pid"), base: git(f.vault, "rev-parse", "HEAD") }
}

// A second plugin copy: the shipped bundle under <copy>/runtime/, and, when `withVaultNotes`, a stand-in
// <copy>/bin/vault-notes that records its argv, working directory and canonical root.
function pluginCopy(f: Fixture, withVaultNotes: boolean): { bundle: string; vaultNotes: string; record: string } {
	const copy = join(f.root, "plugin-copy")
	const bundle = join(copy, "runtime", "vault-steward.js")
	const record = join(f.root, "vault-notes-calls.log")
	write(copy, "runtime/vault-steward.js", "")
	copyFileSync(join(PLUGIN_ROOT, "runtime", "vault-steward.js"), bundle)
	if (withVaultNotes) {
		write(copy, "bin/vault-notes", `#!/bin/sh\nprintf '%s|%s|%s\\n' "$*" "$(pwd -P)" "$VAULT_CANONICAL_ROOT" >> '${record}'\nexit 0\n`)
		chmodSync(join(copy, "bin", "vault-notes"), 0o755)
	}
	return { bundle, vaultNotes: join(copy, "bin", "vault-notes"), record }
}

function runCopy(f: Fixture, bundle: string, args: string[], extra: Record<string, string> = {}): { exitCode: number; envelope: Envelope } {
	const result = Bun.spawnSync([process.execPath, bundle, ...args, "--json"], {
		cwd: f.vault,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...stewardEnvironment(f), ...extra, GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" },
	})
	return { exitCode: result.exitCode, envelope: JSON.parse(new TextDecoder().decode(result.stdout)) as Envelope }
}

function diagnosticsOf(message: string | undefined): Record<string, unknown> {
	const path = /checker diagnostics at (\S+)/.exec(message ?? "")?.[1]
	if (path === undefined) throw new Error(`no diagnostics path in ${message}`)
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
}

function inspectState(f: Fixture, worktree: string): Record<string, unknown> {
	return data(must(run(f, ["inspect", "--worktree", worktree]), "SUCCESS_UNCHANGED"))
}

test("the checker child receives this plugin copy's vault-notes path from source and from the shipped bundle, replacing a caller value", () => {
	const f = fixture()
	const { record } = recordingChecker(f)
	const worktree = candidate(f)
	must(run(f, ["finish", "--preview", "--worktree", worktree, "--message", "docs: goal"], { CHECKER_RECORD: record, VAULT_NOTES_BIN: STALE_VAULT_NOTES }), "SUCCESS_COMPLETED")
	const bundled = Bun.spawnSync([BUNDLE_LAUNCHER, "finish", "--preview", "--worktree", worktree, "--message", "docs: goal", "--json"], {
		cwd: f.vault,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...stewardEnvironment(f), CHECKER_RECORD: record, VAULT_NOTES_BIN: STALE_VAULT_NOTES, GIT_TERMINAL_PROMPT: "0" },
	})
	expect(JSON.parse(new TextDecoder().decode(bundled.stdout)).result.causeCode).toBe("SUCCESS_COMPLETED")
	// Two checker runs here: the first preview commits, the second validates the committed candidate.
	expect(readFileSync(record, "utf8")).toBe(`${PLUGIN_VAULT_NOTES}\n${PLUGIN_VAULT_NOTES}\n`)
})

// The production deadline is observed in-process: a process test cannot wait two minutes.
test("the production checker spawn carries a 120 s deadline and the plugin copy's vault-notes path over a caller value", () => {
	const f = fixture()
	const worktree = candidate(f)
	const base = createRuntime()
	const checkerSpawns: SpawnOptions[] = []
	const rt = {
		...base,
		env: { ...process.env, VAULT_NOTES_BIN: STALE_VAULT_NOTES },
		spawn(command: string[], options: SpawnOptions) {
			if (command[1] === "run" && command[2] === "check") checkerSpawns.push(options)
			return base.spawn(command, options)
		},
	}
	expect(validateCandidate(rt, readManifest(rt, worktree), "docs: goal").kind).toBe("commit")
	expect(checkerSpawns.map((options) => [options.cwd, options.timeoutMs, options.env?.VAULT_NOTES_BIN, options.env?.VAULT_CANONICAL_ROOT])).toEqual([[worktree, 120_000, PLUGIN_VAULT_NOTES, f.vault]])
})

test("the vault checker calls the running plugin copy's own vault-notes from the candidate, never the caller's", () => {
	const f = fixture()
	shimChecker(f)
	const copy = pluginCopy(f, true)
	const callerLog = join(f.root, "caller-calls.log")
	write(f.root, "caller/vault-notes", `#!/bin/sh\necho caller >> '${callerLog}'\nexit 1\n`)
	chmodSync(join(f.root, "caller", "vault-notes"), 0o755)
	const worktree = candidate(f)
	const env = { VAULT_NOTES_BIN: join(f.root, "caller", "vault-notes") }
	const previewed = runCopy(f, copy.bundle, ["finish", "--preview", "--worktree", worktree, "--message", "docs: goal"], env)
	expect(previewed.envelope.result.causeCode).toBe("SUCCESS_COMPLETED")
	expect(readFileSync(copy.record, "utf8")).toBe(`check|${worktree}|${f.vault}\n`)
	expect(existsSync(callerLog)).toBe(false)
	const previewId = (previewed.envelope.result.data as { previewId: string }).previewId
	const applied = runCopy(f, copy.bundle, ["finish", "--apply", "--preview-id", previewId, "--worktree", worktree], env)
	expect(applied.envelope.result.causeCode).toBe("SUCCESS_COMPLETED")
	expect(git(f.vault, "show", "HEAD:projects/demo/GOAL.md")).toBe("# Goal\n\nCompleted.")
})

test("a plugin copy without vault-notes refuses DOMAIN_CHECK_FAILED with exit 127 diagnostics and leaves every station unchanged", () => {
	const f = fixture()
	const base = shimChecker(f)
	const copy = pluginCopy(f, false)
	const worktree = candidate(f)
	const before = inspectState(f, worktree)
	const refused = runCopy(f, copy.bundle, ["finish", "--preview", "--worktree", worktree, "--message", "docs: goal"])
	expect(refused.exitCode).toBe(3)
	expect(refused.envelope.result).toMatchObject({ causeCode: "DOMAIN_CHECK_FAILED", outcome: "refused", transactionState: "unchanged", nextAction: "vault-steward.finish-preview" })
	expect(diagnosticsOf(refused.envelope.message)).toMatchObject({ exitCode: 127 })
	expect(existsSync(copy.vaultNotes)).toBe(false)
	expect(git(worktree, "rev-parse", "HEAD")).toBe(base)
	expect(git(f.vault, "rev-parse", "main")).toBe(base)
	expect(inspectState(f, worktree)).toEqual(before)
})

test("a hung checker is abandoned at its deadline, refuses DOMAIN_CHECK_FAILED, and leaves every station unchanged", () => {
	const f = fixture()
	const checker = recordingChecker(f)
	hungCheckers.push(checker.pidFile)
	const worktree = candidate(f, "HANG", "hang\n")
	const before = inspectState(f, worktree)
	const started = Date.now()
	const refused = run(f, ["finish", "--preview", "--worktree", worktree, "--message", "docs: hang"], { CHECKER_RECORD: checker.record, CHECKER_PID: checker.pidFile, VAULT_STEWARD_FAULT: "checker-deadline=1500" })
	expect(Date.now() - started).toBeLessThan(20_000)
	expect(refused.exitCode).toBe(3)
	expect(refused.envelope?.result).toMatchObject({ causeCode: "DOMAIN_CHECK_FAILED", outcome: "refused", transactionState: "unchanged", nextAction: "vault-steward.finish-preview" })
	expect(refused.envelope?.message).toContain("the checker run was abandoned at its deadline; its child processes may still be running")
	expect(diagnosticsOf(refused.envelope?.message)).toMatchObject({ exitCode: null, timedOut: true })
	expect(existsSync(checker.pidFile)).toBe(true)
	expect(git(worktree, "rev-parse", "HEAD")).toBe(checker.base)
	expect(git(f.vault, "rev-parse", "main")).toBe(checker.base)
	expect(inspectState(f, worktree)).toEqual(before)
})

test("a checker that hangs under the integration lock refuses DOMAIN_REBASED_CHECK_FAILED and releases the lock", () => {
	const f = fixture()
	const checker = recordingChecker(f)
	hungCheckers.push(checker.pidFile)
	const env = { CHECKER_RECORD: checker.record, CHECKER_PID: checker.pidFile }
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
