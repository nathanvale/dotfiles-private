#!/usr/bin/env bun
// Connector Route launcher: names a Connector Skill, one of its Providers, and
// a MCPorter verb, then replaces itself with MCPorter against that skill's own
// registry. It knows nothing about any service. Selections are non-secret
// process metadata whose meaning belongs to the Provider below MCPorter.
//
//   provider-route <skill> [--provider <server>] [--select name=value ...] -- <auth|list|call> [tool] [flags]
//
// Exit meanings follow Contract Core 2.0 for refusals: 2 usage, 3 precondition,
// 4 schema. Success is MCPorter's own exit status and output; no envelope is
// added because stdout belongs to MCPorter.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { INTERNAL_INVOCATION_CONTEXT_ENV, safeEnvironment, validInternalContext } from "./safe-environment.ts";

const PROGRAM = "provider-route";
// Observed with MCPorter 0.13.13 and rechecked with 0.14.0: a stdio child
// inherits the whole MCPorter environment, so this scrub is the only barrier
// before a Provider process.
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const SELECTION_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ALLOWED_FLAGS = {
	auth: new Set(["--json", "--no-browser", "--reset"]),
	list: new Set([
		"--status",
		"--json",
		"--exit-code",
		"--quiet",
		"--schema",
		"--all-parameters",
		"--brief",
		"--signatures",
		"--timeout",
		"--no-oauth",
	]),
	call: new Set(["--args", "--params", "--timeout", "--output", "--no-oauth", "--raw-strings", "--no-coerce"]),
} as const;
const VALUE_FLAGS = new Set(["--timeout", "--args", "--params", "--output"]);
const OUTPUT_FORMATS = new Set(["text", "markdown", "json", "raw"]);
const TOOL_ARGUMENT_PATTERN = /^([A-Za-z_][A-Za-z0-9_.-]*)[=:]([\s\S]*)$/;

type Verb = keyof typeof ALLOWED_FLAGS;
export type RefusalExit = 2 | 3 | 4;
export type RouteErrorCode =
	| "allowlist-missing"
	| "argument-invalid"
	| "arguments-invalid"
	| "command-invalid"
	| "config-invalid"
	| "dispatcher-owned"
	| "flag-forbidden"
	| "flag-invalid"
	| "imports-not-disabled"
	| "internal-context-invalid"
	| "provider-invalid"
	| "select-invalid"
	| "select-missing"
	| "select-undeclared"
	| "skill-config-missing"
	| "skill-invalid"
	| "skill-route-missing"
	| "tool-invalid";

export class RouteError extends Error {
	readonly code: RouteErrorCode;
	readonly exitCode: RefusalExit;

	constructor(code: RouteErrorCode, message: string, exitCode: RefusalExit = 2) {
		super(message);
		this.code = code;
		this.exitCode = exitCode;
	}
}

export interface RoutePlan {
	configPath: string;
	server: string;
	argv: string[];
	env: Record<string, string>;
}

interface Invocation {
	skill: string;
	provider: string | undefined;
	selections: Map<string, string>;
	verb: Verb;
	rest: string[];
}

interface RouteDeclaration {
	defaultProvider: string;
	selectors: Map<string, string>;
	dispatcherOwned: boolean;
	oauth: "mcporter" | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Route options come in pairs: --provider <server> or --select name=value.
function parseRouteOptions(options: string[]): Pick<Invocation, "provider" | "selections"> {
	let provider: string | undefined;
	const selections = new Map<string, string>();
	for (let index = 0; index < options.length; index += 2) {
		const token = options[index];
		const value = options[index + 1];
		if (token === "--provider") {
			if (!value || !NAME_PATTERN.test(value)) throw new RouteError("provider-invalid", "--provider needs a server name");
			provider = value;
		} else if (token === "--select") {
			const equals = value?.indexOf("=") ?? -1;
			if (!value || equals <= 0) throw new RouteError("select-invalid", "--select needs name=value");
			selections.set(value.slice(0, equals), value.slice(equals + 1));
		} else {
			throw new RouteError("arguments-invalid", `unknown route option: ${token}`);
		}
	}
	return { provider, selections };
}

function parseInvocation(argv: string[]): Invocation {
	const separator = argv.indexOf("--");
	if (separator === -1) throw new RouteError("arguments-invalid", "MCPorter arguments are required after --");
	const [skill, ...options] = argv.slice(0, separator);
	const [verb, ...rest] = argv.slice(separator + 1);
	if (!skill || !NAME_PATTERN.test(skill)) {
		throw new RouteError("skill-invalid", "the first argument must be a Connector Skill name matching ^[a-z][a-z0-9-]*$");
	}
	if (verb !== "auth" && verb !== "list" && verb !== "call") throw new RouteError("command-invalid", "only auth, list and call are supported");
	return { skill, ...parseRouteOptions(options), verb, rest };
}

function readJson(file: string, missingCode: RouteErrorCode): unknown {
	if (!existsSync(file)) throw new RouteError(missingCode, `${file} is missing`, 3);
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		throw new RouteError("config-invalid", `${file} is not valid JSON`, 4);
	}
}

