import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { MISE_RELEASE } from "../bin/setup/mise.ts";

// Independent official v2026.9.12 release fixture, not derived from the verifier.
const SIGNED_MANIFEST = "f344c6961190ed2f68e595ed7cb4f03c36c17812bd608886bec799a3082180ff  ./mise-v2026.9.12-linux-arm64\n2d2982b12f7a13894aa88272e4cd360e68591fe105b43cff29b1ac4588c6fe83  ./mise-v2026.9.12-linux-arm64-musl\n22e7ecd3c6c84ef36e4d0c78c4eef49a79e3fb83aa88e091e2993fd9c9a3f8a1  ./mise-v2026.9.12-linux-arm64-musl.tar.gz\ndfd197ace3576347a4fd287c0ee4a66e75fe8fe68bd6ab1bbb42923d64448b05  ./mise-v2026.9.12-linux-arm64-musl.tar.xz\na410487c55c17de74c23e0c00af5fefb58cc5179a3747a7ce1123ff6bd186711  ./mise-v2026.9.12-linux-arm64-musl.tar.zst\ne4a0921da0a76ce4666832d5b57b6f0eb9f22d149ba92845ebae4c38638c6775  ./mise-v2026.9.12-linux-arm64.tar.gz\n7bc2a5558b787a33f22e4b5955cfec58871ad3723658418ad3d2cdf5a0e693b9  ./mise-v2026.9.12-linux-arm64.tar.xz\nf15a6bb85e8f264490e08138054dd8ec4eb1a64fc9d9795b50bbb56f83f5c2d0  ./mise-v2026.9.12-linux-arm64.tar.zst\n9a3a7edff6f81c38e31614fdbd2f0d7148ed0315e112dfc84ee08987995f299e  ./mise-v2026.9.12-linux-armv7\n0f8ec99046c7d5e3d3d813ce72a03ff5ac92aa1681ee6f471b6044de428f91f7  ./mise-v2026.9.12-linux-armv7-musl\n9eba0d0aa4feb93afbd6b4e81391dfc58fefdd66d564cc8481b676d083328aaa  ./mise-v2026.9.12-linux-armv7-musl.tar.gz\n99e028e83ce3918c6b4d7552b12ab2b26ea097573ad7594a281fcf7b7259850f  ./mise-v2026.9.12-linux-armv7-musl.tar.xz\n262d7937535a5c70466a4679803d116329ccd84e9749ba38d42fc3dbe625ae65  ./mise-v2026.9.12-linux-armv7-musl.tar.zst\nc84437412cf030934c395be1af4836cac55ef164d0a58dc6db8e2adb4cc71d46  ./mise-v2026.9.12-linux-armv7.tar.gz\n138a860a97243fa595e3c9b176e78e15dc73a4d5ac179f58f2d9785709b1b4c0  ./mise-v2026.9.12-linux-armv7.tar.xz\nf6e9e09a3cd7e49ef1210f4a152c775ef39324c7b73448c480721e5035ea8abf  ./mise-v2026.9.12-linux-armv7.tar.zst\ne79ae57945034903aee8aa2ea66b4c7ca9cd4f4edd5a8a78a589cbae6d0f428a  ./mise-v2026.9.12-linux-x64\ne59a38683c9d776e0ea6c7b35c9829de915bb7df15d16d0bf6890afa0278bd7c  ./mise-v2026.9.12-linux-x64-musl\n1b2051d8d3efab4d9c85ceb59849a3eb052db24ad406a3901fd6b45374c56ebe  ./mise-v2026.9.12-linux-x64-musl.tar.gz\n64a8fed853e1f6b80ec17c89ec3c34f19d634688a67ebf4589755006dca2dce2  ./mise-v2026.9.12-linux-x64-musl.tar.xz\nad595e7848fd4cdade86f378460cccbae015dd116e95b6bbe509b0b3f80ca4ea  ./mise-v2026.9.12-linux-x64-musl.tar.zst\nb4058dece685259910d3aba5782445996eea79dbdb3cf952a6eb81aadf0373ff  ./mise-v2026.9.12-linux-x64.tar.gz\n30c79a0a24d8f0ad80e6c9b11ec54816be2a9b77e7eeae32c1267a5b9d34d3d7  ./mise-v2026.9.12-linux-x64.tar.xz\ne302176806b007f63eacaa22f10418a651c25a9d98a606d9ea40fe7198af3bf2  ./mise-v2026.9.12-linux-x64.tar.zst\nf20d7cc555a5b0ee7b8a504acbc2583be1b0848d64115cfbe84119ceb705025b  ./mise-v2026.9.12-macos-arm64\n0f1c7f3e74d8c9ae82976e6990058f2bc68821acc6b4c37a68c206c836692419  ./mise-v2026.9.12-macos-arm64.tar.gz\n01b15ea733709a2000a801533203e99c1490d9a3c13d45c8eb90ccefd0bd21f3  ./mise-v2026.9.12-macos-arm64.tar.xz\n7a1f5c361e4939cefeaaf984fca57e16d6b02b34bd941750361c192d55da90c1  ./mise-v2026.9.12-macos-arm64.tar.zst\nfa1e35456f1e27a4555a1ccec82d5367d7037f3b4f46d48b83c4a3bceb4d78f2  ./mise-v2026.9.12-macos-x64\n22be38ec60632913143bf6a96b0aacfd895fdfe4ce4e8958e942f7bdb5a9185b  ./mise-v2026.9.12-macos-x64.tar.gz\nd055d033dd4c80a29e336b6e0ad51d86606c79fd7c49be6c898f5dc47704b975  ./mise-v2026.9.12-macos-x64.tar.xz\nea7e30f95e578e77af4f59099a4da85fde9cf459040c077ceb832288fc32ed91  ./mise-v2026.9.12-macos-x64.tar.zst\n6beeb61b829ba60ef3bb1fdda5717a41b8fb91bd400109de8b05b1700a107d8e  ./mise-v2026.9.12-windows-arm64.exe\n355e2fe5f615f3c636128b827f9a8fd3ce14e846e849a59c641e7123d39652a4  ./mise-v2026.9.12-windows-arm64.zip\n8bc3a2c46246bb00fc49f467c678cf9ff321f707c533ad707061d0f8c7b639b2  ./mise-v2026.9.12-windows-x64.exe\n375ee1a86ece7a7b7270c82b5a1810a591efa1e378188b5f4d928ef47bde91ac  ./mise-v2026.9.12-windows-x64.zip\n";
const SIGNATURE = "untrusted comment: signature from minisign secret key\nRUTC3g8W3z4RZNqm9Uph3F3xaU76jB1/XQ7Z1/9Xn4h1KBYve70gZ3RD3PCu/iRtAjvNI6HywGXGuIjEBS7EPyzTTOj2/9wE1AI=\ntrusted comment: timestamp:1789903913\tfile:SHASUMS256.txt\thashed\nsr9zi4OfBKVipKxGkrTd9QjgzyQ1RV0C9IKen9dIB6/PfOl/MLAlxXJpJYohIMqAoUHGFtphfbVcq6f6Ih2BBA==\n";

