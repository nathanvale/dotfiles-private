// CLI Module: parse argv, select human or machine mode, dispatch one command, render one result through the
// Command Contract, and set the exit code. main() is the one process entry; adapters/native.ts composes production.
// The private state root arrives already selected and validated (or refused); this module opens Diagnostics and the
// stores only for a selected root, and never derives a root of its own. `hook` is routed before the contract: its
// output is Harness JSON and its exit is always 0.

import type { BeadsReader } from "./adapters/beads.ts"
import { productionContext } from "./adapters/native.ts"
import { type BranchStation, stationFor } from "./branch-station-catalog.ts"
import { type CommandIdentity, DISCOVER_ACTION, discovery, HELP_ACTION, HELP_TEXT, machineMode, type Mode, type OutcomeFacts, renderDiscoveryHuman, renderOutcome } from "./command-contract.ts"
import { runBind } from "./commands/bind.ts"
import { HOOK_INPUT_LIMIT_BYTES, type HookFaults, runHook } from "./commands/hook.ts"
import { runInspect } from "./commands/inspect.ts"
import { runRecover } from "./commands/recover.ts"
import { type CommandContext, internalFailure, stateRootOutcome, workspaceOutcome, canonicalWorkspace } from "./commands/shared.ts"
import type { Diagnostics } from "./diagnostics.ts"
import type { CommandOutcome, JsonObject } from "./model.ts"

interface CliIo {
	stdout(text: string): void
	stderr(text: string): void
	/** The whole of stdin, read only by `hook`. */
	readStdin(limit: number): Promise<Uint8Array>
}

export interface CliOptions {
	readonly hookFaults?: HookFaults | undefined
}

type Routed = { readonly command: "inspect" | "recover"; readonly workspace: string; readonly session: string | null } | { readonly command: "bind"; readonly workspace: string; readonly session: string | null; readonly beadId: string; readonly evidence: string | null }

type Parsed =
	| { kind: "help" }
	| { kind: "discover" }
	| { kind: "hook" }
	| { kind: "usage"; identity: CommandIdentity; message: string }
	| { kind: "command"; identity: CommandIdentity; request: Routed }

const SILENT_DIAGNOSTICS: Diagnostics = { log: () => undefined, setStation: () => undefined, flush: () => undefined, dispose: () => ({ file: null, written: 0, dropped: 0, refused: 0, failure: "open", closed: true }) }
const VALUE_OPTIONS = new Set(["--workspace", "--session", "--bead", "--evidence"])
const COMMAND_WORDS: Readonly<Record<string, CommandIdentity>> = { inspect: "msb-workflow.inspect", bind: "msb-workflow.bind", recover: "msb-workflow.recover", hook: "msb-workflow.hook" }

interface Scan {
	word: string | null
	issue: string | null
	readonly options: Map<string, string>
	readonly flags: Set<string>
}

function noteIssue(scan: Scan, issue: string): void {
	scan.issue ??= issue
}

function consumeValueOption(scan: Scan, token: string, value: string | undefined): void {
	if (value === undefined || value.startsWith("--") || value.length === 0) noteIssue(scan, `${token} requires a value`)
	else if (scan.options.has(token)) noteIssue(scan, `${token} was given more than once`)
	else scan.options.set(token, value)
}

function consumeWord(scan: Scan, token: string): void {
	if (token.startsWith("-")) noteIssue(scan, `unknown option ${token}`)
	else if (scan.word === null && COMMAND_WORDS[token] !== undefined) scan.word = token
	else noteIssue(scan, scan.word === null ? `unknown command ${token}` : `unexpected argument ${token}`)
}

function scanArgv(argv: readonly string[]): Scan {
	const scan: Scan = { word: null, issue: null, options: new Map(), flags: new Set() }
	const tokens = argv.filter((token) => token !== "--json")
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] as string
		if (token === "--help" || token === "--discover") scan.flags.add(token)
		else if (VALUE_OPTIONS.has(token)) {
			consumeValueOption(scan, token, tokens[index + 1])
			index += 1
		} else consumeWord(scan, token)
	}
	return scan
}

function identityOf(scan: Scan): CommandIdentity {
	if (scan.word !== null) return COMMAND_WORDS[scan.word] as CommandIdentity
	return scan.flags.has("--discover") ? "msb-workflow.discover" : "msb-workflow.help"
}

