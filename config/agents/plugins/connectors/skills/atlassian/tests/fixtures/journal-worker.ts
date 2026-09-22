#!/usr/bin/env bun
// Test-owned worker: one journal apply in a separate process so races, crash
// points, and lock holders are real. Writes one marker file per dispatch so
// the test has an oracle outside the journal.
//   journal-worker <stateRoot> <previewId> <mode> [holdMs]
//   modes: hold | barrier | crash-before-intent | crash-after-intent | crash-in-dispatch
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { JournalError, openJournal } from "../../scripts/dispatch/journal.ts";

const [stateRoot = "", previewId = "", mode = "hold", holdMs = "300"] = process.argv.slice(2);
const journal = openJournal("example", {
	stateRoot,
	...(mode === "crash-before-intent" ? { crashAt: "before-intent" as const } : mode === "crash-after-intent" ? { crashAt: "after-intent" as const } : {}),
});
const input = JSON.parse(process.env.JOURNAL_INPUT ?? "{}") as unknown;
const revision = process.env.JOURNAL_REVISION ?? null;
try {
	const receipt = await journal.apply({ provider: "official", previewId, canonicalInput: input, providerArgs: input, revision }, async (intent) => {
		writeFileSync(path.join(stateRoot, "markers", `${intent.runId}.marker`), "");
		process.stdout.write("dispatching\n");
		if (mode === "crash-in-dispatch") process.exit(9);
		if (mode === "barrier") while (!existsSync(path.join(stateRoot, "barrier"))) await Bun.sleep(20);
		if (mode === "hold") await Bun.sleep(Number(holdMs));
		return { proof: "completed", effects: [{ kind: "jira-comment", id: "10001" }] };
	});
	process.stdout.write(`done ${receipt.status}\n`);
} catch (error) {
	process.stdout.write(`error ${error instanceof JournalError ? error.code : "unexpected"}\n`);
	process.exit(3);
}
