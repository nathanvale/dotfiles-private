import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { downloadOfficial } from "../bin/mcporter-custody.ts";

// A local server stands in for the release host so each stall and oversize
// shape is controlled. Production pins the official URLs; these tests prove the
// bounds that first use applies to whatever host answers.
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function workspace(): string {
	const root = mkdtempSync(path.join(os.tmpdir(), "connectors-download-test-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function serve(routes: Record<string, () => Response | Promise<Response>>): string {
	const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (request) => routes[new URL(request.url).pathname]?.() ?? new Response("missing", { status: 404 }) });
	cleanups.push(() => server.stop(true));
	return `http://127.0.0.1:${server.port}`;
}

const stalledBody = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(16)); } }));
const neverAnswers = () => new Promise<Response>(() => {});
const unsizedBytes = (size: number) => () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(size)); controller.close(); } }));

async function refusal(run: Promise<void>): Promise<{ message: string; elapsed: number }> {
	const started = performance.now();
	try {
		await run;
	} catch (error) {
		return { message: (error as Error).message, elapsed: performance.now() - started };
	}
	throw new Error("download unexpectedly succeeded");
}

test("a bounded download writes the exact body as a private file", async () => {
	const base = serve({ "/asset": () => new Response("official bytes") });
	const target = path.join(workspace(), "asset");
	await downloadOfficial([{ url: `${base}/asset`, target, maxBytes: 14 }], 5_000);
	expect(readFileSync(target, "utf8")).toBe("official bytes");
	expect(statSync(target).mode & 0o777).toBe(0o600);
});

test("a stalled response body refuses at the deadline and writes nothing", async () => {
	const base = serve({ "/asset": stalledBody });
	const target = path.join(workspace(), "asset");
	const result = await refusal(downloadOfficial([{ url: `${base}/asset`, target, maxBytes: 1024 }], 300));
	expect(result.message).toBe("download-timeout");
	expect(result.elapsed).toBeGreaterThanOrEqual(250);
	expect(result.elapsed).toBeLessThan(3_000);
	expect(existsSync(target)).toBe(false);
});

test("a host that never sends headers refuses at the deadline", async () => {
	const base = serve({ "/asset": neverAnswers });
	const target = path.join(workspace(), "asset");
	const result = await refusal(downloadOfficial([{ url: `${base}/asset`, target, maxBytes: 1024 }], 300));
	expect(result.message).toBe("download-timeout");
	expect(result.elapsed).toBeLessThan(3_000);
	expect(existsSync(target)).toBe(false);
});

test("a declared length over the cap refuses before the body is saved", async () => {
	const base = serve({ "/asset": () => new Response(new Uint8Array(2048)) });
	const target = path.join(workspace(), "asset");
	const result = await refusal(downloadOfficial([{ url: `${base}/asset`, target, maxBytes: 1024 }], 5_000));
	expect(result.message).toBe("download-too-large");
	expect(existsSync(target)).toBe(false);
});

test("an undeclared streamed body over the cap refuses and writes nothing", async () => {
	const base = serve({ "/asset": unsizedBytes(1025) });
	const target = path.join(workspace(), "asset");
	const result = await refusal(downloadOfficial([{ url: `${base}/asset`, target, maxBytes: 1024 }], 5_000));
	expect(result.message).toBe("download-too-large");
	expect(existsSync(target)).toBe(false);
});

test("one failed asset aborts a stalled sibling instead of waiting for the deadline", async () => {
	let cancelled = false;
	const base = serve({ "/stalled": () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(16)); }, cancel() { cancelled = true; } })) });
	const root = workspace();
	const result = await refusal(downloadOfficial([
		{ url: `${base}/stalled`, target: path.join(root, "archive"), maxBytes: 1024 },
		{ url: `${base}/missing`, target: path.join(root, "provenance"), maxBytes: 1024 },
	], 10_000));
	expect(result.message).toBe("download-failed");
	expect(result.elapsed).toBeLessThan(3_000);
	// The sibling connection closes well before its 10 s deadline.
	for (const started = performance.now(); !cancelled && performance.now() - started < 2_000;) await Bun.sleep(20);
	expect(cancelled).toBe(true);
	expect(existsSync(path.join(root, "archive"))).toBe(false);
	expect(existsSync(path.join(root, "provenance"))).toBe(false);
});
