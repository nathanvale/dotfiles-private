// The tenant's private upload outbox. The Community package confines every
// upload source to the Provider's working directory, so the dispatcher stages
// each file here under a digest of its content and the Provider starts in this
// directory. A changed file changes the staged path, which changes the
// journal-bound provider arguments and refuses the apply.
import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { ownedDirectory, stateRoot } from "../../../bin/private-state.ts";
import type { EnvironmentSource } from "../../../bin/safe-environment.ts";

export function outboxDirectory(tenant: string, env: EnvironmentSource): string {
	return path.join(stateRoot(env), "connectors", "atlassian", tenant, "outbox");
}

export type StageResult = { ok: true; relative: string } | { ok: false; reason: "file-unreadable" | "outbox-unavailable" };

// A staged copy is needed only between a preview and its apply, and an apply
// re-stages the file. Digest directories untouched for longer than this are
// removed on the next staging, so the outbox stays bounded.
const STALE_MS = 60 * 60 * 1000;

function pruneStale(outbox: string, keep: string, now: number): void {
	let entries: string[];
	try {
		entries = readdirSync(outbox);
	} catch {
		return;
	}
	for (const name of entries) {
		if (name === keep || !/^[0-9a-f]{64}$/.test(name)) continue;
		const directory = path.join(outbox, name);
		try {
			const metadata = lstatSync(directory);
			if (metadata.isDirectory() && !metadata.isSymbolicLink() && now - metadata.mtimeMs > STALE_MS) rmSync(directory, { recursive: true, force: true });
		} catch {
			// A vanished or unreadable entry is left alone; the next staging retries.
		}
	}
}

// Copy one absolute local file into the outbox as <digest>/<basename> and
// return that relative path, the only form the Provider can read.
export function stageFile(tenant: string, env: EnvironmentSource, file: string, now: number = Date.now()): StageResult {
	let content: Buffer;
	try {
		const metadata = lstatSync(file);
		if (!metadata.isFile()) return { ok: false, reason: "file-unreadable" };
		content = readFileSync(file);
	} catch {
		return { ok: false, reason: "file-unreadable" };
	}
	const digest = createHash("sha256").update(content).digest("hex");
	const outbox = outboxDirectory(tenant, env);
	const directory = path.join(outbox, digest);
	for (const level of [outbox, directory]) {
		if (!ownedDirectory(level).ok) return { ok: false, reason: "outbox-unavailable" };
	}
	try {
		copyFileSync(file, path.join(directory, path.basename(file)));
	} catch {
		return { ok: false, reason: "outbox-unavailable" };
	}
	pruneStale(outbox, digest, now);
	return { ok: true, relative: `${digest}/${path.basename(file)}` };
}
