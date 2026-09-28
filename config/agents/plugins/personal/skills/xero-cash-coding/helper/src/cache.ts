import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { CacheDocument, Observation, PreviewDocument } from "./command-contract.ts";
import type { CacheDocument as Cache, Observation as Observed, PreviewDocument as Preview } from "./command-contract.ts";

export class CacheProblem extends Error {
  constructor(readonly kind: "malformed" | "unsafe" | "locked" | "busy" | "pending" | "stale" | "missing" | "invalid", message: string, readonly effectId?: string) { super(message); }
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function key(value: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(value)) throw new CacheProblem("invalid", "Verified IDs must contain only letters, digits, and hyphens.");
  // A case-insensitive filesystem must still keep case-distinct Xero IDs apart.
  return `id-${Buffer.from(value, "utf8").toString("hex")}`;
}
function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME)
    ? env.XDG_STATE_HOME : join(env.HOME ?? "", ".local", "state");
  if (!isAbsolute(base)) throw new CacheProblem("unsafe", "An absolute home or state root is required.");
  return join(base, "xero-cash-coding");
}
export function accountPath(organisationId: string, accountId: string): string {
  return join(stateRoot(), key(organisationId), key(accountId), "history.json");
}
function pathParts(path: string): string[] {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts: string[] = [];
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    parts.push(current);
  }
  return parts;
}
function ordinaryPart(part: string, target: string, terminal: "file" | "directory"): boolean {
  const stat = lstatSync(part);
  if (stat.isSymbolicLink()) return false;
  if (part !== target) return stat.isDirectory();
  return terminal === "file" ? stat.isFile() : stat.isDirectory();
}
function assertOrdinary(path: string, terminal: "file" | "directory" = "file"): void {
  for (const part of pathParts(path)) {
    try {
      if (!ordinaryPart(part, path, terminal)) {
        throw new CacheProblem("unsafe", "Cache path contains a symlink or unexpected file.");
      }
    } catch (error) {
      if (error instanceof CacheProblem) throw error;
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }
}
function privateDirectory(path: string): void {
  assertOrdinary(path, "directory");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const root = stateRoot();
  let current = path;
  while (current.startsWith(root)) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CacheProblem("unsafe", "Cache directory is unsafe.");
    if ((stat.mode & 0o077) !== 0) throw new CacheProblem("unsafe", "Cache directory is not owner-only; chmod it to 0700.");
    if (current === root) break;
    current = dirname(current);
  }
}
export async function readCache(path: string): Promise<{ cache: Cache | null; hash: string | null }> {
  assertOrdinary(path);
  let bytes: string;
  try { bytes = await readFile(path, "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { cache: null, hash: null };
    throw error;
  }
  const mode = (await lstat(path)).mode & 0o777;
  if (mode !== 0o600) throw new CacheProblem("unsafe", "Cache file is not owner-only; chmod it to 0600.");
  let parsed: unknown;
  try { parsed = JSON.parse(bytes); }
  catch { throw new CacheProblem("malformed", "Malformed cache preserved. Repair it from verified observations or move it aside manually."); }
  const result = CacheDocument.safeParse(parsed);
  if (!result.success) throw new CacheProblem("malformed", "Incompatible cache preserved. Repair it from verified observations or move it aside manually.");
  return { cache: result.data, hash: digest(bytes) };
}
function merge(current: Cache | null, observed: Observed): Cache {
  if (current && (current.organisation.id !== observed.organisation.id || current.bankAccount.id !== observed.bankAccount.id)) {
    throw new CacheProblem("invalid", "Observed identities do not match this cache partition.");
  }
  const transactions = { ...(current?.transactions ?? {}) };
  for (const item of observed.transactions) transactions[item.id] = item;
  const coverage = [...(current?.coverage ?? [])];
  for (const item of observed.coverage) {
    const index = coverage.findIndex((old) => old.from === item.from && old.to === item.to && old.query === item.query);
    if (index < 0) coverage.push(item); else coverage[index] = item;
  }
  return CacheDocument.parse({
    schemaVersion: 1, organisation: observed.organisation, bankAccount: observed.bankAccount,
    updatedAt: new Date().toISOString(), coverage, transactions,
  });
}
function exclusiveFile(path: string, contents: string): void {
  assertOrdinary(path);
  const fd = openSync(path, "wx", 0o600);
  try { fchmodSync(fd, 0o600); writeFileSync(fd, contents); fsyncSync(fd); }
  finally { closeSync(fd); }
}
function replacePrivate(path: string, contents: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  exclusiveFile(temporary, contents);
  try { assertOrdinary(path); renameSync(temporary, path); }
  catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
}
function previewPath(path: string): string { return `${path}.preview.json`; }
function journalPath(path: string): string { return `${path}.journal.jsonl`; }
function lockPath(path: string): string { return `${path}.lock`; }
function writerActive(path: string): boolean {
  if (!existsSync(lockPath(path))) return false;
  assertOrdinary(lockPath(path));
  try {
    const owner: unknown = JSON.parse(readFileSync(lockPath(path), "utf8"));
    if (typeof owner !== "object" || owner === null || !("pid" in owner) || !Number.isSafeInteger(owner.pid) || typeof owner.pid !== "number" || owner.pid <= 0) return false;
    try { process.kill(owner.pid, 0); return true; }
    catch (error) { return error instanceof Error && "code" in error && error.code === "EPERM"; }
  } catch { return false; }
}
let activeClaim: { release: () => void; intentStarted: boolean } | null = null;
let signalRequested = false;
export function stopForSignal(): void {
  signalRequested = true;
  if (activeClaim && !activeClaim.intentStarted) activeClaim.release();
}
function journal(path: string, value: unknown): void {
  assertOrdinary(journalPath(path));
  const fd = openSync(journalPath(path), "a", 0o600);
  try { fchmodSync(fd, 0o600); writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
}
interface JournalRow { phase: "intent" | "completed"; id: string; hash: string; baseHash?: string | null }
function journalRows(path: string): JournalRow[] {
  assertOrdinary(journalPath(path));
  let bytes: string;
  try { bytes = readFileSync(journalPath(path), "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  if ((lstatSync(journalPath(path)).mode & 0o777) !== 0o600) throw new CacheProblem("unsafe", "Journal is not owner-only; chmod it to 0600.");
  try {
    return bytes.trim().split("\n").filter(Boolean).map((line) => {
      const row: unknown = JSON.parse(line);
      if (typeof row !== "object" || row === null || !("phase" in row) || !("id" in row) || !("hash" in row) ||
        (row.phase !== "intent" && row.phase !== "completed") || typeof row.id !== "string" || !/^[a-f0-9]{64}$/.test(String(row.hash))) {
        throw new Error("bad journal row");
      }
      if (row.phase === "intent" && "baseHash" in row && row.baseHash !== null &&
        (typeof row.baseHash !== "string" || !/^[a-f0-9]{64}$/.test(row.baseHash))) throw new Error("bad base hash");
      return { phase: row.phase, id: row.id, hash: String(row.hash),
        ...("baseHash" in row ? { baseHash: row.baseHash as string | null } : {}) };
    });
  } catch { throw new CacheProblem("malformed", "Malformed journal preserved; inspect it before another apply."); }
}
function pending(path: string): { id: string; hash: string; baseHash?: string | null } | null {
  let intent: { id: string; hash: string; baseHash?: string | null } | null = null;
  for (const row of journalRows(path)) {
    if (row.phase === "intent" && intent === null) intent = { id: row.id, hash: row.hash,
      ...(row.baseHash !== undefined ? { baseHash: row.baseHash } : {}) };
    else if (row.phase === "completed" && intent?.id === row.id && intent.hash === row.hash) intent = null;
    else throw new CacheProblem("malformed", "Malformed journal sequence preserved; inspect it before another apply.");
  }
  return intent;
}
function completedEffect(path: string, effectId: string): boolean {
  return journalRows(path).some((row) => row.phase === "completed" && row.id === effectId);
}
export async function prepare(observation: unknown): Promise<{ id: string; path: string; count: number; addedIds: string[]; replacedIds: string[] }> {
  const parsed = Observation.safeParse(observation);
  if (!parsed.success) throw new CacheProblem("invalid", "Observation JSON does not match schema version 1.");
  const path = accountPath(parsed.data.organisation.id, parsed.data.bankAccount.id);
  privateDirectory(dirname(path));
  if (writerActive(path)) throw new CacheProblem("busy", "Another active writer holds this account; retry preview after 250 ms.");
  if (existsSync(lockPath(path))) throw new CacheProblem("locked", "Account lock residue blocks writes. Run recover for the exact manual repair path.");
  if (pending(path)) throw new CacheProblem("pending", "Run recover before preparing another update.");
  const current = await readCache(path);
  const addedIds = parsed.data.transactions.filter((item) => !current.cache?.transactions[item.id]).map((item) => item.id);
  const replacedIds = parsed.data.transactions.filter((item) => !!current.cache?.transactions[item.id]).map((item) => item.id);
  const proposed = merge(current.cache, parsed.data);
  const id = randomUUID();
  const proposedBytes = `${JSON.stringify(proposed)}\n`;
  const preview: Preview = {
    previewId: id, baseHash: current.hash, expectedHash: digest(proposedBytes),
    proposed, consumed: false,
  };
  replacePrivate(previewPath(path), `${JSON.stringify(preview)}\n`);
  return { id, path, count: parsed.data.transactions.length, addedIds, replacedIds };
}
function readPreview(path: string): Preview {
  assertOrdinary(previewPath(path));
  try {
    if ((lstatSync(previewPath(path)).mode & 0o777) !== 0o600) throw new CacheProblem("unsafe", "Preview is not owner-only; chmod it to 0600.");
  } catch (error) {
    if (error instanceof CacheProblem) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new CacheProblem("missing", "Preview unavailable; create a fresh preview.");
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(previewPath(path), "utf8")); }
  catch { throw new CacheProblem("missing", "Preview unavailable; create a fresh preview."); }
  const result = PreviewDocument.safeParse(parsed);
  if (!result.success) throw new CacheProblem("malformed", "Malformed preview preserved; inspect it and create a fresh preview after repair.");
  return result.data;
}
function claimLock(path: string): () => void {
  const lock = lockPath(path);
  let fd: number;
  let owned: { dev: number; ino: number };
  try {
    fd = openSync(lock, "wx", 0o600);
    fchmodSync(fd, 0o600);
    owned = fstatSync(fd);
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid })}\n`);
    fsyncSync(fd);
    closeSync(fd);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      const active = writerActive(path);
      throw new CacheProblem(active ? "busy" : "locked", active
        ? "Another active writer holds this account; retry after 250 ms."
        : "Account lock residue blocks writes. Run recover for the exact manual repair path.");
    }
    throw error;
  }
  const claim = { intentStarted: false, release: () => {
    try {
      const current = lstatSync(lock);
      if (current.dev === owned.dev && current.ino === owned.ino) unlinkSync(lock);
    } catch { /* Preserve missing or replaced locks. */ }
    if (activeClaim === claim) activeClaim = null;
  } };
  activeClaim = claim;
  return claim.release;
}
async function publishPreview(path: string, preview: Preview, effectId: string): Promise<void> {
  const bytes = `${JSON.stringify(preview.proposed)}\n`;
  if (process.env.NODE_ENV === "test" && process.env.XERO_HISTORY_TEST_BEFORE_INTENT) {
    writeFileSync(process.env.XERO_HISTORY_TEST_BEFORE_INTENT, "ready", { mode: 0o600 });
    await Bun.sleep(2000);
  }
  if (signalRequested) throw new CacheProblem("busy", "Apply stopped before writing an intent; create a fresh preview.");
  if (activeClaim) activeClaim.intentStarted = true;
  journal(path, { phase: "intent", id: effectId, hash: preview.expectedHash, baseHash: preview.baseHash });
  if (process.env.NODE_ENV === "test" && process.env.XERO_HISTORY_TEST_AFTER_INTENT) {
    writeFileSync(process.env.XERO_HISTORY_TEST_AFTER_INTENT, "ready", { mode: 0o600 });
    await Bun.sleep(2000);
  }
  replacePrivate(path, bytes);
  if (process.env.NODE_ENV === "test" && process.env.XERO_HISTORY_TEST_AFTER_RENAME) {
    writeFileSync(process.env.XERO_HISTORY_TEST_AFTER_RENAME, "ready", { mode: 0o600 });
    await Bun.sleep(2000);
  }
  const after = await readCache(path);
  if (after.hash !== preview.expectedHash) throw new CacheProblem("pending", "Cache read-back differed; run recover.");
  journal(path, { phase: "completed", id: effectId, hash: preview.expectedHash });
  if (process.env.NODE_ENV === "test" && process.env.XERO_HISTORY_TEST_AFTER_COMPLETION === "interrupt") {
    throw new Error("synthetic interruption after completion");
  }
  replacePrivate(previewPath(path), `${JSON.stringify({ ...preview, consumed: true })}\n`);
}
export async function apply(organisationId: string, accountId: string, previewId: string): Promise<string> {
  const path = accountPath(organisationId, accountId);
  privateDirectory(dirname(path));
  const release = claimLock(path);
  let attemptedEffect: string | null = null;
  try {
    if (pending(path)) throw new CacheProblem("pending", "Run recover before another apply.");
    const preview = readPreview(path);
    if (preview.consumed || preview.previewId !== previewId || completedEffect(path, `cache:${previewId}`)) throw new CacheProblem("stale", "Preview ID is missing, stale, or consumed.");
    const current = await readCache(path);
    if (current.hash !== preview.baseHash) throw new CacheProblem("stale", "Cache changed since preview; create a fresh preview.");
    if (digest(`${JSON.stringify(preview.proposed)}\n`) !== preview.expectedHash) throw new CacheProblem("malformed", "Preview hash mismatch; preserve it for inspection.");
    const effectId = `cache:${previewId}`;
    attemptedEffect = effectId;
    await publishPreview(path, preview, effectId);
    return effectId;
  } catch (error) {
    if (attemptedEffect !== null) throw new CacheProblem("pending", `Apply ${attemptedEffect} may have changed the cache. Run recover and inspect it before another apply.`, attemptedEffect);
    throw error;
  } finally {
    release();
  }
}
export interface Recovery {
  state: "none" | "unchanged" | "completed" | "unknown" | "lock-residue" | "writer-active";
  effectId: string | null;
  pending: boolean;
  repair: string | null;
}
async function inspectPending(path: string, intent: NonNullable<ReturnType<typeof pending>>): Promise<Recovery> {
  const inspected = `Inspect ${journalPath(path)}, ${previewPath(path)}, and ${path}.`;
  const resolved = `After verifying the effect and writer PID, archive ${journalPath(path)} and ${previewPath(path)} by moving them aside; remove ${lockPath(path)} only if its PID is dead. Then create a fresh preview.`;
  try {
    const current = await readCache(path);
    if (current.hash === intent.hash) return { state: "completed", effectId: intent.id, pending: true,
      repair: `The cache matches the intended hash. ${inspected} ${resolved}` };
    if (intent.baseHash !== undefined && current.hash === intent.baseHash) return { state: "unchanged", effectId: intent.id, pending: true,
      repair: `The cache matches the pre-apply hash. ${inspected} ${resolved}` };
  } catch { /* An unreadable cache leaves the effect uncertain. */ }
  return { state: "unknown", effectId: intent.id, pending: true,
    repair: `The cache does not prove the pre-apply or intended state. ${inspected} Preserve all files and resolve the effect manually before removing any lock or journal.` };
}
function inspectWithoutPending(path: string, lockResidue: boolean): Recovery {
  if (lockResidue) return { state: "lock-residue", effectId: null, pending: false,
    repair: `Verify the writer PID is dead, then remove only ${lockPath(path)} after inspecting ${journalPath(path)} and ${path}. Run recover again before writing.` };
  if (!existsSync(previewPath(path))) return { state: "none", effectId: null, pending: false, repair: null };
  const preview = readPreview(path);
  const effectId = `cache:${preview.previewId}`;
  if (!preview.consumed && completedEffect(path, effectId)) return { state: "completed", effectId, pending: false,
    repair: "This preview was applied. Create a fresh preview for another update; never retry its ID." };
  return { state: "none", effectId: null, pending: false, repair: null };
}
export async function recover(organisationId: string, accountId: string): Promise<Recovery> {
  const path = accountPath(organisationId, accountId);
  const intent = pending(path);
  const hasLock = existsSync(lockPath(path));
  if (hasLock && writerActive(path)) return { state: "writer-active", effectId: intent?.id ?? null,
    pending: intent !== null, repair: "An active writer holds this account. Wait for it to finish, then run recover again before writing." };
  return intent ? inspectPending(path, intent) : inspectWithoutPending(path, hasLock);
}
export interface LookupContext {
  direction?: "in" | "out";
  currency?: string;
  amountMinor?: number;
}
function contextScore(item: Cache["transactions"][string], context: LookupContext): number {
  let score = 0;
  if (context.direction === item.direction) score += 4;
  if (context.currency === item.currency) score += 4;
  if (context.amountMinor === item.amountMinor) score += 3;
  return score;
}
export function select(cache: Cache | null, query: string, context: LookupContext = {}): Array<Cache["transactions"][string]> {
  if (!cache) return [];
  const needle = query.trim().toLocaleLowerCase().replace(/\s+/g, " ");
  return Object.values(cache.transactions).filter((item) => `${item.payee ?? ""} ${item.description ?? ""}`.toLocaleLowerCase().replace(/\s+/g, " ").includes(needle))
    .sort((a, b) => contextScore(b, context) - contextScore(a, context) || b.date.localeCompare(a.date));
}