const MODULE = path.resolve(import.meta.dir, "../bin/setup/mise.ts");
const SCRIPT = `import { installVerifiedMise } from ${JSON.stringify(MODULE)}; console.log(JSON.stringify(installVerifiedMise(JSON.parse(process.env.MISE_TEST_INPUT ?? "{}"))));`;

function fixture(root: string) {
	const manifestFile = path.join(root, "SHASUMS256.txt");
	const signatureFile = path.join(root, "SHASUMS256.txt.minisig");
	const archiveFile = path.join(root, "release.tar.xz");
	writeFileSync(manifestFile, SIGNED_MANIFEST);
	writeFileSync(signatureFile, SIGNATURE);
	writeFileSync(archiveFile, "wrong archive bytes");
	return { manifestFile, signatureFile, archiveFile };
}

function invoke(root: string, input: Record<string, unknown>, xdg: string) {
	return spawnSync(process.execPath, ["-e", SCRIPT], {
		encoding: "utf8",
		env: { HOME: root, XDG_STATE_HOME: xdg, MISE_TEST_INPUT: JSON.stringify(input), PATH: "/missing", MISE_CONFIG_FILE: path.join(root, "hostile.toml") },
	});
}

test("mise authority is the fixed release key and digests", () => {
	expect(MISE_RELEASE).toEqual({
		version: "2026.9.12",
		archiveName: "mise-v2026.9.12-macos-arm64.tar.xz",
		archiveUrl: "https://github.com/jdx/mise/releases/download/v2026.9.12/mise-v2026.9.12-macos-arm64.tar.xz",
		manifestUrl: "https://github.com/jdx/mise/releases/download/v2026.9.12/SHASUMS256.txt",
		signatureUrl: "https://github.com/jdx/mise/releases/download/v2026.9.12/SHASUMS256.txt.minisig",
		publicKey: "RWTC3g8W3z4RZK3V3qv7fa1QY4JEWyBtqIHW+85QlJpZc5yG+uNYNBSZ",
		archiveSha256: "01b15ea733709a2000a801533203e99c1490d9a3c13d45c8eb90ccefd0bd21f3",
		binarySha256: "f20d7cc555a5b0ee7b8a504acbc2583be1b0848d64115cfbe84119ceb705025b",
	});
});

