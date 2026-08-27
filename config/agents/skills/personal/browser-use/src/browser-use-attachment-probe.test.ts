import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ATTACHMENT_PROBE_CASES,
	attachmentProbeCase,
	attachmentProbeCustodyDiagnostic,
	attachmentProbeDiagnostic,
	compareCurrentTabIdentity,
	currentTabDiagnostic,
	CURRENT_TAB_ADOPTION_SEQUENCE,
	buildAttachmentProbeArgv,
	classifyAttachmentProbeResult,
	isReadOnlyNativeArgs,
	releaseAttachmentProbeCustody,
	releaseAttachmentProbeSession,
	runAttachmentProbe,
	summarizeCurrentTabs,
	verifyStableTargetIdentity,
	type AttachmentProbeCase,
	type AttachmentProbeCaseId,
	type AttachmentProbeCommandResult,
	type AttachmentProbeCommandRunner,
} from "./browser-use-attachment-probe";

// Independent oracle: this list is a deliberate restatement of the read-only
// token allowlist. Do not hoist it into the module under test — the point is
// that a widened allowlist must fail this test until a reviewer edits it here
// too.
const EXPECTED_READ_ONLY_TOKENS = ["session", "tab", "list", "--json"];

// Independent oracle: the exact public Agent Browser argv each named case must
// produce. Written by hand from the Agent Browser CLI contract, never derived
// by calling the builder.
const EXPECTED_ARGV: Record<string, readonly string[]> = {
	"session-inventory": ["--session", "probe-session", "session", "list", "--json"],
	"adopted-current-tab-inventory": [
		"--cdp",
		"<endpoint>",
		"--session",
		"probe-session",
		"tab",
		"list",
		"--json",
	],
	"pinned-current-tab-inventory": [
		"--cdp",
		"<endpoint>",
		"--session",
		"probe-session",
		"--pin-tab",
		"tab",
		"list",
		"--json",
	],
};

const CASE_IDS: AttachmentProbeCaseId[] = [
	"session-inventory",
	"adopted-current-tab-inventory",
	"pinned-current-tab-inventory",
];

function caseById(id: string): AttachmentProbeCase {
	const probeCase = attachmentProbeCase(id);
	if (probeCase === undefined) throw new Error(`missing probe case ${id}`);
	return probeCase;
}

function tabEnvelope(tabs: readonly unknown[]): string {
	return JSON.stringify({ success: true, data: { tabs } });
}

describe("read-only attachment-probe catalog", () => {
	test("the catalog holds exactly the named cases", () => {
		expect(ATTACHMENT_PROBE_CASES.map((probeCase) => probeCase.id)).toEqual(
			CASE_IDS,
		);
	});

	test("the read-only allowlist matches its independently restated oracle", () => {
		const tokens = new Set<string>();
		for (const probeCase of ATTACHMENT_PROBE_CASES) {
			for (const token of probeCase.nativeArgs) tokens.add(token);
		}
		for (const token of tokens) {
			expect(EXPECTED_READ_ONLY_TOKENS).toContain(token);
		}
	});

	test("every catalog case is read-only", () => {
		for (const probeCase of ATTACHMENT_PROBE_CASES) {
			expect(isReadOnlyNativeArgs(probeCase.nativeArgs)).toBe(true);
		}
	});

	test("the adoption sequence adopts unpinned, then pins the same shape", () => {
		// Independent oracle: the ordered sequence, written by hand. Step 1 must
		// NOT pin — a pinned session with no binding opens a fresh tab instead of
		// adopting the existing current tab.
		expect([...CURRENT_TAB_ADOPTION_SEQUENCE]).toEqual([
			"adopted-current-tab-inventory",
			"pinned-current-tab-inventory",
		]);
		const adopt = caseById("adopted-current-tab-inventory");
		const pin = caseById("pinned-current-tab-inventory");
		expect(adopt.strictTabBinding).toBe(false);
		expect(pin.strictTabBinding).toBe(true);
		expect(adopt.requiresEndpoint).toBe(true);
		expect(pin.requiresEndpoint).toBe(true);
		expect([...adopt.nativeArgs]).toEqual(["tab", "list", "--json"]);
		expect([...pin.nativeArgs]).toEqual([...adopt.nativeArgs]);
	});

	test("page-requiring and tab-mutating verbs are unreachable", () => {
		// Independent oracle: the verbs this harness must never be able to emit.
		for (const verb of ["open", "get", "new", "close", "screenshot", "eval", "reload"]) {
			expect(isReadOnlyNativeArgs([verb])).toBe(false);
		}
	});
});

