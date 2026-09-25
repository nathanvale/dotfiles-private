// Public process seam for the Vault Steward CLI 2.0 front door: spawn `src/main.ts` (or $VAULT_STEWARD_COMMAND) against
// the fixtures of harness.ts with a pinned environment, parse the one stdout envelope through a test-owned shape, and
// derive the catalogue observation the station tests compare. Nothing here reads the production catalogue.
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { type Fixture, write } from "./harness.ts"

const sourceCommand = resolve(import.meta.dir, "../../src/main.ts")
const command = process.env.VAULT_STEWARD_COMMAND ?? sourceCommand
export const STEWARD_PREFIX = command === sourceCommand ? [process.execPath, command] : [command]

export interface Envelope {
	envelopeVersion: number
	contractVersion: string
	message: string
	availablePaths: string[]
	result: Record<string, unknown> & { effects: { completed: string[]; remaining: string[]; uncertain: string[]; inventoryComplete: boolean } }
	diagnostics?: Record<string, unknown>
}

export interface StewardRun {
	exitCode: number | null
	signal: string | null
	stdout: string
	stderr: string
	envelope: Envelope | null
}

export function stewardEnvironment(fixture: Fixture, extra: Record<string, string> = {}): Record<string, string> {
	return { XDG_STATE_HOME: fixture.state, HOME: `${fixture.root}/home`, XDG_CONFIG_HOME: `${fixture.root}/config`, ...extra }
}

function parseEnvelope(stdout: string): Envelope | null {
	try {
		const value = JSON.parse(stdout) as Envelope
		return typeof value === "object" && value !== null ? value : null
	} catch {
		return null
	}
}

export function steward(cwd: string, arguments_: string[], environment: Record<string, string> = {}, json = true): StewardRun {
	const result = Bun.spawnSync([...STEWARD_PREFIX, ...arguments_, ...(json ? ["--json"] : [])], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...environment, GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" },
	})
	const stdout = new TextDecoder().decode(result.stdout)
	return { exitCode: result.exitCode, signal: result.signalCode ?? null, stdout, stderr: new TextDecoder().decode(result.stderr), envelope: json ? parseEnvelope(stdout) : null }
}

export async function stewardAsync(cwd: string, arguments_: string[], environment: Record<string, string> = {}): Promise<StewardRun> {
	const child = Bun.spawn([...STEWARD_PREFIX, ...arguments_, "--json"], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...environment, GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" } })
	const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
	return { exitCode, signal: child.signalCode ?? null, stdout, stderr, envelope: parseEnvelope(stdout) }
}

export function data(run: StewardRun | Envelope): Record<string, unknown> {
	const envelope = "result" in run ? run : run.envelope
	const value = envelope?.result.data
	if (typeof value !== "object" || value === null) throw new Error(`no data in ${"result" in run ? JSON.stringify(run) : run.stdout || run.stderr}`)
	return value as Record<string, unknown>
}

export function must(run: StewardRun, cause: string): Envelope {
	if (run.envelope?.result.causeCode !== cause) throw new Error(`expected ${cause}, got ${run.stdout || run.stderr || String(run.signal)}`)
	return run.envelope
}

// The identity the catalogue tests compare: [commandIdentity, outcome, causeCode] plus the guidance emitted.
export function observationOf(envelope: Envelope): { identity: string; nextAction: string | null; handoffOwner: string | null } {
	const result = envelope.result
	const handoff = result.handoff as { owner?: string } | undefined
	return { identity: JSON.stringify([result.commandIdentity, result.outcome, result.causeCode]), nextAction: typeof result.nextAction === "string" ? result.nextAction : null, handoffOwner: handoff?.owner ?? null }
}

// ---------------------------------------------------------------------------------------------------------------------
// Shared journey setup (one owner): begin a candidate, preview it, apply a preview, and the lock-owner witness.

export function run(f: Fixture, args: string[], extra: Record<string, string> = {}): StewardRun {
	return steward(f.vault, args, stewardEnvironment(f, extra))
}

// The candidate worktree of a fresh begin; `contents` null leaves the admitted path untouched (a no-changes candidate).
export function candidate(f: Fixture, path = "projects/demo/GOAL.md", contents: string | null = "# Goal\n\nCompleted.\n"): string {
	const started = must(run(f, ["begin", "--vault", f.vault, "--path", path]), "SUCCESS_COMPLETED")
	const worktree = (data(started).candidate as { worktree: string }).worktree
	if (contents !== null) write(worktree, path, contents)
	return worktree
}

export function preview(f: Fixture, worktree: string, message = "docs: change"): string {
	return data(must(run(f, ["finish", "--preview", "--worktree", worktree, "--message", message]), "SUCCESS_COMPLETED")).previewId as string
}

export function apply(f: Fixture, worktree: string, previewId: string): StewardRun {
	return run(f, ["finish", "--apply", "--preview-id", previewId, "--worktree", worktree])
}

// Preview then apply; the caller asserts the apply's outcome.
export function integrate(f: Fixture, worktree: string, message = "docs: change"): StewardRun {
	return apply(f, worktree, preview(f, worktree, message))
}

// The filesystem owner record is the inter-process ordering witness. The 10 s bound only detects a hung child process;
// the ordering oracle is the holder's fault barrier, published after that record.
export async function waitForOwner(path: string, previous?: string): Promise<void> {
	const deadline = Date.now() + 10_000
	let observed: string | null = null
	while (Date.now() < deadline) {
		try {
			observed = readFileSync(path, "utf8")
			if (previous === undefined || observed !== previous) break
		} catch {
			observed = null
		}
		await Bun.sleep(20)
	}
	if (observed === null || (previous !== undefined && observed === previous)) throw new Error(`owner record ${path} was not published within 10 s`)
}

// A barrier fault publishes <path>.arrived when its process reaches the fault point. Awaiting it orders a second
// process after the first has provably reached that point. The 10 s bound only detects a hung child process.
export async function waitForBarrierArrival(path: string): Promise<void> {
	const arrival = `${path}.arrived`
	const deadline = Date.now() + 10_000
	while (!existsSync(arrival)) {
		if (Date.now() >= deadline) throw new Error(`barrier ${path} was not reached within 10 s`)
		await Bun.sleep(10)
	}
}
