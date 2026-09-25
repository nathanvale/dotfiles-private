// T1 (Ticket #88 under Spec #87) shipped the discovery-only skeleton; T2
// (Ticket #89 under Spec #87) added the generic manifest-driven command
// core. The compiled front door boots standalone, with an empty HOME and no
// ambient Bun/Node/mise/op on PATH, and answers a trivial discovery command
// with a Contract Core 2.0 envelope. Expected values below are independent
// literals, never re-derived by importing bin/connectors.ts's own
// envelope-building code.
import { describe, expect, test } from "bun:test";
import { accessSync, constants, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertEnvelope, buildInternalFailureEnvelope } from "../bin/connectors.ts";
import { startLoopbackMcpStub } from "./fixtures/loopback-mcp-stub.ts";
import { createBundle, createFakeMcporterBinDir, createFixtureAuthorityBinDir, FRONT_DOOR, PLUGIN_ROOT, runFrontDoor } from "./harness.ts";

const CONTRACT_VERSION = "2.0.0";
// Contract Core 2.0 requires availablePaths sorted and unique; this literal
// is alphabetical, independent of bin/connectors.ts's own COMMANDS order.
const AVAILABLE_PATHS = [
	"connectors.auth",
	"connectors.config.show",
	"connectors.config.validate",
	"connectors.deps.repair.mcporter",
	"connectors.discovery",
	"connectors.dispatch",
	"connectors.doctor",
	"connectors.fixtureAuth",
	"connectors.help",
	"connectors.list",
	"connectors.run",
	"connectors.schema",
	"connectors.setup",
	"connectors.status",
];
const EXIT_MEANINGS = { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "transient" };
const SIGNAL_EXITS = { "130": "SIGINT", "143": "SIGTERM" };