describe("attachment-probe argv", () => {
	test("session-inventory builds the browser-free argv", () => {
		const built = buildAttachmentProbeArgv({
			probeCase: caseById("session-inventory"),
			sessionName: "probe-session",
		});
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		expect(built.argv).toEqual(EXPECTED_ARGV["session-inventory"] ?? []);
	});

	test("adopted-current-tab-inventory attaches unpinned so it can adopt", () => {
		const built = buildAttachmentProbeArgv({
			probeCase: caseById("adopted-current-tab-inventory"),
			sessionName: "probe-session",
			endpointWs: "<endpoint>",
		});
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		expect(built.argv).toEqual(
			EXPECTED_ARGV["adopted-current-tab-inventory"] ?? [],
		);
		expect(built.argv).not.toContain("--pin-tab");
		expect(built.argv).not.toContain("get");
		expect(built.argv).not.toContain("open");
	});

	test("pinned-current-tab-inventory requests the pin and never requests a page", () => {
		const built = buildAttachmentProbeArgv({
			probeCase: caseById("pinned-current-tab-inventory"),
			sessionName: "probe-session",
			endpointWs: "<endpoint>",
		});
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		expect(built.argv).toEqual(
			EXPECTED_ARGV["pinned-current-tab-inventory"] ?? [],
		);
		expect(built.argv).toContain("--pin-tab");
		expect(built.argv).not.toContain("get");
		expect(built.argv).not.toContain("open");
	});

	test("an endpoint-requiring case refuses without an endpoint", () => {
		const built = buildAttachmentProbeArgv({
			probeCase: caseById("pinned-current-tab-inventory"),
			sessionName: "probe-session",
		});
		expect(built).toEqual({ ok: false, code: "endpoint_required" });
	});

	test("a browser-free case refuses an endpoint", () => {
		const built = buildAttachmentProbeArgv({
			probeCase: caseById("session-inventory"),
			sessionName: "probe-session",
			endpointWs: "<endpoint>",
		});
		expect(built).toEqual({ ok: false, code: "endpoint_forbidden" });
	});

	test("an unsafe session name refuses before argv exists", () => {
		const built = buildAttachmentProbeArgv({
			probeCase: caseById("session-inventory"),
			sessionName: "probe session; rm -rf /",
		});
		expect(built).toEqual({ ok: false, code: "unsafe_session_name" });
	});

	test("a case outside the catalog refuses", () => {
		const built = buildAttachmentProbeArgv({
			probeCase: {
				...caseById("session-inventory"),
				id: "not-in-catalog" as AttachmentProbeCase["id"],
			},
			sessionName: "probe-session",
		});
		expect(built).toEqual({ ok: false, code: "unknown_probe_case" });
	});

	test("a mutating case cannot produce argv", () => {
		// The guard is reached through the catalog, so mutate the catalog entry's
		// native args in place of admitting a mutating case.
		const probeCase = caseById("session-inventory");
		const mutating: AttachmentProbeCase = {
			...probeCase,
			nativeArgs: ["tab", "new", "--json"],
		};
		expect(isReadOnlyNativeArgs(mutating.nativeArgs)).toBe(false);
	});
});

describe("attachment-probe classification", () => {
	const pinned = caseById("pinned-current-tab-inventory");

	test("a returned tab inventory inside the bound is confirmed", () => {
		const outcome = classifyAttachmentProbeResult({
			probeCase: pinned,
			exitCode: 0,
			stdout: tabEnvelope([{ tabId: "t1", targetId: "A1", active: true }]),
			timedOut: false,
			durationMs: 180,
			boundMs: 8000,
		});
		expect(outcome.ok).toBe(true);
		expect(outcome.code).toBe("attachment_read_only_confirmed");
		expect(outcome.boundVerdict).toBe("within_bound");
	});

	test("a slow success is confirmed but reported as exceeding the bound", () => {
		const outcome = classifyAttachmentProbeResult({
			probeCase: pinned,
			exitCode: 0,
			stdout: tabEnvelope([{ tabId: "t1", targetId: "A1", active: true }]),
			timedOut: false,
			durationMs: 13_000,
			boundMs: 8000,
		});
		expect(outcome.ok).toBe(true);
		expect(outcome.boundVerdict).toBe("exceeded_bound");
	});

	test("a timeout is its own meaning", () => {
		const outcome = classifyAttachmentProbeResult({
			probeCase: pinned,
			exitCode: null,
			stdout: "",
			timedOut: true,
			durationMs: 8000,
			boundMs: 8000,
		});
		expect(outcome.code).toBe("attachment_probe_timed_out");
	});

	test("tab_gone is a fail-closed refusal, not an adopted tab", () => {
		const outcome = classifyAttachmentProbeResult({
			probeCase: pinned,
			exitCode: 1,
			stdout: JSON.stringify({
				success: false,
				code: "tab_gone",
				data: { targetId: "A1" },
			}),
			timedOut: false,
			durationMs: 120,
			boundMs: 8000,
		});
		expect(outcome.code).toBe("strict_pin_tab_gone");
	});

	test("a non-zero exit is a command failure", () => {
		const outcome = classifyAttachmentProbeResult({
			probeCase: pinned,
			exitCode: 1,
			stdout: JSON.stringify({ success: false, error: "nope" }),
			timedOut: false,
			durationMs: 120,
			boundMs: 8000,
		});
		expect(outcome.code).toBe("attachment_probe_command_failed");
	});

	test("unparseable stdout is an invalid envelope", () => {
		const outcome = classifyAttachmentProbeResult({
			probeCase: pinned,
			exitCode: 0,
			stdout: "Unsupported engine WARN\n{\"success\":true}",
			timedOut: false,
			durationMs: 120,
			boundMs: 8000,
		});
		expect(outcome.code).toBe("attachment_probe_invalid_envelope");
	});

	test("the wrong envelope shape for the case is an invalid envelope", () => {
		const outcome = classifyAttachmentProbeResult({
			probeCase: pinned,
			exitCode: 0,
			stdout: JSON.stringify({ success: true, data: { sessions: [] } }),
			timedOut: false,
			durationMs: 120,
			boundMs: 8000,
		});
		expect(outcome.code).toBe("attachment_probe_invalid_envelope");
	});
});

