// Process seam for Source Intake classify tests. Each fixture is a private synthetic root with its own HOME,
// XDG_STATE_HOME, CODEX_HOME and a fake codex release first on PATH. The fake never calls a model: `exec` records what
// it inherited and prints a scripted event stream; other subcommands run a hard link of the installed codex, so every
// pre-flight probe meets the real Seatbelt sandbox. Every value is fictional. Nothing here imports the modules under test.
import { expect, test } from "bun:test"
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const PLUGIN_ROOT = resolve(import.meta.dir, "../../../..")
export const COMMAND = join(PLUGIN_ROOT, "bin/source-intake-classify")
export const RUNTIME = join(PLUGIN_ROOT, "runtime/source-intake-classify.js")
export const CHECKER = join(PLUGIN_ROOT, "bin/cli-design-check")
const FAKE_CODEX = join(import.meta.dir, "fake-codex.pl")
// Generic process fixtures owned by the source-intake-dispatch tests, reused by path so each exists once.
const SHARED_FIXTURES = resolve(import.meta.dir, "../../../source-intake-dispatch/tests/fixtures")
/** Checker adapter: an optional lane=DIR PATH selector, then stdin=FILE or stdin-busy=FILE, as in lane-adapter.sh. */
export const LANE_ADAPTER = join(import.meta.dir, "lane-adapter.sh")
/** With SOURCE_INTAKE_TEST_EXHAUST_DESCRIPTORS set, opens descriptors until the process limit before the command runs. */
export const DESCRIPTOR_LIMIT_PRELOAD = join(SHARED_FIXTURES, "descriptor-limit.ts")
export const EXHAUST_DESCRIPTORS = { SOURCE_INTAKE_TEST_EXHAUST_DESCRIPTORS: "1" }
/** Records each `codex exec` spawn from the parent side into SOURCE_INTAKE_TEST_SPAWN_LOG, before the process exists. */
export const SPAWN_RECORDER_PRELOAD = join(import.meta.dir, "spawn-recorder.ts")
/** Holds the first stdout write undelivered and marks SOURCE_INTAKE_TEST_READY. */
export const STDOUT_HOLD_PRELOAD = join(SHARED_FIXTURES, "stdout-hold.ts")

/**
 * Fixture roots stay outside the per-user temporary directory, as real receipt roots do: under it, Codex's sandbox
 * answers file metadata even for a denied path, and the pre-flight's stat probe then refuses the lane.
 */
const FIXTURE_PARENT = process.platform === "darwin" ? "/private/tmp" : tmpdir()

export const OPAQUE_ITEM_REF = "synthetic-item-001"
export const SENTINEL = "RECEIPT_SENTINEL_MUST_NOT_LEAK"
export const THREAD_ID = "synthetic-thread-0001"

/** The installed codex, when there is one. */
export const REAL_CODEX: string | null = (() => {
	const found = Bun.which("codex")
	return found === null ? null : realpathSync(found)
})()

/** The account record's home, as the command reads it: from the operating system, not HOME. */
function accountHome(): string | null {
	if (process.platform !== "darwin") return null
	const fields = Bun.spawnSync(["/usr/bin/id", "-P"]).stdout.toString().trim().split(":")
	return fields[8] ?? null
}

export const ACCOUNT_DEFAULT_ROOT: string | null = (() => {
	const home = accountHome()
	return home === null ? null : join(home, ".local", "state", "my-second-brain-playground")
})()

/**
 * The lane can run here only on macOS with codex installed and the account default receipt root present: the
 * pre-flight refuses a missing root, because a missing path answers ENOENT, not a permission denial.
 */
export const LANE_READY = process.platform === "darwin" && REAL_CODEX !== null && ACCOUNT_DEFAULT_ROOT !== null && existsSync(ACCOUNT_DEFAULT_ROOT)
export const LANE_SKIP_RATIONALE = "needs macOS, an installed codex and the account default receipt root; the pre-flight fails closed without them"

export interface ProofLedger {
	/** A proof that runs only where its environment allows; the ledger counts whether it ran. */
	test(name: string, body: () => void | Promise<void>, timeout?: number): void
	/** Declared last in a file: asserts the skip rationale and pins the covered and skipped counts for this environment. */
	pin(expected: number): void
}

/**
 * One ledger per environment condition and test file. Where the condition holds, every registered proof must run, so
 * a proof downgraded to a silent skip or dropped from the file fails the pin. Where it does not hold, every proof
 * skips visibly and the pin expects exactly that many skips: the ledger does not detect an environment that should
 * have been ready.
 */
