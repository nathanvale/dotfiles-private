import { describe, expect, test } from "bun:test";
import {
	PINNED_OPEN_IDENTITY_FIXTURES,
	PINNED_OPEN_IDENTITY_LIVE_GATE,
	PINNED_OPEN_EXEC_ARGV_SHAPE,
	PINNED_OPEN_MINT_ARGV_SHAPE,
	PINNED_OPEN_PREPARE_ARGV_SHAPE,
	buildPinnedOpenExecArgv,
	buildPinnedOpenMintArgv,
	buildPinnedOpenPrepareArgv,
	dispatchPinnedOpenLive,
	isPublicOnlyArgv,
	matchesPinnedOpenArgvShape,
	pinnedOpenExecDiagnostic,
	runPinnedOpenQualificationExec,
	shouldDispatchPinnedOpenLive,
	classifyPinnedOpenFixture,
	classifyPinnedOpenIdentity,
	pinnedOpenIdentityDiagnostic,
	pinnedOpenIdentityFixture,
	type PinnedOpenIdentityVerdict,
} from "./browser-use-pinned-open-identity";

// Independent oracle: every expected verdict is written by hand here from the
// documented distinction, never read from the catalog and never produced by
// calling the classifier. The catalog supplies only the domain to enumerate.
const EXPECTED_VERDICT: Record<string, PinnedOpenIdentityVerdict> = {
	"created-new-tab": "pinned_open_created_new_tab",
	"navigated-in-place-same-origin": "pinned_open_navigated_in_place",
	"navigated-in-place-cross-origin": "pinned_open_navigated_in_place",
	"navigated-in-place-elsewhere": "pinned_open_navigated_in_place",
	"no-identity-change": "pinned_open_no_identity_change",
	"inventory-lost-tab": "pinned_open_inventory_lost_tab",
	"ambiguous-two-new-tabs": "pinned_open_identity_ambiguous",
	"ambiguous-two-navigations": "pinned_open_identity_ambiguous",
	"tab-ref-changed": "pinned_open_tab_ref_changed",
	"unsafe-duplicate-target-id": "pinned_open_identity_unsafe",
};

// Independent oracle: pinned exactly, so adding or dropping a fixture is a
// reviewable edit rather than a silent change in coverage.
const EXPECTED_FIXTURE_COUNT = 10;

// Independent oracle: which fixtures must land on the requested url. Held
// separately from the verdict table because identity and destination are
// deliberately independent claims.
const EXPECTED_LANDED: Record<string, boolean> = {
	"created-new-tab": true,
	"navigated-in-place-same-origin": true,
	"navigated-in-place-cross-origin": true,
	"navigated-in-place-elsewhere": false,
	"no-identity-change": false,
	"inventory-lost-tab": false,
	"ambiguous-two-new-tabs": false,
	"ambiguous-two-navigations": false,
	"tab-ref-changed": false,
	"unsafe-duplicate-target-id": false,
};

describe("pinned-open identity fixture catalog", () => {
	test("pins the fixture inventory and gives every fixture a hand-written expectation", () => {
		expect(PINNED_OPEN_IDENTITY_FIXTURES).toHaveLength(EXPECTED_FIXTURE_COUNT);
		const ids: string[] = PINNED_OPEN_IDENTITY_FIXTURES.map(
			(fixture) => fixture.id,
		);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.slice().sort()).toEqual(Object.keys(EXPECTED_VERDICT).sort());
		expect(ids.slice().sort()).toEqual(Object.keys(EXPECTED_LANDED).sort());
	});

	test("every fixture carries a non-empty summary and a parseable requested url", () => {
		for (const fixture of PINNED_OPEN_IDENTITY_FIXTURES) {
			expect(fixture.summary.length).toBeGreaterThan(0);
			expect(() => new URL(fixture.requestedUrl)).not.toThrow();
		}
	});

	// Independent oracle: the gate name restated by hand. A rename must fail
	// here until a reviewer updates whatever runs the live counterpart too.
	test("owns a stable live gate name and implements no live case", () => {
		expect(PINNED_OPEN_IDENTITY_LIVE_GATE).toBe(
			"BROWSER_USE_PINNED_OPEN_IDENTITY_LIVE",
		);
	});

	test("looks one fixture up by id and refuses an unknown id", () => {
		expect(pinnedOpenIdentityFixture("created-new-tab")?.id).toBe("created-new-tab");
		expect(pinnedOpenIdentityFixture("not-a-fixture")).toBeUndefined();
	});
});