describe("current-tab identity", () => {
	test("exactly one active tab is an identity", () => {
		const summary = summarizeCurrentTabs([
			{ tabId: "t1", targetId: "A1", active: false },
			{ tabId: "t2", targetId: "A2", active: true },
		]);
		expect(summary.verdict).toBe("current_tab_identified");
		expect(summary.tab_count).toBe(2);
		expect(summary.active_tab_count).toBe(1);
		expect(summary.current_tab).toEqual({
			tab_id: "t2",
			canonical_target_id: "A2",
		});
	});

	test("two active tabs are ambiguous and carry no current tab", () => {
		const summary = summarizeCurrentTabs([
			{ tabId: "t1", targetId: "A1", active: true },
			{ tabId: "t2", targetId: "A2", active: true },
		]);
		expect(summary.verdict).toBe("current_tab_ambiguous");
		expect(summary.current_tab).toBeUndefined();
	});

	test("no active tab fails closed", () => {
		const summary = summarizeCurrentTabs([
			{ tabId: "t1", targetId: "A1", active: false },
		]);
		expect(summary.verdict).toBe("current_tab_absent");
		expect(summary.current_tab).toBeUndefined();
	});

	test("a duplicate target id fails closed", () => {
		const summary = summarizeCurrentTabs([
			{ tabId: "t1", targetId: "A1", active: true },
			{ tabId: "t2", targetId: "A1", active: false },
		]);
		expect(summary.verdict).toBe("target_identity_duplicate");
		expect(summary.current_tab).toBeUndefined();
	});

	test("an unsafe target id fails closed", () => {
		const summary = summarizeCurrentTabs([
			{ tabId: "t1", targetId: "A 1;rm", active: true },
		]);
		expect(summary.verdict).toBe("target_identity_unsafe");
		expect(summary.current_tab).toBeUndefined();
	});

	test("an empty inventory is its own verdict", () => {
		expect(summarizeCurrentTabs([]).verdict).toBe("tab_inventory_empty");
	});

	test("only an identified verdict ever carries a current tab", () => {
		// Independent oracle: the one verdict the gated live case accepts, and
		// the inventories that must not produce it. Written by hand.
		const inventories: readonly {
			verdict: string;
			tabs: readonly unknown[];
		}[] = [
			{
				verdict: "current_tab_identified",
				tabs: [{ tabId: "t1", targetId: "A1", active: true }],
			},
			{
				verdict: "current_tab_absent",
				tabs: [{ tabId: "t1", targetId: "A1", active: false }],
			},
			{
				verdict: "current_tab_ambiguous",
				tabs: [
					{ tabId: "t1", targetId: "A1", active: true },
					{ tabId: "t2", targetId: "A2", active: true },
				],
			},
			{ verdict: "tab_inventory_empty", tabs: [] },
			{
				verdict: "target_identity_duplicate",
				tabs: [
					{ tabId: "t1", targetId: "A1", active: true },
					{ tabId: "t2", targetId: "A1", active: false },
				],
			},
			{
				verdict: "target_identity_unsafe",
				tabs: [{ tabId: "t1", targetId: "A 1;rm", active: true }],
			},
		];
		for (const inventory of inventories) {
			const summary = summarizeCurrentTabs(inventory.tabs);
			expect(summary.verdict).toBe(inventory.verdict as never);
			expect(summary.current_tab !== undefined).toBe(
				inventory.verdict === "current_tab_identified",
			);
		}
	});

	test("the summary leaks no url or title bytes", () => {
		const summary = summarizeCurrentTabs([
			{
				tabId: "t1",
				targetId: "A1",
				active: true,
				url: "http://127.0.0.1:43150/?SENTINEL_URL_LEAK",
				title: "SENTINEL_TITLE_LEAK",
			},
		]);
		expect(summary.verdict).toBe("current_tab_identified");
		const serialized = JSON.stringify(summary);
		expect(serialized).not.toContain("SENTINEL_URL_LEAK");
		expect(serialized).not.toContain("SENTINEL_TITLE_LEAK");
		expect(serialized).not.toContain("43150");
	});
});

// ---------------------------------------------------------------------------
// Process-boundary shape, proven through the injectable runner.
// ---------------------------------------------------------------------------

type RecordedCall = {
	command: string;
	args: readonly string[];
	env: Readonly<Record<string, string>>;
	timeoutMs: number;
};

function fakeRunner(
	replies: readonly AttachmentProbeCommandResult[],
): { runCommand: AttachmentProbeCommandRunner; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	let index = 0;
	return {
		calls,
		runCommand: async (input) => {
			calls.push(input);
			const reply = replies[index];
			index += 1;
			return (
				reply ?? { exitCode: 1, stdout: "", stderr: "no reply", timedOut: false }
			);
		},
	};
}

const OK_TABS: AttachmentProbeCommandResult = {
	exitCode: 0,
	stdout: JSON.stringify({
		success: true,
		data: { tabs: [{ tabId: "t1", targetId: "A1", active: true }] },
	}),
	stderr: "",
	timedOut: false,
};

describe("attachment probe at the injected command boundary", () => {
	test("the executed argv is the argv the fixture table pins", async () => {
		const runner = fakeRunner([OK_TABS]);
		const result = await runAttachmentProbe({
			runCommand: runner.runCommand,
			executable: "/abs/agent-browser",
			probeCase: caseById("pinned-current-tab-inventory"),
			sessionName: "probe-session",
			endpointWs: "<endpoint>",
			socketDir: "/tmp/probe-sock",
			boundMs: 8000,
			timeoutMs: 25_000,
		});
		expect(result.stage).toBe("command");
		expect(result.ok).toBe(true);
		expect(runner.calls).toHaveLength(1);
		expect(runner.calls[0]?.command).toBe("/abs/agent-browser");
		expect(runner.calls[0]?.args).toEqual(
			EXPECTED_ARGV["pinned-current-tab-inventory"] ?? [],
		);
	});

	test("the probe runs in an isolated, non-keepalive daemon namespace", async () => {
		const runner = fakeRunner([OK_TABS]);
		await runAttachmentProbe({
			runCommand: runner.runCommand,
			executable: "/abs/agent-browser",
			probeCase: caseById("pinned-current-tab-inventory"),
			sessionName: "probe-session",
			endpointWs: "<endpoint>",
			socketDir: "/tmp/probe-sock",
			boundMs: 8000,
			timeoutMs: 25_000,
		});
		expect(runner.calls[0]?.env).toEqual({
			AGENT_BROWSER_SOCKET_DIR: "/tmp/probe-sock",
			MCPORTER_NO_KEEPALIVE: "*",
		});
	});

	test("an argv refusal never reaches the command boundary", async () => {
		const runner = fakeRunner([OK_TABS]);
		const result = await runAttachmentProbe({
			runCommand: runner.runCommand,
			executable: "/abs/agent-browser",
			probeCase: caseById("pinned-current-tab-inventory"),
			sessionName: "probe-session",
			socketDir: "/tmp/probe-sock",
			boundMs: 8000,
			timeoutMs: 25_000,
		});
		expect(result).toEqual({
			stage: "argv",
			ok: false,
			code: "endpoint_required",
		});
		expect(runner.calls).toHaveLength(0);
	});

	test("the measured duration decides the bound verdict", async () => {
		const runner = fakeRunner([OK_TABS]);
		let clock = 1000;
		const result = await runAttachmentProbe({
			runCommand: runner.runCommand,
			executable: "/abs/agent-browser",
			probeCase: caseById("pinned-current-tab-inventory"),
			sessionName: "probe-session",
			endpointWs: "<endpoint>",
			socketDir: "/tmp/probe-sock",
			boundMs: 8000,
			timeoutMs: 25_000,
			now: () => {
				const value = clock;
				clock += 13_000;
				return value;
			},
		});
		expect(result.stage).toBe("command");
		if (result.stage !== "command") return;
		expect(result.ok).toBe(true);
		expect(result.boundVerdict).toBe("exceeded_bound");
	});
});

