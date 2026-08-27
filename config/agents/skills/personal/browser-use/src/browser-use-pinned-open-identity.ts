// ---------------------------------------------------------------------------
// Pinned-open identity outcomes (single owner).
//
// `--pin-tab open <url>` has two outcomes that a URL comparison cannot tell
// apart. It can open a genuinely NEW tab, and it can NAVIGATE a tab that
// already exists. After either one, some tab carries the requested URL, so
// "a tab is showing what I asked for" proves nothing about ownership.
//
// They differ only in IDENTITY:
//
//   new tab            -> a canonical target id the before-inventory never had
//   navigated in place -> the SAME tab_id AND the SAME canonical_target_id,
//                         with only the url changed
//
// A CDP target id is a property of the tab, not of the document the tab
// currently shows, so it survives navigation, including across origins. That
// is exactly why the URL cannot stand in for identity here.
//
// This module owns that distinction browser-free. The url is never an identity
// input: it is reported separately as `landed_on_requested_url`, which says
// whether the outcome went where the caller asked and nothing about whose tab
// it is.
//
// Harness owner only. It performs no I/O and spawns nothing. It deliberately
// does NOT extend the read-only probe's native token allowlist: `open` is a
// mutating verb, so a live counterpart is a separately gated command its owner
// runs deliberately, never something this harness can spawn.
//
// Extension point: add one entry to PINNED_OPEN_IDENTITY_FIXTURES, plus its
// expected verdict in the test's own hand-written table. The catalog supplies
// the domain to enumerate; it never carries the expected value.
// ---------------------------------------------------------------------------

import type { CurrentTabIdentity } from "./browser-use-attachment-probe";
import {
	BROWSER_USE_QUALIFICATION_HANDOFF_PRODUCER_CONTRACT_ID,
	BROWSER_USE_QUALIFICATION_HANDOFF_PRODUCER_SCHEMA_VERSION,
} from "./command-contract";
import { SAFE_TAB_ID } from "./browser-use-identifiers";

/**
 * Env gate for the separately owned live counterpart.
 *
 * The live case is deliberately NOT implemented in this harness: observing a
 * real pinned open requires the mutating `open` verb, and this module refuses
 * to spawn one. Admitting that verb is a reviewer decision, not a harness
 * change. The gate name is owned here so it cannot drift between the harness
 * and whatever eventually runs it.
 */
export const PINNED_OPEN_IDENTITY_LIVE_GATE =
	"BROWSER_USE_PINNED_OPEN_IDENTITY_LIVE";

/** One inventory row, in the shape Agent Browser `tab list` returns. */
export type PinnedOpenTabRow = {
	readonly tabId: string;
	readonly targetId: string;
	readonly url: string;
};

/**
 * What a before/after inventory pair proves about one pinned open.
 *
 * Every non-result is a distinct fail-closed verdict rather than a fallback,
 * so a caller can never mistake "could not tell" for "created".
 */
export type PinnedOpenIdentityVerdict =
	| "pinned_open_created_new_tab"
	| "pinned_open_navigated_in_place"
	| "pinned_open_no_identity_change"
	| "pinned_open_tab_ref_changed"
	| "pinned_open_identity_ambiguous"
	| "pinned_open_identity_unsafe"
	| "pinned_open_inventory_lost_tab";

export type PinnedOpenIdentityResult = {
	readonly verdict: PinnedOpenIdentityVerdict;
	readonly before_tab_count: number;
	readonly after_tab_count: number;
	readonly new_target_id_count: number;
	readonly missing_target_id_count: number;
	readonly navigated_target_id_count: number;
	/** Present only on `created_new_tab` and `navigated_in_place`. */
	readonly identity?: CurrentTabIdentity;
	/** Corroboration only. Never an input to the verdict. */
	readonly landed_on_requested_url: boolean;
};

function exactHref(value: string): string | undefined {
	try {
		return new URL(value).href;
	} catch {
		return undefined;
	}
}

type ParsedInventory =
	| { readonly ok: true; readonly rows: readonly PinnedOpenTabRow[] }
	| { readonly ok: false };

/**
 * Narrow an unknown inventory to safe, uniquely identified rows.
 *
 * A duplicate canonical target id fails the whole inventory: a repeated id
 * means the identity space itself cannot be trusted for this comparison.
 */
function parseInventory(value: unknown): ParsedInventory {
	if (!Array.isArray(value)) return { ok: false };
	const rows: PinnedOpenTabRow[] = [];
	const seen = new Set<string>();
	for (const raw of value) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			return { ok: false };
		}
		const row = raw as Record<string, unknown>;
		const { tabId, targetId, url } = row;
		if (
			typeof tabId !== "string" ||
			typeof targetId !== "string" ||
			typeof url !== "string" ||
			!SAFE_TAB_ID.test(tabId) ||
			!SAFE_TAB_ID.test(targetId) ||
			seen.has(targetId)
		) {
			return { ok: false };
		}
		seen.add(targetId);
		rows.push({ tabId, targetId, url });
	}
	return { ok: true, rows };
}

