import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createBundle, createFakeMcporterBinDir, runBundle } from "./harness.ts";

const OP_PATH = "/dist/1P/op2/pkg/v2.39.0/op_apple_universal_v2.39.0.pkg";
const MISE_BASE = "/jdx/mise/releases/download/v2026.9.12";
const PINNED_OP_SHA256 = "bde261468f3232484e2738e337e39c674c11a4537f4c6ed314f933eae558a405";
const PINNED_MISE_SHA256 = "01b15ea733709a2000a801533203e99c1490d9a3c13d45c8eb90ccefd0bd21f3";
// Independent oracle: restated from the accepted pins so a dedupe pass does
// not hoist them into the production release records under test.
const OP_BINARY_SHA256 = "7e17cbf4052393d2c55a59a7c3d05f0bbcdcb079d57785cff682f3bc994ba8ce";
const OP_SELECTED = `op-2.39.0-${OP_BINARY_SHA256}`;
const MISE_BINARY_SHA256 = "f20d7cc555a5b0ee7b8a504acbc2583be1b0848d64115cfbe84119ceb705025b";
const MISE_SELECTED = `mise-2026.9.12-${MISE_BINARY_SHA256}`;
const UV_BINARY_SHA256 = "17914b3f58e645361bf68424cbc71d834a96a7ada71625b28776bd7c3760afb0";
const ALL_REMAINING = { completed: [], remaining: ["op", "mise", "uv"], uncertain: [], inventoryComplete: true };
// A parent config that would add a tool and downgrade uv if mise inherited it.
const HOSTILE_MISE_CONFIG = '[tools]\n"aqua:astral-sh/uv" = "0.1.0"\n"aqua:jqlang/jq" = "1.7.1"\n';

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
	if (sha256(op) !== PINNED_OP_SHA256 || sha256(files.archive) !== PINNED_MISE_SHA256) throw new Error("official setup fixture digest mismatch");
	return files;
}

function sha256(file: string): string {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const fixtures = officialFixtures();
// Supplied by the test runner from an independently fetched MCPorter release.
const officialMcporter = process.env.CONNECTORS_OFFICIAL_RELEASE_FIXTURE;

type ServerHook = (pathname: string) => Response | null;

function fixtureServer(files: NonNullable<typeof fixtures>, hook: ServerHook = () => null) {
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
		const injected = hook(pathname);
		if (injected) return injected;
		const file = routes[pathname];
		return file ? new Response(Bun.file(file)) : new Response("unknown fixture path", { status: 404 });
	} });
	return { server, requests };
}

// Every ambient mise variable points at hostile locations or values. A leak
// of any of them into setup's mise child would create or read these paths.
function hostileMiseEnvironment(root: string, hostileFile: string): Record<string, string> {
	return {
		MISE_CONFIG_FILE: hostileFile,
		MISE_GLOBAL_CONFIG_FILE: hostileFile,
		MISE_ENV: "hostile",
		MISE_DATA_DIR: path.join(root, "hostile-data"),
		MISE_UV_VERSION: "0.1.0",
		MISE_CEILING_PATHS: "/",
		MISE_CONFIG_DIR: path.join(root, "hostile-config"),
		MISE_SYSTEM_CONFIG_DIR: path.join(root, "hostile-system"),
		MISE_GLOBAL_CONFIG_ROOT: root,
		MISE_CACHE_DIR: path.join(root, "hostile-cache"),
		MISE_STATE_DIR: path.join(root, "hostile-state"),
		MISE_INSTALLS_DIR: path.join(root, "hostile-installs"),
		MISE_SHIMS_DIR: path.join(root, "hostile-shims"),
		MISE_TMP_DIR: path.join(root, "hostile-temp"),
		MISE_TRUSTED_CONFIG_PATHS: "/",
		MISE_YES: "1",
	};
}

