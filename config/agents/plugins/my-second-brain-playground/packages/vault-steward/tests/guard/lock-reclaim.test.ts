import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { lockPath } from "../../src/integration-lock.ts"

// These are real Bun processes rather than shared-runtime calls: stale reclaim is a filesystem interleaving contract.
setDefaultTimeout(60_000)
const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const lockModule = resolve(import.meta.dir, "../../src/integration-lock.ts")
const runtimeModule = resolve(import.meta.dir, "../../src/runtime.ts")
const faultsModule = resolve(import.meta.dir, "../../src/faults.ts")

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "vault-steward-reclaim-"))
	roots.push(value)
	return value
}

function deadLock(common: string): string {
	const lock = lockPath(common)
	mkdirSync(lock)
	writeFileSync(join(lock, "owner.json"), JSON.stringify({ schemaVersion: 1, runId: "dead", pid: 2_147_483_646 }))
	return lock
}

const contender = `
const { acquireLock, releaseLock } = await import(${JSON.stringify(lockModule)})
const { createRuntime } = await import(${JSON.stringify(runtimeModule)})
const { parseFaults, withFaults } = await import(${JSON.stringify(faultsModule)})
const { existsSync, mkdirSync, rmdirSync } = await import("node:fs")
const pause = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
const faults = parseFaults(process.env.VAULT_STEWARD_FAULT)
const rt = faults === null ? createRuntime() : withFaults(createRuntime(), faults)
const lock = acquireLock(rt, process.env.LOCK_TEST_COMMON, "contender-" + process.pid)
if (lock === null) process.exit(20)
if (process.env.LOCK_TEST_A_MARKER && existsSync(process.env.LOCK_TEST_A_MARKER)) process.exit(31)
if (process.env.LOCK_TEST_MARKER) {
  try { mkdirSync(process.env.LOCK_TEST_MARKER) } catch { process.exit(32) }
}
pause(Number(process.env.LOCK_TEST_HOLD_MS || "20"))
if (process.env.LOCK_TEST_MARKER) rmdirSync(process.env.LOCK_TEST_MARKER)
releaseLock(lock)
console.log("held")
`

function spawn(common: string, extra: Record<string, string> = {}) {
	return Bun.spawn([process.execPath, "-e", contender], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, LOCK_TEST_COMMON: common, ...extra },
	})
}

async function outcome(child: ReturnType<typeof spawn>): Promise<{ exitCode: number; stderr: string }> {
	const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
	return { exitCode, stderr }
}

async function waitForPath(path: string): Promise<void> {
	const deadline = Date.now() + 10_000
	while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(10)
	expect(existsSync(path)).toBe(true)
}

test("a paused stale juror rechecks the owner under the reclaim mutex and acquires only after the reclaimer releases", async () => {
	const common = root()
	const lock = deadLock(common)
	const holding = join(common, "a-holding")
	const release = join(common, "release")
	const b = spawn(common, { VAULT_STEWARD_FAULT: `barrier=lock-judged:${join(lock, "owner.json")}`, LOCK_TEST_A_MARKER: holding, LOCK_TEST_HOLD_MS: "10" })
	const a = spawn(common, { VAULT_STEWARD_FAULT: `barrier=lock-held:${release}`, LOCK_TEST_MARKER: holding, LOCK_TEST_HOLD_MS: "20" })
	// A's owner record is published before its lock-held barrier. B cannot leave lock-judged until that publication; the 10-s wait only bounds a hung child.
	await waitForPath(join(lock, "owner.json"))
	writeFileSync(release, "release\n")
	const [aResult, bResult] = await Promise.all([outcome(a), outcome(b)])
	expect(aResult).toEqual({ exitCode: 0, stderr: "" })
	expect(bResult).toEqual({ exitCode: 0, stderr: "" })
	expect(existsSync(lock)).toBe(false)
	expect(existsSync(`${lock}.reclaim`)).toBe(false)
})

test("twenty rounds of four stale-lock contenders have no double hold and no crash", async () => {
	let crashes = 0
	let doubleHolds = 0
	for (let round = 0; round < 20; round++) {
		const common = root()
		deadLock(common)
		const marker = join(common, "holding")
		const results = await Promise.all(Array.from({ length: 4 }, () => outcome(spawn(common, { LOCK_TEST_MARKER: marker }))))
		for (const result of results) {
			if (result.exitCode === 32) doubleHolds++
			else if (result.exitCode !== 0) crashes++
		}
	}
	expect({ doubleHolds, crashes }).toEqual({ doubleHolds: 0, crashes: 0 })
}, 60_000)
