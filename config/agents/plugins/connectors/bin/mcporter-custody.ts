// Plugin-owned MCPorter selection. The only normal download is first use.
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { MCPORTER_RELEASE, verifyAndExtractMcporterRelease, verifyInstalledMcporter } from "./mcporter-release.ts";
import { ownedDirectory, stateRoot } from "./private-state.ts";
import type { EnvironmentSource } from "./safe-environment.ts";

export type McporterSelection = { ok: true; binary: string; bootstrapped: boolean; recovered?: true } | { ok: false; cause: string; repair: string; bootstrapped?: true; recovered?: true; uncertain?: true };
export type RepairResult = { ok: true; repaired: boolean; recovered: boolean } | { ok: false; cause: string; effect: "unchanged" | "recovered" | "completed" | "recovered-and-completed" | "unknown" };
const repair = "Run connectors deps repair mcporter";
export const lockRecovery = "Independently verify the .selection.lock owner identity and that its process has ended, then immediately recheck the lock before removing it and retrying the same command";

function ownedRoot(env: EnvironmentSource): string {
	return path.join(stateRoot(env), "connectors", "mcporter");
}

function selected(root: string, revision = "current"): McporterSelection | null {
	const current = path.join(root, revision);
	if (!existsSync(current)) return null;
	try {
		const directory = lstatSync(current);
		if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== os.userInfo().uid || (directory.mode & 0o777) !== 0o700) throw new Error("invalid directory");
		const marker = path.join(current, "release.json");
		const markerStat = lstatSync(marker);
		if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.uid !== os.userInfo().uid || (markerStat.mode & 0o777) !== 0o600) throw new Error("invalid marker");
		const value: unknown = JSON.parse(readFileSync(marker, "utf8"));
		if (typeof value !== "object" || value === null || typeof (value as { version?: unknown }).version !== "string") throw new Error("invalid marker");
		const binary = path.join(current, "mcporter");
		const binaryStat = lstatSync(binary);
		if (!binaryStat.isFile() || binaryStat.isSymbolicLink() || binaryStat.uid !== os.userInfo().uid || (binaryStat.mode & 0o777) !== 0o700) throw new Error("invalid binary");
		const verified = verifyInstalledMcporter(binary);
		if (!verified.ok) return { ok: false, cause: verified.cause, repair };
		return (value as { version: string }).version === MCPORTER_RELEASE.version
			? { ok: true, binary, bootstrapped: false }
			: { ok: false, cause: "version-mismatch", repair };
	} catch {
		return { ok: false, cause: "selected-release-invalid", repair };
	}
}

// shlock uses an atomic hard link and checks process liveness before reclaiming
// a dead owner's lock. No elapsed-time heuristic may evict a live downloader.
async function withSelectionLock<T>(root: string, action: () => Promise<T>): Promise<T> {
	const lock = path.join(root, ".selection.lock");
	const deadline = Date.now() + 30_000;
	for (;;) {
		if (existsSync(lock)) {
			const stat = lstatSync(lock);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== os.userInfo().uid) throw new Error("selection-lock-invalid");
		}
		try {
			execFileSync("/usr/bin/shlock", ["-f", lock, "-p", String(process.pid)], { stdio: "ignore", timeout: 2000 });
			break;
		} catch {
			if (Date.now() >= deadline) throw new Error("selection-lock-busy");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	try {
		chmodSync(lock, 0o600);
		return await action();
	} finally {
		const stat = lstatSync(lock);
		if (stat.isFile() && !stat.isSymbolicLink() && stat.uid === os.userInfo().uid && readFileSync(lock, "utf8").trim() === String(process.pid)) rmSync(lock);
	}
}

export type OfficialAsset = { url: string; target: string; maxBytes: number };

// First use runs under the selection lock, so a stalled or oversized download
// must fail closed instead of holding the lock for the life of the process.
const downloadTimeoutMs = 120_000;

async function saveBounded(asset: OfficialAsset, signal: AbortSignal): Promise<void> {
	const response = await fetch(asset.url, { redirect: "follow", signal });
	if (!response.ok || !response.body) throw new Error("download-failed");
	if (Number(response.headers.get("content-length")) > asset.maxBytes) throw new Error("download-too-large");
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of response.body) {
		size += chunk.byteLength;
		if (size > asset.maxBytes) throw new Error("download-too-large");
		chunks.push(chunk);
	}
	writeFileSync(asset.target, Buffer.concat(chunks), { mode: 0o600 });
}

// One deadline covers every asset. The first failure aborts its siblings so no
// request outlives the refusal.
export async function downloadOfficial(assets: readonly OfficialAsset[], timeoutMs = downloadTimeoutMs): Promise<void> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("download-timeout")), timeoutMs);
	try {
		await Promise.all(assets.map((asset) => saveBounded(asset, controller.signal).catch((error: unknown) => {
			controller.abort(error);
			throw error;
		})));
	} finally {
		clearTimeout(timer);
	}
}

