// Figma's upload_assets through an adapter-owned outbox. Figma answers the
// call with single-use upload URLs; a POST of raw bytes to each URL stores the
// asset and places it, as a fill on a target node or as a new frame on a page.
// Those URLs are capabilities, so the adapter alone holds them, in memory, and
// performs every POST itself: no URL reaches an envelope, the journal, an
// argument, or a log. A URL off Figma's origin is never contacted.
//
// The local files are staged through the Atlassian outbox owner into
// <stateRoot>/connectors/figma/outbox, and their content digests join the
// preview's input digest, so an apply sends exactly the previewed bytes. The
// write follows the same journal as every other Figma write: preview, one
// apply, a receipt durable before the call, and settlement only on read-back.
// Read-back is the target page's get_metadata (one new node per asset) or,
// for fills, every target node's get_design_context having moved; a node read
// is a partial view, so it never proves an upload had no effect.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { stateRoot } from "../../../bin/private-state.ts";
import type { Executed } from "../../../bin/adapters/contract.ts";
import type { EnvironmentSource } from "../../../bin/safe-environment.ts";
import { stageInto } from "../../atlassian/scripts/outbox.ts";
import { type Call, sha256, type WriteInput } from "./catalogue.ts";
import { FIGMA_ENDPOINT } from "./endpoint.ts";
import { newIds, observe } from "./evidence.ts";
import type { Baseline, Journal, Receipt } from "./journal.ts";
import type { Caller } from "./transport.ts";
import { blockedRefusal, digestOf, JOURNAL_REPAIR, PREVIEW_AGAIN, readFailure, recoverRun, refused, UNKNOWN_REPAIR } from "./writes.ts";

const MAX_BYTES = 10 * 1024 * 1024;
const POST_TIMEOUT_MS = 60_000;

interface Asset {
	readonly path: string;
	readonly contentType: string;
}
interface Staged extends Asset {
	readonly file: string;
	readonly digest: string;
}
type Mode = { kind: "page"; pageId: string } | { kind: "fill"; nodeIds: string[] };

const assetsOf = (write: WriteInput): Asset[] => write.input.assets as Asset[];
const modeOf = (write: WriteInput): Mode => (write.input.nodeIds === undefined ? { kind: "page", pageId: write.input.currentPageId as string } : { kind: "fill", nodeIds: write.input.nodeIds as string[] });

// Stage every asset; a refusal names the closed cause only, never the path.
function stage(write: WriteInput, env: EnvironmentSource): { ok: true; staged: Staged[] } | { ok: false; refusal: Executed } {
	const outbox = path.join(stateRoot(env), "connectors", "figma", "outbox");
	const staged: Staged[] = [];
	for (const asset of assetsOf(write)) {
		const result = stageInto(outbox, asset.path);
		if (!result.ok) return { ok: false, refusal: refused(result.reason, result.reason === "file-unreadable" ? "an asset is not a readable regular file; name an absolute path to an existing image" : "the Figma upload outbox under Connectors state is not a private owned directory") };
		const file = path.join(outbox, result.relative);
		if (statSync(file).size > MAX_BYTES) return { ok: false, refusal: refused("asset-too-large", "Figma accepts at most 10 MB per asset") };
		staged.push({ ...asset, file, digest: result.relative.split("/")[0] as string });
	}
	return { ok: true, staged };
}

// The input digest binds the staged bytes, not just their paths.
const uploadDigest = (write: WriteInput, staged: Staged[]): string => digestOf(write.operation, { ...write.input, assets: staged.map((item) => ({ path: item.path, contentType: item.contentType, sha256: item.digest })) });

function reads(write: WriteInput, mode: Mode): Call[] {
	const fileKey = write.input.fileKey as string;
	return mode.kind === "page" ? [{ tool: "get_metadata", args: { fileKey, nodeId: mode.pageId } }] : mode.nodeIds.map((nodeId) => ({ tool: "get_design_context", args: { fileKey, nodeId } }));
}

// One baseline across the reads: page node ids, or each target's digest.
async function observeUpload(write: WriteInput, caller: Caller): Promise<{ ok: true; baseline: Baseline } | { ok: false; refusal: Executed }> {
	const mode = modeOf(write);
	const digests: string[] = [];
	let ids: string[] = [];
	for (const call of reads(write, mode)) {
		const read = await observe(call, caller);
		if (!read.ok) return { ok: false, refusal: readFailure(read.result) };
		digests.push(read.observation.baseline.digest);
		if (mode.kind === "page") ids = read.observation.baseline.ids;
	}
	return { ok: true, baseline: { digest: sha256(digests.join(",")), ids: mode.kind === "page" ? ids : mode.nodeIds.map((nodeId, index) => `${nodeId}=${digests[index]}`), version: null } };
}

type Proof = { proof: "completed"; ids: string[] } | { proof: "baseline" } | { proof: "none" };

