// Public-process proof of the owned session and read paths through the
// compiled front door of the verified private copy. The MCPorter process leaf
// is the only substitution, so the route plan, environment, cwd, namespace and
// session gating each call observes are shipped source.
import { beforeAll, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cause, consoleCli, document, runningDaemon, SERVER } from "./fixtures/console-cli.ts";

const cli = consoleCli();
const SESSION = "sessionfile", READS = "readsfile01", EARLY = "earlystart1";
// Independent oracle: the accepted canonical route environment.
const ROUTE_KEYS = ["CONNECTORS_INTERNAL_INVOCATION_CONTEXT", "FIGMA_CONSOLE_ACCOUNT", "FIGMA_CONSOLE_FILE", "HOME", "LANG", "LC_ALL", "MCPORTER_DAEMON_DIR", "PATH", "TMPDIR", "XDG_STATE_HOME"];
beforeAll(async () => {
	for (const file of [SESSION, READS, EARLY]) expect((await cli.configure(file)).code).toBe(0);
}, 60000);
const session = (operation: string, ...phase: string[]) => cli.write(SESSION, operation, {}, ...phase);
async function lifecycle(operation: string) {
	const preview = await session(operation, "--preview");
	expect([preview.code, preview.envelope?.result.causeCode]).toEqual([0, "SUCCESS_RUN_RECORDED"]);
	return session(operation, "--apply", preview.envelope?.result.data?.previewId as string);
}

test("one owned session starts and stops through journaled lifecycle in one namespace, environment and cwd; busy or unknown-outcome servers refuse to stop", async () => {
	cli.setMachine({ document: document(SESSION), daemon: null });
	const status = await cli.run(["run", "figma-console", ...cli.select(SESSION), "session_status"]);
	expect([status.code, status.envelope?.result.data?.session]).toEqual([0, null]);
	// No ordinary call may start a daemon outside the journal.
	const stopped = await cli.run(["run", "figma-console", ...cli.select(SESSION), "read_node", "--input", JSON.stringify({ nodeId: "7:285" })]);
	expect([stopped.code, cause(stopped.envelope), cli.state().autostarts, cli.calls().map((call) => call.argv[2])]).toEqual([3, "session-not-started", 0, ["daemon", "daemon"]]);

	const started = await lifecycle("session_start");
	expect([started.code, started.envelope?.result.causeCode, cli.state().starts, cli.state().daemon?.servers.map((server) => server.name)]).toEqual([0, "SUCCESS_RUN_APPLIED", 1, [SERVER]]);
	const again = await session("session_start", "--preview");
	expect([again.code, cause(again.envelope), cli.state().starts]).toEqual([3, "session-already-running", 1]);

	for (const busy of [{ activeCalls: 1 }, { activeCalls: 0, idleBlocked: "unknown-outcome" }]) {
		cli.patch((machine) => { Object.assign(machine.daemon?.servers[0] ?? {}, busy); });
		const refused = await session("session_stop", "--preview");
		expect([refused.code, cause(refused.envelope), cli.state().daemon === null]).toEqual([3, "session-not-drained", false]);
		cli.patch((machine) => { const server = machine.daemon?.servers[0]; if (server) { server.activeCalls = 0; delete server.idleBlocked; } });
	}
	const ended = await lifecycle("session_stop");
	expect([ended.code, ended.envelope?.result.causeCode, cli.state().daemon]).toEqual([0, "SUCCESS_RUN_APPLIED", null]);

	const calls = cli.calls();
	const root = cli.profileRoot(SESSION);
	expect(new Set(calls.map((call) => call.cwd))).toEqual(new Set([root]));
	expect(new Set(calls.map((call) => JSON.stringify(call.env)))).toHaveProperty("size", 1);
	const env = calls[0]?.env ?? {};
	expect(Object.keys(env).sort()).toEqual(ROUTE_KEYS);
	expect(env.MCPORTER_DAEMON_DIR).toMatch(new RegExp(`^/tmp/connectors-fc-${os.userInfo().uid}-[0-9a-f]{12}$`));
	expect([env.PATH, env.TMPDIR, env.XDG_STATE_HOME, env.FIGMA_CONSOLE_ACCOUNT, env.FIGMA_CONSOLE_FILE]).toEqual(["/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin", path.join(root, "tmp"), cli.machine.state, "monash", SESSION]);
	expect(new Set(calls.map((call) => call.argv.slice(0, 2).join(" ")))).toEqual(new Set([`--config ${path.join(realpathSync(cli.machine.plugin), "skills/figma-console/config/mcporter.json")}`]));
}, 60000);

