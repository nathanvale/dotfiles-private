import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PluginOwnership } from "./plugin-preparation";

const repoRoot = path.resolve(import.meta.dir, "..");
const cliPath = path.join(repoRoot, "tooling/plugin-preparation.ts");

interface FixtureEntry {
	name: string;
	ownership: PluginOwnership;
	path?: string;
}

function text(value: unknown): string {
	return value instanceof Uint8Array ? new TextDecoder().decode(value) : String(value ?? "");
}

function createFakeBun(root: string): string {
	const fakeBun = path.join(root, "fake-bun");
	writeFileSync(
		fakeBun,
		["#!/bin/sh", 'printf \'%s|%s\\n\' "$PWD" "$*" >> "$PREPARATION_LOG"', 'printf \'stdout:%s|%s\\n\' "$PWD" "$*"', 'printf \'stderr:%s|%s\\n\' "$PWD" "$*" >&2', 'if [ -n "$FAIL_CWD" ] && [ "$PWD" = "$FAIL_CWD" ]; then exit 41; fi', "exit 0", ""].join("\n"),
		{ mode: 0o700 },
	);
	chmodSync(fakeBun, 0o700);
	return fakeBun;
}

function createFixture(entries: FixtureEntry[]): string {
	const fixture = mkdtempSync(path.join(os.tmpdir(), "plugin-preparation-process-"));
	const pluginsRoot = path.join(fixture, "config/agents/plugins");
	mkdirSync(pluginsRoot, { recursive: true });
	mkdirSync(path.join(fixture, "tooling"), { recursive: true });
	writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ workspaces: entries.filter((entry) => entry.ownership === "root-workspace").map((entry) => entry.path ?? `config/agents/plugins/${entry.name}`) }));
	writeFileSync(
		path.join(fixture, "tooling/plugin-preparation.json"),
		JSON.stringify({
			version: 1,
			plugins: entries.map((entry) => ({
				name: entry.name,
				path: entry.path ?? `config/agents/plugins/${entry.name}`,
				ownership: entry.ownership,
				reason: `fixture ${entry.ownership}`,
			})),
		}),
	);
	for (const entry of entries) {
		const pluginRoot = path.join(fixture, entry.path ?? `config/agents/plugins/${entry.name}`);
		mkdirSync(pluginRoot, { recursive: true });
		writeFileSync(path.join(pluginRoot, "package.json"), JSON.stringify({ name: entry.name, private: true }));
		if (entry.ownership === "independent-lock") writeFileSync(path.join(pluginRoot, "bun.lock"), "{}\n");
	}
	return fixture;
}

