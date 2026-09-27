// Ticket #141 (F-b) under Spec #87 AC19 and AC16, bounded by C4 and Q13c:
// `deps update <revision> --preview` admits only the requirements revision
// packaged in this build and records the exact convergence of every present
// plugin-owned selection to its pin; `--apply <previewId>` claims that
// preview with a durable receipt before at most one verified install per
// planned tool. Every case spawns the packaged binary from an isolated bundle
// with its own HOME, XDG state, and a hostile PATH. Identities, causes,
// exits, effect names, and the revision are literals, never read from the
// production catalogue or requirements.json.
import { expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runBundle } from "./harness.ts";
import { deps, OP_PATH, owned, PREVIEW_ID, plantPriorUv, plantWrongMcporter, plantWrongMise, plantWrongOp, records, refusingHost, sandbox, selections, SENTINEL } from "./deps-sandbox.ts";

// Independent oracle: `jq -c . requirements.json | tr -d '\n' | shasum -a 256`
// on the packaged requirements (op 2.39.0, mise 2026.9.12, uv 0.12.18,
// mcporter 0.14.0). A pin change is a reviewable edit of this literal.
const REVISION = "sha256:d4184f6799a80c6aab24c819644e8bf9619dacb8c1be5362d755f6d8eb6359e4";
const OTHER_REVISION = `sha256:${"a".repeat(64)}`;

const preview = (tool: string) => ({ commandIdentity: "connectors.deps.repair.preview", command: `connectors deps repair ${tool} --preview` });
const ABSENT_MCPORTER = { tool: "mcporter", owner: "connectors", required: "0.14.0", state: "absent", ready: false, selected: null, cause: null, repair: { commandIdentity: "connectors.run", command: "connectors run <connector> <operation>" } };
const WRONG_MCPORTER = { tool: "mcporter", owner: "connectors", required: "0.14.0", state: "not-ready", ready: false, selected: null, cause: "binary-digest-mismatch", repair: preview("mcporter") };
const WRONG_OP = { tool: "op", owner: "connectors", required: "2.39.0", state: "not-ready", ready: false, selected: null, cause: "selection-invalid", repair: preview("op") };
const ABSENT_OP = { tool: "op", owner: "connectors", required: "2.39.0", state: "absent", ready: false, selected: null, cause: null, repair: preview("op") };
const ABSENT_MISE = { tool: "mise", owner: "connectors", required: "2026.9.12", state: "absent", ready: false, selected: null, cause: null, repair: preview("mise") };
const ABSENT_UV = { tool: "uv", owner: "connectors", required: "0.12.18", state: "absent", ready: false, selected: null, cause: null, repair: preview("uv") };
const WRONG_UV = { ...ABSENT_UV, state: "not-ready", cause: "selection-invalid" };

// A refused uv install at the pinned version's entry.
function plantWrongUv(state: string): void {
	const uv = path.join(state, "connectors", "setup", "uv", "installs", "aqua-astral-sh-uv", "0.12.18", "uv-aarch64-apple-darwin");
	owned(uv);
	writeFileSync(path.join(uv, "uv"), "damaged uv bytes", { mode: 0o700 });
}

// Protects the admitted-revision contract and the exact plan: status names
// the packaged revision, and its preview plans only the present selections
// in order, leaving absent tools to first use or setup. Wrong behavior
// caught: planning an install for an absent tool, reaching the network, or
// changing a selection before apply.
test("deps update <packaged revision> --preview records the exact convergence of present selections and changes nothing", async () => {
	const box = sandbox();
	plantWrongMcporter(box.state);
	plantWrongOp(box.state);
	const host = refusingHost();
	try {
		const status = await deps(box, ["status"]);
		expect(status.result.data.requirementsRevision).toBe(REVISION);
		const before = selections(box.state);
		const { code, result } = await deps(box, ["update", REVISION, "--preview"], { CONNECTORS_TEST_RELEASE_ORIGIN: host.origin });
		expect(code).toBe(0);
		expect(result).toMatchObject({ commandIdentity: "connectors.deps.update.preview", outcome: "success", causeCode: "SUCCESS_DEPS_UPDATE_PREVIEWED", effectClass: "repository-local", transactionState: "completed", nextAction: "connectors.deps.update.apply", repairAction: null });
		expect(result.effects).toEqual({ completed: ["deps-update-preview"], remaining: [], uncertain: [], inventoryComplete: true });
		const id: string = result.data.previewId;
		expect(id).toMatch(PREVIEW_ID);
		expect(result.data).toEqual({ previewId: id, revision: REVISION, observed: [WRONG_MCPORTER, WRONG_OP, ABSENT_MISE, ABSENT_UV], plannedEffects: ["mcporter-update", "op-update"], apply: `connectors deps update ${REVISION} --apply ${id}` });
		expect(host.requests).toEqual([]);
		expect(selections(box.state)).toEqual(before);
		expect(records(box.state, "previews")).toEqual([`${id}.json`]);
		expect(lstatSync(path.join(box.state, "connectors", "deps", "previews", `${id}.json`)).mode & 0o777).toBe(0o600);
		expect(records(box.state, "receipts")).toEqual([]);
	} finally {
		host.stop();
		box.bundle.dispose();
	}
});

