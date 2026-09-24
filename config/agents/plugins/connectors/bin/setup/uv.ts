import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ownedDirectory, readPrivateFile, stateRoot } from "../private-state.ts";
import { MISE_RELEASE } from "./mise.ts";

const UV_VERSION = "0.12.18";
const UV_BINARY_SHA256 = "17914b3f58e645361bf68424cbc71d834a96a7ada71625b28776bd7c3760afb0";
const TOOL = "aqua:astral-sh/uv";

export type UvInstallResult = { ok: true; executable: string; version: string } | { ok: false; reason: "config-invalid" | "state-invalid" | "install-failed" | "version-invalid" };

function directory(root: string, name: string): string | null {
	const target = path.join(root, name);
	return ownedDirectory(target).ok ? target : null;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: string[]): boolean {
	return Object.keys(value).sort().join("\0") === expected.sort().join("\0");
}

function validConfig(config: unknown): boolean {
	return record(config) && record(config.tools) && keys(config, ["tools"]) && keys(config.tools, [TOOL]) && config.tools[TOOL] === UV_VERSION;
}

function validPlatform(platform: unknown, uv: Record<string, unknown>): boolean {
	return record(platform) && keys(platform, ["checksum", "url", "url_api", "provenance"]) && typeof uv.sha256 === "string" && /^[a-f0-9]{64}$/.test(uv.sha256) && platform.checksum === `sha256:${uv.sha256}` && platform.url === uv.url && platform.url_api === "https://api.github.com/repos/astral-sh/uv/releases/assets/582430554" && platform.provenance === "github-attestations";
}

function validLock(lock: unknown, uv: Record<string, unknown>): boolean {
	if (!record(lock) || !record(lock.tools) || !keys(lock, ["lockfile_version", "tools"]) || lock.lockfile_version !== 2 || !keys(lock.tools, [TOOL])) return false;
	const entries = lock.tools[TOOL];
	if (!Array.isArray(entries) || entries.length !== 1 || !record(entries[0])) return false;
	const entry = entries[0];
	if (!keys(entry, ["version", "backend", "specifiers", "platforms.macos-arm64"]) || entry.version !== UV_VERSION || entry.backend !== TOOL || !Array.isArray(entry.specifiers) || entry.specifiers.length !== 1 || entry.specifiers[0] !== UV_VERSION) return false;
	return validPlatform(entry["platforms.macos-arm64"], uv);
}

export function validUvSources(requirementsText: string, configText: string, lockText: string): boolean {
	try {
		const requirements: unknown = JSON.parse(requirementsText);
		const config: unknown = Bun.TOML.parse(configText);
		const lock: unknown = Bun.TOML.parse(lockText);
		if (!record(requirements) || !record(requirements.pins) || !record(requirements.sources) || !record(requirements.sources.uv)) return false;
		return requirements.pins.uv === UV_VERSION && validConfig(config) && validLock(lock, requirements.sources.uv);
	} catch {
		return false;
	}
}

export type ValidatedUvSources = Readonly<{ configText: string; lockText: string }>;

export function readValidatedUvSources(requirementsPath: string, configPath: string, lockPath: string): ValidatedUvSources | null {
	try {
		const requirementsText = readFileSync(requirementsPath, "utf8");
		const configText = readFileSync(configPath, "utf8");
		const lockText = readFileSync(lockPath, "utf8");
		return validUvSources(requirementsText, configText, lockText) ? { configText, lockText } : null;
	} catch {
		return null;
	}
}

export function stageValidatedUvSources(workspace: string, sources: ValidatedUvSources): void {
	writeFileSync(path.join(workspace, "mise.toml"), sources.configText, { mode: 0o600 });
	writeFileSync(path.join(workspace, "mise.lock"), sources.lockText, { mode: 0o600 });
}

