// Ticket #141 (F-c) under Spec #87 AC21: schemaQualified and liveReadProven
// move to proven only from a retained observation of a keyless read that
// succeeded on an admitted hosted route, bound to the packaged endpoint,
// registry and manifest bytes, front-door build, MCPorter pin, and selection,
// and valid for 30 days. Every case spawns the packaged bin/connectors.
//
// Authoring gate. Each test names the behavior it protects and one wrong
// behavior that fails it:
// - loopback fixture: a keyless schema and read that succeed against a
//   copied-root loopback stub retain nothing, and a later status keeps both
//   live states unobserved without writing. Fails if the hosted-origin
//   admission accepted the stub (the disposable negative control).
// - retained records: a malformed, loopback-bound, expired, or mismatched
//   record never promotes, each for its own named reason, and status neither
//   writes nor echoes it. Fails if status trusted a record's presence, or
//   rejected all of them for one unrelated reason.
// - discovery: schema and run declare the one new success station. Fails if
//   the catalogue omitted the station the recorded effect reports.
// - attended T8 (gated, never run by routine suites): one real
//   unauthenticated keyless Context7 schema and read on the unmodified
//   packaged route, then status proves both states with the exact binding.
//   Fails if a hosted success retained nothing or bound the wrong route.
// No existing test reads a retained observation. The oracles are literals;
// the gated row hashes file bytes itself and imports no production module.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AccountKeyMachine, accountKeyPlugin, type ConnectorFixture, OFFICIAL_MCPORTER } from "./fixtures/account-key-machine.ts";
import { createBundle, runBundle } from "./harness.ts";

if (process.env.CI && !OFFICIAL_MCPORTER) throw new Error("CONNECTORS_OFFICIAL_RELEASE_FIXTURE is required for CI process proof");
// The attended T8 gate: set only by Nathan in a foreground session.
const LIVE_T8 = process.env.CONNECTORS_T8_LIVE_KEYLESS === "attended";

const SENTINEL = "evidence-record-secret-sentinel-5e27";
const DAY = 24 * 60 * 60 * 1000;
// Independent oracles restated from the accepted contract.
const HOSTED_CONTEXT7 = "https://mcp.context7.com/mcp";
const MCPORTER = { version: "0.14.0", binarySha256: "01d99ede8b6a88dd282eaeda2afb7086dca5bdbc04c05c8c21744703575adb27" };
const NO_PROVIDER = { verdict: "unobserved", basis: "status-contacts-no-provider", observedAt: null, boundary: null };
const rejected = (basis: string) => ({ verdict: "unobserved", basis, observedAt: null, boundary: null });
const OBSERVED_STATION = {
	causeCode: "SUCCESS_READ_OBSERVED", trigger: "the read completed on an admitted hosted route and its evidence observation was retained", reachability: "provider",
	outcome: "success", failureClass: null, exitCode: 0, effectClass: "repository-local", transactionState: "completed",
	effectEvidence: { mayPopulate: ["completed"], inventoryComplete: true }, retryable: false, retry: { policy: "not-retryable" }, recovery: { kind: "none", repairAction: false },
};

const CONTEXT7: ConnectorFixture = { id: "context7", tools: ["resolve-library-id", "query-docs"], key: "ctx7sk-SENTINEL-evidence-record-key", item: "context7evidenceitem000001" };
const plugin = OFFICIAL_MCPORTER ? accountKeyPlugin([CONTEXT7]) : null;

function snapshot(root: string): string[] {
	if (!existsSync(root)) return ["<absent>"];
	return readdirSync(root, { recursive: true }).map(String).sort().map((name) => {
		const stat = lstatSync(path.join(root, name));
		return `${name} ${(stat.mode & 0o7777).toString(8)} ${stat.isFile() ? readFileSync(path.join(root, name), "hex") : ""}`;
	});
}

type Evidence = Record<string, unknown>;

// One status call that must not write or echo anything private.
async function status(run: () => Promise<{ code: number; stdout: string; stderr: string }>, roots: readonly string[], forbidden: readonly string[]): Promise<Record<string, Evidence>> {
	const before = roots.map(snapshot);
	const result = await run();
	expect(result.stderr).toBe("");
	expect(result.code).toBe(0);
	for (const value of forbidden) expect(result.stdout).not.toContain(value);
	expect(roots.map(snapshot)).toEqual(before);
	const envelope = JSON.parse(result.stdout) as { result: { causeCode: string; effects: unknown; data: { connectors: { id: string; evidence: Record<string, Evidence> }[] } } };
	expect(envelope.result.causeCode).toBe("SUCCESS_UNCHANGED");
	expect(envelope.result.effects).toEqual({ completed: [], remaining: [], uncertain: [], inventoryComplete: true });
	expect(envelope.result.data.connectors.map((row) => row.id)).toEqual(["context7"]);
	return envelope.result.data.connectors[0]?.evidence ?? {};
}

