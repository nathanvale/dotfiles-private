import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Config, type RemoteDevConfig } from "./command-contract.ts";

export function configPath(environment: Record<string, string | undefined>): string {
  const explicit = environment.REMOTE_DEV_CONFIG;
  if (explicit !== undefined && explicit !== "") return explicit;
  const base = environment.XDG_CONFIG_HOME || join(homeOf(environment), ".config");
  return join(base, "remote-dev", "targets.json");
}

export function homeOf(environment: Record<string, string | undefined>): string {
  return environment.HOME || homedir();
}

export type ConfigLoad =
  | { kind: "invalid" }
  | { kind: "missing" }
  | { config: RemoteDevConfig; kind: "ok" };

export async function loadConfig(path: string): Promise<ConfigLoad> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { kind: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return { kind: "invalid" };
  }
  const result = Config.safeParse(parsed);
  return result.success ? { config: result.data, kind: "ok" } : { kind: "invalid" };
}

export type ProgramResult =
  | { kind: "missing" }
  | { exitCode: number; kind: "exited"; stderr: string; stdout: string }
  | { kind: "timeout" };

const OUTPUT_LIMIT = 4 * 1024 * 1024;

/**
 * Run one local program without a shell, with stdin closed so it can never
 * wait on keyboard input. Output is captured, bounded, and never inherited.
 */
export async function runProgram(
  program: string,
  args: string[],
  options: { captureStderr?: boolean; environment?: Record<string, string>; timeoutMs: number },
): Promise<ProgramResult> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([program, ...args], {
      env: options.environment ?? (process.env as Record<string, string>),
      stderr: options.captureStderr === true ? "pipe" : "ignore",
      stdin: "ignore",
      stdout: "pipe",
    });
  } catch {
    return { kind: "missing" };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeoutMs);
  const [stdout, stderr] = await Promise.all([
    readBounded(child.stdout as ReadableStream<Uint8Array>),
    options.captureStderr === true ? readBounded(child.stderr as ReadableStream<Uint8Array>) : "",
  ]);
  const exitCode = await child.exited;
  clearTimeout(timer);
  if (timedOut) return { kind: "timeout" };
  return { exitCode, kind: "exited", stderr, stdout };
}

export type Transfer =
  | { kind: "missing" }
  | { bytes: number; exitCode: number; header: string; kind: "measured"; milliseconds: number };

const HEADER_LIMIT = 4096;

/**
 * Run one program whose stdout is any preamble, a line starting with `marker`,
 * then a byte stream. Time the stream from the end of the marker line and count
 * its bytes without keeping them. `header` is the marker line's remainder.
 */
export async function measureTransfer(
  program: string,
  args: string[],
  options: { environment: Record<string, string>; marker: string; timeoutMs: number },
): Promise<Transfer> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([program, ...args], { env: options.environment, stderr: "ignore", stdin: "ignore", stdout: "pipe" });
  } catch {
    return { kind: "missing" };
  }
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
  const decoder = new TextDecoder("latin1");
  let preamble = "";
  let header: string | null = null;
  let bytes = 0;
  let started = performance.now();
  for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
    if (header !== null) {
      bytes += chunk.length;
      continue;
    }
    const text = preamble + decoder.decode(chunk);
    const at = text.startsWith(options.marker) ? 0 : text.indexOf(`\n${options.marker}`);
    const start = at <= 0 ? at : at + 1;
    const end = start === -1 ? -1 : text.indexOf("\n", start);
    if (end === -1) {
      preamble = text.slice(-HEADER_LIMIT);
      continue;
    }
    header = text.slice(start + options.marker.length, end);
    started = performance.now();
    bytes = text.length - end - 1;
  }
  const exitCode = await child.exited;
  clearTimeout(timer);
  return { bytes, exitCode, header: header ?? "", kind: "measured", milliseconds: performance.now() - started };
}

async function readBounded(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    if (text.length < OUTPUT_LIMIT) text += decoder.decode(chunk, { stream: true });
  }
  return text.slice(0, OUTPUT_LIMIT);
}

export async function directoriesExist(paths: string[]): Promise<boolean> {
  for (const path of paths) {
    const info = await stat(path).catch(() => null);
    if (info === null || !info.isDirectory()) return false;
  }
  return true;
}

export async function executableExists(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  if (info === null || !info.isFile()) return false;
  return access(path, constants.X_OK).then(() => true, () => false);
}

export type PickResult =
  | { kind: "cancelled" }
  | { kind: "failed" }
  | { key: string; kind: "picked"; line: string }
  | { kind: "missing" };

/**
 * Run fzf for one interactive pick. fzf draws on the terminal; rows arrive on
 * stdin and the pick returns on stdout. Escape (130) and no match (1) cancel.
 */
export async function pick(
  fzf: string,
  rows: string[],
  args: string[],
): Promise<PickResult> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([fzf, ...args], {
      stderr: "inherit",
      stdin: new Blob([`${rows.join("\n")}\n`]),
      stdout: "pipe",
    });
  } catch {
    return { kind: "missing" };
  }
  const stdout = await readBounded(child.stdout as ReadableStream<Uint8Array>);
  const exitCode = await child.exited;
  if (exitCode === 1 || exitCode === 130) return { kind: "cancelled" };
  if (exitCode !== 0) return { kind: "failed" };
  const output = stdout.replace(/\n$/, "").split("\n");
  if (!args.includes("--expect")) return { key: "", kind: "picked", line: output[0] ?? "" };
  return { key: output[0] ?? "", kind: "picked", line: output[1] ?? "" };
}
