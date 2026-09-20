// Prepares the fixtures the strict 2.0 checker needs and runs `bin/cli-design-check` against the Vault Steward CLI
// (CONTRACT.md 7.2). Rows: help, discovery, no-arguments, unknown-option, success (inspect), missing-input
// (finish --preview on an absent candidate), internal-failure (a candidate whose vault directory was moved after begin,
// so Git fails deterministically without the fault channel), schema-refusal (corrupt manifest), transient-refusal
// (integration lock held by this process), malformed-value (relative worktree), unauthorized-effect (consumed preview).
// Skipped rows and their reasons are reported by `runChecker`.
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { cleanupFixtures, fixture, git, write } from "../helpers/harness.ts"
import { data, steward, stewardEnvironment } from "../helpers/steward.ts"

export const MAIN = resolve(import.meta.dir, "../../src/main.ts")
export const CHECKER = resolve(import.meta.dir, "../../../../bin/cli-design-check")

export const SKIPPED_ROWS: Readonly<Record<string, string>> = {
	"secret-redaction": "no command accepts a secret-bearing input: the commit subject must reach Git verbatim and would legitimately appear in data; redaction is proven at the diagnostics sink by the unit diagnostics test instead",
	"large-envelope": "no public path emits a large envelope by design: data.paths is bounded by the admitted set and inspect data is a fixed shape",
}

export interface CheckerRun {
	exitCode: number
	stdout: string
	stderr: string
	envelope: Record<string, unknown> | null
	command: string[]
}

export function runChecker(): CheckerRun {
	const f = fixture()
	const env = stewardEnvironment(f)
	const begin = (path: string, contents: string): string => {
		const started = steward(f.vault, ["begin", "--vault", f.vault, "--path", path], env)
		const worktree = (data(started).candidate as { worktree: string }).worktree
		write(worktree, path, contents)
		return worktree
	}
	// success and malformed rows share a healthy candidate
	const candidate = begin("projects/demo/GOAL.md", "# Goal\n\nCompleted.\n")
	// schema row: a candidate whose manifest is corrupt
	const corrupt = begin("products/lamp.md", "# Lamp\n")
	writeFileSync(join(git(corrupt, "rev-parse", "--absolute-git-dir"), "vault-note-commit.json"), "{broken")
	// transient row: a previewed candidate whose integration lock this process holds
	const locked = begin("projects/second/README.md", "# Second\n")
	const lockedPreview = data(steward(f.vault, ["finish", "--preview", "--worktree", locked, "--message", "docs: second"], env)).previewId as string
	// effect row: a candidate whose preview was consumed by an apply that halted before its receipt
	const consumed = begin("projects/third/README.md", "# Third\n")
	const consumedPreview = data(steward(f.vault, ["finish", "--preview", "--worktree", consumed, "--message", "docs: third"], env)).previewId as string
	steward(f.vault, ["finish", "--apply", "--preview-id", consumedPreview, "--worktree", consumed], { ...env, VAULT_STEWARD_FAULT: "halt=before-receipt" })
	// internal row: a second vault moved after begin, so the candidate's Git metadata points nowhere
	const moved = fixture()
	const movedEnv = stewardEnvironment(moved)
	const orphan = (data(steward(moved.vault, ["begin", "--vault", moved.vault, "--path", "projects/demo/GOAL.md"], movedEnv)).candidate as { worktree: string }).worktree
	renameSync(moved.vault, join(moved.root, "moved-vault"))
	const lock = join(f.vault, ".git", "vault-note-commits.lock")
	mkdirSync(lock, { recursive: true })
	writeFileSync(join(lock, "owner.json"), `${JSON.stringify({ schemaVersion: 1, runId: "checker-harness", pid: process.pid })}\n`)
	const command = [
		CHECKER,
		"--cwd", f.vault,
		"--command", `${process.execPath} ${MAIN}`,
		"--success-args", `inspect --worktree ${candidate}`,
		"--missing-args", `finish --preview --worktree ${join(f.root, "absent-candidate")} --message x`,
		"--internal-args", `finish --preview --worktree ${orphan} --message x`,
		"--schema-args", `finish --preview --worktree ${corrupt} --message x`,
		"--transient-args", `finish --apply --preview-id ${lockedPreview} --worktree ${locked}`,
		"--malformed-args", "finish --preview --worktree relative/path --message x",
		"--effect-args", `finish --apply --preview-id ${consumedPreview} --worktree ${consumed}`,
		"--timeout-ms", "60000",
		"--json",
	]
	try {
		const result = Bun.spawnSync(command, { cwd: f.vault, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" } })
		const stdout = new TextDecoder().decode(result.stdout)
		let envelope: Record<string, unknown> | null = null
		try {
			envelope = JSON.parse(stdout) as Record<string, unknown>
		} catch {
			envelope = null
		}
		return { exitCode: result.exitCode, stdout, stderr: new TextDecoder().decode(result.stderr), envelope, command }
	} finally {
		rmSync(lock, { recursive: true, force: true })
	}
}

if (import.meta.main) {
	const run = runChecker()
	process.stdout.write(`${JSON.stringify({ command: run.command, exitCode: run.exitCode, skippedRows: SKIPPED_ROWS, envelope: run.envelope, stderr: run.stderr }, null, 2)}\n`)
	cleanupFixtures()
	process.exit(run.exitCode)
}