/**
 * Classify one pinned open from the inventories observed either side of it.
 *
 * Order matters. Unsafe input is rejected before anything is counted, a lost
 * tab outranks every positive verdict because a vanished tab means the
 * inventory cannot be reconciled at all, and ambiguity outranks a match.
 */
export function classifyPinnedOpenIdentity(input: {
	readonly before: unknown;
	readonly after: unknown;
	readonly requestedUrl: string;
}): PinnedOpenIdentityResult {
	const before = parseInventory(input.before);
	const after = parseInventory(input.after);
	const requested = exactHref(input.requestedUrl);
	if (!before.ok || !after.ok || requested === undefined) {
		return {
			verdict: "pinned_open_identity_unsafe",
			before_tab_count: before.ok ? before.rows.length : 0,
			after_tab_count: after.ok ? after.rows.length : 0,
			new_target_id_count: 0,
			missing_target_id_count: 0,
			navigated_target_id_count: 0,
			landed_on_requested_url: false,
		};
	}
	const beforeById = new Map(before.rows.map((row) => [row.targetId, row]));
	const afterIds = new Set(after.rows.map((row) => row.targetId));
	const newRows = after.rows.filter((row) => !beforeById.has(row.targetId));
	const missing = before.rows.filter((row) => !afterIds.has(row.targetId));
	// A same-id row whose url changed. Identity is the id pair; the url change
	// is what makes this row the one the open acted on.
	const navigated = after.rows.filter((row) => {
		const previous = beforeById.get(row.targetId);
		return previous !== undefined && previous.url !== row.url;
	});
	const base = {
		before_tab_count: before.rows.length,
		after_tab_count: after.rows.length,
		new_target_id_count: newRows.length,
		missing_target_id_count: missing.length,
		navigated_target_id_count: navigated.length,
	};
	if (missing.length > 0) {
		return {
			verdict: "pinned_open_inventory_lost_tab",
			...base,
			landed_on_requested_url: false,
		};
	}
	if (newRows.length > 1) {
		return {
			verdict: "pinned_open_identity_ambiguous",
			...base,
			landed_on_requested_url: false,
		};
	}
	if (newRows.length === 1) {
		const created = newRows[0];
		if (created === undefined) {
			return {
				verdict: "pinned_open_identity_unsafe",
				...base,
				landed_on_requested_url: false,
			};
		}
		return {
			verdict: "pinned_open_created_new_tab",
			...base,
			identity: {
				tab_id: created.tabId,
				canonical_target_id: created.targetId,
			},
			landed_on_requested_url: exactHref(created.url) === requested,
		};
	}
	if (navigated.length > 1) {
		return {
			verdict: "pinned_open_identity_ambiguous",
			...base,
			landed_on_requested_url: false,
		};
	}
	if (navigated.length === 0) {
		return {
			verdict: "pinned_open_no_identity_change",
			...base,
			landed_on_requested_url: false,
		};
	}
	const moved = navigated[0];
	const previous = moved === undefined ? undefined : beforeById.get(moved.targetId);
	if (moved === undefined || previous === undefined) {
		return {
			verdict: "pinned_open_identity_unsafe",
			...base,
			landed_on_requested_url: false,
		};
	}
	// In place requires BOTH ids equal. An equal target id under a changed tab
	// reference means the adapter re-derived its handle, which is not the same
	// binding a caller may rely on.
	if (previous.tabId !== moved.tabId) {
		return {
			verdict: "pinned_open_tab_ref_changed",
			...base,
			landed_on_requested_url: false,
		};
	}
	return {
		verdict: "pinned_open_navigated_in_place",
		...base,
		identity: { tab_id: moved.tabId, canonical_target_id: moved.targetId },
		landed_on_requested_url: exactHref(moved.url) === requested,
	};
}

/**
 * One named browser-free fixture.
 *
 * Deliberately carries NO expected verdict. The expectation lives in the test,
 * written by hand, so a fixture can never grade itself.
 */
export type PinnedOpenIdentityFixture = {
	readonly id: string;
	readonly summary: string;
	readonly requestedUrl: string;
	readonly before: readonly PinnedOpenTabRow[];
	readonly after: readonly PinnedOpenTabRow[];
};

const STORYBOOK_STORY_URL =
	"http://127.0.0.1:43151/?path=/story/components-forms-atoms-datepickerfield--path-docs";

/**
 * The sealed fixture catalog, and the only owner of the fixture-id vocabulary.
 *
 * Two entries are reconstructions of real production outcomes and are the
 * reason this harness exists. Keep their shape when editing.
 */
