// The smallest private-state helper for Connectors: an owned 0700 directory,
// an owned exact-0600 regular file read, and an atomic exact-0600 write.
// Symlinks are refused everywhere by lstat. Every refusal is a closed reason;
// no path or content is carried in it. This is not a framework: consumers
// keep their own record formats and their own recovery policy.
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, type Stats, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EnvironmentSource } from "./safe-environment.ts";

export type PrivateStateReason = "absent" | "symlink" | "not-regular" | "not-directory" | "not-owned" | "mode-invalid" | "write-failed";
export type PrivateStateResult<T> = ({ ok: true } & T) | { ok: false; reason: PrivateStateReason };

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

// The XDG state root: an absolute XDG_STATE_HOME, else HOME/.local/state.
export function stateRoot(env: EnvironmentSource): string {
	const xdg = env.XDG_STATE_HOME ?? "";
	if (path.isAbsolute(xdg)) return xdg;
	return path.join(env.HOME ?? os.homedir(), ".local", "state");
}

function inspect(target: string): PrivateStateResult<{ metadata: Stats }> {
	try {
		const metadata: Stats = lstatSync(target);
		return { ok: true, metadata };
	} catch {
		return { ok: false, reason: "absent" };
	}
}

// A real directory this user owns, with its current mode.
function inspectDirectory(directory: string): PrivateStateResult<{ mode: number }> {
	const inspected = inspect(directory);
	if (!inspected.ok) return inspected;
	const { metadata } = inspected;
	if (metadata.isSymbolicLink()) return { ok: false, reason: "symlink" };
	if (!metadata.isDirectory()) return { ok: false, reason: "not-directory" };
	if (metadata.uid !== os.userInfo().uid) return { ok: false, reason: "not-owned" };
	return { ok: true, mode: metadata.mode & 0o7777 };
}

// Private Connector state always descends through the final `connectors`
// segment below its selected state root. Return that root and every directory
// through the target so callers can reject an intermediate symlink before an
// operation reaches its referent.
function stateAncestors(directory: string): string[] | null {
	const absolute = path.resolve(directory);
	const parsed = path.parse(absolute);
	const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
	const marker = parts.lastIndexOf("connectors");
	if (marker < 0) return null;
	const selectedRoot = path.join(parsed.root, ...parts.slice(0, marker));
	const ancestors = [selectedRoot];
	for (let index = marker; index < parts.length; index += 1) ancestors.push(path.join(parsed.root, ...parts.slice(0, index + 1)));
	return ancestors;
}

function inspectStateAncestors(directory: string): PrivateStateResult<Record<never, never>> {
	for (const ancestor of stateAncestors(directory) ?? []) {
		const inspected = inspectDirectory(ancestor);
		if (!inspected.ok) return inspected;
	}
	return { ok: true };
}

function ensureDirectory(directory: string, recursive: boolean): PrivateStateResult<{ mode: number }> {
	if (!inspect(directory).ok) {
		try {
			mkdirSync(directory, { recursive, mode: DIRECTORY_MODE });
		} catch {
			// Inspection below reports the closed refusal reason.
		}
	}
	return inspectDirectory(directory);
}

function ensureDirectoryPath(directory: string): PrivateStateResult<{ mode: number }> {
	const ancestors = stateAncestors(directory);
	if (ancestors === null) return ensureDirectory(directory, true);
	let target: PrivateStateResult<{ mode: number }> = { ok: false, reason: "absent" };
	for (const [index, ancestor] of ancestors.entries()) {
		target = ensureDirectory(ancestor, index === 0);
		if (!target.ok) return target;
	}
	return target;
}

// Create the directory (and its parents) with owner-only permissions, then
// prove it is a real directory this user owns. An existing owned directory is
// narrowed to 0700; it is never widened.
export function ownedDirectory(directory: string): PrivateStateResult<Record<never, never>> {
	const owned = ensureDirectoryPath(directory);
	if (!owned.ok) return owned;
	if (owned.mode !== DIRECTORY_MODE) {
		try {
			chmodSync(directory, DIRECTORY_MODE);
		} catch {
			// A failed chmod is reported by the re-inspection below.
		}
		const again = inspectDirectory(directory);
		if (!again.ok || again.mode !== DIRECTORY_MODE) return { ok: false, reason: "mode-invalid" };
	}
	return { ok: true };
}

const openFailure = (error: unknown): PrivateStateReason => {
	const code = (error as { code?: unknown }).code;
	if (code === "ENOENT") return "absent";
	if (code === "ELOOP") return "symlink";
	return "not-regular";
};

// Read a regular file this user owns whose mode is exactly 0600. The file is
// opened without following a symlink, inspected through that descriptor, and
// read from the same descriptor, so nothing can be swapped between the check
// and the read.
export function readPrivateFile(file: string): PrivateStateResult<{ text: string }> {
	const ancestors = inspectStateAncestors(path.dirname(file));
	if (!ancestors.ok) return ancestors;
	let fd: number;
	try {
		fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		return { ok: false, reason: openFailure(error) };
	}
	try {
		const metadata = fstatSync(fd);
		if (!metadata.isFile()) return { ok: false, reason: "not-regular" };
		if (metadata.uid !== os.userInfo().uid) return { ok: false, reason: "not-owned" };
		if ((metadata.mode & 0o7777) !== FILE_MODE) return { ok: false, reason: "mode-invalid" };
		return { ok: true, text: readFileSync(fd, "utf8") };
	} catch {
		return { ok: false, reason: "not-regular" };
	} finally {
		closeSync(fd);
	}
}

// Write content to a fresh exact-0600 temp file beside the target, fsync it,
// then rename it over the target. The directory must already pass
// ownedDirectory; this never creates it. An existing target that is a
// symlink or not a regular file is refused, never replaced.
export function writePrivateFile(file: string, content: string): PrivateStateResult<Record<never, never>> {
	const directory = path.dirname(file);
	const ancestors = inspectStateAncestors(directory);
	if (!ancestors.ok) return ancestors;
	const owned = inspectDirectory(directory);
	if (!owned.ok) return owned;
	if (owned.mode !== DIRECTORY_MODE) return { ok: false, reason: "mode-invalid" };
	const target = inspect(file);
	if (target.ok && target.metadata.isSymbolicLink()) return { ok: false, reason: "symlink" };
	if (target.ok && !target.metadata.isFile()) return { ok: false, reason: "not-regular" };
	const temp = path.join(directory, `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
	try {
		const fd = openSync(temp, "wx", FILE_MODE);
		try {
			fchmodSync(fd, FILE_MODE);
			writeSync(fd, content);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temp, file);
		const directoryFd = openSync(directory, constants.O_RDONLY);
		try {
			fsyncSync(directoryFd);
		} finally {
			closeSync(directoryFd);
		}
		return { ok: true };
	} catch {
		rmSync(temp, { force: true });
		return { ok: false, reason: "write-failed" };
	}
}
