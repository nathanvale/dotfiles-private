import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

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

// The packaged native helper owns terminal input and the Security framework
// write/readback. The front door receives only its exit status.
export function storeServiceToken(terminal: number, home: string, keychain: string): boolean {
	const helper = path.join(path.dirname(process.execPath), "connectors-keychain-setup");
	const result = spawnSync(helper, [keychain], {
		env: { HOME: home, PATH: "/usr/bin:/bin" },
		stdio: [terminal, terminal, terminal],
		timeout: 600_000,
	});
	return result.status === 0;
}