export const PINNED_OPEN_IDENTITY_FIXTURES = [
	{
		id: "created-new-tab",
		summary: "A genuinely new tab appears and every existing tab is untouched.",
		requestedUrl: STORYBOOK_STORY_URL,
		before: [{ tabId: "tab-a", targetId: "target-a", url: "https://mail.test/inbox" }],
		after: [
			{ tabId: "tab-a", targetId: "target-a", url: "https://mail.test/inbox" },
			{ tabId: "tab-b", targetId: "target-b", url: STORYBOOK_STORY_URL },
		],
	},
	{
		id: "navigated-in-place-same-origin",
		summary:
			"Reconstruction: a tab already on the Storybook origin is navigated in place, so no new target id appears.",
		requestedUrl: STORYBOOK_STORY_URL,
		before: [{ tabId: "tab-a", targetId: "target-a", url: "http://127.0.0.1:43151/iframe.html" }],
		after: [{ tabId: "tab-a", targetId: "target-a", url: STORYBOOK_STORY_URL }],
	},
	{
		id: "navigated-in-place-cross-origin",
		summary:
			"Reconstruction: a bystander tab on another origin is navigated in place and keeps both ids.",
		requestedUrl: STORYBOOK_STORY_URL,
		before: [{ tabId: "tab-a", targetId: "target-a", url: "https://mail.test/inbox" }],
		after: [{ tabId: "tab-a", targetId: "target-a", url: STORYBOOK_STORY_URL }],
	},
	{
		id: "navigated-in-place-elsewhere",
		summary:
			"Identity is decided without the url: an in-place navigation that did not land on the request is still in place.",
		requestedUrl: STORYBOOK_STORY_URL,
		before: [{ tabId: "tab-a", targetId: "target-a", url: "https://mail.test/inbox" }],
		after: [{ tabId: "tab-a", targetId: "target-a", url: "https://mail.test/sent" }],
	},
	{
		id: "no-identity-change",
		summary: "Nothing observable happened: same ids, same urls.",
		requestedUrl: STORYBOOK_STORY_URL,
		before: [{ tabId: "tab-a", targetId: "target-a", url: "https://mail.test/inbox" }],
		after: [{ tabId: "tab-a", targetId: "target-a", url: "https://mail.test/inbox" }],
	},
	{
		id: "inventory-lost-tab",
		summary: "A tab present before is absent after, so the inventory cannot be reconciled.",
		requestedUrl: STORYBOOK_STORY_URL,
		before: [
			{ tabId: "tab-a", targetId: "target-a", url: "https://mail.test/inbox" },
			{ tabId: "tab-b", targetId: "target-b", url: "https://calendar.test/" },
		],
		after: [{ tabId: "tab-b", targetId: "target-b", url: STORYBOOK_STORY_URL }],
	},
	{
		id: "ambiguous-two-new-tabs",
		summary: "Two new target ids appear, so no single created tab can be named.",
		requestedUrl: STORYBOOK_STORY_URL,
		before: [{ tabId: "tab-a", targetId: "target-a", url: "https://mail.test/inbox" }],
		after: [
			{ tabId: "tab-a", targetId: "target-a", url: "https://mail.test/inbox" },
			{ tabId: "tab-b", targetId: "target-b", url: STORYBOOK_STORY_URL },
			{ tabId: "tab-c", targetId: "target-c", url: STORYBOOK_STORY_URL },
		],
	},
	{
		id: "ambiguous-two-navigations",
		summary: "Two same-id tabs changed url, so the acted-on tab cannot be named.",
		requestedUrl: STORYBOOK_STORY_URL,
		before: [
			{ tabId: "tab-a", targetId: "target-a", url: "https://mail.test/inbox" },
			{ tabId: "tab-b", targetId: "target-b", url: "https://calendar.test/" },
		],
		after: [
			{ tabId: "tab-a", targetId: "target-a", url: STORYBOOK_STORY_URL },
			{ tabId: "tab-b", targetId: "target-b", url: "https://calendar.test/day" },
		],
	},
	{
		id: "tab-ref-changed",
		summary: "Same canonical target id under a different adapter tab reference.",
		requestedUrl: STORYBOOK_STORY_URL,
		before: [{ tabId: "tab-a", targetId: "target-a", url: "https://mail.test/inbox" }],
		after: [{ tabId: "tab-z", targetId: "target-a", url: STORYBOOK_STORY_URL }],
	},
	{
		id: "unsafe-duplicate-target-id",
		summary: "A repeated canonical target id makes the identity space untrustworthy.",
		requestedUrl: STORYBOOK_STORY_URL,
		before: [{ tabId: "tab-a", targetId: "target-a", url: "https://mail.test/inbox" }],
		after: [
			{ tabId: "tab-a", targetId: "target-a", url: STORYBOOK_STORY_URL },
			{ tabId: "tab-b", targetId: "target-a", url: STORYBOOK_STORY_URL },
		],
	},
] as const satisfies readonly PinnedOpenIdentityFixture[];

/** A fixture that is actually in the catalog. */
export type PinnedOpenIdentityCatalogFixture =
	(typeof PINNED_OPEN_IDENTITY_FIXTURES)[number];

/** The sealed fixture-id vocabulary, derived from its single catalog owner. */
export type PinnedOpenIdentityFixtureId = PinnedOpenIdentityCatalogFixture["id"];

/** Look one fixture up by id. */
export function pinnedOpenIdentityFixture(
	id: string,
): PinnedOpenIdentityCatalogFixture | undefined {
	return PINNED_OPEN_IDENTITY_FIXTURES.find((fixture) => fixture.id === id);
}

