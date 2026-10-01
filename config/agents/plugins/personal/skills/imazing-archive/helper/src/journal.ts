import {
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

const JournalRecordSchema = z.strictObject({
  effectId: z.string().min(1),
  expectedValueHash: z.string().regex(/^[0-9a-f]{64}$/),
  journalVersion: z.literal(1),
  phase: z.enum(["intent", "completed"]),
  runId: z.string().min(1),
});

export type JournalRecord = z.infer<typeof JournalRecordSchema>;

export class JournalLockHeld extends Error {
  constructor(readonly ownerAlive: boolean) {
    super("journal lock is already held");
  }
}

/** A live owner PID means an active writer; otherwise the lock is residue. */
function lockOwnerAlive(path: string): boolean {
  try {
    const owner: unknown = JSON.parse(readFileSync(path, "utf8"));
    const pid =
      typeof owner === "object" && owner !== null && "pid" in owner
        ? owner.pid
        : null;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
      return false;
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function journalPath(statePath: string): string {
  return `${statePath}.journal.jsonl`;
}

function lockPath(statePath: string): string {
  return `${statePath}.journal.lock`;
}

function testBarrier(
  directory: string,
  ownerToken: string,
  phase: "ready" | "claimed",
  release: string,
): void {
  mkdirSync(directory, { mode: 0o700, recursive: true });
  writeFileSync(join(directory, `${ownerToken}.${phase}`), `${process.pid}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  const deadline = performance.now() + 10_000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(join(directory, release))) {
    if (performance.now() >= deadline) {
      throw new Error("journal contention test barrier timed out");
    }
    Atomics.wait(wait, 0, 0, 10);
  }
}

export function acquireJournalLock(
  statePath: string,
  ownerToken: string,
  barrierDirectory: string | null,
): () => void {
  if (barrierDirectory !== null) {
    testBarrier(barrierDirectory, ownerToken, "ready", "start");
  }
  const path = lockPath(statePath);
  mkdirSync(dirname(path), { recursive: true });
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      throw new JournalLockHeld(lockOwnerAlive(path));
    }
    throw error;
  }
  const owner = `${JSON.stringify({
    lockVersion: 1,
    ownerToken,
    pid: process.pid,
  })}\n`;
  const inode = fstatSync(descriptor);
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, owner);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const release = (): void => {
    try {
      const current = lstatSync(path);
      if (
        current.isFile() &&
        current.dev === inode.dev &&
        current.ino === inode.ino &&
        readFileSync(path, "utf8") === owner
      ) {
        unlinkSync(path);
      }
    } catch {
      // A missing, replaced, or unreadable lock is not ours to remove.
    }
  };
  try {
    if (barrierDirectory !== null) {
      testBarrier(barrierDirectory, ownerToken, "claimed", "finish");
    }
  } catch (error) {
    release();
    throw error;
  }
  return release;
}

export async function appendJournal(
  statePath: string,
  record: JournalRecord,
): Promise<void> {
  const parsed = JournalRecordSchema.parse(record);
  const path = journalPath(statePath);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(parsed)}\n`, { encoding: "utf8" });
}

async function readJournal(statePath: string): Promise<JournalRecord[]> {
  let text: string;
  try {
    text = await readFile(journalPath(statePath), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JournalRecordSchema.parse(JSON.parse(line)));
}

export async function pendingJournalIntent(
  statePath: string,
): Promise<JournalRecord | null> {
  const records = await readJournal(statePath);
  const completed = new Set(
    records
      .filter((record) => record.phase === "completed")
      .map((record) => `${record.runId}:${record.effectId}`),
  );
  return (
    records.findLast(
      (record) =>
        record.phase === "intent" &&
        !completed.has(`${record.runId}:${record.effectId}`),
    ) ?? null
  );
}
