// Ticket #93 under Spec #87 (AC12, AC14, AC19, AC20, AC22, AC25): the packaged
// `bin/connectors` reaches Canva through the generic auth, run, and schema
// commands.
// Every process runs inside a macOS sandbox that denies outbound network, so
// no Canva endpoint, OAuth server, or release host can be reached. MCPorter is
// the official 0.14.0 release selected by the binary's own verification from
// local fixture bytes; a hostile `mcporter` sits first on PATH and must stay
// unused. Expected values are test-owned literals.
import { expect, test } from "bun:test";
import { chmodSync, closeSync, constants, cpSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { type Bundle, createBundle, createFakeMcporterBinDir, PLUGIN_ROOT } from "./harness.ts";

const official = process.env.CONNECTORS_OFFICIAL_RELEASE_FIXTURE;
if (process.env.CI && !official) throw new Error("CONNECTORS_OFFICIAL_RELEASE_FIXTURE is required for CI process proof");

// Denies outbound network and any Keychain command. macOS refuses a nested
// sandbox with a different profile, so a runner that wraps this suite in its
// own sandbox must use this exact profile.
const DENY_NETWORK = '(version 1)(allow default)(deny network-outbound (remote ip))(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))(deny process-exec (literal "/usr/bin/security"))';
const GRANT_SENTINEL = "SENTINEL_CANVA_GRANT_VALUE";
const ARGV_SENTINEL = "SENTINEL_CANVA_ARGV_VALUE";
const LEGACY_SENTINEL = "SENTINEL_CANVA_LEGACY_REFRESH_TOKEN";
// Ambient caller variables a leaky route would carry into MCPorter's
// environment; every fixture process starts with them set.
const AMBIENT_SECRETS = { CANVA_CLIENT_SECRET: "SENTINEL_CANVA_AMBIENT_CLIENT_SECRET", CANVA_ACCESS_TOKEN: "SENTINEL_CANVA_AMBIENT_ACCESS_TOKEN" };
// Independent oracle: MCPorter's camelCase and snake_case client identity,
// metadata-document, token-cache, bearer, and command spellings, plus an
// unknown key; each would change identity or move the grant behind the switch.
const REGISTRY_OVERRIDES: ReadonlyArray<Record<string, unknown>> = [
	{ oauthClientMetadataUrl: "https://example.test/client.json" },
	{ oauthClientId: "portal-client" },
	{ tokenCacheDir: "~/shared" },
	{ oauth_client_id: "portal-client" },
	{ oauth_client_metadata_url: "https://example.test/client.json" },
	{ token_cache_dir: "~/shared" },
	{ bearerToken: "fixture" },
	{ bearer_token_env: "CANVA_TOKEN" },
	{ oauthCommand: { args: ["login"] } },
	{ futureOption: true },
];
// Independent oracle: MCPorter 0.14.0's vault format, restated by hand.
const SEEDED_VAULT = JSON.stringify({
	version: 2,
	entries: { "canva-connectors|seeded": { serverName: "canva-connectors", serverUrl: "https://mcp.canva.com/mcp", tokens: { access_token: GRANT_SENTINEL, token_type: "Bearer", refresh_token: GRANT_SENTINEL } } },
});
// Independent oracle: the same grant under the exact key MCPorter 0.14.0
// derives for this registry entry, name|sha256({name,url,command})[:16], with
// the updatedAt its vault requires, so its own --reset can find and clear it.
const KEYED_VAULT = JSON.stringify({
	version: 2,
	entries: { "canva-connectors|9d1be6da9c0f5a76": { serverName: "canva-connectors", serverUrl: "https://mcp.canva.com/mcp", updatedAt: "2026-09-25T00:00:00.000Z", tokens: { access_token: GRANT_SENTINEL, token_type: "Bearer", refresh_token: GRANT_SENTINEL } } },
});

interface Fixture {
	readonly bundle: Bundle;
	readonly state: string;
	readonly home: string;
	readonly hostileBin: string;
	vault(account: string): string;
	run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
	// The binary's stdin is a pseudo-terminal, so /dev/tty exists for an
	// attended login; its stdout and stderr still land in files, and terminal
	// is everything written to the pseudo-terminal itself.
	runAttended(argv: string[]): Promise<{ code: number; stdout: string; stderr: string; terminal: string }>;
	dispose(): void;
}

function canvaFixture(): Fixture {
	const bundle = createBundle();
	const hostile = createFakeMcporterBinDir();
	cpSync(path.join(PLUGIN_ROOT, "skills", "canva", "config"), path.join(bundle.skillsRoot, "canva", "config"), { recursive: true });
	const state = path.join(bundle.root, "state");
	const home = path.join(bundle.root, "home");
	mkdirSync(state);
	mkdirSync(home);
	const env = {
		HOME: home,
		PATH: `${hostile.binDir}:/usr/bin:/bin`,
		TMPDIR: bundle.root,
		XDG_STATE_HOME: state,
		...AMBIENT_SECRETS,
		CONNECTORS_TEST_RELEASE_DIR: official ?? path.join(bundle.root, "no-release-fixture"),
	};
	return {
		bundle, state, home, hostileBin: hostile.binDir,
		vault: (account) => path.join(state, "connectors", "canva-mcporter", account),
		async run(argv) {
			const proc = Bun.spawn(["/usr/bin/sandbox-exec", "-p", DENY_NETWORK, bundle.binary, ...argv], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
			return { code, stdout, stderr };
		},
		async runAttended(argv) {
			const out = path.join(bundle.root, "attended.out");
			const err = path.join(bundle.root, "attended.err");
			const tty = path.join(bundle.root, "attended.tty");
			const shell = '"$@" >"$ATTENDED_OUT" 2>"$ATTENDED_ERR"; echo $? >"$ATTENDED_OUT.code"';
			const proc = Bun.spawn(["/usr/bin/sandbox-exec", "-p", DENY_NETWORK, "/usr/bin/script", "-q", tty, "/bin/sh", "-c", shell, "sh", bundle.binary, ...argv], {
				env: { ...env, ATTENDED_OUT: out, ATTENDED_ERR: err }, stdin: "ignore", stdout: "ignore", stderr: "ignore",
			});
			await proc.exited;
			return { code: Number(readFileSync(`${out}.code`, "utf8")), stdout: readFileSync(out, "utf8"), stderr: readFileSync(err, "utf8"), terminal: readFileSync(tty, "utf8") };
		},
		dispose() {
			hostile.dispose();
			bundle.dispose();
		},
	};
}

function ownedVault(root: string): string {
	for (const directory of [root, path.join(root, "data"), path.join(root, "cache"), path.join(root, "data", "mcporter")]) mkdirSync(directory, { recursive: true, mode: 0o700 });
	return path.join(root, "data", "mcporter", "credentials.json");
}

function seedLegacySession(state: string, account: string): string {
	const file = path.join(state, "connectors", "canva", account, "session.json");
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	writeFileSync(file, JSON.stringify({ refresh_token: LEGACY_SENTINEL }), { mode: 0o600 });
	return file;
}

function overrideRegistry(fixture: Fixture, override: Record<string, unknown>): void {
	const file = path.join(fixture.bundle.skillsRoot, "canva", "config", "mcporter.json");
	const registry = JSON.parse(readFileSync(file, "utf8"));
	registry.mcpServers["canva-connectors"] = { ...registry.mcpServers["canva-connectors"], ...override };
	writeFileSync(file, JSON.stringify(registry));
}

function onlyEnvelope(result: { stdout: string; stderr: string }): { message: string; result: Record<string, any> } {
	expect(result.stderr).toBe("");
	expect(result.stdout.trim().split("\n")).toHaveLength(1);
	return JSON.parse(result.stdout);
}

function filesUnder(root: string): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
}

// Pid to args for every process, without environments.
function processArgs(): Map<string, string> {
	const table = new Map<string, string>();
	for (const line of execFileSync("/bin/ps", ["-axww", "-o", "pid=,args="], { encoding: "utf8" }).split("\n")) {
		const row = /^\s*(\d+) (.*)$/.exec(line);
		if (row?.[1] !== undefined && row[2] !== undefined) table.set(row[1], row[2]);
	}
	return table;
}

// One process's args followed by its environment. ps reads only that pid, so
// no other process's environment is ever collected. A pid that has already
// exited yields an empty string, never ps's error text.
function processArgsWithEnv(pid: string): string {
	try {
		return execFileSync("/bin/ps", ["-Eww", "-o", "args=", "-p", pid], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

// The held MCPorter's environment carries the account's own vault roots and
// the route's no-keepalive pin, and no ambient Canva secret by name or value.
// The roots are the positive control: an empty or unparsed capture fails them.
// Failures show only fixture paths, literal names, and booleans.
function expectAccountEnv(fixture: Fixture, account: string, env: readonly string[]): void {
	const pinned = env.filter((entry) => ["XDG_DATA_HOME=", "XDG_CACHE_HOME=", "MCPORTER_NO_KEEPALIVE="].some((name) => entry.startsWith(name))).sort();
	expect({ account, pinned }).toEqual({ account, pinned: ["MCPORTER_NO_KEEPALIVE=*", `XDG_CACHE_HOME=${fixture.vault(account)}/cache`, `XDG_DATA_HOME=${fixture.vault(account)}/data`] });
	for (const [name, secret] of Object.entries(AMBIENT_SECRETS)) {
		expect({ account, name, leaked: env.some((entry) => entry.startsWith(`${name}=`) || entry.includes(secret)) }).toEqual({ account, name, leaked: false });
	}
}

// Holds MCPorter on a FIFO vault file and reads its argv and environment from
// the process table while it waits, then releases it onto a regular grant-free
// vault so any later read finds a file. Returns the argv from `verb` on and the
// environment entries, or null when MCPorter never opened the vault. Paths and
// environment values under the fixture hold no spaces.
async function heldMcporter(fifo: string, state: string, verb: string, done: Promise<unknown>): Promise<{ argv: string[]; env: string[] } | null> {
	let settled = false;
	void done.finally(() => { settled = true; });
	while (!settled) {
		let fd: number;
		try {
			fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
		} catch {
			await Bun.sleep(5);
			continue;
		}
		const held = [...processArgs()].find(([, args]) => args.startsWith(`${state}/`) && args.includes(` ${verb} `));
		const withEnv = held ? processArgsWithEnv(held[0]) : "";
		const empty = JSON.stringify({ version: 2, entries: {} });
		writeFileSync(`${fifo}.next`, empty, { mode: 0o600 });
		renameSync(`${fifo}.next`, fifo);
		writeSync(fd, empty);
		closeSync(fd);
		if (!held) return null;
		const args = held[1].trim();
		const argv = args.split(" ");
		return { argv: argv.slice(argv.indexOf(verb)), env: withEnv.slice(args.length).trim().split(" ") };
	}
	return null;
}

// A non-blocking open for writing succeeds only while a reader holds the FIFO,
// so success means MCPorter itself opened that exact vault file.
async function watchFifo(fifo: string, done: Promise<unknown>): Promise<boolean> {
	let settled = false;
	void done.finally(() => { settled = true; });
	while (!settled) {
		try {
			const fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
			writeSync(fd, JSON.stringify({ version: 2, entries: {} }));
			closeSync(fd);
			return true;
		} catch {
			await Bun.sleep(5);
		}
	}
	return false;
}

test.skipIf(!official)("run opens only the selected account's vault through the verified MCPorter", async () => {
	const fixture = canvaFixture();
	try {
		const fifoA = ownedVault(fixture.vault("a"));
		const fifoB = ownedVault(fixture.vault("b"));
		for (const fifo of [fifoA, fifoB]) execFileSync("/usr/bin/mkfifo", [fifo]);
		const running = fixture.run(["run", "canva", "--select", "account=b", "search-designs", "--input", '{"query":"poster"}']);
		const [openedA, openedB] = await Promise.all([watchFifo(fifoA, running), watchFifo(fifoB, running)]);
		const result = await running;
		expect({ openedA, openedB }).toEqual({ openedA: false, openedB: true });
		expect(lstatSync(fifoA).isFIFO()).toBe(true);
		expect(result.code).toBe(75);
		const envelope = onlyEnvelope(result);
		expect(envelope.message).toBe("connectors: canva provider call did not complete");
		// MCPorter replaced b's vault file with its own index after reading it.
		expect(envelope.result).toMatchObject({
			commandIdentity: "connectors.run", outcome: "refused", failureClass: "transient", exitCode: 75,
			causeCode: "TRANSIENT_PROVIDER_AFTER_BOOTSTRAP", effectClass: "repository-local", transactionState: "completed",
			effects: { completed: ["mcporter-bootstrap", "mcporter-vault-file"], remaining: [], uncertain: [], inventoryComplete: true },
		});
		expect(existsSync(path.join(fixture.home, ".mcporter"))).toBe(false);
		expect(existsSync(path.join(fixture.bundle.root, "mcporter.json"))).toBe(false);
	} finally {
		fixture.dispose();
	}
}, 60_000);

test.skipIf(!official)("schema reads only the selected account's vault through the verified MCPorter, and stays a read on a terminal", async () => {
	const fixture = canvaFixture();
	const offline = "Retry the schema request; if it keeps failing, run connectors auth status canva --select account=<value>";
	try {
		const fifoA = ownedVault(fixture.vault("a"));
		const fifoB = ownedVault(fixture.vault("b"));
		for (const fifo of [fifoA, fifoB]) execFileSync("/usr/bin/mkfifo", [fifo]);
		const running = fixture.run(["schema", "canva", "--select", "account=b"]);
		const [openedA, openedB] = await Promise.all([watchFifo(fifoA, running), watchFifo(fifoB, running)]);
		const selected = await running;
		expect({ openedA, openedB }).toEqual({ openedA: false, openedB: true });
		expect(selected.code).toBe(75);
		const envelope = onlyEnvelope(selected);
		expect(envelope.message).toBe("connectors: canva provider call did not complete");
		expect(envelope.result).toMatchObject({
			commandIdentity: "connectors.schema", outcome: "refused", failureClass: "transient", causeCode: "TRANSIENT_PROVIDER_AFTER_BOOTSTRAP", data: null, repairAction: offline,
			effects: { completed: ["mcporter-bootstrap", "mcporter-vault-file"], remaining: [], uncertain: [], inventoryComplete: true },
		});
		// With a terminal present, a first schema for a new account still only
		// reads: it creates the private vault and never reaches browser consent.
		const fresh = await fixture.runAttended(["schema", "canva", "--select", "account=fresh"]);
		expect({ code: fresh.code, stderr: fresh.stderr, lines: fresh.stdout.trim().split("\n").length }).toEqual({ code: 75, stderr: "", lines: 1 });
		expect(JSON.parse(fresh.stdout).result).toMatchObject({
			commandIdentity: "connectors.schema", causeCode: "TRANSIENT_PROVIDER_AFTER_ACCOUNT_EFFECT", effectClass: "repository-local", transactionState: "completed", repairAction: offline,
			effects: { completed: ["account-vault", "mcporter-vault-file"], remaining: [], uncertain: [], inventoryComplete: true },
		});
		const root = fixture.vault("fresh");
		for (const directory of [root, path.join(root, "data"), path.join(root, "cache")]) expect({ directory, mode: lstatSync(directory).mode & 0o777 }).toEqual({ directory, mode: 0o700 });
		expect(existsSync(path.join(fixture.home, ".mcporter"))).toBe(false);
		expect(existsSync(path.join(fixture.bundle.root, "mcporter.json"))).toBe(false);
	} finally {
		fixture.dispose();
	}
}, 60_000);

test.skipIf(!official)("run and schema hand the verified MCPorter a no-consent read with the account's vault roots and no ambient secret", async () => {
	const fixture = canvaFixture();
	// [account, command argv, MCPorter argv from its verb on], restated from
	// ADR 0004: every Canva read carries --no-oauth, so it never starts consent.
	const reads: ReadonlyArray<readonly [string, string[], readonly [string, ...string[]]]> = [
		["reader", ["run", "canva", "--select", "account=reader", "search-designs", "--input", '{"query":"poster"}'], ["call", "canva-connectors.search-designs", "--args", '{"query":"poster"}', "--output", "json", "--no-oauth"]],
		["schemer", ["schema", "canva", "--select", "account=schemer"], ["list", "canva-connectors", "--schema", "--json", "--no-oauth"]],
	];
	try {
		for (const [account, argv, expected] of reads) {
			const fifo = ownedVault(fixture.vault(account));
			execFileSync("/usr/bin/mkfifo", [fifo]);
			const running = fixture.run(argv);
			const held = await heldMcporter(fifo, fixture.state, expected[0], running);
			const result = await running;
			expect({ account, argv: held?.argv }).toEqual({ account, argv: [...expected] });
			expectAccountEnv(fixture, account, held?.env ?? []);
			for (const secret of Object.values(AMBIENT_SECRETS)) expect(result.stdout).not.toContain(secret);
			onlyEnvelope(result);
		}
	} finally {
		fixture.dispose();
	}
}, 60_000);

test.skipIf(!official)("a run reports the vault directories it creates or narrows, and status reads a grant-free index as unknown", async () => {
	const fixture = canvaFixture();
	try {
		const search = (account: string) => fixture.run(["run", "canva", "--select", `account=${account}`, "search-designs"]);
		// [account, cause, completed effects], in invocation order.
		const runs: ReadonlyArray<readonly [string, string, readonly string[]]> = [
			["fresh", "TRANSIENT_PROVIDER_AFTER_BOOTSTRAP", ["mcporter-bootstrap", "account-vault", "mcporter-vault-file"]],
			["fresh", "TRANSIENT_PROVIDER_UNREACHABLE", []],
			["other", "TRANSIENT_PROVIDER_AFTER_ACCOUNT_EFFECT", ["account-vault", "mcporter-vault-file"]],
			["widened", "TRANSIENT_PROVIDER_AFTER_ACCOUNT_EFFECT", ["account-vault", "mcporter-vault-file"]],
		];
		for (const [account, cause, completed] of runs) {
			// An existing root wider than 0700 whose data and cache are already
			// private: commit only narrows the root, and that alone is the effect.
			if (account === "widened") {
				const root = fixture.vault(account);
				for (const directory of [root, path.join(root, "data"), path.join(root, "cache")]) mkdirSync(directory, { recursive: true, mode: 0o700 });
				chmodSync(root, 0o755);
			}
			const result = await search(account);
			expect({ account, code: result.code }).toEqual({ account, code: 75 });
			const envelope = onlyEnvelope(result);
			expect({ account, cause: envelope.result.causeCode, effects: envelope.result.effects }).toEqual({ account, cause, effects: { completed, remaining: [], uncertain: [], inventoryComplete: true } });
			// A runnable next step that names the selector, never its value.
			expect(envelope.result).toMatchObject({ retryable: true, transactionState: completed.length === 0 ? "unchanged" : "completed", repairAction: "Retry the run; if it keeps failing, run connectors auth status canva --select account=<value>" });
		}
		for (const root of [fixture.vault("fresh"), fixture.vault("widened")]) {
			for (const directory of [root, path.join(root, "data"), path.join(root, "cache")]) expect({ directory, mode: lstatSync(directory).mode & 0o777 }).toEqual({ directory, mode: 0o700 });
		}
		const root = fixture.vault("fresh");
		expect(lstatSync(path.join(root, "data", "mcporter", "credentials.json")).isFile()).toBe(true);
		const status = await fixture.run(["auth", "status", "canva", "--select", "account=fresh"]);
		expect(status.code).toBe(0);
		expect(onlyEnvelope(status).result.data).toEqual({ connector: "canva", account: "fresh", custody: "mcporter-native", clientMode: "dcr", clientModeAdmitted: true, vaultIndex: "present", grant: "unknown", legacySession: "absent" });
	} finally {
		fixture.dispose();
	}
}, 90_000);

test.skipIf(!official)("a run for the grant-holding account keeps the grant inside its vault", async () => {
	const fixture = canvaFixture();
	try {
		const grant = ownedVault(fixture.vault("a"));
		writeFileSync(grant, SEEDED_VAULT, { mode: 0o600 });
		const legacy = seedLegacySession(fixture.state, "a");
		const result = await fixture.run(["run", "canva", "--select", "account=a", "get-design", "--input", '{"design_id":"D1"}']);
		expect(result.code).toBe(75);
		// Offline, MCPorter still rewrites the grant-holding file with its index.
		expect(onlyEnvelope(result).result).toMatchObject({ causeCode: "TRANSIENT_PROVIDER_AFTER_BOOTSTRAP", effects: { completed: ["mcporter-bootstrap", "mcporter-vault-file"], uncertain: [] } });
		expect(result.stdout).not.toContain(GRANT_SENTINEL);
		const holders = [...filesUnder(fixture.state), ...filesUnder(fixture.home), ...filesUnder(path.join(fixture.bundle.skillsRoot, "canva"))].filter((file) => readFileSync(file).includes(GRANT_SENTINEL));
		expect(holders).toEqual([grant]);
		// The former Canva Session stays where it was, unchanged and never echoed.
		expect(result.stdout).not.toContain(LEGACY_SENTINEL);
		expect(readFileSync(legacy, "utf8")).toBe(JSON.stringify({ refresh_token: LEGACY_SENTINEL }));
	} finally {
		fixture.dispose();
	}
}, 60_000);

test("approved client mode refuses login, run, and schema with no fallback, no MCPorter selection, and no vault", async () => {
	const fixture = canvaFixture();
	try {
		writeFileSync(path.join(fixture.bundle.skillsRoot, "canva", "config", "client.json"), JSON.stringify({ mode: "approved" }));
		for (const argv of [["auth", "login", "canva", "--select", "account=a"], ["run", "canva", "--select", "account=a", "search-designs"], ["schema", "canva", "--select", "account=a"]]) {
			const result = await fixture.run(argv);
			expect(result.code).toBe(3);
			const envelope = onlyEnvelope(result);
			expect(envelope.message).toBe("connectors: canva refused the request (client-mode-not-admitted)");
			expect(envelope.result).toMatchObject({
				outcome: "refused", failureClass: "domain", causeCode: "DOMAIN_CLIENT_MODE_NOT_ADMITTED", effectClass: "inspect", transactionState: "unchanged",
				data: { connector: "canva", connectorCause: "client-mode-not-admitted" },
				repairAction: "Set mode to dcr in skills/canva/config/client.json; the approved client is not yet built",
			});
		}
		// Inspect still reports which mode the switch selects, and that it is not admitted.
		const status = await fixture.run(["auth", "status", "canva", "--select", "account=a"]);
		expect(status.code).toBe(0);
		expect(onlyEnvelope(status).result.data).toMatchObject({ connector: "canva", account: "a", clientMode: "approved", clientModeAdmitted: false });
		expect(existsSync(path.join(fixture.state, "connectors"))).toBe(false);
	} finally {
		fixture.dispose();
	}
}, 30_000);

test("unsupported verbs, unattended login, and bad input refuse before any dependency or state", async () => {
	const fixture = canvaFixture();
	// [argv, exit, cause, connectorCause or null when unpinned, pinned repairAction or null when unpinned],
	// restated from the accepted catalogue. A pinned repairAction is runnable once the caller substitutes
	// their own selector value, and echoes none.
	const cases: ReadonlyArray<readonly [string[], number, string, string | null, string | null]> = [
		[["auth", "logout", "canva", "--select", "account=a"], 3, "DOMAIN_AUTH_VERB_UNSUPPORTED", "auth-verb-unsupported", null],
		[["auth", "check", "canva", "--select", "account=a"], 3, "DOMAIN_AUTH_VERB_UNSUPPORTED", "auth-verb-unsupported", null],
		[["auth", "login", "canva", "--select", "account=a"], 3, "DOMAIN_ATTENDED_REQUIRED", null, "Run connectors auth login canva --select account=<value> yourself in a terminal; an agent cannot complete browser consent"],
		// The closed login options: accepted only after login, repeated in its repair, and refused on every other verb or when unknown.
		[["auth", "login", "canva", "--reset", "--select", "account=a", "--no-browser"], 3, "DOMAIN_ATTENDED_REQUIRED", null, "Run connectors auth login canva --select account=<value> --no-browser --reset yourself in a terminal; an agent cannot complete browser consent"],
		[["auth", "status", "canva", "--select", "account=a", "--reset"], 2, "USAGE_MALFORMED_ARGUMENTS", null, null],
		[["auth", "status", "canva", "--select", "account=a", "--no-browser"], 2, "USAGE_MALFORMED_ARGUMENTS", null, null],
		[["auth", "login", "canva", "--select", "account=a", "--json"], 2, "USAGE_MALFORMED_ARGUMENTS", null, null],
		[["auth", "login", "canva", "--select", "account=a", "--no-browser", "--json"], 2, "USAGE_MALFORMED_ARGUMENTS", null, null],
		[["auth", "login", "canva", "--select", "account=a", `--${ARGV_SENTINEL}`], 2, "USAGE_MALFORMED_ARGUMENTS", null, null],
		[["run", "canva", "--select", "account=a", "search-designs", "--reset"], 2, "USAGE_MALFORMED_ARGUMENTS", null, null],
		[["schema", "canva", "--select", "account=a", "--no-browser"], 2, "USAGE_MALFORMED_ARGUMENTS", null, null],
		[["run", "canva", "--select", "account=a", "export-design"], 2, "USAGE_OPERATION_UNKNOWN", "operation-not-allowed", null],
		[["run", "canva", "--select", `account=${ARGV_SENTINEL}`, "search-designs"], 2, "USAGE_ADAPTER_REFUSED", "account-invalid", null],
		[["run", "canva", "search-designs"], 4, "SCHEMA_SELECTOR_INVALID", null, "Run connectors config show canva --resolved --json --select account=<value> to see its declared selectors"],
		[["run", "canva", "--select", `${ARGV_SENTINEL}=a`, "search-designs"], 4, "SCHEMA_SELECTOR_INVALID", null, "Run connectors config show canva --resolved --json --select account=<value> to see its declared selectors"],
		[["run", "canva", "--select", "account=a", "search-designs", "--input", `[${ARGV_SENTINEL}]`], 2, "USAGE_MALFORMED_ARGUMENTS", null, null],
		[["run", ARGV_SENTINEL.toLowerCase(), "search-designs"], 2, "USAGE_CONNECTOR_UNKNOWN", null, null],
		[["auth", "frobnicate", "canva"], 2, "USAGE_MALFORMED_ARGUMENTS", null, null],
		[["schema", "canva"], 4, "SCHEMA_SELECTOR_INVALID", null, "Run connectors config show canva --resolved --json --select account=<value> to see its declared selectors"],
		[["schema", "canva", "--select", `account=${ARGV_SENTINEL}`], 2, "USAGE_ADAPTER_REFUSED", "account-invalid", null],
		[["schema", "canva", "--select", "account=a", ARGV_SENTINEL], 2, "USAGE_MALFORMED_ARGUMENTS", null, null],
	];
	try {
		for (const [argv, exit, cause, connectorCause, repairAction] of cases) {
			const result = await fixture.run(argv);
			expect({ argv, code: result.code }).toEqual({ argv, code: exit });
			const envelope = onlyEnvelope(result);
			expect(envelope.result.causeCode).toBe(cause);
			if (connectorCause !== null) expect(envelope.result.data.connectorCause).toBe(connectorCause);
			if (repairAction !== null) expect(envelope.result.repairAction).toBe(repairAction);
			expect(result.stdout).not.toContain(ARGV_SENTINEL);
			expect(result.stdout).not.toContain(ARGV_SENTINEL.toLowerCase());
		}
		expect(existsSync(path.join(fixture.state, "connectors"))).toBe(false);
		expect(existsSync(path.join(fixture.bundle.root, "mcporter.json"))).toBe(false);
	} finally {
		fixture.dispose();
	}
}, 60_000);

test("auth status reports the vault index per account, never a grant it has not read", async () => {
	const fixture = canvaFixture();
	try {
		writeFileSync(ownedVault(fixture.vault("a")), SEEDED_VAULT, { mode: 0o600 });
		const legacy = seedLegacySession(fixture.state, "a");
		const expected = { a: ["present", "unknown", "preserved"], b: ["absent", "absent", "absent"] } as const;
		for (const [account, [vaultIndex, grant, legacySession]] of Object.entries(expected)) {
			const result = await fixture.run(["auth", "status", "canva", "--select", `account=${account}`]);
			expect(result.code).toBe(0);
			const envelope = onlyEnvelope(result);
			expect(envelope.result).toMatchObject({ commandIdentity: "connectors.auth", causeCode: "SUCCESS_UNCHANGED", effectClass: "inspect", transactionState: "unchanged" });
			expect(envelope.result.data).toEqual({ connector: "canva", account, custody: "mcporter-native", clientMode: "dcr", clientModeAdmitted: true, vaultIndex, grant, legacySession });
			expect(result.stdout).not.toContain(GRANT_SENTINEL);
			expect(result.stdout).not.toContain(LEGACY_SENTINEL);
		}
		expect(readFileSync(legacy, "utf8")).toBe(JSON.stringify({ refresh_token: LEGACY_SENTINEL }));
		expect(existsSync(path.join(fixture.state, "connectors", "mcporter"))).toBe(false);
		expect(existsSync(fixture.vault("b"))).toBe(false);
	} finally {
		fixture.dispose();
	}
}, 30_000);

test("adapter preconditions refuse on their own cause rows before any MCPorter selection", async () => {
	// [label, setup, argv, exit, cause, connectorCause], restated from the accepted catalogue.
	// A registry row's label names the override key it plants.
	type Row = readonly [string, (fixture: Fixture) => void, string[], number, string, string];
	const cases: ReadonlyArray<Row> = [
		["legacy home cache on run", (fixture) => mkdirSync(path.join(fixture.home, ".mcporter", "canva-connectors"), { recursive: true }), ["run", "canva", "--select", "account=a", "search-designs"], 3, "DOMAIN_ADAPTER_REFUSED", "legacy-cache-present"],
		["legacy home cache on schema", (fixture) => mkdirSync(path.join(fixture.home, ".mcporter", "canva-connectors"), { recursive: true }), ["schema", "canva", "--select", "account=a"], 3, "DOMAIN_ADAPTER_REFUSED", "legacy-cache-present"],
		["unknown client mode", (fixture) => writeFileSync(path.join(fixture.bundle.skillsRoot, "canva", "config", "client.json"), JSON.stringify({ mode: "portal" })), ["auth", "status", "canva", "--select", "account=a"], 4, "SCHEMA_ADAPTER_REFUSED", "client-mode-invalid"],
		...REGISTRY_OVERRIDES.map((override): Row => [`registry override ${Object.keys(override).join(",")}`, (fixture) => overrideRegistry(fixture, override), ["run", "canva", "--select", "account=a", "search-designs"], 4, "SCHEMA_ADAPTER_REFUSED", "registry-identity-invalid"]),
	];
	expect(cases).toHaveLength(13);
	for (const [label, setup, argv, exit, cause, connectorCause] of cases) {
		const fixture = canvaFixture();
		try {
			setup(fixture);
			const result = await fixture.run(argv);
			expect({ label, connectorCause, code: result.code }).toEqual({ label, connectorCause, code: exit });
			expect(onlyEnvelope(result).result).toMatchObject({ causeCode: cause, transactionState: "unchanged", data: { connector: "canva", connectorCause }, effects: { completed: [], uncertain: [] } });
			expect(existsSync(path.join(fixture.state, "connectors"))).toBe(false);
		} finally {
			fixture.dispose();
		}
	}
}, 60_000);

test.skipIf(!official)("after MCPorter selection, a symlinked vault root refuses and an offline attended login reports an uncertain grant", async () => {
	const fixture = canvaFixture();
	try {
		const elsewhere = path.join(fixture.bundle.root, "elsewhere");
		mkdirSync(elsewhere, { mode: 0o700 });
		mkdirSync(path.dirname(fixture.vault("linked")), { recursive: true, mode: 0o700 });
		symlinkSync(elsewhere, fixture.vault("linked"));
		const refused = await fixture.run(["run", "canva", "--select", "account=linked", "search-designs"]);
		expect(refused.code).toBe(3);
		expect(onlyEnvelope(refused).result).toMatchObject({
			causeCode: "DOMAIN_ADAPTER_REFUSED_AFTER_SELECTION", transactionState: "completed", data: { connector: "canva", connectorCause: "vault-root-invalid" },
			effects: { completed: ["mcporter-bootstrap"], remaining: [], uncertain: [], inventoryComplete: true },
		});
		expect(readdirSync(elsewhere)).toEqual([]);
		expect(filesUnder(fixture.vault("fresh"))).toEqual([]);
		const login = await fixture.runAttended(["auth", "login", "canva", "--select", "account=fresh"]);
		expect(login.code).toBe(3);
		expect(login.stderr).toBe("");
		const envelope = JSON.parse(login.stdout);
		expect(login.stdout.trim().split("\n")).toHaveLength(1);
		expect(envelope.result).toMatchObject({
			commandIdentity: "connectors.auth", outcome: "failed", exitCode: 3, causeCode: "DOMAIN_AUTH_LOGIN_UNKNOWN", effectClass: "external", transactionState: "unknown",
			// MCPorter writes its vault index even when consent never completes.
			effects: { completed: ["account-vault", "mcporter-vault-file"], remaining: [], uncertain: ["account-grant"], inventoryComplete: true },
			repairAction: "Run connectors auth status canva --select account=<value> to inspect the account vault before retrying login",
		});
		expect(filesUnder(fixture.vault("fresh"))).toEqual([path.join(fixture.vault("fresh"), "data", "mcporter", "credentials.json")]);
	} finally {
		fixture.dispose();
	}
}, 90_000);

test.skipIf(!official)("attended login hands --no-browser and --reset to the verified MCPorter's auth, and --reset clears only the selected account's grant", async () => {
	const fixture = canvaFixture();
	const login = async (account: string, flags: readonly string[]) => {
		const result = await fixture.runAttended(["auth", "login", "canva", ...flags.slice(0, 1), "--select", `account=${account}`, ...flags.slice(1)]);
		expect({ account, code: result.code, stderr: result.stderr, lines: result.stdout.trim().split("\n").length }).toEqual({ account, code: 3, stderr: "", lines: 1 });
		expect(JSON.parse(result.stdout).result).toMatchObject({
			commandIdentity: "connectors.auth", outcome: "failed", causeCode: "DOMAIN_AUTH_LOGIN_UNKNOWN", transactionState: "unknown",
			data: { connector: "canva", verb: "login", account, clientMode: "dcr" },
			effects: { remaining: [], uncertain: ["account-grant"], inventoryComplete: true },
		});
		for (const output of [result.stdout, result.terminal]) {
			for (const secret of [GRANT_SENTINEL, ...Object.values(AMBIENT_SECRETS)]) expect(output).not.toContain(secret);
		}
	};
	try {
		// [account, caller flags, MCPorter argv from "auth" on]. The flags arrive
		// on either side of --select and leave in one fixed order.
		const handed: ReadonlyArray<readonly [string, readonly string[], readonly string[]]> = [
			["bare", [], ["auth", "canva-connectors"]],
			["flagged", ["--reset", "--no-browser"], ["auth", "canva-connectors", "--no-browser", "--reset"]],
		];
		for (const [account, flags, expected] of handed) {
			const fifo = ownedVault(fixture.vault(account));
			execFileSync("/usr/bin/mkfifo", [fifo]);
			const running = login(account, flags);
			const held = await heldMcporter(fifo, fixture.state, "auth", running);
			await running;
			expect({ account, argv: held?.argv ?? null }).toEqual({ account, argv: [...expected] });
			// Login spawns MCPorter from its own site, so its environment is proved apart from the reads.
			expectAccountEnv(fixture, account, held?.env ?? []);
		}
		// A plain login leaves the seeded grant in place, so only --reset clears
		// it, and only in the selected account's vault.
		const [plain, reset, other] = [ownedVault(fixture.vault("plain")), ownedVault(fixture.vault("reset")), ownedVault(fixture.vault("other"))];
		for (const file of [plain, reset, other]) writeFileSync(file, KEYED_VAULT, { mode: 0o600 });
		await login("plain", []);
		await login("reset", ["--reset"]);
		const holders = [...filesUnder(fixture.state), ...filesUnder(fixture.home)].filter((file) => readFileSync(file).includes(GRANT_SENTINEL));
		expect(holders.sort()).toEqual([plain, other].sort());
		expect(lstatSync(reset).isFile()).toBe(true);
		expect(existsSync(path.join(fixture.home, ".mcporter"))).toBe(false);
	} finally {
		fixture.dispose();
	}
}, 90_000);
