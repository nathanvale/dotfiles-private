import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { SERVICE_TOKEN_ACCOUNT, SERVICE_TOKEN_SERVICE } from "../one-password-custody.ts";

const SECURITY_TOOL = "/usr/bin/security";

export function loginKeychain(home: string | undefined): string | null {
	if (!home || !path.isAbsolute(home)) return null;
	const file = path.join(home, "Library", "Keychains", "login.keychain-db");
	const result = spawnSync(SECURITY_TOOL, ["default-keychain", "-d", "user"], {
		env: { HOME: home, PATH: "/usr/bin:/bin" },
		encoding: "utf8",
		maxBuffer: 4096,
		timeout: 10_000,
	});
	if (result.status !== 0) return null;
	const selected = /^[ \t]*"([^"\r\n]+)"\r?\n?$/.exec(result.stdout)?.[1];
	if (!selected || !path.isAbsolute(selected)) return null;
	try {
		return realpathSync(file) === realpathSync(selected) ? file : null;
	} catch {
		return null;
	}
}

// macOS security reads the value directly from the user's terminal. This
// process receives only an exit status; no credential enters its argv,
// environment, buffers, or result.
export function storeServiceToken(terminal: number, home: string): boolean {
	const result = spawnSync(SECURITY_TOOL, ["add-generic-password", "-U", "-s", SERVICE_TOKEN_SERVICE, "-a", SERVICE_TOKEN_ACCOUNT, "-w"], {
		env: { HOME: home, PATH: "/usr/bin:/bin" },
		stdio: [terminal, terminal, terminal],
		timeout: 600_000,
	});
	return result.status === 0;
}