test("a signed manifest does not authorize wrong archive bytes or create state", () => {
	const root = mkdtempSync("/private/tmp/connectors-mise-wrong-");
	try {
		const xdg = path.join(root, "xdg");
		const stateDirectory = path.join(xdg, "connectors", "setup", "mise");
		const child = invoke(root, { ...fixture(root), stateDirectory }, xdg);
		expect(child.status).toBe(0);
		expect(child.stderr).toBe("");
		expect(JSON.parse(child.stdout)).toEqual({ ok: false, reason: "artifact-invalid" });
		expect(existsSync(xdg)).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a changed signed manifest refuses before state creation", () => {
	const root = mkdtempSync("/private/tmp/connectors-mise-signature-");
	try {
		const xdg = path.join(root, "xdg");
		const stateDirectory = path.join(xdg, "connectors", "setup", "mise");
		const input = fixture(root);
		writeFileSync(input.manifestFile, SIGNED_MANIFEST.replace("f344c696", "0344c696"));
		const child = invoke(root, { ...input, stateDirectory }, xdg);
		expect(child.status).toBe(0);
		expect(child.stderr).toBe("");
		expect(JSON.parse(child.stdout)).toEqual({ ok: false, reason: "signature-invalid" });
		expect(existsSync(xdg)).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a changed trusted comment refuses before state creation", () => {
	const root = mkdtempSync("/private/tmp/connectors-mise-comment-");
	try {
		const xdg = path.join(root, "xdg");
		const stateDirectory = path.join(xdg, "connectors", "setup", "mise");
		const input = fixture(root);
		writeFileSync(input.signatureFile, SIGNATURE.replace("timestamp:1789903913", "timestamp:1789903914"));
		const child = invoke(root, { ...input, stateDirectory }, xdg);
		expect(child.status).toBe(0);
		expect(child.stderr).toBe("");
		expect(JSON.parse(child.stdout)).toEqual({ ok: false, reason: "signature-invalid" });
		expect(existsSync(xdg)).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a redirected state directory refuses without touching its referent", () => {
	const root = mkdtempSync("/private/tmp/connectors-mise-redirect-");
	try {
		const xdg = path.join(root, "xdg");
		const stateDirectory = path.join(root, "outsider");
		const child = invoke(root, { ...fixture(root), stateDirectory }, xdg);
		expect(child.status).toBe(0);
		expect(child.stderr).toBe("");
		expect(JSON.parse(child.stdout)).toEqual({ ok: false, reason: "state-invalid" });
		expect(existsSync(stateDirectory)).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
