// ---------------------------------------------------------------------------
// Read-only Warm Chrome attachment-probe cases (single owner).
//
// Browser Connect's agent-browser attachment probe asks Agent Browser for the
// ACTIVE PAGE (`get cdp-url`). That request initialises a target-aware daemon,
// so a discarded or unresponsive renderer can burn renderer detection plus
// renderer revival before the command returns. Revival reloads the page, so
// that path is not read-only either. Browser Connect bounds the probe at
// PROBE_TIMEOUT_MS, which sits below that recovery path.
//
// This module owns the read-only alternative: named cases that prove
// attachment and identify the CURRENT TABS without ever requesting the active
// page.
//
// Why identifying the current tab is a TWO-STEP sequence. A pinned session
// with no binding is documented to open a fresh tab rather than adopt an
// existing one. Pinning on the first command therefore cannot identify the tab
// the user already has open, and risks creating one. So:
//
//   step 1  unpinned `tab list`  -> the session adopts the existing current tab
//   step 2  pinned   `tab list`  -> the same session makes that binding strict
//
// Both steps run on the SAME session, and the adoption only counts when both
// steps identify exactly one current tab with an equal `tab_id` AND an equal
// `canonical_target_id`. Neither step requests the active page, so neither can
// enter the detect-then-revive path.
//
// What this harness proves browser-free is the argv, the classification, and
// the identity comparison. What the adapter actually binds on first attach is
// observed only by the env-gated live case, and is unproven until it is run.
//
// Harness owner only. It performs no I/O and spawns nothing, and nothing in
// the sealed qualification runtime closure imports it. Adding a case is one
// entry in ATTACHMENT_PROBE_CASES plus, when the case needs a native token the
// allowlist does not yet carry, one reviewable edit to READ_ONLY_NATIVE_TOKENS.
// ---------------------------------------------------------------------------

import { SAFE_RUN_ID, SAFE_TAB_ID } from "./browser-use-identifiers";

/** Which success envelope shape a case returns. */
export type AttachmentProbeEnvelopeKind = "sessions" | "tabs";

/**
 * One named read-only attachment-probe case.
 *
 * `id` is a plain string here so the catalog below can be the single owner of
 * the case-id vocabulary; {@link AttachmentProbeCaseId} is derived from it.
 */
export type AttachmentProbeCase = {
	readonly id: string;
	readonly summary: string;
	/** True when the case must attach to the verified Warm Chrome endpoint. */
	readonly requiresEndpoint: boolean;
	/**
	 * True when the case passes `--pin-tab`. Deliberately false for the
	 * adoption step: a pinned session with no binding opens a fresh tab instead
	 * of adopting the existing current tab. This selects the flag; it does not
	 * by itself establish what the adapter binds.
	 */
	readonly strictTabBinding: boolean;
	/** Native argv after the session flags. */
	readonly nativeArgs: readonly string[];
	readonly envelopeKind: AttachmentProbeEnvelopeKind;
};

/**
 * Sealed allowlist of native argv tokens a read-only case may use.
 *
 * An allowlist, not a denylist: a case that needs a new verb fails closed until
 * the token is admitted here by a reviewer. `tab new`, `tab close`, `open`,
 * `get`, `screenshot`, and every other state-changing or page-requiring verb
 * are therefore unreachable by construction.
 */
export const READ_ONLY_NATIVE_TOKENS: readonly string[] = [
	"session",
	"tab",
	"list",
	"--json",
];

/**
 * The sealed catalog of read-only probe cases, and the only owner of the
 * case-id vocabulary. Extension point: add one entry here.
 */
