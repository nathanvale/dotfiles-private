// fallow-ignore-file code-duplication -- The accepted 2.0 successor must remain separate from the frozen 1.0 predecessor oracle and source boundary.
import { realpathSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { checkerOptionTakesValue, checkerParseArgsOptions, renderCheckerDiscoveryHuman, renderCheckerHelpHuman } from "./command-contract.ts"
import { renderDiscovery, renderHelp, renderHuman, renderInternalError, renderJson, renderUsageError } from "./render.ts"
import { type SuccessorMatrixOptions, runSuccessorMatrix, validateRetentionDirectory } from "./runner.ts"

const DEFAULT_TIMEOUT_MS = 15000

interface ParsedOptions {
	help: boolean
	discover: boolean
	json: boolean
	cwd?: string | undefined
	command?: string | undefined
	successArgs?: string | undefined
	missingArgs?: string | undefined
	internalArgs?: string | undefined
	schemaArgs?: string | undefined
	transientArgs?: string | undefined
	retainStreamsDirectory?: string | undefined
	effectArgs?: string | undefined
	secretArgs?: string | undefined
	secretMarker?: string | undefined
	malformedArgs?: string | undefined
	largeArgs?: string | undefined
	timeoutMs?: string | undefined
}

type Resolved = { kind: "help"; json: boolean } | { kind: "discovery"; json: boolean } | { kind: "run"; json: boolean; options: SuccessorMatrixOptions }

function hasJsonFlag(args: readonly string[]): boolean {
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index]
		if (token === "--") return false
		if (token === "--json") return true
		if (token !== undefined && checkerOptionTakesValue(token)) index += 1
	}
	return false
}

function oneLine(value: unknown): string {
	const message = value instanceof Error ? value.message : String(value)
	return message.replace(/[\r\n]+/g, " ").trim() || "unknown error"
}

function splitWords(value: string): string[] {
	const trimmed = value.trim()
	return trimmed === "" ? [] : trimmed.split(/\s+/)
}

function optionalWords(value: string | undefined): string[] | undefined {
	return value === undefined ? undefined : splitWords(value)
}

function stringOption(options: Record<string, unknown>, name: string): string | undefined {
	const value = options[name]
	if (value === undefined) return undefined
	if (typeof value !== "string") throw new Error(`--${name} must be supplied once with one string value`)
	return value
}

function parseCli(args: readonly string[]): ParsedOptions {
	const { values } = parseArgs({
		args,
		options: checkerParseArgsOptions(),
		strict: true,
		allowPositionals: false,
	})
	const options = values as Record<string, unknown>
	return {
		help: options.help === true,
		discover: options.discover === true,
		json: options.json === true,
		cwd: stringOption(options, "cwd"),
		command: stringOption(options, "command"),
		successArgs: stringOption(options, "success-args"),
		missingArgs: stringOption(options, "missing-args"),
		internalArgs: stringOption(options, "internal-args"),
		schemaArgs: stringOption(options, "schema-args"),
		transientArgs: stringOption(options, "transient-args"),
		retainStreamsDirectory: stringOption(options, "retain-streams-dir"),
		effectArgs: stringOption(options, "effect-args"),
		secretArgs: stringOption(options, "secret-args"),
		secretMarker: stringOption(options, "secret-marker"),
		malformedArgs: stringOption(options, "malformed-args"),
		largeArgs: stringOption(options, "large-args"),
		timeoutMs: stringOption(options, "timeout-ms"),
	}
}

function hasCommandOptions(parsed: ParsedOptions): boolean {
	return [parsed.cwd, parsed.command, parsed.successArgs, parsed.missingArgs, parsed.internalArgs, parsed.schemaArgs, parsed.transientArgs, parsed.retainStreamsDirectory, parsed.effectArgs, parsed.secretArgs, parsed.secretMarker, parsed.malformedArgs, parsed.largeArgs, parsed.timeoutMs].some((value) => value !== undefined)
}

function required(value: string | undefined, name: string): string {
	if (value === undefined) throw new Error(`missing required option --${name}`)
	return value
}

