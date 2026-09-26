import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MCPORTER_RELEASE, verifyAndExtractWithPolicy, verifyAndExtractMcporterRelease, type ReleaseRun } from "../bin/mcporter-release.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const signatureRequirement = 'identifier "org.openclaw.mcporter" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "FWJYW4S8P8"';

test("official policy pins archive, provenance, binary, and signer independently", () => {
	expect(MCPORTER_RELEASE.version).toBe("0.14.0");
	expect(MCPORTER_RELEASE.archiveSha256).toBe("4e4a0c579219ffc0da07ed95196c2c25f278b0d432d232c9554ee43118f5150b");
	expect(MCPORTER_RELEASE.provenanceSha256).toBe("7a4256c6a3a921e2319386c3142ec33b4f0b5d693af5c652fe97ee884f30f2ab");
	expect(MCPORTER_RELEASE.binarySha256).toBe("01d99ede8b6a88dd282eaeda2afb7086dca5bdbc04c05c8c21744703575adb27");
	expect(MCPORTER_RELEASE.commit).toBe("7985e1d27a5f8f00607f10846aeed670c5aa98f3");
});

function fixture() {
	const root = mkdtempSync(path.join(os.tmpdir(), "connectors-release-test-"));
	const archive = path.join(root, "archive.tar.gz");
	const provenance = path.join(root, "provenance.json");
	const binary = path.join(root, "mcporter");
	const archiveBytes = "test-owned archive";
	const binaryBytes = "test-owned arm64 executable";
	writeFileSync(archive, archiveBytes);
	const metadata = JSON.stringify({
		repository: "openclaw/mcporter", version: "0.14.0", tag: "v0.14.0", commit: "7985e1d27a5f8f00607f10846aeed670c5aa98f3", sourceTree: "clean",
		releaseAssets: ["mcporter_0.14.0_darwin_arm64.tar.gz"],
		codeSignature: { identity: "Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)", identifier: "org.openclaw.mcporter", teamId: "FWJYW4S8P8", hardenedRuntime: true, timestamp: true },
		payloads: [{ name: "mcporter_0.14.0_darwin_arm64.tar.gz", sha256: sha(archiveBytes), platform: "darwin", arch: "arm64", identifier: "org.openclaw.mcporter", teamId: "FWJYW4S8P8", notarized: true }],
	});
	writeFileSync(provenance, metadata);
	const policy = { ...MCPORTER_RELEASE, archiveSha256: sha(archiveBytes), provenanceSha256: sha(metadata), binarySha256: sha(binaryBytes) };
	const calls: string[][] = [];
	const run: ReleaseRun = (argv) => {
		calls.push([...argv]);
		if (argv[0] === "/usr/bin/tar" && argv[1] === "-xzf") writeFileSync(binary, binaryBytes);
		return { exitCode: 0, stdout: argv[1] === "-tzf" ? "mcporter" : argv[0] === "/usr/bin/lipo" ? "arm64" : argv[0] === binary ? "0.14.0" : "" };
	};
	return { root, archive, provenance, binary, policy, calls, run, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("digest and provenance refuse before extraction", () => {
	const f = fixture();
	try {
		writeFileSync(f.archive, "wrong archive");
		expect(verifyAndExtractWithPolicy(f.archive, f.provenance, f.root, f.policy, f.run)).toEqual({ ok: false, cause: "archive-digest-mismatch" });
		expect(f.calls).toHaveLength(0);
		writeFileSync(f.archive, "test-owned archive");
		writeFileSync(f.provenance, "wrong provenance");
		expect(verifyAndExtractWithPolicy(f.archive, f.provenance, f.root, f.policy, f.run)).toEqual({ ok: false, cause: "provenance-invalid" });
		expect(f.calls).toHaveLength(0);
	} finally { f.dispose(); }
});

test("pinned provenance must name the selected archive bytes and official arm64 asset", () => {
	const f = fixture();
	try {
		const mismatched = JSON.parse(readFileSync(f.provenance, "utf8")) as { payloads: Array<{ sha256: string; arch: string }>; codeSignature: { identity: string } };
		mismatched.payloads[0]!.sha256 = "another-release";
		const text = JSON.stringify(mismatched);
		writeFileSync(f.provenance, text);
		expect(verifyAndExtractWithPolicy(f.archive, f.provenance, f.root, { ...f.policy, provenanceSha256: sha(text) }, f.run)).toEqual({ ok: false, cause: "provenance-invalid" });
		expect(f.calls).toHaveLength(0);
		mismatched.payloads[0]!.sha256 = f.policy.archiveSha256;
		mismatched.payloads[0]!.arch = "x86_64";
		const wrongArch = JSON.stringify(mismatched);
		writeFileSync(f.provenance, wrongArch);
		expect(verifyAndExtractWithPolicy(f.archive, f.provenance, f.root, { ...f.policy, provenanceSha256: sha(wrongArch) }, f.run)).toEqual({ ok: false, cause: "provenance-invalid" });
		expect(f.calls).toHaveLength(0);
		mismatched.payloads[0]!.arch = "arm64";
		mismatched.codeSignature.identity = "Developer ID Application: Someone Else (FWJYW4S8P8)";
		const wrongSigner = JSON.stringify(mismatched);
		writeFileSync(f.provenance, wrongSigner);
		expect(verifyAndExtractWithPolicy(f.archive, f.provenance, f.root, { ...f.policy, provenanceSha256: sha(wrongSigner) }, f.run)).toEqual({ ok: false, cause: "provenance-invalid" });
		expect(f.calls).toHaveLength(0);
	} finally { f.dispose(); }
});

test("exact Apple signature and notarization commands gate candidate success", () => {
	const f = fixture();
	try {
		expect(verifyAndExtractWithPolicy(f.archive, f.provenance, f.root, f.policy, f.run)).toEqual({ ok: true });
		expect(readFileSync(f.binary, "utf8")).toBe("test-owned arm64 executable");
		expect(f.calls).toContainEqual(["/usr/bin/codesign", "--verify", "--strict", `-R=${signatureRequirement}`, "--verbose=2", f.binary]);
		expect(f.calls).toContainEqual(["/usr/bin/codesign", "--verify", "--strict", "--check-notarization", "-R=notarized", "--verbose=2", f.binary]);
		for (const [needle, cause] of [["-R=" + signatureRequirement, "signature-invalid"], ["--check-notarization", "notarization-invalid"]] as const) {
			const refusing: ReleaseRun = (argv) => argv.includes(needle) ? { exitCode: 1, stdout: "" } : f.run(argv);
			expect(verifyAndExtractWithPolicy(f.archive, f.provenance, f.root, f.policy, refusing)).toEqual({ ok: false, cause });
			const throwing: ReleaseRun = (argv) => {
				if (argv.includes(needle)) throw new Error("verifier unavailable");
				return f.run(argv);
			};
			expect(verifyAndExtractWithPolicy(f.archive, f.provenance, f.root, f.policy, throwing)).toEqual({ ok: false, cause });
		}
	} finally { f.dispose(); }
});

test("production wrapper refuses fixture bytes before extraction", () => {
	const f = fixture();
	try {
		expect(verifyAndExtractMcporterRelease(f.archive, f.provenance, f.root, f.run)).toEqual({ ok: false, cause: "archive-digest-mismatch" });
		expect(f.calls).toHaveLength(0);
	} finally { f.dispose(); }
});
