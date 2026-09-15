// fallow-ignore-file code-duplication -- The accepted 2.0 successor must remain separate from the frozen 1.0 predecessor oracle and source boundary.
import { type ChildProcess, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import type { Stats } from "node:fs"
import { lstatSync } from "node:fs"
import { lstat, open, readlink, readdir, unlink } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import type { Readable } from "node:stream"
import { analyzeScenario, buildSuccessorScenarios, type ProcessResult, type ScenarioOptions, type ScenarioSpec, skippedSuccessorScenarios } from "./scenario-rules.ts"

export interface StreamCustody {
	stdoutPath: string
	stderrPath: string
}

export interface SuccessorRow {
	scenario: string
	argv: string[]
	expectedExit: number | readonly number[] | null
	observedExit: number | null
	observedContractVersion: string | null
	passed: boolean
	findings: string[]
	durationMilliseconds: number
	streamCustody: StreamCustody | null
}

export interface SuccessorRunReport {
	runIdentity: string
	targetDirectory: string
	command: string[]
	rows: SuccessorRow[]
	passedCount: number
	failedCount: number
	targetUnchanged: boolean
	changedPaths: string[]
	retention: { requested: boolean; directory: string | null }
	skippedRows: string[]
	observationExclusions: string[]
}

export interface SuccessorMatrixOptions extends ScenarioOptions {
	cwd: string
	command: string[]
	timeoutMs: number
	retainStreamsDirectory?: string | undefined
}

type EntryKind = "block-device" | "character-device" | "directory" | "fifo" | "file" | "socket" | "symlink" | "unknown"

interface EntrySnapshot {
	relativePath: string
	kind: EntryKind
	mode: number
	sha256?: string
	linkTarget?: string
}

interface StreamCollector {
	done: Promise<void>
	text: () => string
	close: () => void
}

interface ExitOutcome {
	observedExit: number | null
	timedOut: boolean
}

const TIMED_OUT = Symbol("timed-out")
const KILL_GRACE_MS = 500
const READ_GRACE_MS = 500
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git"])
const OBSERVATION_EXCLUSIONS = [
	"contents of excluded directories: .git, node_modules",
	"out-of-tree paths",
	"referents of symlink entries",
	"reverted effects",
	"runtime contents of non-regular entries",
] as const

class StreamRetentionError extends Error {
	constructor(scenario: string, remainingPaths: readonly string[]) {
		super(
			remainingPaths.length === 0
				? `could not retain streams for ${scenario}; no retained artifact remains`
				: `could not retain streams for ${scenario}; retained raw stream custody remains at ${remainingPaths.join(", ")}`,
		)
	}
}

function childEnvironment(): Record<string, string> {
	const env: Record<string, string> = {}
	for (const [key, value] of Object.entries(process.env)) {
		if (key !== "CI" && value !== undefined) env[key] = value
	}
	env.NO_COLOR = "1"
	env.TERM = "dumb"
	return env
}

function entryKind(stat: Stats): EntryKind {
	if (stat.isFile()) return "file"
	if (stat.isDirectory()) return "directory"
	if (stat.isSymbolicLink()) return "symlink"
	if (stat.isFIFO()) return "fifo"
	if (stat.isSocket()) return "socket"
	if (stat.isBlockDevice()) return "block-device"
	if (stat.isCharacterDevice()) return "character-device"
	return "unknown"
}

function relativePath(root: string, path: string): string {
	const pathFromRoot = relative(root, path).split("\\").join("/")
	return pathFromRoot === "" ? "." : pathFromRoot
}

async function snapshotEntry(root: string, path: string): Promise<EntrySnapshot[]> {
	const stat = await lstat(path)
	const kind = entryKind(stat)
	const entry: EntrySnapshot = { relativePath: relativePath(root, path), kind, mode: stat.mode & 0o7777 }
	if (kind === "file") {
		const bytes = new Uint8Array(await Bun.file(path).arrayBuffer())
		entry.sha256 = createHash("sha256").update(bytes).digest("hex")
	} else if (kind === "symlink") {
		entry.linkTarget = await readlink(path)
	}
	if (kind !== "directory" || (path !== root && SKIPPED_DIRECTORIES.has(path.split("/").at(-1) as string))) return [entry]
	const descendants: EntrySnapshot[] = []
	for (const name of (await readdir(path)).sort()) descendants.push(...(await snapshotEntry(root, join(path, name))))
	return [entry, ...descendants]
}

async function snapshotDirectory(directory: string): Promise<EntrySnapshot[]> {
	return (await snapshotEntry(directory, directory)).sort((left, right) => left.relativePath.localeCompare(right.relativePath))
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
			// A torn-down pipe ends collection; the bounded observation still reports received bytes.
		}
	})()
	return { done, text: () => Buffer.concat(chunks).toString("utf8"), close: () => stream.destroy() }
}

function exitPromise(child: ChildProcess): Promise<number | null> {
	const exited = new Promise<number | null>((resolve, reject) => {
		child.once("error", reject)
		child.once("exit", (code) => resolve(code))
	})
	exited.catch(() => undefined)
	return exited
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	const pid = child.pid
	if (pid === undefined) return
	try {
		process.kill(-pid, signal)
	} catch {
		child.kill(signal)
	}
}

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

async function drainStreams(child: ChildProcess, collectors: StreamCollector[]): Promise<void> {
	const drained = Promise.all(collectors.map(({ done }) => done))
	if ((await withTimeout(drained, READ_GRACE_MS)) !== TIMED_OUT) return
	signalGroup(child, "SIGTERM")
	if ((await withTimeout(drained, KILL_GRACE_MS)) !== TIMED_OUT) return
	signalGroup(child, "SIGKILL")
	if ((await withTimeout(drained, KILL_GRACE_MS)) !== TIMED_OUT) return
	for (const collector of collectors) collector.close()
	await withTimeout(drained, KILL_GRACE_MS)
}

