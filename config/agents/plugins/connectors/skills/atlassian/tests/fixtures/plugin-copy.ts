// The custody tests' plugin roots: private copies of the whole Connectors
// plugin that differ from source only in two declared places. The Keychain
// leaf may be replaced by the test-owned reader fake, and requirements.json
// may name the measured digests of the test-owned fake op and uv launchers as
// the qualified op and uv binaries, changing no other manifest field. Every
// process the tests start (dispatcher, custody child, Provider preflight and
// Provider) resolves its modules and the manifest through import.meta.dir, so
// all of them run the copy's leaf and admit only the copy's digests. Admitting
// a fake takes a package edit, never an environment value.
//
// Shapes: routine (fake reader, fixture manifest); production anchor (fake
// reader, shipped manifest bytes, so the shipped digests must reject the fakes);
// attended (the real reader, fixture manifest). Evidence from a copy is
// substituted process proof, never shipped-binary or live-Keychain proof.
//
// Fail closed: the copy is verified by content digest against source before
// anything uses it, and any difference beyond its shape throws.
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
export const REQUIREMENTS = "requirements.json";
const FAKE_OP = path.join(import.meta.dir, "op-fake.ts");
const FAKE_UV = path.join(import.meta.dir, "community-mcp-fake.ts");

export type CopyShape = Readonly<{ reader: "fake" | "shipped"; manifest: "fixture" | "shipped" }>;
const ROUTINE: CopyShape = { reader: "fake", manifest: "fixture" };

// The one owner of a fake executable's bytes: an absolute Bun shebang (the
// custody reader gives op only /usr/bin:/bin) importing the fake module.
export function fakeLauncher(modulePath: string): string {
	return `#!${process.execPath}\nimport "${modulePath}";\n`;
}
export const FAKE_OP_LAUNCHER = fakeLauncher(FAKE_OP);
export const FAKE_UV_LAUNCHER = fakeLauncher(FAKE_UV);

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

// The shipped manifest with only the op and uv binary digests replaced by
// the fake launchers' measured digests.
function fixtureRequirements(source: string): unknown {
	const manifest = JSON.parse(readFileSync(path.join(source, REQUIREMENTS), "utf8")) as { sources: { op: Record<string, unknown>; uv: Record<string, unknown> } };
	manifest.sources.op.binarySha256 = sha256(FAKE_OP_LAUNCHER);
	manifest.sources.uv.binarySha256 = sha256(FAKE_UV_LAUNCHER);
	return manifest;
}

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
				digests.set(path.relative(root, full), sha256(bytes));
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

// Throws unless the copy differs from source by exactly its shape: the leaf
// holding the fake when the reader is fake, and a manifest whose only
// changes are the fake launchers' op and uv digests when it is the fixture's.
export function verifySubstitutedCopy(copy: string, shape: CopyShape = ROUTINE, source: string = SHIPPED_ROOT): void {
	const expected = [...(shape.manifest === "fixture" ? [REQUIREMENTS] : []), ...(shape.reader === "fake" ? [KEYCHAIN_LEAF] : [])];
	const changed = changedPaths(source, copy);
	if (expected.length === 0 || JSON.stringify(changed) !== JSON.stringify(expected)) throw new Error(`substituted plugin copy does not change exactly ${JSON.stringify(expected)}: ${JSON.stringify(changed)}`);
	if (shape.manifest === "fixture" && !Bun.deepEquals(JSON.parse(readFileSync(path.join(copy, REQUIREMENTS), "utf8")), fixtureRequirements(source), true)) throw new Error("substituted plugin copy changes a manifest field other than the fake op and uv digests");
	if (shape.reader === "fake") {
		const fake = readFileSync(FAKE_READER);
		if (!fake.includes(FAKE_MARKER) || !readFileSync(path.join(copy, KEYCHAIN_LEAF)).equals(fake)) throw new Error("substituted plugin copy does not hold the test Keychain reader");
	}
	if (readFileSync(path.join(source, KEYCHAIN_LEAF), "utf8").includes(FAKE_MARKER)) throw new Error("the shipped Keychain leaf carries the test reader marker");
}

// A fresh private copy of the plugin in the given shape. The caller owns
// removal; nothing is verified here.
export function copyWithFakeReader(prefix: string, shape: CopyShape = ROUTINE): string {
	const copy = mkdtempSync(path.join(os.tmpdir(), prefix));
	chmodSync(copy, 0o700);
	cpSync(SHIPPED_ROOT, copy, { recursive: true, verbatimSymlinks: true });
	if (shape.reader === "fake") writeFileSync(path.join(copy, KEYCHAIN_LEAF), readFileSync(FAKE_READER));
	if (shape.manifest === "fixture") writeFileSync(path.join(copy, REQUIREMENTS), `${JSON.stringify(fixtureRequirements(SHIPPED_ROOT), null, "\t")}\n`);
	return copy;
}

const shared = new Map<string, string>();

// The one verified copy of a shape for the calling scope. `bun test` fires no
// process "exit" handler, so removal belongs to the runner's afterAll, which
// binds to the scope that first asked; the next scope to ask gets a fresh
// copy. Asked first at module scope or in a test body, the copy is removed
// when that scope's tests finish, passed or failed. Asked first in a hook,
// Bun 1.4 removes it when the hook returns and never removes it if the hook
// throws: a file with a hook that asks and can throw asks at module scope
// first. A killed runner runs no hook and leaves its copy.
export function substitutedPluginRoot(shape: CopyShape = ROUTINE): string {
	const key = `${shape.reader}:${shape.manifest}`;
	const existing = shared.get(key);
	if (existing !== undefined) return existing;
	const copy = copyWithFakeReader("connectors-substituted-plugin-", shape);
	afterAll(() => {
		if (shared.get(key) === copy) shared.delete(key);
		rmSync(copy, { recursive: true, force: true });
	});
	verifySubstitutedCopy(copy, shape);
	shared.set(key, copy);
	return copy;
}