const officialProvenanceUrl = "https://github.com/openclaw/mcporter/releases/download/v0.14.0/provenance.json";

// Process-test seam: an http origin on 127.0.0.1 replaces only the scheme,
// host, and port of each official asset URL and shortens the deadline. The
// production pins and provenance checks still decide acceptance. Any other
// value refuses before a request, so the first request always targets
// 127.0.0.1; fetch still follows redirects that the loopback server returns.
const loopbackTimeoutMs = 3_000;

function officialDownload(env: EnvironmentSource): { rebase: (url: string) => string; timeoutMs: number } {
	const value = env.CONNECTORS_TEST_MCPORTER_ORIGIN;
	if (!value) return { rebase: (url) => url, timeoutMs: downloadTimeoutMs };
	const origin = URL.canParse(value) ? new URL(value) : null;
	if (!origin || origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash) throw new Error("release-origin-invalid");
	return { rebase: (url) => new URL(new URL(url).pathname, origin).href, timeoutMs: loopbackTimeoutMs };
}

async function verifiedStaging(root: string, env: EnvironmentSource): Promise<string> {
	const staging = mkdtempSync(path.join(root, ".staging-"));
	try {
		chmodSync(staging, 0o700);
		const archive = path.join(staging, "release.tar.gz");
		const provenance = path.join(staging, "provenance.json");
		// Local process fixtures supply byte-identical official artifacts. The
		// release verifier applies the same production pins to either source.
		const fixture = env.CONNECTORS_TEST_RELEASE_DIR;
		if (fixture) {
			copyFileSync(path.join(fixture, "mcporter_0.14.0_darwin_arm64.tar.gz"), archive);
			copyFileSync(path.join(fixture, "provenance.json"), provenance);
		} else {
			const { rebase, timeoutMs } = officialDownload(env);
			await downloadOfficial([
				{ url: rebase(MCPORTER_RELEASE.archiveUrl), target: archive, maxBytes: 64 * 1024 * 1024 },
				{ url: rebase(officialProvenanceUrl), target: provenance, maxBytes: 64 * 1024 },
			], timeoutMs);
		}
		const result = verifyAndExtractMcporterRelease(archive, provenance, staging);
		if (!result.ok) throw new Error(result.cause);
		rmSync(archive);
		rmSync(provenance);
		chmodSync(path.join(staging, "mcporter"), 0o700);
		writeFileSync(path.join(staging, "release.json"), JSON.stringify({ version: MCPORTER_RELEASE.version }), { mode: 0o600 });
		return staging;
	} catch (error) {
		rmSync(staging, { recursive: true, force: true });
		throw error;
	}
}

// An interrupted rename sequence leaves the previous selection in this
// plugin-owned slot. Restore it before an ordinary command can bootstrap.
function restoreInterruptedRepair(root: string): boolean {
	const current = path.join(root, "current");
	const previous = path.join(root, ".previous");
	if (existsSync(current) || !existsSync(previous)) return false;
	if (!intactPrevious(root)) throw new Error("previous-invalid");
	renameSync(previous, current);
	return true;
}

function intactPrevious(root: string): boolean {
	const prior = selected(root, ".previous");
	return prior?.ok === true || prior?.cause === "version-mismatch";
}

function ownedSelectionDirectory(root: string, name: "current" | ".previous"): boolean {
	try {
		const stat = lstatSync(path.join(root, name));
		return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === os.userInfo().uid && (stat.mode & 0o777) === 0o700;
	} catch { return false; }
}

function reconcilePrevious(root: string): string | null {
	const current = path.join(root, "current");
	const previous = path.join(root, ".previous");
	if (!existsSync(previous)) return null;
	if (!existsSync(current)) return "selected-release-missing";
	if (!selected(root)?.ok) {
		if (!intactPrevious(root)) return "recovery-required";
		if (!ownedSelectionDirectory(root, "current")) return "recovery-required";
		try { rmSync(current, { recursive: true }); renameSync(previous, current); } catch { return "recovery-failed"; }
		return "recovered";
	}
	if (!ownedSelectionDirectory(root, ".previous")) return "recovery-required";
	try { rmSync(previous, { recursive: true }); } catch { return null; }
	return null;
}

function rollbackRepair(root: string): boolean {
	const current = path.join(root, "current");
	const previous = path.join(root, ".previous");
	try {
		if (!intactPrevious(root)) return false;
		if (existsSync(current)) {
			if (!ownedSelectionDirectory(root, "current")) return false;
			rmSync(current, { recursive: true });
		}
		renameSync(previous, current);
		return true;
	} catch {
		return false;
	}
}

