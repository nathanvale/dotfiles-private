import { afterEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { analyzeLifecycleObservation, type LifecycleObservation } from "../../../cli-design-check/src/successor/lifecycle-observation.ts"
import { createRoot, journalRecords, MAIN, readState, removeRoot, REVISION_5_RESOURCE, type Root } from "../helpers/harness.ts"

const PRELOAD = resolve(import.meta.dir, "../helpers/process-lifecycle-preload.ts")
const roots: Root[] = []
const children: ReturnType<typeof Bun.spawn>[] = []
const groupChildren: ChildProcessWithoutNullStreams[] = []
const groupClosed = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>()
const fresh = (variant: Parameters<typeof createRoot>[0] = "healthy"): Root => { const root = createRoot(variant); roots.push(root); return root }
afterEach(async () => {
	for (const child of children.splice(0)) { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited }
	for (const child of groupChildren.splice(0)) {
		if (child.exitCode === null && child.pid !== undefined) { try { process.kill(-child.pid, "SIGKILL") } catch {} }
		await groupClosed.get(child)
	}
	for (const root of roots.splice(0)) removeRoot(root)
})

function start(root: Root, args: string[], options: { mode?: string; stdin?: "ignore" | "pipe"; preload?: string; env?: Record<string, string> } = {}) {
	const preload = options.preload ?? (options.mode === undefined ? undefined : PRELOAD)
	const command = preload === undefined ? [process.execPath, MAIN] : [process.execPath, "--preload", preload, MAIN]
	const env = { PATH: process.env.PATH ?? "", HOME: root.privateRoot, XDG_STATE_HOME: join(root.privateRoot, "state"), NO_COLOR: "1", TERM: "dumb", O3_CONTROL: root.privateRoot, ...(options.mode === undefined ? {} : { O3_MODE: options.mode }), ...(options.env ?? {}) }
	const child = Bun.spawn([...command, ...args], { cwd: root.root, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
	if (options.stdin !== "pipe") child.stdin.end()
	children.push(child)
	return child
}

function startGroup(root: Root, args: string[], mode: string): ChildProcessWithoutNullStreams {
	const command = [process.execPath, "--preload", PRELOAD, MAIN]
	const env = { PATH: process.env.PATH ?? "", HOME: root.privateRoot, XDG_STATE_HOME: join(root.privateRoot, "state"), NO_COLOR: "1", TERM: "dumb", O3_CONTROL: root.privateRoot, O3_MODE: mode }
	const child = spawn(command[0] as string, [...command.slice(1), ...args], { cwd: root.root, env, stdio: ["pipe", "pipe", "pipe"], detached: true })
	groupClosed.set(child, new Promise<void>((resolve) => { child.once("close", () => resolve()) }))
	child.stdin.end()
	groupChildren.push(child)
	return child
}

function groupSignal(child: ChildProcessWithoutNullStreams, signal: "SIGINT" | "SIGTERM"): void {
	if (child.pid === undefined) throw new Error("detached child has no process-group identity")
	process.kill(-child.pid, signal)
}

function captureGroup(child: ChildProcessWithoutNullStreams, collectStdout = true): Promise<{ stdout: string; stderr: string; exit: number; signal: string | null; pid: number }> {
	const stdout: Buffer[] = []
	const stderr: Buffer[] = []
	if (collectStdout) child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
	child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
	return new Promise((resolve, reject) => {
		child.once("error", reject)
		child.once("close", (code, signal) => resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exit: code ?? 0, signal, pid: child.pid ?? 0 }))
	})
}

async function waitFor(path: string): Promise<void> {
	const deadline = performance.now() + 2_000
	while (!existsSync(path)) {
		if (performance.now() >= deadline) throw new Error(`process did not reach ${path}`)
		await Bun.sleep(2)
	}
}

async function result(child: ReturnType<typeof start>): Promise<{ stdout: string; stderr: string; exit: number; signal: string | null }> {
	const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
	return { stdout, stderr, exit, signal: child.signalCode }
}

async function boundedResult(child: ReturnType<typeof start>, timeoutMs: number): Promise<{ stdout: string; stderr: string; exit: number; signal: string | null; blocked: boolean }> {
	let blocked = false
	const timer = setTimeout(() => { blocked = true; child.kill("SIGKILL") }, timeoutMs)
	try {
		const observed = await result(child)
		return { ...observed, blocked }
	} finally {
		clearTimeout(timer)
	}
}

function prompted(stdout: string, stderr: string): boolean {
	if (stderr !== "") return true
	const lines = stdout.split("\n").filter((line) => line.length > 0)
	if (lines.length !== 1) return true
	try { JSON.parse(lines[0] as string); return false } catch { return true }
}

function stdinReadCount(root: Root): number {
	const count = Number(readFileSync(join(root.privateRoot, "stdin-read-count"), "utf8").trim())
	if (!Number.isSafeInteger(count) || count < 0) throw new Error("stdin observation receipt is invalid")
	return count
}

function diagnostics(root: Root): string {
	const directory = join(root.privateRoot, "state", "repair-lab", "diagnostics")
	return existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith(".jsonl")).map((name) => readFileSync(join(directory, name), "utf8")).join("") : ""
}

