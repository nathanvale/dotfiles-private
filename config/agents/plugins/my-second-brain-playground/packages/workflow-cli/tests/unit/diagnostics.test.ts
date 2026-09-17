import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { configureSync, getLogger, resetSync } from "@logtape/logtape"
import { openDiagnostics } from "../../src/diagnostics.ts"

// Diagnostics Module (Spec #57, Diagnostics and lock): every record carries run correlation, secrets are redacted at
// the sink by key and by known value (including values learned after the sink opened), output reaches only a
// bounded 0600 JSON Lines file under the supplied private root or, in human mode, warning-level lines on the
// caller's stderr writer, and no logging failure can throw into or change the command result. Copied from the
// retired candidate and adapted to decisions D2 (stderr sink level) and D3 (the root's mode is the operator's) and
// to the accepted L2 repair (a broad-mode helper ancestor is refused, never corrected). The reader here is
// independent of the module: raw bytes, split on newline, JSON.parse per line.

const pluginRoot = resolve(import.meta.dir, "../../../..")
const modulePath = resolve(import.meta.dir, "../../src/diagnostics.ts")
const roots: string[] = []

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function stateHome(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "workflow-cli-diag-")))
	roots.push(root)
	return root
}

function diagnosticsDirectory(root: string): string {
	return join(root, "my-second-brain-playground", "workflow-cli", "diagnostics")
}

function runFile(root: string, runIdentity: string): string {
	return join(diagnosticsDirectory(root), `${runIdentity}.jsonl`)
}

function records(file: string): Array<Record<string, unknown>> {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
}

function line(lines: Array<Record<string, unknown>>, index: number): Record<string, unknown> {
	const found = lines[index]
	if (found === undefined) throw new Error(`no record at index ${index}`)
	return found
}

