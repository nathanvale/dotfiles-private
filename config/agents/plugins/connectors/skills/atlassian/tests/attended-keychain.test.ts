// Attended only: the real /usr/bin/security reads a throwaway keychain file.
// It runs only with CONNECTORS_ATTENDED_KEYCHAIN_TEST=1, after Nathan
// authorizes a Keychain test plan, because creating a keychain touches the
// user-level search list. Every case asserts the list is byte-for-byte what
// it was before the suite, and the suite first clears any keychain a killed
// attended run recorded. Routine runs skip it; their Keychain read is the
// test-owned fake inside the substituted plugin copy, never this tree.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ATTENDED_KEYCHAIN, recoverAttendedKeychains, userSearchList } from "./fixtures/attended-keychain.ts";
import { CustodyFixture, SERVICE_TOKEN } from "./fixtures/custody-fixture.ts";
import { changedPaths, KEYCHAIN_LEAF, SHIPPED_ROOT } from "./fixtures/plugin-copy.ts";

const KEYCHAIN_HANDOFF = "store the Connectors 1Password service-account token in the login Keychain yourself: security add-generic-password -s connectors.1password.service-account -a connectors -w (it prompts for the value; Connectors never receives it)";
// The fixture's default registered Jira item ID, restated as a test-owned literal.
const JIRA_ITEM_READ = ["item", "get", "jirafixtureitem00000000001", "--vault", "API Credentials", "--format", "json"];
const READ = ["--tenant", "example", "issue.get", "--input", '{"issueKey":"PROJ-1"}'];

describe.skipIf(!ATTENDED_KEYCHAIN)("attended real Keychain read", () => {
	let before: string[];
	let fixture: CustodyFixture | undefined;
	beforeAll(() => {
		recoverAttendedKeychains();
		before = userSearchList();
	});
	afterEach(() => {
		fixture?.dispose();
		fixture = undefined;
		expect(userSearchList()).toEqual(before);
	});
	afterAll(() => expect(userSearchList()).toEqual(before));

	test("the real security read hands the service token to op alone and leaves the search list unchanged", async () => {
		fixture = new CustodyFixture({ keychain: "attended" }).installAll();
		expect(userSearchList()).toEqual(before);
		// The shipped leaf, the real reader; only the manifest admits the fakes,
		// and the front door is recompiled from that manifest.
		expect(changedPaths(SHIPPED_ROOT, fixture.pluginRoot)).toEqual(["bin/connectors", "requirements.json"]);
		expect(readFileSync(path.join(fixture.pluginRoot, KEYCHAIN_LEAF), "utf8")).toContain('spawnSync("/usr/bin/security"');
		const result = await fixture.dispatch(READ);
		expect([result.code, result.stderr]).toEqual([3, ""]);
		// No item is written: op reports the registered item absent after a matching token.
		expect(fixture.lines("op-calls.jsonl")).toEqual([{ argv: JIRA_ITEM_READ, envKeys: ["HOME", "OP_SERVICE_ACCOUNT_TOKEN", "PATH"], serviceTokenMatches: true }]);
		for (const stream of [result.stdout, result.stderr, fixture.sweepText()]) expect(stream).not.toContain(SERVICE_TOKEN);
	}, 60_000);

	test("an absent item in the real keychain is the Keychain handoff", async () => {
		fixture = new CustodyFixture({ keychain: "attended" }).installAll();
		fixture.removeKeychainToken();
		const result = await fixture.dispatch(READ);
		expect([result.code, result.stderr]).toEqual([3, ""]);
		const envelope = (JSON.parse(result.stdout) as { result: { causeCode: string; repairAction: string } }).result;
		expect([envelope.causeCode, envelope.repairAction]).toEqual(["refused-credential-unconfigured", KEYCHAIN_HANDOFF]);
		expect(fixture.lines("op-calls.jsonl")).toEqual([]);
	}, 60_000);

	test("dispose is idempotent and removes the keychain file and any registration", () => {
		const local = new CustodyFixture({ keychain: "attended" });
		local.installKeychainToken();
		local.dispose();
		local.dispose();
		expect(userSearchList()).not.toContain(local.keychain);
		expect(existsSync(local.keychain)).toBe(false);
	});
});
