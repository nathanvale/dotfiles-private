// Proof of the canva-auth CLI: public-process rows with fixture sessions under
// XDG_STATE_HOME, in-process login rendering against the fake authorization
// server, command-scoped discovery against a test-owned station table, and
// the strict cli-design-check matrix. Expected values are literals; the
// production contract is enumerated for coverage only.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OP_TOKEN_SENTINEL } from "../../../tests/harness.ts";
import { authorizationNotice, type CliDeps, renderOutput, run } from "../scripts/canva-auth.ts";
import { parseOAuthConfig } from "../scripts/session/index.ts";

import { type FakeAuthorizationServer, startAuthorizationServer } from "./fixtures/authorization-server.ts";

const SKILL = path.resolve(import.meta.dir, "..");
const CLI = path.join(SKILL, "scripts", "canva-auth.ts");
const CHECKER = path.resolve(SKILL, "..", "..", "..", "my-second-brain-playground", "bin", "cli-design-check");
const ACCESS_TOKEN = "fixture-canva-access-token";
const REFRESH_TOKEN = "fixture-canva-refresh-token";
const NOW = 1_700_000_000_000;

let root: string;
let fake: FakeAuthorizationServer;
beforeEach(() => {
	root = mkdtempSync(path.join(os.tmpdir(), "canva-auth-"));
	fake = startAuthorizationServer();
});
// The "stuck" fixture is a session file with the macOS immutable flag, the
// one way an owned file refuses removal without privileges. It is cleared
// before the root is removed.
const immutable = (file: string, on: boolean) => Bun.spawnSync(["chflags", on ? "uchg" : "nouchg", file]);
afterEach(() => {
	fake.stop();
	const stuck = path.join(root, "connectors", "canva", "stuck", "session.json");
	if (existsSync(stuck)) immutable(stuck, false);
	rmSync(root, { recursive: true, force: true });
});

const accountDirectory = (account: string) => path.join(root, "connectors", "canva", account);

