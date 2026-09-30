// Process seam for Source Intake dispatch tests. Each fixture is a private synthetic root with its own XDG_STATE_HOME,
// one opaque item directory, and a scratch directory outside the items tree. The grant and request reach the command
// on standard input. Every value is fictional. Nothing here imports the modules under test.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const PLUGIN_ROOT = resolve(import.meta.dir, "../../../..")
export const COMMAND = join(PLUGIN_ROOT, "bin/source-intake-dispatch")
export const RUNTIME = join(PLUGIN_ROOT, "runtime/source-intake-dispatch.js")
export const CHECKER = join(PLUGIN_ROOT, "bin/cli-design-check")
/** With SOURCE_INTAKE_TEST_EXHAUST_DESCRIPTORS set, opens descriptors until the process limit before the command runs. */
export const DESCRIPTOR_LIMIT_PRELOAD = join(import.meta.dir, "descriptor-limit.ts")
export const EXHAUST_DESCRIPTORS = { SOURCE_INTAKE_TEST_EXHAUST_DESCRIPTORS: "1" }
/** Checker adapter: maps a leading stdin=FILE or stdin-busy=FILE argument onto the command's standard input. */
export const STDIN_ADAPTER = join(import.meta.dir, "stdin-adapter.sh")
/** Pauses after the item directory is pinned and before the receipt is opened; marks SOURCE_INTAKE_TEST_PAUSE_MARKER. */
export const PIN_PAUSE_PRELOAD = join(import.meta.dir, "pin-pause.ts")
/** Holds the first stdout write undelivered and marks SOURCE_INTAKE_TEST_READY. */
export const STDOUT_HOLD_PRELOAD = join(import.meta.dir, "stdout-hold.ts")

export const OPAQUE_ITEM_REF = "synthetic-item-001"
export const SENTINEL = "RECEIPT_SENTINEL_MUST_NOT_LEAK"

// Independent oracle: restated from the Ticket #136 refusal and the published Contract Core 2.0 envelope, not
// imported from src, so a change to the production refusal fails these tests instead of redefining them.
export const REFUSAL_JSON =
	'{"envelopeVersion":2,"contractVersion":"2.0.0","message":"Request denied. Stage Manager must verify the private grant before retrying.","availablePaths":["source-intake-dispatch.command-discovery","source-intake-dispatch.discovery","source-intake-dispatch.help","source-intake-dispatch.project","source-intake-dispatch.redacted"],"result":{"runId":"run-source-intake-dispatch.project","commandIdentity":"source-intake-dispatch.project","outcome":"refused","effectClass":"inspect","transactionState":"unchanged","causeCode":"DOMAIN_PRECONDITION_UNMET","failureClass":"domain","exitCode":3,"data":null,"retryable":false,"repairAction":"Verify the private grant, then issue a request that matches it exactly.","effects":{"completed":[],"inventoryComplete":true,"remaining":[],"uncertain":[]},"nextAction":"Ask Stage Manager to verify the private grant and issue a matching request."}}\n'
// Independent oracle: the human-mode form of the same refusal.
export const REFUSAL_HUMAN =
	"Request denied. Stage Manager must verify the private grant before retrying. Next: Ask Stage Manager to verify the private grant and issue a matching request.\n"

export interface ProcessResult {
	exitCode: number | null
	stderr: string
	stdout: string
}

export interface Fixture {
	root: string
	stateHome: string
	itemDirectory: string
	receiptPath: string
	inputs: string
	env: Record<string, string>
}

export function createFixture(): Fixture {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "source-intake-dispatch-")))
	const stateHome = join(root, "state")
	const itemDirectory = join(stateHome, "my-second-brain-playground", "drive-inbox-filing", "items", OPAQUE_ITEM_REF)
	const inputs = join(root, "inputs")
	mkdirSync(itemDirectory, { recursive: true })
	mkdirSync(inputs)
	return {
		root,
		stateHome,
		itemDirectory,
		receiptPath: join(itemDirectory, "classification-metadata.json"),
		inputs,
		env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "", XDG_STATE_HOME: stateHome },
	}
}

/** Restores permissions a test removed, then deletes only this fixture's own temporary root. */
export function removeFixture(fixture: Fixture): void {
	if (existsSync(fixture.itemDirectory)) chmodSync(fixture.itemDirectory, 0o700)
	rmSync(fixture.root, { force: true, recursive: true })
}

export function writeJson(path: string, value: unknown): string {
	writeFileSync(path, JSON.stringify(value))
	return path
}

export function createFifo(path: string): void {
	const result = Bun.spawnSync({ cmd: ["mkfifo", path], stderr: "pipe", stdout: "pipe" })
	if (result.exitCode !== 0) throw new Error("mkfifo failed")
}

export function receipt(): Record<string, string | number> {
	return { displayName: "Fictional planning note", mimeType: "text/plain", modifiedTime: "2026-01-02T03:04:05Z", sizeBytes: 1234, receiptSummary: SENTINEL }
}

export function grant(fixture: Fixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { opaqueItemRef: OPAQUE_ITEM_REF, provider: "luna", purpose: "classification", allowedFields: ["displayName", "mimeType"], receiptPath: fixture.receiptPath, ...overrides }
}

export function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { opaqueItemRef: OPAQUE_ITEM_REF, provider: "luna", purpose: "classification", requestedFields: ["displayName", "mimeType"], ...overrides }
}

/** The one piped input document: the grant and the request. */
export function input(grantValue: unknown, requestValue: unknown): string {
	return JSON.stringify({ grant: grantValue, request: requestValue })
}

/** Writes one piped input document under the fixture's scratch directory and returns its path. */
export function writeInput(fixture: Fixture, grantValue: unknown, requestValue: unknown, name = "case"): string {
	const path = join(fixture.inputs, `${name}-input.json`)
	writeFileSync(path, input(grantValue, requestValue))
	return path
}

export interface InvokeOptions {
	/** Text piped to standard input. */
	stdin?: string
	/** A path redirected onto standard input by the shell, so a directory or FIFO can stand in for a pipe. */
	stdinPath?: string
	/** Runs the committed runtime under this preload instead of the bin wrapper. */
	preload?: string
	env?: Record<string, string>
}

/** Runs the public command. Standard input is empty unless a test pipes text or redirects a path. */
export function invoke(fixture: Fixture, args: readonly string[], options: InvokeOptions = {}): ProcessResult {
	const target = options.preload === undefined ? [COMMAND, ...args] : [process.execPath, "--preload", options.preload, RUNTIME, ...args]
	const cmd = options.stdinPath === undefined ? target : ["/bin/sh", "-c", 'file=$1; shift; exec "$@" < "$file"', "sh", options.stdinPath, ...target]
	const stdin = options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin)
	const child = Bun.spawnSync({ cmd, cwd: fixture.root, env: { ...fixture.env, ...options.env }, stdin, stderr: "pipe", stdout: "pipe", timeout: 5000 })
	return { exitCode: child.exitCode, stderr: new TextDecoder().decode(child.stderr), stdout: new TextDecoder().decode(child.stdout) }
}

// biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary envelope fields after a strict JSON parse.
export function envelope(result: ProcessResult): any {
	return JSON.parse(result.stdout)
}