// Protects C4 and Q13c: with no present selection to converge, update is an
// inspection, not an installer. Wrong behavior caught: first-use
// bootstrapping MCPorter or installing op, mise, or uv from update.
test("deps update --preview with nothing present plans nothing and records nothing", async () => {
	const box = sandbox();
	try {
		const { code, result } = await deps(box, ["update", REVISION, "--preview"]);
		expect(code).toBe(0);
		expect(result).toMatchObject({ commandIdentity: "connectors.deps.update.preview", outcome: "success", causeCode: "SUCCESS_UNCHANGED", effectClass: "inspect", transactionState: "unchanged", nextAction: "connectors.deps.status" });
		expect(result.effects).toEqual({ completed: [], remaining: [], uncertain: [], inventoryComplete: true });
		expect(result.data).toEqual({ revision: REVISION, observed: [ABSENT_MCPORTER, ABSENT_OP, ABSENT_MISE, ABSENT_UV], plannedEffects: [] });
		expect(selections(box.state)).toEqual(["<absent>"]);
	} finally {
		box.bundle.dispose();
	}
});

// Protects the accepted "never ambient latest" rule: only this build's
// revision is admitted, and a name like latest is not a revision at all.
// Neither contacts a release host or records state, and neither echoes its
// input. Wrong behavior caught: resolving an upstream latest, or admitting
// any well-formed revision.
test("deps update refuses an unadmitted revision, latest, and a missing revision without network, state, or echo", async () => {
	const box = sandbox();
	plantWrongOp(box.state);
	const host = refusingHost();
	try {
		const before = selections(box.state);
		const rows = [
			[["update", OTHER_REVISION, "--preview"], "connectors.deps.update.preview", "DOMAIN_DEPS_REVISION_NOT_ADMITTED", 3],
			[["update", OTHER_REVISION, "--apply", "0".repeat(32)], "connectors.deps.update.apply", "DOMAIN_DEPS_REVISION_NOT_ADMITTED", 3],
			[["update", "latest", "--preview"], "connectors.deps.update.preview", "USAGE_MALFORMED_ARGUMENTS", 2],
			[["update", `sha256:${SENTINEL}`, "--preview"], "connectors.deps.update.preview", "USAGE_MALFORMED_ARGUMENTS", 2],
			[["update", "--preview"], "connectors.deps.update.preview", "USAGE_MALFORMED_ARGUMENTS", 2],
			[["update", REVISION], "connectors.deps.update.preview", "USAGE_MALFORMED_ARGUMENTS", 2],
		] as const;
		for (const [argv, identity, cause, exit] of rows) {
			const { code, result } = await deps(box, [...argv], { CONNECTORS_TEST_RELEASE_ORIGIN: host.origin });
			expect([argv[1], cause, code]).toEqual([argv[1], cause, exit]);
			expect(result).toMatchObject({ commandIdentity: identity, outcome: "refused", causeCode: cause, effectClass: "inspect", transactionState: "unchanged", data: null });
			expect(JSON.stringify(result)).not.toContain(OTHER_REVISION);
		}
		const refused = await deps(box, ["update", OTHER_REVISION, "--preview"]);
		expect(refused.result).toMatchObject({ nextAction: "connectors.deps.status", repairAction: `This build admits only requirements revision ${REVISION}; another revision needs a deliberate Connectors plugin update` });
		expect(host.requests).toEqual([]);
		expect(selections(box.state)).toEqual(before);
		expect(existsSync(path.join(box.state, "connectors", "deps"))).toBe(false);
	} finally {
		host.stop();
		box.bundle.dispose();
	}
});

