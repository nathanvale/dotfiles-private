// Ticket #141 (F-b) under Spec #87 AC19 and AC16, bounded by C4 and Q13c:
// `deps repair <tool> --preview` records the exact intended repair and
// changes no dependency; `--apply <previewId>` claims that preview with a
// durable receipt before at most one verified install attempt. Every case
// spawns the packaged binary from an isolated bundle with its own HOME, XDG
// state, and a hostile PATH. Identities, causes, exits, effect names, and
// routes are literals from the accepted proposal, never read from the
// production catalogue.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { runBundle } from "./harness.ts";
import { deps, OP_PATH, PREVIEW_ID, plantWrongMcporter, plantWrongOp, records, refusingHost, sandbox, selections, SENTINEL } from "./deps-sandbox.ts";

const OP_NOT_READY = { tool: "op", owner: "connectors", required: "2.39.0", state: "not-ready", ready: false, selected: null, cause: "selection-invalid", repair: { commandIdentity: "connectors.deps.repair.preview", command: "connectors deps repair op --preview" } };

// Protects the preview contract: it declares the exact effect and the apply
// that consumes it, writes only its own private record, and never reaches
// the network or a PATH tool. Wrong behavior caught: a preview that installs,
// omits its planned effect, or leaves selection state changed.
test("deps repair op --preview records the exact planned effect and changes no selection", async () => {
	const box = sandbox();
	plantWrongOp(box.state);
	const before = selections(box.state);
	const host = refusingHost();
	try {
		const { code, result } = await deps(box, ["repair", "op", "--preview"], { CONNECTORS_TEST_RELEASE_ORIGIN: host.origin });
		expect(code).toBe(0);
		expect(result).toMatchObject({ commandIdentity: "connectors.deps.repair.preview", outcome: "success", causeCode: "SUCCESS_DEPS_REPAIR_PREVIEWED", effectClass: "repository-local", transactionState: "completed", nextAction: "connectors.deps.repair.apply", repairAction: null });
		expect(result.effects).toEqual({ completed: ["deps-repair-preview"], remaining: [], uncertain: [], inventoryComplete: true });
		expect(result.data.previewId).toMatch(PREVIEW_ID);
		expect(result.data).toEqual({ previewId: result.data.previewId, tool: "op", required: "2.39.0", observed: [OP_NOT_READY], plannedEffects: ["op-repair"], apply: `connectors deps repair op --apply ${result.data.previewId}` });
		expect(host.requests).toEqual([]);
		expect(selections(box.state)).toEqual(before);
		expect(records(box.state, "previews")).toEqual([`${result.data.previewId}.json`]);
		expect(lstatSync(path.join(box.state, "connectors", "deps", "previews", `${result.data.previewId}.json`)).mode & 0o777).toBe(0o600);
		expect(records(box.state, "receipts")).toEqual([]);
	} finally {
		host.stop();
		box.bundle.dispose();
	}
});

// Protects C4 and Q13c: absent MCPorter is installed by first use, not by a
// repair, and uv's installer needs a ready plugin-owned mise. Wrong behavior
// caught: recording a preview whose apply cannot succeed, or bootstrapping.
test("deps repair --preview refuses a tool whose prerequisite route comes first, recording nothing", async () => {
	const box = sandbox();
	try {
		const mcporter = await deps(box, ["repair", "mcporter", "--preview"]);
		expect(mcporter.code).toBe(3);
		expect(mcporter.result).toMatchObject({ commandIdentity: "connectors.deps.repair.preview", outcome: "refused", causeCode: "DOMAIN_DEPS_REPAIR_PREREQUISITE", effectClass: "inspect", transactionState: "unchanged", data: null, nextAction: "connectors.run", repairAction: "MCPorter is not installed yet; run connectors run <connector> <operation> and first use installs it" });
		const uv = await deps(box, ["repair", "uv", "--preview"]);
		expect(uv.code).toBe(3);
		expect(uv.result).toMatchObject({ commandIdentity: "connectors.deps.repair.preview", causeCode: "DOMAIN_DEPS_REPAIR_PREREQUISITE", transactionState: "unchanged", nextAction: "connectors.deps.repair.preview", repairAction: "Run connectors deps repair mise --preview and apply it first" });
		for (const refused of [mcporter.result, uv.result]) expect(refused.effects).toEqual({ completed: [], remaining: [], uncertain: [], inventoryComplete: true });
		expect(selections(box.state)).toEqual(["<absent>"]);
	} finally {
		box.bundle.dispose();
	}
});