describe("attachment probe custody release", () => {
	const closedOk: AttachmentProbeCommandResult = {
		exitCode: 0,
		stdout: JSON.stringify({ success: true, data: { closed: true } }),
		stderr: "",
		timedOut: false,
	};

	test("release is proven by the independent inventory read", async () => {
		const runner = fakeRunner([
			closedOk,
			{
				exitCode: 0,
				stdout: JSON.stringify({ success: true, data: { sessions: [] } }),
				stderr: "",
				timedOut: false,
			},
		]);
		const release = await releaseAttachmentProbeSession({
			runCommand: runner.runCommand,
			executable: "/abs/agent-browser",
			sessionName: "probe-session",
			socketDir: "/tmp/probe-sock",
			timeoutMs: 30_000,
		});
		expect(release).toEqual({
			released: true,
			closeAcknowledged: true,
			sessionsRemaining: 0,
		});
		expect(runner.calls[0]?.args).toEqual([
			"--session",
			"probe-session",
			"close",
			"--json",
		]);
		expect(runner.calls[1]?.args).toEqual(["session", "list", "--json"]);
	});

	test("an acknowledged close that leaves the session behind is not released", async () => {
		const runner = fakeRunner([
			closedOk,
			{
				exitCode: 0,
				stdout: JSON.stringify({
					success: true,
					data: { sessions: ["probe-session"] },
				}),
				stderr: "",
				timedOut: false,
			},
		]);
		const release = await releaseAttachmentProbeSession({
			runCommand: runner.runCommand,
			executable: "/abs/agent-browser",
			sessionName: "probe-session",
			socketDir: "/tmp/probe-sock",
			timeoutMs: 30_000,
		});
		expect(release.closeAcknowledged).toBe(true);
		expect(release.released).toBe(false);
		expect(release.sessionsRemaining).toBe(1);
	});
});

describe("stable target identity", () => {
	// Independent oracle: hand-written inventories, expectations, and the verdict
	// each pair must produce. Never derived by calling the module.
	const IDENTITY_CASES: readonly {
		name: string;
		tabs: readonly unknown[];
		expectedTargetId: string;
		verdict: string;
	}[] = [
		{
			name: "a safe, unchanged identity is stable",
			tabs: [
				{ tabId: "t1", targetId: "A1", active: true },
				{ tabId: "t2", targetId: "A2", active: false },
			],
			expectedTargetId: "A1",
			verdict: "target_identity_stable",
		},
		{
			name: "a different current tab is changed, never adopted",
			tabs: [
				{ tabId: "t1", targetId: "A1", active: false },
				{ tabId: "t2", targetId: "A2", active: true },
			],
			expectedTargetId: "A1",
			verdict: "target_identity_changed",
		},
		{
			name: "no active tab is absent",
			tabs: [{ tabId: "t1", targetId: "A1", active: false }],
			expectedTargetId: "A1",
			verdict: "target_identity_absent",
		},
		{
			name: "an empty inventory is absent",
			tabs: [],
			expectedTargetId: "A1",
			verdict: "target_identity_absent",
		},
		{
			name: "more than one active tab is ambiguous",
			tabs: [
				{ tabId: "t1", targetId: "A1", active: true },
				{ tabId: "t2", targetId: "A2", active: true },
			],
			expectedTargetId: "A1",
			verdict: "target_identity_ambiguous",
		},
		{
			name: "an unsafe observed identity is unsafe",
			tabs: [{ tabId: "t1", targetId: "A 1;rm", active: true }],
			expectedTargetId: "A1",
			verdict: "target_identity_unsafe",
		},
		{
			name: "an unsafe expectation is unsafe",
			tabs: [{ tabId: "t1", targetId: "A1", active: true }],
			expectedTargetId: "A 1;rm",
			verdict: "target_identity_unsafe",
		},
		{
			name: "a duplicate canonical id is unsafe",
			tabs: [
				{ tabId: "t1", targetId: "A1", active: true },
				{ tabId: "t2", targetId: "A1", active: false },
			],
			expectedTargetId: "A1",
			verdict: "target_identity_unsafe",
		},
	];

	for (const identityCase of IDENTITY_CASES) {
		test(identityCase.name, () => {
			const result = verifyStableTargetIdentity({
				tabs: identityCase.tabs,
				expectedTargetId: identityCase.expectedTargetId,
			});
			expect(result.verdict).toBe(identityCase.verdict as never);
		});
	}

	test("only a stable verdict hands back an identity", () => {
		for (const identityCase of IDENTITY_CASES) {
			const result = verifyStableTargetIdentity({
				tabs: identityCase.tabs,
				expectedTargetId: identityCase.expectedTargetId,
			});
			expect(result.current_tab !== undefined).toBe(
				identityCase.verdict === "target_identity_stable",
			);
		}
	});

	test("a stable verdict returns the expected identity and no page content", () => {
		const result = verifyStableTargetIdentity({
			tabs: [
				{
					tabId: "t1",
					targetId: "A1",
					active: true,
					url: "http://127.0.0.1:43150/?SENTINEL_URL_LEAK",
					title: "SENTINEL_TITLE_LEAK",
				},
			],
			expectedTargetId: "A1",
		});
		expect(result.verdict).toBe("target_identity_stable");
		expect(result.current_tab).toEqual({
			tab_id: "t1",
			canonical_target_id: "A1",
		});
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("SENTINEL_URL_LEAK");
		expect(serialized).not.toContain("SENTINEL_TITLE_LEAK");
	});
});

