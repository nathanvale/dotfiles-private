import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
	appendFileSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import {
	createInvocationTraceStore,
	cleanupTraces,
	DEFAULT_TRACE_MAX_TOTAL_BYTES,
	queryTraces,
	traceRoot,
} from "./invocation-trace-store.ts"
import { createRecoveryDiagnosticAdapter } from "./logtape-diagnostic-adapter.ts"
import { validateLifecycleRecord } from "./serialized-values.ts"

const pluginRoot = resolve(import.meta.dir, "../../..")
const traceCommand = join(pluginRoot, "bin/recovery-traces")
const concurrentWriter = join(import.meta.dir, "test-fixtures/write-trace.ts")
const roots: string[] = []

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "recovery-observability-test-"))
	roots.push(root)
	return root
}

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schema_version: 1,
		record_type: "lifecycle",
		record_identity: "record-1",
		journey_identity: "journey-1",
		invocation_identity: "invocation-1",
		producer_identity: "producer-1",
		producer_sequence: 0,
		observed_worker_identity: "worker-1",
		observed_worker_identity_source: "hook-payload",
		ledger_task_identity: "task-1",
		harness_kind: "codex",
		operation: "hook",
		phase: "invocation",
		occurred_at: "2026-09-06T00:00:00.000Z",
		outcome: "started",
		...overrides,
	}
}

function runCli(args: string[], stateHome: string): { exitCode: number; stdout: string; stderr: string } {
	const child = Bun.spawnSync([traceCommand, ...args, "--state-home", stateHome], {
		cwd: pluginRoot,
		env: { ...process.env, XDG_STATE_HOME: stateHome },
		stdout: "pipe",
		stderr: "pipe",
	})
	return {
		exitCode: child.exitCode,
		stdout: child.stdout.toString(),
		stderr: child.stderr.toString(),
	}
}

function runIdentity(): { exitCode: number; stdout: string; stderr: string } {
	const child = Bun.spawnSync([traceCommand, "identity"], {
		cwd: pluginRoot,
		stdout: "pipe",
		stderr: "pipe",
	})
	return {
		exitCode: child.exitCode,
		stdout: child.stdout.toString(),
		stderr: child.stderr.toString(),
	}
}

describe("closed lifecycle records", () => {
	test("validates, freezes, rejects unknown fields, known secrets, and oversized records", () => {
		const accepted = validateLifecycleRecord(record())
		expect(accepted.accepted).toBe(true)
		if (!accepted.accepted) throw new Error("expected accepted record")
		expect(Object.isFrozen(accepted.record)).toBe(true)

		expect(validateLifecycleRecord(record({ surprise: true }))).toEqual({ accepted: false, refusal: "unknown-field" })
		expect(
			validateLifecycleRecord(record({ ledger_task_identity: "task-planted-secret" }), {
				knownSecretValues: ["planted-secret"],
			}),
		).toEqual({ accepted: false, refusal: "known-secret" })

		const long = `a${"x".repeat(510)}`
		const oversized = record({
			record_identity: long,
			journey_identity: long,
			invocation_identity: long,
			producer_identity: long,
			parent_record_identity: long,
			observed_worker_identity: long,
			inherited_parent_identity: long,
			ledger_task_identity: long,
		})
		expect(validateLifecycleRecord(oversized)).toEqual({ accepted: false, refusal: "oversized-record" })
	})

	test("install versions accept SemVer build metadata without widening recovery identities", () => {
		// Independent SemVer examples, not values derived from the production predicate.
		for (const version of ["0.0.0", "1.2.3", "1.2.3+build.7", "1.2.3-alpha.1+build.7", "1.2.3-0", "1.2.3+007"]) {
			expect(validateLifecycleRecord(record({ install_evidence: { plugin_version: version } })).accepted).toBe(true)
		}
		for (const version of ["", "1.2", "v1.2.3", "01.2.3", "1.02.3", "1.2.03", "1.2.3-01", "1.2.3-alpha..1", "1.2.3+build..7", "1.2.3+", "1.2.3-", "1.2.3\n"]) {
			expect(validateLifecycleRecord(record({ install_evidence: { plugin_version: version } })).accepted).toBe(false)
		}
		expect(validateLifecycleRecord(record({ install_evidence: { plugin_version: undefined, runtime_sha256: "a".repeat(64) } })).accepted).toBe(true)
		expect(validateLifecycleRecord(record({ install_evidence: { plugin_version: `1.2.3+${"a".repeat(123)}` } })).accepted).toBe(false)
		expect(validateLifecycleRecord(record({ journey_identity: "journey+build.7" })).accepted).toBe(false)
	})

	test("requires paired worker evidence and a closed refusal code", () => {
		expect(validateLifecycleRecord(record({ observed_worker_identity_source: undefined }))).toEqual({
			accepted: false,
			refusal: "invalid-value",
		})
		expect(validateLifecycleRecord(record({ outcome: "refused", refusal_code: "ARBITRARY" }))).toEqual({
			accepted: false,
			refusal: "invalid-value",
		})
	})
})