const HOSTILE_DIRECTORIES = ["hostile-data", "hostile-config", "hostile-system", "hostile-cache", "hostile-state", "hostile-installs", "hostile-shims", "hostile-temp"];

function snapshot(files: readonly string[]): Record<string, { bytes: string; mtimeMs: number }> {
	return Object.fromEntries(files.map((file) => [file, { bytes: readFileSync(file, "utf8"), mtimeMs: statSync(file).mtimeMs }]));
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
		expect(envelope.result.effects).toEqual(ALL_REMAINING);
		expect(existsSync(path.join(bundle.root, "state"))).toBe(false);
	} finally {
		bundle.dispose();
	}
});

// Each row corrupts one packaged file beside the copied executable. The
// interrupted-release test below runs the same bundle shape with pristine
// config and does reach the network, so the refusal here is caused by config.
const CONFIG_CORRUPTIONS: ReadonlyArray<{ name: string; file: string; from: string; to: string }> = [
	{ name: "uv config pin differs from the accepted version", file: "config/mise.toml", from: '"0.12.18"', to: '"0.1.0"' },
	{ name: "uv lock checksum differs from the pinned source", file: "config/mise.lock", from: "sha256:cf40e0c6", to: "sha256:00000000" },
	{ name: "uv config is not TOML", file: "config/mise.toml", from: "[tools]", to: "[tools" },
	{ name: "requirements pin differs from config", file: "requirements.json", from: '"uv": "0.12.18"', to: '"uv": "0.12.17"' },
];

for (const corruption of CONFIG_CORRUPTIONS) {
	test(`compiled setup refuses packaged config before state or network effects: ${corruption.name}`, async () => {
		const bundle = createBundle();
		const requests: string[] = [];
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
			requests.push(new URL(request.url).pathname);
			return new Response("unexpected request", { status: 500 });
		} });
		try {
			const target = path.join(bundle.root, corruption.file);
			const original = readFileSync(target, "utf8");
			expect(original).toContain(corruption.from);
			writeFileSync(target, original.replace(corruption.from, corruption.to));
			const home = path.join(bundle.root, "home");
			mkdirSync(home);
			const state = path.join(realpathSync(bundle.root), "state");
			const result = await runBundle(bundle, ["setup"], { home, extraEnv: { XDG_STATE_HOME: state, CONNECTORS_TEST_RELEASE_ORIGIN: `http://127.0.0.1:${server.port}/` } });
			expect(result.code).toBe(4);
			expect(result.stderr).toBe("");
			const envelope = JSON.parse(result.stdout);
			expect(envelope.result.commandIdentity).toBe("connectors.setup");
			expect(envelope.result.outcome).toBe("refused");
			expect(envelope.result.causeCode).toBe("SCHEMA_SETUP_CONFIG_INVALID");
			expect(envelope.result.transactionState).toBe("unchanged");
			expect(envelope.result.effects).toEqual(ALL_REMAINING);
			expect(requests).toEqual([]);
			expect(existsSync(state)).toBe(false);
		} finally {
			server.stop(true);
			bundle.dispose();
		}
	});
}

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

