// The tenant's private upload outbox. The Community package confines every
// upload source to the Provider's working directory, so the dispatcher stages
// each file here under a digest of its content and the Provider starts in this
// directory. A changed file changes the staged path, which changes the
// journal-bound provider arguments and refuses the apply.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readdirSync, readSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { ownedDirectory, stateRoot } from "../../../bin/private-state.ts";
import type { EnvironmentSource } from "../../../bin/safe-environment.ts";

export function outboxDirectory(tenant: string, env: EnvironmentSource): string {
	return path.join(stateRoot(env), "connectors", "atlassian", tenant, "outbox");
}

type StageFailureReason = "file-unreadable" | "outbox-unavailable";
export type StageResult = { ok: true; relative: string } | { ok: false; reason: "file-unreadable" | "outbox-unavailable" };

// A staged copy is needed only between a preview and its apply, and an apply
// re-stages the file. Digest directories untouched for longer than this are
// removed on the next staging, so the outbox stays bounded.
const STALE_MS = 60 * 60 * 1000;
const COPY_BUFFER_BYTES = 64 * 1024;

function openRegularSource(file: string): number | undefined {
	let source: number | undefined;
	try {
		source = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		if (fstatSync(source).isFile()) return source;
	} catch {
		// A missing, unreadable, or changed source is refused below.
	}
	if (source !== undefined) closeSync(source);
	return undefined;
}

function copyAndHash(source: number, staged: number): { ok: true; digest: string } | { ok: false; reason: StageFailureReason } {
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
	while (true) {
		let count: number;
		try {
			count = readSync(source, buffer, 0, buffer.length, null);
		} catch {
			return { ok: false, reason: "file-unreadable" };
		}
		if (count === 0) return { ok: true, digest: hash.digest("hex") };
		hash.update(buffer.subarray(0, count));
		for (let offset = 0; offset < count;) {
			const written = writeSync(staged, buffer, offset, count - offset);
			if (written === 0) return { ok: false, reason: "outbox-unavailable" };
			offset += written;
		}
	}
}

function removeTemporary(file: string | undefined): void {
	if (file === undefined) return;
	try {
		rmSync(file, { force: true });
	} catch {
		// Cleanup is retried by the next staging.
	}
}

function destinationAvailable(file: string): boolean {
	try {
		return lstatSync(file).isFile();
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

function pruneStale(outbox: string, keep: string, now: number): void {
	let entries: string[];
	try {
		entries = readdirSync(outbox);
	} catch {
		return;
	}
	for (const name of entries) {
		if (name === keep) continue;
		const entry = path.join(outbox, name);
		try {
			const metadata = lstatSync(entry);
			if (now - metadata.mtimeMs <= STALE_MS) continue;
			if (/^[0-9a-f]{64}$/.test(name) && metadata.isDirectory()) rmSync(entry, { recursive: true, force: true });
			if (/^\.stage-[0-9a-f-]{36}$/.test(name) && metadata.isFile()) rmSync(entry, { force: true });
		} catch {
			// A vanished or unreadable entry is left alone; the next staging retries.
		}
	}
}

// Copy one absolute local file into the outbox as <digest>/<basename> and
// return that relative path, the only form the Provider can read.
export function stageFile(tenant: string, env: EnvironmentSource, file: string, now: number = Date.now()): StageResult {
	const source = openRegularSource(file);
	if (source === undefined) return { ok: false, reason: "file-unreadable" };
	const outbox = outboxDirectory(tenant, env);
	let temporary: string | undefined;
	try {
		if (!ownedDirectory(outbox).ok) return { ok: false, reason: "outbox-unavailable" };
		temporary = path.join(outbox, `.stage-${randomUUID()}`);
		const staged = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
		let copied: ReturnType<typeof copyAndHash>;
		try {
			copied = copyAndHash(source, staged);
		} finally {
			closeSync(staged);
		}
		if (!copied.ok) return copied;
		const digest = copied.digest;
		const directory = path.join(outbox, digest);
		if (!ownedDirectory(directory).ok) return { ok: false, reason: "outbox-unavailable" };
		const destination = path.join(directory, path.basename(file));
		if (!destinationAvailable(destination)) return { ok: false, reason: "outbox-unavailable" };
		// A rename publishes the bytes hashed above without opening the destination.
		// A symlink planted after the check is replaced, never followed.
		renameSync(temporary, destination);
		temporary = undefined;
		pruneStale(outbox, digest, now);
		return { ok: true, relative: `${digest}/${path.basename(file)}` };
	} catch {
		return { ok: false, reason: "outbox-unavailable" };
	} finally {
		removeTemporary(temporary);
		closeSync(source);
	}
}
