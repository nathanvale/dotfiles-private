import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { z } from "zod";
import {
  AmbiguityRecordSchema,
  ArchiveMarker,
  AssociationRecordSchema,
  BlobRecordSchema,
  DecisionRecordSchema,
  ItemRecordSchema,
  ObservationRecordSchema,
  ReceiptMarker,
} from "./command-contract.ts";
import { readExport } from "./csv.ts";
import { DERIVED_REVISION, derivedFiles, pendingImages } from "./derived.ts";
import {
  acquireJournalLock,
  appendJournal,
  JournalLockHeld,
  type JournalRecord,
  pendingJournalIntent,
} from "./journal.ts";
import type {
  ArchiveState,
  AttachmentFile,
  DecisionRecord,
  ImportPlan,
  ParsedExport,
} from "./model.ts";
import {
  emptyState,
  foldRecords,
  type ImportSummary,
  type PlannedImport,
  planImport,
  planIsEmpty,
} from "./planner.ts";

const MARKER = "archive.json";
const RECORDS = {
  ambiguities: "records/ambiguities.jsonl",
  associations: "records/associations.jsonl",
  blobs: "records/blobs.jsonl",
  decisions: "records/decisions.jsonl",
  items: "records/items.jsonl",
  observations: "records/observations.jsonl",
} as const;
const EXPORT_PREFIX = /^(\d{4}-\d\d-\d\d \d\d \d\d \d\d) - /;

export class InvalidArchiveError extends Error {}
export class PreconditionError extends Error {}
/** An archive file already exists with bytes other than the plan's. */
export class ArchiveConflictError extends Error {}
/** Derived views could not be rebuilt; records are unchanged. */
export class DerivedWriteError extends Error {}
/** Raised after the journal intent: archive effects may be partial. */
export class EffectUncertainError extends Error {
  constructor(
    readonly effectId: string,
    detail: string,
  ) {
    super(detail);
  }
}

export const IMPORT_EFFECT = "effect.import";
export const DECISION_EFFECT = "effect.decision";

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function journalState(archive: string): string {
  return join(archive, "archive");
}

async function readJsonl<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line, index) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new InvalidArchiveError(`${path} line ${index + 1} is not JSON.`);
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        throw new InvalidArchiveError(`${path} line ${index + 1} is invalid.`);
      }
      return parsed.data;
    });
}

async function revisionOf(archive: string): Promise<string> {
  const hash = createHash("sha256");
  for (const path of Object.values(RECORDS)) {
    hash.update(path);
    hash.update(await readFile(join(archive, path)).catch(() => ""));
  }
  return hash.digest("hex");
}

export async function loadArchive(archive: string): Promise<ArchiveState> {
  const state = foldRecords(emptyState(), {
    ambiguities: await readJsonl(
      join(archive, RECORDS.ambiguities),
      AmbiguityRecordSchema,
    ),
    associations: await readJsonl(
      join(archive, RECORDS.associations),
      AssociationRecordSchema,
    ),
    blobs: await readJsonl(join(archive, RECORDS.blobs), BlobRecordSchema),
    decisions: await readJsonl(
      join(archive, RECORDS.decisions),
      DecisionRecordSchema,
    ),
    items: await readJsonl(join(archive, RECORDS.items), ItemRecordSchema),
    observations: await readJsonl(
      join(archive, RECORDS.observations),
      ObservationRecordSchema,
    ),
  });
  state.revision = await revisionOf(archive);
  return state;
}

/** Refuses a missing archive (when required) or a foreign non-empty folder. */
export async function checkArchive(
  archive: string,
  mustExist: boolean,
): Promise<void> {
  const entries = await readdir(archive).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (entries === null) {
    if (mustExist) throw new PreconditionError("The archive does not exist.");
    return;
  }
  const visible = entries.filter((entry) => !entry.startsWith("."));
  if (visible.length > 0 && !visible.includes(MARKER)) {
    throw new PreconditionError(
      "The archive folder is not empty and has no archive.json marker.",
    );
  }
  if (mustExist && !visible.includes(MARKER)) {
    throw new PreconditionError("The archive has no archive.json marker.");
  }
}

