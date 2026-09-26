// Ticket #137 under Spec #87 (AC8, AC10, AC11, AC13, AC20, AC26): Context7
// and Firecrawl keep their keyless route until each is configured with a
// 1Password item ID, then send that account key only from their own Provider
// role to their own endpoint, and refuse without keyless fallback when the key
// is missing, invalid, or rejected. Every process is the compiled
// bin/connectors of the verified substituted plugin copy
// (fixtures/account-key-machine.ts) under a loopback-only sandbox that denies
// the real Keychain tool. MCPorter is the official 0.14.0 release the
// production bootstrap selects; a hostile mcporter, bun, node, op, uv, and
// uvx sit first on PATH. Each hosted endpoint is a loopback stub and each key
// a sentinel. Substituted-source packaged process proof only: no real
// Keychain, op, Provider account, installed plugin, or hosted endpoint.
//
// Authoring gate. Each test names the behavior it protects and one wrong
// behavior that fails it:
// - keyless: before configure, each connector's schema and run reach only its
//   own endpoint with no Authorization header and read no custody. Fails if
//   an unconfigured connector read 1Password or sent any header.
// - account: after configure, every request to the configured connector's
//   endpoint carries exactly its key, the key never reaches MCPorter, an
//   argument, an environment, a file, or an output, and the other connector
//   stays keyless. Fails if the route put the key into MCPorter's argv or
//   environment, or configuring one connector changed the other.
// - fail closed: a missing item, an item without a key, a malformed
//   registration, and a rejected key each refuse with a fixed repair and no
//   keyless request. Fails if any failure fell back to the keyless entry.
// - allow-list: both modes list the same exact tools, hide the unlisted one,
//   and refuse an unlisted operation before any request. Fails if the account
//   entry widened or narrowed the allow-list.
// No existing test reaches these adapters, and none needs a production seam
// beyond the two per-Skill leaves production also uses.
import { expect, test } from "bun:test";
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { UNLISTED_TOOL } from "./fixtures/account-key-stub.ts";
import { AccountKeyMachine, accountKeyPlugin, type ConnectorFixture, type Envelope, OFFICIAL_MCPORTER, SERVICE_TOKEN } from "./fixtures/account-key-machine.ts";

if (process.env.CI && !OFFICIAL_MCPORTER) throw new Error("CONNECTORS_OFFICIAL_RELEASE_FIXTURE is required for the packaged account-key proof");

// Independent oracles, restated from each Skill's accepted keyless allow-list.
const CONTEXT7: ConnectorFixture = { id: "context7", tools: ["resolve-library-id", "query-docs"], key: "ctx7sk-SENTINEL-context7-account-key", item: "context7fixtureitem0000001" };
const FIRECRAWL: ConnectorFixture = { id: "firecrawl", tools: ["firecrawl_search", "firecrawl_scrape"], key: "fc-SENTINEL-firecrawl-account-key", item: "firecrawlfixtureitem000001" };
const CONNECTORS = [CONTEXT7, FIRECRAWL] as const;
const LABEL = { context7: "Context7", firecrawl: "Firecrawl" } as const;
const MISSING_ITEM = "missingfixtureitem00000001";
const INPUT = { query: "SENTINEL_ACCOUNT_KEY_INPUT_VALUE" };
const AMBIENT = { CONTEXT7_API_KEY: "SENTINEL_AMBIENT_CONTEXT7_KEY", FIRECRAWL_API_KEY: "SENTINEL_AMBIENT_FIRECRAWL_KEY" };
const registrationLiteral = (item: string) => `{"schemaVersion":1,"vault":"API Credentials","item":"${item}"}\n`;
const opRead = (item: string) => ({ argv: ["item", "get", item, "--vault", "API Credentials", "--format", "json"], envKeys: ["HOME", "OP_SERVICE_ACCOUNT_TOKEN", "PATH"], serviceTokenMatches: true });
const keyHandoff = (id: "context7" | "firecrawl", item: string) =>
	`store the ${LABEL[id]} API key yourself in the credential field of the 1Password item with ID ${item}, the ID auth configure recorded, in the API Credentials vault; Connectors never creates, rotates, or imports a key, and never falls back to keyless mode while ${LABEL[id]} is registered`;

