import { type ChildProcess, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import { join, relative } from "node:path"
import type { Readable } from "node:stream"
import { FINDINGS } from "./contract.ts"
import { buildScenarios, type ProcessResult, type ScenarioOptions, scenarioFindings, type ScenarioSpec } from "./scenario-rules.ts"

export interface ScenarioRow {
	scenario: string
	argv: string[]
	expectedExit: number | null
	observedExit: number | null
	passed: boolean
	findings: string[]
	durationMilliseconds: number
}

export interface RunReport {
	targetDirectory: string
	command: string[]
	rows: ScenarioRow[]
	passedCount: number
	failedCount: number
	targetUnchanged: boolean
}

export interface MatrixOptions extends ScenarioOptions {
	cwd: string
	command: string[]
	timeoutMs: number
}

interface FileSnapshot {
	relativePath: string
	sha256: string
}

interface StreamCollector {
	done: Promise<void>
	text: () => string
}

interface ExitOutcome {
	observedExit: number | null
	timedOut: boolean
}

const TIMED_OUT = Symbol("timed-out")
const KILL_GRACE_MS = 500
const READ_GRACE_MS = 500
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git"])

function childEnvironment(): Record<string, string> {
	const env: Record<string, string> = {}
	for (const [key, value] of Object.entries(process.env)) {
		if (key !== "CI" && value !== undefined) env[key] = value
	}
	env.NO_COLOR = "1"
	env.TERM = "dumb"
	return env
}

async function entryFiles(directory: string, entry: Dirent): Promise<string[]> {
	const filePath = join(directory, entry.name)
	if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : listFiles(filePath)
	return entry.isFile() ? [filePath] : []
}

async function listFiles(directory: string): Promise<string[]> {
	const files: string[] = []
	for (const entry of await readdir(directory, { withFileTypes: true })) files.push(...(await entryFiles(directory, entry)))
	return files
}

async function snapshotDirectory(directory: string): Promise<FileSnapshot[]> {
	const snapshots: FileSnapshot[] = []
	for (const filePath of await listFiles(directory)) {
		const bytes = new Uint8Array(await Bun.file(filePath).arrayBuffer())
		const sha256 = createHash("sha256").update(bytes).digest("hex")
		snapshots.push({ relativePath: relative(directory, filePath).split("\\").join("/"), sha256 })
	}
	return snapshots.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T | typeof TIMED_OUT> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
		timer = setTimeout(() => resolve(TIMED_OUT), milliseconds)
	})
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function collectStream(stream: Readable): StreamCollector {
	const chunks: Buffer[] = []
	const done = (async (): Promise<void> => {
		try {
			for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
		} catch {
			// A torn-down pipe ends collection; whatever arrived is still reported.
		}
	})()
	return { done, text: () => Buffer.concat(chunks).toString("utf8") }
}

function exitPromise(child: ChildProcess): Promise<number | null> {
	const exited = new Promise<number | null>((resolve, reject) => {
		child.once("error", reject)
		child.once("exit", (code) => resolve(code))
	})
	exited.catch(() => undefined)
	return exited
}

// The child owns its process group, so the signal reaches any grandchild holding the pipes.
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	const pid = child.pid
	if (pid === undefined) return
	try {
		process.kill(-pid, signal)
	} catch {
		child.kill(signal)
	}
}

// Always returns: SIGTERM at the timeout, SIGKILL after a bounded grace, then a bounded wait for exit.
async function exitOrKill(child: ChildProcess, timeoutMs: number): Promise<ExitOutcome> {
	const exited = exitPromise(child)
	const first = await withTimeout(exited, timeoutMs)
	if (first !== TIMED_OUT) return { observedExit: first, timedOut: false }
	signalGroup(child, "SIGTERM")
	const afterTerm = await withTimeout(exited, KILL_GRACE_MS)
	if (afterTerm === TIMED_OUT) signalGroup(child, "SIGKILL")
	await withTimeout(exited, KILL_GRACE_MS)
	return { observedExit: null, timedOut: true }
}

async function spawnScenario(command: string[], spec: ScenarioSpec, cwd: string, env: Record<string, string>, timeoutMs: number): Promise<ProcessResult> {
	const started = process.hrtime.bigint()
	// command is validated non-empty by matrixOptions() before any scenario runs.
	const child = spawn(command[0] as string, [...command.slice(1), ...spec.argv], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true })
	const stdout = collectStream(child.stdout as Readable)
	const stderr = collectStream(child.stderr as Readable)
	const outcome = await exitOrKill(child, timeoutMs)
	await withTimeout(Promise.all([stdout.done, stderr.done]), READ_GRACE_MS)
	return {
		stdout: stdout.text(),
		stderr: stderr.text(),
		observedExit: outcome.observedExit,
		timedOut: outcome.timedOut,
		durationMilliseconds: Number(process.hrtime.bigint() - started) / 1_000_000,
	}
}

function changedPaths(before: FileSnapshot[], after: FileSnapshot[]): string[] {
	const beforeMap = new Map(before.map((file) => [file.relativePath, file.sha256]))
	const afterMap = new Map(after.map((file) => [file.relativePath, file.sha256]))
	return [...new Set([...beforeMap.keys(), ...afterMap.keys()])].filter((path) => beforeMap.get(path) !== afterMap.get(path)).sort()
}

function scenarioRow(spec: ScenarioSpec, result: ProcessResult): ScenarioRow {
	const findings = scenarioFindings(spec, result)
	return {
		scenario: spec.scenario,
		argv: spec.argv,
		expectedExit: spec.expectedExit,
		observedExit: result.observedExit,
		passed: findings.length === 0,
		findings,
		durationMilliseconds: result.durationMilliseconds,
	}
}

function targetRow(changed: string[]): ScenarioRow {
	const findings = changed.length === 0 ? [] : [FINDINGS.TARGET_MUTATED, ...changed]
	return { scenario: "target-unchanged", argv: [], expectedExit: null, observedExit: null, passed: changed.length === 0, findings, durationMilliseconds: 0 }
}

export async function runMatrix(options: MatrixOptions): Promise<RunReport> {
	const before = await snapshotDirectory(options.cwd)
	const env = childEnvironment()
	const rows: ScenarioRow[] = []
	for (const spec of buildScenarios(options)) {
		rows.push(scenarioRow(spec, await spawnScenario(options.command, spec, options.cwd, env, options.timeoutMs)))
	}
	const changed = changedPaths(before, await snapshotDirectory(options.cwd))
	rows.push(targetRow(changed))
	const passedCount = rows.filter((row) => row.passed).length
	return { targetDirectory: options.cwd, command: [...options.command], rows, passedCount, failedCount: rows.length - passedCount, targetUnchanged: changed.length === 0 }
}