function inside(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !path.startsWith(sep));
}

async function hashFile(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

async function listFiles(root: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isFile()) paths.push(entry.name);
    if (!entry.isDirectory()) continue;
    for (const child of await readdir(join(root, entry.name), {
      withFileTypes: true,
    })) {
      if (child.isFile() && !child.name.startsWith(".")) {
        paths.push(join(entry.name, child.name));
      }
    }
  }
  return paths.sort();
}

export interface AttachmentScan {
  files: AttachmentFile[];
  totalFiles: number;
}

/** Files at depth one or two whose names carry `<timestamp> - <chat> - `. */
async function scanAttachments(
  root: string,
  chatSession: string,
  csvPath: string,
): Promise<AttachmentScan> {
  const paths = (await listFiles(root)).filter(
    (path) => resolve(root, path) !== csvPath,
  );
  const files: AttachmentFile[] = [];
  for (const relativePath of paths) {
    const name = basename(relativePath);
    const timestamp = EXPORT_PREFIX.exec(name)?.[1];
    const prefix = `${timestamp} - ${chatSession} - `;
    if (timestamp === undefined || !name.startsWith(prefix)) continue;
    const absolute = join(root, relativePath);
    files.push({
      exportedName: name.slice(prefix.length),
      relativePath,
      sha256: await hashFile(absolute),
      size: (await stat(absolute)).size,
      timestamp,
    });
  }
  return { files, totalFiles: paths.length };
}

async function readMarker(archive: string) {
  const text = await readFile(join(archive, MARKER), "utf8").catch(
    (error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    },
  );
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InvalidArchiveError(`${MARKER} is not JSON.`);
  }
  const parsed = ArchiveMarker.safeParse(value);
  if (!parsed.success) throw new InvalidArchiveError(`${MARKER} is invalid.`);
  return parsed.data;
}

/**
 * One archive holds one chat. Its identity is the export's set of Sender IDs
 * (Chat Session names differ between exports of the same chat).
 */
async function checkChatIdentity(
  archive: string,
  parsed: ParsedExport,
  state: ArchiveState,
): Promise<string[]> {
  const senderIds = [
    ...new Set(parsed.rows.map((row) => row.senderId).filter(Boolean)),
  ].sort();
  if (senderIds.length === 0) {
    throw new PreconditionError("The export has no Sender ID to identify its chat.");
  }
  const recorded = (await readMarker(archive))?.chatIdentity?.senderIds;
  if (recorded === undefined) {
    if (state.items.size === 0) return senderIds;
    throw new PreconditionError("The archive records no chat identity to compare.");
  }
  if (JSON.stringify(recorded) !== JSON.stringify(senderIds)) {
    throw new PreconditionError(
      "The export's Sender IDs differ from the archive's chat identity.",
    );
  }
  return senderIds;
}

export interface ImportSource {
  archive: string;
  attachments: string;
  csv: string;
}

export interface PreparedImport extends PlannedImport {
  bytes: Buffer;
  exportSha256: string;
  senderIds: string[];
  parsed: ParsedExport;
  scan: AttachmentScan;
}

export async function prepareImport(
  source: ImportSource,
  state: ArchiveState,
): Promise<PreparedImport> {
  if (inside(source.archive, source.attachments)) {
    throw new PreconditionError(
      "The archive must not live inside the attachments root.",
    );
  }
  const bytes = await readFile(source.csv).catch((error: unknown) => {
    if (isMissing(error)) throw new PreconditionError("The CSV does not exist.");
    throw error;
  });
  if (!(await stat(source.attachments).catch(() => null))?.isDirectory()) {
    throw new PreconditionError("The attachments root is not a directory.");
  }
  const exportSha256 = createHash("sha256").update(bytes).digest("hex");
  const parsed = readExport(bytes.toString("utf8"));
  const senderIds = await checkChatIdentity(source.archive, parsed, state);
  const scan = await scanAttachments(
    source.attachments,
    parsed.chatSession,
    source.csv,
  );
  const planned = planImport(state, parsed, exportSha256, scan.files);
  return { ...planned, bytes, exportSha256, parsed, scan, senderIds };
}

