import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const roots: string[] = [];

export type Run = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  envelope: {
    message: string;
    result: {
      causeCode: string;
      commandIdentity: string;
      outcome: string;
      exitCode: number;
      data: unknown;
      retryable: boolean;
      retryDelayMilliseconds?: number;
    };
  };
};

/** Runs the public entry point; set BESTIE_CHECK_ENTRY to exercise a bundle. */
export function run(...args: string[]): Run {
  const entry = process.env.BESTIE_CHECK_ENTRY ?? join(ROOT, "src/cli.ts");
  const result = Bun.spawnSync([process.execPath, "run", entry, ...args, "--json"], {
    cwd: ROOT,
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  const stdout = result.stdout.toString();
  return {
    envelope: JSON.parse(stdout),
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout,
  };
}

export function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "bestie-chapter-check-"));
  roots.push(dir);
  return dir;
}

export function cleanup(): void {
  for (const dir of roots.splice(0)) rmSync(dir, { force: true, recursive: true });
}

export function put(dir: string, name: string, content: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function git(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stderr: "pipe", stdout: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

/** A one-commit repository standing in for the source vault. */
export function sourceRepository(dir: string): { repository: string; commit: string } {
  const repository = join(dir, "vault");
  Bun.spawnSync(["mkdir", "-p", repository]);
  git(repository, "init", "-q");
  writeFileSync(join(repository, "note.md"), "# Note\n");
  git(repository, "add", "note.md");
  git(repository, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "seed");
  return { commit: git(repository, "rev-parse", "HEAD"), repository };
}
