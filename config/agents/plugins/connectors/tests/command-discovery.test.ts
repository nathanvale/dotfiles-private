// Spec #87 AC19: command-scoped discovery. `--discover-command <identity>
// --json` describes one declared command's route, usage, effect class, and
// possible stations without running it, reading state, or claiming live
// proof. Every expected value below is a test-owned literal of the accepted
// contract, never read back from bin/connectors.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { runBundle } from "./harness.ts";
import { SENTINEL, sandbox, type Sandbox } from "./deps-sandbox.ts";

// Independent oracle: the accepted command identities with their routes and
// effect classes (help text and Spec AC19), plus this route itself.
const COMMANDS: Readonly<Record<string, readonly [string[], string]>> = {
	"connectors.dispatch": [[], "inspect"],
	"connectors.help": [["--help"], "inspect"],
	"connectors.discovery": [["--discover", "--json"], "inspect"],
	"connectors.discovery.command": [["--discover-command", "--json"], "inspect"],
	"connectors.list": [["list"], "inspect"],
	"connectors.setup": [["setup"], "repository-local"],
	"connectors.config.validate": [["config", "validate"], "inspect"],
	"connectors.config.show": [["config", "show"], "inspect"],
	"connectors.status": [["status"], "inspect"],
	"connectors.doctor": [["doctor"], "inspect"],
	"connectors.schema": [["schema"], "repository-local"],
	"connectors.deps.status": [["deps", "status"], "inspect"],
	"connectors.deps.repair.preview": [["deps", "repair", "--preview"], "repository-local"],
	"connectors.deps.repair.apply": [["deps", "repair", "--apply"], "external"],
	"connectors.deps.update.preview": [["deps", "update", "--preview"], "repository-local"],
	"connectors.deps.update.apply": [["deps", "update", "--apply"], "external"],
	"connectors.fixtureAuth": [["fixture-auth"], "repository-local"],
	"connectors.auth": [["auth"], "external"],
	"connectors.run": [["run"], "repository-local"],
	"connectors.run.preview": [["run", "--preview"], "repository-local"],
	"connectors.run.apply": [["run", "--apply"], "external"],
	"connectors.recover": [["recover"], "inspect"],
	"connectors.recover.adjudicate": [["recover", "--adjudicate"], "repository-local"],
	"connectors.recover.unlock": [["recover", "--unlock"], "repository-local"],
};
const IDENTITIES = Object.keys(COMMANDS);
const SCOPE = "possible stations declared by this build; not live state, authorization, or proof";

// Independent oracle: the station vocabulary of cli-proposal "Stations and
// recovery" and the cli-design Branch Station catalogue. Reachability names
// the deepest input a station's decision may depend on.
const STATION_KEYS = ["causeCode", "effectClass", "effectEvidence", "exitCode", "failureClass", "outcome", "reachability", "recovery", "retry", "retryable", "transactionState", "trigger"];
const REACHABILITY = ["arguments", "packaged-files", "plugin-state", "dependency-selection", "dependency-install", "provider", "attended-terminal", "interruption"];
const RECOVERY_KINDS = ["none", "repair", "retry", "inspect-effects", "attended-handoff"];
const NOTHING_CHANGED = { mayPopulate: [], inventoryComplete: true };
const NOT_RETRYABLE = { policy: "not-retryable" };

interface Station {
	causeCode: string;
	trigger: string;
	reachability: string;
	outcome: string;
	failureClass: string | null;
	exitCode: number;
	effectClass: string;
	transactionState: string;
	effectEvidence: { mayPopulate: string[]; inventoryComplete: boolean };
	retryable: boolean;
	retry: { policy: string };
	recovery: { kind: string; repairAction: boolean };
}

interface InputElement {
	position: number;
	kind: string;
	token?: string;
	name?: string;
	value?: Record<string, unknown>;
	required: boolean;
	repeatable: boolean;
	onlyWhen?: string;
}

let box: Sandbox | null = null;
afterEach(() => {
	if (box) rmSync(box.bundle.root, { recursive: true, force: true });
	box = null;
});

// One packaged-process call with a hostile PATH, private XDG state, and a
// sentinel in the environment. Discovery is inspection only: no PATH tool
// runs, no state or HOME entry appears, and nothing private is echoed.
async function discoverCommand(argv: string[]) {
	box ??= sandbox();
	const run = await runBundle(box.bundle, argv, { home: box.home, binDir: box.hostile, extraEnv: { XDG_STATE_HOME: box.state, OP_SERVICE_ACCOUNT_TOKEN: SENTINEL }, timeoutMs: 20_000 });
	expect(run.stderr).toBe("");
	expect(run.stdout.trim().split("\n")).toHaveLength(1);
	for (const forbidden of [SENTINEL, box.home, box.state, box.bundle.root, realpathSync(box.bundle.root)]) expect(run.stdout).not.toContain(forbidden);
	expect(existsSync(box.marker)).toBe(false);
	expect(existsSync(box.state)).toBe(false);
	expect(readdirSync(box.home)).toEqual([]);
	return { code: run.code, envelope: JSON.parse(run.stdout) };
}

