import type { RemoteDevConfig } from "./command-contract.ts";
import { resultFor, STATE_REASON } from "./engine.ts";
import type { InventoryRow, OperationResult } from "./model.ts";
import {
  type Environment,
  inventory,
  openBoard,
  openTarget,
  readConfig,
  readLogs,
  startTarget,
  toolPath,
} from "./operations.ts";
import { homeOf, pick } from "./runtime.ts";

const COMMAND = "remote-dev.choose";
const ROW_GUIDE =
  "Type to filter · ↑/↓ move · Enter choose · Esc cancel · Ctrl-A known/all containers";
const ACTION_GUIDE = "↑/↓ move · Enter run · Esc cancel (nothing is launched)";
const LOG_LINES = 200;

function rowLine(row: InventoryRow, index: number): string {
  const name = row.target ?? "-";
  const note = row.eligible ? "" : `  (${row.reason ?? "not eligible"})`;
  return [index, row.host, name, row.role, row.state, `${row.container}${note}`].join("\t");
}

function cancelled(): OperationResult {
  return resultFor(COMMAND, "cancelled", {
    data: { cancelled: true },
  });
}

function fzfArgs(prompt: string, header: string, expectToggle: boolean): string[] {
  return [
    "--prompt", prompt,
    "--header", header,
    "--delimiter", "\t",
    "--with-nth", "2..",
    "--no-multi",
    "--layout", "reverse",
    "--height", "60%",
    "--tiebreak", "index",
    ...(expectToggle ? ["--expect", "ctrl-a"] : []),
  ];
}

type Picked = { kind: "result"; result: OperationResult } | { kind: "row"; row: InventoryRow };
type ViewPick = Picked | { kind: "toggle" };

function emptyInventory(all: boolean): Picked {
  return {
    kind: "result",
    result: resultFor(COMMAND, "inspected", {
      data: { cancelled: false, rows: 0 },
      message: all
        ? "No containers were found on the admitted hosts. Nothing was launched."
        : "No development targets are configured. Run remote-dev list --all to inspect containers. Nothing was launched.",
    }),
  };
}

/** Discover one view and let the person pick a row, toggle the view, or cancel. */
async function pickFromView(config: RemoteDevConfig, all: boolean, environment: Environment): Promise<ViewPick> {
  const found = await inventory(config, all, environment);
  if (!found.ok) return { kind: "result", result: resultFor(COMMAND, found.reason) };
  const rows = found.value.data.rows;
  if (rows.length === 0) return emptyInventory(all);
  const view = all ? "all containers" : "known development targets";
  const fzf = toolPath(config, "fzf", homeOf(environment));
  const picked = await pick(fzf, rows.map(rowLine), fzfArgs(`remote-dev (${view})> `, ROW_GUIDE, true));
  if (picked.kind === "missing" || picked.kind === "failed") {
    return { kind: "result", result: resultFor(COMMAND, "tool-unavailable") };
  }
  if (picked.kind === "cancelled") return { kind: "result", result: cancelled() };
  if (picked.key === "ctrl-a") return { kind: "toggle" };
  const row = rows[Number(picked.line.split("\t")[0])];
  return row === undefined ? { kind: "result", result: cancelled() } : { kind: "row", row };
}

async function pickRow(config: RemoteDevConfig, environment: Environment): Promise<Picked> {
  let all = false;
  for (let toggles = 0; toggles < 32; toggles += 1) {
    const picked = await pickFromView(config, all, environment);
    if (picked.kind !== "toggle") return picked;
    all = !all;
  }
  return { kind: "result", result: cancelled() };
}

function refusalFor(row: InventoryRow): OperationResult {
  if (row.target === null) {
    return resultFor(COMMAND, "target-unknown", {
      message: `${row.container} is unclassified: inspect only. Nothing was launched.`,
    });
  }
  const cause = row.state === "running" ? "target-unknown" : STATE_REASON[row.state];
  return resultFor(COMMAND, cause);
}

async function runAction(
  action: string,
  config: RemoteDevConfig,
  target: string,
  environment: Environment,
): Promise<OperationResult> {
  if (action === "open") return openTarget(COMMAND, config, target, environment);
  if (action === "start") return startTarget(COMMAND, config, target, environment);
  if (action === "logs") return readLogs(COMMAND, config, target, LOG_LINES, environment);
  return openBoard(COMMAND, config, target, environment);
}

/** Interactive chooser. Every dispatch reuses the same rechecking handlers as the explicit commands. */
export async function choose(environment: Environment): Promise<OperationResult> {
  const config = await readConfig(environment);
  if (!config.ok) return resultFor(COMMAND, config.reason);
  const picked = await pickRow(config.value, environment);
  if (picked.kind === "result") return picked.result;
  const { row } = picked;
  if (row.target === null || !row.actions.some((action) => action.available)) return refusalFor(row);
  const available = row.actions.filter((action) => action.available);
  const unavailable = row.actions
    .filter((action) => !action.available)
    .map((action) => `${action.label}: ${action.reason ?? "unavailable"}`);
  const header = [ACTION_GUIDE, ...unavailable.map((line) => `Not available: ${line}`)].join("\n");
  const fzf = toolPath(config.value, "fzf", homeOf(environment));
  const chosen = await pick(
    fzf,
    available.map((action) => `${action.id}\t${action.label}`),
    fzfArgs(`${row.target}> `, header, false),
  );
  if (chosen.kind === "missing" || chosen.kind === "failed") {
    return resultFor(COMMAND, "tool-unavailable");
  }
  if (chosen.kind === "cancelled") return cancelled();
  const action = chosen.line.split("\t")[0] ?? "";
  if (!available.some((candidate) => candidate.id === action)) return cancelled();
  return runAction(action, config.value, row.target, environment);
}
