import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"

const hookCommand = resolve(import.meta.dir, "../../../hooks/recover-context")
const checkpointCommand = resolve(import.meta.dir, "../../../hooks/recovery-checkpoint")
const recoveryEngine = resolve(import.meta.dir, "recovery.py")
const observationPipeHarness = resolve(import.meta.dir, "test-fixtures/observation-pipe-harness.py")
const taskIdentity = "prove-recovery-task-2f52a7a1"
const programIdentity = "my-second-brain-playground"
const sessionIdentity = "session-fixture"
// Independent oracle: the accepted control-panel next-action contract.
const fixedNextAction =
 "Control panel ready. Read the goal owner for the next action; open other owners only as needed. Accepted Task identity was checked now, not lifecycle status. Inspect any uncertain operation before retrying."

const temporaryRoots: string[] = []

interface Fixture {
	root: string
	home: string
	vault: string
	state: string
	data: string
	agentLedger: string
	register: string
	checkpointPath: string
	checkpoint: Record<string, unknown>
}

interface ProcessResult {
	exitCode: number
	stdout: string
	stderr: string
}

interface TimedProcessResult extends ProcessResult {
	firstStdoutByteMs: number | null
	stdoutEofMs: number
	exitMs: number
}

interface ObserverPhaseTiming {
	invocationIdentity: string
	observerOpenMs: number
	responseAvailableMs: number
	terminalMs: number
}

function write(path: string, contents: string, mode?: number): void {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, contents)
	if (mode !== undefined) chmodSync(path, mode)
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
	return `'${value.replaceAll("'", `'"'"'`)}'`
}

function shellCommand(...arguments_: string[]): string {
	return arguments_.map(shellQuote).join(" ")
}

function createRegister(path: string, task = taskIdentity): void {
	mkdirSync(dirname(path), { recursive: true })
	const register = new Database(path, { create: true })
	register.exec(`
		CREATE TABLE register_metadata (
			id INTEGER PRIMARY KEY,
			format_identity TEXT NOT NULL,
			program_identity TEXT NOT NULL,
			schema_version INTEGER NOT NULL
		) STRICT;
		CREATE TABLE register_events (
			register_sequence INTEGER PRIMARY KEY,
			event_identity TEXT NOT NULL UNIQUE,
			stream TEXT NOT NULL,
			entity_identity TEXT NOT NULL,
			kind TEXT NOT NULL
		) STRICT;
	`)
	register
		.query("INSERT INTO register_metadata VALUES (1, ?, ?, 1)")
		.run("agent-ledger.orchestration-register", programIdentity)
	register
		.query("INSERT INTO register_events VALUES (1, ?, 'task', ?, 'task-accepted')")
		.run("register-event-fixture", task)
	register.close()
}

function observedAt(secondsAgo = 0): string {
	return new Date(Date.now() - secondsAgo * 1000).toISOString().replace(/\.000Z$/, "Z")
}

function fixture(options: { writeCheckpoint?: boolean; observedSecondsAgo?: number } = {}): Fixture {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "compaction-recovery-test-")))
	temporaryRoots.push(root)
	const home = join(root, "home")
	const vault = join(root, "playground's vault")
	const state = join(root, "state")
	const data = join(root, "data")
	mkdirSync(home)
	mkdirSync(vault)
	mkdirSync(state)
	mkdirSync(data)
	const agentLedger = join(root, "Agent Ledger's bin", "agent-ledger")
	write(agentLedger, `#!/bin/sh\ntouch ${shellQuote(`${agentLedger}.executed`)}\n`, 0o700)
	write(join(vault, "README.md"), "# Playground entry\n")
	write(join(vault, "projects/ledger-workflow/README.md"), "# Ledger Workflow\n")
	write(join(vault, "projects/ledger-workflow/proof.md"), "# Evidence\n")
	write(join(vault, "docs/agents/recovery.md"), "# Recovery guide\n")
	const register = join(data, "my-second-brain-playground/registers/ledger.sqlite3")
	createRegister(register)
	const canonicalRegister = realpathSync(register)
	write(
		join(vault, "projects/ledger-workflow/GOAL.md"),
		[
			"# Goal",
			"",
			`- Task: \`${taskIdentity}\`.`,
			`- Register: \`${canonicalRegister}\`.`,
			`- Program: \`${programIdentity}\`.`,
			"",
		].join("\n"),
	)
	write(
		join(home, ".config/my-second-brain-playground/vault.json"),
		`${JSON.stringify({ schemaVersion: 1, vault })}\n`,
	)
	const checkpoint = {
		schemaVersion: 2,
		vaultRoot: vault,
		projectMap: "projects/ledger-workflow/README.md",
		goalPath: "projects/ledger-workflow/GOAL.md",
		evidencePath: "projects/ledger-workflow/proof.md",
		recoveryPath: "docs/agents/recovery.md",
		agentLedgerExecutable: agentLedger,
		sessionIdentity,
		registerPath: canonicalRegister,
		taskIdentity,
		programIdentity,
		scope: "compaction-recovery",
		observedAt: observedAt(options.observedSecondsAgo),
	}
	const checkpointPath = join(
		state,
		"my-second-brain-playground/recovery/sessions",
		`${sessionIdentity}.json`,
	)
	if (options.writeCheckpoint !== false) {
		mkdirSync(dirname(checkpointPath), { recursive: true, mode: 0o700 })
		chmodSync(dirname(dirname(dirname(checkpointPath))), 0o700)
		chmodSync(dirname(dirname(checkpointPath)), 0o700)
		chmodSync(dirname(checkpointPath), 0o700)
		write(checkpointPath, `${JSON.stringify(checkpoint)}\n`, 0o600)
	}
	return {
		root,
		home,
		vault,
		state,
		data,
		agentLedger,
		register: canonicalRegister,
		checkpointPath,
		checkpoint,
	}
}

function environment(fixture: Fixture): Record<string, string> {
	return {
		...process.env,
		HOME: fixture.home,
		XDG_STATE_HOME: fixture.state,
		XDG_DATA_HOME: fixture.data,
	}
}

function run(
	command: string,
	cwd: string,
	input: string,
	environmentVariables: Record<string, string>,
	arguments_: string[] = [],
): ProcessResult {
	const process = Bun.spawnSync([command, ...arguments_], {
		cwd,
		stdin: new TextEncoder().encode(input),
		stdout: "pipe",
		stderr: "pipe",
		env: environmentVariables,
	})
	return {
		exitCode: process.exitCode,
		stdout: new TextDecoder().decode(process.stdout),
		stderr: new TextDecoder().decode(process.stderr),
	}
}

async function runTimed(
	command: string,
	cwd: string,
	input: string,
	environmentVariables: Record<string, string>,
	arguments_: string[] = [],
): Promise<TimedProcessResult> {
	const started = performance.now()
	const child = Bun.spawn([command, ...arguments_], {
		cwd,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: environmentVariables,
	})
	child.stdin.write(input)
	child.stdin.end()
	let firstStdoutByteMs: number | null = null
	const stdoutChunks: Uint8Array[] = []
	const stderrChunks: Uint8Array[] = []
	const stdout = (async () => {
		for await (const chunk of child.stdout) {
			if (firstStdoutByteMs === null) firstStdoutByteMs = performance.now() - started
			stdoutChunks.push(chunk)
		}
		return performance.now() - started
	})()
	const stderr = (async () => {
		for await (const chunk of child.stderr) stderrChunks.push(chunk)
	})()
	const exitCode = await child.exited
	const exitMs = performance.now() - started
	const [stdoutEofMs] = await Promise.all([stdout, stderr])
	return {
		exitCode,
		stdout: Buffer.concat(stdoutChunks).toString("utf8"),
		stderr: Buffer.concat(stderrChunks).toString("utf8"),
		firstStdoutByteMs,
		stdoutEofMs,
		exitMs,
	}
}

function withoutCapture(current: Fixture): Record<string, string> {
	return { ...environment(current), PATH: "/usr/bin:/bin" }
}

function withUnavailableCapture(current: Fixture): Record<string, string> {
	const ownerRoot = join(current.state, "my-second-brain-playground")
	mkdirSync(ownerRoot, { recursive: true, mode: 0o700 })
	write(join(ownerRoot, "recovery-traces"), "occupied and unwritable\n", 0o000)
	return environment(current)
}

function normalizePrimaryResult(result: ProcessResult): Record<string, unknown> {
	const parsed = JSON.parse(result.stdout) as Record<string, unknown>
	if (typeof parsed.runIdentity === "string") parsed.runIdentity = "generated-run-identity"
	const normalized = JSON.stringify(parsed).replace(
		/Observation: (fresh|stale) \([^)]*\)/g,
		"Observation: $1 (generated-observation-time)",
	)
	return { exitCode: result.exitCode, stderr: result.stderr, stdout: JSON.parse(normalized) }
}

function normalizeCheckpoint(contents: string): Record<string, unknown> {
	const parsed = JSON.parse(contents) as Record<string, unknown>
	parsed.observedAt = "generated-observation-time"
	return parsed
}

function percentile95(samples: readonly number[]): number {
	const ordered = [...samples].sort((left, right) => left - right)
	return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? Number.NaN
}

function pairedStdoutEofDeltas(observed: readonly TimedProcessResult[], baseline: readonly TimedProcessResult[]): number[] {
	if (observed.length !== baseline.length) throw new Error("paired timing sample count mismatch")
	return observed.map((sample, index) => {
		const pairedBaseline = baseline.at(index)
		if (!pairedBaseline) throw new Error("paired timing baseline missing")
		return sample.stdoutEofMs - pairedBaseline.stdoutEofMs
	})
}

async function startAtBarrier(
	command: string,
	cwd: string,
	input: string,
	environmentVariables: Record<string, string>,
	arguments_: string[],
): Promise<{ release(): void; result(): Promise<ProcessResult> }> {
	const child = Bun.spawn(
		["/bin/sh", "-c", "printf 'ready\\n'; IFS= read -r release; exec \"$@\"", "barrier", command, ...arguments_],
		{ cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: environmentVariables },
	)
	const reader = child.stdout.getReader()
	const ready = await reader.read()
	expect(ready.done).toBe(false)
	expect(new TextDecoder().decode(ready.value)).toBe("ready\n")
	return {
		release() {
			child.stdin.write(`release\n${input}`)
			child.stdin.end()
		},
		async result() {
			const stdoutChunks: Uint8Array[] = []
			const stderrChunks: Uint8Array[] = []
			const stdout = (async () => {
				while (true) {
					const chunk = await reader.read()
					if (chunk.done) break
					stdoutChunks.push(chunk.value)
				}
			})()
			const stderr = (async () => {
				for await (const chunk of child.stderr) stderrChunks.push(chunk)
			})()
			const exitCode = await child.exited
			await Promise.all([stdout, stderr])
			return {
				exitCode,
				stdout: Buffer.concat(stdoutChunks).toString("utf8"),
				stderr: Buffer.concat(stderrChunks).toString("utf8"),
			}
		},
	}
}

