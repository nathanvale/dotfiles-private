// Ticket #93 under Spec #87 (AC12, AC14, AC19, AC20, AC25): the packaged
// `bin/connectors` reaches Canva through the generic auth and run commands.
// Every process runs inside a macOS sandbox that denies outbound network, so
// no Canva endpoint, OAuth server, or release host can be reached. MCPorter is
// the official 0.14.0 release selected by the binary's own verification from
// local fixture bytes; a hostile `mcporter` sits first on PATH and must stay
// unused. Expected values are test-owned literals.
import { expect, test } from "bun:test";
import { chmodSync, closeSync, constants, cpSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
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
// Independent oracle: MCPorter 0.14.0's vault format, restated by hand.
const SEEDED_VAULT = JSON.stringify({
	version: 2,
	entries: { "canva-connectors|seeded": { serverName: "canva-connectors", serverUrl: "https://mcp.canva.com/mcp", tokens: { access_token: GRANT_SENTINEL, token_type: "Bearer", refresh_token: GRANT_SENTINEL } } },
});

interface Fixture {
	readonly bundle: Bundle;
	readonly state: string;
	readonly home: string;
	readonly hostileBin: string;
	vault(account: string): string;
	run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
	// The binary's stdin is a pseudo-terminal, so /dev/tty exists for an
	// attended login; its stdout and stderr still land in files.
	runAttended(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
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
			const shell = '"$@" >"$ATTENDED_OUT" 2>"$ATTENDED_ERR"; echo $? >"$ATTENDED_OUT.code"';
			const proc = Bun.spawn(["/usr/bin/sandbox-exec", "-p", DENY_NETWORK, "/usr/bin/script", "-q", "/dev/null", "/bin/sh", "-c", shell, "sh", bundle.binary, ...argv], {
				env: { ...env, ATTENDED_OUT: out, ATTENDED_ERR: err }, stdin: "ignore", stdout: "ignore", stderr: "ignore",
			});
			await proc.exited;
			return { code: Number(readFileSync(`${out}.code`, "utf8")), stdout: readFileSync(out, "utf8"), stderr: readFileSync(err, "utf8") };
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

function onlyEnvelope(result: { stdout: string; stderr: string }): { message: string; result: Record<string, any> } {
	expect(result.stderr).toBe("");
	expect(result.stdout.trim().split("\n")).toHaveLength(1);
	return JSON.parse(result.stdout);
}

function filesUnder(root: string): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
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
		const result = await fixture.run(["run", "canva", "--select", "account=a", "get-design", "--input", '{"design_id":"D1"}']);
		expect(result.code).toBe(75);
		// Offline, MCPorter still rewrites the grant-holding file with its index.
		expect(onlyEnvelope(result).result).toMatchObject({ causeCode: "TRANSIENT_PROVIDER_AFTER_BOOTSTRAP", effects: { completed: ["mcporter-bootstrap", "mcporter-vault-file"], uncertain: [] } });
		expect(result.stdout).not.toContain(GRANT_SENTINEL);
		const holders = [...filesUnder(fixture.state), ...filesUnder(fixture.home), ...filesUnder(path.join(fixture.bundle.skillsRoot, "canva"))].filter((file) => readFileSync(file).includes(GRANT_SENTINEL));
		expect(holders).toEqual([grant]);
	} finally {
		fixture.dispose();
	}
}, 60_000);

test("approved client mode refuses login and run with no fallback, no MCPorter selection, and no vault", async () => {
	const fixture = canvaFixture();
	try {
		writeFileSync(path.join(fixture.bundle.skillsRoot, "canva", "config", "client.json"), JSON.stringify({ mode: "approved" }));
		for (const argv of [["auth", "login", "canva", "--select", "account=a"], ["run", "canva", "--select", "account=a", "search-designs"]]) {
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
		[["run", "canva", "--select", "account=a", "export-design"], 2, "USAGE_OPERATION_UNKNOWN", "operation-not-allowed", null],
		[["run", "canva", "--select", `account=${ARGV_SENTINEL}`, "search-designs"], 2, "USAGE_ADAPTER_REFUSED", "account-invalid", null],
		[["run", "canva", "search-designs"], 4, "SCHEMA_SELECTOR_INVALID", null, "Run connectors config show canva --resolved --json --select account=<value> to see its declared selectors"],
		[["run", "canva", "--select", `${ARGV_SENTINEL}=a`, "search-designs"], 4, "SCHEMA_SELECTOR_INVALID", null, "Run connectors config show canva --resolved --json --select account=<value> to see its declared selectors"],
		[["run", "canva", "--select", "account=a", "search-designs", "--input", `[${ARGV_SENTINEL}]`], 2, "USAGE_MALFORMED_ARGUMENTS", null, null],
		[["run", ARGV_SENTINEL.toLowerCase(), "search-designs"], 2, "USAGE_CONNECTOR_UNKNOWN", null, null],
		[["auth", "frobnicate", "canva"], 2, "USAGE_MALFORMED_ARGUMENTS", null, null],
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
		const expected = { a: ["present", "unknown"], b: ["absent", "absent"] } as const;
		for (const [account, [vaultIndex, grant]] of Object.entries(expected)) {
			const result = await fixture.run(["auth", "status", "canva", "--select", `account=${account}`]);
			expect(result.code).toBe(0);
			const envelope = onlyEnvelope(result);
			expect(envelope.result).toMatchObject({ commandIdentity: "connectors.auth", causeCode: "SUCCESS_UNCHANGED", effectClass: "inspect", transactionState: "unchanged" });
			expect(envelope.result.data).toEqual({ connector: "canva", account, custody: "mcporter-native", clientMode: "dcr", clientModeAdmitted: true, vaultIndex, grant, legacySession: "absent" });
			expect(result.stdout).not.toContain(GRANT_SENTINEL);
		}
		expect(existsSync(path.join(fixture.state, "connectors", "mcporter"))).toBe(false);
		expect(existsSync(fixture.vault("b"))).toBe(false);
	} finally {
		fixture.dispose();
	}
}, 30_000);

test("adapter preconditions refuse on their own cause rows before any MCPorter selection", async () => {
	// [setup, argv, exit, cause, connectorCause], restated from the accepted catalogue.
	const cases: ReadonlyArray<readonly [(fixture: Fixture) => void, string[], number, string, string]> = [
		[(fixture) => mkdirSync(path.join(fixture.home, ".mcporter", "canva-connectors"), { recursive: true }), ["run", "canva", "--select", "account=a", "search-designs"], 3, "DOMAIN_ADAPTER_REFUSED", "legacy-cache-present"],
		[(fixture) => writeFileSync(path.join(fixture.bundle.skillsRoot, "canva", "config", "client.json"), JSON.stringify({ mode: "portal" })), ["auth", "status", "canva", "--select", "account=a"], 4, "SCHEMA_ADAPTER_REFUSED", "client-mode-invalid"],
	];
	for (const [setup, argv, exit, cause, connectorCause] of cases) {
		const fixture = canvaFixture();
		try {
			setup(fixture);
			const result = await fixture.run(argv);
			expect({ cause, code: result.code }).toEqual({ cause, code: exit });
			expect(onlyEnvelope(result).result).toMatchObject({ causeCode: cause, transactionState: "unchanged", data: { connector: "canva", connectorCause }, effects: { completed: [], uncertain: [] } });
			expect(existsSync(path.join(fixture.state, "connectors"))).toBe(false);
		} finally {
			fixture.dispose();
		}
	}
}, 30_000);

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
