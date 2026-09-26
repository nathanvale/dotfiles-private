import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildFaultedFrontDoor } from "./faulted-front-door.ts";
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

type ReleaseFixtures = { op: string; manifest?: string; signature?: string; archive?: string };

function officialOpFixture(): string | null {
	const op = process.env.CONNECTORS_TEST_OP_PACKAGE;
	if (!op) {
		if (process.env.CI) throw new Error("CI requires the official op release fixture before compiled setup tests");
		return null;
	}
	if (!path.isAbsolute(op)) throw new Error("official setup fixture paths must be absolute");
	if (!statSync(op).isFile()) throw new Error("official setup fixture is not a regular file");
	if (sha256(op) !== PINNED_OP_SHA256) throw new Error("official setup fixture digest mismatch");
	return op;
}

function officialFixtures(op: string | null): Required<ReleaseFixtures> | null {
	const root = process.env.CONNECTORS_TEST_MISE_RELEASE_DIR;
	if (!op || !root) {
		if (process.env.CI) throw new Error("CI requires official op and mise release fixtures before compiled setup tests");
		return null;
	}
	if (!path.isAbsolute(root)) throw new Error("official setup fixture paths must be absolute");
	const files = { op, manifest: path.join(root, "SHASUMS256.txt"), signature: path.join(root, "SHASUMS256.txt.minisig"), archive: path.join(root, "mise.tar.xz") };
	for (const file of Object.values(files)) {
		if (!statSync(file).isFile()) throw new Error("official setup fixture is not a regular file");
	}
	if (sha256(files.archive) !== PINNED_MISE_SHA256) throw new Error("official setup fixture digest mismatch");
	return files;
}