function hookEvent(
	fixture: Fixture,
	source = "compact",
	cwd = fixture.vault,
	session = sessionIdentity,
): string {
	return JSON.stringify({
		session_id: session,
		transcript_path: join(fixture.root, "transcript-with-private-content.jsonl"),
		cwd,
		hook_event_name: "SessionStart",
		source,
	})
}

function runHook(fixture: Fixture, input = hookEvent(fixture), cwd = fixture.vault): ProcessResult {
	return run(hookCommand, cwd, input, environment(fixture))
}

function machineEnvelope(
	result: ProcessResult,
	operation: string,
	status: "success" | "error",
): Record<string, unknown> {
	expect(result.stderr).toBe("")
	const envelope = JSON.parse(result.stdout) as Record<string, unknown>
	expect(envelope).toMatchObject({
		schemaVersion: 1,
		commandIdentity: "my-second-brain-playground.recovery-checkpoint",
		operation,
		status,
	})
	expect(envelope.runIdentity).toMatch(/^recovery-checkpoint-run-[0-9a-f]{24}$/)
	return envelope
}

function expectedContext(fixture: Fixture, freshness: "fresh" | "stale"): string {
	const taskQuery =
		"SELECT register_sequence, event_identity, kind, entity_identity FROM register_events WHERE stream = 'task' AND kind = 'task-accepted' AND entity_identity = 'prove-recovery-task-2f52a7a1' ORDER BY register_sequence;"
	return [
		"My Second Brain recovery control panel.",
		"Continue the existing bound work from the goal and current artifact. Reopen workflow skills only when scope changes or workflow guidance is missing.",
		"Run these exact read-only commands as needed. Treat recovered facts as hints; current owners are authoritative.",
		`Read playground entry: ${shellCommand("/bin/cat", join(fixture.vault, "README.md"))}`,
		`Read project map: ${shellCommand("/bin/cat", join(fixture.vault, "projects/ledger-workflow/README.md"))}`,
		`Read goal owner: ${shellCommand("/bin/cat", join(fixture.vault, "projects/ledger-workflow/GOAL.md"))}`,
		`Read evidence owner: ${shellCommand("/bin/cat", join(fixture.vault, "projects/ledger-workflow/proof.md"))}`,
		`Read recovery guide: ${shellCommand("/bin/cat", join(fixture.vault, "docs/agents/recovery.md"))}`,
		`Discover Agent Ledger commands: ${shellCommand(fixture.agentLedger, "register", "discover")}`,
		`Read live Task lifecycle (public Agent Ledger status projection; accepted Task appears in activeTasks while active): ${shellCommand(fixture.agentLedger, "register", "status", "--db", fixture.register)}`,
		`Verify accepted Task (diagnostic fallback, read-only; use only while discovery has no public Task read): ${shellCommand("/usr/bin/sqlite3", "-readonly", fixture.register, taskQuery)}`,
		`Inspect goal and evidence Git history: ${shellCommand("/usr/bin/git", "-C", fixture.vault, "log", "--format=%h%x09%ad%x09%s", "--date=short", "--", "projects/ledger-workflow/GOAL.md", "projects/ledger-workflow/proof.md")}`,
		`Next safe action: ${fixedNextAction}`,
		"Recovered hints:",
		`Observation: ${freshness} (${fixture.checkpoint.observedAt})`,
		`Session identity: ${sessionIdentity}`,
		"Scope: compaction-recovery",
		`Agent Ledger Register: ${fixture.register}`,
		`Task identity: ${taskIdentity}`,
		`Program identity: ${programIdentity}`,
	].join("\n")
}

function replaceCheckpoint(fixture: Fixture, change: Record<string, unknown>): void {
	const checkpoint = { ...fixture.checkpoint, ...change }
	write(fixture.checkpointPath, `${JSON.stringify(checkpoint)}\n`, 0o600)
}

interface FileObservation {
	mode: number
	mtimeMs: number
	size: number
	contents?: string
}

function observeTree(root: string): Record<string, FileObservation> {
	const observations: Record<string, FileObservation> = {}
	function visit(path: string): void {
		const information = lstatSync(path)
		const key = relative(root, path) || "."
		observations[key] = {
			mode: information.mode,
			mtimeMs: information.mtimeMs,
			size: information.size,
			...(information.isFile() ? { contents: readFileSync(path).toString("base64") } : {}),
		}
		if (information.isDirectory()) {
			for (const entry of readdirSync(path).sort()) visit(join(path, entry))
		}
	}
	visit(root)
	return observations
}

function observePrimaryTree(root: string): Record<string, FileObservation> {
	const observations = observeTree(root)
	for (const key of Object.keys(observations)) {
		if (key === "state/my-second-brain-playground/recovery-traces" || key.startsWith("state/my-second-brain-playground/recovery-traces/")) {
			delete observations[key]
		}
	}
	// Creating the private trace directory updates only this parent directory's mtime.
	delete observations["state/my-second-brain-playground"]
	return observations
}

function lifecycleRecords(current: Fixture, recordType = "lifecycle"): Array<Record<string, unknown>> {
	const root = join(current.state, "my-second-brain-playground", "recovery-traces")
	return readdirSync(root)
		.filter((name) => name.endsWith(".jsonl"))
		.flatMap((name) => readFileSync(join(root, name), "utf8").trim().split("\n"))
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((record) => record.record_type === recordType)
}

function observerTraceFileNames(current: Fixture): Set<string> {
	const root = join(current.state, "my-second-brain-playground", "recovery-traces")
	return existsSync(root)
		? new Set(readdirSync(root).filter((name) => name.endsWith(".jsonl")))
		: new Set()
}

function observerPhaseTiming(current: Fixture, before: ReadonlySet<string>): ObserverPhaseTiming {
	const root = join(current.state, "my-second-brain-playground", "recovery-traces")
	const created = [...observerTraceFileNames(current)].filter((name) => !before.has(name))
	if (created.length !== 1) {
		throw new Error(`recovery observer timing association is ambiguous: expected 1 new trace, received ${created.length}`)
	}
	const records = readFileSync(join(root, created[0] as string), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
	const observerRecords = records.filter((record) => (
		record.record_type === "lifecycle" &&
		record.operation === "recover" &&
		typeof record.producer_identity === "string" &&
		record.producer_identity.startsWith("recovery-observer-")
	))
	const phase = (name: string): Record<string, unknown> | undefined => {
		const matches = observerRecords.filter((record) => record.phase === name)
		return matches.length === 1 ? matches[0] : undefined
	}
	const invocation = phase("invocation")
	const response = phase("response-available")
	const terminal = phase("terminal")
	const durations = [invocation?.duration_ms, response?.duration_ms, terminal?.duration_ms]
	const identities = new Set(observerRecords.map((record) => record.invocation_identity))
	const producers = new Set(observerRecords.map((record) => record.producer_identity))
	const valid = invocation !== undefined && response !== undefined && terminal !== undefined &&
		invocation.outcome === "started" && response.outcome === "succeeded" && terminal.outcome === "succeeded" &&
		identities.size === 1 && typeof invocation.invocation_identity === "string" &&
		producers.size === 1 && response.parent_record_identity === invocation.record_identity &&
		terminal.parent_record_identity === invocation.record_identity &&
		durations.every((duration) => typeof duration === "number" && Number.isFinite(duration) && duration >= 0) &&
		(durations[0] as number) <= (durations[1] as number) &&
		(durations[1] as number) <= (durations[2] as number)
	if (!valid) throw new Error("recovery observer timing record has invalid phase values or association")
	return {
		invocationIdentity: invocation.invocation_identity as string,
		observerOpenMs: durations[0] as number,
		responseAvailableMs: durations[1] as number,
		terminalMs: durations[2] as number,
	}
}

async function directChildProcessId(parentProcessId: number): Promise<number> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const found = Bun.spawnSync(["/usr/bin/pgrep", "-P", String(parentProcessId)], { stdout: "pipe", stderr: "pipe" })
		const candidate = Number(found.stdout.toString().trim().split("\n")[0])
		if (found.exitCode === 0 && Number.isSafeInteger(candidate) && candidate > 0) return candidate
		await Bun.spawn(["/usr/bin/true"]).exited
	}
	throw new Error("observer child process was not found")
}

async function waitForFile(path: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (existsSync(path)) return
		await Bun.sleep(5)
	}
	throw new Error(`timed out waiting for ${path}`)
}

async function waitForProcessExit(processId: number): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const check = Bun.spawnSync(["/bin/kill", "-0", String(processId)], { stdout: "ignore", stderr: "ignore" })
		if (check.exitCode !== 0) return
		await Bun.sleep(5)
	}
	throw new Error(`process ${processId} remained alive after supervised shutdown`)
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("a valid compact SessionStart emits only verified bounded recovery context", () => {
	const current = fixture()
	write(join(current.root, "transcript-with-private-content.jsonl"), "PRIVATE TRANSCRIPT SENTINEL\n")

	const result = runHook(current)

	expect(result.exitCode).toBe(0)
	expect(result.stderr).toBe("")
	expect(JSON.parse(result.stdout)).toEqual({
		hookSpecificOutput: {
			hookEventName: "SessionStart",
			additionalContext: expectedContext(current, "fresh"),
		},
	})
	expect(result.stdout).not.toContain("PRIVATE TRANSCRIPT SENTINEL")
	expect(result.stdout).not.toContain("transcript-with-private-content")
	expect(existsSync(`${current.agentLedger}.executed`)).toBe(false)
})