function writeSessionFixture(account: string, overrides: Record<string, unknown> = {}): void {
	mkdirSync(accountDirectory(account), { recursive: true, mode: 0o700 });
	const record = {
		version: 1,
		account,
		client: { mode: "dcr", clientId: "fixture-client-1", redirectUri: "http://127.0.0.1:1/callback" },
		issuer: fake.issuer,
		resource: fake.resource,
		tokenEndpoint: `${fake.url}/token`,
		revocationEndpoint: `${fake.url}/revoke`,
		scope: "design:meta:read",
		accessToken: ACCESS_TOKEN,
		accessTokenExpiresAt: NOW + 3_600_000,
		refreshToken: REFRESH_TOKEN,
		obtainedAt: NOW,
		...overrides,
	};
	writeFileSync(path.join(accountDirectory(account), "session.json"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

// The fixture tree the checker and the process rows share: personal (valid),
// tampered (invalid record), busy (held lock), stuck (unremovable directory).
function writeFixtures(): void {
	writeSessionFixture("personal");
	writeSessionFixture("tampered");
	writeFileSync(path.join(accountDirectory("tampered"), "session.json"), "{}", { mode: 0o600 });
	writeSessionFixture("busy");
	writeFileSync(path.join(accountDirectory("busy"), "refresh.lock"), "{}", { mode: 0o600 });
	writeSessionFixture("stuck", { revocationEndpoint: null });
	immutable(path.join(accountDirectory("stuck"), "session.json"), true);
}

async function runCli(argv: string[]) {
	const proc = Bun.spawn([CLI, ...argv], {
		cwd: root,
		env: { HOME: path.join(root, "home"), PATH: process.env.PATH ?? "", TMPDIR: root, XDG_STATE_HOME: root, OP_SERVICE_ACCOUNT_TOKEN: OP_TOKEN_SENTINEL },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, OP_TOKEN_SENTINEL]) {
		expect(stdout).not.toContain(secret);
		expect(stderr).not.toContain(secret);
	}
	return { code, stdout, stderr, envelope: () => JSON.parse(stdout) as { message: string; availablePaths: string[]; result: Record<string, unknown> } };
}

const EXPECTED_PATHS = ["canva-auth.command-discovery", "canva-auth.discovery", "canva-auth.dispatch", "canva-auth.help", "canva-auth.login", "canva-auth.logout", "canva-auth.status"];

describe("canva-auth public process", () => {
	test("status reports the nonsecret session as a validated envelope and as prose", async () => {
		writeFixtures();
		const machine = await runCli(["status", "--account", "personal", "--json"]);
		expect([machine.code, machine.stderr]).toEqual([0, ""]);
		const { result, availablePaths } = machine.envelope();
		expect(availablePaths).toEqual(EXPECTED_PATHS);
		expect(result).toMatchObject({ commandIdentity: "canva-auth.status", outcome: "success", causeCode: "SUCCESS_UNCHANGED", effectClass: "inspect", transactionState: "unchanged", failureClass: null, exitCode: 0, retryable: false, repairAction: null, nextAction: "canva-auth status --account <slug>", effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true } });
		expect(result.data).toEqual({ account: "personal", clientMode: "dcr", clientId: "fixture-client-1", issuer: fake.issuer, resource: fake.resource, scope: "design:meta:read", obtainedAt: NOW, expiresAt: NOW + 3_600_000, refreshable: true });
		expect(Object.keys(result).sort()).toEqual(["causeCode", "commandIdentity", "data", "effectClass", "effects", "exitCode", "failureClass", "nextAction", "outcome", "repairAction", "retryable", "runId", "transactionState"]);
		const human = await runCli(["status", "--account", "personal"]);
		expect([human.code, human.stderr, human.stdout]).toEqual([0, "", `account personal: client dcr fixture-client-1, issuer ${fake.issuer}, expires 2023-11-14T23:13:20.000Z, refreshable\n`]);
	});

	test("missing, tampered, busy, and unremovable sessions map to the contract's domain, schema, transient, and internal rows", async () => {
		writeFixtures();
		const missing = await runCli(["status", "--account", "nobody", "--json"]);
		expect([missing.code, missing.envelope().result.causeCode, missing.envelope().result.repairAction]).toEqual([3, "DOMAIN_PRECONDITION_UNMET", "No session exists for this account; run canva-auth login --account <slug>"]);
		const tampered = await runCli(["status", "--account", "tampered", "--json"]);
		expect([tampered.code, tampered.envelope().result.causeCode, tampered.envelope().result.failureClass]).toEqual([4, "SCHEMA_INVALID_INPUT", "schema"]);
		const busy = await runCli(["logout", "--account", "busy", "--json"]);
		expect([busy.code, busy.envelope().result.causeCode, busy.envelope().result.retryable, busy.envelope().result.repairAction]).toEqual([75, "TRANSIENT_NOT_STARTED", true, "Stop all canva-auth and Canva Provider processes for this account, remove only refresh.lock from its private state directory, then run status before retrying"]);
		expect(existsSync(path.join(accountDirectory("busy"), "session.json"))).toBe(true);
		const stuck = await runCli(["logout", "--account", "stuck", "--json"]);
		const result = stuck.envelope().result;
		expect([stuck.code, result.causeCode, result.transactionState, result.effects, result.handoff]).toEqual([1, "INTERNAL_RESULT_UNCHANGED", "unchanged", { completed: [], remaining: ["canva-session:stuck"], uncertain: [], inventoryComplete: true }, { owner: "operator", reason: "The local session could not be removed.", inspect: ["canva-auth status --account <slug>"] }]);
		expect("nextAction" in result).toBe(false);
		const humanBusy = await runCli(["logout", "--account", "busy"]);
		expect([humanBusy.code, humanBusy.stdout, humanBusy.stderr]).toEqual([75, "", "canva-auth: TRANSIENT_NOT_STARTED: Stop all canva-auth and Canva Provider processes for this account, remove only refresh.lock from its private state directory, then run status before retrying\n"]);
	});

	test("logout revokes through the session's revocation endpoint and removes the directory; a second logout is unchanged", async () => {
		writeFixtures();
		const first = await runCli(["logout", "--account", "personal", "--json"]);
		expect([first.code, first.envelope().result.causeCode, first.envelope().result.effects]).toEqual([0, "SUCCESS_COMPLETED", { completed: ["canva-grant:personal", "canva-session:personal"], remaining: [], uncertain: [], inventoryComplete: true }]);
		expect(first.envelope().result.data).toEqual({ account: "personal", removed: true, revoked: "confirmed" });
		expect(fake.calls.revocations).toEqual([REFRESH_TOKEN]);
		// The session state is gone; the owned directory outlives it.
		expect([existsSync(path.join(accountDirectory("personal"), "session.json")), existsSync(path.join(accountDirectory("personal"), "refresh.lock")), existsSync(accountDirectory("personal"))]).toEqual([false, false, true]);
		const second = await runCli(["logout", "--account", "personal", "--json"]);
		expect([second.code, second.envelope().result.causeCode, second.envelope().result.transactionState]).toEqual([0, "SUCCESS_UNCHANGED", "unchanged"]);
		const human = await runCli(["logout", "--account", "tampered"]);
		expect([human.code, human.stdout]).toEqual([0, "logout succeeded for account tampered\n"]);
	});

	test("usage refusals are one stderr line in human mode and a USAGE_ envelope in machine mode, with no state touched", async () => {
		for (const argv of [[], ["--definitely-unknown-option"], ["status"], ["status", "--account", "Bad Slug"], ["status", "--account"], ["login", "extra"], ["status", "--account", "a", "--account", "b"]]) {
			const human = await runCli(argv);
			expect([argv.join(" "), human.code, human.stdout, human.stderr.split("\n").length]).toEqual([argv.join(" "), 2, "", 2]);
			expect(human.stderr.startsWith("canva-auth: USAGE_INVALID_INVOCATION: ")).toBe(true);
			const machine = await runCli([...argv, "--json"]);
			expect([argv.join(" "), machine.code, machine.stderr, machine.envelope().result.causeCode, machine.envelope().result.failureClass]).toEqual([argv.join(" "), 2, "", "USAGE_INVALID_INVOCATION", "usage"]);
		}
		expect(existsSync(path.join(root, "connectors"))).toBe(false);
	});

	test("help and discovery answer in both modes; command discovery publishes the literal stations for logout", async () => {
		const help = await runCli(["--help"]);
		expect([help.code, help.stderr, /usage/i.test(help.stdout)]).toEqual([0, "", true]);
		const discover = await runCli(["--discover", "--json"]);
		expect(discover.envelope().result.data).toEqual({
			contractVersion: "2.0.0",
			generationConventionVersion: "2.0.0",
			profile: "complex",
			commands: [
				{ commandIdentity: "canva-auth.help", route: ["--help"], summary: "Show help and usage", effectClass: "inspect" },
				{ commandIdentity: "canva-auth.discovery", route: ["--discover"], summary: "Describe commands and the contract", effectClass: "inspect" },
				{ commandIdentity: "canva-auth.command-discovery", route: ["--discover-command"], summary: "Describe the possible outcomes of one selected command", effectClass: "inspect" },
				{ commandIdentity: "canva-auth.dispatch", route: [], summary: "Refuse a missing or invalid invocation", effectClass: "inspect" },
				{ commandIdentity: "canva-auth.login", route: ["login"], summary: "Run the attended Canva login for one account and store its session", effectClass: "external" },
				{ commandIdentity: "canva-auth.status", route: ["status"], summary: "Report the nonsecret session status for one account", effectClass: "inspect" },
				{ commandIdentity: "canva-auth.logout", route: ["logout"], summary: "Revoke the account's grant when the server allows it and remove the local session", effectClass: "external" },
			],
			exitMeanings: { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "transient" },
			signalExits: { "130": "SIGINT", "143": "SIGTERM" },
			effectExclusions: ["the system browser's own state and the Canva-side grant record are outside this CLI's effect inventory"],
		});
		const humanDiscover = await runCli(["--discover"]);
		expect([humanDiscover.code, humanDiscover.stdout.startsWith("profile: complex\n")]).toEqual([0, true]);
		const stations = await runCli(["--discover-command", "canva-auth.logout", "--json"]);
		const data = stations.envelope().result.data as { command: unknown; semantics: string; stations: Record<string, unknown>[] };
		expect(data.semantics).toBe("possible-outcomes");
		expect(data.stations.map((station) => [station.causeCode, station.outcome, station.transactionState, station.exitCode, station.retryable])).toEqual([
			["SUCCESS_COMPLETED", "success", "completed", 0, false],
			["SUCCESS_UNCHANGED", "success", "unchanged", 0, false],
			["USAGE_INVALID_INVOCATION", "refused", "unchanged", 2, false],
			["DOMAIN_PRECONDITION_UNMET", "refused", "unchanged", 3, false],
			["TRANSIENT_NOT_STARTED", "refused", "unchanged", 75, true],
			["DOMAIN_RECOVERY_HANDOFF_REQUIRED", "failed", "unknown", 3, false],
			["INTERNAL_RESULT_UNCHANGED", "failed", "unchanged", 1, false],
			["INTERNAL_RESULT_PARTIAL", "failed", "partially-completed", 1, false],
			["INTERNAL_RESULT_UNKNOWN", "failed", "unknown", 1, false],
		]);
		const unknown = await runCli(["--discover-command", "canva-auth.nope", "--json"]);
		expect([unknown.code, unknown.envelope().result.causeCode]).toEqual([2, "USAGE_UNKNOWN_COMMAND"]);
	});
});

describe("canva-auth login rendering", () => {
	const deps = (overrides: Record<string, unknown> = {}): CliDeps => {
		const config = parseOAuthConfig({ resource: fake.resource, client: { mode: "dcr", clientName: "Connectors plugin" }, loopbackPort: 0, callbackTimeoutMs: 300, refreshLockWaitMs: 100, ...overrides });
		if (!config) throw new Error("test config invalid");
		const clock = { now: () => NOW, sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };
		return {
			stateRoot: root,
			clock,
			fetch,
			session: { fetch, openBrowser: async (url) => void (await fetch(url)), clock, random: (bytes) => crypto.getRandomValues(new Uint8Array(bytes)), stateRoot: root, env: {}, config },
		};
	};

	const SECRETS = ["fixture-access-token", "fixture-refresh-token", "fixture-code"];

	test("logout preserves a stored registered session when its scoped client secret is unavailable", async () => {
		writeSessionFixture("registered", { client: { mode: "registered", clientId: "portal-client", redirectUri: "http://127.0.0.1:47391/callback" } });
		const registered = deps({ client: { mode: "registered", clientId: "portal-client" }, loopbackPort: 47_391 });
		const output = renderOutput((await run(["logout", "--account", "registered"], registered)).rendering, true);
		const result = (JSON.parse(output.stdout) as { result: Record<string, unknown> }).result;
		expect([output.exitCode, output.stderr, result.causeCode, result.transactionState, result.repairAction]).toEqual([3, "", "DOMAIN_PRECONDITION_UNMET", "unchanged", "Restore CANVA_CLIENT_SECRET and the matching registered client in oauth.json, then retry; the stored session was preserved"]);
		expect([fake.calls.revocations, existsSync(path.join(accountDirectory("registered"), "session.json"))]).toEqual([[], true]);
	});

	test("a completed login is SUCCESS_COMPLETED with the grant and session effects and no token in the envelope", async () => {
		const { rendering, urls } = await run(["login", "--account", "personal"], deps());
		const output = renderOutput(rendering, true);
		const envelope = JSON.parse(output.stdout) as { result: Record<string, unknown> };
		expect([output.exitCode, output.stderr, envelope.result.causeCode, envelope.result.effectClass, envelope.result.effects]).toEqual([0, "", "SUCCESS_COMPLETED", "external", { completed: ["canva-grant:personal", "canva-session:personal"], remaining: [], uncertain: [], inventoryComplete: true }]);
		expect(envelope.result.data).toMatchObject({ account: "personal", clientMode: "dcr", authorizationUrlPrinted: false });
		expect(urls).toEqual([]);
		for (const secret of SECRETS) expect(output.stdout).not.toContain(secret);
		expect(renderOutput(rendering, false).stdout).toBe("login succeeded for account personal\n");
	});

	// With --no-browser the URL must reach the human before the callback wait,
	// so the notice is the only way the fixture browser can ever complete the
	// login: it is opened from the notification, never from the result.
	test("--no-browser notifies the URL before the wait and the login completes from that notice; no code or token is in the notice", async () => {
		let opened = 0;
		const withCounter = deps();
		if (!withCounter.session) throw new Error("session deps missing");
		withCounter.session.openBrowser = async () => {
			opened += 1;
		};
		let settled = false;
		const notices: string[] = [];
		const noticed = new Promise<string>((resolve) => {
			const notify = (url: string) => {
				notices.push(url);
				resolve(url);
			};
			void run(["login", "--account", "personal", "--no-browser"], withCounter, notify).then((result) => {
				settled = true;
				(withCounter as { result?: unknown }).result = result;
			});
		});
		const url = await noticed;
		expect(settled).toBe(false);
		await fetch(url);
		while (!settled) await new Promise((resolve) => setTimeout(resolve, 5));
		const { rendering, urls } = (withCounter as { result?: { rendering: Parameters<typeof renderOutput>[0]; urls: string[] } }).result as { rendering: Parameters<typeof renderOutput>[0]; urls: string[] };
		expect([opened, notices.length, urls, rendering.cause]).toEqual([0, 1, [url], "SUCCESS_COMPLETED"]);
		expect(JSON.parse(renderOutput(rendering, true).stdout).result.data.authorizationUrlPrinted).toBe(true);
		for (const secret of SECRETS) expect(url).not.toContain(secret);
		expect(authorizationNotice(url)).toEqual({ stream: "stdout", text: `Open this URL in your browser to continue, then return here:\n${url}\n` });
	});

	test("--no-browser with no callback is the deadline row; the notice still fired before the wait", async () => {
		const noBrowser = deps();
		if (!noBrowser.session) throw new Error("session deps missing");
		noBrowser.session.openBrowser = async () => {
			throw new Error("the browser must not open");
		};
		const notices: string[] = [];
		const { rendering, urls } = await run(["login", "--account", "personal", "--no-browser"], noBrowser, (url) => notices.push(url));
		expect([notices.length, urls.length, rendering.cause]).toEqual([1, 1, "DOMAIN_DEADLINE_UNCHANGED"]);
		const human = renderOutput(rendering, false);
		expect([human.exitCode, human.stdout, human.stderr]).toEqual([3, "", "canva-auth: DOMAIN_DEADLINE_UNCHANGED: No callback arrived within the login window; run login again and complete the browser step\n"]);
		expect(renderOutput(rendering, true).stderr).toBe("");
	});

	test("--no-browser with --json refuses before login so ordinary machine completion keeps stderr empty", async () => {
		const notices: string[] = [];
		const { rendering, urls } = await run(["login", "--account", "personal", "--no-browser", "--json"], deps(), (url) => notices.push(url));
		const output = renderOutput(rendering, true);
		const result = (JSON.parse(output.stdout) as { result: Record<string, unknown> }).result;
		expect([output.exitCode, output.stderr, result.causeCode, urls, notices, fake.calls.registrations]).toEqual([2, "", "USAGE_INVALID_INVOCATION", [], [], 0]);
	});

	test("denied consent, a mismatched state, a failed exchange, and a held session lock each map to their stations", async () => {
		fake.options.consent = "deny";
		const denied = renderOutput((await run(["login", "--account", "personal"], deps())).rendering, true);
		const deniedEnvelope = JSON.parse(denied.stdout) as { result: Record<string, unknown> };
		expect([denied.exitCode, deniedEnvelope.result.causeCode, deniedEnvelope.result.handoff]).toEqual([3, "DOMAIN_AUTHORITY_REQUIRED", { owner: "human", reason: "Canva did not grant access for this login.", inspect: ["canva-auth status --account <slug>"] }]);
		fake.options.tamperState = true;
		const mismatched = await run(["login", "--account", "personal"], deps());
		expect([mismatched.rendering.cause, mismatched.rendering.message]).toEqual(["DOMAIN_AUTHORITY_REQUIRED", "login refused: login-mismatch"]);
		fake.options.tamperState = false;
		fake.options.consent = "grant";
		const failing = deps();
		if (!failing.session) throw new Error("session deps missing");
		failing.session.fetch = (input, init) => (String(input).endsWith("/token") ? Promise.resolve(new Response('{"error":"server_error"}', { status: 500 })) : fetch(input, init));
		const exchange = await run(["login", "--account", "personal"], failing);
		const output = renderOutput(exchange.rendering, true);
		const envelope = JSON.parse(output.stdout) as { result: Record<string, unknown> };
		expect([output.exitCode, envelope.result.causeCode, envelope.result.transactionState, envelope.result.effects]).toEqual([3, "DOMAIN_RECOVERY_HANDOFF_REQUIRED", "unknown", { completed: [], remaining: [], uncertain: ["canva-grant:personal"], inventoryComplete: true }]);
		mkdirSync(accountDirectory("personal"), { recursive: true, mode: 0o700 });
		writeFileSync(path.join(accountDirectory("personal"), "refresh.lock"), '{"owner":"someone-else"}', { mode: 0o600 });
		const busy = await run(["login", "--account", "personal"], deps());
		expect([busy.rendering.cause, busy.rendering.message, busy.rendering.repairAction]).toEqual(["TRANSIENT_NOT_STARTED", "login refused: session-busy", "Stop all canva-auth and Canva Provider processes for this account, remove only refresh.lock from its private state directory, then run status before retrying"]);
		expect(existsSync(path.join(accountDirectory("personal"), "session.json"))).toBe(false);
	});

	test("an unwritable account directory refuses before discovery as INTERNAL_PREPARATION", async () => {
		mkdirSync(path.join(root, "connectors", "canva"), { recursive: true, mode: 0o700 });
		writeFileSync(path.join(root, "connectors", "canva", "personal"), "not a directory");
		const { rendering, urls } = await run(["login", "--account", "personal"], deps());
		expect([rendering.cause, urls.length, fake.calls.registrations]).toEqual(["INTERNAL_PREPARATION", 0, 0]);
		expect(renderOutput(rendering, true).exitCode).toBe(1);
	});
});

describe("cli-design-check matrix", () => {
	test("every required row and the secret-redaction row pass against the fixture tree", async () => {
		writeFixtures();
		// The checker hashes its --cwd tree for mutation; the state root lives
		// beside it, under XDG_STATE_HOME, where the logout rows may write.
		const cwd = path.join(root, "checker-cwd");
		mkdirSync(cwd, { mode: 0o700 });
		const argv = [
			CHECKER,
			"--cwd", cwd,
			"--command", `bun ${CLI}`,
			"--success-args", "status --account personal",
			"--missing-args", "status --account nobody",
			"--internal-args", "logout --account stuck",
			"--schema-args", "status --account tampered",
			"--transient-args", "logout --account busy",
			"--secret-args", "status --account personal",
			"--secret-marker", REFRESH_TOKEN,
			"--timeout-ms", "20000",
			"--json",
		];
		const proc = Bun.spawn(argv, { cwd, env: { HOME: path.join(root, "home"), PATH: process.env.PATH ?? "", TMPDIR: root, XDG_STATE_HOME: root, NO_COLOR: "1", TERM: "dumb" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		const report = (JSON.parse(stdout) as { result: { data: { rows: { scenario: string; passed: boolean; findings: string[]; observedExit: number }[]; failedCount: number; skippedRows: string[] } } }).result.data;
		expect(report.rows.filter((row) => !row.passed).map((row) => [row.scenario, row.observedExit, row.findings])).toEqual([]);
		expect([code, stderr, report.failedCount, report.skippedRows]).toEqual([0, "", 0, ["malformed-value-json", "large-envelope", "unauthorized-effect"]]);
		expect(report.rows.map((row) => row.scenario)).toEqual(["help-human", "help-json", "discover-human", "discover-json", "no-arguments-human", "no-arguments-json", "unknown-option-human", "unknown-option-json", "success-human", "success-json", "missing-input-json", "secret-redaction", "internal-failure-json", "schema-refusal-json", "transient-refusal-json", "target-unchanged"]);
	}, 120_000);
});
