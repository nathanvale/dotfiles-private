import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BEAD, bindingPath, bindSession, createRoot, diagnosticsDirectory, FIXTURE_BD, hookEvent, hookOutputOf, markerPath, modeOf, readJsonFile, removeRoot, resultOf, retainedBytes, type Root, type Run, runCli, runHook, runHookWithFault, SECRET_BEAD, SECRET_MARKER, spawnLockHolder, stateListing, steerBd } from "../fixtures/harness.ts"

// The `hook` command through a real process: one Harness event on stdin, Harness JSON or silence on stdout, exit 0
// and empty stderr on every path. Expected deliveries, marker states and texts are literals from Spec #57's hook
// lifecycle and Ticket #58 criterion 7 (independent oracle). Codex payload shapes are fixture-derived (decision D6).

// Every row spawns two or more real processes and the concurrency rows hold a native read open; Bun's 5,000 ms
// default produced a spurious red on a loaded machine (hook proof review L3), so this file runs on 30 seconds.
setDefaultTimeout(30_000)

const SESSION = "session-1"
const OTHER_SESSION = "session-2"
const HELPER_PREFIX = "my-second-brain-playground/workflow-cli/"

let root: Root
const extraDirectories: string[] = []

beforeEach(() => {
	root = createRoot()
})