/** Classify one catalog fixture through the same entry point a caller uses. */
export function classifyPinnedOpenFixture(
	fixture: PinnedOpenIdentityFixture,
): PinnedOpenIdentityResult {
	return classifyPinnedOpenIdentity({
		before: fixture.before,
		after: fixture.after,
		requestedUrl: fixture.requestedUrl,
	});
}

export type PinnedOpenIdentityDiagnostic = {
	readonly verdict: PinnedOpenIdentityVerdict;
	readonly new_target_id_count: number;
	readonly missing_target_id_count: number;
	readonly navigated_target_id_count: number;
	readonly landed_on_requested_url: boolean;
};

/**
 * Project one result into deterministic, leak-free metadata.
 *
 * Tab ids, canonical target ids, urls, and titles are all dropped: a failing
 * assertion must be able to print the diagnosis without carrying page content
 * or an operator's browsing state into the output.
 */
export function pinnedOpenIdentityDiagnostic(
	result: PinnedOpenIdentityResult,
): PinnedOpenIdentityDiagnostic {
	return {
		verdict: result.verdict,
		new_target_id_count: result.new_target_id_count,
		missing_target_id_count: result.missing_target_id_count,
		navigated_target_id_count: result.navigated_target_id_count,
		landed_on_requested_url: result.landed_on_requested_url,
	};
}

// ---------------------------------------------------------------------------
// Gated public qualification-exec caller.
//
// The only part of this harness that would reach a browser, and it goes through
// the PUBLIC front door: one `qualification prepare` into a freshly allocated
// child bundle, one sealed `qualification handoff` mint through that same
// bundle, then one `qualification exec` carrying the sealed manifest digest, an
// explicit run-scoped state path, and a public `targets open` argv.
//
// WHY THE MINT STEP EXISTS. `qualification exec -- targets open --handoff <h>`
// admits <h> only together with its sealed sibling receipt `<h>.producer.json`.
// That receipt is minted by exactly one producer, the sealed
// `qualification handoff` command, and it binds the run id, the handoff bytes,
// the Browser authority, the manifest digest, and the sealed artifact sha to
// the bundle that will execute the open. A handoff minted through the ordinary
// `browser-connect connect agent-browser --json` front door is a valid Verified
// Handoff Envelope with NO such receipt, so the consumer refuses it, correctly
// and failure-closed, with `qualification_handoff_producer_invalid` before any
// adapter mutation. An approved live probe proved exactly that stop. The fix is
// to mint through the sealed producer, never to relax the consumer.
//
// The mint therefore runs through the SAME bundle this run prepared, so the
// receipt is bound to the artifact the open executes. The minted handoff and
// its receipt become invocation-owned state. The caller removes them unless a
// created target still needs that exact handoff for the public close owner.
//
// Argv is validated against the exact supported SHAPE, not merely checked for
// the absence of adapter flags: a reordered, truncated, extended, or
// verb-swapped argv carries no adapter flag either, and none of those is a
// command this caller is allowed to issue.
//
// It never retries a step, stops at the first failure, and never closes a
// target. Live target cleanup belongs to its existing public owner; this caller
// reports the custody the run is holding and retains the exact handoff when a
// created target needs public close. Its child bundle is removed, or retained
// and named when removal fails.
// ---------------------------------------------------------------------------

/** Adapter-native flags this caller must never emit. */
const RAW_NATIVE_TOKENS: readonly string[] = ["--cdp", "--session", "--pin-tab"];

/** Defence in depth. The shape check below is the real gate. */
export function isPublicOnlyArgv(args: readonly string[]): boolean {
	return !args.some((token) => RAW_NATIVE_TOKENS.includes(token));
}

/** `<name>` marks a value slot; every other entry must match exactly. */
export const PINNED_OPEN_PREPARE_ARGV_SHAPE: readonly string[] = [
	"qualification",
	"prepare",
	"--output",
	"<output>",
	"--json",
];

/**
 * The sealed producer mint. Runs `qualification handoff` INSIDE the same sealed
 * bundle, which is the only path that writes `<output>.producer.json`.
 */
export const PINNED_OPEN_MINT_ARGV_SHAPE: readonly string[] = [
	"qualification",
	"exec",
	"--bundle",
	"<bundle>",
	"--expected-manifest-digest",
	"<digest>",
	"--",
	"qualification",
	"handoff",
	"--run-id",
	"<run-id>",
	"--output",
	"<handoff>",
	"--json",
];

export const PINNED_OPEN_EXEC_ARGV_SHAPE: readonly string[] = [
	"qualification",
	"exec",
	"--bundle",
	"<bundle>",
	"--expected-manifest-digest",
	"<digest>",
	"--",
	"targets",
	"open",
	"--url",
	"<url>",
	"--handoff",
	"<handoff>",
	"--state",
	"<state>",
	"--run-id",
	"<run-id>",
	"--debug",
	"--json",
];