// Protects the uv installer's dependency: uv converges only through a ready
// plugin-owned mise. Wrong behavior caught: recording a plan whose apply
// cannot succeed.
test("deps update --preview refuses a present uv without a ready mise, recording nothing", async () => {
	const box = sandbox();
	plantWrongUv(box.state);
	try {
		const { code, result } = await deps(box, ["update", REVISION, "--preview"]);
		expect(code).toBe(3);
		expect(result).toMatchObject({ commandIdentity: "connectors.deps.update.preview", outcome: "refused", causeCode: "DOMAIN_DEPS_REPAIR_PREREQUISITE", effectClass: "inspect", transactionState: "unchanged", data: null, nextAction: "connectors.deps.repair.preview", repairAction: "Run connectors deps repair mise --preview and apply it first" });
		expect(existsSync(path.join(box.state, "connectors", "deps"))).toBe(false);
	} finally {
		box.bundle.dispose();
	}
});

// Protects convergence from a genuinely installed prior uv pin: it is a
// present selection, so update plans uv after its mise installer, and the
// old binary is never run or adopted. Wrong behavior caught: a uv reader
// that sees only the current pin's folder, so the prior install reads absent
// and update silently leaves it unconverged.
test("deps update --preview plans uv convergence from an installed prior uv pin without running it", async () => {
	const box = sandbox();
	plantWrongMise(box.state);
	plantPriorUv(box.state, box.marker);
	try {
		const before = selections(box.state);
		const { code, result } = await deps(box, ["update", REVISION, "--preview"]);
		expect(code).toBe(0);
		expect(result).toMatchObject({ commandIdentity: "connectors.deps.update.preview", causeCode: "SUCCESS_DEPS_UPDATE_PREVIEWED", transactionState: "completed" });
		expect(result.data.observed).toEqual([ABSENT_MCPORTER, ABSENT_OP, { ...ABSENT_MISE, state: "not-ready", cause: "selection-invalid" }, WRONG_UV]);
		expect(result.data.plannedEffects).toEqual(["mise-update", "uv-update"]);
		expect(selections(box.state)).toEqual(before);
	} finally {
		box.bundle.dispose();
	}
});

// Protects AC16's failed install during a multi-tool update: the first
// failure stops the apply, every prior selection keeps its bytes, the
// unachieved effects are named as remaining, and the consumed preview is
// never applied again. Wrong behavior caught: continuing to op after
// MCPorter failed, reporting a partial update as completed, or replaying.
test("deps update --apply stops at the first failure, keeps every prior selection, and is never reapplied", async () => {
	const box = sandbox();
	plantWrongMcporter(box.state);
	plantWrongOp(box.state);
	const host = refusingHost();
	const env = { CONNECTORS_TEST_RELEASE_ORIGIN: host.origin, CONNECTORS_TEST_RELEASE_DIR: path.join(box.bundle.root, "missing-release") };
	try {
		const previewed = await deps(box, ["update", REVISION, "--preview"]);
		const id: string = previewed.result.data.previewId;
		const before = selections(box.state);
		const applied = await deps(box, ["update", REVISION, "--apply", id], env);
		expect(applied.code).toBe(3);
		expect(applied.result).toMatchObject({ commandIdentity: "connectors.deps.update.apply", outcome: "failed", causeCode: "DOMAIN_DEPS_UPDATE_FAILED_RECORDED", effectClass: "external", transactionState: "partially-completed", nextAction: "connectors.deps.status", retryable: false, data: { previewId: id, revision: REVISION } });
		expect(applied.result.effects).toEqual({ completed: ["deps-update-receipt"], remaining: ["mcporter-update", "op-update"], uncertain: [], inventoryComplete: true });
		expect(host.requests).toEqual([]);
		expect(selections(box.state)).toEqual(before);
		expect(JSON.parse(readFileSync(path.join(box.state, "connectors", "deps", "receipts", `${id}.json`), "utf8"))).toMatchObject({ previewId: id, revision: REVISION, outcome: "failed" });
		const again = await deps(box, ["update", REVISION, "--apply", id], env);
		expect(again.code).toBe(3);
		expect(again.result).toMatchObject({ commandIdentity: "connectors.deps.update.apply", outcome: "refused", causeCode: "DOMAIN_DEPS_PREVIEW_CONSUMED", transactionState: "unchanged", nextAction: "connectors.deps.status" });
		expect(host.requests).toEqual([]);
	} finally {
		host.stop();
		box.bundle.dispose();
	}
});