const plugin = accountKeyPlugin(CONNECTORS);

interface Context {
	readonly machine: AccountKeyMachine;
	run(argv: string[]): Promise<{ code: number; result: Envelope["result"] }>;
}

const stub = (connector: ConnectorFixture) => {
	const found = plugin.stubs.get(connector.id);
	if (!found) throw new Error(`no stub for ${connector.id}`);
	return found;
};

async function withMachine(body: (context: Context) => Promise<void>): Promise<void> {
	for (const each of plugin.stubs.values()) each.reset();
	const machine = new AccountKeyMachine(plugin, AMBIENT);
	const outputs: string[] = [];
	const context: Context = {
		machine,
		async run(argv) {
			const run = await machine.run(argv);
			outputs.push(run.stdout, run.stderr);
			expect({ argv, stderr: run.stderr }).toEqual({ argv, stderr: "" });
			expect(run.stdout.trim().split("\n")).toHaveLength(1);
			return { code: run.code, result: (JSON.parse(run.stdout) as Envelope).result };
		},
	};
	try {
		await body(context);
		// No key, service token, ambient value, or input value reaches any
		// output or ordinary file, and the hostile PATH entries never ran.
		const sweep = machine.sweepText();
		for (const surface of [...outputs, sweep]) for (const secret of [CONTEXT7.key, FIRECRAWL.key, SERVICE_TOKEN, ...Object.values(AMBIENT)]) expect(surface).not.toContain(secret);
		expect(machine.lines("hostile-recorders.jsonl")).toEqual([]);
		expect(machine.lines("hostile-mcporter.jsonl")).toEqual([]);
	} finally {
		machine.dispose();
	}
}

const station = (run: { code: number; result: Envelope["result"] }) => ({ code: run.code, cause: run.result.causeCode, connectorCause: run.result.data?.connectorCause ?? null });
const toolNames = (schema: unknown) => ((schema as { tools?: { name: string }[] }).tools ?? []).map((tool) => tool.name);
const runArgs = (connector: ConnectorFixture, tool = connector.tools[0] ?? "") => ["run", connector.id, tool, "--input", JSON.stringify(INPUT)];

test.skipIf(!OFFICIAL_MCPORTER)("unconfigured connectors stay keyless: own endpoint, no header, no custody, exact allow-list", async () => {
	await withMachine(async ({ machine, run }) => {
		for (const connector of CONNECTORS) {
			expect((await run(["auth", "status", connector.id])).result.data).toEqual({ connector: connector.id, mode: "keyless", nextStep: `to use an account key, run connectors auth configure ${connector.id} --input '{"item":"<id>"}'` });
			const schema = await run(["schema", connector.id]);
			expect({ code: schema.code, mode: schema.result.data?.mode, server: schema.result.data?.server, allowedTools: schema.result.data?.allowedTools, listed: toolNames(schema.result.data?.schema) }).toEqual({ code: 0, mode: "keyless", server: connector.id, allowedTools: connector.tools, listed: connector.tools });
			const read = await run(runArgs(connector));
			expect({ code: read.code, data: read.result.data }).toEqual({ code: 0, data: { connector: connector.id, operation: connector.tools[0], mode: "keyless", result: { tool: connector.tools[0], arguments: INPUT } } });
			expect(station(await run(runArgs(connector, UNLISTED_TOOL)))).toEqual({ code: 2, cause: "USAGE_OPERATION_UNKNOWN", connectorCause: "operation-not-allowed" });
			expect(stub(connector).headers.length).toBeGreaterThan(0);
			expect(new Set(stub(connector).headers)).toEqual(new Set(["absent"]));
			expect(stub(connector).calls).toEqual([{ name: connector.tools[0], arguments: INPUT }]);
		}
		expect(machine.lines("op-calls.jsonl")).toEqual([]);
		expect(machine.lines("keychain-reads.jsonl")).toEqual([]);
	});
}, 120_000);

