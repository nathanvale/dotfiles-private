// Runs the shipped public bin (bin/closeout-packet, which executes runtime/closeout-packet.js) as a real process.
// Build the plugin first; these controls prove the committed runtime, not the source module.
import { join, resolve } from "node:path";
import type { Fault } from "./faults.ts";

const PLUGIN_ROOT = resolve(import.meta.dir, "../../../..");
export const BIN = join(PLUGIN_ROOT, "bin", "closeout-packet");
const PRELOAD = join(import.meta.dir, "fault-preload.ts");

export function binEnv(fault?: Fault): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && name !== "BUN_OPTIONS" && name !== "CLOSEOUT_PACKET_TEST_FAULT") env[name] = value;
  if (fault !== undefined) {
    env.BUN_OPTIONS = `--preload ${PRELOAD}`;
    env.CLOSEOUT_PACKET_TEST_FAULT = JSON.stringify(fault);
  }
  return env;
}

export function runBin(args: string[], fault?: Fault): { exitCode: number; stderr: string; stdout: string } {
  const result = Bun.spawnSync([BIN, ...args], { env: binEnv(fault), stderr: "pipe", stdout: "pipe", stdin: "ignore" });
  return { exitCode: result.exitCode, stderr: result.stderr.toString(), stdout: result.stdout.toString() };
}