function envelopeCount(stdout: string): number {
	return stdout.split("\n").filter((line) => {
		if (line.length === 0) return false
		try { JSON.parse(line); return true } catch { return false }
	}).length
}

type DeadlineEffectState = "unchanged" | "completed" | "partially-completed" | "unknown"

interface DeadlineCase {
	mode: "deadline-before-start" | "deadline-unchanged" | "deadline-completed" | "deadline-partial" | "deadline-unknown"
	phase: "before-dispatch" | "after-dispatch"
	state: DeadlineEffectState
	causeCode: "DOMAIN_DEADLINE_BEFORE_START" | "DOMAIN_DEADLINE_UNCHANGED" | "DOMAIN_DEADLINE_COMPLETED" | "DOMAIN_DEADLINE_PARTIAL" | "DOMAIN_DEADLINE_UNKNOWN"
	outcome: "refused" | "failed"
	fault?: "effect.write-journal-outcome-unknown"
}

const DEADLINE_CASES: readonly DeadlineCase[] = [
	{ mode: "deadline-before-start", phase: "before-dispatch", state: "unchanged", causeCode: "DOMAIN_DEADLINE_BEFORE_START", outcome: "refused" },
	{ mode: "deadline-unchanged", phase: "after-dispatch", state: "unchanged", causeCode: "DOMAIN_DEADLINE_UNCHANGED", outcome: "failed" },
	{ mode: "deadline-completed", phase: "after-dispatch", state: "completed", causeCode: "DOMAIN_DEADLINE_COMPLETED", outcome: "failed" },
	{ mode: "deadline-partial", phase: "after-dispatch", state: "partially-completed", causeCode: "DOMAIN_DEADLINE_PARTIAL", outcome: "failed" },
	{ mode: "deadline-unknown", phase: "after-dispatch", state: "unknown", causeCode: "DOMAIN_DEADLINE_UNKNOWN", outcome: "failed", fault: "effect.write-journal-outcome-unknown" },
]

function machineResult(stdout: string): Record<string, unknown> {
	const envelope = JSON.parse(stdout) as { result?: unknown }
	if (typeof envelope.result !== "object" || envelope.result === null || Array.isArray(envelope.result)) throw new Error("expected one machine envelope result")
	return envelope.result as Record<string, unknown>
}

function expectedEffects(state: DeadlineEffectState): Record<string, unknown> {
	switch (state) {
		case "unchanged": return { completed: [], remaining: ["effect.update-index", "effect.write-journal"], uncertain: [], inventoryComplete: true }
		case "completed": return { completed: ["effect.update-index", "effect.write-journal"], remaining: [], uncertain: [], inventoryComplete: true }
		case "partially-completed": return { completed: ["effect.update-index"], remaining: ["effect.write-journal"], uncertain: [], inventoryComplete: true }
		case "unknown": return { completed: ["effect.update-index"], remaining: [], uncertain: ["effect.write-journal"], inventoryComplete: true }
	}
}