for (const [configured, other] of [[CONTEXT7, FIRECRAWL], [FIRECRAWL, CONTEXT7]] as const) {
	test.skipIf(!OFFICIAL_MCPORTER)(`configured ${configured.id} sends its key only from its Provider to its endpoint; ${other.id} stays keyless`, async () => {
		await withMachine(async ({ machine, run }) => {
			machine.storeItem(configured.item, configured.key);
			const recorded = await run(["auth", "configure", configured.id, "--input", JSON.stringify({ item: configured.item })]);
			expect({ ...station(recorded), completed: recorded.result.effects.completed }).toEqual({ code: 0, cause: "SUCCESS_RUN_RECORDED", connectorCause: null, completed: ["custody-registration"] });
			expect(readFileSync(machine.registrationFile(configured.id), "utf8")).toBe(registrationLiteral(configured.item));
			expect(statSync(machine.registrationFile(configured.id)).mode & 0o777).toBe(0o600);
			expect((await run(["auth", "status", configured.id])).result.data).toEqual({ connector: configured.id, mode: "account", vault: "API Credentials", item: configured.item, nextStep: `connectors auth check ${configured.id}` });

			// The custody check reads the item in the Provider's preflight and
			// sends nothing.
			const checked = await run(["auth", "check", configured.id]);
			expect({ code: checked.code, data: checked.result.data }).toEqual({ code: 0, data: { connector: configured.id, custodyChecked: true, vault: "API Credentials", item: configured.item } });
			expect(stub(configured).headers).toEqual([]);

			const schema = await run(["schema", configured.id]);
			expect({ code: schema.code, mode: schema.result.data?.mode, allowedTools: schema.result.data?.allowedTools, listed: toolNames(schema.result.data?.schema) }).toEqual({ code: 0, mode: "account", allowedTools: configured.tools, listed: configured.tools });
			const read = await run(runArgs(configured));
			expect({ code: read.code, data: read.result.data }).toEqual({ code: 0, data: { connector: configured.id, operation: configured.tools[0], mode: "account", result: { tool: configured.tools[0], arguments: INPUT } } });
			expect(station(await run(runArgs(configured, UNLISTED_TOOL)))).toEqual({ code: 2, cause: "USAGE_OPERATION_UNKNOWN", connectorCause: "operation-not-allowed" });
			// Every request to the configured endpoint carried exactly its key.
			expect(stub(configured).headers.length).toBeGreaterThan(0);
			expect(new Set(stub(configured).headers)).toEqual(new Set(["match"]));

			// The other connector is untouched: keyless, no custody.
			expect((await run(["auth", "status", other.id])).result.data?.mode).toBe("keyless");
			expect((await run(runArgs(other))).result.data?.mode).toBe("keyless");
			expect(new Set(stub(other).headers)).toEqual(new Set(["absent"]));

			// The check, then the schema and the read each as preflight plus
			// Provider: five reads of this item only.
			expect(machine.lines("op-calls.jsonl")).toEqual(Array(5).fill(opRead(configured.item)));
			const provider = ["__internal", configured.id, "provider"];
			expect(machine.lines<Record<string, unknown>>("op-parents.jsonl").map((row) => [row.parentRole, row.parentEnvironmentVisible, row.parentHoldsServiceToken, row.parentHoldsProviderToken])).toEqual([
				[[...provider, "--preflight"], true, false, false],
				[[...provider, "--preflight"], true, false, false],
				[provider, true, false, false],
				[[...provider, "--preflight"], true, false, false],
				[provider, true, false, false],
			]);
			// Each Provider's grandparent is the front door (preflight) or the
			// selected MCPorter, and neither holds a key in argv or environment.
			const frontDoor = realpathSync(path.join(plugin.root, "bin", "connectors"));
			const mcporter = realpathSync(path.join(machine.state, "connectors", "mcporter", "current", "mcporter"));
			const label = (executable: string) => (realpathSync(executable) === frontDoor ? "front-door" : realpathSync(executable) === mcporter ? "mcporter" : executable);
			expect(machine.lines<Record<string, unknown>>("op-parents.jsonl").map((row) => [label(row.grandparentExecutable as string), row.grandparentEnvironmentVisible, row.grandparentHoldsServiceToken, row.grandparentHoldsProviderToken])).toEqual([
				["front-door", true, false, false],
				["front-door", true, false, false],
				["mcporter", true, false, false],
				["front-door", true, false, false],
				["mcporter", true, false, false],
			]);
		});
	}, 120_000);
}