const live = (evidence: Record<string, Evidence>) => ({ schemaQualified: evidence.schemaQualified, liveReadProven: evidence.liveReadProven });

test.skipIf(!plugin)("a keyless schema and read that succeed on a loopback copied-root stub retain nothing, and status keeps both live states unobserved", async () => {
	if (!plugin) return;
	const machine = new AccountKeyMachine(plugin, { OP_SERVICE_ACCOUNT_TOKEN: SENTINEL });
	try {
		const call = async (argv: string[]) => {
			const run = await machine.run(argv);
			expect({ argv, stderr: run.stderr }).toEqual({ argv, stderr: "" });
			const result = JSON.parse(run.stdout).result as { causeCode: string; exitCode: number; effects: { completed: string[] } };
			return [result.exitCode, result.causeCode, result.effects.completed];
		};
		expect(await call(["schema", "context7"])).toEqual([0, "SUCCESS_BOOTSTRAPPED", ["mcporter-bootstrap"]]);
		expect(await call(["run", "context7", "resolve-library-id", "--input", JSON.stringify({ query: "bun" })])).toEqual([0, "SUCCESS_UNCHANGED", []]);
		expect(await call(["run", "context7", "unlisted_tool", "--input", "{}"])).toEqual([2, "USAGE_OPERATION_UNKNOWN", []]);
		expect(plugin.stubs.get("context7")?.calls.length).toBe(1);
		expect(existsSync(path.join(machine.state, "connectors", "evidence"))).toBe(false);

		const evidence = await status(() => machine.run(["status", "context7"]), [machine.state, machine.home], [SENTINEL, machine.state, machine.root, plugin.root]);
		expect(live(evidence)).toEqual({ schemaQualified: NO_PROVIDER, liveReadProven: NO_PROVIDER });
	} finally {
		machine.dispose();
	}
}, 120_000);

// A test-owned record in the accepted private layout, bound to values this
// test chooses. Only rejection is ever asserted from a hand-written record.
function writeRecord(state: string, kind: "schema" | "read", content: string): void {
	const directory = path.join(state, "connectors", "evidence", "context7");
	for (const each of [state, path.join(state, "connectors"), path.join(state, "connectors", "evidence"), directory]) mkdirSync(each, { recursive: true, mode: 0o700 });
	writeFileSync(path.join(directory, `${kind}.json`), content, { mode: 0o600 });
}

function record(kind: "schema" | "read", endpoint: string, observedAt: number): string {
	return `${JSON.stringify({
		schemaVersion: 1, connector: "context7", kind, ...(kind === "read" ? { operation: "resolve-library-id" } : {}),
		route: { server: "context7", endpoint },
		binding: { registrySha256: "0".repeat(64), manifestSha256: "0".repeat(64), buildSha256: "0".repeat(64), mcporter: MCPORTER, selectionSha256: "0".repeat(64) },
		observedAt: new Date(observedAt).toISOString(), validUntil: new Date(observedAt + 30 * DAY).toISOString(),
	})}\n`;
}

test("a retained record that is malformed, loopback-bound, expired, or bound to another build never promotes, and status neither writes nor echoes it", async () => {
	const now = Date.now();
	// [record kind, content, expected schemaQualified, expected liveReadProven]
	const rows: ReadonlyArray<readonly [string, "schema" | "read", string, Evidence, Evidence]> = [
		["malformed", "schema", `{"schemaVersion":1,"connector":"context7","kind":"schema","note":"${SENTINEL}"}\n`, rejected("observation-invalid"), NO_PROVIDER],
		["loopback-bound", "schema", record("schema", "http://127.0.0.1:9/mcp", now - 60_000), rejected("observation-route-not-admitted"), NO_PROVIDER],
		["expired", "schema", record("schema", HOSTED_CONTEXT7, now - 31 * DAY), rejected("observation-expired"), NO_PROVIDER],
		["other build", "schema", record("schema", HOSTED_CONTEXT7, now - 60_000), rejected("observation-binding-mismatch"), NO_PROVIDER],
		["other build read", "read", record("read", HOSTED_CONTEXT7, now - 60_000), NO_PROVIDER, rejected("observation-binding-mismatch")],
	];
	for (const [label, kind, content, schemaQualified, liveReadProven] of rows) {
		const bundle = createBundle();
		try {
			const home = path.join(bundle.root, "home");
			const state = path.join(bundle.root, "state");
			mkdirSync(home);
			writeRecord(state, kind, content);
			const evidence = await status(() => runBundle(bundle, ["status", "context7"], { home, extraEnv: { XDG_STATE_HOME: state, OP_SERVICE_ACCOUNT_TOKEN: SENTINEL }, timeoutMs: 15_000 }), [state, home], [SENTINEL, state, bundle.root, "0".repeat(64)]);
			expect({ label, ...live(evidence) }).toEqual({ label, schemaQualified, liveReadProven });
		} finally {
			bundle.dispose();
		}
	}
}, 60_000);