function readRegistry(configPath: string): Map<string, Record<string, unknown>> {
	const registry = readJson(configPath, "skill-config-missing");
	if (!isRecord(registry) || !isRecord(registry.mcpServers)) {
		throw new RouteError("config-invalid", `${configPath} must declare mcpServers`, 4);
	}
	if (!Array.isArray(registry.imports) || registry.imports.length !== 0) {
		throw new RouteError("imports-not-disabled", `${configPath} must set imports: []`, 4);
	}
	// Every server carries an explicit, array-shaped exact-name allow-list.
	// MCPorter treats a missing list as "allow everything"; this route treats
	// it as a configuration defect and refuses before any process starts.
	const servers = new Map<string, Record<string, unknown>>();
	for (const [name, entry] of Object.entries(registry.mcpServers)) {
		if (!isRecord(entry) || !Array.isArray(entry.allowedTools) || !entry.allowedTools.every((tool) => typeof tool === "string" && tool.length > 0)) {
			throw new RouteError("allowlist-missing", `${configPath} server ${name} must declare an explicit allowedTools array`, 4);
		}
		servers.set(name, entry);
	}
	return servers;
}

function checkOAuthEntry(configPath: string, server: string, entry: Record<string, unknown>): void {
	const endpoint = entry.baseUrl ?? entry.url;
	let hostedHttps = false;
	if (typeof endpoint === "string") {
		try {
			hostedHttps = new URL(endpoint).protocol === "https:";
		} catch {
			// An invalid URL is a configuration refusal below.
		}
	}
	if (entry.auth !== "oauth" || !hostedHttps) {
		throw new RouteError("config-invalid", `${configPath} server ${server} must declare OAuth on a hosted HTTPS endpoint`, 4);
	}
}

function readDeclaration(routePath: string): RouteDeclaration {
	const declaration = readJson(routePath, "skill-route-missing");
	if (!isRecord(declaration) || typeof declaration.defaultProvider !== "string") {
		throw new RouteError("config-invalid", `${routePath} must declare defaultProvider`, 4);
	}
	const selectors = new Map<string, string>();
	if (declaration.selectors !== undefined) {
		if (!isRecord(declaration.selectors)) throw new RouteError("config-invalid", `${routePath} selectors must be an object`, 4);
		for (const [name, envKey] of Object.entries(declaration.selectors)) {
			if (typeof envKey !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(envKey)) {
				throw new RouteError("config-invalid", `${routePath} selector ${name} must map to an environment key`, 4);
			}
			selectors.set(name, envKey);
		}
	}
	if (declaration.dispatcherOwned !== undefined && typeof declaration.dispatcherOwned !== "boolean") {
		throw new RouteError("config-invalid", `${routePath} dispatcherOwned must be a boolean`, 4);
	}
	if (declaration.oauth !== undefined && declaration.oauth !== "mcporter") {
		throw new RouteError("config-invalid", `${routePath} oauth must be mcporter`, 4);
	}
	return { defaultProvider: declaration.defaultProvider, selectors, dispatcherOwned: declaration.dispatcherOwned === true, oauth: declaration.oauth };
}