describe("pinned-open identity classification", () => {
	for (const fixture of PINNED_OPEN_IDENTITY_FIXTURES) {
		test(`classifies ${fixture.id}`, () => {
			const result = classifyPinnedOpenFixture(fixture);
			expect(pinnedOpenIdentityDiagnostic(result).verdict).toBe(
				EXPECTED_VERDICT[fixture.id] as PinnedOpenIdentityVerdict,
			);
			expect(result.landed_on_requested_url).toBe(
				EXPECTED_LANDED[fixture.id] as boolean,
			);
		});
	}

	test("hands back identity only for a created or in-place outcome", () => {
		for (const fixture of PINNED_OPEN_IDENTITY_FIXTURES) {
			const result = classifyPinnedOpenFixture(fixture);
			const carries =
				result.verdict === "pinned_open_created_new_tab" ||
				result.verdict === "pinned_open_navigated_in_place";
			expect(result.identity !== undefined).toBe(carries);
		}
	});

	test("names the new tab, not the untouched one, when a tab is created", () => {
		const result = classifyPinnedOpenFixture(
			pinnedOpenIdentityFixture("created-new-tab") ??
				PINNED_OPEN_IDENTITY_FIXTURES[0],
		);
		expect(result.identity).toEqual({
			tab_id: "tab-b",
			canonical_target_id: "target-b",
		});
	});

	test("names the same ids it started with when a tab is navigated in place", () => {
		const result = classifyPinnedOpenFixture(
			pinnedOpenIdentityFixture("navigated-in-place-cross-origin") ??
				PINNED_OPEN_IDENTITY_FIXTURES[0],
		);
		expect(result.identity).toEqual({
			tab_id: "tab-a",
			canonical_target_id: "target-a",
		});
	});
});

describe("pinned-open identity is decided without the url", () => {
	// The whole point of the harness: two fixtures that end on the SAME url
	// must still separate, because only their identities differ.
	test("separates a created tab from an in-place navigation that ends on the same url", () => {
		const created = classifyPinnedOpenFixture(
			pinnedOpenIdentityFixture("created-new-tab") ??
				PINNED_OPEN_IDENTITY_FIXTURES[0],
		);
		const inPlace = classifyPinnedOpenFixture(
			pinnedOpenIdentityFixture("navigated-in-place-cross-origin") ??
				PINNED_OPEN_IDENTITY_FIXTURES[0],
		);
		expect(created.landed_on_requested_url).toBe(true);
		expect(inPlace.landed_on_requested_url).toBe(true);
		expect(created.verdict).not.toBe(inPlace.verdict);
	});

	test("reads an in-place navigation the same way whether or not it crossed origins", () => {
		const sameOrigin = classifyPinnedOpenFixture(
			pinnedOpenIdentityFixture("navigated-in-place-same-origin") ??
				PINNED_OPEN_IDENTITY_FIXTURES[0],
		);
		const crossOrigin = classifyPinnedOpenFixture(
			pinnedOpenIdentityFixture("navigated-in-place-cross-origin") ??
				PINNED_OPEN_IDENTITY_FIXTURES[0],
		);
		expect(sameOrigin.verdict).toBe(crossOrigin.verdict);
		expect(sameOrigin.new_target_id_count).toBe(0);
		expect(crossOrigin.new_target_id_count).toBe(0);
	});
});

describe("pinned-open identity fails closed", () => {
	const REQUESTED = "http://127.0.0.1:43151/";

	test("rejects a non-array inventory on either side", () => {
		expect(
			classifyPinnedOpenIdentity({ before: null, after: [], requestedUrl: REQUESTED })
				.verdict,
		).toBe("pinned_open_identity_unsafe");
		expect(
			classifyPinnedOpenIdentity({ before: [], after: "nope", requestedUrl: REQUESTED })
				.verdict,
		).toBe("pinned_open_identity_unsafe");
	});

	test("rejects an unsafe id and a missing field", () => {
		const row = { tabId: "tab-a", targetId: "target-a", url: REQUESTED };
		expect(
			classifyPinnedOpenIdentity({
				before: [row],
				after: [{ tabId: "tab a!", targetId: "target-a", url: REQUESTED }],
				requestedUrl: REQUESTED,
			}).verdict,
		).toBe("pinned_open_identity_unsafe");
		expect(
			classifyPinnedOpenIdentity({
				before: [row],
				after: [{ tabId: "tab-a", targetId: "target-a" }],
				requestedUrl: REQUESTED,
			}).verdict,
		).toBe("pinned_open_identity_unsafe");
	});

	test("rejects an unparseable requested url", () => {
		expect(
			classifyPinnedOpenIdentity({
				before: [],
				after: [],
				requestedUrl: "not-a-url",
			}).verdict,
		).toBe("pinned_open_identity_unsafe");
	});

	test("a lost tab outranks a tab created in the same window", () => {
		const result = classifyPinnedOpenIdentity({
			before: [{ tabId: "tab-a", targetId: "target-a", url: "https://mail.test/" }],
			after: [{ tabId: "tab-b", targetId: "target-b", url: REQUESTED }],
			requestedUrl: REQUESTED,
		});
		expect(result.verdict).toBe("pinned_open_inventory_lost_tab");
		expect(result.identity).toBeUndefined();
	});
});