export const ATTACHMENT_PROBE_CASES = [
	{
		id: "session-inventory",
		summary:
			"Prove the Agent Browser daemon answers without touching a browser.",
		requiresEndpoint: false,
		strictTabBinding: false,
		nativeArgs: ["session", "list", "--json"],
		envelopeKind: "sessions",
	},
	{
		id: "adopted-current-tab-inventory",
		summary:
			"Step 1: adopt and identify the existing current tab on a fresh session, without requesting the active page.",
		requiresEndpoint: true,
		strictTabBinding: false,
		nativeArgs: ["tab", "list", "--json"],
		envelopeKind: "tabs",
	},
	{
		id: "pinned-current-tab-inventory",
		summary:
			"Step 2: make the adopted binding strict on the same session, without requesting the active page.",
		requiresEndpoint: true,
		strictTabBinding: true,
		nativeArgs: ["tab", "list", "--json"],
		envelopeKind: "tabs",
	},
] as const satisfies readonly AttachmentProbeCase[];

/**
 * The ordered two-step live sequence, run on ONE session.
 *
 * Step 1 attaches unpinned so the session adopts the tab that is already
 * current. Step 2 pins that same session. Reversing the order would ask an
 * unbound pinned session for a tab list, which is the case the adapter answers
 * by opening a fresh tab.
 */
export const CURRENT_TAB_ADOPTION_SEQUENCE = [
	"adopted-current-tab-inventory",
	"pinned-current-tab-inventory",
] as const;

/** A case that is actually in the catalog. */
export type AttachmentProbeCatalogCase = (typeof ATTACHMENT_PROBE_CASES)[number];

/** The sealed case-id vocabulary, derived from its single catalog owner. */
export type AttachmentProbeCaseId = AttachmentProbeCatalogCase["id"];

/** Look one case up by id. */
export function attachmentProbeCase(
	id: string,
): AttachmentProbeCatalogCase | undefined {
	return ATTACHMENT_PROBE_CASES.find((probeCase) => probeCase.id === id);
}

/** True when every native token is admitted by the read-only allowlist. */
export function isReadOnlyNativeArgs(args: readonly string[]): boolean {
	return args.every((token) => READ_ONLY_NATIVE_TOKENS.includes(token));
}

/** Why an argv build refused. */
export type AttachmentProbeArgvRefusal =
	| "unknown_probe_case"
	| "unsafe_session_name"
	| "endpoint_required"
	| "endpoint_forbidden"
	| "mutating_probe_case";

export type AttachmentProbeArgvResult =
	| { readonly ok: true; readonly argv: readonly string[] }
	| { readonly ok: false; readonly code: AttachmentProbeArgvRefusal };

/**
 * Build the exact public Agent Browser argv for one read-only case.
 *
 * Flag order mirrors the shape Browser Use discovery already uses:
 * `--cdp <ws> --session <name> [--pin-tab] <native args>`.
 */
export function buildAttachmentProbeArgv(input: {
	readonly probeCase: AttachmentProbeCase;
	readonly sessionName: string;
	readonly endpointWs?: string;
}): AttachmentProbeArgvResult {
	const probeCase = attachmentProbeCase(input.probeCase.id);
	if (probeCase === undefined) return { ok: false, code: "unknown_probe_case" };
	if (!SAFE_RUN_ID.test(input.sessionName)) {
		return { ok: false, code: "unsafe_session_name" };
	}
	if (!isReadOnlyNativeArgs(probeCase.nativeArgs)) {
		return { ok: false, code: "mutating_probe_case" };
	}
	const endpoint = input.endpointWs;
	if (probeCase.requiresEndpoint && (endpoint === undefined || endpoint === "")) {
		return { ok: false, code: "endpoint_required" };
	}
	if (!probeCase.requiresEndpoint && endpoint !== undefined) {
		return { ok: false, code: "endpoint_forbidden" };
	}
	return {
		ok: true,
		argv: [
			...(probeCase.requiresEndpoint && endpoint !== undefined
				? ["--cdp", endpoint]
				: []),
			"--session",
			input.sessionName,
			...(probeCase.strictTabBinding ? ["--pin-tab"] : []),
			...probeCase.nativeArgs,
		],
	};
}