function selectionEnvironment(skill: string, declared: Map<string, string>, given: Map<string, string>): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const [name, value] of given) {
		const envKey = declared.get(name);
		if (!envKey) throw new RouteError("select-undeclared", `skill ${skill} does not declare selector ${name}`);
		if (!SELECTION_VALUE_PATTERN.test(value)) {
			throw new RouteError("select-invalid", `selector ${name} must match ${SELECTION_VALUE_PATTERN.source}`);
		}
		environment[envKey] = value;
	}
	for (const name of declared.keys()) {
		if (!given.has(name)) throw new RouteError("select-missing", `skill ${skill} requires --select ${name}=<value>`);
	}
	return environment;
}

function targetAndFlags(verb: Verb, server: string, rest: string[]): { target: string; flags: string[] } {
	if (verb === "list" || verb === "auth") return { target: server, flags: rest };
	const tool = rest[0];
	if (!tool || tool.startsWith("-") || !/^[A-Za-z0-9_-]+$/.test(tool)) {
		throw new RouteError("tool-invalid", "call needs a bare tool name on the selected provider");
	}
	return { target: `${server}.${tool}`, flags: rest.slice(1) };
}

// A value flag consumes exactly one present, non-option token, so no option
// can hide behind it. Values are checked for the meaning MCPorter gives them.
function checkValueMeaning(name: string, value: string): void {
	if (name === "--timeout" && !/^[0-9]{1,9}$/.test(value)) {
		throw new RouteError("flag-invalid", "--timeout must be a whole number of milliseconds");
	}
	if (name === "--output" && !OUTPUT_FORMATS.has(value)) {
		throw new RouteError("flag-invalid", `--output must be one of ${[...OUTPUT_FORMATS].join(", ")}`);
	}
	if (name === "--args" || name === "--params") {
		let parsed: unknown;
		try {
			parsed = JSON.parse(value);
		} catch {
			throw new RouteError("flag-invalid", `${name} must be a JSON object`);
		}
		if (!isRecord(parsed)) throw new RouteError("flag-invalid", `${name} must be a JSON object`);
	}
}

function checkFlagValue(verb: Verb, name: string, value: string | undefined): void {
	if (value === undefined) throw new RouteError("flag-invalid", `${name} needs a value`);
	if (value.startsWith("-")) {
		const equals = value.indexOf("=");
		const next = equals === -1 ? value : value.slice(0, equals);
		if (!ALLOWED_FLAGS[verb].has(next)) throw new RouteError("flag-forbidden", `flag ${next} is not allowed on ${verb}`);
		throw new RouteError("flag-invalid", `${name} needs a value`);
	}
	checkValueMeaning(name, value);
}

// Returns how many tokens the option at `index` consumed.
function checkOption(verb: Verb, flags: string[], index: number): number {
	const token = flags[index] ?? "";
	const equals = token.indexOf("=");
	const name = equals === -1 ? token : token.slice(0, equals);
	if (!ALLOWED_FLAGS[verb].has(name)) throw new RouteError("flag-forbidden", `flag ${name} is not allowed on ${verb}`);
	if (!VALUE_FLAGS.has(name)) {
		if (equals !== -1) throw new RouteError("flag-invalid", `${name} takes no value`);
		return 1;
	}
	if (equals !== -1) {
		checkFlagValue(verb, name, token.slice(equals + 1));
		return 1;
	}
	checkFlagValue(verb, name, flags[index + 1]);
	return 2;
}

// Tool arguments are named only. MCPorter reads a local file for a value that
// starts with a single @, so that form never reaches it.
function checkToolArgument(token: string): void {
	const match = TOOL_ARGUMENT_PATTERN.exec(token);
	if (!match) throw new RouteError("argument-invalid", `tool arguments take the form name=value or name:value: ${token}`);
	const value = match[2] ?? "";
	if (value.startsWith("@") && !value.startsWith("@@")) {
		throw new RouteError("argument-invalid", `a tool argument cannot read a local file: ${match[1]}`);
	}
}

// Allow-list, not deny-list: anything MCPorter could use to reach another
// server, config, working directory, header, or environment is absent from it.
function checkFlags(verb: Verb, flags: string[]): string[] {
	let index = 0;
	while (index < flags.length) {
		const token = flags[index] ?? "";
		if (token.startsWith("-")) {
			index += checkOption(verb, flags, index);
			continue;
		}
		if (verb !== "call") throw new RouteError("arguments-invalid", `unexpected ${verb} argument: ${token}`);
		checkToolArgument(token);
		index += 1;
	}
	return verb === "auth" || flags.includes("--no-oauth") ? flags : [...flags, "--no-oauth"];
}

