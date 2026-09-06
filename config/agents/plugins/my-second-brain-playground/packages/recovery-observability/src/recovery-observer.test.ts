import { afterEach, describe, expect, test } from "bun:test"
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { firstTerminalOutcome } from "./recovery-observer.ts"
import { queryTraces } from "./invocation-trace-store.ts"

const temporaryRoots: string[] = []
const pluginRoot = resolve(import.meta.dir, "../../..")

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

test("bundled cleanup ignores inherited test barrier variables", async () => {
	const root = temporaryRoot()
	const command = await bundle(root, "trace-command.ts", "recovery-traces.js")
	const barrier = join(root, "barrier")
	const result = await run(command, ["cleanup"], join(root, "state"), { MSB_RECOVERY_TEST_CLEANUP_BARRIER_DIRECTORY: barrier })
	expect(result.exitCode).toBe(0)
	expect(result.stderr).toBe("")
	expect(JSON.parse(result.stdout)).toMatchObject({ command: "cleanup", ok: true })
	expect(existsSync(barrier)).toBe(false)
}, 2_000)

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

describe("observer terminal cause arbitration", () => {
	test("preserves an earlier external signal when a later deadline is observed", () => {
		expect(firstTerminalOutcome("signalled", "deadline-exceeded")).toBe("signalled")
		expect(firstTerminalOutcome(undefined, "deadline-exceeded")).toBe("deadline-exceeded")
	})
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
