#!/usr/bin/env bun
// canva-auth: the attended Canva login, session status, and logout CLI for
// the Connectors plugin, on the Contract Core 2.0 complex profile. It never
// prompts, never automates the browser (it only opens the system browser or
// prints the URL), never prints a token, and returns every public path
// through the validated envelope in scripts/auth/contract.ts.
//
//   canva-auth login  --account <slug> [--no-browser] [--json]
//   canva-auth status --account <slug> [--json]
//   canva-auth logout --account <slug> [--json]
//   canva-auth --discover [--json] | --discover-command <identity> [--json] | --help [--json]
import { stateRoot } from "../../../bin/private-state.ts";
import { safeEnvironment } from "../../../bin/safe-environment.ts";
import { AVAILABLE_PATHS, COMMANDS, type CommandIdentity, DISCOVERY_DATA, type Envelope, envelope, HELP_DATA, HELP_TEXT, isCommandIdentity, PROGRAM, REPAIR, type Rendering, RETRY_DELAY_MS, STATIONS, validateEnvelope } from "./auth/contract.ts";
import { ACCOUNT_PATTERN, clientEnvironment, loadOAuthConfig, type LoginResult, type LogoutResult, login, logout, type SessionDeps, type SessionStatus, type StatusResult, status } from "./session/index.ts";

const COMMAND_WORDS = ["login", "status", "logout"] as const;
type CommandWord = (typeof COMMAND_WORDS)[number];
const FLAGS = ["--help", "--discover", "--json", "--no-browser"] as const;
const VALUES = ["--discover-command", "--account"] as const;
type Flag = (typeof FLAGS)[number];
type ValueOption = (typeof VALUES)[number];

interface Options {
	flags: Set<Flag>;
	values: Partial<Record<ValueOption, string>>;
	command: CommandWord | undefined;
}

type Parsed = { ok: true; options: Options } | { ok: false; reason: string };

function takeOption(options: Options, token: string, value: string | undefined): { consumed: number } | string {
	if ((FLAGS as readonly string[]).includes(token)) {
		options.flags.add(token as Flag);
		return { consumed: 1 };
	}
	if ((VALUES as readonly string[]).includes(token)) {
		if (value === undefined || value.startsWith("-")) return `${token} needs a value`;
		if (token in options.values) return `${token} may appear only once`;
		options.values[token as ValueOption] = value;
		return { consumed: 2 };
	}
	return `unknown option ${token}`;
}

// Strict argv: one command word, flags, and single-valued options.
function parseArgv(argv: string[]): Parsed {
	const options: Options = { flags: new Set(), values: {}, command: undefined };
	for (let index = 0; index < argv.length; ) {
		const token = argv[index] ?? "";
		if (token.startsWith("-")) {
			const taken = takeOption(options, token, argv[index + 1]);
			if (typeof taken === "string") return { ok: false, reason: taken };
			index += taken.consumed;
			continue;
		}
		if (options.command !== undefined || !(COMMAND_WORDS as readonly string[]).includes(token)) return { ok: false, reason: `unexpected argument ${token}` };
		options.command = token as CommandWord;
		index += 1;
	}
	return { ok: true, options };
}

// The dependencies a test injects; production builds them in main.
export interface CliDeps {
	session: SessionDeps | null;
	stateRoot: string;
	clock: SessionDeps["clock"];
	fetch: SessionDeps["fetch"];
}

const effectIds = (account: string) => ({ session: `canva-session:${account}`, grant: `canva-grant:${account}` });

const usage = (identity: CommandIdentity, effectClass: Rendering["effectClass"], reason: string): Rendering => ({ identity, cause: "USAGE_INVALID_INVOCATION", effectClass, message: `${PROGRAM} refused: ${reason}`, data: null, guidance: { nextAction: "canva-auth --help" }, repairAction: REPAIR.usage });

