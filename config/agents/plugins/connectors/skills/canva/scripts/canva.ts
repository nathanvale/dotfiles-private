#!/usr/bin/env bun
// Canva launcher: attended login, nonsecret status, and read calls for one
// Canva Account through MCPorter's native OAuth vault. The route plan comes
// from the shared launcher; this file adds only the account vault and the
// client-mode switch, then replaces itself with MCPorter.
//
//   canva <login|status|list|call> --account <slug> [MCPorter flags]
//
// Refusals print one `canva:error:<cause>:<message>` line on stderr; causes
// and exits live in contract.ts. Success output belongs to MCPorter, except
// status, which prints one JSON object.
import { providerProcess } from "../../../bin/provider-process.ts";
import { CanvaError, type Command, isCommand, USAGE } from "./contract.ts";
import { accountVault, checkAccount, inspectVault, planCanvaRoute, prepareVault, readClientMode, requireAdmittedMode } from "./custody/index.ts";

const LOGIN_FLAGS = new Set(["--no-browser", "--reset"]);
const provider = providerProcess("canva");

function status(account: string): void {
	const mode = readClientMode();
	const inspection = inspectVault(process.env, accountVault(process.env, account));
	process.stdout.write(`${JSON.stringify({ account, custody: "mcporter-native", clientMode: mode, clientModeAdmitted: mode === "dcr", ...inspection })}\n`);
}

// Login is attended and human-facing, so only the two MCPorter flags that keep
// it that way cross: never --json, which would put the authorization URL in a
// machine result.
function mcporterArgs(command: Exclude<Command, "status">, rest: string[]): string[] {
	if (command !== "login") return [command, ...rest];
	if (rest.some((flag) => !LOGIN_FLAGS.has(flag))) throw new CanvaError("flag-forbidden", "login accepts only --no-browser and --reset");
	return ["auth", ...rest];
}

// Every check and dependency lookup precedes the first state change, so a
// refusal leaves no vault directory behind.
function run(command: Exclude<Command, "status">, account: string, rest: string[]): never {
	requireAdmittedMode(readClientMode());
	const { plan, vault } = planCanvaRoute(process.env, account, mcporterArgs(command, rest));
	const mcporter = providerProcess("canva", plan.env).executableOnPath("mcporter");
	prepareVault(vault);
	return provider.replaceProcess(mcporter, ["mcporter", ...plan.argv], plan.env);
}

function main(argv: string[]): void {
	const [command, flag, account, ...rest] = argv;
	if (command === "--help") {
		process.stdout.write(`${USAGE}\n`);
		return;
	}
	if (!isCommand(command)) throw new CanvaError("command-invalid", `usage: ${USAGE}`);
	if (flag !== "--account") throw new CanvaError("account-invalid", "--account <slug> must follow the command");
	const selected = checkAccount(account);
	if (command !== "status") run(command, selected, rest);
	if (rest.length > 0) throw new CanvaError("arguments-invalid", "status takes no further arguments");
	status(selected);
}

try {
	main(process.argv.slice(2));
} catch (error) {
	if (error instanceof CanvaError) provider.fail(error.code, error.message, error.exitCode);
	throw error;
}