describe("pinned-open identity diagnostics cannot leak", () => {
	test("the projection carries no url, tab id, or canonical target id", () => {
		for (const fixture of PINNED_OPEN_IDENTITY_FIXTURES) {
			const diagnostic = pinnedOpenIdentityDiagnostic(
				classifyPinnedOpenFixture(fixture),
			);
			const rendered = JSON.stringify(diagnostic);
			expect(rendered).not.toContain("http");
			expect(rendered).not.toContain("tab-");
			expect(rendered).not.toContain("target-");
			expect(Object.keys(diagnostic).sort()).toEqual([
				"landed_on_requested_url",
				"missing_target_id_count",
				"navigated_target_id_count",
				"new_target_id_count",
				"verdict",
			]);
		}
	});
});

// ---------------------------------------------------------------------------
// Gated public qualification-exec caller.
//
// One `qualification prepare` into a freshly allocated child bundle, one sealed
// `qualification handoff` mint through that same bundle, then one
// `qualification exec` carrying the sealed digest, an explicit run-scoped state
// path, and a public `targets open` argv. Never raw adapter argv, never a
// retry, never a target close.
//
// The mint is load-bearing: `targets open` admits a handoff only together with
// its sealed `<handoff>.producer.json` receipt, and only that producer writes
// one. Skipping it is what an approved live probe proved returns
// `qualification_handoff_producer_invalid`.
// ---------------------------------------------------------------------------

const RUNNER_EXE = "/opt/browser-use/browser-use";
const BUNDLE_ROOT = "/private/pinned-open";
const BUNDLE_CHILD = "/private/pinned-open/bundle-abc123";
const STATE_PATH = "/private/pinned-open/selected-target.json";
const HANDOFF_PATH = "/private/pinned-open/handoff-abc123.json";
const RUNNER_RUN_ID = "pinned-open-fixture-run";
const RUNNER_URL = "http://127.0.0.1:43151/?path=/story/x";
const SEALED_DIGEST =
	"f15a8fce32213e8a585a0d9409e58622d12a1266089b71e74727aa88c4572e7f";
const OTHER_DIGEST =
	"0000000000000000000000000000000000000000000000000000000000000000";

type Cmd = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };

function pubEnvelope(data: unknown): string {
	return JSON.stringify({ status: "ok", run_id: RUNNER_RUN_ID, data });
}

function execRunner(respond: (args: readonly string[], n: number) => Cmd) {
	const calls: (readonly string[])[] = [];
	const runner = async (input: { args: readonly string[] }) => {
		calls.push(input.args);
		return respond(input.args, calls.length);
	};
	return { runner, calls };
}

const PREPARE_OK: Cmd = {
	exitCode: 0,
	stdout: pubEnvelope({ manifest_digest: SEALED_DIGEST }),
	stderr: "",
	timedOut: false,
};

/** The receipt the sealed producer prints, bound to this run and bundle. */
const MINT_OK: Cmd = {
	exitCode: 0,
	stdout: JSON.stringify({
		status: "ok",
		data: {
			contract: "browser-use.qualification-handoff-producer",
			schema_version: "1",
			command: "qualification-handoff",
			producer: "browser-connect",
			adapter: "agent-browser",
			run_id: RUNNER_RUN_ID,
			expected_manifest_digest: SEALED_DIGEST,
			observed_manifest_digest: SEALED_DIGEST,
		},
	}),
	stderr: "",
	timedOut: false,
};

const EXEC_OK: Cmd = {
	exitCode: 0,
	stdout: pubEnvelope({
		command: "targets-open",
		effect: "confirmed",
		target_mutated: true,
		target_present: true,
		command_outcome: "adapter-confirmed",
		ownership: { kind: "created-target", retained: true },
	}),
	stderr: JSON.stringify({
		level: "debug",
		event: "target-topology-fallback-adopted",
		operation_phase: "inventory",
	}),
	timedOut: false,
};

const ADOPTED_EXEC_OK: Cmd = {
	...EXEC_OK,
	stdout: pubEnvelope({
		command: "targets-open",
		effect: "confirmed",
		target_mutated: true,
		target_present: true,
		command_outcome: "adapter-confirmed",
		ownership: { kind: "adopted-existing-target", retained: true },
	}),
};

/**
 * Route one fake call to its stage.
 *
 * `handoff` as a bare token is the mint verb; the open carries `--handoff`,
 * which is a different element, so the two never collide.
 */
function stageOf(args: readonly string[]): "prepare" | "mint" | "exec" {
	if (args.includes("prepare")) return "prepare";
	return args.includes("handoff") ? "mint" : "exec";
}

const STAGE_OK = { prepare: PREPARE_OK, mint: MINT_OK, exec: EXEC_OK } as const;

/** Answer every stage successfully, except the ones this call overrides. */
function respond(
	overrides: Partial<Record<"prepare" | "mint" | "exec", Cmd>> = {},
): (args: readonly string[]) => Cmd {
	return (args) => {
		const stage = stageOf(args);
		return overrides[stage] ?? STAGE_OK[stage];
	};
}

