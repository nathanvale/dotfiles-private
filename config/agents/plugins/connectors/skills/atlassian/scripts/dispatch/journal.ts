// Private Atlassian write journal. Previews bind an apply to exact input and
// revision; receipts record durable intent before any dispatch and a durable
// send mark before any request leaves; one object-scoped lock guards the
// critical section; unresolved intents block every write operation on the
// same object across processes. Only identifiers, digests, statuses,
// timestamps, and holder pids are stored.
//
// Durability guarantee: process-crash durability (fsync, rename, directory
// fsync where supported). Power-loss durability is best effort; no
// F_FULLFSYNC is requested.
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TENANT_PATTERN } from "../atlassian-provider-common.ts";
import { OPERATION_SPECS, type OperationId, type ProviderName } from "./contract.ts";

export type WriteOperation = Extract<OperationId, "issue.create" | "issue.update" | "issue.comment" | "page.create" | "page.update" | "page.comment">;
export type EffectKind = "jira-issue" | "jira-comment" | "confluence-content" | "confluence-comment";
export interface Effect {
	kind: EffectKind;
	id: string;
}
// Stable observations from the preview read. They are deliberately limited to
// provider identifiers and a non-timestamp revision, never write content or
// credentials. A later read-back may complete only with an effect outside this
// baseline, or an update at a different stable revision.
export interface WriteBaseline {
	effectIds: string[];
	commentIds: string[];
	revision: string | null;
}
// Read-back absence proves nothing about a request that may have left the
// process, so "unchanged" on that basis is accepted only while the receipt is
// still unsent. A monotonic revision that did not move proves no effect
// whatever the send state.
export type UnchangedBasis = "readback-absent" | "revision-unchanged";
export type Evidence = { proof: "completed"; effects: Effect[] } | { proof: "unchanged"; basis: UnchangedBasis } | { proof: "unknown" };
export type PreviewStatus = "open" | "consumed";
export type ReceiptStatus = "intent" | "completed" | "unchanged" | "unknown";
// Written ahead of the request: "unsent" until the dispatcher calls sending(),
// "possible" from then on, whether or not the request actually left.
export type SendState = "unsent" | "possible";

export interface Preview {
	previewId: string;
	operation: WriteOperation;
	provider: ProviderName;
	objectIdentity: string;
	inputDigest: string;
	// Digest of the exact provider arguments the preview was shaped into, so an
	// apply can send only what was previewed.
	argsDigest: string;
	revisionDigest: string | null;
	baseline: WriteBaseline;
	baselineDigest: string;
	instructionDigest: string | null;
	createdAt: number;
	expiresAt: number;
	status: PreviewStatus;
}

export interface Receipt {
	runId: string;
	previewId: string;
	operation: WriteOperation;
	provider: ProviderName;
	objectIdentity: string;
	inputDigest: string;
	argsDigest: string;
	revisionDigest: string | null;
	baseline: WriteBaseline;
	baselineDigest: string;
	instructionDigest: string | null;
	status: ReceiptStatus;
	send: SendState;
	// Present only on an unchanged receipt: what proved the absence of effect.
	basis?: UnchangedBasis;
	effects: Effect[];
	holder: { pid: number };
	createdAt: number;
	updatedAt: number;
}

export type CrashPoint = "before-intent" | "after-intent";

export interface JournalOptions {
	stateRoot?: string;
	env?: Record<string, string | undefined>;
	now?: () => number;
	previewTtlMs?: number;
	// Test-only seams: exit the process at a point inside the critical section,
	// or run a hook just before an object lock is released.
	crashAt?: CrashPoint;
	hooks?: { beforeRelease?: (lockFile: string) => void };
}

export interface PreviewRequest {
	operation: WriteOperation;
	provider: ProviderName;
	canonicalInput: unknown;
	providerArgs: unknown;
	revision: string | null;
	baseline?: WriteBaseline;
	spaceInstructions?: false | undefined;
}