function recoverBeforeRepair(root: string): { ok: true; restored: boolean } | { ok: false; cause: string } {
	let restored = false;
	try {
		restored = restoreInterruptedRepair(root);
	} catch {
		return { ok: false, cause: "recovery-failed" };
	}
	const reconciliation = reconcilePrevious(root);
	if (reconciliation && reconciliation !== "recovered") return { ok: false, cause: reconciliation };
	restored ||= reconciliation === "recovered";
	return { ok: true, restored };
}

function failedReplacement(root: string, restored: boolean, moved: boolean, committed: boolean): RepairResult {
	if (committed) return { ok: false, cause: "post-commit-failed", effect: restored ? "recovered-and-completed" : "completed" };
	if (moved && existsSync(path.join(root, ".previous")) && !rollbackRepair(root)) return { ok: false, cause: "recovery-failed", effect: "unknown" };
	return { ok: false, cause: "repair-failed", effect: restored ? "recovered" : "unchanged" };
}

async function replaceSelected(root: string, env: EnvironmentSource, restored: boolean): Promise<RepairResult> {
	const current = path.join(root, "current");
	const previous = path.join(root, ".previous");
	let staging = "";
	let moved = false;
	let committed = false;
	try {
		staging = await verifiedStaging(root, env);
		renameSync(current, previous);
		moved = true;
		renameSync(staging, current);
		staging = "";
		const verified = selected(root);
		if (!verified?.ok) throw new Error("selected-release-invalid");
		committed = true;
		try { if (ownedSelectionDirectory(root, ".previous")) rmSync(previous, { recursive: true }); } catch { /* Selection committed; a later invocation may clean up. */ }
		return { ok: true, repaired: true, recovered: restored };
	} catch {
		return failedReplacement(root, restored, moved, committed);
	} finally {
		if (staging) try { rmSync(staging, { recursive: true, force: true }); } catch { /* A failed staging cleanup cannot alter selection. */ }
	}
}

async function repairLocked(root: string, env: EnvironmentSource): Promise<RepairResult> {
	const recovery = recoverBeforeRepair(root);
	if (!recovery.ok) return { ok: false, cause: recovery.cause, effect: "unknown" };
	if (!ownedSelectionDirectory(root, "current")) return { ok: false, cause: "selected-release-invalid", effect: recovery.restored ? "recovered" : "unchanged" };
	return replaceSelected(root, env, recovery.restored);
}

export async function repairMcporter(env: EnvironmentSource = process.env): Promise<RepairResult> {
	const root = ownedRoot(env);
	if (!ownedDirectory(root).ok) return { ok: false, cause: "state-invalid", effect: "unchanged" };
	try { return await withSelectionLock(root, () => repairLocked(root, env)); }
	catch { return { ok: false, cause: "selection-lock-failed", effect: "unknown" }; }
}

async function bootstrapMissing(root: string, env: EnvironmentSource): Promise<McporterSelection> {
	let staging = "";
	let promoted = false;
	try {
		staging = await verifiedStaging(root, env);
		renameSync(staging, path.join(root, "current"));
		staging = "";
		promoted = true;
		const promotedSelection = selected(root);
		return promotedSelection?.ok ? { ...promotedSelection, bootstrapped: true } : { ok: false, cause: promotedSelection?.ok === false ? promotedSelection.cause : "selected-release-invalid", repair, bootstrapped: true };
	} catch {
		if (promoted) return { ok: false, cause: "post-promotion-failed", repair, bootstrapped: true };
		return selected(root) ?? { ok: false, cause: "bootstrap-failed", repair };
	} finally {
		if (staging) try { rmSync(staging, { recursive: true, force: true }); } catch { /* Selection is unchanged or already committed. */ }
	}
}

async function ensureLocked(root: string, env: EnvironmentSource): Promise<McporterSelection> {
	let recovered = false;
	try { recovered = restoreInterruptedRepair(root); } catch { return { ok: false, cause: "recovery-failed", repair, uncertain: true }; }
	const reconciliation = reconcilePrevious(root);
	if (reconciliation && reconciliation !== "recovered") return { ok: false, cause: reconciliation, repair, uncertain: true, ...(recovered ? { recovered: true as const } : {}) };
	recovered ||= reconciliation === "recovered";
	const existing = selected(root);
	if (existing) return { ...existing, ...(recovered ? { recovered: true as const } : {}) };
	return bootstrapMissing(root, env);
}

export async function ensureMcporter(env: EnvironmentSource = process.env): Promise<McporterSelection> {
	const root = ownedRoot(env);
	if (!ownedDirectory(root).ok) return { ok: false, cause: "state-invalid", repair };
	try { return await withSelectionLock(root, () => ensureLocked(root, env)); }
	catch { return { ok: false, cause: "selection-lock-failed", repair: lockRecovery, uncertain: true }; }
}
