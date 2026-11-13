import { writeFile } from "node:fs/promises";
import { stationsFor } from "./branch-station-catalog.ts";
import { choose } from "./chooser.ts";
import { COMMANDS, envelope, TargetArgument } from "./command-contract.ts";
import { attemptEmergencyDiagnostic, recordDiagnostic } from "./diagnostics.ts";
import { resultFor } from "./engine.ts";
import type { InventoryRow, OperationResult } from "./model.ts";
import { inventory, openBoard, openTarget, readConfig, readLogs, startTarget } from "./operations.ts";
import { systemProcessLifecycle } from "./process-lifecycle.ts";

const lifecycle = systemProcessLifecycle(attemptEmergencyDiagnostic);
process.on("SIGINT", () => lifecycle.terminate(130));
process.on("SIGTERM", () => lifecycle.terminate(143));

const USAGE =
  "remote-dev [choose] | list [--all] | open TARGET | start TARGET | logs TARGET [--lines N] | board TARGET  [--json]";

const HUMAN_HELP = `Usage: ${USAGE}

Return to an approved remote development container from this Mac.
Only start (or the chooser start action) starts an explicitly opted-in existing container.
Other actions never start containers. No command creates, restarts, rebuilds, stops, or removes containers or services.

Commands:
  (none), --help  Show this help without connecting or starting anything.
  choose          Interactive fuzzy chooser (needs a terminal). Known targets first;
                  recent editor requests first within that view.
                  Ctrl-A switches to all containers. Enter selects, Esc cancels.
  list [--all]    List configured targets, or every container with --all.
  open TARGET     Recheck TARGET, then open it in the isolated VS Code environment.
  start TARGET    Start the existing target, restore configured services, then open VS Code.
                  Only exited or created containers can be started; running skips start.
  logs TARGET     Recheck TARGET, then print its native service log tail (secrets redacted).
                  Editor connection logs: in VS Code, View > Output > Dev Containers or Remote - SSH.
  board TARGET    Recheck TARGET, then open its configured task board.

Options:
  --all           Include unclassified containers (inspect only).
  --lines N       Log lines, 1 to 1000 (default 200).
  --json          One machine envelope on stdout.

Examples:
  remote-dev choose
  remote-dev list --json
  remote-dev open pilot

Discovery:
  remote-dev --discover --json
  remote-dev --discover-command COMMAND_IDENTITY --json

Config: $REMOTE_DEV_CONFIG or \${XDG_CONFIG_HOME:-~/.config}/remote-dev/targets.json
`;

const KNOWN = new Set(["board", "choose", "list", "logs", "open", "start"]);

const OPTIONS = [
  { name: "--all", value: null },
  { name: "--json", value: null },
  { name: "--lines", value: "N" },
];

function hasJson(argv: string[]): boolean {
  return argv.includes("--json");
}

function interactive(): boolean {
  return process.stdin.isTTY === true && process.stderr.isTTY === true;
}

async function waitForLifecycleTest(): Promise<void> {
  if (process.env.NODE_ENV !== "test") return;
  const readyPath = process.env.REMOTE_DEV_TEST_READY_PATH;
  if (readyPath !== undefined) await writeFile(readyPath, "ready\n");
  const crash = process.env.REMOTE_DEV_TEST_CRASH;
  if (crash === "uncaught" || crash === "unhandled") {
    await new Promise<void>(() => {
      queueMicrotask(() => {
        if (crash === "uncaught") throw new Error("test uncaught exception");
        void Promise.reject(new Error("test unhandled rejection"));
      });
    });
  }
  const milliseconds = Number(process.env.REMOTE_DEV_TEST_DELAY_MS ?? "0");
  if (Number.isSafeInteger(milliseconds) && milliseconds > 0) await Bun.sleep(milliseconds);
}

function padForLifecycleTest(result: ReturnType<typeof envelope>): void {
  if (process.env.NODE_ENV !== "test") return;
  const bytes = Number(process.env.REMOTE_DEV_TEST_OUTPUT_BYTES ?? "0");
  if (Number.isSafeInteger(bytes) && bytes > 0) {
    result.result.data = { original: result.result.data, padding: "x".repeat(bytes) };
  }
}

