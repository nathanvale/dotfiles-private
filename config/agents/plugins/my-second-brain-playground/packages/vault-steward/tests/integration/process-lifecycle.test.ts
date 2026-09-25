import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { cleanupFixtures, type Fixture, fixture, git } from "../helpers/harness.ts"
import { candidate, data, STEWARD_PREFIX, steward, stewardEnvironment } from "../helpers/steward.ts"

// Process lifecycle through real children: stdin held open or closed never prompts or blocks, SIGINT and SIGTERM
// before output exit 130 and 143 with empty streams, a closed stdout reader (EPIPE) ends the process without a
// crash trace, and an uncaught crash leaves no envelope and an empty stderr in machine mode.

setDefaultTimeout(60_000)
afterEach(cleanupFixtures)

function spawn(f: Fixture, args: string[], extra: Record<string, string> = {}, stdin: "pipe" | "ignore" = "ignore") {
	return Bun.spawn([...STEWARD_PREFIX, ...args, "--json"], { cwd: f.vault, stdin, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...stewardEnvironment(f, extra), GIT_TERMINAL_PROMPT: "0" } })
}

test("held-open and closed stdin never prompt or block", async () => {
	const f = fixture()
	const worktree = candidate(f)
	const held = spawn(f, ["inspect", "--worktree", worktree], {}, "pipe")
	const exit = await Promise.race([held.exited, Bun.sleep(20_000).then(() => "timeout" as const)])
	expect(exit).toBe(0)
	held.stdin?.end()
	expect(JSON.parse(await new Response(held.stdout).text()).result.causeCode).toBe("SUCCESS_UNCHANGED")
	const closed = steward(f.vault, ["inspect", "--worktree", worktree], stewardEnvironment(f))
	expect(closed.exitCode).toBe(0)
})

// The engine is synchronous: a signal stops new work and output, never a running Git transaction. The process exits
// 130 or 143 with empty streams, the in-flight integration completes atomically, and inspect reports the truth.
test.each([["SIGINT", 130] as const, ["SIGTERM", 143] as const])("%s before output exits %d with empty streams; the transaction is never half done", async (signal, code) => {
	const f = fixture()
	const worktree = candidate(f)
	const id = data(steward(f.vault, ["finish", "--preview", "--worktree", worktree, "--message", "docs: change"], stewardEnvironment(f))).previewId as string
	const child = spawn(f, ["finish", "--apply", "--preview-id", id, "--worktree", worktree], { VAULT_STEWARD_FAULT: "pause=after-lock:3000" })
	await Bun.sleep(1_500)
	child.kill(signal)
	const exit = await child.exited
	expect(exit).toBe(code)
	expect(await new Response(child.stdout).text()).toBe("")
	expect(await new Response(child.stderr).text()).toBe("")
	const inspected = steward(f.vault, ["inspect", "--worktree", worktree], stewardEnvironment(f))
	expect((inspected.envelope?.result.data as { recovery: { state: string } }).recovery.state).toBe("completed")
	expect(git(f.vault, "rev-list", "--count", `${f.initialHead}..main`)).toBe("1")
	const retried = steward(f.vault, ["finish", "--apply", "--preview-id", id, "--worktree", worktree], stewardEnvironment(f))
	expect(retried.envelope?.result.causeCode).toBe("SUCCESS_UNCHANGED")
})

test("a reader that closes stdout early ends the process without a crash trace", async () => {
	const f = fixture()
	const worktree = candidate(f)
	const child = spawn(f, ["inspect", "--worktree", worktree])
	const reader = child.stdout.getReader()
	await reader.cancel()
	const exit = await child.exited
	expect([0, 1]).toContain(exit)
	expect(await new Response(child.stderr).text()).toBe("")
})

test("an invalid fault specification is a usage refusal, never a crash", () => {
	const f = fixture()
	const worktree = candidate(f)
	const refused = steward(f.vault, ["inspect", "--worktree", worktree], stewardEnvironment(f, { VAULT_STEWARD_FAULT: "explode" }))
	expect(refused.exitCode).toBe(2)
	expect(refused.stderr).toBe("")
	expect(refused.envelope?.result).toMatchObject({ commandIdentity: "vault-steward.inspect", causeCode: "USAGE_INVALID_INVOCATION" })
})