test("quoted owner, Task diagnostic, and Git history controls execute at their read-only seams", () => {
	const current = fixture()
	const output = JSON.parse(runHook(current).stdout) as {
		hookSpecificOutput: { additionalContext: string }
	}
	const lines = output.hookSpecificOutput.additionalContext.split("\n")
	const commandFor = (label: string): string => {
		const line = lines.find((candidate) => candidate.startsWith(`${label}: `))
		expect(line).toBeDefined()
		return line!.slice(label.length + 2)
	}

	const entry = run("/bin/sh", current.vault, "", environment(current), [
		"-c",
		commandFor("Read playground entry"),
	])
	expect(entry).toEqual({ exitCode: 0, stdout: "# Playground entry\n", stderr: "" })

	const registerBefore = readFileSync(current.register).toString("base64")
	const diagnostic = run("/bin/sh", current.vault, "", environment(current), [
		"-c",
		commandFor(
			"Verify accepted Task (diagnostic fallback, read-only; use only while discovery has no public Task read)",
		),
	])
	expect(diagnostic).toEqual({
		exitCode: 0,
		stdout: `1|register-event-fixture|task-accepted|${taskIdentity}\n`,
		stderr: "",
	})
	expect(readFileSync(current.register).toString("base64")).toBe(registerBefore)

	const statusRegisterBefore = readFileSync(current.register).toString("base64")
	const liveStatus = run("/bin/sh", current.vault, "", environment(current), [
		"-c",
		commandFor("Read live Task lifecycle (public Agent Ledger status projection; accepted Task appears in activeTasks while active)"),
	])
	expect(liveStatus.exitCode).toBe(0)
	expect(existsSync(`${current.agentLedger}.executed`)).toBe(true)
	expect(readFileSync(current.register).toString("base64")).toBe(statusRegisterBefore)

	expect(run("/usr/bin/git", current.vault, "", environment(current), ["init"]).exitCode).toBe(0)
	expect(
		run("/usr/bin/git", current.vault, "", environment(current), ["add", "README.md", "projects"]).exitCode,
	).toBe(0)
	expect(
		run("/usr/bin/git", current.vault, "", environment(current), [
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"-m",
			"fixture history",
		]).exitCode,
	).toBe(0)
	const history = run("/bin/sh", current.vault, "", environment(current), [
		"-c",
		commandFor("Inspect goal and evidence Git history"),
	])
	expect(history.exitCode).toBe(0)
	expect(history.stderr).toBe("")
	expect(history.stdout).toContain("fixture history")
})

test("startup and resume expose only the hook-supplied session identity", () => {
	const current = fixture()
	for (const source of ["startup", "resume"]) {
		const result = runHook(current, hookEvent(current, source))
		expect(result.exitCode).toBe(0)
		expect(result.stderr).toBe("")
		expect(JSON.parse(result.stdout)).toEqual({
			hookSpecificOutput: {
				hookEventName: "SessionStart",
				additionalContext: [
					"My Second Brain recovery session.",
					`Session identity: ${sessionIdentity}`,
					"Use this exact sessionIdentity when writing this session's recovery checkpoint.",
				].join("\n"),
			},
		})
	}
})

test("unregistered SessionStart sources and other hook events stay silent", () => {
	const current = fixture()
	const cases = [
		hookEvent(current, "clear"),
		JSON.stringify({
			session_id: sessionIdentity,
			hook_event_name: "Stop",
			source: "compact",
			cwd: current.vault,
		}),
	]
	for (const input of cases) {
		expect(runHook(current, input)).toEqual({ exitCode: 0, stdout: "", stderr: "" })
	}
})

test("a compact event whose cwd is outside the configured vault stays silent", () => {
	const current = fixture()
	const outside = join(current.root, "outside")
	mkdirSync(outside)

	expect(runHook(current, hookEvent(current, "compact", outside), outside)).toEqual({
		exitCode: 0,
		stdout: "",
		stderr: "",
	})
})

test("malformed and oversized hook inputs fail open without output", () => {
	const current = fixture()
	const malformed = '{"hook_event_name":"SessionStart",'
	const duplicate = `{"hook_event_name":"SessionStart","hook_event_name":"SessionStart","source":"compact","cwd":${JSON.stringify(current.vault)}}`
	const oversized = " ".repeat(128 * 1024 + 1)

	for (const input of [malformed, duplicate, oversized]) {
		expect(runHook(current, input)).toEqual({ exitCode: 0, stdout: "", stderr: "" })
	}
})

test("missing, malformed, public, and symbolic checkpoint state stays silent", () => {
	const current = fixture()
	rmSync(current.checkpointPath)
	expect(runHook(current)).toEqual({ exitCode: 0, stdout: "", stderr: "" })

	const globalCheckpoint = join(dirname(dirname(current.checkpointPath)), "current.json")
	write(globalCheckpoint, `${JSON.stringify(current.checkpoint)}\n`, 0o600)
	expect(runHook(current)).toEqual({ exitCode: 0, stdout: "", stderr: "" })

	write(current.checkpointPath, "{", 0o600)
	expect(runHook(current)).toEqual({ exitCode: 0, stdout: "", stderr: "" })

	write(current.checkpointPath, `${JSON.stringify(current.checkpoint)}\n`, 0o644)
	expect(runHook(current)).toEqual({ exitCode: 0, stdout: "", stderr: "" })

	write(current.checkpointPath, " ".repeat(16 * 1024 + 1), 0o600)
	expect(runHook(current)).toEqual({ exitCode: 0, stdout: "", stderr: "" })

	write(current.checkpointPath, `${JSON.stringify(current.checkpoint)}\n`, 0o600)
	const privateTarget = join(current.root, "private-checkpoint.json")
	renameSync(current.checkpointPath, privateTarget)
	chmodSync(privateTarget, 0o600)
	symlinkSync(privateTarget, current.checkpointPath)
	expect(runHook(current)).toEqual({ exitCode: 0, stdout: "", stderr: "" })
})

test("missing and malformed vault configuration stays silent", () => {
	const current = fixture()
	const config = join(current.home, ".config/my-second-brain-playground/vault.json")
	rmSync(config)
	expect(runHook(current)).toEqual({ exitCode: 0, stdout: "", stderr: "" })

	write(config, `${JSON.stringify({ schemaVersion: 1, vault: current.vault, extra: true })}\n`)
	expect(runHook(current)).toEqual({ exitCode: 0, stdout: "", stderr: "" })
})

test("mismatched Task, Register, and contained-path relationships stay silent", () => {
	const current = fixture()
	replaceCheckpoint(current, { taskIdentity: "wrong-task-identity" })
	expect(runHook(current).stdout).toBe("")

	const otherRegister = join(current.data, "my-second-brain-playground/registers/other.sqlite3")
	cpSync(current.register, otherRegister)
	replaceCheckpoint(current, { registerPath: realpathSync(otherRegister) })
	expect(runHook(current).stdout).toBe("")

	write(join(current.root, "outside.md"), "# Outside\n")
	replaceCheckpoint(current, { evidencePath: "../outside.md" })
	expect(runHook(current).stdout).toBe("")
})

test("unsafe Agent Ledger executable paths stay silent", () => {
	const current = fixture()
	chmodSync(current.agentLedger, 0o600)
	expect(runHook(current).stdout).toBe("")

	chmodSync(current.agentLedger, 0o700)
	const link = join(current.root, "agent-ledger-link")
	symlinkSync(current.agentLedger, link)
	replaceCheckpoint(current, { agentLedgerExecutable: link })
	expect(runHook(current).stdout).toBe("")

	replaceCheckpoint(current, { agentLedgerExecutable: join(current.root, "missing-agent-ledger") })
	expect(runHook(current).stdout).toBe("")
})

test("invalid or mismatched session identities stay silent", () => {
	const current = fixture()
	expect(runHook(current, hookEvent(current, "compact", current.vault, "../other"))).toEqual({
		exitCode: 0,
		stdout: "",
		stderr: "",
	})
	expect(runHook(current, hookEvent(current, "compact", current.vault, "other-session"))).toEqual({
		exitCode: 0,
		stdout: "",
		stderr: "",
	})
	replaceCheckpoint(current, { sessionIdentity: "other-session" })
	expect(runHook(current).stdout).toBe("")
})

test("two checkpoint writes and compact sessions recover only their own Task control panel", () => {
	const current = fixture({ writeCheckpoint: false })
	const secondSession = "session-second"
	const secondTask = "prove-second-task-9b45cdee"
	const register = new Database(current.register)
	register
		.query("INSERT INTO register_events VALUES (2, ?, 'task', ?, 'task-accepted')")
		.run("register-event-second", secondTask)
	register.close()

	write(join(current.vault, "projects/second-work/README.md"), "# Second work\n")
	write(join(current.vault, "projects/second-work/proof.md"), "# Second evidence\n")
	write(
		join(current.vault, "projects/second-work/GOAL.md"),
		[
			"# Second goal",
			"",
			`- Task: \`${secondTask}\`.`,
			`- Register: \`${current.register}\`.`,
			`- Program: \`${programIdentity}\`.`,
			"",
		].join("\n"),
	)
	const secondCheckpoint = {
		...current.checkpoint,
		projectMap: "projects/second-work/README.md",
		goalPath: "projects/second-work/GOAL.md",
		evidencePath: "projects/second-work/proof.md",
		sessionIdentity: secondSession,
		taskIdentity: secondTask,
		scope: "second-work",
	}
	const secondCheckpointPath = join(
		current.state,
		"my-second-brain-playground/recovery/sessions",
		`${secondSession}.json`,
	)
	expect(
		run(
			checkpointCommand,
			current.vault,
			JSON.stringify(current.checkpoint),
			environment(current),
			["write"],
		).exitCode,
	).toBe(0)
	expect(
		run(
			checkpointCommand,
			current.vault,
			JSON.stringify(secondCheckpoint),
			environment(current),
			["write"],
		).exitCode,
	).toBe(0)
	expect(existsSync(current.checkpointPath)).toBe(true)
	expect(existsSync(secondCheckpointPath)).toBe(true)

	const first = runHook(current)
	const second = runHook(
		current,
		hookEvent(current, "compact", current.vault, secondSession),
	)
	expect(first.stdout).toContain(taskIdentity)
	expect(first.stdout).not.toContain(secondTask)
	expect(first.stdout).toContain("projects/ledger-workflow/GOAL.md")
	expect(first.stdout).not.toContain("projects/second-work/GOAL.md")
	expect(second.stdout).toContain(secondTask)
	expect(second.stdout).not.toContain(taskIdentity)
	expect(second.stdout).toContain("projects/second-work/GOAL.md")
	expect(second.stdout).not.toContain("projects/ledger-workflow/GOAL.md")
})

test("a version 1 checkpoint is rejected", () => {
	const current = fixture({ writeCheckpoint: false })
	const oldCheckpoint = { ...current.checkpoint }
	oldCheckpoint.schemaVersion = 1
	delete oldCheckpoint.agentLedgerExecutable
	delete oldCheckpoint.sessionIdentity

	const result = run(
		checkpointCommand,
		current.vault,
		JSON.stringify(oldCheckpoint),
		environment(current),
		["write"],
	)

	expect(result.exitCode).toBe(1)
	const envelope = machineEnvelope(result, "write", "error")
	expect(envelope).toMatchObject({
		transactionState: "not-started",
		error: {
			code: "INVALID_CHECKPOINT",
			action: "CORRECT_INPUT",
			errorFamily: "validation",
			safeToRetrySameInput: false,
		},
	})
	expect(existsSync(current.checkpointPath)).toBe(false)
})