function existingDirectory(value: string): string {
	const directory = resolve(process.cwd(), value)
	try {
		if (!statSync(directory).isDirectory()) throw new Error("not a directory")
	} catch {
		throw new Error(`--cwd must be an existing directory: ${value}`)
	}
	return realpathSync(directory)
}

function nonnegativeInteger(value: string | undefined): number {
	if (value === undefined) return DEFAULT_TIMEOUT_MS
	if (!/^\d+$/.test(value)) throw new Error("--timeout-ms must be a non-negative integer")
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed)) throw new Error("--timeout-ms must be a non-negative integer")
	return parsed
}

function matrixOptions(parsed: ParsedOptions): SuccessorMatrixOptions {
	const command = splitWords(required(parsed.command, "command"))
	if (command.length === 0) throw new Error("--command must contain at least one word")
	if ((parsed.secretArgs === undefined) !== (parsed.secretMarker === undefined)) throw new Error("--secret-args and --secret-marker must be supplied together")
	const retainStreamsDirectory = parsed.retainStreamsDirectory === undefined ? undefined : validateRetentionDirectory(parsed.retainStreamsDirectory)
	return {
		cwd: existingDirectory(required(parsed.cwd, "cwd")),
		command,
		successArgs: splitWords(required(parsed.successArgs, "success-args")),
		missingArgs: splitWords(required(parsed.missingArgs, "missing-args")),
		internalArgs: splitWords(required(parsed.internalArgs, "internal-args")),
		schemaArgs: splitWords(required(parsed.schemaArgs, "schema-args")),
		transientArgs: splitWords(required(parsed.transientArgs, "transient-args")),
		effectArgs: optionalWords(parsed.effectArgs),
		secretArgs: optionalWords(parsed.secretArgs),
		secretMarker: parsed.secretMarker,
		malformedArgs: optionalWords(parsed.malformedArgs),
		largeArgs: optionalWords(parsed.largeArgs),
		timeoutMs: nonnegativeInteger(parsed.timeoutMs),
		...(retainStreamsDirectory === undefined ? {} : { retainStreamsDirectory }),
	}
}

function resolveInvocation(args: readonly string[]): Resolved {
	const parsed = parseCli(args)
	if (parsed.help && parsed.discover) throw new Error("--help and --discover are mutually exclusive")
	if ((parsed.help || parsed.discover) && hasCommandOptions(parsed)) throw new Error("built-in options cannot be combined with checker command options")
	if (parsed.help) return { kind: "help", json: parsed.json }
	if (parsed.discover) return { kind: "discovery", json: parsed.json }
	return { kind: "run", json: parsed.json, options: matrixOptions(parsed) }
}

function usageFailure(error: unknown, json: boolean): number {
	const cause = oneLine(error)
	if (json) process.stdout.write(renderUsageError(cause))
	else process.stderr.write(`cli-design-check: ${cause}; run cli-design-check --help\n`)
	return 2
}

function internalFailure(error: unknown, json: boolean): number {
	const cause = oneLine(error)
	if (json) process.stdout.write(renderInternalError(cause))
	else process.stderr.write(`cli-design-check: internal error: ${cause}\n`)
	return 1
}

async function runAndReport(options: SuccessorMatrixOptions, json: boolean): Promise<number> {
	const report = await runSuccessorMatrix(options)
	if (!json) {
		process.stdout.write(renderHuman(report))
		return report.failedCount === 0 ? 0 : 4
	}
	const rendered = renderJson(report)
	process.stdout.write(rendered.text)
	return rendered.exit
}

async function dispatch(args: readonly string[]): Promise<number> {
	let resolved: Resolved
	try {
		resolved = resolveInvocation(args)
	} catch (error) {
		return usageFailure(error, hasJsonFlag(args))
	}
	if (resolved.kind === "help") {
		process.stdout.write(resolved.json ? renderHelp() : renderCheckerHelpHuman())
		return 0
	}
	if (resolved.kind === "discovery") {
		process.stdout.write(resolved.json ? renderDiscovery() : renderCheckerDiscoveryHuman())
		return 0
	}
	try {
		return await runAndReport(resolved.options, resolved.json)
	} catch (error) {
		return internalFailure(error, resolved.json)
	}
}

process.exitCode = await dispatch(process.argv.slice(2))
