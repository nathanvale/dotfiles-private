// Routine Keychain isolation. No test here starts a process. Source scans
// (supporting evidence only): every mutating security command stays inside
// the attended module, only the attended suite asks for an attended fixture,
// and the shipped leaf is the fixed /usr/bin/security reader with no test
// marker. Copy integrity: the substituted plugin copy the routine custody
// tests run from differs from source by exactly that leaf, and the guard
// refuses any other difference.
import { describe, expect, test } from "bun:test";
import { appendFileSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { changedPaths, copyWithFakeReader, FAKE_MARKER, SHIPPED_ROOT, substitutedPluginRoot, verifySubstitutedCopy } from "./fixtures/plugin-copy.ts";

const SKILL = path.resolve(import.meta.dir, "..");
const SELF = path.join("tests", "keychain-isolation.test.ts");
const ATTENDED_MODULE = path.join("tests", "fixtures", "attended-keychain.ts");
// Independent oracles: the one plugin-relative path a copy may change, and
// the shipped leaf's one spawn.
const LEAF = "skills/atlassian/scripts/custody/keychain-read.ts";
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

	test("only the custody fixture and the attended suite import the attended module, and only the attended suite asks for it", () => {
		const importers = sources().filter((file) => file !== SELF && readFileSync(path.join(SKILL, file), "utf8").includes('attended-keychain.ts"'));
		expect(importers).toEqual([path.join("tests", "attended-keychain.test.ts"), path.join("tests", "fixtures", "custody-fixture.ts")]);
		const requesters = sources().filter((file) => file !== SELF && readFileSync(path.join(SKILL, file), "utf8").includes('keychain: "attended"'));
		expect(requesters).toEqual([path.join("tests", "attended-keychain.test.ts")]);
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

	test("the shipped bin/connectors binary carries no fake marker", () => {
		const binary = readFileSync(path.join(SHIPPED_ROOT, "bin", "connectors"));
		// Positive control: the scan reads the compiled front door's text.
		expect(binary.includes("DOMAIN_CUSTODY_NOT_SUPPORTED")).toBe(true);
		expect(binary.includes(FAKE_MARKER)).toBe(false);
	});
});

describe("substituted plugin copy", () => {
	test("differs from source by exactly the Keychain leaf, which holds the fake", () => {
		const copy = substitutedPluginRoot();
		expect(changedPaths(SHIPPED_ROOT, copy)).toEqual([LEAF]);
		expect(readFileSync(path.join(copy, LEAF), "utf8")).toContain(FAKE_MARKER);
	});

	test("the guard refuses a second changed file and an incomplete substitution", () => {
		const copy = copyWithFakeReader("connectors-copy-guard-");
		try {
			appendFileSync(path.join(copy, SECOND), "\n// changed\n");
			expect(() => verifySubstitutedCopy(copy)).toThrow(`substituted plugin copy is not exactly the Keychain leaf: ${JSON.stringify([LEAF, SECOND])}`);
			writeFileSync(path.join(copy, SECOND), readFileSync(path.join(SHIPPED_ROOT, SECOND)));
			writeFileSync(path.join(copy, LEAF), readFileSync(path.join(SHIPPED_ROOT, LEAF)));
			expect(() => verifySubstitutedCopy(copy)).toThrow("substituted plugin copy is not exactly the Keychain leaf: []");
		} finally {
			rmSync(copy, { recursive: true, force: true });
		}
	});
});
