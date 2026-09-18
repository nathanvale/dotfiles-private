import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

test("acquire creates the directory with its owner, refuses a live owner after about two seconds, and reclaims a dead one", () => {
	const rt = createRuntime()
	const common = commonDirectory()
	const lock = acquireLock(rt, common, "vnc-run")
	expect(lock).toBe(lockPath(common))
	expect(JSON.parse(rt.readText(join(lockPath(common), "owner.json")))).toEqual({ schemaVersion: 1, runId: "vnc-run", pid: process.pid })
	const started = Date.now()
	expect(acquireLock(rt, common, "vnc-second")).toBeNull()
	const elapsed = Date.now() - started
	expect(elapsed).toBeGreaterThanOrEqual(1_900)
	expect(elapsed).toBeLessThan(4_000)
	writeFileSync(join(lockPath(common), "owner.json"), JSON.stringify({ schemaVersion: 1, runId: "gone", pid: 2_147_483_646 }))
	expect(acquireLock(rt, common, "vnc-third")).toBe(lockPath(common))
	releaseLock(lockPath(common))
	expect(ownerIsLive(rt, lockPath(common))).toBe(false)
}, 15_000)
