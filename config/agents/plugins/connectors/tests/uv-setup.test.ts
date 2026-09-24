import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installPinnedUv, readValidatedUvSources, stageValidatedUvSources, validUvSources } from "../bin/setup/uv.ts";

const requirements = readFileSync(path.resolve(import.meta.dir, "../requirements.json"), "utf8");
const config = readFileSync(path.resolve(import.meta.dir, "../config/mise.toml"), "utf8");
const lock = readFileSync(path.resolve(import.meta.dir, "../config/mise.lock"), "utf8");
const miseName = "mise-2026.9.12-f20d7cc555a5b0ee7b8a504acbc2583be1b0848d64115cfbe84119ceb705025b";
const officialMiseSha256 = "f20d7cc555a5b0ee7b8a504acbc2583be1b0848d64115cfbe84119ceb705025b";

function resolveOfficialMiseFixture(env: Record<string, string | undefined>): string | null {
	const executable = env.CONNECTORS_TEST_MISE_BINARY;
	if (!executable) {
		if (env.CI) throw new Error("CI requires CONNECTORS_TEST_MISE_BINARY before bun run check");
		return null;
	}
	if (!path.isAbsolute(executable)) throw new Error("CONNECTORS_TEST_MISE_BINARY must be an absolute path");
	try {
		if (!statSync(executable).isFile()) throw new Error("not a regular file");
		accessSync(executable, constants.X_OK);
		if (createHash("sha256").update(readFileSync(executable)).digest("hex") !== officialMiseSha256) throw new Error("digest mismatch");
	} catch {
		throw new Error("CONNECTORS_TEST_MISE_BINARY must be an executable official mise v2026.9.12 macOS arm64 binary with the pinned SHA-256");
	}
	return executable;
}

const officialMise = resolveOfficialMiseFixture(process.env);

function requiredMise(): string {
	if (!officialMise) throw new Error("official mise fixture was not selected");
	return officialMise;
}

function isolatedMise(root: string, executable: string): { mise: string; state: string } {
	expect(createHash("sha256").update(readFileSync(executable)).digest("hex")).toBe(officialMiseSha256);
	const stateRoot = path.join(root, "state");
	const directory = path.join(stateRoot, "connectors", "setup", "mise");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const mise = path.join(directory, miseName);
	copyFileSync(executable, mise);
	chmodSync(mise, 0o700);
	expect(createHash("sha256").update(readFileSync(mise)).digest("hex")).toBe(officialMiseSha256);
	writeFileSync(path.join(directory, "mise-selected"), miseName, { mode: 0o600 });
	return { mise, state: path.join(stateRoot, "connectors", "setup", "uv") };
}

async function invoke(mise: string, state: string, root: string) {
	const modulePath = path.resolve(import.meta.dir, "../bin/setup/uv.ts");
	const script = `import { installPinnedUv } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(await installPinnedUv(process.env.TEST_MISE!, process.env.TEST_STATE!)));`;
	const child = Bun.spawn([process.execPath, "-e", script], {
		env: { HOME: root, XDG_STATE_HOME: path.join(root, "state"), PATH: "/missing", TEST_MISE: mise, TEST_STATE: state,
			MISE_CONFIG_FILE: path.join(root, "hostile.toml"), MISE_UV_VERSION: "0.1.0", MISE_DATA_DIR: path.join(root, "hostile-data"), MISE_CEILING_PATHS: "/", MISE_TRUSTED_CONFIG_PATHS: "/",
			MISE_CONFIG_DIR: path.join(root, "hostile-config"), MISE_GLOBAL_CONFIG_FILE: path.join(root, "hostile.toml"), MISE_SYSTEM_CONFIG_DIR: path.join(root, "hostile-system"),
			MISE_GLOBAL_CONFIG_ROOT: root, MISE_CACHE_DIR: path.join(root, "hostile-cache"), MISE_STATE_DIR: path.join(root, "hostile-state"),
			MISE_INSTALLS_DIR: path.join(root, "hostile-installs"), MISE_SHIMS_DIR: path.join(root, "hostile-shims"), MISE_TMP_DIR: path.join(root, "hostile-temp") },
		stdout: "pipe", stderr: "pipe",
	});
	const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	return { exit, stderr, result: JSON.parse(stdout) as Awaited<ReturnType<typeof installPinnedUv>> };
}