function stateDirectory(): string {
  if (process.env.IMAZING_ARCHIVE_STATE_DIR !== undefined) {
    return process.env.IMAZING_ARCHIVE_STATE_DIR;
  }
  const base =
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(base, "imazing-archive");
}

/** Durable effects an apply wrote: whole files and appended record spans. */
export interface EffectManifest {
  files: { path: string; sha256: string }[];
  records: RecordSpan[];
}

export interface RecordSpan {
  length: number;
  offset: number;
  path: string;
  sha256: string;
}

export interface Receipt {
  attachmentsRoot: { chatFiles: number; path: string; totalFiles: number };
  csv: { chatSession: string; path: string; sha256: string };
  effectId?: string;
  effects?: EffectManifest;
  mode: "apply" | "preview" | "unchanged";
  planDigest: string;
  receiptVersion: 1;
  recordedAt: string;
  runId: string;
  archive: string;
  summary: ImportSummary;
}

export function receiptFor(
  source: ImportSource,
  prepared: PreparedImport,
  mode: Receipt["mode"],
): Receipt {
  return {
    archive: source.archive,
    attachmentsRoot: {
      chatFiles: prepared.scan.files.length,
      path: source.attachments,
      totalFiles: prepared.scan.totalFiles,
    },
    csv: {
      chatSession: prepared.parsed.chatSession,
      path: source.csv,
      sha256: prepared.exportSha256,
    },
    mode,
    planDigest: prepared.digest,
    receiptVersion: 1,
    recordedAt: new Date().toISOString(),
    runId: randomUUID(),
    summary: prepared.summary,
  };
}

