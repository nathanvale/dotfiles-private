import { randomUUID } from "node:crypto";
import { existsSync, linkSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { Executed, SchemaRequest, WritePhase } from "../../../bin/adapters/contract.ts";
import { ownedDirectory, publishPrivateFileOnce, readPrivateFile, writePrivateFile } from "../../../bin/private-state.ts";
import { fenceScript, mutationScript, objectId, snapshotScript, validateWrite, type CanvasWrite, type WriteName } from "./canvas.ts";
import { canonical, ConsoleRefusal, type Data, digest, record } from "./model.ts";
import { type Profile, profileRoot } from "./profile.ts";
import { currentSnapshot, type ConsoleCaller } from "./transport.ts";

export const RECEIPT_ID = /^fc-[a-f0-9-]{36}$/;
const PREVIEW_SECONDS = 900;
const STATUSES = ["preview", "sending", "applied", "unknown", "unchanged"] as const;
export interface Receipt {
	id: string;
	profile: string;
	operation: WriteName;
	input: Data;
	object: string;
	baseline: Data;
	status: typeof STATUSES[number];
	createdAt: string;
}
const refusal = (reason: string): never => { throw new ConsoleRefusal(reason); };
// An existing target is a lost race, never a publication of our own.
const published = (result: ReturnType<typeof publishPrivateFileOnce>): boolean => result.ok && result.published;

// Atomic publication is the cross-process lock and consume primitive. The
// one-use marker decides each preview exactly once: an apply that wins it
// (`one-attempt`) is the only sender; an unlock that wins it (`cancelled`)
// ends the preview unsent. A receipt whose attempt marker exists reads as
// `sending` even if its own status write never landed, so a crash at any later
// point leaves an open receipt to adjudicate. The attempt marker names its pid.
// A verdict (applied or unchanged) is its own one-use `<id>.terminal` record,
// so the first verdict stands and outranks the receipt body.
const ATTEMPT = `one-attempt ${process.pid}\n`, CANCELLED = "cancelled\n";
const VERDICTS: readonly unknown[] = ["applied", "unchanged"];
const CLAIM_STALE_MS = 10_000;
export class Journal {
	readonly root: string;
	// Writes validate every receipt first; recovery reads around a malformed one.
	constructor(request: SchemaRequest, readonly profile: Profile, strict = true) {
		this.root = path.join(profileRoot(request.env, profile), "journal");
		if (!ownedDirectory(this.root).ok) refusal("journal-unavailable");
		if (strict) this.receipts(); // One malformed receipt blocks further mutation.
	}
	private file(id: string): string { if (!RECEIPT_ID.test(id)) refusal("receipt-invalid"); return path.join(this.root, `${id}.json`); }
	private marker(id: string): string { return path.join(this.root, `${id}.used`); }
	private terminal(id: string): string { return path.join(this.root, `${id}.terminal`); }
	private verdict(id: string): Receipt["status"] | null {
		const read = readPrivateFile(this.terminal(id));
		const status = read.ok ? read.text.trim() : null;
		return VERDICTS.includes(status) ? status as Receipt["status"] : null;
	}
	private lock(object: string): string { return path.join(this.root, `${digest({ account: this.profile.userId, file: this.profile.fileKey, object })}.lock`); }
	private holds(receipt: Receipt): boolean { const lock = readPrivateFile(this.lock(receipt.object)); return lock.ok && lock.text === `${receipt.id}\n`; }
	// Removes a lock file only while it names `holder`: checked before moving it
	// aside and again on the moved copy, which is restored if it changed hands.
	// Settlement is serialized per receipt, so only that receipt's own settler
	// ever moves a lock naming it.
	private release(lock: string, holder: string): "released" | "absent" | "foreign" | "failed" {
		const named = readPrivateFile(lock);
		if (!named.ok) return named.reason === "absent" ? "absent" : "failed";
		if (named.text !== `${holder}\n`) return "foreign";
		const tomb = `${lock}.${randomUUID()}.release`;
		try { renameSync(lock, tomb); } catch (error) { return (error as { code?: unknown }).code === "ENOENT" ? "absent" : "failed"; }
		const held = readPrivateFile(tomb);
		try {
			if (held.ok && held.text === `${holder}\n`) { unlinkSync(tomb); return "released"; }
			try { linkSync(tomb, lock); } catch { /* A newer lock took the path; it stays. */ }
			unlinkSync(tomb);
			return "foreign";
		} catch { return "failed"; }
	}
	read(id: string): Receipt {
		const read = readPrivateFile(this.file(id));
		if (!read.ok) return refusal("receipt-unavailable");
		let value: unknown;
		try { value = JSON.parse(read.text) as unknown; } catch { return refusal("journal-corrupt"); }
		if (!record(value) || value.id !== id || value.profile !== digest(this.profile) || typeof value.operation !== "string" || !record(value.input) || !validateWrite(value.operation, value.input) || typeof value.object !== "string" || value.object !== objectId(value.operation, value.input) || !record(value.baseline) || !(STATUSES as readonly unknown[]).includes(value.status) || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return refusal("journal-corrupt");
		const receipt = value as unknown as Receipt;
		const verdict = this.verdict(id);
		if (verdict !== null) return { ...receipt, status: verdict };
		if (receipt.status !== "preview") return receipt;
		const marker = readPrivateFile(this.marker(id));
		if (marker.ok) return { ...receipt, status: marker.text === CANCELLED ? "unchanged" : "sending" };
		// A marker that exists but cannot be read is an attempt until proven not.
		return marker.reason === "absent" ? receipt : { ...receipt, status: "sending" };
	}
	// When the receipt's attempt began, and the process that made it.
	attemptedAt(id: string): number | null {
		try { return statSync(this.marker(id)).mtimeMs; } catch { return null; }
	}
	attemptRunning(id: string): boolean {
		const marker = readPrivateFile(this.marker(id));
		const pid = marker.ok ? Number.parseInt(marker.text.replace(/^one-attempt /, ""), 10) : Number.NaN;
		return Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && alive(pid);
	}
	// Serializes one receipt's status changes and lock release across
	// processes. A claim names its pid and time; it is stale once its holder
	// exited, is this process (a release that failed), or is older than any
	// step could take, so a reused pid cannot block settlement.
	private exclusive<T>(id: string, step: () => T): T | null {
		const file = path.join(this.root, `${id}.settle`);
		for (let tries = 0; tries < 250; tries += 1) {
			const mine = `${process.pid} ${Date.now()}`, claim = publishPrivateFileOnce(file, `${mine}\n`);
			// Storage that cannot publish at all is a failure, not a holder to wait for.
			if (!claim.ok) return null;
			if (claim.published) {
				try { return step(); } finally { this.release(file, mine); }
			}
			const held = claim.existing.trim(), [pid = Number.NaN, at = Number.NaN] = held.split(" ").map(Number);
			if (pid === process.pid || !alive(pid) || !(Date.now() - at < CLAIM_STALE_MS)) this.release(file, held);
			else Bun.sleepSync(20);
		}
		return null;
	}
	receipts(): Receipt[] { return readdirSync(this.root).filter((name) => name.endsWith(".json")).map((name) => this.read(name.slice(0, -5))); }
	// The recovery listing: every readable receipt, every malformed one by
	// name, and every lock whose receipt never published.
	scan(): { receipts: Receipt[]; malformed: string[]; orphanLocks: string[] } {
		const receipts: Receipt[] = [], malformed: string[] = [], ids = new Set<string>();
		for (const name of readdirSync(this.root).filter((entry) => entry.endsWith(".json"))) {
			try { const receipt = this.read(name.slice(0, -5)); receipts.push(receipt); ids.add(receipt.id); } catch { malformed.push(name); }
		}
		const orphanLocks = this.locks().filter(([, id]) => !ids.has(id) && !malformed.includes(`${id}.json`)).map(([, id]) => id);
		return { receipts, malformed, orphanLocks };
	}
	private locks(): [string, string][] {
		return readdirSync(this.root).filter((name) => name.endsWith(".lock")).flatMap((name): [string, string][] => {
			const held = readPrivateFile(path.join(this.root, name));
			return held.ok ? [[path.join(this.root, name), held.text.trim()]] : [];
		});
	}
	preview(operation: WriteName, input: Data, baseline: Data): Receipt {
		const object = objectId(operation, input), id = `fc-${randomUUID()}`;
		if (!published(publishPrivateFileOnce(this.lock(object), `${id}\n`))) return refusal("object-blocked");
		const receipt: Receipt = { id, profile: digest(this.profile), operation, input, object, baseline, status: "preview", createdAt: new Date().toISOString() };
		if (published(publishPrivateFileOnce(this.file(id), `${canonical(receipt)}\n`))) return receipt;
		// Nothing names this lock yet, so releasing it cannot hide an attempt;
		// if this fails, `--unlock` releases it as an orphan.
		this.release(this.lock(object), id);
		return refusal("journal-unavailable");
	}
	// Every refusal here is before any send. Only the winner of the marker
	// publication proceeds; a degraded journal refuses rather than send.
	attempt(receipt: Receipt): void {
		if (receipt.status !== "preview") refusal("preview-consumed");
		if (Date.now() - Date.parse(receipt.createdAt) > PREVIEW_SECONDS * 1000) refusal("preview-expired");
		if (!this.holds(receipt)) refusal("object-blocked");
		if (!published(publishPrivateFileOnce(this.marker(receipt.id), ATTEMPT))) refusal("preview-consumed");
		// An adjudication may already have fenced and settled this attempt.
		const sending = this.settle(receipt, "sending");
		if (sending !== "recorded") refusal(sending === "settled" ? "receipt-settled" : "journal-unavailable");
	}
	// Never throws. A compare-and-set per receipt: once a verdict exists it is
	// never overwritten, so a late process cannot reopen it. A verdict is
	// published once before the receipt body changes, and releases the object
	// lock only after it is durable. `failed` means the status may not be
	// recorded, so the receipt stays open.
	settle(receipt: Receipt, status: Receipt["status"]): "recorded" | "settled" | "failed" {
		try {
			return this.exclusive(receipt.id, () => {
				if (this.verdict(receipt.id) !== null) return "settled" as const;
				const final = VERDICTS.includes(status);
				if (final) {
					const claim = publishPrivateFileOnce(this.terminal(receipt.id), `${status}\n`);
					if (!claim.ok) return "failed" as const;
					if (!claim.published) return "settled" as const;
				}
				const wrote = writePrivateFile(this.file(receipt.id), `${canonical({ ...receipt, status })}\n`).ok;
				if (!final) return wrote ? "recorded" as const : "failed" as const;
				return this.release(this.lock(receipt.object), receipt.id) === "failed" ? "failed" as const : "recorded" as const;
			}) ?? "failed";
		} catch { return "failed"; }
	}
	// Ends an unattempted preview by winning its marker, releases a settled
	// receipt's lock left behind by a failed release, or releases a lock whose
	// receipt never published. An attempted, unsettled receipt is never unlocked.
	cancel(id: string): Data {
		if (!existsSync(this.file(id))) return this.releaseOrphan(id);
		const receipt = this.read(id);
		if (receipt.status === "applied" || receipt.status === "unchanged") return this.releaseSettled(receipt);
		if (receipt.status !== "preview" || !published(publishPrivateFileOnce(this.marker(id), CANCELLED))) refusal("attempted-receipt-cannot-unlock");
		if (this.settle(receipt, "unchanged") === "failed") refusal("journal-unavailable");
		return { ...this.read(id) };
	}
	private releaseOrphan(id: string): Data {
		const orphans = this.locks().filter(([, held]) => held === id);
		if (orphans.length === 0) return refusal("receipt-unavailable");
		if (this.exclusive(id, () => orphans.some(([lock]) => this.release(lock, id) === "failed")) !== false) return refusal("journal-unavailable");
		return { id, orphanLock: "released" };
	}
	private releaseSettled(receipt: Receipt): Data {
		if (!this.holds(receipt)) refusal("receipt-already-unlocked");
		const released = this.exclusive(receipt.id, () => this.release(this.lock(receipt.object), receipt.id));
		if (released === "absent" || released === "foreign") refusal("receipt-already-unlocked");
		if (released !== "released") refusal("journal-unavailable");
		return { ...this.read(receipt.id) };
	}
}

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (error) { return (error as { code?: unknown }).code === "EPERM"; }
}

const children = (snapshot: Data): Data[] => record(snapshot.node) && Array.isArray(snapshot.node.children) ? snapshot.node.children.filter(record) : [];
const variable = (snapshot: Data, id: unknown): Data | undefined => Array.isArray(snapshot.variables) ? snapshot.variables.filter(record).find((v) => v.id === id) : undefined;
// Figma stores numbers at float32 precision and COLOR values as RGBA, so a
// requested value matches what it reads back as, never only its exact bytes.
function near(observed: unknown, requested: unknown): boolean {
	if (typeof observed === "number" && typeof requested === "number") return Math.fround(observed) === Math.fround(requested);
	if (Array.isArray(observed) && Array.isArray(requested)) return observed.length === requested.length && observed.every((item, index) => near(item, requested[index]));
	if (record(observed) && record(requested)) return canonical(Object.keys(observed).sort()) === canonical(Object.keys(requested).sort()) && Object.keys(observed).every((key) => near(observed[key], requested[key]));
	return observed === requested;
}
const RGB = ["r", "g", "b"];
const rgba = (value: unknown): unknown => record(value) && RGB.every((key) => typeof value[key] === "number") && Object.keys(value).every((key) => [...RGB, "a"].includes(key)) ? { a: 1, ...value } : value;
const sameValue = (observed: unknown, requested: unknown): boolean => near(rgba(observed), rgba(requested));
function textMatches(node: Data, input: Data): boolean {
	return node.type === "TEXT" && node.characters === input.text && near(node.fontSize, input.fontSize) && canonical(node.fontName) === canonical({ family: input.fontFamily, style: input.fontStyle });
}

// Observable, operation-specific marks; a changed digest alone never passes.
function matches(receipt: Pick<Receipt, "operation" | "input" | "baseline">, after: Data): boolean {
	const { input, operation } = receipt;
	if (operation === "session_start" || operation === "session_stop") return false;
	if (operation === "update_text") return record(after.node) && textMatches(after.node, input);
	if (operation === "create_text") {
		const old = new Set(children(receipt.baseline).map((n) => n.id));
		return children(after).filter((n) => !old.has(n.id) && n.name === input.name && textMatches(n, input)).length === 1;
	}
	if (operation === "create_variants") {
		const old = new Set(children(receipt.baseline).map((n) => n.id));
		return children(after).filter((n) => !old.has(n.id) && n.type === "COMPONENT_SET" && n.name === input.name && Array.isArray(n.children) && canonical(n.children.filter(record).map((c) => c.name).sort()) === canonical((input.variants as string[]).map((v) => `State=${v}`).sort())).length === 1;
	}
	if (operation === "update_variable") {
		const v = variable(after, input.variableId);
		return v !== undefined && record(v.valuesByMode) && sameValue(v.valuesByMode[String(input.modeId)], input.value);
	}
	if (operation === "bind_fill") {
		if (!record(after.node) || !Array.isArray(after.node.fills)) return false;
		return after.node.fills.some((paint: unknown) => record(paint) && record(paint.boundVariables) && record(paint.boundVariables.color) && paint.boundVariables.color.id === input.variableId);
	}
	return tokenMatches(receipt, after);
}

function tokenMatches(receipt: Pick<Receipt, "input" | "baseline">, after: Data): boolean {
	const old = new Set(Array.isArray(receipt.baseline.collections) ? receipt.baseline.collections.filter(record).map((c) => c.id) : []);
	const collections = Array.isArray(after.collections) ? after.collections.filter(record).filter((c) => !old.has(c.id) && c.name === receipt.input.collection) : [];
	const c = collections[0];
	if (collections.length !== 1 || !c || !Array.isArray(after.variables)) return false;
	const variables = after.variables.filter(record);
	return (receipt.input.tokens as Data[]).every((t) => variables.filter((v) => v.variableCollectionId === c.id && v.name === t.name && v.resolvedType === t.type && canonical(v.scopes) === canonical(t.scopes) && record(v.valuesByMode) && sameValue(v.valuesByMode[String(c.defaultModeId)], t.value)).length === 1);
}

// After a won attempt, the request may have left: every path from here,
// including a journal that cannot record the outcome, reports effect-unknown
// unless operation-specific read-back proves the effect and is recorded.
export async function settleAttempt(journal: Journal, receipt: Receipt, send: () => Promise<{ verified: boolean; data: Data }>, repair: string): Promise<Executed> {
	let sent: { verified: boolean; data: Data } | null = null;
	try { sent = await send(); } catch { /* The outcome is unknown; the receipt below says so. */ }
	if (sent?.verified && journal.settle(receipt, "applied") === "recorded") return { kind: "applied", data: { runId: receipt.id, object: receipt.object, ...sent.data } };
	const recorded = journal.settle(receipt, "unknown");
	if (recorded === "settled") return settledMeanwhile(journal, receipt, repair);
	return unknown(receipt, recorded === "recorded" ? "unknown" : "sending", repair);
}

function unknown(receipt: Receipt, receiptStatus: string, repair: string): Executed {
	return { kind: "effect-unknown", data: { runId: receipt.id, object: receipt.object, receiptStatus }, repair };
}

// An adjudication settled this receipt while its apply was still running:
// its own evidence decides, and the fence kept a late mutation from landing.
// A session has no fence, so its late effect stays unknown beside the verdict.
function settledMeanwhile(journal: Journal, receipt: Receipt, repair: string): Executed {
	let status: Receipt["status"];
	try { status = journal.read(receipt.id).status; } catch { return unknown(receipt, "unreadable", repair); }
	if (receipt.operation === "session_start" || receipt.operation === "session_stop") return unknown(receipt, status, "The journal settled this session while the attempt still ran; check session_status and stop or start through a new preview. Never replay this one");
	const data = { runId: receipt.id, object: receipt.object, receiptStatus: status, settledBy: "adjudication" };
	return status === "applied" ? { kind: "applied", data } : { kind: "failed-after-record", connectorCause: "settled-unchanged", data, repair: "An adjudication fenced this receipt and proved its object unchanged before this send; preview again if the change is still wanted" };
}

export async function write(request: SchemaRequest, profile: Profile, transport: ConsoleCaller, operation: CanvasWrite, input: Data, phase: WritePhase): Promise<Executed> {
	const journal = new Journal(request, profile);
	if (phase.kind === "preview") {
		const baseline = await currentSnapshot(transport, profile, snapshotScript(profile, input, true));
		const receipt = journal.preview(operation, input, baseline);
		return { kind: "recorded", effect: "write-preview", data: { previewId: receipt.id, object: receipt.object, account: profile.userId, fileKey: profile.fileKey, baselineDigest: digest(baseline), expiresInSeconds: PREVIEW_SECONDS, input } };
	}
	const receipt = journal.read(phase.previewId);
	if (receipt.operation !== operation || canonical(receipt.input) !== canonical(input)) refusal("preview-input-mismatch");
	// Read before consuming. A missing bridge/account/file is still a no-send
	// refusal; the same complete baseline is checked again inside the mutation.
	const fresh = await currentSnapshot(transport, profile, snapshotScript(profile, input, true));
	if (canonical(fresh) !== canonical(receipt.baseline)) refusal("baseline-changed");
	journal.attempt(receipt);
	return settleAttempt(journal, receipt, async () => {
		await transport.call("figma_execute", { fileKey: profile.fileKey, code: mutationScript(profile, operation, input, receipt.baseline, receipt.id), timeout: 15000 });
		const after = await currentSnapshot(transport, profile, snapshotScript(profile, input, true));
		return { verified: matches(receipt, after), data: { fileKey: profile.fileKey, afterDigest: digest(after) } };
	}, `Inspect the receipt, then adjudicate with fresh readback: recover figma-console --select account=${profile.account} --select file=${profile.fileKey} --run ${receipt.id} --adjudicate --input {}. Never resend this preview`);
}

// The receipt's own object: unrelated edits elsewhere in the file never
// decide whether this write landed.
function scope(receipt: Pick<Receipt, "operation" | "input">, snapshot: Data): unknown {
	if (receipt.operation === "update_variable") return variable(snapshot, receipt.input.variableId) ?? null;
	if (receipt.operation !== "create_tokens") return snapshot.node;
	// Every collection id as well: a created collection renamed afterwards
	// still differs from the baseline.
	const all = Array.isArray(snapshot.collections) ? snapshot.collections.filter(record) : [];
	const named = all.filter((c) => c.name === receipt.input.collection);
	const ids = new Set(named.map((c) => c.id));
	return { collectionIds: all.map((c) => String(c.id)).sort(), collections: named, variables: Array.isArray(snapshot.variables) ? snapshot.variables.filter(record).filter((v) => ids.has(v.variableCollectionId)) : [] };
}

// Fenced first, so the observation is final for this receipt: a mutation
// still running in Desktop refuses at its fence instead of landing later.
export async function adjudicate(journal: Journal, receipt: Receipt, transport: ConsoleCaller): Promise<Executed> {
	const after = await currentSnapshot(transport, journal.profile, fenceScript(journal.profile, receipt.input, receipt.id));
	const status = matches(receipt, after) ? "applied" : canonical(scope(receipt, after)) === canonical(scope(receipt, receipt.baseline)) ? "unchanged" : null;
	if (status === null) return refusal("adjudication-inconclusive");
	const settled = journal.settle(receipt, status);
	if (settled !== "recorded") return refusal(settled === "settled" ? "receipt-not-open" : "journal-unavailable");
	return { kind: "recorded", effect: "write-adjudication", data: { runId: receipt.id, status, afterDigest: digest(after) } };
}
