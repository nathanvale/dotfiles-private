// One fake for every controlled external boundary (ssh, code, fzf, opener).
// It records its argv and selected environment facts, then replays the
// scenario named by FAKE_SCENARIO. It never touches Docker, SSH, or editors.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Scenario } from "./harness.ts";

const [tool = "unknown", ...argv] = process.argv.slice(2);
const scenarioPath = process.env.FAKE_SCENARIO ?? "";
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as Scenario;
const stdin = tool === "fzf" ? readFileSync(0, "utf8") : "";
const deliveredSentinel = tool === "ssh" && (argv.at(-1) ?? "").includes("--env-file")
  ? readFileSync(0, "utf8") === "CLAUDE_CODE_OAUTH_TOKEN=NONSECRET_RESTORE_SENTINEL\n"
  : false;

function nextCount(category = tool): number {
  const counter = `${scenarioPath}.${category}.count`;
  const count = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  writeFileSync(counter, String(count + 1));
  return count;
}

const count = tool === "ssh" ? 0 : nextCount();
appendFileSync(
  process.env.FAKE_LOG ?? "",
  `${JSON.stringify({
    argv,
    deliveredSentinel,
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
  const verb = command.split(" ")[3]?.replaceAll("'", "");
  if (verb === "start") return settings.startExit ?? 0;
  if (verb === "exec") {
    process.stdout.write(settings.logs ?? "");
    return 0;
  }
  const outputs = settings.ps ?? [""];
  const inventoryCount = nextCount("inventory");
  const inspectionExit = settings.psExits?.[inventoryCount] ?? 0;
  if (inspectionExit !== 0) return inspectionExit;
  const sshCount = Math.min(inventoryCount, outputs.length - 1);
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
  pilotRuntime: () => {
    process.stdout.write(scenario.pilotRuntime?.output ?? JSON.stringify({ status: "ready", started: [], attempted: false }));
    return scenario.pilotRuntime?.exit ?? 0;
  },
  ssh,
};
process.exit((exits[tool] ?? (() => 99))());