/** Whether the case returned inside the caller's probe bound. */
export type AttachmentProbeBoundVerdict = "within_bound" | "exceeded_bound";

/** Distinct public meanings for a read-only probe result. */
export type AttachmentProbeFailureCode =
	| "attachment_probe_timed_out"
	| "strict_pin_tab_gone"
	| "attachment_probe_command_failed"
	| "attachment_probe_invalid_envelope";

export type AttachmentProbeOutcome =
	| {
			readonly ok: true;
			readonly code: "attachment_read_only_confirmed";
			readonly durationMs: number;
			readonly boundVerdict: AttachmentProbeBoundVerdict;
			readonly exitStatus: number | null;
			readonly data: Record<string, unknown>;
	  }
	| {
			readonly ok: false;
			readonly code: AttachmentProbeFailureCode;
			readonly durationMs: number;
			readonly boundVerdict: AttachmentProbeBoundVerdict;
			readonly exitStatus: number | null;
	  };

/**
 * Narrow a raw child exit code to a safe, printable numeric status.
 *
 * Anything that is not an ordinary 0-255 process status becomes null, so a
 * hostile or exotic value can never reach a diagnostic string.
 */
function safeExitStatus(exitCode: number | null): number | null {
	return typeof exitCode === "number" &&
		Number.isInteger(exitCode) &&
		exitCode >= 0 &&
		exitCode <= 255
		? exitCode
		: null;
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function parseEnvelope(stdout: string): Record<string, unknown> | undefined {
	try {
		return jsonObject(JSON.parse(stdout));
	} catch {
		return undefined;
	}
}

/**
 * Classify one completed read-only probe.
 *
 * `strict_pin_tab_gone` is reported separately from a generic command failure.
 * The adapter emits `tab_gone` when a pinned session's bound tab is absent and
 * it refuses to fall back to another one, so it is a fail-closed refusal, never
 * evidence that the probe adopted a tab. It says nothing about how that binding
 * was established in the first place.
 */
export function classifyAttachmentProbeResult(input: {
	readonly probeCase: AttachmentProbeCase;
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly timedOut: boolean;
	readonly durationMs: number;
	readonly boundMs: number;
}): AttachmentProbeOutcome {
	const boundVerdict: AttachmentProbeBoundVerdict =
		input.durationMs <= input.boundMs ? "within_bound" : "exceeded_bound";
	const exitStatus = safeExitStatus(input.exitCode);
	if (input.timedOut) {
		return {
			ok: false,
			code: "attachment_probe_timed_out",
			durationMs: input.durationMs,
			boundVerdict,
			exitStatus,
		};
	}
	const envelope = parseEnvelope(input.stdout);
	if (envelope === undefined) {
		return {
			ok: false,
			code: "attachment_probe_invalid_envelope",
			durationMs: input.durationMs,
			boundVerdict,
			exitStatus,
		};
	}
	if (envelope.code === "tab_gone") {
		return {
			ok: false,
			code: "strict_pin_tab_gone",
			durationMs: input.durationMs,
			boundVerdict,
			exitStatus,
		};
	}
	if (input.exitCode !== 0 || envelope.success !== true) {
		return {
			ok: false,
			code: "attachment_probe_command_failed",
			durationMs: input.durationMs,
			boundVerdict,
			exitStatus,
		};
	}
	const data = jsonObject(envelope.data);
	if (data === undefined) {
		return {
			ok: false,
			code: "attachment_probe_invalid_envelope",
			durationMs: input.durationMs,
			boundVerdict,
			exitStatus,
		};
	}
	const expected = input.probeCase.envelopeKind === "tabs" ? "tabs" : "sessions";
	if (!Array.isArray(data[expected])) {
		return {
			ok: false,
			code: "attachment_probe_invalid_envelope",
			durationMs: input.durationMs,
			boundVerdict,
			exitStatus,
		};
	}
	return {
		ok: true,
		code: "attachment_read_only_confirmed",
		durationMs: input.durationMs,
		boundVerdict,
		exitStatus,
		data,
	};
}

/** Sanitized identity of one tab. Carries no URL, title, or endpoint. */
export type CurrentTabIdentity = {
	readonly tab_id: string;
	readonly canonical_target_id: string;
};

/** What the inventory proves about the current tab. */
export type CurrentTabVerdict =
	| "current_tab_identified"
	| "current_tab_absent"
	| "current_tab_ambiguous"
	| "target_identity_duplicate"
	| "target_identity_unsafe"
	| "tab_inventory_empty";

export type CurrentTabSummary = {
	readonly verdict: CurrentTabVerdict;
	readonly tab_count: number;
	readonly active_tab_count: number;
	readonly target_ids: readonly string[];
	readonly current_tab?: CurrentTabIdentity;
};

/**
 * Reduce a `tab list` inventory to a sanitized identity verdict.
 *
 * Fails closed on absent, ambiguous, duplicate, or unsafe identity. The result
 * deliberately carries no `url` and no `title`: a current-tab identity is a
 * pair of bounded ids, not page content.
 */
export function summarizeCurrentTabs(tabs: unknown): CurrentTabSummary {
	const rows = Array.isArray(tabs) ? tabs : [];
	const identities: CurrentTabIdentity[] = [];
	const active: CurrentTabIdentity[] = [];
	const seen = new Set<string>();
	let unsafe = false;
	let duplicate = false;
	for (const row of rows) {
		const tab = jsonObject(row);
		const tabId = tab?.tabId;
		const targetId = tab?.targetId;
		if (
			typeof tabId !== "string" ||
			typeof targetId !== "string" ||
			!SAFE_TAB_ID.test(tabId) ||
			!SAFE_TAB_ID.test(targetId)
		) {
			unsafe = true;
			continue;
		}
		if (seen.has(targetId)) {
			duplicate = true;
			continue;
		}
		seen.add(targetId);
		const identity: CurrentTabIdentity = {
			tab_id: tabId,
			canonical_target_id: targetId,
		};
		identities.push(identity);
		if (tab?.active === true) active.push(identity);
	}
	const base = {
		tab_count: identities.length,
		active_tab_count: active.length,
		target_ids: identities.map((identity) => identity.canonical_target_id),
	};
	if (unsafe) return { verdict: "target_identity_unsafe", ...base };
	if (duplicate) return { verdict: "target_identity_duplicate", ...base };
	if (rows.length === 0) return { verdict: "tab_inventory_empty", ...base };
	if (active.length === 0) return { verdict: "current_tab_absent", ...base };
	if (active.length > 1) return { verdict: "current_tab_ambiguous", ...base };
	const current = active[0];
	if (current === undefined) return { verdict: "current_tab_absent", ...base };
	return { verdict: "current_tab_identified", ...base, current_tab: current };
}

/** Whether a previously observed target identity still holds. */
export type StableTargetIdentityVerdict =
	| "target_identity_stable"
	| "target_identity_changed"
	| "target_identity_absent"
	| "target_identity_ambiguous"
	| "target_identity_unsafe";

export type StableTargetIdentityResult = {
	readonly verdict: StableTargetIdentityVerdict;
	readonly observed_tab_count: number;
	readonly observed_active_tab_count: number;
	/** Present only on a stable verdict: no other verdict hands back identity. */
	readonly current_tab?: CurrentTabIdentity;
};

/**
 * Confirm that a previously observed canonical target id is still the current
 * tab, without asking for the active page.
 *
 * Fails closed on every non-result: an unsafe expectation or inventory, an
 * absent or empty inventory, more than one active tab, and a current tab whose
 * identity differs from the expectation. A duplicate canonical id is reported
 * as unsafe rather than as its own verdict, because a repeated id means the
 * identity space itself cannot be trusted for this comparison.
 */
export function verifyStableTargetIdentity(input: {
	readonly tabs: unknown;
	readonly expectedTargetId: string;
}): StableTargetIdentityResult {
	const summary = summarizeCurrentTabs(input.tabs);
	const base = {
		observed_tab_count: summary.tab_count,
		observed_active_tab_count: summary.active_tab_count,
	};
	if (!SAFE_TAB_ID.test(input.expectedTargetId)) {
		return { verdict: "target_identity_unsafe", ...base };
	}
	if (
		summary.verdict === "target_identity_unsafe" ||
		summary.verdict === "target_identity_duplicate"
	) {
		return { verdict: "target_identity_unsafe", ...base };
	}
	if (
		summary.verdict === "tab_inventory_empty" ||
		summary.verdict === "current_tab_absent"
	) {
		return { verdict: "target_identity_absent", ...base };
	}
	if (summary.verdict === "current_tab_ambiguous") {
		return { verdict: "target_identity_ambiguous", ...base };
	}
	const current = summary.current_tab;
	if (current === undefined) {
		return { verdict: "target_identity_absent", ...base };
	}
	if (current.canonical_target_id !== input.expectedTargetId) {
		return { verdict: "target_identity_changed", ...base };
	}
	return { verdict: "target_identity_stable", ...base, current_tab: current };
}

/** Whether the adopted identity survived the pin, across both steps. */
export type TwoStepIdentityVerdict =
	| "identity_held"
	| "identity_not_identified"
	| "identity_target_changed"
	| "identity_tab_ref_changed";

export type TwoStepIdentityResult = {
	readonly verdict: TwoStepIdentityVerdict;
	/** Present only on `identity_held`. */
	readonly identity?: CurrentTabIdentity;
};

/**
 * Compare the current-tab identity observed before and after pinning.
 *
 * The adoption holds only when BOTH steps identified exactly one current tab
 * and BOTH the adapter tab reference and the canonical target id are equal. A
 * changed canonical target id means the session moved to a different tab; an
 * equal target id under a changed tab reference means the session re-derived
 * its handle, which is still not the same binding this harness may rely on.
 */
export function compareCurrentTabIdentity(input: {
	readonly first: CurrentTabSummary;
	readonly second: CurrentTabSummary;
}): TwoStepIdentityResult {
	const first = input.first.current_tab;
	const second = input.second.current_tab;
	if (
		input.first.verdict !== "current_tab_identified" ||
		input.second.verdict !== "current_tab_identified" ||
		first === undefined ||
		second === undefined
	) {
		return { verdict: "identity_not_identified" };
	}
	if (first.canonical_target_id !== second.canonical_target_id) {
		return { verdict: "identity_target_changed" };
	}
	if (first.tab_id !== second.tab_id) {
		return { verdict: "identity_tab_ref_changed" };
	}
	return { verdict: "identity_held", identity: second };
}

// ---------------------------------------------------------------------------
// Injectable public-command boundary.
//
// The harness never spawns anything itself: the caller supplies the runner.
// Browser-free tests pass a fake; the env-gated live case passes a real spawn.
// Both drive the identical argv, so the argv that fixture tests pin is the argv
// the live case executes.
// ---------------------------------------------------------------------------

export type AttachmentProbeCommandResult = {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
};

export type AttachmentProbeCommandRunner = (input: {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly timeoutMs: number;
}) => Promise<AttachmentProbeCommandResult>;

export type AttachmentProbeRunResult =
	| {
			readonly stage: "argv";
			readonly ok: false;
			readonly code: AttachmentProbeArgvRefusal;
	  }
	| ({ readonly stage: "command" } & AttachmentProbeOutcome);

/**
 * Disposable-daemon environment for one probe.
 *
 * The isolated socket directory keeps the probe's Agent Browser daemon out of
 * the default namespace, so a probe can never observe, disturb, or leak into a
 * governed Browser Use session. This mirrors the isolation Browser Use target
 * topology already uses for its cleanup session.
 */
export function attachmentProbeEnvironment(
	socketDir: string,
): Record<string, string> {
	return {
		AGENT_BROWSER_SOCKET_DIR: socketDir,
		MCPORTER_NO_KEEPALIVE: "*",
	};
}

/** Execute one named read-only case through the injected runner. */
export async function runAttachmentProbe(input: {
	readonly runCommand: AttachmentProbeCommandRunner;
	readonly executable: string;
	readonly probeCase: AttachmentProbeCase;
	readonly sessionName: string;
	readonly socketDir: string;
	readonly boundMs: number;
	readonly timeoutMs: number;
	readonly endpointWs?: string;
	readonly now?: () => number;
}): Promise<AttachmentProbeRunResult> {
	const built = buildAttachmentProbeArgv({
		probeCase: input.probeCase,
		sessionName: input.sessionName,
		...(input.endpointWs === undefined ? {} : { endpointWs: input.endpointWs }),
	});
	if (!built.ok) return { stage: "argv", ok: false, code: built.code };
	const now = input.now ?? (() => Date.now());
	const startedAt = now();
	const result = await input.runCommand({
		command: input.executable,
		args: built.argv,
		env: attachmentProbeEnvironment(input.socketDir),
		timeoutMs: input.timeoutMs,
	});
	return {
		stage: "command",
		...classifyAttachmentProbeResult({
			probeCase: input.probeCase,
			exitCode: result.exitCode,
			stdout: result.stdout,
			timedOut: result.timedOut,
			durationMs: now() - startedAt,
			boundMs: input.boundMs,
		}),
	};
}

export type AttachmentProbeReleaseResult = {
	/** Proven by the independent inventory read, never by the close response. */
	readonly released: boolean;
	readonly closeAcknowledged: boolean;
	readonly sessionsRemaining: number | null;
};

/**
 * Release the probe's session through the public Agent Browser surface.
 *
 * `close` is the writer, so its own reply cannot prove release. The verdict
 * comes from a separate `session list` read of the same isolated namespace.
 */
export async function releaseAttachmentProbeSession(input: {
	readonly runCommand: AttachmentProbeCommandRunner;
	readonly executable: string;
	readonly sessionName: string;
	readonly socketDir: string;
	readonly timeoutMs: number;
}): Promise<AttachmentProbeReleaseResult> {
	if (!SAFE_RUN_ID.test(input.sessionName)) {
		return {
			released: false,
			closeAcknowledged: false,
			sessionsRemaining: null,
		};
	}
	const env = attachmentProbeEnvironment(input.socketDir);
	const close = await input.runCommand({
		command: input.executable,
		args: ["--session", input.sessionName, "close", "--json"],
		env,
		timeoutMs: input.timeoutMs,
	});
	const closeEnvelope = parseEnvelope(close.stdout);
	const closeAcknowledged =
		close.exitCode === 0 && closeEnvelope?.success === true;
	const inventory = await input.runCommand({
		command: input.executable,
		args: ["session", "list", "--json"],
		env,
		timeoutMs: input.timeoutMs,
	});
	const inventoryEnvelope = parseEnvelope(inventory.stdout);
	const sessions = jsonObject(inventoryEnvelope?.data)?.sessions;
	if (inventory.exitCode !== 0 || !Array.isArray(sessions)) {
		return { released: false, closeAcknowledged, sessionsRemaining: null };
	}
	return {
		released: !sessions.includes(input.sessionName),
		closeAcknowledged,
		sessionsRemaining: sessions.length,
	};
}

/** Release plus its ordered disposable-state cleanup. */
export type AttachmentProbeCustodyResult = AttachmentProbeReleaseResult & {
	readonly socketDirRemoved: boolean;
	/** Set when the directory was deliberately kept for its owner to inspect. */
	readonly retainedSocketDir?: string;
};

/**
 * Release the probe session, then remove its isolated socket directory — in
 * that order, and only when release is independently proven.
 *
 * An unreleased session still owns that directory: its daemon socket, pid, and
 * session state are the operator's only handle for finishing the release. So a
 * failed release retains the directory and reports the retained path instead of
 * deleting the evidence that a release is still outstanding.
 */
export async function releaseAttachmentProbeCustody(input: {
	readonly runCommand: AttachmentProbeCommandRunner;
	readonly executable: string;
	readonly sessionName: string;
	readonly socketDir: string;
	readonly timeoutMs: number;
	readonly removeSocketDir: (socketDir: string) => void;
}): Promise<AttachmentProbeCustodyResult> {
	const release = await releaseAttachmentProbeSession({
		runCommand: input.runCommand,
		executable: input.executable,
		sessionName: input.sessionName,
		socketDir: input.socketDir,
		timeoutMs: input.timeoutMs,
	});
	if (!release.released) {
		return {
			...release,
			socketDirRemoved: false,
			retainedSocketDir: input.socketDir,
		};
	}
	try {
		input.removeSocketDir(input.socketDir);
	} catch {
		return {
			...release,
			socketDirRemoved: false,
			retainedSocketDir: input.socketDir,
		};
	}
	return { ...release, socketDirRemoved: true };
}

// ---------------------------------------------------------------------------
// Sanitized failure projection.
//
// A live assertion must be able to say WHY it failed without becoming a leak.
// These projections carry only deterministic, bounded values: the stage, the
// typed code, the bound verdict, a narrowed numeric exit status, and small
// counts. They deliberately drop `data`, `durationMs`, and every path-, URL-,
// or name-shaped field, so no stdout, stderr, endpoint, page URL, page title,
// session name, or socket path can reach an error message. Assert on the
// projection, and a failing diff prints the diagnosis already sanitized.
// ---------------------------------------------------------------------------

export type AttachmentProbeDiagnostic = {
	readonly stage: "argv" | "command";
	readonly ok: boolean;
	readonly code: string;
	readonly bound_verdict: AttachmentProbeBoundVerdict | null;
	readonly exit_status: number | null;
};

/** Project one probe result into deterministic, leak-free metadata. */
export function attachmentProbeDiagnostic(
	result: AttachmentProbeRunResult,
): AttachmentProbeDiagnostic {
	if (result.stage === "argv") {
		return {
			stage: "argv",
			ok: false,
			code: result.code,
			bound_verdict: null,
			exit_status: null,
		};
	}
	return {
		stage: "command",
		ok: result.ok,
		code: result.code,
		bound_verdict: result.boundVerdict,
		exit_status: result.exitStatus,
	};
}

export type CurrentTabDiagnostic = {
	readonly verdict: CurrentTabVerdict;
	readonly active_tab_count: number;
};

/**
 * Project a tab inventory into a deterministic verdict pair.
 *
 * `tab_count` and `target_ids` are deliberately omitted: both vary with
 * whatever the operator happens to have open, so they would make a failure
 * message nondeterministic without adding diagnostic value the verdict does
 * not already carry.
 */
export function currentTabDiagnostic(
	summary: CurrentTabSummary,
): CurrentTabDiagnostic {
	return {
		verdict: summary.verdict,
		active_tab_count: summary.active_tab_count,
	};
}

export type AttachmentProbeCustodyDiagnostic = {
	readonly released: boolean;
	readonly close_acknowledged: boolean;
	readonly sessions_remaining: number | null;
	readonly socket_dir_removed: boolean;
	/** Whether a directory was retained — never which one. */
	readonly socket_dir_retained: boolean;
};

/** Project a custody result into deterministic, path-free metadata. */
export function attachmentProbeCustodyDiagnostic(
	custody: AttachmentProbeCustodyResult,
): AttachmentProbeCustodyDiagnostic {
	return {
		released: custody.released,
		close_acknowledged: custody.closeAcknowledged,
		sessions_remaining: custody.sessionsRemaining,
		socket_dir_removed: custody.socketDirRemoved,
		socket_dir_retained: custody.retainedSocketDir !== undefined,
	};
}
