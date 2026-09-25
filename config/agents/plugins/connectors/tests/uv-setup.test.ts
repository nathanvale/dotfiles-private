import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installPinnedUv, validUvSources } from "../bin/setup/uv.ts";

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

async function invoke(mise: string, state: string, root: string, modulePath = path.resolve(import.meta.dir, "../bin/setup/uv.ts")) {
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

test("the Requirements Manifest qualifies the official uv binary that setup installs and ordinary use runs", () => {
	// Independent oracle: the locally measured uv 0.12.18 aarch64 binary, not read from uv.ts.
	expect((JSON.parse(requirements) as { sources: { uv: { binarySha256: unknown } } }).sources.uv.binarySha256).toBe("17914b3f58e645361bf68424cbc71d834a96a7ada71625b28776bd7c3760afb0");
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
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 120_000);

test.skipIf(!officialMise)("setup replaces a damaged pinned uv with the official binary instead of refusing", async () => {
	const root = mkdtempSync("/private/tmp/connectors-uv-restore-");
	try {
		const { mise, state } = isolatedMise(root, requiredMise());
		const executable = path.join(state, "installs", "aqua-astral-sh-uv", "0.12.18", "uv-aarch64-apple-darwin", "uv");
		expect((await invoke(mise, state, root)).result).toEqual({ ok: true, executable, version: "0.12.18" });
		// Same path, owner, and mode; only the bytes differ, which ordinary use
		// refuses with "run connectors setup".
		writeFileSync(executable, "\n", { flag: "a" });
		const repaired = await invoke(mise, state, root);
		expect([repaired.exit, repaired.stderr, repaired.result]).toEqual([0, "", { ok: true, executable, version: "0.12.18" }]);
		// Independent oracle: the locally measured uv 0.12.18 aarch64 binary.
		expect(createHash("sha256").update(readFileSync(executable)).digest("hex")).toBe("17914b3f58e645361bf68424cbc71d834a96a7ada71625b28776bd7c3760afb0");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 240_000);

test.skipIf(!officialMise)("a symlink at the pinned uv version refuses setup's repair without touching its referent", async () => {
	const root = mkdtempSync("/private/tmp/connectors-uv-restore-link-");
	try {
		const { mise, state } = isolatedMise(root, requiredMise());
		const referent = path.join(root, "outside", "uv-aarch64-apple-darwin");
		mkdirSync(referent, { recursive: true, mode: 0o700 });
		writeFileSync(path.join(referent, "uv"), "untouched", { mode: 0o700 });
		const tool = path.join(state, "installs", "aqua-astral-sh-uv");
		for (const directory of [state, path.join(state, "installs")]) mkdirSync(directory, { recursive: true, mode: 0o700 });
		mkdirSync(tool, { mode: 0o755 });
		symlinkSync(path.dirname(referent), path.join(tool, "0.12.18"));
		const run = await invoke(mise, state, root);
		expect([run.exit, run.stderr, run.result]).toEqual([0, "", { ok: false, reason: "state-invalid" }]);
		expect(readFileSync(path.join(referent, "uv"), "utf8")).toBe("untouched");
		expect(lstatSync(path.join(tool, "0.12.18")).isSymbolicLink()).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// A private plugin copy whose bundled manifest, mise config, and lock agree
// on one uv version string, so only setup's own version-path rule stands
// between that string and its recursive removal.
function pluginWithUvPin(root: string, version: string): string {
	const copy = path.join(root, "plugin");
	for (const module of ["private-state.ts", "safe-environment.ts", path.join("setup", "mise.ts"), path.join("setup", "uv.ts")]) {
		mkdirSync(path.dirname(path.join(copy, "bin", module)), { recursive: true });
		copyFileSync(path.resolve(import.meta.dir, "../bin", module), path.join(copy, "bin", module));
	}
	const manifest = JSON.parse(requirements) as { pins: Record<string, string> };
	manifest.pins.uv = version;
	writeFileSync(path.join(copy, "requirements.json"), JSON.stringify(manifest));
	mkdirSync(path.join(copy, "config"));
	writeFileSync(path.join(copy, "config", "mise.toml"), config.replaceAll('"0.12.18"', JSON.stringify(version)));
	writeFileSync(path.join(copy, "config", "mise.lock"), lock.replaceAll('"0.12.18"', JSON.stringify(version)));
	return path.join(copy, "bin", "setup", "uv.ts");
}

test.skipIf(!officialMise)("a uv pin that is not one version entry refuses before setup can remove other Connector state", async () => {
	// Test-owned literals: from the uv installs root, the first names the whole
	// `connectors` state directory and the second the sibling op install.
	for (const version of ["../../../..", "../../../op"]) {
		const root = mkdtempSync("/private/tmp/connectors-uv-pin-path-");
		try {
			const { mise, state } = isolatedMise(root, requiredMise());
			const connectors = path.join(root, "state", "connectors");
			const receipt = path.join(connectors, "atlassian", "receipt.json");
			const opSelected = path.join(connectors, "setup", "op", "op-selected");
			for (const file of [receipt, opSelected]) {
				mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
				writeFileSync(file, "kept", { mode: 0o600 });
			}
			const run = await invoke(mise, state, root, pluginWithUvPin(root, version));
			expect([version, existsSync(receipt) && readFileSync(receipt, "utf8"), existsSync(opSelected) && readFileSync(opSelected, "utf8")]).toEqual([version, "kept", "kept"]);
			expect([version, run.exit, run.stderr, run.result]).toEqual([version, 0, "", { ok: false, reason: "config-invalid" }]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
}, 60_000);

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
