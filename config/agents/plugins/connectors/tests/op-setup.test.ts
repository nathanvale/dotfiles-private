import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { installVerifiedOp, OP_RELEASE } from "../bin/setup/op.ts";

const MODULE = path.resolve(import.meta.dir, "../bin/setup/op.ts");
const SCRIPT = `import { installVerifiedOp } from ${JSON.stringify(MODULE)}; console.log(JSON.stringify(installVerifiedOp(JSON.parse(process.env.OP_TEST_INPUT ?? "{}"))));`;

function invoke(root: string, input: Record<string, unknown>, stateRoot: string) {
	return spawnSync(process.execPath, ["-e", SCRIPT], {
		encoding: "utf8",
		env: { HOME: root, XDG_STATE_HOME: stateRoot, OP_TEST_INPUT: JSON.stringify(input), PATH: "/missing", MISE_CONFIG_FILE: path.join(root, "hostile.toml") },
	});
}

test("the official package identity is pinned independently of caller values", () => {
	expect(OP_RELEASE).toEqual({
		version: "2.39.0",
		url: "https://cache.agilebits.com/dist/1P/op2/pkg/v2.39.0/op_apple_universal_v2.39.0.pkg",
		sha256: "bde261468f3232484e2738e337e39c674c11a4537f4c6ed314f933eae558a405",
		team: "2BUA8C4S2C",
		identifier: "com.1password.op",
		binarySha256: "7e17cbf4052393d2c55a59a7c3d05f0bbcdcb079d57785cff682f3bc994ba8ce",
	});
});

test("a redirected state directory refuses before any write", () => {
	const root = mkdtempSync("/private/tmp/connectors-op-state-");
	try {
		const xdg = path.join(root, "xdg");
		const outsider = path.join(root, "outsider");
		mkdirSync(xdg);
		mkdirSync(outsider);
		const pkg = path.join(root, "package.pkg");
		writeFileSync(pkg, "invalid");
		const child = invoke(root, { packageFile: pkg, stateDirectory: outsider }, xdg);
		expect(child.status).toBe(0);
		expect(child.stderr).toBe("");
		expect(JSON.parse(child.stdout)).toEqual({ ok: false, reason: "state-invalid" });
		expect(readFileSync(pkg, "utf8")).toBe("invalid");
		expect(readdirSync(outsider)).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a symlink ancestor refuses without touching its referent", () => {
	const root = mkdtempSync("/private/tmp/connectors-op-symlink-");
	try {
		const xdg = path.join(root, "xdg");
		const outsider = path.join(root, "outsider");
		mkdirSync(xdg);
		mkdirSync(outsider);
		symlinkSync(outsider, path.join(xdg, "connectors"));
		const pkg = path.join(root, "package.pkg");
		writeFileSync(pkg, "invalid");
		const state = path.join(xdg, "connectors", "setup", "op");
		const child = invoke(root, { packageFile: pkg, stateDirectory: state }, xdg);
		expect(child.status).toBe(0);
		expect(JSON.parse(child.stdout)).toEqual({ ok: false, reason: "state-invalid" });
		expect(readdirSync(outsider)).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a wrong package and caller release claims preserve the previous selection", () => {
	const root = mkdtempSync("/private/tmp/connectors-op-wrong-pkg-");
	try {
		const xdg = path.join(root, "xdg");
		const state = path.join(xdg, "connectors", "setup", "op");
		mkdirSync(state, { recursive: true, mode: 0o700 });
		writeFileSync(path.join(state, "op-selected"), "previous", { mode: 0o600 });
		const pkg = path.join(root, "package.pkg");
		writeFileSync(pkg, "wrong package bytes");
		const child = invoke(root, { packageFile: pkg, stateDirectory: state, sha256: "caller digest", version: "999", team: "caller" }, xdg);
		expect(child.status).toBe(0);
		expect(child.stderr).toBe("");
		expect(JSON.parse(child.stdout)).toEqual({ ok: false, reason: "package-invalid" });
		expect(readFileSync(path.join(state, "op-selected"), "utf8")).toBe("previous");
		expect(readdirSync(state)).toEqual(["op-selected"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("missing and wrong package input cannot create plugin state", () => {
	const root = mkdtempSync("/private/tmp/connectors-op-no-effect-");
	try {
		const xdg = path.join(root, "xdg");
		const state = path.join(xdg, "connectors", "setup", "op");
		const missing = invoke(root, { packageFile: path.join(root, "absent.pkg"), stateDirectory: state }, xdg);
		expect(missing.status).toBe(0);
		expect(missing.stderr).toBe("");
		expect(JSON.parse(missing.stdout)).toEqual({ ok: false, reason: "package-invalid" });
		expect(existsSync(xdg)).toBe(false);
		const wrong = path.join(root, "wrong.pkg");
		writeFileSync(wrong, "wrong package bytes");
		const bad = invoke(root, { packageFile: wrong, stateDirectory: state }, xdg);
		expect(bad.status).toBe(0);
		expect(bad.stderr).toBe("");
		expect(JSON.parse(bad.stdout)).toEqual({ ok: false, reason: "package-invalid" });
		expect(existsSync(xdg)).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
