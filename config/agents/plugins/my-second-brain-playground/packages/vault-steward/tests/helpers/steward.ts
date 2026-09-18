// Public process seam for the Vault Steward CLI 2.0 front door: spawn `src/main.ts` (or $VAULT_STEWARD_COMMAND) against
// the fixtures of harness.ts with a pinned environment, parse the one stdout envelope through a test-owned shape, and
// derive the catalogue observation the station tests compare. Nothing here reads the production catalogue.
import { resolve } from "node:path"
import type { Fixture } from "./harness.ts"

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

// The identity and product reason the catalogue tests compare: [commandIdentity, outcome, causeCode] and the first
// message token when it is an upper-case product code.
export function observationOf(envelope: Envelope): { identity: string; reason: string | null; nextAction: string | null; handoffOwner: string | null } {
	const result = envelope.result
	const reason = /^([A-Z][A-Z_]+)(?::|$)/.exec(envelope.message)?.[1] ?? null
	const handoff = result.handoff as { owner?: string } | undefined
	return { identity: JSON.stringify([result.commandIdentity, result.outcome, result.causeCode]), reason, nextAction: typeof result.nextAction === "string" ? result.nextAction : null, handoffOwner: handoff?.owner ?? null }
}