// Protects the single-tool attempt: a refused op download records a failed
// receipt with op still remaining and the prior op bytes intact. Wrong
// behavior caught: an update that never reaches its planned installer, or
// one that replaces the prior selection before verification.
test("deps update --apply attempts each planned install once and keeps the prior op on a refused download", async () => {
	const box = sandbox();
	plantWrongOp(box.state);
	const host = refusingHost();
	try {
		const previewed = await deps(box, ["update", REVISION, "--preview"]);
		expect(previewed.result.data.plannedEffects).toEqual(["op-update"]);
		const before = selections(box.state);
		const applied = await deps(box, ["update", REVISION, "--apply", previewed.result.data.previewId], { CONNECTORS_TEST_RELEASE_ORIGIN: host.origin });
		expect(applied.result).toMatchObject({ causeCode: "DOMAIN_DEPS_UPDATE_FAILED_RECORDED", transactionState: "partially-completed" });
		expect(applied.result.effects).toEqual({ completed: ["deps-update-receipt"], remaining: ["op-update"], uncertain: [], inventoryComplete: true });
		expect(host.requests).toEqual([OP_PATH]);
		expect(selections(box.state)).toEqual(before);
	} finally {
		host.stop();
		box.bundle.dispose();
	}
});

// Protects AC16's stale preview and the preview kind boundary: a selection
// that changed after the preview, or a repair preview offered to update,
// refuses before any receipt or request.
test("deps update --apply refuses a stale preview and a repair preview before any receipt or download", async () => {
	const box = sandbox();
	plantWrongOp(box.state);
	const host = refusingHost();
	try {
		const repairPreview = await deps(box, ["repair", "op", "--preview"]);
		const mismatched = await deps(box, ["update", REVISION, "--apply", repairPreview.result.data.previewId], { CONNECTORS_TEST_RELEASE_ORIGIN: host.origin });
		expect(mismatched.result).toMatchObject({ commandIdentity: "connectors.deps.update.apply", outcome: "refused", causeCode: "DOMAIN_DEPS_PREVIEW_INVALID", transactionState: "unchanged", data: null });
		const previewed = await deps(box, ["update", REVISION, "--preview"]);
		// Staleness is judged on the observed selection view, so the change
		// must be observable: the refused op selection is removed.
		rmSync(path.join(box.state, "connectors", "setup", "op"), { recursive: true });
		const stale = await deps(box, ["update", REVISION, "--apply", previewed.result.data.previewId], { CONNECTORS_TEST_RELEASE_ORIGIN: host.origin });
		expect(stale.code).toBe(3);
		expect(stale.result).toMatchObject({ commandIdentity: "connectors.deps.update.apply", outcome: "refused", causeCode: "DOMAIN_DEPS_PREVIEW_STALE", effectClass: "inspect", transactionState: "unchanged", nextAction: "connectors.deps.update.preview", repairAction: `Run connectors deps update ${REVISION} --preview again` });
		expect(host.requests).toEqual([]);
		expect(records(box.state, "receipts")).toEqual([]);
	} finally {
		host.stop();
		box.bundle.dispose();
	}
});

