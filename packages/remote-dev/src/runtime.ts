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

const HEADER_LIMIT = 512;

/**
 * Run one program whose stdout is a header line followed by a byte stream, and
 * time the stream from the end of the header. The bytes are counted, never kept.
 */
export async function measureTransfer(
  program: string,
  args: string[],
  options: { environment: Record<string, string>; timeoutMs: number },
): Promise<Transfer> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([program, ...args], { env: options.environment, stderr: "ignore", stdin: "ignore", stdout: "pipe" });
  } catch {
    return { kind: "missing" };
  }
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
  let header = "";
  let headerDone = false;
  let bytes = 0;
  let started = performance.now();
  for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
    let body = chunk;
    if (!headerDone) {
      const newline = chunk.indexOf(0x0a);
      const end = newline === -1 ? chunk.length : newline;
      header = (header + new TextDecoder().decode(chunk.subarray(0, end))).slice(0, HEADER_LIMIT);
      if (newline === -1) continue;
      headerDone = true;
      started = performance.now();
      body = chunk.subarray(newline + 1);
    }
    bytes += body.length;
  }
  const exitCode = await child.exited;
  clearTimeout(timer);
  return { bytes, exitCode, header, kind: "measured", milliseconds: performance.now() - started };
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
