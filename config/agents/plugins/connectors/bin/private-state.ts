// The smallest private-state helper for Connectors: an owned 0700 directory,
// an owned exact-0600 regular file read, and an atomic exact-0600 write.
// Symlinks are refused everywhere by lstat. Every refusal is a closed reason;
// no path or content is carried in it. This is not a framework: consumers
// keep their own record formats and their own recovery policy.
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, type Stats, writeSync } from "node:fs";
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

// Create the directory (and its parents) with owner-only permissions, then
// prove it is a real directory this user owns. An existing owned directory is
// narrowed to 0700; it is never widened.
export function ownedDirectory(directory: string): PrivateStateResult<Record<never, never>> {
	try {
		mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
	} catch {
		// A path component that is not a directory surfaces in the inspection.
	}
	const owned = inspectDirectory(directory);
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

// Read a regular file this user owns whose mode is exactly 0600.
export function readPrivateFile(file: string): PrivateStateResult<{ text: string }> {
	const inspected = inspect(file);
	if (!inspected.ok) return inspected;
	const { metadata } = inspected;
	if (metadata.isSymbolicLink()) return { ok: false, reason: "symlink" };
	if (!metadata.isFile()) return { ok: false, reason: "not-regular" };
	if (metadata.uid !== os.userInfo().uid) return { ok: false, reason: "not-owned" };
	if ((metadata.mode & 0o7777) !== FILE_MODE) return { ok: false, reason: "mode-invalid" };
	try {
		return { ok: true, text: readFileSync(file, "utf8") };
	} catch {
		return { ok: false, reason: "absent" };
	}
}

// Write content to a fresh exact-0600 temp file beside the target, fsync it,
// then rename it over the target. The directory must already pass
// ownedDirectory; this never creates it. A symlink at the target is replaced
// by the rename, never followed.
export function writePrivateFile(file: string, content: string): PrivateStateResult<Record<never, never>> {
	const directory = path.dirname(file);
	const owned = inspectDirectory(directory);
	if (!owned.ok) return owned;
	if (owned.mode !== DIRECTORY_MODE) return { ok: false, reason: "mode-invalid" };
	const temp = path.join(directory, `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
	try {
		const fd = openSync(temp, "wx", FILE_MODE);
		try {
			writeSync(fd, content);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temp, file);
		return { ok: true };
	} catch {
		rmSync(temp, { force: true });
		return { ok: false, reason: "write-failed" };
	}
}
