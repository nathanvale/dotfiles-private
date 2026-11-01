import { afterAll, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const temporaryRoots: string[] = [];
const baselineApi = "export const value = 1;\nexport const inherited = 2;\n";

afterAll(() => { for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true }); });

function command(root: string, args: string[], formatterExit = "0", extraEnv: Record<string, string> = {}) {
	return Bun.spawnSync(args, {
		cwd: root, stdout: "pipe", stderr: "pipe", timeout: 30_000,
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", FALLOW_AUDIT_BASE: "", FORMATTER_EXIT: formatterExit, PATH: `${join(root, "bin")}:${process.env.PATH}`, ...extraEnv },
	});
}

function git(root: string, ...args: string[]) {
	const result = command(root, ["git", ...args]);
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
}

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "native-fallow-git-")));
	temporaryRoots.push(root);
	git(root, "init", "--initial-branch=task");
	git(root, "config", "user.name", "Native Hook Test");
	git(root, "config", "user.email", "native-hook@example.invalid");
	git(root, "config", "commit.gpgsign", "false");
	writeFileSync(join(root, "package.json"), '{"name":"native-hook-fixture","private":true}\n');
	writeFileSync(join(root, ".fallowrc.json"), '{"entry":["index.ts"],"rules":{"unused-exports":"error"},"audit":{"gate":"new-only"}}\n');
	writeFileSync(join(root, ".gitignore"), "node_modules/\n.fallow/\n.husky/\nbin/\n");
	writeFileSync(join(root, "index.ts"), 'import {value} from "./api"; console.log(value);\n');
	writeFileSync(join(root, "api.ts"), baselineApi);
	git(root, "add", "package.json", ".fallowrc.json", ".gitignore", "index.ts", "api.ts");
	git(root, "commit", "-m", "test: baseline inherited debt");
	const head = git(root, "rev-parse", "HEAD");
	git(root, "update-ref", "refs/remotes/origin/main", head);
	mkdirSync(join(root, ".husky"));
	copyFileSync(join(repoRoot, ".husky/pre-commit"), join(root, ".husky/pre-commit"));
	chmodSync(join(root, ".husky/pre-commit"), 0o755);
	git(root, "config", "core.hooksPath", ".husky");
	mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
	symlinkSync(realpathSync(join(repoRoot, "node_modules/.bin/fallow")), join(root, "node_modules/.bin/fallow"));
	mkdirSync(join(root, "bin"));
	writeFileSync(join(root, "bin/bunx"), '#!/bin/sh\necho "fixture formatter" >&2\nexit "$FORMATTER_EXIT"\n');
	chmodSync(join(root, "bin/bunx"), 0o755);
	return { root, head };
}

for (const scenario of ["inherited", "introduced", "formatter-failure", "invalid-base"]) {
	test(`Git pre-commit enforces the native audit in its actual checkout: ${scenario}`, () => {
		const { root, head } = fixture();
		writeFileSync(join(root, "api.ts"), baselineApi.replace("value = 1", "value = 3") + (scenario === "introduced" ? "export const newlyUnused = 4;\n" : ""));
		git(root, "add", "api.ts");
		if (scenario === "invalid-base") git(root, "update-ref", "-d", "refs/remotes/origin/main");
		const result = command(root, ["git", "commit", "-m", "test: target checkout change"], scenario === "formatter-failure" ? "7" : "0");
		expect(result.stderr.toString()).toContain("fixture formatter");
		expect(result.exitCode, result.stderr.toString()).toBe(scenario === "inherited" ? 0 : 1);
		expect(git(root, "rev-parse", "HEAD") === head).toBe(scenario !== "inherited");
		if (scenario === "introduced") expect(result.stderr.toString()).toContain('"verdict":"fail"');
		if (scenario === "invalid-base") expect(result.stderr.toString()).toContain('"error":true');
		expect(readFileSync(join(root, "api.ts"), "utf8")).toContain("value = 3");
	}, 30_000);
}

test("the committed-candidate audit catches staged debt hidden by an unstaged repair", () => {
	const { root, head } = fixture();
	writeFileSync(join(root, "api.ts"), baselineApi + "export const newlyUnused = 4;\n");
	git(root, "add", "api.ts");
	writeFileSync(join(root, "api.ts"), baselineApi);
	const commit = command(root, ["git", "commit", "-m", "test: stage a finding before the repair"]);
	if (commit.exitCode !== 0) {
		// A future native index-aware gate may reject this before CI is needed.
		expect(commit.stderr.toString()).toContain('"verdict":"fail"');
		expect(git(root, "rev-parse", "HEAD")).toBe(head);
		return;
	}
	const snapshot = realpathSync(mkdtempSync(join(tmpdir(), "native-fallow-committed-")));
	temporaryRoots.push(snapshot);
	git(root, "worktree", "add", "--detach", snapshot, "HEAD");
	const audit = command(snapshot, [join(repoRoot, "node_modules/.bin/fallow"), "audit", "--base", "origin/main", "--format", "json", "--quiet", "--type-aware", "--type-aware-require", "best-effort"]);
	expect(audit.exitCode, audit.stderr.toString()).toBe(1);
	const report = JSON.parse(audit.stdout.toString());
	expect(report.verdict).toBe("fail");
	expect(report.attribution.dead_code_introduced).toBe(1);
	expect(readFileSync(join(root, "api.ts"), "utf8")).toBe(baselineApi);
}, 30_000);

for (const introduced of [false, true]) {
	test(`inherited editor companion cannot replace pinned Git analysis: introduced=${introduced}`, () => {
		const { root, head } = fixture();
		writeFileSync(join(root, "api.ts"), baselineApi.replace("value = 1", "value = 3") + (introduced ? "export const editorUnused = 4;\n" : ""));
		git(root, "add", "api.ts");
		const result = command(root, ["git", "commit", "-m", "test: editor-inherited environment"], "0", {
			FALLOW_TYPE_AWARE_BIN: join(root, "missing-editor-companion"),
			FALLOW_TYPE_AWARE_SCRIPT: join(root, "missing-editor-script"),
			FALLOW_TYPE_AWARE_BIN_SOURCE: "editor-extension",
		});
		expect(result.exitCode, result.stderr.toString()).toBe(introduced ? 1 : 0);
		expect(git(root, "rev-parse", "HEAD") === head).toBe(introduced);
		const reportLine = `${result.stdout}${result.stderr}`.split("\n").find((line) => line.startsWith('{"kind":"audit"'));
		expect(reportLine).toBeDefined();
		const report = JSON.parse(reportLine ?? "null");
		expect(report.verdict).toBe(introduced ? "fail" : "pass");
		expect(report._meta.type_aware.executed).toBe(true);
	}, 30_000);
}
