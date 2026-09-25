// The routine custody tests' plugin root: a private copy of the whole
// Connectors plugin in which exactly one file differs from source, the
// Keychain-read leaf, replaced by the test-owned fake. Every process the
// routine tests start (dispatcher, custody child, Provider preflight and
// Provider) resolves its modules through import.meta.dir, so all of them run
// the fake inside the copy and none can reach the shipped reader. Evidence
// from the copy is substituted-reader process proof, never shipped-binary or
// live-Keychain proof.
//
// Fail closed: the copy is verified by content digest against source before
// anything uses it, and any difference beyond the leaf throws.
import { afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const SHIPPED_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..");
// Plugin-relative path of the one file a copy may change.
export const KEYCHAIN_LEAF = path.join("skills", "atlassian", "scripts", "custody", "keychain-read.ts");
export const FAKE_READER = path.join(import.meta.dir, "keychain-read-fake.ts");
// Present in the fake and nowhere the shipped plugin runs.
export const FAKE_MARKER = "connectors-test-keychain-reader-fake";

// Plugin-relative path to content digest for every file and link below root.
function treeDigests(root: string): Map<string, string> {
	const digests = new Map<string, string>();
	const walk = (directory: string) => {
		for (const entry of readdirSync(directory)) {
			const full = path.join(directory, entry);
			const stats = lstatSync(full);
			if (stats.isDirectory()) walk(full);
			else {
				const bytes = stats.isSymbolicLink() ? Buffer.from(`link:${readlinkSync(full)}`) : readFileSync(full);
				digests.set(path.relative(root, full), createHash("sha256").update(bytes).digest("hex"));
			}
		}
	};
	walk(root);
	return digests;
}

// Every plugin-relative path whose content differs, or that exists on one
// side only, sorted.
export function changedPaths(source: string, copy: string): string[] {
	const [left, right] = [treeDigests(source), treeDigests(copy)];
	return [...new Set([...left.keys(), ...right.keys()])].filter((file) => left.get(file) !== right.get(file)).sort();
}

// Throws unless the copy differs from source by exactly the leaf, the copy's
// leaf is the fake, and the source leaf is not.
export function verifySubstitutedCopy(copy: string, source: string = SHIPPED_ROOT): void {
	const changed = changedPaths(source, copy);
	if (changed.length !== 1 || changed[0] !== KEYCHAIN_LEAF) throw new Error(`substituted plugin copy is not exactly the Keychain leaf: ${JSON.stringify(changed)}`);
	const fake = readFileSync(FAKE_READER);
	if (!fake.includes(FAKE_MARKER) || !readFileSync(path.join(copy, KEYCHAIN_LEAF)).equals(fake)) throw new Error("substituted plugin copy does not hold the test Keychain reader");
	if (readFileSync(path.join(source, KEYCHAIN_LEAF), "utf8").includes(FAKE_MARKER)) throw new Error("the shipped Keychain leaf carries the test reader marker");
}

// A fresh private copy of the plugin with the leaf replaced. The caller owns
// removal; nothing is verified here.
export function copyWithFakeReader(prefix: string): string {
	const copy = mkdtempSync(path.join(os.tmpdir(), prefix));
	chmodSync(copy, 0o700);
	cpSync(SHIPPED_ROOT, copy, { recursive: true, verbatimSymlinks: true });
	writeFileSync(path.join(copy, KEYCHAIN_LEAF), readFileSync(FAKE_READER));
	return copy;
}

let shared: string | undefined;

// The one verified copy for the calling scope. `bun test` fires no process
// "exit" handler, so removal belongs to the runner's afterAll, which binds to
// the scope that first asked; the next scope to ask gets a fresh copy.
// Asked first at module scope or in a test body, the copy is removed when
// that scope's tests finish, passed or failed. Asked first in a hook, Bun
// 1.4 removes it when the hook returns and never removes it if the hook
// throws: a file with a hook that asks and can throw asks at module scope
// first. A killed runner runs no hook and leaves its copy.
export function substitutedPluginRoot(): string {
	if (shared !== undefined) return shared;
	const copy = copyWithFakeReader("connectors-substituted-plugin-");
	afterAll(() => {
		if (shared === copy) shared = undefined;
		rmSync(copy, { recursive: true, force: true });
	});
	verifySubstitutedCopy(copy);
	shared = copy;
	return copy;
}
