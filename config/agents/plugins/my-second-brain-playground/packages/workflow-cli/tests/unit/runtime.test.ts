import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LockFailure, lockAdapterFor } from "../../src/lock-adapter.ts"
import { atomicWritePrivate, readPrivateFile, RuntimeFailure, stateAddresses, withLocks, withSessionLock } from "../../src/runtime.ts"

// The Runtime and Lock Adapter contracts as literals (independent oracle): the fixed private addresses, the private
// read refusals, the atomic write's two failure classes, the unsupported Adapter's refusal before any effect, and
// the in-process behaviour of the admitted Darwin Adapter. Cross-process exclusion and SIGKILL release are proven in
// tests/integration/lock.test.ts.

let stateHome: string

beforeEach(() => {
	stateHome = realpathSync(mkdtempSync(join(tmpdir(), "msb-runtime-")))
})

afterEach(() => {
	rmSync(stateHome, { recursive: true, force: true })
})

const failure = (action: () => unknown): RuntimeFailure => {
	try {
		action()
	} catch (error) {
		if (error instanceof RuntimeFailure) return error
		throw error
	}
	throw new Error("expected a RuntimeFailure")
}

describe("stateAddresses", () => {
	test("keys bindings and markers by session under the fixed helper subtree and locks by a digest", () => {
		const addresses = stateAddresses("/state")
		expect(addresses.helper).toBe("/state/my-second-brain-playground/workflow-cli")
		expect(addresses.sessions).toBe("/state/my-second-brain-playground/workflow-cli/recovery/sessions")
		expect(addresses.diagnostics).toBe("/state/my-second-brain-playground/workflow-cli/diagnostics")
		expect(addresses.binding("s-1")).toBe("/state/my-second-brain-playground/workflow-cli/recovery/sessions/s-1.json")
		expect(addresses.marker("s-1")).toBe("/state/my-second-brain-playground/workflow-cli/recovery/sessions/s-1.marker.json")
		expect(addresses.workspaceLock("/ws")).toMatch(/^\/state\/my-second-brain-playground\/workflow-cli\/locks\/workspaces\/[0-9a-f]{32}\.lock$/)
		expect(addresses.sessionLock("s-1")).toMatch(/^\/state\/my-second-brain-playground\/workflow-cli\/locks\/sessions\/[0-9a-f]{32}\.lock$/)
		expect(addresses.sessionLock("s-1")).toBe(addresses.sessionLock("s-1"))
		expect(addresses.sessionLock("s-1")).not.toBe(addresses.sessionLock("s-2"))
		// The schema-v2 Python address is a sibling subtree the helper never names.
		expect(addresses.sessions.includes("/my-second-brain-playground/recovery/")).toBe(false)
	})
})

