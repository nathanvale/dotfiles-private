// connectors-test-keychain-reader-fake
// Test-owned stand-in for scripts/custody/keychain-read.ts. plugin-copy.ts
// writes it over that leaf inside a copied plugin root only; the shipped
// tree always runs the real /usr/bin/security. It emulates the one security
// call custody makes: the item's value and a trailing newline with status 0
// when the argv names the fixture-recorded keychain, service, and account,
// and status 44 (item or keychain absent) otherwise. The fixture root is
// HOME's parent, as for the op fake. It records argv and the environment's
// key names, never a value.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const FOUND = 0;
const NOT_FOUND = 44;

export function readKeychain(argv: readonly string[], env: Record<string, string>): { status: number | null; stdout: string | null } {
	const root = path.dirname(env.HOME ?? "/nonexistent");
	appendFileSync(path.join(root, "keychain-reads.jsonl"), `${JSON.stringify({ argv, envKeys: Object.keys(env).sort() })}\n`);
	const itemFile = path.join(root, "keychain-item.json");
	const tokenFile = path.join(root, "keychain-token");
	if (!existsSync(itemFile) || !existsSync(tokenFile)) return { status: NOT_FOUND, stdout: "" };
	const item = JSON.parse(readFileSync(itemFile, "utf8")) as { keychain: string; service: string; account: string };
	const wanted = ["find-generic-password", "-s", item.service, "-a", item.account, "-w", item.keychain];
	const matches = argv.length === wanted.length && argv.every((value, index) => value === wanted[index]);
	return matches ? { status: FOUND, stdout: `${readFileSync(tokenFile, "utf8")}\n` } : { status: NOT_FOUND, stdout: "" };
}
