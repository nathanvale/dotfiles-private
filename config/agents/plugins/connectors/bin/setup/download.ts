import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ownedDirectory, stateRoot } from "../private-state.ts";
import { installVerifiedMise, MISE_RELEASE, type MiseInstallResult } from "./mise.ts";
import { installVerifiedOp, OP_RELEASE, type OpInstallResult } from "./op.ts";

export type DownloadFailure = { ok: false; reason: "source-invalid" | "network-transient" | "http-transient" | "http-refused" | "size-refused" | "integrity-refused" | "state-invalid" };
export type ReleaseSource = { localReleaseOrigin?: string };

const LIMITS = { package: 48 * 1024 * 1024, archive: 48 * 1024 * 1024, manifest: 128 * 1024, signature: 4096 } as const;
const TIMEOUT_MS = 45_000;
const MAX_REDIRECTS = 5;
const OFFICIAL_HOSTS = new Set(["cache.agilebits.com", "github.com", "release-assets.githubusercontent.com"]);

function privateStageDirectory(): string | null {
	const root = stateRoot(process.env);
	if (!path.isAbsolute(root)) return null;
	const directory = path.join(root, "connectors", "setup", "downloads");
	let current = path.parse(directory).root;
	for (const segment of directory.slice(current.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		try {
			const entry = lstatSync(current);
			if (entry.isSymbolicLink() || !entry.isDirectory() || (current === root && entry.uid !== os.userInfo().uid)) return null;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
		}
	}
	return ownedDirectory(directory).ok ? directory : null;
}

function releaseUrl(official: string, source?: ReleaseSource): string | null {
	if (!source?.localReleaseOrigin) return official;
	try {
		const local = new URL(source.localReleaseOrigin);
		if (local.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(local.hostname) || local.username || local.password || local.search || local.hash || local.pathname !== "/") return null;
		const upstream = new URL(official);
		return new URL(upstream.pathname, local).href;
	} catch {
		return null;
	}
}

function approvedUrl(candidate: URL, initial: URL): boolean {
	if (candidate.username || candidate.password || candidate.hash) return false;
	if (initial.protocol === "http:") return candidate.protocol === "http:" && candidate.origin === initial.origin;
	return candidate.protocol === "https:" && OFFICIAL_HOSTS.has(candidate.hostname) && !candidate.port;
}

async function fetchApproved(url: string, signal: AbortSignal): Promise<Response | DownloadFailure["reason"]> {
	const initial = new URL(url);
	let current = initial;
	for (let hop = 0; ; hop++) {
		if (!approvedUrl(current, initial)) return "source-invalid";
		const response = await fetch(current, { signal, cache: "no-store", redirect: "manual" });
		if (![301, 302, 303, 307, 308].includes(response.status)) return response;
		const location = response.headers.get("location");
		if (!location || hop >= MAX_REDIRECTS) return "source-invalid";
		try {
			current = new URL(location, current);
		} catch {
			return "source-invalid";
		}
	}
}

function declaredSize(response: Response): number | null {
	const header = response.headers.get("content-length");
	if (header === null) return null;
	return /^\d+$/.test(header) ? Number(header) : Number.NaN;
}

async function writeBoundedBody(body: ReadableStream<Uint8Array>, descriptor: number, maximum: number): Promise<{ size: number; digest: string } | null> {
	const hash = createHash("sha256");
	let size = 0;
	for await (const chunk of body) {
		size += chunk.byteLength;
		if (size > maximum) return null;
		writeSync(descriptor, chunk);
		hash.update(chunk);
	}
	return { size, digest: hash.digest("hex") };
}

async function saveBody(response: Response, file: string, maximum: number, sha256?: string): Promise<DownloadFailure["reason"] | null> {
	if (!response.ok) return response.status === 429 || response.status >= 500 ? "http-transient" : "http-refused";
	if (!response.body) return "integrity-refused";
	const declared = declaredSize(response);
	if (declared !== null && (!Number.isSafeInteger(declared) || declared > maximum)) return "size-refused";
	const descriptor = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try {
		const written = await writeBoundedBody(response.body, descriptor, maximum);
		if (!written) return "size-refused";
		if (written.size === 0 || (declared !== null && written.size !== declared)) return "integrity-refused";
		fsyncSync(descriptor);
		return sha256 && written.digest !== sha256 ? "integrity-refused" : null;
	} finally {
		closeSync(descriptor);
	}
}

async function download(url: string, file: string, maximum: number, sha256?: string): Promise<DownloadFailure["reason"] | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const response = await fetchApproved(url, controller.signal);
		return typeof response === "string" ? response : await saveBody(response, file, maximum, sha256);
	} catch {
		return "network-transient";
	} finally {
		clearTimeout(timer);
	}
}

export async function downloadAndInstallOp(source?: ReleaseSource): Promise<OpInstallResult | DownloadFailure> {
	const url = releaseUrl(OP_RELEASE.url, source);
	if (!url) return { ok: false, reason: "source-invalid" };
	const directory = privateStageDirectory();
	if (!directory) return { ok: false, reason: "state-invalid" };
	const stage = mkdtempSync(path.join(directory, ".op-fetch-"));
	try {
		const file = path.join(stage, "release.pkg");
		const failure = await download(url, file, LIMITS.package, OP_RELEASE.sha256);
		if (failure) return { ok: false, reason: failure };
		return installVerifiedOp({ packageFile: file, stateDirectory: path.join(stateRoot(process.env), "connectors", "setup", "op") });
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}

export async function downloadAndInstallMise(source?: ReleaseSource): Promise<MiseInstallResult | DownloadFailure> {
	const archiveUrl = releaseUrl(MISE_RELEASE.archiveUrl, source);
	const manifestUrl = releaseUrl(MISE_RELEASE.manifestUrl, source);
	const signatureUrl = releaseUrl(MISE_RELEASE.signatureUrl, source);
	if (!archiveUrl || !manifestUrl || !signatureUrl) return { ok: false, reason: "source-invalid" };
	const directory = privateStageDirectory();
	if (!directory) return { ok: false, reason: "state-invalid" };
	const stage = mkdtempSync(path.join(directory, ".mise-fetch-"));
	try {
		const archiveFile = path.join(stage, "release.tar.xz");
		const manifestFile = path.join(stage, "SHASUMS256.txt");
		const signatureFile = path.join(stage, "SHASUMS256.txt.minisig");
		for (const [url, file, maximum, digest] of [[manifestUrl, manifestFile, LIMITS.manifest, undefined], [signatureUrl, signatureFile, LIMITS.signature, undefined], [archiveUrl, archiveFile, LIMITS.archive, MISE_RELEASE.archiveSha256]] as const) {
			const failure = await download(url, file, maximum, digest);
			if (failure) return { ok: false, reason: failure };
		}
		return installVerifiedMise({ archiveFile, manifestFile, signatureFile, stateDirectory: path.join(stateRoot(process.env), "connectors", "setup", "mise") });
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}