test("schema and run each declare the retained-observation success station", async () => {
	const bundle = createBundle();
	try {
		const home = path.join(bundle.root, "home");
		mkdirSync(home);
		for (const identity of ["connectors.schema", "connectors.run"]) {
			const run = await runBundle(bundle, ["--discover-command", identity, "--json"], { home, timeoutMs: 15_000 });
			expect([identity, run.code, run.stderr]).toEqual([identity, 0, ""]);
			expect(JSON.parse(run.stdout).result.data.stations).toContainEqual(OBSERVED_STATION);
		}
	} finally {
		bundle.dispose();
	}
});

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

// Attended T8 only: contacts the hosted Context7 endpoint once for schema and
// once for a read, without any credential. Never run by routine or CI suites.
test.skipIf(!LIVE_T8)("attended T8: a real keyless hosted schema and read are retained, and status proves both with the exact binding", async () => {
	const bundle = createBundle();
	try {
		const home = path.join(bundle.root, "home");
		const state = path.join(bundle.root, "state");
		mkdirSync(home);
		const env = { home, timeoutMs: 120_000, extraEnv: { XDG_STATE_HOME: state, ...(OFFICIAL_MCPORTER ? { CONNECTORS_TEST_RELEASE_DIR: OFFICIAL_MCPORTER } : {}) } };
		const call = async (argv: string[]) => {
			const from = Date.now();
			const run = await runBundle(bundle, argv, env);
			expect({ argv, stderr: run.stderr, code: run.code }).toEqual({ argv, stderr: "", code: 0 });
			const result = JSON.parse(run.stdout).result as { causeCode: string; effects: { completed: string[] } };
			expect(result.effects.completed.at(-1)).toBe("evidence-observation");
			expect(["SUCCESS_READ_OBSERVED", "SUCCESS_BOOTSTRAPPED"]).toContain(result.causeCode);
			return { from, to: Date.now() };
		};
		const schemaWindow = await call(["schema", "context7"]);
		const readWindow = await call(["run", "context7", "resolve-library-id", "--input", JSON.stringify({ query: "bun runtime", libraryName: "bun" })]);

		const binding = {
			registrySha256: sha256(path.join(bundle.skillsRoot, "context7", "config", "mcporter.json")),
			manifestSha256: sha256(path.join(bundle.skillsRoot, "context7", "config", "manifest.json")),
			buildSha256: sha256(bundle.binary),
			mcporter: MCPORTER,
		};
		const evidence = await status(() => runBundle(bundle, ["status", "context7"], env), [state, home], [state, bundle.root]);
		for (const [state_, window, extra] of [["schemaQualified", schemaWindow, {}], ["liveReadProven", readWindow, { operation: "resolve-library-id" }]] as const) {
			const row = evidence[state_] as { verdict: string; boundary: string; observedAt: string; observation: { route: unknown; binding: Record<string, unknown>; validUntil: string } };
			expect({ verdict: row.verdict, boundary: row.boundary, route: row.observation.route }).toEqual({ verdict: "proven", boundary: "hosted", route: { server: "context7", endpoint: HOSTED_CONTEXT7 } });
			expect(row.observation.binding).toMatchObject(binding);
			expect(row.observation).toMatchObject(extra);
			expect(row.observation.binding.selectionSha256).toMatch(/^[0-9a-f]{64}$/);
			const observed = Date.parse(row.observedAt);
			expect(observed).toBeGreaterThanOrEqual(Math.floor(window.from / 1000) * 1000);
			expect(observed).toBeLessThanOrEqual(window.to);
			expect(Date.parse(row.observation.validUntil) - observed).toBe(30 * DAY);
		}

		// A changed registry is another route: the same records stop proving.
		const registry = path.join(bundle.skillsRoot, "context7", "config", "mcporter.json");
		writeFileSync(registry, readFileSync(registry, "utf8").replace("keyless rate-limited tier", "keyless tier"));
		expect(live(await status(() => runBundle(bundle, ["status", "context7"], env), [state, home], [state, bundle.root]))).toEqual({
			schemaQualified: rejected("observation-binding-mismatch"), liveReadProven: rejected("observation-binding-mismatch"),
		});
	} finally {
		bundle.dispose();
	}
}, 300_000);