test("a stale checkpoint is labelled stale while preserving the fixed next action", () => {
	const current = fixture({ observedSecondsAgo: 2 * 60 * 60 })

	const result = runHook(current)

	expect(result.exitCode).toBe(0)
	expect(result.stderr).toBe("")
	expect(JSON.parse(result.stdout)).toEqual({
		hookSpecificOutput: {
			hookEventName: "SessionStart",
			additionalContext: expectedContext(current, "stale"),
		},
	})
})

test("the read-only hook changes no checkpoint or fixture state outside private traces", () => {
	const current = fixture()
	const before = observePrimaryTree(current.root)

	const result = runHook(current)

	expect(result.stdout).not.toBe("")
	expect(observePrimaryTree(current.root)).toEqual(before)
})

test("the production hook supervisor preserves Python bytes and records the hook-supplied worker identity", () => {
	const current = fixture()
	const input = hookEvent(current)
	const direct = run("/usr/bin/python3", current.vault, input, environment(current), ["-B", recoveryEngine, "hook"])
	const supervised = runHook(current, input)

	expect(supervised).toEqual(direct)
	const records = lifecycleRecords(current)
	expect(records.some((record) => (
		record.operation === "hook" &&
		record.observed_worker_identity === sessionIdentity &&
		record.observed_worker_identity_source === "hook-payload"
	))).toBe(true)
	expect(records.some((record) => record.inherited_parent_identity !== undefined)).toBe(false)
	const observerInvocation = records.find((record) => (
		record.operation === "hook" &&
		record.phase === "invocation" &&
		String(record.producer_identity).startsWith("recovery-observer-")
	))
	if (!observerInvocation) throw new Error("observer invocation was not retained")
	const producerRecords = records.filter((record) => String(record.producer_identity).startsWith("recovery-python-"))
	expect(producerRecords.length).toBeGreaterThan(0)
	expect(producerRecords.some((record) => record.journey_identity === "session-fixture")).toBe(true)
	expect(new Set(producerRecords.map((record) => record.invocation_identity))).toEqual(new Set([observerInvocation.invocation_identity]))
	expect(new Set(producerRecords.map((record) => record.parent_record_identity))).toEqual(new Set([observerInvocation.record_identity]))
})

test("bind and recovery share a session journey with distinct explicitly linked invocations", () => {
	const current = fixture()
	const env = { ...environment(current), CODEX_SESSION_ID: sessionIdentity }
	for (const [operation, arguments_] of [
		["bind", ["bind", "projects/ledger-workflow/GOAL.md", "--agent-ledger", current.agentLedger]],
		["recover", ["recover"]],
	] as const) {
		const result = run(checkpointCommand, current.vault, "", env, [...arguments_])
		expect(result.exitCode).toBe(0)
		const records = lifecycleRecords(current).filter((record) => record.operation === operation)
		const observerInvocation = records.find((record) => (
			record.phase === "invocation" && String(record.producer_identity).startsWith("recovery-observer-")
		))
		if (!observerInvocation) throw new Error(`${operation} observer invocation was not retained`)
		const producerRecords = records.filter((record) => String(record.producer_identity).startsWith("recovery-python-"))
		expect(producerRecords.length).toBeGreaterThan(0)
		expect(producerRecords.some((record) => record.journey_identity === "session-fixture")).toBe(true)
		expect(new Set(producerRecords.map((record) => record.invocation_identity))).toEqual(new Set([observerInvocation.invocation_identity]))
		expect(new Set(producerRecords.map((record) => record.parent_record_identity))).toEqual(new Set([observerInvocation.record_identity]))
	}
	const records = lifecycleRecords(current)
	const journey = records.filter((record) => record.journey_identity === "session-fixture" && record.operation !== "cleanup")
	expect(new Set(journey.map((record) => record.operation))).toEqual(new Set(["bind", "recover"]))
	expect(new Set(journey.map((record) => record.invocation_identity)).size).toBe(2)
	expect(journey.some((record) => record.observed_worker_identity !== undefined)).toBe(false)
})

test("the public hook supervisor records a real child signal while the producer has no terminal record", async () => {
	const current = fixture()
	const observer = Bun.spawn([hookCommand], {
		cwd: current.vault,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: environment(current),
	})
	const stdout = new Response(observer.stdout).text()
	const stderr = new Response(observer.stderr).text()
	try {
		const childProcessId = await directChildProcessId(observer.pid)
		process.kill(childProcessId, "SIGTERM")
	} finally {
		observer.stdin.end()
	}
	expect(await observer.exited).not.toBe(0)
	expect(await stdout).toBe("")
	expect(await stderr).toBe("")
	const diagnostics = lifecycleRecords(current, "diagnostic")
	expect(diagnostics.some((record) => record.event === "observer-failure" && record.level === "error")).toBe(true)
	const records = lifecycleRecords(current).filter((record) => record.operation === "hook")
	expect(records.some((record) => record.phase === "terminal" && record.outcome === "signalled")).toBe(true)
	expect(records.some((record) => (
		String(record.producer_identity).startsWith("recovery-python-") && record.phase === "terminal"
	))).toBe(false)
}, 10_000)

test("the observer deadline is a known terminal observation while a missing producer terminal remains unknown", async () => {
	const current = fixture()
	const observer = Bun.spawn([hookCommand], {
		cwd: current.vault,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...environment(current), MSB_RECOVERY_OBSERVER_DEADLINE_MS: "50" },
	})
	const stdout = new Response(observer.stdout).text()
	const stderr = new Response(observer.stderr).text()
	// A 50 ms child can exit between scheduler turns; the signal test owns PID reaping proof.
	try {
		expect(await observer.exited).not.toBe(0)
	} finally {
		observer.stdin.end()
	}
	expect(await stdout).toBe("")
	expect(await stderr).toBe("")
	const records = lifecycleRecords(current).filter((record) => record.operation === "hook")
	expect(records.some((record) => (
		record.phase === "terminal" &&
		record.outcome === "deadline-exceeded" &&
		String(record.producer_identity).startsWith("recovery-observer-")
	))).toBe(true)
	expect(records.some((record) => (
		String(record.producer_identity).startsWith("recovery-python-") && record.phase === "terminal"
	))).toBe(false)
}, 10_000)

test("the supervisor forwards SIGTERM and SIGINT to a held Python child and reaps it", async () => {
	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		const current = fixture()
		const observer = Bun.spawn([checkpointCommand, "recover"], {
			cwd: current.vault,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: environment(current),
		})
		const stdout = new Response(observer.stdout).text()
		const stderr = new Response(observer.stderr).text()
		const childProcessId = await directChildProcessId(observer.pid)
		process.kill(observer.pid, signal)
		try {
			expect(await observer.exited).not.toBe(0)
		} finally {
			observer.stdin.end()
		}
		expect(await stdout).toBe("")
		expect(await stderr).toBe("")
		await waitForProcessExit(childProcessId)
		const records = lifecycleRecords(current).filter((record) => record.operation === "recover")
		expect(records.some((record) => (
			record.phase === "terminal" &&
			record.outcome === "signalled" &&
			String(record.producer_identity).startsWith("recovery-observer-")
		))).toBe(true)
		expect(records.some((record) => String(record.producer_identity).startsWith("recovery-python-"))).toBe(false)
	}
}, 15_000)