export function proofLedger(ready: boolean, rationale: string): ProofLedger {
	let registered = 0
	let covered = 0
	return {
		test(name, body, timeout) {
			registered += 1
			test.skipIf(!ready)(
				name,
				async () => {
					covered += 1
					await body()
				},
				timeout,
			)
		},
		pin(expected) {
			test(`proof ledger (${rationale}): the skip rationale is stated and covered and skipped counts are pinned`, () => {
				expect(rationale.trim()).not.toBe("")
				expect(registered).toBe(expected)
				expect({ covered, skipped: registered - covered }).toEqual(ready ? { covered: expected, skipped: 0 } : { covered: 0, skipped: expected })
			})
		},
	}
}

/** The ledger for lane proofs, which need macOS, an installed codex and the account default receipt root. */
export function laneLedger(): ProofLedger {
	return proofLedger(LANE_READY, LANE_SKIP_RATIONALE)
}

// Independent oracle: restated from the Ticket #158 lane refusal and the published Contract Core 2.0 envelope, not
// imported from src, so a change to the production refusal fails these tests instead of redefining them.
export const LANE_REFUSAL_JSON =
	'{"envelopeVersion":2,"contractVersion":"2.0.0","message":"Classifier lane not started. Its read-prevention pre-flight did not pass.","availablePaths":["source-intake-classify.classify","source-intake-classify.command-discovery","source-intake-classify.discovery","source-intake-classify.help"],"result":{"runId":"run-source-intake-classify.classify","commandIdentity":"source-intake-classify.classify","outcome":"refused","effectClass":"external","transactionState":"unchanged","causeCode":"DOMAIN_PRECONDITION_UNMET","failureClass":"domain","exitCode":3,"data":null,"retryable":false,"repairAction":"Inspect the Codex install, the lane profile and both receipt roots, then retry.","effects":{"completed":[],"inventoryComplete":true,"remaining":[],"uncertain":[]},"nextAction":"Ask the granted foreground Steward to inspect the classifier lane pre-flight before any retry."}}\n'

export interface ProcessResult {
	exitCode: number | null
	stderr: string
	stdout: string
}

export type FakeMode = "honest" | "open" | "slow-probe" | "render-variant"

export interface Fixture {
	root: string
	home: string
	stateHome: string
	privateRoot: string
	receiptPath: string
	fakeRoot: string
	/** A second fake release whose sandbox runs every probe unsandboxed: the weakened-lane double. */
	openFakeRoot: string
	inputs: string
	env: Record<string, string>
}

/** The classification a fake lane returns: fictional and schema-valid. */
export function classification(): Record<string, unknown> {
	return {
		summary: "A fictional planning note.",
		ownerKind: "project",
		ownerName: "Fictional Garden Project",
		competingOwners: ["Fictional Home Area"],
		uncertainty: "Only the display name and type were granted.",
		decisionQuestion: "File the fictional note under the Fictional Garden Project?",
		nextAction: "Ask Nathan the decision question.",
	}
}

