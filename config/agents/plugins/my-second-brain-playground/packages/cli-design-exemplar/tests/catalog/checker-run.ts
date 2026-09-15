import { createHash } from "node:crypto"
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { createRoot, MAIN, SECRET_MARKER } from "../helpers/harness.ts"

const CHECKER_TIMEOUT_MS = 180_000
const USAGE = "usage: REPAIR_LAB_CHECKER_MAIN=<absolute checker src/main.ts> REPAIR_LAB_RUN_ROOT=<run output directory> bun run tests/catalog/checker-run.ts"

interface RunResult {
	stdout: string
	stderr: string
	exit: number
}

interface TreeDelta {
	added: string[]
	removed: string[]
	modified: string[]
}

interface Expectation {
	expected: unknown
	actual: unknown
	ok: boolean
}

interface Judgement {
	expectations: Record<string, Expectation>
	ok: boolean
}

function readRegularFile(path: string, originalMode: number): Buffer {
	let modeChanged = false
	try {
		try {
			return readFileSync(path)
		} catch {
			chmodSync(path, originalMode | 0o400)
			modeChanged = true
			return readFileSync(path)
		}
	} finally {
		if (modeChanged) chmodSync(path, originalMode)
	}
}

// One manifest line per filesystem entry (PR 184, thread 4003813624): entry type, mode, and the regular-file digest or
// the symlink target. Directories are recorded too, including empty ones, so a new directory or a mode-only change is
// a modification. Any other entry type is refused before it is opened, so a FIFO or socket can never stall or be read.
function manifestEntry(path: string, relativePath: string): string {
	const stat = lstatSync(path)
	const mode = (stat.mode & 0o7777).toString(8).padStart(4, "0")
	if (stat.isSymbolicLink()) return `symlink ${mode} ${readlinkSync(path)}`
	if (stat.isDirectory()) return `dir ${mode} -`
	if (stat.isFile()) return `file ${mode} ${createHash("sha256").update(readRegularFile(path, stat.mode & 0o777)).digest("hex")}`
	throw new Error(`unsupported filesystem entry ${relativePath} (mode ${(stat.mode & 0o170000).toString(8)})`)
}

function manifestTree(root: string): Map<string, string> {
	const entries = new Map<string, string>()
	const directories = [root]
	while (directories.length > 0) {
		const directory = directories.pop()
		if (directory === undefined) continue
		for (const entry of readdirSync(directory)) {
			const path = join(directory, entry)
			const relativePath = relative(root, path).split(sep).join("/")
			const line = manifestEntry(path, relativePath)
			entries.set(relativePath, line)
			if (line.startsWith("dir ")) directories.push(path)
		}
	}
	return new Map([...entries.entries()].sort(([left], [right]) => left.localeCompare(right)))
}

function writeManifest(path: string, entries: Map<string, string>): void {
	const lines = [...entries.entries()].map(([relativePath, line]) => `${line}  ${relativePath}`)
	writeFileSync(path, lines.length === 0 ? "" : `${lines.join("\n")}\n`)
}

function diffTrees(before: Map<string, string>, after: Map<string, string>): TreeDelta {
	const added: string[] = []
	const removed: string[] = []
	const modified: string[] = []
	const paths = [...new Set([...before.keys(), ...after.keys()])].sort()
	for (const path of paths) {
		if (!before.has(path)) added.push(path)
		else if (!after.has(path)) removed.push(path)
		else if (before.get(path) !== after.get(path)) modified.push(path)
	}
	return { added, removed, modified }
}

async function runChecker(checkerMain: string, runRoot: string, cwdDir: string, fixtureRoot: string): Promise<RunResult> {
	const child = Bun.spawn(
		[
			"bun",
			"run",
			checkerMain,
			"--cwd",
			cwdDir,
			"--command",
			`bun run ${MAIN}`,
			"--success-args",
			"status",
			"--missing-args",
			"inspect --state state/missing.json",
			"--effect-args",
			"apply --automation",
			"--secret-args",
			"inspect --include-diagnostics",
			"--secret-marker",
			SECRET_MARKER,
			"--malformed-args",
			"inspect --state state/malformed.json",
			"--large-args",
			"inspect --state state/large.json",
			"--json",
		],
		{
			cwd: runRoot,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: { HOME: process.env.HOME ?? "/", PATH: process.env.PATH ?? "", NO_COLOR: "1", TERM: "dumb", REPAIR_LAB_ROOT: fixtureRoot },
		},
	)
	let timedOut = false
	const timer = setTimeout(() => {
		timedOut = true
		child.kill("SIGKILL")
	}, CHECKER_TIMEOUT_MS)
	try {
		const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
		const exit = await child.exited
		return { stdout, stderr, exit: timedOut ? -9 : exit }
	} finally {
		clearTimeout(timer)
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function parseReport(stdout: string): { report: Record<string, unknown> | null; parsed: boolean } {
	try {
		const envelope = asRecord(JSON.parse(stdout) as unknown)
		if (envelope === null) return { report: null, parsed: false }
		return { report: asRecord(envelope.result) ?? envelope, parsed: true }
	} catch {
		return { report: null, parsed: false }
	}
}

function nestedRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> | null {
	return asRecord(parent[key])
}

function normalized(value: unknown): unknown {
	return value === undefined ? null : value
}

function deepEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right)
}

