// One fake for every controlled external boundary (ssh, code, fzf, opener).
// It records its argv and selected environment facts, then replays the
// scenario named by FAKE_SCENARIO. It never touches Docker, SSH, or editors.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

interface Pick {
  exit?: number;
  key?: string;
  match?: string;
}

interface Scenario {
  code?: { exit?: number };
  fzf?: { picks?: Pick[] };
  opener?: { exit?: number };
  ssh?: { exit?: number; logs?: string; ps?: string[]; unreachableAliases?: string[] };
}

const [tool = "unknown", ...argv] = process.argv.slice(2);
const scenarioPath = process.env.FAKE_SCENARIO ?? "";
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as Scenario;
const stdin = tool === "fzf" ? readFileSync(0, "utf8") : "";

function nextCount(): number {
  const counter = `${scenarioPath}.${tool}.count`;
  const count = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  writeFileSync(counter, String(count + 1));
  return count;
}

const count = nextCount();
appendFileSync(
  process.env.FAKE_LOG ?? "",
  `${JSON.stringify({
    argv,
    sshAuthSock: process.env.SSH_AUTH_SOCK ?? null,
    stdin,
    tool,
    vscodeIpcHook: process.env.VSCODE_IPC_HOOK_CLI ?? null,
  })}\n`,
);

function ssh(): number {
  const settings = scenario.ssh ?? {};
  if (settings.exit !== undefined) return settings.exit;
  if (settings.unreachableAliases?.some((alias) => argv.includes(alias))) return 255;
  const command = argv.at(-1) ?? "";
  if (command.includes("'exec'")) {
    process.stdout.write(settings.logs ?? "");
    return 0;
  }
  const outputs = settings.ps ?? [""];
  const sshCount = count < outputs.length ? count : outputs.length - 1;
  process.stdout.write(outputs[sshCount] ?? "");
  return 0;
}

function fzf(): number {
  const pickRow = scenario.fzf?.picks?.[count] ?? { exit: 130 };
  if (pickRow.exit !== undefined && pickRow.exit !== 0) return pickRow.exit;
  const line = stdin.split("\n").find((row) => row.includes(pickRow.match ?? "\u0000"));
  if (line === undefined) return 1;
  const expectsKey = argv.includes("--expect");
  process.stdout.write(`${expectsKey ? `${pickRow.key ?? ""}\n` : ""}${line}\n`);
  return 0;
}

const exits: Record<string, () => number> = {
  code: () => scenario.code?.exit ?? 0,
  fzf,
  opener: () => scenario.opener?.exit ?? 0,
  ssh,
};
process.exit((exits[tool] ?? (() => 99))());