async function describeCommand(identity: string) {
	const { code, envelope } = await discoverCommand(["--discover-command", identity, "--json"]);
	expect([identity, code, envelope.result.causeCode]).toEqual([identity, 0, "SUCCESS_UNCHANGED"]);
	return envelope.result.data as { command: { commandIdentity: string; route: string[]; effectClass: string; usage: string; input: InputElement[] }; stations: Station[]; exitMeanings: Record<string, string>; scope: string };
}

const causes = (stations: readonly Station[]): string[] => stations.map((station) => station.causeCode);

describe("command-scoped discovery (packaged process)", () => {
	test("describes every accepted command identity by its route and effect class, and generic discovery lists the same set", async () => {
		expect(IDENTITIES).toHaveLength(24);
		const generic = await discoverCommand(["--discover", "--json"]);
		expect(generic.envelope.availablePaths).toEqual([...IDENTITIES].sort());
		const described = [];
		for (const identity of IDENTITIES) {
			const data = await describeCommand(identity);
			described.push([data.command.commandIdentity, data.command.route, data.command.effectClass, data.scope, data.stations.length > 0, data.command.usage.length > 0]);
		}
		expect(described).toEqual(IDENTITIES.map((identity) => [identity, COMMANDS[identity]![0], COMMANDS[identity]![1], SCOPE, true, true]));
	}, 60_000);

	test("names the exact stations of setup, list, dispatch, and itself", async () => {
		expect(causes((await describeCommand("connectors.setup")).stations).sort()).toEqual([
			"DOMAIN_SETUP_FAILED_PARTIAL", "DOMAIN_SETUP_FAILED_UNCHANGED", "INTERNAL_SETUP_AFTER_COMMIT", "INTERNAL_SETUP_UNKNOWN", "SCHEMA_SETUP_CONFIG_INVALID", "SUCCESS_COMPLETED", "USAGE_SETUP_MALFORMED",
		]);
		const list = await describeCommand("connectors.list");
		expect(list.stations).toEqual([
			{ causeCode: "SUCCESS_UNCHANGED", trigger: "the command completed without changing any state", reachability: "packaged-files", outcome: "success", failureClass: null, exitCode: 0, effectClass: "inspect", transactionState: "unchanged", effectEvidence: NOTHING_CHANGED, retryable: false, retry: NOT_RETRYABLE, recovery: { kind: "none", repairAction: false } },
			{ causeCode: "USAGE_MALFORMED_ARGUMENTS", trigger: "the arguments do not match the command's input schema", reachability: "arguments", outcome: "refused", failureClass: "usage", exitCode: 2, effectClass: "inspect", transactionState: "unchanged", effectEvidence: NOTHING_CHANGED, retryable: false, retry: NOT_RETRYABLE, recovery: { kind: "repair", repairAction: true } },
		]);
		expect(list.exitMeanings).toEqual({ "0": "success", "2": "usage" });
		expect(causes((await describeCommand("connectors.dispatch")).stations).sort()).toEqual(["INTERNAL_UNEXPECTED_AFTER_BOOTSTRAP", "INTERNAL_UNEXPECTED_UNCHANGED", "USAGE_UNKNOWN_COMMAND"]);
		const self = await describeCommand("connectors.discovery.command");
		expect(causes(self.stations).sort()).toEqual(["SUCCESS_UNCHANGED", "USAGE_MALFORMED_ARGUMENTS", "USAGE_UNKNOWN_COMMAND"]);
		expect(self.command.usage).toBe("--discover-command <identity> --json");
	});

	test("an explicit update apply declares its success, refusal, and recovery stations and no other command's", async () => {
		const data = await describeCommand("connectors.deps.update.apply");
		expect(data.command.usage).toBe("deps update <revision> --apply <previewId>");
		expect(data.stations).toContainEqual({ causeCode: "SUCCESS_DEPS_UPDATED", trigger: "every planned dependency update was installed and verified after its receipt", reachability: "dependency-install", outcome: "success", failureClass: null, exitCode: 0, effectClass: "external", transactionState: "completed", effectEvidence: { mayPopulate: ["completed"], inventoryComplete: true }, retryable: false, retry: NOT_RETRYABLE, recovery: { kind: "none", repairAction: false } });
		expect(data.stations).toContainEqual({ causeCode: "DOMAIN_DEPS_PREVIEW_STALE", trigger: "the observed dependency selection changed after the preview was recorded", reachability: "plugin-state", outcome: "refused", failureClass: "domain", exitCode: 3, effectClass: "inspect", transactionState: "unchanged", effectEvidence: NOTHING_CHANGED, retryable: false, retry: NOT_RETRYABLE, recovery: { kind: "repair", repairAction: true } });
		expect(data.stations).toContainEqual({ causeCode: "DOMAIN_DEPS_UPDATE_EFFECT_UNKNOWN", trigger: "an update install stopped where its effect cannot be confirmed", reachability: "dependency-install", outcome: "failed", failureClass: "domain", exitCode: 3, effectClass: "external", transactionState: "unknown", effectEvidence: { mayPopulate: ["completed", "remaining", "uncertain"], inventoryComplete: true }, retryable: false, retry: NOT_RETRYABLE, recovery: { kind: "inspect-effects", repairAction: true } });
		expect(data.stations).toContainEqual({ causeCode: "INTERNAL_DEPS_UPDATE_PARTIAL", trigger: "an unexpected failure stopped the update after some planned updates completed and before the rest started", reachability: "interruption", outcome: "failed", failureClass: "internal", exitCode: 1, effectClass: "external", transactionState: "partially-completed", effectEvidence: { mayPopulate: ["completed", "remaining"], inventoryComplete: true }, retryable: false, retry: NOT_RETRYABLE, recovery: { kind: "inspect-effects", repairAction: true } });
		for (const foreign of ["SUCCESS_DEPS_REPAIRED", "SUCCESS_DEPS_UPDATE_PREVIEWED", "SUCCESS_RUN_APPLIED", "USAGE_UNKNOWN_COMMAND"]) expect(causes(data.stations)).not.toContain(foreign);
		expect(data.exitMeanings).toEqual({ "0": "success", "1": "internal", "2": "usage", "3": "domain" });
	});

	test("run apply, auth, and schema keep their own write, attended, and transient stations", async () => {
		const apply = await describeCommand("connectors.run.apply");
		expect(apply.stations).toContainEqual({ causeCode: "SUCCESS_RUN_APPLIED", trigger: "the Provider confirmed the one previewed write after its receipt was recorded", reachability: "provider", outcome: "success", failureClass: null, exitCode: 0, effectClass: "external", transactionState: "completed", effectEvidence: { mayPopulate: ["completed"], inventoryComplete: true }, retryable: false, retry: NOT_RETRYABLE, recovery: { kind: "none", repairAction: false } });
		expect(apply.stations).toContainEqual({ causeCode: "DOMAIN_RUN_EFFECT_UNKNOWN", trigger: "the write may have reached the Provider but its effect was not confirmed", reachability: "provider", outcome: "failed", failureClass: "domain", exitCode: 3, effectClass: "external", transactionState: "unknown", effectEvidence: { mayPopulate: ["completed", "remaining", "uncertain"], inventoryComplete: true }, retryable: false, retry: NOT_RETRYABLE, recovery: { kind: "inspect-effects", repairAction: true } });
		expect(causes(apply.stations)).not.toContain("SUCCESS_AUTH_LOGIN");
		const auth = await describeCommand("connectors.auth");
		expect(causes(auth.stations)).toEqual(expect.arrayContaining(["DOMAIN_ATTENDED_REQUIRED", "SUCCESS_AUTH_LOGIN", "DOMAIN_AUTH_LOGIN_UNKNOWN"]));
		expect(causes(auth.stations)).not.toContain("DOMAIN_PROVIDER_CALL_FAILED");
		expect(auth.stations).toContainEqual({ causeCode: "DOMAIN_ATTENDED_REQUIRED", trigger: "login needs an attended terminal and none is available to this process", reachability: "attended-terminal", outcome: "refused", failureClass: "domain", exitCode: 3, effectClass: "inspect", transactionState: "unchanged", effectEvidence: NOTHING_CHANGED, retryable: false, retry: NOT_RETRYABLE, recovery: { kind: "attended-handoff", repairAction: true } });
		const schema = await describeCommand("connectors.schema");
		expect(schema.stations).toContainEqual({ causeCode: "TRANSIENT_PROVIDER_UNREACHABLE", trigger: "the Provider was unreachable, so no request reached it", reachability: "provider", outcome: "refused", failureClass: "transient", exitCode: 75, effectClass: "inspect", transactionState: "unchanged", effectEvidence: NOTHING_CHANGED, retryable: true, retry: { policy: "same-invocation" }, recovery: { kind: "retry", repairAction: true } });
		expect(causes(schema.stations)).not.toContain("SUCCESS_RUN_APPLIED");
		// A null adapter is the keyless schema route, so schema can never
		// refuse for an undeclared adapter (Ticket #141).
		expect(causes(schema.stations)).not.toContain("DOMAIN_ADAPTER_NOT_DECLARED");
	});

	test("every station of every command declares its trigger, reachability, effect evidence, retry policy, and recovery", async () => {
		const rows = [];
		for (const identity of IDENTITIES) {
			const { stations } = await describeCommand(identity);
			const triggers = new Set(stations.map((station) => station.trigger));
			rows.push([identity, triggers.size === stations.length, stations.every((station) => station.trigger.length > 0)]);
			for (const station of stations) {
				expect([identity, station.causeCode, Object.keys(station).sort()]).toEqual([identity, station.causeCode, STATION_KEYS]);
				expect([identity, station.causeCode, REACHABILITY.includes(station.reachability), RECOVERY_KINDS.includes(station.recovery.kind)]).toEqual([identity, station.causeCode, true, true]);
				// Contract Core: partial and unknown effects are nonretryable, and only a retryable row retries.
				expect([station.causeCode, station.retry.policy]).toEqual([station.causeCode, station.retryable ? "same-invocation" : "not-retryable"]);
				expect(station.effectEvidence.inventoryComplete).toBe(true);
			}
		}
		expect(rows).toEqual(IDENTITIES.map((identity) => [identity, true, true]));
		const self = await describeCommand("connectors.discovery.command");
		expect(self.stations).toContainEqual({ causeCode: "USAGE_MALFORMED_ARGUMENTS", trigger: "the arguments do not match the command's input schema", reachability: "arguments", outcome: "refused", failureClass: "usage", exitCode: 2, effectClass: "inspect", transactionState: "unchanged", effectEvidence: NOTHING_CHANGED, retryable: false, retry: NOT_RETRYABLE, recovery: { kind: "repair", repairAction: true } });
		expect(self.stations).toContainEqual(expect.objectContaining({ causeCode: "SUCCESS_UNCHANGED", reachability: "arguments" }));
	}, 60_000);

	test("each command publishes a structured input schema that covers its route in order", async () => {
		const tokenRows = [];
		for (const identity of IDENTITIES) {
			const { input } = (await describeCommand(identity)).command;
			const tokens = input.filter((element) => element.token !== undefined).map((element) => element.token);
			const route = COMMANDS[identity]![0];
			tokenRows.push([identity, route.filter((token) => tokens.includes(token)), input.every((element, index) => index === 0 || element.position >= input[index - 1]!.position)]);
		}
		expect(tokenRows).toEqual(IDENTITIES.map((identity) => [identity, COMMANDS[identity]![0], true]));
		const word = (position: number, token: string) => ({ position, kind: "word", token, required: true, repeatable: false });
		const connector = (position: number) => ({ position, kind: "positional", name: "connector", value: { type: "string", source: "connectors.list" }, required: true, repeatable: false });
		const select = (position: number) => ({ position, kind: "option", token: "--select", value: { type: "string", pattern: "^[^=]+=", source: "connectors.config.show" }, required: false, repeatable: true });
		expect((await describeCommand("connectors.list")).command.input).toEqual([word(0, "list")]);
		expect((await describeCommand("connectors.deps.update.apply")).command.input).toEqual([
			word(0, "deps"),
			word(1, "update"),
			{ position: 2, kind: "positional", name: "revision", value: { type: "string", pattern: "^sha256:[0-9a-f]{64}$", source: "connectors.deps.status" }, required: true, repeatable: false },
			{ position: 3, kind: "option", token: "--apply", value: { type: "string", pattern: "^[0-9a-f]{32}$", source: "connectors.deps.update.preview" }, required: true, repeatable: false },
		]);
		expect((await describeCommand("connectors.run.apply")).command.input).toEqual([
			word(0, "run"),
			connector(1),
			select(2),
			{ position: 3, kind: "positional", name: "operation", value: { type: "string", source: "connectors.schema" }, required: true, repeatable: false },
			{ position: 4, kind: "option", token: "--input", value: { type: "json-object" }, required: true, repeatable: false },
			{ position: 4, kind: "option", token: "--apply", value: { type: "string", source: "connectors.run.preview" }, required: true, repeatable: false },
		]);
		expect((await describeCommand("connectors.recover.adjudicate")).command.input).toEqual([
			word(0, "recover"),
			connector(1),
			select(2),
			{ position: 3, kind: "option", token: "--run", value: { type: "string", source: "connectors.recover" }, required: true, repeatable: false },
			{ position: 4, kind: "option", token: "--adjudicate", required: true, repeatable: false },
			{ position: 5, kind: "option", token: "--input", value: { type: "json-object" }, required: true, repeatable: false },
		]);
		expect((await describeCommand("connectors.auth")).command.input).toEqual([
			word(0, "auth"),
			{ position: 1, kind: "positional", name: "verb", value: { type: "string", enum: ["configure", "status", "check", "login", "repair", "logout"] }, required: true, repeatable: false },
			connector(2),
			select(3),
			{ position: 3, kind: "option", token: "--input", value: { type: "json-object" }, required: false, repeatable: false, onlyWhen: "verb=configure" },
			{ position: 3, kind: "option", token: "--no-browser", required: false, repeatable: false, onlyWhen: "verb=login" },
			{ position: 3, kind: "option", token: "--reset", required: false, repeatable: false, onlyWhen: "verb=login" },
		]);
	}, 60_000);

	test("the published required and optional positionals agree with the real parser", async () => {
		// Parser parity through the same packaged process: the schema's
		// required connector is really required, its optional one really
		// optional, and one positional beyond the schema is really malformed.
		const doctor = (await describeCommand("connectors.doctor")).command.input;
		const validate = (await describeCommand("connectors.config.validate")).command.input;
		expect(doctor.filter((element) => element.kind === "positional").map((element) => [element.name, element.required])).toEqual([["connector", true]]);
		expect(validate.filter((element) => element.kind === "positional").map((element) => [element.name, element.required])).toEqual([["connector", false]]);
		const cause = async (argv: string[]) => {
			const run = await runBundle(box!.bundle, argv, { home: box!.home, binDir: box!.hostile, extraEnv: { XDG_STATE_HOME: box!.state }, timeoutMs: 20_000 });
			expect(run.stderr).toBe("");
			return JSON.parse(run.stdout).result.causeCode as string;
		};
		expect(await cause(["doctor"])).toBe("USAGE_MALFORMED_ARGUMENTS");
		expect(await cause(["doctor", "context7"])).not.toBe("USAGE_MALFORMED_ARGUMENTS");
		expect(await cause(["config", "validate"])).not.toBe("USAGE_MALFORMED_ARGUMENTS");
		expect(await cause(["config", "validate", "context7", "extra"])).toBe("USAGE_MALFORMED_ARGUMENTS");
	}, 60_000);

	test("list refuses an argument its input schema does not declare, without echoing it or touching state", async () => {
		// The schema declares list as the bare word; the runtime must agree.
		const refused = await discoverCommand(["list", SENTINEL]);
		expect(refused.code).toBe(2);
		expect(refused.envelope.result).toMatchObject({ commandIdentity: "connectors.list", outcome: "refused", failureClass: "usage", causeCode: "USAGE_MALFORMED_ARGUMENTS", transactionState: "unchanged", data: null });
		expect(refused.envelope.result.effects).toEqual({ completed: [], remaining: [], uncertain: [], inventoryComplete: true });
		expect((await discoverCommand(["list"])).envelope.result.causeCode).toBe("SUCCESS_UNCHANGED");
	});

	test("an unknown identity refuses as unknown, and a malformed shape as malformed, without echoing either", async () => {
		const unknown = await discoverCommand(["--discover-command", `connectors.${SENTINEL.replaceAll(/[^a-z]/g, "")}`, "--json"]);
		expect(unknown.code).toBe(2);
		expect(unknown.envelope.result).toMatchObject({ commandIdentity: "connectors.discovery.command", outcome: "refused", causeCode: "USAGE_UNKNOWN_COMMAND", transactionState: "unchanged", data: null, nextAction: "connectors.discovery" });
		expect(JSON.stringify(unknown.envelope)).not.toContain(SENTINEL.replaceAll(/[^a-z]/g, ""));
		const malformed = [
			["--discover-command", "--json"],
			["--discover-command", "connectors.list"],
			["--discover-command", "connectors.list", "--json", "extra"],
			["--discover-command", SENTINEL, "--json"],
			["--discover-command", "--json", "connectors.list"],
		];
		expect(malformed).toHaveLength(5);
		for (const argv of malformed) {
			const refused = await discoverCommand(argv);
			expect([argv.join(" "), refused.code, refused.envelope.result.causeCode, refused.envelope.result.commandIdentity]).toEqual([argv.join(" "), 2, "USAGE_MALFORMED_ARGUMENTS", "connectors.discovery.command"]);
		}
	});
});
