import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import {
	WARM_CHROME_CHECK_REASONS,
	WARM_CHROME_DEFAULT_PROFILE_DIR,
	WARM_CHROME_REPAIR_REASONS,
	WARM_CHROME_RETIRED_PROFILE_DIRS,
} from "../src/model.ts";
import { isRetiredProfilePath } from "../src/runtime.ts";

// ===========================================================================
// Agent Browser Profile Cutover retirement.
//
// The cutover reserved one existing profile for Warm Browser. This package may
// no longer launch Chrome on it, mutate its state, or hand its endpoint to a
// consumer as proof, and no replacement profile was introduced in its place.
//
// Each route's refusal is proved beside that route, through its own public
// surface: `check-stations`, `launch-stations`, `repair-stations`,
// `profile-avatar`, and `profile-migration`. This file owns the two claims no
// single route can make: that the retirement is one list with one reader, and
// that removing an entry from that list is the whole rollback.
// ===========================================================================

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = "/Users/warm";
/** Independent oracle: the reserved profile, restated by hand. */
const RETIRED_PROFILE = `${HOME}/Library/Application Support/Agent Chrome/Chrome User Data`;

async function source(relativePath: string): Promise<string> {
	return readFile(join(PACKAGE_ROOT, relativePath), "utf8");
}

describe("Agent Browser Profile Cutover: the retirement is one list", () => {
	test("the reserved profile is the retired list, and no fallback replaced it", () => {
		expect(WARM_CHROME_RETIRED_PROFILE_DIRS).toEqual([
			"~/Library/Application Support/Agent Chrome/Chrome User Data",
		]);
		// The product default was not repointed at a second profile; it is the
		// retired one, which is why a lifecycle given no profile refuses.
		expect(WARM_CHROME_DEFAULT_PROFILE_DIR).toBe(
			WARM_CHROME_RETIRED_PROFILE_DIRS[0],
		);
	});

	test("both closed reason unions carry the retirement, so a route can name it", () => {
		expect(WARM_CHROME_CHECK_REASONS.unsafe_profile).toContain("retired_profile");
		expect(WARM_CHROME_REPAIR_REASONS.unrepairable).toContain(
			"profile_path_retired",
		);
	});
});

describe("Agent Browser Profile Cutover: the guard is exactly scoped", () => {
	const retired = [
		["the reserved profile itself", RETIRED_PROFILE],
		["its inner Chrome profile directory", `${RETIRED_PROFILE}/Default`],
		["a file inside it", `${RETIRED_PROFILE}/Local State`],
	] as const;

	test.each(retired)("%s is retired", (_label, path) => {
		expect(isRetiredProfilePath(path, { HOME })).toBe(true);
	});

	// Everything the retirement must NOT reach. Each of these is one path token
	// away from the reserved profile, and every route still treats them exactly
	// as it did before the cutover.
	const permitted = [
		["the owner directory above it", `${HOME}/Library/Application Support/Agent Chrome`],
		[
			"a sibling sharing its leading path",
			`${HOME}/Library/Application Support/Agent Chrome/Chrome User Cache`,
		],
		[
			"a longer name beginning with it",
			`${HOME}/Library/Application Support/Agent Chrome/Chrome User Data Backup`,
		],
		["the everyday default Chrome profile", `${HOME}/Library/Application Support/Google/Chrome`],
		["another dedicated profile", `${HOME}/Library/Application Support/Side Quest/Chrome User Data`],
		["the same relative path under another home", "/Users/other/Library/Application Support/Agent Chrome/Chrome User Data"],
	] as const;

	test.each(permitted)("%s is not retired", (_label, path) => {
		expect(isRetiredProfilePath(path, { HOME })).toBe(false);
	});

	test("a trailing slash on HOME does not fail the guard open", () => {
		expect(isRetiredProfilePath(RETIRED_PROFILE, { HOME: `${HOME}/` })).toBe(true);
	});

	test("an absent HOME fails closed on the retired suffix instead of disabling the guard", () => {
		expect(isRetiredProfilePath(RETIRED_PROFILE, {})).toBe(true);
		expect(
			isRetiredProfilePath(`${HOME}/Library/Application Support/Side Quest/Chrome User Data`, {}),
		).toBe(false);
	});
});

describe("Agent Browser Profile Cutover: rollback is removing the entry", () => {
	// The rollback the cutover promises restores the previous ownership
	// configuration without deleting anything. It is one edit: take the entry out
	// of WARM_CHROME_RETIRED_PROFILE_DIRS. These two cases are what make that
	// true, so a change that spread the retirement anywhere else fails here.

	test("only the runtime guard reads the retired list", async () => {
		const readers: string[] = [];
		for (const path of [
			"src/runtime.ts",
			"src/proof.ts",
			"src/launch.ts",
			"src/repair.ts",
			"src/cli.ts",
			"src/index.ts",
			"src/branch-station-catalog.ts",
			"src/branch-station-evidence.ts",
			"src/command-contract.ts",
			"app/profile-avatar.ts",
			"app/migrate-profile.ts",
			"app/native-runtime.ts",
			"app/install.ts",
		]) {
			if ((await source(path)).includes("WARM_CHROME_RETIRED_PROFILE_DIRS")) {
				readers.push(path);
			}
		}
		expect(readers).toEqual(["src/runtime.ts"]);
	});

	test("every route that could launch, repair, or claim the profile asks the guard", async () => {
		const gated = [
			"src/proof.ts",
			"src/launch.ts",
			"src/repair.ts",
			"app/profile-avatar.ts",
			"app/migrate-profile.ts",
		] as const;
		for (const path of gated) {
			const text = await source(path);
			expect(text, path).toContain("isRetiredProfilePath");
		}
	});
});
