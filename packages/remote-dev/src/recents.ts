import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { ConfiguredTarget } from "./command-contract.ts";
import type { InventoryRow } from "./model.ts";
import { configPath, homeOf } from "./runtime.ts";

const History = z.strictObject({ version: z.literal(1), targets: z.array(z.string().max(1024)).max(50) });

function historyPath(environment: Record<string, string | undefined>): string {
  const scope = createHash("sha256").update(resolve(configPath(environment))).digest("hex");
  const state = environment.XDG_STATE_HOME || join(homeOf(environment), ".local/state");
  return join(state, "remote-dev", `recents-${scope}.json`);
}

async function readHistory(path: string): Promise<string[]> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 65536) return [];
    const parsed = History.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data.targets : [];
  } catch {
    return [];
  }
}

/** Advisory ranking only: history never supplies targets, launch settings or authority. */
export async function recentRows(
  rows: InventoryRow[],
  environment: Record<string, string | undefined>,
): Promise<InventoryRow[]> {
  const history = await readHistory(historyPath(environment));
  const rank = new Map(history.map((key, index) => [key, index]));
  const position = (row: InventoryRow) => row.target === null ? history.length : rank.get(`${row.host}/${row.target}/${row.containerId}`) ?? history.length;
  return [...rows].sort((a, b) => position(a) - position(b));
}

/** Remember a dispatched editor request, not a proven connection. Never replay a launch. */
export async function rememberLaunch(
  target: ConfiguredTarget,
  environment: Record<string, string | undefined>,
): Promise<void> {
  const path = historyPath(environment);
  const key = `${target.host}/${target.id}/${target.containerId}`;
  const previous = await readHistory(path);
  const targets = [key, ...previous.filter((entry) => entry !== key)].slice(0, 50);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
    await writeFile(temporary, `${JSON.stringify({ version: 1, targets })}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch {
    // History is optional convenience metadata; failure cannot undo or repeat an editor request.
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