function renderLogin(account: string, result: LoginResult, urls: string[]): Rendering {
	const identity: CommandIdentity = "canva-auth.login";
	const ids = effectIds(account);
	const failed = (cause: Rendering["cause"], repairAction: string, guidance: Rendering["guidance"], effects?: Rendering["effects"]): Rendering => ({ identity, cause, effectClass: "external", message: `login ${cause === "DOMAIN_RECOVERY_HANDOFF_REQUIRED" || cause === "DOMAIN_DEADLINE_UNCHANGED" ? "failed" : "refused"}: ${result.ok ? "" : result.cause}`, data: null, ...(effects ? { effects } : {}), guidance, repairAction });
	if (result.ok) return { identity, cause: "SUCCESS_COMPLETED", effectClass: "external", message: `login succeeded for account ${account}`, data: { ...result.status, authorizationUrlPrinted: urls.length > 0 }, effects: { completed: [ids.grant, ids.session] }, guidance: { nextAction: "canva-auth status --account <slug>" }, repairAction: null };
	switch (result.cause) {
		case "account-invalid":
			return usage(identity, "external", result.detail);
		case "session-unwritable":
			return failed("INTERNAL_PREPARATION", REPAIR.unwritable, { nextAction: "canva-auth status --account <slug>" });
		case "session-exists":
			return failed("DOMAIN_PRECONDITION_UNMET", REPAIR.sessionExists, { nextAction: "canva-auth status --account <slug>" });
		case "client-secret-required":
			return failed("DOMAIN_PRECONDITION_UNMET", REPAIR.registeredSecretRequired, { nextAction: "canva-auth status --account <slug>" });
		case "session-busy":
			return failed("TRANSIENT_NOT_STARTED", REPAIR.lockHeld, { nextAction: `retry canva-auth login once after ${RETRY_DELAY_MS} ms` });
		case "login-denied":
		case "login-mismatch":
			return failed("DOMAIN_AUTHORITY_REQUIRED", REPAIR.denied, { handoff: { owner: "human", reason: "Canva did not grant access for this login.", inspect: ["canva-auth status --account <slug>"] } });
		case "login-timeout":
			return failed("DOMAIN_DEADLINE_UNCHANGED", REPAIR.timeout, { nextAction: "canva-auth login --account <slug>" });
		case "exchange-failed":
			return failed("DOMAIN_RECOVERY_HANDOFF_REQUIRED", REPAIR.exchange, { handoff: { owner: "human", reason: "A grant may exist at Canva with no local session.", inspect: ["canva-auth status --account <slug>"] } }, { uncertain: [ids.grant] });
		default:
			return failed("DOMAIN_PRECONDITION_UNMET", REPAIR.precondition, { nextAction: "canva-auth status --account <slug>" });
	}
}

function renderStatus(account: string, result: StatusResult): Rendering {
	const identity: CommandIdentity = "canva-auth.status";
	if (result.ok) return { identity, cause: "SUCCESS_UNCHANGED", effectClass: "inspect", message: `status for account ${account}`, data: result.status, guidance: { nextAction: "canva-auth status --account <slug>" }, repairAction: null };
	if (result.cause === "account-invalid") return usage(identity, "inspect", result.detail);
	const cause = result.cause === "auth-required" ? "DOMAIN_PRECONDITION_UNMET" : "SCHEMA_INVALID_INPUT";
	return { identity, cause, effectClass: "inspect", message: `status refused: ${result.cause}`, data: null, guidance: { nextAction: "canva-auth login --account <slug>" }, repairAction: result.cause === "auth-required" ? REPAIR.authRequired : REPAIR.sessionInvalid };
}

function renderLogoutFailure(account: string, result: Extract<LogoutResult, { ok: false }>): Rendering {
	const identity: CommandIdentity = "canva-auth.logout";
	const ids = effectIds(account);
	if (result.cause === "account-invalid") return usage(identity, "external", result.detail);
	if (result.cause === "auth-busy") return { identity, cause: "TRANSIENT_NOT_STARTED", effectClass: "external", message: "logout refused: auth-busy", data: null, guidance: { nextAction: `retry canva-auth logout once after ${RETRY_DELAY_MS} ms` }, repairAction: REPAIR.lockHeld };
	if (result.cause === "client-secret-unavailable") return { identity, cause: "DOMAIN_PRECONDITION_UNMET", effectClass: "external", message: "logout refused: client-secret-unavailable", data: null, effects: { remaining: [ids.grant, ids.session] }, guidance: { nextAction: "canva-auth status --account <slug>" }, repairAction: REPAIR.clientSecretUnavailable };
	if (result.cause === "session-binding-invalid") return { identity, cause: "DOMAIN_PRECONDITION_UNMET", effectClass: "external", message: "logout refused: session-binding-invalid", data: null, effects: { remaining: [ids.grant, ids.session] }, guidance: { nextAction: "restore the original oauth.json for this session, then retry canva-auth logout --account <slug>" }, repairAction: REPAIR.bindingInvalid };
	const operator = (reason: string): Rendering["guidance"] => ({ handoff: { owner: "operator", reason, inspect: ["canva-auth status --account <slug>"] } });
	if (result.revoked === "confirmed") return { identity, cause: "INTERNAL_RESULT_PARTIAL", effectClass: "external", message: "logout failed: session-unremovable", data: null, effects: { completed: [ids.grant], remaining: [ids.session] }, guidance: operator("The grant is revoked but the local session remains."), repairAction: REPAIR.unremovable };
	if (result.revoked === "uncertain") return { identity, cause: "INTERNAL_RESULT_UNKNOWN", effectClass: "external", message: "logout failed: session-unremovable", data: null, effects: { remaining: [ids.session], uncertain: [ids.grant] }, guidance: operator("Neither the grant nor the local session is in a known state."), repairAction: REPAIR.unremovable };
	return { identity, cause: "INTERNAL_RESULT_UNCHANGED", effectClass: "external", message: "logout failed: session-unremovable", data: null, effects: { remaining: [ids.session] }, guidance: operator("The local session could not be removed."), repairAction: REPAIR.unremovable };
}

