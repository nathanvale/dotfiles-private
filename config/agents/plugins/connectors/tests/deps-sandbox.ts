// Shared process sandbox for the explicit deps repair and update tests: an
// isolated packaged bundle with its own HOME and XDG state, a hostile PATH
// whose tools must never run, planted refused selections, and a loopback
// release host that refuses every artifact. One owner, so both commands'
// tests exercise the same fake.
import { expect } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createBundle, runBundle, type Bundle } from "./harness.ts";

export const SENTINEL = "deps-repair-secret-sentinel-7a2d";
// Independent oracle: the official op package path below the release host.
export const OP_PATH = "/dist/1P/op2/pkg/v2.39.0/op_apple_universal_v2.39.0.pkg";
export const PREVIEW_ID = /^[0-9a-f]{32}$/;

export interface Sandbox {
	bundle: Bundle;
	home: string;
	state: string;
	hostile: string;
	marker: string;
}

export function sandbox(): Sandbox {
	const bundle = createBundle();
	const home = path.join(bundle.root, "home");
	const hostile = path.join(bundle.root, "hostile-bin");
	const marker = path.join(bundle.root, "ambient-invoked");
	mkdirSync(home);
	mkdirSync(hostile);
	for (const tool of ["mcporter", "op", "mise", "uv"]) writeFileSync(path.join(hostile, tool), `#!/bin/sh\necho ${tool} >> '${marker}'\n`, { mode: 0o755 });
	// Setup's installers refuse a state path below a symlink, and the macOS
	// temporary directory sits below /var -> /private/var.
	return { bundle, home, state: path.join(realpathSync(bundle.root), "state"), hostile, marker };
}

// Path, mode, and bytes of every dependency-selection entry. The deps
// repair records under connectors/deps are asserted separately, and the
// installers' own download staging is not a selection.
const NOT_SELECTION = [path.join("connectors", "deps"), path.join("connectors", "setup", "downloads")];

export function selections(state: string): string[] {
	if (!existsSync(state)) return ["<absent>"];
	return readdirSync(state, { recursive: true }).map(String).filter((name) => !NOT_SELECTION.some((prefix) => name.startsWith(prefix))).sort().map((name) => {
		const file = path.join(state, name);
		const stat = lstatSync(file);
		return `${name} ${(stat.mode & 0o7777).toString(8)} ${stat.isFile() ? readFileSync(file, "hex") : ""}`;
	});
}

export function records(state: string, kind: "previews" | "receipts"): string[] {
	const directory = path.join(state, "connectors", "deps", kind);
	return existsSync(directory) ? readdirSync(directory).sort() : [];
}

export async function deps(box: Sandbox, argv: string[], extraEnv: Record<string, string> = {}) {
	const run = await runBundle(box.bundle, ["deps", ...argv], { home: box.home, binDir: box.hostile, extraEnv: { XDG_STATE_HOME: box.state, OP_SERVICE_ACCOUNT_TOKEN: SENTINEL, ...extraEnv }, timeoutMs: 20_000 });
	expect(run.stderr).toBe("");
	expect(run.stdout.trim().split("\n")).toHaveLength(1);
	for (const forbidden of [SENTINEL, box.home, box.state, box.bundle.root, realpathSync(box.bundle.root)]) expect(run.stdout).not.toContain(forbidden);
	expect(existsSync(box.marker)).toBe(false);
	return { code: run.code, result: JSON.parse(run.stdout).result };
}

export function owned(directory: string): void {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
}

// A damaged op selection an earlier install could leave behind.
export function plantWrongOp(state: string): void {
	const op = path.join(state, "connectors", "setup", "op");
	owned(op);
	writeFileSync(path.join(op, "op-selected"), `op-2.38.0-${"0".repeat(64)}`, { mode: 0o600 });
	writeFileSync(path.join(op, `op-2.38.0-${"0".repeat(64)}`), "older op bytes", { mode: 0o700 });
}

export function plantWrongMcporter(state: string): void {
	const current = path.join(state, "connectors", "mcporter", "current");
	owned(current);
	writeFileSync(path.join(current, "release.json"), JSON.stringify({ version: "0.13.13" }), { mode: 0o600 });
	writeFileSync(path.join(current, "mcporter"), "older mcporter bytes", { mode: 0o700 });
}

// A loopback release host that refuses every artifact after an optional
// delay and records each requested path.
export function refusingHost(delayMs = 0) {
	const requests: string[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		requests.push(new URL(request.url).pathname);
		if (delayMs) await Bun.sleep(delayMs);
		return new Response("refused", { status: 404 });
	} });
	return { requests, origin: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) };
}
