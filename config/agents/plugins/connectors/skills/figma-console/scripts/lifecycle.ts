import type { Executed, SchemaRequest, WritePhase } from "../../../bin/adapters/contract.ts";
import { Journal, type Receipt, settleAttempt } from "./journal.ts";
import { canonical, ConsoleRefusal, record } from "./model.ts";
import type { Profile } from "./profile.ts";
import type { ConsoleCaller } from "./transport.ts";

// MCPorter 0.14.0 `daemon status --json` prints null for no daemon, else its
// pid and keep-alive servers with activeCalls and an idleBlocked reason such
// as "unknown-outcome".
function stopped(value: unknown): boolean { return value === null; }
function running(value: unknown): value is { pid: unknown; servers: unknown[] } { return record(value) && Array.isArray(value.servers); }
function drained(value: unknown): boolean {
	return running(value) && value.servers.every((server: unknown) => record(server) && server.activeCalls === 0 && server.idleBlocked === undefined);
}
const REPAIR = (profile: Profile, id: string) => `Do not replay. Inspect the owned daemon, then adjudicate: recover figma-console --select account=${profile.account} --select file=${profile.fileKey} --run ${id} --adjudicate --input {}`;

export async function lifecycle(request: SchemaRequest, profile: Profile, caller: ConsoleCaller, operation: "session_start" | "session_stop", phase: WritePhase): Promise<Executed> {
	const journal = new Journal(request, profile);
	const current = await caller.daemon("status");
	if (operation === "session_start" && !stopped(current)) throw new ConsoleRefusal("session-already-running");
	if (operation === "session_stop" && !drained(current)) throw new ConsoleRefusal("session-not-drained");
	if (phase.kind === "preview") {
		const receipt = journal.preview(operation, {}, { session: current });
		return { kind: "recorded", effect: "write-preview", data: { previewId: receipt.id, operation, account: profile.userId, fileKey: profile.fileKey, effect: "owned-local-daemon", baseline: current } };
	}
	const receipt = journal.read(phase.previewId);
	if (receipt.operation !== operation || canonical(receipt.baseline) !== canonical({ session: current })) throw new ConsoleRefusal("preview-state-changed");
	journal.attempt(receipt);
	return settleAttempt(journal, receipt, async () => {
		await caller.daemon(operation === "session_start" ? "start" : "stop");
		// A first fixed status call starts the single pinned stdio transport.
		if (operation === "session_start") await caller.call("figma_get_status", {});
		const after = await caller.daemon("status");
		return { verified: operation === "session_start" ? running(after) && after.servers.length === 1 : stopped(after), data: { operation, session: after } };
	}, REPAIR(profile, receipt.id));
}

// A session's effect is local process state, observed directly: the expected
// state proves the effect; the preview's own daemon still present (or still
// absent) proves unchanged, but only after MCPorter's own 45-second start
// window, so a start still running cannot land after the verdict. Anything
// else stays open.
const START_WINDOW_MS = 60_000;
export async function adjudicateSession(journal: Journal, receipt: Receipt, caller: ConsoleCaller): Promise<Executed> {
	const after = await caller.daemon("status");
	const before = receipt.baseline.session;
	const start = receipt.operation === "session_start";
	// The pinned server connects lazily, so a running owned daemon is the start.
	const applied = start ? running(after) : stopped(after);
	const unchanged = start ? stopped(after) : running(after) && running(before) && after.pid === before.pid;
	if (!applied && !unchanged) throw new ConsoleRefusal("adjudication-inconclusive");
	const attempted = journal.attemptedAt(receipt.id);
	// An attempt still alive, or inside MCPorter's start window, may yet land.
	if (!applied && (attempted === null || Date.now() - attempted < START_WINDOW_MS || journal.attemptRunning(receipt.id))) throw new ConsoleRefusal("adjudication-too-early");
	const status = applied ? "applied" : "unchanged";
	const settled = journal.settle(receipt, status);
	if (settled !== "recorded") throw new ConsoleRefusal(settled === "settled" ? "receipt-not-open" : "journal-unavailable");
	return { kind: "recorded", effect: "write-adjudication", data: { runId: receipt.id, status, session: after } };
}