describe("compiled front door: discovery", () => {
	test("boots standalone and answers --discover --json with a Contract Core envelope", async () => {
		const result = await runFrontDoor(["--discover", "--json"]);
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		const envelope = JSON.parse(result.stdout);
		expect(envelope.envelopeVersion).toBe(2);
		expect(envelope.contractVersion).toBe(CONTRACT_VERSION);
		expect(envelope.availablePaths).toEqual(AVAILABLE_PATHS);
		expect(envelope.result.commandIdentity).toBe("connectors.discovery");
		expect(envelope.result.outcome).toBe("success");
		expect(envelope.result.failureClass).toBeNull();
		expect(envelope.result.exitCode).toBe(0);
		expect(envelope.result.effectClass).toBe("inspect");
		expect(envelope.result.transactionState).toBe("unchanged");
		expect(envelope.result.causeCode).toBe("SUCCESS_UNCHANGED");
		expect(envelope.result.data.commands.map((c: { commandIdentity: string }) => c.commandIdentity).slice().sort()).toEqual(AVAILABLE_PATHS);
		expect(envelope.result.data.exitMeanings).toEqual(EXIT_MEANINGS);
		expect(envelope.result.data.signalExits).toEqual(SIGNAL_EXITS);
		// Independent literal of the accepted exclusions: setup and MCPorter
		// repair are advertised above, so no exclusion may deny them.
		expect(envelope.result.data.effectExclusions).toEqual([
			"any credential value read by this binary or T5 custody access; fixture-auth only presents a nonsecret reference to a fixture-tested authority, and an OAuth grant stays inside MCPorter's per-account vault",
			"any dependency install on ordinary non-setup runs other than first-use MCPorter bootstrap",
			"any provider write operation",
			"auth or run for a connector whose packaged adapter has no prepare step, and auth logout for every connector; deps covers only explicit MCPorter repair",
		]);
	});

	test("availablePaths is sorted and has no duplicates", async () => {
		const result = await runFrontDoor(["--discover", "--json"]);
		const envelope = JSON.parse(result.stdout);
		const paths: string[] = envelope.availablePaths;
		expect(paths).toEqual([...paths].sort());
		expect(new Set(paths).size).toBe(paths.length);
	});

	test("bare --discover without --json refuses instead of silently answering", async () => {
		const result = await runFrontDoor(["--discover"]);
		expect(result.code).toBe(2);
		const envelope = JSON.parse(result.stdout);
		expect(envelope.result.outcome).toBe("refused");
	});

	test("--help without --json prints human-readable text naming commands and an example, not JSON", async () => {
		const result = await runFrontDoor(["--help"]);
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(() => JSON.parse(result.stdout)).toThrow();
		expect(result.stdout).toContain("--discover --json");
		expect(result.stdout).toContain("--help");
		expect(result.stdout).toContain("Commands:");
		expect(result.stdout).toContain("Examples:");
	});

	test("--help --json answers with its own Contract Core envelope", async () => {
		const result = await runFrontDoor(["--help", "--json"]);
		expect(result.code).toBe(0);
		const envelope = JSON.parse(result.stdout);
		expect(envelope.result.commandIdentity).toBe("connectors.help");
		expect(envelope.result.outcome).toBe("success");
	});

	test("refuses an unsupported command truthfully instead of crashing or succeeding", async () => {
		const result = await runFrontDoor(["frobnicate"]);
		expect(result.code).toBe(2);
		const envelope = JSON.parse(result.stdout);
		expect(envelope.result.commandIdentity).toBe("connectors.dispatch");
		expect(envelope.result.outcome).toBe("refused");
		expect(envelope.result.failureClass).toBe("usage");
		expect(envelope.result.exitCode).toBe(2);
		expect(envelope.result.causeCode).toBe("USAGE_UNKNOWN_COMMAND");
		// The refusal message is fixed and independent of the caller's argv;
		// see the dedicated no-echo regression test below for why.
		expect(envelope.message).toBe("connectors: unsupported command. Run with --discover --json to see available commands.");
		// repairAction must be a useful string naming the actual next command,
		// never a bare boolean flag.
		expect(typeof envelope.result.repairAction).toBe("string");
		expect(envelope.result.repairAction.length).toBeGreaterThan(0);
		expect(envelope.result.repairAction).toContain("--discover --json");
	});

	test("never echoes caller argv into public output, even a secret-shaped value", async () => {
		const sentinel = "SENTINEL_PRIVATE_VALUE";
		const result = await runFrontDoor(["--json", sentinel]);
		expect(result.code).toBe(2);
		expect(result.stdout).not.toContain(sentinel);
		expect(result.stderr).not.toContain(sentinel);
		const envelope = JSON.parse(result.stdout);
		expect(envelope.message).not.toContain(sentinel);
		expect(JSON.stringify(envelope)).not.toContain(sentinel);
	});

	test("refuses when no command is given", async () => {
		const result = await runFrontDoor([]);
		expect(result.code).toBe(2);
		const envelope = JSON.parse(result.stdout);
		expect(envelope.result.outcome).toBe("refused");
		expect(envelope.result.causeCode).toBe("USAGE_UNKNOWN_COMMAND");
		expect(typeof envelope.result.repairAction).toBe("string");
	});

	test("machine stdout carries only the envelope; nothing on stderr", async () => {
		const result = await runFrontDoor(["--discover", "--json"]);
		expect(result.stderr).toBe("");
		expect(() => JSON.parse(result.stdout)).not.toThrow();
	});

	test("stdout is not truncated when piped: the full envelope is valid JSON on every run", async () => {
		// Regression guard for calling process.exit() immediately after an
		// async stdout write, which can race Bun's own flush on a pipe.
		// Repeats spawn to catch an intermittent race, not just a one-off.
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const result = await runFrontDoor(["--discover", "--json"]);
			expect(result.code).toBe(0);
			expect(() => JSON.parse(result.stdout)).not.toThrow();
			expect(result.stdout.endsWith("\n")).toBe(true);
		}
	});
});

