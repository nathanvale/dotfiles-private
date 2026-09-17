import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { bindingPath, envelopeOf, hookOutputOf, readJsonFile, resultOf, retainedBytes, type Root, type Run, runCli, runHook, stateListing } from "../fixtures/harness.ts"

// The native-storage seam: the production entry against the pinned bd 1.2.2 executable and an isolated throwaway
// store that `bd init` creates under $HOME/.local/state (the pinned `bd context` refuses a store under /private/tmp).
// Every process in this suite runs with a disposable fake HOME, itself a Git top level holding its own `bd init`
// store, so no bd process can discover the real ~/.beads or the selected trial store: the pinned bd walks up from
// its cwd to the enclosing Git root looking for a .beads directory whenever BEADS_DIR names a missing store. The
// pinned path and digest are literals from Ticket #58 (independent oracle), so this suite is bound to the machine
// that holds the pinned executable and fails, never skips, without it. The hook rows stop at SessionStart compact:
// the marker and lock paths are proven by the shim suites.

/** Ticket #58: the native Beads executable, its SHA-256, and the version the store gate pins. */
const PINNED_BD = "/Users/nathanvale/.local/state/trustworthy-engineering-loop-prototype/beads/bd"
const PINNED_BD_SHA256 = "9581d8bcd9662ccf9d889ee8d879787e32cd4c0249d93374eeac5044e9f24351"
const PINNED_VERSION = "1.2.2@6c124203e771"
const PREFIX = "throwaway"
const FAKE_HOME_PREFIX = "fakeglobal"
const SESSION = "native-session"
const SECRET_MARKER = "NATIVE_FIXTURE_SECRET_MARKER"
const HELPER_PREFIX = "my-second-brain-playground/workflow-cli/"
const PACKAGE_ROOT = resolve(import.meta.dir, "../..")

interface NativeStore {
	readonly root: Root
	readonly store: string
	/** The disposable HOME every process runs under: a Git top level with its own initialised .beads store. */
	readonly fakeHome: string
	/** An existing directory under the fake home with no .beads store, for the missing-store rows. */
	readonly missingWorkspace: string
	/** A Git working directory outside the fake home, where no store can be discovered. */
	readonly outside: string
	readonly bead: string
	readonly blocker: string
	readonly gate: string
}

let native: NativeStore

function bdEnvironment(fakeHome: string, store: string | null): Record<string, string> {
	return { HOME: fakeHome, PATH: process.env.PATH ?? "", ...(store === null ? {} : { BEADS_DIR: store }), NO_COLOR: "1", TERM: "dumb" }
}