describe("private invocation traces", () => {
	test("writes one 0600 file under 0700 directories and refuses another invocation", () => {
		const stateHome = temporaryRoot()
		const store = createInvocationTraceStore({ invocationIdentity: "invocation-1", stateHome })
		expect(store.accept(record()).accepted).toBe(true)
		expect(store.accept(record({ invocation_identity: "invocation-2" }))).toEqual({
			accepted: false,
			refusal: "invocation-mismatch",
		})
		store.dispose()
		if (!store.path) throw new Error("trace path unavailable")
		expect(statSync(store.path).mode & 0o777).toBe(0o600)
		expect(statSync(dirname(store.path)).mode & 0o777).toBe(0o700)
		expect(statSync(dirname(dirname(store.path))).mode & 0o777).toBe(0o700)
		expect(readFileSync(store.path, "utf8").trim()).toBe(JSON.stringify(record()))
		expect(store.accept(record())).toEqual({ accepted: false, refusal: "storage-unavailable" })
	})

	test("reports an initial sequence gap, later gaps, duplicates, unknown schemas, and one partial final line without reordering", () => {
		const stateHome = temporaryRoot()
		const store = createInvocationTraceStore({ invocationIdentity: "invocation-1", stateHome })
		for (const item of [
			record({ producer_sequence: 2 }),
			record({ record_identity: "record-2", producer_sequence: 4 }),
			record({ record_identity: "record-3", producer_sequence: 4 }),
		]) {
			expect(store.accept(item).accepted).toBe(true)
		}
		store.dispose()
		if (!store.path) throw new Error("trace path unavailable")
		appendFileSync(store.path, `${JSON.stringify({ schema_version: 2, record_type: "lifecycle" })}\n{"schema_version":1`)

		const result = queryTraces({ stateHome })
		expect(result.records.filter((item) => item.record_type === "lifecycle").map((item) => item.record_identity)).toEqual([
			"record-1",
			"record-2",
			"record-3",
		])
		expect(result.anomalies.map((item) => item.code)).toEqual([
			"sequence-gap",
			"sequence-gap",
			"duplicate-sequence",
			"unknown-schema",
			"partial-final-line",
		])
		expect(result.anomalies.slice(0, 2)).toEqual([
			expect.objectContaining({ expected_sequence: 0, observed_sequence: 2 }),
			expect.objectContaining({ expected_sequence: 3, observed_sequence: 4 }),
		])
	})

	test("returns unavailable instead of throwing when state storage cannot be created", () => {
		const root = temporaryRoot()
		const unavailable = join(root, "not-a-directory")
		writeFileSync(unavailable, "occupied")
		const store = createInvocationTraceStore({ invocationIdentity: "invocation-1", stateHome: unavailable })
		expect(store.path).toBeNull()
		expect(store.accept(record())).toEqual({ accepted: false, refusal: "storage-unavailable" })
	})

	test("the production writer refuses secret, control-character, and oversized identities before persistence", () => {
		const stateHome = temporaryRoot()
		const store = createInvocationTraceStore({
			invocationIdentity: "invocation-1",
			stateHome,
			knownSecretValues: ["planted-secret"],
		})
		expect(store.accept(record({ ledger_task_identity: "task-planted-secret" }))).toEqual({
			accepted: false,
			refusal: "known-secret",
		})
		expect(store.accept(record({ ledger_task_identity: "task\ncontrol" }))).toEqual({
			accepted: false,
			refusal: "invalid-value",
		})
		const long = `a${"x".repeat(510)}`
		expect(store.accept(record({
			record_identity: long,
			journey_identity: long,
			invocation_identity: long,
			producer_identity: long,
			parent_record_identity: long,
			observed_worker_identity: long,
			inherited_parent_identity: long,
			ledger_task_identity: long,
		}))).toEqual({ accepted: false, refusal: "oversized-record" })
		store.dispose()
		if (!store.path) throw new Error("trace path unavailable")
		expect(readFileSync(store.path, "utf8")).toBe("")
	})

	test("diagnostic persistence rejects arbitrary properties and known secrets before writing bytes", () => {
		const stateHome = temporaryRoot()
		const store = createInvocationTraceStore({ invocationIdentity: "invocation-1", stateHome, knownSecretValues: ["private-marker", "09-06"] })
		const diagnostic = {
			schema_version: 1,
			record_type: "diagnostic",
			category: "my-second-brain-playground/recovery",
			level: "warning",
			event: "buffer-truncated",
			occurred_at: "2026-01-01T00:00:00.000Z",
			properties: { dropped_records: 2 },
		}
		const rejected = [
			{ prompt: "private-marker prompt" },
			{ nested: { checkpoint: "private-marker checkpoint", exception: "private-marker exception", path: "/private/marker" } },
			{ arbitrary_count: 2 },
			{ dropped_records: "private-marker" },
			{ dropped_records: { prompt: "private-marker" } },
			{ dropped_records: -1 },
			{ dropped_records: 1.5 },
			{ dropped_records: Number.MAX_SAFE_INTEGER + 1 },
		]
		const accepted = rejected.map((properties) => store.writeDiagnostic(`${JSON.stringify({ ...diagnostic, properties })}\n`))
		accepted.push(store.writeDiagnostic(`${JSON.stringify({ ...diagnostic, occurred_at: "2026-09-06T00:00:00.000Z" })}\n`))
		if (!store.path) throw new Error("trace path unavailable")
		const rejectedBytes = readFileSync(store.path, "utf8")
		expect(store.writeDiagnostic(`${JSON.stringify(diagnostic)}\n`)).toBe(true)
		store.dispose()
		expect(rejectedBytes).toBe("")
		expect(accepted).toEqual(Array(9).fill(false))
		expect(readFileSync(store.path, "utf8")).toBe(`${JSON.stringify(diagnostic)}\n`)
	})

	test("concurrent processes get separate files and preserve each producer sequence", async () => {
		const stateHome = temporaryRoot()
		const children = ["producer-a", "producer-b"].map((producer) =>
			Bun.spawn([process.execPath, concurrentWriter, stateHome, "shared-invocation", producer], {
				cwd: pluginRoot,
				stdout: "pipe",
				stderr: "pipe",
			}),
		)
		expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0])
		const root = traceRoot(stateHome)
		if (!root) throw new Error("trace root unavailable")
		expect(readdirSync(root).filter((name) => name.endsWith(".jsonl"))).toHaveLength(2)
		const viewed = queryTraces({ stateHome, filter: { invocation_identity: "shared-invocation" } })
		expect(viewed.records.filter((item) => item.record_type === "lifecycle").map((item) => item.producer_identity).sort()).toEqual([
			"producer-a",
			"producer-b",
		])
		expect(viewed.anomalies).toEqual([])
	})
})