function runnerInput(
	runner: (input: { args: readonly string[] }) => Promise<Cmd>,
	gate: string | undefined,
) {
	const removed: string[] = [];
	const removedHandoffs: string[] = [];
	const allocated: string[] = [];
	const allocatedHandoffs: string[] = [];
	return {
		removed,
		removedHandoffs,
		allocated,
		allocatedHandoffs,
		input: {
			env: gate === undefined ? {} : { BROWSER_USE_PINNED_OPEN_IDENTITY_LIVE: gate },
			runCommand: runner,
			executable: RUNNER_EXE,
			bundleRoot: BUNDLE_ROOT,
			allocateBundleDir: (root: string) => {
				allocated.push(root);
				return BUNDLE_CHILD;
			},
			allocateHandoffPath: (root: string) => {
				allocatedHandoffs.push(root);
				return HANDOFF_PATH;
			},
			expectedManifestDigest: SEALED_DIGEST,
			requestedUrl: RUNNER_URL,
			statePath: STATE_PATH,
			runId: RUNNER_RUN_ID,
			timeoutMs: 30_000,
			removeBundleDir: (dir: string) => {
				removed.push(dir);
			},
			removeHandoff: (path: string) => {
				removedHandoffs.push(path);
			},
		},
	};
}

describe("pinned-open exec caller is disabled by default", () => {
	test("performs zero calls and allocates no bundle when the gate is unset", async () => {
		const { runner, calls } = execRunner(() => PREPARE_OK);
		const { input, removed, allocated } = runnerInput(runner, undefined);
		const run = await runPinnedOpenQualificationExec(input);
		expect(run.result).toMatchObject({
			ok: false,
			code: "pinned_open_live_disabled",
			prepareCalls: 0,
			execCalls: 0,
		});
		expect(calls).toHaveLength(0);
		expect(allocated).toEqual([]);
		expect(removed).toEqual([]);
		expect(run.bundle).toBeUndefined();
	});

	for (const gate of ["", "0", "true", "01"] as const) {
		test(`stays disabled for gate ${JSON.stringify(gate)}`, async () => {
			const { runner, calls } = execRunner(() => PREPARE_OK);
			const { input, allocated } = runnerInput(runner, gate);
			const run = await runPinnedOpenQualificationExec(input);
			expect(run.result.code).toBe("pinned_open_live_disabled");
			expect(calls).toHaveLength(0);
			expect(allocated).toEqual([]);
		});
	}
});

