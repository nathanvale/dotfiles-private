import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { BEAD, bindingPath, createRoot, envelopeOf, type Holder, removeRoot, type Root, runCli, spawnLockHolder, stateListing } from "../fixtures/harness.ts"

// The admitted lock through real processes: the checker's holder takes a lock through the helper's own Lock Adapter,
// a competing bind refuses busy after the 2,000 ms bound, a holder killed with SIGKILL releases the lock to the next
// process, and the workspace lock is taken before the session lock. Expected causes, exits and delays are literals
// from Spec #57 and Ticket #58 criterion 4 (independent oracle).

const SESSION = "busy-session"
const LOCKS_PREFIX = "my-second-brain-playground/workflow-cli/locks/"

let root: Root
let holder: Holder | null = null

beforeEach(() => {
	root = createRoot()
})

afterEach(async () => {
	if (holder !== null) {
		holder.kill()
		await holder.exited
		holder = null
	}
	removeRoot(root)
})

const bindArgs = (session: string): string[] => ["bind", "--workspace", root.workspace, "--session", session, "--bead", BEAD, "--json"]

function expectBusy(stdout: string, exit: number): void {
	expect(exit).toBe(75)
	const envelope = envelopeOf({ stdout, stderr: "", exit })
	expect(envelope.causeCode).toBe("UNAVAILABLE_STORAGE_BUSY")
	expect(envelope.outcome).toBe("failed")
	expect(envelope.transactionState).toBe("unchanged")
	expect(envelope.retryable).toBe(true)
	expect(envelope.retryDelayMilliseconds).toBe(2000)
}

describe("the admitted flock Adapter across processes", () => {
	test("a held session lock makes bind refuse busy after the bounded wait, and SIGKILL on the holder releases it", async () => {
		holder = spawnLockHolder(root, SESSION)
		const lockPath = await holder.held
		expect(lockPath.endsWith(".lock")).toBe(true)
		expect(stateListing(root)).toContain(`${lockPath.slice(root.stateHome.length + 1)}:600`)
		const started = performance.now()
		const busy = await runCli(root, bindArgs(SESSION))
		const waited = performance.now() - started
		expect(busy.stderr).toBe("")
		expectBusy(busy.stdout, busy.exit)
		expect(waited).toBeGreaterThanOrEqual(2000)
		expect(existsSync(bindingPath(root, SESSION))).toBe(false)
		holder.kill("SIGKILL")
		await holder.exited
		holder = null
		const after = performance.now()
		const released = await runCli(root, bindArgs(SESSION))
		expect(released.exit).toBe(0)
		expect(performance.now() - after).toBeLessThan(2000)
		expect((JSON.parse(readFileSync(bindingPath(root, SESSION), "utf8")) as { beadId: string }).beadId).toBe(BEAD)
	})

	test("a held session lock does not block a different session in the same workspace", async () => {
		holder = spawnLockHolder(root, SESSION)
		await holder.held
		const other = await runCli(root, bindArgs("other-session"))
		expect(other.exit).toBe(0)
		expect(existsSync(bindingPath(root, "other-session"))).toBe(true)
	})

	test("the workspace lock is taken first: a held workspace lock refuses bind before the session lock file exists", async () => {
		holder = spawnLockHolder(root, SESSION, root.workspace)
		const lockPath = await holder.held
		expect(lockPath).toContain(`${LOCKS_PREFIX}workspaces/`)
		const busy = await runCli(root, bindArgs(SESSION))
		expectBusy(busy.stdout, busy.exit)
		const locks = stateListing(root).filter((entry) => entry.startsWith(LOCKS_PREFIX) && entry.endsWith(".lock:600"))
		expect(locks).toHaveLength(1)
		expect(locks[0]).toContain(`${LOCKS_PREFIX}workspaces/`)
		expect(stateListing(root).some((entry) => entry.startsWith(`${LOCKS_PREFIX}sessions/`) && entry.endsWith(".lock:600"))).toBe(false)
	})

	test("the holder refuses a refused state root instead of holding anything", async () => {
		const bad = spawnLockHolder({ ...root, stateHome: `${root.stateHome}-absent` }, SESSION)
		await expect(bad.held).rejects.toThrow(/state root refused/)
		expect(await bad.exited).toBe(2)
	})
})