function renderLogout(account: string, result: LogoutResult): Rendering {
	const identity: CommandIdentity = "canva-auth.logout";
	const ids = effectIds(account);
	if (!result.ok) return renderLogoutFailure(account, result);
	const nextAction = "canva-auth status --account <slug>";
	if (!result.removed) return { identity, cause: "SUCCESS_UNCHANGED", effectClass: "external", message: `no session existed for account ${account}`, data: { account, removed: false, revoked: result.revoked }, guidance: { nextAction }, repairAction: null };
	if (result.revoked === "uncertain") return { identity, cause: "DOMAIN_RECOVERY_HANDOFF_REQUIRED", effectClass: "external", message: "logout removed the session but revocation is unconfirmed", data: null, effects: { completed: [ids.session], uncertain: [ids.grant] }, guidance: { handoff: { owner: "human", reason: "Canva did not confirm revocation of the grant.", inspect: [nextAction] } }, repairAction: REPAIR.revokeUncertain };
	return { identity, cause: "SUCCESS_COMPLETED", effectClass: "external", message: `logout succeeded for account ${account}`, data: { account, removed: true, revoked: result.revoked }, effects: { completed: result.revoked === "confirmed" ? [ids.grant, ids.session] : [ids.session] }, guidance: { nextAction }, repairAction: null };
}

function commandDiscovery(identity: string | undefined): Rendering {
	const self: CommandIdentity = "canva-auth.command-discovery";
	if (identity === undefined || !isCommandIdentity(identity)) {
		return { identity: self, cause: "USAGE_UNKNOWN_COMMAND", effectClass: "inspect", message: "command discovery refused: unknown command identity", data: null, guidance: { nextAction: "canva-auth --help" }, repairAction: REPAIR.unknownCommand };
	}
	const command = COMMANDS.find((entry) => entry.commandIdentity === identity);
	return { identity: self, cause: "SUCCESS_UNCHANGED", effectClass: "inspect", message: `possible outcomes of ${identity}`, data: { command, semantics: "possible-outcomes", stations: STATIONS.filter((station) => station.commandIdentity === identity) }, guidance: { nextAction: "canva-auth status --account <slug>" }, repairAction: null };
}

// With --no-browser the human must have the URL before the callback wait, so
// it is written immediately to human stdout. JSON mode refuses this option.
export function authorizationNotice(url: string): { stream: "stdout"; text: string } {
	return { stream: "stdout", text: `Open this URL in your browser to continue, then return here:\n${url}\n` };
}

export type Notify = (url: string) => void;

async function runCommand(options: Options, deps: CliDeps, urls: string[], notify: Notify): Promise<Rendering> {
	const command = options.command as CommandWord;
	const identity: CommandIdentity = `canva-auth.${command}`;
	const effectClass = command === "status" ? "inspect" : "external";
	const account = options.values["--account"];
	if (account === undefined || !ACCOUNT_PATTERN.test(account)) return usage(identity, effectClass, "--account must be a lowercase slug");
	if (command === "status") return renderStatus(account, status(account, deps));
	if (command === "logout") return renderLogout(account, await logout(account, deps.session ?? deps));
	if (deps.session === null) return { identity, cause: "INTERNAL_PREPARATION", effectClass: "external", message: "login refused: the oauth.json configuration is missing or invalid", data: null, guidance: { nextAction: "canva-auth status --account <slug>" }, repairAction: REPAIR.unwritable };
	// The URL is surfaced only when the browser is not opened, and immediately.
	const noBrowser = options.flags.has("--no-browser");
	const onAuthorizationUrl = (url: string) => {
		if (!noBrowser) return;
		urls.push(url);
		notify(url);
	};
	return renderLogin(account, await login(account, { noBrowser, onAuthorizationUrl }, deps.session), urls);
}

