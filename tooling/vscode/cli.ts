#!/usr/bin/env bun
import { commands, type Command, discover, type Envelope, failure, success } from "./contract.ts";
import { requireValue } from "./model.ts";
import { apply, loadPlan, preview, rollback, status, stopInstaller } from "./runtime.ts";

const help = `Usage: bun run vscode <command> [options]

  preview --target ROOT [--state DIR] [--code EXECUTABLE] [--vsix ID=PATH]
    Write a private review plan; never launch Code or write editor files.
  apply --plan FILE --editor-closed
    Apply the exact preview and install declared client extensions.
  status --plan FILE
    Inspect durable intent and actual files without replay.
  rollback --plan FILE --editor-closed
    Restore owned configuration bytes. Installed extensions are retained.

ROOT must contain separate user-data/User and extensions directories.
All paths must be absolute. --json emits the version 2 machine envelope.
--discover --json and --discover-command vscode.apply --json describe effects.
No command opens/reloads the editor, connects to containers or changes services.

Example: bun run vscode preview --target /absolute/isolated-root --json
`;

function parse(args: string[]) {
	const flags = new Map<string, string[]>();
	const booleans = new Set(["--json", "--editor-closed", "--help", "--discover"]);
	const valued = new Set(["--target", "--state", "--code", "--vsix", "--plan", "--discover-command"]);
	let route = "";
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		if (index === 0 && !arg.startsWith("-")) { route = arg; continue; }
		requireValue(booleans.has(arg) || valued.has(arg), "Unknown option. Run bun run vscode --help.", "usage");
		requireValue(arg === "--vsix" || !flags.has(arg), "Duplicate option; pass it only once.", "usage");
		let value = "true";
		if (valued.has(arg)) {
			value = args[++index] ?? "";
			requireValue(value && !value.startsWith("--"), "Option requires a value. Run bun run vscode --help.", "usage");
		}
		flags.set(arg, [...(flags.get(arg) ?? []), value]);
	}
	return { route, flags };
}

function selected(args: string[]): Command {
	const route = args[0];
	const identity = `vscode.${route}`;
	if (commands.includes(identity as Command)) return identity as Command;
	if (args.includes("--discover") || args.includes("--discover-command")) return "vscode.discover";
	return "vscode.help";
}

async function execute(args: string[]): Promise<Envelope> {
	const command = selected(args);
	try {
		const { route, flags } = parse(args);
		if (flags.has("--help")) return success("vscode.help", { help });
		if (flags.has("--discover") || flags.has("--discover-command")) return discovery(route, flags);
		requireValue(["preview", "apply", "status", "rollback"].includes(route), "Choose preview, apply, status or rollback.", "usage");
		const allowed = route === "preview"
			? ["--target", "--state", "--code", "--vsix", "--json"]
			: ["--plan", "--json", ...(route === "status" ? [] : ["--editor-closed"])];
		requireValue([...flags.keys()].every((key) => allowed.includes(key)), "Option does not belong to this command.", "usage");
		if (route === "preview") return preparePreview(flags);
		const path = flags.get("--plan")?.[0];
		requireValue(path, "This command requires --plan FILE.", "usage");
		const plan = loadPlan(path);
		if (route === "status") return success(command, status(plan));
		const closed = flags.has("--editor-closed");
		if (route === "rollback") {
			const result = await rollback(plan, closed);
			return success(command, result, result.unchanged ? [] : ["configuration:rollback"]);
		}
		const result = await apply(plan, closed);
		return success(command, result, result.unchanged ? [] : result.effects.completed);
	} catch (error) { return failure(command, error); }
}

function discovery(route: string, flags: Map<string, string[]>): Envelope {
	requireValue(!route && flags.size <= 2, "Use discovery alone, optionally with --json.", "usage");
	const selector = flags.get("--discover-command")?.[0];
	requireValue(!selector || commands.includes(selector as Command), "Unknown command identity. Use --discover --json.", "usage");
	return success("vscode.discover", discover(selector as Command | undefined));
}

function preparePreview(flags: Map<string, string[]>): Envelope {
	const target = flags.get("--target")?.[0];
	requireValue(target, "preview requires --target ROOT.", "usage");
	const data = preview(target, flags.get("--state")?.[0], flags.get("--code")?.[0], flags.get("--vsix") ?? []);
	return success("vscode.preview", data, [`plan:${data.plan}`]);
}

// Intent is durable before launch; cancellation kills the task-owned process group.
process.on("SIGINT", () => { stopInstaller(); process.exit(130); });
process.on("SIGTERM", () => { stopInstaller(); process.exit(143); });
process.stdout.on("error", () => process.exit(1)); // EPIPE has no replacement envelope.
const args = process.argv.slice(2);
const result = await execute(args);
if (!args.includes("--json") && result.result.outcome !== "success") {
	process.stderr.write(`${result.message}\n`, () => { process.exitCode = result.result.exitCode; });
} else {
const output = args.includes("--json")
	? JSON.stringify(result)
	: result.result.commandIdentity === "vscode.help" && result.result.outcome === "success"
		? help
		: `${result.message}\n${result.result.data === null ? "" : JSON.stringify(result.result.data, null, 2)}`;
process.stdout.write(`${output}\n`, () => { process.exitCode = result.result.exitCode; });
}
