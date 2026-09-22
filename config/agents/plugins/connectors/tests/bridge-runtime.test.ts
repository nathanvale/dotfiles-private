import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { bridgeFromArchive, type BridgeFetcher, downloadBridgeArchive, provisionBridgeForTarget } from "../bin/bridge-runtime.ts";

const digest = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const binary = new TextEncoder().encode("fixture bridge bytes");
function archiveFor(payload: Uint8Array): Uint8Array {
	const tar = new Uint8Array(2048);
	tar.set(new TextEncoder().encode("hyper-mcp-remote"));
	tar.set(new TextEncoder().encode(payload.length.toString(8).padStart(11, "0") + "\0"), 124);
	tar[156] = 48;
	tar.set(payload, 512);
	return gzipSync(tar);
}
const archive = archiveFor(binary);
const target = { archive: "fixture.tar.gz", digest: digest(archive), binaryDigest: digest(binary) };
let root = mkdtempSync(path.join(os.tmpdir(), "connectors-bridge-test-"));
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	root = mkdtempSync(path.join(os.tmpdir(), "connectors-bridge-test-"));
});

test("provisions a verified owned bridge and refuses a later binary tamper without downloading", async () => {
	const file = path.join(root, "hyper-mcp-remote");
	let requests = 0;
	const fetcher: BridgeFetcher = async () => { requests += 1; return new Response(new Uint8Array(archive).buffer as ArrayBuffer); };
	await provisionBridgeForTarget(file, target, fetcher);
	expect(readFileSync(file)).toEqual(Buffer.from(binary));
	expect(await provisionBridgeForTarget(file, target, fetcher)).toBe(file);
	expect(requests).toBe(1);
	writeFileSync(file, "tampered");
	chmodSync(file, 0o700);
	await expect(provisionBridgeForTarget(file, target, fetcher)).rejects.toThrow("bridge-owned-invalid");
	expect(requests).toBe(1);
});

test("archive and executable digests are independent pinned checks", () => {
	expect(() => bridgeFromArchive(archive, "0".repeat(64), target.binaryDigest)).toThrow("bridge-checksum-invalid");
	expect(() => bridgeFromArchive(archive, target.digest, "0".repeat(64))).toThrow("bridge-binary-invalid");
});

test("download refuses a declared oversize and an unbounded stream, aborting both", async () => {
	let cancelled = false;
	const declared: BridgeFetcher = async (_url, init) => {
		init?.signal?.addEventListener("abort", () => { cancelled = true; });
		return new Response(new Uint8Array(archive).buffer as ArrayBuffer, { headers: { "content-length": "999999999" } });
	};
	await expect(downloadBridgeArchive("fixture", declared, 32, 1000)).rejects.toThrow("bridge-download-bounded");
	expect(cancelled).toBe(true);
	const streaming: BridgeFetcher = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(33)); } }));
	await expect(downloadBridgeArchive("fixture", streaming, 32, 1000)).rejects.toThrow("bridge-download-bounded");
});

test("download timeout and offline refusal leave no executable", async () => {
	const file = path.join(root, "hyper-mcp-remote");
	const stalled: BridgeFetcher = async (_url, init) => new Promise((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
	});
	await expect(downloadBridgeArchive("fixture", stalled, 32, 10)).rejects.toThrow("bridge-download-timeout");
	const offline: BridgeFetcher = async () => { throw new Error("offline"); };
	await expect(provisionBridgeForTarget(file, target, offline)).rejects.toThrow("bridge-download-failed");
	expect(existsSync(file)).toBe(false);
});