function isValueSlot(token: string): boolean {
	return token.startsWith("<") && token.endsWith(">");
}

/** True only when the argv is exactly the supported shape, slot for slot. */
export function matchesPinnedOpenArgvShape(
	argv: readonly string[],
	shape: readonly string[],
): boolean {
	if (argv.length !== shape.length) return false;
	return shape.every((expected, index) => {
		const actual = argv[index];
		if (actual === undefined) return false;
		return isValueSlot(expected)
			? actual.length > 0 && !actual.startsWith("--")
			: actual === expected;
	});
}

export type PinnedOpenArgvRefusal =
	| "unsafe_run_id"
	| "unsafe_requested_url"
	| "unsafe_expected_digest"
	| "unsafe_state_path"
	| "unsafe_handoff_path"
	| "unsafe_bundle_path";

export type PinnedOpenArgvResult =
	| { readonly ok: true; readonly argv: readonly string[] }
	| { readonly ok: false; readonly code: PinnedOpenArgvRefusal };

const SEALED_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_ARGV_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isHttpUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

function isSafeAbsolutePath(value: string): boolean {
	return value.startsWith("/") && !value.split("/").includes("..");
}

type PinnedOpenValidation =
	| { readonly ok: true }
	| { readonly ok: false; readonly code: PinnedOpenArgvRefusal };

/**
 * Everything the sealed producer mint depends on. Kept separate because the
 * mint carries no url and no run-scoped state path.
 */
export function validatePinnedOpenMintInputs(input: {
	readonly expectedManifestDigest: string;
	readonly handoffPath: string;
	readonly runId: string;
}): PinnedOpenValidation {
	if (!SAFE_ARGV_RUN_ID.test(input.runId)) {
		return { ok: false, code: "unsafe_run_id" };
	}
	if (!SEALED_DIGEST_PATTERN.test(input.expectedManifestDigest)) {
		return { ok: false, code: "unsafe_expected_digest" };
	}
	if (!isSafeAbsolutePath(input.handoffPath)) {
		return { ok: false, code: "unsafe_handoff_path" };
	}
	return { ok: true };
}

/**
 * Validate everything that does not depend on the bundle, so a bad input
 * refuses before any directory is allocated.
 */
export function validatePinnedOpenExecInputs(input: {
	readonly expectedManifestDigest: string;
	readonly requestedUrl: string;
	readonly statePath: string;
	readonly runId: string;
}): PinnedOpenValidation {
	if (!SAFE_ARGV_RUN_ID.test(input.runId)) {
		return { ok: false, code: "unsafe_run_id" };
	}
	if (!isHttpUrl(input.requestedUrl)) {
		return { ok: false, code: "unsafe_requested_url" };
	}
	if (!SEALED_DIGEST_PATTERN.test(input.expectedManifestDigest)) {
		return { ok: false, code: "unsafe_expected_digest" };
	}
	if (!isSafeAbsolutePath(input.statePath)) {
		return { ok: false, code: "unsafe_state_path" };
	}
	return { ok: true };
}

/** True only for a fresh directory strictly beneath the root. */
export function isFreshChildBundle(root: string, candidate: string): boolean {
	return (
		candidate !== root &&
		candidate.startsWith(`${root}/`) &&
		!candidate.split("/").includes("..") &&
		candidate.slice(root.length + 1).length > 0
	);
}

export function buildPinnedOpenPrepareArgv(input: {
	readonly outputDir: string;
}): PinnedOpenArgvResult {
	return {
		ok: true,
		argv: ["qualification", "prepare", "--output", input.outputDir, "--json"],
	};
}

export function buildPinnedOpenMintArgv(input: {
	readonly bundleDir: string;
	readonly expectedManifestDigest: string;
	readonly handoffPath: string;
	readonly runId: string;
}): PinnedOpenArgvResult {
	const validated = validatePinnedOpenMintInputs(input);
	if (!validated.ok) return validated;
	return {
		ok: true,
		argv: [
			"qualification",
			"exec",
			"--bundle",
			input.bundleDir,
			"--expected-manifest-digest",
			input.expectedManifestDigest,
			"--",
			"qualification",
			"handoff",
			"--run-id",
			input.runId,
			"--output",
			input.handoffPath,
			"--json",
		],
	};
}

export function buildPinnedOpenExecArgv(input: {
	readonly bundleDir: string;
	readonly expectedManifestDigest: string;
	readonly requestedUrl: string;
	readonly handoffPath: string;
	readonly statePath: string;
	readonly runId: string;
}): PinnedOpenArgvResult {
	const validated = validatePinnedOpenExecInputs(input);
	if (!validated.ok) return validated;
	// The handoff is emitted into this argv, so it is validated here too.
	const handoff = validatePinnedOpenMintInputs(input);
	if (!handoff.ok) return handoff;
	return {
		ok: true,
		argv: [
			"qualification",
			"exec",
			"--bundle",
			input.bundleDir,
			"--expected-manifest-digest",
			input.expectedManifestDigest,
			"--",
			"targets",
			"open",
			"--url",
			input.requestedUrl,
			"--handoff",
			input.handoffPath,
			"--state",
			input.statePath,
			"--run-id",
			input.runId,
			"--debug",
			"--json",
		],
	};
}

