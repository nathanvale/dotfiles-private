// Spec #87 AC24, Ticket #141 finding F-d: `config show --resolved --json`
// reports the custody mode and custody subject each packaged adapter resolves
// from its own nonsecret state, with a deterministic source. A manifest's
// credential reference or an adapter's declared mode never becomes effective
// on its own, and an ambiguous registration refuses instead of guessing.
//
// Every row spawns the compiled front door in an isolated bundle with a
// private HOME and XDG_STATE_HOME. Registrations come from the same binary's
// `auth configure`; only the Canva vault index is written here, standing in
// for MCPorter's own write, because MCPorter is the external owner of that
// file. Expected values are hand-typed literals from the AC24 vocabulary.
// Selector-default and requirements-pin provenance stay in manifest-core.
import { describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Bundle, createBundle, PLUGIN_ROOT, type RunResult, runBundle } from "./harness.ts";

const SENTINEL = "SENTINEL_PRIVATE_CREDENTIAL_VALUE";
// Independent oracle: 26-character 1Password item ID shapes, never real items.
const ITEM = "abcdefghijklmnopqrstuvwxy1";
const JIRA_ITEM = "jjjjjjjjjjjjjjjjjjjjjjjjj1";
const CONFLUENCE_ITEM = "ccccccccccccccccccccccccc1";

interface Machine {
	bundle: Bundle;
	state: string;
	run(argv: string[]): Promise<RunResult>;
	show(connector: string, ...select: string[]): Promise<{ result: RunResult; envelope: { result: Record<string, unknown> & { data: { values: Record<string, unknown> } | null } } }>;
	files(): string[];
}

async function withMachine(skills: readonly string[], body: (machine: Machine) => Promise<void>): Promise<void> {
	const bundle = createBundle();
	const state = path.join(bundle.root, "state");
	mkdirSync(state, { mode: 0o700 });
	for (const id of skills) cpSync(path.join(PLUGIN_ROOT, "skills", id, "config"), path.join(bundle.skillsRoot, id, "config"), { recursive: true });
	const run = (argv: string[]) => runBundle(bundle, argv, { home: path.join(bundle.root, "home"), extraEnv: { XDG_STATE_HOME: state, OP_SERVICE_ACCOUNT_TOKEN: SENTINEL } });
	const machine: Machine = {
		bundle,
		state,
		run,
		async show(connector, ...select) {
			const result = await run(["config", "show", connector, "--resolved", "--json", ...select.flatMap((value) => ["--select", value])]);
			return { result, envelope: JSON.parse(result.stdout) };
		},
		files: () => readdirSync(state, { recursive: true }).map(String).sort(),
	};
	try {
		await body(machine);
	} finally {
		bundle.dispose();
	}
}

// Nothing secret or private leaves the process: no sentinel, no item ID, no
// state or home path, one envelope on stdout, empty stderr.
function expectClean(machine: Machine, result: RunResult): void {
	expect(result.stderr).toBe("");
	for (const forbidden of [SENTINEL, ITEM, JIRA_ITEM, CONFLUENCE_ITEM, machine.state, machine.bundle.root]) expect(result.stdout).not.toContain(forbidden);
}

async function custodyOf(machine: Machine, connector: string, ...select: string[]): Promise<unknown> {
	const before = machine.files();
	const { result, envelope } = await machine.show(connector, ...select);
	expectClean(machine, result);
	expect([result.code, envelope.result.causeCode]).toEqual([0, "SUCCESS_UNCHANGED"]);
	expect(machine.files()).toEqual(before);
	const values = envelope.result.data?.values ?? {};
	return { custodyMode: values.custodyMode, subject: values["custody:subject"] };
}

async function configure(machine: Machine, argv: string[]): Promise<void> {
	const result = await machine.run(["auth", "configure", ...argv]);
	expect(result.stderr).toBe("");
	expect([result.code, JSON.parse(result.stdout).result.causeCode]).toEqual([0, "SUCCESS_RUN_RECORDED"]);
}

const KEYLESS_UNTIL_REGISTERED = {
	custodyMode: { value: "keyless", source: "plugin-state:registration-absent", notYetEffective: { value: "1password-below-mcporter", source: "plugin-state:registration-absent" } },
	subject: { value: null, source: "not-applicable" },
};
const REGISTERED_ACCOUNT_KEY = {
	custodyMode: { value: "1password-below-mcporter", source: "plugin-state:registration" },
	subject: { value: null, source: "not-applicable" },
};

