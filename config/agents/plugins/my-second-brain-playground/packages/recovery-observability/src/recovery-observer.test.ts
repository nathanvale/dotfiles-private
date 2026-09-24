import { afterEach, expect, test } from "bun:test"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { queryTraces } from "./invocation-trace-store.ts"

const temporaryRoots: string[] = []
const pluginRoot = resolve(import.meta.dir, "../../..")
// Independent oracle: complete normalized output authored from recovery.py's command_envelope and schema_document contracts.
const EXPECTED_NORMALIZED_SCHEMA_STDOUT = `${JSON.stringify({
	schemaVersion: 1,
	commandIdentity: "my-second-brain-playground.recovery-checkpoint",
	runIdentity: "<run-identity>",
	operation: "schema",
	status: "success",
	data: {
		schemaVersion: 2,
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
		futureSkewSeconds: 300,
		identityPattern: "^[a-z0-9][a-z0-9-]{0,127}$",
		sessionIdentityPattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
		pathRules: {
			vaultRoot: "configured canonical absolute playground path",
			projectMap: "contained project README.md",
			goalPath: "contained GOAL.md beside the project map",
			evidencePath: "contained regular file under the project directory",
			recoveryPath: "contained recovery guide",
			agentLedgerExecutable: "canonical absolute regular executable owned by the current user",
			sessionIdentity: "hook-supplied safe session token for one session-scoped checkpoint",
			registerPath: "canonical file under the playground XDG Register directory",
		},
		observedAt: "UTC RFC 3339 timestamp ending in Z",
	},
})}\n`

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "recovery-observer-test-"))
	temporaryRoots.push(root)
	return root
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function bundle(root: string, entry: string, output: string): Promise<string> {
	const path = join(root, "runtime", output)
	const result = await Bun.build({ entrypoints: [join(import.meta.dir, entry)], target: "bun", outdir: join(root, "runtime"), naming: output })
	expect(result.success).toBe(true)
	return path
}

async function run(command: string, args: string[], stateHome: string, extraEnvironment: Record<string, string> = {}) {
	const child = Bun.spawn([process.execPath, command, ...args], {
		stdin: "ignore", stdout: "pipe", stderr: "pipe",
		env: { PATH: process.env.PATH, HOME: stateHome, XDG_STATE_HOME: stateHome, ...extraEnvironment },
	})
	const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
	return { exitCode, stdout, stderr }
}

test("source, fresh bundle, and committed runtime observers run the Python checkpoint command and cleanup", async () => {
	const root = temporaryRoot()
	const bundled = await bundle(root, "recovery-observer.ts", "recovery-observer.js")
	const recoveryDirectory = join(root, "packages/compaction-recovery/src")
	mkdirSync(recoveryDirectory, { recursive: true })
	cpSync(join(pluginRoot, "packages/compaction-recovery/src/recovery.py"), join(recoveryDirectory, "recovery.py"))
	await bundle(root, "trace-command.ts", "recovery-traces.js")
	const variants = [
		{ name: "source", command: join(import.meta.dir, "recovery-observer.ts") },
		{ name: "fresh-bundle", command: bundled },
		{ name: "committed-runtime", command: join(pluginRoot, "runtime/recovery-observer.js") },
	]
	for (const { name, command } of variants) {
		const stateHome = join(root, "state", name)
		const traces = join(stateHome, "my-second-brain-playground/recovery-traces")
		mkdirSync(traces, { recursive: true, mode: 0o700 })
		const expiredTrace = join(traces, "expired.jsonl")
		writeFileSync(expiredTrace, "", { mode: 0o600 })
		utimesSync(expiredTrace, new Date(0), new Date(0))
		const result = await run(command, ["checkpoint", "schema"], stateHome)
		expect(result.exitCode).toBe(0)
		expect(result.stderr).toBe("")
		expect(JSON.parse(result.stdout)).toMatchObject({ operation: "schema", status: "success" })
		const deadline = Date.now() + 2_000
		while (existsSync(expiredTrace) && Date.now() < deadline) await Bun.sleep(5)
		expect(existsSync(expiredTrace)).toBe(false)
	}
})

