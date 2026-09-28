// The only test module that runs a mutating /usr/bin/security command. It
// backs the attended real-Keychain proof, which runs only when
// CONNECTORS_ATTENDED_KEYCHAIN_TEST=1 after Nathan authorizes that run.
// Routine tests use the test-owned reader fake instead.
//
// `security create-keychain` always adds the new keychain to the user's
// search list, a user-level macOS setting outside any temp directory. The
// earlier fixture left that registration behind whenever a test removed the
// file or cleanup failed. This module therefore:
// - records each keychain in a ledger before creating it, so a run killed
//   between creation and cleanup leaves a record the next attended run clears;
// - holds one cross-process lock around every search-list read-modify-write,
//   so concurrent fixtures never overwrite each other's list;
// - removes the new registration at once and asserts the list equals the
//   snapshot taken before creation;
// - deletes by path, checks every exit status, and is idempotent.
// Another process editing the search list during a create can still race the
// write; the equality assertion then fails the test rather than hiding it.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const ATTENDED_KEYCHAIN = process.env.CONNECTORS_ATTENDED_KEYCHAIN_TEST === "1";
const SECURITY = "/usr/bin/security";
const PASSWORD = "fixture-keychain-password";
const LEDGER = path.join(os.tmpdir(), "connectors-atlassian-attended-keychains");
const LOCK = `${LEDGER}.lock`;
const live = new Set<string>();

function security(args: string[]): { code: number; stdout: string; stderr: string } {
	const run = Bun.spawnSync([SECURITY, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15_000 });
	return { code: run.exitCode ?? -1, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

function required(args: string[]): string {
	const run = security(args);
	if (run.code !== 0) throw new Error(`security ${args[0]} exited ${run.code}: ${run.stderr.trim()}`);
	return run.stdout;
}

// The user search list as `security list-keychains -d user` prints it: one
// quoted path per line.
export function userSearchList(): string[] {
	return required(["list-keychains", "-d", "user"])
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => line.replace(/^"(.*)"$/, "$1"));
}

function writeSearchList(paths: string[]): void {
	if (paths.length === 0) throw new Error("refusing to write an empty keychain search list");
	required(["list-keychains", "-d", "user", "-s", ...paths]);
}

function withLock<T>(work: () => T): T {
	const deadline = Date.now() + 30_000;
	for (;;) {
		try {
			mkdirSync(LOCK, { mode: 0o700 });
			break;
		} catch {
			if (Date.now() > deadline) throw new Error(`the attended keychain lock ${LOCK} is held; inspect it before removing`);
			Bun.sleepSync(50);
		}
	}
	try {
		return work();
	} finally {
		rmSync(LOCK, { recursive: true, force: true });
	}
}

const ledgerEntry = (file: string) => path.join(LEDGER, Buffer.from(file).toString("base64url"));

// Removes one test keychain from the search list and disk. Idempotent: an
// absent file or an absent registration is already clean.
function remove(file: string): void {
	withLock(() => {
		if (existsSync(file)) required(["delete-keychain", file]);
		const current = userSearchList();
		if (current.includes(file)) writeSearchList(current.filter((entry) => entry !== file));
		if (userSearchList().includes(file)) throw new Error("a test keychain is still on the user search list");
		rmSync(ledgerEntry(file), { force: true });
		live.delete(file);
	});
}

// Clears every keychain a killed attended run recorded but never removed.
export function recoverAttendedKeychains(): string[] {
	if (!existsSync(LEDGER)) return [];
	const recovered = readdirSync(LEDGER).map((name) => readFileSync(path.join(LEDGER, name), "utf8"));
	for (const file of recovered) remove(file);
	return recovered;
}

export class AttendedKeychain {
	constructor(readonly file: string) {}

	// Creates the keychain with its one item and leaves the user search list
	// exactly as it was.
	create(token: string, service: string, account: string): void {
		if (existsSync(this.file)) throw new Error("the fixture keychain already exists");
		withLock(() => {
			const before = userSearchList();
			if (before.includes(this.file)) throw new Error("the fixture keychain is already registered");
			mkdirSync(LEDGER, { recursive: true, mode: 0o700 });
			writeFileSync(ledgerEntry(this.file), this.file, { mode: 0o600 });
			live.add(this.file);
			required(["create-keychain", "-p", PASSWORD, this.file]);
			writeSearchList(userSearchList().filter((entry) => entry !== this.file));
			const after = userSearchList();
			if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error("the user keychain search list changed across fixture creation");
		});
		required(["set-keychain-settings", this.file]);
		required(["add-generic-password", "-s", service, "-a", account, "-w", token, "-T", SECURITY, this.file]);
	}

	// Leaves the keychain in place without its item: the absent-token case.
	removeItem(service: string, account: string): void {
		required(["delete-generic-password", "-s", service, "-a", account, this.file]);
	}

	destroy(): void {
		remove(this.file);
	}
}

// A test that dies after creation still unregisters its keychain on exit.
process.on("exit", () => {
	for (const file of [...live]) remove(file);
});