describe("openDiagnostics file sink", () => {
	test("every record carries run correlation; station, Bead and generation facts appear when supplied", () => {
		const root = stateHome()
		const diagnostics = openDiagnostics({ runIdentity: "run-1", commandIdentity: "msb-workflow.bind", stateHome: root })
		diagnostics.log("store.verified")
		diagnostics.setStation("bound")
		diagnostics.log("bind.completed", { beadId: "lkr-1", generation: 2 })
		diagnostics.log("station.left", { stationId: "recovered" })
		const status = diagnostics.dispose()
		const file = runFile(root, "run-1")
		expect(statSync(diagnosticsDirectory(root)).mode & 0o777).toBe(0o700)
		expect(statSync(file).mode & 0o777).toBe(0o600)
		expect(status).toEqual({ file, written: 3, dropped: 0, refused: 0, failure: null, closed: true })
		const lines = records(file)
		expect(lines).toHaveLength(3)
		for (const record of lines) {
			expect(record.runIdentity).toBe("run-1")
			expect(record.commandIdentity).toBe("msb-workflow.bind")
			expect(record.logger).toBe("msb-workflow")
			expect(record.message).toBe(record.eventKind)
			expect(typeof record["@timestamp"]).toBe("string")
		}
		expect(lines.map((record) => [record.sequence, record.eventKind])).toEqual([
			[1, "store.verified"],
			[2, "bind.completed"],
			[3, "station.left"],
		])
		expect("stationId" in line(lines, 0)).toBe(false)
		expect(line(lines, 1)).toMatchObject({ stationId: "bound", beadId: "lkr-1", generation: 2 })
		expect(line(lines, 2).stationId).toBe("recovered")
		expect("beadId" in line(lines, 2)).toBe(false)
	})

	test("caller properties cannot override the reserved identity keys", () => {
		const root = stateHome()
		const diagnostics = openDiagnostics({ runIdentity: "run-2", commandIdentity: "msb-workflow.inspect", stateHome: root })
		diagnostics.log("x", { runIdentity: "spoof", commandIdentity: "spoof", sequence: 99, eventKind: "spoof", message: "spoof", logger: "spoof", "@timestamp": "spoof", extra: "kept" })
		diagnostics.dispose()
		const file = runFile(root, "run-2")
		expect(records(file)).toEqual([expect.objectContaining({ runIdentity: "run-2", commandIdentity: "msb-workflow.inspect", sequence: 1, eventKind: "x", message: "x", logger: "msb-workflow", extra: "kept" })])
		expect(readFileSync(file, "utf8").includes("spoof")).toBe(false)
	})

	test("secret-bearing keys are redacted at the sink at every depth", () => {
		const root = stateHome()
		const diagnostics = openDiagnostics({ runIdentity: "run-3", commandIdentity: "msb-workflow.recover", stateHome: root })
		diagnostics.log("secret.test", {
			token: "tok-1",
			apiKey: "key-value-1",
			api_key: "key-value-2",
			private_key: "pk-value",
			nested: { password: "pw-value", inner: { credential: "cred-value" } },
			list: [{ secret: "list-secret" }],
			safe: "visible",
		})
		diagnostics.dispose()
		const file = runFile(root, "run-3")
		expect(line(records(file), 0)).toMatchObject({
			token: "[REDACTED]",
			apiKey: "[REDACTED]",
			api_key: "[REDACTED]",
			private_key: "[REDACTED]",
			nested: { password: "[REDACTED]", inner: { credential: "[REDACTED]" } },
			list: [{ secret: "[REDACTED]" }],
			safe: "visible",
		})
		const raw = readFileSync(file, "utf8")
		for (const leaked of ["tok-1", "key-value-1", "key-value-2", "pk-value", "pw-value", "cred-value", "list-secret"]) expect(raw.includes(leaked)).toBe(false)
	})

	test("known secret values are redacted wherever they appear, including the message", () => {
		const root = stateHome()
		const diagnostics = openDiagnostics({ runIdentity: "run-4", commandIdentity: "msb-workflow.recover", stateHome: root, knownSecretValues: ["CHECK_FIXTURE_SECRET_MARKER", ""] })
		diagnostics.log("known.value", { note: "prefix CHECK_FIXTURE_SECRET_MARKER suffix", nested: ["CHECK_FIXTURE_SECRET_MARKER"], count: 1 })
		diagnostics.log("CHECK_FIXTURE_SECRET_MARKER")
		const status = diagnostics.dispose()
		const file = runFile(root, "run-4")
		const lines = records(file)
		expect(line(lines, 0)).toMatchObject({ note: "prefix [REDACTED] suffix", nested: ["[REDACTED]"], count: 1 })
		expect(line(lines, 1)).toMatchObject({ message: "[REDACTED]", eventKind: "[REDACTED]" })
		expect(readFileSync(file, "utf8").includes("CHECK_FIXTURE_SECRET_MARKER")).toBe(false)
		expect(status).toMatchObject({ written: 2, refused: 0, failure: null })
	})

	test("a known-value provider is read at every write, so a value learned mid-run is redacted from then on", () => {
		const root = stateHome()
		const learned: string[] = []
		const diagnostics = openDiagnostics({ runIdentity: "run-4b", commandIdentity: "msb-workflow.recover", stateHome: root, knownSecretValues: () => learned })
		diagnostics.log("before", { note: "value LATER_SECRET visible" })
		learned.push("LATER_SECRET")
		diagnostics.log("after", { note: "value LATER_SECRET hidden" })
		diagnostics.dispose()
		const lines = records(runFile(root, "run-4b"))
		expect(line(lines, 0).note).toBe("value LATER_SECRET visible")
		expect(line(lines, 1).note).toBe("value [REDACTED] hidden")
	})

	test("an invalid event kind and an oversized record are each replaced by one bounded marker", () => {
		const root = stateHome()
		const diagnostics = openDiagnostics({ runIdentity: "run-5", commandIdentity: "msb-workflow.bind", stateHome: root })
		diagnostics.log("has space", { detail: "never-written" })
		diagnostics.log("big", { blob: "x".repeat(5000) })
		const status = diagnostics.dispose()
		const file = runFile(root, "run-5")
		const lines = records(file)
		expect(lines.map((record) => [record.sequence, record.eventKind, record.reason, record.refusedEventKind ?? null])).toEqual([
			[1, "diagnostics.refused", "event-kind", null],
			[2, "diagnostics.refused", "oversized", "big"],
		])
		const raw = readFileSync(file, "utf8")
		expect(raw.includes("has space")).toBe(false)
		expect(raw.includes("never-written")).toBe(false)
		expect(raw.includes("xxxxxxxxxx")).toBe(false)
		expect(status).toEqual({ file, written: 2, dropped: 0, refused: 2, failure: null, closed: true })
	})

	test("an unserializable record is refused with a marker and the run continues", () => {
		const root = stateHome()
		const diagnostics = openDiagnostics({ runIdentity: "run-6", commandIdentity: "msb-workflow.bind", stateHome: root })
		const cyclic: Record<string, unknown> = { name: "cycle" }
		cyclic.self = cyclic
		diagnostics.log("cycle", { cyclic })
		diagnostics.log("after", { ok: true })
		const status = diagnostics.dispose()
		const lines = records(runFile(root, "run-6"))
		expect(lines.map((record) => [record.eventKind, record.reason ?? null])).toEqual([
			["diagnostics.refused", "unserializable"],
			["after", null],
		])
		expect(status).toMatchObject({ written: 2, refused: 1, dropped: 0, failure: null })
	})

	test("the per-run record cap is 512 and disposal appends one truncation record with the dropped count", () => {
		const root = stateHome()
		const diagnostics = openDiagnostics({ runIdentity: "run-7", commandIdentity: "msb-workflow.bind", stateHome: root })
		for (let index = 0; index < 600; index += 1) diagnostics.log("flood", { index })
		const status = diagnostics.dispose()
		const lines = records(runFile(root, "run-7"))
		expect(lines).toHaveLength(513)
		expect(line(lines, 511)).toMatchObject({ sequence: 512, eventKind: "flood", index: 511 })
		expect(line(lines, 512)).toMatchObject({ eventKind: "diagnostics.truncated", droppedRecords: 88, runIdentity: "run-7" })
		expect(status).toMatchObject({ written: 513, dropped: 88, refused: 0, failure: null, closed: true })
	})

	test("a pre-existing run file is never appended to or truncated", () => {
		const root = stateHome()
		mkdirSync(diagnosticsDirectory(root), { recursive: true, mode: 0o700 })
		writeFileSync(runFile(root, "run-8"), "existing\n")
		const diagnostics = openDiagnostics({ runIdentity: "run-8", commandIdentity: "msb-workflow.bind", stateHome: root })
		diagnostics.log("a")
		diagnostics.log("b")
		const status = diagnostics.dispose()
		expect(status).toEqual({ file: null, written: 0, dropped: 2, refused: 0, failure: "open: EEXIST", closed: true })
		expect(readFileSync(runFile(root, "run-8"), "utf8")).toBe("existing\n")
	})

	test("a diagnostics path that is not a directory is refused without a throw", () => {
		const root = stateHome()
		mkdirSync(join(root, "my-second-brain-playground", "workflow-cli"), { recursive: true, mode: 0o700 })
		writeFileSync(diagnosticsDirectory(root), "not a directory\n")
		const diagnostics = openDiagnostics({ runIdentity: "run-9", commandIdentity: "msb-workflow.bind", stateHome: root })
		expect(() => diagnostics.log("a")).not.toThrow()
		expect(() => diagnostics.flush()).not.toThrow()
		const status = diagnostics.dispose()
		expect(status.failure).toBe("open: ENOTDIR")
		expect(status.file).toBeNull()
		expect(readFileSync(diagnosticsDirectory(root), "utf8")).toBe("not a directory\n")
	})

	test("an invalid run or command identity opens no file and drops every record", () => {
		const root = stateHome()
		for (const context of [
			{ runIdentity: "bad id", commandIdentity: "msb-workflow.bind" },
			{ runIdentity: "run-10", commandIdentity: "msb workflow" },
			{ runIdentity: "", commandIdentity: "msb-workflow.bind" },
		]) {
			const diagnostics = openDiagnostics({ ...context, stateHome: root })
			diagnostics.log("a")
			const status = diagnostics.dispose()
			expect(status).toEqual({ file: null, written: 0, dropped: 1, refused: 0, failure: "open: IDENTITY_INVALID", closed: true })
		}
		expect(existsSync(diagnosticsDirectory(root))).toBe(false)
	})

	test("retention keeps at most 64 run files, pruning the oldest first", () => {
		const root = stateHome()
		const directory = diagnosticsDirectory(root)
		mkdirSync(directory, { recursive: true, mode: 0o700 })
		for (let index = 0; index < 64; index += 1) {
			const file = join(directory, `old-${index}.jsonl`)
			writeFileSync(file, "")
			const seconds = 1_700_000_000 + index * 60
			utimesSync(file, seconds, seconds)
		}
		const diagnostics = openDiagnostics({ runIdentity: "run-11", commandIdentity: "msb-workflow.bind", stateHome: root })
		diagnostics.log("a")
		const status = diagnostics.dispose()
		const remaining = readdirSync(directory).filter((name) => name.endsWith(".jsonl")).sort()
		expect(remaining).toHaveLength(64)
		expect(remaining.includes("run-11.jsonl")).toBe(true)
		expect(remaining.includes("old-0.jsonl")).toBe(false)
		expect(remaining.includes("old-1.jsonl")).toBe(true)
		expect(remaining.includes("old-63.jsonl")).toBe(true)
		expect(status).toMatchObject({ written: 1, failure: null })
	})

	test("dispose is idempotent and later log, flush, and dispose calls are contained no-ops", () => {
		const root = stateHome()
		const diagnostics = openDiagnostics({ runIdentity: "run-12", commandIdentity: "msb-workflow.bind", stateHome: root })
		diagnostics.log("before")
		const first = diagnostics.dispose()
		for (let repeat = 0; repeat < 3; repeat += 1) {
			expect(() => diagnostics.log("after", { token: "late" })).not.toThrow()
			expect(() => diagnostics.flush()).not.toThrow()
			expect(diagnostics.dispose()).toEqual(first)
		}
		expect(first).toEqual({ file: runFile(root, "run-12"), written: 1, dropped: 0, refused: 0, failure: null, closed: true })
		expect(records(runFile(root, "run-12")).map((record) => record.eventKind)).toEqual(["before"])
	})

	test("a reused diagnostics directory with a broad mode is refused, never corrected, and no run file opens", () => {
		const root = stateHome()
		const directory = diagnosticsDirectory(root)
		mkdirSync(directory, { recursive: true, mode: 0o700 })
		chmodSync(directory, 0o755)
		const diagnostics = openDiagnostics({ runIdentity: "run-13", commandIdentity: "msb-workflow.bind", stateHome: root })
		diagnostics.log("a")
		expect(diagnostics.dispose()).toEqual({ file: null, written: 0, dropped: 1, refused: 0, failure: "open: EMODE", closed: true })
		expect(statSync(directory).mode & 0o777).toBe(0o755)
		expect(readdirSync(directory)).toEqual([])
	})

	test("level is lifted from properties when valid and ignored otherwise", () => {
		const root = stateHome()
		const diagnostics = openDiagnostics({ runIdentity: "run-17", commandIdentity: "msb-workflow.bind", stateHome: root })
		diagnostics.log("warned", { level: "warning", detail: 1 })
		diagnostics.log("errored", { level: "error" })
		diagnostics.log("odd", { level: "shout" })
		diagnostics.log("plain")
		diagnostics.dispose()
		const lines = records(runFile(root, "run-17"))
		// A caller-supplied level never reaches the flattened line: "shout" would otherwise overwrite the record level.
		expect(lines.map((record) => [record.eventKind, record.level])).toEqual([
			["warned", "WARN"],
			["errored", "ERROR"],
			["odd", "INFO"],
			["plain", "INFO"],
		])
		expect(line(lines, 0).detail).toBe(1)
		expect(readFileSync(runFile(root, "run-17"), "utf8").includes("shout")).toBe(false)
	})

	test("an Error property keeps only its name so no message or stack is recorded", () => {
		const root = stateHome()
		const diagnostics = openDiagnostics({ runIdentity: "run-19", commandIdentity: "msb-workflow.bind", stateHome: root })
		const failure = new TypeError("message with /Users/someone/private/path and token=abc")
		diagnostics.log("owner.failed", { failure, nested: { cause: failure } })
		diagnostics.dispose()
		const file = runFile(root, "run-19")
		expect(line(records(file), 0)).toMatchObject({ failure: { name: "TypeError" }, nested: { cause: { name: "TypeError" } } })
		const raw = readFileSync(file, "utf8")
		expect(raw.includes("message with")).toBe(false)
		expect(raw.includes("/Users/someone")).toBe(false)
		expect(raw.includes("stack")).toBe(false)
	})

	test("an empty station identity is ignored and a correlation property that is neither a string nor a number is dropped", () => {
		const root = stateHome()
		const diagnostics = openDiagnostics({ runIdentity: "run-18", commandIdentity: "msb-workflow.bind", stateHome: root })
		diagnostics.setStation("")
		diagnostics.log("a", { beadId: { nested: true }, generation: true })
		diagnostics.setStation("bound")
		diagnostics.log("b")
		diagnostics.dispose()
		const lines = records(runFile(root, "run-18"))
		expect("stationId" in line(lines, 0)).toBe(false)
		expect("beadId" in line(lines, 0)).toBe(false)
		expect("generation" in line(lines, 0)).toBe(false)
		expect(line(lines, 1).stationId).toBe("bound")
	})

	test("a foreign LogTape configuration without context-local storage is a contained log failure", () => {
		const root = stateHome()
		resetSync()
		// A foreign owner that configured LogTape without contextLocalStorage: the meta logger is silenced here only so
		// this test's own setup prints nothing.
		configureSync({ sinks: {}, loggers: [{ category: ["logtape", "meta"], lowestLevel: null }] })
		try {
			const diagnostics = openDiagnostics({ runIdentity: "run-16", commandIdentity: "msb-workflow.bind", stateHome: root })
			expect(() => diagnostics.log("a")).not.toThrow()
			expect(() => getLogger(["logtape", "meta"]).warning("meta failure observed")).not.toThrow()
			const status = diagnostics.dispose()
			expect(status).toEqual({ file: runFile(root, "run-16"), written: 0, dropped: 1, refused: 0, failure: "log: ConfigError", closed: true })
			expect(readFileSync(runFile(root, "run-16"), "utf8")).toBe("")
		} finally {
			resetSync()
		}
		const recovered = openDiagnostics({ runIdentity: "run-16b", commandIdentity: "msb-workflow.bind", stateHome: root })
		recovered.log("b")
		expect(recovered.dispose()).toMatchObject({ written: 1, failure: null })
	})
})