test("compiled setup reports op as uncertain when staging cleanup fails mid-download", async () => {
	const bundle = createBundle();
	const home = path.join(bundle.root, "home");
	mkdirSync(home);
	const state = path.join(realpathSync(bundle.root), "state");
	const downloads = path.join(state, "connectors", "setup", "downloads");
	const requests: string[] = [];
	// While the op body is in flight, the staging parent becomes read-only, so
	// the command cannot remove its own stage and cannot claim an unchanged result.
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
		requests.push(new URL(request.url).pathname);
		chmodSync(downloads, 0o500);
		return new Response("interrupted fixture bytes", { status: 200 });
	} });
	try {
		const result = await runBundle(bundle, ["setup"], { home, extraEnv: { XDG_STATE_HOME: state, CONNECTORS_TEST_RELEASE_ORIGIN: `http://127.0.0.1:${server.port}/` } });
		expect(result.code).toBe(1);
		expect(result.stderr).toBe("");
		expect(result.stdout.trim().split("\n")).toHaveLength(1);
		const envelope = JSON.parse(result.stdout);
		expect(envelope.result.commandIdentity).toBe("connectors.setup");
		expect(envelope.result.outcome).toBe("failed");
		expect(envelope.result.causeCode).toBe("INTERNAL_SETUP_UNKNOWN");
		expect(envelope.result.transactionState).toBe("unknown");
		expect(envelope.result.effects).toEqual({ completed: [], remaining: ["mise", "uv"], uncertain: ["op"], inventoryComplete: true });
		expect(requests).toEqual([OP_PATH]);
		expect(existsSync(path.join(state, "connectors", "setup", "op", "op-selected"))).toBe(false);
		const leftovers = readdirSync(downloads);
		expect(leftovers).toHaveLength(1);
		expect(leftovers[0]!.startsWith(".op-fetch-")).toBe(true);
	} finally {
		server.stop(true);
		if (existsSync(downloads)) chmodSync(downloads, 0o700);
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

test.skipIf(!officialMcporter)("ordinary first use that bootstraps MCPorter never installs or invokes op, mise, or uv", async () => {
	const bundle = createBundle();
	const hostileBin = createFakeMcporterBinDir();
	try {
		const home = path.join(bundle.root, "home");
		const source = path.join(bundle.root, "official-source");
		mkdirSync(home);
		mkdirSync(source);
		cpSync(path.join(officialMcporter!, "mcporter_0.14.0_darwin_arm64.tar.gz"), path.join(source, "mcporter_0.14.0_darwin_arm64.tar.gz"));
		cpSync(path.join(officialMcporter!, "provenance.json"), path.join(source, "provenance.json"));
		bundle.addSkill("keyless-fixture-skill");
		// PATH decoys record any attempt to run a setup-owned tool.
		const invoked = path.join(bundle.root, "invoked-tools");
		for (const tool of ["op", "mise", "uv", "uvx"]) {
			writeFileSync(path.join(hostileBin.binDir, tool), `#!/bin/sh\necho ${tool} >> '${invoked}'\nexit 0\n`, { mode: 0o755 });
		}
		const hostile = path.join(bundle.root, "hostile.toml");
		writeFileSync(hostile, HOSTILE_MISE_CONFIG);
		const before = snapshot([hostile]);
		const state = path.join(realpathSync(bundle.root), "state");
		mkdirSync(state, { mode: 0o700 });
		const result = await runBundle(bundle, ["schema", "keyless-fixture-skill"], { home, binDir: hostileBin.binDir, timeoutMs: 30_000, extraEnv: {
			XDG_STATE_HOME: state,
			CONNECTORS_TEST_RELEASE_DIR: source,
			...hostileMiseEnvironment(bundle.root, hostile),
		} });
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		const envelope = JSON.parse(result.stdout);
		expect(envelope.result.commandIdentity).toBe("connectors.schema");
		expect(envelope.result.causeCode).toBe("SUCCESS_BOOTSTRAPPED");
		expect(envelope.result.effects.completed).toEqual(["mcporter-bootstrap"]);
		expect(readdirSync(path.join(state, "connectors"))).toEqual(["mcporter"]);
		expect(existsSync(invoked)).toBe(false);
		expect(snapshot([hostile])).toEqual(before);
		for (const directory of HOSTILE_DIRECTORIES) expect(existsSync(path.join(bundle.root, directory))).toBe(false);
	} finally {
		hostileBin.dispose();
		bundle.dispose();
	}
}, 30_000);

test.skipIf(fixtures === null)("official compiled setup completes op, mise and pinned uv despite hostile parent config and every ambient mise variable", async () => {
	if (!fixtures) throw new Error("official fixture missing");
	const bundle = createBundle();
	const { server, requests } = fixtureServer(fixtures);
	try {
		const home = path.join(bundle.root, "home");
		mkdirSync(home);
		const root = realpathSync(bundle.root);
		const state = path.join(root, "state");
		const setup = path.join(state, "connectors", "setup");
		const uvState = path.join(setup, "uv");
		mkdirSync(uvState, { recursive: true, mode: 0o700 });
		// A typical ~/.local/state is owner-owned 0755; only Connectors'
		// descendants are private.
		chmodSync(state, 0o755);
		for (const directory of [path.join(state, "connectors"), setup, uvState]) chmodSync(directory, 0o700);
		// Hostile config at every ancestor of the uv workspace, including the
		// uv state directory itself and the MISE_ENV-selected file name.
		const hostile = path.join(root, "hostile.toml");
		const hostileFiles = [hostile, path.join(root, "mise.toml"), path.join(root, "mise.hostile.toml"), path.join(state, ".mise.toml"), path.join(setup, "mise.toml"), path.join(uvState, ".mise.toml"), path.join(uvState, "mise.toml")];
		for (const file of hostileFiles) writeFileSync(file, HOSTILE_MISE_CONFIG);
		const before = snapshot(hostileFiles);
		const result = await runBundle(bundle, ["setup"], { home, timeoutMs: 180_000, extraEnv: {
			XDG_STATE_HOME: state,
			CONNECTORS_TEST_RELEASE_ORIGIN: `http://127.0.0.1:${server.port}/`,
			...hostileMiseEnvironment(root, hostile),
		} });
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		const envelope = JSON.parse(result.stdout);
		expect(envelope.result.commandIdentity).toBe("connectors.setup");
		expect(envelope.result.outcome).toBe("success");
		expect(envelope.result.causeCode).toBe("SUCCESS_COMPLETED");
		expect(envelope.result.transactionState).toBe("completed");
		expect(envelope.result.data).toEqual({ installed: ["op", "mise", "uv"] });
		expect(envelope.result.effects).toEqual({ completed: ["op", "mise", "uv"], remaining: [], uncertain: [], inventoryComplete: true });
		expect(requests).toEqual([OP_PATH, `${MISE_BASE}/SHASUMS256.txt`, `${MISE_BASE}/SHASUMS256.txt.minisig`, `${MISE_BASE}/mise-v2026.9.12-macos-arm64.tar.xz`]);

		expect(readFileSync(path.join(setup, "op", "op-selected"), "utf8")).toBe(OP_SELECTED);
		expect(sha256(path.join(setup, "op", OP_SELECTED))).toBe(OP_BINARY_SHA256);
		expect(readFileSync(path.join(setup, "mise", "mise-selected"), "utf8")).toBe(MISE_SELECTED);
		expect(sha256(path.join(setup, "mise", MISE_SELECTED))).toBe(MISE_BINARY_SHA256);

		// Only the pinned uv from plugin config was installed; an inherited
		// parent config would have added jq or the 0.1.0 uv here.
		const installs = path.join(uvState, "installs");
		expect(readdirSync(installs).sort()).toEqual([".mise-installs.toml", "aqua-astral-sh-uv"]);
		const uvVersions = path.join(installs, "aqua-astral-sh-uv");
		expect(readdirSync(uvVersions).sort()).toEqual([".mise.backend.toml", "0", "0.12", "0.12.18", "latest"]);
		// mise's version aliases must all point at the one pinned install.
		for (const alias of ["0", "0.12", "latest"]) {
			expect(lstatSync(path.join(uvVersions, alias)).isSymbolicLink()).toBe(true);
			expect(realpathSync(path.join(uvVersions, alias))).toBe(path.join(uvVersions, "0.12.18"));
		}
		expect(lstatSync(path.join(uvVersions, "0.12.18")).isDirectory()).toBe(true);
		const uv = path.join(installs, "aqua-astral-sh-uv", "0.12.18", "uv-aarch64-apple-darwin", "uv");
		expect(sha256(uv)).toBe(UV_BINARY_SHA256);
		const probe = Bun.spawnSync([uv, "--version"], { env: { PATH: "/usr/bin:/bin", HOME: home }, stdout: "pipe", stderr: "pipe" });
		expect(probe.exitCode).toBe(0);
		expect(probe.stdout.toString().startsWith("uv 0.12.18 ")).toBe(true);

		expect(readdirSync(path.join(setup, "downloads"))).toEqual([]);
		expect(readdirSync(uvState).filter((entry) => entry.startsWith(".uv-install-"))).toEqual([]);
		expect(snapshot(hostileFiles)).toEqual(before);
		for (const directory of HOSTILE_DIRECTORIES) expect(existsSync(path.join(root, directory))).toBe(false);
	} finally {
		server.stop(true);
		bundle.dispose();
	}
}, 200_000);

test.skipIf(fixtures === null)("official compiled setup retains selected op after interrupted mise download and reports partial effects", async () => {
	if (!fixtures) throw new Error("official fixture missing");
	const bundle = createBundle();
	const { server, requests } = fixtureServer(fixtures, (pathname) => pathname === `${MISE_BASE}/SHASUMS256.txt` ? new Response("fixture interruption", { status: 503 }) : null);
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
		expect(readFileSync(path.join(state, "connectors", "setup", "op", "op-selected"), "utf8")).toBe(OP_SELECTED);
		expect(existsSync(path.join(state, "connectors", "setup", "mise", "mise-selected"))).toBe(false);
		expect(readdirSync(path.join(state, "connectors", "setup", "downloads"))).toEqual([]);
	} finally {
		server.stop(true);
		bundle.dispose();
	}
}, 100_000);

