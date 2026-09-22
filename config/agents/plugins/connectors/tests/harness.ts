// Shared public-process harness for every connector test. One owner of the
// fake processes and custody assertions; per-skill tests add expectations only.
import { expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PLUGIN_ROOT = path.resolve(import.meta.dir, "..");
export const ROUTE = path.join(PLUGIN_ROOT, "bin", "provider-route.ts");
export const FIXTURES = path.join(PLUGIN_ROOT, "tests", "fixtures");
// Same launcher main, bound to the fixture skills under tests/fixtures.
export const FIXTURE_ROUTE = path.join(FIXTURES, "provider-route-fixture.ts");
export const AMBIENT_SENTINEL = "must-not-cross-route";
export const OP_TOKEN_SENTINEL = "fixture-op-service-account-token";

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	pid: number;
}

export interface Harness {
	root: string;
	home: string;
	binDir: string;
	run(argv: string[], extraEnv?: Record<string, string>, entry?: string): Promise<RunResult>;
	receipt<T = Record<string, unknown>>(name: string): T;
	has(name: string): boolean;
	write(name: string, content: string): void;
	dispose(): void;
}

function shim(file: string, modulePath: string): void {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, `#!/usr/bin/env bun\nimport "${modulePath}";\n`);
	chmodSync(file, 0o755);
}

// `fakes` maps an executable name on PATH to the TypeScript module that
// implements it. The 1Password helper is always installed at the path the
// Providers resolve below HOME.
export function createHarness(fakes: Record<string, string>): Harness {
	const root = mkdtempSync(path.join(os.tmpdir(), "connectors-test-"));
	const home = path.join(root, "home");
	const binDir = path.join(root, "bin");
	shim(path.join(home, "code", "dotfiles", "bin", "with-one-password-token"), path.join(FIXTURES, "one-password-fake.ts"));
	shim(path.join(binDir, "mcporter"), path.join(FIXTURES, "mcporter-fake.ts"));
	for (const [name, modulePath] of Object.entries(fakes)) shim(path.join(binDir, name), modulePath);
	return {
		root,
		home,
		binDir,
		async run(argv, extraEnv = {}, entry = ROUTE) {
			const proc = Bun.spawn([process.execPath, entry, ...argv], {
				env: {
					HOME: home,
					PATH: `${binDir}:${process.env.PATH ?? ""}`,
					TMPDIR: root,
					XDG_STATE_HOME: root,
					AMBIENT_SENTINEL,
					OP_SERVICE_ACCOUNT_TOKEN: OP_TOKEN_SENTINEL,
					...extraEnv,
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
			return { code, stdout, stderr, pid: proc.pid };
		},
		receipt(name) {
			return JSON.parse(readFileSync(path.join(root, name), "utf8"));
		},
		has(name) {
			return existsSync(path.join(root, name));
		},
		write(name, content) {
			writeFileSync(path.join(root, name), content);
		},
		dispose() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

export interface McporterReceipt {
	argv: string[];
	env: Record<string, string>;
	pid: number;
	cwd: string;
	kind: "stdio" | "http";
	url?: string;
	headers?: Record<string, string> | null;
	command?: string;
}

// The custody claim shared by every connector: MCPorter itself never holds a
// credential or ambient authority, the route always disables OAuth and the
// keep-alive daemon, and no fixture secret reaches a public stream.
export function assertCustody(harness: Harness, result: RunResult, secrets: string[]): McporterReceipt {
	const receipt = harness.receipt<McporterReceipt>("mcporter.json");
	for (const key of ["AMBIENT_SENTINEL", "OP_SERVICE_ACCOUNT_TOKEN"]) {
		expect(receipt.env).not.toHaveProperty(key);
	}
	expect(receipt.env.MCPORTER_NO_KEEPALIVE).toBe("*");
	expect(receipt.argv[0]).toBe("--config");
	expect(receipt.argv.filter((token) => token === "--no-oauth")).toHaveLength(1);
	expect(receipt.pid).toBe(result.pid);
	const serialized = JSON.stringify(receipt);
	for (const secret of [OP_TOKEN_SENTINEL, ...secrets]) {
		expect(serialized).not.toContain(secret);
		expect(result.stdout).not.toContain(secret);
		expect(result.stderr).not.toContain(secret);
	}
	return receipt;
}