describe("openDiagnostics stderr sink (human mode, decision D2)", () => {
	test("writes only warning-level and above lines to the caller's writer, opens no file, and redacts by key and known value", () => {
		const root = stateHome()
		const lines: string[] = []
		const diagnostics = openDiagnostics({ runIdentity: "run-30", commandIdentity: "msb-workflow.bind", stateHome: root, sink: "stderr", writeStderr: (text) => lines.push(text), knownSecretValues: ["KNOWN_VALUE"] })
		diagnostics.log("quiet.info", { detail: "never shown" })
		diagnostics.log("loud.warning", { level: "warning", token: "tok-1", note: "carries KNOWN_VALUE" })
		diagnostics.log("loud.error", { level: "error" })
		const status = diagnostics.dispose()
		expect(status).toEqual({ file: null, written: 2, dropped: 0, refused: 0, failure: null, closed: true })
		expect(existsSync(diagnosticsDirectory(root))).toBe(false)
		expect(lines).toHaveLength(2)
		const parsed = lines.map((text) => JSON.parse(text) as Record<string, unknown>)
		expect(parsed.map((record) => [record.eventKind, record.level, record.runIdentity])).toEqual([
			["loud.warning", "WARN", "run-30"],
			["loud.error", "ERROR", "run-30"],
		])
		expect(line(parsed, 0)).toMatchObject({ token: "[REDACTED]", note: "carries [REDACTED]" })
		expect(lines.join("")).not.toContain("never shown")
		expect(lines.join("")).not.toContain("tok-1")
		expect(lines.join("")).not.toContain("KNOWN_VALUE")
	})

	test("a throwing stderr writer is a contained write failure that never reaches the caller", () => {
		const root = stateHome()
		const diagnostics = openDiagnostics({
			runIdentity: "run-31",
			commandIdentity: "msb-workflow.bind",
			stateHome: root,
			sink: "stderr",
			writeStderr: () => {
				throw new Error("EPIPE")
			},
		})
		expect(() => diagnostics.log("loud", { level: "warning" })).not.toThrow()
		expect(diagnostics.dispose()).toMatchObject({ file: null, written: 0, dropped: 1, closed: true })
	})
})

