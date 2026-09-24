// Verify official release assets before extraction or promotion.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export const MCPORTER_RELEASE = {
	version: "0.14.0",
	archiveUrl: "https://github.com/openclaw/mcporter/releases/download/v0.14.0/mcporter_0.14.0_darwin_arm64.tar.gz",
	archiveSha256: "4e4a0c579219ffc0da07ed95196c2c25f278b0d432d232c9554ee43118f5150b",
	provenanceSha256: "7a4256c6a3a921e2319386c3142ec33b4f0b5d693af5c652fe97ee884f30f2ab",
	binarySha256: "01d99ede8b6a88dd282eaeda2afb7086dca5bdbc04c05c8c21744703575adb27",
	identifier: "org.openclaw.mcporter",
	teamId: "FWJYW4S8P8",
	commit: "7985e1d27a5f8f00607f10846aeed670c5aa98f3",
} as const;

export type ReleasePolicy = { [K in keyof typeof MCPORTER_RELEASE]: string };
export type ReleaseFailure = "archive-digest-mismatch" | "provenance-invalid" | "archive-inventory-invalid" | "extraction-failed" | "binary-digest-mismatch" | "architecture-invalid" | "signature-invalid" | "notarization-invalid" | "version-invalid";
export type ReleaseVerification = { ok: true } | { ok: false; cause: ReleaseFailure };
export type ReleaseRun = (argv: readonly string[]) => { exitCode: number; stdout: string };

const nativeRun: ReleaseRun = (argv) => {
	const result = Bun.spawnSync([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin" } });
	return { exitCode: result.exitCode, stdout: result.stdout.toString().trim() };
};

function digest(file: string): string | null {
	try {
		return createHash("sha256").update(readFileSync(file)).digest("hex");
	} catch {
		return null;
	}
}

function runClosed(run: ReleaseRun, argv: readonly string[]): { exitCode: number; stdout: string } {
	try {
		return run(argv);
	} catch {
		return { exitCode: 1, stdout: "" };
	}
}

function assetMatches(asset: Record<string, unknown>, release: ReleasePolicy): boolean {
	return asset.sha256 === release.archiveSha256 && asset.platform === "darwin" && asset.arch === "arm64" && asset.identifier === release.identifier && asset.teamId === release.teamId && asset.notarized === true;
}

function signatureMatches(signature: Record<string, unknown>, release: ReleasePolicy): boolean {
	return signature.identity === `Developer ID Application: OpenClaw Foundation (${release.teamId})` && signature.identifier === release.identifier && signature.teamId === release.teamId && signature.hardenedRuntime === true && signature.timestamp === true;
}

function provenanceMatches(file: string, release: ReleasePolicy): boolean {
	if (digest(file) !== release.provenanceSha256) return false;
	try {
		const value: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
		const record = value as Record<string, unknown>;
		const payloads = record.payloads;
		const signature = record.codeSignature;
		const assetName = path.basename(new URL(release.archiveUrl).pathname);
		const asset = Array.isArray(payloads) ? payloads.find((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && entry.name === assetName) : undefined;
		if (typeof signature !== "object" || signature === null || Array.isArray(signature) || !asset) return false;
		return record.repository === "openclaw/mcporter" && record.version === release.version && record.tag === `v${release.version}` && record.commit === release.commit && record.sourceTree === "clean" && Array.isArray(record.releaseAssets) && record.releaseAssets.includes(assetName) && assetMatches(asset, release) && signatureMatches(signature as Record<string, unknown>, release);
	} catch {
		return false;
	}
}

// Extraction lives behind the archive and provenance checks; the caller only
// receives a candidate binary after all checks pass.
export function verifyAndExtractMcporterRelease(archive: string, provenance: string, candidateDir: string, run: ReleaseRun = nativeRun): ReleaseVerification {
	return verifyAndExtractWithPolicy(archive, provenance, candidateDir, MCPORTER_RELEASE, run);
}

// Recheck a selected copy on every use. A marker alone never authorizes execution.
export function verifyInstalledMcporter(binary: string, run: ReleaseRun = nativeRun): ReleaseVerification {
	return verifySelectedBinary(binary, MCPORTER_RELEASE, run);
}

function verifySelectedBinary(binary: string, release: ReleasePolicy, run: ReleaseRun): ReleaseVerification {
	if (digest(binary) !== release.binarySha256) return { ok: false, cause: "binary-digest-mismatch" };
	const arch = runClosed(run, ["/usr/bin/lipo", "-archs", binary]);
	if (arch.exitCode !== 0 || arch.stdout !== "arm64") return { ok: false, cause: "architecture-invalid" };
	const requirement = `identifier "${release.identifier}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${release.teamId}"`;
	if (runClosed(run, ["/usr/bin/codesign", "--verify", "--strict", `-R=${requirement}`, "--verbose=2", binary]).exitCode !== 0) return { ok: false, cause: "signature-invalid" };
	if (runClosed(run, ["/usr/bin/codesign", "--verify", "--strict", "--check-notarization", "-R=notarized", "--verbose=2", binary]).exitCode !== 0) return { ok: false, cause: "notarization-invalid" };
	const version = runClosed(run, [binary, "--version"]);
	if (version.exitCode !== 0 || version.stdout !== release.version) return { ok: false, cause: "version-invalid" };
	return { ok: true };
}

// Fixture policy is internal to tests. Production callers use the pinned wrapper.
export function verifyAndExtractWithPolicy(archive: string, provenance: string, candidateDir: string, release: ReleasePolicy, run: ReleaseRun): ReleaseVerification {
	if (digest(archive) !== release.archiveSha256) return { ok: false, cause: "archive-digest-mismatch" };
	if (!provenanceMatches(provenance, release)) return { ok: false, cause: "provenance-invalid" };
	const listing = runClosed(run, ["/usr/bin/tar", "-tzf", archive]);
	if (listing.exitCode !== 0 || listing.stdout !== "mcporter") return { ok: false, cause: "archive-inventory-invalid" };
	if (runClosed(run, ["/usr/bin/tar", "-xzf", archive, "-C", candidateDir, "mcporter"]).exitCode !== 0) return { ok: false, cause: "extraction-failed" };
	const binary = path.join(candidateDir, "mcporter");
	return verifySelectedBinary(binary, release, run);
}