async function uploadEvidence(write: WriteInput, baseline: Baseline, caller: Caller): Promise<Proof> {
	const now = await observeUpload(write, caller);
	if (!now.ok) return { proof: "none" };
	const mode = modeOf(write);
	if (mode.kind === "fill") {
		const moved = mode.nodeIds.every((_nodeId, index) => baseline.ids[index] !== now.baseline.ids[index]);
		return moved ? { proof: "completed", ids: mode.nodeIds } : { proof: "none" };
	}
	const created = newIds(baseline, { text: "", statuses: [], baseline: now.baseline });
	if (created.length >= assetsOf(write).length) return { proof: "completed", ids: created };
	return created.length === 0 ? { proof: "baseline" } : { proof: "none" };
}

// Figma's own upload origin, or the one hosted endpoint's origin.
function admissible(raw: string): boolean {
	try {
		const url = new URL(raw);
		if (url.username !== "" || url.password !== "") return false;
		if (url.origin === new URL(FIGMA_ENDPOINT).origin) return true;
		return url.protocol === "https:" && (url.hostname === "figma.com" || url.hostname.endsWith(".figma.com"));
	} catch {
		return false;
	}
}

// A string that holds JSON, parsed; any other value unchanged.
function parsed(value: unknown): unknown {
	if (typeof value !== "string" || !(value.startsWith("{") || value.startsWith("["))) return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function children(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (typeof value === "object" && value !== null) return Object.entries(value).filter(([key]) => key !== "_meta").map(([, item]) => item);
	return [];
}

// Every http(s) string in the reply, in order; the reply is never kept.
function uploadUrls(reply: unknown): string[] {
	const value = parsed(reply);
	if (typeof value === "string") return /^https?:\/\//.test(value) ? [value] : [];
	return children(value).flatMap(uploadUrls);
}

// POST each staged asset to its own URL; only HTTP statuses survive.
async function post(urls: string[], staged: Staged[]): Promise<(number | "failed")[]> {
	const statuses: (number | "failed")[] = [];
	for (const [index, url] of urls.entries()) {
		const item = staged[index] as Staged;
		try {
			const response = await fetch(url, { method: "POST", headers: { "content-type": item.contentType }, body: readFileSync(item.file), redirect: "manual", signal: AbortSignal.timeout(POST_TIMEOUT_MS) });
			statuses.push(response.status);
		} catch {
			statuses.push("failed");
		}
	}
	return statuses;
}

function settle(write: WriteInput, receipt: Receipt, journal: Journal, proof: Proof, outcome: { replied: boolean; providerRefused: boolean; urlRefused: boolean; statuses: (number | "failed")[] }): Executed {
	const data = (settled: Receipt | null) => ({ operation: write.operation, runId: receipt.runId, receipt: settled ?? receipt, uploads: outcome.statuses });
	if (proof.proof === "completed") {
		const settled = journal.settle(receipt, { status: "completed", replied: outcome.replied, effects: proof.ids.map((id) => ({ kind: "figma-object" as const, id })) });
		if (settled) return { kind: "applied", data: data(settled) };
	}
	// Nothing was posted: Figma refused the call, or the adapter refused a URL.
	if (proof.proof === "baseline" && (outcome.providerRefused || outcome.urlRefused)) {
		const settled = journal.settle(receipt, { status: "unchanged", replied: outcome.replied, effects: [] });
		if (settled) {
			const repair = outcome.urlRefused ? "Figma returned an upload URL off its own origin, so nothing was posted and the page is unchanged; report this before uploading again" : "Figma refused the upload and the page is unchanged; correct the input, then preview again";
			return { kind: "failed-after-record", connectorCause: outcome.urlRefused ? "upload-url-refused" : "provider-refused", data: data(settled), repair };
		}
	}
	const settled = journal.settle(receipt, { status: "unknown", replied: outcome.replied, effects: [] });
	return { kind: "effect-unknown", data: data(settled), repair: UNKNOWN_REPAIR(receipt.runId) };
}

// The call's arguments: the asset count, never a path or a byte.
function callArgs(write: WriteInput): Record<string, unknown> {
	const { fileKey, nodeIds, currentPageId, scaleMode } = write.input;
	return { fileKey, count: assetsOf(write).length, ...(nodeIds === undefined ? {} : { nodeIds }), ...(currentPageId === undefined ? {} : { currentPageId }), ...(scaleMode === undefined ? {} : { scaleMode }) };
}

export async function previewUpload(write: WriteInput, env: EnvironmentSource, caller: Caller, journal: Journal | null): Promise<Executed> {
	if (journal === null) return refused("journal-unavailable", JOURNAL_REPAIR);
	const identity = write.spec.identity(write.input);
	const blocked = blockedRefusal(journal, identity);
	if (blocked) return blocked;
	const staged = stage(write, env);
	if (!staged.ok) return staged.refusal;
	const observed = await observeUpload(write, caller);
	if (!observed.ok) return observed.refusal;
	const preview = journal.recordPreview({ operation: write.operation, objectIdentity: identity, inputDigest: uploadDigest(write, staged.staged), baseline: observed.baseline });
	if (preview === null) return refused("journal-unavailable", JOURNAL_REPAIR);
	return { kind: "recorded", effect: "write-preview", data: { operation: write.operation, previewId: preview.previewId, objectIdentity: identity, assets: staged.staged.map((item) => item.digest), expiresAt: new Date(preview.expiresAt).toISOString() } };
}

async function lockedUpload(write: WriteInput, previewId: string, staged: Staged[], caller: Caller, journal: Journal, identity: string): Promise<Executed> {
	const blocked = blockedRefusal(journal, identity);
	if (blocked) return blocked;
	const preview = journal.preview(previewId);
	if (preview === null) return refused("preview-unknown", PREVIEW_AGAIN);
	const observed = await observeUpload(write, caller);
	if (!observed.ok) return observed.refusal;
	if (observed.baseline.digest !== preview.baseline.digest) return refused("preview-stale", `the target changed after the preview; ${PREVIEW_AGAIN}`);
	const ready = await caller.prepare({ tool: write.operation, args: callArgs(write) });
	if (!ready.ok) return refused(ready.cause, ready.repair);
	if (!journal.consume(previewId)) return refused("preview-consumed", `a preview applies at most once; ${PREVIEW_AGAIN}`);
	const receipt = journal.begin(preview, observed.baseline);
	if (receipt === null) return refused("journal-unavailable", JOURNAL_REPAIR);
	const sent = ready.send();
	const replied = sent.ok || sent.cause !== "transport-failed";
	const urls = sent.ok ? uploadUrls(sent.data) : [];
	const urlRefused = sent.ok && (urls.length !== staged.length || !urls.every(admissible));
	const statuses = sent.ok && !urlRefused ? await post(urls, staged) : [];
	const proof = await uploadEvidence(write, observed.baseline, caller);
	return settle(write, receipt, journal, proof, { replied, providerRefused: !sent.ok && sent.cause === "tool-error", urlRefused, statuses });
}

export async function applyUpload(write: WriteInput, previewId: string, env: EnvironmentSource, caller: Caller, journal: Journal | null): Promise<Executed> {
	if (journal === null) return refused("journal-unavailable", JOURNAL_REPAIR);
	const staged = stage(write, env);
	if (!staged.ok) return staged.refusal;
	const preview = journal.preview(previewId);
	if (preview === null || preview.operation !== write.operation) return refused("preview-unknown", PREVIEW_AGAIN);
	if (preview.inputDigest !== uploadDigest(write, staged.staged)) return refused("preview-input-mismatch", `apply needs the identical --input and asset bytes the preview recorded; ${PREVIEW_AGAIN}`);
	if (journal.expired(preview)) return refused("preview-expired", PREVIEW_AGAIN);
	if (journal.consumed(previewId)) return refused("preview-consumed", `a preview applies at most once; ${PREVIEW_AGAIN}`);
	const identity = write.spec.identity(write.input);
	if (!journal.lock(identity)) return refused("write-locked", `another apply holds this object's lock; if no apply is running, release it with ${recoverRun(previewId)} --unlock, then apply again`);
	try {
		return await lockedUpload(write, previewId, staged.staged, caller, journal, identity);
	} finally {
		journal.release(identity);
	}
}

// Adjudication re-stages the identical input, sends nothing, and settles only
// on found placement or, after a reply, a page still at its baseline.
export async function adjudicateUpload(receipt: Receipt, write: WriteInput | null, env: EnvironmentSource, caller: Caller, journal: Journal): Promise<Executed> {
	if (receipt.status !== "sending" && receipt.status !== "unknown") return refused("receipt-settled", "this receipt is already settled; nothing to adjudicate");
	const staged = write === null ? null : stage(write, env);
	if (write === null || staged === null || !staged.ok || write.operation !== receipt.operation || uploadDigest(write, staged.staged) !== receipt.inputDigest) return refused("adjudicate-input-mismatch", "adjudication needs the identical --input and asset bytes the write recorded");
	const proof = await uploadEvidence(write, receipt.baseline, caller);
	if (proof.proof === "completed" || (proof.proof === "baseline" && receipt.replied)) {
		const settled = journal.settle(receipt, proof.proof === "completed" ? { status: "completed", replied: receipt.replied, effects: proof.ids.map((id) => ({ kind: "figma-object" as const, id })) } : { status: "unchanged", replied: true, effects: [] });
		if (settled) return { kind: "recorded", effect: "write-adjudication", data: { runId: receipt.runId, receipt: settled } };
	}
	return refused("evidence-insufficient", "the read-back found neither the placed assets nor, for a request that may still have been in flight, proof of no effect; the receipt stays unresolved and its file stays blocked");
}
