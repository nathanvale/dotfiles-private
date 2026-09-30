// vault-notes public entry point. check, list and inventory receive their remaining arguments unchanged and keep
// their frozen legacy output; resources and every control path (help, discovery, refusal) speak Contract Core 2.0.
// Every command is inspect-only; see contract.ts for the typed catalogue and effect exclusions.
import { runCheck } from "./check";
import {
  COMMANDS,
  commandDiscovery,
  discoveryData,
  isCommandIdentity,
  type LegacyCommand,
  STATIONS,
  serializeEnvelope,
  stationResult,
  success,
} from "./contract";
import { runInventory } from "./inventory";
import { runList } from "./list";
import { type Output, runResources } from "./resources-command";

const LEGACY_RUNNERS = new Map<string, (args: string[]) => Promise<void>>([
  ["check", (args) => runCheck(args, process.env)],
  ["list", runList],
  ["inventory", runInventory],
] satisfies [LegacyCommand, (args: string[]) => Promise<void>][]);

const USAGE = [
  "Usage:",
  "  vault-notes check [--root PATH] [--canonical-root PATH] [--json]",
  "  vault-notes list [--family NAME] [--root PATH] [--json] [--help]",
  "  vault-notes inventory [--root PATH] [--json]",
  "  vault-notes resources [--project SLUG]... [--root PATH] [--updated YYYY-MM-DD] [--json]",
  "  vault-notes --help [--json] | --discover [--json] | --discover-command COMMAND_IDENTITY [--json]",
];

const OPTIONS = [
  { name: "--root", valueName: "PATH", summary: "Vault root to inspect; default the current directory." },
  {
    name: "--canonical-root",
    valueName: "PATH",
    summary: "check only: canonical checkout for escaping or gitignored link targets; else VAULT_CANONICAL_ROOT, else vault.json.",
  },
  { name: "--family", valueName: "NAME", summary: "list only: one family from the vault contract." },
  { name: "--project", valueName: "SLUG", summary: "resources only: a project folder under projects/; repeatable; default every project." },
  {
    name: "--updated",
    valueName: "YYYY-MM-DD",
    summary: "resources only: the 'updated' date of a newly created index; default today. Existing indexes keep theirs.",
  },
  { name: "--json", valueName: null, summary: "Machine output: legacy JSON for check, list and inventory; one 2.0 envelope otherwise." },
  { name: "--discover", valueName: null, summary: "Describe the contract, commands and effect exclusions." },
  { name: "--discover-command", valueName: "COMMAND_IDENTITY", summary: "Describe one command's possible outcomes." },
  { name: "--help", valueName: null, summary: "Show this help." },
];

const HUMAN_HELP = [
  "Inspect vault notes. Every command is read-only.",
  "",
  ...USAGE,
  "",
  "check, list and inventory keep the vault's legacy output byte-for-byte and emit no",
  "Contract Core 2.0 envelope; resources, help and discovery do. resources proposes each",
  "project's complete Resources Index (resources.md) and its findings; it writes nothing.",
  "",
  "Options:",
  ...OPTIONS.map((option) => `  ${option.name}${option.valueName === null ? "" : ` ${option.valueName}`}  ${option.summary}`),
  "",
  "Examples:",
  "  vault-notes check --root ~/code/my-second-brain-playground",
  "  vault-notes list --family projects --json",
  "  vault-notes resources --project my-second-brain --root ~/code/my-second-brain-playground --json",
  "  vault-notes --discover-command vault-notes.check --json",
].join("\n");

class UsageError extends Error {}

type ControlSelection = { kind: "help" } | { kind: "discover" } | { kind: "discover-command"; selector: string };

/** Control arguments are strict: exactly one of --help, --discover or --discover-command VALUE, plus --json. */
function selectControl(args: string[]): ControlSelection {
  const rest = args.filter((arg) => arg !== "--json");
  const [first, second, ...extra] = rest;
  if (extra.length === 0 && second === undefined && (first === "--help" || first === "-h")) return { kind: "help" };
  if (extra.length === 0 && second === undefined && first === "--discover") return { kind: "discover" };
  if (extra.length === 0 && first === "--discover-command" && second !== undefined) return { kind: "discover-command", selector: second };
  throw new UsageError(first === undefined ? "Choose a command." : "Choose a supported command.");
}