describe("pinned-open exec caller argv matches the exact supported shapes", () => {
	// Independent oracle: written by hand from the published CLI usage strings.
	const EXPECTED_PREPARE = [
		"qualification", "prepare", "--output", BUNDLE_CHILD, "--json",
	];
	// The sealed producer mint. Written by hand from the same usage strings: it
	// is `qualification handoff` run INSIDE `qualification exec`, so the receipt
	// it writes is bound to the bundle the open will execute.
	const EXPECTED_MINT = [
		"qualification", "exec",
		"--bundle", BUNDLE_CHILD,
		"--expected-manifest-digest", SEALED_DIGEST,
		"--",
		"qualification", "handoff",
		"--run-id", RUNNER_RUN_ID,
		"--output", HANDOFF_PATH,
		"--json",
	];
	const EXPECTED_EXEC = [
		"qualification", "exec",
		"--bundle", BUNDLE_CHILD,
		"--expected-manifest-digest", SEALED_DIGEST,
		"--",
		"targets", "open",
		"--url", RUNNER_URL,
		"--handoff", HANDOFF_PATH,
		"--state", STATE_PATH,
		"--run-id", RUNNER_RUN_ID,
		"--debug", "--json",
	];

	test("builds the exact prepare, mint, and exec argv", () => {
		expect(buildPinnedOpenPrepareArgv({ outputDir: BUNDLE_CHILD })).toEqual({
			ok: true,
			argv: EXPECTED_PREPARE,
		});
		expect(
			buildPinnedOpenMintArgv({
				bundleDir: BUNDLE_CHILD,
				expectedManifestDigest: SEALED_DIGEST,
				handoffPath: HANDOFF_PATH,
				runId: RUNNER_RUN_ID,
			}),
		).toEqual({ ok: true, argv: EXPECTED_MINT });
		expect(
			buildPinnedOpenExecArgv({
				bundleDir: BUNDLE_CHILD,
				expectedManifestDigest: SEALED_DIGEST,
				requestedUrl: RUNNER_URL,
				handoffPath: HANDOFF_PATH,
				statePath: STATE_PATH,
				runId: RUNNER_RUN_ID,
			}),
		).toEqual({ ok: true, argv: EXPECTED_EXEC });
	});

	test("the mint argv names the sealed producer, never a bare connect", () => {
		// The receipt only exists because `qualification handoff` wrote it. A
		// `browser-connect connect` handoff has no receipt, which is exactly the
		// live `qualification_handoff_producer_invalid` stop.
		expect(EXPECTED_MINT.slice(7, 9)).toEqual(["qualification", "handoff"]);
		expect(EXPECTED_MINT).not.toContain("connect");
		// Mint and open carry the same bundle, digest, run id, and handoff.
		expect(EXPECTED_MINT[3]).toBe(EXPECTED_EXEC[3]);
		expect(EXPECTED_MINT[5]).toBe(EXPECTED_EXEC[5]);
		expect(EXPECTED_MINT[10]).toBe(RUNNER_RUN_ID);
		expect(EXPECTED_MINT[12]).toBe(HANDOFF_PATH);
		expect(EXPECTED_EXEC).toContain(HANDOFF_PATH);
	});

	test("accepts only the exact shape, not merely the absence of native flags", () => {
		expect(matchesPinnedOpenArgvShape(EXPECTED_PREPARE, PINNED_OPEN_PREPARE_ARGV_SHAPE)).toBe(true);
		expect(matchesPinnedOpenArgvShape(EXPECTED_MINT, PINNED_OPEN_MINT_ARGV_SHAPE)).toBe(true);
		expect(matchesPinnedOpenArgvShape(EXPECTED_EXEC, PINNED_OPEN_EXEC_ARGV_SHAPE)).toBe(true);

		// A mint argv is not an open argv, and neither shape accepts the other.
		expect(matchesPinnedOpenArgvShape(EXPECTED_MINT, PINNED_OPEN_EXEC_ARGV_SHAPE)).toBe(false);
		expect(matchesPinnedOpenArgvShape(EXPECTED_EXEC, PINNED_OPEN_MINT_ARGV_SHAPE)).toBe(false);

		const mintReordered = [...EXPECTED_MINT];
		[mintReordered[7], mintReordered[8]] = [
			mintReordered[8] as string,
			mintReordered[7] as string,
		];
		expect(isPublicOnlyArgv(mintReordered)).toBe(true);
		expect(matchesPinnedOpenArgvShape(mintReordered, PINNED_OPEN_MINT_ARGV_SHAPE)).toBe(false);

		// Each of these carries no native flag at all, yet none is supported.
		const reordered = [...EXPECTED_EXEC];
		[reordered[7], reordered[8]] = [reordered[8] as string, reordered[7] as string];
		const dropped = EXPECTED_EXEC.filter((token) => token !== "--debug");
		const extra = [...EXPECTED_EXEC, "--quiet"];
		const swappedVerb = EXPECTED_EXEC.map((t) => (t === "open" ? "close" : t));
		for (const argv of [reordered, dropped, extra, swappedVerb]) {
			expect(isPublicOnlyArgv(argv)).toBe(true);
			expect(matchesPinnedOpenArgvShape(argv, PINNED_OPEN_EXEC_ARGV_SHAPE)).toBe(false);
		}
	});

	test("rejects a native flag on both the shape and the denylist", () => {
		for (const native of ["--cdp", "--session", "--pin-tab"] as const) {
			const argv = [...EXPECTED_EXEC, native];
			expect(isPublicOnlyArgv(argv)).toBe(false);
			expect(matchesPinnedOpenArgvShape(argv, PINNED_OPEN_EXEC_ARGV_SHAPE)).toBe(false);
		}
	});

	test("refuses an unsafe run id, url, digest, state path, or handoff path", () => {
		const base = {
			bundleDir: BUNDLE_CHILD,
			expectedManifestDigest: SEALED_DIGEST,
			requestedUrl: RUNNER_URL,
			handoffPath: HANDOFF_PATH,
			statePath: STATE_PATH,
			runId: RUNNER_RUN_ID,
		};
		for (const handoffPath of ["relative/handoff.json", "/private/../etc/handoff.json"]) {
			expect(buildPinnedOpenExecArgv({ ...base, handoffPath })).toEqual({
				ok: false, code: "unsafe_handoff_path",
			});
			expect(buildPinnedOpenMintArgv({ ...base, handoffPath })).toEqual({
				ok: false, code: "unsafe_handoff_path",
			});
		}
		expect(buildPinnedOpenExecArgv({ ...base, runId: "bad id!" })).toEqual({
			ok: false, code: "unsafe_run_id",
		});
		expect(buildPinnedOpenExecArgv({ ...base, requestedUrl: "file:///etc/passwd" })).toEqual({
			ok: false, code: "unsafe_requested_url",
		});
		expect(buildPinnedOpenExecArgv({ ...base, expectedManifestDigest: "nope" })).toEqual({
			ok: false, code: "unsafe_expected_digest",
		});
		expect(buildPinnedOpenExecArgv({ ...base, statePath: "relative/state.json" })).toEqual({
			ok: false, code: "unsafe_state_path",
		});
	});

	test("refuses before spawning or allocating anything when argv cannot be built", async () => {
		const { runner, calls } = execRunner(() => PREPARE_OK);
		const { input, allocated } = runnerInput(runner, "1");
		const run = await runPinnedOpenQualificationExec({
			...input,
			requestedUrl: "file:///etc/passwd",
		});
		expect(run.result).toMatchObject({
			ok: false, code: "unsafe_requested_url", prepareCalls: 0, execCalls: 0,
		});
		expect(calls).toHaveLength(0);
		expect(allocated).toEqual([]);
	});
});

