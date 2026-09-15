import { createHash } from "node:crypto"
import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createRoot, MAIN, readState, removeRoot, RESET_RESOURCE, REVISION_5_RESOURCE, type Root, type Run } from "../helpers/harness.ts"

// O2 approved public seam. Every expected cap/mode/exit/status is a test-owned literal, not a production import.
const PRELOAD = resolve(import.meta.dir, "../helpers/diagnostics-preload.ts")
const roots: Root[] = []
const children: ReturnType<typeof Bun.spawn>[] = []
function fresh(variant: Parameters<typeof createRoot>[0] = "healthy"): Root { const root = createRoot(variant); roots.push(root); return root }
afterEach(async () => {
	for (const child of children.splice(0)) { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited }
	for (const root of roots.splice(0)) removeRoot(root)
})
function directory(root: Root): string { return join(root.privateRoot, "state", "repair-lab", "diagnostics") }
function files(root: Root): string[] { return existsSync(directory(root)) ? readdirSync(directory(root)).filter((name) => name.endsWith(".jsonl")).map((name) => join(directory(root), name)) : [] }
function allBytes(root: Root): string { return files(root).map((file) => statSync(file).isFile() ? readFileSync(file, "utf8") : "").join("") }
function directorySnapshot(root: Root): unknown[] {
	return files(root).map((file) => { const info = statSync(file); return { file, size: info.size, mode: info.mode & 0o777, bytes: info.isFile() ? readFileSync(file, "utf8") : null } })
}
function caps(root: Root): void { const logs = files(root); expect(logs.length).toBeLessThanOrEqual(50); expect(logs.reduce((sum, file) => sum + statSync(file).size, 0)).toBeLessThanOrEqual(10_000_000) }
function start(root: Root, options: { mode?: string; env?: Record<string, string>; args?: string[] } = {}) {
	const env = { PATH: process.env.PATH ?? "", HOME: root.privateRoot, XDG_STATE_HOME: join(root.privateRoot, "state"), O2_CONTROL: root.privateRoot, NO_COLOR: "1", ...options.env }
	const command = options.mode === undefined ? [process.execPath, MAIN] : [process.execPath, "--preload", PRELOAD, MAIN]
	const child = Bun.spawn([...command, ...(options.args ?? ["inspect", "--json"])], { cwd: root.root, env: { ...env, ...(options.mode === undefined ? {} : { O2_MODE: options.mode }) }, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
	children.push(child)
	const result = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).then(([stdout, stderr, exit]): Run => {
		const observed = { stdout, stderr, exit, signal: child.signalCode }
		const receipts = process.env.O2_RECEIPTS
		if (receipts) {
			mkdirSync(receipts, { recursive: true, mode: 0o700 })
			writeFileSync(join(receipts, `${child.pid}.json`), `${JSON.stringify({ ...observed, mode: options.mode ?? null, command: options.args?.[0] ?? "inspect", diagnosticsFault: options.env?.REPAIR_LAB_FAULT ?? null, writeMode: options.env?.O2_WRITE_MODE ?? null, homeUnset: options.env?.HOME === "", xdgUnset: options.env?.XDG_STATE_HOME === "", resourceSha256: createHash("sha256").update(readState(root).resource).digest("hex"), diagnostics: directorySnapshot(root) })}\n`, { mode: 0o600 })
		}
		return observed
	})
	return { child, result }
}
async function run(root: Root, options: Parameters<typeof start>[1] = {}): Promise<Run> { return start(root, options).result }
function envelope(run: Run): { result: Record<string, unknown>; diagnostics: Record<string, unknown> } {
	expect(run.stderr).toBe("")
	expect(run.stdout.split("\n")).toHaveLength(2)
	return JSON.parse(run.stdout)
}
function domain(run: Run): unknown { const parsed = JSON.parse(run.stdout); delete parsed.diagnostics; return JSON.parse(JSON.stringify(parsed).split(parsed.result.runId).join("run-NORMALIZED")) }
async function ready(root: Root, count = 1): Promise<void> {
	const deadline = performance.now() + 1500
	while (readdirSync(root.privateRoot).filter((name) => name.startsWith("ready-")).length < count) {
		if (performance.now() > deadline) throw new Error("child never reached the diagnostic write barrier")
		await Bun.sleep(2)
	}
}
function seed(root: Root, name: string, bytes: number, closed: boolean, ageDays = 0): string {
	mkdirSync(directory(root), { recursive: true, mode: 0o700 })
	const file = join(directory(root), `${name}.jsonl`)
	writeFileSync(file, "x".repeat(bytes), { mode: 0o600 })
	const date = new Date(Date.now() - ageDays * 86_400_000)
	utimesSync(file, date, date)
	if (closed) {
		// Independently close/write/read the fixture, then bind the explicit closure proof to its observed inode.
		const info = statSync(file)
		mkdirSync(`${file}.closed-${info.dev}-${info.ino}-${info.size}-${info.mtimeMs}`, { mode: 0o700 })
	}
	return file
}

async function signalCase(root: Root, args: string[], availability: string, signal: "SIGINT" | "SIGTERM"): Promise<void> {
	const before = readState(root)
	const env: Record<string, string> = availability === "unavailable" ? { XDG_STATE_HOME: "", HOME: "" } : availability === "dropped" ? { REPAIR_LAB_FAULT: "diagnostics-flood" } : availability === "unflushed" ? { O2_WRITE_MODE: "stuck" } : {}
	const child = start(root, { mode: "signal-ready", env, args })
	await ready(root)
	const started = performance.now()
	child.child.kill(signal)
	const observed = await child.result
	expect(performance.now() - started).toBeLessThan(650)
	expect(observed.exit).toBe(signal === "SIGINT" ? 130 : 143)
	expect(observed.stdout + observed.stderr).toBe("")
	expect(readState(root)).toEqual(before)
	if (availability === "unavailable") expect(files(root)).toHaveLength(0)
	else expect(files(root)).toHaveLength(1)
	if (availability === "unflushed") expect(allBytes(root)).toBe("")
}

describe("O2 diagnostics custody process", () => {
	test("XDG path is disclosed, missing parents are private, and target-tree log override is ignored", async () => {
		const root = fresh()
		const observed = envelope(await run(root, { env: { REPAIR_LAB_LOG_FILE: join(root.root, "override.jsonl") } }))
		const file = observed.diagnostics.file as string
		expect(file.startsWith(`${directory(root)}/run-`)).toBe(true)
		expect(statSync(directory(root)).mode & 0o777).toBe(0o700)
		expect(statSync(file).mode & 0o777).toBe(0o600)
		expect(existsSync(join(root.root, "override.jsonl"))).toBe(false)
		expect(existsSync(join(root.root, "diagnostics"))).toBe(false)
		expect(readState(root).resource).toBe(RESET_RESOURCE)
	})
	test("unset or relative XDG selects HOME fallback; unset HOME and XDG reports unavailable", async () => {
		for (const xdg of ["", "relative"]) {
			const root = fresh()
			const observed = envelope(await run(root, { env: { XDG_STATE_HOME: xdg } }))
			expect(String(observed.diagnostics.file).startsWith(join(root.privateRoot, ".local", "state", "repair-lab", "diagnostics"))).toBe(true)
		}
		const root = fresh()
		const observed = await run(root, { env: { XDG_STATE_HOME: "", HOME: "" } })
		expect(observed.exit).toBe(0)
		expect(envelope(observed).diagnostics).toEqual({ status: "unavailable", reason: "status-unavailable", trusted: { file: null, sinkFailure: "setup" } })
	})
	test("EACCES, ENOSPC, symlink and untrusted ancestor preserve exact domain state", async () => {
		const baseline = await run(fresh())
		for (const mode of ["eacces", "enospc", "symlink", "ancestor"]) {
			const root = fresh()
			const state = join(root.privateRoot, "state")
			if (mode === "eacces") { mkdirSync(state); chmodSync(state, 0o500) }
			if (mode === "ancestor") { mkdirSync(state); chmodSync(state, 0o777) }
			if (mode === "symlink") { mkdirSync(join(root.privateRoot, "outside")); symlinkSync(join(root.privateRoot, "outside"), state) }
			const observed = await run(root, mode === "enospc" ? { mode } : {})
			expect(observed.exit).toBe(0)
			expect(envelope(observed).diagnostics.status).toBe("unavailable")
			expect(domain(observed)).toEqual(domain(baseline))
			expect(readState(root).resource).toBe(RESET_RESOURCE)
			if (mode === "eacces") chmodSync(state, 0o700)
		}
	})
	test("descriptor custody contains a final-path replacement without opening the replacement", async () => {
		const root = fresh()
		writeFileSync(join(root.privateRoot, "sentinel"), "sentinel\n")
		const observed = await run(root, { mode: "replace" })
		expect(observed.exit).toBe(0)
		expect(envelope(observed).diagnostics.sinkFailure).toBe("close")
		expect(readFileSync(join(root.privateRoot, "sentinel"), "utf8")).toBe("sentinel\n")
		const owned = readdirSync(directory(root)).find((name) => name.endsWith(".owned"))
		expect(owned).toBeDefined()
		expect(readFileSync(join(directory(root), owned as string), "utf8")).toContain("inspect.completed")
	})
	test("pre-existing destination, final symlink and FIFO are refused without blocking or replacement", async () => {
		const baseline = await run(fresh())
		for (const mode of ["existing", "final-symlink", "fifo"]) {
			const root = fresh()
			writeFileSync(join(root.privateRoot, "sentinel"), "sentinel\n")
			const before = performance.now()
			const observed = await run(root, { mode })
			expect(performance.now() - before).toBeLessThan(850)
			expect(envelope(observed).diagnostics.status).toBe("unavailable")
			expect(domain(observed)).toEqual(domain(baseline))
			expect(readFileSync(join(root.privateRoot, "sentinel"), "utf8")).toBe("sentinel\n")
			if (mode === "existing") expect(readFileSync(files(root)[0] as string, "utf8")).toBe("existing bytes\n")
		}
	})
	test("two writers reserve at the aggregate byte threshold", async () => {
		const root = fresh()
		for (let index = 0; index < 9; index += 1) seed(root, `active-${index}`, 1_000_000, false)
		const left = start(root, { mode: "barrier" })
		await ready(root)
		const right = start(root, { mode: "barrier" })
		const refused = await Promise.race([left.result, right.result])
		expect(envelope(refused).diagnostics).toEqual({ status: "unavailable", reason: "status-unavailable", trusted: { file: null, sinkFailure: "capacity" } })
		caps(root)
		writeFileSync(join(root.privateRoot, "release"), "release\n")
		const results = await Promise.all([left.result, right.result])
		expect(results.map((item) => item.exit)).toEqual([0, 0])
		expect(domain(results[0] as Run)).toEqual(domain(results[1] as Run))
		expect(results.map((item) => envelope(item).diagnostics.status).sort()).toEqual(["available", "unavailable"])
		caps(root)
		expect(readState(root).resource).toBe(RESET_RESOURCE)
	})
	test("two pruners at 50 files preserve old active and ambiguous files", async () => {
		const root = fresh()
		const active = seed(root, "active", 10, false, 30)
		const ambiguous = seed(root, "ambiguous", 10, false, 30)
		for (let index = 0; index < 48; index += 1) seed(root, `closed-${index}`, 10, true)
		const left = start(root, { mode: "barrier" })
		await ready(root)
		const right = start(root, { mode: "barrier" })
		await ready(root, 2)
		caps(root)
		writeFileSync(join(root.privateRoot, "release"), "release\n")
		const results = await Promise.all([left.result, right.result])
		expect(results.map((result) => envelope(result).diagnostics.status)).toEqual(["available", "available"])
		for (const result of results) { expect(result.exit).toBe(0); expect(result.stderr).toBe("") }
		expect(results.some((result) => envelope(result).diagnostics.status === "available")).toBe(true)
		expect(files(root).filter((file) => file.includes("/closed-")).length).toBeLessThan(48)
		expect(domain(results[0] as Run)).toEqual(domain(results[1] as Run))
		expect(readFileSync(active, "utf8")).toBe("xxxxxxxxxx")
		expect(readFileSync(ambiguous, "utf8")).toBe("xxxxxxxxxx")
		caps(root)
	})
	test("retention prunes confirmed closed seven-day files and the oldest closed file when room is needed", async () => {
		const root = fresh()
		const old = seed(root, "old", 10, true, 8)
		const recent = seed(root, "recent", 10, true, 1)
		envelope(await run(root))
		expect(existsSync(old)).toBe(false)
		expect(existsSync(recent)).toBe(true)
		const full = fresh()
		const oldest = seed(full, "oldest", 1_000_000, true, 2)
		for (let index = 0; index < 9; index += 1) seed(full, `closed-${index}`, 1_000_000, true, 1)
		envelope(await run(full))
		expect(existsSync(oldest)).toBe(false)
		caps(full)
	})
	test("externally deleted logs do not accumulate orphaned closure bookkeeping", async () => {
		const root = fresh()
		const before = await run(root)
		const old = files(root)[0] as string
		unlinkSync(old)
		const after = await run(root)
		expect(domain(after)).toEqual(domain(before))
		expect(readdirSync(directory(root)).filter((name) => name.includes(".closed-"))).toHaveLength(1)
	})
	test("64,001-byte, free-text, encoded and over-depth record payloads are redacted and visibly truncated", async () => {
		const root = fresh()
		const marker = "O2_SYNTHETIC_SECRET_19371"
		const observed = await run(root, { mode: "hostile-record", env: { O2_SECRET: marker } })
		const diagnostics = envelope(observed).diagnostics
		expect(diagnostics.truncatedRecords).toBe(2)
		const surfaces = observed.stdout + observed.stderr + allBytes(root)
		expect(surfaces).not.toContain(marker)
		expect(surfaces).not.toContain(Buffer.from(marker).toString("base64"))
		expect(allBytes(root)).toContain('"truncated":true')
		for (const line of allBytes(root).trim().split("\n")) expect(Buffer.byteLength(`${line}\n`)).toBeLessThanOrEqual(64_000)
	})
	test("byte-first and record-first queue loss is disclosed without changing domain result", async () => {
		const baseline = await run(fresh())
		for (const options of [{ mode: "byte-flood" }, { env: { REPAIR_LAB_FAULT: "diagnostics-flood" } }]) {
			const root = fresh()
			const observed = await run(root, options)
			const status = envelope(observed).diagnostics
			expect(status.sinkFailure).toBe("capacity")
			expect(status.droppedRecords).toBeGreaterThan(0)
			const count = allBytes(root).trim().split("\n").length
			if (options.mode === "byte-flood") expect(count).toBeLessThan(200)
			else expect(count).toBe(256)
			expect(files(root).map((file) => statSync(file).size).every((size) => size <= 1_000_000)).toBe(true)
			expect(domain(observed)).toEqual(domain(baseline))
		}
	})
	test("throwing, stuck and late sink finalization freezes one unchanged result and bounded exit", async () => {
		const baseline = await run(fresh())
		for (const mode of ["throw", "stuck", "late"]) {
			const root = fresh()
			const before = performance.now()
			const observed = await run(root, mode === "throw" ? { env: { REPAIR_LAB_FAULT: "sink-throw" } } : { mode })
			expect(performance.now() - before).toBeLessThan(850)
			const status = envelope(observed).diagnostics
			expect(status.sinkFailure).toBe(mode === "throw" ? "write" : "flush-timeout")
			expect(status.unflushedRecords).toBe(2)
			expect(observed.exit).toBe(0)
			expect(domain(observed)).toEqual(domain(baseline))
			expect(readState(root).resource).toBe(RESET_RESOURCE)
		}
	})
	test("refusal and recovery failure remain exact with unavailable, dropped and unflushed diagnostics", async () => {
		for (const [variant, args, exit] of [["healthy", ["apply", "--json"], 3], ["unknown-after-partial", ["recover", "--json"], 3]] as const) {
			const baseline = await run(fresh(variant), { args: [...args] })
			for (const options of [{ env: { XDG_STATE_HOME: "", HOME: "" } }, { env: { REPAIR_LAB_FAULT: "diagnostics-flood" } }, { mode: "stuck" }]) {
				const root = fresh(variant)
				const before = readState(root)
				const observed = await run(root, { ...options, args: [...args] })
				expect(observed.exit).toBe(exit)
				expect(observed.stderr).toBe("")
				expect(domain(observed)).toEqual(domain(baseline))
				expect(readState(root)).toEqual(before)
			}
		}
	})
	test("sensitive argv, file and environment values stay absent from output and promoted receipts", async () => {
		const marker = "O2_PRIVATE_VALUE_78326"
		for (const args of [["apply", "--authorize", marker, "--json"], ["inspect", "--state", `../../${marker}`, "--json"], ["inspect", "--include-diagnostics", "--json"]]) {
			const root = fresh()
			const state = JSON.parse(RESET_RESOURCE)
			state.diagnostic_token = { free_text: marker, encoded: Buffer.from(marker).toString("base64") }
			writeFileSync(join(root.root, "state", "resource.json"), `${JSON.stringify(state)}\n`)
			const observed = await run(root, { args, env: { SYNTHETIC_SECRET: marker } })
			const receipt = JSON.stringify({ stdout: observed.stdout, stderr: observed.stderr, diagnostics: allBytes(root) })
			writeFileSync(join(root.privateRoot, "promoted-receipt.json"), receipt, { mode: 0o600 })
			expect(readFileSync(join(root.privateRoot, "promoted-receipt.json"), "utf8")).not.toContain(marker)
			expect(receipt).not.toContain(Buffer.from(marker).toString("base64"))
		}
	})
	for (const signal of ["SIGINT", "SIGTERM"] as const) test(`${signal} during diagnostics stops envelope emission and bounds shutdown`, async () => {
		const root = fresh()
		const child = start(root, { mode: "stuck" })
		await ready(root)
		const before = performance.now()
		child.child.kill(signal)
		const observed = await child.result
		expect(performance.now() - before).toBeLessThan(650)
		expect(observed.exit).toBe(signal === "SIGINT" ? 130 : 143)
		expect(observed.stdout).toBe("")
		expect(observed.stderr).toBe("")
		expect(readState(root).resource).toBe(RESET_RESOURCE)
	})
	test("signal non-interference covers success, refusal and recovery failure with every diagnostics availability", async () => {
		for (const [variant, args] of [["healthy", ["inspect", "--json"]], ["healthy", ["apply", "--json"]], ["unknown-after-partial", ["recover", "--json"]]] as const) {
			for (const availability of ["available", "unavailable", "dropped", "unflushed"]) {
				for (const signal of ["SIGINT", "SIGTERM"] as const) {
					await signalCase(fresh(variant), [...args], availability, signal)
				}
			}
		}
	}, 15_000)
	test("repeated termination exits immediately during a stuck diagnostic flush", async () => {
		const root = fresh()
		const child = start(root, { mode: "stuck" })
		await ready(root)
		child.child.kill("SIGINT")
		await Bun.sleep(20)
		const before = performance.now()
		child.child.kill("SIGTERM")
		const observed = await child.result
		expect(performance.now() - before).toBeLessThan(250)
		expect(observed.exit).toBe(143)
		expect(observed.stdout + observed.stderr).toBe("")
	})
})


describe("O2 review repairs", () => {
	test("invalid diagnostics preserve success, refusal, committed effects and recovery without fallback", async () => {
		const cases = [
			["healthy", ["inspect", "--json"], 0, RESET_RESOURCE],
			["healthy", ["apply", "--json"], 3, RESET_RESOURCE],
			["healthy-with-fresh-preview", ["apply", "--preview-id", "preview-healthy-revision-4", "--authorize", "fixture-authority", "--json"], 0, REVISION_5_RESOURCE],
			["unknown-after-partial", ["recover", "--json"], 3, REVISION_5_RESOURCE],
		] as const
		for (const [variant, args, exit, resource] of cases) {
			const baseline = await run(fresh(variant), { args: [...args] })
			const root = fresh(variant)
			const observed = await run(root, { mode: "invalid-status", args: [...args] })
			const decoded = envelope(observed)
			expect(observed.exit).toBe(exit)
			expect(domain(observed)).toEqual(domain(baseline))
			expect(readState(root).resource).toBe(resource)
			expect(decoded.diagnostics).toEqual({ status: "unavailable", reason: "status-invalid", trusted: { file: files(root)[0], sinkFailure: null, unflushedRecords: 0, truncatedRecords: 0, countsComplete: false, closed: true } })
		}
	})
	test("invalid diagnostics isolate corrupt fields and preserve independently trusted status fields", async () => {
		const baseline = await run(fresh())
		for (const corruption of ["unsafe-count", "wrong-boolean", "relative-path", "nonobject", "getter", "missing-count"]) {
			const root = fresh()
			const observed = await run(root, { mode: "invalid-status", env: { O2_CORRUPTION: corruption } })
			const decoded = envelope(observed)
			expect(observed.exit).toBe(0)
			expect(domain(observed)).toEqual(domain(baseline))
			expect(decoded.diagnostics.status).toBe("unavailable")
			expect(decoded.diagnostics.reason).toBe("status-invalid")
			const trusted = decoded.diagnostics.trusted as Record<string, unknown>
			if (corruption === "nonobject") expect(trusted).toEqual({})
			else expect(trusted).toMatchObject({ sinkFailure: null, unflushedRecords: 0, truncatedRecords: 0 })
			if (["unsafe-count", "getter", "missing-count"].includes(corruption)) { expect(trusted.droppedRecords).toBeUndefined(); expect(trusted.countsComplete).toBe(false); expect(trusted.file).toBe(files(root)[0]) }
			if (corruption === "wrong-boolean") { expect(trusted.closed).toBeUndefined(); expect(trusted.countsComplete).toBe(true) }
			if (corruption === "relative-path") { expect(trusted.file).toBeUndefined(); expect(trusted.closed).toBe(true) }
		}
	})
	test("first sink failure stays write when later records are dropped", async () => {
		const baseline = await run(fresh())
		const root = fresh()
		const observed = await run(root, { mode: "failure-then-drop" })
		expect(observed.exit).toBe(0)
		expect(domain(observed)).toEqual(domain(baseline))
		expect(envelope(observed).diagnostics).toEqual({ status: "available", file: files(root)[0], sinkFailure: "write", droppedRecords: 2, unflushedRecords: 1, truncatedRecords: 0, countsComplete: true, closed: true })
	})
	test("first sink failure stays capacity when write or timeout occurs later", async () => {
		const baseline = await run(fresh())
		const root = fresh()
		const observed = await run(root, { mode: "drop-then-failure", env: { REPAIR_LAB_FAULT: "diagnostics-flood" } })
		expect(domain(observed)).toEqual(domain(baseline))
		expect(envelope(observed).diagnostics).toEqual({ status: "available", file: files(root)[0], sinkFailure: "capacity", droppedRecords: 10, unflushedRecords: 256, truncatedRecords: 0, countsComplete: true, closed: true })
		const timed = await run(fresh(), { mode: "byte-flood", env: { O2_WRITE_MODE: "stuck" } })
		expect(domain(timed)).toEqual(domain(baseline))
		expect(envelope(timed).diagnostics.sinkFailure).toBe("capacity")
		expect(envelope(timed).diagnostics.unflushedRecords).toBeGreaterThan(0)
	})
})


describe("O2 diagnostics cross-field invariants", () => {
	test("diagnostics cross-field timeout closure preserves domain outcomes, effects and recovery", async () => {
		const cases = [
			["healthy", ["inspect", "--json"], 0, RESET_RESOURCE],
			["healthy", ["apply", "--json"], 3, RESET_RESOURCE],
			["healthy-with-fresh-preview", ["apply", "--preview-id", "preview-healthy-revision-4", "--authorize", "fixture-authority", "--json"], 0, REVISION_5_RESOURCE],
			["unknown-after-partial", ["recover", "--json"], 3, REVISION_5_RESOURCE],
		] as const
		for (const [variant, args, exit, resource] of cases) {
			const baseline = await run(fresh(variant), { args: [...args] })
			const root = fresh(variant)
			const observed = await run(root, { mode: "invalid-status", args: [...args], env: { O2_CORRUPTION: "timeout-closed", O2_WRITE_MODE: "stuck" } })
			expect(observed.exit).toBe(exit)
			expect(observed.stderr).toBe("")
			expect(domain(observed)).toEqual(domain(baseline))
			expect(readState(root).resource).toBe(resource)
			const status = envelope(observed).diagnostics
			expect(status.status).toBe("unavailable")
			expect(status.reason).toBe("status-invalid")
			expect(status.trusted).toMatchObject({ file: files(root)[0], droppedRecords: 0, truncatedRecords: 0, countsComplete: true })
			const trusted = status.trusted as Record<string, unknown>
			expect(trusted.unflushedRecords).toBeGreaterThan(0)
			expect(trusted.closed).toBeUndefined()
			expect(trusted.sinkFailure).toBeUndefined()
		}
	}, 15_000)
	test("diagnostics cross-field loss contradictions retain only independently trusted accounting", async () => {
		const baseline = await run(fresh())
		for (const corruption of ["timeout-empty-count", "drops-without-failure", "unflushed-without-failure"]) {
			const root = fresh()
			const timed = corruption === "timeout-empty-count"
			const observed = await run(root, { mode: "invalid-status", env: { O2_CORRUPTION: corruption, ...(timed ? { O2_WRITE_MODE: "stuck" } : {}) } })
			expect(observed.exit).toBe(0)
			expect(observed.stderr).toBe("")
			expect(domain(observed)).toEqual(domain(baseline))
			expect(readState(root).resource).toBe(RESET_RESOURCE)
			const status = envelope(observed).diagnostics
			expect(status.status).toBe("unavailable")
			expect(status.reason).toBe("status-invalid")
			expect(status.trusted).toEqual({ file: files(root)[0], ...(corruption === "drops-without-failure" ? { unflushedRecords: 0 } : { droppedRecords: 0 }), truncatedRecords: 0, countsComplete: false, closed: !timed })
		}
	})
})