function runCli(
	fixture: string,
	fakeBun: string,
	log: string,
	receiptDir: string,
	failCwd?: string,
): { exitCode: number; stdout: string; stderr: string } {
	const result = Bun.spawnSync([process.execPath, cliPath, "--repo-root", fixture, "--bun", fakeBun, "--receipt-dir", receiptDir], {
		cwd: repoRoot,
		env: {
			...process.env,
			PREPARATION_LOG: log,
			...(failCwd ? { FAIL_CWD: failCwd } : {}),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	return { exitCode: result.exitCode, stdout: text(result.stdout), stderr: text(result.stderr) };
}

test("the public preparation process installs root first, then sorted independent locks, with separate receipts", () => {
	const fixture = createFixture([
		{ name: "zeta", ownership: "independent-lock" },
		{ name: "root-owned", ownership: "root-workspace" },
		{ name: "alpha", ownership: "independent-lock" },
		{ name: "dependency-free", ownership: "no-nested-install" },
	]);
	const fakeBun = createFakeBun(fixture);
	const log = path.join(fixture, "calls.log");
	const receiptDir = path.join(fixture, "receipts");
	try {
		const result = runCli(fixture, fakeBun, log, receiptDir);
		const realFixture = realpathSync(fixture);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("preparation passed: root plus 2 independent plugin lock(s)");
		expect(result.stderr).toContain("[preparation root stderr]");
		expect(result.stderr).toContain("[preparation plugin:alpha stderr]");

		const calls = readFileSync(log, "utf8").trim().split("\n");
		expect(calls).toHaveLength(3);
		expect(calls[0]).toBe(`${realFixture}|install --frozen-lockfile`);
		expect(calls[1]).toBe(`${path.join(realFixture, "config/agents/plugins/alpha")}|install --frozen-lockfile`);
		expect(calls[2]).toBe(`${path.join(realFixture, "config/agents/plugins/zeta")}|install --frozen-lockfile`);
		const callText = calls.join("\n");
		expect(callText).not.toContain("dependency-free|install");
		expect(callText).not.toContain("root-owned|install");

		expect(readFileSync(path.join(receiptDir, "root.stdout"), "utf8")).toContain("stdout:");
		expect(readFileSync(path.join(receiptDir, "plugins/plugin-alpha.stderr"), "utf8")).toContain("alpha");
		expect(readFileSync(path.join(receiptDir, "plugins/plugin-alpha.stderr"), "utf8")).not.toContain("zeta");
		expect(JSON.parse(readFileSync(path.join(receiptDir, "summary.json"), "utf8"))).toMatchObject({
			status: "passed",
			records: [
				{ scope: "root", status: "passed" },
				{ scope: "plugin", plugin: "alpha", status: "passed" },
				{ scope: "plugin", plugin: "zeta", status: "passed" },
			],
		});
		expect(statSync(receiptDir).mode & 0o777).toBe(0o700);
		expect(statSync(path.join(receiptDir, "root.stdout")).mode & 0o777).toBe(0o600);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("a failed nested install stops preparation before later installs can run", () => {
	const fixture = createFixture([
		{ name: "stale", ownership: "independent-lock" },
		{ name: "zz-later", ownership: "independent-lock" },
	]);
	const fakeBun = createFakeBun(fixture);
	const log = path.join(fixture, "calls.log");
	const receiptDir = path.join(fixture, "receipts");
	try {
		const result = runCli(fixture, fakeBun, log, receiptDir, realpathSync(path.join(fixture, "config/agents/plugins/stale")));
		expect(result.exitCode).toBe(1);
		expect(readFileSync(log, "utf8")).toContain("/stale|install --frozen-lockfile");
		expect(readFileSync(log, "utf8")).not.toContain("/zz-later|install");
		expect(result.stderr).toContain("preparation failed for stale; later plugin installs were not started");
		expect(JSON.parse(readFileSync(path.join(receiptDir, "summary.json"), "utf8"))).toMatchObject({
			status: "failed",
			records: [
				{ scope: "root", status: "passed" },
				{ scope: "plugin", plugin: "stale", status: "failed", exitCode: 41 },
			],
		});
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("an unclassified plugin lock refuses preparation before any install", () => {
	const fixture = createFixture([{ name: "known", ownership: "no-nested-install" }]);
	const extra = path.join(fixture, "config/agents/plugins/unclassified");
	mkdirSync(extra, { recursive: true });
	writeFileSync(path.join(extra, "package.json"), JSON.stringify({ name: "unclassified", private: true }));
	writeFileSync(path.join(extra, "bun.lock"), "{}\n");
	const fakeBun = createFakeBun(fixture);
	const log = path.join(fixture, "calls.log");
	const receiptDir = path.join(fixture, "receipts");
	try {
		const result = runCli(fixture, fakeBun, log, receiptDir);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("unclassified: plugin directory is unclassified");
		expect(existsSync(log)).toBe(false);
		expect(JSON.parse(readFileSync(path.join(receiptDir, "summary.json"), "utf8"))).toMatchObject({ status: "refused", records: [] });
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});


test("an orphan plugin lock without package metadata refuses preparation before installs", () => {
	const fixture = createFixture([]);
	const extra = path.join(fixture, "config/agents/plugins/orphan");
	mkdirSync(extra, { recursive: true });
	writeFileSync(path.join(extra, "bun.lock"), "{}\n");
	const fakeBun = createFakeBun(fixture);
	const log = path.join(fixture, "calls.log");
	const receiptDir = path.join(fixture, "receipts");
	try {
		const result = runCli(fixture, fakeBun, log, receiptDir);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("orphan: plugin directory is unclassified");
		expect(existsSync(log)).toBe(false);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});
