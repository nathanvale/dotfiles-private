import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ownedDirectory, stateRoot, writePrivateFile } from "../private-state.ts";

// Locally measured 1Password 2.39.0 universal installer and extracted binary.
// Apple signature and notarization verification provide independent provenance.
export const OP_RELEASE = {
	version: "2.39.0",
	url: "https://cache.agilebits.com/dist/1P/op2/pkg/v2.39.0/op_apple_universal_v2.39.0.pkg",
	sha256: "bde261468f3232484e2738e337e39c674c11a4537f4c6ed314f933eae558a405",
	team: "2BUA8C4S2C",
	identifier: "com.1password.op",
	binarySha256: "7e17cbf4052393d2c55a59a7c3d05f0bbcdcb079d57785cff682f3bc994ba8ce",
} as const;

export type OpInstallResult = { ok: true; executable: string } | { ok: false; reason: "package-invalid" | "signature-invalid" | "state-invalid" | "verifier-unavailable" | "install-failed" };
export type OpInstallInput = { packageFile: string; stateDirectory: string };

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const environment = { PATH: "/usr/bin:/bin", HOME: "/var/empty" };

function run(executable: string, args: string[], cwd?: string, input?: Buffer) {
	return spawnSync(executable, args, { cwd, input, env: environment, encoding: "utf8", timeout: 30_000, maxBuffer: 128 * 1024 * 1024 });
}