async function spawnScenario(command: string[], spec: ScenarioSpec, cwd: string, timeoutMs: number): Promise<ProcessResult> {
	const started = process.hrtime.bigint()
	const child = spawn(command[0] as string, [...command.slice(1), ...spec.argv], { cwd, env: childEnvironment(), stdio: ["ignore", "pipe", "pipe"], detached: true })
	const stdout = collectStream(child.stdout as Readable)
	const stderr = collectStream(child.stderr as Readable)
	const outcome = await exitOrKill(child, timeoutMs)
	await drainStreams(child, [stdout, stderr])
	return { stdout: stdout.text(), stderr: stderr.text(), observedExit: outcome.observedExit, timedOut: outcome.timedOut, durationMilliseconds: Number(process.hrtime.bigint() - started) / 1_000_000 }
}

function changedPaths(before: EntrySnapshot[], after: EntrySnapshot[]): string[] {
	const beforeMap = new Map(before.map((entry) => [entry.relativePath, JSON.stringify(entry)]))
	const afterMap = new Map(after.map((entry) => [entry.relativePath, JSON.stringify(entry)]))
	return [...new Set([...beforeMap.keys(), ...afterMap.keys()])].filter((path) => beforeMap.get(path) !== afterMap.get(path)).sort()
}

async function writeExclusive(path: string, content: string, createdPaths: string[]): Promise<void> {
	const handle = await open(path, "wx", 0o600)
	createdPaths.push(path)
	try {
		await handle.chmod(0o600)
		await handle.writeFile(content, "utf8")
		await handle.close()
	} catch (error) {
		await handle.close().catch(() => undefined)
		await unlink(path).catch(() => undefined)
		throw error
	}
}

function isMissingPathError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

async function unconfirmedCustodyPaths(paths: readonly string[]): Promise<string[]> {
	const unconfirmed = await Promise.all(
		paths.map(async (path) => {
			try {
				await lstat(path)
				return path
			} catch (error) {
				return isMissingPathError(error) ? null : path
			}
		}),
	)
	return unconfirmed.filter((path): path is string => path !== null)
}

async function cleanupRetainedPaths(paths: readonly string[]): Promise<string[]> {
	await Promise.all(paths.map((path) => unlink(path).catch(() => undefined)))
	return unconfirmedCustodyPaths(paths)
}

async function retainStreams(directory: string, runIdentity: string, scenario: string, result: ProcessResult): Promise<StreamCustody> {
	const stdoutPath = join(directory, `${runIdentity}.${scenario}.stdout.txt`)
	const stderrPath = join(directory, `${runIdentity}.${scenario}.stderr.txt`)
	const createdPaths: string[] = []
	try {
		await writeExclusive(stdoutPath, result.stdout, createdPaths)
		await writeExclusive(stderrPath, result.stderr, createdPaths)
		return { stdoutPath, stderrPath }
	} catch {
		throw new StreamRetentionError(scenario, await cleanupRetainedPaths(createdPaths))
	}
}

function targetRow(changed: string[]): SuccessorRow {
	const findings = changed.length === 0 ? [] : ["TARGET_MUTATED"]
	return { scenario: "target-unchanged", argv: [], expectedExit: null, observedExit: null, observedContractVersion: null, passed: findings.length === 0, findings, durationMilliseconds: 0, streamCustody: null }
}

export function validateRetentionDirectory(directory: string): string {
	if (!isAbsolute(directory)) throw new Error("--retain-streams-dir must be an absolute directory")
	let stat: ReturnType<typeof lstatSync>
	try {
		stat = lstatSync(directory)
	} catch {
		throw new Error("--retain-streams-dir must already exist")
	}
	const owner = typeof process.getuid === "function" ? process.getuid() : stat.uid
	if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== owner || (stat.mode & 0o777) !== 0o700) throw new Error("--retain-streams-dir must be a non-symlinked, current-user-owned 0700 directory")
	return directory
}

export async function runSuccessorMatrix(options: SuccessorMatrixOptions): Promise<SuccessorRunReport> {
	const runIdentity = `run-${randomUUID()}`
	const before = await snapshotDirectory(options.cwd)
	const rows: SuccessorRow[] = []
	let declaredCommands: string[] | undefined
	for (const spec of buildSuccessorScenarios(options)) {
		const result = await spawnScenario(options.command, spec, options.cwd, options.timeoutMs)
		const streamCustody = options.retainStreamsDirectory === undefined ? null : await retainStreams(options.retainStreamsDirectory, runIdentity, spec.scenario, result)
		const analysis = analyzeScenario(spec, result, declaredCommands)
		if (spec.discovery === true && analysis.findings.length === 0) declaredCommands = analysis.declaredCommands
		rows.push({ scenario: spec.scenario, argv: spec.argv, expectedExit: spec.expectedExit, observedExit: result.observedExit, observedContractVersion: analysis.observedContractVersion, passed: analysis.findings.length === 0, findings: analysis.findings, durationMilliseconds: result.durationMilliseconds, streamCustody })
	}
	const changed = changedPaths(before, await snapshotDirectory(options.cwd))
	rows.push(targetRow(changed))
	const passedCount = rows.filter((row) => row.passed).length
	return { runIdentity, targetDirectory: options.cwd, command: [...options.command], rows, passedCount, failedCount: rows.length - passedCount, targetUnchanged: changed.length === 0, changedPaths: changed, retention: { requested: options.retainStreamsDirectory !== undefined, directory: options.retainStreamsDirectory ?? null }, skippedRows: skippedSuccessorScenarios(options), observationExclusions: [...OBSERVATION_EXCLUSIONS] }
}