export type PinnedOpenExecRunner = (input: {
	readonly command: string;
	readonly args: readonly string[];
	readonly timeoutMs: number;
}) => Promise<{
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}>;

/** What the run observed about the target the open left behind. Never closed. */
export type PinnedOpenCustodyReport = {
	readonly ownership_kind: string | null;
	readonly command_outcome: string | null;
	readonly effect: string | null;
	readonly target_mutated: boolean | null;
	readonly target_present: boolean | string | null;
	readonly target_retained: boolean;
	/** True when the adapter's fallback-adoption event appeared on stderr. */
	readonly fallback_adopted: boolean;
};

export type PinnedOpenExecFailureCode =
	| PinnedOpenArgvRefusal
	| "pinned_open_live_disabled"
	| "pinned_open_prepare_failed"
	| "pinned_open_handoff_mint_failed"
	| "pinned_open_binding_mismatch"
	| "pinned_open_exec_failed"
	| "pinned_open_invalid_envelope";

export type PinnedOpenExecResult =
	| {
			readonly ok: false;
			readonly code: PinnedOpenExecFailureCode;
			readonly prepareCalls: number;
			readonly mintCalls: number;
			readonly execCalls: number;
			/** Safe code projected from the public Browser Use error envelope. */
			readonly browserUseErrorCode?: string;
	  }
	| {
			readonly ok: true;
			readonly code: "pinned_open_observed";
			readonly prepareCalls: number;
			readonly mintCalls: number;
			readonly execCalls: number;
			readonly custody: PinnedOpenCustodyReport;
	  };

export type PinnedOpenBundleOutcome = {
	readonly removed: boolean;
	/** Named only when the path was deliberately kept for its owner. */
	readonly retainedPath?: string;
};

export type PinnedOpenExecRun = {
	readonly result: PinnedOpenExecResult;
	/** Absent when nothing was ever allocated. */
	readonly bundle?: PinnedOpenBundleOutcome;
	/** The minted handoff and its sealed receipt. Absent when never allocated. */
	readonly handoff?: PinnedOpenBundleOutcome;
};

export type PinnedOpenExecInput = {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly runCommand: PinnedOpenExecRunner;
	readonly executable: string;
	readonly bundleRoot: string;
	readonly allocateBundleDir: (bundleRoot: string) => string;
	/**
	 * A fresh path the sealed producer will create. It must NOT exist: the
	 * producer refuses an --output whose handoff or receipt is already there.
	 */
	readonly allocateHandoffPath: (bundleRoot: string) => string;
	readonly expectedManifestDigest: string;
	readonly requestedUrl: string;
	readonly statePath: string;
	readonly runId: string;
	readonly timeoutMs: number;
	readonly removeBundleDir: (bundleDir: string) => void;
	/** Removes the minted handoff AND its sealed sibling receipt. */
	readonly removeHandoff: (handoffPath: string) => void;
};

const FALLBACK_EVENT_RECORD = '"event":"target-topology-fallback-adopted"';
const SAFE_PUBLIC_ERROR_CODE = /^[a-z][a-z0-9_]{0,127}$/;

function publicEnvelopeData(stdout: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(stdout) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return undefined;
		}
		const envelope = parsed as Record<string, unknown>;
		if (envelope.status !== "ok") return undefined;
		const data = envelope.data;
		return typeof data === "object" && data !== null && !Array.isArray(data)
			? (data as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Keep one bounded owner code while dropping messages, paths, and raw output. */
function publicEnvelopeErrorCode(stdout: string): string | undefined {
	try {
		const parsed = JSON.parse(stdout) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return undefined;
		}
		const envelope = parsed as Record<string, unknown>;
		if (envelope.status !== "error") return undefined;
		const error = envelope.error;
		if (typeof error !== "object" || error === null || Array.isArray(error)) {
			return undefined;
		}
		const code = (error as Record<string, unknown>).code;
		return typeof code === "string" && SAFE_PUBLIC_ERROR_CODE.test(code)
			? code
			: undefined;
	} catch {
		return undefined;
	}
}

function readCustody(
	data: Record<string, unknown>,
	stderr: string,
): PinnedOpenCustodyReport {
	const ownership =
		typeof data.ownership === "object" &&
		data.ownership !== null &&
		!Array.isArray(data.ownership)
			? (data.ownership as Record<string, unknown>)
			: undefined;
	return {
		ownership_kind: typeof ownership?.kind === "string" ? ownership.kind : null,
		command_outcome:
			typeof data.command_outcome === "string" ? data.command_outcome : null,
		effect: typeof data.effect === "string" ? data.effect : null,
		target_mutated:
			typeof data.target_mutated === "boolean" ? data.target_mutated : null,
		target_present:
			typeof data.target_present === "boolean" ||
			typeof data.target_present === "string"
				? (data.target_present as boolean | string)
				: null,
		target_retained: ownership?.retained === true,
		// A bounded token match. Raw stderr is never stored or returned.
		fallback_adopted: stderr.includes(FALLBACK_EVENT_RECORD),
	};
}

