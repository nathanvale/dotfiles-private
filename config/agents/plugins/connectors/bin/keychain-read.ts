// Shared Keychain read for static-credential Providers. Tests substitute this
// module only in private plugin copies; the shipped reader always executes
// the fixed macOS security tool. 1Password custody owns result mapping.
import { spawnSync } from "node:child_process";

export interface KeychainRead {
	status: number | null;
	stdout: string | null;
}

export function readKeychain(argv: readonly string[], env: Record<string, string>): KeychainRead {
	const read = spawnSync("/usr/bin/security", argv, { env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 15_000 });
	return { status: read.status, stdout: typeof read.stdout === "string" ? read.stdout : null };
}