describe("ordered custody cleanup", () => {
	const closedOk: AttachmentProbeCommandResult = {
		exitCode: 0,
		stdout: JSON.stringify({ success: true, data: { closed: true } }),
		stderr: "",
		timedOut: false,
	};

	function inventory(sessions: readonly string[]): AttachmentProbeCommandResult {
		return {
			exitCode: 0,
			stdout: JSON.stringify({ success: true, data: { sessions } }),
			stderr: "",
			timedOut: false,
		};
	}

	test("the socket directory is removed only after release is proven", async () => {
		const runner = fakeRunner([closedOk, inventory([])]);
		const removed: string[] = [];
		const custody = await releaseAttachmentProbeCustody({
			runCommand: runner.runCommand,
			executable: "/abs/agent-browser",
			sessionName: "probe-session",
			socketDir: "/tmp/probe-sock",
			timeoutMs: 30_000,
			removeSocketDir: (dir) => {
				// The independent inventory read must already have happened.
				expect(runner.calls).toHaveLength(2);
				removed.push(dir);
			},
		});
		expect(custody.released).toBe(true);
		expect(custody.socketDirRemoved).toBe(true);
		expect(custody.retainedSocketDir).toBeUndefined();
		expect(removed).toEqual(["/tmp/probe-sock"]);
	});

	test("inventory-proven release survives a missing close acknowledgement", async () => {
		const runner = fakeRunner([
			{ exitCode: 1, stdout: "", stderr: "", timedOut: false },
			inventory([]),
		]);
		const removed: string[] = [];
		const custody = await releaseAttachmentProbeCustody({
			runCommand: runner.runCommand,
			executable: "/abs/agent-browser",
			sessionName: "probe-session",
			socketDir: "/tmp/probe-sock",
			timeoutMs: 30_000,
			removeSocketDir: (dir) => removed.push(dir),
		});
		expect(custody).toEqual({
			released: true,
			closeAcknowledged: false,
			sessionsRemaining: 0,
			socketDirRemoved: true,
		});
		expect(removed).toEqual(["/tmp/probe-sock"]);
	});

	test("a failed release keeps the socket directory for its owner", async () => {
		const runner = fakeRunner([closedOk, inventory(["probe-session"])]);
		const removed: string[] = [];
		const custody = await releaseAttachmentProbeCustody({
			runCommand: runner.runCommand,
			executable: "/abs/agent-browser",
			sessionName: "probe-session",
			socketDir: "/tmp/probe-sock",
			timeoutMs: 30_000,
			removeSocketDir: (dir) => removed.push(dir),
		});
		expect(custody.released).toBe(false);
		expect(custody.socketDirRemoved).toBe(false);
		expect(custody.retainedSocketDir).toBe("/tmp/probe-sock");
		expect(removed).toEqual([]);
	});

	test("an unreadable inventory keeps the socket directory", async () => {
		const runner = fakeRunner([
			closedOk,
			{ exitCode: 1, stdout: "", stderr: "daemon busy", timedOut: false },
		]);
		const removed: string[] = [];
		const custody = await releaseAttachmentProbeCustody({
			runCommand: runner.runCommand,
			executable: "/abs/agent-browser",
			sessionName: "probe-session",
			socketDir: "/tmp/probe-sock",
			timeoutMs: 30_000,
			removeSocketDir: (dir) => removed.push(dir),
		});
		expect(custody.released).toBe(false);
		expect(custody.sessionsRemaining).toBeNull();
		expect(custody.retainedSocketDir).toBe("/tmp/probe-sock");
		expect(removed).toEqual([]);
	});

	test("a removal that fails is reported, not assumed", async () => {
		const runner = fakeRunner([closedOk, inventory([])]);
		const custody = await releaseAttachmentProbeCustody({
			runCommand: runner.runCommand,
			executable: "/abs/agent-browser",
			sessionName: "probe-session",
			socketDir: "/tmp/probe-sock",
			timeoutMs: 30_000,
			removeSocketDir: () => {
				throw new Error("EBUSY");
			},
		});
		expect(custody.released).toBe(true);
		expect(custody.socketDirRemoved).toBe(false);
		expect(custody.retainedSocketDir).toBe("/tmp/probe-sock");
	});
});

