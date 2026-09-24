import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createBundle, runBundle } from "./harness.ts";

const OP_PATH = "/dist/1P/op2/pkg/v2.39.0/op_apple_universal_v2.39.0.pkg";
const MISE_BASE = "/jdx/mise/releases/download/v2026.9.12";
const PINNED_OP_SHA256 = "bde261468f3232484e2738e337e39c674c11a4537f4c6ed314f933eae558a405";
const PINNED_MISE_SHA256 = "01b15ea733709a2000a801533203e99c1490d9a3c13d45c8eb90ccefd0bd21f3";

function officialFixtures(): { op: string; manifest: string; signature: string; archive: string } | null {
	const op = process.env.CONNECTORS_TEST_OP_PACKAGE;
	const root = process.env.CONNECTORS_TEST_MISE_RELEASE_DIR;
	if (!op || !root) {
		if (process.env.CI) throw new Error("CI requires official op and mise release fixtures before compiled setup tests");
		return null;
	}
	if (!path.isAbsolute(op) || !path.isAbsolute(root)) throw new Error("official setup fixture paths must be absolute");
	const files = { op, manifest: path.join(root, "SHASUMS256.txt"), signature: path.join(root, "SHASUMS256.txt.minisig"), archive: path.join(root, "mise.tar.xz") };
	for (const file of Object.values(files)) {
		if (!statSync(file).isFile()) throw new Error("official setup fixture is not a regular file");
	}
	const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
	if (digest(op) !== PINNED_OP_SHA256 || digest(files.archive) !== PINNED_MISE_SHA256) throw new Error("official setup fixture digest mismatch");
	return files;
}

const fixtures = officialFixtures();

function fixtureServer(files: NonNullable<typeof fixtures>, interruptMise: boolean) {
	const requests: string[] = [];
	const routes: Record<string, string> = {
		[OP_PATH]: files.op,
		[`${MISE_BASE}/SHASUMS256.txt`]: files.manifest,
		[`${MISE_BASE}/SHASUMS256.txt.minisig`]: files.signature,
		[`${MISE_BASE}/mise-v2026.9.12-macos-arm64.tar.xz`]: files.archive,
	};
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
		const pathname = new URL(request.url).pathname;
		requests.push(pathname);
		if (interruptMise && pathname === `${MISE_BASE}/SHASUMS256.txt`) return new Response("fixture interruption", { status: 503 });
		const file = routes[pathname];
		return file ? new Response(Bun.file(file)) : new Response("unknown fixture path", { status: 404 });
	} });
	return { server, requests };
}

test("compiled setup refuses malformed arguments before state or network effects", async () => {
	const bundle = createBundle();
	try {
		const home = path.join(bundle.root, "home");
		mkdirSync(home);
		const result = await runBundle(bundle, ["setup", "SENTINEL_PRIVATE_VALUE"], { home, extraEnv: { XDG_STATE_HOME: path.join(bundle.root, "state") } });
		expect(result.code).toBe(2);
		expect(result.stderr).toBe("");
		expect(result.stdout).not.toContain("SENTINEL_PRIVATE_VALUE");
		const envelope = JSON.parse(result.stdout);
		expect(envelope.result.commandIdentity).toBe("connectors.setup");
		expect(envelope.result.causeCode).toBe("USAGE_SETUP_MALFORMED");
		expect(envelope.result.effects).toEqual({ completed: [], remaining: ["op", "mise", "uv"], uncertain: [], inventoryComplete: true });
		expect(existsSync(path.join(bundle.root, "state"))).toBe(false);
	} finally {
		bundle.dispose();
	}
});

test("compiled setup resolves packaged config beside copied executable and refuses an interrupted release without selecting a tool", async () => {
	const bundle = createBundle();
	const requests: string[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
		requests.push(new URL(request.url).pathname);
		return new Response("interrupted fixture bytes", { status: 200 });
	} });
	try {
		const home = path.join(bundle.root, "home");
		mkdirSync(home);
		const state = path.join(realpathSync(bundle.root), "state");
		const result = await runBundle(bundle, ["setup"], { home, extraEnv: { XDG_STATE_HOME: state, CONNECTORS_TEST_RELEASE_ORIGIN: `http://127.0.0.1:${server.port}/`, MISE_CONFIG_FILE: path.join(bundle.root, "hostile.toml") } });
		expect(result.code).toBe(3);
		expect(result.stderr).toBe("");
		const envelope = JSON.parse(result.stdout);
		expect(envelope.result.commandIdentity).toBe("connectors.setup");
		expect(envelope.result.causeCode).toBe("DOMAIN_SETUP_FAILED_UNCHANGED");
		expect(envelope.result.transactionState).toBe("unchanged");
		expect(envelope.result.effects.completed).toEqual([]);
		expect(requests).toEqual(["/dist/1P/op2/pkg/v2.39.0/op_apple_universal_v2.39.0.pkg"]);
		expect(existsSync(path.join(state, "connectors", "setup", "op", "op-selected"))).toBe(false);
		expect(readdirSync(path.join(state, "connectors", "setup", "downloads"))).toEqual([]);
	} finally {
		server.stop(true);
		bundle.dispose();
	}
});