describe("LogTape diagnostic adapter", () => {
	test("quiet, default, verbose, and debug modes expose their literal diagnostic thresholds", () => {
		const outputs: Record<string, string[]> = {}
		for (const mode of ["quiet", "default", "verbose", "debug"] as const) {
			const lines: string[] = []
			const adapter = createRecoveryDiagnosticAdapter({
				mode,
				writeDiagnostic: (line) => lines.push(line),
				retainLifecycle: () => ({ accepted: false, refusal: "storage-unavailable" }),
			})
			adapter.diagnostic({ level: "debug", event: "observer-failure", timestamp: 0 })
			adapter.diagnostic({ level: "info", event: "storage-unavailable", timestamp: 1 })
			outputs[mode] = lines.map((line) => (JSON.parse(line) as { level: string }).level)
			adapter.dispose()
		}
		expect(outputs).toEqual({
			quiet: [],
			default: [],
			verbose: ["info"],
			debug: ["debug", "info"],
		})
	})

	test("interleaved adapter lifetimes keep LogTape routing scoped to their own output", () => {
		const first: string[] = []
		const second: string[] = []
		const makeAdapter = (lines: string[]) => createRecoveryDiagnosticAdapter({
			mode: "debug",
			writeDiagnostic: (line) => lines.push(line),
			retainLifecycle: () => ({ accepted: false, refusal: "storage-unavailable" }),
		})
		const firstAdapter = makeAdapter(first)
		const secondAdapter = makeAdapter(second)
		firstAdapter.diagnostic({ level: "info", event: "observer-failure", timestamp: 0 })
		secondAdapter.diagnostic({ level: "warning", event: "cleanup-failure", timestamp: 1 })
		firstAdapter.dispose()
		secondAdapter.diagnostic({ level: "error", event: "storage-unavailable", timestamp: 2 })
		secondAdapter.dispose()
		expect(first.map((line) => JSON.parse(line).event)).toEqual(["observer-failure"])
		expect(second.map((line) => JSON.parse(line).event)).toEqual(["cleanup-failure", "storage-unavailable"])
	})

	test("flushes a bounded oldest-drop buffer in order and redacts before egress", () => {
		const lines: string[] = []
		const adapter = createRecoveryDiagnosticAdapter({
			writeDiagnostic: (line) => lines.push(line),
			retainLifecycle: (input) => {
				const validated = validateLifecycleRecord(input)
				return validated.accepted ? { accepted: true, record: validated.record } : validated
			},
			knownSecretValues: ["planted-secret"],
		})
		// Independent oracle: the admitted cap is 250 records, with two overflow inputs.
		for (let index = 0; index < 252; index += 1) {
			adapter.diagnostic({ level: "debug", event: "observer-failure", timestamp: index })
		}
		adapter.diagnostic({
			level: "error",
			event: "storage-unavailable",
			timestamp: 999,
			properties: { api_key: "key", nested: { token: "token", safe: "planted-secret" } },
		})
		const output = lines.map((line) => JSON.parse(line))
		expect(output).toHaveLength(252)
		expect(output[0].event).toBe("buffer-truncated")
		expect(output[0].properties.dropped_records).toBe(2)
		expect(output[1].occurred_at).toBe("1970-01-01T00:00:00.002Z")
		expect(output.at(-1).properties).toEqual({})
	})

	test("diagnostic adapter persists only admitted counters from sensitive payloads", () => {
		const stateHome = temporaryRoot()
		const store = createInvocationTraceStore({ invocationIdentity: "invocation-1", stateHome, knownSecretValues: ["private-marker"] })
		const adapter = createRecoveryDiagnosticAdapter({
			mode: "debug",
			knownSecretValues: ["private-marker"],
			writeDiagnostic: (line) => { store.writeDiagnostic(line) },
			retainLifecycle: store.accept,
			disposeOutput: store.dispose,
		})
		adapter.diagnostic({
			level: "warning",
			event: "buffer-truncated",
			timestamp: 0,
			properties: {
				dropped_records: 2,
				prompt: "private-marker prompt",
				checkpoint: "checkpoint prose",
				exception: "exception prose",
				path: "/private/marker",
				nested: { api_key: "private-marker", prompt: "nested prose" },
			},
		})
		adapter.dispose()
		if (!store.path) throw new Error("trace path unavailable")
		expect(readFileSync(store.path, "utf8")).toBe(`${JSON.stringify({
			schema_version: 1,
			record_type: "diagnostic",
			category: "my-second-brain-playground/recovery",
			level: "warning",
			event: "buffer-truncated",
			occurred_at: "1970-01-01T00:00:00.000Z",
			properties: { dropped_records: 2 },
		})}\n`)
	})

	test("lifecycle bypasses buffering and sink or disposal failures stay contained", () => {
		let lifecycleCalls = 0
		const adapter = createRecoveryDiagnosticAdapter({
			writeDiagnostic: () => {
				throw new Error("diagnostic writer failed")
			},
			retainLifecycle: () => {
				lifecycleCalls += 1
				throw new Error("retention failed")
			},
			disposeOutput: () => {
				throw new Error("dispose failed")
			},
		})
		expect(adapter.accept(record())).toEqual({ accepted: false, refusal: "storage-unavailable" })
		expect(lifecycleCalls).toBe(1)
		expect(() => adapter.diagnostic({ level: "error", event: "observer-failure" })).not.toThrow()
		expect(() => adapter.dispose()).not.toThrow()
		expect(() => adapter.dispose()).not.toThrow()
		expect(adapter.accept(record())).toEqual({ accepted: false, refusal: "storage-unavailable" })
	})
})