describe("pinned-open exec caller allocates a fresh child bundle and handoff", () => {
	test("allocates each exactly once under the root and uses them in every argv", async () => {
		const { runner, calls } = execRunner(respond());
		const { input, allocated, allocatedHandoffs } = runnerInput(runner, "1");
		await runPinnedOpenQualificationExec(input);
		expect(allocated).toEqual([BUNDLE_ROOT]);
		expect(allocatedHandoffs).toEqual([BUNDLE_ROOT]);
		// Every call is bound to the one bundle this run prepared.
		for (const call of calls) expect(call).toContain(BUNDLE_CHILD);
		// The mint creates the handoff; the open consumes that same path.
		expect(calls[1]).toContain(HANDOFF_PATH);
		expect(calls[2]).toContain(HANDOFF_PATH);
		expect(calls[0]).not.toContain(BUNDLE_ROOT);
	});

	test("refuses an allocation that is not a fresh child of the root", async () => {
		for (const bad of [BUNDLE_ROOT, "/elsewhere/bundle", `${BUNDLE_ROOT}/../escape`] as const) {
			const { runner, calls } = execRunner(respond());
			const { input } = runnerInput(runner, "1");
			const run = await runPinnedOpenQualificationExec({
				...input,
				allocateBundleDir: () => bad,
			});
			expect(run.result).toMatchObject({
				ok: false, code: "unsafe_bundle_path", prepareCalls: 0, mintCalls: 0, execCalls: 0,
			});
			expect(calls).toHaveLength(0);
		}
	});

	test("refuses a handoff allocation that is not a fresh child of the root", async () => {
		for (const bad of [
			BUNDLE_ROOT,
			"/elsewhere/handoff.json",
			`${BUNDLE_ROOT}/../escape.json`,
			BUNDLE_CHILD,
		] as const) {
			const { runner, calls } = execRunner(respond());
			const { input } = runnerInput(runner, "1");
			const run = await runPinnedOpenQualificationExec({
				...input,
				allocateHandoffPath: () => bad,
			});
			expect(run.result).toMatchObject({
				ok: false, code: "unsafe_handoff_path", prepareCalls: 0, mintCalls: 0, execCalls: 0,
			});
			expect(calls).toHaveLength(0);
		}
	});
});

