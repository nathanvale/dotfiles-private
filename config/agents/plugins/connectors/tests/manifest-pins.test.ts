// Spec #87: the Requirements Manifest owns the pinned op and uv versions for
// ordinary use as well as setup. The real selection modules run from a
// private copy of `bin/` beside a manifest whose op and uv pins moved, so the
// only way a selection follows the move is by reading the manifest; a code
// copy of either version would keep selecting the old layout. Module-level
// proof in a child process, not the packaged executable.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PLUGIN = path.resolve(import.meta.dir, "..");
const MODULES = ["private-state.ts", "safe-environment.ts", path.join("setup", "mise.ts"), path.join("setup", "op.ts"), path.join("setup", "uv.ts")];
const BYTES = "fake executable bytes\n";
const DIGEST = createHash("sha256").update(BYTES).digest("hex");
// Independent oracles: the moved pins and the shipped pins they replace.
const MOVED = { op: "2.39.1", uv: "0.12.99" };
const SHIPPED = { op: "2.39.0", uv: "0.12.18" };

let root: string;
let copy: string;
let state: string;
beforeEach(() => {
	root = mkdtempSync(path.join(os.tmpdir(), "connectors-manifest-pins-"));
	copy = path.join(root, "plugin");
	state = path.join(root, "state");
	for (const module of MODULES) {
		mkdirSync(path.dirname(path.join(copy, "bin", module)), { recursive: true });
		cpSync(path.join(PLUGIN, "bin", module), path.join(copy, "bin", module));
	}
	const manifest = JSON.parse(readFileSync(path.join(PLUGIN, "requirements.json"), "utf8")) as { pins: Record<string, string>; sources: Record<string, Record<string, string>> };
	manifest.pins.op = MOVED.op;
	manifest.pins.uv = MOVED.uv;
	manifest.sources.op!.binarySha256 = DIGEST;
	manifest.sources.uv!.binarySha256 = DIGEST;
	writeFileSync(path.join(copy, "requirements.json"), JSON.stringify(manifest));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function privateExecutable(file: string): void {
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	writeFileSync(file, BYTES);
	chmodSync(file, 0o700);
}

// Both version layouts setup could have published, each holding bytes whose
// digest the copy's manifest qualifies.
function publish(versions: { op: string; uv: string }): void {
	const op = path.join(state, "connectors", "setup", "op");
	const name = `op-${versions.op}-${DIGEST}`;
	privateExecutable(path.join(op, name));
	writeFileSync(path.join(op, "op-selected"), name, { mode: 0o600 });
	privateExecutable(path.join(state, "connectors", "setup", "uv", "installs", "aqua-astral-sh-uv", versions.uv, "uv-aarch64-apple-darwin", "uv"));
}

function selected(): { op: string | null; uv: string | null } {
	const script = `import { installedOp } from ${JSON.stringify(path.join(copy, "bin", "setup", "op.ts"))}; import { installedUv } from ${JSON.stringify(path.join(copy, "bin", "setup", "uv.ts"))}; const env = { XDG_STATE_HOME: process.argv[1] }; console.log(JSON.stringify({ op: installedOp(env), uv: installedUv(env) }));`;
	const child = spawnSync(process.execPath, ["-e", script, state], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: root } });
	expect([child.status, child.stderr]).toEqual([0, ""]);
	return JSON.parse(child.stdout) as { op: string | null; uv: string | null };
}

test("ordinary use selects op and uv at the versions the Requirements Manifest pins", () => {
	publish(MOVED);
	expect(selected()).toEqual({
		op: path.join(state, "connectors", "setup", "op", `op-${MOVED.op}-${DIGEST}`),
		uv: path.join(state, "connectors", "setup", "uv", "installs", "aqua-astral-sh-uv", MOVED.uv, "uv-aarch64-apple-darwin", "uv"),
	});
});

test("ordinary use refuses the previous version layouts once the Requirements Manifest moves", () => {
	publish(SHIPPED);
	expect(selected()).toEqual({ op: null, uv: null });
});
