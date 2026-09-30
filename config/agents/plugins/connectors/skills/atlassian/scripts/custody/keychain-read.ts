// The custody module's one Keychain process: the fixed macOS security tool,
// run with the caller's argv and environment. Nothing here selects another
// executable, and nothing here maps or parses the result; one-password.ts
// owns that. Routine tests replace this file only inside a copied plugin
// root, never in this tree.
import { spawnSync } from "node:child_process";

export interface KeychainRead {
	status: number | null;
	stdout: string | null;
}

export function readKeychain(argv: readonly string[], env: Record<string, string>): KeychainRead {
	const read = spawnSync("/usr/bin/security", argv, { env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 15_000 });
	return { status: read.status, stdout: typeof read.stdout === "string" ? read.stdout : null };
}
