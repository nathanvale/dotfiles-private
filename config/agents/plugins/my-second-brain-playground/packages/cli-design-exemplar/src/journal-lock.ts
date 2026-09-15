import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// The held-lock refusal carries its accepted cause identity only; the wire guidance owner supplies every public word.
const LOCK_HELD_CAUSE = "DOMAIN_JOURNAL_LOCK_HELD"
export class JournalLockHeld extends Error {
	readonly causeCode = LOCK_HELD_CAUSE
	constructor() { super(LOCK_HELD_CAUSE) }
}

// Closed fixture-only barrier. Every child announces readiness before the one shared release; the owner then waits
// for a separate finish marker so the harness can observe the loser's bytes before any effect. Ten seconds is a test
// watchdog, never a lock lease or liveness judgement. No barrier is entered without the explicit closed fault token.
function barrier(directory: string, run: string, phase: "ready" | "claimed", release: string): void {
	mkdirSync(directory, { recursive: true, mode: 0o700 })
	writeFileSync(join(directory, `${run}.${phase}`), `${process.pid}\n`, { flag: "wx", mode: 0o600 })
	const deadline = performance.now() + 10_000
	const wait = new Int32Array(new SharedArrayBuffer(4))
	while (!existsSync(join(directory, release))) {
		if (performance.now() >= deadline) throw new Error("journal contention test barrier timed out")
		Atomics.wait(wait, 0, 0, 10)
	}
}

// A successful exclusive open is the only admission. The versioned token and inode must still match for normal
// release. PID and age never confer authority. Crash residue, malformed files, directories and final symlinks all
// refuse without reading or deleting the existing lock. Parent containment is admitted by the runtime immediately
// before this call; hostile ancestor/replacement races and power-loss persistence are outside this local fixture proof.
export function acquireJournalLock(stateDirectory: string, run: string, testBarrier: string | null): () => void {
	if (testBarrier !== null) barrier(testBarrier, run, "ready", "start")
	const path = join(stateDirectory, "journal.lock")
	mkdirSync(stateDirectory, { recursive: true })
	let fd: number
	try {
		fd = openSync(path, "wx", 0o600)
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") throw new JournalLockHeld()
		throw error
	}
	const owner = `${JSON.stringify({ lockVersion: 1, ownerToken: run, pid: process.pid })}\n`
	const inode = fstatSync(fd)
	// Initialization failure intentionally leaves conservative residue for inspection, never a stealable partial lock.
	try {
		writeFileSync(fd, owner)
		fsyncSync(fd)
	} finally {
		closeSync(fd)
	}
	const release = (): void => {
		try {
			const current = lstatSync(path)
			if (current.isFile() && current.dev === inode.dev && current.ino === inode.ino && readFileSync(path, "utf8") === owner) unlinkSync(path)
		} catch {
			// Missing, replaced or unreadable ownership is not ours to remove. Keep residue for manual inspection.
		}
	}
	try {
		if (testBarrier !== null) barrier(testBarrier, run, "claimed", "finish")
	} catch (error) {
		release()
		throw error
	}
	return release
}
