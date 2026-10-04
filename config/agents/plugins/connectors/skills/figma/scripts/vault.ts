// Figma's MCPorter vault root: one private data and cache root under
// Connectors state, named in every Figma plan. Without it, the front door
// runs MCPorter in the keyless root other connectors' children share, which
// would put the Figma grant beside them. Its location is fixed: no caller,
// manifest, or environment key chooses it. The vault file is observed by
// metadata only and never opened.
import { lstatSync } from "node:fs";
import path from "node:path";
import { ownedDirectory, stateRoot } from "../../../bin/private-state.ts";
import type { EnvironmentSource } from "../../../bin/safe-environment.ts";

export interface FigmaVault {
	readonly root: string;
	readonly env: { readonly XDG_DATA_HOME: string; readonly XDG_CACHE_HOME: string };
	readonly file: string;
}

export function figmaVault(env: EnvironmentSource): FigmaVault {
	const root = path.join(stateRoot(env), "connectors", "figma-mcporter");
	const dataHome = path.join(root, "data");
	return { root, env: { XDG_DATA_HOME: dataHome, XDG_CACHE_HOME: path.join(root, "cache") }, file: path.join(dataHome, "mcporter", "credentials.json") };
}

// Each directory's mode, or absent: creating or narrowing one changes it.
export function directoryStamp(vault: FigmaVault): string {
	return [vault.root, vault.env.XDG_DATA_HOME, vault.env.XDG_CACHE_HOME].map((directory) => {
		try {
			return String(lstatSync(directory).mode);
		} catch {
			return "absent";
		}
	}).join(",");
}

// Creates the root, or narrows it to 0700; false when any part is not a real
// directory this user owns.
export const prepareVault = (vault: FigmaVault): boolean => [vault.root, vault.env.XDG_DATA_HOME, vault.env.XDG_CACHE_HOME].every((directory) => ownedDirectory(directory).ok);

export function vaultStamp(vault: FigmaVault): string | null {
	try {
		const stat = lstatSync(vault.file, { bigint: true });
		return `${stat.ino}:${stat.mtimeNs}:${stat.size}`;
	} catch {
		return null;
	}
}
