// Ticket #141 keyless data-root finding under Spec #87 (AC8, AC21, AC22): a
// keyless `bin/connectors schema` keeps MCPorter's data and cache inside one
// owned private Connectors state root, never the caller's HOME vault, reports
// MCPorter's vault-file change there as an observed effect, and refuses before
// MCPorter starts when that root is not a private owned directory. The
// compiled bundle binary runs with its own HOME, XDG state, and PATH; a
// hostile `mcporter` sits first on PATH; MCPorter is the official 0.14.0
// release selected from local fixture bytes; the only endpoint is a loopback
// stub. Expected paths, bytes, effects, and causes are test-owned literals.
//
// Authoring gate. Behavior: the generic keyless fallback's MCPorter child
// uses <state>/connectors/mcporter-keyless and leaves a planted caller vault
// byte-identical. Wrong behavior that fails it: MCPorter selecting
// HOME/.mcporter (the observed Mac Mini defect), an effect supplied rather
// than observed, or a refusal that bootstraps MCPorter or reaches the endpoint. The adapter
// transport path is owned by account-key.test.ts; this file owns the generic
// fallback and the refusal.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startLoopbackMcpStub } from "./fixtures/loopback-mcp-stub.ts";
import { createBundle, createFakeMcporterBinDir, runBundle } from "./harness.ts";

const official = process.env.CONNECTORS_OFFICIAL_RELEASE_FIXTURE;
if (process.env.CI && !official) throw new Error("CONNECTORS_OFFICIAL_RELEASE_FIXTURE is required for CI process proof");

const CONNECTOR = "keyless-fixture-skill";
const CALLER_SENTINEL = "SENTINEL_CALLER_HOME_VAULT_ENTRY";
const AMBIENT_SENTINEL = "SENTINEL_AMBIENT_KEYLESS_DATA_ROOT";
// A nonsecret caller vault the keyless route must never open or rewrite.
const CALLER_VAULT = `${JSON.stringify({ version: 2, entries: {}, serverUrls: { [CALLER_SENTINEL]: "https://caller.invalid/mcp" } })}\n`;

test.skipIf(!official)("keyless schema refuses an invalid root before MCPorter bootstrap, then keeps MCPorter in the owned Connectors root and reports its vault file", async () => {
	const bundle = createBundle();
	bundle.addSkill(CONNECTOR);
	const hostile = createFakeMcporterBinDir();
	const stub = startLoopbackMcpStub();
	const home = path.join(bundle.root, "home");
	const state = path.join(bundle.root, "state");
	const callerVault = path.join(home, ".mcporter", "credentials.json");
	// Independent oracle: the accepted keyless root below this test's state.
	const keylessRoot = path.join(state, "connectors", "mcporter-keyless");
	const keylessVault = path.join(keylessRoot, "data", "mcporter", "credentials.json");
	mkdirSync(path.dirname(callerVault), { recursive: true, mode: 0o700 });
	writeFileSync(callerVault, CALLER_VAULT, { mode: 0o600 });
	const callerBefore = { bytes: readFileSync(callerVault, "utf8"), mode: statSync(callerVault).mode & 0o777, mtimeMs: statSync(callerVault).mtimeMs };
	mkdirSync(state, { mode: 0o700 });
	writeFileSync(path.join(bundle.skillsRoot, CONNECTOR, "config", "mcporter.json"), JSON.stringify({ imports: [], mcpServers: { [CONNECTOR]: { baseUrl: stub.url, allowedTools: ["probe"] } } }));
	const schema = async () => {
		const run = await runBundle(bundle, ["schema", CONNECTOR], { home, binDir: hostile.binDir, timeoutMs: 30_000, extraEnv: { XDG_STATE_HOME: state, CONNECTORS_TEST_RELEASE_DIR: official ?? "", CONTEXT7_API_KEY: AMBIENT_SENTINEL } });
		expect({ code: run.code, stderr: run.stderr, lines: run.stdout.trim().split("\n").length }).toEqual({ code: run.code, stderr: "", lines: 1 });
		for (const sentinel of [CALLER_SENTINEL, AMBIENT_SENTINEL]) expect(run.stdout).not.toContain(sentinel);
		return { code: run.code, result: JSON.parse(run.stdout).result };
	};
	const callerUnchanged = () => {
		expect({ entries: readdirSync(path.dirname(callerVault)), bytes: readFileSync(callerVault, "utf8"), mode: statSync(callerVault).mode & 0o777, mtimeMs: statSync(callerVault).mtimeMs }).toEqual({ entries: ["credentials.json"], ...callerBefore });
		expect(readdirSync(home)).toEqual([".mcporter"]);
	};
	try {
		// Configuration before dependency: on a fresh machine, a root that is
		// not a private owned directory refuses before MCPorter is bootstrapped
		// or started. The endpoint sees no request and no vault is written.
		mkdirSync(path.dirname(keylessRoot), { mode: 0o700 });
		writeFileSync(keylessRoot, "not a directory\n");
		const refused = await schema();
		expect({ code: refused.code, outcome: refused.result.outcome, cause: refused.result.causeCode, data: refused.result.data, nextAction: refused.result.nextAction, effects: refused.result.effects }).toEqual({
			code: 3, outcome: "refused", cause: "DOMAIN_MCPORTER_REPAIR_REQUIRED", data: null, nextAction: "connectors.doctor", effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true },
		});
		expect(refused.result.repairAction).toContain("keyless MCPorter data root");
		expect(refused.result.repairAction).not.toContain(state);
		expect(readdirSync(path.dirname(keylessRoot))).toEqual(["mcporter-keyless"]);
		expect(stub.requests).toBe(0);
		expect(readFileSync(keylessRoot, "utf8")).toBe("not a directory\n");
		callerUnchanged();
		rmSync(keylessRoot);

		// First use: bootstrap, then MCPorter writes its index in the owned root.
		const first = await schema();
		expect({ code: first.code, cause: first.result.causeCode, effects: first.result.effects, tools: first.result.data?.schema?.tools?.map((tool: { name: string }) => tool.name) }).toEqual({
			code: 0, cause: "SUCCESS_BOOTSTRAPPED", effects: { completed: ["mcporter-bootstrap", "mcporter-vault-file"], remaining: [], uncertain: [], inventoryComplete: true }, tools: ["probe"],
		});
		callerUnchanged();
		for (const directory of [keylessRoot, path.join(keylessRoot, "data"), path.join(keylessRoot, "cache")]) expect({ directory, mode: statSync(directory).mode & 0o777 }).toEqual({ directory, mode: 0o700 });
		const index = readFileSync(keylessVault, "utf8");
		expect((JSON.parse(index) as { serverUrls?: Record<string, string> }).serverUrls).toEqual({ [CONNECTOR]: stub.url });
		expect(index).not.toContain(CALLER_SENTINEL);

		// The same read again changes nothing, so the effect is observed, never supplied.
		const again = await schema();
		expect({ code: again.code, cause: again.result.causeCode, effects: again.result.effects }).toEqual({ code: 0, cause: "SUCCESS_UNCHANGED", effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true } });
		callerUnchanged();
		expect(existsSync(path.join(bundle.root, "mcporter.json"))).toBe(false);
	} finally {
		stub.stop();
		hostile.dispose();
		bundle.dispose();
	}
}, 90_000);