afterEach(() => {
	removeRoot(root)
	for (const directory of extraDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** Every hook run: exit 0, nothing on stderr. Returns the parsed Harness output or null when silent. */
function expectHook(run: Run): { hookEventName: string; additionalContext: string } | null {
	expect(run.exit).toBe(0)
	expect(run.stderr).toBe("")
	return hookOutputOf(run)
}

function expectSilent(run: Run): void {
	expect(expectHook(run)).toBeNull()
	expect(run.stdout).toBe("")
}

/** The PreCompact output fields Codex 0.154.0 admits, from the Codex hooks documentation's common output fields
 * (independent oracle; the installed binary's `pre-compact.command.output` schema is `additionalProperties: false`
 * over exactly these). `hookSpecificOutput` is not among them: Codex printed `Hook failed: hook returned invalid
 * PreCompact hook JSON output` for it (M2 U4-lite runtime observer, finding F1). */
const PRECOMPACT_COMMON_OUTPUT_FIELDS = ["continue", "stopReason", "suppressOutput", "systemMessage"]

/** A PreCompact warning: exit 0, empty stderr, one JSON object on stdout whose only field is `systemMessage`, so
 * compaction is never stopped and nothing outside the admitted field set is sent. Returns the warning text. */
function expectPreCompactWarning(run: Run): string {
	expect(run.exit).toBe(0)
	expect(run.stderr).toBe("")
	expect(run.stdout.endsWith("\n")).toBe(true)
	const parsed = JSON.parse(run.stdout) as Record<string, unknown>
	const keys = Object.keys(parsed)
	expect(keys.every((key) => PRECOMPACT_COMMON_OUTPUT_FIELDS.includes(key))).toBe(true)
	expect(keys).toEqual(["systemMessage"])
	expect(typeof parsed.systemMessage).toBe("string")
	return parsed.systemMessage as string
}

/** Durable state only: bindings, markers and locks; the hook's private diagnostics run files and the helper
 * directories that hold them are the accepted exception (decision D2) and are excluded. */
function durableListing(target: Root): string[] {
	return stateListing(target).filter((entry) => entry.startsWith(`${HELPER_PREFIX}recovery`) || entry.startsWith(`${HELPER_PREFIX}locks`))
}

function generations(target: Root, session: string): [number, string][] {
	if (!existsSync(markerPath(target, session))) return []
	const marker = readJsonFile(markerPath(target, session)) as { generations: { generation: number; state: string }[] }
	return marker.generations.map((generation) => [generation.generation, generation.state])
}

function diagnosticsFiles(): Set<string> {
	return new Set(existsSync(diagnosticsDirectory(root)) ? readdirSync(diagnosticsDirectory(root)) : [])
}

/** The records of the one run file written since `before`, and that file's path. */
function recordsSince(before: Set<string>): { file: string; records: Record<string, unknown>[] } {
	const files = readdirSync(diagnosticsDirectory(root)).filter((name) => !before.has(name))
	expect(files).toHaveLength(1)
	const file = join(diagnosticsDirectory(root), files[0] as string)
	return { file, records: readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) }
}

async function until(condition: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 10_000
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
		await Bun.sleep(25)
	}
}

/** A bd executable whose first invocation while `hold()` is in force announces itself and blocks until `release()`,
 * then replays the fixture bd; every other invocation replays at once. It keeps one hook inside a native read for as
 * long as a row needs, so the row can observe what a concurrent hook does during that read. The bound executable is
 * the one bind stored, so the row binds with it. */
function holdableBd(): { readonly executable: string; hold(): void; release(): void; holding(): Promise<void> } {
	const executable = join(root.privateRoot, "bd-holdable")
	const hold = join(root.privateRoot, "bd-hold")
	const holding = join(root.privateRoot, "bd-holding")
	const script = ["#!/bin/sh", "set -eu", `if [ -f "${hold}" ] && [ ! -f "${holding}" ]; then`, `\t: > "${holding}"`, "\tcount=0", `\twhile [ -f "${hold}" ] && [ "$count" -lt 400 ]; do`, "\t\tsleep 0.05", "\t\tcount=$((count + 1))", "\tdone", "fi", `exec "${FIXTURE_BD}" "$@"`, ""].join("\n")
	writeFileSync(executable, script, { mode: 0o700 })
	return {
		executable,
		hold: () => writeFileSync(hold, ""),
		release: () => rmSync(hold, { force: true }),
		holding: () => until(() => existsSync(holding), "the held native read"),
	}
}

async function bindWithExecutable(session: string, executable: string): Promise<void> {
	const run = await runCli(root, ["bind", "--workspace", root.workspace, "--session", session, "--bead", BEAD, "--json"], { env: { MSB_WORKFLOW_BD_EXECUTABLE: executable } })
	if (run.exit !== 0) throw new Error(`bind failed: ${run.stdout}${run.stderr}`)
}

const PANEL_HEAD = "# Resume Panel\n"

const startup = (overrides: Record<string, unknown> = {}): Record<string, unknown> => hookEvent(root, { source: "startup", ...overrides })
const compact = (overrides: Record<string, unknown> = {}): Record<string, unknown> => hookEvent(root, { source: "compact", ...overrides })
const event = (name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => {
	const base = hookEvent(root, { hook_event_name: name, ...overrides })
	if (name !== "SessionStart") delete base.source
	return base
}
const preCompact = (overrides: Record<string, unknown> = {}): Record<string, unknown> => event("PreCompact", overrides)
const postCompact = (overrides: Record<string, unknown> = {}): Record<string, unknown> => event("PostCompact", overrides)
const prompt = (overrides: Record<string, unknown> = {}): Record<string, unknown> => event("UserPromptSubmit", overrides)

describe("hook input and admission: every invalid input is silent", () => {
	test.each([
		["garbage", "not json at all"],
		["empty stdin", ""],
		["a JSON array", "[]"],
		["an unknown event name", { hook_event_name: "Stop", session_id: SESSION }],
		["SessionStart without a source", { hook_event_name: "SessionStart", session_id: SESSION }],
		["SessionStart with an unknown source", { hook_event_name: "SessionStart", source: "reload", session_id: SESSION }],
		["an unsafe session_id", { hook_event_name: "SessionStart", source: "startup", session_id: "../etc" }],
		["a missing session_id", { hook_event_name: "SessionStart", source: "startup" }],
		["a relative cwd", { hook_event_name: "SessionStart", source: "startup", session_id: SESSION, cwd: "relative" }],
		["a missing cwd", { hook_event_name: "SessionStart", source: "startup", session_id: SESSION, cwd: undefined }],
		["a duplicate JSON key", `{"hook_event_name":"SessionStart","hook_event_name":"SessionStart","source":"startup","session_id":"${SESSION}","cwd":"/"}`],
	])("%s", async (_label, input) => {
		await bindSession(root, SESSION)
		const before = durableListing(root)
		const payload = typeof input === "string" ? input : { cwd: root.privateRoot, ...input }
		expectSilent(await runHook(root, payload))
		expect(durableListing(root)).toEqual(before)
	})

	test("stdin over 128 KiB is silent", async () => {
		await bindSession(root, SESSION)
		const oversized = JSON.stringify({ ...startup(), padding: "x".repeat(128 * 1024) })
		expectSilent(await runHook(root, oversized))
	})

	test("a nonexistent cwd is silent", async () => {
		await bindSession(root, SESSION)
		expectSilent(await runHook(root, startup({ cwd: join(root.privateRoot, "absent") })))
	})

	test("a cwd that is not spelled canonically is silent, never normalised: a symlink alias, a trailing slash, a dot segment", async () => {
		await bindSession(root, SESSION)
		const alias = join(realpathSync(mkdtempSync(join(tmpdir(), "msb-alias-"))), "link")
		extraDirectories.push(dirname(alias))
		symlinkSync(root.privateRoot, alias)
		const before = durableListing(root)
		for (const cwd of [alias, `${root.privateRoot}/`, `${root.privateRoot}/.`, `${root.privateRoot}/workspace/..`]) expectSilent(await runHook(root, startup({ cwd })))
		expect(durableListing(root)).toEqual(before)
		// The same directory spelled canonically is admitted.
		expect(expectHook(await runHook(root, startup()))?.hookEventName).toBe("SessionStart")
	})

	test("a missing binding is silent for every event (the Spec overrides the legacy unbound guidance)", async () => {
		for (const payload of [startup(), startup({ source: "resume" }), startup({ source: "clear" }), compact(), preCompact(), postCompact(), prompt()]) expectSilent(await runHook(root, payload))
		expect(durableListing(root)).toEqual([])
	})

	test("a cwd outside the source repository and workspace is silent; the workspace itself and a subdirectory are admitted", async () => {
		await bindSession(root, SESSION)
		const outside = realpathSync(mkdtempSync(join(tmpdir(), "msb-outside-")))
		extraDirectories.push(outside)
		const before = durableListing(root)
		expectSilent(await runHook(root, startup({ cwd: outside })))
		expect(durableListing(root)).toEqual(before)
		expect(expectHook(await runHook(root, startup({ cwd: root.workspace })))?.hookEventName).toBe("SessionStart")
		const nested = join(root.privateRoot, "nested", "deeper")
		mkdirSync(nested, { recursive: true })
		expect(expectHook(await runHook(root, startup({ cwd: nested })))?.hookEventName).toBe("SessionStart")
	})

	test("a refused state root is silent", async () => {
		await bindSession(root, SESSION)
		const link = join(root.privateRoot, "state-link")
		symlinkSync(root.stateHome, link)
		expectSilent(await runHook(root, startup(), { env: { MSB_WORKFLOW_STATE_HOME: link } }))
	})

	test.each([
		["malformed bytes", (path: string) => writeFileSync(path, "{not json\n", { mode: 0o600 })],
		["schema v2 bytes", (path: string) => writeFileSync(path, '{"schemaVersion":2}\n', { mode: 0o600 })],
		["a world-readable binding", (path: string) => chmodSync(path, 0o644)],
		[
			"a symlinked binding",
			(path: string) => {
				const target = `${path}.real`
				writeFileSync(target, readFileSync(path), { mode: 0o600 })
				rmSync(path)
				symlinkSync(target, path)
			},
		],
		["an oversized binding", (path: string) => writeFileSync(path, `{"padding":"${"x".repeat(17 * 1024)}"}\n`, { mode: 0o600 })],
	])("%s is silent for every event and never rewritten", async (_label, plant) => {
		await bindSession(root, SESSION)
		plant(bindingPath(root, SESSION))
		const before = durableListing(root)
		for (const payload of [startup(), compact(), preCompact(), postCompact(), prompt()]) expectSilent(await runHook(root, payload))
		expect(durableListing(root)).toEqual(before)
	})

	test("an event for another session finds no binding and is silent", async () => {
		await bindSession(root, SESSION)
		expectSilent(await runHook(root, startup({ session_id: "session-2" })))
	})
})

describe("SessionStart and PreCompact", () => {
	test("startup, resume and clear deliver bounded session guidance and never consume a marker", async () => {
		await bindSession(root, SESSION)
		expectSilent(await runHook(root, postCompact()))
		expect(generations(root, SESSION)).toEqual([[1, "pending"]])
		for (const source of ["startup", "resume", "clear"]) {
			const output = expectHook(await runHook(root, startup({ source })))
			expect(output?.hookEventName).toBe("SessionStart")
			expect(output?.additionalContext).toContain(`Session identity: ${SESSION}`)
			expect(output?.additionalContext).toContain(`Bound to Bead ${BEAD} in ${root.workspace}`)
			expect(output?.additionalContext).toContain(`msb-workflow recover --workspace ${root.workspace} --session ${SESSION} --json`)
			expect(output?.additionalContext).toContain(`msb-workflow bind --workspace ${root.workspace} --bead <bead-id> --session ${SESSION}`)
			// The hook cannot tell the Harness apart, so the guidance names both delivery paths (review L4).
			expect(output?.additionalContext).toContain("After compaction the Resume Panel is delivered once: on the next prompt (Codex) or at SessionStart compact (Claude Code).")
			expect(output?.additionalContext).not.toContain("# Resume Panel")
		}
		expect(generations(root, SESSION)).toEqual([[1, "pending"]])
	})

	test("compact delivers the current panel with prime context appended", async () => {
		await bindSession(root, SESSION)
		steerBd(root, { beads: { [BEAD]: { status: "closed", updated_at: "2026-09-17T09:00:00Z", dependencies: [] } } })
		const output = expectHook(await runHook(root, compact()))
		expect(output?.hookEventName).toBe("SessionStart")
		const text = output?.additionalContext ?? ""
		expect(text.startsWith("# Resume Panel\n")).toBe(true)
		expect(text).toContain(`Bead: ${BEAD} M1: fixture Bead`)
		expect(text).toContain("Status: closed;")
		expect(text).toContain("changed since binding: yes")
		expect(text).toContain("\n## Beads prime context\n[bd prime] fixture prime context")
		expect(text).toContain(`Next safe action: ${BEAD} is closed; bind this session to the next Bead`)
	})

	test("compact is silent when the store is unavailable, redirected, or the Bead is missing", async () => {
		await bindSession(root, SESSION)
		for (const scenario of [{ unavailable: "no_beads_directory" }, { redirected: true }, { showError: { [BEAD]: "no issues found matching the provided IDs" } }, { wherePath: "/elsewhere/.beads" }]) {
			steerBd(root, scenario)
			expectSilent(await runHook(root, compact()))
		}
	})

	test("PreCompact is silent when recovery is available, and warns through systemMessage alone when it is unavailable", async () => {
		await bindSession(root, SESSION)
		const before = durableListing(root)
		const files = diagnosticsFiles()
		expectSilent(await runHook(root, preCompact()))
		expect(recordsSince(files).records.find((record) => record.eventKind === "hook.completed")?.delivery).toBe("precompact-available")
		steerBd(root, { unavailable: "no_beads_directory" })
		const unavailable = expectPreCompactWarning(await runHook(root, preCompact()))
		expect(unavailable.startsWith("msb-workflow recovery is unavailable before compaction: ")).toBe(true)
		expect(unavailable).toContain("no_beads_directory")
		expect(unavailable).toContain("Repair: ")
		steerBd(root, { redirected: true })
		expect(expectPreCompactWarning(await runHook(root, preCompact()))).toContain("redirected")
		expect(durableListing(root)).toEqual(before)
	})
})

describe("the recover and bind commands in the guidance and the notice are quoted for a POSIX shell (lkr-737.5.5)", () => {
	test("a workspace with a space and a single quote renders one quoted recover command in the guidance, the notice, and panel command 4, and one quoted bind command in the guidance", async () => {
		const workspace = join(root.privateRoot, "work sp'ace")
		mkdirSync(join(workspace, ".beads"), { recursive: true, mode: 0o700 })
		const bound = await runCli(root, ["bind", "--workspace", workspace, "--session", SESSION, "--bead", BEAD, "--json"])
		expect(bound.exit).toBe(0)
		// Hand-derived POSIX single quoting (independent oracle): the whole workspace is one single-quoted word with '
		// spelled '\''; the private root is a plain temporary path and contributes no character needing an escape.
		const recover = `msb-workflow recover --workspace '${root.privateRoot}/work sp'\\''ace' --session ${SESSION} --json`
		const bind = `msb-workflow bind --workspace '${root.privateRoot}/work sp'\\''ace' --bead <bead-id> --session ${SESSION}`
		const guidance = expectHook(await runHook(root, startup()))
		expect(guidance?.additionalContext).toContain(`Rebuild the Resume Panel at any time: ${recover}\n`)
		expect(guidance?.additionalContext).toContain(`Refresh or rebind with this exact session identity: ${bind}\n`)
		expectSilent(await runHook(root, postCompact()))
		await runHookWithFault(root, prompt(), "kill-after-claim")
		const notice = expectHook(await runHook(root, prompt()))
		expect(notice?.additionalContext).toBe(`msb-workflow: the Resume Panel for compaction generation(s) 1 was claimed but never recorded delivered; run ${recover} to rebuild it. Nothing is replayed automatically.`)
		const panel = await runCli(root, ["recover", "--workspace", workspace, "--session", SESSION, "--json"])
		expect(panel.exit).toBe(0)
		expect((resultOf(panel).readOnlyCommands as string[])[3]).toBe(recover)
		// A real sh re-parses each rendered command into the exact words: the workspace stays one word, nothing is
		// expanded. The bind line is reparsed once its `<bead-id>` placeholder is replaced by a concrete Bead ID, as a
		// user would paste it; the placeholder itself is never shell input.
		const reparse = (command: string): string => {
			const shell = Bun.spawnSync(["sh", "-c", `set -- ${command}; printf '%s\\n' "$@"`], { env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent" }, stdout: "pipe", stderr: "pipe" })
			expect(shell.stderr.toString()).toBe("")
			return shell.stdout.toString()
		}
		expect(reparse(recover)).toBe(`${["msb-workflow", "recover", "--workspace", workspace, "--session", SESSION, "--json"].join("\n")}\n`)
		expect(reparse(bind.replace("<bead-id>", BEAD))).toBe(`${["msb-workflow", "bind", "--workspace", workspace, "--bead", BEAD, "--session", SESSION].join("\n")}\n`)
	})
})

describe("PostCompact and UserPromptSubmit: exactly one panel per prompt", () => {
	test("PostCompact records a pending generation in a 0600 marker beside the binding, monotonically", async () => {
		await bindSession(root, SESSION)
		expectSilent(await runHook(root, postCompact()))
		expect(modeOf(markerPath(root, SESSION))).toBe(0o600)
		expect(generations(root, SESSION)).toEqual([[1, "pending"]])
		expectSilent(await runHook(root, postCompact()))
		expect(generations(root, SESSION)).toEqual([
			[1, "pending"],
			[2, "pending"],
		])
		const marker = readJsonFile(markerPath(root, SESSION))
		expect(marker.schemaVersion).toBe(1)
		expect(marker.sessionIdentity).toBe(SESSION)
	})

	test("a prompt with nothing pending is silent", async () => {
		await bindSession(root, SESSION)
		expectSilent(await runHook(root, prompt()))
		expect(existsSync(markerPath(root, SESSION))).toBe(false)
	})

	test("one compaction: the next prompt delivers one panel with prime context and the following prompt is silent", async () => {
		await bindSession(root, SESSION)
		expectSilent(await runHook(root, postCompact()))
		const output = expectHook(await runHook(root, prompt()))
		expect(output?.hookEventName).toBe("UserPromptSubmit")
		expect(output?.additionalContext.startsWith("# Resume Panel\n")).toBe(true)
		expect(output?.additionalContext).toContain("\n## Beads prime context\n")
		expect(generations(root, SESSION)).toEqual([[1, "delivered"]])
		expectSilent(await runHook(root, prompt()))
		expect(generations(root, SESSION)).toEqual([[1, "delivered"]])
	})

	test("two PostCompact notifications before one prompt yield one panel and a silent second prompt", async () => {
		await bindSession(root, SESSION)
		expectSilent(await runHook(root, postCompact()))
		expectSilent(await runHook(root, postCompact()))
		expect(expectHook(await runHook(root, prompt()))?.hookEventName).toBe("UserPromptSubmit")
		expect(generations(root, SESSION)).toEqual([
			[1, "delivered"],
			[2, "delivered"],
		])
		expectSilent(await runHook(root, prompt()))
	})

	test("a refused read before any output leaves the generations pending so the next prompt retries", async () => {
		await bindSession(root, SESSION)
		expectSilent(await runHook(root, postCompact()))
		steerBd(root, { unavailable: "database is locked by another process" })
		expectSilent(await runHook(root, prompt()))
		expect(generations(root, SESSION)).toEqual([[1, "pending"]])
		steerBd(root, {})
		expect(expectHook(await runHook(root, prompt()))?.hookEventName).toBe("UserPromptSubmit")
		expect(generations(root, SESSION)).toEqual([[1, "delivered"]])
	})

	test("a claimant killed after the claim leaves the generation uncertain; the next prompt emits the notice, then silence", async () => {
		await bindSession(root, SESSION)
		expectSilent(await runHook(root, postCompact()))
		const killed = await runHookWithFault(root, prompt(), "kill-after-claim")
		expect(killed.exit).not.toBe(0)
		expect(killed.stdout).toBe("")
		expect(generations(root, SESSION)).toEqual([[1, "claimed"]])
		const inspect = await runCli(root, ["inspect", "--workspace", root.workspace, "--session", SESSION, "--json"])
		expect(inspect.exit).toBe(3)
		const checks = (JSON.parse(inspect.stdout) as { result: { checks: { name: string; status: string; detail: string; repair: string | null }[] } }).result.checks
		const marker = checks.find((check) => check.name === "marker")
		expect(marker?.status).toBe("fail")
		expect(marker?.detail).toBe("generations 1 were claimed but never recorded delivered")
		expect(marker?.repair).toBe(`Run msb-workflow recover --workspace ${root.workspace} --session ${SESSION}; the next prompt hook emits a notice, not a panel`)
		const notice = expectHook(await runHook(root, prompt()))
		expect(notice?.hookEventName).toBe("UserPromptSubmit")
		expect(notice?.additionalContext).toBe(`msb-workflow: the Resume Panel for compaction generation(s) 1 was claimed but never recorded delivered; run msb-workflow recover --workspace ${root.workspace} --session ${SESSION} --json to rebuild it. Nothing is replayed automatically.`)
		expect(generations(root, SESSION)).toEqual([[1, "notified"]])
		expectSilent(await runHook(root, prompt()))
	})

	test("a claimant killed after output leaves the generation uncertain; the next prompt emits the notice, not the panel", async () => {
		await bindSession(root, SESSION)
		expectSilent(await runHook(root, postCompact()))
		const killed = await runHookWithFault(root, prompt(), "kill-after-output")
		expect(killed.exit).not.toBe(0)
		expect(killed.stdout).toContain("# Resume Panel")
		expect(generations(root, SESSION)).toEqual([[1, "claimed"]])
		const notice = expectHook(await runHook(root, prompt()))
		expect(notice?.additionalContext).toContain("was claimed but never recorded delivered")
		expect(notice?.additionalContext).not.toContain("# Resume Panel")
		expect(generations(root, SESSION)).toEqual([[1, "notified"]])
		expectSilent(await runHook(root, prompt()))
	})

	test("a compaction after an uncertain claim folds into the one notice instead of a blind replay", async () => {
		await bindSession(root, SESSION)
		expectSilent(await runHook(root, postCompact()))
		await runHookWithFault(root, prompt(), "kill-after-claim")
		expectSilent(await runHook(root, postCompact()))
		expect(generations(root, SESSION)).toEqual([
			[1, "claimed"],
			[2, "pending"],
		])
		const notice = expectHook(await runHook(root, prompt()))
		expect(notice?.additionalContext).toContain("generation(s) 1 was claimed but never recorded delivered")
		expect(notice?.additionalContext).toContain("Pending generation(s) 2 settle with this notice.")
		expect(generations(root, SESSION)).toEqual([
			[1, "notified"],
			[2, "notified"],
		])
		expectSilent(await runHook(root, prompt()))
	})

	test("a corrupt or unsafe marker is fail-open silent on hooks and named by inspect with one repair", async () => {
		await bindSession(root, SESSION)
		writeFileSync(markerPath(root, SESSION), "{\n", { mode: 0o600 })
		expectSilent(await runHook(root, postCompact()))
		expectSilent(await runHook(root, prompt()))
		expect(readFileSync(markerPath(root, SESSION), "utf8")).toBe("{\n")
		expect(expectHook(await runHook(root, startup()))?.hookEventName).toBe("SessionStart")
		const inspect = await runCli(root, ["inspect", "--workspace", root.workspace, "--session", SESSION, "--json"])
		expect(inspect.exit).toBe(3)
		const checks = (JSON.parse(inspect.stdout) as { result: { checks: { name: string; status: string; repair: string | null }[] } }).result.checks
		expect(checks.filter((check) => check.status === "fail").map((check) => check.name)).toEqual(["marker"])
		expect(checks.find((check) => check.name === "marker")?.repair).toBe(`Move or delete ${markerPath(root, SESSION)} after reading it`)
		chmodSync(markerPath(root, SESSION), 0o644)
		expectSilent(await runHook(root, postCompact()))
		expect(modeOf(markerPath(root, SESSION))).toBe(0o644)
	})

	test("a redirected store after binding keeps the prompt silent and the generation pending", async () => {
		await bindSession(root, SESSION)
		expectSilent(await runHook(root, postCompact()))
		steerBd(root, { redirected: true })
		expectSilent(await runHook(root, prompt()))
		expect(generations(root, SESSION)).toEqual([[1, "pending"]])
	})

	test("the notice leaves the process before notified is recorded: a death right after the notice output repeats it on the next prompt", async () => {
		await bindSession(root, SESSION)
		expectSilent(await runHook(root, postCompact()))
		await runHookWithFault(root, prompt(), "kill-after-claim")
		expect(generations(root, SESSION)).toEqual([[1, "claimed"]])
		const killed = await runHookWithFault(root, prompt(), "kill-after-output")
		expect(killed.exit).not.toBe(0)
		expect(killed.stdout).toContain("generation(s) 1 was claimed but never recorded delivered")
		// Still claimed, never silently lost: the handoff is repeated, which is harmless, rather than dropped (review L1).
		expect(generations(root, SESSION)).toEqual([[1, "claimed"]])
		const notice = expectHook(await runHook(root, prompt()))
		expect(notice?.additionalContext).toContain("generation(s) 1 was claimed but never recorded delivered")
		expect(generations(root, SESSION)).toEqual([[1, "notified"]])
		expectSilent(await runHook(root, prompt()))
	})
})

describe("marker operations take the session lock only, and a prompt's native reads hold no lock", () => {
	test("a held workspace lock never delays PostCompact or the prompt's delivery", async () => {
		await bindSession(root, SESSION)
		const holder = spawnLockHolder(root, SESSION, root.workspace)
		await holder.held
		try {
			expectSilent(await runHook(root, postCompact()))
			expect(generations(root, SESSION)).toEqual([[1, "pending"]])
			expect(expectHook(await runHook(root, prompt()))?.additionalContext.startsWith(PANEL_HEAD)).toBe(true)
			expect(generations(root, SESSION)).toEqual([[1, "delivered"]])
		} finally {
			holder.kill()
			await holder.exited
		}
	})

	test("a busy session lock fails open, writes nothing, and the retained hook.failed record names the failure kind", async () => {
		await bindSession(root, SESSION)
		const holder = spawnLockHolder(root, SESSION)
		await holder.held
		try {
			const before = diagnosticsFiles()
			expectSilent(await runHook(root, postCompact()))
			expect(existsSync(markerPath(root, SESSION))).toBe(false)
			const failed = recordsSince(before).records.find((record) => record.eventKind === "hook.failed")
			expect(failed?.kind).toBe("busy")
			expect(failed?.failure).toEqual({ name: "Error" })
		} finally {
			holder.kill()
			await holder.exited
		}
	})

	test("a PostCompact for another session on the same workspace mints its generation while this session's prompt is inside a native read", async () => {
		const bd = holdableBd()
		await bindWithExecutable(SESSION, bd.executable)
		await bindSession(root, OTHER_SESSION)
		expectSilent(await runHook(root, postCompact()))
		bd.hold()
		const reading = runHook(root, prompt())
		await bd.holding()
		expectSilent(await runHook(root, postCompact({ session_id: OTHER_SESSION })))
		expect(generations(root, OTHER_SESSION)).toEqual([[1, "pending"]])
		expect(generations(root, SESSION)).toEqual([[1, "pending"]])
		bd.release()
		const output = expectHook(await reading)
		expect(output?.hookEventName).toBe("UserPromptSubmit")
		expect(output?.additionalContext.startsWith(PANEL_HEAD)).toBe(true)
		expect(generations(root, SESSION)).toEqual([[1, "delivered"]])
		expect(expectHook(await runHook(root, prompt({ session_id: OTHER_SESSION })))?.additionalContext.startsWith(PANEL_HEAD)).toBe(true)
		expect(generations(root, OTHER_SESSION)).toEqual([[1, "delivered"]])
	})

	test("a PostCompact for this session during the prompt's native read mints a pending generation; the prompt claims it on re-decision and delivers one panel", async () => {
		const bd = holdableBd()
		await bindWithExecutable(SESSION, bd.executable)
		expectSilent(await runHook(root, postCompact()))
		bd.hold()
		const reading = runHook(root, prompt())
		await bd.holding()
		expectSilent(await runHook(root, postCompact()))
		expect(generations(root, SESSION)).toEqual([
			[1, "pending"],
			[2, "pending"],
		])
		bd.release()
		const output = expectHook(await reading)
		expect(output?.hookEventName).toBe("UserPromptSubmit")
		expect(output?.additionalContext.startsWith(PANEL_HEAD)).toBe(true)
		expect(generations(root, SESSION)).toEqual([
			[1, "delivered"],
			[2, "delivered"],
		])
		expectSilent(await runHook(root, prompt()))
	})

	test("two prompts racing for one pending generation deliver exactly one panel; the one that loses the re-decision settles silent", async () => {
		const bd = holdableBd()
		await bindWithExecutable(SESSION, bd.executable)
		expectSilent(await runHook(root, postCompact()))
		bd.hold()
		const first = runHook(root, prompt())
		await bd.holding()
		const second = expectHook(await runHook(root, prompt()))
		expect(second?.hookEventName).toBe("UserPromptSubmit")
		expect(second?.additionalContext.startsWith(PANEL_HEAD)).toBe(true)
		expect(generations(root, SESSION)).toEqual([[1, "delivered"]])
		bd.release()
		expectSilent(await first)
		expect(generations(root, SESSION)).toEqual([[1, "delivered"]])
		expectSilent(await runHook(root, prompt()))
	})
})

describe("hook diagnostics and redaction", () => {
	test("every delivery redacts the known secret values of the run on stdout and in the retained diagnostics", async () => {
		await bindSession(root, "secret-session", SECRET_BEAD)
		const secretEvent = (name: string, source?: string): Record<string, unknown> => ({ hook_event_name: name, ...(source === undefined ? {} : { source }), session_id: "secret-session", cwd: root.privateRoot })
		const compactOutput = expectHook(await runHook(root, secretEvent("SessionStart", "compact")))
		expect(compactOutput?.additionalContext).toContain("[REDACTED]")
		expect(compactOutput?.additionalContext).not.toContain(SECRET_MARKER)
		expectSilent(await runHook(root, secretEvent("PostCompact")))
		const promptOutput = expectHook(await runHook(root, secretEvent("UserPromptSubmit")))
		expect(promptOutput?.additionalContext).toContain("[REDACTED]")
		expect(promptOutput?.additionalContext).not.toContain(SECRET_MARKER)
		expect(retainedBytes(root)).not.toContain(SECRET_MARKER)
	})

	test("hook diagnostics go to a private run file carrying the run identity, never to stderr", async () => {
		await bindSession(root, SESSION)
		const before = diagnosticsFiles()
		const run = await runHook(root, compact())
		expectHook(run)
		const { file, records } = recordsSince(before)
		expect(modeOf(file)).toBe(0o600)
		expect(records.length).toBeGreaterThan(0)
		for (const record of records) expect(record.runIdentity).toMatch(/^run-[0-9a-f-]{36}$/)
		expect(records.some((record) => record.event === "hook.completed" || String(record.message ?? "").includes("hook.completed"))).toBe(true)
	})
})
