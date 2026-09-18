// The integration lock directory `<git-common-dir>/vault-note-commits.lock` with its owner.json, liveness, and grace
// semantics. The lock name and layout are shared with every 0.12.x helper still in the field (CONTRACT.md 2.7).
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { invalidLockOwnerGraceMs, lockDirectoryName, schemaVersion } from "./model.ts"
import type { Runtime } from "./runtime.ts"

const lockAttempts = 81
const lockPauseMs = 25

function pause(milliseconds: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function withinGrace(rt: Runtime, modified: number): boolean {
	return rt.now() - modified < invalidLockOwnerGraceMs
}

function pidIsLive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH")
	}
}

// A lock is live when its owner process answers signal 0, when the owner file is unreadable, or when a missing or
// malformed owner is younger than the grace period (a fresh acquirer may not have published its pid yet).
export function ownerIsLive(rt: Runtime, lock: string): boolean {
	const directory = rt.fileFacts(lock)
	if (directory.kind === "missing") return false
	const ownerPath = join(lock, "owner.json")
	const owner = rt.fileFacts(ownerPath)
	const modified = Math.max(directory.mtimeMs, owner.mtimeMs)
	if (owner.kind === "missing") return withinGrace(rt, modified)
	let contents: string
	try {
		contents = rt.readText(ownerPath)
	} catch {
		return true
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(contents)
	} catch {
		return withinGrace(rt, modified)
	}
	const pid = typeof parsed === "object" && parsed !== null && "pid" in parsed ? parsed.pid : undefined
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return withinGrace(rt, modified)
	return pidIsLive(pid)
}

export function lockPath(commonGitDirectory: string): string {
	return join(commonGitDirectory, lockDirectoryName)
}

// One exclusive-create attempt: created, held by a live owner, or reclaimed from a dead one (and worth retrying at once).
function tryCreate(rt: Runtime, lock: string): "created" | "busy" | "reclaimed" {
	try {
		mkdirSync(lock, { mode: 0o700 })
		return "created"
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
	}
	if (!existsSync(lock) || ownerIsLive(rt, lock)) return "busy"
	rmSync(lock, { recursive: true, force: true })
	return "reclaimed"
}

function publishOwner(rt: Runtime, lock: string, runId: string): void {
	try {
		rt.writePrivateText(join(lock, "owner.json"), `${JSON.stringify({ schemaVersion, runId, pid: rt.pid })}\n`)
	} catch (error) {
		releaseLock(lock)
		throw error
	}
}

// Returns the lock directory once it is exclusively created, or null after about two seconds of a live owner.
export function acquireLock(rt: Runtime, commonGitDirectory: string, runId: string): string | null {
	const lock = lockPath(commonGitDirectory)
	for (let attempt = 0; attempt < lockAttempts; attempt++) {
		const outcome = tryCreate(rt, lock)
		if (outcome === "created") {
			publishOwner(rt, lock, runId)
			return lock
		}
		if (outcome === "busy" && attempt < lockAttempts - 1) pause(lockPauseMs)
	}
	return null
}

export function releaseLock(lock: string): void {
	rmSync(lock, { recursive: true, force: true })
}