describe("pinned-open exec caller runs one prepare, one mint, and one exec", () => {
	test("retains a created-target handoff for exact public close and removes the bundle", async () => {
		const { runner, calls } = execRunner(respond());
		const { input, removed, removedHandoffs } = runnerInput(runner, "1");
		const run = await runPinnedOpenQualificationExec(input);
		expect(run.result).toMatchObject({
			ok: true,
			code: "pinned_open_observed",
			prepareCalls: 1,
			mintCalls: 1,
			execCalls: 1,
		});
		expect(calls).toHaveLength(3);
		expect(calls.map(stageOf)).toEqual(["prepare", "mint", "exec"]);
		expect(removed).toEqual([BUNDLE_CHILD]);
		expect(removedHandoffs).toEqual([]);
		expect(run.bundle).toEqual({ removed: true });
		expect(run.handoff).toEqual({
			removed: false,
			retainedPath: HANDOFF_PATH,
		});
	});

	test("releases the handoff when the successful open did not create the target", async () => {
		const { runner } = execRunner(respond({ exec: ADOPTED_EXEC_OK }));
		const { input, removedHandoffs } = runnerInput(runner, "1");
		const run = await runPinnedOpenQualificationExec(input);
		expect(run.result).toMatchObject({ ok: true, code: "pinned_open_observed" });
		expect(removedHandoffs).toEqual([HANDOFF_PATH]);
		expect(run.handoff).toEqual({ removed: true });
	});

	test("stops after the mint and never opens when the sealed producer fails", async () => {
		const { runner, calls } = execRunner(
			respond({
				mint: {
					exitCode: 20,
					stdout: JSON.stringify({
						status: "error",
						error: { code: "qualification_handoff_producer_input_invalid" },
					}),
					stderr: "",
					timedOut: false,
				},
			}),
		);
		const { input, removed, removedHandoffs } = runnerInput(runner, "1");
		const run = await runPinnedOpenQualificationExec(input);
		expect(run.result).toMatchObject({
			ok: false,
			code: "pinned_open_handoff_mint_failed",
			prepareCalls: 1,
			mintCalls: 1,
			execCalls: 0,
			browserUseErrorCode: "qualification_handoff_producer_input_invalid",
		});
		expect(calls).toHaveLength(2);
		// A failed mint still releases every allocated path.
		expect(removed).toEqual([BUNDLE_CHILD]);
		expect(removedHandoffs).toEqual([HANDOFF_PATH]);
	});

	test("refuses a receipt that is not bound to this producer, run, or bundle", async () => {
		const bound = JSON.parse(MINT_OK.stdout) as { data: Record<string, unknown> };
		const drifts: Record<string, unknown>[] = [
			{ contract: "browser-use.some-other-producer" },
			{ schema_version: "2" },
			{ command: "connect" },
			{ producer: "someone-else" },
			{ adapter: "chrome-devtools" },
			{ run_id: "a-different-run" },
			{ expected_manifest_digest: OTHER_DIGEST },
			{ observed_manifest_digest: OTHER_DIGEST },
		];
		for (const drift of drifts) {
			const { runner, calls } = execRunner(
				respond({
					mint: {
						...MINT_OK,
						stdout: JSON.stringify({
							status: "ok",
							data: { ...bound.data, ...drift },
						}),
					},
				}),
			);
			const { input } = runnerInput(runner, "1");
			const run = await runPinnedOpenQualificationExec(input);
			expect(run.result, JSON.stringify(drift)).toMatchObject({
				ok: false,
				code: "pinned_open_binding_mismatch",
				mintCalls: 1,
				execCalls: 0,
			});
			expect(calls).toHaveLength(2);
		}
	});

	test("never issues a target close", async () => {
		const { runner, calls } = execRunner(respond());
		const { input } = runnerInput(runner, "1");
		await runPinnedOpenQualificationExec(input);
		expect(calls.some((a) => a.includes("close"))).toBe(false);
	});

	test("stops without mint or exec when prepare fails, and does not retry", async () => {
		const { runner, calls } = execRunner(() => ({
			exitCode: 1, stdout: "", stderr: "boom", timedOut: false,
		}));
		const { input } = runnerInput(runner, "1");
		const run = await runPinnedOpenQualificationExec(input);
		expect(run.result).toMatchObject({
			ok: false,
			code: "pinned_open_prepare_failed",
			prepareCalls: 1,
			mintCalls: 0,
			execCalls: 0,
		});
		expect(calls).toHaveLength(1);
	});

	test("stops before mint and exec when the sealed digest does not match", async () => {
		const { runner, calls } = execRunner(
			respond({
				prepare: {
					...PREPARE_OK,
					stdout: pubEnvelope({ manifest_digest: OTHER_DIGEST }),
				},
			}),
		);
		const { input } = runnerInput(runner, "1");
		const run = await runPinnedOpenQualificationExec(input);
		expect(run.result).toMatchObject({
			ok: false,
			code: "pinned_open_binding_mismatch",
			prepareCalls: 1,
			mintCalls: 0,
			execCalls: 0,
		});
		expect(calls).toHaveLength(1);
	});

	test("stops after exactly one exec when exec fails, and does not retry", async () => {
		const { runner, calls } = execRunner(
			respond({ exec: { exitCode: 20, stdout: "", stderr: "boom", timedOut: false } }),
		);
		const { input } = runnerInput(runner, "1");
		const run = await runPinnedOpenQualificationExec(input);
		expect(run.result).toMatchObject({
			ok: false, code: "pinned_open_exec_failed", prepareCalls: 1, mintCalls: 1, execCalls: 1,
		});
		expect(calls).toHaveLength(3);
	});

	test("surfaces the live producer refusal instead of collapsing it", async () => {
		// The exact code the approved live probe observed, reproduced through the
		// caller: a sealed exec that refuses the handoff it was handed.
		const { runner } = execRunner(
			respond({
				exec: {
					exitCode: 20,
					stdout: JSON.stringify({
						status: "error",
						error: { code: "qualification_handoff_producer_invalid", exit_code: 20 },
					}),
					stderr: "",
					timedOut: false,
				},
			}),
		);
		const { input } = runnerInput(runner, "1");
		const run = await runPinnedOpenQualificationExec(input);
		expect(run.result).toMatchObject({
			ok: false,
			code: "pinned_open_exec_failed",
			browserUseErrorCode: "qualification_handoff_producer_invalid",
		});
	});

	test("parses the machine result from stdout only", async () => {
		const { runner } = execRunner(
			respond({
				exec: { exitCode: 0, stdout: "", stderr: EXEC_OK.stdout, timedOut: false },
			}),
		);
		const { input } = runnerInput(runner, "1");
		const run = await runPinnedOpenQualificationExec(input);
		expect(run.result.code).toBe("pinned_open_invalid_envelope");
	});

	test("produces a deterministic machine result across identical runs", async () => {
		async function once() {
			const { runner } = execRunner((args) =>
				args.includes("prepare") ? PREPARE_OK : EXEC_OK,
			);
			const { input } = runnerInput(runner, "1");
			return (await runPinnedOpenQualificationExec(input)).result;
		}
		expect(JSON.stringify(await once())).toBe(JSON.stringify(await once()));
	});
});