async function writePrivate(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

/** Writes the private runtime receipt and, for apply, the archive copy. */
export async function writeReceipt(receipt: Receipt): Promise<string> {
  const name = `${receipt.recordedAt.replaceAll(":", "-")}-${receipt.mode}-${receipt.runId}.json`;
  const text = `${JSON.stringify(receipt, null, 2)}\n`;
  const runtimePath = join(stateDirectory(), "receipts", name);
  await writePrivate(runtimePath, text);
  if (receipt.mode === "apply") {
    await writePrivate(join(receipt.archive, "imports", name), text);
  }
  return runtimePath;
}

function sha256Of(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** False when absent; refuses an existing file whose bytes differ. */
async function existingMatches(
  archive: string,
  path: string,
  sha256: string,
): Promise<boolean> {
  const target = join(archive, path);
  if ((await stat(target).catch(() => null)) === null) return false;
  if ((await hashFile(target)) === sha256) return true;
  throw new ArchiveConflictError(
    `The archive file ${path} already exists with bytes that do not match sha256 ${sha256}.`,
  );
}

function originalPath(source: ImportSource, prepared: PreparedImport): string {
  return join("originals", `${prepared.exportSha256}-${basename(source.csv)}`);
}

/** Hashes every existing target before the journal intent. */
async function checkExistingTargets(
  source: ImportSource,
  prepared: PreparedImport,
): Promise<void> {
  if (prepared.plan.copyOriginal) {
    const path = originalPath(source, prepared);
    await existingMatches(source.archive, path, prepared.exportSha256);
  }
  for (const blob of prepared.plan.blobs) {
    await existingMatches(source.archive, blob.path, blob.sha256);
  }
}

async function copyBlob(
  archive: string,
  attachments: string,
  blob: ImportPlan["blobs"][number],
): Promise<void> {
  if (await existingMatches(archive, blob.path, blob.sha256)) return;
  const target = join(archive, blob.path);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await copyFile(join(attachments, blob.sourcePath), temporary);
  if ((await hashFile(temporary)) !== blob.sha256) {
    await rm(temporary, { force: true });
    throw new Error(`Attachment bytes changed after preview: ${blob.sourcePath}`);
  }
  await rename(temporary, target);
}

function recordLines(records: unknown[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

/** Refuses a record file whose last line has no terminating newline. */
async function checkRecordTail(archive: string, path: string): Promise<void> {
  const file = Bun.file(join(archive, path));
  if (!(await file.exists()) || file.size === 0) return;
  if ((await file.slice(file.size - 1).text()) === "\n") return;
  throw new InvalidArchiveError(
    `${path} does not end in a newline; its last record is torn.`,
  );
}

/** Appends records and returns the byte span they occupy. */
async function appendRecords(
  archive: string,
  path: string,
  records: unknown[],
): Promise<RecordSpan[]> {
  if (records.length === 0) return [];
  await checkRecordTail(archive, path);
  const target = join(archive, path);
  await mkdir(dirname(target), { recursive: true });
  const text = recordLines(records);
  const offset = (await stat(target).catch(() => null))?.size ?? 0;
  await appendFile(target, text, "utf8");
  const length = Buffer.byteLength(text);
  return [{ length, offset, path, sha256: sha256Of(text) }];
}

async function regenerateDerived(
  archive: string,
  loaded?: ArchiveState,
): Promise<void> {
  const state = loaded ?? (await loadArchive(archive));
  for (const [path, text] of Object.entries(derivedFiles(state))) {
    await writePrivate(join(archive, path), text);
  }
}

/** Rebuilds derived views built from an older records revision. */
async function refreshDerived(archive: string, state: ArchiveState): Promise<void> {
  const built = await readFile(join(archive, DERIVED_REVISION), "utf8").catch(
    () => null,
  );
  if (built?.trim() === state.revision) return;
  try {
    await regenerateDerived(archive, state);
  } catch (error) {
    throw new DerivedWriteError(String(error));
  }
}

/** Writes the hashed bytes, re-hashes the copy, and refuses a mismatch. */
async function writeOriginal(
  source: ImportSource,
  prepared: PreparedImport,
): Promise<void> {
  const path = originalPath(source, prepared);
  if (await existingMatches(source.archive, path, prepared.exportSha256)) return;
  const target = join(source.archive, path);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, prepared.bytes, { flag: "wx" });
  if ((await hashFile(temporary)) !== prepared.exportSha256) {
    await rm(temporary, { force: true });
    throw new Error("The original CSV copy does not match its recorded sha256.");
  }
  await rename(temporary, target);
}

async function writeEffects(
  source: ImportSource,
  prepared: PreparedImport,
): Promise<EffectManifest> {
  const { archive } = source;
  const { plan } = prepared;
  const files: EffectManifest["files"] = [];
  if (plan.copyOriginal) {
    await writeOriginal(source, prepared);
    files.push({ path: originalPath(source, prepared), sha256: prepared.exportSha256 });
  }
  for (const blob of plan.blobs) {
    await copyBlob(archive, source.attachments, blob);
    files.push({ path: blob.path, sha256: blob.sha256 });
  }
  const records = [
    ...(await appendRecords(archive, RECORDS.items, plan.items)),
    ...(await appendRecords(archive, RECORDS.observations, plan.observations)),
    ...(await appendRecords(archive, RECORDS.associations, plan.associations)),
    ...(await appendRecords(archive, RECORDS.blobs, plan.blobs)),
    ...(await appendRecords(archive, RECORDS.ambiguities, plan.ambiguities)),
  ];
  await regenerateDerived(archive);
  return { files, records };
}

export type ApplyOutcome =
  | { status: "applied"; prepared: PreparedImport; receiptPath: string }
  | { status: "blocked"; effectId: string }
  | { status: "busy" }
  | { status: "residue" }
  | { status: "stale"; digest: string }
  | { status: "unchanged"; prepared: PreparedImport; receiptPath: string };

function lockToken(): string {
  return process.env.NODE_ENV === "test" &&
    process.env.IMAZING_ARCHIVE_TEST_LOCK_OWNER_TOKEN !== undefined
    ? process.env.IMAZING_ARCHIVE_TEST_LOCK_OWNER_TOKEN
    : randomUUID();
}

async function testPauseAfterIntent(): Promise<void> {
  if (process.env.NODE_ENV !== "test") return;
  const readyPath = process.env.IMAZING_ARCHIVE_TEST_AFTER_INTENT_READY_PATH;
  if (readyPath !== undefined) await writeFile(readyPath, "intent-written\n");
  const milliseconds = Number(
    process.env.IMAZING_ARCHIVE_TEST_AFTER_INTENT_DELAY_MS ?? "0",
  );
  if (Number.isSafeInteger(milliseconds) && milliseconds > 0) {
    await Bun.sleep(milliseconds);
  }
}

type Locked<T> = T | { status: "blocked"; effectId: string } | { status: "busy" } | { status: "residue" };

/** Runs one archive writer under the journal lock after recovery checks. */
async function withWriter<T>(
  archive: string,
  runId: string,
  work: () => Promise<T>,
): Promise<Locked<T>> {
  const barrier =
    process.env.NODE_ENV === "test"
      ? (process.env.IMAZING_ARCHIVE_TEST_LOCK_BARRIER_PATH ?? null)
      : null;
  await mkdir(archive, { recursive: true });
  let release: () => void;
  try {
    release = acquireJournalLock(journalState(archive), runId, barrier);
  } catch (error) {
    if (!(error instanceof JournalLockHeld)) throw error;
    return { status: error.ownerAlive ? "busy" : "residue" };
  }
  try {
    const pending = await inspectRecovery(archive);
    if (pending.state === "unknown") {
      return { effectId: pending.effectId, status: "blocked" };
    }
    return await work();
  } finally {
    release();
  }
}

export async function applyImport(
  source: ImportSource,
  expectedDigest: string,
): Promise<ApplyOutcome> {
  const runId = lockToken();
  return withWriter(source.archive, runId, async (): Promise<ApplyOutcome> => {
    const state = await loadArchive(source.archive);
    const prepared = await prepareImport(source, state);
    if (prepared.digest !== expectedDigest) {
      return { digest: prepared.digest, status: "stale" };
    }
    const receipt = { ...receiptFor(source, prepared, "apply"), runId };
    if (planIsEmpty(prepared.plan)) {
      await refreshDerived(source.archive, state);
      receipt.mode = "unchanged";
      return { prepared, receiptPath: await writeReceipt(receipt), status: "unchanged" };
    }
    await checkExistingTargets(source, prepared);
    for (const path of Object.values(RECORDS)) {
      await checkRecordTail(source.archive, path);
    }
    const record = { effectId: IMPORT_EFFECT, expectedValueHash: prepared.digest, journalVersion: 1 as const, runId };
    if ((await readMarker(source.archive))?.chatIdentity === undefined) {
      const marker = { archiveVersion: 1, chatIdentity: { senderIds: prepared.senderIds } };
      await writePrivate(join(source.archive, MARKER), `${JSON.stringify(marker)}\n`);
    }
    await appendJournal(journalState(source.archive), { ...record, phase: "intent" });
    let receiptPath: string;
    try {
      await testPauseAfterIntent();
      receipt.effects = await writeEffects(source, prepared);
      receipt.effectId = IMPORT_EFFECT;
      receiptPath = await writeReceipt(receipt);
    } catch (error) {
      throw new EffectUncertainError(IMPORT_EFFECT, String(error));
    }
    await appendJournal(journalState(source.archive), { ...record, phase: "completed" });
    return { prepared, receiptPath, status: "applied" };
  });
}

export type DecideOutcome =
  | { status: "blocked"; effectId: string }
  | { status: "busy" }
  | { status: "recorded" }
  | { status: "residue" }
  | { status: "unknown-item" };

/** Journals the decision so an interrupted write is provable by its line. */
export async function recordDecision(
  archive: string,
  decision: DecisionRecord,
): Promise<DecideOutcome> {
  const runId = lockToken();
  return withWriter(archive, runId, async (): Promise<DecideOutcome> => {
    const state = await loadArchive(archive);
    if (!state.items.has(decision.itemKey)) return { status: "unknown-item" };
    await checkRecordTail(archive, RECORDS.decisions);
    const record = {
      effectId: DECISION_EFFECT,
      expectedValueHash: sha256Of(recordLines([decision])),
      journalVersion: 1 as const,
      runId,
    };
    await appendJournal(journalState(archive), { ...record, phase: "intent" });
    try {
      await appendRecords(archive, RECORDS.decisions, [decision]);
      await regenerateDerived(archive);
    } catch (error) {
      throw new EffectUncertainError(DECISION_EFFECT, String(error));
    }
    await appendJournal(journalState(archive), { ...record, phase: "completed" });
    return { status: "recorded" };
  });
}

type ReceiptProof = z.infer<typeof ReceiptMarker>;

async function archiveReceipts(archive: string): Promise<ReceiptProof[]> {
  const names = await readdir(join(archive, "imports")).catch(() => []);
  const receipts: ReceiptProof[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const text = await readFile(join(archive, "imports", name), "utf8");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      continue;
    }
    const parsed = ReceiptMarker.safeParse(value);
    if (parsed.success) receipts.push(parsed.data);
  }
  return receipts;
}

async function spanPresent(archive: string, span: RecordSpan): Promise<boolean> {
  const target = join(archive, span.path);
  if (!inside(target, archive)) return false;
  const bytes = await readFile(target).catch(() => null);
  const chunk = bytes?.subarray(span.offset, span.offset + span.length);
  return chunk?.length === span.length && sha256Of(chunk) === span.sha256;
}

async function filePresent(
  archive: string,
  file: EffectManifest["files"][number],
): Promise<boolean> {
  const target = join(archive, file.path);
  if (!inside(target, archive)) return false;
  return (await hashFile(target).catch(() => null)) === file.sha256;
}

async function effectsPresent(
  archive: string,
  effects: EffectManifest,
): Promise<boolean> {
  for (const span of effects.records) {
    if (!(await spanPresent(archive, span))) return false;
  }
  for (const file of effects.files) {
    if (!(await filePresent(archive, file))) return false;
  }
  return true;
}

/** A receipt for this run and effect whose durable effects all read back. */
async function importProven(
  archive: string,
  pending: JournalRecord,
): Promise<boolean> {
  for (const receipt of await archiveReceipts(archive)) {
    if (
      receipt.runId === pending.runId &&
      receipt.effectId === pending.effectId &&
      receipt.planDigest === pending.expectedValueHash &&
      (await effectsPresent(archive, receipt.effects))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The exact newline-terminated decision line the intent hashed is in the
 * decision records; an unterminated tail never proves the write.
 */
async function decisionProven(
  archive: string,
  pending: JournalRecord,
): Promise<boolean> {
  const text = await readFile(join(archive, RECORDS.decisions), "utf8").catch(
    () => "",
  );
  let start = 0;
  for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
    if (sha256Of(text.slice(start, end + 1)) === pending.expectedValueHash) {
      return true;
    }
    start = end + 1;
  }
  return false;
}

export type RecoveryObservation =
  | { effectId: null; state: "none" }
  | { effectId: string; state: "completed" | "unknown" };

/** Read-only: a pending intent is complete only when its effects read back. */
export async function inspectRecovery(
  archive: string,
): Promise<RecoveryObservation> {
  const pending = await pendingJournalIntent(journalState(archive));
  if (pending === null) return { effectId: null, state: "none" };
  const proven =
    pending.effectId === DECISION_EFFECT
      ? await decisionProven(archive, pending)
      : pending.effectId === IMPORT_EFFECT && (await importProven(archive, pending));
  return { effectId: pending.effectId, state: proven ? "completed" : "unknown" };
}

export async function archiveStatus(archive: string) {
  const state = await loadArchive(archive);
  const associations = { ambiguous: 0, missing: 0, resolved: 0 };
  for (const record of state.associations.values()) {
    associations[record.status] += 1;
  }
  return {
    ambiguousItems: state.ambiguities.size,
    associations,
    blobs: state.blobs.size,
    decisions: state.decisions.size,
    exports: state.originals.size,
    items: state.items.size,
    pendingImages: pendingImages(state).length,
    recovery: (await inspectRecovery(archive)).state,
  };
}
