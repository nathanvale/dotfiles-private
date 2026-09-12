import { statSync } from "node:fs"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { renderHuman, renderInternalError, renderJson, renderUsageError } from "./render.ts"
import { type MatrixOptions, runMatrix } from "./runner.ts"

const HELP_TEXT = `usage:
  cli-design-check --cwd <dir> --command "<argv words>" --success-args "<args>" --missing-args "<args>" [--effect-args "<args>"] [--secret-args "<args>" --secret-marker <string>] [--json] [--timeout-ms <n>]
  cli-design-check --help

Run the target CLI through the standard design contract scenario matrix.
Use --json for one machine-readable Contract Core envelope on stdout; in that mode stderr stays empty.
In human mode a usage error or internal error is one line on stderr.
`

const DEFAULT_TIMEOUT_MS = 15000
const valueOptions = new Set(["--cwd", "--command", "--success-args", "--missing-args", "--effect-args", "--secret-args", "--secret-marker", "--timeout-ms"])

interface ParsedOptions {
	help: boolean
	json: boolean
	cwd?: string | undefined
	command?: string | undefined
	successArgs?: string | undefined
	missingArgs?: string | undefined
	effectArgs?: string | undefined
	secretArgs?: string | undefined
	secretMarker?: string | undefined
	timeoutMs?: string | undefined
}

type Resolved = { kind: "help" } | { kind: "run"; json: boolean; options: MatrixOptions }

function hasJsonFlag(args: readonly string[]): boolean {
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index]
		if (token === "--json") return true
		if (token !== undefined && valueOptions.has(token)) index += 1
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
		options: {
			help: { type: "boolean" },
			json: { type: "boolean" },
			cwd: { type: "string" },
			command: { type: "string" },
			"success-args": { type: "string" },
			"missing-args": { type: "string" },
			"effect-args": { type: "string" },
			"secret-args": { type: "string" },
			"secret-marker": { type: "string" },
			"timeout-ms": { type: "string" },
		},
		strict: true,
		allowPositionals: false,
	})
	const options = values as Record<string, unknown>
	return {
		help: options.help === true,
		json: options.json === true,
		cwd: stringOption(options, "cwd"),
		command: stringOption(options, "command"),
		successArgs: stringOption(options, "success-args"),
		missingArgs: stringOption(options, "missing-args"),
		effectArgs: stringOption(options, "effect-args"),
		secretArgs: stringOption(options, "secret-args"),
		secretMarker: stringOption(options, "secret-marker"),
		timeoutMs: stringOption(options, "timeout-ms"),
	}
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
	return directory
}

function nonNegativeInteger(value: string | undefined): number {
	if (value === undefined) return DEFAULT_TIMEOUT_MS
	if (!/^\d+$/.test(value)) throw new Error("--timeout-ms must be a non-negative integer")
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed)) throw new Error("--timeout-ms must be a non-negative integer")
	return parsed
}

function matrixOptions(parsed: ParsedOptions): MatrixOptions {
	const command = splitWords(required(parsed.command, "command"))
	if (command.length === 0) throw new Error("--command must contain at least one word")
	if ((parsed.secretArgs === undefined) !== (parsed.secretMarker === undefined)) throw new Error("--secret-args and --secret-marker must be supplied together")
	return {
		cwd: existingDirectory(required(parsed.cwd, "cwd")),
		command,
		successArgs: splitWords(required(parsed.successArgs, "success-args")),
		missingArgs: splitWords(required(parsed.missingArgs, "missing-args")),
		effectArgs: optionalWords(parsed.effectArgs),
		secretArgs: optionalWords(parsed.secretArgs),
		secretMarker: parsed.secretMarker,
		timeoutMs: nonNegativeInteger(parsed.timeoutMs),
	}
}

function resolveInvocation(args: readonly string[]): Resolved {
	const parsed = parseCli(args)
	if (parsed.help) return { kind: "help" }
	return { kind: "run", json: parsed.json, options: matrixOptions(parsed) }
}

// In --json mode the envelope carries the message and stderr stays empty; human mode gets one stderr line.
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

async function runAndReport(options: MatrixOptions, json: boolean): Promise<number> {
	const report = await runMatrix(options)
	process.stdout.write(json ? renderJson(report) : renderHuman(report))
	return report.failedCount === 0 ? 0 : 3
}

async function dispatch(args: readonly string[]): Promise<number> {
	let resolved: Resolved
	try {
		resolved = resolveInvocation(args)
	} catch (error) {
		return usageFailure(error, hasJsonFlag(args))
	}
	if (resolved.kind === "help") {
		process.stdout.write(HELP_TEXT)
		return 0
	}
	try {
		return await runAndReport(resolved.options, resolved.json)
	} catch (error) {
		return internalFailure(error, resolved.json)
	}
}

const exitCode = await dispatch(process.argv.slice(2))
process.exit(exitCode)
