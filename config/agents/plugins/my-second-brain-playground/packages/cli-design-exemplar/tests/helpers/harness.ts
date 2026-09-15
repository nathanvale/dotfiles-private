import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// Public process seam (brief 12, 7.3): Bun.spawn the real executable under a fresh fixture root with a pinned,
// scrubbed environment; both streams piped; stdin ignored. Every expected value in the tests is a literal
// restated from the immutable fixture and Contract Core, never read from the code under test.

export const MAIN = resolve(import.meta.dir, "../../src/main.ts")
export const SECRET_MARKER = "CDS_QI_SECRET_MARKER_REPAIR_LAB"
export const RESET_RESOURCE = '{"resource":"demo","revision":4,"status":"healthy","version":1}\n'

export type Variant =
	| "healthy"
	| "healthy-with-fresh-preview"
	| "healthy-with-partial-preview"
	| "revision-5-with-revision-4-preview"
	| "derived-index-missing"
	| "derived-index-missing-with-fresh-preview"
	| "unknown-after-partial"
	| "secret-marker-in-diagnostic-field"
	| "checker-target"
	| "repair-stale"
	| "healthy-with-repair-preview"
	| "derived-index-missing-with-apply-preview"
	| "healthy-with-mismatched-effects-preview"
	| "derived-index-missing-with-mismatched-effects-preview"
	| "healthy-with-consumed-preview"

export interface Root {
	root: string
	privateRoot: string
	sentinel: string
}

const APPLY_PREVIEW = (id: string, revision = 4) => `${JSON.stringify({ preview_id: id, kind: "apply", resource_revision: revision, expected_effect_ids: ["effect.update-index", "effect.write-journal"], consumed: false })}\n`
const REPAIR_PREVIEW = `${JSON.stringify({ preview_id: "repair-preview-missing-index", kind: "repair", resource_revision: 4, expected_effect_ids: ["effect.repair-cache", "effect.write-journal"], consumed: false })}\n`

export function createRoot(variant: Variant, parent?: string): Root {
	let privateRoot: string
	if (parent === undefined) privateRoot = realpathSync(mkdtempSync(join(tmpdir(), "repair-lab-")))
	else {
		// Caller-supplied parents retain private run roots for later inspection.
		mkdirSync(parent, { recursive: true, mode: 0o700 })
		privateRoot = realpathSync(parent)
	}
	const fixtures = join(privateRoot, "fixtures", "repair-lab")
	// Two levels below the sentinel: the fixture's `../../outside-root-sentinel` resolves exactly to it (brief 12, 3.1).
	const root = join(fixtures, "lab", "run")
	mkdirSync(join(root, "state"), { recursive: true })
	mkdirSync(join(root, "receipts"), { recursive: true })
	const sentinel = join(fixtures, "outside-root-sentinel")
	writeFileSync(sentinel, "sentinel-bytes\n")
	chmodSync(sentinel, 0o000)
	let resource = RESET_RESOURCE
	let preview: string | null = null
	let journal = ""
	switch (variant) {
		case "healthy":
			break
		case "healthy-with-fresh-preview":
			preview = APPLY_PREVIEW("preview-healthy-revision-4")
			break
		case "healthy-with-partial-preview":
			preview = APPLY_PREVIEW("preview-partial-revision-4")
			break
		case "revision-5-with-revision-4-preview":
			resource = '{"resource":"demo","revision":5,"status":"healthy","version":1}\n'
			preview = APPLY_PREVIEW("preview-stale-revision-4")
			break
		case "derived-index-missing":
			resource = '{"resource":"demo","revision":4,"status":"index-missing","version":1}\n'
			break
		case "derived-index-missing-with-fresh-preview":
			resource = '{"resource":"demo","revision":4,"status":"index-missing","version":1}\n'
			preview = REPAIR_PREVIEW
			break
		case "unknown-after-partial":
			resource = '{"resource":"demo","revision":5,"status":"healthy","version":1}\n'
			preview = `${JSON.stringify({ preview_id: "preview-partial-revision-4", kind: "apply", resource_revision: 4, expected_effect_ids: ["effect.update-index", "effect.write-journal"], consumed: true, consumed_by_run: "run-fixture" })}\n`
			journal = [
				JSON.stringify({ kind: "intent", seq: 1, run: "run-fixture", effect: "effect.update-index", operation: "apply", preview_id: "preview-partial-revision-4" }),
				JSON.stringify({ kind: "completed", seq: 2, run: "run-fixture", effect: "effect.update-index", operation: "apply", preview_id: "preview-partial-revision-4", resource_revision: 5 }),
				JSON.stringify({ kind: "intent", seq: 3, run: "run-fixture", effect: "effect.write-journal", operation: "apply", preview_id: "preview-partial-revision-4" }),
			].join("\n")
			journal += "\n"
			break
		case "secret-marker-in-diagnostic-field":
			resource = `${JSON.stringify({ resource: "demo", revision: 4, status: "healthy", version: 1, diagnostic_token: SECRET_MARKER })}\n`
			break
		case "checker-target":
			resource = `${JSON.stringify({ resource: "demo", revision: 4, status: "healthy", version: 1, diagnostic_token: SECRET_MARKER })}\n`
			writeFileSync(join(root, "state", "malformed.json"), '{"resource":"demo","revision":4,"stat')
			writeFileSync(join(root, "state", "large.json"), `${JSON.stringify({ resource: "demo", revision: 4, status: "healthy", version: 1, payload: largePayload() })}\n`)
			break
		case "repair-stale":
			resource = '{"resource":"demo","revision":5,"status":"index-missing","version":1}\n'
			preview = REPAIR_PREVIEW
			break
		case "healthy-with-repair-preview":
			preview = REPAIR_PREVIEW
			break
		case "derived-index-missing-with-apply-preview":
			resource = '{"resource":"demo","revision":4,"status":"index-missing","version":1}\n'
			preview = APPLY_PREVIEW("preview-healthy-revision-4")
			break
		case "healthy-with-mismatched-effects-preview":
			preview = `${JSON.stringify({ preview_id: "preview-healthy-revision-4", kind: "apply", resource_revision: 4, expected_effect_ids: ["effect.update-index"], consumed: false })}\n`
			break
		case "derived-index-missing-with-mismatched-effects-preview":
			resource = '{"resource":"demo","revision":4,"status":"index-missing","version":1}\n'
			preview = `${JSON.stringify({ preview_id: "repair-preview-missing-index", kind: "repair", resource_revision: 4, expected_effect_ids: ["effect.repair-cache"], consumed: false })}\n`
			break
		case "healthy-with-consumed-preview":
			preview = `${JSON.stringify({ preview_id: "preview-healthy-revision-4", kind: "apply", resource_revision: 4, expected_effect_ids: ["effect.update-index", "effect.write-journal"], consumed: true, consumed_by_run: "run-fixture" })}\n`
			break
	}
	writeFileSync(join(root, "state", "resource.json"), resource)
	if (preview !== null) writeFileSync(join(root, "state", "preview.json"), preview)
	writeFileSync(join(root, "state", "journal.jsonl"), journal)
	writeFileSync(join(root, "receipts", "events.jsonl"), "")
	return { root, privateRoot, sentinel }
}