function existingAncestorsAreDirectories(directory: string): boolean {
	let current = path.parse(directory).root;
	for (const segment of directory.slice(current.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		try {
			const entry = lstatSync(current);
			if (entry.isSymbolicLink() || !entry.isDirectory()) return false;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
		}
	}
	return true;
}

function stateRootIsOwned(root: string): boolean {
	try {
		const entry = lstatSync(root);
		return entry.uid === os.userInfo().uid && entry.isDirectory() && !entry.isSymbolicLink();
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

function statePathIsPrivate(directory: string): boolean {
	const root = stateRoot(process.env);
	if (!path.isAbsolute(root) || directory !== path.join(root, "connectors", "setup", "op")) return false;
	if (!existingAncestorsAreDirectories(directory) || !stateRootIsOwned(root)) return false;
	return true;
}

function stateIsPrivate(directory: string): boolean {
	if (!statePathIsPrivate(directory)) return false;
	return ownedDirectory(directory).ok;
}

function verifyInstaller(pkg: string): OpInstallResult | null {
	const signature = run("/usr/sbin/pkgutil", ["--check-signature", pkg]);
	if (signature.error) return { ok: false, reason: "verifier-unavailable" };
	if (signature.status !== 0 || !signature.stdout.includes("Status: signed by a developer certificate issued by Apple for distribution") || !signature.stdout.includes("Notarization: trusted by the Apple notary service") || !signature.stdout.includes(`Developer ID Installer: AgileBits Inc. (${OP_RELEASE.team})`)) return { ok: false, reason: "signature-invalid" };
	const assessed = run("/usr/sbin/spctl", ["--assess", "--type", "install", "-vv", pkg]);
	if (assessed.error) return { ok: false, reason: "verifier-unavailable" };
	if (assessed.status !== 0 || !assessed.stderr.includes("source=Notarized Developer ID") || !assessed.stderr.includes(`origin=Developer ID Installer: AgileBits Inc. (${OP_RELEASE.team})`)) return { ok: false, reason: "signature-invalid" };
	return null;
}

function packageInventoryIsOpOnly(component: string): boolean {
	if (readdirSync(component).sort().join("\n") !== "Bom\nPackageInfo\nPayload") return false;
	const info = readFileSync(path.join(component, "PackageInfo"), "utf8");
	if (!info.includes(`identifier="${OP_RELEASE.identifier}"`) || !info.includes(`version="${OP_RELEASE.version}"`) || !info.includes('postinstall-action="none"')) return false;
	const bom = run("/usr/bin/lsbom", ["-f", path.join(component, "Bom")]);
	return bom.status === 0 && bom.stdout.trim().split("\n").length === 1 && bom.stdout.startsWith("./op\t");
}

function verifyBinary(op: string): OpInstallResult | string {
	if (!lstatSync(op).isFile() || digest(readFileSync(op)) !== OP_RELEASE.binarySha256) return { ok: false, reason: "package-invalid" };
	const verified = run("/usr/bin/codesign", ["--verify", "--all-architectures", "--strict", "-v", op]);
	const identity = run("/usr/bin/codesign", ["-dv", "--verbose=4", op]);
	if (verified.status !== 0 || identity.status !== 0 || !identity.stderr.includes(`TeamIdentifier=${OP_RELEASE.team}`) || !identity.stderr.includes(`Identifier=${OP_RELEASE.identifier}`)) return { ok: false, reason: "signature-invalid" };
	return op;
}

function extractVerifiedBinary(pkg: string, stage: string): OpInstallResult | string {
	const expanded = path.join(stage, "expanded");
	const expansion = run("/usr/sbin/pkgutil", ["--expand", pkg, expanded]);
	if (expansion.error) return { ok: false, reason: "verifier-unavailable" };
	if (expansion.status !== 0) return { ok: false, reason: "package-invalid" };
	try {
		const component = path.join(expanded, "op.pkg");
		if (!packageInventoryIsOpOnly(component)) return { ok: false, reason: "package-invalid" };
		const payload = spawnSync("/usr/bin/gzip", ["-dc", path.join(component, "Payload")], { env: environment, timeout: 30_000, maxBuffer: 128 * 1024 * 1024 });
		if (payload.status !== 0 || !payload.stdout) return { ok: false, reason: "package-invalid" };
		const inventory = run("/usr/bin/cpio", ["-it"], undefined, payload.stdout);
		if (inventory.status !== 0 || inventory.stdout.trim().split("\n").sort().join("\n") !== ".\n./op") return { ok: false, reason: "package-invalid" };
		const extraction = path.join(stage, "extract");
		if (!ownedDirectory(extraction).ok) return { ok: false, reason: "install-failed" };
		const unpacked = run("/usr/bin/cpio", ["-idm", "--no-preserve-owner"], extraction, payload.stdout);
		if (unpacked.status !== 0) return { ok: false, reason: "package-invalid" };
		return verifyBinary(path.join(extraction, "op"));
	} catch {
		return { ok: false, reason: "package-invalid" };
	}
}

// The caller cannot supply a release identity. Every package operation uses
// the private copy of the bytes checked against the fixed release digest.
export function installVerifiedOp(input: OpInstallInput): OpInstallResult {
	if (!statePathIsPrivate(input.stateDirectory)) return { ok: false, reason: "state-invalid" };
	let stage: string | undefined;
	try {
		const bytes = readFileSync(input.packageFile);
		if (digest(bytes) !== OP_RELEASE.sha256) return { ok: false, reason: "package-invalid" };
		if (!stateIsPrivate(input.stateDirectory)) return { ok: false, reason: "state-invalid" };
		stage = mkdtempSync(path.join(input.stateDirectory, ".op-stage-"));
		const pkg = path.join(stage, "release.pkg");
		writeFileSync(pkg, bytes, { mode: 0o600, flag: "wx" });
		const signatureFailure = verifyInstaller(pkg);
		if (signatureFailure) return signatureFailure;
		const extracted = extractVerifiedBinary(pkg, stage);
		if (typeof extracted !== "string") return extracted;
		const revision = path.join(input.stateDirectory, `op-${OP_RELEASE.version}-${OP_RELEASE.binarySha256}`);
		chmodSync(extracted, 0o700);
		try {
			linkSync(extracted, revision); // Atomic no-replace publication.
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !lstatSync(revision).isFile() || digest(readFileSync(revision)) !== OP_RELEASE.binarySha256) return { ok: false, reason: "install-failed" };
		}
		const selected = writePrivateFile(path.join(input.stateDirectory, "op-selected"), path.basename(revision));
		if (!selected.ok) return { ok: false, reason: "install-failed" };
		return { ok: true, executable: revision };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && !stage) return { ok: false, reason: "package-invalid" };
		return { ok: false, reason: "install-failed" };
	} finally {
		if (stage) rmSync(stage, { recursive: true, force: true });
	}
}