// Protects AC16's failed install: a refused download publishes nothing, keeps
// the prior selection bytes, and records a failed receipt; the consumed
// preview then refuses without a second attempt. Wrong behavior caught:
// replacing the prior selection, reporting unchanged after the receipt, or
// retrying on a repeated apply.
test("deps repair op --apply keeps the prior selection on a refused download and never reapplies its preview", async () => {
	const box = sandbox();
	plantWrongOp(box.state);
	const host = refusingHost();
	try {
		const preview = await deps(box, ["repair", "op", "--preview"]);
		const id: string = preview.result.data.previewId;
		const before = selections(box.state);
		const applied = await deps(box, ["repair", "op", "--apply", id], { CONNECTORS_TEST_RELEASE_ORIGIN: host.origin });
		expect(applied.code).toBe(3);
		expect(applied.result).toMatchObject({ commandIdentity: "connectors.deps.repair.apply", outcome: "failed", causeCode: "DOMAIN_DEPS_REPAIR_FAILED_RECORDED", effectClass: "external", transactionState: "completed", nextAction: "connectors.deps.status", retryable: false });
		expect(applied.result.effects).toEqual({ completed: ["deps-repair-receipt"], remaining: [], uncertain: [], inventoryComplete: true });
		expect(host.requests).toEqual([OP_PATH]);
		expect(selections(box.state)).toEqual(before);
		expect(JSON.parse(readFileSync(path.join(box.state, "connectors", "deps", "receipts", `${id}.json`), "utf8"))).toMatchObject({ previewId: id, tool: "op", outcome: "failed" });
		const again = await deps(box, ["repair", "op", "--apply", id], { CONNECTORS_TEST_RELEASE_ORIGIN: host.origin });
		expect(again.code).toBe(3);
		expect(again.result).toMatchObject({ commandIdentity: "connectors.deps.repair.apply", outcome: "refused", causeCode: "DOMAIN_DEPS_PREVIEW_CONSUMED", transactionState: "unchanged", nextAction: "connectors.deps.status" });
		expect(host.requests).toEqual([OP_PATH]);
	} finally {
		host.stop();
		box.bundle.dispose();
	}
});

// Protects AC16's stale preview: a selection that changed after the preview
// refuses before any receipt or request. Wrong behavior caught: applying a
// plan made for a different observed state.
test("deps repair --apply refuses a stale preview before any receipt or download", async () => {
	const box = sandbox();
	const host = refusingHost();
	try {
		const preview = await deps(box, ["repair", "op", "--preview"]);
		expect(preview.result.data.observed[0].state).toBe("absent");
		plantWrongOp(box.state);
		const before = selections(box.state);
		const stale = await deps(box, ["repair", "op", "--apply", preview.result.data.previewId], { CONNECTORS_TEST_RELEASE_ORIGIN: host.origin });
		expect(stale.code).toBe(3);
		expect(stale.result).toMatchObject({ commandIdentity: "connectors.deps.repair.apply", outcome: "refused", causeCode: "DOMAIN_DEPS_PREVIEW_STALE", effectClass: "inspect", transactionState: "unchanged", nextAction: "connectors.deps.repair.preview", repairAction: "Run connectors deps repair op --preview again" });
		expect(host.requests).toEqual([]);
		expect(records(box.state, "receipts")).toEqual([]);
		expect(selections(box.state)).toEqual(before);
	} finally {
		host.stop();
		box.bundle.dispose();
	}
});