describe("openDiagnostics root discipline", () => {
	// Every case below hands the module an unusable root; the module must open nothing, write nothing, and never try
	// another root. The filesystem is read back independently after each attempt.
	test.each([
		["empty", () => ""],
		["relative", () => "relative-state"],
		["missing", (root: string) => join(root, "absent")],
		["symbolic link", (root: string) => join(root, "state-link")],
		["regular file", (root: string) => join(root, "state-file")],
	] as const)("an %s root opens no file, creates nothing, and is reported as open: ROOT_UNSAFE", (_label, configured) => {
		const root = stateHome()
		const state = join(root, "state")
		mkdirSync(state, { mode: 0o700 })
		symlinkSync(state, join(root, "state-link"))
		writeFileSync(join(root, "state-file"), "", { mode: 0o600 })
		const before = readdirSync(root).sort()
		const diagnostics = openDiagnostics({ runIdentity: "run-20", commandIdentity: "msb-workflow.bind", stateHome: configured(root) })
		diagnostics.log("a")
		const status = diagnostics.dispose()
		expect(status).toEqual({ file: null, written: 0, dropped: 1, refused: 0, failure: "open: ROOT_UNSAFE", closed: true })
		expect(readdirSync(root).sort()).toEqual(before)
		expect(readdirSync(state)).toEqual([])
		expect(existsSync(join(pluginRoot, "relative-state"))).toBe(false)
		expect(existsSync(join(pluginRoot, "my-second-brain-playground"))).toBe(false)
	})

	test("a broad-mode root is the operator's and is accepted; every helper descendant is created 0700 (decision D3)", () => {
		const root = stateHome()
		const broad = join(root, "broad")
		mkdirSync(broad, { mode: 0o755 })
		const diagnostics = openDiagnostics({ runIdentity: "run-24", commandIdentity: "msb-workflow.bind", stateHome: broad })
		diagnostics.log("a")
		expect(diagnostics.dispose()).toMatchObject({ file: runFile(broad, "run-24"), written: 1, failure: null })
		expect(statSync(broad).mode & 0o777).toBe(0o755)
		for (const directory of [join(broad, "my-second-brain-playground"), join(broad, "my-second-brain-playground", "workflow-cli"), diagnosticsDirectory(broad)]) expect(statSync(directory).mode & 0o777).toBe(0o700)
	})

	test("a root owned by another user is refused without a write (Darwin: /private/var/root is root-owned)", () => {
		// Darwin-only observation: a foreign-owned directory cannot be created without privileges, so the platform's own
		// directory is used. Elsewhere the ownership refusal is unproved by this file.
		if (process.platform !== "darwin") return
		const diagnostics = openDiagnostics({ runIdentity: "run-21", commandIdentity: "msb-workflow.bind", stateHome: "/private/var/root" })
		diagnostics.log("a")
		expect(diagnostics.dispose()).toEqual({ file: null, written: 0, dropped: 1, refused: 0, failure: "open: ROOT_UNSAFE", closed: true })
	})

	test("a symbolic link at an intermediate segment under a valid root is refused and never followed", () => {
		const root = stateHome()
		const elsewhere = join(root, "elsewhere")
		const state = join(root, "state")
		mkdirSync(elsewhere, { mode: 0o700 })
		mkdirSync(state, { mode: 0o700 })
		symlinkSync(elsewhere, join(state, "my-second-brain-playground"))
		const diagnostics = openDiagnostics({ runIdentity: "run-22", commandIdentity: "msb-workflow.bind", stateHome: state })
		diagnostics.log("a")
		expect(diagnostics.dispose()).toEqual({ file: null, written: 0, dropped: 1, refused: 0, failure: "open: ELOOP", closed: true })
		expect(readdirSync(elsewhere)).toEqual([])
	})

	test("a reused intermediate directory with a broad mode is refused and left exactly as found (accepted L2 repair)", () => {
		const root = stateHome()
		const intermediate = join(root, "my-second-brain-playground")
		mkdirSync(intermediate, { mode: 0o755 })
		const diagnostics = openDiagnostics({ runIdentity: "run-23", commandIdentity: "msb-workflow.bind", stateHome: root })
		diagnostics.log("a")
		expect(diagnostics.dispose()).toEqual({ file: null, written: 0, dropped: 1, refused: 0, failure: "open: EMODE", closed: true })
		expect(statSync(intermediate).mode & 0o777).toBe(0o755)
		expect(readdirSync(intermediate)).toEqual([])
	})
})

