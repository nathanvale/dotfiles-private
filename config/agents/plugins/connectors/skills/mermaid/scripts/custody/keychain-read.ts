// Mermaid custody's one Keychain process: the fixed macOS security tool, run
// with the caller's argv and environment. bin/one-password-custody.ts owns
// the mapping.
// Routine tests replace this leaf only inside a copied plugin root, with the
// same test-owned reader fake the Atlassian leaf takes.
import { spawnSync } from "node:child_process";

export function readKeychain(argv: readonly string[], env: Record<string, string>): { status: number | null; stdout: string | null } {
	const read = spawnSync("/usr/bin/security", argv, { env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 15_000 });
	return { status: read.status, stdout: typeof read.stdout === "string" ? read.stdout : null };
}