test("ordinary compiled commands do not create setup state or invoke mise", async () => {
	const bundle = createBundle();
	try {
		const home = path.join(bundle.root, "home");
		mkdirSync(home);
		const hostile = path.join(bundle.root, "hostile.toml");
		writeFileSync(hostile, '[tools]\n"aqua:astral-sh/uv" = "0.1.0"\n');
		const state = path.join(realpathSync(bundle.root), "state");
		const result = await runBundle(bundle, ["list"], { home, extraEnv: { XDG_STATE_HOME: state, MISE_CONFIG_FILE: hostile } });
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout).result.commandIdentity).toBe("connectors.list");
		expect(readFileSync(hostile, "utf8")).toContain("0.1.0");
		expect(existsSync(state)).toBe(false);
	} finally {
		bundle.dispose();
	}
});

test.skipIf(fixtures === null)("official compiled setup completes op, mise and pinned uv with an isolated hostile environment", async () => {
	if (!fixtures) throw new Error("official fixture missing");
	const bundle = createBundle();
	const { server, requests } = fixtureServer(fixtures, false);
	try {
		const home = path.join(bundle.root, "home");
		mkdirSync(home);
		const state = path.join(realpathSync(bundle.root), "state");
		const hostile = path.join(bundle.root, "hostile.toml");
		writeFileSync(hostile, '[tools]\n"aqua:astral-sh/uv" = "0.1.0"\n');
		const result = await runBundle(bundle, ["setup"], { home, timeoutMs: 180_000, extraEnv: {
			XDG_STATE_HOME: state,
			CONNECTORS_TEST_RELEASE_ORIGIN: `http://127.0.0.1:${server.port}/`,
			MISE_CONFIG_FILE: hostile,
			MISE_DATA_DIR: path.join(bundle.root, "hostile-data"),
			MISE_UV_VERSION: "0.1.0",
			MISE_CEILING_PATHS: "/",
			MISE_CONFIG_DIR: path.join(bundle.root, "hostile-config"),
			MISE_GLOBAL_CONFIG_FILE: hostile,
			MISE_SYSTEM_CONFIG_DIR: path.join(bundle.root, "hostile-system"),
			MISE_GLOBAL_CONFIG_ROOT: bundle.root,
			MISE_CACHE_DIR: path.join(bundle.root, "hostile-cache"),
			MISE_STATE_DIR: path.join(bundle.root, "hostile-state"),
			MISE_INSTALLS_DIR: path.join(bundle.root, "hostile-installs"),
			MISE_SHIMS_DIR: path.join(bundle.root, "hostile-shims"),
			MISE_TMP_DIR: path.join(bundle.root, "hostile-temp"),
			MISE_TRUSTED_CONFIG_PATHS: "/",
		} });
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		const envelope = JSON.parse(result.stdout);
		expect(envelope.result.commandIdentity).toBe("connectors.setup");
		expect(envelope.result.outcome).toBe("success");
		expect(envelope.result.causeCode).toBe("SUCCESS_COMPLETED");
		expect(envelope.result.transactionState).toBe("completed");
		expect(envelope.result.effects).toEqual({ completed: ["op", "mise", "uv"], remaining: [], uncertain: [], inventoryComplete: true });
		expect(requests).toEqual([OP_PATH, `${MISE_BASE}/SHASUMS256.txt`, `${MISE_BASE}/SHASUMS256.txt.minisig`, `${MISE_BASE}/mise-v2026.9.12-macos-arm64.tar.xz`]);
		expect(readFileSync(path.join(state, "connectors", "setup", "op", "op-selected"), "utf8")).toMatch(/^op-2\.39\.0-/);
		expect(readFileSync(path.join(state, "connectors", "setup", "mise", "mise-selected"), "utf8")).toMatch(/^mise-2026\.9\.12-/);
		expect(existsSync(path.join(state, "connectors", "setup", "uv", "installs", "aqua-astral-sh-uv", "0.12.18", "uv-aarch64-apple-darwin", "uv"))).toBe(true);
		expect(existsSync(path.join(bundle.root, "hostile-data"))).toBe(false);
	} finally {
		server.stop(true);
		bundle.dispose();
	}
});

test.skipIf(fixtures === null)("official compiled setup retains selected op after interrupted mise download and reports partial effects", async () => {
	if (!fixtures) throw new Error("official fixture missing");
	const bundle = createBundle();
	const { server, requests } = fixtureServer(fixtures, true);
	try {
		const home = path.join(bundle.root, "home");
		mkdirSync(home);
		const state = path.join(realpathSync(bundle.root), "state");
		const result = await runBundle(bundle, ["setup"], { home, timeoutMs: 90_000, extraEnv: { XDG_STATE_HOME: state, CONNECTORS_TEST_RELEASE_ORIGIN: `http://127.0.0.1:${server.port}/` } });
		expect(result.code).toBe(3);
		expect(result.stderr).toBe("");
		const envelope = JSON.parse(result.stdout);
		expect(envelope.result.commandIdentity).toBe("connectors.setup");
		expect(envelope.result.outcome).toBe("failed");
		expect(envelope.result.causeCode).toBe("DOMAIN_SETUP_FAILED_PARTIAL");
		expect(envelope.result.transactionState).toBe("partially-completed");
		expect(envelope.result.effects).toEqual({ completed: ["op"], remaining: ["mise", "uv"], uncertain: [], inventoryComplete: true });
		expect(requests).toEqual([OP_PATH, `${MISE_BASE}/SHASUMS256.txt`]);
		expect(readFileSync(path.join(state, "connectors", "setup", "op", "op-selected"), "utf8")).toMatch(/^op-2\.39\.0-/);
		expect(existsSync(path.join(state, "connectors", "setup", "mise", "mise-selected"))).toBe(false);
		expect(readdirSync(path.join(state, "connectors", "setup", "downloads"))).toEqual([]);
	} finally {
		server.stop(true);
		bundle.dispose();
	}
});
