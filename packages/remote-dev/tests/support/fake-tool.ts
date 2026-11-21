// One fake for every controlled external boundary (ssh, code, fzf, opener).
// It records its argv and selected environment facts, then replays the
// scenario named by FAKE_SCENARIO. It never touches Docker, SSH, or editors.
import { appendFileSync, existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import type { LinkSample, Scenario } from "./harness.ts";

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

const doctor = scenario.doctor ?? {};
const HOME_CLIENT: LinkSample = { client: "192.168.1.104", mibPerSecond: 100 };
const MASTER = { etime: "06:07", pid: 70549 };

/** Replay one SSH sample: sshd's view of the client, then the bytes at the scenario's rate. */
function sample(link: LinkSample, command: string): number {
  if (link.responds === false) return 255;
  writeSync(1, `Last login: Sat Nov 21 10:00:00 2026\nremote-dev-sample ${link.client} 50888 192.168.1.100 22\n`);
  const requested = Number(/head -c (\d+)/.exec(command)?.[1] ?? "0");
  const total = Math.min(requested, link.transfer?.bytes ?? requested);
  const chunk = 256 * 1024;
  for (let sent = 0; sent < total; sent += chunk) {
    const size = Math.min(chunk, total - sent);
    writeSync(1, Buffer.alloc(size));
    Bun.sleepSync((size / (link.mibPerSecond * 1024 * 1024)) * 1000);
  }
  return link.transfer?.exitCode ?? 0;
}

function sshLocal(): number | null {
  if (argv.includes("-G")) {
    process.stdout.write(`user server\nhostname ${doctor.hostname ?? "192.168.1.100"}\nport 22\n`);
    return 0;
  }
  if (!argv.includes("-O")) return null;
  const master = doctor.master === undefined ? MASTER : doctor.master;
  if (master === null) {
    process.stderr.write("Control socket connect(/tmp/cm): No such file or directory\r\n");
    return 255;
  }
  process.stderr.write(`Master running (pid=${master.pid})\r\n`);
  return 0;
}

/** Doctor's remote probes: a timed sample, or the container's VS Code server listing. */
function doctorProbe(command: string): number | null {
  if (command.includes("SSH_CONNECTION")) {
    return sample((argv.includes("ControlPath=none") ? doctor.direct : doctor.shared) ?? HOME_CLIENT, command);
  }
  if (!command.includes(".vscode-server")) return null;
  process.stdout.write(doctor.servers === undefined ? "" : `${doctor.servers.join("\n")}\n`);
  return 0;
}

function ssh(): number {
  const settings = scenario.ssh ?? {};
  const local = sshLocal();
  if (local !== null) return local;
  if (settings.exit !== undefined) return settings.exit;
  if (settings.unreachableAliases?.some((alias) => argv.includes(alias))) return 255;
  const command = argv.at(-1) ?? "";
  const probed = doctorProbe(command);
  if (probed !== null) return probed;
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

function route(): number {
  const destination = argv.at(-1);
  const settings = doctor.route ?? {};
  if (destination === "default") {
    process.stdout.write(`   route to: default\n  interface: ${settings.default ?? "en0"}\n`);
    return 0;
  }
  if (settings.host === null) {
    process.stdout.write(`   route to: ${destination}\ndestination: default\n  interface: ${settings.default ?? "en0"}\n`);
    return 0;
  }
  process.stdout.write(`   route to: ${destination}\ndestination: ${destination}\n  interface: ${settings.host ?? "en0"}\n`);
  return 0;
}

function code(): number {
  if (argv[0] === "--version") {
    process.stdout.write(`1.147.0\n${doctor.commit ?? "8a14f0cc1b08d531eb83255ea3764ae22aa932b5"}\narm64\n`);
    return 0;
  }
  return scenario.code?.exit ?? 0;
}

const exits: Record<string, () => number> = {
  code,
  fzf,
  opener: () => scenario.opener?.exit ?? 0,
  pilotRuntime: () => {
    process.stdout.write(scenario.pilotRuntime?.output ?? JSON.stringify({ status: "ready", started: [], attempted: false }));
    return scenario.pilotRuntime?.exit ?? 0;
  },
  ps: () => {
    process.stdout.write(`${(doctor.master ?? MASTER).etime}\n`);
    return 0;
  },
  route,
  ssh,
};
process.exit((exits[tool] ?? (() => 99))());