test("a lifecycle outcome lost after the start stays unknown until the owned daemon's state is adjudicated", async () => {
	cli.setMachine({ document: document(SESSION), daemon: null, faults: { failDaemonStart: true } });
	const unknown = await lifecycle("session_start");
	expect([unknown.code, unknown.envelope?.result.causeCode, unknown.envelope?.result.data?.receiptStatus]).toEqual([3, "DOMAIN_RUN_EFFECT_UNKNOWN", "unknown"]);
	cli.patch((machine) => { machine.faults = {}; });
	const blocked = await session("session_stop", "--preview");
	expect([blocked.code, cause(blocked.envelope)]).toEqual([3, "object-blocked"]);
	const settled = await cli.recover(SESSION, "--run", unknown.envelope?.result.data?.runId as string, "--adjudicate", "--input", "{}");
	expect([settled.code, settled.envelope?.result.data?.status, cli.state().starts]).toEqual([0, "applied", 1]);
	expect((await lifecycle("session_stop")).code).toBe(0);
}, 60000);

test("export reads fresh variables first, keeps a token group named warning, and refuses every cached, stale, fallback or warning mark and a file that changed during export", async () => {
	const exportTokens = () => cli.run(["run", "figma-console", ...cli.select(READS), "export_tokens", "--input", JSON.stringify({ format: "dtcg" })]);
	for (const reply of [{ cached: true }, { warnings: ["snapshot fallback"] }, { warning: "used cached variables" }, { source: "rest-cache" }, { data: { variables: [], stale: true } }, { fromCache: "yes" }, { warning: { message: "Using cached variables" } }, { fallback: { used: true } }, { warning: { $value: null, message: "used cache" } }, { warnings: { $note: "stale" } }, { fallback: { color: { primary: { $value: "#000" } } } }]) {
		cli.setMachine({ document: document(READS), daemon: runningDaemon(), replies: { figma_get_variables: reply } });
		const refused = await exportTokens();
		expect([JSON.stringify(reply), refused.code, cause(refused.envelope)]).toEqual([JSON.stringify(reply), 3, "stale-or-warning-result"]);
		expect(cli.calls().some((call) => call.argv[3] === `${SERVER}.figma_export_tokens`)).toBe(false);
	}
	cli.setMachine({ document: document(READS), daemon: runningDaemon(), replies: { figma_get_variables: { cached: false, warnings: [], variables: [] }, figma_export_tokens: { tokens: { space: { $value: 24 }, color: { warning: { $value: "#b42318" } } }, warning: null } } });
	const exported = await exportTokens();
	expect([exported.code, exported.envelope?.result.data?.result, exported.envelope?.result.data?.changedDuringRead]).toEqual([0, { tokens: { space: { $value: 24 }, color: { warning: { $value: "#b42318" } } }, warning: null }, false]);
	const refresh = cli.calls().find((call) => call.argv[3] === `${SERVER}.figma_get_variables`);
	expect(JSON.parse(refresh?.argv[5] ?? "{}")).toMatchObject({ refreshCache: true, includePublished: false });
	const exportCall = cli.calls().find((call) => call.argv[3] === `${SERVER}.figma_export_tokens`);
	const configPath = JSON.parse(exportCall?.argv[5] ?? "{}").configPath as string;
	expect([configPath, readFileSync(configPath, "utf8")]).toEqual([path.join(cli.profileRoot(READS), "tokens.config.json"), `${JSON.stringify({ figmaFile: READS })}\n`]);

	cli.patch((machine) => { machine.faults = { changeOnExport: true }; });
	const changed = await exportTokens();
	expect([changed.code, cause(changed.envelope)]).toEqual([3, "changed-during-export"]);
}, 60000);

test("a start that may still be running cannot be adjudicated unchanged inside MCPorter's start window", async () => {
	cli.setMachine({ document: document(EARLY), daemon: null, faults: { failDaemonStartNoEffect: true } });
	const preview = await cli.write(EARLY, "session_start", {}, "--preview");
	const unknown = await cli.write(EARLY, "session_start", {}, "--apply", preview.envelope?.result.data?.previewId as string);
	expect([unknown.envelope?.result.causeCode, cli.state().daemon]).toEqual(["DOMAIN_RUN_EFFECT_UNKNOWN", null]);
	const early = await cli.recover(EARLY, "--run", unknown.envelope?.result.data?.runId as string, "--adjudicate", "--input", "{}");
	expect([early.code, cause(early.envelope)]).toEqual([3, "adjudication-too-early"]);
}, 60000);
