import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFallowRuntimeAudit } from "./fallow-runtime-audit";

let workDir: string;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "fallow-runtime-audit-test-"));
});

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

function writeFakeFallow(script: string): string {
	const binPath = join(workDir, "fake-fallow.sh");
	writeFileSync(binPath, `#!/bin/sh\n${script}\n`);
	chmodSync(binPath, 0o755);
	return binPath;
}

describe("runFallowRuntimeAudit", () => {
	test("reports exit 0 when every package passes", async () => {
		const fallowBin = writeFakeFallow(`echo '{"verdict":"pass","summary":{"dead_code_issues":0}}'\nexit 0`);
		const lines: string[] = [];
		const exitCode = await runFallowRuntimeAudit({
			repoRoot: workDir,
			fallowBin,
			packages: ["pkg-a"],
			extraArgs: [],
			log: (line) => lines.push(line),
		});

		expect(exitCode).toBe(0);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "")).toMatchObject({ package: "pkg-a", verdict: "pass", exit: 0 });
	});

	test("reports exit 1 when a package fails its audit", async () => {
		const fallowBin = writeFakeFallow(`echo '{"verdict":"fail","summary":{"dead_code_issues":3}}'\nexit 1`);
		const exitCode = await runFallowRuntimeAudit({
			repoRoot: workDir,
			fallowBin,
			packages: ["pkg-a"],
			extraArgs: [],
			log: () => {},
		});

		expect(exitCode).toBe(1);
	});

	test("treats a zero-exit non-JSON stdout as an operational error (exit 2), not a pass", async () => {
		const fallowBin = writeFakeFallow(`echo 'not json'\nexit 0`);
		const lines: string[] = [];
		const errors: string[] = [];
		const exitCode = await runFallowRuntimeAudit({
			repoRoot: workDir,
			fallowBin,
			packages: ["pkg-a"],
			extraArgs: [],
			log: (line) => lines.push(line),
			logError: (line) => errors.push(line),
		});

		expect(exitCode).toBe(2);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "")).toMatchObject({ package: "pkg-a", verdict: null, exit: 2 });
		expect(errors[0] ?? "").toContain("pkg-a");
	});

	test("gives exit 2 precedence over exit 1 when both occur across packages", async () => {
		const passingThenGarbage = writeFakeFallow(
			`if [ "$3" = "pkg-fail" ]; then echo '{"verdict":"fail","summary":{}}'; exit 1; else echo 'not json'; exit 0; fi`,
		);
		const exitCode = await runFallowRuntimeAudit({
			repoRoot: workDir,
			fallowBin: passingThenGarbage,
			packages: ["pkg-fail", "pkg-garbage"],
			extraArgs: [],
			log: () => {},
			logError: () => {},
		});

		expect(exitCode).toBe(2);
	});
});
