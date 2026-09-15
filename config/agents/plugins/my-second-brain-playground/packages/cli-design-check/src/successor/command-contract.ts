import { CHECKER_CONTRACT_VERSION, checkerExitMeanings } from "./contract.ts"

export const CHECKER_IDENTITIES = {
	discovery: "cli-design-check.discovery",
	dispatch: "cli-design-check.dispatch",
	help: "cli-design-check.help",
	run: "cli-design-check.run",
} as const

const SUMMARY = "Inspect a target CLI through the strict 2.0.0 design-contract scenario matrix"
const USAGE = 'cli-design-check --cwd <dir> --command "<argv words>" --success-args "<args>" --missing-args "<args>" --internal-args "<args>" --schema-args "<args>" --transient-args "<args>" [options]'

const COMMANDS = [
	{ commandIdentity: CHECKER_IDENTITIES.discovery, route: ["--discover"], summary: "Describe the checker command and 2.0 contract", effectClass: "inspect" },
	{ commandIdentity: CHECKER_IDENTITIES.dispatch, route: [], summary: "Report invalid checker invocations", effectClass: "inspect" },
	{ commandIdentity: CHECKER_IDENTITIES.help, route: ["--help"], summary: "Show checker help and usage", effectClass: "inspect" },
	{ commandIdentity: CHECKER_IDENTITIES.run, route: [], summary: "Inspect a target CLI through the successor scenario matrix", effectClass: "inspect" },
] as const

const OPTION_DESCRIPTORS = [
	{ key: "help", name: "--help", type: "boolean", valueName: null, summary: "Show help" },
	{ key: "discover", name: "--discover", type: "boolean", valueName: null, summary: "Show command and contract discovery" },
	{ key: "json", name: "--json", type: "boolean", valueName: null, summary: "Emit one machine-readable 2.0 envelope" },
	{ key: "cwd", name: "--cwd", type: "string", valueName: "dir", summary: "Select the target working directory" },
	{ key: "command", name: "--command", type: "string", valueName: "argv words", summary: "Select the target CLI command" },
	{ key: "success-args", name: "--success-args", type: "string", valueName: "args", summary: "Set the target success arguments" },
	{ key: "missing-args", name: "--missing-args", type: "string", valueName: "args", summary: "Set the target missing-input arguments" },
	{ key: "internal-args", name: "--internal-args", type: "string", valueName: "args", summary: "Set the target internal-failure arguments" },
	{ key: "schema-args", name: "--schema-args", type: "string", valueName: "args", summary: "Set the target schema-refusal arguments" },
	{ key: "transient-args", name: "--transient-args", type: "string", valueName: "args", summary: "Set the target transient-refusal arguments" },
	{ key: "retain-streams-dir", name: "--retain-streams-dir", type: "string", valueName: "absolute-directory", summary: "Retain raw target streams in an existing private directory" },
	{ key: "effect-args", name: "--effect-args", type: "string", valueName: "args", summary: "Set optional authority-refusal arguments" },
	{ key: "secret-args", name: "--secret-args", type: "string", valueName: "args", summary: "Set optional secret-redaction arguments" },
	{ key: "secret-marker", name: "--secret-marker", type: "string", valueName: "string", summary: "Set the secret marker paired with secret arguments" },
	{ key: "malformed-args", name: "--malformed-args", type: "string", valueName: "args", summary: "Set optional malformed-value arguments" },
	{ key: "large-args", name: "--large-args", type: "string", valueName: "args", summary: "Set optional large-envelope arguments" },
	{ key: "timeout-ms", name: "--timeout-ms", type: "string", valueName: "n", summary: "Set the per-scenario timeout" },
] as const

const OPTIONS = OPTION_DESCRIPTORS.map(({ name, valueName, summary }) => ({ name, valueName, summary }))

export function checkerParseArgsOptions(): Record<string, { type: "boolean" | "string" }> {
	return Object.fromEntries(OPTION_DESCRIPTORS.map(({ key, type }) => [key, { type }]))
}

export function checkerOptionTakesValue(token: string): boolean {
	return OPTION_DESCRIPTORS.some((option) => option.name === token && option.type === "string")
}

export const CHECKER_AVAILABLE_PATHS = COMMANDS.map((command) => command.commandIdentity)

export const CHECKER_HELP_DATA = {
	usage: USAGE,
	summary: SUMMARY,
	commands: COMMANDS,
	options: OPTIONS,
} as const

export const CHECKER_DISCOVERY_DATA = {
	contractVersion: CHECKER_CONTRACT_VERSION,
	generationConventionVersion: CHECKER_CONTRACT_VERSION,
	profile: "simple",
	commands: COMMANDS,
	exitMeanings: checkerExitMeanings(),
	signalExits: { "130": "SIGINT", "143": "SIGTERM" },
	effectExclusions: ["retained raw stream files are diagnostic custody, not target domain effects"],
} as const

export function renderCheckerHelpHuman(): string {
	return `${SUMMARY}\n\nusage:\n  ${USAGE}\n\nexample:\n  cli-design-check --discover --json\n`
}

export function renderCheckerDiscoveryHuman(): string {
	const commands = COMMANDS.map((command) => `command: ${command.commandIdentity}\n  route: ${command.route.join(" ") || "<root>"}\n  effect: ${command.effectClass}\n  summary: ${command.summary}`)
	const exits = Object.entries(CHECKER_DISCOVERY_DATA.exitMeanings).map(([exit, meaning]) => `exit ${exit}: ${meaning}`)
	const signals = Object.entries(CHECKER_DISCOVERY_DATA.signalExits).map(([exit, signal]) => `signal ${exit}: ${signal}`)
	const exclusions = CHECKER_DISCOVERY_DATA.effectExclusions.map((exclusion) => `effect exclusion: ${exclusion}`)
	return `${[SUMMARY, `contract version: ${CHECKER_CONTRACT_VERSION}`, "profile: simple", ...commands, ...exits, ...signals, ...exclusions].join("\n")}\n`
}