// Protects AC16's concurrent apply: two processes applying one preview make
// exactly one install attempt and one refusal. Wrong behavior caught: both
// claiming the preview and downloading twice.
test("two concurrent applies of one preview make exactly one attempt and one refusal", async () => {
	const box = sandbox();
	plantWrongOp(box.state);
	const host = refusingHost(1_500);
	try {
		const preview = await deps(box, ["repair", "op", "--preview"]);
		const argv = ["repair", "op", "--apply", preview.result.data.previewId];
		const results = await Promise.all([deps(box, argv, { CONNECTORS_TEST_RELEASE_ORIGIN: host.origin }), deps(box, argv, { CONNECTORS_TEST_RELEASE_ORIGIN: host.origin })]);
		expect(results.map(({ result }) => result.causeCode).sort()).toEqual(["DOMAIN_DEPS_PREVIEW_CONSUMED", "DOMAIN_DEPS_REPAIR_FAILED_RECORDED"]);
		expect(host.requests).toEqual([OP_PATH]);
	} finally {
		host.stop();
		box.bundle.dispose();
	}
});

// Protects AC16's interrupted install: a killed apply leaves the prior
// selection and its claimed receipt, a repeated apply refuses instead of
// replaying, and a fresh preview is still possible. Wrong behavior caught:
// an interrupted apply that damages the selection, holds the lock forever,
// or is silently replayed.
test("an apply killed mid-download keeps the prior selection and is never replayed", async () => {
	const box = sandbox();
	plantWrongOp(box.state);
	const host = refusingHost(10_000);
	try {
		const preview = await deps(box, ["repair", "op", "--preview"]);
		const id: string = preview.result.data.previewId;
		const before = selections(box.state);
		const child = Bun.spawn([box.bundle.binary, "deps", "repair", "op", "--apply", id], { env: { HOME: box.home, PATH: `${box.hostile}:/usr/bin:/bin`, TMPDIR: box.bundle.root, XDG_STATE_HOME: box.state, CONNECTORS_TEST_RELEASE_ORIGIN: host.origin }, stdout: "pipe", stderr: "pipe" });
		for (let waited = 0; host.requests.length === 0 && waited < 10_000; waited += 50) await Bun.sleep(50);
		expect(host.requests).toEqual([OP_PATH]);
		child.kill("SIGKILL");
		await child.exited;
		expect(selections(box.state)).toEqual(before);
		const replay = await deps(box, ["repair", "op", "--apply", id], { CONNECTORS_TEST_RELEASE_ORIGIN: host.origin });
		expect(replay.result).toMatchObject({ causeCode: "DOMAIN_DEPS_PREVIEW_CONSUMED", transactionState: "unchanged" });
		expect(host.requests).toEqual([OP_PATH]);
		const fresh = await deps(box, ["repair", "op", "--preview"]);
		expect(fresh.result.causeCode).toBe("SUCCESS_DEPS_REPAIR_PREVIEWED");
		expect(fresh.result.data.observed).toEqual([OP_NOT_READY]);
	} finally {
		host.stop();
		box.bundle.dispose();
	}
});