function control(selection: ControlSelection): Output {
  if (selection.kind === "help") {
    const data = {
      summary: "Inspect-only vault notes: check, list, inventory and resources.",
      usage: USAGE.slice(1).map((line) => line.trim()),
      commands: COMMANDS,
      options: OPTIONS,
    };
    return { envelope: success("vault-notes.help", data, "Show help.", "Choose a command from the usage lines."), human: HUMAN_HELP };
  }
  if (selection.kind === "discover") {
    const human =
      "Commands: check (inspect, legacy output), list (inspect, legacy output), inventory (inspect, legacy output), resources (inspect, 2.0)";
    return { envelope: success("vault-notes.discovery", discoveryData(), "Describe commands.", "Choose a command to run."), human };
  }
  const { selector } = selection;
  if (!isCommandIdentity(selector)) throw new UsageError("--discover-command needs a listed command identity.");
  const data = commandDiscovery(selector);
  const rows = "stations" in data ? data.stations.map((row) => `${row.causeCode}/exit ${row.exitCode}`) : data.outcomes.map((row) => `${row.id}/exit ${row.exitCode}`);
  const human = `${selector}: ${rows.join(", ")}`;
  return {
    envelope: success("vault-notes.command-discovery", data, `Describe ${selector}.`, "Read the outcomes; discovery reports no live state."),
    human,
  };
}

function controlIdentity(args: string[]) {
  if (args.includes("--help") || args.includes("-h")) return "vault-notes.help";
  if (args.includes("--discover")) return "vault-notes.discovery";
  if (args.includes("--discover-command")) return "vault-notes.command-discovery";
  return "vault-notes.dispatch";
}

function write(text: string, json: boolean): number | null {
  try {
    process.stdout.write(text);
    return null;
  } catch {
    if (!json) process.stderr.write(`${STATIONS.emission.trigger} Repair: ${STATIONS.emission.repairAction}\n`);
    return 1;
  }
}

/** Machine output: the validated envelope, else the validated internal fallback, else nothing. */
function emitMachine(output: Output): number {
  const text = serializeEnvelope(output.envelope);
  if (text !== null) return write(text, true) ?? output.envelope.result.exitCode;
  const fallback = serializeEnvelope(
    stationResult(
      output.envelope.result.commandIdentity as Parameters<typeof stationResult>[0],
      "serialization",
      STATIONS.serialization.trigger,
    ),
  );
  return fallback === null ? 1 : (write(fallback, true) ?? 1);
}

function emit(output: Output, json: boolean): number {
  if (json) return emitMachine(output);
  const { exitCode, repairAction } = output.envelope.result;
  if (exitCode !== 0) {
    process.stderr.write(`${output.envelope.message} Repair: ${String(repairAction)}\n`);
    return exitCode;
  }
  return write(`${output.human}\n`, false) ?? exitCode;
}

function runControl(args: string[]): number {
  const json = args.includes("--json");
  let output: Output;
  try {
    output = control(selectControl(args));
  } catch (error) {
    const message = error instanceof UsageError ? error.message : "The command failed unexpectedly before producing a result.";
    output = { envelope: stationResult(controlIdentity(args), error instanceof UsageError ? "usage" : "serialization", message), human: "" };
  }
  return emit(output, json);
}

/** Today's date in the process time zone, YYYY-MM-DD. */
function localDate(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function dispatch(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const legacy = LEGACY_RUNNERS.get(command ?? "");
  if (legacy) return legacy(rest);
  const control = ["--help", "-h", "--discover", "--discover-command"];
  if (command === "resources" && !rest.some((arg) => control.includes(arg))) {
    process.exitCode = emit(await runResources(rest, process.cwd(), localDate()), rest.includes("--json"));
    return;
  }
  // Help and discovery read the same after the resources command word as before it.
  process.exitCode = runControl(command === "resources" ? rest : argv);
}

await dispatch(process.argv.slice(2));
