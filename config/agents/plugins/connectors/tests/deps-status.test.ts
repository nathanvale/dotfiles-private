// Ticket #141 (F-b) under Spec #87 AC19: `deps status [tool]` inspects each
// declared dependency's plugin-owned selection. Every case spawns the
// packaged binary from an isolated bundle with its own HOME and XDG state and
// a hostile PATH. Expected versions, identities, causes, and routes are
// literals from the accepted proposal and decisions (Q13c, Q-op, Q-mise, C4),
// never read from the production catalogue or requirements.json.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createBundle, runBundle, type Bundle } from "./harness.ts";

const SENTINEL = "deps-status-secret-sentinel-5c1e";

// Independent oracle: the accepted pins (Spec #87 names MCPorter 0.14.0;
// the packaged Requirements Manifest owns op, mise, and uv). Deliberately
// restated here, not imported.
const REQUIRED = { mcporter: "0.14.0", op: "2.39.0", mise: "2026.9.12", uv: "0.12.18" } as const;
const FIRST_USE = { commandIdentity: "connectors.run", command: "connectors run <connector> <operation>" };
// C4: every tool after MCPorter's first use repairs through its own explicit
// preview, which leads to apply.
const repairPreview = (tool: string) => ({ commandIdentity: "connectors.deps.repair.preview", command: `connectors deps repair ${tool} --preview` });

interface Sandbox {
	bundle: Bundle;
	home: string;
	state: string;
	hostile: string;
	marker: string;
}

// Every ambient tool on PATH claims the pinned version and records any
// invocation. Status never adopts, runs, or reports an ambient tool.
function sandbox(): Sandbox {
	const bundle = createBundle();
	const home = path.join(bundle.root, "home");
	const hostile = path.join(bundle.root, "hostile-bin");
	const marker = path.join(bundle.root, "ambient-invoked");
	mkdirSync(home);
	mkdirSync(hostile);
	for (const [tool, version] of Object.entries(REQUIRED)) {
		writeFileSync(path.join(hostile, tool), `#!/bin/sh\necho ${tool} >> '${marker}'\necho ${version}\n`, { mode: 0o755 });
	}
	return { bundle, home, state: path.join(bundle.root, "state"), hostile, marker };
}

// Path, mode, and bytes of every entry, so a chmod, rewrite, or new file
// under HOME or XDG state is a visible difference.
function snapshot(root: string): string[] {
	if (!existsSync(root)) return ["<absent>"];
	return readdirSync(root, { recursive: true }).map(String).sort().map((name) => {
		const file = path.join(root, name);
		const stat = lstatSync(file);
		return `${name} ${(stat.mode & 0o7777).toString(8)} ${stat.isFile() ? readFileSync(file, "hex") : ""}`;
	});
}

async function deps(box: Sandbox, argv: string[]) {
	const before = { home: snapshot(box.home), state: snapshot(box.state) };
	const run = await runBundle(box.bundle, ["deps", ...argv], { home: box.home, binDir: box.hostile, extraEnv: { XDG_STATE_HOME: box.state, OP_SERVICE_ACCOUNT_TOKEN: SENTINEL }, timeoutMs: 15_000 });
	expect(run.stderr).toBe("");
	expect(run.stdout.trim().split("\n")).toHaveLength(1);
	for (const forbidden of [SENTINEL, box.home, box.state, box.bundle.root]) expect(run.stdout).not.toContain(forbidden);
	expect(existsSync(box.marker)).toBe(false);
	expect({ home: snapshot(box.home), state: snapshot(box.state) }).toEqual(before);
	return { code: run.code, result: JSON.parse(run.stdout).result };
}

function expectInspectResult(result: Record<string, unknown>, cause: string, exitCode: number, outcome: string): void {
	expect(result).toMatchObject({ commandIdentity: "connectors.deps.status", causeCode: cause, exitCode, outcome, effectClass: "inspect", transactionState: "unchanged" });
	expect(result.effects).toEqual({ completed: [], remaining: [], uncertain: [], inventoryComplete: true });
}

function owned(directory: string): void {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
}

// Wrong selections an earlier install or a damaged state could leave behind.
// Each sits where its owner looks, with owner-acceptable modes, so only the
// selection rule itself can refuse it.
function plantWrongSelections(state: string): void {
	const connectors = path.join(state, "connectors");
	const current = path.join(connectors, "mcporter", "current");
	owned(current);
	writeFileSync(path.join(current, "release.json"), JSON.stringify({ version: "0.13.13" }), { mode: 0o600 });
	writeFileSync(path.join(current, "mcporter"), "older mcporter bytes", { mode: 0o700 });
	const op = path.join(connectors, "setup", "op");
	owned(op);
	writeFileSync(path.join(op, "op-selected"), `op-2.38.0-${"0".repeat(64)}`, { mode: 0o600 });
	writeFileSync(path.join(op, `op-2.38.0-${"0".repeat(64)}`), "older op bytes", { mode: 0o700 });
	const mise = path.join(connectors, "setup", "mise");
	owned(mise);
	writeFileSync(path.join(mise, "mise-selected"), `mise-2026.1.1-${"0".repeat(64)}`, { mode: 0o600 });
	const uv = path.join(connectors, "setup", "uv", "installs", "aqua-astral-sh-uv", "0.12.18", "uv-aarch64-apple-darwin");
	owned(uv);
	writeFileSync(path.join(uv, "uv"), "damaged uv bytes", { mode: 0o700 });
	for (const directory of [state, connectors]) chmodSync(directory, 0o700);
}