describe("atomicWritePrivate", () => {
	test("creates 0700 directories and a 0600 file, replaces it in place, and leaves no temporary file", () => {
		const path = stateAddresses(stateHome).binding("s-1")
		atomicWritePrivate(stateHome, path, "one\n")
		expect(readFileSync(path, "utf8")).toBe("one\n")
		expect(statSync(path).mode & 0o777).toBe(0o600)
		for (const directory of [join(stateHome, "my-second-brain-playground"), join(stateHome, "my-second-brain-playground", "workflow-cli"), stateAddresses(stateHome).sessions]) expect(statSync(directory).mode & 0o777).toBe(0o700)
		atomicWritePrivate(stateHome, path, "two\n")
		expect(readFileSync(path, "utf8")).toBe("two\n")
		expect(readdirSync(stateAddresses(stateHome).sessions)).toEqual(["s-1.json"])
	})

	test("a failure before the rename is unavailable, leaves the previous bytes, and cleans the temporary file", () => {
		const path = stateAddresses(stateHome).binding("s-1")
		atomicWritePrivate(stateHome, path, "one\n")
		const error = failure(() =>
			atomicWritePrivate(stateHome, path, "two\n", {
				beforeReplace: () => {
					throw new Error("disk full")
				},
			}),
		)
		expect(error.kind).toBe("unavailable")
		expect(readFileSync(path, "utf8")).toBe("one\n")
		expect(readdirSync(stateAddresses(stateHome).sessions)).toEqual(["s-1.json"])
	})

	test("a failure after the rename is uncertain and the new bytes are visible", () => {
		const path = stateAddresses(stateHome).binding("s-1")
		const error = failure(() =>
			atomicWritePrivate(stateHome, path, "two\n", {
				afterReplace: () => {
					throw new Error("fsync lost")
				},
			}),
		)
		expect(error.kind).toBe("uncertain")
		expect(readFileSync(path, "utf8")).toBe("two\n")
	})

	test.each([
		["a path outside the state root", () => join(tmpdir(), "outside.json"), /escaped the selected state root/],
		[
			"a symlinked target",
			() => {
				const sessions = stateAddresses(stateHome).sessions
				mkdirSync(sessions, { recursive: true, mode: 0o700 })
				writeFileSync(join(stateHome, "elsewhere"), "x", { mode: 0o600 })
				symlinkSync(join(stateHome, "elsewhere"), join(sessions, "s-1.json"))
				return join(sessions, "s-1.json")
			},
			/not a real regular file/,
		],
		[
			"a pre-existing 0755 ancestor",
			() => {
				mkdirSync(join(stateHome, "my-second-brain-playground"), { mode: 0o755 })
				return stateAddresses(stateHome).binding("s-1")
			},
			/must have mode 0700/,
		],
		[
			"an existing 0644 target",
			() => {
				const path = stateAddresses(stateHome).binding("s-1")
				atomicWritePrivate(stateHome, path, "one\n")
				chmodSync(path, 0o644)
				return path
			},
			/must have mode 0600/,
		],
	])("refuses %s as unsafe before writing", (_label, prepare, message) => {
		const path = prepare()
		const error = failure(() => atomicWritePrivate(stateHome, path, "bytes\n"))
		expect(error.kind).toBe("unsafe")
		expect(error.message).toMatch(message)
	})

	test("refuses a symlinked state root", () => {
		const link = join(tmpdir(), `msb-root-link-${process.pid}`)
		rmSync(link, { force: true })
		symlinkSync(stateHome, link)
		try {
			expect(failure(() => atomicWritePrivate(link, stateAddresses(link).binding("s-1"), "x\n")).kind).toBe("unsafe")
		} finally {
			rmSync(link, { force: true })
		}
	})
})

describe("readPrivateFile", () => {
	const write = (name: string, bytes: string, mode = 0o600): string => {
		const sessions = stateAddresses(stateHome).sessions
		mkdirSync(sessions, { recursive: true, mode: 0o700 })
		const path = join(sessions, name)
		writeFileSync(path, bytes, { mode })
		return path
	}

	test("returns the bytes of a 0600 regular file and null for an absent one", () => {
		const path = write("s-1.json", "{}\n")
		expect(readPrivateFile(path, 1024)?.toString("utf8")).toBe("{}\n")
		expect(readPrivateFile(join(stateAddresses(stateHome).sessions, "absent.json"), 1024)).toBeNull()
	})

	test.each([
		["a 0644 file", () => write("s-1.json", "{}\n", 0o644), /must have mode 0600/],
		[
			"a symlink",
			() => {
				const target = write("real.json", "{}\n")
				const link = join(stateAddresses(stateHome).sessions, "s-1.json")
				symlinkSync(target, link)
				return link
			},
			/not a real regular file/,
		],
		[
			"a file with two links",
			() => {
				const path = write("s-1.json", "{}\n")
				linkSync(path, join(stateAddresses(stateHome).sessions, "twin.json"))
				return path
			},
			/exactly one link/,
		],
		["a file over the bound", () => write("s-1.json", "x".repeat(2048)), /exceeds 1024 bytes/],
		[
			"a directory",
			() => {
				const path = join(stateAddresses(stateHome).sessions, "s-1.json")
				mkdirSync(path, { recursive: true, mode: 0o700 })
				return path
			},
			/not a real regular file/,
		],
	])("refuses %s as unsafe", (_label, prepare, message) => {
		const path = prepare()
		const error = failure(() => readPrivateFile(path, 1024))
		expect(error.kind).toBe("unsafe")
		expect(error.message).toMatch(message)
	})
})