describe("config show custody provenance: Spec AC24 through each packaged adapter", () => {
	test("an optional account key stays keyless despite its declared 1Password reference until its own registration, per connector", async () => {
		await withMachine(["mermaid"], async (machine) => {
			for (const id of ["context7", "firecrawl", "mermaid"]) expect(await custodyOf(machine, id)).toEqual(KEYLESS_UNTIL_REGISTERED);
			await configure(machine, ["context7", "--input", JSON.stringify({ item: ITEM })]);
			await configure(machine, ["mermaid", "--input", JSON.stringify({ item: ITEM })]);
			expect(await custodyOf(machine, "context7")).toEqual(REGISTERED_ACCOUNT_KEY);
			expect(await custodyOf(machine, "mermaid")).toEqual(REGISTERED_ACCOUNT_KEY);
			expect(await custodyOf(machine, "firecrawl")).toEqual(KEYLESS_UNTIL_REGISTERED);
		});
	}, 60_000);

	test("an Atlassian tenant's custody is effective only for the registered tenant the invocation selects", async () => {
		await withMachine(["atlassian"], async (machine) => {
			const unregistered = (tenant: string) => ({
				custodyMode: { value: null, source: "not-yet-effective", notYetEffective: { value: "1password-below-mcporter", source: "plugin-state:registration-absent" } },
				subject: { value: tenant, selector: "tenant", source: "invocation-selector" },
			});
			expect(await custodyOf(machine, "atlassian", "tenant=acme")).toEqual(unregistered("acme"));
			await configure(machine, ["atlassian", "--select", "tenant=acme", "--input", JSON.stringify({ jiraItem: JIRA_ITEM, confluenceItem: CONFLUENCE_ITEM })]);
			expect(await custodyOf(machine, "atlassian", "tenant=acme")).toEqual({
				custodyMode: { value: "1password-below-mcporter", source: "plugin-state:registration" },
				subject: { value: "acme", selector: "tenant", source: "invocation-selector" },
			});
			expect(await custodyOf(machine, "atlassian", "tenant=other")).toEqual(unregistered("other"));
		});
	}, 60_000);

	test("a Canva account's native vault is effective only once its own vault index exists and its client mode is admitted", async () => {
		await withMachine(["canva"], async (machine) => {
			const subject = (account: string) => ({ value: account, selector: "account", source: "invocation-selector" });
			const pending = (source: string) => ({ value: null, source: "not-yet-effective", notYetEffective: { value: "mcporter-native-vault", source } });
			expect(await custodyOf(machine, "canva", "account=alpha")).toEqual({ custodyMode: pending("plugin-state:account-vault-absent"), subject: subject("alpha") });
			// MCPorter's own index write for account alpha, grant-free.
			const index = path.join(machine.state, "connectors", "canva-mcporter", "alpha", "data", "mcporter");
			mkdirSync(index, { recursive: true, mode: 0o700 });
			writeFileSync(path.join(index, "credentials.json"), "{}", { mode: 0o600 });
			expect(await custodyOf(machine, "canva", "account=alpha")).toEqual({ custodyMode: { value: "mcporter-native-vault", source: "plugin-state:account-vault-index" }, subject: subject("alpha") });
			expect(await custodyOf(machine, "canva", "account=beta")).toEqual({ custodyMode: pending("plugin-state:account-vault-absent"), subject: subject("beta") });
			writeFileSync(path.join(machine.bundle.skillsRoot, "canva", "config", "client.json"), JSON.stringify({ mode: "approved" }));
			expect(await custodyOf(machine, "canva", "account=alpha")).toEqual({ custodyMode: pending("packaged-config:client-mode-not-admitted"), subject: subject("alpha") });
		});
	}, 60_000);

	test("an ambiguous registration or an inadmissible subject refuses without echoing it or changing state", async () => {
		await withMachine(["canva", "mermaid"], async (machine) => {
			const directory = path.join(machine.state, "connectors", "context7");
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			chmodSync(directory, 0o700);
			writeFileSync(path.join(directory, "registration.json"), `${JSON.stringify({ schemaVersion: 1, vault: "API Credentials", item: SENTINEL })}\n`, { mode: 0o600 });
			const cases: [string, string[], number, string, string][] = [
				["context7", [], 3, "DOMAIN_ADAPTER_REFUSED", "registration-invalid"],
				["canva", [`account=${SENTINEL}`], 2, "USAGE_ADAPTER_REFUSED", "account-invalid"],
			];
			for (const [connector, select, code, cause, connectorCause] of cases) {
				const before = machine.files();
				const { result, envelope } = await machine.show(connector, ...select);
				expectClean(machine, result);
				expect([result.code, envelope.result.commandIdentity, envelope.result.outcome, envelope.result.causeCode, envelope.result.data]).toEqual([code, "connectors.config.show", "refused", cause, { connector, connectorCause }]);
				expect(machine.files()).toEqual(before);
			}
		});
	}, 60_000);

	test("discovery declares the adapter refusals config show can now reach and the plugin state it reads", async () => {
		await withMachine([], async (machine) => {
			const result = await machine.run(["--discover-command", "connectors.config.show", "--json"]);
			expect([result.code, result.stderr]).toEqual([0, ""]);
			const stations = JSON.parse(result.stdout).result.data.stations as { causeCode: string; reachability: string }[];
			expect(stations.map((station) => station.causeCode).sort()).toEqual([
				"DOMAIN_ADAPTER_REFUSED", "SCHEMA_ADAPTER_REFUSED", "SCHEMA_ADAPTER_UNKNOWN", "SCHEMA_MANIFEST_INVALID", "SCHEMA_REQUIREMENTS_INVALID", "SCHEMA_SELECTOR_INVALID", "SCHEMA_VERSION_UNSUPPORTED", "SUCCESS_UNCHANGED", "USAGE_ADAPTER_REFUSED", "USAGE_CONNECTOR_UNKNOWN", "USAGE_MALFORMED_ARGUMENTS",
			]);
			expect(stations.find((station) => station.causeCode === "SUCCESS_UNCHANGED")?.reachability).toBe("plugin-state");
		});
	});
});