describe("public trace command and scoped cleanup", () => {
	test("reports deterministic candidate bytes for foreground installed-journey comparison", () => {
		const result = runIdentity()
		expect(result.exitCode).toBe(0)
		expect(result.stderr).toBe("")
		const identity = JSON.parse(result.stdout) as Record<string, string | boolean | number>
		const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")
		expect(identity).toEqual({
			schema_version: 1,
			command: "identity",
			ok: true,
			plugin_version: "0.11.2",
			recovery_source_sha256: sha256(join(pluginRoot, "packages/compaction-recovery/src/recovery.py")),
			observer_source_sha256: sha256(join(pluginRoot, "packages/recovery-observability/src/recovery-observer.ts")),
			runtime_sha256: sha256(join(pluginRoot, "runtime/recovery-observer.js")),
		})
	})

	test("views filters through the public executable with pure JSON stdout", () => {
		const stateHome = temporaryRoot()
		for (const [invocation, journey, worker, task] of [
			["invocation-1", "journey-1", "worker-1", "task-1"],
			["invocation-2", "journey-2", "worker-2", "task-2"],
		]) {
			const store = createInvocationTraceStore({ invocationIdentity: invocation, stateHome })
			store.accept(record({ invocation_identity: invocation, journey_identity: journey, observed_worker_identity: worker, ledger_task_identity: task }))
			store.dispose()
		}
		for (const [flag, value] of [["--journey", "journey-2"], ["--invocation", "invocation-2"], ["--worker", "worker-2"], ["--task", "task-2"]]) {
			const result = runCli(["view", flag, value], stateHome)
			expect(result.exitCode).toBe(0)
			expect(result.stderr).toBe("")
			const output = JSON.parse(result.stdout)
			expect(output.records).toHaveLength(1)
			expect(output.records[0].invocation_identity).toBe("invocation-2")
		}
	})

	test("rejects a bare prototype-named filter key as a usage error, not an inherited filter", () => {
		const stateHome = temporaryRoot()
		for (const key of ["constructor", "__proto__"]) {
			const result = runCli(["view", key, "some-value"], stateHome)
			expect(result.exitCode).toBe(64)
			expect(result.stdout).toBe("")
		}
	})

	test("the public reader reports invalid, unknown, and partial records without inventing terminal state", () => {
		const stateHome = temporaryRoot()
		const root = traceRoot(stateHome)
		if (!root) throw new Error("trace root unavailable")
		mkdirSync(root, { recursive: true, mode: 0o700 })
		writeFileSync(
			join(root, "interrupted.jsonl"),
			[
				JSON.stringify(record({ observed_worker_identity: undefined, observed_worker_identity_source: undefined })),
				JSON.stringify(record({ record_identity: "bad\\ncontrol" })),
				JSON.stringify({ schema_version: 2, record_type: "lifecycle" }),
				'{"schema_version":1',
			].join("\n"),
		)

		const result = runCli(["view"], stateHome)
		expect(result.exitCode).toBe(0)
		expect(result.stderr).toBe("")
		const output = JSON.parse(result.stdout) as {
			records: Array<Record<string, unknown>>
			anomalies: Array<{ code: string }>
		}
		expect(output.records.map((item) => item.phase)).toEqual(["invocation"])
		expect(output.records.some((item) => ["deadline-exceeded", "cancelled", "signalled"].includes(String(item.outcome)))).toBe(false)
		expect(output.anomalies.map((item) => item.code)).toEqual(["invalid-record", "unknown-schema", "partial-final-line"])
	})

	test("removes expired and over-cap traces without touching checkpoint or unrelated state", () => {
		const stateHome = temporaryRoot()
		const root = traceRoot(stateHome)
		if (!root) throw new Error("trace root unavailable")
		mkdirSync(root, { recursive: true, mode: 0o700 })
		const old = join(root, "old.jsonl")
		const first = join(root, "first.jsonl")
		const second = join(root, "second.jsonl")
		writeFileSync(old, "old")
		writeFileSync(first, "12345678")
		writeFileSync(second, "abcdefgh")
		utimesSync(old, new Date(0), new Date(0))
		utimesSync(first, new Date(1000), new Date(1000))
		utimesSync(second, new Date(2000), new Date(2000))
		const checkpoint = join(stateHome, "my-second-brain-playground", "recovery", "checkpoint.json")
		mkdirSync(dirname(checkpoint), { recursive: true })
		writeFileSync(checkpoint, "preserve")
		const unrelated = join(stateHome, "unrelated.json")
		writeFileSync(unrelated, "preserve")

		const cleaned = cleanupTraces({ stateHome, nowMs: 3000, maxAgeMs: 2500, maxTotalBytes: 8 })
		expect(cleaned.removed_files).toBe(2)
		expect(readdirSync(root)).toEqual(["second.jsonl"])
		expect(readFileSync(checkpoint, "utf8")).toBe("preserve")
		expect(readFileSync(unrelated, "utf8")).toBe("preserve")

		utimesSync(second, new Date(0), new Date(0))
		const result = runCli(["cleanup"], stateHome)
		expect(result.exitCode).toBe(0)
		expect(result.stderr).toBe("")
		expect(JSON.parse(result.stdout).removed_files).toBe(1)
		expect(readFileSync(checkpoint, "utf8")).toBe("preserve")
	})

	test("enforces aggregate retention across more than 10000 trace files", () => {
		const stateHome = temporaryRoot()
		const root = traceRoot(stateHome)
		if (!root) throw new Error("trace root unavailable")
		mkdirSync(root, { recursive: true, mode: 0o700 })
		// Independent oracle: 10,000 * 2,097 = 20,970,000, below 20 MiB;
		// one more file brings the complete directory above that cap.
		const bytes = Buffer.alloc(2097)
		for (let index = 0; index < 10001; index += 1) {
			writeFileSync(join(root, `${String(index).padStart(5, "0")}.jsonl`), bytes)
		}
		const result = cleanupTraces({ stateHome })
		const retainedBytes = readdirSync(root).reduce((total, name) => total + statSync(join(root, name)).size, 0)
		expect(result.scanned_files).toBe(10001)
		expect(result.scan_truncated).toBe(false)
		expect(result.removed_files).toBe(1)
		expect(result.removed_bytes).toBe(2097)
		expect(retainedBytes).toBe(20970000)
		expect(result.retained_bytes).toBe(retainedBytes)
	})

	test("enforces the default 20 MiB aggregate cap", () => {
		const stateHome = temporaryRoot()
		const root = traceRoot(stateHome)
		if (!root) throw new Error("trace root unavailable")
		mkdirSync(root, { recursive: true, mode: 0o700 })
		writeFileSync(join(root, "first.jsonl"), Buffer.alloc(11 * 1024 * 1024))
		writeFileSync(join(root, "second.jsonl"), Buffer.alloc(11 * 1024 * 1024))
		const result = cleanupTraces({ stateHome })
		expect(DEFAULT_TRACE_MAX_TOTAL_BYTES).toBe(20 * 1024 * 1024)
		expect(result.removed_files).toBe(1)
		expect(result.retained_bytes).toBe(11 * 1024 * 1024)
	})
})