/** Run the gated observation through the public front door. */
export async function runPinnedOpenQualificationExec(
	input: PinnedOpenExecInput,
): Promise<PinnedOpenExecRun> {
	if (input.env[PINNED_OPEN_IDENTITY_LIVE_GATE] !== "1") {
		return {
			result: {
				ok: false,
				code: "pinned_open_live_disabled",
				prepareCalls: 0,
				mintCalls: 0,
				execCalls: 0,
			},
		};
	}
	const refuseBeforeAllocation = (
		code: PinnedOpenExecFailureCode,
	): PinnedOpenExecRun => ({
		result: { ok: false, code, prepareCalls: 0, mintCalls: 0, execCalls: 0 },
	});
	// Validate first, so a bad input refuses before anything is allocated.
	const validated = validatePinnedOpenExecInputs(input);
	if (!validated.ok) return refuseBeforeAllocation(validated.code);
	const bundleDir = input.allocateBundleDir(input.bundleRoot);
	if (!isFreshChildBundle(input.bundleRoot, bundleDir)) {
		return refuseBeforeAllocation("unsafe_bundle_path");
	}
	// The handoff is a sibling of the bundle, not a child of it: the sealed
	// bundle is left read-only by prepare, so the producer could not write into
	// it. Both live under the one private root this run was given.
	const handoffPath = input.allocateHandoffPath(input.bundleRoot);
	if (
		!isFreshChildBundle(input.bundleRoot, handoffPath) ||
		handoffPath === bundleDir
	) {
		return refuseBeforeAllocation("unsafe_handoff_path");
	}
	const prepareArgv = buildPinnedOpenPrepareArgv({ outputDir: bundleDir });
	const mintArgv = buildPinnedOpenMintArgv({ ...input, bundleDir, handoffPath });
	const execArgv = buildPinnedOpenExecArgv({ ...input, bundleDir, handoffPath });
	if (
		!prepareArgv.ok ||
		!mintArgv.ok ||
		!execArgv.ok ||
		!matchesPinnedOpenArgvShape(prepareArgv.argv, PINNED_OPEN_PREPARE_ARGV_SHAPE) ||
		!matchesPinnedOpenArgvShape(mintArgv.argv, PINNED_OPEN_MINT_ARGV_SHAPE) ||
		!matchesPinnedOpenArgvShape(execArgv.argv, PINNED_OPEN_EXEC_ARGV_SHAPE) ||
		!isPublicOnlyArgv(prepareArgv.argv) ||
		!isPublicOnlyArgv(mintArgv.argv) ||
		!isPublicOnlyArgv(execArgv.argv)
	) {
		const code = !prepareArgv.ok
			? prepareArgv.code
			: !mintArgv.ok
				? mintArgv.code
				: !execArgv.ok
					? execArgv.code
					: "unsafe_bundle_path";
		return refuseBeforeAllocation(code);
	}

	let prepareCalls = 0;
	let mintCalls = 0;
	let execCalls = 0;
	// Release every invocation-owned path, and report each one honestly. The
	// handoff goes first: it is the one that carries a live endpoint.
	const settle = (
		result: PinnedOpenExecResult,
		retainCreatedTargetHandoff = false,
	): PinnedOpenExecRun => {
		let handoff: PinnedOpenBundleOutcome;
		if (retainCreatedTargetHandoff) {
			handoff = { removed: false, retainedPath: handoffPath };
		} else {
			try {
				input.removeHandoff(handoffPath);
				handoff = { removed: true };
			} catch {
				handoff = { removed: false, retainedPath: handoffPath };
			}
		}
		try {
			input.removeBundleDir(bundleDir);
		} catch {
			return { result, bundle: { removed: false, retainedPath: bundleDir }, handoff };
		}
		return { result, bundle: { removed: true }, handoff };
	};

	prepareCalls += 1;
	const prepared = await input.runCommand({
		command: input.executable,
		args: prepareArgv.argv,
		timeoutMs: input.timeoutMs,
	});
	if (prepared.timedOut || prepared.exitCode !== 0) {
		return settle({
			ok: false,
			code: "pinned_open_prepare_failed",
			prepareCalls,
			mintCalls,
			execCalls,
			browserUseErrorCode: publicEnvelopeErrorCode(prepared.stdout),
		});
	}
	const prepareData = publicEnvelopeData(prepared.stdout);
	if (prepareData === undefined) {
		return settle({
			ok: false,
			code: "pinned_open_invalid_envelope",
			prepareCalls,
			mintCalls,
			execCalls,
		});
	}
	// Sealed binding: refuse before executing anything when the bundle just
	// prepared is not the artifact the reviewer approved.
	if (prepareData.manifest_digest !== input.expectedManifestDigest) {
		return settle({
			ok: false,
			code: "pinned_open_binding_mismatch",
			prepareCalls,
			mintCalls,
			execCalls,
		});
	}

	// The sealed producer mint. Without it the open below is refused with
	// `qualification_handoff_producer_invalid`, because a handoff is admitted
	// only together with its sealed sibling receipt.
	mintCalls += 1;
	const minted = await input.runCommand({
		command: input.executable,
		args: mintArgv.argv,
		timeoutMs: input.timeoutMs,
	});
	if (minted.timedOut || minted.exitCode !== 0) {
		return settle({
			ok: false,
			code: "pinned_open_handoff_mint_failed",
			prepareCalls,
			mintCalls,
			execCalls,
			browserUseErrorCode: publicEnvelopeErrorCode(minted.stdout),
		});
	}
	const mintData = publicEnvelopeData(minted.stdout);
	if (mintData === undefined) {
		return settle({
			ok: false,
			code: "pinned_open_invalid_envelope",
			prepareCalls,
			mintCalls,
			execCalls,
		});
	}
	// Prove the receipt came from THIS producer, for THIS run, bound to THIS
	// sealed artifact, before spending the one open. Anything else is a binding
	// mismatch, not something to open through and diagnose afterwards.
	if (
		mintData.contract !== BROWSER_USE_QUALIFICATION_HANDOFF_PRODUCER_CONTRACT_ID ||
		mintData.schema_version !==
			BROWSER_USE_QUALIFICATION_HANDOFF_PRODUCER_SCHEMA_VERSION ||
		mintData.command !== "qualification-handoff" ||
		mintData.producer !== "browser-connect" ||
		mintData.adapter !== "agent-browser" ||
		mintData.run_id !== input.runId ||
		mintData.expected_manifest_digest !== input.expectedManifestDigest ||
		mintData.observed_manifest_digest !== input.expectedManifestDigest
	) {
		return settle({
			ok: false,
			code: "pinned_open_binding_mismatch",
			prepareCalls,
			mintCalls,
			execCalls,
		});
	}

	execCalls += 1;
	const executed = await input.runCommand({
		command: input.executable,
		args: execArgv.argv,
		timeoutMs: input.timeoutMs,
	});
	if (executed.timedOut || executed.exitCode !== 0) {
		return settle({
			ok: false,
			code: "pinned_open_exec_failed",
			prepareCalls,
			mintCalls,
			execCalls,
			browserUseErrorCode: publicEnvelopeErrorCode(executed.stdout),
		});
	}
	const execData = publicEnvelopeData(executed.stdout);
	if (execData === undefined) {
		return settle({
			ok: false,
			code: "pinned_open_invalid_envelope",
			prepareCalls,
			mintCalls,
			execCalls,
		});
	}
	const custody = readCustody(execData, executed.stderr);
	return settle({
		ok: true,
		code: "pinned_open_observed",
		prepareCalls,
		mintCalls,
		execCalls,
		custody,
	}, custody.ownership_kind === "created-target" && custody.target_retained);
}