describe("two-step adopted identity", () => {
	function inventoryOf(
		rows: readonly unknown[],
	): ReturnType<typeof summarizeCurrentTabs> {
		return summarizeCurrentTabs(rows);
	}

	const ADOPTED = [{ tabId: "t1", targetId: "A1", active: true }];

	// Independent oracle: hand-written step pairs and the verdict each must
	// produce. Only an unchanged tab_id AND canonical_target_id may hold.
	const PAIRS: readonly {
		name: string;
		first: readonly unknown[];
		second: readonly unknown[];
		verdict: string;
	}[] = [
		{
			name: "the same tab id and target id hold the adoption",
			first: ADOPTED,
			second: [{ tabId: "t1", targetId: "A1", active: true }],
			verdict: "identity_held",
		},
		{
			name: "a different canonical target id is a changed target",
			first: ADOPTED,
			second: [{ tabId: "t1", targetId: "A2", active: true }],
			verdict: "identity_target_changed",
		},
		{
			name: "the same target under a different tab ref is not the same binding",
			first: ADOPTED,
			second: [{ tabId: "t7", targetId: "A1", active: true }],
			verdict: "identity_tab_ref_changed",
		},
		{
			name: "an unidentified first step never holds",
			first: [{ tabId: "t1", targetId: "A1", active: false }],
			second: ADOPTED,
			verdict: "identity_not_identified",
		},
		{
			name: "an ambiguous second step never holds",
			first: ADOPTED,
			second: [
				{ tabId: "t1", targetId: "A1", active: true },
				{ tabId: "t2", targetId: "A2", active: true },
			],
			verdict: "identity_not_identified",
		},
		{
			name: "an empty second step never holds",
			first: ADOPTED,
			second: [],
			verdict: "identity_not_identified",
		},
		{
			name: "an unsafe second step never holds",
			first: ADOPTED,
			second: [{ tabId: "t1", targetId: "A 1;rm", active: true }],
			verdict: "identity_not_identified",
		},
	];

	for (const pair of PAIRS) {
		test(pair.name, () => {
			const result = compareCurrentTabIdentity({
				first: inventoryOf(pair.first),
				second: inventoryOf(pair.second),
			});
			expect(result.verdict).toBe(pair.verdict as never);
		});
	}

	test("only a held adoption hands back an identity", () => {
		for (const pair of PAIRS) {
			const result = compareCurrentTabIdentity({
				first: inventoryOf(pair.first),
				second: inventoryOf(pair.second),
			});
			expect(result.identity !== undefined).toBe(
				pair.verdict === "identity_held",
			);
		}
	});

	test("a held adoption returns both ids and no page content", () => {
		const result = compareCurrentTabIdentity({
			first: inventoryOf([
				{
					tabId: "t1",
					targetId: "A1",
					active: true,
					url: "http://127.0.0.1:43150/?SENTINEL_URL_LEAK",
					title: "SENTINEL_TITLE_LEAK",
				},
			]),
			second: inventoryOf(ADOPTED),
		});
		expect(result.verdict).toBe("identity_held");
		expect(result.identity).toEqual({
			tab_id: "t1",
			canonical_target_id: "A1",
		});
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("SENTINEL_URL_LEAK");
		expect(serialized).not.toContain("SENTINEL_TITLE_LEAK");
	});
});

describe("sanitized failure projection", () => {
	function commandResult(
		input: Parameters<typeof classifyAttachmentProbeResult>[0],
	): Parameters<typeof attachmentProbeDiagnostic>[0] {
		return { stage: "command", ...classifyAttachmentProbeResult(input) };
	}

	const pinned = caseById("pinned-current-tab-inventory");

	// Independent oracle: every failure class this harness can produce, and the
	// exact deterministic metadata each must project. Hand-written.
	const FAILURE_CLASSES: readonly {
		name: string;
		exitCode: number | null;
		stdout: string;
		timedOut: boolean;
		durationMs: number;
		expected: Record<string, unknown>;
	}[] = [
		{
			name: "timeout",
			exitCode: null,
			stdout: "",
			timedOut: true,
			durationMs: 25_000,
			expected: {
				stage: "command",
				ok: false,
				code: "attachment_probe_timed_out",
				bound_verdict: "exceeded_bound",
				exit_status: null,
			},
		},
		{
			name: "strict pin refusal",
			exitCode: 1,
			stdout: JSON.stringify({ success: false, code: "tab_gone" }),
			timedOut: false,
			durationMs: 120,
			expected: {
				stage: "command",
				ok: false,
				code: "strict_pin_tab_gone",
				bound_verdict: "within_bound",
				exit_status: 1,
			},
		},
		{
			name: "command failure",
			exitCode: 2,
			stdout: JSON.stringify({ success: false }),
			timedOut: false,
			durationMs: 120,
			expected: {
				stage: "command",
				ok: false,
				code: "attachment_probe_command_failed",
				bound_verdict: "within_bound",
				exit_status: 2,
			},
		},
		{
			name: "invalid envelope",
			exitCode: 0,
			stdout: "not json",
			timedOut: false,
			durationMs: 120,
			expected: {
				stage: "command",
				ok: false,
				code: "attachment_probe_invalid_envelope",
				bound_verdict: "within_bound",
				exit_status: 0,
			},
		},
		{
			name: "success past the bound",
			exitCode: 0,
			stdout: JSON.stringify({
				success: true,
				data: { tabs: [{ tabId: "t1", targetId: "A1", active: true }] },
			}),
			timedOut: false,
			durationMs: 13_000,
			expected: {
				stage: "command",
				ok: true,
				code: "attachment_read_only_confirmed",
				bound_verdict: "exceeded_bound",
				exit_status: 0,
			},
		},
	];

	for (const failureClass of FAILURE_CLASSES) {
		test(`${failureClass.name} is visible in the projection`, () => {
			const diagnostic = attachmentProbeDiagnostic(
				commandResult({
					probeCase: pinned,
					exitCode: failureClass.exitCode,
					stdout: failureClass.stdout,
					timedOut: failureClass.timedOut,
					durationMs: failureClass.durationMs,
					boundMs: 8000,
				}),
			);
			expect(diagnostic).toEqual(failureClass.expected as never);
		});
	}

	test("an argv refusal is visible without its rejected input", () => {
		const diagnostic = attachmentProbeDiagnostic({
			stage: "argv",
			ok: false,
			code: "unsafe_session_name",
		});
		expect(diagnostic).toEqual({
			stage: "argv",
			ok: false,
			code: "unsafe_session_name",
			bound_verdict: null,
			exit_status: null,
		});
	});

	test("an exotic exit status is narrowed away, never printed", () => {
		for (const exitCode of [-1, 256, 1.5, Number.NaN]) {
			const diagnostic = attachmentProbeDiagnostic(
				commandResult({
					probeCase: pinned,
					exitCode,
					stdout: "not json",
					timedOut: false,
					durationMs: 120,
					boundMs: 8000,
				}),
			);
			expect(diagnostic.exit_status).toBeNull();
		}
	});
});