function sha256(file: string): string {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const opFixture = officialOpFixture();
const fixtures = officialFixtures(opFixture);
// Supplied by the test runner from an independently fetched MCPorter release.
const officialMcporter = process.env.CONNECTORS_OFFICIAL_RELEASE_FIXTURE;

type ServerHook = (pathname: string) => Response | null;

function fixtureServer(files: ReleaseFixtures, hook: ServerHook = () => null) {
	const requests: string[] = [];
	const routes: Record<string, string | undefined> = {
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

test("compiled setup refuses malformed arguments without echoing them or creating state", async () => {
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

test("an ordinary compiled list does not create setup state or invoke op, mise, or uv from PATH", async () => {
	const bundle = createBundle();
	try {
		const home = path.join(bundle.root, "home");
		mkdirSync(home);
		// PATH decoys record any attempt to run a setup-owned tool.
		const decoys = path.join(bundle.root, "decoy-bin");
		mkdirSync(decoys);
		const invoked = path.join(bundle.root, "invoked-tools");
		for (const tool of ["op", "mise", "uv", "uvx"]) {
			writeFileSync(path.join(decoys, tool), `#!/bin/sh\necho ${tool} >> '${invoked}'\nexit 0\n`, { mode: 0o755 });
		}
		const state = path.join(realpathSync(bundle.root), "state");
		const result = await runBundle(bundle, ["list"], { home, binDir: decoys, extraEnv: { XDG_STATE_HOME: state } });
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout).result.commandIdentity).toBe("connectors.list");
		expect(existsSync(invoked)).toBe(false);
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

const MISE_INTERRUPTED: ServerHook = (pathname) => pathname === `${MISE_BASE}/SHASUMS256.txt` ? new Response("fixture interruption", { status: 503 }) : null;
const OP_INTERRUPTED: ServerHook = (pathname) => pathname === OP_PATH ? new Response("interrupted fixture bytes", { status: 200 }) : null;

// Ticket #103: bytes a partial copy or local edit could leave at the pinned
// revision name. Independent of every production digest.
const DAMAGED_OP_BYTES = "wrong-bytes";
// A selection left by an earlier setup, so restoring op-selected is observable.
const PREVIOUS_OP_SELECTED = `op-2.38.0-${"0".repeat(64)}`;
// Independent oracle: the only permission bits a published op revision holds.
const PUBLISHED_OP_MODE = 0o700;

async function runOpSetup(bundle: ReturnType<typeof createBundle>, state: string, hook: ServerHook) {
	if (!opFixture) throw new Error("official op fixture missing");
	const { server, requests } = fixtureServer({ op: opFixture }, hook);
	try {
		const home = path.join(bundle.root, "home");
		mkdirSync(home, { recursive: true });
		const result = await runBundle(bundle, ["setup"], { home, timeoutMs: 90_000, extraEnv: { XDG_STATE_HOME: state, CONNECTORS_TEST_RELEASE_ORIGIN: `http://127.0.0.1:${server.port}/` } });
		expect(result.stderr).toBe("");
		expect(result.stdout.trim().split("\n")).toHaveLength(1);
		return { code: result.code, envelope: JSON.parse(result.stdout), requests, home };
	} finally {
		server.stop(true);
	}
}

// The selected revision is a runnable official op, not merely matching bytes.
function opVersion(executable: string, home: string): string {
	const probe = Bun.spawnSync([executable, "--version"], { env: { PATH: "/usr/bin:/bin", HOME: home }, stdout: "pipe", stderr: "pipe" });
	expect(probe.exitCode).toBe(0);
	return probe.stdout.toString().trim();
}

function opPaths(bundle: ReturnType<typeof createBundle>) {
	const state = path.join(realpathSync(bundle.root), "state");
	const opState = path.join(state, "connectors", "setup", "op");
	return { state, opState, revision: path.join(opState, OP_SELECTED), selection: path.join(opState, "op-selected") };
}

type OpPaths = ReturnType<typeof opPaths>;

// A verified packaged run leaves the official binary at the pinned revision, so
// a row can then damage only its mode.
async function seedOfficialRevision(bundle: ReturnType<typeof createBundle>, paths: OpPaths) {
	const seeded = await runOpSetup(bundle, paths.state, MISE_INTERRUPTED);
	expect(seeded.envelope.result.effects.completed).toEqual(["op"]);
	expect(sha256(paths.revision)).toBe(OP_BINARY_SHA256);
}

async function seedWrongBytes(_bundle: ReturnType<typeof createBundle>, paths: OpPaths) {
	writeFileSync(paths.revision, DAMAGED_OP_BYTES);
}

// Ticket #103: each row leaves a damaged regular file at the pinned revision.
// Explicit setup publishes the verified stage file over it; it never keeps,
// rewrites, or re-modes the damaged entry in place. The 0700 row is the
// reproduced defect: its mode matches, so only the digest marks it damaged.
// `selected` is op-selected before the run. The in-field state keeps the
// selection on the damaged revision, so a selection is never proof of bytes.
const DAMAGED_REVISIONS: ReadonlyArray<{ name: string; mode: number; selected: string; seed: (bundle: ReturnType<typeof createBundle>, paths: OpPaths) => Promise<void> }> = [
	{ name: "wrong bytes at published mode 0700", mode: 0o700, selected: PREVIOUS_OP_SELECTED, seed: seedWrongBytes },
	{ name: "wrong bytes at published mode 0700 while op-selected already names it", mode: 0o700, selected: OP_SELECTED, seed: seedWrongBytes },
	{ name: "wrong bytes at mode 0600", mode: 0o600, selected: PREVIOUS_OP_SELECTED, seed: seedWrongBytes },
	{ name: "official bytes at mode 0600", mode: 0o600, selected: PREVIOUS_OP_SELECTED, seed: seedOfficialRevision },
	{ name: "official bytes at world-writable mode 0777", mode: 0o777, selected: PREVIOUS_OP_SELECTED, seed: seedOfficialRevision },
	{ name: "official bytes at unreadable mode 0000", mode: 0o000, selected: PREVIOUS_OP_SELECTED, seed: seedOfficialRevision },
];

for (const row of DAMAGED_REVISIONS) {
	test.skipIf(opFixture === null)(`official compiled setup restores the pinned op revision from ${row.name}`, async () => {
		const bundle = createBundle();
		try {
			const paths = opPaths(bundle);
			mkdirSync(paths.opState, { recursive: true, mode: 0o700 });
			await row.seed(bundle, paths);
			chmodSync(paths.revision, row.mode);
			writeFileSync(paths.selection, row.selected, { mode: 0o600 });
			const damaged = lstatSync(paths.revision);
			expect(damaged.mode & 0o7777).toBe(row.mode);
			expect(readFileSync(paths.selection, "utf8")).toBe(row.selected);
			const { code, envelope, requests, home } = await runOpSetup(bundle, paths.state, MISE_INTERRUPTED);
			expect(code).toBe(3);
			expect(envelope.result.commandIdentity).toBe("connectors.setup");
			expect(envelope.result.causeCode).toBe("DOMAIN_SETUP_FAILED_PARTIAL");
			expect(envelope.result.effects).toEqual({ completed: ["op"], remaining: ["mise", "uv"], uncertain: [], inventoryComplete: true });
			expect(requests).toEqual([OP_PATH, `${MISE_BASE}/SHASUMS256.txt`]);
			expect(readdirSync(paths.opState).sort()).toEqual([OP_SELECTED, "op-selected"].sort());
			expect(readFileSync(paths.selection, "utf8")).toBe(OP_SELECTED);
			const published = lstatSync(paths.revision);
			expect(published.isFile()).toBe(true);
			expect(published.ino).not.toBe(damaged.ino);
			expect(published.mode & 0o7777).toBe(PUBLISHED_OP_MODE);
			expect(sha256(paths.revision)).toBe(OP_BINARY_SHA256);
			expect(opVersion(paths.revision, home)).toBe("2.39.0");
		} finally {
			bundle.dispose();
		}
	}, 200_000);
}

const OUTSIDE_BYTES = "outside bytes";
const OUTSIDE_MODE = 0o640;

// Any entry other than a regular file at the pinned revision refuses after
// verification. Nothing it points at is followed, replaced, or re-moded.
const NON_FILE_REVISIONS: ReadonlyArray<{ name: string; plant: (revision: string, outside: string) => void; entry: (revision: string) => boolean }> = [
	{ name: "symlink to an outside file", plant: (revision, outside) => symlinkSync(outside, revision), entry: (revision) => lstatSync(revision).isSymbolicLink() },
	{ name: "directory", plant: (revision) => mkdirSync(revision), entry: (revision) => lstatSync(revision).isDirectory() },
];

for (const row of NON_FILE_REVISIONS) {
	test.skipIf(opFixture === null)(`official compiled setup refuses a ${row.name} at the pinned op revision`, async () => {
		const bundle = createBundle();
		try {
			const paths = opPaths(bundle);
			mkdirSync(paths.opState, { recursive: true, mode: 0o700 });
			const outside = path.join(bundle.root, "outside");
			writeFileSync(outside, OUTSIDE_BYTES);
			chmodSync(outside, OUTSIDE_MODE);
			row.plant(paths.revision, outside);
			writeFileSync(paths.selection, "previous", { mode: 0o600 });
			const { code, envelope, requests } = await runOpSetup(bundle, paths.state, MISE_INTERRUPTED);
			expect(code).toBe(3);
			expect(envelope.message).toBe("connectors: op setup failed: install-failed");
			expect(envelope.result.causeCode).toBe("DOMAIN_SETUP_FAILED_UNCHANGED");
			expect(envelope.result.transactionState).toBe("unchanged");
			expect(envelope.result.effects).toEqual(ALL_REMAINING);
			expect(requests).toEqual([OP_PATH]);
			expect(row.entry(paths.revision)).toBe(true);
			expect(readFileSync(outside, "utf8")).toBe(OUTSIDE_BYTES);
			expect(lstatSync(outside).mode & 0o7777).toBe(OUTSIDE_MODE);
			expect(readFileSync(paths.selection, "utf8")).toBe("previous");
			expect(readdirSync(paths.opState).sort()).toEqual([OP_SELECTED, "op-selected"].sort());
		} finally {
			bundle.dispose();
		}
	}, 100_000);
}

// The corrupt body fails the package digest in the download step, before op
// verification or publication runs. Interrupted verification or publication
// inside op setup is inferred from source order and rename atomicity only.
test.skipIf(opFixture === null)("a corrupt op download never publishes its bytes and preserves damaged bytes or a working selection", async () => {
	const bundle = createBundle();
	try {
		const { state, opState, revision } = opPaths(bundle);

		// Damaged bytes are never replaced by unverified package bytes.
		mkdirSync(opState, { recursive: true, mode: 0o700 });
		writeFileSync(revision, DAMAGED_OP_BYTES, { mode: 0o700 });
		const damaged = await runOpSetup(bundle, state, OP_INTERRUPTED);
		expect(damaged.code).toBe(3);
		expect(damaged.envelope.result.causeCode).toBe("DOMAIN_SETUP_FAILED_UNCHANGED");
		expect(damaged.envelope.result.effects.completed).toEqual([]);
		expect(readFileSync(revision, "utf8")).toBe(DAMAGED_OP_BYTES);
		expect(readdirSync(opState)).toEqual([OP_SELECTED]);

		// A verified run establishes a working selection.
		rmSync(revision);
		const working = await runOpSetup(bundle, state, MISE_INTERRUPTED);
		expect(working.envelope.result.effects.completed).toEqual(["op"]);
		const observe = () => ({ selected: readFileSync(path.join(opState, "op-selected"), "utf8"), digest: sha256(revision), inode: lstatSync(revision).ino });
		const before = observe();
		expect(before.selected).toBe(OP_SELECTED);
		expect(before.digest).toBe(OP_BINARY_SHA256);

		// A corrupt download neither unlinks, replaces, nor reselects it.
		const later = await runOpSetup(bundle, state, OP_INTERRUPTED);
		expect(later.code).toBe(3);
		expect(later.envelope.result.causeCode).toBe("DOMAIN_SETUP_FAILED_UNCHANGED");
		expect(later.envelope.result.transactionState).toBe("unchanged");
		expect(later.requests).toEqual([OP_PATH]);
		expect(observe()).toEqual(before);
		expect(readdirSync(opState).sort()).toEqual([OP_SELECTED, "op-selected"].sort());
		expect(opVersion(revision, later.home)).toBe("2.39.0");
	} finally {
		bundle.dispose();
	}
}, 200_000);

// Fault injection for the post-commit station: a test-only build whose final
// success envelope names an unchanged outcome while reporting completed
// effects, so output validation throws after op, mise and uv are committed and
// before any stdout write. The shipped source has no such fault.
test.skipIf(fixtures === null)("official compiled setup reports committed effects when output validation fails after uv", async () => {
	if (!fixtures) throw new Error("official fixture missing");
	const bundle = createBundle();
	const { server, requests } = fixtureServer(fixtures);
	try {
		buildFaultedFrontDoor(bundle.root, bundle.binary, { find: 'emitSetup("SUCCESS_COMPLETED", completed,', replace: 'emitSetup("DOMAIN_SETUP_FAILED_UNCHANGED", completed,' });
		const home = path.join(bundle.root, "home");
		mkdirSync(home);
		const state = path.join(realpathSync(bundle.root), "state");
		const setup = path.join(state, "connectors", "setup");
		const result = await runBundle(bundle, ["setup"], { home, timeoutMs: 180_000, extraEnv: {
			XDG_STATE_HOME: state,
			CONNECTORS_TEST_RELEASE_ORIGIN: `http://127.0.0.1:${server.port}/`,
			OP_SERVICE_ACCOUNT_TOKEN: "SENTINEL_PRIVATE_VALUE",
		} });
		expect(result.code).toBe(1);
		expect(result.stderr).toBe("");
		expect(result.stdout.trim().split("\n")).toHaveLength(1);
		expect(result.stdout).not.toContain("SENTINEL_PRIVATE_VALUE");
		const envelope = JSON.parse(result.stdout);
		expect(envelope.result.commandIdentity).toBe("connectors.setup");
		expect(envelope.result.outcome).toBe("failed");
		expect(envelope.result.failureClass).toBe("internal");
		expect(envelope.result.causeCode).toBe("INTERNAL_SETUP_AFTER_COMMIT");
		expect(envelope.result.transactionState).toBe("completed");
		expect(envelope.result.effects).toEqual({ completed: ["op", "mise", "uv"], remaining: [], uncertain: [], inventoryComplete: true });
		expect(envelope.diagnostics).toEqual({ detail: "internal contract validation or serialization failed before output" });
		expect(requests).toEqual([OP_PATH, `${MISE_BASE}/SHASUMS256.txt`, `${MISE_BASE}/SHASUMS256.txt.minisig`, `${MISE_BASE}/mise-v2026.9.12-macos-arm64.tar.xz`]);
		// The reported completed effects are durable, not merely claimed.
		expect(readFileSync(path.join(setup, "op", "op-selected"), "utf8")).toBe(OP_SELECTED);
		expect(sha256(path.join(setup, "op", OP_SELECTED))).toBe(OP_BINARY_SHA256);
		expect(readFileSync(path.join(setup, "mise", "mise-selected"), "utf8")).toBe(MISE_SELECTED);
		expect(sha256(path.join(setup, "mise", MISE_SELECTED))).toBe(MISE_BINARY_SHA256);
		expect(sha256(path.join(setup, "uv", "installs", "aqua-astral-sh-uv", "0.12.18", "uv-aarch64-apple-darwin", "uv"))).toBe(UV_BINARY_SHA256);
		expect(readdirSync(path.join(setup, "downloads"))).toEqual([]);
	} finally {
		server.stop(true);
		bundle.dispose();
	}
}, 240_000);
