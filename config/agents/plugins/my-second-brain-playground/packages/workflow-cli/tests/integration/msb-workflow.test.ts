import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BEAD, bindingPath, bindSession, createRoot, envelopeOf, FIXTURE_BD, markerPath, modeOf, OTHER_BEAD, removeRoot, resultOf, type Root, type Run, runCli, runCliOnPlatform, runCliWithStoreFault, SECRET_BEAD, SECRET_MARKER, stateListing, steerBd, TAMPERED_BEAD } from "../fixtures/harness.ts"

// The public process seam for the five envelope commands: every row spawns the production entry against the fixture
// bd and a fresh private root. Expected cause codes, exits, transaction states and retry facts are literals from
// Spec #57 and Ticket #58 (independent oracle), never read from the catalog.

const SESSION = "session-1"
const HELPER_PREFIX = "my-second-brain-playground/workflow-cli/"
const DIAGNOSTICS_PREFIX = `${HELPER_PREFIX}diagnostics/`
const BINDINGS_PREFIX = `${HELPER_PREFIX}recovery/sessions/`

interface Expected {
	readonly exit: number
	readonly outcome: "success" | "refused" | "failed" | "unknown"
	readonly causeCode: string | null
	readonly transactionState: "unchanged" | "completed" | "unknown"
	readonly retryable: boolean
	readonly retryDelayMilliseconds?: number | null
}

/** One machine-mode envelope: empty stderr, one JSON line, the fixed identity fields, and the row's literal facts. */
function expectEnvelope(run: Run, identity: string, expected: Expected): Record<string, unknown> {
	expect(run.stderr).toBe("")
	expect(run.exit).toBe(expected.exit)
	const envelope = envelopeOf(run)
	expect(envelope.envelopeVersion).toBe(1)
	expect(envelope.contractVersion).toBe("1.0.0")
	expect(envelope.commandIdentity).toBe(identity)
	expect(envelope.runIdentity).toMatch(/^run-[0-9a-f-]{36}$/)
	expect(envelope.outcome).toBe(expected.outcome)
	expect(envelope.causeCode).toBe(expected.causeCode)
	expect(envelope.transactionState).toBe(expected.transactionState)
	expect(envelope.retryable).toBe(expected.retryable)
	if (expected.retryDelayMilliseconds !== undefined) expect(envelope.retryDelayMilliseconds).toBe(expected.retryDelayMilliseconds)
	if (expected.outcome === "success") expect(envelope.repairAction).toBeNull()
	else {
		expect(typeof envelope.repairAction).toBe("string")
		// Exactly one of nextAction or handoff guides a non-success outcome.
		expect((envelope.nextAction === null) !== (envelope.handoff === null)).toBe(true)
	}
	return envelope
}

function expectHumanRefusal(run: Run, causeCode: string, exit: number): void {
	expect(run.stdout).toBe("")
	expect(run.exit).toBe(exit)
	expect(run.stderr.split("\n")).toHaveLength(2)
	expect(run.stderr.startsWith(`msb-workflow: ${causeCode}: `)).toBe(true)
	expect(run.stderr).toContain("; repair: ")
}

/** The durable entries a command may own: bindings, markers and lock files. Machine-mode diagnostics run files and the
 * helper directories that hold them are the accepted exception (decision D2) and are excluded here. */
function durableListing(root: Root): string[] {
	return stateListing(root).filter((entry) => entry.startsWith(`${HELPER_PREFIX}recovery`) || entry.startsWith(`${HELPER_PREFIX}locks`))
}

function secondWorkspace(root: Root): string {
	const workspace = join(root.privateRoot, "workspace-two")
	mkdirSync(join(workspace, ".beads"), { recursive: true, mode: 0o700 })
	return workspace
}

/** A directory outside every Git working directory, for the "bind outside Git" and "evidence outside" rows. */
function outsideDirectory(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "msb-outside-")))
}

function plantBinding(root: Root, session: string, bytes: string): void {
	mkdirSync(join(root.stateHome, "my-second-brain-playground", "workflow-cli", "recovery", "sessions"), { recursive: true, mode: 0o700 })
	writeFileSync(bindingPath(root, session), bytes, { mode: 0o600 })
}

const bindArgs = (root: Root, session: string, bead: string, workspace = root.workspace): string[] => ["bind", "--workspace", workspace, "--session", session, "--bead", bead, "--json"]
/** The verified same-session switch: `--from` names the saved Bead the request replaces. */
const switchArgs = (root: Root, session: string, bead: string, from: string, workspace = root.workspace): string[] => ["bind", "--workspace", workspace, "--session", session, "--bead", bead, "--from", from, "--json"]
const recoverArgs = (root: Root, session: string, workspace = root.workspace): string[] => ["recover", "--workspace", workspace, "--session", session, "--json"]
const inspectArgs = (root: Root, session: string | null, workspace = root.workspace): string[] => ["inspect", "--workspace", workspace, ...(session === null ? [] : ["--session", session]), "--json"]

let root: Root
const extraDirectories: string[] = []

beforeEach(() => {
	root = createRoot()
})