// Test-authored deterministic 2 MiB payload: a 36-character alphabet cycled with a running decimal index every
// 64 characters, so any same-length substitution changes the string (brief 12, 7.4).
export function largePayload(): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	const parts: string[] = []
	let index = 0
	let length = 0
	while (length < 2_097_152) {
		const stamp = String(index).padStart(8, "0")
		let block = stamp
		let cursor = index
		while (block.length < 64) {
			block += alphabet[cursor % 36]
			cursor += 1
		}
		parts.push(block)
		length += 64
		index += 1
	}
	return parts.join("").slice(0, 2_097_152)
}

export function removeRoot(root: Root): void {
	try {
		chmodSync(root.sentinel, 0o600)
	} catch {
		// sentinel may already be removed
	}
	rmSync(root.privateRoot, { recursive: true, force: true })
}

export interface Run {
	stdout: string
	stderr: string
	exit: number
	signal: string | null
}

export interface RunOptions {
	fault?: string
	env?: Record<string, string>
	cwd?: string
	timeoutMs?: number
}

export async function runCli(root: Root, argv: string[], options: RunOptions = {}): Promise<Run> {
	const env: Record<string, string> = { HOME: process.env.HOME ?? "/", NO_COLOR: "1", TERM: "dumb", PATH: process.env.PATH ?? "", ...(options.env ?? {}) }
	if (options.fault !== undefined) env.REPAIR_LAB_FAULT = options.fault
	const child = Bun.spawn(["bun", "run", MAIN, ...argv], { cwd: options.cwd ?? root.root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
	const deadline = options.timeoutMs ?? 20_000
	let timedOut = false
	const timer = setTimeout(() => {
		timedOut = true
		child.kill("SIGKILL")
	}, deadline)
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
	const exit = await child.exited
	clearTimeout(timer)
	if (timedOut) throw new Error(`repair-lab hung for ${deadline} ms; partial stdout ${stdout.length} bytes`)
	return { stdout, stderr, exit, signal: child.signalCode }
}

export function envelopeOf(run: Run): Record<string, unknown> {
	if (!run.stdout.endsWith("\n")) throw new Error(`stdout does not end with a newline: ${run.stdout.slice(-40)}`)
	const parsed = JSON.parse(run.stdout) as unknown
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("stdout is not one JSON object")
	return parsed as Record<string, unknown>
}

export function readState(root: Root): { resource: string; preview: string | null; journal: string } {
	const state = join(root.root, "state")
	return {
		resource: readFileSync(join(state, "resource.json"), "utf8"),
		preview: existsSync(join(state, "preview.json")) ? readFileSync(join(state, "preview.json"), "utf8") : null,
		journal: readFileSync(join(state, "journal.jsonl"), "utf8"),
	}
}

export function journalRecords(root: Root): Array<Record<string, unknown>> {
	return readState(root)
		.journal.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
}

export function diagnosticsFiles(root: Root): string[] {
	const directory = join(root.root, "diagnostics")
	return existsSync(directory) ? readdirSync(directory).sort() : []
}

export function diagnosticsRecords(root: Root, file: string): Array<Record<string, unknown>> {
	return readFileSync(join(root.root, "diagnostics", file), "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
}

export function modeOf(path: string): number {
	return statSync(path).mode & 0o777
}

// The fixture's hostile argv must name the sentinel itself (not a path nothing creates), its mode must still be 0000
// (never accessed by a writing escape) and its bytes unchanged (F11).
export function sentinelUntouched(root: Root): boolean {
	const target = resolve(root.root, "../../outside-root-sentinel")
	if (target !== root.sentinel) throw new Error(`hostile argv target ${target} is not the sentinel ${root.sentinel}`)
	if (modeOf(root.sentinel) !== 0o000) return false
	chmodSync(root.sentinel, 0o600)
	const bytes = readFileSync(root.sentinel, "utf8")
	chmodSync(root.sentinel, 0o000)
	return bytes === "sentinel-bytes\n"
}

export function linkOutside(root: Root, name: string): string {
	const outside = join(root.privateRoot, "outside-dir")
	mkdirSync(outside, { recursive: true })
	writeFileSync(join(outside, "resource.json"), RESET_RESOURCE)
	const link = join(root.root, "state", name)
	symlinkSync(outside, link)
	return link
}

// Final-component symlink containment (PR 184, thread 4003813337): the named state file is replaced by a symlink to an
// outside file holding the given bytes; the returned path lets the test re-read those bytes independently afterwards.
export function linkStateFile(root: Root, name: "preview.json" | "journal.jsonl" | "resource.json", bytes: string): string {
	const outside = join(root.privateRoot, "outside-dir")
	mkdirSync(outside, { recursive: true })
	const target = join(outside, name)
	writeFileSync(target, bytes)
	const link = join(root.root, "state", name)
	rmSync(link, { force: true })
	symlinkSync(target, link)
	return target
}

// Exact comparison (brief 12, 8.2): every occurrence of the run token becomes run-NORMALIZED; sinkFailure is nulled.
export function normalize(text: string, runIdentity: string): Record<string, unknown> {
	const parsed = JSON.parse(text.split(runIdentity).join("run-NORMALIZED")) as Record<string, unknown>
	const result = parsed.result as Record<string, unknown> | null
	if (result !== null && typeof result.diagnostics === "object" && result.diagnostics !== null) (result.diagnostics as Record<string, unknown>).sinkFailure = null
	return parsed
}

// W2 witness (brief 12, 8.1): the journal is made unwritable after the fresh preview is in place; the intent append fails.
export function readOnlyJournal(root: Root): void {
	chmodSync(join(root.root, "state", "journal.jsonl"), 0o400)
}

// Unwritable diagnostics (brief 12, 8.2): the diagnostics path pre-exists as a regular file.
export function blockDiagnostics(root: Root): void {
	writeFileSync(join(root.root, "diagnostics"), "not a directory\n")
}

export function envelopeKeys(): string[] {
	return ["envelopeVersion", "contractVersion", "commandIdentity", "runIdentity", "outcome", "failureClass", "causeCode", "message", "effectClass", "transactionState", "retryable", "retryDelayMilliseconds", "nextAction", "availablePaths", "repairAction", "handoff", "result"]
}

// One receipt directory per scenario run under the private root (brief 12, 8.2); every surface is returned for the marker scan.
export function writeReceipt(root: Root, scenario: string, run: Run): { directory: string; surfaces: Record<string, string> } {
	const envelope = run.stdout.startsWith("{") ? (JSON.parse(run.stdout) as { runIdentity?: string }) : {}
	const runIdentity = envelope.runIdentity ?? "human"
	const directory = join(root.privateRoot, "receipts", scenario, runIdentity)
	mkdirSync(directory, { recursive: true })
	const files = diagnosticsFiles(root)
	const diagnostics = files.length === 1 ? readFileSync(join(root.root, "diagnostics", files[0] as string), "utf8") : ""
	const state = readState(root)
	const digest = (bytes: string | null): string | null => (bytes === null ? null : createHash("sha256").update(bytes).digest("hex"))
	const surfaces: Record<string, string> = { stdout: run.stdout, stderr: run.stderr, exit: `${run.exit}\n`, "diagnostics.jsonl": diagnostics, "state-after.json": JSON.stringify({ resource: digest(state.resource), preview: digest(state.preview), journal: digest(state.journal) }) }
	for (const [name, bytes] of Object.entries(surfaces)) writeFileSync(join(directory, name), bytes)
	return { directory, surfaces }
}