describe("Lock Adapter", () => {
	test("the unsupported Adapter refuses before touching the filesystem", async () => {
		const adapter = lockAdapterFor("linux")
		expect(adapter.platform).toBe("linux")
		const lockPath = join(stateHome, "never.lock")
		await expect(adapter.withExclusive(lockPath, async () => "ran")).rejects.toMatchObject({ kind: "unsupported" })
		expect(existsSync(lockPath)).toBe(false)
	})

	test("the Darwin Adapter runs the action, releases on return and on throw, and keeps the permanent 0600 lock file", async () => {
		const adapter = lockAdapterFor("darwin")
		const lockPath = join(stateHome, "one.lock")
		expect(await adapter.withExclusive(lockPath, async () => "first")).toBe("first")
		expect(statSync(lockPath).mode & 0o777).toBe(0o600)
		await expect(adapter.withExclusive(lockPath, async () => Promise.reject(new Error("inner"))) as Promise<never>).rejects.toThrow("inner")
		expect(await adapter.withExclusive(lockPath, async () => "again")).toBe("again")
		expect(existsSync(lockPath)).toBe(true)
	})

	test.each([
		[
			"a symlinked lock path",
			() => {
				writeFileSync(join(stateHome, "real.lock"), "", { mode: 0o600 })
				symlinkSync(join(stateHome, "real.lock"), join(stateHome, "link.lock"))
				return join(stateHome, "link.lock")
			},
		],
		[
			"a 0644 lock file",
			() => {
				writeFileSync(join(stateHome, "broad.lock"), "", { mode: 0o644 })
				return join(stateHome, "broad.lock")
			},
		],
	])("refuses %s as unsafe", async (_label, prepare) => {
		const lockPath = prepare()
		let caught: unknown = null
		try {
			await lockAdapterFor("darwin").withExclusive(lockPath, async () => "never")
		} catch (error) {
			caught = error
		}
		expect(caught).toBeInstanceOf(LockFailure)
		expect((caught as LockFailure).kind).toBe("unsafe")
	})

	test("withLocks takes the workspace lock, then the session lock, and maps an unsupported Adapter to a RuntimeFailure", async () => {
		const order: string[] = []
		const recording = {
			platform: "darwin",
			withExclusive: async <T>(lockPath: string, action: () => Promise<T>): Promise<T> => {
				order.push(lockPath.includes("/workspaces/") ? "workspace" : "session")
				return action()
			},
		}
		expect(await withLocks(stateHome, recording, "/ws", "s-1", async () => "done")).toBe("done")
		expect(order).toEqual(["workspace", "session"])
		let caught: unknown = null
		try {
			await withLocks(stateHome, lockAdapterFor("linux"), "/ws", "s-1", async () => "never")
		} catch (error) {
			caught = error
		}
		expect(caught).toBeInstanceOf(RuntimeFailure)
		expect((caught as RuntimeFailure).kind).toBe("unsupported")
	})

	test("withSessionLock takes the session lock alone, never the workspace lock, and maps a busy Adapter to a RuntimeFailure", async () => {
		const order: string[] = []
		const recording = {
			platform: "darwin",
			withExclusive: async <T>(lockPath: string, action: () => Promise<T>): Promise<T> => {
				order.push(lockPath.includes("/workspaces/") ? "workspace" : "session")
				return action()
			},
		}
		expect(await withSessionLock(stateHome, recording, "s-1", async () => "done")).toBe("done")
		expect(order).toEqual(["session"])
		expect(existsSync(stateAddresses(stateHome).sessionLock("s-1").replace(/\/[^/]+$/, ""))).toBe(true)
		expect(existsSync(stateAddresses(stateHome).workspaceLock("/ws").replace(/\/[^/]+$/, ""))).toBe(false)
		const busy = { platform: "darwin", withExclusive: async () => Promise.reject(new LockFailure("busy", "held elsewhere")) }
		let caught: unknown = null
		try {
			await withSessionLock(stateHome, busy, "s-1", async () => "never")
		} catch (error) {
			caught = error
		}
		expect(caught).toBeInstanceOf(RuntimeFailure)
		expect((caught as RuntimeFailure).kind).toBe("busy")
	})
})