test("official mise fixture is optional locally, required in CI, and validated before use", () => {
	expect(resolveOfficialMiseFixture({})).toBeNull();
	expect(() => resolveOfficialMiseFixture({ CI: "true" })).toThrow("CI requires CONNECTORS_TEST_MISE_BINARY");
	expect(() => resolveOfficialMiseFixture({ CONNECTORS_TEST_MISE_BINARY: "relative/mise" })).toThrow("absolute path");
	const root = mkdtempSync("/private/tmp/connectors-mise-fixture-");
	try {
		const impostor = path.join(root, "mise");
		writeFileSync(impostor, "wrong mise bytes", { mode: 0o700 });
		expect(() => resolveOfficialMiseFixture({ CONNECTORS_TEST_MISE_BINARY: impostor })).toThrow("pinned SHA-256");
		chmodSync(impostor, 0o600);
		expect(() => resolveOfficialMiseFixture({ CONNECTORS_TEST_MISE_BINARY: impostor })).toThrow("executable official mise");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("active uv lock rejects substitution, comment bait, and extra entries", () => {
	expect(validUvSources(requirements, config, lock)).toBe(true);
	const badUrl = lock.replace("https://github.com/astral-sh/uv/releases/download/0.12.18/uv-aarch64-apple-darwin.tar.gz", "https://example.invalid/uv.tar.gz");
	expect(validUvSources(requirements, config, `${badUrl}\n# ${lock.match(/^url = .+$/m)?.[0]}\n`)).toBe(false);
	const badChecksum = lock.replace("cf40e0c6a202190ccd9e0406dcfdd5b2d6668a9a5c779b17948963df32aafe5b", "0".repeat(64));
	expect(validUvSources(requirements, config, `${badChecksum}\n# checksum = "sha256:cf40e0c6a202190ccd9e0406dcfdd5b2d6668a9a5c779b17948963df32aafe5b"\n`)).toBe(false);
	expect(validUvSources(requirements, `${config}\n"aqua:other/tool" = "1"\n`, lock)).toBe(false);
	expect(validUvSources(requirements, config, `${lock}\n[[tools."aqua:astral-sh/uv"]]\nversion = "0.12.18"\n`)).toBe(false);
});

test("source replacement after validation cannot change staged mise inputs", () => {
	const root = mkdtempSync("/private/tmp/connectors-uv-swap-");
	const configPath = path.join(root, "source.toml");
	const lockPath = path.join(root, "source.lock");
	const requirementsPath = path.join(root, "requirements.json");
	const workspace = path.join(root, "workspace");
	try {
		mkdirSync(workspace, { mode: 0o700 });
		writeFileSync(requirementsPath, requirements);
		writeFileSync(configPath, config);
		writeFileSync(lockPath, lock);
		const validated = readValidatedUvSources(requirementsPath, configPath, lockPath);
		expect(validated).not.toBeNull();
		const hostileConfig = '[tools]\n"aqua:astral-sh/uv" = "0.1.0"\n';
		const hostileLock = lock.replace("https://github.com/astral-sh/uv/releases/download/0.12.18/uv-aarch64-apple-darwin.tar.gz", "https://example.invalid/uv.tar.gz");
		writeFileSync(configPath, hostileConfig);
		writeFileSync(lockPath, hostileLock);
		expect(validUvSources(requirements, hostileConfig, hostileLock)).toBe(false);
		stageValidatedUvSources(workspace, validated!);
		const stagedConfig = readFileSync(path.join(workspace, "mise.toml"), "utf8");
		const stagedLock = readFileSync(path.join(workspace, "mise.lock"), "utf8");
		expect(stagedConfig).toBe(config);
		expect(stagedLock).toBe(lock);
		expect(validUvSources(requirements, stagedConfig, stagedLock)).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("arbitrary uv state is refused before filesystem effects", async () => {
	const root = mkdtempSync("/private/tmp/connectors-uv-path-");
	const wrong = path.join(root, "arbitrary");
	try {
		const run = await invoke(path.join(root, "missing-mise"), wrong, root);
		expect(run.exit).toBe(0);
		expect(run.stderr).toBe("");
		expect(run.result).toEqual({ ok: false, reason: "state-invalid" });
		expect(existsSync(wrong)).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test.skipIf(!officialMise)("a non-executable selected mise is a typed refusal before uv state", async () => {
	const root = mkdtempSync("/private/tmp/connectors-uv-noexec-");
	try {
		const { mise, state } = isolatedMise(root, requiredMise());
		chmodSync(mise, 0o600);
		const run = await invoke(mise, state, root);
		expect(run.exit).toBe(0);
		expect(run.stderr).toBe("");
		expect(run.result).toEqual({ ok: false, reason: "config-invalid" });
		expect(existsSync(state)).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test.skipIf(!officialMise)("official uv installs inside plugin state despite hostile parent config and inherited mise settings", async () => {
	const root = mkdtempSync("/private/tmp/connectors-uv-success-");
	try {
		const { mise, state } = isolatedMise(root, requiredMise());
		writeFileSync(path.join(root, "hostile.toml"), '[tools]\n"aqua:astral-sh/uv" = "0.1.0"\n');
		mkdirSync(state, { recursive: true, mode: 0o700 });
		writeFileSync(path.join(state, "mise.toml"), '[tools]\n"aqua:astral-sh/uv" = "0.1.0"\n');
		writeFileSync(path.join(path.dirname(state), ".mise.toml"), "[tools\n");
		const run = await invoke(mise, state, root);
		expect(run.exit).toBe(0);
		expect(run.stderr).toBe("");
		expect(run.result).toEqual({ ok: true, executable: path.join(state, "installs", "aqua-astral-sh-uv", "0.12.18", "uv-aarch64-apple-darwin", "uv"), version: "0.12.18" });
		expect(existsSync(path.join(root, "hostile-data"))).toBe(false);
		expect(existsSync(path.join(state, "installs", "aqua-astral-sh-uv", "0.1.0"))).toBe(false);
		// The per-run workspace is removed after install, so repeated setup
		// leaves no staging residue beside the retained installs.
		expect(readdirSync(state).filter((entry) => entry.startsWith(".uv-install-"))).toEqual([]);
		// Re-stage the same validated sources at the production workspace depth
		// to prove which config mise selects there under the hostile parents.
		const workspace = path.join(state, ".uv-install-probe");
		mkdirSync(workspace, { mode: 0o700 });
		stageValidatedUvSources(workspace, readValidatedUvSources(path.resolve(import.meta.dir, "../requirements.json"), path.resolve(import.meta.dir, "../config/mise.toml"), path.resolve(import.meta.dir, "../config/mise.lock"))!);
		expect(readFileSync(path.join(workspace, "mise.toml"), "utf8")).toBe(config);
		expect(readFileSync(path.join(workspace, "mise.lock"), "utf8")).toBe(lock);
		const privateEnv = {
			HOME: path.join(state, "home"), PATH: "/usr/bin:/bin", MISE_CONFIG_DIR: path.join(state, "config"),
			MISE_GLOBAL_CONFIG_FILE: path.join(state, "config", "global.toml"), MISE_SYSTEM_CONFIG_DIR: path.join(state, "system"),
			MISE_GLOBAL_CONFIG_ROOT: path.join(state, "home"), MISE_DATA_DIR: path.join(state, "data"), MISE_CACHE_DIR: path.join(state, "cache"),
			MISE_STATE_DIR: path.join(state, "state"), MISE_INSTALLS_DIR: path.join(state, "installs"), MISE_SHIMS_DIR: path.join(state, "shims"),
			MISE_TMP_DIR: path.join(state, "temp"), MISE_CEILING_PATHS: state,
		};
		const selected = Bun.spawn([mise, "config", "ls", "-J"], { cwd: workspace, env: privateEnv, stdout: "pipe", stderr: "pipe" });
		const [selectedExit, selectedOut] = await Promise.all([selected.exited, new Response(selected.stdout).text()]);
		expect(selectedExit).toBe(0);
		expect(JSON.parse(selectedOut)).toEqual([{ path: path.join(workspace, "mise.toml"), tools: ["aqua:astral-sh/uv"] }]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 120_000);

test("an unverified mise executable is refused before creating uv state", async () => {
	const root = mkdtempSync("/private/tmp/connectors-uv-unverified-");
	const impostor = path.join(root, "mise");
	const state = path.join(root, "state", "connectors", "setup", "uv");
	writeFileSync(impostor, "impostor", { mode: 0o700 });
	try {
		const run = await invoke(impostor, state, root);
		expect(run.result).toEqual({ ok: false, reason: "config-invalid" });
		expect(existsSync(state)).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