function optionIssue(scan: Scan, required: readonly string[], allowed: readonly string[]): string | null {
	for (const name of required) if (!scan.options.has(name)) return `${scan.word} requires ${name}`
	for (const name of scan.options.keys()) if (!allowed.includes(name)) return `${name} is not an option of ${scan.word}`
	return null
}

function buildCommand(scan: Scan, identity: CommandIdentity): Parsed {
	const usage = (message: string): Parsed => ({ kind: "usage", identity, message })
	const get = (name: string): string | null => scan.options.get(name) ?? null
	const word = scan.word
	const workspace = get("--workspace")
	if (word === "bind") {
		const issue = optionIssue(scan, ["--workspace", "--bead"], ["--workspace", "--bead", "--session", "--evidence"])
		if (issue !== null || workspace === null) return usage(issue ?? "bind requires --workspace")
		return { kind: "command", identity, request: { command: "bind", workspace, session: get("--session"), beadId: get("--bead") as string, evidence: get("--evidence") } }
	}
	const issue = optionIssue(scan, ["--workspace"], ["--workspace", "--session"])
	if (issue !== null || workspace === null) return usage(issue ?? `${word} requires --workspace`)
	return { kind: "command", identity, request: { command: word === "inspect" ? "inspect" : "recover", workspace, session: get("--session") } }
}

/** `hook` is exactly the argv ["hook"]; any other argv containing it is an ordinary usage failure. */
function parseArgv(argv: readonly string[]): Parsed {
	if (argv.length === 1 && argv[0] === "hook") return { kind: "hook" }
	const scan = scanArgv(argv)
	const identity = identityOf(scan)
	if (scan.issue !== null) return { kind: "usage", identity, message: scan.issue }
	if (scan.flags.has("--help")) return scan.word === null && scan.options.size === 0 && !scan.flags.has("--discover") ? { kind: "help" } : { kind: "usage", identity, message: "--help takes no other arguments" }
	if (scan.flags.has("--discover")) return scan.word === null && scan.options.size === 0 ? { kind: "discover" } : { kind: "usage", identity, message: "--discover takes no other arguments" }
	if (scan.word === null) return { kind: "usage", identity: "msb-workflow.help", message: scan.options.size === 0 ? `no command given; run ${HELP_ACTION}` : "a command word is required" }
	if (scan.word === "hook") return { kind: "usage", identity, message: "hook takes no arguments and reads the Harness event from stdin" }
	return buildCommand(scan, identity)
}

function factsFor(station: BranchStation, runIdentity: string, outcome: CommandOutcome): OutcomeFacts {
	const inspect = "msb-workflow inspect --workspace <absolute-path>"
	const prerequisites = outcome.handoffPrerequisites.length > 0 ? outcome.handoffPrerequisites : [inspect]
	return {
		commandIdentity: station.commandIdentity,
		runIdentity,
		outcome: station.outcome,
		failureClass: station.failureClass,
		causeCode: station.causeCode,
		message: outcome.message,
		effectClass: station.effectClass,
		transactionState: station.transactionState,
		retryable: station.retryable,
		retryDelayMilliseconds: station.retryDelayMilliseconds,
		nextAction: station.guidance === "next-action" ? (outcome.nextAction ?? inspect) : null,
		availablePaths: outcome.availablePaths,
		repairAction: station.outcome === "success" ? null : (outcome.repairAction ?? `Run ${HELP_ACTION}`),
		handoff: station.guidance === "handoff" ? { reason: outcome.message, prerequisites } : null,
		result: outcome.result,
	}
}

function usageOutcome(message: string): CommandOutcome {
	return { station: "usage-refused", message, result: { station: "usage-refused", usage: HELP_TEXT.split("\n")[0] ?? "" }, repairAction: `Run ${HELP_ACTION} and repeat the command with the documented arguments`, handoffPrerequisites: [], nextAction: HELP_ACTION, availablePaths: ["msb-workflow.help", "msb-workflow.discover"] }
}

function helpOutcome(): CommandOutcome {
	return { station: "help-shown", message: "usage shown", result: { station: "help-shown", usage: HELP_TEXT.split("\n")[0] ?? "", example: HELP_TEXT.split("\n")[1] ?? "", discover: DISCOVER_ACTION }, repairAction: null, handoffPrerequisites: [], nextAction: null, availablePaths: ["msb-workflow.discover"] }
}