/** The gate decision, owned in one place so the entry cannot drift from it. */
export function shouldDispatchPinnedOpenLive(
	env: Readonly<Record<string, string | undefined>>,
): boolean {
	return env[PINNED_OPEN_IDENTITY_LIVE_GATE] === "1";
}

export type PinnedOpenDispatch = {
	readonly dispatched: boolean;
	readonly run?: PinnedOpenExecRun;
};

/**
 * The real gated entry. A live case calls exactly this, so the dispatch that
 * fixtures prove is the dispatch that would run.
 */
export async function dispatchPinnedOpenLive(
	input: PinnedOpenExecInput,
): Promise<PinnedOpenDispatch> {
	if (!shouldDispatchPinnedOpenLive(input.env)) return { dispatched: false };
	return { dispatched: true, run: await runPinnedOpenQualificationExec(input) };
}

export type PinnedOpenExecDiagnostic = {
	readonly ok: boolean;
	readonly code: string;
	readonly prepare_calls: number;
	readonly mint_calls: number;
	readonly exec_calls: number;
	readonly ownership_kind: string | null;
	readonly command_outcome: string | null;
	readonly fallback_adopted: boolean | null;
	readonly browser_use_error_code: string | null;
};

/**
 * Project one run into deterministic, leak-free metadata.
 *
 * Urls, digests, bundle, state and handoff paths, run ids, and target ids are
 * all dropped: a failing assertion must print the diagnosis without carrying
 * the operator's browsing state or the sealed binding into the output.
 */
export function pinnedOpenExecDiagnostic(
	result: PinnedOpenExecResult,
): PinnedOpenExecDiagnostic {
	return {
		ok: result.ok,
		code: result.code,
		prepare_calls: result.prepareCalls,
		mint_calls: result.mintCalls,
		exec_calls: result.execCalls,
		ownership_kind: result.ok ? result.custody.ownership_kind : null,
		command_outcome: result.ok ? result.custody.command_outcome : null,
		fallback_adopted: result.ok ? result.custody.fallback_adopted : null,
		browser_use_error_code: result.ok
			? null
			: (result.browserUseErrorCode ?? null),
	};
}
