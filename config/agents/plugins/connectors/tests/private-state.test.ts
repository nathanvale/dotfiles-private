// Proof of the private-state helper at its interface with literal modes and
// closed reasons. Ownership by another user cannot be staged without
// privileges and stays unproved here.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ownedDirectory, readPrivateFile, stateRoot, writePrivateFile } from "../bin/private-state.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(path.join(os.tmpdir(), "private-state-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const mode = (target: string) => statSync(target).mode & 0o7777;

describe("stateRoot", () => {
	test("uses an absolute XDG_STATE_HOME, else HOME/.local/state", () => {
		expect(stateRoot({ XDG_STATE_HOME: "/x/state", HOME: "/h" })).toBe("/x/state");
		expect(stateRoot({ XDG_STATE_HOME: "relative", HOME: "/h" })).toBe("/h/.local/state");
		expect(stateRoot({ HOME: "/h" })).toBe("/h/.local/state");
	});
});

describe("ownedDirectory", () => {
	test("creates nested owner-only directories and narrows a wider existing one", () => {
		const nested = path.join(root, "a", "b", "c");
		expect(ownedDirectory(nested)).toEqual({ ok: true });
		expect(mode(nested)).toBe(0o700);
		expect(mode(path.join(root, "a", "b"))).toBe(0o700);
		chmodSync(nested, 0o755);
		expect(ownedDirectory(nested)).toEqual({ ok: true });
		expect(mode(nested)).toBe(0o700);
	});

	test("refuses a symlinked directory and a regular file at the path", () => {
		const real = path.join(root, "real");
		mkdirSync(real, { mode: 0o700 });
		symlinkSync(real, path.join(root, "link"));
		expect(ownedDirectory(path.join(root, "link"))).toEqual({ ok: false, reason: "symlink" });
		writeFileSync(path.join(root, "file"), "x");
		expect(ownedDirectory(path.join(root, "file"))).toEqual({ ok: false, reason: "not-directory" });
		expect(ownedDirectory(path.join(root, "file", "child"))).toEqual({ ok: false, reason: "absent" });
	});
});

describe("writePrivateFile and readPrivateFile", () => {
	test("writes an exact-0600 file atomically, overwrites, and leaves no temp file", () => {
		const directory = path.join(root, "state");
		expect(ownedDirectory(directory)).toEqual({ ok: true });
		const file = path.join(directory, "session.json");
		expect(writePrivateFile(file, '{"v":1}\n')).toEqual({ ok: true });
		expect(mode(file)).toBe(0o600);
		expect(readPrivateFile(file)).toEqual({ ok: true, text: '{"v":1}\n' });
		expect(writePrivateFile(file, '{"v":2}\n')).toEqual({ ok: true });
		expect(readFileSync(file, "utf8")).toBe('{"v":2}\n');
		expect(mode(file)).toBe(0o600);
		expect(readdirSync(directory)).toEqual(["session.json"]);
	});

	test("a write refuses a missing, symlinked, wide, or non-directory parent and creates nothing", () => {
		const real = path.join(root, "real");
		mkdirSync(real, { mode: 0o700 });
		symlinkSync(real, path.join(root, "link"));
		expect(writePrivateFile(path.join(root, "missing", "f"), "x")).toEqual({ ok: false, reason: "absent" });
		expect(writePrivateFile(path.join(root, "link", "f"), "x")).toEqual({ ok: false, reason: "symlink" });
		writeFileSync(path.join(root, "plain"), "x");
		expect(writePrivateFile(path.join(root, "plain", "f"), "x")).toEqual({ ok: false, reason: "not-directory" });
		const wide = path.join(root, "wide");
		mkdirSync(wide, { mode: 0o755 });
		expect(writePrivateFile(path.join(wide, "f"), "x")).toEqual({ ok: false, reason: "mode-invalid" });
		expect(readdirSync(real)).toEqual([]);
		expect(readdirSync(wide)).toEqual([]);
	});

	test("a write refuses a symlink or a directory at the target and touches neither it nor its referent", () => {
		const directory = path.join(root, "state");
		expect(ownedDirectory(directory)).toEqual({ ok: true });
		const victim = path.join(root, "victim");
		writeFileSync(victim, "untouched");
		const file = path.join(directory, "session.json");
		symlinkSync(victim, file);
		expect(writePrivateFile(file, "new")).toEqual({ ok: false, reason: "symlink" });
		expect(readFileSync(victim, "utf8")).toBe("untouched");
		expect(lstatSync(file).isSymbolicLink()).toBe(true);
		expect(readdirSync(directory)).toEqual(["session.json"]);
		mkdirSync(path.join(directory, "nested"), { mode: 0o700 });
		expect(writePrivateFile(path.join(directory, "nested"), "new")).toEqual({ ok: false, reason: "not-regular" });
	});

	test("a read never follows a symlink: the descriptor is opened no-follow and inspected before it is read", () => {
		const directory = path.join(root, "state");
		expect(ownedDirectory(directory)).toEqual({ ok: true });
		const real = path.join(directory, "real.json");
		expect(writePrivateFile(real, "real")).toEqual({ ok: true });
		// A symlink to an otherwise acceptable owned 0600 file is still refused.
		const link = path.join(directory, "session.json");
		symlinkSync(real, link);
		expect(readPrivateFile(link)).toEqual({ ok: false, reason: "symlink" });
		// Swapping the regular file for a symlink after it was valid is refused on the next read.
		rmSync(real);
		writeFileSync(real, "swapped", { mode: 0o644 });
		expect(readPrivateFile(real)).toEqual({ ok: false, reason: "mode-invalid" });
		expect(readPrivateFile(link)).toEqual({ ok: false, reason: "symlink" });
	});

	test("a read refuses anything but an owned exact-0600 regular file", () => {
		const directory = path.join(root, "state");
		expect(ownedDirectory(directory)).toEqual({ ok: true });
		const file = path.join(directory, "session.json");
		expect(readPrivateFile(file)).toEqual({ ok: false, reason: "absent" });
		expect(writePrivateFile(file, "x")).toEqual({ ok: true });
		for (const [wrong, reason] of [
			[0o640, "mode-invalid"],
			[0o644, "mode-invalid"],
			[0o4600, "mode-invalid"],
			[0o400, "mode-invalid"],
			[0o700, "mode-invalid"],
		] as const) {
			chmodSync(file, wrong);
			expect([wrong.toString(8), readPrivateFile(file)]).toEqual([wrong.toString(8), { ok: false, reason }]);
		}
		chmodSync(file, 0o600);
		expect(readPrivateFile(file)).toEqual({ ok: true, text: "x" });
		symlinkSync(file, path.join(directory, "alias"));
		expect(readPrivateFile(path.join(directory, "alias"))).toEqual({ ok: false, reason: "symlink" });
		expect(readPrivateFile(directory)).toEqual({ ok: false, reason: "not-regular" });
		expect(existsSync(file)).toBe(true);
	});
});