// Protects F-AC19-DEPS-CRASH-IDENTITY: a receipt that cannot be published
// after the apply holds the deps lock refuses under the apply's own identity
// at a declared station, claims nothing, and its repair action recovers.
// Wrong behavior caught: the dispatch crash envelope, an undeclared cause,
// an attempt without a receipt, or a refusal whose route does not recover.
test("deps repair --apply with an unpublishable receipt refuses at a declared station and recovers through a fresh preview", async () => {
	const box = sandbox();
	plantWrongOp(box.state);
	const host = refusingHost();
	const env = { CONNECTORS_TEST_RELEASE_ORIGIN: host.origin, CONNECTORS_TEST_RELEASE_DIR: path.join(box.bundle.root, "missing-release") };
	const receipts = path.join(box.state, "connectors", "deps", "receipts");
	try {
		const preview = await deps(box, ["repair", "op", "--preview"]);
		const id: string = preview.result.data.previewId;
		chmodSync(receipts, 0o500);
		const before = { selections: selections(box.state), previews: records(box.state, "previews") };
		const refused = await deps(box, ["repair", "op", "--apply", id], env);
		expect([refused.code, refused.result.commandIdentity, refused.result.causeCode]).toEqual([3, "connectors.deps.repair.apply", "DOMAIN_DEPS_STATE_INVALID"]);
		expect(refused.result).toMatchObject({ commandIdentity: "connectors.deps.repair.apply", outcome: "refused", failureClass: "domain", causeCode: "DOMAIN_DEPS_STATE_INVALID", effectClass: "inspect", transactionState: "unchanged", retryable: false, data: null, nextAction: "connectors.deps.status", repairAction: "Inspect the plugin-owned XDG state root, then run connectors deps repair op --preview again" });
		// The refusal claimed nothing, so the same apply refuses again; its
		// envelope carries the message, which names no privacy defect.
		const repeated = await runBundle(box.bundle, ["deps", "repair", "op", "--apply", id], { home: box.home, binDir: box.hostile, extraEnv: { XDG_STATE_HOME: box.state, OP_SERVICE_ACCOUNT_TOKEN: SENTINEL, ...env } });
		expect([repeated.code, repeated.stderr, repeated.stdout.trim().split("\n").length, repeated.stdout.includes(SENTINEL)]).toEqual([3, "", 1, false]);
		const envelope = JSON.parse(repeated.stdout);
		expect([envelope.message, envelope.result.causeCode]).toEqual(["connectors: plugin-owned deps state could not record this repair receipt; nothing was attempted", "DOMAIN_DEPS_STATE_INVALID"]);
		expect(refused.result.effects).toEqual({ completed: [], remaining: [], uncertain: [], inventoryComplete: true });
		expect(host.requests).toEqual([]);
		expect(records(box.state, "receipts")).toEqual([]);
		expect({ selections: selections(box.state), previews: records(box.state, "previews") }).toEqual(before);
		const described = await runBundle(box.bundle, ["--discover-command", "connectors.deps.repair.apply", "--json"], { home: box.home, binDir: box.hostile });
		expect([described.code, described.stderr]).toEqual([0, ""]);
		expect(JSON.parse(described.stdout).result.data.stations.map((station: { causeCode: string }) => station.causeCode)).toContain("DOMAIN_DEPS_STATE_INVALID");

		const fresh = await deps(box, ["repair", "op", "--preview"], env);
		expect(fresh.result.causeCode).toBe("SUCCESS_DEPS_REPAIR_PREVIEWED");
		const applied = await deps(box, ["repair", "op", "--apply", fresh.result.data.previewId], env);
		expect(applied.result).toMatchObject({ commandIdentity: "connectors.deps.repair.apply", causeCode: "DOMAIN_DEPS_REPAIR_FAILED_RECORDED" });
		expect(host.requests).toEqual([OP_PATH]);
		expect(selections(box.state)).toEqual(before.selections);
	} finally {
		host.stop();
		box.bundle.dispose();
	}
});

