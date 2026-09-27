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
	"connectors.fixtureAuth": [["fixture-auth"], "inspect"],
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

interface Station {
	causeCode: string;
	outcome: string;
	failureClass: string | null;
	exitCode: number;
	effectClass: string;
	transactionState: string;
	retryable: boolean;
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
	return envelope.result.data as { command: { commandIdentity: string; route: string[]; effectClass: string; usage: string }; stations: Station[]; exitMeanings: Record<string, string>; scope: string };
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
		expect(list.stations).toEqual([{ causeCode: "SUCCESS_UNCHANGED", outcome: "success", failureClass: null, exitCode: 0, effectClass: "inspect", transactionState: "unchanged", retryable: false }]);
		expect(list.exitMeanings).toEqual({ "0": "success" });
		expect(causes((await describeCommand("connectors.dispatch")).stations).sort()).toEqual(["INTERNAL_UNEXPECTED_AFTER_BOOTSTRAP", "INTERNAL_UNEXPECTED_UNCHANGED", "USAGE_UNKNOWN_COMMAND"]);
		const self = await describeCommand("connectors.discovery.command");
		expect(causes(self.stations).sort()).toEqual(["SUCCESS_UNCHANGED", "USAGE_MALFORMED_ARGUMENTS", "USAGE_UNKNOWN_COMMAND"]);
		expect(self.command.usage).toBe("--discover-command <identity> --json");
	});

	test("an explicit update apply declares its success, refusal, and recovery stations and no other command's", async () => {
		const data = await describeCommand("connectors.deps.update.apply");
		expect(data.command.usage).toBe("deps update <revision> --apply <previewId>");
		expect(data.stations).toContainEqual({ causeCode: "SUCCESS_DEPS_UPDATED", outcome: "success", failureClass: null, exitCode: 0, effectClass: "external", transactionState: "completed", retryable: false });
		expect(data.stations).toContainEqual({ causeCode: "DOMAIN_DEPS_PREVIEW_STALE", outcome: "refused", failureClass: "domain", exitCode: 3, effectClass: "inspect", transactionState: "unchanged", retryable: false });
		expect(data.stations).toContainEqual({ causeCode: "DOMAIN_DEPS_UPDATE_EFFECT_UNKNOWN", outcome: "failed", failureClass: "domain", exitCode: 3, effectClass: "external", transactionState: "unknown", retryable: false });
		expect(data.stations).toContainEqual({ causeCode: "INTERNAL_DEPS_UPDATE_PARTIAL", outcome: "failed", failureClass: "internal", exitCode: 1, effectClass: "external", transactionState: "partially-completed", retryable: false });
		for (const foreign of ["SUCCESS_DEPS_REPAIRED", "SUCCESS_DEPS_UPDATE_PREVIEWED", "SUCCESS_RUN_APPLIED", "USAGE_UNKNOWN_COMMAND"]) expect(causes(data.stations)).not.toContain(foreign);
		expect(data.exitMeanings).toEqual({ "0": "success", "1": "internal", "2": "usage", "3": "domain" });
	});

	test("run apply, auth, and schema keep their own write, attended, and transient stations", async () => {
		const apply = await describeCommand("connectors.run.apply");
		expect(apply.stations).toContainEqual({ causeCode: "SUCCESS_RUN_APPLIED", outcome: "success", failureClass: null, exitCode: 0, effectClass: "external", transactionState: "completed", retryable: false });
		expect(apply.stations).toContainEqual({ causeCode: "DOMAIN_RUN_EFFECT_UNKNOWN", outcome: "failed", failureClass: "domain", exitCode: 3, effectClass: "external", transactionState: "unknown", retryable: false });
		expect(causes(apply.stations)).not.toContain("SUCCESS_AUTH_LOGIN");
		const auth = await describeCommand("connectors.auth");
		expect(causes(auth.stations)).toEqual(expect.arrayContaining(["DOMAIN_ATTENDED_REQUIRED", "SUCCESS_AUTH_LOGIN", "DOMAIN_AUTH_LOGIN_UNKNOWN"]));
		expect(causes(auth.stations)).not.toContain("DOMAIN_PROVIDER_CALL_FAILED");
		const schema = await describeCommand("connectors.schema");
		expect(schema.stations).toContainEqual({ causeCode: "TRANSIENT_PROVIDER_UNREACHABLE", outcome: "refused", failureClass: "transient", exitCode: 75, effectClass: "inspect", transactionState: "unchanged", retryable: true });
		expect(causes(schema.stations)).not.toContain("SUCCESS_RUN_APPLIED");
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