// Protects: a fresh machine can inspect every declared dependency without an
// install, a directory, or ambient adoption. Wrong behavior caught: status
// bootstrapping MCPorter (Q13c is for ordinary runs only), creating XDG
// state, or reporting a hostile PATH tool as selected.
test("deps status on fresh state reports all four tools absent with one exact route each and changes nothing", async () => {
	const box = sandbox();
	try {
		const { code, result } = await deps(box, ["status"]);
		expect(code).toBe(0);
		expectInspectResult(result, "SUCCESS_UNCHANGED", 0, "success");
		expect(result.nextAction).toBe("connectors.run");
		expect(result.data.dependencies).toEqual([
			{ tool: "mcporter", owner: "connectors", required: REQUIRED.mcporter, state: "absent", ready: false, selected: null, cause: null, repair: FIRST_USE },
			{ tool: "op", owner: "connectors", required: REQUIRED.op, state: "absent", ready: false, selected: null, cause: null, repair: repairPreview("op") },
			{ tool: "mise", owner: "connectors", required: REQUIRED.mise, state: "absent", ready: false, selected: null, cause: null, repair: repairPreview("mise") },
			{ tool: "uv", owner: "connectors", required: REQUIRED.uv, state: "absent", ready: false, selected: null, cause: null, repair: repairPreview("uv") },
		]);
	} finally {
		box.bundle.dispose();
	}
});

// Protects C4: after first use, a wrong selection is reported not ready and
// left in place, with the explicit route that owns replacing it. Wrong
// behavior caught: status repairing or reselecting a tool, or reporting
// unverified bytes as a selected version.
test("deps status reports each wrong plugin-owned selection not ready, untouched, with its explicit route", async () => {
	const box = sandbox();
	plantWrongSelections(box.state);
	try {
		const { code, result } = await deps(box, ["status"]);
		expect(code).toBe(0);
		expectInspectResult(result, "SUCCESS_UNCHANGED", 0, "success");
		expect(result.nextAction).toBe("connectors.deps.repair.preview");
		expect(result.data.dependencies).toEqual([
			{ tool: "mcporter", owner: "connectors", required: REQUIRED.mcporter, state: "not-ready", ready: false, selected: null, cause: "binary-digest-mismatch", repair: repairPreview("mcporter") },
			{ tool: "op", owner: "connectors", required: REQUIRED.op, state: "not-ready", ready: false, selected: null, cause: "selection-invalid", repair: repairPreview("op") },
			{ tool: "mise", owner: "connectors", required: REQUIRED.mise, state: "not-ready", ready: false, selected: null, cause: "selection-invalid", repair: repairPreview("mise") },
			{ tool: "uv", owner: "connectors", required: REQUIRED.uv, state: "not-ready", ready: false, selected: null, cause: "selection-invalid", repair: repairPreview("uv") },
		]);
	} finally {
		box.bundle.dispose();
	}
});

// Protects the optional tool argument: it narrows the report to exactly
// that declared tool. Wrong behavior caught: ignoring the argument, or
// scoping to a different tool.
test("deps status <tool> reports only that tool", async () => {
	const box = sandbox();
	plantWrongSelections(box.state);
	try {
		const rows = [
			["mcporter", { tool: "mcporter", owner: "connectors", required: REQUIRED.mcporter, state: "not-ready", ready: false, selected: null, cause: "binary-digest-mismatch", repair: repairPreview("mcporter") }, "connectors.deps.repair.preview"],
			["uv", { tool: "uv", owner: "connectors", required: REQUIRED.uv, state: "not-ready", ready: false, selected: null, cause: "selection-invalid", repair: repairPreview("uv") }, "connectors.deps.repair.preview"],
		] as const;
		for (const [tool, row, next] of rows) {
			const { code, result } = await deps(box, ["status", tool]);
			expect([tool, code]).toEqual([tool, 0]);
			expectInspectResult(result, "SUCCESS_UNCHANGED", 0, "success");
			expect(result.nextAction).toBe(next);
			expect(result.data.dependencies).toEqual([row]);
		}
	} finally {
		box.bundle.dispose();
	}
});

// Protects the catalogue refusal: an undeclared tool is a usage refusal
// that never echoes its input, and extra arguments are malformed. Wrong
// behavior caught: echoing a secret-shaped argument, or reporting an empty
// dependency list as success.
test("deps status refuses an undeclared tool without echo and malformed arguments unchanged", async () => {
	const box = sandbox();
	try {
		const unknown = await deps(box, ["status", SENTINEL]);
		expect(unknown.code).toBe(2);
		expectInspectResult(unknown.result, "USAGE_DEPENDENCY_UNKNOWN", 2, "refused");
		expect(unknown.result.data).toBeNull();
		expect(unknown.result.repairAction).toBe("Run connectors deps status [mcporter|op|mise|uv]");
		const extra = await deps(box, ["status", "op", "uv"]);
		expect(extra.code).toBe(2);
		expectInspectResult(extra.result, "USAGE_MALFORMED_ARGUMENTS", 2, "refused");
		expect(extra.result.repairAction).toBe("Run connectors deps status [tool]");
	} finally {
		box.bundle.dispose();
	}
});