const COMPLETED_JOURNAL = [["intent", "effect.update-index"], ["completed", "effect.update-index"], ["intent", "effect.write-journal"], ["event", "effect.write-journal"], ["completed", "effect.write-journal"]]
const PARTIAL_JOURNAL = [["intent", "effect.update-index"], ["completed", "effect.update-index"]]
const UNKNOWN_JOURNAL = [["intent", "effect.update-index"], ["completed", "effect.update-index"], ["intent", "effect.write-journal"]]

function journalSignature(root: Root): string[][] {
	return journalRecords(root).map((record) => [String(record.kind), String(record.effect)])
}

function observedDeadlineEffectState(root: Root, before: ReturnType<typeof readState>): DeadlineEffectState {
	const observed = readState(root)
	const signature = journalSignature(root)
	if (JSON.stringify(observed) === JSON.stringify(before)) {
		expect(observed).toEqual(before)
		return "unchanged"
	}
	if (observed.resource === REVISION_5_RESOURCE && JSON.stringify(signature) === JSON.stringify(COMPLETED_JOURNAL)) {
		expect(observed.resource).toBe(REVISION_5_RESOURCE)
		expect(signature).toEqual(COMPLETED_JOURNAL)
		return "completed"
	}
	if (observed.resource === REVISION_5_RESOURCE && JSON.stringify(signature) === JSON.stringify(PARTIAL_JOURNAL)) {
		expect(observed.resource).toBe(REVISION_5_RESOURCE)
		expect(signature).toEqual(PARTIAL_JOURNAL)
		return "partially-completed"
	}
	if (observed.resource === REVISION_5_RESOURCE && JSON.stringify(signature) === JSON.stringify(UNKNOWN_JOURNAL)) {
		expect(observed.resource).toBe(REVISION_5_RESOURCE)
		expect(signature).toEqual(UNKNOWN_JOURNAL)
		return "unknown"
	}
	throw new Error(`unexpected deadline resource/journal state: ${JSON.stringify(observed)}`)
}