function plan(argv: string[], skillsRoot: string, env: Record<string, string | undefined>, dispatcherTransport: boolean, internalContext?: string): RoutePlan {
	const invocation = parseInvocation(argv);
	const configDir = path.join(skillsRoot, invocation.skill, "config");
	const configPath = path.join(configDir, "mcporter.json");
	if (!existsSync(configPath)) throw new RouteError("skill-config-missing", `${configPath} is missing`, 3);
	const declaration = readDeclaration(path.join(configDir, "route.json"));
	if (declaration.dispatcherOwned && !dispatcherTransport) {
		throw new RouteError("dispatcher-owned", `skill ${invocation.skill} accepts provider transport only through its semantic dispatcher`, 3);
	}
	if (invocation.verb === "auth" && declaration.oauth !== "mcporter") {
		throw new RouteError("command-invalid", `skill ${invocation.skill} does not declare MCPorter OAuth`);
	}
	const servers = readRegistry(configPath);
	const server = invocation.provider ?? declaration.defaultProvider;
	if (!servers.has(server)) {
		throw new RouteError("provider-invalid", `provider ${server} is not declared by skill ${invocation.skill}`);
	}
	if (invocation.verb === "auth") checkOAuthEntry(configPath, server, servers.get(server)!);
	const selections = selectionEnvironment(invocation.skill, declaration.selectors, invocation.selections);
	const { target, flags } = targetAndFlags(invocation.verb, server, invocation.rest);
	const routeEnv: Record<string, string> = { MCPORTER_NO_KEEPALIVE: "*", ...safeEnvironment(env) };
	Object.assign(routeEnv, selections);
	if (internalContext !== undefined) {
		if (!dispatcherTransport || !validInternalContext(internalContext)) throw new RouteError("internal-context-invalid", "the dispatcher context must be one non-empty single-line value", 3);
		// This fixed channel is unavailable to planRoute and cannot overwrite
		// selectors, keep-alive policy, or any safe route environment key.
		routeEnv[INTERNAL_INVOCATION_CONTEXT_ENV] = internalContext;
	}
	return {
		configPath,
		server,
		argv: ["--config", configPath, invocation.verb, target, ...checkFlags(invocation.verb, flags)],
		env: routeEnv,
	};
}

// The public launcher cannot reach a Connector Skill whose provider transport
// belongs to its semantic dispatcher.
export function planRoute(argv: string[], skillsRoot: string, env: Record<string, string | undefined>): RoutePlan {
	return plan(argv, skillsRoot, env, false);
}

// Internal seam for a dispatcher after it has enforced its own policy.
export function planDispatcherRoute(argv: string[], skillsRoot: string, env: Record<string, string | undefined>, internalContext: string): RoutePlan {
	return plan(argv, skillsRoot, env, true, internalContext);
}

function refuse(code: string, message: string, exitCode: number): never {
	process.stderr.write(`${PROGRAM}:error:${code}:${message}\n`);
	process.exit(exitCode);
}

// The skills root is fixed by the entry point, never by the caller or the
// environment. The production entry below uses the plugin's own skills; the
// test suite owns a fixture entry that passes its fixture skills.
export function main(argv: string[], skillsRoot: string): never {
	let plan: RoutePlan;
	try {
		plan = planRoute(argv, skillsRoot, process.env);
	} catch (error) {
		if (error instanceof RouteError) refuse(error.code, error.message, error.exitCode);
		throw error;
	}
	const mcporter = Bun.which("mcporter", { PATH: plan.env.PATH ?? "" });
	if (!mcporter) refuse("executable-missing", "mcporter is not available on PATH", 3);
	const execve = process.execve;
	if (!execve) refuse("execve-unavailable", "this Bun runtime cannot replace the process", 3);
	execve(mcporter, ["mcporter", ...plan.argv], plan.env);
	refuse("exec-failed", "MCPorter did not start", 3);
}

if (import.meta.main) main(process.argv.slice(2), path.resolve(import.meta.dir, "..", "skills"));