afterEach(() => {
	removeRoot(root)
	for (const directory of extraDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("contract surface through a real process", () => {
	test("--help prints usage on stdout and exits 0 with empty stderr", async () => {
		const run = await runCli(root, ["--help"])
		expect(run.exit).toBe(0)
		expect(run.stderr).toBe("")
		expect(run.stdout.startsWith("usage: msb-workflow <inspect|bind|recover|hook> [options] [--json]\nexample: msb-workflow recover ")).toBe(true)
	})

	test("no arguments exits 2 with one stderr line naming --help", async () => {
		const run = await runCli(root, [])
		expectHumanRefusal(run, "USAGE_INVALID_INVOCATION", 2)
		expect(run.stderr).toContain("msb-workflow --help")
	})

	test("an unknown option with --json is one usage envelope", async () => {
		const run = await runCli(root, ["--nope", "--json"])
		expectEnvelope(run, "msb-workflow.help", { exit: 2, outcome: "refused", causeCode: "USAGE_INVALID_INVOCATION", transactionState: "unchanged", retryable: false })
	})

	test("--discover --json lists exactly the six identities with their effect stances", async () => {
		const run = await runCli(root, ["--discover", "--json"])
		expectEnvelope(run, "msb-workflow.discover", { exit: 0, outcome: "success", causeCode: null, transactionState: "unchanged", retryable: false })
		const result = resultOf(run)
		const commands = result.commands as { identity: string; effectClass: string }[]
		expect(commands.map((command) => [command.identity, command.effectClass])).toEqual([
			["msb-workflow.help", "inspect"],
			["msb-workflow.discover", "inspect"],
			["msb-workflow.inspect", "inspect"],
			["msb-workflow.bind", "repository-local"],
			["msb-workflow.recover", "inspect"],
			["msb-workflow.hook", "repository-local"],
		])
		expect(result.contractVersion).toBe("1.0.0")
		expect(result.machineMode).toBe("--json")
		expect(result.logtape).toBe(true)
		expect((result.bindingSchema as { schemaVersion: number }).schemaVersion).toBe(3)
	})

	test("hook with any extra argument is an ordinary usage failure", async () => {
		const run = await runCli(root, ["hook", "--json"])
		expectEnvelope(run, "msb-workflow.hook", { exit: 2, outcome: "refused", causeCode: "USAGE_INVALID_INVOCATION", transactionState: "unchanged", retryable: false })
		const human = await runCli(root, ["hook", "extra"])
		expectHumanRefusal(human, "USAGE_INVALID_INVOCATION", 2)
	})

	test("a missing or relative workspace refuses before any state is touched", async () => {
		const missing = await runCli(root, ["recover", "--workspace", join(root.privateRoot, "absent"), "--session", SESSION, "--json"])
		expectEnvelope(missing, "msb-workflow.recover", { exit: 3, outcome: "refused", causeCode: "DOMAIN_WORKSPACE_INVALID", transactionState: "unchanged", retryable: false })
		const relative = await runCli(root, ["inspect", "--workspace", "workspace", "--json"])
		expectEnvelope(relative, "msb-workflow.inspect", { exit: 3, outcome: "refused", causeCode: "DOMAIN_WORKSPACE_INVALID", transactionState: "unchanged", retryable: false })
		expect(stateListing(root)).toEqual([])
	})

	test("an absent or symlinked state root refuses every routed command without creating it", async () => {
		const absent = join(root.privateRoot, "no-such-state")
		const run = await runCli(root, bindArgs(root, SESSION, BEAD), { env: { MSB_WORKFLOW_STATE_HOME: absent } })
		expectEnvelope(run, "msb-workflow.bind", { exit: 3, outcome: "refused", causeCode: "DOMAIN_STATE_ROOT_UNSAFE", transactionState: "unchanged", retryable: false })
		expect(existsSync(absent)).toBe(false)
		const link = join(root.privateRoot, "state-link")
		symlinkSync(root.stateHome, link)
		const linked = await runCli(root, recoverArgs(root, SESSION), { env: { MSB_WORKFLOW_STATE_HOME: link } })
		expectEnvelope(linked, "msb-workflow.recover", { exit: 3, outcome: "refused", causeCode: "DOMAIN_STATE_ROOT_UNSAFE", transactionState: "unchanged", retryable: false })
		expect(stateListing(root)).toEqual([])
	})
})

describe("session identity", () => {
	test("--session and a different CODEX_SESSION_ID refuse", async () => {
		const run = await runCli(root, bindArgs(root, SESSION, BEAD), { env: { CODEX_SESSION_ID: "session-2" } })
		expectEnvelope(run, "msb-workflow.bind", { exit: 3, outcome: "refused", causeCode: "DOMAIN_SESSION_CONFLICT", transactionState: "unchanged", retryable: false })
		expect(durableListing(root)).toEqual([])
	})

	test("a session outside the closed grammar refuses", async () => {
		const run = await runCli(root, recoverArgs(root, "-bad"))
		expectEnvelope(run, "msb-workflow.recover", { exit: 3, outcome: "refused", causeCode: "DOMAIN_SESSION_INVALID", transactionState: "unchanged", retryable: false })
	})

	test("no session at all is a usage refusal", async () => {
		const run = await runCli(root, ["recover", "--workspace", root.workspace, "--json"])
		expectEnvelope(run, "msb-workflow.recover", { exit: 2, outcome: "refused", causeCode: "USAGE_INVALID_INVOCATION", transactionState: "unchanged", retryable: false })
	})

	test("CODEX_SESSION_ID alone binds a fresh session", async () => {
		const run = await runCli(root, ["bind", "--workspace", root.workspace, "--bead", BEAD, "--json"], { env: { CODEX_SESSION_ID: "env-session" } })
		expectEnvelope(run, "msb-workflow.bind", { exit: 0, outcome: "success", causeCode: null, transactionState: "completed", retryable: false })
		expect(existsSync(bindingPath(root, "env-session"))).toBe(true)
	})
})

describe("bind: the one local write", () => {
	test("writes one 0600 schema-v3 binding under 0700 directories and returns the panel", async () => {
		const run = await runCli(root, bindArgs(root, SESSION, BEAD))
		const envelope = expectEnvelope(run, "msb-workflow.bind", { exit: 0, outcome: "success", causeCode: null, transactionState: "completed", retryable: false })
		expect(envelope.effectClass).toBe("repository-local")
		const result = resultOf(run)
		expect(result.station).toBe("bound")
		expect(result.refreshed).toBe(false)
		expect(result.bindingPath).toBe(bindingPath(root, SESSION))
		const saved = JSON.parse(readFileSync(bindingPath(root, SESSION), "utf8")) as Record<string, unknown>
		expect(Object.keys(saved).sort()).toEqual(["beadId", "beadObservedAt", "beadsExecutable", "beadsVersion", "evidencePath", "observedAt", "schemaVersion", "sessionIdentity", "sourceRepository", "storePath", "storePrefix", "workspace"])
		expect(saved.schemaVersion).toBe(3)
		expect(saved.sessionIdentity).toBe(SESSION)
		expect(saved.workspace).toBe(root.workspace)
		expect(saved.storePath).toBe(join(root.workspace, ".beads"))
		expect(saved.storePrefix).toBe("lkr")
		expect(saved.beadsExecutable).toBe(FIXTURE_BD)
		expect(saved.beadsVersion).toBe("1.3.0@f45b249ce6b4")
		expect(saved.beadId).toBe(BEAD)
		expect(saved.beadObservedAt).toBe("2026-09-17T03:09:16Z")
		expect(saved.sourceRepository).toBe(root.privateRoot)
		expect(saved.evidencePath).toBeNull()
		const listing = stateListing(root)
		for (const entry of listing) expect(entry).toMatch(/:(700|600)$/)
		expect(listing).toContain(`my-second-brain-playground/workflow-cli/recovery/sessions/${SESSION}.json:600`)
		expect(listing.filter((entry) => entry.endsWith(".lock:600"))).toHaveLength(2)
		expect(existsSync(markerPath(root, SESSION))).toBe(false)
		expect(result.nextSafeAction).toBe(`Wait for the open human Gate lkr-gate to close through native bd before continuing ${BEAD}; do not resolve it yourself`)
		expect(envelope.nextAction).toBe(result.nextSafeAction)
	})

	test("the same owner refreshes; a different Bead refuses and preserves the saved bytes", async () => {
		await bindSession(root, SESSION)
		const before = readFileSync(bindingPath(root, SESSION))
		const again = await runCli(root, bindArgs(root, SESSION, BEAD))
		expectEnvelope(again, "msb-workflow.bind", { exit: 0, outcome: "success", causeCode: null, transactionState: "completed", retryable: false })
		expect(resultOf(again).refreshed).toBe(true)
		const refreshed = readFileSync(bindingPath(root, SESSION))
		const other = await runCli(root, bindArgs(root, SESSION, OTHER_BEAD))
		const envelope = expectEnvelope(other, "msb-workflow.bind", { exit: 3, outcome: "refused", causeCode: "DOMAIN_BINDING_OWNERSHIP_CONFLICT", transactionState: "unchanged", retryable: false })
		expect(envelope.nextAction).toBe(`msb-workflow recover --workspace ${root.workspace} --session ${SESSION}`)
		expect(resultOf(other).savedBeadId).toBe(BEAD)
		expect(readFileSync(bindingPath(root, SESSION)).equals(refreshed)).toBe(true)
		expect(before.length).toBeGreaterThan(0)
	})

	test("a different workspace for the same session refuses and preserves the saved bytes", async () => {
		await bindSession(root, SESSION)
		const saved = readFileSync(bindingPath(root, SESSION))
		const run = await runCli(root, bindArgs(root, SESSION, BEAD, secondWorkspace(root)))
		expectEnvelope(run, "msb-workflow.bind", { exit: 3, outcome: "refused", causeCode: "DOMAIN_BINDING_OWNERSHIP_CONFLICT", transactionState: "unchanged", retryable: false })
		expect(readFileSync(bindingPath(root, SESSION)).equals(saved)).toBe(true)
	})

	test("an inherited-only identity never replaces a saved owner", async () => {
		await bindSession(root, SESSION)
		const saved = readFileSync(bindingPath(root, SESSION))
		const run = await runCli(root, ["bind", "--workspace", root.workspace, "--bead", OTHER_BEAD, "--json"], { env: { CODEX_SESSION_ID: SESSION } })
		expectEnvelope(run, "msb-workflow.bind", { exit: 3, outcome: "refused", causeCode: "DOMAIN_SESSION_INHERITED_CONFLICT", transactionState: "unchanged", retryable: false })
		expect(readFileSync(bindingPath(root, SESSION)).equals(saved)).toBe(true)
	})

	test("malformed saved bytes refuse with a schema cause and are never replaced", async () => {
		plantBinding(root, SESSION, "{not json\n")
		const run = await runCli(root, bindArgs(root, SESSION, BEAD))
		expectEnvelope(run, "msb-workflow.bind", { exit: 4, outcome: "refused", causeCode: "SCHEMA_BINDING_INVALID", transactionState: "unchanged", retryable: false })
		expect(readFileSync(bindingPath(root, SESSION), "utf8")).toBe("{not json\n")
	})

	test("a symlinked binding is unsafe state and is left in place", async () => {
		const target = join(root.privateRoot, "elsewhere.json")
		writeFileSync(target, "{}\n", { mode: 0o600 })
		mkdirSync(join(root.stateHome, "my-second-brain-playground", "workflow-cli", "recovery", "sessions"), { recursive: true, mode: 0o700 })
		symlinkSync(target, bindingPath(root, SESSION))
		const run = await runCli(root, bindArgs(root, SESSION, BEAD))
		expectEnvelope(run, "msb-workflow.bind", { exit: 3, outcome: "refused", causeCode: "DOMAIN_STATE_UNSAFE", transactionState: "unchanged", retryable: false })
		expect(readFileSync(target, "utf8")).toBe("{}\n")
	})

	test("a missing Bead is a domain refusal that never invites a retry, and nothing is written", async () => {
		const run = await runCli(root, bindArgs(root, SESSION, "lkr-nope"))
		const envelope = expectEnvelope(run, "msb-workflow.bind", { exit: 3, outcome: "refused", causeCode: "DOMAIN_BEAD_MISSING", transactionState: "unchanged", retryable: false, retryDelayMilliseconds: null })
		expect(envelope.repairAction).toContain("lkr-nope")
		expect(durableListing(root)).toEqual([])
	})

	test.each([
		["a missing database", "database does not exist"],
		["a differently cased absent-issue value", "No Issues Found Matching The Provided IDs"],
		["an issue-not-found phrasing the pinned bd was never observed to emit", "issue lkr-fixture not found"],
	])("%s is an error value outside the observed absent-issue allowlist: unavailable, exit 75, not a missing Bead", async (_label, error) => {
		steerBd(root, { showError: { [BEAD]: error } })
		const run = await runCli(root, bindArgs(root, SESSION, BEAD))
		expectEnvelope(run, "msb-workflow.bind", { exit: 75, outcome: "failed", causeCode: "UNAVAILABLE_BEADS_READ", transactionState: "unchanged", retryable: true, retryDelayMilliseconds: 1000 })
		expect(durableListing(root)).toEqual([])
	})

	test.each([
		["the pinned revision as the branch text with another revision", "bd version 1.3.0 (deadbeef0: f45b249ce6b4@deadbeef0000)"],
		["no parenthesised build field", "bd version 1.3.0 f45b249ce6b4"],
		["a patch version bump at the pinned revision", "bd version 1.3.1 (f45b249ce: f45b249ce6b4)"],
		["the pinned revision only as a prefix of the revision field", "bd version 1.3.0 (f45b249ce: f45b249ce6b4433a)"],
	])("%s refuses as a store mismatch before any write", async (_label, version) => {
		steerBd(root, { version })
		const run = await runCli(root, bindArgs(root, SESSION, BEAD))
		const envelope = expectEnvelope(run, "msb-workflow.bind", { exit: 3, outcome: "refused", causeCode: "DOMAIN_STORE_MISMATCH", transactionState: "unchanged", retryable: false })
		expect(envelope.message).toBe("bd executable is not the verified 1.3.0 at f45b249ce6b4")
		expect(durableListing(root)).toEqual([])
	})

	test.each([
		["outside a Git directory", "bd version 1.3.0 (f45b249ce: f45b249ce6b4)"],
		["inside a Git directory, with the branch appended", "bd version 1.3.0 (f45b249ce: codex/lkr-195-helper-pin-1.3@f45b249ce6b4)"],
		["with a branch containing @ and parentheses", "bd version 1.3.0 (f45b249ce: release@2026(a)@f45b249ce6b4)"],
	])("the pinned version line %s binds", async (_label, version) => {
		steerBd(root, { version })
		const run = await runCli(root, bindArgs(root, SESSION, BEAD))
		expectEnvelope(run, "msb-workflow.bind", { exit: 0, outcome: "success", causeCode: null, transactionState: "completed", retryable: false })
	})

	test.each([
		["a wrong store path", { wherePath: "/elsewhere/.beads" }],
		["a wrong bd version", { version: "bd version 1.4.0 (abcdef0: abcdef0123456)" }],
		["a prefix that disagrees with configuration", { configPrefix: "zzz" }],
		["a redirected context", { redirected: true }],
	])("%s refuses as a store mismatch before any write", async (_label, scenario) => {
		steerBd(root, scenario)
		const run = await runCli(root, bindArgs(root, SESSION, BEAD))
		expectEnvelope(run, "msb-workflow.bind", { exit: 3, outcome: "refused", causeCode: "DOMAIN_STORE_MISMATCH", transactionState: "unchanged", retryable: false })
		expect(durableListing(root)).toEqual([])
	})

	test.each([
		["no_beads_directory", { unavailable: "no_beads_directory" }],
		["database contention", { unavailable: "database is locked by another process" }],
		["a reply that is not JSON", { noJson: true }],
	])("%s is unavailable, exit 75, retryable after 1000 ms", async (_label, scenario) => {
		steerBd(root, scenario)
		const run = await runCli(root, bindArgs(root, SESSION, BEAD))
		expectEnvelope(run, "msb-workflow.bind", { exit: 75, outcome: "failed", causeCode: "UNAVAILABLE_BEADS_READ", transactionState: "unchanged", retryable: true, retryDelayMilliseconds: 1000 })
		expect(durableListing(root)).toEqual([])
	})

	test("an unset or missing executable refuses; PATH is never searched", async () => {
		const unset = await runCli(root, bindArgs(root, SESSION, BEAD), { env: { MSB_WORKFLOW_BD_EXECUTABLE: undefined } })
		expectEnvelope(unset, "msb-workflow.bind", { exit: 3, outcome: "refused", causeCode: "DOMAIN_EXECUTABLE_INVALID", transactionState: "unchanged", retryable: false })
		const missing = await runCli(root, bindArgs(root, SESSION, BEAD), { env: { MSB_WORKFLOW_BD_EXECUTABLE: join(root.privateRoot, "no-bd") } })
		expectEnvelope(missing, "msb-workflow.bind", { exit: 3, outcome: "refused", causeCode: "DOMAIN_EXECUTABLE_INVALID", transactionState: "unchanged", retryable: false })
		const relative = await runCli(root, bindArgs(root, SESSION, BEAD), { env: { MSB_WORKFLOW_BD_EXECUTABLE: "bd" } })
		expectEnvelope(relative, "msb-workflow.bind", { exit: 3, outcome: "refused", causeCode: "DOMAIN_EXECUTABLE_INVALID", transactionState: "unchanged", retryable: false })
		expect(durableListing(root)).toEqual([])
	})

	test("the production entry refuses the fixture bd: it is not the accepted path, whatever version it prints", async () => {
		const run = await runCli(root, bindArgs(root, SESSION, BEAD), { entry: "production" })
		const envelope = expectEnvelope(run, "msb-workflow.bind", { exit: 3, outcome: "refused", causeCode: "DOMAIN_EXECUTABLE_INVALID", transactionState: "unchanged", retryable: false })
		// The accepted path is the Ticket #52 revision 3 literal, never read from the helper.
		expect(envelope.message).toBe(`bd executable ${FIXTURE_BD} is not the accepted /Users/nathanvale/.local/share/mise/installs/github-gastownhall-beads/1.3.0/bd`)
		expect(durableListing(root)).toEqual([])
	})

	test("outside a Git working directory bind refuses with exit 3 and no --source flag exists", async () => {
		const outside = outsideDirectory()
		extraDirectories.push(outside)
		const run = await runCli(root, bindArgs(root, SESSION, BEAD), { cwd: outside })
		expectEnvelope(run, "msb-workflow.bind", { exit: 3, outcome: "refused", causeCode: "DOMAIN_SOURCE_REPOSITORY_MISSING", transactionState: "unchanged", retryable: false })
		const flagged = await runCli(root, [...bindArgs(root, SESSION, BEAD), "--source", root.privateRoot])
		expectEnvelope(flagged, "msb-workflow.bind", { exit: 2, outcome: "refused", causeCode: "USAGE_INVALID_INVOCATION", transactionState: "unchanged", retryable: false })
		expect(durableListing(root)).toEqual([])
	})

	test("--evidence must be a canonical regular file inside the source repository", async () => {
		const inside = join(root.privateRoot, "evidence.md")
		writeFileSync(inside, "# evidence\n")
		const outside = outsideDirectory()
		extraDirectories.push(outside)
		const outsideFile = join(outside, "evidence.md")
		writeFileSync(outsideFile, "# elsewhere\n")
		for (const evidence of [outsideFile, join(root.privateRoot, "missing.md"), "relative.md", root.privateRoot]) {
			const run = await runCli(root, [...bindArgs(root, SESSION, BEAD), "--evidence", evidence])
			expectEnvelope(run, "msb-workflow.bind", { exit: 3, outcome: "refused", causeCode: "DOMAIN_EVIDENCE_INVALID", transactionState: "unchanged", retryable: false })
		}
		expect(durableListing(root)).toEqual([])
		const run = await runCli(root, [...bindArgs(root, SESSION, BEAD), "--evidence", inside])
		expectEnvelope(run, "msb-workflow.bind", { exit: 0, outcome: "success", causeCode: null, transactionState: "completed", retryable: false })
		expect((JSON.parse(readFileSync(bindingPath(root, SESSION), "utf8")) as { evidencePath: string }).evidencePath).toBe(inside)
	})

	test("a failure before the rename is unchanged and retryable; nothing is written", async () => {
		const run = await runCliWithStoreFault(root, bindArgs(root, SESSION, BEAD), "before-rename")
		expectEnvelope(run, "msb-workflow.bind", { exit: 75, outcome: "failed", causeCode: "UNAVAILABLE_WRITE_FAILED", transactionState: "unchanged", retryable: true })
		expect(existsSync(bindingPath(root, SESSION))).toBe(false)
		// The permanent lock files exist; the sessions directory holds neither the binding nor a leftover temporary file.
		expect(stateListing(root).filter((entry) => entry.startsWith(BINDINGS_PREFIX))).toEqual([])
	})

	test("a failure after the rename is unknown, not retryable, and names recover as the next action", async () => {
		const run = await runCliWithStoreFault(root, bindArgs(root, SESSION, BEAD), "after-rename")
		const envelope = expectEnvelope(run, "msb-workflow.bind", { exit: 1, outcome: "unknown", causeCode: "INTERNAL_WRITE_OUTCOME_UNKNOWN", transactionState: "unknown", retryable: false })
		expect(envelope.nextAction).toBe(`msb-workflow recover --workspace ${root.workspace} --session ${SESSION}`)
		expect(existsSync(bindingPath(root, SESSION))).toBe(true)
		const recovered = await runCli(root, recoverArgs(root, SESSION))
		expectEnvelope(recovered, "msb-workflow.recover", { exit: 0, outcome: "success", causeCode: null, transactionState: "unchanged", retryable: false })
	})

	test("an unsupported platform refuses before any effect", async () => {
		const run = await runCliOnPlatform(root, bindArgs(root, SESSION, BEAD), "linux")
		expectEnvelope(run, "msb-workflow.bind", { exit: 75, outcome: "failed", causeCode: "UNAVAILABLE_LOCK_UNSUPPORTED", transactionState: "unchanged", retryable: false })
		expect(existsSync(bindingPath(root, SESSION))).toBe(false)
		expect(durableListing(root).filter((entry) => entry.endsWith(".lock:600"))).toEqual([])
	})

	test("a pre-existing helper ancestor with a broader mode is refused, never corrected", async () => {
		const ancestor = join(root.stateHome, "my-second-brain-playground")
		mkdirSync(ancestor, { mode: 0o755 })
		const run = await runCli(root, bindArgs(root, SESSION, BEAD))
		expectEnvelope(run, "msb-workflow.bind", { exit: 3, outcome: "refused", causeCode: "DOMAIN_STATE_UNSAFE", transactionState: "unchanged", retryable: false })
		expect(statSync(ancestor).mode & 0o777).toBe(0o755)
		expect(stateListing(root)).toEqual(["my-second-brain-playground:755"])
		const human = await runCli(root, ["bind", "--workspace", root.workspace, "--session", SESSION, "--bead", BEAD])
		expectHumanRefusal(human, "DOMAIN_STATE_UNSAFE", 3)
		expect(stateListing(root)).toEqual(["my-second-brain-playground:755"])
	})

	test("two competing binds on one session produce one write and one storage-busy refusal", async () => {
		const holder = runCliWithStoreFault(root, bindArgs(root, SESSION, BEAD), "hold-lock-3s")
		await Bun.sleep(600)
		const contender = await runCli(root, bindArgs(root, SESSION, BEAD))
		expectEnvelope(contender, "msb-workflow.bind", { exit: 75, outcome: "failed", causeCode: "UNAVAILABLE_STORAGE_BUSY", transactionState: "unchanged", retryable: true, retryDelayMilliseconds: 2000 })
		const held = await holder
		expectEnvelope(held, "msb-workflow.bind", { exit: 0, outcome: "success", causeCode: null, transactionState: "completed", retryable: false })
		expect(existsSync(bindingPath(root, SESSION))).toBe(true)
		expect((JSON.parse(readFileSync(bindingPath(root, SESSION), "utf8")) as { beadId: string }).beadId).toBe(BEAD)
	})
})

describe("bind --from: the verified same-session switch", () => {
	// Expected values are literals from Ticket [#56](https://github.com/nathanvale/dotfiles-private/issues/56) revision 2 AC4 and the task-switch contract brief (independent oracle):
	// the switch is an expected-owner compare-and-swap on the one binding, never an override of the ordinary refusal.
	const CLAIM_OTHER = `Claim ${OTHER_BEAD} through native bd before starting work; the binding records intent, not a claim`

	test("bind --bead B --from A on a session bound to A replaces the one binding, reads it back, and returns B's panel", async () => {
		await bindSession(root, SESSION)
		const before = readFileSync(bindingPath(root, SESSION))
		const run = await runCli(root, switchArgs(root, SESSION, OTHER_BEAD, BEAD))
		const envelope = expectEnvelope(run, "msb-workflow.bind", { exit: 0, outcome: "success", causeCode: null, transactionState: "completed", retryable: false })
		expect(envelope.effectClass).toBe("repository-local")
		expect(envelope.message).toBe(`binding switched for ${SESSION}: ${BEAD} -> ${OTHER_BEAD}`)
		expect(envelope.nextAction).toBe(CLAIM_OTHER)
		const result = resultOf(run)
		expect(result.station).toBe("switched")
		expect(result.readBack).toBe(true)
		expect(result.bindingPath).toBe(bindingPath(root, SESSION))
		const previous = result.previous as Record<string, unknown>
		expect(Object.keys(previous).sort()).toEqual(["beadId", "beadObservedAt", "evidencePath", "observedAt"])
		expect(previous.beadId).toBe(BEAD)
		expect(previous.beadObservedAt).toBe("2026-09-17T03:09:16Z")
		expect(previous.evidencePath).toBeNull()
		expect(result.session).toBe(SESSION)
		expect(result.workspace).toBe(root.workspace)
		expect((result.bead as { id: string; title: string }).id).toBe(OTHER_BEAD)
		expect(result.nextSafeAction).toBe(CLAIM_OTHER)
		expect(result.resumePanel as string).toContain(`Bead: ${OTHER_BEAD} Another Bead`)
		// The durable record, read independently: one 0600 file naming B for the same session and workspace, bytes changed.
		const saved = JSON.parse(readFileSync(bindingPath(root, SESSION), "utf8")) as Record<string, unknown>
		expect([saved.schemaVersion, saved.sessionIdentity, saved.workspace, saved.beadId, saved.beadObservedAt]).toEqual([3, SESSION, root.workspace, OTHER_BEAD, "2026-09-17T08:30:13Z"])
		expect(readFileSync(bindingPath(root, SESSION)).equals(before)).toBe(false)
		expect(modeOf(bindingPath(root, SESSION))).toBe(0o600)
		expect(stateListing(root).filter((entry) => entry.startsWith(BINDINGS_PREFIX))).toEqual([`${BINDINGS_PREFIX}${SESSION}.json:600`])
		expect(existsSync(markerPath(root, SESSION))).toBe(false)
	})

	test("after the switch the old Bead is an obsolete continuation: bind --bead A refuses with savedBeadId B and names the switch in its repair", async () => {
		await bindSession(root, SESSION)
		await runCli(root, switchArgs(root, SESSION, OTHER_BEAD, BEAD))
		const switched = readFileSync(bindingPath(root, SESSION))
		const run = await runCli(root, bindArgs(root, SESSION, BEAD))
		const envelope = expectEnvelope(run, "msb-workflow.bind", { exit: 3, outcome: "refused", causeCode: "DOMAIN_BINDING_OWNERSHIP_CONFLICT", transactionState: "unchanged", retryable: false })
		expect(resultOf(run).savedBeadId).toBe(OTHER_BEAD)
		expect(envelope.repairAction).toContain(`msb-workflow bind --workspace ${root.workspace} --bead ${BEAD} --from ${OTHER_BEAD} --session ${SESSION}`)
		expect(envelope.nextAction).toBe(`msb-workflow recover --workspace ${root.workspace} --session ${SESSION}`)
		expect(readFileSync(bindingPath(root, SESSION)).equals(switched)).toBe(true)
	})

	test("after the switch recover and inspect read B from current reads", async () => {
		await bindSession(root, SESSION)
		await runCli(root, switchArgs(root, SESSION, OTHER_BEAD, BEAD))
		const recovered = await runCli(root, recoverArgs(root, SESSION))
		expectEnvelope(recovered, "msb-workflow.recover", { exit: 0, outcome: "success", causeCode: null, transactionState: "unchanged", retryable: false })
		const result = resultOf(recovered)
		expect((result.bead as { id: string }).id).toBe(OTHER_BEAD)
		expect(result.session).toBe(SESSION)
		expect(result.nextSafeAction).toBe(CLAIM_OTHER)
		expect((result.readOnlyCommands as string[])[0]).toBe(`BEADS_DIR=${join(root.workspace, ".beads")} ${FIXTURE_BD} show ${OTHER_BEAD} --readonly --json --include-comments`)
		const inspected = await runCli(root, inspectArgs(root, SESSION))
		expectEnvelope(inspected, "msb-workflow.inspect", { exit: 0, outcome: "success", causeCode: null, transactionState: "unchanged", retryable: false })
		expect((resultOf(inspected).checks as { name: string; detail: string }[]).find((check) => check.name === "binding")?.detail).toContain(`${OTHER_BEAD} in ${root.workspace}`)
	})

	test("--from that is not the saved Bead refuses as a switch mismatch naming the saved owner, and preserves the bytes", async () => {
		await bindSession(root, SESSION)
		const saved = readFileSync(bindingPath(root, SESSION))
		const run = await runCli(root, switchArgs(root, SESSION, OTHER_BEAD, SECRET_BEAD))
		const envelope = expectEnvelope(run, "msb-workflow.bind", { exit: 3, outcome: "refused", causeCode: "DOMAIN_SWITCH_FROM_MISMATCH", transactionState: "unchanged", retryable: false, retryDelayMilliseconds: null })
		expect(envelope.nextAction).toBe(`msb-workflow recover --workspace ${root.workspace} --session ${SESSION}`)
		const result = resultOf(run)
		expect(result.station).toBe("switch-from-mismatch")
		expect([result.savedBeadId, result.from, result.requestedBeadId]).toEqual([BEAD, SECRET_BEAD, OTHER_BEAD])
		expect(readFileSync(bindingPath(root, SESSION)).equals(saved)).toBe(true)
	})

	test("--from with no saved binding refuses as absent, writes no binding, and names bind without --from", async () => {
		const run = await runCli(root, switchArgs(root, SESSION, OTHER_BEAD, BEAD))
		const envelope = expectEnvelope(run, "msb-workflow.bind", { exit: 3, outcome: "refused", causeCode: "DOMAIN_BINDING_ABSENT", transactionState: "unchanged", retryable: false })
		const again = `msb-workflow bind --workspace ${root.workspace} --bead ${OTHER_BEAD} --session ${SESSION}`
		expect(envelope.nextAction).toBe(again)
		expect(envelope.repairAction).toBe(`Bind this session without --from: ${again}`)
		expect(resultOf(run).bindingPath).toBe(bindingPath(root, SESSION))
		expect(resultOf(run).from).toBe(BEAD)
		expect(stateListing(root).filter((entry) => entry.startsWith(BINDINGS_PREFIX))).toEqual([])
	})

	test("--from equal to --bead is a usage refusal before any state root or store is touched, and --from is not an option of recover or inspect", async () => {
		const same = await runCli(root, switchArgs(root, SESSION, BEAD, BEAD))
		expectEnvelope(same, "msb-workflow.bind", { exit: 2, outcome: "refused", causeCode: "USAGE_INVALID_INVOCATION", transactionState: "unchanged", retryable: false })
		expect(stateListing(root)).toEqual([])
		const recover = await runCli(root, [...recoverArgs(root, SESSION), "--from", BEAD])
		expectEnvelope(recover, "msb-workflow.recover", { exit: 2, outcome: "refused", causeCode: "USAGE_INVALID_INVOCATION", transactionState: "unchanged", retryable: false })
		const inspect = await runCli(root, [...inspectArgs(root, SESSION), "--from", BEAD])
		expectEnvelope(inspect, "msb-workflow.inspect", { exit: 2, outcome: "refused", causeCode: "USAGE_INVALID_INVOCATION", transactionState: "unchanged", retryable: false })
		const empty = await runCli(root, ["bind", "--workspace", root.workspace, "--session", SESSION, "--bead", OTHER_BEAD, "--from", "--json"])
		expectEnvelope(empty, "msb-workflow.bind", { exit: 2, outcome: "refused", causeCode: "USAGE_INVALID_INVOCATION", transactionState: "unchanged", retryable: false })
		expect(stateListing(root)).toEqual([])
	})

	test("an inherited-only identity never switches a saved owner, before any store read or lock", async () => {
		await bindSession(root, SESSION)
		const saved = readFileSync(bindingPath(root, SESSION))
		const before = durableListing(root)
		const run = await runCli(root, ["bind", "--workspace", root.workspace, "--bead", OTHER_BEAD, "--from", BEAD, "--json"], { env: { CODEX_SESSION_ID: SESSION } })
		const envelope = expectEnvelope(run, "msb-workflow.bind", { exit: 3, outcome: "refused", causeCode: "DOMAIN_SESSION_INHERITED_CONFLICT", transactionState: "unchanged", retryable: false })
		expect(envelope.nextAction).toBe(`msb-workflow recover --workspace ${root.workspace} --session ${SESSION}`)
		expect(readFileSync(bindingPath(root, SESSION)).equals(saved)).toBe(true)
		expect(durableListing(root)).toEqual(before)
		// The same identity passed explicitly as --session beside the same CODEX_SESSION_ID is explicit, and switches.
		const explicit = await runCli(root, switchArgs(root, SESSION, OTHER_BEAD, BEAD), { env: { CODEX_SESSION_ID: SESSION } })
		expectEnvelope(explicit, "msb-workflow.bind", { exit: 0, outcome: "success", causeCode: null, transactionState: "completed", retryable: false })
	})

	test("--from never switches the workspace: a different --workspace is the ordinary owner conflict, bytes preserved", async () => {
		await bindSession(root, SESSION)
		const saved = readFileSync(bindingPath(root, SESSION))
		const run = await runCli(root, switchArgs(root, SESSION, OTHER_BEAD, BEAD, secondWorkspace(root)))
		const envelope = expectEnvelope(run, "msb-workflow.bind", { exit: 3, outcome: "refused", causeCode: "DOMAIN_BINDING_OWNERSHIP_CONFLICT", transactionState: "unchanged", retryable: false })
		expect(envelope.repairAction).toContain("a saved workspace is never switched")
		expect(envelope.repairAction).not.toContain("--from")
		expect(resultOf(run).savedWorkspace).toBe(root.workspace)
		expect(readFileSync(bindingPath(root, SESSION)).equals(saved)).toBe(true)
	})

	test("the new Bead is verified in the store before any lock: a missing Bead refuses with nothing written or created", async () => {
		await bindSession(root, SESSION)
		const saved = readFileSync(bindingPath(root, SESSION))
		const before = durableListing(root)
		const run = await runCli(root, switchArgs(root, SESSION, "lkr-nope", BEAD))
		expectEnvelope(run, "msb-workflow.bind", { exit: 3, outcome: "refused", causeCode: "DOMAIN_BEAD_MISSING", transactionState: "unchanged", retryable: false, retryDelayMilliseconds: null })
		expect(readFileSync(bindingPath(root, SESSION)).equals(saved)).toBe(true)
		expect(durableListing(root)).toEqual(before)
		steerBd(root, { unavailable: "database is locked by another process" })
		const unavailable = await runCli(root, switchArgs(root, SESSION, OTHER_BEAD, BEAD))
		expectEnvelope(unavailable, "msb-workflow.bind", { exit: 75, outcome: "failed", causeCode: "UNAVAILABLE_BEADS_READ", transactionState: "unchanged", retryable: true, retryDelayMilliseconds: 1000 })
		expect(readFileSync(bindingPath(root, SESSION)).equals(saved)).toBe(true)
	})

	test("malformed or unsafe saved state refuses a switch exactly as it refuses a bind, and is never replaced", async () => {
		plantBinding(root, SESSION, "{not json\n")
		const invalid = await runCli(root, switchArgs(root, SESSION, OTHER_BEAD, BEAD))
		expectEnvelope(invalid, "msb-workflow.bind", { exit: 4, outcome: "refused", causeCode: "SCHEMA_BINDING_INVALID", transactionState: "unchanged", retryable: false })
		expect(readFileSync(bindingPath(root, SESSION), "utf8")).toBe("{not json\n")
		chmodSync(bindingPath(root, SESSION), 0o644)
		const unsafe = await runCli(root, switchArgs(root, SESSION, OTHER_BEAD, BEAD))
		expectEnvelope(unsafe, "msb-workflow.bind", { exit: 3, outcome: "refused", causeCode: "DOMAIN_STATE_UNSAFE", transactionState: "unchanged", retryable: false })
		expect(readFileSync(bindingPath(root, SESSION), "utf8")).toBe("{not json\n")
	})

	test("a failure before the rename leaves A saved and is retryable; a failure after it is unknown and recover reports the durable B", async () => {
		await bindSession(root, SESSION)
		const saved = readFileSync(bindingPath(root, SESSION))
		const failed = await runCliWithStoreFault(root, switchArgs(root, SESSION, OTHER_BEAD, BEAD), "before-rename")
		expectEnvelope(failed, "msb-workflow.bind", { exit: 75, outcome: "failed", causeCode: "UNAVAILABLE_WRITE_FAILED", transactionState: "unchanged", retryable: true })
		expect(readFileSync(bindingPath(root, SESSION)).equals(saved)).toBe(true)
		expect(stateListing(root).filter((entry) => entry.startsWith(BINDINGS_PREFIX))).toEqual([`${BINDINGS_PREFIX}${SESSION}.json:600`])
		const unknown = await runCliWithStoreFault(root, switchArgs(root, SESSION, OTHER_BEAD, BEAD), "after-rename")
		const envelope = expectEnvelope(unknown, "msb-workflow.bind", { exit: 1, outcome: "unknown", causeCode: "INTERNAL_WRITE_OUTCOME_UNKNOWN", transactionState: "unknown", retryable: false })
		expect(envelope.nextAction).toBe(`msb-workflow recover --workspace ${root.workspace} --session ${SESSION}`)
		expect(unknown.stdout).not.toContain('"station":"switched"')
		const recovered = await runCli(root, recoverArgs(root, SESSION))
		expectEnvelope(recovered, "msb-workflow.recover", { exit: 0, outcome: "success", causeCode: null, transactionState: "unchanged", retryable: false })
		expect((resultOf(recovered).bead as { id: string }).id).toBe(OTHER_BEAD)
		// The durable owner is now B, so the same switch is a mismatch that names B: the caller learns it already happened.
		const again = await runCli(root, switchArgs(root, SESSION, OTHER_BEAD, BEAD))
		expectEnvelope(again, "msb-workflow.bind", { exit: 3, outcome: "refused", causeCode: "DOMAIN_SWITCH_FROM_MISMATCH", transactionState: "unchanged", retryable: false })
		expect(resultOf(again).savedBeadId).toBe(OTHER_BEAD)
	})

	test("the switch is reported only after the durable bytes read back as the written binding: another owner read back is unknown, never switched", async () => {
		await bindSession(root, SESSION)
		const run = await runCliWithStoreFault(root, switchArgs(root, SESSION, OTHER_BEAD, BEAD), "tamper-after-rename")
		const envelope = expectEnvelope(run, "msb-workflow.bind", { exit: 1, outcome: "unknown", causeCode: "INTERNAL_WRITE_OUTCOME_UNKNOWN", transactionState: "unknown", retryable: false })
		expect(envelope.message).toContain(`read-back after the switch returned a binding naming ${TAMPERED_BEAD}, not the written ${OTHER_BEAD}`)
		expect(envelope.nextAction).toBe(`msb-workflow recover --workspace ${root.workspace} --session ${SESSION}`)
		expect(run.stdout).not.toContain('"station":"switched"')
		// The helper never rewrote the tampered bytes: what the read-back found is what recover now finds.
		expect((JSON.parse(readFileSync(bindingPath(root, SESSION), "utf8")) as { beadId: string }).beadId).toBe(TAMPERED_BEAD)
	})

	test("a held lock makes a concurrent switch busy; the serialized retry of a completed switch is a mismatch naming B, never a second write", async () => {
		await bindSession(root, SESSION)
		const holder = runCliWithStoreFault(root, switchArgs(root, SESSION, OTHER_BEAD, BEAD), "hold-lock-3s")
		await Bun.sleep(600)
		const contender = await runCli(root, switchArgs(root, SESSION, OTHER_BEAD, BEAD))
		expectEnvelope(contender, "msb-workflow.bind", { exit: 75, outcome: "failed", causeCode: "UNAVAILABLE_STORAGE_BUSY", transactionState: "unchanged", retryable: true, retryDelayMilliseconds: 2000 })
		const held = await holder
		expectEnvelope(held, "msb-workflow.bind", { exit: 0, outcome: "success", causeCode: null, transactionState: "completed", retryable: false })
		expect(resultOf(held).station).toBe("switched")
		const switched = readFileSync(bindingPath(root, SESSION))
		expect((JSON.parse(switched.toString("utf8")) as { beadId: string }).beadId).toBe(OTHER_BEAD)
		const retry = await runCli(root, switchArgs(root, SESSION, OTHER_BEAD, BEAD))
		expectEnvelope(retry, "msb-workflow.bind", { exit: 3, outcome: "refused", causeCode: "DOMAIN_SWITCH_FROM_MISMATCH", transactionState: "unchanged", retryable: false })
		expect(resultOf(retry).savedBeadId).toBe(OTHER_BEAD)
		expect(readFileSync(bindingPath(root, SESSION)).equals(switched)).toBe(true)
	})

	test("two sessions and two workspaces stay isolated: one session's switch leaves every other binding byte-identical", async () => {
		const otherWorkspace = secondWorkspace(root)
		await bindSession(root, SESSION)
		await bindSession(root, "session-2")
		const elsewhere = await runCli(root, bindArgs(root, "session-3", BEAD, otherWorkspace))
		expect(elsewhere.exit).toBe(0)
		const second = readFileSync(bindingPath(root, "session-2"))
		const third = readFileSync(bindingPath(root, "session-3"))
		const run = await runCli(root, switchArgs(root, SESSION, OTHER_BEAD, BEAD))
		expectEnvelope(run, "msb-workflow.bind", { exit: 0, outcome: "success", causeCode: null, transactionState: "completed", retryable: false })
		expect(readFileSync(bindingPath(root, "session-2")).equals(second)).toBe(true)
		expect(readFileSync(bindingPath(root, "session-3")).equals(third)).toBe(true)
		expect((resultOf(await runCli(root, recoverArgs(root, "session-2"))).bead as { id: string }).id).toBe(BEAD)
		expect((resultOf(await runCli(root, recoverArgs(root, "session-3", otherWorkspace))).bead as { id: string }).id).toBe(BEAD)
		expect((resultOf(await runCli(root, recoverArgs(root, SESSION))).bead as { id: string }).id).toBe(OTHER_BEAD)
	})

	test("human mode: the switch prints B's panel with empty stderr; mismatch and absent are one stderr line each", async () => {
		const humanSwitch = ["bind", "--workspace", root.workspace, "--session", SESSION, "--bead", OTHER_BEAD, "--from", BEAD]
		expectHumanRefusal(await runCli(root, humanSwitch), "DOMAIN_BINDING_ABSENT", 3)
		await bindSession(root, SESSION)
		expectHumanRefusal(await runCli(root, ["bind", "--workspace", root.workspace, "--session", SESSION, "--bead", OTHER_BEAD, "--from", SECRET_BEAD]), "DOMAIN_SWITCH_FROM_MISMATCH", 3)
		const run = await runCli(root, humanSwitch)
		expect(run.exit).toBe(0)
		expect(run.stderr).toBe("")
		expect(run.stdout.startsWith("# Resume Panel\n")).toBe(true)
		expect(run.stdout).toContain(`Bead: ${OTHER_BEAD} Another Bead`)
	})

	test("discovery and help carry --from on bind alone; the identities and the binding schema are unchanged", async () => {
		const discover = await runCli(root, ["--discover", "--json"])
		const commands = resultOf(discover).commands as { identity: string; argv: string }[]
		expect(commands).toHaveLength(6)
		expect(commands.find((command) => command.identity === "msb-workflow.bind")?.argv).toBe("msb-workflow bind --workspace <absolute-path> --bead <bead-id> [--session <id>] [--evidence <absolute-file>] [--from <bead-id>]")
		expect(commands.filter((command) => command.identity !== "msb-workflow.bind").some((command) => command.argv.includes("--from"))).toBe(false)
		expect((resultOf(discover).bindingSchema as { schemaVersion: number; required: string[] }).required).toHaveLength(12)
		const help = await runCli(root, ["--help"])
		expect(help.exit).toBe(0)
		expect(help.stdout).toContain("[--from <bead-id>]")
		expect(help.stdout).toContain("bind --from <bead-id> is the verified same-session switch")
	})
})

describe("bind in human mode: exactly one stderr line on every refusal and failure", () => {
	const humanBind = (session: string, bead: string): string[] => ["bind", "--workspace", root.workspace, "--session", session, "--bead", bead]

	test("success keeps stderr empty", async () => {
		const run = await runCli(root, humanBind(SESSION, BEAD))
		expect(run.exit).toBe(0)
		expect(run.stderr).toBe("")
		expect(run.stdout.length).toBeGreaterThan(0)
	})

	test("owner conflict and inherited conflict", async () => {
		await bindSession(root, SESSION)
		expectHumanRefusal(await runCli(root, humanBind(SESSION, OTHER_BEAD)), "DOMAIN_BINDING_OWNERSHIP_CONFLICT", 3)
		expectHumanRefusal(await runCli(root, ["bind", "--workspace", root.workspace, "--bead", OTHER_BEAD], { env: { CODEX_SESSION_ID: SESSION } }), "DOMAIN_SESSION_INHERITED_CONFLICT", 3)
	})

	test("storage busy", async () => {
		const holder = runCliWithStoreFault(root, bindArgs(root, SESSION, BEAD), "hold-lock-3s")
		await Bun.sleep(600)
		expectHumanRefusal(await runCli(root, humanBind(SESSION, BEAD)), "UNAVAILABLE_STORAGE_BUSY", 75)
		expect((await holder).exit).toBe(0)
	})

	test("write failed before the rename and write unknown after it", async () => {
		expectHumanRefusal(await runCliWithStoreFault(root, humanBind(SESSION, BEAD), "before-rename"), "UNAVAILABLE_WRITE_FAILED", 75)
		expectHumanRefusal(await runCliWithStoreFault(root, humanBind(SESSION, BEAD), "after-rename"), "INTERNAL_WRITE_OUTCOME_UNKNOWN", 1)
	})

	test("unsupported platform, missing Bead, store mismatch and unavailable store", async () => {
		expectHumanRefusal(await runCliOnPlatform(root, humanBind(SESSION, BEAD), "linux"), "UNAVAILABLE_LOCK_UNSUPPORTED", 75)
		expectHumanRefusal(await runCli(root, humanBind(SESSION, "lkr-nope")), "DOMAIN_BEAD_MISSING", 3)
		steerBd(root, { wherePath: "/elsewhere/.beads" })
		expectHumanRefusal(await runCli(root, humanBind(SESSION, BEAD)), "DOMAIN_STORE_MISMATCH", 3)
		steerBd(root, { unavailable: "no_beads_directory" })
		expectHumanRefusal(await runCli(root, humanBind(SESSION, BEAD)), "UNAVAILABLE_BEADS_READ", 75)
	})
})

describe("recover: the Resume Panel from current reads", () => {
	test("returns the panel for the bound session with current status, blockers, gates, comments and one next action", async () => {
		await bindSession(root, SESSION)
		const before = durableListing(root)
		const run = await runCli(root, recoverArgs(root, SESSION))
		const envelope = expectEnvelope(run, "msb-workflow.recover", { exit: 0, outcome: "success", causeCode: null, transactionState: "unchanged", retryable: false })
		expect(envelope.effectClass).toBe("inspect")
		const result = resultOf(run)
		expect(result.station).toBe("recovered")
		expect(result.session).toBe(SESSION)
		expect(result.workspace).toBe(root.workspace)
		const store = result.store as { path: string; prefix: string; executable: string; executableDigest: string; version: string }
		expect(store.path).toBe(join(root.workspace, ".beads"))
		expect(store.prefix).toBe("lkr")
		// The configured executable is the one that was run and hashed (decision D1: the digest is recorded, the version is pinned).
		expect(store.executable).toBe(FIXTURE_BD)
		expect(store.executableDigest).toBe(createHash("sha256").update(readFileSync(FIXTURE_BD)).digest("hex"))
		expect(store.version).toBe("1.3.0@f45b249ce6b4")
		const bead = result.bead as Record<string, unknown>
		expect(bead.id).toBe(BEAD)
		expect(bead.status).toBe("in_progress")
		expect(bead.assignee).toBe("migration-engineer")
		expect(bead.parent).toBe("lkr-parent")
		expect(bead.labels).toEqual(["enhancement", "ready-for-agent"])
		expect(bead.specId).toBe("https://github.com/nathanvale/dotfiles-private/issues/57")
		expect(bead.externalRef).toBe("https://github.com/nathanvale/dotfiles-private/issues/58")
		expect(result.openBlockers).toEqual(["lkr-blocker (open) Blocker bead"])
		expect(result.openHumanGates).toEqual(["lkr-gate (open) Gate: human"])
		const comments = result.recentComments as { author: string; text: string }[]
		expect(comments.map((comment) => comment.text)).toEqual(["## Checkpoint two\n\nSecond checkpoint body.", "## Checkpoint three\n\nThird checkpoint body.", "## Checkpoint four\n\nFourth checkpoint body; the newest."])
		expect((result.binding as { freshness: string; changedSinceBinding: boolean }).freshness).toBe("fresh")
		expect((result.binding as { changedSinceBinding: boolean }).changedSinceBinding).toBe(false)
		expect(result.readOnlyCommands).toEqual([
			`BEADS_DIR=${join(root.workspace, ".beads")} ${FIXTURE_BD} show ${BEAD} --readonly --json --include-comments`,
			`BEADS_DIR=${join(root.workspace, ".beads")} ${FIXTURE_BD} gate list --all --readonly --json`,
			`BEADS_DIR=${join(root.workspace, ".beads")} ${FIXTURE_BD} where --readonly --json`,
			`msb-workflow recover --workspace ${root.workspace} --session ${SESSION} --json`,
		])
		expect(result.nextSafeAction).toBe(`Wait for the open human Gate lkr-gate to close through native bd before continuing ${BEAD}; do not resolve it yourself`)
		expect(envelope.nextAction).toBe(result.nextSafeAction)
		expect((result.resumePanel as string).startsWith("# Resume Panel\n")).toBe(true)
		expect(result.resumePanel).not.toContain("## Beads prime context")
		expect(durableListing(root)).toEqual(before)
	})

	test("human mode prints the panel as prose on stdout with empty stderr", async () => {
		await bindSession(root, SESSION)
		const run = await runCli(root, ["recover", "--workspace", root.workspace, "--session", SESSION])
		expect(run.exit).toBe(0)
		expect(run.stderr).toBe("")
		expect(run.stdout.startsWith("# Resume Panel\n")).toBe(true)
		expect(run.stdout).toContain(`Next safe action: Wait for the open human Gate lkr-gate`)
	})

	test("rebuilds from current reads: a changed Bead is reported, never the bound snapshot", async () => {
		await bindSession(root, SESSION)
		steerBd(root, { beads: { [BEAD]: { status: "closed", assignee: "someone-else", updated_at: "2026-09-17T09:00:00Z", dependencies: [] } } })
		const run = await runCli(root, recoverArgs(root, SESSION))
		expectEnvelope(run, "msb-workflow.recover", { exit: 0, outcome: "success", causeCode: null, transactionState: "unchanged", retryable: false })
		const result = resultOf(run)
		expect((result.bead as { status: string; assignee: string }).status).toBe("closed")
		expect((result.bead as { assignee: string }).assignee).toBe("someone-else")
		expect((result.binding as { changedSinceBinding: boolean }).changedSinceBinding).toBe(true)
		expect(result.openBlockers).toEqual([])
		expect(result.openHumanGates).toEqual([])
		expect(result.nextSafeAction).toBe(`${BEAD} is closed; bind this session to the next Bead with msb-workflow bind before doing more work`)
	})

	// evidencePath is optional under Spec #57, so the in-progress action names only what the binding holds. The fixture
	// Bead's gate and blocker are cleared so the in-progress branch is the one reached; its status and comments stay.
	test("an in-progress Bead bound without an evidence path continues from the last comment; no evidence pointer is named", async () => {
		await bindSession(root, SESSION)
		steerBd(root, { beads: { [BEAD]: { dependencies: [] } } })
		const run = await runCli(root, recoverArgs(root, SESSION))
		const envelope = expectEnvelope(run, "msb-workflow.recover", { exit: 0, outcome: "success", causeCode: null, transactionState: "unchanged", retryable: false })
		const result = resultOf(run)
		expect(result.evidencePath).toBeNull()
		expect(result.openBlockers).toEqual([])
		expect(result.openHumanGates).toEqual([])
		const expected = `Continue ${BEAD} from the last comment; record the next checkpoint with native bd comment before compaction`
		expect(result.nextSafeAction).toBe(expected)
		expect(envelope.nextAction).toBe(expected)
		const lines = (result.resumePanel as string).split("\n")
		expect(lines).toContain("Evidence: none")
		expect(lines.filter((line) => line.startsWith("Next safe action: "))).toEqual([`Next safe action: ${expected}`])
		const human = await runCli(root, ["recover", "--workspace", root.workspace, "--session", SESSION])
		expect(human.exit).toBe(0)
		expect(human.stderr).toBe("")
		expect(human.stdout).toContain(`\nNext safe action: ${expected}\n`)
		expect(human.stdout).not.toContain("evidence pointer")
	})

	test("an in-progress Bead bound with an evidence path continues from the evidence pointer and the last comment", async () => {
		const evidence = join(root.privateRoot, "evidence.md")
		writeFileSync(evidence, "# evidence\n")
		await bindSession(root, SESSION, BEAD, ["--evidence", evidence])
		steerBd(root, { beads: { [BEAD]: { dependencies: [] } } })
		const run = await runCli(root, recoverArgs(root, SESSION))
		const envelope = expectEnvelope(run, "msb-workflow.recover", { exit: 0, outcome: "success", causeCode: null, transactionState: "unchanged", retryable: false })
		const result = resultOf(run)
		expect(result.evidencePath).toBe(evidence)
		const expected = `Continue ${BEAD} from the evidence pointer and the last comment; record the next checkpoint with native bd comment before compaction`
		expect(result.nextSafeAction).toBe(expected)
		expect(envelope.nextAction).toBe(expected)
		const lines = (result.resumePanel as string).split("\n")
		expect(lines).toContain(`Evidence: ${evidence}`)
		expect(lines.filter((line) => line.startsWith("Next safe action: "))).toEqual([`Next safe action: ${expected}`])
	})

	test("uses the bound executable, not the environment", async () => {
		await bindSession(root, SESSION)
		const unset = await runCli(root, recoverArgs(root, SESSION), { env: { MSB_WORKFLOW_BD_EXECUTABLE: undefined } })
		expectEnvelope(unset, "msb-workflow.recover", { exit: 0, outcome: "success", causeCode: null, transactionState: "unchanged", retryable: false })
		const bogus = await runCli(root, recoverArgs(root, SESSION), { env: { MSB_WORKFLOW_BD_EXECUTABLE: join(root.privateRoot, "no-bd") } })
		expectEnvelope(bogus, "msb-workflow.recover", { exit: 0, outcome: "success", causeCode: null, transactionState: "unchanged", retryable: false })
	})

	test("an absent binding is a distinct domain refusal naming bind", async () => {
		const run = await runCli(root, recoverArgs(root, SESSION))
		const envelope = expectEnvelope(run, "msb-workflow.recover", { exit: 3, outcome: "refused", causeCode: "DOMAIN_BINDING_ABSENT", transactionState: "unchanged", retryable: false })
		expect(envelope.nextAction).toBe(`msb-workflow bind --workspace ${root.workspace} --bead <bead-id> --session ${SESSION}`)
		expect(resultOf(run).bindingPath).toBe(bindingPath(root, SESSION))
		expectHumanRefusal(await runCli(root, ["recover", "--workspace", root.workspace, "--session", SESSION]), "DOMAIN_BINDING_ABSENT", 3)
	})

	test("a binding that is not schema v3 is a schema refusal, exit 4", async () => {
		plantBinding(root, SESSION, `${JSON.stringify({ schemaVersion: 2, session: SESSION })}\n`)
		const run = await runCli(root, recoverArgs(root, SESSION))
		expectEnvelope(run, "msb-workflow.recover", { exit: 4, outcome: "refused", causeCode: "SCHEMA_BINDING_INVALID", transactionState: "unchanged", retryable: false })
		expect(resultOf(run).bindingPath).toBe(bindingPath(root, SESSION))
	})

	test("a binding carrying a __proto__ member or a duplicate key is refused as schema invalid", async () => {
		await bindSession(root, SESSION)
		const valid = readFileSync(bindingPath(root, SESSION), "utf8").trimEnd()
		writeFileSync(bindingPath(root, SESSION), `${valid.slice(0, -1)},"__proto__":{"polluted":true}}\n`, { mode: 0o600 })
		const proto = await runCli(root, recoverArgs(root, SESSION))
		expectEnvelope(proto, "msb-workflow.recover", { exit: 4, outcome: "refused", causeCode: "SCHEMA_BINDING_INVALID", transactionState: "unchanged", retryable: false })
		expect(resultOf(proto).reason).toContain("__proto__")
		writeFileSync(bindingPath(root, SESSION), `${valid.slice(0, -1)},"beadId":"${OTHER_BEAD}"}\n`, { mode: 0o600 })
		const duplicate = await runCli(root, recoverArgs(root, SESSION))
		expectEnvelope(duplicate, "msb-workflow.recover", { exit: 4, outcome: "refused", causeCode: "SCHEMA_BINDING_INVALID", transactionState: "unchanged", retryable: false })
		expect(resultOf(duplicate).reason).toContain("duplicate object key")
	})

	test("a stored workspace that differs from --workspace refuses and names the bound one", async () => {
		await bindSession(root, SESSION)
		const other = secondWorkspace(root)
		const run = await runCli(root, recoverArgs(root, SESSION, other))
		const envelope = expectEnvelope(run, "msb-workflow.recover", { exit: 3, outcome: "refused", causeCode: "DOMAIN_BINDING_WORKSPACE_MISMATCH", transactionState: "unchanged", retryable: false })
		expect(envelope.nextAction).toBe(`msb-workflow recover --workspace ${root.workspace} --session ${SESSION}`)
		expect(resultOf(run).boundWorkspace).toBe(root.workspace)
	})

	test("a Bead that vanished since binding is a domain refusal, not an unavailable store", async () => {
		await bindSession(root, SESSION)
		steerBd(root, { showError: { [BEAD]: "no issues found matching the provided IDs" } })
		const run = await runCli(root, recoverArgs(root, SESSION))
		expectEnvelope(run, "msb-workflow.recover", { exit: 3, outcome: "refused", causeCode: "DOMAIN_BEAD_MISSING", transactionState: "unchanged", retryable: false, retryDelayMilliseconds: null })
	})

	test("an unavailable store is exit 75 and retryable", async () => {
		await bindSession(root, SESSION)
		steerBd(root, { unavailable: "no_beads_directory" })
		const run = await runCli(root, recoverArgs(root, SESSION))
		expectEnvelope(run, "msb-workflow.recover", { exit: 75, outcome: "failed", causeCode: "UNAVAILABLE_BEADS_READ", transactionState: "unchanged", retryable: true, retryDelayMilliseconds: 1000 })
	})

	test("a redirected store refuses inside a Git working directory and context is skipped outside one", async () => {
		await bindSession(root, SESSION)
		steerBd(root, { redirected: true })
		const inside = await runCli(root, recoverArgs(root, SESSION))
		expectEnvelope(inside, "msb-workflow.recover", { exit: 3, outcome: "refused", causeCode: "DOMAIN_STORE_MISMATCH", transactionState: "unchanged", retryable: false })
		const outside = outsideDirectory()
		extraDirectories.push(outside)
		const skipped = await runCli(root, recoverArgs(root, SESSION), { cwd: outside })
		expectEnvelope(skipped, "msb-workflow.recover", { exit: 0, outcome: "success", causeCode: null, transactionState: "unchanged", retryable: false })
		steerBd(root, { wherePath: "/elsewhere/.beads" })
		const moved = await runCli(root, recoverArgs(root, SESSION), { cwd: outside })
		expectEnvelope(moved, "msb-workflow.recover", { exit: 3, outcome: "refused", causeCode: "DOMAIN_STORE_MISMATCH", transactionState: "unchanged", retryable: false })
	})

	test("redacts the known secret values of the run on every stream and retained record", async () => {
		await bindSession(root, "secret-session", SECRET_BEAD)
		const machine = await runCli(root, recoverArgs(root, "secret-session"))
		expectEnvelope(machine, "msb-workflow.recover", { exit: 0, outcome: "success", causeCode: null, transactionState: "unchanged", retryable: false })
		expect(machine.stdout).not.toContain(SECRET_MARKER)
		expect(machine.stdout).toContain("[REDACTED]")
		const human = await runCli(root, ["recover", "--workspace", root.workspace, "--session", "secret-session"])
		expect(human.exit).toBe(0)
		expect(human.stdout).not.toContain(SECRET_MARKER)
		expect(human.stderr).not.toContain(SECRET_MARKER)
		const retained = readFileSync(bindingPath(root, "secret-session"), "utf8") + stateListing(root).join("\n")
		expect(retained).not.toContain(SECRET_MARKER)
		for (const entry of stateListing(root)) {
			if (entry.startsWith(DIAGNOSTICS_PREFIX) && entry.endsWith(":600")) expect(readFileSync(join(root.stateHome, entry.slice(0, entry.lastIndexOf(":"))), "utf8")).not.toContain(SECRET_MARKER)
		}
	})
})

describe("inspect: read-only prerequisites", () => {
	test("passes without a session and names bind as the next action", async () => {
		const run = await runCli(root, inspectArgs(root, null))
		const envelope = expectEnvelope(run, "msb-workflow.inspect", { exit: 0, outcome: "success", causeCode: null, transactionState: "unchanged", retryable: false })
		expect(envelope.nextAction).toBe(`msb-workflow bind --workspace ${root.workspace} --bead <bead-id> --session <id>`)
		const checks = resultOf(run).checks as { name: string; status: string }[]
		expect(checks.map((check) => [check.name, check.status])).toEqual([
			["executable", "pass"],
			["store", "pass"],
			["state-root", "pass"],
			["diagnostics-directory", "pass"],
			["binding", "skipped"],
			["marker", "skipped"],
			["lock-files", "skipped"],
		])
		expect(durableListing(root)).toEqual([])
	})

	test("after bind every prerequisite passes and recover is the next action", async () => {
		await bindSession(root, SESSION)
		const before = durableListing(root)
		const run = await runCli(root, inspectArgs(root, SESSION))
		const envelope = expectEnvelope(run, "msb-workflow.inspect", { exit: 0, outcome: "success", causeCode: null, transactionState: "unchanged", retryable: false })
		expect(envelope.nextAction).toBe(`msb-workflow recover --workspace ${root.workspace} --session ${SESSION}`)
		const checks = resultOf(run).checks as { name: string; status: string; detail: string }[]
		expect(checks.map((check) => [check.name, check.status])).toEqual([
			["executable", "pass"],
			["store", "pass"],
			["state-root", "pass"],
			["diagnostics-directory", "pass"],
			["binding", "pass"],
			["marker", "pass"],
			["lock-files", "pass"],
			["sessions-directory", "pass"],
		])
		expect(checks.find((check) => check.name === "binding")?.detail).toContain(`${BEAD} in ${root.workspace}`)
		expect(checks.find((check) => check.name === "lock-files")?.detail).toContain(": safe")
		expect(durableListing(root)).toEqual(before)
	})

	test.each([
		["a regular file where the helper directory belongs (ENOTDIR)", "ENOTDIR", (plugin: string) => writeFileSync(join(plugin, "workflow-cli"), "")],
		["a symlink loop on the plugin directory (ELOOP)", "ELOOP", (plugin: string) => symlinkSync(plugin, plugin)],
	])("%s fails the diagnostics-directory prerequisite with its repair, never a skip", async (_label, code, plant) => {
		const plugin = join(root.stateHome, "my-second-brain-playground")
		if (code !== "ELOOP") mkdirSync(plugin, { mode: 0o700 })
		plant(plugin)
		const run = await runCli(root, inspectArgs(root, null))
		expectEnvelope(run, "msb-workflow.inspect", { exit: 3, outcome: "refused", causeCode: "DOMAIN_PREREQUISITE_FAILED", transactionState: "unchanged", retryable: false })
		const check = (resultOf(run).checks as { name: string; status: string; detail: string; repair: string | null }[]).find((entry) => entry.name === "diagnostics-directory")
		expect(check?.status).toBe("fail")
		expect(check?.detail).toBe(`${join(plugin, "workflow-cli", "diagnostics")} is not accessible (${code})`)
		expect(check?.repair).toBe("Repair the diagnostics directory to a private 0700 directory you own (a machine-mode run creates it 0700 when absent)")
	})

	test.skipIf(typeof process.geteuid === "function" && process.geteuid() === 0)("an unreadable plugin directory (EACCES) fails the diagnostics-directory prerequisite, never a skip", async () => {
		const plugin = join(root.stateHome, "my-second-brain-playground")
		mkdirSync(plugin, { mode: 0o000 })
		try {
			const run = await runCli(root, inspectArgs(root, null))
			expectEnvelope(run, "msb-workflow.inspect", { exit: 3, outcome: "refused", causeCode: "DOMAIN_PREREQUISITE_FAILED", transactionState: "unchanged", retryable: false })
			const check = (resultOf(run).checks as { name: string; status: string; detail: string }[]).find((entry) => entry.name === "diagnostics-directory")
			expect(check?.status).toBe("fail")
			expect(check?.detail).toBe(`${join(plugin, "workflow-cli", "diagnostics")} is not accessible (EACCES)`)
		} finally {
			chmodSync(plugin, 0o700)
		}
	})

	test("names an absent binding with one repair and writes no binding, marker or lock", async () => {
		const run = await runCli(root, inspectArgs(root, SESSION))
		const envelope = expectEnvelope(run, "msb-workflow.inspect", { exit: 3, outcome: "refused", causeCode: "DOMAIN_PREREQUISITE_FAILED", transactionState: "unchanged", retryable: false })
		expect(envelope.repairAction).toBe(`Bind this session: msb-workflow bind --workspace ${root.workspace} --bead <bead-id> --session ${SESSION}`)
		const checks = resultOf(run).checks as { name: string; status: string; repair: string | null }[]
		expect(checks.filter((check) => check.status === "fail").map((check) => check.name)).toEqual(["binding"])
		expect(durableListing(root)).toEqual([])
		expectHumanRefusal(await runCli(root, ["inspect", "--workspace", root.workspace, "--session", SESSION]), "DOMAIN_PREREQUISITE_FAILED", 3)
	})

	// Only ENOENT means "absent". Every other failure to reach the sessions tree (EACCES, ELOOP, ENOTDIR) must surface
	// as unavailable or unsafe: a bound session whose binding cannot be read is never reported as "no binding".
	// The EACCES rows are skipped as root, because root traverses a 0000 directory and the failure is unobservable.
	test.skipIf(typeof process.geteuid === "function" && process.geteuid() === 0)("an unreadable sessions tree (EACCES) after bind fails sessions-directory and never reports the binding absent", async () => {
		await bindSession(root, SESSION)
		const recovery = join(root.stateHome, "my-second-brain-playground", "workflow-cli", "recovery")
		const sessions = join(recovery, "sessions")
		chmodSync(recovery, 0o000)
		try {
			const run = await runCli(root, inspectArgs(root, SESSION))
			expectEnvelope(run, "msb-workflow.inspect", { exit: 3, outcome: "refused", causeCode: "DOMAIN_PREREQUISITE_FAILED", transactionState: "unchanged", retryable: false })
			const checks = resultOf(run).checks as { name: string; status: string; detail: string; repair: string | null }[]
			const binding = checks.find((check) => check.name === "binding")
			expect(binding?.status).toBe("fail")
			expect(binding?.detail.startsWith("no binding at")).toBe(false)
			expect(binding?.repair).toBe("Repair the named private state entry (owner, mode 0600/0700, no symlink, one link)")
			const directory = checks.find((check) => check.name === "sessions-directory")
			expect(directory?.status).toBe("fail")
			expect(directory?.detail).toBe(`${sessions} is not accessible (EACCES)`)
			expect(directory?.repair).toBe("Repair the sessions directory to a private 0700 directory you own")
			expect(checks.find((check) => check.name === "marker")?.status).toBe("fail")
		} finally {
			chmodSync(recovery, 0o700)
		}
	})

	test.skipIf(typeof process.geteuid === "function" && process.geteuid() === 0)("recover on an unreadable sessions tree (EACCES) is unavailable, never DOMAIN_BINDING_ABSENT", async () => {
		await bindSession(root, SESSION)
		const recovery = join(root.stateHome, "my-second-brain-playground", "workflow-cli", "recovery")
		chmodSync(recovery, 0o000)
		try {
			const run = await runCli(root, recoverArgs(root, SESSION))
			const envelope = expectEnvelope(run, "msb-workflow.recover", { exit: 75, outcome: "failed", causeCode: "UNAVAILABLE_BEADS_READ", transactionState: "unchanged", retryable: true, retryDelayMilliseconds: 1000 })
			expect(envelope.causeCode).not.toBe("DOMAIN_BINDING_ABSENT")
			expect(envelope.message).toBe(`${join(recovery, "sessions")} is not accessible`)
		} finally {
			chmodSync(recovery, 0o700)
		}
	})

	test.each([
		["sessions itself is the loop", "sessions", (recovery: string) => `${join(recovery, "sessions")} is not a real directory`],
		["the recovery parent is the loop (ELOOP)", "recovery", (recovery: string) => `${join(recovery, "sessions")} is not accessible (ELOOP)`],
	])("a symlink loop where %s fails sessions-directory and never reports the binding absent", async (_label, loopAt, expectedDetail) => {
		const helper = join(root.stateHome, "my-second-brain-playground", "workflow-cli")
		const recovery = join(helper, "recovery")
		if (loopAt === "sessions") {
			mkdirSync(recovery, { recursive: true, mode: 0o700 })
			symlinkSync(join(recovery, "sessions"), join(recovery, "sessions"))
		} else {
			mkdirSync(helper, { recursive: true, mode: 0o700 })
			symlinkSync(recovery, recovery)
		}
		const run = await runCli(root, inspectArgs(root, SESSION))
		expectEnvelope(run, "msb-workflow.inspect", { exit: 3, outcome: "refused", causeCode: "DOMAIN_PREREQUISITE_FAILED", transactionState: "unchanged", retryable: false })
		const checks = resultOf(run).checks as { name: string; status: string; detail: string; repair: string | null }[]
		const binding = checks.find((check) => check.name === "binding")
		expect(binding?.status).toBe("fail")
		expect(binding?.detail.startsWith("no binding at")).toBe(false)
		const directory = checks.find((check) => check.name === "sessions-directory")
		expect(directory?.status).toBe("fail")
		expect(directory?.detail).toBe(expectedDetail(recovery))
		expect(directory?.repair).toBe("Repair the sessions directory to a private 0700 directory you own")
	})

	test("names a malformed binding and an unsafe lock file", async () => {
		await bindSession(root, SESSION)
		writeFileSync(bindingPath(root, SESSION), "{not json\n", { mode: 0o600 })
		const locks = join(root.stateHome, "my-second-brain-playground", "workflow-cli", "locks", "sessions")
		const lockFile = (stateListing(root).find((entry) => entry.startsWith("my-second-brain-playground/workflow-cli/locks/sessions/") && entry.endsWith(".lock:600")) ?? "").split(":")[0] as string
		chmodSync(join(root.stateHome, lockFile), 0o644)
		expect(existsSync(locks)).toBe(true)
		const run = await runCli(root, inspectArgs(root, SESSION))
		expectEnvelope(run, "msb-workflow.inspect", { exit: 3, outcome: "refused", causeCode: "DOMAIN_PREREQUISITE_FAILED", transactionState: "unchanged", retryable: false })
		const checks = resultOf(run).checks as { name: string; status: string; detail: string }[]
		expect(checks.filter((check) => check.status === "fail").map((check) => check.name)).toEqual(["binding", "lock-files"])
		expect(checks.find((check) => check.name === "binding")?.detail).toContain("not schema v3")
		expect(checks.find((check) => check.name === "lock-files")?.detail).toContain("mode is not 0600")
		expect(readFileSync(bindingPath(root, SESSION), "utf8")).toBe("{not json\n")
	})

	test("value-redacts a secret observed in a bd reply wherever it recurs in the report", async () => {
		steerBd(root, { prefix: "sekret", configPrefix: "sekret", config: { api_key: "sekret" } })
		const run = await runCli(root, inspectArgs(root, null))
		expectEnvelope(run, "msb-workflow.inspect", { exit: 0, outcome: "success", causeCode: null, transactionState: "unchanged", retryable: false })
		expect(run.stdout).not.toContain("sekret")
		expect((resultOf(run).checks as { name: string; detail: string }[]).find((check) => check.name === "store")?.detail).toContain("(prefix [REDACTED])")
	})

	test("reports the configured executable with its recorded digest", async () => {
		const run = await runCli(root, inspectArgs(root, null))
		const detail = (resultOf(run).checks as { name: string; detail: string }[]).find((check) => check.name === "executable")?.detail ?? ""
		expect(detail).toBe(`${FIXTURE_BD} (bd 1.3.0@f45b249ce6b4; sha256 ${createHash("sha256").update(readFileSync(FIXTURE_BD)).digest("hex")})`)
	})

	test("names a bad executable and skips the store read", async () => {
		const run = await runCli(root, inspectArgs(root, null), { env: { MSB_WORKFLOW_BD_EXECUTABLE: join(root.privateRoot, "no-bd") } })
		expectEnvelope(run, "msb-workflow.inspect", { exit: 3, outcome: "refused", causeCode: "DOMAIN_PREREQUISITE_FAILED", transactionState: "unchanged", retryable: false })
		const checks = resultOf(run).checks as { name: string; status: string }[]
		expect(checks.slice(0, 2).map((check) => [check.name, check.status])).toEqual([
			["executable", "fail"],
			["store", "skipped"],
		])
	})

	test("names a wrong store as a failed prerequisite and an unavailable store as exit 75", async () => {
		steerBd(root, { wherePath: "/elsewhere/.beads" })
		const wrong = await runCli(root, inspectArgs(root, null))
		expectEnvelope(wrong, "msb-workflow.inspect", { exit: 3, outcome: "refused", causeCode: "DOMAIN_PREREQUISITE_FAILED", transactionState: "unchanged", retryable: false })
		expect((resultOf(wrong).checks as { name: string; status: string }[]).find((check) => check.name === "store")?.status).toBe("fail")
		steerBd(root, { unavailable: "no_beads_directory" })
		const unavailable = await runCli(root, inspectArgs(root, null))
		expectEnvelope(unavailable, "msb-workflow.inspect", { exit: 75, outcome: "failed", causeCode: "UNAVAILABLE_BEADS_READ", transactionState: "unchanged", retryable: true, retryDelayMilliseconds: 1000 })
	})
})