test("a detached slow cleanup cannot retain the primary response descriptors", async () => {
	const current = fixture()
	const barrier = join(current.root, "cleanup-barrier")
	mkdirSync(barrier, { recursive: true, mode: 0o700 })
	const isolatedPlugin = join(current.root, "plugin")
	const runtime = join(isolatedPlugin, "runtime")
	const recoverySource = join(isolatedPlugin, "packages/compaction-recovery/src")
	mkdirSync(runtime, { recursive: true })
	mkdirSync(recoverySource, { recursive: true })
	cpSync(recoveryEngine, join(recoverySource, "recovery.py"))
	cpSync(resolve(import.meta.dir, "../../recovery-observability/src/test-fixtures/held-cleanup.js"), join(runtime, "recovery-traces.js"))
	const build = Bun.spawnSync([
		process.execPath, "build", resolve(import.meta.dir, "../../recovery-observability/src/recovery-observer.ts"),
		"--target=bun", `--outfile=${join(runtime, "recovery-observer.js")}`,
	], { cwd: resolve(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe" })
	expect(build.exitCode).toBe(0)
	const observer = Bun.spawn([process.execPath, join(runtime, "recovery-observer.js"), "checkpoint", "recover"], {
		cwd: current.vault,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...environment(current),
			CODEX_SESSION_ID: sessionIdentity,
			MSB_RECOVERY_TEST_CLEANUP_BARRIER_DIRECTORY: barrier,
		},
	})
	observer.stdin.end()
	const stdout = new Response(observer.stdout).text()
	const stderr = new Response(observer.stderr).text()
	try {
		await waitForFile(join(barrier, "cleanup-ready"))
		expect(JSON.parse(await stdout)).toMatchObject({ operation: "recover", status: "success" })
		expect(await stderr).toBe("")
		expect(await observer.exited).toBe(0)
		expect(existsSync(join(barrier, "cleanup-finished"))).toBe(false)
	} finally {
		write(join(barrier, "cleanup-release"), "release\n", 0o600)
		await waitForFile(join(barrier, "cleanup-finished"))
	}
}, 15_000)

test("the checkpoint supervisor records accepted write and schema lifecycle operations without promoting inherited identity to a worker", () => {
	const current = fixture()
	const parentIdentity = "inherited-parent-session"
	const env = { ...environment(current), CODEX_SESSION_ID: parentIdentity }
	const payload = JSON.stringify(current.checkpoint)
	const direct = run("/usr/bin/python3", current.vault, payload, env, ["-B", recoveryEngine, "checkpoint", "write"])
	const beforeSupervised = readFileSync(current.checkpointPath, "utf8")
	const supervised = run(checkpointCommand, current.vault, payload, env, ["write"])
	const normalize = (result: ProcessResult): Record<string, unknown> => {
		const envelope = JSON.parse(result.stdout) as Record<string, unknown>
		envelope.runIdentity = "independent-run-identity"
		return envelope
	}

	expect(supervised.exitCode).toBe(direct.exitCode)
	expect(supervised.stderr).toBe(direct.stderr)
	expect(normalize(supervised)).toEqual(normalize(direct))
	expect(readFileSync(current.checkpointPath, "utf8")).toBe(beforeSupervised)
	const writeRecords = lifecycleRecords(current).filter((record) => record.operation === "write")
	const writeObserverRecords = writeRecords.filter((record) => typeof record.producer_identity === "string" && record.producer_identity.startsWith("recovery-observer-"))
	expect(writeRecords.some((record) => record.inherited_parent_identity === parentIdentity)).toBe(true)
	expect(writeRecords.some((record) => record.observed_worker_identity !== undefined)).toBe(false)
	expect(writeObserverRecords.map((record) => record.phase)).toEqual(["invocation", "response-available", "terminal"])
	expect(writeObserverRecords.map((record) => record.producer_sequence)).toEqual([0, 1, 2])

	const schema = run(checkpointCommand, current.vault, "", env, ["schema"])
	expect(schema.exitCode).toBe(0)
	const schemaObserverRecords = lifecycleRecords(current).filter((record) => (
		record.operation === "schema" &&
		typeof record.producer_identity === "string" &&
		record.producer_identity.startsWith("recovery-observer-")
	))
	expect(schemaObserverRecords.map((record) => record.phase)).toEqual(["invocation", "response-available", "terminal"])
})

test("capture enabled, disabled, and unavailable preserve bind, recover, hook, and durable primary results", () => {
	const current = fixture({ writeCheckpoint: false })
	const registerBefore = readFileSync(current.register).toString("base64")
	const tracePath = join(current.state, "my-second-brain-playground", "recovery-traces")
	type Mode = "disabled" | "enabled" | "unavailable"
	// Every mode is written in the loop below before any mode is read.
	const rows = {} as Record<Mode, Record<string, unknown>>

	for (const mode of ["disabled", "enabled", "unavailable"] as const) {
		rmSync(current.checkpointPath, { force: true })
		rmSync(tracePath, { recursive: true, force: true })
		const baseEnvironment = mode === "disabled"
			? withoutCapture(current)
			: mode === "unavailable"
				? withUnavailableCapture(current)
				: environment(current)
		const env = { ...baseEnvironment, CODEX_SESSION_ID: sessionIdentity }
		const binding = run(checkpointCommand, current.vault, "", env, [
			"bind",
			"projects/ledger-workflow/GOAL.md",
			"--agent-ledger",
			current.agentLedger,
		])
		const checkpointAfterBind = readFileSync(current.checkpointPath, "utf8")
		const recovered = run(checkpointCommand, current.vault, "", env, ["recover"])
		const identityRefusal = run(checkpointCommand, current.vault, "", env, [
			"recover",
			"--session",
			"conflicting-session",
		])
		const hook = run(hookCommand, current.vault, hookEvent(current), env)

		expect(readFileSync(current.checkpointPath, "utf8")).toBe(checkpointAfterBind)
		expect(readFileSync(current.register).toString("base64")).toBe(registerBefore)
		rows[mode] = {
			bind: normalizePrimaryResult(binding),
			recover: normalizePrimaryResult(recovered),
			identityRefusal: normalizePrimaryResult(identityRefusal),
			hook: normalizePrimaryResult(hook),
			checkpoint: normalizeCheckpoint(checkpointAfterBind),
			register: readFileSync(current.register).toString("base64"),
			traceFiles: existsSync(tracePath) && statSync(tracePath).isDirectory()
				? readdirSync(tracePath).filter((name) => name.endsWith(".jsonl")).length
				: 0,
		}
		if (mode === "enabled") {
			expect(lifecycleRecords(current).some((record) => (
				record.operation === "recover" &&
				record.phase === "terminal" &&
				record.outcome === "failed" &&
				record.inherited_parent_identity === sessionIdentity &&
				String(record.producer_identity).startsWith("recovery-observer-")
			))).toBe(true)
		}
	}

	expect(typeof rows.enabled.traceFiles).toBe("number")
	expect(Number(rows.enabled.traceFiles)).toBeGreaterThan(0)
	expect(rows.disabled.traceFiles).toBe(0)
	expect(rows.unavailable.traceFiles).toBe(0)
	for (const mode of ["enabled", "unavailable"] as const) {
		expect({ ...rows[mode], traceFiles: 0 }).toEqual({ ...rows.disabled, traceFiles: 0 })
	}
})

test("simultaneous sessions cross one launch barrier, retain separate checkpoints, and preserve producer order", async () => {
	const current = fixture({ writeCheckpoint: false })
	const secondSession = "session-second"
	const secondTask = "prove-second-task-9b45cdee"
	const secondCheckpointPath = join(dirname(current.checkpointPath), `${secondSession}.json`)
	const register = new Database(current.register)
	register
		.query("INSERT INTO register_events VALUES (2, ?, 'task', ?, 'task-accepted')")
		.run("register-event-second", secondTask)
	register.close()
	write(join(current.vault, "projects/second-work/README.md"), "# Second work\n")
	write(join(current.vault, "projects/second-work/proof.md"), "# Second evidence\n")
	write(
		join(current.vault, "projects/second-work/GOAL.md"),
		[
			"# Second goal",
			"",
			`- Task: \`${secondTask}\`.`,
			`- Register: \`${current.register}\`.`,
			`- Program: \`${programIdentity}\`.`,
			"",
		].join("\n"),
	)
	const secondCheckpoint = {
		...current.checkpoint,
		projectMap: "projects/second-work/README.md",
		goalPath: "projects/second-work/GOAL.md",
		evidencePath: "projects/second-work/proof.md",
		sessionIdentity: secondSession,
		taskIdentity: secondTask,
		scope: "second-work",
	}
	const first = await startAtBarrier(
		checkpointCommand,
		current.vault,
		JSON.stringify(current.checkpoint),
		{ ...environment(current), CODEX_SESSION_ID: "parent-first" },
		["write"],
	)
	const second = await startAtBarrier(
		checkpointCommand,
		current.vault,
		JSON.stringify(secondCheckpoint),
		{ ...environment(current), CODEX_SESSION_ID: "parent-second" },
		["write"],
	)

	first.release()
	second.release()
	const [firstResult, secondResult] = await Promise.all([first.result(), second.result()])
	expect(firstResult.exitCode).toBe(0)
	expect(secondResult.exitCode).toBe(0)
	expect(firstResult.stderr).toBe("")
	expect(secondResult.stderr).toBe("")
	expect(JSON.parse(readFileSync(current.checkpointPath, "utf8"))).toEqual(current.checkpoint)
	expect(JSON.parse(readFileSync(secondCheckpointPath, "utf8"))).toEqual(secondCheckpoint)

	const records = lifecycleRecords(current)
	const attributedTasks = new Set(records.map((record) => record.ledger_task_identity).filter(Boolean))
	expect(attributedTasks).toEqual(new Set([taskIdentity, secondTask]))
	expect(new Set(records.map((record) => record.inherited_parent_identity).filter(Boolean))).toEqual(
		new Set(["parent-first", "parent-second"]),
	)
	const sequences = new Map<string, number[]>()
	for (const record of records) {
		const producer = record.producer_identity
		const sequence = record.producer_sequence
		if (typeof producer !== "string" || typeof sequence !== "number") continue
		sequences.set(producer, [...(sequences.get(producer) ?? []), sequence])
	}
	for (const sequence of sequences.values()) {
		expect(sequence).toEqual(sequence.map((_, index) => index))
	}
})

test.each([0, 1, 2])("standard descriptor %i cannot become a lifecycle observation channel", (descriptor) => {
	const current = fixture()
	const env = { ...environment(current), CODEX_SESSION_ID: sessionIdentity }
	const args = ["-B", recoveryEngine, "checkpoint", "recover"]
	const direct = run("/usr/bin/python3", current.vault, "", env, args)
	const observed = run("/usr/bin/python3", current.vault, "", {
		...env,
		MSB_RECOVERY_OBSERVABILITY_FD: String(descriptor),
		MSB_RECOVERY_OBSERVATION_INVOCATION_IDENTITY: "standard-descriptor-regression",
	}, args)
	expect(direct.exitCode).toBe(0)
	expect(normalizePrimaryResult(observed)).toEqual(normalizePrimaryResult(direct))
})

test("the recovery lifecycle emits a 512-character observation identity and rejects 513", () => {
	const current = fixture()
	const acceptedIdentity = `a${"x".repeat(511)}`
	const rejectedIdentity = `a${"x".repeat(512)}`
	const acceptedTrace = join(current.root, "accepted-observations.jsonl")
	const rejectedTrace = join(current.root, "rejected-observations.jsonl")
	const recoverWithIdentity = (identity: string, trace: string): ProcessResult => run(
		"/bin/sh",
		current.vault,
		"",
		{
			...environment(current),
			CODEX_SESSION_ID: sessionIdentity,
			MSB_RECOVERY_OBSERVABILITY_FD: "3",
			MSB_RECOVERY_OBSERVATION_INVOCATION_IDENTITY: identity,
		},
		["-c", `exec /usr/bin/python3 -B ${shellQuote(recoveryEngine)} checkpoint recover 3>${shellQuote(trace)}`],
	)

	expect(acceptedIdentity.length).toBe(512)
	expect(rejectedIdentity.length).toBe(513)
	expect(recoverWithIdentity(acceptedIdentity, acceptedTrace).exitCode).toBe(0)
	expect(recoverWithIdentity(rejectedIdentity, rejectedTrace).exitCode).toBe(0)
	const acceptedRecords = readFileSync(acceptedTrace, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>)
	expect(acceptedRecords.length).toBeGreaterThan(0)
	expect(acceptedRecords.every((record) => record.invocation_identity === acceptedIdentity)).toBe(true)
	expect(readFileSync(rejectedTrace, "utf8")).toBe("")
})

test("closed, full, and non-reading lifecycle pipes preserve the real recovery process result", () => {
	const current = fixture()
	const env = { ...environment(current), CODEX_SESSION_ID: sessionIdentity }
	const checkpointBefore = readFileSync(current.checkpointPath)
	const registerBefore = readFileSync(current.register)
	const direct = run("/usr/bin/python3", current.vault, "", env, ["-B", recoveryEngine, "checkpoint", "recover"])

	for (const mode of ["closed", "full", "non-reading"]) {
		const observed = run("/usr/bin/python3", current.vault, "", env, [
			"-B",
			observationPipeHarness,
			recoveryEngine,
			mode,
			"checkpoint",
			"recover",
		])
		expect(normalizePrimaryResult(observed)).toEqual(normalizePrimaryResult(direct))
		expect(readFileSync(current.checkpointPath)).toEqual(checkpointBefore)
		expect(readFileSync(current.register)).toEqual(registerBefore)
	}
})

test("the Task identity check is sensitive to a wrong goal identity", () => {
	const current = fixture()
	const goal = join(current.vault, "projects/ledger-workflow/GOAL.md")
	const correctGoal = readFileSync(goal, "utf8")
	writeFileSync(goal, correctGoal.replace(taskIdentity, "wrong-task-identity"))

	expect(runHook(current).stdout).toBe("")

	writeFileSync(goal, correctGoal)
	expect(runHook(current).stdout).not.toBe("")
})

test("the checkpoint process exposes its exact versioned field contract", () => {
	const current = fixture()
	const result = run(checkpointCommand, current.vault, "", environment(current), ["schema"])

	expect(result.exitCode).toBe(0)
	const envelope = machineEnvelope(result, "schema", "success")
	expect(envelope.data).toMatchObject({
		schemaVersion: 2,
		sessionIdentityPattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
		required: [
			"schemaVersion",
			"vaultRoot",
			"projectMap",
			"goalPath",
			"evidencePath",
			"recoveryPath",
			"agentLedgerExecutable",
			"sessionIdentity",
			"registerPath",
			"taskIdentity",
			"programIdentity",
			"scope",
			"observedAt",
		],
		additionalProperties: false,
		freshForSeconds: 3600,
	})
})

test("no arguments and both help flags advertise the bounded command surface", () => {
	const current = fixture()
	for (const arguments_ of [[], ["--help"], ["-h"]]) {
		const result = run(checkpointCommand, current.vault, "", environment(current), arguments_)
		expect(result.exitCode).toBe(0)
		const envelope = machineEnvelope(result, "help", "success")
		expect(envelope.data).toEqual({
			usage: "recovery-checkpoint [--help|-h|schema|write|bind|recover]",
 session: "Use CODEX_SESSION_ID, or --session with the Claude startup hook identity. Conflicting values are refused.",
			commands: [
    {name:"bind",description:"Bind an unbound session or refresh its same work owner from GOAL.md; refuse a different saved owner.",usage:"bind <vault-relative-GOAL.md> --agent-ledger <absolute-executable> [--session <id>] [--evidence <vault-relative-file>]"},
    {name:"recover",description:"Return this session's verified control panel without writes or command execution.",usage:"recover [--session <id>]"},
				{
					name: "schema",
					description: "Print the accepted checkpoint field contract.",
				},
				{
					name: "write",
					description:
						"Validate one checkpoint JSON object from stdin and atomically write its session file.",
				},
			],
		})
	}
})

test("unknown arguments report a versioned not-started usage failure with a fixed repair", () => {
	const current = fixture()
	const result = run(checkpointCommand, current.vault, "", environment(current), ["unknown"])

	expect(result.exitCode).toBe(2)
	const envelope = machineEnvelope(result, "usage", "error")
	expect(envelope).toMatchObject({
		transactionState: "not-started",
		error: {
			code: "USAGE",
			action: "READ_HELP",
			errorFamily: "usage",
			repairAction: "Run recovery-checkpoint --help and select one advertised command.",
			safeToRetrySameInput: false,
		},
	})
})

test("Codex and Claude declarations route startup, resume, and compact SessionStart to the shared executable", () => {
	const pluginRoot = resolve(import.meta.dir, "../../..")
	const codex = JSON.parse(readFileSync(join(pluginRoot, "hooks/codex/hooks.json"), "utf8"))
	const claude = JSON.parse(readFileSync(join(pluginRoot, "hooks/claude/hooks.json"), "utf8"))

	expect(codex).toEqual({
		hooks: {
			SessionStart: [
				{
					matcher: "startup|resume|compact",
					hooks: [{ type: "command", command: '"${PLUGIN_ROOT}/hooks/recover-context"' }],
				},
			],
		},
	})
	expect(claude).toEqual({
		hooks: {
			SessionStart: [
				{
					matcher: "startup|resume|compact",
					hooks: [{ type: "command", command: '"${CLAUDE_PLUGIN_ROOT}/hooks/recover-context"' }],
				},
			],
		},
	})
})

test("the checkpoint writer atomically creates private state accepted by the hook", () => {
	const current = fixture({ writeCheckpoint: false })
	const result = run(
		checkpointCommand,
		current.vault,
		JSON.stringify(current.checkpoint),
		environment(current),
		["write"],
	)

	expect(result.exitCode).toBe(0)
	const envelope = machineEnvelope(result, "write", "success")
	expect(envelope).toMatchObject({
		transactionState: "committed",
		data: {
			code: "CHECKPOINT_WRITTEN",
			checkpointPath: current.checkpointPath,
			sessionIdentity,
			taskIdentity,
		},
	})
	expect(statSync(dirname(current.checkpointPath)).mode & 0o777).toBe(0o700)
	expect(statSync(current.checkpointPath).mode & 0o777).toBe(0o600)
	expect(JSON.parse(readFileSync(current.checkpointPath, "utf8"))).toEqual(current.checkpoint)
	expect(runHook(current).stdout).not.toBe("")
})

test("an invalid checkpoint write reports no change and creates no checkpoint", () => {
	const current = fixture({ writeCheckpoint: false })
	const invalid = { ...current.checkpoint, taskIdentity: "wrong-task-identity" }

	const result = run(
		checkpointCommand,
		current.vault,
		JSON.stringify(invalid),
		environment(current),
		["write"],
	)

	expect(result.exitCode).toBe(1)
	const envelope = machineEnvelope(result, "write", "error")
	expect(envelope).toMatchObject({
		transactionState: "not-started",
		error: {
			code: "INVALID_CHECKPOINT",
			action: "CORRECT_INPUT",
			errorFamily: "validation",
			repairAction:
				"Run recovery-checkpoint schema, correct the checkpoint input, then run recovery-checkpoint write again.",
			safeToRetrySameInput: false,
		},
	})
	expect(existsSync(current.checkpointPath)).toBe(false)
})

test("a non-executable Agent Ledger route is rejected before checkpoint state changes", () => {
	const current = fixture({ writeCheckpoint: false })
	chmodSync(current.agentLedger, 0o600)

	const result = run(
		checkpointCommand,
		current.vault,
		JSON.stringify(current.checkpoint),
		environment(current),
		["write"],
	)

	expect(result.exitCode).toBe(1)
	const envelope = machineEnvelope(result, "write", "error")
	expect(envelope).toMatchObject({
		transactionState: "not-started",
		error: {
			code: "INVALID_CHECKPOINT",
			action: "CORRECT_INPUT",
			errorFamily: "validation",
			safeToRetrySameInput: false,
		},
	})
	expect(existsSync(current.checkpointPath)).toBe(false)
})

test("a filesystem refusal reports a retryable not-started write failure", () => {
	const current = fixture({ writeCheckpoint: false })
	chmodSync(current.state, 0o500)
	const result = run(
		checkpointCommand,
		current.vault,
		JSON.stringify(current.checkpoint),
		environment(current),
		["write"],
	)
	chmodSync(current.state, 0o700)

	expect(result.exitCode).toBe(1)
	const envelope = machineEnvelope(result, "write", "error")
	expect(envelope).toMatchObject({
		transactionState: "not-started",
		error: {
			code: "CHECKPOINT_WRITE_FAILED",
			action: "REPAIR_STATE_PATH",
			errorFamily: "filesystem",
			repairAction: "Repair the private checkpoint state path, then retry the same write input.",
			safeToRetrySameInput: true,
		},
	})
	expect(existsSync(current.checkpointPath)).toBe(false)
})


test("bind derives identity from the goal and recover returns the same session panel without writes", () => {
 const current = fixture({ writeCheckpoint: false })
 const env = { ...environment(current), CODEX_SESSION_ID: sessionIdentity }
 const binding = run(checkpointCommand, current.vault, "", env, ["bind", "projects/ledger-workflow/GOAL.md", "--agent-ledger", current.agentLedger])
 expect(binding.exitCode).toBe(0)
 expect(binding.stderr).toBe("")
 expect(JSON.parse(binding.stdout)).toMatchObject({operation:"bind", transactionState:"committed", data:{taskIdentity,sessionIdentity}})
 const saved = JSON.parse(readFileSync(current.checkpointPath,"utf8"))
 expect(saved).toMatchObject({taskIdentity,registerPath:current.register,sessionIdentity,goalPath:"projects/ledger-workflow/GOAL.md"})
 expect(statSync(current.checkpointPath).mode & 0o777).toBe(0o600)
	const before = observePrimaryTree(current.root)
 const recovered = run(checkpointCommand, current.vault, "", env, ["recover"])
 expect(recovered.exitCode).toBe(0)
 expect(recovered.stderr).toBe("")
 expect(JSON.parse(recovered.stdout)).toMatchObject({operation:"recover", transactionState:"not-applicable", data:{taskIdentity,sessionIdentity}})
 expect(JSON.parse(recovered.stdout).data.controlPanel).toContain(`Task identity: ${taskIdentity}`)
	expect(JSON.parse(recovered.stdout).data.controlPanel).toContain(
		`Read live Task lifecycle (public Agent Ledger status projection; accepted Task appears in activeTasks while active): ${shellCommand(current.agentLedger, "register", "status", "--db", current.register)}`,
	)
	expect(observePrimaryTree(current.root)).toEqual(before)
 expect(runHook(current).stdout).toContain(taskIdentity)
})

test("bind accepts evidence anywhere under the project subtree and renders it", () => {
	const current = fixture({ writeCheckpoint: false })
	const evidencePath = "projects/ledger-workflow/proofs/proof.md"
	write(join(current.vault, evidencePath), "# Proof\n")
	const env = { ...environment(current), CODEX_SESSION_ID: sessionIdentity }
	const binding = run(checkpointCommand, current.vault, "", env, [
		"bind",
		"projects/ledger-workflow/GOAL.md",
		"--agent-ledger",
		current.agentLedger,
		"--evidence",
		evidencePath,
	])
	expect(binding.exitCode).toBe(0)
	expect(machineEnvelope(binding, "bind", "success")).toMatchObject({
		transactionState: "committed",
	})
	const saved = JSON.parse(readFileSync(current.checkpointPath, "utf8"))
	expect(saved.evidencePath).toBe(evidencePath)
	const expectedEvidenceLine = `Read evidence owner: ${shellCommand("/bin/cat", join(current.vault, evidencePath))}`
	const recovered = run(checkpointCommand, current.vault, "", env, ["recover"])
	expect(recovered.exitCode).toBe(0)
	machineEnvelope(recovered, "recover", "success")
	expect(JSON.parse(recovered.stdout).data.controlPanel).toContain(expectedEvidenceLine)
	const hook = runHook(current)
	expect(hook.exitCode).toBe(0)
	expect(hook.stderr).toBe("")
	const hookOutput = JSON.parse(hook.stdout) as {
		hookSpecificOutput: { additionalContext: string }
	}
	expect(hookOutput.hookSpecificOutput.additionalContext).toContain(expectedEvidenceLine)
})

test("bind defaults evidence to the project README", () => {
	const current = fixture({ writeCheckpoint: false })
	rmSync(join(current.vault, "projects/ledger-workflow/proof.md"))
	const env = { ...environment(current), CODEX_SESSION_ID: sessionIdentity }
	const binding = run(checkpointCommand, current.vault, "", env, [
		"bind",
		"projects/ledger-workflow/GOAL.md",
		"--agent-ledger",
		current.agentLedger,
	])
	expect(binding.exitCode).toBe(0)
	expect(machineEnvelope(binding, "bind", "success")).toMatchObject({
		transactionState: "committed",
	})
	const evidencePath = "projects/ledger-workflow/README.md"
	const saved = JSON.parse(readFileSync(current.checkpointPath, "utf8"))
	expect(saved.evidencePath).toBe(evidencePath)
	const recovered = run(checkpointCommand, current.vault, "", env, ["recover"])
	expect(recovered.exitCode).toBe(0)
	machineEnvelope(recovered, "recover", "success")
	expect(JSON.parse(recovered.stdout).data.controlPanel).toContain(
		`Read evidence owner: ${shellCommand("/bin/cat", join(current.vault, evidencePath))}`,
	)
})

test("evidence outside the bound project stays refused", () => {
	const current = fixture()
	const otherEvidencePath = "projects/other-project/README.md"
	write(join(current.vault, otherEvidencePath), "# Other project\n")

	replaceCheckpoint(current, { evidencePath: otherEvidencePath })
	const outsideProjectBefore = observePrimaryTree(current.root)
	expect(runHook(current).stdout).toBe("")
	expect(observePrimaryTree(current.root)).toEqual(outsideProjectBefore)

	replaceCheckpoint(current, { evidencePath: "README.md" })
	const vaultRootBefore = observePrimaryTree(current.root)
	expect(runHook(current).stdout).toBe("")
	expect(observePrimaryTree(current.root)).toEqual(vaultRootBefore)

	const escapePath = join(current.vault, "projects/ledger-workflow/proofs/escape.md")
	mkdirSync(dirname(escapePath), { recursive: true })
	symlinkSync(join(current.vault, otherEvidencePath), escapePath)
	replaceCheckpoint(current, { evidencePath: "projects/ledger-workflow/proofs/escape.md" })
	const escapingSymlinkBefore = observePrimaryTree(current.root)
	expect(runHook(current).stdout).toBe("")
	expect(observePrimaryTree(current.root)).toEqual(escapingSymlinkBefore)

	const unbound = fixture({ writeCheckpoint: false })
	write(join(unbound.vault, otherEvidencePath), "# Other project\n")
	const binding = run(
		checkpointCommand,
		unbound.vault,
		"",
		{ ...environment(unbound), CODEX_SESSION_ID: sessionIdentity },
		[
			"bind",
			"projects/ledger-workflow/GOAL.md",
			"--agent-ledger",
			unbound.agentLedger,
			"--evidence",
			otherEvidencePath,
		],
	)
	expect(binding.exitCode).toBe(1)
	expect(machineEnvelope(binding, "bind", "error")).toMatchObject({
		transactionState: "not-started",
		error: {
			code: "INVALID_CHECKPOINT",
			action: "CORRECT_INPUT",
			errorFamily: "validation",
			safeToRetrySameInput: false,
		},
	})
	expect(existsSync(unbound.checkpointPath)).toBe(false)
})

test("bind and recovery recognize a committed WAL Task without changing Register data", () => {
	const current = fixture({ writeCheckpoint: false })
	const env = { ...environment(current), CODEX_SESSION_ID: sessionIdentity }
	const register = new Database(current.register)
	try {
		register.exec("DELETE FROM register_events")
		register.exec("PRAGMA journal_mode = WAL")
		const databaseBefore = readFileSync(current.register)
		register.exec("BEGIN IMMEDIATE")
		register
			.query("INSERT INTO register_events VALUES (1, ?, 'task', ?, 'task-accepted')")
			.run("register-event-wal", taskIdentity)
		register.exec("COMMIT")
		const walBefore = readFileSync(`${current.register}-wal`)
		expect(walBefore.length).toBeGreaterThan(0)
		expect(readFileSync(current.register)).toEqual(databaseBefore)
		const accepted = run("/usr/bin/sqlite3", current.vault, "", env, [
			"-readonly",
			current.register,
			"SELECT entity_identity FROM register_events WHERE stream = 'task' AND kind = 'task-accepted';",
		])
		expect(accepted).toEqual({ exitCode: 0, stdout: "prove-recovery-task-2f52a7a1\n", stderr: "" })

		const binding = run(checkpointCommand, current.vault, "", env, [
			"bind", "projects/ledger-workflow/GOAL.md", "--agent-ledger", current.agentLedger,
		])
		expect(machineEnvelope(binding, "bind", "success")).toMatchObject({
			transactionState: "committed",
			data: { taskIdentity, sessionIdentity },
		})
		expect(binding.exitCode).toBe(0)
		expect(JSON.parse(readFileSync(current.checkpointPath, "utf8"))).toMatchObject({
			taskIdentity, sessionIdentity, registerPath: current.register,
		})
		const checkpointBefore = readFileSync(current.checkpointPath)
		const recovered = run(checkpointCommand, current.vault, "", env, ["recover"])
		expect(machineEnvelope(recovered, "recover", "success")).toMatchObject({
			transactionState: "not-applicable",
			data: { taskIdentity, sessionIdentity },
		})
		expect(recovered.exitCode).toBe(0)
		const hook = runHook(current)
		expect(hook.exitCode).toBe(0)
		expect(hook.stderr).toBe("")
		expect(hook.stdout).toContain(`Task identity: ${taskIdentity}`)
		expect(readFileSync(current.checkpointPath)).toEqual(checkpointBefore)
		expect(readFileSync(current.register)).toEqual(databaseBefore)
		expect(readFileSync(`${current.register}-wal`)).toEqual(walBefore)
	} finally {
		register.close()
	}
})

test("bind rejects ambiguous goal identity and conflicting session without changing the checkpoint", () => {
 const current = fixture()
 const env = { ...environment(current), CODEX_SESSION_ID: sessionIdentity }
 const args = ["bind", "projects/ledger-workflow/GOAL.md", "--agent-ledger",current.agentLedger]
 const before = readFileSync(current.checkpointPath,"utf8")
 const conflict = run(checkpointCommand,current.vault,"",env,[...args,"--session","someone-else"])
 expect(conflict.exitCode).toBe(1)
 expect(JSON.parse(conflict.stdout).transactionState).toBe("not-started")
 const goal = join(current.vault,"projects/ledger-workflow/GOAL.md")
 writeFileSync(goal, readFileSync(goal,"utf8") + "\n- Task: `another-task`.\n")
 const ambiguous = run(checkpointCommand,current.vault,"",env,args)
 expect(ambiguous.exitCode).toBe(1)
 expect(readFileSync(current.checkpointPath,"utf8")).toBe(before)
})

test("recover refuses missing session and never borrows another checkpoint", () => {
 const current = fixture()
 for (const identity of ["", "missing-session"]) {
  const result = run(checkpointCommand,current.vault,"",{...environment(current),CODEX_SESSION_ID:identity},["recover"])
  expect(result.exitCode).toBe(1)
  expect(JSON.parse(result.stdout)).toMatchObject({operation:"recover",status:"error",transactionState:"not-started"})
  expect(result.stdout).not.toContain(taskIdentity)
 }
})

test("bind preserves another accepted Task behind an inherited session identity", () => {
	const current = fixture()
	const otherTask = "other-accepted-task-7c923cab"
	const register = new Database(current.register)
	register.query("INSERT INTO register_events VALUES (2, ?, 'task', ?, 'task-accepted')")
		.run("register-event-other", otherTask)
	register.close()
	const otherGoalPath = "projects/other-work/GOAL.md"
	write(join(current.vault, "projects/other-work/README.md"), "# Other work\n")
	write(join(current.vault, "projects/other-work/proof.md"), "# Other evidence\n")
	write(join(current.vault, otherGoalPath), readFileSync(
		join(current.vault, "projects/ledger-workflow/GOAL.md"), "utf8").replace(taskIdentity, otherTask))
	const before = readFileSync(current.checkpointPath)
	const result = run(checkpointCommand, current.vault, "", {
		...environment(current), CODEX_SESSION_ID: sessionIdentity,
	}, ["bind", otherGoalPath, "--agent-ledger", current.agentLedger])
	expect(result.exitCode).toBe(1)
	expect(machineEnvelope(result, "bind", "error")).toMatchObject({
		transactionState: "not-started",
		error: { code: "CHECKPOINT_OWNERSHIP_CONFLICT", safeToRetrySameInput: false },
	})
	expect(readFileSync(current.checkpointPath)).toEqual(before)
	const deliberate = run(checkpointCommand, current.vault,
		JSON.stringify({ ...current.checkpoint, taskIdentity: otherTask,
			projectMap: "projects/other-work/README.md", goalPath: otherGoalPath,
			evidencePath: "projects/other-work/proof.md" }),
		environment(current), ["write"])
	expect(deliberate.exitCode).toBe(0)
	expect(machineEnvelope(deliberate, "write", "success").transactionState).toBe("committed")
	expect(JSON.parse(readFileSync(current.checkpointPath, "utf8")).taskIdentity).toBe(otherTask)
})

test("bind preserves malformed existing ownership instead of replacing it", () => {
	const current = fixture()
	writeFileSync(current.checkpointPath, "{unreadable-owner")
	const before = readFileSync(current.checkpointPath)
	const result = run(checkpointCommand, current.vault, "", {
		...environment(current), CODEX_SESSION_ID: sessionIdentity,
	}, ["bind", "projects/ledger-workflow/GOAL.md", "--agent-ledger", current.agentLedger])
	expect(result.exitCode).toBe(1)
	expect(machineEnvelope(result, "bind", "error")).toMatchObject({
		transactionState: "not-started",
		error: { code: "CHECKPOINT_OWNERSHIP_CONFLICT", safeToRetrySameInput: false },
	})
	expect(readFileSync(current.checkpointPath)).toEqual(before)
})

test("checkpoint writers refuse a held session lock without changing its owner", async () => {
	const current = fixture()
	const before = readFileSync(current.checkpointPath)
	const lockPath = current.checkpointPath.replace(/\.json$/, ".lock")
	const holder = Bun.spawn(["/usr/bin/python3", "-c", [
		"import fcntl, os, sys",
		"fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)",
		"fcntl.flock(fd, fcntl.LOCK_EX)",
		"print('locked', flush=True)",
		"sys.stdin.read(1)",
		"os.close(fd)",
	].join("\n"), lockPath], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
	try {
		const ready = await holder.stdout.getReader().read()
		expect(new TextDecoder().decode(ready.value)).toBe("locked\n")
		for (const operation of ["bind", "write"]) {
			const result = run(checkpointCommand, current.vault, JSON.stringify(current.checkpoint),
				{ ...environment(current), CODEX_SESSION_ID: sessionIdentity },
				operation === "bind" ? ["bind", "projects/ledger-workflow/GOAL.md", "--agent-ledger", current.agentLedger] : ["write"])
			expect(result.exitCode).toBe(1)
			expect(machineEnvelope(result, operation, "error")).toMatchObject({
				transactionState: "not-started",
				error: { code: "CHECKPOINT_BUSY", safeToRetrySameInput: operation === "bind" },
			})
			expect(readFileSync(current.checkpointPath)).toEqual(before)
		}
		const busy = lifecycleRecords(current).filter((record) => record.phase === "lock" && record.outcome === "busy")
		expect(new Set(busy.map((record) => record.operation))).toEqual(new Set(["bind", "write"]))
		expect(busy.every((record) => record.inherited_parent_identity === sessionIdentity)).toBe(true)
	} finally {
		holder.stdin.write("x")
		holder.stdin.end()
		await holder.exited
	}
})

test("bind refreshes the same accepted work owner", () => {
	const current = fixture()
	const beforeRegister = readFileSync(current.register)
	const result = run(checkpointCommand, current.vault, "", {
		...environment(current), CODEX_SESSION_ID: sessionIdentity,
	}, ["bind", "projects/ledger-workflow/GOAL.md", "--agent-ledger", current.agentLedger])
	expect(result.exitCode).toBe(0)
	expect(machineEnvelope(result, "bind", "success")).toMatchObject({
		transactionState: "committed", data: { taskIdentity, sessionIdentity },
	})
	expect(JSON.parse(readFileSync(current.checkpointPath, "utf8"))).toMatchObject({
		taskIdentity, sessionIdentity, registerPath: current.register, programIdentity,
	})
	expect(readFileSync(current.register)).toEqual(beforeRegister)
	expect(runHook(current).stdout).toContain(taskIdentity)
})

test("observer timing correlation rejects wrong phase values and ambiguous association", () => {
	const current = fixture()
	const traceRoot = join(current.state, "my-second-brain-playground", "recovery-traces")
	const before = observerTraceFileNames(current)
	const record = (
		phase: "invocation" | "response-available" | "terminal",
		duration: number,
		sequence: number,
	): Record<string, unknown> => ({
		schema_version: 1,
		record_type: "lifecycle",
		record_identity: `observer-1-${sequence}`,
		journey_identity: "invocation-1",
		invocation_identity: "invocation-1",
		producer_identity: "recovery-observer-1",
		producer_sequence: sequence,
		...(sequence === 0 ? {} : { parent_record_identity: "observer-1-0" }),
		harness_kind: "unknown",
		operation: "recover",
		phase,
		occurred_at: `2026-09-14T00:00:0${sequence}.000Z`,
		duration_ms: duration,
		outcome: sequence === 0 ? "started" : "succeeded",
	})
	write(join(traceRoot, "first.jsonl"), [
		record("invocation", 1, 0),
		record("response-available", 3, 1),
		record("terminal", 2, 2),
	].map((value) => JSON.stringify(value)).join("\n") + "\n", 0o600)
	expect(() => observerPhaseTiming(current, before)).toThrow("invalid phase values or association")
	write(join(traceRoot, "second.jsonl"), [
		record("invocation", 1, 0),
		record("response-available", 2, 1),
		record("terminal", 3, 2),
	].map((value) => JSON.stringify(value)).join("\n") + "\n", 0o600)
	expect(() => observerPhaseTiming(current, before)).toThrow("expected 1 new trace, received 2")
})

test("paired cold processes keep capture-enabled and unavailable primary-response p95 within 100 ms", async () => {
	const sampleCount = 20
	const disabled = fixture()
	const enabled = fixture()
	const unavailable = fixture()
	const unavailableEnvironment = {
		...withUnavailableCapture(unavailable),
		CODEX_SESSION_ID: sessionIdentity,
	}
	const rows = {
		disabled: [] as TimedProcessResult[],
		enabled: [] as TimedProcessResult[],
		unavailable: [] as TimedProcessResult[],
	}
	const observerPhases: ObserverPhaseTiming[] = []
	const runSample = async (mode: keyof typeof rows): Promise<void> => {
		const current = { disabled, enabled, unavailable }[mode]
		const observerTracesBefore = mode === "enabled" ? observerTraceFileNames(current) : undefined
		const env = mode === "disabled"
			? { ...withoutCapture(current), CODEX_SESSION_ID: sessionIdentity }
			: mode === "unavailable"
				? unavailableEnvironment
				: { ...environment(current), CODEX_SESSION_ID: sessionIdentity }
		const result = await runTimed(checkpointCommand, current.vault, "", env, ["recover"])
		expect(result.exitCode).toBe(0)
		expect(result.stderr).toBe("")
		expect(result.firstStdoutByteMs).not.toBeNull()
		expect(JSON.parse(result.stdout)).toMatchObject({
			operation: "recover",
			status: "success",
			data: { taskIdentity, sessionIdentity },
		})
		rows[mode].push(result)
		if (observerTracesBefore !== undefined) observerPhases.push(observerPhaseTiming(current, observerTracesBefore))
	}

	for (let index = 0; index < sampleCount; index += 1) {
		const order: Array<keyof typeof rows> = index % 2 === 0
			? ["disabled", "enabled", "unavailable"]
			: ["unavailable", "enabled", "disabled"]
		for (const mode of order) await runSample(mode)
	}

	const p95 = Object.fromEntries(
		Object.entries(rows).map(([mode, samples]) => [
			mode,
			{
				first_stdout_byte_ms: percentile95(samples.map((sample) => sample.firstStdoutByteMs ?? Number.NaN)),
				stdout_eof_ms: percentile95(samples.map((sample) => sample.stdoutEofMs)),
				exit_ms: percentile95(samples.map((sample) => sample.exitMs)),
			},
		]),
	) as Record<keyof typeof rows, { first_stdout_byte_ms: number; stdout_eof_ms: number; exit_ms: number }>
	const enabledDelta = p95.enabled.stdout_eof_ms - p95.disabled.stdout_eof_ms
	const unavailableDelta = p95.unavailable.stdout_eof_ms - p95.disabled.stdout_eof_ms
	const pairedDeltaP95 = {
		enabled: percentile95(pairedStdoutEofDeltas(rows.enabled, rows.disabled)),
		unavailable: percentile95(pairedStdoutEofDeltas(rows.unavailable, rows.disabled)),
	}
	const pluginRoot = resolve(import.meta.dir, "../../..")
	const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex")
	const plugin = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8")) as { version: string }
	// The accepted qualification contract is paired p95 overhead. Independent
	// per-mode p95 values remain diagnostic so CI failures expose both statistics.
	const observerPhaseP95 = {
		observer_open_ms: percentile95(observerPhases.map((phase) => phase.observerOpenMs)),
		response_available_ms: percentile95(observerPhases.map((phase) => phase.responseAvailableMs)),
		terminal_ms: percentile95(observerPhases.map((phase) => phase.terminalMs)),
		estimated_shell_bun_import_ms: percentile95(observerPhases.map((phase, index) => (
			(rows.enabled.at(index)?.firstStdoutByteMs ?? Number.NaN) - phase.responseAvailableMs
		))),
	}
	const sampleMeasurements = Object.fromEntries(
		Object.entries(rows).map(([mode, samples]) => [
			mode,
			samples.map((sample, index) => {
				const phase = mode === "enabled" ? observerPhases.at(index) : undefined
				return {
					first_stdout_byte_ms: sample.firstStdoutByteMs,
					stdout_eof_ms: sample.stdoutEofMs,
					exit_ms: sample.exitMs,
					post_stdout_eof_until_exit_ms: sample.exitMs - sample.stdoutEofMs,
					...(phase === undefined ? {} : {
						observer_open_ms: phase.observerOpenMs,
						observer_response_available_ms: phase.responseAvailableMs,
						observer_terminal_ms: phase.terminalMs,
						estimated_shell_bun_import_ms: (sample.firstStdoutByteMs ?? Number.NaN) - phase.responseAvailableMs,
					}),
				}
			}),
		]),
	)
	console.log(JSON.stringify({
		recovery_observability_qualification: {
			sample_count_per_mode: sampleCount,
			mode_order: "even: disabled,enabled,unavailable; odd: unavailable,enabled,disabled",
			primary_response_measure: "process launch to complete stdout EOF",
			p95_ms: p95,
			delta_p95_ms: { enabled: enabledDelta, unavailable: unavailableDelta },
			paired_delta_p95_ms: pairedDeltaP95,
			observer_phase_p95_ms: observerPhaseP95,
			observer_phase_invocation_identities: observerPhases.map((phase) => phase.invocationIdentity),
			paired_stdout_eof_delta_samples_ms: {
				enabled: pairedStdoutEofDeltas(rows.enabled, rows.disabled),
				unavailable: pairedStdoutEofDeltas(rows.unavailable, rows.disabled),
			},
			samples_ms: sampleMeasurements,
			machine: {
				platform: process.platform,
				architecture: process.arch,
				bun: Bun.version,
				ci: process.env.CI === "true",
				runner_os: process.env.RUNNER_OS ?? null,
				runner_architecture: process.env.RUNNER_ARCH ?? null,
				image_os: process.env.ImageOS ?? null,
			},
			plugin_version: plugin.version,
			source_sha256: sha256(recoveryEngine),
			observer_source_sha256: sha256(resolve(import.meta.dir, "../../recovery-observability/src/recovery-observer.ts")),
			runtime_sha256: sha256(join(pluginRoot, "runtime/recovery-observer.js")),
			coverage: ["disabled", "enabled", "unavailable"],
			unknowns: ["native-compaction: no native trigger exercised", "installed-harness-trust: fixture processes only", "observer-owned-deadline: covered by a separate process test, not this timing run"],
		},
	}))

	expect(observerPhases).toHaveLength(sampleCount)
	expect(pairedDeltaP95.enabled).toBeLessThanOrEqual(100)
	expect(pairedDeltaP95.unavailable).toBeLessThanOrEqual(100)
}, 30_000)