// Every path renders here; the human line and the machine envelope come from
// one rendering so they cannot disagree. `notify` receives the authorization
// URL before the callback wait starts.
export async function run(argv: string[], deps: CliDeps, notify: Notify = () => undefined): Promise<{ rendering: Rendering; urls: string[] }> {
	const urls: string[] = [];
	const parsed = parseArgv(argv);
	if (!parsed.ok) return { rendering: usage("canva-auth.dispatch", "inspect", parsed.reason), urls };
	const { options } = parsed;
	if (options.command === "login" && options.flags.has("--no-browser") && options.flags.has("--json")) {
		return { rendering: usage("canva-auth.login", "external", "--no-browser cannot be combined with --json because machine completion requires empty stderr"), urls };
	}
	if (options.flags.has("--help")) return { rendering: { identity: "canva-auth.help", cause: "SUCCESS_UNCHANGED", effectClass: "inspect", message: "canva-auth help", data: HELP_DATA, guidance: { nextAction: "canva-auth status --account <slug>" }, repairAction: null }, urls };
	if (options.flags.has("--discover")) return { rendering: { identity: "canva-auth.discovery", cause: "SUCCESS_UNCHANGED", effectClass: "inspect", message: "canva-auth discovery", data: DISCOVERY_DATA, guidance: { nextAction: "canva-auth status --account <slug>" }, repairAction: null }, urls };
	if ("--discover-command" in options.values) return { rendering: commandDiscovery(options.values["--discover-command"]), urls };
	if (options.command === undefined) return { rendering: usage("canva-auth.dispatch", "inspect", "a command is required: login, status, or logout"), urls };
	return { rendering: await runCommand(options, deps, urls, notify), urls };
}

function humanStatus(data: SessionStatus): string {
	const expiry = data.expiresAt === null ? "no expiry" : `expires ${new Date(data.expiresAt).toISOString()}`;
	return `account ${data.account}: client ${data.clientMode} ${data.clientId}, issuer ${data.issuer}, ${expiry}, ${data.refreshable ? "refreshable" : "not refreshable"}`;
}

function humanLines(rendering: Rendering): string {
	switch (rendering.identity) {
		case "canva-auth.help":
			return HELP_TEXT;
		case "canva-auth.discovery":
			return `${[DISCOVERY_DATA.profile === "complex" ? "profile: complex" : "", `contract version: ${DISCOVERY_DATA.contractVersion}`, ...COMMANDS.map((command) => `command: ${command.commandIdentity} (${command.effectClass}): ${command.summary}`), ...Object.entries(DISCOVERY_DATA.exitMeanings).map(([exit, meaning]) => `exit ${exit}: ${meaning}`)].filter(Boolean).join("\n")}\n`;
		case "canva-auth.command-discovery": {
			const data = rendering.data as { command: { commandIdentity: string }; stations: { outcome: string; causeCode: string; transactionState: string; exitCode: number; retryable: boolean; reachability: string }[] };
			return `${[`${data.command.commandIdentity}: possible outcomes`, ...data.stations.map((station) => `  ${station.outcome} | ${station.causeCode} | ${station.transactionState} | exit ${station.exitCode} | retryable ${station.retryable} | ${station.reachability}`)].join("\n")}\n`;
		}
		case "canva-auth.status":
			return `${humanStatus(rendering.data as SessionStatus)}\n`;
		default:
			return `${rendering.message}\n`;
	}
}

export function renderOutput(rendering: Rendering, json: boolean): { stdout: string; stderr: string; exitCode: number } {
	let built = envelope(rendering);
	if (validateEnvelope(built).length > 0) {
		built = envelope({ identity: rendering.identity, cause: "INTERNAL_UNEXPECTED", effectClass: rendering.effectClass, message: "the result could not be validated", data: null, guidance: { handoff: { owner: "operator", reason: "The envelope failed validation before output.", inspect: ["canva-auth status --account <slug>"] } }, repairAction: REPAIR.unexpected });
	}
	if (json) return { stdout: `${JSON.stringify(built)}\n`, stderr: "", exitCode: built.result.exitCode };
	if (built.result.outcome === "success") return { stdout: humanLines(rendering), stderr: "", exitCode: 0 };
	return { stdout: "", stderr: `${PROGRAM}: ${built.result.causeCode}: ${built.result.repairAction}\n`, exitCode: built.result.exitCode };
}

function productionDeps(): CliDeps {
	const environment = safeEnvironment(process.env);
	const root = stateRoot(environment);
	const clock = { now: Date.now, sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };
	const config = loadOAuthConfig();
	const session: SessionDeps | null = config
		? {
				fetch,
				// The system browser is attended only: opened once, never driven.
				openBrowser: async (url) => {
					Bun.spawn(["/usr/bin/open", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
				},
				clock,
				random: (bytes) => crypto.getRandomValues(new Uint8Array(bytes)),
				stateRoot: root,
				env: clientEnvironment(process.env),
				config,
			}
		: null;
	return { session, stateRoot: root, clock, fetch };
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const json = argv.includes("--json");
	const { rendering } = await run(argv, productionDeps(), (url) => {
		const notice = authorizationNotice(url);
		process.stdout.write(notice.text);
	});
	const output = renderOutput(rendering, json);
	process.stdout.write(output.stdout);
	process.stderr.write(output.stderr);
	process.exit(output.exitCode);
}

export { AVAILABLE_PATHS, type Envelope };