function discoverOutcome(): CommandOutcome {
	return { station: "discovery-shown", message: "contract discovery", result: { station: "discovery-shown", ...(discovery() as unknown as JsonObject) }, repairAction: null, handoffPrerequisites: [], nextAction: null, availablePaths: [] }
}

interface Dispatched {
	readonly outcome: CommandOutcome
	readonly identity: CommandIdentity
	readonly knownSecretValues: readonly string[]
}

/** Captures every Beads reader a command opens so the diagnostics sink can redact values learned mid-run. */
function capturingContext(context: CommandContext, readers: BeadsReader[]): CommandContext {
	return {
		...context,
		openBeads: (executable, workspace, cwd) => {
			const reader = context.openBeads(executable, workspace, cwd)
			readers.push(reader)
			return reader
		},
	}
}

async function runRouted(request: Routed, context: CommandContext, stateHome: string, diagnostics: Diagnostics): Promise<{ outcome: CommandOutcome; knownSecretValues: readonly string[] }> {
	if (request.command === "bind") return runBind(request, context, stateHome, diagnostics)
	if (request.command === "recover") return runRecover(request, context, stateHome, diagnostics)
	return runInspect(request, context, stateHome, diagnostics)
}

async function dispatch(parsed: Parsed, context: CommandContext, open: (identity: CommandIdentity) => Diagnostics): Promise<Dispatched> {
	if (parsed.kind === "help") return { outcome: helpOutcome(), identity: "msb-workflow.help", knownSecretValues: [] }
	if (parsed.kind === "discover") return { outcome: discoverOutcome(), identity: "msb-workflow.discover", knownSecretValues: [] }
	if (parsed.kind === "usage") return { outcome: usageOutcome(parsed.message), identity: parsed.identity, knownSecretValues: [] }
	if (parsed.kind === "hook") throw new Error("hook is routed before dispatch")
	// Every routed command needs private state; a refused root ends here before any store, Beads read or Diagnostics.
	if (context.stateRoot.status === "refused") return { outcome: stateRootOutcome(context.stateRoot.reason), identity: parsed.identity, knownSecretValues: [] }
	const workspace = canonicalWorkspace(parsed.request.workspace)
	if (workspace === null) return { outcome: workspaceOutcome(parsed.request.workspace), identity: parsed.identity, knownSecretValues: [] }
	const diagnostics = open(parsed.identity)
	diagnostics.log("command.started", { command: parsed.request.command })
	const { outcome, knownSecretValues } = await runRouted({ ...parsed.request, workspace }, context, context.stateRoot.path, diagnostics)
	return { outcome, identity: parsed.identity, knownSecretValues }
}

async function runHookCommand(context: CommandContext, io: CliIo, options: CliOptions): Promise<number> {
	let diagnostics: Diagnostics = SILENT_DIAGNOSTICS
	try {
		const readers: BeadsReader[] = []
		const capturing = capturingContext(context, readers)
		if (context.stateRoot.status === "selected") diagnostics = context.openDiagnostics({ runIdentity: context.runIdentity, commandIdentity: "msb-workflow.hook", stateHome: context.stateRoot.path, sink: "file", knownSecretValues: () => readers.flatMap((reader) => reader.knownSecretValues()) })
		const stdin = await io.readStdin(HOOK_INPUT_LIMIT_BYTES + 1)
		const result = await runHook(stdin, capturing, diagnostics, io.stdout, options.hookFaults ?? {})
		diagnostics.log("hook.completed", { delivery: result.delivery })
	} catch {
		// Fail open: the Harness never sees a non-zero exit or an envelope from the hook.
	} finally {
		diagnostics.dispose()
	}
	return 0
}