test.skipIf(fixtures === null)("official compiled setup reports mise as uncertain after op when mise staging cleanup fails", async () => {
	if (!fixtures) throw new Error("official fixture missing");
	const bundle = createBundle();
	const home = path.join(bundle.root, "home");
	mkdirSync(home);
	const state = path.join(realpathSync(bundle.root), "state");
	const downloads = path.join(state, "connectors", "setup", "downloads");
	const { server, requests } = fixtureServer(fixtures, (pathname) => {
		if (pathname !== `${MISE_BASE}/SHASUMS256.txt`) return null;
		chmodSync(downloads, 0o500);
		return new Response("fixture interruption", { status: 503 });
	});
	try {
		const result = await runBundle(bundle, ["setup"], { home, timeoutMs: 90_000, extraEnv: { XDG_STATE_HOME: state, CONNECTORS_TEST_RELEASE_ORIGIN: `http://127.0.0.1:${server.port}/` } });
		expect(result.code).toBe(1);
		expect(result.stderr).toBe("");
		const envelope = JSON.parse(result.stdout);
		expect(envelope.result.commandIdentity).toBe("connectors.setup");
		expect(envelope.result.causeCode).toBe("INTERNAL_SETUP_UNKNOWN");
		expect(envelope.result.transactionState).toBe("unknown");
		expect(envelope.result.effects).toEqual({ completed: ["op"], remaining: ["uv"], uncertain: ["mise"], inventoryComplete: true });
		expect(requests).toEqual([OP_PATH, `${MISE_BASE}/SHASUMS256.txt`]);
		expect(readFileSync(path.join(state, "connectors", "setup", "op", "op-selected"), "utf8")).toBe(OP_SELECTED);
		expect(existsSync(path.join(state, "connectors", "setup", "mise", "mise-selected"))).toBe(false);
		const leftovers = readdirSync(downloads);
		expect(leftovers).toHaveLength(1);
		expect(leftovers[0]!.startsWith(".mise-fetch-")).toBe(true);
	} finally {
		server.stop(true);
		if (existsSync(downloads)) chmodSync(downloads, 0o700);
		bundle.dispose();
	}
}, 100_000);