// Protects explicit MCPorter repair through preview and apply: an unavailable
// release keeps the selected revision. Wrong behavior caught: removing the
// prior selection before a verified replacement exists.
test("deps repair mcporter --apply keeps the selected revision when the release is unavailable", async () => {
	const box = sandbox();
	plantWrongMcporter(box.state);
	try {
		const preview = await deps(box, ["repair", "mcporter", "--preview"]);
		expect(preview.result.data).toMatchObject({ tool: "mcporter", required: "0.14.0", plannedEffects: ["mcporter-repair"] });
		const before = selections(box.state);
		const applied = await deps(box, ["repair", "mcporter", "--apply", preview.result.data.previewId], { CONNECTORS_TEST_RELEASE_DIR: path.join(box.bundle.root, "missing-release") });
		expect(applied.code).toBe(3);
		expect(applied.result).toMatchObject({ commandIdentity: "connectors.deps.repair.apply", causeCode: "DOMAIN_DEPS_REPAIR_FAILED_RECORDED", effectClass: "external", transactionState: "completed" });
		expect(applied.result.effects).toEqual({ completed: ["deps-repair-receipt"], remaining: [], uncertain: [], inventoryComplete: true });
		expect(selections(box.state)).toEqual(before);
	} finally {
		box.bundle.dispose();
	}
});

// Protects the input boundary: malformed, unknown, or mismatched previews
// refuse before any state change and never echo their input.
test("deps repair refuses malformed, unknown, and mismatched previews without echo or state", async () => {
	const box = sandbox();
	plantWrongOp(box.state);
	try {
		const preview = await deps(box, ["repair", "op", "--preview"]);
		const before = { selections: selections(box.state), previews: records(box.state, "previews") };
		const rows = [
			[["repair", SENTINEL, "--preview"], "connectors.deps.repair.preview", "USAGE_DEPENDENCY_UNKNOWN", 2],
			[["repair", "op", "--apply", SENTINEL], "connectors.deps.repair.apply", "USAGE_MALFORMED_ARGUMENTS", 2],
			[["repair", "op", "--preview", "--apply", preview.result.data.previewId], "connectors.deps.repair.apply", "USAGE_MALFORMED_ARGUMENTS", 2],
			[["repair", "op", "--apply", "0".repeat(32)], "connectors.deps.repair.apply", "DOMAIN_DEPS_PREVIEW_INVALID", 3],
			[["repair", "mise", "--apply", preview.result.data.previewId], "connectors.deps.repair.apply", "DOMAIN_DEPS_PREVIEW_INVALID", 3],
		] as const;
		for (const [argv, identity, cause, exit] of rows) {
			const { code, result } = await deps(box, [...argv]);
			expect([cause, code]).toEqual([cause, exit]);
			expect(result).toMatchObject({ commandIdentity: identity, outcome: "refused", causeCode: cause, transactionState: "unchanged", data: null });
		}
		expect({ selections: selections(box.state), previews: records(box.state, "previews") }).toEqual(before);
		expect(records(box.state, "receipts")).toEqual([]);
	} finally {
		box.bundle.dispose();
	}
});

// Protects the retired direct route: a bare repair never touches a selection
// or its lock and names the one released route. Wrong behavior caught: the
// unpreviewed MCPorter replacement still running, or a refusal with no route.
test("a bare deps repair <tool> refuses unchanged with its exact preview route", async () => {
	const box = sandbox();
	plantWrongMcporter(box.state);
	const before = selections(box.state);
	try {
		for (const tool of ["mcporter", "op"]) {
			const { code, result } = await deps(box, ["repair", tool], { CONNECTORS_TEST_RELEASE_DIR: path.join(box.bundle.root, "missing-release") });
			expect([tool, code]).toEqual([tool, 2]);
			expect(result).toMatchObject({ commandIdentity: "connectors.deps.repair.preview", outcome: "refused", causeCode: "USAGE_MALFORMED_ARGUMENTS", effectClass: "inspect", transactionState: "unchanged", data: null, repairAction: `Run connectors deps repair ${tool} --preview`, nextAction: "connectors.deps.repair.preview" });
		}
		expect(selections(box.state)).toEqual(before);
		expect(existsSync(path.join(box.state, "connectors", "mcporter", ".selection.lock"))).toBe(false);
		expect(existsSync(path.join(box.state, "connectors", "deps"))).toBe(false);
	} finally {
		box.bundle.dispose();
	}
});
