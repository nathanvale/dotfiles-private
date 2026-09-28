import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ATTENDED_KEYCHAIN, AttendedKeychain } from "../skills/atlassian/tests/fixtures/attended-keychain.ts";

test.skipIf(!ATTENDED_KEYCHAIN)("packaged Keychain helper stores the full synthetic token without exposing it", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "connectors-native-keychain-"));
	const keychain = new AttendedKeychain(path.join(root, "fixture.keychain-db"));
	const service = "connectors.1password.service-account";
	const account = "connectors";
	const token = `synthetic-${"A".repeat(300)}-end`;
	try {
		keychain.create("initial-synthetic-value", service, account);
		keychain.removeItem(service, account);
		const helper = path.resolve(import.meta.dir, "../bin/connectors-keychain-setup");
		const interaction = `set timeout 15
set helper [lindex $argv 0]
set keychain [lindex $argv 1]
gets stdin token
spawn -noecho $helper $keychain
expect "1Password service token: "
send -- "$token\\r"
expect "Re-enter service token: "
send -- "$token\\r"
expect eof
set result [wait]
exit [lindex $result 3]`;
		const expectFile = path.join(root, "keychain-interaction.exp");
		writeFileSync(expectFile, interaction);
		const write = spawnSync("/usr/bin/expect", [expectFile, helper, keychain.file], {
			input: `${token}\n`, encoding: "utf8", timeout: 20_000, maxBuffer: 8192,
		});
		expect(write.stdout + write.stderr).not.toContain(token);
		if (write.status !== 0) throw new Error(`helper exit ${write.status}: ${(write.stdout + write.stderr).replaceAll(token, "[synthetic-token]")}`);
		const read = spawnSync("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w", keychain.file], {
			encoding: "utf8", timeout: 15_000, maxBuffer: 8192,
		});
		expect(read.status).toBe(0);
		expect(read.stdout.trimEnd()).toBe(token);
	} finally {
		keychain.destroy();
		rmSync(root, { recursive: true, force: true });
	}
}, 60_000);