describe("O3 public process lifecycle", () => {
	test.each([...DEADLINE_CASES])("deadline $mode reports $state from the real process", async (scenario) => {
		const root = fresh("healthy-with-fresh-preview")
		const before = readState(root)
		const child = start(root, ["apply", "--preview-id", "preview-healthy-revision-4", "--authorize", "fixture-authority", "--deadline-ms", "1", "--json"], { mode: scenario.mode, env: scenario.fault === undefined ? {} : { REPAIR_LAB_FAULT: scenario.fault } })
		const observed = await result(child)
		const payload = machineResult(observed.stdout)
		const dispatchStarted = existsSync(join(root.privateRoot, "deadline-dispatch"))
		expect(observed.exit).toBe(3)
		expect(observed.stderr).toBe("")
		expect(payload).toMatchObject({
			commandIdentity: "repair-lab.apply",
			outcome: scenario.outcome,
			transactionState: scenario.state,
			causeCode: scenario.causeCode,
			failureClass: "domain",
			exitCode: 3,
			retryable: false,
			effects: expectedEffects(scenario.state),
		})
		const observedEffectState = observedDeadlineEffectState(root, before)
		expect(observedEffectState).toBe(scenario.state)
		const lifecycle: LifecycleObservation = {
			claim: "deadline",
			stdout: observed.stdout,
			stderr: observed.stderr,
			envelopeCount: 1,
			drainConfirmed: true,
			phase: scenario.phase,
			observedEffectState,
			reportedEffectState: payload.transactionState as DeadlineEffectState,
			exitCode: observed.exit,
			outcome: payload.outcome as "refused" | "failed",
			causeCode: String(payload.causeCode),
			retryable: payload.retryable === true,
			dispatchStarted,
		}
		expect(analyzeLifecycleObservation(lifecycle)).toEqual([])
	})

	test("invalid and undeclared --deadline-ms refuse before state effects", async () => {
		for (const args of [
			["apply", "--preview-id", "preview-healthy-revision-4", "--authorize", "fixture-authority", "--deadline-ms", "0", "--json"],
			["status", "--deadline-ms", "1", "--json"],
		]) {
			const root = fresh("healthy-with-fresh-preview")
			const before = readState(root)
			const observed = await result(start(root, args))
			const payload = machineResult(observed.stdout)
			expect(observed.exit).toBe(2)
			expect(observed.stderr).toBe("")
			expect(payload).toMatchObject({ outcome: "refused", transactionState: "unchanged", causeCode: "USAGE_INVALID_INVOCATION", failureClass: "usage", exitCode: 2, retryable: false })
			expect(readState(root)).toEqual(before)
		}
	})

	test("closed and held-open non-TTY stdin never prompt or block any accepted route", async () => {
		const routes = [
			{ route: "dispatch", variant: "healthy", args: ["--json"], identity: "repair-lab.dispatch", outcome: "refused", exit: 2, previewWritten: false },
			{ route: "help", variant: "healthy", args: ["--help", "--json"], identity: "repair-lab.help", outcome: "success", exit: 0, previewWritten: false },
			{ route: "discover", variant: "healthy", args: ["--discover", "--json"], identity: "repair-lab.discovery", outcome: "success", exit: 0, previewWritten: false },
			{ route: "command-discovery", variant: "healthy", args: ["--discover-command", "repair-lab.status", "--json"], identity: "repair-lab.command-discovery", outcome: "success", exit: 0, previewWritten: false },
			{ route: "status", variant: "healthy", args: ["status", "--json"], identity: "repair-lab.status", outcome: "success", exit: 0, previewWritten: false },
			{ route: "inspect", variant: "healthy", args: ["inspect", "--json"], identity: "repair-lab.inspect", outcome: "success", exit: 0, previewWritten: false },
			{ route: "inspect-diagnostics", variant: "healthy", args: ["inspect", "--include-diagnostics", "--json"], identity: "repair-lab.inspect-diagnostics", outcome: "success", exit: 0, previewWritten: false },
			{ route: "preview", variant: "healthy", args: ["apply", "--preview", "--json"], identity: "repair-lab.preview", outcome: "success", exit: 0, previewWritten: true },
			{ route: "apply", variant: "healthy", args: ["apply", "--json"], identity: "repair-lab.apply", outcome: "refused", exit: 3, previewWritten: false },
			{ route: "repair-preview", variant: "derived-index-missing", args: ["repair", "--preview", "--json"], identity: "repair-lab.repair", outcome: "refused", exit: 3, previewWritten: true },
			{ route: "repair", variant: "derived-index-missing", args: ["repair", "--apply", "--json"], identity: "repair-lab.repair", outcome: "refused", exit: 3, previewWritten: false },
			{ route: "repair-retry", variant: "derived-index-missing", args: ["repair", "--apply", "--retry-once", "--json"], identity: "repair-lab.repair-retry", outcome: "refused", exit: 3, previewWritten: false },
			{ route: "recover", variant: "healthy", args: ["recover", "--json"], identity: "repair-lab.recover", outcome: "success", exit: 0, previewWritten: false },
		] as const
		for (const route of routes) {
			for (const stdin of ["ignore", "pipe"] as const) {
				const root = fresh(route.variant)
				const before = readState(root)
				const observed = await boundedResult(start(root, [...route.args], { mode: "stdin-observation", stdin }), 2_000)
				const after = readState(root)
				const wasPrompted = prompted(observed.stdout, observed.stderr)
				expect(analyzeLifecycleObservation({ claim: "stdin-neutral", stdout: observed.stdout, stderr: observed.stderr, envelopeCount: envelopeCount(observed.stdout), drainConfirmed: !observed.blocked, disposition: stdin === "pipe" ? "held-open" : "closed", stdinReadCount: stdinReadCount(root), prompted: wasPrompted, blocked: observed.blocked, expectedExitCode: route.exit, exitCode: observed.exit, domainStateUnchanged: after.resource === before.resource && after.journal === before.journal })).toEqual([])
				expect(observed).toMatchObject({ exit: route.exit, stderr: "" })
				expect(machineResult(observed.stdout)).toMatchObject({ commandIdentity: route.identity, outcome: route.outcome })
				expect(after.resource).toBe(before.resource)
				expect(after.journal).toBe(before.journal)
				if (route.previewWritten) expect(after.preview).not.toBe(before.preview)
				else expect(after.preview).toBe(before.preview)
			}
		}
	})

	test("the stdin receipt and bounded collector detect their negative controls", async () => {
		const readRoot = fresh()
		const readObserved = await boundedResult(start(readRoot, ["status", "--json"], { mode: "stdin-observation", stdin: "pipe", env: { O3_STDIN_CONTROL: "read" } }), 2_000)
		expect(readObserved.blocked).toBe(false)
		expect(stdinReadCount(readRoot)).toBeGreaterThan(0)
		expect(analyzeLifecycleObservation({ claim: "stdin-neutral", stdout: readObserved.stdout, stderr: readObserved.stderr, envelopeCount: envelopeCount(readObserved.stdout), drainConfirmed: true, disposition: "held-open", stdinReadCount: stdinReadCount(readRoot), prompted: prompted(readObserved.stdout, readObserved.stderr), blocked: false, expectedExitCode: 0, exitCode: readObserved.exit, domainStateUnchanged: true })).toEqual(["LIFECYCLE_STDIN_READ"])

		const blockedRoot = fresh()
		const blocked = await boundedResult(start(blockedRoot, ["status", "--json"], { mode: "before-output-signal", stdin: "pipe" }), 50)
		expect(blocked).toMatchObject({ stdout: "", stderr: "", blocked: true })
	})

	test("a human-mode top-level rejection emits its bounded fallback before crash exit", async () => {
		const root = fresh()
		const observed = await result(start(root, ["status"], { mode: "run-rejection" }))
		expect(observed).toEqual({ stdout: "", stderr: "repair-lab: internal failure\n", exit: 1, signal: null })
	})

	test("uncaught exception and unhandled rejection make one emergency attempt and exit silently", async () => {
		for (const mode of ["uncaught", "unhandled"] as const) {
			const root = fresh()
			const before = readState(root)
			const child = start(root, ["status", "--json"], { mode })
			await waitFor(join(root.privateRoot, "crash-ready"))
			const observed = await result(child)
			expect(observed.exit).toBe(1)
			expect(observed.stdout).toBe("")
			expect(observed.stderr).toBe("")
			expect(diagnostics(root)).toContain('"emergency":true')
			expect(readState(root)).toEqual(before)
			expect(analyzeLifecycleObservation({ claim: "crash", stdout: observed.stdout, stderr: observed.stderr, envelopeCount: 0, drainConfirmed: false, kind: mode === "uncaught" ? "uncaught-exception" : "unhandled-rejection", exitCode: observed.exit, emergencyAttempts: 1 })).toEqual([])
		}
	})

	test("an EPIPE event after confirmed drain preserves the emitted result and exit", async () => {
		const root = fresh()
		const child = start(root, ["status", "--json"], { mode: "late-epipe" })
		const observed = await result(child)
		expect(observed.exit).toBe(0)
		expect(observed.stderr).toBe("")
		expect(JSON.parse(observed.stdout).result).toMatchObject({ commandIdentity: "repair-lab.status", outcome: "success", exitCode: 0 })
		expect(analyzeLifecycleObservation({ claim: "epipe-after-drain", stdout: observed.stdout, stderr: observed.stderr, envelopeCount: 1, drainConfirmed: true, epipeObserved: true, expectedExitCode: 0, exitCode: observed.exit })).toEqual([])
	})

	test("consumer disappearance before large-output drain exits internal without replacement output", async () => {
		const root = fresh("checker-target")
		const before = readState(root)
		const child = start(root, ["inspect", "--state", "state/large.json", "--json"])
		await child.stdout.cancel()
		const [stderr, exit] = await Promise.all([new Response(child.stderr).text(), child.exited])
		expect(exit).toBe(1)
		expect(stderr).toBe("")
		expect(child.signalCode).toBeNull()
		expect(readState(root)).toEqual(before)
		expect(analyzeLifecycleObservation({ claim: "epipe-before-drain", stdout: "", stderr, envelopeCount: 0, drainConfirmed: false, epipeObserved: true, exitCode: exit })).toEqual([])
	})

	test("a slow consumer receives the complete large envelope before normal exit", async () => {
		const root = fresh("checker-target")
		const child = start(root, ["inspect", "--state", "state/large.json", "--json"])
		const reader = child.stdout.getReader()
		const chunks: Uint8Array[] = []
		for (;;) {
			const next = await reader.read()
			if (next.done) break
			chunks.push(next.value)
			await Bun.sleep(2)
		}
		const bytes = Buffer.concat(chunks)
		const [stderr, exit] = await Promise.all([new Response(child.stderr).text(), child.exited])
		const stdout = bytes.toString("utf8")
		expect(analyzeLifecycleObservation({ claim: "large-output-drain", stdout, stderr, envelopeCount: envelopeCount(stdout), drainConfirmed: true, slowConsumer: true, exitCode: exit })).toEqual([])
	})

	test.each(["SIGINT", "SIGTERM"] as const)("%s before output emits no envelope and exits after the bounded stop", async (signal) => {
		const root = fresh()
		const child = startGroup(root, ["status", "--json"], "before-output-signal")
		const completion = captureGroup(child)
		await waitFor(join(root.privateRoot, "before-output-ready"))
		const started = performance.now()
		groupSignal(child, signal)
		const observed = await completion
		const elapsed = performance.now() - started
		expect(elapsed).toBeLessThan(750)
		expect(observed.pid).toBeGreaterThan(0)
		expect(observed.exit).toBe(signal === "SIGINT" ? 130 : 143)
		expect(analyzeLifecycleObservation({ claim: "signal", stdout: observed.stdout, stderr: observed.stderr, envelopeCount: 0, drainConfirmed: false, signal, phase: "before-output", terminationCount: 1, exitCode: observed.exit, immediateTermination: false })).toEqual([])
	})

	test("SIGTERM during a blocked large-output drain permits no replacement envelope", async () => {
		const root = fresh("checker-target")
		const child = startGroup(root, ["inspect", "--state", "state/large.json", "--json"], "during-drain-signal")
		const completion = captureGroup(child, false)
		await waitFor(join(root.privateRoot, "write-started"))
		groupSignal(child, "SIGTERM")
		const observed = await completion
		expect(observed.pid).toBeGreaterThan(0)
		expect(observed.exit).toBe(143)
		expect(analyzeLifecycleObservation({ claim: "signal", stdout: observed.stdout, stderr: observed.stderr, envelopeCount: envelopeCount(observed.stdout), drainConfirmed: false, signal: "SIGTERM", phase: "during-drain", terminationCount: 1, exitCode: observed.exit, immediateTermination: false })).toEqual([])
	})

	test("a repeated SIGINT exits immediately while the first stop is flushing", async () => {
		const root = fresh()
		const child = startGroup(root, ["status", "--json"], "repeated-signal")
		const completion = captureGroup(child)
		await waitFor(join(root.privateRoot, "before-output-ready"))
		groupSignal(child, "SIGINT")
		await Bun.sleep(20)
		const repeatedAt = performance.now()
		groupSignal(child, "SIGINT")
		const observed = await completion
		const elapsed = performance.now() - repeatedAt
		expect(elapsed).toBeLessThan(150)
		expect(observed.exit).toBe(130)
		expect(analyzeLifecycleObservation({ claim: "signal", stdout: observed.stdout, stderr: observed.stderr, envelopeCount: 0, drainConfirmed: false, signal: "SIGINT", phase: "before-output", terminationCount: 2, exitCode: observed.exit, immediateTermination: true })).toEqual([])
	})

	test("a signal after confirmed drain preserves the envelope and exits out of band", async () => {
		const root = fresh()
		const child = start(root, ["status", "--json"], { mode: "after-drain-signal" })
		await waitFor(join(root.privateRoot, "drain-confirmed"))
		child.kill("SIGINT")
		const observed = await result(child)
		expect(observed.exit).toBe(130)
		expect(observed.stderr).toBe("")
		expect(JSON.parse(observed.stdout).result).toMatchObject({ commandIdentity: "repair-lab.status", outcome: "success", exitCode: 0 })
	})
})