test("identity reports bounded JSON for missing or malformed identity inputs", async () => {
	const root = temporaryRoot()
	const command = await bundle(root, "trace-command.ts", "recovery-traces.js")
	const packagePath = join(root, "package.json")
	const observerPath = join(root, "packages/recovery-observability/src/recovery-observer.ts")
	const recoveryPath = join(root, "packages/compaction-recovery/src/recovery.py")
	const runtimePath = join(root, "runtime/recovery-observer.js")
	const inputs = [observerPath, recoveryPath, runtimePath]
	for (const path of inputs) {
		mkdirSync(resolve(path, ".."), { recursive: true })
		writeFileSync(path, "abc")
	}
	for (const metadata of [undefined, "{private-invalid-json", "null", "{}", '{"version":42}', '{"version":""}']) {
		if (metadata !== undefined) writeFileSync(packagePath, metadata)
		const result = await run(command, ["identity"], join(root, "state"))
		expect(result.exitCode).not.toBe(0)
		expect(result.stderr).toBe("")
		expect(JSON.parse(result.stdout)).toMatchObject({ schema_version: 1, command: "identity", ok: false, error: "identity-unavailable" })
		expect(result.stdout).not.toContain(root)
		expect(result.stdout).not.toContain("private-invalid-json")
	}
	writeFileSync(packagePath, '{"version":"1.2.3"}')
	for (const path of inputs) {
		rmSync(path)
		const result = await run(command, ["identity"], join(root, "state"))
		expect(result.exitCode).not.toBe(0)
		expect(result.stderr).toBe("")
		expect(JSON.parse(result.stdout)).toMatchObject({ command: "identity", ok: false, error: "identity-unavailable" })
		expect(result.stdout).not.toContain(root)
		writeFileSync(path, "abc")
	}
	const result = await run(command, ["identity"], join(root, "state"))
	expect(result.exitCode).toBe(0)
	expect(result.stderr).toBe("")
	// Independent oracle: published SHA-256 digest of the fixture bytes "abc".
	const digest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	expect(JSON.parse(result.stdout)).toEqual({ schema_version: 1, command: "identity", ok: true, plugin_version: "1.2.3", recovery_source_sha256: digest, observer_source_sha256: digest, runtime_sha256: digest })
})

test("observer lifecycle seam reports refused and thrown observer-owned writes without replacing accepted child output", async () => {
	const root = temporaryRoot()
	const observerSource = join(import.meta.dir, "recovery-observer.ts")
	for (const storeOutcome of ["accepted", "refused", "thrown"] as const) {
		const stateHome = join(root, "state", storeOutcome)
		const eventsPath = join(root, `${storeOutcome}.jsonl`)
		const script = `
import { appendFileSync } from "node:fs"
import { runRecoveryObserver } from ${JSON.stringify(observerSource)}
const storeOutcome = ${JSON.stringify(storeOutcome)}
const eventsPath = ${JSON.stringify(eventsPath)}
const recordEvent = (event) => appendFileSync(eventsPath, JSON.stringify(event) + "\\n")
const exitCode = await runRecoveryObserver(["checkpoint", "schema"], {
  createTraceStore: () => ({
    path: null,
    accept(input) {
      const observerTerminal = input?.record_type === "lifecycle"
        && input?.phase === "terminal"
        && typeof input?.producer_identity === "string"
        && input.producer_identity.startsWith("recovery-observer-")
      const outcome = observerTerminal ? storeOutcome : "accepted"
      recordEvent({ event: "accept", observerTerminal, outcome })
      if (outcome === "thrown") throw new Error("test-owned trace acceptance failure")
      if (outcome === "refused") return { accepted: false, refusal: "storage-unavailable" }
      return { accepted: true, record: input }
    },
    writeDiagnostic(line) {
      recordEvent({ event: "diagnostic", record: JSON.parse(line) })
      return true
    },
    dispose() {},
  }),
})
process.exitCode = exitCode
`
		const child = Bun.spawn([process.execPath, "--eval", script], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, HOME: stateHome, XDG_STATE_HOME: stateHome },
		})
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		])
		expect(exitCode).toBe(0)
		expect(stderr).toBe("")
		const output = JSON.parse(stdout) as Record<string, unknown>
		expect(output.runIdentity).toMatch(/^recovery-checkpoint-run-[a-f0-9]{24}$/)
		const normalizedPrimaryOutput = stdout.replace(
			`"runIdentity":"${String(output.runIdentity)}"`,
			'"runIdentity":"<run-identity>"',
		)
		expect(normalizedPrimaryOutput).toBe(EXPECTED_NORMALIZED_SCHEMA_STDOUT)

		const events = readFileSync(eventsPath, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>)
		const observerTerminalAttempts = events.filter(event => event.event === "accept" && event.observerTerminal)
		expect(observerTerminalAttempts).toHaveLength(1)
		expect(observerTerminalAttempts).toEqual([
			{ event: "accept", observerTerminal: true, outcome: storeOutcome },
		])
		const diagnostics = events.filter(event => event.event === "diagnostic")
		if (storeOutcome === "accepted") expect(diagnostics).toEqual([])
		else {
			expect(diagnostics).toHaveLength(1)
			expect(diagnostics).toMatchObject([{ record: { level: "error", event: "observer-failure", properties: {} } }])
		}
	}
})