function safeExistingPart(current: string, root: string): boolean {
	try {
		const entry = lstatSync(current);
		if (entry.isSymbolicLink() || (current === root && !entry.isDirectory())) return false;
		if (!entry.isDirectory() || (current !== root && !current.startsWith(`${root}${path.sep}`))) return true;
		const mode = entry.mode & 0o777;
		const installedTool = current.startsWith(`${root}${path.sep}connectors${path.sep}setup${path.sep}uv${path.sep}installs${path.sep}`);
		return entry.uid === os.userInfo().uid && (installedTool ? (mode & 0o022) === 0 : mode === 0o700);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

function safePath(target: string, root: string): boolean {
	if (!path.isAbsolute(root) || !target.startsWith(`${root}${path.sep}`)) return false;
	let current = path.parse(target).root;
	for (const segment of target.slice(current.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		if (!safeExistingPart(current, root)) return false;
	}
	return true;
}

function selectedMise(miseExecutable: string, root: string): boolean {
	const directory = path.join(root, "connectors", "setup", "mise");
	if (!safePath(miseExecutable, root)) return false;
	const selected = readPrivateFile(path.join(directory, "mise-selected"));
	const expectedName = `mise-${MISE_RELEASE.version}-${MISE_RELEASE.binarySha256}`;
	if (!selected.ok || selected.text !== expectedName || miseExecutable !== path.join(directory, expectedName)) return false;
	try {
		const entry = lstatSync(miseExecutable);
		return entry.isFile() && entry.uid === os.userInfo().uid && (entry.mode & 0o777) === 0o700 && createHash("sha256").update(readFileSync(miseExecutable)).digest("hex") === MISE_RELEASE.binarySha256;
	} catch {
		return false;
	}
}

function prepareState(stateDirectory: string): { workspace: string; installs: string; env: Record<string, string> } | null {
	if (!ownedDirectory(stateDirectory).ok) return null;
	const workspace = mkdtempSync(path.join(stateDirectory, ".uv-install-"));
	const dirs: Record<string, string> = {};
	for (const name of ["home", "config", "system", "data", "cache", "state", "installs", "shims", "temp"]) {
		const value = directory(stateDirectory, name);
		if (!value) return null;
		dirs[name] = value;
	}
	const home = dirs.home!;
	const configDir = dirs.config!;
	const env = {
		HOME: home, PATH: "/usr/bin:/bin", TMPDIR: dirs.temp!,
		MISE_CONFIG_DIR: configDir, MISE_GLOBAL_CONFIG_FILE: path.join(configDir, "global.toml"),
		MISE_SYSTEM_CONFIG_DIR: dirs.system!, MISE_GLOBAL_CONFIG_ROOT: home, MISE_DATA_DIR: dirs.data!, MISE_CACHE_DIR: dirs.cache!,
		MISE_STATE_DIR: dirs.state!, MISE_INSTALLS_DIR: dirs.installs!, MISE_SHIMS_DIR: dirs.shims!,
		MISE_TMP_DIR: dirs.temp!, MISE_CEILING_PATHS: stateDirectory,
	};
	return { workspace, installs: dirs.installs!, env };
}

export async function installPinnedUv(miseExecutable: string, stateDirectory: string, pluginDirectory = path.resolve(import.meta.dir, "../..")): Promise<UvInstallResult> {
	const sources = readValidatedUvSources(path.join(pluginDirectory, "requirements.json"), path.join(pluginDirectory, "config", "mise.toml"), path.join(pluginDirectory, "config", "mise.lock"));
	if (!sources) return { ok: false, reason: "config-invalid" };
	const root = stateRoot(process.env);
	if (stateDirectory !== path.join(root, "connectors", "setup", "uv") || !safePath(stateDirectory, root)) return { ok: false, reason: "state-invalid" };
	if (!selectedMise(miseExecutable, root)) return { ok: false, reason: "config-invalid" };
	try {
		const prepared = prepareState(stateDirectory);
		if (!prepared) return { ok: false, reason: "state-invalid" };
		const { workspace, installs, env } = prepared;
		stageValidatedUvSources(workspace, sources);
		const child = Bun.spawn([miseExecutable, "install", "--locked"], { cwd: workspace, env, stdout: "pipe", stderr: "pipe" });
		const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		void stdout;
		void stderr;
		if (exit !== 0) return { ok: false, reason: "install-failed" };
		const executable = path.join(installs, "aqua-astral-sh-uv", UV_VERSION, "uv-aarch64-apple-darwin", "uv");
		if (!safePath(executable, root)) return { ok: false, reason: "version-invalid" };
		const entry = lstatSync(executable);
		if (!entry.isFile() || entry.uid !== os.userInfo().uid || (entry.mode & 0o111) === 0 || createHash("sha256").update(readFileSync(executable)).digest("hex") !== UV_BINARY_SHA256) return { ok: false, reason: "version-invalid" };
		const probe = Bun.spawn([executable, "--version"], { cwd: workspace, env, stdout: "pipe", stderr: "pipe" });
		const [probeExit, version] = await Promise.all([probe.exited, new Response(probe.stdout).text()]);
		if (probeExit !== 0 || !version.startsWith(`uv ${UV_VERSION} `)) return { ok: false, reason: "version-invalid" };
		return { ok: true, executable, version: UV_VERSION };
	} catch {
		return { ok: false, reason: "install-failed" };
	}
}
