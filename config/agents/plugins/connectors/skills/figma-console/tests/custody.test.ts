// Process proof of credential custody below MCPorter: the compiled copy's own
// internal Provider role, started as MCPorter starts it (the route env plus
// the registry entry env), with the shared fake op and Keychain reader, a
// loopback identity origin and the fixture Console runtime. Substituted
// process proof only: no 1Password, Keychain, Figma or Desktop bridge.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FAKE_OP_LAUNCHER } from "../../atlassian/tests/fixtures/plugin-copy.ts";
import { cause, consoleCli, EMAIL, ITEM, USER } from "./fixtures/console-cli.ts";

const cli = consoleCli();
const { machine } = cli;
const FILE = "custodyfile", OTHER = "unregistered1";
const SERVICE_TOKEN = "ops_fixtureServiceAccountToken";
const FIGMA_TOKEN = "figd_SENTINEL_fixture_pat_value";
const CONTEXT = "figma-console-adapter-v1";
const SHELL_KEYS = new Set(["PWD", "SHLVL", "_", "OLDPWD"]);
// Independent oracle: the accepted target environment of the pinned server.
const CONSOLE_KEYS = ["ENABLE_MCP_APPS", "FIGMA_ACCESS_TOKEN", "FIGMA_WS_HOST", "FIGMA_WS_PORT", "HOME", "LANG", "LC_ALL", "LOG_LEVEL", "PATH", "TMPDIR"];
let identity: Record<string, unknown> = { id: USER, email: EMAIL };
let identityStatus = 200;
const identityReads: boolean[] = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
	identityReads.push(request.headers.get("x-figma-token") === FIGMA_TOKEN);
	return new URL(request.url).pathname === "/v1/me" ? Response.json(identity, { status: identityStatus }) : new Response(null, { status: 404 });
} });
afterAll(() => { server.stop(true); });
const file = (name: string) => path.join(machine.root, name);
const lines = (name: string) => existsSync(file(name)) ? readFileSync(file(name), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>) : [];
const item = (fields: unknown[]) => writeFileSync(path.join(machine.root, "items", `${ITEM}.json`), JSON.stringify({ id: ITEM, version: 1, fields }));
const CREDENTIAL = { id: "credential", label: "credential", type: "CONCEALED", value: FIGMA_TOKEN };

beforeAll(async () => {
	writeFileSync(file("figma-api-origin"), `http://127.0.0.1:${server.port}\n`);
	const requirements = JSON.parse(readFileSync(path.join(machine.plugin, "requirements.json"), "utf8")) as { pins: { op: string }; sources: { op: { binarySha256: string } } };
	const opDirectory = path.join(machine.state, "connectors/setup/op");
	for (const directory of [path.join(machine.state, "connectors"), path.join(machine.state, "connectors/setup"), opDirectory]) mkdirSync(directory, { recursive: true, mode: 0o700 });
	const name = `op-${requirements.pins.op}-${requirements.sources.op.binarySha256}`;
	writeFileSync(path.join(opDirectory, name), FAKE_OP_LAUNCHER, { mode: 0o700 });
	writeFileSync(path.join(opDirectory, "op-selected"), name, { mode: 0o600 });
	writeFileSync(file("keychain-item.json"), JSON.stringify({ keychain: path.join(machine.home, "Library", "Keychains", "login.keychain-db"), service: "connectors.1password.service-account", account: "connectors" }));
	writeFileSync(file("keychain-token"), SERVICE_TOKEN, { mode: 0o600 });
	writeFileSync(file("expected-service-token"), SERVICE_TOKEN);
	writeFileSync(file("expected-provider-token"), FIGMA_TOKEN);
	writeFileSync(file("expected-figma-token"), FIGMA_TOKEN);
	mkdirSync(file("items"), { mode: 0o700 });
	item([CREDENTIAL]);
	expect((await cli.configure(FILE)).code).toBe(0);
}, 60000);

async function provider(options: { context?: string; args?: string[]; selected?: string } = {}) {
	for (const name of ["op-calls.jsonl", "op-parents.jsonl", "console-starts.jsonl"]) rmSync(file(name), { force: true });
	identityReads.length = 0;
	const child = Bun.spawn([machine.binary, "__internal", "figma-console", "provider", ...(options.args ?? [])], {
		cwd: path.join(machine.plugin, "skills/figma-console/config"), stdin: "ignore", stdout: "pipe", stderr: "pipe",
		env: { HOME: machine.home, PATH: "/usr/bin:/bin", LANG: "en_AU.UTF-8", TMPDIR: path.join(cli.profileRoot(FILE), "tmp"), XDG_STATE_HOME: machine.state, CONNECTORS_INTERNAL_INVOCATION_CONTEXT: options.context ?? CONTEXT, FIGMA_CONSOLE_ACCOUNT: "monash", FIGMA_CONSOLE_FILE: options.selected ?? FILE },
	});
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	for (const stream of [stdout, stderr]) for (const secret of [FIGMA_TOKEN, SERVICE_TOKEN]) expect(stream).not.toContain(secret);
	return { pid: child.pid, code, stdout, stderr, starts: lines("console-starts.jsonl"), ops: lines("op-calls.jsonl"), parents: lines("op-parents.jsonl") };
}
const refusal = (stderr: string) => /^figma-console-provider:error:([a-z-]+):/.exec(stderr)?.[1];