describe("failure projections cannot leak", () => {
	// Independent oracle: one sentinel per forbidden channel.
	const SENTINELS = [
		"SENTINELSTDOUT",
		"SENTINELSTDERR",
		"SENTINELENDPOINT",
		"SENTINELSESSION",
		"SENTINELSOCKET",
		"SENTINELURL",
		"SENTINELTITLE",
	];

	function sentinelStdout(success: boolean): string {
		return JSON.stringify({
			success,
			note: "SENTINELSTDOUT",
			data: {
				tabs: [
					{
						tabId: "t1",
						targetId: "A1",
						active: true,
						url: "http://127.0.0.1:43150/SENTINELURL",
						title: "SENTINELTITLE",
					},
				],
			},
		});
	}

	async function probeWithSentinels(
		reply: AttachmentProbeCommandResult,
	): Promise<string> {
		const runner = fakeRunner([reply]);
		const result = await runAttachmentProbe({
			runCommand: runner.runCommand,
			executable: "/abs/agent-browser",
			probeCase: caseById("pinned-current-tab-inventory"),
			sessionName: "SENTINELSESSION",
			endpointWs: "ws://SENTINELENDPOINT/devtools/browser/x",
			socketDir: "/tmp/SENTINELSOCKET",
			boundMs: 8000,
			timeoutMs: 25_000,
		});
		return JSON.stringify(attachmentProbeDiagnostic(result));
	}

	const REPLIES: readonly {
		name: string;
		reply: AttachmentProbeCommandResult;
	}[] = [
		{
			name: "success",
			reply: {
				exitCode: 0,
				stdout: sentinelStdout(true),
				stderr: "SENTINELSTDERR",
				timedOut: false,
			},
		},
		{
			name: "command failure",
			reply: {
				exitCode: 1,
				stdout: sentinelStdout(false),
				stderr: "SENTINELSTDERR",
				timedOut: false,
			},
		},
		{
			name: "invalid envelope",
			reply: {
				exitCode: 0,
				stdout: "SENTINELSTDOUT not json",
				stderr: "SENTINELSTDERR",
				timedOut: false,
			},
		},
		{
			name: "timeout",
			reply: {
				exitCode: null,
				stdout: "SENTINELSTDOUT",
				stderr: "SENTINELSTDERR",
				timedOut: true,
			},
		},
		{
			name: "strict pin refusal",
			reply: {
				exitCode: 1,
				stdout: JSON.stringify({
					success: false,
					code: "tab_gone",
					data: { targetId: "A1", lastUrl: "http://x/SENTINELURL" },
				}),
				stderr: "SENTINELSTDERR",
				timedOut: false,
			},
		},
	];

	for (const replyCase of REPLIES) {
		test(`${replyCase.name} projects no sentinel bytes`, async () => {
			const serialized = await probeWithSentinels(replyCase.reply);
			for (const sentinel of SENTINELS) {
				expect(serialized).not.toContain(sentinel);
			}
			expect(serialized).not.toContain("43150");
			expect(serialized).not.toContain("://");
		});
	}

	test("an argv refusal projects no sentinel session name", async () => {
		const runner = fakeRunner([]);
		const result = await runAttachmentProbe({
			runCommand: runner.runCommand,
			executable: "/abs/agent-browser",
			probeCase: caseById("pinned-current-tab-inventory"),
			sessionName: "SENTINELSESSION not safe",
			endpointWs: "ws://SENTINELENDPOINT/x",
			socketDir: "/tmp/SENTINELSOCKET",
			boundMs: 8000,
			timeoutMs: 25_000,
		});
		expect(runner.calls).toHaveLength(0);
		const serialized = JSON.stringify(attachmentProbeDiagnostic(result));
		expect(serialized).toContain("unsafe_session_name");
		for (const sentinel of SENTINELS) {
			expect(serialized).not.toContain(sentinel);
		}
	});

	test("a retained socket path never reaches the custody projection", () => {
		const serialized = JSON.stringify(
			attachmentProbeCustodyDiagnostic({
				released: false,
				closeAcknowledged: true,
				sessionsRemaining: 1,
				socketDirRemoved: false,
				retainedSocketDir: "/tmp/SENTINELSOCKET",
			}),
		);
		expect(serialized).toContain('"socket_dir_retained":true');
		expect(serialized).not.toContain("SENTINELSOCKET");
		expect(serialized).not.toContain("/tmp");
	});

	test("the tab projection carries no inventory detail", () => {
		const serialized = JSON.stringify(
			currentTabDiagnostic(
				summarizeCurrentTabs([
					{
						tabId: "t1",
						targetId: "A1",
						active: true,
						url: "http://127.0.0.1:43150/SENTINELURL",
						title: "SENTINELTITLE",
					},
				]),
			),
		);
		expect(serialized).toContain("current_tab_identified");
		for (const sentinel of SENTINELS) {
			expect(serialized).not.toContain(sentinel);
		}
		expect(serialized).not.toContain("A1");
	});
});

