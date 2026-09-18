import { afterEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { acquireLock, lockPath, ownerIsLive, releaseLock } from "../../src/integration-lock.ts"
import { createRuntime } from "../../src/runtime.ts"

// Lock liveness and grace (CONTRACT.md 2.7): expected verdicts are literals from the inventoried rules.

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function commonDirectory(): string {
	const root = mkdtempSync(join(tmpdir(), "vault-steward-lock-"))
	roots.push(root)
	return root
}

function age(path: string, seconds: number): void {
	const past = new Date(Date.now() - seconds * 1_000)
	utimesSync(path, past, past)
}

test("a missing lock is dead; a live owner pid is live; a dead pid is dead", () => {
	const rt = createRuntime()
	const common = commonDirectory()
	const lock = lockPath(common)
	expect(ownerIsLive(rt, lock)).toBe(false)
	mkdirSync(lock)
	writeFileSync(join(lock, "owner.json"), JSON.stringify({ schemaVersion: 1, runId: "x", pid: process.pid }))
	expect(ownerIsLive(rt, lock)).toBe(true)
	writeFileSync(join(lock, "owner.json"), JSON.stringify({ schemaVersion: 1, runId: "x", pid: 2_147_483_646 }))
	expect(ownerIsLive(rt, lock)).toBe(false)
})

test("a missing, malformed, or non-positive owner is live only within the one-second grace period", () => {
	const rt = createRuntime()
	for (const owner of [undefined, "{", JSON.stringify({ pid: 0 }), JSON.stringify({ pid: "7" })]) {
		const common = commonDirectory()
		const lock = lockPath(common)
		mkdirSync(lock)
		if (owner !== undefined) writeFileSync(join(lock, "owner.json"), owner)
		expect(ownerIsLive(rt, lock)).toBe(true)
		age(lock, 60)
		if (owner !== undefined) age(join(lock, "owner.json"), 60)
		expect(ownerIsLive(rt, lock)).toBe(false)
	}
})

test("an unreadable present owner stays live after the grace period", () => {
	const rt = createRuntime()
	const common = commonDirectory()
	const lock = lockPath(common)
	mkdirSync(join(lock, "owner.json"), { recursive: true })
	age(lock, 60)
	age(join(lock, "owner.json"), 60)
	expect(ownerIsLive(rt, lock)).toBe(true)
})

const lockModule = resolve(import.meta.dir, "../../src/integration-lock.ts")
const runtimeModule = resolve(import.meta.dir, "../../src/runtime.ts")
const faultsModule = resolve(import.meta.dir, "../../src/faults.ts")
const lockContender = `
const { acquireLock, releaseLock } = await import(${JSON.stringify(lockModule)})
const { createRuntime } = await import(${JSON.stringify(runtimeModule)})
const { parseFaults, withFaults } = await import(${JSON.stringify(faultsModule)})
const faults = parseFaults(process.env.VAULT_STEWARD_FAULT) ?? []
const lock = acquireLock(withFaults(createRuntime(), faults), process.env.LOCK_TEST_COMMON, "worker-" + process.pid)
if (lock === null) process.exit(20)
releaseLock(lock)
console.log("acquired")
`

async function waitForOwner(path: string): Promise<void> {
	const deadline = Date.now() + 10_000
	while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(20)
	expect(existsSync(path)).toBe(true)
}

test("acquire creates the directory with its owner, observes a fault-held live owner, and reclaims a dead one", async () => {
	const rt = createRuntime()
	const common = commonDirectory()
	const lock = acquireLock(rt, common, "vnc-run")
	expect(lock).toBe(lockPath(common))
	expect(JSON.parse(rt.readText(join(lockPath(common), "owner.json")))).toEqual({ schemaVersion: 1, runId: "vnc-run", pid: process.pid })
	releaseLock(lockPath(common))
	const holder = Bun.spawn([process.execPath, "-e", lockContender], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, LOCK_TEST_COMMON: common, VAULT_STEWARD_FAULT: "pause=lock-held:1200" } })
	// The holder's published owner is the ordering witness; the 10-s wait only bounds a hung child process.
	await waitForOwner(join(lockPath(common), "owner.json"))
	const contender = Bun.spawn([process.execPath, "-e", lockContender], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, LOCK_TEST_COMMON: common } })
	expect(await holder.exited).toBe(0)
	expect(await contender.exited).toBe(0)
	mkdirSync(lockPath(common))
	writeFileSync(join(lockPath(common), "owner.json"), JSON.stringify({ schemaVersion: 1, runId: "gone", pid: 2_147_483_646 }))
	expect(acquireLock(rt, common, "vnc-third")).toBe(lockPath(common))
	// The reclaim mutex is removed before the new owner is published, and the renamed dead lock leaves no residue.
	expect(readdirSync(common).filter((name) => name.includes(".reclaim"))).toEqual([])
	releaseLock(lockPath(common))
	expect(ownerIsLive(rt, lockPath(common))).toBe(false)
}, 15_000)

test("a fresh reclaim mutex makes a dead lock busy, while a stale mutex is reclaimed before the dead lock", () => {
	const rt = createRuntime()
	const common = commonDirectory()
	const lock = lockPath(common)
	mkdirSync(lock)
	writeFileSync(join(lock, "owner.json"), JSON.stringify({ schemaVersion: 1, runId: "gone", pid: 2_147_483_646 }))
	mkdirSync(`${lock}.reclaim`)
	const started = Date.now()
	expect(acquireLock(rt, common, "fresh-mutex")).toBeNull()
	const elapsed = Date.now() - started
	expect(elapsed).toBeGreaterThanOrEqual(1_900)
	expect(elapsed).toBeLessThan(4_000)
	expect(readdirSync(common).sort()).toEqual(["vault-note-commits.lock", "vault-note-commits.lock.reclaim"])
	age(`${lock}.reclaim`, 15)
	expect(acquireLock(rt, common, "stale-mutex")).toBe(lock)
	expect(readdirSync(common).filter((name) => name.includes(".reclaim"))).toEqual([])
}, 15_000)

test("a lock whose owner cannot be read for any reason other than absence stays live (review finding 3)", () => {
	const rt = createRuntime()
	const common = commonDirectory()
	const lock = lockPath(common)
	mkdirSync(lock)
	writeFileSync(join(lock, "owner.json"), JSON.stringify({ schemaVersion: 1, runId: "x", pid: 2_147_483_646 }))
	age(lock, 60)
	age(join(lock, "owner.json"), 60)
	// The dead owner is reclaimable while readable, but an unreadable lock directory (EACCES on lstat of its child) is live.
	expect(ownerIsLive(rt, lock)).toBe(false)
	chmodSync(lock, 0o000)
	try {
		expect(rt.fileFacts(join(lock, "owner.json")).errorCode).toBe("EACCES")
		expect(ownerIsLive(rt, lock)).toBe(true)
	} finally {
		chmodSync(lock, 0o700)
	}
	expect(rt.fileFacts(join(common, "absent")).errorCode).toBe("ENOENT")
	expect(ownerIsLive(rt, join(common, "absent"))).toBe(false)
})
