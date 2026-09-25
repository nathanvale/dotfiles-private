// Ordinary-run lookup of the executables `connectors setup` installed into
// plugin-owned state. Setup verified each release before it published it;
// this module never installs, downloads, or repairs, and it never resolves a
// tool from PATH. A missing or changed selection refuses with the setup
// repair so a wrong copy is never run.
import { lstatSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPrivateFile, stateRoot } from "../../../../bin/private-state.ts";
import type { EnvironmentSource } from "../../../../bin/safe-environment.ts";
import { OP_RELEASE } from "../../../../bin/setup/op.ts";

const REQUIREMENTS = path.resolve(import.meta.dir, "..", "..", "..", "..", "requirements.json");

function setupDirectory(env: EnvironmentSource, tool: "op" | "uv"): string {
	return path.join(stateRoot(env), "connectors", "setup", tool);
}

// Every directory from the state root's `connectors` segment down to the
// executable is a real directory this user owns, and the executable is an
// owned regular file with the given exact mode, or at least one execute bit.
function ownedExecutable(root: string, executable: string, mode: "exact-0700" | "executable"): boolean {
	const base = path.join(root, "connectors");
	if (!executable.startsWith(`${base}${path.sep}`)) return false;
	const uid = os.userInfo().uid;
	const directories = [base];
	for (const segment of path.dirname(executable).slice(base.length + 1).split(path.sep).filter(Boolean)) directories.push(path.join(directories.at(-1) ?? base, segment));
	try {
		for (const directory of directories) {
			const entry = lstatSync(directory);
			if (entry.isSymbolicLink() || !entry.isDirectory() || entry.uid !== uid) return false;
		}
		const file = lstatSync(executable);
		if (file.isSymbolicLink() || !file.isFile() || file.uid !== uid) return false;
		return mode === "exact-0700" ? (file.mode & 0o777) === 0o700 : (file.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

// The op revision setup published: `op-selected` names exactly the pinned
// version and binary digest, and that file sits beside it with mode 0700.
export function selectedOp(env: EnvironmentSource): string | null {
	const directory = setupDirectory(env, "op");
	const expected = `op-${OP_RELEASE.version}-${OP_RELEASE.binarySha256}`;
	const record = readPrivateFile(path.join(directory, "op-selected"));
	if (!record.ok || record.text !== expected) return null;
	const executable = path.join(directory, expected);
	return ownedExecutable(stateRoot(env), executable, "exact-0700") ? executable : null;
}

function pinnedUvVersion(): string | null {
	try {
		const pins = (JSON.parse(readFileSync(REQUIREMENTS, "utf8")) as { pins?: { uv?: unknown } }).pins;
		return typeof pins?.uv === "string" && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(pins.uv) ? pins.uv : null;
	} catch {
		return null;
	}
}

// The pinned uv setup installed through the plugin-owned mise.
export function selectedUv(env: EnvironmentSource): string | null {
	const version = pinnedUvVersion();
	if (version === null) return null;
	const executable = path.join(setupDirectory(env, "uv"), "installs", "aqua-astral-sh-uv", version, "uv-aarch64-apple-darwin", "uv");
	return ownedExecutable(stateRoot(env), executable, "executable") ? executable : null;
}