test.skipIf(!OFFICIAL_MCPORTER)("a successful tool result may contain the relay rejection marker", async () => {
	await withMachine(async ({ machine, run }) => {
		for (const connector of CONNECTORS) {
			machine.storeItem(connector.item, connector.key);
			expect(station(await run(["auth", "configure", connector.id, "--input", JSON.stringify({ item: connector.item })]))).toEqual({ code: 0, cause: "SUCCESS_RUN_RECORDED", connectorCause: null });
			const input = { query: `${connector.id}-relay:key-rejected` };
			const result = await run(["run", connector.id, connector.tools[0] ?? "", "--input", JSON.stringify(input)]);
			expect({ code: result.code, data: result.result.data }).toEqual({
				code: 0,
				data: { connector: connector.id, operation: connector.tools[0], mode: "account", result: { tool: connector.tools[0], arguments: input } },
			});
		}
	});
}, 120_000);

test.skipIf(!OFFICIAL_MCPORTER)("a configured key that is missing, invalid, or rejected refuses with a repair and makes no keyless request", async () => {
	await withMachine(async ({ machine, run }) => {
		// Bootstrap MCPorter first, so no refusal below also reports that effect.
		expect((await run(["schema", CONTEXT7.id])).result.effects.completed).toEqual(["mcporter-bootstrap"]);
		for (const each of plugin.stubs.values()) each.reset();
		for (const connector of CONNECTORS) {
			const configure = (item: string) => run(["auth", "configure", connector.id, "--input", JSON.stringify({ item })]);
			// An item reference that is not an item ID is refused unrecorded.
			expect(station(await configure(INPUT.query))).toEqual({ code: 4, cause: "SCHEMA_ADAPTER_REFUSED", connectorCause: "item-reference-invalid" });

			// A registered item that 1Password does not hold.
			expect(station(await configure(MISSING_ITEM))).toEqual({ code: 0, cause: "SUCCESS_RUN_RECORDED", connectorCause: null });
			const missing = await run(runArgs(connector));
			expect({ ...station(missing), repair: missing.result.repairAction }).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "item-missing", repair: keyHandoff(connector.id, MISSING_ITEM) });
			expect(station(await run(["schema", connector.id]))).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "item-missing" });
			expect(stub(connector).headers).toEqual([]);

			// A malformed registration refuses rather than guess a mode.
			writeFileSync(machine.registrationFile(connector.id), '{"item":"not-an-item"}\n', { mode: 0o600 });
			expect(station(await run(runArgs(connector)))).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "registration-invalid" });
			expect(stub(connector).headers).toEqual([]);

			// The item exists but holds no key field.
			writeFileSync(machine.registrationFile(connector.id), registrationLiteral(connector.item), { mode: 0o600 });
			machine.storeItem(connector.item, null);
			const invalid = await run(runArgs(connector));
			expect({ ...station(invalid), repair: invalid.result.repairAction }).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "credential-invalid", repair: keyHandoff(connector.id, connector.item) });
			expect(stub(connector).headers).toEqual([]);

			// The endpoint rejects the key: the refusal names it, and every
			// request that left carried the key, never none.
			machine.storeItem(connector.item, connector.key);
			stub(connector).reject = true;
			const rejected = await run(runArgs(connector));
			expect({ ...station(rejected), repair: rejected.result.repairAction }).toEqual({ code: 3, cause: "DOMAIN_ADAPTER_REFUSED", connectorCause: "key-rejected", repair: `${LABEL[connector.id]} rejected the API key in the 1Password item with ID ${connector.item}; ${keyHandoff(connector.id, connector.item)}` });
			expect(stub(connector).headers.length).toBeGreaterThan(0);
			expect(new Set(stub(connector).headers)).toEqual(new Set(["match"]));
			expect(stub(connector).calls).toEqual([]);
			stub(connector).reject = false;
		}
	});
}, 180_000);
