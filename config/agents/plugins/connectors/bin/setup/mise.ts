import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ownedDirectory, stateRoot, writePrivateFile } from "../private-state.ts";

// The public key and both digests are fixed plugin trust anchors. The archive
// and contained binary have distinct entries in the signed release manifest.
export const MISE_RELEASE = {
	version: "2026.9.12",
	archiveName: "mise-v2026.9.12-macos-arm64.tar.xz",
	archiveUrl: "https://github.com/jdx/mise/releases/download/v2026.9.12/mise-v2026.9.12-macos-arm64.tar.xz",
	manifestUrl: "https://github.com/jdx/mise/releases/download/v2026.9.12/SHASUMS256.txt",
	signatureUrl: "https://github.com/jdx/mise/releases/download/v2026.9.12/SHASUMS256.txt.minisig",
	publicKey: "RWTC3g8W3z4RZK3V3qv7fa1QY4JEWyBtqIHW+85QlJpZc5yG+uNYNBSZ",
	archiveSha256: "01b15ea733709a2000a801533203e99c1490d9a3c13d45c8eb90ccefd0bd21f3",
	binarySha256: "f20d7cc555a5b0ee7b8a504acbc2583be1b0848d64115cfbe84119ceb705025b",
} as const;

export type MiseInstallInput = { archiveFile: string; manifestFile: string; signatureFile: string; stateDirectory: string };
export type MiseInstallResult = { ok: true; executable: string } | { ok: false; reason: "artifact-invalid" | "signature-invalid" | "state-invalid" | "extract-failed" | "install-failed" };

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const keyBytes = Buffer.from(MISE_RELEASE.publicKey, "base64");
const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), keyBytes.subarray(10)]), format: "der", type: "spki" });

function privateStatePath(directory: string): boolean {
	const root = stateRoot(process.env);
	if (!path.isAbsolute(root) || directory !== path.join(root, "connectors", "setup", "mise")) return false;
	let current = path.parse(directory).root;
	for (const segment of directory.slice(current.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		try {
			const entry = lstatSync(current);
			if (entry.isSymbolicLink() || !entry.isDirectory()) return false;
			if (current === root && entry.uid !== os.userInfo().uid) return false;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
		}
	}
	return true;
}

function signedManifestIsValid(manifest: Buffer, signatureFile: Buffer): boolean {
	const lines = signatureFile.toString("utf8").trimEnd().split("\n");
	if (lines.length !== 4 || !lines[0]?.startsWith("untrusted comment: ") || !lines[2]?.startsWith("trusted comment: ")) return false;
	const signed = Buffer.from(lines[1] ?? "", "base64");
	const commentSignature = Buffer.from(lines[3] ?? "", "base64");
	if (keyBytes.length !== 42 || signed.length !== 74 || commentSignature.length !== 64) return false;
	if (keyBytes.toString("ascii", 0, 2) !== "Ed" || signed.toString("ascii", 0, 2) !== "ED") return false;
	if (!keyBytes.subarray(2, 10).equals(signed.subarray(2, 10))) return false;
	const contentHash = createHash("blake2b512").update(manifest).digest();
	if (!verify(null, contentHash, publicKey, signed.subarray(10))) return false;
	const trustedComment = Buffer.from(lines[2].slice("trusted comment: ".length));
	return verify(null, Buffer.concat([signed.subarray(10), trustedComment]), publicKey, commentSignature);
}

function manifestHasPinnedArtifacts(manifest: Buffer): boolean {
	const lines = manifest.toString("utf8").trimEnd().split("\n");
	const archiveLine = `${MISE_RELEASE.archiveSha256}  ./mise-v${MISE_RELEASE.version}-macos-arm64.tar.xz`;
	const binaryLine = `${MISE_RELEASE.binarySha256}  ./mise-v${MISE_RELEASE.version}-macos-arm64`;
	return lines.filter((line) => line === archiveLine).length === 1 && lines.filter((line) => line === binaryLine).length === 1;
}

function publishRevision(staged: string, directory: string): MiseInstallResult {
	const revision = path.join(directory, `mise-${MISE_RELEASE.version}-${MISE_RELEASE.binarySha256}`);
	try {
		linkSync(staged, revision);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !lstatSync(revision).isFile() || digest(readFileSync(revision)) !== MISE_RELEASE.binarySha256) return { ok: false, reason: "install-failed" };
	}
	if (!writePrivateFile(path.join(directory, "mise-selected"), path.basename(revision)).ok) return { ok: false, reason: "install-failed" };
	return { ok: true, executable: revision };
}

function installPinnedArchive(archive: Buffer, directory: string): MiseInstallResult {
	if (!privateStatePath(directory) || !ownedDirectory(directory).ok) return { ok: false, reason: "state-invalid" };
	let stage: string | undefined;
	try {
		stage = mkdtempSync(path.join(directory, ".mise-stage-"));
		const stagedArchive = path.join(stage, "release.tar.xz");
		writeFileSync(stagedArchive, archive, { mode: 0o600, flag: "wx" });
		const extracted = spawnSync("/usr/bin/tar", ["-xOf", stagedArchive, "mise/bin/mise"], { env: { PATH: "/usr/bin:/bin", HOME: "/var/empty" }, timeout: 30_000, maxBuffer: 128 * 1024 * 1024 });
		if (extracted.status !== 0 || !extracted.stdout || digest(extracted.stdout) !== MISE_RELEASE.binarySha256) return { ok: false, reason: "extract-failed" };
		const staged = path.join(stage, "mise");
		writeFileSync(staged, extracted.stdout, { mode: 0o700, flag: "wx" });
		chmodSync(staged, 0o700);
		return publishRevision(staged, directory);
	} catch {
		return { ok: false, reason: "install-failed" };
	} finally {
		if (stage) rmSync(stage, { recursive: true, force: true });
	}
}

// This core accepts local artifact paths for the future explicit setup route.
// Caller-provided manifests and signatures are data, never trust anchors.
export function installVerifiedMise(input: MiseInstallInput): MiseInstallResult {
	if (!privateStatePath(input.stateDirectory)) return { ok: false, reason: "state-invalid" };
	let archive: Buffer;
	let manifest: Buffer;
	let signature: Buffer;
	try {
		archive = readFileSync(input.archiveFile);
		manifest = readFileSync(input.manifestFile);
		signature = readFileSync(input.signatureFile);
	} catch {
		return { ok: false, reason: "artifact-invalid" };
	}
	if (!signedManifestIsValid(manifest, signature)) return { ok: false, reason: "signature-invalid" };
	if (!manifestHasPinnedArtifacts(manifest) || digest(archive) !== MISE_RELEASE.archiveSha256) return { ok: false, reason: "artifact-invalid" };
	return installPinnedArchive(archive, input.stateDirectory);
}
