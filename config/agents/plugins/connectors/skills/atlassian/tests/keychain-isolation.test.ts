// Routine Keychain isolation. No test here starts a process. Source scans
// (supporting evidence only): every mutating security command stays inside
// the attended module, and the shipped leaf is the fixed /usr/bin/security
// reader with no test marker. Copy integrity: the substituted plugin copy the routine custody
// tests run from differs from source by exactly that leaf, the manifest's op
// and uv digests, and the front door compiled from them, and the guard
// refuses any other difference.
import { describe, expect, test } from "bun:test";
import { appendFileSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { changedPaths, copyWithFakeReader, FAKE_MARKER, FAKE_OP_LAUNCHER, FAKE_READER_LOG, FAKE_UV_LAUNCHER, SHIPPED_ROOT, substitutedPluginRoot, verifySubstitutedCopy } from "./fixtures/plugin-copy.ts";

const SKILL = path.resolve(import.meta.dir, "..");
const ATTENDED_MODULE = path.join("tests", "fixtures", "attended-keychain.ts");
// Independent oracles: the plugin-relative paths a copy may change, and the
// shipped leaf's one spawn.
const LEAF = "skills/atlassian/scripts/custody/keychain-read.ts";
const MANIFEST = "requirements.json";
const FRONT_DOOR = "bin/connectors";
const SECOND = "skills/atlassian/scripts/custody/one-password.ts";
const SHIPPED_SPAWN = 'spawnSync("/usr/bin/security", argv,';
// A security subcommand as a spawn argument: a quoted array element.
const MUTATING_SECURITY = /"(create-keychain|delete-keychain|list-keychains|set-keychain-settings|add-generic-password|delete-generic-password|default-keychain|unlock-keychain)"/;

function sources(): string[] {
	const found: string[] = [];
	const walk = (directory: string) => {
		for (const entry of readdirSync(directory)) {
			const full = path.join(directory, entry);
			if (statSync(full).isDirectory()) walk(full);
			else if (entry.endsWith(".ts")) found.push(path.relative(SKILL, full));
		}
	};
	walk(path.join(SKILL, "scripts"));
	walk(path.join(SKILL, "tests"));
	return found.sort();
}

describe("source scan", () => {
	test("only the attended module spawns a mutating security command", () => {
		const offenders = sources().filter((file) => MUTATING_SECURITY.test(readFileSync(path.join(SKILL, file), "utf8")));
		expect(offenders).toEqual([ATTENDED_MODULE]);
	});
});

describe("shipped Keychain reader", () => {
	test("the leaf is the only script naming security, spawns only its literal path, and no shipped source carries the fake marker", () => {
		const scripts = sources().filter((file) => file.startsWith(`scripts${path.sep}`));
		expect(scripts.filter((file) => readFileSync(path.join(SKILL, file), "utf8").includes("/usr/bin/security"))).toEqual([path.join("scripts", "custody", "keychain-read.ts")]);
		const leaf = readFileSync(path.join(SHIPPED_ROOT, LEAF), "utf8");
		expect(leaf.split("spawnSync(").length).toBe(2);
		expect(leaf).toContain(SHIPPED_SPAWN);
		expect(scripts.filter((file) => /keychain-read-fake|connectors-test-keychain-reader-fake/.test(readFileSync(path.join(SKILL, file), "utf8")))).toEqual([]);
	});

});

describe("substituted plugin copy", () => {
	const digest = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
	const manifest = (root: string) => JSON.parse(readFileSync(path.join(root, MANIFEST), "utf8")) as { sources: Record<string, Record<string, unknown>> };

	test("differs from source by exactly the Keychain leaf, the fake op and uv digests, and its recompiled front door", () => {
		const copy = substitutedPluginRoot();
		expect(changedPaths(SHIPPED_ROOT, copy)).toEqual([FRONT_DOOR, MANIFEST, LEAF]);
		expect(readFileSync(path.join(copy, LEAF), "utf8")).toContain(FAKE_MARKER);
		const [shipped, copied] = [manifest(SHIPPED_ROOT), manifest(copy)];
		expect([copied.sources.op?.binarySha256, copied.sources.uv?.binarySha256]).toEqual([digest(FAKE_OP_LAUNCHER), digest(FAKE_UV_LAUNCHER)]);
		for (const tool of ["op", "uv"]) delete shipped.sources[tool]?.binarySha256, delete copied.sources[tool]?.binarySha256;
		expect(copied).toEqual(shipped);
	});

	test("the shipped front door carries no fake reader, and the copy compiled from the fake does", () => {
		const shipped = readFileSync(path.join(SHIPPED_ROOT, FRONT_DOOR));
		// Positive controls: the scan reads compiled text, and the copy's front
		// door carries the fake reader's log name. Minification drops the marker
		// comment, so scanning for it would pass against either binary.
		expect(shipped.includes("DOMAIN_CUSTODY_NOT_SUPPORTED")).toBe(true);
		expect(readFileSync(path.join(substitutedPluginRoot(), FRONT_DOOR)).includes(FAKE_READER_LOG)).toBe(true);
		expect(shipped.includes(FAKE_READER_LOG)).toBe(false);
	});

	test("the production-anchor copy keeps the shipped manifest bytes and the attended copy keeps the shipped reader", () => {
		expect(changedPaths(SHIPPED_ROOT, substitutedPluginRoot({ reader: "fake", manifest: "shipped" }))).toEqual([FRONT_DOOR, LEAF]);
		expect(changedPaths(SHIPPED_ROOT, substitutedPluginRoot({ reader: "shipped", manifest: "fixture" }))).toEqual([FRONT_DOOR, MANIFEST]);
	});

	test("the guard refuses a second changed file, another manifest change, an incomplete substitution, and a front door not compiled from the copy", () => {
		const copy = copyWithFakeReader("connectors-copy-guard-");
		try {
			appendFileSync(path.join(copy, SECOND), "\n// changed\n");
			expect(() => verifySubstitutedCopy(copy)).toThrow(`substituted plugin copy does not change exactly ${JSON.stringify([FRONT_DOOR, MANIFEST, LEAF])}: ${JSON.stringify([FRONT_DOOR, MANIFEST, LEAF, SECOND])}`);
			writeFileSync(path.join(copy, SECOND), readFileSync(path.join(SHIPPED_ROOT, SECOND)));
			const widened = manifest(copy);
			widened.sources.op = { ...widened.sources.op, sha256: "0".repeat(64) };
			writeFileSync(path.join(copy, MANIFEST), JSON.stringify(widened));
			expect(() => verifySubstitutedCopy(copy)).toThrow("substituted plugin copy changes a manifest field other than the fake op and uv digests");
			writeFileSync(path.join(copy, MANIFEST), readFileSync(path.join(substitutedPluginRoot(), MANIFEST)));
			// A front door compiled from other source beside a correctly
			// substituted tree: it would run without the copy's fake digests.
			const compiled = readFileSync(path.join(copy, FRONT_DOOR));
			writeFileSync(path.join(copy, FRONT_DOOR), readFileSync(path.join(substitutedPluginRoot({ reader: "fake", manifest: "shipped" }), FRONT_DOOR)));
			expect(() => verifySubstitutedCopy(copy)).toThrow("substituted plugin copy's bin/connectors was not compiled from its substituted source");
			writeFileSync(path.join(copy, FRONT_DOOR), compiled);
			verifySubstitutedCopy(copy);
			writeFileSync(path.join(copy, MANIFEST), readFileSync(path.join(SHIPPED_ROOT, MANIFEST)));
			writeFileSync(path.join(copy, LEAF), readFileSync(path.join(SHIPPED_ROOT, LEAF)));
			expect(() => verifySubstitutedCopy(copy)).toThrow(`substituted plugin copy does not change exactly ${JSON.stringify([FRONT_DOOR, MANIFEST, LEAF])}: ${JSON.stringify([FRONT_DOOR])}`);
		} finally {
			rmSync(copy, { recursive: true, force: true });
		}
	});
});