// ---------------------------------------------------------------------------
// Live read-only current-tab case.
//
// Explicitly gated: it attaches to real Warm Chrome, so it never runs as part
// of `bun test src`. Enable deliberately with
// `BROWSER_USE_ATTACHMENT_PROBE_LIVE=1`.
//
// The case opens no tab, navigates no tab, closes no tab, and mutates no tab
// or browser-wide state. Its only browser-facing acts are two `tab list` reads
// on one session: step 1 unpinned so the session adopts the tab that is already
// current, then step 2 pinned on that same session.
//
// Step 1 is deliberately NOT pinned. A pinned session with no binding is
// documented to open a fresh tab rather than adopt one, so pinning first could
// not identify the existing current tab and could create one.
//
// This is the only place adoption and first-attach binding are observed rather
// than assumed: the browser-free fixtures prove the argv, the classification,
// and the identity comparison, not what the adapter binds. Until this case has
// been run, that boundary is unproven.
//
// Releasing its own Agent Browser session afterwards is separate: that ends the
// probe's isolated daemon session, which is custody cleanup, not a tab close.
// ---------------------------------------------------------------------------

const LIVE_GATE = "BROWSER_USE_ATTACHMENT_PROBE_LIVE";
const LIVE = process.env[LIVE_GATE] === "1";
const AGENT_BROWSER = Bun.which("agent-browser");
const BROWSER_CONNECT = Bun.which("browser-connect");

function liveRunner(): AttachmentProbeCommandRunner {
	return async (input) => {
		const spawned = spawnSync(input.command, [...input.args], {
			encoding: "utf8",
			timeout: input.timeoutMs,
			env: { ...process.env, ...input.env },
		});
		return {
			exitCode: spawned.status,
			stdout: spawned.stdout ?? "",
			stderr: spawned.stderr ?? "",
			timedOut: spawned.error?.name === "Error" && spawned.signal !== null,
		};
	};
}

describe.skipIf(!LIVE || AGENT_BROWSER === null || BROWSER_CONNECT === null)(
	"live read-only current-tab identity",
	() => {
		test("adopts, then pins, the same current Warm Chrome tab", async () => {
			const adoptCase = caseById("adopted-current-tab-inventory");
			const pinCase = caseById("pinned-current-tab-inventory");
			// Runtime guard: never spawn a case the read-only allowlist rejects.
			expect(isReadOnlyNativeArgs(adoptCase.nativeArgs)).toBe(true);
			expect(isReadOnlyNativeArgs(pinCase.nativeArgs)).toBe(true);

			const check = spawnSync(BROWSER_CONNECT ?? "", ["check", "--json"], {
				encoding: "utf8",
				timeout: 30_000,
			});
			expect(check.status).toBe(0);
			const envelope = JSON.parse(check.stdout) as {
				data: { outcome: string; endpoint: { ws: string } };
			};
			expect(envelope.data.outcome).toBe("verified");

			const socketDir = mkdtempSync(join(tmpdir(), "browser-use-probe-"));
			chmodSync(socketDir, 0o700);
			// One session for BOTH steps: step 2 must pin what step 1 adopted.
			const sessionName = `browser-use-attachment-probe-${randomBytes(4).toString("hex")}`;
			const runCommand = liveRunner();
			const step = async (probeCase: typeof adoptCase) =>
				await runAttachmentProbe({
					runCommand,
					executable: AGENT_BROWSER ?? "",
					probeCase,
					sessionName,
					endpointWs: envelope.data.endpoint.ws,
					socketDir,
					boundMs: 8000,
					timeoutMs: 25_000,
				});
			try {
				// Step 1: unpinned, so the fresh session adopts the tab that is
				// already current instead of opening a new one.
				const adopted = await step(adoptCase);
				// Assert on the sanitized projection: a failing diff prints the
				// stage, typed code, bound verdict, and exit status, and nothing
				// else can reach the error message.
				expect(attachmentProbeDiagnostic(adopted)).toEqual({
					stage: "command",
					ok: true,
					code: "attachment_read_only_confirmed",
					bound_verdict: "within_bound",
					exit_status: 0,
				});
				if (!adopted.ok || adopted.stage !== "command") return;
				const first = summarizeCurrentTabs(adopted.data.tabs);
				expect(currentTabDiagnostic(first)).toEqual({
					verdict: "current_tab_identified",
					active_tab_count: 1,
				});

				// Step 2: same session, now pinned.
				const pinned = await step(pinCase);
				expect(attachmentProbeDiagnostic(pinned)).toEqual({
					stage: "command",
					ok: true,
					code: "attachment_read_only_confirmed",
					bound_verdict: "within_bound",
					exit_status: 0,
				});
				if (!pinned.ok || pinned.stage !== "command") return;
				const second = summarizeCurrentTabs(pinned.data.tabs);
				expect(currentTabDiagnostic(second)).toEqual({
					verdict: "current_tab_identified",
					active_tab_count: 1,
				});

				// Both tab_id and canonical_target_id must be unchanged: pinning
				// must not move, replace, or re-derive the adopted binding.
				const held = compareCurrentTabIdentity({ first, second });
				expect(held.verdict).toBe("identity_held");
				expect(held.identity).toBeDefined();
				expect(JSON.stringify(held)).not.toContain("http");
			} finally {
				// Ordered: the socket directory is removed only after the
				// independent inventory read proves the session is gone.
				const custody = await releaseAttachmentProbeCustody({
					runCommand,
					executable: AGENT_BROWSER ?? "",
					sessionName,
					socketDir,
					timeoutMs: 30_000,
					removeSocketDir: (dir) =>
						rmSync(dir, { recursive: true, force: true }),
				});
				const custodyDiagnostic = attachmentProbeCustodyDiagnostic(custody);
				expect(custodyDiagnostic).toMatchObject({
					released: true,
					sessions_remaining: 0,
					socket_dir_removed: true,
					socket_dir_retained: false,
				});
				expect(typeof custodyDiagnostic.close_acknowledged).toBe("boolean");
			}
		});
	},
);
