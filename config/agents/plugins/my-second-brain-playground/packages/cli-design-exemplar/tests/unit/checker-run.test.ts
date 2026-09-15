import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const CHECKER_RUN = resolve(import.meta.dir, "../catalog/checker-run.ts")
const roots: string[] = []

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), "repair-lab-checker-run-"))
	roots.push(root)
	return root
}

function fakeChecker(root: string, mutation: "none" | "mode" | "directory" | "symlink" | "fifo"): string {
	const path = join(root, `checker-${mutation}.ts`)
	writeFileSync(path, `
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const root = process.env.REPAIR_LAB_ROOT as string
writeFileSync(${JSON.stringify(join(root, "fake.pid"))}, String(process.pid))
const diagnostics = join(root, "diagnostics")
mkdirSync(diagnostics, { recursive: true, mode: 0o700 })
chmodSync(diagnostics, 0o700)
const file = join(diagnostics, "fake.jsonl")
writeFileSync(file, "")
chmodSync(file, 0o600)
const mutation = ${JSON.stringify(mutation)}
if (mutation === "mode") chmodSync(join(root, "state", "resource.json"), 0o600)
if (mutation === "directory") mkdirSync(join(root, "state", "unexpected-empty"), { mode: 0o700 })
if (mutation === "symlink") symlinkSync("resource.json", join(root, "state", "unexpected-link.json"))
if (mutation === "fifo") {
	const fifo = Bun.spawnSync(["mkfifo", join(root, "state", "unsupported.fifo")], { stdout: "pipe", stderr: "pipe" })
	if (fifo.exitCode !== 0) throw new Error(new TextDecoder().decode(fifo.stderr))
}
const rows = [
	{ scenario: "internal-failure-json", observedExit: 1, passed: true },
	{ scenario: "schema-refusal-json", observedExit: 4, passed: true },
	{ scenario: "transient-refusal-json", observedExit: 75, passed: true },
	...Array.from({ length: 16 }, (_, index) => ({ scenario: \`passing-\${index}\`, observedExit: 0, passed: true })),
]
process.stdout.write(JSON.stringify({ envelopeVersion: 2, contractVersion: "2.0.0", result: { data: { rows, failedCount: 0, skippedRows: [], observationExclusions: ["runtime contents of non-regular entries"], targetUnchanged: true } } }))
`)
	return path
}

async function runChecker(runRoot: string, checkerMain: string): Promise<{
	exit: number
	stdout: string
	stderr: string
	timedOut: boolean
	signal: string | null
	elapsedMs: number
}> {
	const startedAt = performance.now()
	let timedOut = false
	const child = Bun.spawn(["bun", "run", CHECKER_RUN], {
		cwd: runRoot,
		env: {
			HOME: process.env.HOME ?? "/",
			PATH: process.env.PATH ?? "",
			NO_COLOR: "1",
			TERM: "dumb",
			REPAIR_LAB_CHECKER_MAIN: checkerMain,
			REPAIR_LAB_RUN_ROOT: runRoot,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	})
	const timeout = setTimeout(() => {
		timedOut = true
		child.kill()
	}, 5_000)
	try {
		const [stdout, stderr, exit] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		])
		return { exit, stdout, stderr, timedOut, signal: child.signalCode, elapsedMs: performance.now() - startedAt }
	} finally {
		clearTimeout(timeout)
	}
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return false
		throw error
	}
}

describe("checker-run filesystem manifest", () => {
	test("accepts only the canonical diagnostics directory and files through a symlinked run root", async () => {
		const root = workspace()
		const canonical = join(root, "canonical")
		mkdirSync(canonical, { mode: 0o700 })
		const alias = join(root, "alias")
		symlinkSync(canonical, alias)
		const run = await runChecker(alias, fakeChecker(root, "none"))
		expect(run).toMatchObject({ exit: 0, stdout: "checker-run: ok\n", stderr: "", timedOut: false, signal: null })
	})

	test("detects mode-only changes, empty directories, and added symlinks", async () => {
		for (const mutation of ["mode", "directory", "symlink"] as const) {
			const root = workspace()
			const runRoot = join(root, "run")
			mkdirSync(runRoot, { mode: 0o700 })
			const run = await runChecker(runRoot, fakeChecker(root, mutation))
			expect(`${mutation}:${run.exit}:${run.stdout}:${run.stderr}`).toContain(`${mutation}:1:checker-run: FAIL`)
		}
	})

	test("rejects a FIFO without opening or blocking and leaves no checker orphan", async () => {
		const root = workspace()
		const runRoot = join(root, "run")
		mkdirSync(runRoot, { mode: 0o700 })
		const run = await runChecker(runRoot, fakeChecker(root, "fifo"))
		const fakePid = Number(readFileSync(join(root, "fake.pid"), "utf8"))
		const fakeProcessAlive = processExists(fakePid)
		if (process.env.REPAIR_LAB_FIFO_RECEIPT) {
			writeFileSync(
				process.env.REPAIR_LAB_FIFO_RECEIPT,
				`${JSON.stringify({ ...run, fakePid, fakeProcessAlive }, null, 2)}\n`,
			)
		}

		expect(run.exit).toBe(1)
		expect(run.timedOut).toBe(false)
		expect(run.signal).toBeNull()
		expect(run.elapsedMs).toBeLessThan(5_000)
		expect(run.stderr).toContain("unsupported filesystem entry")
		expect(run.stderr).toContain("state/unsupported.fifo")
		expect(fakeProcessAlive).toBe(false)
	})
})