function table(rows: InventoryRow[]): string {
  const header = ["HOST", "TARGET", "ROLE", "STATE", "CONTAINER"];
  const body = rows.map((row) => [
    row.host,
    row.target ?? "-",
    row.role,
    row.state,
    `${row.container}${row.containerId === null ? "" : ` (${row.containerId.slice(0, 12)})`}`,
  ]);
  const widths = header.map((title, index) =>
    Math.max(title.length, ...body.map((cells) => cells[index]?.length ?? 0)),
  );
  return [header, ...body]
    .map((cells) => cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ").trimEnd())
    .join("\n");
}

function humanSuccess(result: OperationResult): string {
  const data = result.data as { rows?: InventoryRow[]; text?: string } | null;
  if (result.commandIdentity === "remote-dev.list" && data?.rows !== undefined) {
    const rows = data.rows;
    const notes = rows.filter((row) => row.reason !== null).map((row) => `- ${row.target ?? row.container}: ${row.reason}`);
    return [result.message, "", rows.length === 0 ? "(no rows)" : table(rows), ...(notes.length > 0 ? ["", ...notes] : [])].join("\n");
  }
  if (typeof data?.text === "string") return `${result.message}\n\n${data.text.replace(/\n?$/, "")}`;
  return result.message;
}

function write(result: OperationResult, json: boolean): number {
  const machine = envelope(result);
  if (json) {
    padForLifecycleTest(machine);
    lifecycle.stdout(`${JSON.stringify(machine)}\n`);
  } else if (result.outcome === "success") {
    lifecycle.stdout(`${humanSuccess(result)}\n`);
  } else {
    const next = machine.result.handoff?.reason ?? machine.result.nextAction ?? "";
    lifecycle.stderr(`${result.message} ${next}\n`);
  }
  return result.exitCode;
}

function inspected(commandIdentity: string, data: unknown, message: string): OperationResult {
  return resultFor(commandIdentity, "inspected", { data, message });
}

function usage(message = "Unknown command or option. Run remote-dev --help."): OperationResult {
  return resultFor("remote-dev.dispatch", "usage", { message });
}

function discovery(args: string[]): OperationResult | null {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return inspected(
      "remote-dev.help",
      { commands: COMMANDS, options: OPTIONS, summary: "Remote development entry.", usage: USAGE },
      "Show help.",
    );
  }
  if (args.length === 1 && args[0] === "--discover") {
    return inspected(
      "remote-dev.discovery",
      {
        commands: COMMANDS,
        contractVersion: "2.0.0",
        effectExclusions: [
          "Only start and the chooser start action may start an opted-in exact existing container; other actions never start containers.",
          "No command creates, restarts, rebuilds, replaces, stops, removes, or prunes containers or services.",
          "External effects are starting an opted-in existing container and opening VS Code or a browser window; diagnostics are not domain effects.",
        ],
        exitMeanings: { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "transient" },
        generationConventionVersion: "2.0.0",
        profile: "complex",
        signalExits: { "130": "SIGINT", "143": "SIGTERM" },
      },
      "Describe commands.",
    );
  }
  if (args.length === 2 && args[0] === "--discover-command") {
    const command = COMMANDS.find((candidate) => candidate.commandIdentity === args[1]);
    if (command === undefined) return usage("Unknown command identity. Run remote-dev --discover --json.");
    return inspected(
      "remote-dev.command-discovery",
      { command, semantics: "possible-outcomes", stations: stationsFor(command.commandIdentity) },
      `Describe ${command.commandIdentity}.`,
    );
  }
  return null;
}

async function list(args: string[]): Promise<OperationResult> {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--all")) return usage();
  await waitForLifecycleTest();
  const config = await readConfig(process.env);
  if (!config.ok) return resultFor("remote-dev.list", config.reason);
  const found = await inventory(config.value, args[0] === "--all", process.env);
  if (!found.ok) return resultFor("remote-dev.list", found.reason);
  const count = found.value.data.rows.length;
  const message =
    count === 0
      ? "No development targets found. Nothing was started."
      : `${count} ${found.value.data.view === "all" ? "containers" : "known targets"}; nothing was started.`;
  return inspected("remote-dev.list", found.value.data, message);
}

function parseLines(args: string[]): number | null | "invalid" {
  if (args.length === 0) return null;
  if (args.length !== 2 || args[0] !== "--lines") return "invalid";
  const value = Number(args[1]);
  return Number.isSafeInteger(value) && value >= 1 && value <= 1000 ? value : "invalid";
}

async function targetCommand(name: "board" | "logs" | "open" | "start", args: string[]): Promise<OperationResult> {
  const commandIdentity = `remote-dev.${name}`;
  const [target, ...rest] = args;
  if (target === undefined || target.startsWith("--")) return usage(`${name} needs a TARGET. Run remote-dev list.`);
  const lines = name === "logs" ? parseLines(rest) : rest.length === 0 ? null : "invalid";
  if (lines === "invalid" && name !== "logs") return usage();
  if (!TargetArgument.safeParse(target).success || lines === "invalid") {
    return resultFor(commandIdentity, "input-invalid");
  }
  const config = await readConfig(process.env);
  if (!config.ok) return resultFor(commandIdentity, config.reason);
  if (name === "start") return startTarget(commandIdentity, config.value, target, process.env);
  if (name === "open") return openTarget(commandIdentity, config.value, target, process.env);
  if (name === "board") return openBoard(commandIdentity, config.value, target, process.env);
  return readLogs(commandIdentity, config.value, target, lines ?? 200, process.env);
}

async function chooseCommand(args: string[]): Promise<OperationResult> {
  if (args.length > 0) return usage();
  if (!interactive()) return resultFor("remote-dev.choose", "needs-tty");
  return choose(process.env);
}

async function main(argv: string[]): Promise<number> {
  const json = hasJson(argv);
  const args = argv.filter((value) => value !== "--json");
  if (args.length === 0) args.push("--help");
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h") && !json) {
    lifecycle.stdout(HUMAN_HELP);
    return 0;
  }
  const described = discovery(args);
  if (described !== null) return write(described, json);
  const [command, ...rest] = args;
  await recordDiagnostic(KNOWN.has(command ?? "") ? `remote-dev.${command}` : "remote-dev.choose");
  if (command === undefined || command === "choose") return write(await chooseCommand(rest), json);
  if (command === "list") return write(await list(rest), json);
  if (command === "open" || command === "logs" || command === "board" || command === "start") {
    return write(await targetCommand(command, rest), json);
  }
  return write(usage(), json);
}

await lifecycle.complete(await main(process.argv.slice(2)));
