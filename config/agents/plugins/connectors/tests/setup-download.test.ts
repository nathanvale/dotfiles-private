import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { downloadAndInstallMise, downloadAndInstallOp } from "../bin/setup/download.ts";

type DownloadResult = Awaited<ReturnType<typeof downloadAndInstallOp>> | Awaited<ReturnType<typeof downloadAndInstallMise>>;

const MODULE = path.resolve(import.meta.dir, "../bin/setup/download.ts");
const SCRIPT = `import { downloadAndInstallOp, downloadAndInstallMise } from ${JSON.stringify(MODULE)}; const result = process.env.SETUP_KIND === "op" ? await downloadAndInstallOp({ localReleaseOrigin: process.env.RELEASE_ORIGIN }) : await downloadAndInstallMise({ localReleaseOrigin: process.env.RELEASE_ORIGIN }); console.log(JSON.stringify(result));`;

async function invoke(kind: "op" | "mise", root: string, origin: string) {
	const child = Bun.spawn([process.execPath, "-e", SCRIPT], {
		env: { HOME: root, XDG_STATE_HOME: path.join(root, "state"), PATH: "/missing", SETUP_KIND: kind, RELEASE_ORIGIN: origin },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	return { exit, stdout, stderr, result: JSON.parse(stdout) as DownloadResult };
}

test("a wrong official op package from a local release source preserves the previous selection", async () => {
	const root = mkdtempSync("/private/tmp/connectors-op-download-");
	const selected = path.join(root, "state", "connectors", "setup", "op", "op-selected");
	mkdirSync(path.dirname(selected), { recursive: true, mode: 0o700 });
	writeFileSync(selected, "previous", { mode: 0o600 });
	const requests: string[] = [];
	const server = Bun.serve({ port: 0, fetch(request) {
		requests.push(new URL(request.url).pathname);
		return new Response("not the pinned package");
	} });
	try {
		const run = await invoke("op", root, `http://127.0.0.1:${server.port}/`);
		expect(run.exit).toBe(0);
		expect(run.stderr).toBe("");
		expect(run.result).toEqual({ ok: false, reason: "integrity-refused" });
		expect(requests).toEqual(["/dist/1P/op2/pkg/v2.39.0/op_apple_universal_v2.39.0.pkg"]);
		expect(readFileSync(selected, "utf8")).toBe("previous");
		expect(readdirSync(path.dirname(selected))).toEqual(["op-selected"]);
		expect(readdirSync(path.join(root, "state", "connectors", "setup", "downloads"))).toEqual([]);
	} finally {
		server.stop(true);
		rmSync(root, { recursive: true, force: true });
	}
});

test("a failed signed-manifest download never reaches mise or changes selection", async () => {
	const root = mkdtempSync("/private/tmp/connectors-mise-download-");
	const selected = path.join(root, "state", "connectors", "setup", "mise", "mise-selected");
	mkdirSync(path.dirname(selected), { recursive: true, mode: 0o700 });
	writeFileSync(selected, "previous", { mode: 0o600 });
	const requests: string[] = [];
	const server = Bun.serve({ port: 0, fetch(request) {
		requests.push(new URL(request.url).pathname);
		return new Response("unavailable", { status: 503 });
	} });
	try {
		const run = await invoke("mise", root, `http://127.0.0.1:${server.port}/`);
		expect(run.exit).toBe(0);
		expect(run.stderr).toBe("");
		expect(run.result).toEqual({ ok: false, reason: "http-transient" });
		expect(requests).toEqual(["/jdx/mise/releases/download/v2026.9.12/SHASUMS256.txt"]);
		expect(readFileSync(selected, "utf8")).toBe("previous");
		expect(readdirSync(path.join(root, "state", "connectors", "setup", "downloads"))).toEqual([]);
	} finally {
		server.stop(true);
		rmSync(root, { recursive: true, force: true });
	}
});

test("an untrusted release origin is refused before creating state", async () => {
	const root = mkdtempSync("/private/tmp/connectors-download-origin-");
	try {
		const run = await invoke("op", root, "https://example.invalid/");
		expect(run.exit).toBe(0);
		expect(run.stderr).toBe("");
		expect(run.result).toEqual({ ok: false, reason: "source-invalid" });
		expect(existsSync(path.join(root, "state"))).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an oversized declared package is refused before its body or selection changes", async () => {
	const root = mkdtempSync("/private/tmp/connectors-download-size-");
	const selected = path.join(root, "state", "connectors", "setup", "op", "op-selected");
	mkdirSync(path.dirname(selected), { recursive: true, mode: 0o700 });
	writeFileSync(selected, "previous", { mode: 0o600 });
	const server = Bun.serve({ port: 0, fetch() {
		return new Response(new Uint8Array(49 * 1024 * 1024));
	} });
	try {
		const run = await invoke("op", root, `http://127.0.0.1:${server.port}/`);
		expect(run.exit).toBe(0);
		expect(run.stderr).toBe("");
		expect(run.result).toEqual({ ok: false, reason: "size-refused" });
		expect(readFileSync(selected, "utf8")).toBe("previous");
		expect(readdirSync(path.join(root, "state", "connectors", "setup", "downloads"))).toEqual([]);
	} finally {
		server.stop(true);
		rmSync(root, { recursive: true, force: true });
	}
});

test("an approved source cannot redirect a setup request to a hostile listener", async () => {
	const root = mkdtempSync("/private/tmp/connectors-download-redirect-");
	const selected = path.join(root, "state", "connectors", "setup", "op", "op-selected");
	mkdirSync(path.dirname(selected), { recursive: true, mode: 0o700 });
	writeFileSync(selected, "previous", { mode: 0o600 });
	let hostileRequests = 0;
	const hostile = Bun.serve({ port: 0, fetch() { hostileRequests++; return new Response("hostile"); } });
	const source = Bun.serve({ port: 0, fetch() {
		return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${hostile.port}/artifact` } });
	} });
	try {
		const run = await invoke("op", root, `http://127.0.0.1:${source.port}/`);
		expect(run.exit).toBe(0);
		expect(run.stderr).toBe("");
		expect(run.result).toEqual({ ok: false, reason: "source-invalid" });
		expect(hostileRequests).toBe(0);
		expect(readFileSync(selected, "utf8")).toBe("previous");
		expect(readdirSync(path.dirname(selected))).toEqual(["op-selected"]);
		expect(readdirSync(path.join(root, "state", "connectors", "setup", "downloads"))).toEqual([]);
	} finally {
		source.stop(true);
		hostile.stop(true);
		rmSync(root, { recursive: true, force: true });
	}
});

test("a malformed redirect location is an invalid source", async () => {
	const root = mkdtempSync("/private/tmp/connectors-download-bad-location-");
	const source = Bun.serve({ port: 0, fetch() {
		return new Response(null, { status: 302, headers: { location: "http://[invalid" } });
	} });
	try {
		const run = await invoke("op", root, `http://127.0.0.1:${source.port}/`);
		expect(run.exit).toBe(0);
		expect(run.stderr).toBe("");
		expect(run.result).toEqual({ ok: false, reason: "source-invalid" });
		expect(readdirSync(path.join(root, "state", "connectors", "setup", "downloads"))).toEqual([]);
	} finally {
		source.stop(true);
		rmSync(root, { recursive: true, force: true });
	}
});

test("a connection failure has a transient cause and leaves staging empty", async () => {
	const root = mkdtempSync("/private/tmp/connectors-download-network-");
	const server = Bun.serve({ port: 0, fetch() { return new Response("unused"); } });
	const origin = `http://127.0.0.1:${server.port}/`;
	server.stop(true);
	try {
		const run = await invoke("op", root, origin);
		expect(run.exit).toBe(0);
		expect(run.stderr).toBe("");
		expect(run.result).toEqual({ ok: false, reason: "network-transient" });
		expect(readdirSync(path.join(root, "state", "connectors", "setup", "downloads"))).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a missing release has a nontransient HTTP cause", async () => {
	const root = mkdtempSync("/private/tmp/connectors-download-missing-");
	const server = Bun.serve({ port: 0, fetch() { return new Response("missing", { status: 404 }); } });
	try {
		const run = await invoke("op", root, `http://127.0.0.1:${server.port}/`);
		expect(run.exit).toBe(0);
		expect(run.stderr).toBe("");
		expect(run.result).toEqual({ ok: false, reason: "http-refused" });
		expect(readdirSync(path.join(root, "state", "connectors", "setup", "downloads"))).toEqual([]);
	} finally {
		server.stop(true);
		rmSync(root, { recursive: true, force: true });
	}
});