describe("compiled front door: closed-pipe output boundary", () => {
	// Real child process, real pipe: cancel the read side before the child
	// can have written, simulating a caller that closes stdout early
	// (piping to `head`, an aborted request, and so on). Repeated to catch
	// the timing-sensitive race, matching the reviewer's own 30-run repro.
	test("a pre-drain EPIPE ends with empty stderr and no replacement envelope, never a raw stack", async () => {
		for (let attempt = 0; attempt < 30; attempt += 1) {
			const proc = Bun.spawn([FRONT_DOOR, "--discover", "--json"], {
				env: { HOME: "/tmp", PATH: "/usr/bin:/bin" },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			proc.stdout.cancel();
			const stderr = await new Response(proc.stderr).text();
			const code = await proc.exited;
			expect(stderr).toBe("");
			expect(code).toBe(1);
		}
	});
});

describe("compiled front door: internal-failure fallback (unit-layer, supporting evidence)", () => {
	// This narrow claim cannot honestly be forced through the black-box
	// process seam: under correct code there is no reachable argv that
	// makes assertEnvelope throw, so there is nothing to spawn against.
	// Proven at the unit layer instead, importing the pure builder/validator
	// directly; the primary process-level proof above stays the main claim
	// for every ordinary success/refusal path.
	test("the fallback envelope is itself a valid envelope, and never carries dynamic exception text", () => {
		const envelope = buildInternalFailureEnvelope();
		expect(() => assertEnvelope(envelope)).not.toThrow();
		expect(envelope.result.outcome).toBe("failed");
		expect(envelope.result.failureClass).toBe("internal");
		expect(envelope.result.exitCode).toBe(1);
		expect(envelope.result.causeCode).toBe("INTERNAL_UNEXPECTED_UNCHANGED");
		expect(envelope.result.transactionState).toBe("unchanged");
		expect(envelope.result.effects).toEqual({ completed: [], remaining: [], uncertain: [], inventoryComplete: true });
		expect(typeof envelope.result.repairAction).toBe("string");
		expect(envelope.result.repairAction?.length).toBeGreaterThan(0);
		// Fixed, independent of any caught error: buildInternalFailureEnvelope
		// takes no argument, so there is no exception message to leak here.
		expect(envelope.diagnostics?.detail).toBe("internal contract validation or serialization failed before output");
	});
});

describe("compiled front door: assertEnvelope rejects fabricated envelopes (unit-layer)", () => {
	// One known-good baseline, independently valid (it is exactly what
	// buildInternalFailureEnvelope produces, already proven valid above).
	// Each test below mutates exactly one field to a value a real caller
	// could plausibly fabricate, and asserts the validator still catches it.
	const valid = () => structuredClone(buildInternalFailureEnvelope());

	test("wrong contractVersion", () => {
		const envelope = { ...valid(), contractVersion: "9.9.9" };
		expect(() => assertEnvelope(envelope)).toThrow(/contractVersion/);
	});

	test("malformed availablePaths (wrong element type)", () => {
		const envelope = { ...valid(), availablePaths: [1] } as unknown as ReturnType<typeof valid>;
		expect(() => assertEnvelope(envelope)).toThrow(/availablePaths/);
	});

	test("extra top-level key", () => {
		const envelope = { ...valid(), extraTopLevelField: true } as unknown as ReturnType<typeof valid>;
		expect(() => assertEnvelope(envelope)).toThrow(/unexpected key/);
	});

	test("extraneous result.retryDelayMilliseconds", () => {
		const base = valid();
		const envelope = { ...base, result: { ...base.result, retryDelayMilliseconds: 500 } } as unknown as ReturnType<typeof valid>;
		expect(() => assertEnvelope(envelope)).toThrow(/unexpected key/);
	});

	test("mismatched cause/outcome: failed outcome carrying SUCCESS_UNCHANGED", () => {
		const base = valid();
		const envelope = { ...base, result: { ...base.result, causeCode: "SUCCESS_UNCHANGED" } } as unknown as ReturnType<typeof valid>;
		expect(() => assertEnvelope(envelope)).toThrow(/causeCode SUCCESS_UNCHANGED requires outcome "success"/);
	});

	test("wrong exit code for the cause row (exit 75 on INTERNAL_UNEXPECTED_UNCHANGED)", () => {
		const base = valid();
		const envelope = { ...base, result: { ...base.result, exitCode: 75 } } as unknown as ReturnType<typeof valid>;
		expect(() => assertEnvelope(envelope)).toThrow(/requires exitCode 1/);
	});

	test("retryable true on a row that admits only false", () => {
		const base = valid();
		const envelope = { ...base, result: { ...base.result, retryable: true } } as unknown as ReturnType<typeof valid>;
		expect(() => assertEnvelope(envelope)).toThrow(/requires retryable false/);
	});

	test("nextAction is not a string", () => {
		const base = valid();
		const envelope = { ...base, result: { ...base.result, nextAction: 42 } } as unknown as ReturnType<typeof valid>;
		expect(() => assertEnvelope(envelope)).toThrow(/nextAction must be a non-empty string/);
	});

	test("nextAction names a command the CLI does not admit", () => {
		const base = valid();
		const envelope = { ...base, result: { ...base.result, nextAction: "connectors.unavailable" } } as unknown as ReturnType<typeof valid>;
		expect(() => assertEnvelope(envelope)).toThrow(/admitted commands/);
	});

	test("nonempty completed effects while transactionState is unchanged", () => {
		const base = valid();
		const envelope = { ...base, result: { ...base.result, effects: { ...base.result.effects, completed: ["effect.fake"] } } } as unknown as ReturnType<typeof valid>;
		expect(() => assertEnvelope(envelope)).toThrow(/unchanged result cannot report a completed effect/);
	});

	test("commandIdentity naming a command T1 does not admit", () => {
		const base = valid();
		const envelope = { ...base, result: { ...base.result, commandIdentity: "connectors.ghost" } } as unknown as ReturnType<typeof valid>;
		expect(() => assertEnvelope(envelope)).toThrow(/commandIdentity must name one of T1's admitted commands/);
	});

	test("result.data containing undefined, which JSON.stringify would silently drop", () => {
		const base = valid();
		// A success-shaped result is required to carry the unsafe value inside
		// `data` for this probe; failed/refused always carry `data: null`.
		const successResult = { ...base.result, outcome: "success", causeCode: "SUCCESS_UNCHANGED", failureClass: null, exitCode: 0, repairAction: null, data: { hidden: undefined } };
		const envelope = { ...base, result: successResult } as unknown as ReturnType<typeof valid>;
		expect(() => assertEnvelope(envelope)).toThrow(/must be a plain JSON-safe value/);
		// Independent proof the danger is real: JSON.stringify really does
		// drop it silently, which is exactly why this check exists.
		expect(JSON.parse(JSON.stringify(successResult.data))).not.toHaveProperty("hidden");
	});

	test("result.data containing a non-finite number (NaN), which JSON.stringify silently turns into null", () => {
		const base = valid();
		const successResult = { ...base.result, outcome: "success", causeCode: "SUCCESS_UNCHANGED", failureClass: null, exitCode: 0, repairAction: null, data: { count: Number.NaN } };
		const envelope = { ...base, result: successResult } as unknown as ReturnType<typeof valid>;
		expect(() => assertEnvelope(envelope)).toThrow(/must be a plain JSON-safe value/);
		expect(JSON.parse(JSON.stringify(successResult.data)).count).toBeNull();
	});

	test("diagnostics carrying an arbitrary extra key with a secret-shaped value", () => {
		const base = valid();
		const envelope = { ...base, diagnostics: { secret: "SENTINEL_PRIVATE_VALUE" } } as unknown as ReturnType<typeof valid>;
		expect(() => assertEnvelope(envelope)).toThrow(/diagnostics has unexpected key/);
	});

	test("diagnostics.detail set to a value other than T1's one fixed string", () => {
		const base = valid();
		const envelope = { ...base, diagnostics: { detail: "something else" } } as unknown as ReturnType<typeof valid>;
		expect(() => assertEnvelope(envelope)).toThrow(/one fixed, safe string/);
	});
});

describe("compiled front door: assertEnvelope admits run success (unit-layer, diagnostic only)", () => {
	// Diagnostic, not station proof: the fixture-adapter process block below
	// owns the reached run stations. Each envelope here is a test-owned literal
	// of a run that succeeded after these completed effects.
	const runSuccess = (causeCode: string, completed: readonly string[], commandIdentity = "connectors.run") => ({
		envelopeVersion: 2, contractVersion: CONTRACT_VERSION, message: "canva search-designs completed", availablePaths: AVAILABLE_PATHS,
		result: {
			runId: "run-diagnostic", commandIdentity, outcome: "success", failureClass: null, exitCode: 0,
			data: { connector: "canva", operation: "search-designs", result: {} }, retryable: false, repairAction: null, nextAction: "connectors.status",
			effectClass: "repository-local", transactionState: "completed", causeCode,
			effects: { completed, remaining: [], uncertain: [], inventoryComplete: true },
		},
	}) as unknown as Parameters<typeof assertEnvelope>[0];

	// [cause, completed effects], restated from the accepted run inventory.
	const admitted: ReadonlyArray<readonly [string, readonly string[]]> = [
		["SUCCESS_AFTER_ACCOUNT_EFFECT", ["mcporter-vault-file"]],
		["SUCCESS_AFTER_ACCOUNT_EFFECT", ["account-vault"]],
		["SUCCESS_AFTER_ACCOUNT_EFFECT", ["account-vault", "mcporter-vault-file"]],
		["SUCCESS_BOOTSTRAPPED", ["mcporter-bootstrap", "account-vault", "mcporter-vault-file"]],
		["SUCCESS_MCPORTER_RECOVERED", ["mcporter-recovery", "mcporter-vault-file"]],
	];

	test("a run that succeeded after an account effect is a valid envelope", () => {
		for (const [cause, completed] of admitted) expect({ cause, completed, problem: problemOf(runSuccess(cause, completed)) }).toEqual({ cause, completed, problem: null });
	});

	test("setup's causes stay setup-only, and run's own causes stay run-only", () => {
		expect(problemOf(runSuccess("SUCCESS_COMPLETED", ["mcporter-vault-file"]))).toContain("setup cause and command identity must agree");
		expect(problemOf(runSuccess("SUCCESS_AFTER_ACCOUNT_EFFECT", ["mcporter-vault-file"], "connectors.schema"))).toContain("run cause and command identity must agree");
		// A row-coherent transient refusal under auth: identity is its only fault.
		const base = runSuccess("TRANSIENT_PROVIDER_AFTER_ACCOUNT_EFFECT", ["mcporter-vault-file"], "connectors.auth");
		const transient = { ...base, result: { ...base.result, outcome: "refused", failureClass: "transient", exitCode: 75, retryable: true, data: null, repairAction: "Retry the run" } } as typeof base;
		expect(problemOf(transient)).toBe("internal contract violation: run cause and command identity must agree");
	});
});

const official = process.env.CONNECTORS_OFFICIAL_RELEASE_FIXTURE;
if (process.env.CI && !official) throw new Error("CONNECTORS_OFFICIAL_RELEASE_FIXTURE is required for CI process proof");

describe("compiled front door: run through the packaged fixture adapter (public process, loopback only)", () => {
	// Denies all remote network except loopback, and any Keychain command. A
	// runner that wraps this file in its own sandbox must use this exact profile.
	const LOOPBACK_ONLY = '(version 1)(allow default)(deny network-outbound (remote ip))(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))(allow network-outbound (remote ip "localhost:*"))(deny process-exec (literal "/usr/bin/security"))';
	const PROVIDER_SENTINEL = "SENTINEL_PROVIDER_ERROR_TEXT";
	const CONNECTOR = "loopback-fixture-skill";

	// The compiled binary in an isolated bundle, the official MCPorter selected
	// from local release bytes, a hostile mcporter first on PATH, and a keyless
	// loopback stub as the only reachable MCP server.
	function fixtureRun(options: { authority: boolean }) {
		const bundle = createBundle();
		bundle.addSkill(CONNECTOR);
		const hostile = createFakeMcporterBinDir();
		const authority = options.authority ? createFixtureAuthorityBinDir(bundle) : null;
		const stub = startLoopbackMcpStub();
		const registry = { imports: [], mcpServers: { [CONNECTOR]: { baseUrl: stub.url, allowedTools: ["probe"] } } };
		writeFileSync(path.join(bundle.skillsRoot, CONNECTOR, "config", "mcporter.json"), JSON.stringify(registry));
		const state = path.join(bundle.root, "state");
		const home = path.join(bundle.root, "home");
		mkdirSync(state);
		mkdirSync(home);
		const env = { HOME: home, PATH: `${hostile.binDir}:/usr/bin:/bin`, TMPDIR: bundle.root, XDG_STATE_HOME: state, CONNECTORS_TEST_RELEASE_DIR: official ?? path.join(bundle.root, "no-release-fixture") };
		return {
			bundle, state, home, stub,
			async run(argv: string[]) {
				const proc = Bun.spawn(["/usr/bin/sandbox-exec", "-p", LOOPBACK_ONLY, bundle.binary, ...argv], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
				const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
				return { code, stdout, stderr };
			},
			dispose() {
				stub.stop();
				authority?.dispose();
				hostile.dispose();
				bundle.dispose();
			},
		};
	}

	test.skipIf(!official)("the core reports success after an account effect and fails closed on a non-offline provider issue", async () => {
		const fixture = fixtureRun({ authority: true });
		try {
			const fail = "If the grant expired, run connectors auth login loopback-fixture-skill --select account=<value> yourself in a terminal; otherwise correct the operation or its --input before running again";
			// [account, stub error or null, exit, cause, completed effects, repairAction], in invocation order,
			// restated from the accepted run inventory. The repeat for b proves effects are observed, not supplied.
			const runs: ReadonlyArray<readonly [string, string | null, number, string, readonly string[], string | null]> = [
				["a", null, 0, "SUCCESS_BOOTSTRAPPED", ["mcporter-bootstrap", "account-vault", "mcporter-vault-file"], null],
				["b", null, 0, "SUCCESS_AFTER_ACCOUNT_EFFECT", ["account-vault", "mcporter-vault-file"], null],
				["b", null, 0, "SUCCESS_UNCHANGED", [], null],
				["c", PROVIDER_SENTINEL, 3, "DOMAIN_PROVIDER_CALL_FAILED_AFTER_EFFECT", ["account-vault", "mcporter-vault-file"], fail],
			];
			for (const [index, [account, failWith, exit, cause, completed, repairAction]] of runs.entries()) {
				fixture.stub.failWith = failWith;
				const result = await fixture.run(["run", CONNECTOR, "--select", `account=${account}`, "probe"]);
				expect({ index, code: result.code, stderr: result.stderr, lines: result.stdout.trim().split("\n").length }).toEqual({ index, code: exit, stderr: "", lines: 1 });
				const envelope = JSON.parse(result.stdout);
				expect({ index, cause: envelope.result.causeCode, effects: envelope.result.effects, repairAction: envelope.result.repairAction }).toEqual({
					index, cause, effects: { completed, remaining: [], uncertain: [], inventoryComplete: true }, repairAction,
				});
				expect(envelope.result.commandIdentity).toBe("connectors.run");
				// The real MCPorter reached the stub once per run.
				expect({ index, calls: fixture.stub.calls }).toEqual({ index, calls: index + 1 });
				if (failWith === null) expect(envelope.result.data).toEqual({ connector: CONNECTOR, operation: "probe", result: { content: [{ type: "text", text: "probe-ok" }] } });
				else expect(envelope.result.data).toBeNull();
				expect(result.stdout).not.toContain(PROVIDER_SENTINEL);
			}
			expect(existsSync(path.join(fixture.bundle.root, "mcporter.json"))).toBe(false);
			expect(existsSync(path.join(fixture.home, ".mcporter"))).toBe(false);
		} finally {
			fixture.dispose();
		}
	}, 90_000);

	test("outside a test bundle the fixture adapter refuses before MCPorter selection or state", async () => {
		const fixture = fixtureRun({ authority: false });
		try {
			const result = await fixture.run(["run", CONNECTOR, "--select", "account=a", "probe"]);
			expect(result.code).toBe(3);
			expect(result.stderr).toBe("");
			expect(JSON.parse(result.stdout).result).toMatchObject({
				causeCode: "DOMAIN_ADAPTER_REFUSED", transactionState: "unchanged", data: { connector: CONNECTOR, connectorCause: "fixture-authority-unavailable" },
				effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true },
			});
			expect(fixture.stub.calls).toBe(0);
			expect(existsSync(path.join(fixture.state, "connectors"))).toBe(false);
		} finally {
			fixture.dispose();
		}
	}, 30_000);
});

function problemOf(envelope: Parameters<typeof assertEnvelope>[0]): string | null {
	try {
		assertEnvelope(envelope);
		return null;
	} catch (error) {
		return (error as Error).message;
	}
}

describe("compiled front door: per-Skill resolution (Q11a)", () => {
	// Each in-scope Skill resolves the front door as `../../bin/connectors`
	// from its own directory, no global command, no dotfiles path. Mermaid is
	// out of scope for T1 and is not listed here.
	const inScopeSkills = ["atlassian", "canva", "context7", "firecrawl"];

	for (const skill of inScopeSkills) {
		test(`${skill} resolves the front door from its own plugin path`, async () => {
			const skillDir = path.join(PLUGIN_ROOT, "skills", skill);
			const resolved = path.join(skillDir, "..", "..", "bin", "connectors");
			expect(() => accessSync(resolved, constants.X_OK)).not.toThrow();
			const proc = Bun.spawn([resolved, "--discover", "--json"], {
				env: { HOME: "/tmp", PATH: "/usr/bin:/bin" },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
			expect(code).toBe(0);
			expect(JSON.parse(stdout).result.outcome).toBe("success");
		});
	}
});