describe("openDiagnostics process boundary", () => {
	function canaryScript(runIdentity: string, stateHome: string): string {
		return [
			`import { openDiagnostics } from ${JSON.stringify(modulePath)}`,
			`const diagnostics = openDiagnostics({ runIdentity: ${JSON.stringify(runIdentity)}, commandIdentity: "msb-workflow.inspect", stateHome: ${JSON.stringify(stateHome)} })`,
			`diagnostics.log("canary", { token: "tok-canary", stationId: "inspected" })`,
			"diagnostics.flush()",
			"diagnostics.dispose()",
			"",
		].join("\n")
	}

	function spawnCanary(root: string, runIdentity: string, stateHome: string, env: Record<string, string | undefined>): { exitCode: number; stdout: string; stderr: string } {
		const script = join(root, `${runIdentity}.ts`)
		writeFileSync(script, canaryScript(runIdentity, stateHome))
		const result = Bun.spawnSync(["bun", "run", script], { cwd: pluginRoot, env, stdout: "pipe", stderr: "pipe" })
		return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
	}

	test("a real process writes nothing to stdout or stderr and uses only the supplied root, whatever the environment names", () => {
		const root = stateHome()
		const supplied = join(root, "supplied")
		mkdirSync(supplied, { mode: 0o700 })
		const result = spawnCanary(root, "run-14", supplied, { ...process.env, MSB_WORKFLOW_STATE_HOME: join(root, "env-msb"), XDG_STATE_HOME: join(root, "env-xdg"), HOME: root })
		expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" })
		const lines = records(runFile(supplied, "run-14"))
		expect(lines).toHaveLength(1)
		expect(line(lines, 0)).toMatchObject({ runIdentity: "run-14", commandIdentity: "msb-workflow.inspect", token: "[REDACTED]", stationId: "inspected" })
		expect(readFileSync(runFile(supplied, "run-14"), "utf8").includes("tok-canary")).toBe(false)
		expect(existsSync(join(root, "env-msb"))).toBe(false)
		expect(existsSync(join(root, "env-xdg"))).toBe(false)
		expect(existsSync(join(root, ".local"))).toBe(false)
	})

	test("a real process given an unusable root falls back to nothing: no file under the root, the environment roots, or $HOME", () => {
		const root = stateHome()
		const target = join(root, "target")
		mkdirSync(target, { mode: 0o700 })
		symlinkSync(target, join(root, "state-link"))
		const result = spawnCanary(root, "run-15", join(root, "state-link"), { ...process.env, MSB_WORKFLOW_STATE_HOME: join(root, "env-msb"), XDG_STATE_HOME: join(root, "env-xdg"), HOME: root })
		expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" })
		expect(readdirSync(target)).toEqual([])
		// Bun itself may create ~/Library under a redirected HOME; the module's roots are what must stay absent.
		for (const absent of ["env-msb", "env-xdg", ".local", "my-second-brain-playground"]) expect(existsSync(join(root, absent))).toBe(false)
	})
})