async function runCli(argv: readonly string[], context: CommandContext, io: CliIo, options: CliOptions = {}): Promise<number> {
	const mode: Mode = machineMode(argv) ? "machine" : "human"
	const parsed = parseArgv(argv)
	if (parsed.kind === "hook") return runHookCommand(context, io, options)
	const readers: BeadsReader[] = []
	const capturing = capturingContext(context, readers)
	const holder: { current: Diagnostics | null } = { current: null }
	const open = (identity: CommandIdentity): Diagnostics => {
		if (context.stateRoot.status !== "selected") return SILENT_DIAGNOSTICS
		try {
			holder.current = context.openDiagnostics({ runIdentity: context.runIdentity, commandIdentity: identity, stateHome: context.stateRoot.path, sink: mode === "human" ? "stderr" : "file", writeStderr: io.stderr, knownSecretValues: () => readers.flatMap((reader) => reader.knownSecretValues()) })
		} catch {
			// A Diagnostics Module that cannot open is replaced by a silent one; logging failure never changes the outcome.
			holder.current = SILENT_DIAGNOSTICS
		}
		return holder.current
	}
	let dispatched: Dispatched
	try {
		dispatched = await dispatch(parsed, capturing, open)
	} catch {
		const identity = parsed.kind === "command" || parsed.kind === "usage" ? parsed.identity : "msb-workflow.help"
		dispatched = { outcome: internalFailure(), identity, knownSecretValues: readers.flatMap((reader) => reader.knownSecretValues()) }
	}
	const station = stationFor({ station: dispatched.outcome.station, commandIdentity: dispatched.identity })
	const facts = factsFor(station, context.runIdentity, dispatched.outcome)
	const rendered = mode === "human" && parsed.kind === "help" ? { stdout: HELP_TEXT, stderr: "", exit: 0 as const } : mode === "human" && parsed.kind === "discover" ? { stdout: renderDiscoveryHuman(), stderr: "", exit: 0 as const } : renderOutcome(facts, mode, { knownSecretValues: dispatched.knownSecretValues })
	try {
		const opened = holder.current
		if (opened !== null) {
			opened.setStation(station.station)
			opened.log("command.completed", { stationId: station.station, outcome: facts.outcome, causeCode: facts.causeCode, transactionState: facts.transactionState, exit: rendered.exit })
			opened.dispose()
		}
	} catch {
		// Logging failure never changes the command outcome.
	}
	if (rendered.stdout.length > 0) io.stdout(rendered.stdout)
	if (rendered.stderr.length > 0) io.stderr(rendered.stderr)
	return rendered.exit
}

async function readAllStdin(limit: number): Promise<Uint8Array> {
	const chunks: Uint8Array[] = []
	let total = 0
	for await (const chunk of Bun.stdin.stream()) {
		chunks.push(chunk)
		total += chunk.byteLength
		if (total > limit) break
	}
	const output = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		output.set(chunk, offset)
		offset += chunk.byteLength
	}
	return output
}

const PROCESS_IO: CliIo = {
	stdout: (text) => {
		process.stdout.write(text)
	},
	stderr: (text) => {
		process.stderr.write(text)
	},
	readStdin: readAllStdin,
}

/** The process entry: run once against the given context and set the exit code. */
export function main(context: CommandContext = productionContext(process.env, process.cwd()), options: CliOptions = {}): void {
	const argv = process.argv.slice(2)
	runCli(argv, context, PROCESS_IO, options).then(
		(code) => {
			process.exitCode = code
		},
		() => {
			if (argv.length === 1 && argv[0] === "hook") {
				process.exitCode = 0
				return
			}
			if (!machineMode(argv)) process.stderr.write(`msb-workflow: INTERNAL_UNEXPECTED: internal failure; repair: run ${HELP_ACTION}\n`)
			else process.stdout.write(`${JSON.stringify({ envelopeVersion: 1, contractVersion: "1.0.0", commandIdentity: "msb-workflow.help", runIdentity: "run-unknown", outcome: "failed", failureClass: "internal", causeCode: "INTERNAL_UNEXPECTED", message: "internal failure before dispatch", effectClass: "inspect", transactionState: "unknown", retryable: false, retryDelayMilliseconds: null, nextAction: HELP_ACTION, availablePaths: [], repairAction: `Run ${HELP_ACTION}`, handoff: null, result: null })}\n`)
			process.exitCode = 1
		},
	)
}

// This file is the process entry on both production paths: the checker's frozen smoke command runs it directly, and the
// plugin build bundles it into runtime/msb-workflow.js, which bin/msb-workflow execs. The guard runs main() once on each.
// src/main.ts is an unconditional alternate source entry that imports main from here; no launcher, bundle, or test runs it.
if (import.meta.main) main()