/** `bd init` for one disposable store in the Git top level at `directory`, under the fake HOME. */
function initStore(fakeHome: string, directory: string, prefix: string): string {
	const created = Bun.spawnSync([PINNED_BD, "init", "--prefix", prefix, "--non-interactive", "--quiet", "--skip-agents", "--skip-hooks"], { cwd: directory, env: bdEnvironment(fakeHome, null), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
	if (created.exitCode !== 0) throw new Error(`bd init in ${directory} failed: ${created.stderr.toString()}`)
	return join(directory, ".beads")
}

/** One native bd write or read against a disposable store, through the pinned executable alone. */
function bd(fakeHome: string, store: string, cwd: string, args: readonly string[]): Record<string, unknown> | unknown[] {
	const result = Bun.spawnSync([PINNED_BD, ...args], { cwd, env: bdEnvironment(fakeHome, store), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
	if (result.exitCode !== 0) throw new Error(`bd ${args.join(" ")} exited ${result.exitCode}: ${result.stderr.toString()}`)
	return JSON.parse(result.stdout.toString()) as Record<string, unknown> | unknown[]
}

/** A fixture write or read against the throwaway workspace store. */
function nativeBd(args: readonly string[]): Record<string, unknown> | unknown[] {
	return bd(native.fakeHome, native.store, native.root.workspace, args)
}

function gitInit(directory: string): void {
	const init = Bun.spawnSync(["git", "init", "-q", directory], { stdout: "pipe", stderr: "pipe" })
	if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr.toString()}`)
}

function idOf(reply: Record<string, unknown> | unknown[]): string {
	const id = Array.isArray(reply) ? undefined : reply.id
	if (typeof id !== "string") throw new Error(`bd reply carries no id: ${JSON.stringify(reply).slice(0, 200)}`)
	return id
}

function stateHomeParent(): string {
	return process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? homedir(), ".local", "state")
}

/** Creates the throwaway root under the state home, a Git workspace with a `bd init` store, and the fixture Beads. */
function createNativeStore(): NativeStore {
	if (!existsSync(PINNED_BD)) throw new Error(`the pinned bd executable is absent at ${PINNED_BD}; Ticket #58 binds this suite to that machine`)
	const digest = createHash("sha256").update(readFileSync(PINNED_BD)).digest("hex")
	if (digest !== PINNED_BD_SHA256) throw new Error(`the executable at ${PINNED_BD} hashes ${digest}, not the pinned ${PINNED_BD_SHA256}`)
	const privateRoot = realpathSync(mkdtempSync(join(stateHomeParent(), "msb-native-")))
	const fakeHome = join(privateRoot, "home")
	const workspace = join(privateRoot, "workspace")
	const stateHome = join(privateRoot, "state")
	const missingWorkspace = join(fakeHome, "workspace-without-store")
	for (const directory of [fakeHome, workspace, stateHome, missingWorkspace]) mkdirSync(directory, { mode: 0o700 })
	// The pinned bd queues anonymous usage metrics under $HOME and flushes them from a detached child, which would
	// recreate the fake home after cleanup; the opt-out it persists in $HOME/.config/bd/config.yaml is written first.
	mkdirSync(join(fakeHome, ".config", "bd"), { recursive: true, mode: 0o700 })
	writeFileSync(join(fakeHome, ".config", "bd", "config.yaml"), "metrics:\n    disabled: true\n    notice_shown: true\n", { mode: 0o600 })
	const outside = realpathSync(mkdtempSync(join(tmpdir(), "msb-native-outside-")))
	// Each is its own Git top level: `bind` derives sourceRepository there, and bd bounds its store discovery there.
	for (const directory of [fakeHome, workspace, outside]) gitInit(directory)
	initStore(fakeHome, fakeHome, FAKE_HOME_PREFIX)
	const store = initStore(fakeHome, workspace, PREFIX)
	// Creation is not readiness: the store answers `where` with its own path before any fixture write depends on it.
	const where = bd(fakeHome, store, workspace, ["where", "--readonly", "--json"]) as Record<string, unknown>
	if (where.path !== store || where.prefix !== PREFIX) throw new Error(`bd init produced ${JSON.stringify(where)}, not ${store} with prefix ${PREFIX}`)
	const bead = idOf(bd(fakeHome, store, workspace, ["create", "Native fixture Bead", "--type", "task", "--json"]))
	const blocker = idOf(bd(fakeHome, store, workspace, ["create", "Blocker bead", "--type", "task", "--json"]))
	bd(fakeHome, store, workspace, ["dep", "add", bead, blocker, "--json"])
	const gate = idOf(bd(fakeHome, store, workspace, ["gate", "create", "--type=human", "--blocks", bead, "--reason", "Native fixture gate", "--json"]))
	bd(fakeHome, store, workspace, ["comment", bead, `First native comment with api_key=${SECRET_MARKER}`, "--json"])
	bd(fakeHome, store, workspace, ["update", bead, "--set-metadata", `api_key=${SECRET_MARKER}`, "--json"])
	return { root: { privateRoot, workspace, stateHome }, store, fakeHome, missingWorkspace, outside, bead, blocker, gate }
}

/** The pinned executable and the fake HOME for every helper process; bd inherits HOME from the helper. */
function nativeEnvironment(): Record<string, string> {
	return { HOME: native.fakeHome, MSB_WORKFLOW_BD_EXECUTABLE: PINNED_BD }
}

/** The production entry with the pinned executable configured, run from the workspace (its own Git top level). */
function run(argv: readonly string[], cwd = native.root.workspace): Promise<Run> {
	return runCli(native.root, argv, { cwd, env: nativeEnvironment(), timeoutMs: 60_000 })
}

function expectMachine(runResult: Run, identity: string, exit: number, causeCode: string | null): Record<string, unknown> {
	expect(runResult.stderr).toBe("")
	expect(runResult.exit).toBe(exit)
	const envelope = envelopeOf(runResult)
	expect(envelope.contractVersion).toBe("1.0.0")
	expect(envelope.commandIdentity).toBe(identity)
	expect(envelope.causeCode).toBe(causeCode)
	return envelope
}

/** Bindings, markers and lock files under the state root; machine-mode diagnostics are the accepted exception. */
function durableListing(): string[] {
	return stateListing(native.root).filter((entry) => entry.startsWith(`${HELPER_PREFIX}recovery`) || entry.startsWith(`${HELPER_PREFIX}locks`))
}

async function bindNative(session: string): Promise<Record<string, unknown>> {
	const bound = await run(["bind", "--workspace", native.root.workspace, "--session", session, "--bead", native.bead, "--json"])
	expectMachine(bound, "msb-workflow.bind", 0, null)
	return resultOf(bound)
}

beforeAll(() => {
	native = createNativeStore()
}, 120_000)

afterAll(() => {
	if (native === undefined) return
	// The opt-out held: nothing was queued for sending from either disposable store.
	const queued = [native.fakeHome, native.root.workspace].flatMap((home) => {
		const queue = join(home, ".beads", "eventsData")
		return existsSync(queue) ? readdirSync(queue).filter((entry) => entry.endsWith(".evtq")) : []
	})
	rmSync(native.root.privateRoot, { recursive: true, force: true })
	rmSync(native.outside, { recursive: true, force: true })
	if (queued.length > 0) throw new Error(`the pinned bd queued ${queued.length} metrics event(s) despite the opt-out: ${queued.join(", ")}`)
})

beforeEach(() => {
	// The private state root resets per scenario; the throwaway store persists for the whole suite.
	rmSync(native.root.stateHome, { recursive: true, force: true })
	mkdirSync(native.root.stateHome, { mode: 0o700 })
})

describe("the source gate against the pinned bd and a throwaway store", () => {
	test("both disposable stores live under the state home, apart from the selected trial store and the real home", () => {
		for (const store of [native.store, join(native.fakeHome, ".beads")]) {
			expect(store.startsWith(`${stateHomeParent()}/`)).toBe(true)
			expect(store.startsWith("/private/tmp/")).toBe(false)
			expect(store).not.toContain("legacy-kit-rollout-20260916/store")
			expect(store).not.toBe(join(process.env.HOME ?? homedir(), ".beads"))
		}
		expect(native.bead.startsWith(`${PREFIX}-`)).toBe(true)
	})

	test("inspect proves the pinned executable by path, digest and version, and the store by where and config list", async () => {
		const inspected = await run(["inspect", "--workspace", native.root.workspace, "--json"])
		expectMachine(inspected, "msb-workflow.inspect", 0, null)
		const result = resultOf(inspected)
		expect(result.station).toBe("inspected")
		const checks = result.checks as { name: string; status: string; detail: string }[]
		const executable = checks.find((check) => check.name === "executable")
		expect(executable?.status).toBe("pass")
		expect(executable?.detail).toBe(`${PINNED_BD} (bd ${PINNED_VERSION}; sha256 ${PINNED_BD_SHA256})`)
		const store = checks.find((check) => check.name === "store")
		expect(store?.status).toBe("pass")
		expect(store?.detail).toBe(`${native.store} (prefix ${PREFIX}) agrees with where and config list`)
	}, 60_000)

	test("a missing store with no discoverable store above the cwd is unavailable, exit 75, and nothing is bound", async () => {
		const refused = await run(["bind", "--workspace", native.missingWorkspace, "--session", "missing-session", "--bead", native.bead, "--json"], native.outside)
		const envelope = expectMachine(refused, "msb-workflow.bind", 75, "UNAVAILABLE_BEADS_READ")
		expect(envelope.retryable).toBe(true)
		expect(envelope.transactionState).toBe("unchanged")
		expect(envelope.message).toContain("no_beads_directory")
		expect(durableListing()).toEqual([])
	}, 60_000)

	test("a missing store is silently replaced by the ~/.beads the pinned bd discovers above the cwd, which the helper refuses as a mismatch without effects", async () => {
		const homeStore = join(native.fakeHome, ".beads")
		const refused = await run(["bind", "--workspace", native.missingWorkspace, "--session", "missing-session", "--bead", native.bead, "--json"], native.fakeHome)
		const envelope = expectMachine(refused, "msb-workflow.bind", 3, "DOMAIN_STORE_MISMATCH")
		expect(envelope.retryable).toBe(false)
		expect(envelope.message).toBe(`bd resolved store ${homeStore} instead of ${join(native.missingWorkspace, ".beads")}`)
		expect(durableListing()).toEqual([])
	}, 60_000)

	test("a working directory in another Git repository makes the pinned bd report the store redirected, and the helper refuses without effects", async () => {
		const refused = await run(["bind", "--workspace", native.root.workspace, "--session", "redirected-session", "--bead", native.bead, "--json"], PACKAGE_ROOT)
		const envelope = expectMachine(refused, "msb-workflow.bind", 3, "DOMAIN_STORE_MISMATCH")
		expect(envelope.message).toBe("bd context reports a redirected store")
		expect(durableListing()).toEqual([])
	}, 60_000)

	test("a Bead the pinned bd cannot find is a domain refusal that never invites a retry, and nothing is bound", async () => {
		const refused = await run(["bind", "--workspace", native.root.workspace, "--session", "typo-session", "--bead", `${PREFIX}-nope`, "--json"])
		const envelope = expectMachine(refused, "msb-workflow.bind", 3, "DOMAIN_BEAD_MISSING")
		expect(envelope.retryable).toBe(false)
		expect(envelope.message).toContain("no issues found matching the provided IDs")
		expect(durableListing()).toEqual([])
	}, 60_000)
})

describe("bind and recover against live native reads", () => {
	test("bind writes one 0600 schema-v3 binding that records the pinned executable, the store, and the Bead's updated_at as a hint", async () => {
		const result = await bindNative(SESSION)
		expect(result.station).toBe("bound")
		const path = bindingPath(native.root, SESSION)
		expect(statSync(path).mode & 0o777).toBe(0o600)
		const binding = readJsonFile(path)
		expect(binding.schemaVersion).toBe(3)
		expect(binding.beadsExecutable).toBe(PINNED_BD)
		expect(binding.beadsVersion).toBe(PINNED_VERSION)
		expect(binding.storePath).toBe(native.store)
		expect(binding.storePrefix).toBe(PREFIX)
		expect(binding.beadId).toBe(native.bead)
		expect(binding.sourceRepository).toBe(native.root.workspace)
		const shown = nativeBd(["show", native.bead, "--readonly", "--json"]) as { updated_at: string }[]
		expect(binding.beadObservedAt).toBe(shown[0]?.updated_at)
	}, 60_000)

	test("recover rebuilds the Resume Panel from live reads: title, status, the open blocker, the open human Gate, the comment, one next action", async () => {
		await bindNative(SESSION)
		const recovered = await run(["recover", "--workspace", native.root.workspace, "--session", SESSION, "--json"])
		const envelope = expectMachine(recovered, "msb-workflow.recover", 0, null)
		const result = resultOf(recovered)
		expect(result.station).toBe("recovered")
		expect(result.store).toEqual({ path: native.store, prefix: PREFIX, executable: PINNED_BD, executableDigest: PINNED_BD_SHA256, version: PINNED_VERSION })
		const bead = result.bead as Record<string, unknown>
		expect(bead.id).toBe(native.bead)
		expect(bead.title).toBe("Native fixture Bead")
		expect(bead.status).toBe("open")
		expect(result.openBlockers).toEqual([`${native.blocker} (open) Blocker bead`])
		expect(result.openHumanGates).toEqual([`${native.gate} (open) Gate: human`])
		const comments = result.recentComments as { text: string }[]
		expect(comments.map((comment) => comment.text)).toEqual(["First native comment with api_key=[REDACTED]"])
		expect((result.binding as { changedSinceBinding: boolean }).changedSinceBinding).toBe(false)
		expect(result.readOnlyCommands).toEqual([
			`BEADS_DIR=${native.store} ${PINNED_BD} show ${native.bead} --readonly --json --include-comments`,
			`BEADS_DIR=${native.store} ${PINNED_BD} gate list --all --readonly --json`,
			`BEADS_DIR=${native.store} ${PINNED_BD} where --readonly --json`,
			`msb-workflow recover --workspace ${native.root.workspace} --session ${SESSION} --json`,
		])
		expect(result.nextSafeAction).toBe(`Wait for the open human Gate ${native.gate} to close through native bd before continuing ${native.bead}; do not resolve it yourself`)
		expect(envelope.nextAction).toBe(result.nextSafeAction)
		expect(recovered.stdout).not.toContain(SECRET_MARKER)
		expect(retainedBytes(native.root)).not.toContain(SECRET_MARKER)
	}, 60_000)

	test("human mode prints the panel as prose with the secret value redacted and empty stderr", async () => {
		await bindNative(SESSION)
		const human = await run(["recover", "--workspace", native.root.workspace, "--session", SESSION])
		expect(human.exit).toBe(0)
		expect(human.stderr).toBe("")
		expect(human.stdout.startsWith("# Resume Panel\n")).toBe(true)
		expect(human.stdout).toContain(`Beads executable: ${PINNED_BD} (${PINNED_VERSION}; sha256 ${PINNED_BD_SHA256})`)
		expect(human.stdout).toContain("api_key=[REDACTED]")
		expect(human.stdout).not.toContain(SECRET_MARKER)
	}, 60_000)

	test("a native status change and comment after binding appear on the next recover, and the Bead is reported changed since binding", async () => {
		await bindNative(SESSION)
		nativeBd(["comment", native.bead, "Second native comment", "--json"])
		nativeBd(["update", native.bead, "--status", "in_progress", "--json"])
		const recovered = await run(["recover", "--workspace", native.root.workspace, "--session", SESSION, "--json"])
		expectMachine(recovered, "msb-workflow.recover", 0, null)
		const result = resultOf(recovered)
		expect((result.bead as { status: string }).status).toBe("in_progress")
		expect((result.recentComments as { text: string }[]).map((comment) => comment.text)).toEqual(["First native comment with api_key=[REDACTED]", "Second native comment"])
		expect((result.binding as { changedSinceBinding: boolean }).changedSinceBinding).toBe(true)
		expect(result.nextSafeAction).toBe(`Wait for the open human Gate ${native.gate} to close through native bd before continuing ${native.bead}; do not resolve it yourself`)
	}, 60_000)

	test("SessionStart compact delivers the live panel with the pinned bd's prime context appended, silently on stderr", async () => {
		await bindNative(SESSION)
		const event = { hook_event_name: "SessionStart", source: "compact", session_id: SESSION, cwd: native.root.workspace }
		const delivered = await runHook(native.root, event, { cwd: native.root.workspace, env: nativeEnvironment(), timeoutMs: 60_000 })
		expect(delivered.exit).toBe(0)
		expect(delivered.stderr).toBe("")
		const output = hookOutputOf(delivered)
		expect(output?.hookEventName).toBe("SessionStart")
		const text = output?.additionalContext ?? ""
		expect(text.startsWith("# Resume Panel\n")).toBe(true)
		expect(text).toContain(`Bead: ${native.bead} Native fixture Bead`)
		expect(text).toContain("\n## Beads prime context\n[bd prime]")
		expect(text).not.toContain(SECRET_MARKER)
		expect(retainedBytes(native.root)).not.toContain(SECRET_MARKER)
	}, 60_000)
})