/** A scripted `codex exec --json` event stream. */
export function events(options: { thread?: boolean; message?: string | null; completed?: boolean } = {}): string {
	const lines: unknown[] = []
	if (options.thread ?? true) lines.push({ type: "thread.started", thread_id: THREAD_ID })
	lines.push({ type: "turn.started" })
	const message = options.message === undefined ? JSON.stringify(classification()) : options.message
	if (message !== null) lines.push({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: message } })
	if (options.completed ?? true) lines.push({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })
	return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`
}

export function setFake(fixture: Fixture, mode: FakeMode, stream = events(), exitCode = 0): void {
	writeFileSync(join(fixture.fakeRoot, "mode"), mode)
	writeFileSync(join(fixture.fakeRoot, "events.jsonl"), stream)
	writeFileSync(join(fixture.fakeRoot, "exit-code"), String(exitCode))
}

/** A fake codex release: bin/codex is the fake, release/codex a hard link of the installed codex it delegates to. */
function createFake(fakeRoot: string, mode: FakeMode): void {
	mkdirSync(join(fakeRoot, "bin"), { recursive: true, mode: 0o700 })
	mkdirSync(join(fakeRoot, "release"), { mode: 0o700 })
	copyFileSync(FAKE_CODEX, join(fakeRoot, "bin", "codex"))
	chmodSync(join(fakeRoot, "bin", "codex"), 0o755)
	const delegate = join(fakeRoot, "release", "codex")
	if (REAL_CODEX !== null) linkSync(REAL_CODEX, delegate)
	writeFileSync(join(fakeRoot, "real-codex"), delegate)
	writeFileSync(join(fakeRoot, "mode"), mode)
	writeFileSync(join(fakeRoot, "events.jsonl"), events())
	writeFileSync(join(fakeRoot, "exit-code"), "0")
}

export function createFixture(): Fixture {
	const root = realpathSync(mkdtempSync(join(FIXTURE_PARENT, "source-intake-classify-test-")))
	const home = join(root, "home")
	const stateHome = join(root, "state")
	const privateRoot = join(stateHome, "my-second-brain-playground")
	const itemDirectory = join(privateRoot, "drive-inbox-filing", "items", OPAQUE_ITEM_REF)
	const codexHome = join(root, "codex-home")
	const inputs = join(root, "inputs")
	for (const directory of [home, itemDirectory, codexHome, inputs]) mkdirSync(directory, { recursive: true, mode: 0o700 })
	const receiptPath = join(itemDirectory, "classification-metadata.json")
	writeFileSync(receiptPath, JSON.stringify({ displayName: "Fictional planning note", receiptSummary: SENTINEL }))
	writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ fixture: SENTINEL }))
	const fakeRoot = join(root, "fake-codex")
	const openFakeRoot = join(root, "fake-codex-open")
	createFake(fakeRoot, "honest")
	createFake(openFakeRoot, "open")
	return {
		root,
		home,
		stateHome,
		privateRoot,
		receiptPath,
		fakeRoot,
		openFakeRoot,
		inputs,
		env: {
			HOME: home,
			PATH: `${join(fakeRoot, "bin")}:/usr/bin:/bin`,
			XDG_STATE_HOME: stateHome,
			CODEX_HOME: codexHome,
			TMPDIR: process.env.TMPDIR ?? tmpdir(),
			FIXTURE_SENTINEL: SENTINEL,
		},
	}
}

/** Deletes only this fixture's own temporary root, including its hard link to codex (never the installed binary). */
export function removeFixture(fixture: Fixture): void {
	rmSync(fixture.root, { force: true, recursive: true })
}

export interface ExecObservation {
	descriptors: number[]
	env: Record<string, string>
	argv: string[]
	stdin: string
}

/** What each fake `codex exec` inherited and received, in order. Empty means the model was never started. */
export function execObservations(fixture: Fixture): ExecObservation[] {
	const names = readdirSync(fixture.fakeRoot).filter((name) => /^exec-\d+\.json$/.test(name))
	return names.sort().map((name) => JSON.parse(readFileSync(join(fixture.fakeRoot, name), "utf8")) as ExecObservation)
}

export function clearObservations(fixture: Fixture): void {
	for (const name of readdirSync(fixture.fakeRoot).filter((entry) => /^exec-\d+\.json$/.test(entry) || entry === "exec-started")) rmSync(join(fixture.fakeRoot, name))
}

/** True when any fake `codex exec` began, even one killed before it recorded an observation. */
export function execStarted(fixture: Fixture): boolean {
	return existsSync(join(fixture.fakeRoot, "exec-started"))
}

/** A valid lane input: the dispatch projection, public owner notes and redacted Bead state. */
export function laneInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		dispatch: { opaqueItemRef: OPAQUE_ITEM_REF, projection: { displayName: "Fictional planning note", mimeType: "text/plain" } },
		ownerNotes: [{ title: "Fictional Garden Project", text: "A fictional project for garden planning notes." }],
		beadState: "dfi-test: in_progress; receipt [REDACTED]",
		...overrides,
	}
}

export function writeInput(fixture: Fixture, value: unknown, name: string): string {
	const path = join(fixture.inputs, `${name}.json`)
	writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value))
	return path
}

export interface InvokeOptions {
	stdin?: string
	stdinPath?: string
	preload?: string
	env?: Record<string, string>
}

/** Runs the public command. Standard input is empty unless a test pipes text or redirects a path. */
export function invoke(fixture: Fixture, args: readonly string[], options: InvokeOptions = {}): ProcessResult {
	const target = options.preload === undefined ? [COMMAND, ...args] : [process.execPath, "--preload", options.preload, RUNTIME, ...args]
	const cmd = options.stdinPath === undefined ? target : ["/bin/sh", "-c", 'file=$1; shift; exec "$@" < "$file"', "sh", options.stdinPath, ...target]
	const stdin = options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin)
	// The bin wrapper finds bun on PATH; the fixture PATH puts the fake codex first and keeps the system directories.
	const env = { ...fixture.env, PATH: `${fixture.env.PATH}:${resolve(process.execPath, "..")}`, ...options.env }
	const child = Bun.spawnSync({ cmd, cwd: fixture.root, env, stdin, stderr: "pipe", stdout: "pipe", timeout: 60_000 })
	return { exitCode: child.exitCode, stderr: new TextDecoder().decode(child.stderr), stdout: new TextDecoder().decode(child.stdout) }
}

// biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary envelope fields after a strict JSON parse.
export function envelope(result: ProcessResult): any {
	return JSON.parse(result.stdout)
}