function makeExpectation(expected: unknown, actual: unknown, ok = deepEqual(expected, normalized(actual))): Expectation {
	return { expected, actual: normalized(actual), ok }
}

// The only admitted additions are the fixture's private diagnostics directory (0700) and its per-run files (0600).
function diagnosticsOnly(added: string[], after: Map<string, string>, targetRoot: string, fixtureRoot: string): boolean {
	const prefix = relative(targetRoot, fixtureRoot).split(sep).join("/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const directory = new RegExp(`^${prefix}/diagnostics$`)
	const file = new RegExp(`^${prefix}/diagnostics/[^/]+\\.jsonl$`)
	const admitted = (path: string): boolean => (directory.test(path) && after.get(path) === "dir 0700 -") || (file.test(path) && (after.get(path) ?? "").startsWith("file 0600 "))
	return added.some((path) => file.test(path)) && new Set(added).size === added.length && added.every(admitted)
}

function judge(stdout: string, stderr: string, checkerExit: number, delta: TreeDelta, after: Map<string, string>, targetRoot: string, fixtureRoot: string): Judgement {
	const parsed = parseReport(stdout)
	const report = parsed.report ?? {}
	const coverage = nestedRecord(report, "findingCoverage")
	const expectations: Record<string, Expectation> = {
		"report-json": makeExpectation(true, parsed.parsed),
		rows: makeExpectation(15, Array.isArray(report.rows) ? report.rows.length : null),
		failedCount: makeExpectation(0, report.failedCount),
		skippedScenarios: makeExpectation([], report.skippedScenarios),
		"finding-coverage-unproved": makeExpectation([], coverage?.unproved),
		unjudged: makeExpectation(["exitMeanings.75"], report.unjudged),
		"target-unchanged": makeExpectation(true, report.targetUnchanged),
		"checker-exit": makeExpectation(0, checkerExit),
		"checker-stderr-empty": makeExpectation("", stderr),
		"removed-empty": makeExpectation([], delta.removed),
		"modified-empty": makeExpectation([], delta.modified),
		"added-diagnostics-only": makeExpectation("fixture diagnostics (0700) and its *.jsonl (0600) only", delta.added, diagnosticsOnly(delta.added, after, targetRoot, fixtureRoot)),
	}
	return { expectations, ok: Object.values(expectations).every((item) => item.ok) }
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`)
}

function errorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error)
	return message.replace(/[\r\n]+/g, " ").trim() || "unknown error"
}

async function main(): Promise<void> {
	const checkerMain = process.env.REPAIR_LAB_CHECKER_MAIN
	const runRoot = process.env.REPAIR_LAB_RUN_ROOT
	if (checkerMain === undefined || runRoot === undefined || checkerMain === "" || runRoot === "") {
		process.stderr.write(`${USAGE}\n`)
		process.exitCode = 2
		return
	}
	// The canonical private root (PR 184, thread 4003822454): createRoot canonicalizes the caller-supplied parent, so the
	// manifest and the diagnostics-only comparison use the same root the fixture path is expressed under.
	const root = createRoot("checker-target", join(runRoot, "checker-target"))
	const targetRoot = root.privateRoot
	const cwdDir = join(runRoot, "checker-cwd")
	mkdirSync(cwdDir, { recursive: true, mode: 0o700 })
	writeFileSync(join(cwdDir, "README.txt"), `fixture root: ${root.root}\n`)
	const before = manifestTree(targetRoot)
	writeManifest(join(runRoot, "hashes-before.txt"), before)
	const result = await runChecker(checkerMain, runRoot, cwdDir, root.root)
	writeFileSync(join(runRoot, "checker-report.json"), result.stdout)
	writeFileSync(join(runRoot, "checker-stderr.txt"), result.stderr)
	writeFileSync(join(runRoot, "checker-exit.txt"), `${result.exit}\n`)
	const after = manifestTree(targetRoot)
	writeManifest(join(runRoot, "hashes-after.txt"), after)
	const delta = diffTrees(before, after)
	const judgement = judge(result.stdout, result.stderr, result.exit, delta, after, targetRoot, root.root)
	writeJson(join(runRoot, "verdict.json"), { checkerMain, checkerExit: result.exit, expectations: judgement.expectations, ...delta, ok: judgement.ok })
	if (judgement.ok) process.stdout.write("checker-run: ok\n")
	else process.stdout.write(`checker-run: FAIL ${Object.entries(judgement.expectations).filter(([, item]) => !item.ok).map(([name]) => name).join(",")}\n`)
	process.exitCode = judgement.ok ? 0 : 1
}

try {
	await main()
} catch (error) {
	process.stderr.write(`checker-run: FAIL error ${errorMessage(error)}\n`)
	process.exitCode = 1
}