export interface ApplyRequest {
	previewId: string;
	canonicalInput: unknown;
	providerArgs: unknown;
	revision: string | null;
	baseline?: WriteBaseline;
	spaceInstructions?: false | undefined;
}

export type Dispatch = (intent: Receipt, sending: () => void, boundArgs: Record<string, unknown>) => Promise<Evidence>;

export interface Journal {
	recordPreview(request: PreviewRequest): Preview;
	// The dispatcher must call sending() before the request can leave the
	// process; it is durable and idempotent. A receipt that never reached that
	// mark can later be resolved unchanged; one that did needs read-back
	// evidence of the effect, or stays unresolved. The journal hands the
	// dispatcher the provider arguments it verified against the preview, so
	// the outbound request is the receipt-bound object and not a caller's copy.
	apply(request: ApplyRequest, dispatch: Dispatch): Promise<Receipt>;
	resolve(runId: string, evidence: Evidence): Receipt;
	openReceipts(): Receipt[];
	receipt(runId: string): Receipt;
	// Operator recovery only: never called automatically. A stale meta-lock has
	// no programmatic recovery at all; see withMeta.
	unlock(objectIdentity: string): void;
}

export class JournalError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.code = code;
	}
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const EFFECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const STABLE_REVISION = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const EFFECT_KINDS: ReadonlySet<string> = new Set<EffectKind>(["jira-issue", "jira-comment", "confluence-content", "confluence-comment"]);
const PREVIEW_STATUSES: ReadonlySet<string> = new Set<PreviewStatus>(["open", "consumed"]);
const RECEIPT_STATUSES: ReadonlySet<string> = new Set<ReceiptStatus>(["intent", "completed", "unchanged", "unknown"]);
const SEND_STATES: ReadonlySet<string> = new Set<SendState>(["unsent", "possible"]);
const UNCHANGED_BASES: ReadonlySet<string> = new Set<UnchangedBasis>(["readback-absent", "revision-unchanged"]);
const SPACE_ID = /^[1-9][0-9]{0,19}$/;
const DEFAULT_PREVIEW_TTL_MS = 15 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isRecord(value)) {
		const entries = Object.entries(value)
			.filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function sha256(text: string): string {
	return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

export function canonicalDigest(input: unknown): string {
	return sha256(canonical(input));
}

const normalise = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

function identifier(value: unknown, what: string): string {
	if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new JournalError("input-invalid", `${what} must be an identifier`);
	return value;
}

function subjectDigest(value: unknown, what: string): string {
	if (typeof value !== "string" || normalise(value).length === 0) throw new JournalError("input-invalid", `${what} is required`);
	return sha256(normalise(value)).slice(0, 16);
}

function discriminator(value: unknown, what: string): string {
	if (typeof value !== "string") throw new JournalError("input-invalid", `${what} is required`);
	const text = normalise(value).replace(/[^a-z0-9]+/g, "-");
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(text)) throw new JournalError("input-invalid", `${what} is invalid`);
	return text;
}

function isWriteOperation(operation: string): operation is WriteOperation {
	const spec = (OPERATION_SPECS as Record<string, { kind: string } | undefined>)[operation];
	return spec !== undefined && spec.kind === "write";
}

// The object a write acts on, derived only from the canonical input so a
// caller cannot pair one payload with another identity. Creates have no id
// yet: container, normalised discriminator, and a digest of the normalised
// subject stand in. Two different objects with one subject in one container
// collide and wait for resolution; that is the accepted trade-off against
// duplicating an object after an unknown outcome.
export function objectIdentity(operation: WriteOperation, canonicalInput: unknown): string {
	if (!isWriteOperation(operation)) throw new JournalError("operation-invalid", "only write operations are journaled");
	if (!isRecord(canonicalInput)) throw new JournalError("input-invalid", "input must be an object");
	switch (operation) {
		case "issue.update":
		case "issue.comment":
			return `issue:${identifier(canonicalInput.issueKey, "issueKey")}`;
		case "page.update":
		case "page.comment":
			return `page:${identifier(canonicalInput.pageId, "pageId")}`;
		case "issue.create":
			return `project:${identifier(canonicalInput.projectKey, "projectKey")}:create:${discriminator(canonicalInput.issueType, "issueType")}:${subjectDigest(canonicalInput.summary, "summary")}`;
		case "page.create": {
			// One canonical container: the resolved numeric space id. A key is
			// an alias of the same space and would open a second write path
			// around a pending receipt, so key-only input is refused here.
			const space = isRecord(canonicalInput.space) ? canonicalInput.space : {};
			if (typeof space.id !== "string" || !SPACE_ID.test(space.id)) throw new JournalError("input-invalid", "space.id must be the resolved numeric space id; resolve a space key before previewing");
			const parent = canonicalInput.parentId === undefined ? "root" : identifier(canonicalInput.parentId, "parentId");
			return `space:${space.id}:create:${parent}:${subjectDigest(canonicalInput.title, "title")}`;
		}
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// Every directory is inspected with lstat: symlinks, foreign owners, and wrong
// modes fail closed and are never repaired here, because chmod follows links.
function privateDirectory(directory: string): void {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const metadata = lstatSync(directory);
	if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== os.userInfo().uid || (metadata.mode & 0o777) !== 0o700) {
		throw new JournalError("state-invalid", "journal directory must be an owned 0700 directory");
	}
}

function regularFileOrAbsent(file: string): boolean {
	try {
		const metadata = lstatSync(file);
		if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== os.userInfo().uid) throw new JournalError("state-invalid", "journal file must be an owned regular file");
		return true;
	} catch (error) {
		if (error instanceof JournalError) throw error;
		return false;
	}
}

function fsyncDirectory(directory: string): void {
	try {
		const fd = openSync(directory, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch {
		// Directory fsync is not supported everywhere; the file itself is synced.
	}
}

function writeDurable(directory: string, name: string, value: unknown): void {
	privateDirectory(directory);
	const file = path.join(directory, name);
	regularFileOrAbsent(file);
	const temp = path.join(directory, `.${crypto.randomUUID()}.tmp`);
	const fd = openSync(temp, "wx", 0o600);
	try {
		writeSync(fd, `${JSON.stringify(value)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temp, file);
	fsyncDirectory(directory);
}

function readRecord(file: string): Record<string, unknown> | null {
	if (!regularFileOrAbsent(file)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		throw new JournalError("state-corrupt", "journal entry is not readable; inspect the state directory before writing");
	}
	if (!isRecord(parsed)) throw new JournalError("state-corrupt", "journal entry is malformed");
	return parsed;
}

// Persisted records are validated field by field so a tampered or truncated
// file can never be acted on. The object identity must have the shape its
// operation derives, digests must be hex, timestamps finite and ordered, the
// holder pid a positive integer, and effects consistent with the status.
const HEX64 = /^[0-9a-f]{64}$/;
const IDENTITY_SHAPES: Record<WriteOperation, RegExp> = {
	"issue.update": /^issue:[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/,
	"issue.comment": /^issue:[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/,
	"page.update": /^page:[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/,
	"page.comment": /^page:[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/,
	"issue.create": /^project:[A-Za-z0-9][A-Za-z0-9_.-]{0,127}:create:[a-z0-9][a-z0-9-]{0,63}:[0-9a-f]{16}$/,
	"page.create": /^space:[1-9][0-9]{0,19}:create:(?:root|[A-Za-z0-9][A-Za-z0-9_.-]{0,127}):[0-9a-f]{16}$/,
};
const PROVIDERS: ReadonlySet<string> = new Set(["official", "community"]);

// A function declaration, so TypeScript narrows after each guard call.
function corrupt(what: string): never {
	throw new JournalError("state-corrupt", `${what} is malformed; inspect the state directory before writing`);
}
const finiteTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
const digestOrNull = (value: unknown): value is string | null => value === null || (typeof value === "string" && HEX64.test(value));

const EMPTY_BASELINE: WriteBaseline = { effectIds: [], commentIds: [], revision: null };

function copiedBaseline(value: WriteBaseline | undefined): WriteBaseline {
	const baseline = value ?? EMPTY_BASELINE;
	return { effectIds: [...baseline.effectIds].sort(), commentIds: [...baseline.commentIds].sort(), revision: baseline.revision };
}

function validStableIds(ids: unknown): ids is string[] {
	return Array.isArray(ids) && ids.length <= 100 && ids.every((id) => typeof id === "string" && EFFECT_ID.test(id)) && new Set(ids).size === ids.length && JSON.stringify(ids) === JSON.stringify([...ids].sort());
}

function validBaseline(value: unknown): value is WriteBaseline {
	return isRecord(value) && validStableIds(value.effectIds) && validStableIds(value.commentIds) && (value.revision === null || (typeof value.revision === "string" && STABLE_REVISION.test(value.revision)));
}

const validDigests = (record: Record<string, unknown>): boolean =>
	typeof record.inputDigest === "string" && HEX64.test(record.inputDigest) && typeof record.argsDigest === "string" && HEX64.test(record.argsDigest) && digestOrNull(record.revisionDigest) && typeof record.baselineDigest === "string" && HEX64.test(record.baselineDigest) && digestOrNull(record.instructionDigest);

function validIdentity(operation: unknown, identity: unknown): operation is WriteOperation {
	return typeof operation === "string" && isWriteOperation(operation) && typeof identity === "string" && IDENTITY_SHAPES[operation].test(identity);
}

function asPreview(record: Record<string, unknown>): Preview {
	const status = record.status;
	if (typeof record.previewId !== "string" || !IDENTIFIER.test(record.previewId)) corrupt("preview id");
	if (!validIdentity(record.operation, record.objectIdentity)) corrupt("preview operation or identity");
	if (typeof record.provider !== "string" || !PROVIDERS.has(record.provider)) corrupt("preview provider");
	if (!validDigests(record)) corrupt("preview digest");
	if (!validBaseline(record.baseline) || canonicalDigest(record.baseline) !== record.baselineDigest) corrupt("preview baseline");
	if (!finiteTime(record.createdAt) || !finiteTime(record.expiresAt) || record.expiresAt <= record.createdAt) corrupt("preview timestamps");
	if (typeof status !== "string" || !PREVIEW_STATUSES.has(status)) corrupt("preview status");
	return record as unknown as Preview;
}

function asReceipt(record: Record<string, unknown>): Receipt {
	const status = record.status;
	if (typeof record.runId !== "string" || !IDENTIFIER.test(record.runId) || typeof record.previewId !== "string" || !IDENTIFIER.test(record.previewId)) corrupt("receipt id");
	if (!validIdentity(record.operation, record.objectIdentity)) corrupt("receipt operation or identity");
	if (typeof record.provider !== "string" || !PROVIDERS.has(record.provider)) corrupt("receipt provider");
	if (!validDigests(record)) corrupt("receipt digest");
	if (!validBaseline(record.baseline) || canonicalDigest(record.baseline) !== record.baselineDigest) corrupt("receipt baseline");
	if (typeof status !== "string" || !RECEIPT_STATUSES.has(status)) corrupt("receipt status");
	validateReceiptState(status, record.send, record.basis, record.effects, record.holder);
	if (!finiteTime(record.createdAt) || !finiteTime(record.updatedAt) || record.updatedAt < record.createdAt) corrupt("receipt timestamps");
	return record as unknown as Receipt;
}

// Effects exist only on a completed receipt; an unchanged receipt names its
// basis, and only a revision basis may follow a possible send; the holder pid
// is a positive integer.
function validateReceiptState(status: string, send: unknown, basis: unknown, effects: unknown, holder: unknown): void {
	if (typeof send !== "string" || !SEND_STATES.has(send)) corrupt("receipt send state");
	if (status === "unchanged" ? typeof basis !== "string" || !UNCHANGED_BASES.has(basis) : basis !== undefined) corrupt("receipt unchanged basis");
	if (status === "unchanged" && send !== "unsent" && basis !== "revision-unchanged") corrupt("receipt unchanged after a possible send");
	if (!validEffects(effects)) corrupt("receipt effects");
	if (status === "completed" ? effects.length === 0 : effects.length !== 0) corrupt("receipt effects for its status");
	if (!isRecord(holder) || !Number.isInteger(holder.pid) || (holder.pid as number) <= 0) corrupt("receipt holder");
}

function validEffects(effects: unknown): effects is Effect[] {
	return Array.isArray(effects) && effects.every((effect) => isRecord(effect) && typeof effect.kind === "string" && EFFECT_KINDS.has(effect.kind) && typeof effect.id === "string" && EFFECT_ID.test(effect.id));
}

function validEvidence(evidence: unknown): evidence is Evidence {
	if (!isRecord(evidence)) return false;
	if (evidence.proof === "unknown") return true;
	if (evidence.proof === "unchanged") return typeof evidence.basis === "string" && UNCHANGED_BASES.has(evidence.basis);
	// A completion must name at least one effect; the persisted shape refuses
	// a completed receipt without effects, so it is refused here first.
	if (evidence.proof === "completed") return validEffects(evidence.effects) && evidence.effects.length > 0;
	return false;
}

const lockName = (identity: string) => `${identity.replace(/[^A-Za-z0-9_-]/g, "_")}.lock`;
const META_LOCK = ".meta";

interface LockRecord {
	pid: number;
	lockId: string;
	at: number;
}

function readLock(file: string): LockRecord | null {
	const record = readRecord(file);
	if (!record) return null;
	if (!Number.isInteger(record.pid) || typeof record.lockId !== "string" || !finiteTime(record.at)) corrupt("lock entry");
	return record as unknown as LockRecord;
}

class FileJournal implements Journal {
	private readonly previews: string;
	private readonly receipts: string;
	private readonly locks: string;

	constructor(
		root: string,
		private readonly now: () => number,
		private readonly previewTtlMs: number,
		private readonly crashAt: CrashPoint | undefined,
		private readonly hooks: JournalOptions["hooks"],
	) {
		this.previews = path.join(root, "previews");
		this.receipts = path.join(root, "receipts");
		this.locks = path.join(root, "locks");
		for (const directory of [root, this.previews, this.receipts, this.locks]) privateDirectory(directory);
	}

	// Writes a lock file atomically with this process's pid and a fresh lockId.
	private claimLock(file: string, code: string, message: string): string {
		regularFileOrAbsent(file);
		const lockId = crypto.randomUUID();
		let fd: number;
		try {
			fd = openSync(file, "wx", 0o600);
		} catch {
			throw new JournalError(code, message);
		}
		try {
			writeSync(fd, `${JSON.stringify({ pid: process.pid, lockId, at: this.now() })}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		return lockId;
	}

	// Unlinks a lock only when the file still carries the lockId we hold.
	private releaseLock(file: string, lockId: string): void {
		this.hooks?.beforeRelease?.(file);
		const current = readLock(file);
		if (!current || current.lockId !== lockId) throw new JournalError("lock-tampered", "the lock file no longer carries this process's lock id");
		rmSync(file, { force: true });
	}

	// The meta-lock is held briefly around every object-lock transition so an
	// unlock can never race an acquire or release. Nothing sits above it, so no
	// check-then-remove on it can be made race-free: a recoverer that read a
	// dead holder could unlink a lock a fresh writer claimed in between. A stale
	// meta-lock is therefore removed only by an operator, by hand, once no
	// connectors process is running.
	private withMeta<T>(fn: () => T): T {
		const file = path.join(this.locks, META_LOCK);
		const lockId = this.claimLock(file, "meta-locked", `the journal meta-lock is held; if no connectors process is running, remove ${file} by hand`);
		try {
			return fn();
		} finally {
			this.releaseLock(file, lockId);
		}
	}

	recordPreview(request: PreviewRequest): Preview {
		const createdAt = this.now();
		const preview: Preview = {
			previewId: crypto.randomUUID(),
			operation: request.operation,
			provider: request.provider,
			objectIdentity: objectIdentity(request.operation, request.canonicalInput),
			inputDigest: canonicalDigest(request.canonicalInput),
			argsDigest: canonicalDigest(request.providerArgs),
			revisionDigest: request.revision === null ? null : sha256(request.revision),
			baseline: copiedBaseline(request.baseline),
			baselineDigest: canonicalDigest(copiedBaseline(request.baseline)),
			instructionDigest: request.spaceInstructions === false ? canonicalDigest(false) : null,
			createdAt,
			expiresAt: createdAt + this.previewTtlMs,
			status: "open",
		};
		writeDurable(this.previews, `${preview.previewId}.json`, preview);
		return preview;
	}

	private readPreview(previewId: string): Preview {
		if (!IDENTIFIER.test(previewId)) throw new JournalError("preview-unknown", "no such preview");
		const record = readRecord(path.join(this.previews, `${previewId}.json`));
		if (!record) throw new JournalError("preview-unknown", "no such preview");
		return asPreview(record);
	}

	private readReceipt(runId: string): Receipt {
		if (!IDENTIFIER.test(runId)) throw new JournalError("receipt-unknown", "no such receipt");
		const record = readRecord(path.join(this.receipts, `${runId}.json`));
		if (!record) throw new JournalError("receipt-unknown", "no such receipt");
		return this.checkedReceipt(record);
	}

	// An unresolved receipt gates every write on its object, so a well-formed
	// but foreign identity on it would let a same-object duplicate through.
	// Each unresolved receipt is bound to the preview it was recorded from: a
	// preview must outlive its unresolved receipt. Resolved receipts gate
	// nothing and are validated by shape only.
	private checkedReceipt(record: Record<string, unknown>): Receipt {
		const receipt = asReceipt(record);
		if (receipt.status !== "intent" && receipt.status !== "unknown") return receipt;
		const previewRecord = readRecord(path.join(this.previews, `${receipt.previewId}.json`));
		if (!previewRecord) corrupt("receipt preview");
		const preview = asPreview(previewRecord);
		const bound =
			preview.operation === receipt.operation &&
			preview.provider === receipt.provider &&
			preview.objectIdentity === receipt.objectIdentity &&
			preview.inputDigest === receipt.inputDigest &&
				preview.argsDigest === receipt.argsDigest &&
				preview.revisionDigest === receipt.revisionDigest &&
				preview.baselineDigest === receipt.baselineDigest &&
				canonicalDigest(preview.baseline) === canonicalDigest(receipt.baseline) &&
				preview.instructionDigest === receipt.instructionDigest;
		if (!bound) corrupt("receipt binding to its preview");
		return receipt;
	}

	private allReceipts(): Receipt[] {
		privateDirectory(this.receipts);
		return readdirSync(this.receipts)
			.filter((name) => name.endsWith(".json"))
			.map((name) => {
				const record = readRecord(path.join(this.receipts, name));
				if (!record) throw new JournalError("state-corrupt", "receipt vanished during listing");
				return this.checkedReceipt(record);
			})
			.sort((a, b) => a.createdAt - b.createdAt);
	}

	openReceipts(): Receipt[] {
		return this.allReceipts().filter((receipt) => receipt.status === "intent" || receipt.status === "unknown");
	}

	receipt(runId: string): Receipt {
		return this.readReceipt(runId);
	}

	// Object locks are never reclaimed automatically: a dead holder still blocks
	// until an explicit unlock, because pid liveness cannot rule out pid reuse.
	// Acquire and release both run under the meta-lock.
	private acquireLock(identity: string): () => void {
		const file = path.join(this.locks, lockName(identity));
		const lockId = this.withMeta(() => this.claimLock(file, "write-locked", "another process holds the lock for this object; run unlock only after confirming no live writer"));
		return () => this.withMeta(() => this.releaseLock(file, lockId));
	}

	unlock(objectIdentity: string): void {
		const file = path.join(this.locks, lockName(objectIdentity));
		this.withMeta(() => {
			const current = readLock(file);
			if (!current) return;
			if (processAlive(current.pid)) throw new JournalError("lock-held", "the lock holder is still alive");
			rmSync(file, { force: true });
		});
	}

	private crash(point: CrashPoint): void {
		if (this.crashAt === point) process.exit(9);
	}

	// Critical section under the object lock: reread the preview, bind input
	// and revision, refuse if an unresolved receipt exists for the object,
	// write the intent durably, then mark the preview consumed.
	private recordIntent(request: ApplyRequest): Receipt {
		const preview = this.readPreview(request.previewId);
		if (preview.status === "consumed") throw new JournalError("preview-consumed", "the preview was already applied");
		if (this.now() > preview.expiresAt) throw new JournalError("preview-expired", "the preview has expired; preview again");
		if (canonicalDigest(request.canonicalInput) !== preview.inputDigest) throw new JournalError("preview-input-mismatch", "the input differs from the previewed input");
		if (canonicalDigest(request.providerArgs) !== preview.argsDigest) throw new JournalError("preview-args-mismatch", "the provider arguments differ from the previewed arguments");
			const revisionDigest = request.revision === null ? null : sha256(request.revision);
			if (revisionDigest !== preview.revisionDigest) throw new JournalError("preview-revision-changed", "the target revision changed since the preview");
			if (canonicalDigest(copiedBaseline(request.baseline)) !== preview.baselineDigest) throw new JournalError("preview-baseline-changed", "the observed identifiers or revision changed since the preview");
		const instructionDigest = request.spaceInstructions === false ? canonicalDigest(false) : null;
		if (instructionDigest !== preview.instructionDigest) throw new JournalError("preview-instructions-changed", "the Confluence instruction observation changed since the preview");
		// The identity is recomputed from the supplied input, which the digest
		// check just bound to the preview, so a well-formed but foreign identity
		// in the preview file cannot steer the lock or the open-receipt check.
		if (objectIdentity(preview.operation, request.canonicalInput) !== preview.objectIdentity) corrupt("preview identity");
		if (this.openReceipts().some((entry) => entry.objectIdentity === preview.objectIdentity)) {
			throw new JournalError("write-blocked-open-receipt", "an unresolved write exists for this object; resolve it first");
		}
		this.crash("before-intent");
		const createdAt = this.now();
		const intent: Receipt = {
			runId: crypto.randomUUID(),
			previewId: preview.previewId,
			operation: preview.operation,
			provider: preview.provider,
			objectIdentity: preview.objectIdentity,
			inputDigest: preview.inputDigest,
				argsDigest: preview.argsDigest,
				revisionDigest: preview.revisionDigest,
				baseline: preview.baseline,
				baselineDigest: preview.baselineDigest,
				instructionDigest: preview.instructionDigest,
			status: "intent",
			send: "unsent",
			effects: [],
			holder: { pid: process.pid },
			createdAt,
			updatedAt: createdAt,
		};
		writeDurable(this.receipts, `${intent.runId}.json`, intent);
		this.crash("after-intent");
		writeDurable(this.previews, `${preview.previewId}.json`, { ...preview, status: "consumed" });
		return intent;
	}

	// Read-back absence releases an object only when the receipt never reached
	// the send mark; after a possible send it is not evidence of no effect.
	private settled(receipt: Receipt, evidence: unknown): Receipt {
		const next: Receipt = { ...receipt, updatedAt: this.now() };
		if (!validEvidence(evidence) || evidence.proof === "unknown") {
			next.status = "unknown";
		} else if (evidence.proof === "completed") {
			next.status = "completed";
			next.effects = evidence.effects.map((effect) => ({ kind: effect.kind, id: effect.id }));
		} else if (evidence.basis === "revision-unchanged" || receipt.send === "unsent") {
			next.status = "unchanged";
			next.basis = evidence.basis;
		} else {
			next.status = "unknown";
		}
		return next;
	}

	// The write-ahead send mark. Only the live holder of an in-flight intent
	// may set it; the receipt file is the holder's to write until it settles.
	private markSending(runId: string): void {
		const current = this.readReceipt(runId);
		if (current.status !== "intent" || current.holder.pid !== process.pid) throw new JournalError("receipt-not-in-flight", "only the live holder of an in-flight intent can mark it sending");
		if (current.send === "possible") return;
		writeDurable(this.receipts, `${runId}.json`, { ...current, send: "possible", updatedAt: this.now() });
	}

	async apply(request: ApplyRequest, dispatch: Dispatch): Promise<Receipt> {
		if (!isRecord(request.providerArgs)) throw new JournalError("input-invalid", "provider arguments must be an object");
		const preview = this.readPreview(request.previewId);
		let release = this.acquireLock(preview.objectIdentity);
		let intent: Receipt;
		try {
			intent = this.recordIntent(request);
		} finally {
			release();
		}
		let evidence: unknown;
		try {
			evidence = await dispatch(intent, () => this.markSending(intent.runId), Object.freeze(JSON.parse(canonical(request.providerArgs)) as Record<string, unknown>));
		} catch {
			evidence = { proof: "unknown" };
		}
		// Settle with compare-and-set under the lock so a resolve that raced the
		// dispatch is never overwritten.
		release = this.acquireLock(intent.objectIdentity);
		try {
			const current = this.readReceipt(intent.runId);
			if (current.status !== "intent" || current.holder.pid !== process.pid) throw new JournalError("receipt-not-in-flight", "the receipt was settled elsewhere");
			const settled = this.settled(current, evidence);
			writeDurable(this.receipts, `${settled.runId}.json`, settled);
			return settled;
		} finally {
			release();
		}
	}

	// Finality and live-holder checks run on a reread inside the object lock, so
	// a settle racing this resolve cannot interleave.
	resolve(runId: string, evidence: Evidence): Receipt {
		if (!validEvidence(evidence)) throw new JournalError("evidence-invalid", "evidence must be unknown, unchanged with readback-absent, or completed with closed-vocabulary effects");
		const located = this.readReceipt(runId);
		const release = this.acquireLock(located.objectIdentity);
		try {
			const receipt = this.readReceipt(runId);
			if (receipt.objectIdentity !== located.objectIdentity) throw new JournalError("state-corrupt", "the receipt changed identity under the lock");
			if (receipt.status === "completed" || receipt.status === "unchanged") throw new JournalError("receipt-already-resolved", "the receipt is already resolved");
			if (receipt.status === "intent" && processAlive(receipt.holder.pid)) throw new JournalError("receipt-in-flight", "the writing process is still alive");
			if (evidence.proof === "unchanged" && evidence.basis === "readback-absent" && receipt.send !== "unsent") {
				throw new JournalError("evidence-insufficient", "the request may have been sent, so a missing read-back cannot prove no effect; resolve with the effect found by read-back, or leave it unresolved until operator adjudication exists");
			}
			const settled = this.settled(receipt, evidence);
			writeDurable(this.receipts, `${settled.runId}.json`, settled);
			return settled;
		} finally {
			release();
		}
	}
}

function stateRoot(options: JournalOptions): string {
	if (options.stateRoot) return options.stateRoot;
	const env = options.env ?? process.env;
	const xdg = env.XDG_STATE_HOME ?? "";
	if (path.isAbsolute(xdg)) return xdg;
	return path.join(env.HOME ?? os.homedir(), ".local", "state");
}

export function openJournal(tenant: string, options: JournalOptions = {}): Journal {
	if (!TENANT_PATTERN.test(tenant)) throw new JournalError("tenant-invalid", "expected a lowercase tenant slug");
	const root = path.join(stateRoot(options), "connectors", "atlassian", tenant);
	return new FileJournal(root, options.now ?? Date.now, options.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS, options.crashAt, options.hooks);
}