test("the Provider reads exactly the registered concealed credential, qualifies its Figma identity, and replaces itself with the pinned server holding the token only in its own environment", async () => {
	const run = await provider();
	expect([run.code, run.stdout, run.stderr]).toEqual([0, "", ""]);
	expect(run.ops).toEqual([{ argv: ["item", "get", ITEM, "--vault", "API Credentials", "--format", "json"], envKeys: ["HOME", "OP_SERVICE_ACCOUNT_TOKEN", "PATH"], serviceTokenMatches: true }]);
	expect(run.parents.map((parent) => [parent.parentHoldsServiceToken, parent.parentHoldsProviderToken])).toEqual([[false, false]]);
	expect(identityReads).toEqual([true]);
	const [start] = run.starts;
	expect(run.starts).toHaveLength(1);
	expect(start?.pid).toBe(run.pid);
	// Bun reports the entry by its real path.
	expect(start?.argv).toEqual([realpathSync(path.join(machine.runtimeRoot, "figma-console-mcp/dist/local.js"))]);
	expect((start?.envKeys as string[]).filter((key) => !SHELL_KEYS.has(key))).toEqual(CONSOLE_KEYS);
	expect([start?.tokenMatches, start?.home, start?.tmpdir, start?.path]).toEqual([true, path.join(cli.profileRoot(FILE), "home"), path.join(cli.profileRoot(FILE), "tmp"), "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"]);
}, 60000);

test("every custody refusal names its cause before the server starts and never prints a credential", async () => {
	const expectRefused = async (expected: string, options?: Parameters<typeof provider>[0], exit = 3) => {
		const run = await provider(options);
		expect([expected, run.code, refusal(run.stderr), run.starts.length]).toEqual([expected, exit, expected, 0]);
		return run;
	};
	expect((await expectRefused("internal-context-invalid", { context: "another-context" })).ops).toHaveLength(0);
	await expectRefused("arguments-invalid", { args: ["--token", "x"] }, 2);
	expect((await expectRefused("profile-unconfigured", { selected: OTHER })).ops).toHaveLength(0);
	identity = { id: "999", email: EMAIL };
	await expectRefused("pat-identity-mismatch");
	identity = { id: USER, email: "someone.else@example.test" };
	await expectRefused("pat-identity-mismatch");
	identity = { id: USER, email: EMAIL }; identityStatus = 403;
	await expectRefused("pat-identity-unavailable");
	identityStatus = 200;
	for (const fields of [[], [CREDENTIAL, { ...CREDENTIAL, id: "second" }], [{ ...CREDENTIAL, type: "STRING" }], [{ ...CREDENTIAL, value: "not-a-figma-token" }]]) {
		item(fields);
		const run = await expectRefused("credential-invalid");
		expect(identityReads).toEqual([]);
		expect(run.ops).toHaveLength(1);
	}
	item([CREDENTIAL]);
	// Each pinned input moves its own pin: runtime closure, Node, shipped payload.
	const tamper = async (target: string, expected: string) => {
		const original = readFileSync(target);
		appendFileSync(target, "\n// tampered\n");
		try { expect((await expectRefused(expected)).ops).toHaveLength(0); } finally { writeFileSync(target, original); }
	};
	await tamper(path.join(machine.runtimeRoot, "figma-console-mcp/dist/local.js"), "runtime-pin-mismatch");
	await tamper(machine.nodeFile, "node-pin-mismatch");
	await tamper(path.join(machine.plugin, "skills/figma-console/payload/ui.html"), "bridge-pin-mismatch");
	expect((await provider()).code).toBe(0);
}, 60000);

test("registration is immutable: identical bytes record nothing, any change refuses, and a runtime outside the pin never registers", async () => {
	const profile = path.join(cli.profileRoot(FILE), "profile.json");
	const before = readFileSync(profile, "utf8");
	const same = await cli.configure(FILE);
	expect([same.code, same.envelope?.result.data?.unchanged, same.envelope?.result.effects.completed]).toEqual([0, true, []]);
	for (const change of [{ email: "other.user@example.test" }, { userId: "999" }, { itemId: "zzzzzzzzzzzzzzzzzzzzzzzzzz" }]) {
		const refused = await cli.configure(FILE, change);
		expect([refused.code, cause(refused.envelope)]).toEqual([3, "profile-immutable"]);
	}
	expect(readFileSync(profile, "utf8")).toBe(before);
	const outside = path.join(machine.root, "outside-runtime");
	mkdirSync(outside, { mode: 0o700 }); writeFileSync(path.join(outside, "local.js"), "foreign\n", { mode: 0o600 });
	const pinned = await cli.configure(OTHER, { runtimeRoot: outside });
	expect([pinned.code, cause(pinned.envelope), existsSync(path.join(cli.profileRoot(OTHER), "profile.json"))]).toEqual([3, "runtime-pin-mismatch", false]);
	const secret = await cli.configure(OTHER, { token: FIGMA_TOKEN });
	expect([secret.code, cause(secret.envelope)]).toEqual([3, "configuration-input-invalid"]);
	expect(secret.stdout).not.toContain(FIGMA_TOKEN);
}, 60000);