// Protects AC16's concurrent apply: two processes applying one update
// preview make exactly one install attempt and one refusal.
test("two concurrent update applies of one preview make exactly one attempt and one refusal", async () => {
	const box = sandbox();
	plantWrongOp(box.state);
	const host = refusingHost(1_500);
	try {
		const previewed = await deps(box, ["update", REVISION, "--preview"]);
		const argv = ["update", REVISION, "--apply", previewed.result.data.previewId];
		const results = await Promise.all([deps(box, argv, { CONNECTORS_TEST_RELEASE_ORIGIN: host.origin }), deps(box, argv, { CONNECTORS_TEST_RELEASE_ORIGIN: host.origin })]);
		expect(results.map(({ result }) => result.causeCode).sort()).toEqual(["DOMAIN_DEPS_PREVIEW_CONSUMED", "DOMAIN_DEPS_UPDATE_FAILED_RECORDED"]);
		expect(host.requests).toEqual([OP_PATH]);
	} finally {
		host.stop();
		box.bundle.dispose();
	}
});

// Protects AC16's interrupted update: a killed apply keeps the prior
// selection, its claimed receipt stays "started" rather than claiming an
// outcome, a replay refuses, and a fresh preview is still possible.
test("an update apply killed mid-download keeps the prior selection, records no outcome, and is never replayed", async () => {
	const box = sandbox();
	plantWrongOp(box.state);
	const host = refusingHost(10_000);
	try {
		const previewed = await deps(box, ["update", REVISION, "--preview"]);
		const id: string = previewed.result.data.previewId;
		const before = selections(box.state);
		const child = Bun.spawn([box.bundle.binary, "deps", "update", REVISION, "--apply", id], { env: { HOME: box.home, PATH: `${box.hostile}:/usr/bin:/bin`, TMPDIR: box.bundle.root, XDG_STATE_HOME: box.state, CONNECTORS_TEST_RELEASE_ORIGIN: host.origin }, stdout: "pipe", stderr: "pipe" });
		for (let waited = 0; host.requests.length === 0 && waited < 10_000; waited += 50) await Bun.sleep(50);
		expect(host.requests).toEqual([OP_PATH]);
		child.kill("SIGKILL");
		await child.exited;
		expect(selections(box.state)).toEqual(before);
		expect(JSON.parse(readFileSync(path.join(box.state, "connectors", "deps", "receipts", `${id}.json`), "utf8"))).toMatchObject({ previewId: id, outcome: "started" });
		const replay = await deps(box, ["update", REVISION, "--apply", id], { CONNECTORS_TEST_RELEASE_ORIGIN: host.origin });
		expect(replay.result).toMatchObject({ causeCode: "DOMAIN_DEPS_PREVIEW_CONSUMED", transactionState: "unchanged" });
		expect(host.requests).toEqual([OP_PATH]);
		const fresh = await deps(box, ["update", REVISION, "--preview"]);
		expect(fresh.result.causeCode).toBe("SUCCESS_DEPS_UPDATE_PREVIEWED");
	} finally {
		host.stop();
		box.bundle.dispose();
	}
});

// Protects the accepted deps surface: status, repair preview/apply, and
// update preview/apply are the deps routes; previews are repository-local
// and applies external (cli-proposal command table).
test("discovery declares exactly the deps status, repair, and update routes with their effect classes", async () => {
	const box = sandbox();
	try {
		const run = await runBundle(box.bundle, ["--discover", "--json"], { home: box.home, binDir: box.hostile, extraEnv: { XDG_STATE_HOME: box.state } });
		expect([run.code, run.stderr]).toEqual([0, ""]);
		const commands: { commandIdentity: string; route: string[]; effectClass: string }[] = JSON.parse(run.stdout).result.data.commands;
		expect(commands.filter((command) => command.route[0] === "deps").map(({ commandIdentity, route, effectClass }) => ({ commandIdentity, route, effectClass }))).toEqual([
			{ commandIdentity: "connectors.deps.status", route: ["deps", "status"], effectClass: "inspect" },
			{ commandIdentity: "connectors.deps.repair.preview", route: ["deps", "repair", "--preview"], effectClass: "repository-local" },
			{ commandIdentity: "connectors.deps.repair.apply", route: ["deps", "repair", "--apply"], effectClass: "external" },
			{ commandIdentity: "connectors.deps.update.preview", route: ["deps", "update", "--preview"], effectClass: "repository-local" },
			{ commandIdentity: "connectors.deps.update.apply", route: ["deps", "update", "--apply"], effectClass: "external" },
		]);
		expect(existsSync(box.state)).toBe(false);
	} finally {
		box.bundle.dispose();
	}
});