describe("pinned-open exec caller bundle custody", () => {
	test("retains the child bundle and names it when removal fails", async () => {
		const { runner } = execRunner(respond());
		const { input } = runnerInput(runner, "1");
		const run = await runPinnedOpenQualificationExec({
			...input,
			removeBundleDir: () => {
				throw new Error("cannot remove");
			},
		});
		expect(run.result.ok).toBe(true);
		expect(run.bundle).toEqual({ removed: false, retainedPath: BUNDLE_CHILD });
	});

	test("retains the minted handoff and names it when removal fails", async () => {
		const { runner } = execRunner(respond({ exec: ADOPTED_EXEC_OK }));
		const { input, removed } = runnerInput(runner, "1");
		const run = await runPinnedOpenQualificationExec({
			...input,
			removeHandoff: () => {
				throw new Error("cannot remove");
			},
		});
		expect(run.result.ok).toBe(true);
		expect(run.handoff).toEqual({ removed: false, retainedPath: HANDOFF_PATH });
		// A handoff that could not be released must not stop the bundle from
		// being released: each path reports its own fate.
		expect(run.bundle).toEqual({ removed: true });
		expect(removed).toEqual([BUNDLE_CHILD]);
	});

	test("still attempts bundle cleanup after a failed exec", async () => {
		const { runner } = execRunner((args) =>
			args.includes("prepare")
				? PREPARE_OK
				: { exitCode: 20, stdout: "", stderr: "boom", timedOut: false },
		);
		const { input, removed } = runnerInput(runner, "1");
		await runPinnedOpenQualificationExec(input);
		expect(removed).toEqual([BUNDLE_CHILD]);
	});
});

describe("pinned-open exec caller reports custody without closing", () => {
	test("reports the retained target custody and the fallback signal", async () => {
		const { runner } = execRunner(respond());
		const { input } = runnerInput(runner, "1");
		const run = await runPinnedOpenQualificationExec(input);
		if (!run.result.ok) throw new Error("expected an observation");
		expect(run.result.custody).toEqual({
			ownership_kind: "created-target",
			command_outcome: "adapter-confirmed",
			effect: "confirmed",
			target_mutated: true,
			target_present: true,
			target_retained: true,
			fallback_adopted: true,
		});
	});

	test("reports no fallback signal when the event is absent", async () => {
		const { runner } = execRunner(respond({ exec: { ...EXEC_OK, stderr: "" } }));
		const { input } = runnerInput(runner, "1");
		const run = await runPinnedOpenQualificationExec(input);
		if (!run.result.ok) throw new Error("expected an observation");
		expect(run.result.custody.fallback_adopted).toBe(false);
	});

	test("the exec diagnostic carries no url, digest, path, run id, or ids", async () => {
		const { runner } = execRunner(respond());
		const { input } = runnerInput(runner, "1");
		const run = await runPinnedOpenQualificationExec(input);
		const rendered = JSON.stringify(pinnedOpenExecDiagnostic(run.result));
		expect(rendered).not.toContain("http");
		expect(rendered).not.toContain(SEALED_DIGEST);
		expect(rendered).not.toContain(BUNDLE_ROOT);
		expect(rendered).not.toContain(BUNDLE_CHILD);
		expect(rendered).not.toContain(HANDOFF_PATH);
		expect(rendered).not.toContain(STATE_PATH);
		expect(rendered).not.toContain(RUNNER_RUN_ID);
		expect(rendered).not.toContain("43151");
	});
});

describe("pinned-open gated entry dispatch", () => {
	test("decides dispatch from the gate alone", () => {
		expect(shouldDispatchPinnedOpenLive({})).toBe(false);
		expect(shouldDispatchPinnedOpenLive({ BROWSER_USE_PINNED_OPEN_IDENTITY_LIVE: "0" })).toBe(false);
		expect(shouldDispatchPinnedOpenLive({ BROWSER_USE_PINNED_OPEN_IDENTITY_LIVE: "1" })).toBe(true);
	});

	test("the real entry runs the caller exactly once when gated on", async () => {
		const { runner, calls } = execRunner(respond());
		const { input } = runnerInput(runner, "1");
		const dispatched = await dispatchPinnedOpenLive(input);
		expect(dispatched.dispatched).toBe(true);
		expect(dispatched.run?.result.ok).toBe(true);
		expect(calls).toHaveLength(3);
	});

	test("the real entry runs nothing when gated off", async () => {
		const { runner, calls } = execRunner(() => PREPARE_OK);
		const { input, allocated } = runnerInput(runner, undefined);
		const dispatched = await dispatchPinnedOpenLive(input);
		expect(dispatched.dispatched).toBe(false);
		expect(dispatched.run).toBeUndefined();
		expect(calls).toHaveLength(0);
		expect(allocated).toEqual([]);
	});
});