test("lifecycle framing discards oversized suffixes and reports incomplete EOF frames", async () => {
	const root = temporaryRoot()
	const command = await bundle(root, "recovery-observer.ts", "recovery-observer.js")
	const recoveryDirectory = join(root, "packages/compaction-recovery/src")
	mkdirSync(recoveryDirectory, { recursive: true })
	writeFileSync(join(recoveryDirectory, "recovery.py"), `import json, os, pathlib, time

def record(identity, sequence):
    return json.dumps({"schema_version": 1, "record_type": "lifecycle", "record_identity": identity,
        "journey_identity": "frame-journey", "invocation_identity": os.environ["MSB_RECOVERY_OBSERVATION_INVOCATION_IDENTITY"],
        "producer_identity": "frame-producer", "producer_sequence": sequence, "harness_kind": "unknown",
        "operation": "schema", "phase": "validation", "occurred_at": "2026-09-06T00:00:00.000Z", "outcome": "accepted"}).encode()

case = os.environ["FRAME_CASE"]
if case.startswith("oversized"):
    # Independent oracle: the wire contract allows at most 4096 bytes per frame.
    os.write(3, b"x" * 4097)
    deadline = time.monotonic() + 2
    traces = pathlib.Path(os.environ["XDG_STATE_HOME"]) / "my-second-brain-playground" / "recovery-traces"
    while not any('"observer-failure"' in path.read_text() for path in traces.glob("*.jsonl")):
        if time.monotonic() >= deadline:
            raise RuntimeError("observer did not reject oversized prefix")
        time.sleep(0.005)
    if case == "oversized-suffix":
        os.write(3, record("discarded-suffix", 0) + b"\\n" + record("following-frame", 1) + b"\\n")
elif case == "partial-json":
    os.write(3, record("partial-frame", 0))
else:
    os.write(3, bytes([0xc3]))
print("primary-response")
`)
	for (const caseName of ["oversized-suffix", "oversized-eof", "partial-json", "partial-utf8"]) {
		const stateHome = join(root, caseName)
		const result = await run(command, ["checkpoint", "schema"], stateHome, { FRAME_CASE: caseName })
		expect(result).toEqual({ exitCode: 0, stdout: "primary-response\n", stderr: "" })
		const records = queryTraces({ stateHome }).records
		const producerRecords = records.filter(record => record.record_type === "lifecycle" && record.producer_identity === "frame-producer")
		expect(producerRecords.map(record => record.record_type === "lifecycle" ? record.record_identity : "diagnostic")).toEqual(
			caseName === "oversized-suffix" ? ["following-frame"] : [],
		)
		expect(records.filter(record => record.record_type === "diagnostic")).toMatchObject([
			{ level: "error", event: "observer-failure", properties: {} },
		])
	}
})

test("the observer keeps the first terminal cause when an external signal follows its deadline", async () => {
	const root = temporaryRoot()
	const command = await bundle(root, "recovery-observer.ts", "recovery-observer.js")
	const recoveryDirectory = join(root, "packages/compaction-recovery/src")
	mkdirSync(recoveryDirectory, { recursive: true })
	// The child reports the deadline's SIGTERM and keeps running, so the external SIGTERM sent below lands inside the
	// observer's reap grace and both causes reach the one terminal record; the deadline is the first cause by
	// construction because the test signals only after it has observed the child's report.
	writeFileSync(join(recoveryDirectory, "recovery.py"), `import signal, sys, time

def report(signum, frame):
    sys.stdout.write("sigterm-received\\n")
    sys.stdout.flush()

signal.signal(signal.SIGTERM, report)
sys.stdout.write("ready\\n")
sys.stdout.flush()
time.sleep(10)
`)
	const stateHome = join(root, "state")
	const observer = Bun.spawn([process.execPath, command, "checkpoint", "schema"], {
		stdin: "ignore", stdout: "pipe", stderr: "pipe",
		env: { PATH: process.env.PATH, HOME: stateHome, XDG_STATE_HOME: stateHome, MSB_RECOVERY_OBSERVER_DEADLINE_MS: "800" },
	})
	const decoder = new TextDecoder()
	let stdout = ""
	let externalSignalSent = false
	for await (const chunk of observer.stdout) {
		stdout += decoder.decode(chunk, { stream: true })
		if (!externalSignalSent && stdout.includes("sigterm-received\n")) {
			externalSignalSent = true
			observer.kill("SIGTERM")
		}
	}
	const [exitCode, stderr] = await Promise.all([observer.exited, new Response(observer.stderr).text()])
	expect(externalSignalSent).toBe(true)
	expect(exitCode).not.toBe(0)
	// Two reports: the deadline's SIGTERM, then the external SIGTERM the observer forwarded after it.
	expect({ stdout, stderr }).toEqual({ stdout: "ready\nsigterm-received\nsigterm-received\n", stderr: "" })
	// Independent oracle: the terminal record names the first cause, read back from the durable trace store.
	const terminalOutcomes = queryTraces({ stateHome }).records.flatMap((record) => (
		record.record_type === "lifecycle" && record.phase === "terminal" && record.producer_identity.startsWith("recovery-observer-")
			? [record.outcome]
			: []
	))
	expect(terminalOutcomes).toEqual(["deadline-exceeded"])
}, 10_000)
