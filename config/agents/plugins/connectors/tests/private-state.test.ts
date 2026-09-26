// Proof of the private-state helper at its interface with literal modes and
// closed reasons. Ownership by another user cannot be staged without
// privileges and stays unproved here.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ownedDirectory, ownedExecutableDigest, publishPrivateFileOnce, readPrivateFile, stateRoot, writePrivateFile } from "../bin/private-state.ts";

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

	test("refuses an intermediate symlink under the selected state root for directory, read, and write custody", () => {
		const outside = path.join(root, "outside");
		const referent = path.join(outside, "canva", "personal");
		mkdirSync(referent, { recursive: true, mode: 0o700 });
		const session = path.join(referent, "session.json");
		writeFileSync(session, "untouched", { mode: 0o600 });
		symlinkSync(outside, path.join(root, "connectors"));
		const selected = path.join(root, "connectors", "canva", "personal");
		expect(ownedDirectory(selected)).toEqual({ ok: false, reason: "symlink" });
		expect(readPrivateFile(path.join(selected, "session.json"))).toEqual({ ok: false, reason: "symlink" });
		expect(writePrivateFile(path.join(selected, "session.json"), "changed")).toEqual({ ok: false, reason: "symlink" });
		expect(readFileSync(session, "utf8")).toBe("untouched");
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

	test("forces the temporary file to exact 0600 even under a restrictive umask", () => {
		const directory = path.join(root, "state");
		expect(ownedDirectory(directory)).toEqual({ ok: true });
		const file = path.join(directory, "session.json");
		const previous = process.umask(0o777);
		try {
			expect(writePrivateFile(file, "private")).toEqual({ ok: true });
		} finally {
			process.umask(previous);
		}
		expect(mode(file)).toBe(0o600);
		expect(readPrivateFile(file)).toEqual({ ok: true, text: "private" });
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

// Create-or-identical publication: the caller compares what it meant to
// publish with what exists. The inode and bytes are the independent oracle
// that an existing file was never replaced.
describe("publishPrivateFileOnce", () => {
	test("publishes exact-0600 once, then returns the existing text without replacing it, and leaves no temp file", () => {
		const directory = path.join(root, "state");
		expect(ownedDirectory(directory)).toEqual({ ok: true });
		const file = path.join(directory, "registration.json");
		expect(publishPrivateFileOnce(file, "first\n")).toEqual({ ok: true, published: true });
		expect([mode(file), readFileSync(file, "utf8")]).toEqual([0o600, "first\n"]);
		const inode = statSync(file).ino;
		for (const content of ["second\n", "first\n"]) {
			expect(publishPrivateFileOnce(file, content)).toEqual({ ok: true, published: false, existing: "first\n" });
			expect([statSync(file).ino, readFileSync(file, "utf8"), mode(file)]).toEqual([inode, "first\n", 0o600]);
		}
		expect(readdirSync(directory)).toEqual(["registration.json"]);
	});

	test("refuses a symlink target, a wide parent, and an existing file that is not exact 0600, replacing nothing", () => {
		const directory = path.join(root, "state");
		expect(ownedDirectory(directory)).toEqual({ ok: true });
		const victim = path.join(root, "victim");
		writeFileSync(victim, "untouched");
		const link = path.join(directory, "registration.json");
		symlinkSync(victim, link);
		expect(publishPrivateFileOnce(link, "new")).toEqual({ ok: false, reason: "symlink" });
		expect([readFileSync(victim, "utf8"), lstatSync(link).isSymbolicLink()]).toEqual(["untouched", true]);
		const wide = path.join(root, "wide");
		mkdirSync(wide, { mode: 0o755 });
		expect(publishPrivateFileOnce(path.join(wide, "f"), "x")).toEqual({ ok: false, reason: "mode-invalid" });
		expect(readdirSync(wide)).toEqual([]);
		const loose = path.join(directory, "loose.json");
		writeFileSync(loose, "loose", { mode: 0o644 });
		chmodSync(loose, 0o644);
		expect(publishPrivateFileOnce(loose, "new")).toEqual({ ok: false, reason: "mode-invalid" });
		expect(readFileSync(loose, "utf8")).toBe("loose");
		expect(readdirSync(directory).sort()).toEqual(["loose.json", "registration.json"]);
	});
});

describe("ownedExecutableDigest", () => {
	test("a FIFO at a selected path refuses promptly instead of blocking the reader", () => {
		const directory = path.join(root, "connectors", "setup", "op");
		expect(ownedDirectory(directory)).toEqual({ ok: true });
		const fifo = path.join(directory, "op-selected");
		expect(spawnSync("/usr/bin/mkfifo", ["-m", "0700", fifo]).status).toBe(0);
		// A blocking open never returns to the event loop, so the probe runs in a
		// child with a hard timeout; a killed child has a null status.
		const module = path.resolve(import.meta.dir, "../bin/private-state.ts");
		const script = `import { ownedExecutableDigest, readPrivateFile } from ${JSON.stringify(module)}; console.log(JSON.stringify([ownedExecutableDigest(process.argv[1], "exact-0700"), readPrivateFile(process.argv[1])]));`;
		const probe = spawnSync(process.execPath, ["-e", script, fifo], { encoding: "utf8", timeout: 3_000 });
		expect([probe.status, probe.stderr]).toEqual([0, ""]);
		expect(JSON.parse(probe.stdout)).toEqual([
			{ ok: false, reason: "not-regular" },
			{ ok: false, reason: "not-regular" },
		]);
	});

	test("a swappable ancestor from the selected state root down refuses executable selection; 0755 and a sticky root do not", () => {
		const connectors = path.join(root, "connectors");
		const setup = path.join(connectors, "setup");
		const directory = path.join(setup, "uv", "installs");
		expect(ownedDirectory(directory)).toEqual({ ok: true });
		const executable = path.join(directory, "uv");
		writeFileSync(executable, "bytes", { mode: 0o700 });
		const record = path.join(connectors, "record.json");
		expect(writePrivateFile(record, "kept")).toEqual({ ok: true });
		// Independent oracle: the measured sha256 of "bytes".
		const selected = { ok: true, sha256: "277089d91c0bdf4f2e6862ba7e4a07605119431f5d13f726dd352b06f1b206a9" } as const;
		const refused = { ok: false, reason: "mode-invalid" } as const;
		for (const [name, target, wide, expected] of [
			["root", root, 0o777, refused],
			["root", root, 0o770, refused],
			["root", root, 0o707, refused],
			["root", root, 0o755, selected],
			// Sticky: another user cannot rename or remove this user's `connectors`.
			["root", root, 0o1777, selected],
			["connectors", connectors, 0o777, refused],
			["connectors", connectors, 0o1777, refused],
			["connectors", connectors, 0o755, selected],
			["setup", setup, 0o777, refused],
			["setup", setup, 0o770, refused],
			["setup", setup, 0o707, refused],
			// mise creates its install directories 0755; that remains selectable.
			["setup", setup, 0o755, selected],
		] as const) {
			for (const owned of [root, connectors, setup]) chmodSync(owned, 0o700);
			chmodSync(target, wide);
			expect([name, wide.toString(8), ownedExecutableDigest(executable, "not-shared-writable")]).toEqual([name, wide.toString(8), expected]);
		}
		// A private-file read keeps its own rule: a wide selected root does not refuse it.
		for (const owned of [connectors, setup]) chmodSync(owned, 0o700);
		chmodSync(root, 0o777);
		expect(readPrivateFile(record)).toEqual({ ok: true, text: "kept" });
		chmodSync(root, 0o700);
	});
});
