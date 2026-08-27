import { createHash } from "node:crypto";

import { redactPathShape } from "./browser-use-core";

export const BROWSER_USE_TARGET_OPERATION_PLAN_CONTRACT_ID =
	"browser-use.target-operation-plan" as const;
/** Kept for callers that explicitly construct the original digest-only plan. */
export const BROWSER_USE_TARGET_OPERATION_PLAN_SCHEMA_VERSION = "1" as const;
export const BROWSER_USE_TARGET_OPERATION_PLAN_SCHEMA_VERSION_V2 = "2" as const;
export const BROWSER_USE_TARGET_OPERATION_PLAN_SCHEMA_VERSION_V3 = "3" as const;
export const BROWSER_USE_TARGET_OPERATION_PLAN_SCHEMA_VERSIONS = [
	BROWSER_USE_TARGET_OPERATION_PLAN_SCHEMA_VERSION,
	BROWSER_USE_TARGET_OPERATION_PLAN_SCHEMA_VERSION_V2,
	BROWSER_USE_TARGET_OPERATION_PLAN_SCHEMA_VERSION_V3,
] as const;
export const BROWSER_USE_TARGET_OPERATION_CAPABILITY_ID =
	"target-operation-plan.v3" as const;

export const BROWSER_USE_TARGET_OPERATION_MAX_STEPS = 64;
export const BROWSER_USE_TARGET_OPERATION_MAX_SELECTORS = 32;
export const BROWSER_USE_TARGET_OPERATION_MAX_COMPUTED_STYLE_PROPERTIES = 32;
export const BROWSER_USE_TARGET_OPERATION_MAX_ROWS = 128;
export const BROWSER_USE_TARGET_OPERATION_MAX_SELECTOR_LENGTH = 512;
export const BROWSER_USE_TARGET_OPERATION_MAX_STYLE_VALUE_BYTES = 2_048;
export const BROWSER_USE_TARGET_OPERATION_MAX_EVIDENCE_BYTES = 262_144;

const SAFE_SELECTOR = /^(?!\s*$)[^\0\n\r]{1,512}$/;
const SAFE_KEY = /^(?!\s*$)[^\0\n\r]{1,64}$/;
const SAFE_STORYBOOK_STORY_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const SAFE_STORYBOOK_COMPONENT = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const SAFE_STORYBOOK_CATALOGUE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_URL = (value: string): boolean => {
	if (value.length === 0 || value.length > 2_048) return false;
	try {
		const url = new URL(value);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			url.username === "" &&
			url.password === "" &&
			url.hash === ""
		);
	} catch {
		return false;
	}
};

export const TARGET_OPERATION_INSPECT_FIELDS = [
	"catalogue",
	"dom",
	"geometry",
	"computed-styles",
	"focus",
	"visibility",
	"scroll",
] as const;
export type BrowserUseTargetOperationInspectField =
	(typeof TARGET_OPERATION_INSPECT_FIELDS)[number];

/** Stable, deliberately small CSS vocabulary that may cross the public seam. */
export const BROWSER_USE_TARGET_OPERATION_CSS_PROPERTY_ALLOWLIST = [
	"align-items",
	"background-color",
	"border",
	"border-top-color",
	"border-top-style",
	"border-top-width",
	"border-right-color",
	"border-right-style",
	"border-right-width",
	"border-bottom-color",
	"border-bottom-style",
	"border-bottom-width",
	"border-left-color",
	"border-left-style",
	"border-left-width",
	"border-radius",
	"box-shadow",
	"color",
	"cursor",
	"display",
	"font-family",
	"font-size",
	"font-weight",
	"height",
	"letter-spacing",
	"line-height",
	"max-height",
	"max-width",
	"min-height",
	"min-width",
	"opacity",
	"outline",
	"outline-color",
	"outline-offset",
	"outline-style",
	"outline-width",
	"padding",
	"pointer-events",
	"visibility",
	"width",
	"word-spacing",
] as const;
export type BrowserUseTargetOperationCssProperty =
	(typeof BROWSER_USE_TARGET_OPERATION_CSS_PROPERTY_ALLOWLIST)[number];

type BrowserUseTargetOperationInspectStepV1 = {
	kind: "inspect";
	selector: string;
	fields: readonly BrowserUseTargetOperationInspectField[];
};

export type BrowserUseTargetOperationInspectStepV2 = {
	kind: "inspect";
	selector: string;
	fields: readonly Exclude<BrowserUseTargetOperationInspectField, "dom">[];
	computed_style_properties?: readonly BrowserUseTargetOperationCssProperty[];
	max_rows?: number;
};

export type BrowserUseStorybookDiagnosticExpectation = {
	expected_story_id: string;
	expected_component: string;
	expected_catalogue_version: string;
};

export type BrowserUseTargetOperationInspectStepV3 =
	BrowserUseTargetOperationInspectStepV2 & {
		storybook_diagnostic?: BrowserUseStorybookDiagnosticExpectation;
	};

export const TARGET_OPERATION_REVIEW_STATES = [
	"hover",
	"focus",
	"pressed",
	"none",
] as const;
export type BrowserUseTargetOperationReviewState =
	(typeof TARGET_OPERATION_REVIEW_STATES)[number];

export const TARGET_OPERATION_INPUT_ACTIONS = [
	"move",
	"click",
	"press",
	"release",
	"focus",
	"scroll",
] as const;
export type BrowserUseTargetOperationInputAction =
	(typeof TARGET_OPERATION_INPUT_ACTIONS)[number];

export const TARGET_OPERATION_CLEANUP_METHODS = [
	"close-control",
	"escape",
	"backdrop",
] as const;
export type BrowserUseTargetOperationCleanupMethod =
	(typeof TARGET_OPERATION_CLEANUP_METHODS)[number];

export type BrowserUseTargetOperationStep =
	| { kind: "navigate"; url: string }
	| BrowserUseTargetOperationInspectStepV1
	| BrowserUseTargetOperationInspectStepV2
	| BrowserUseTargetOperationInspectStepV3
	| {
			kind: "review-state";
			selector: string;
			state: BrowserUseTargetOperationReviewState;
	  }
	| {
			kind: "input";
			action: BrowserUseTargetOperationInputAction;
			selector?: string;
			key?: string;
			delta?: number;
			x?: number;
			y?: number;
	  }
	| {
			kind: "overlay-cleanup";
			method: BrowserUseTargetOperationCleanupMethod;
			/** Schema-v1 legacy surface/control selector. */
			selector?: string;
			/** Schema-v2 exact owned overlay surface selector. */
			surface_selector?: string;
			/** Schema-v2 close-control selector scoped within the owned surface. */
			control_selector?: string;
	  };

export type BrowserUseTargetOperationPlan = {
	contract: typeof BROWSER_USE_TARGET_OPERATION_PLAN_CONTRACT_ID;
	schema_version: (typeof BROWSER_USE_TARGET_OPERATION_PLAN_SCHEMA_VERSIONS)[number];
	scope: "target-local";
	steps: readonly BrowserUseTargetOperationStep[];
};

export type BrowserUseTargetOperationGeometry = {
	x: number;
	y: number;
	width: number;
	height: number;
	top: number;
	right: number;
	bottom: number;
	left: number;
};
export type BrowserUseTargetOperationFocus = { focused: boolean; contains_focus: boolean };
export type BrowserUseTargetOperationScroll = {
	scroll_left: number;
	scroll_top: number;
	scroll_width: number;
	scroll_height: number;
	client_width: number;
	client_height: number;
};
export type BrowserUseTargetOperationEvidenceTruncation = {
	reason: "max_rows_exceeded";
	observed_count: number;
	emitted_count: number;
	limit: number;
};
export type BrowserUseTargetOperationSelectorEvidence = {
	kind: "selector-observation";
	selector: string;
	fields: readonly Exclude<BrowserUseTargetOperationInspectField, "dom">[];
	computed_style_properties: readonly BrowserUseTargetOperationCssProperty[];
	max_rows: number;
	total_match_count: number;
	matches: readonly ({ ordinal: number } & Partial<{
		geometry: BrowserUseTargetOperationGeometry;
		visibility: boolean;
		focus: BrowserUseTargetOperationFocus;
		scroll: BrowserUseTargetOperationScroll;
		computed_styles: Readonly<Record<BrowserUseTargetOperationCssProperty, string>>;
	}> )[];
	truncation?: BrowserUseTargetOperationEvidenceTruncation;
};
export type BrowserUseTargetOperationCatalogueEvidence = {
	kind: "scenario-catalogue";
	root_selector: string;
	fields: readonly Exclude<BrowserUseTargetOperationInspectField, "dom">[];
	computed_style_properties: readonly BrowserUseTargetOperationCssProperty[];
	max_rows: number;
	component: string;
	catalogue_version: string;
	document_ready: boolean;
	interactions_ready: boolean;
	incomplete_image_count: number;
	play_readiness: {
		status: "complete";
		error: null;
		settlement_frames: number;
		visible_owned_overlays: 0;
		expanded: boolean;
	};
	overlay_catalogue: {
		total_record_count: number;
		records: readonly {
			scenario_id: string;
			implementation: string;
			overlay_present: boolean;
			target_selector: string | null;
			overlay_selector: string | null;
			trigger_selector: string | null;
			item_selector: string | null;
			role: string | null;
			cleanup_strategy: BrowserUseTargetOperationCleanupMethod | null;
			cleanup_selector: string | null;
			item_index: number | null;
			item_interaction: "none" | "hover" | "focus" | "press" | null;
			item_state: string | null;
		}[];
		truncation?: BrowserUseTargetOperationEvidenceTruncation;
	};
	matrix_regions: {
		total_region_count: number;
		regions: readonly {
			ordinal: number;
			selector: "[data-docs-matrix] .scrollbar-table[role=\"region\"]";
			total_target_count: number;
			targets: readonly {
				scenario_id: string;
				implementation: string;
				target_selector: string;
			}[];
			target_truncation?: BrowserUseTargetOperationEvidenceTruncation;
			scroll_left: number;
			scroll_width: number;
			client_width: number;
			at_right_edge: boolean;
		}[];
		truncation?: BrowserUseTargetOperationEvidenceTruncation;
	};
	total_row_count: number;
	rows: readonly ({
		ordinal: number;
		scenario_id: string;
		implementation: string;
		layer_id: string;
		selector: string;
		computed_style_properties: readonly BrowserUseTargetOperationCssProperty[];
	} & Partial<{
		geometry: BrowserUseTargetOperationGeometry;
		visibility: boolean;
		focus: BrowserUseTargetOperationFocus;
		scroll: BrowserUseTargetOperationScroll;
		computed_styles: Readonly<Record<BrowserUseTargetOperationCssProperty, string>>;
	}> )[];
	truncation?: BrowserUseTargetOperationEvidenceTruncation;
};
export type BrowserUseTargetOperationEvidence =
	| BrowserUseTargetOperationSelectorEvidence
	| BrowserUseTargetOperationCatalogueEvidence;

export const BROWSER_USE_TARGET_OPERATION_FAILURE_REASONS = [
	"adapter_eval_failed",
	"target_custody_failed",
	"exact_target_proof_failed",
	"evidence_budget_exceeded",
	"serialization_failed",
	"non_object_payload",
	"selector_mode_contract_failed",
	"selector_metadata_failed",
	"selector_cardinality_failed",
	"selector_row_failed",
	"selector_truncation_missing",
	"catalogue_kind_failed",
	"catalogue_field_mismatch",
	"catalogue_metadata_failed",
	"catalogue_cardinality_failed",
	"play_readiness_failed",
	"overlay_catalogue_failed",
	"matrix_region_failed",
	"catalogue_row_failed",
	"computed_style_property_failed",
	"observation_shape_failed",
	"row_order_failed",
	"catalogue_truncation_missing",
	"evidence_truncated",
] as const;

export type BrowserUseTargetOperationFailureReason =
	(typeof BROWSER_USE_TARGET_OPERATION_FAILURE_REASONS)[number];

export type BrowserUseTargetOperationFailureDetail = {
	reason: BrowserUseTargetOperationFailureReason;
	pointer: string;
};

export type BrowserUseTargetOperationEvidenceParseResult =
	| { ok: true; evidence: BrowserUseTargetOperationEvidence }
	| {
			ok: false;
			code: "target_operation_evidence_invalid" | "target_operation_evidence_truncated";
			failure_detail: BrowserUseTargetOperationFailureDetail;
			evidence?: BrowserUseTargetOperationEvidence;
	  };

export type BrowserUseStorybookDocumentDiagnostic = {
	contract: "browser-use.storybook-document-diagnostic";
	schema_version: "1";
	effective_document: {
		origin: string;
		path: string;
		expected_story_id_matches: boolean;
		view_mode: "story" | "docs" | "other" | "missing";
	};
	document_ready_state: "loading" | "interactive" | "complete" | "unknown";
	markers: {
		catalogue_version_count: number;
		component_count: number;
	};
	component_classification: "expected" | "missing" | "unknown" | "mismatch";
	catalogue_version_classification: "expected" | "missing" | "unknown" | "mismatch";
	expected_story_identity_represented: boolean | "unknown";
	storybook_document_classification:
		| "ready"
		| "missing-story"
		| "runtime-error"
		| "loading"
		| "unknown";
	navigation: {
		attempted: boolean;
		confirmed: boolean;
		changed_document: boolean;
	};
	continuity: {
		same_target_ref: true;
		pinned_session: true;
	};
	classification_digest: string;
};

export type BrowserUseTargetOperationStepOutcome =
	| {
				index: number;
				kind: "navigate";
				status: "confirmed";
				/** Observation-backed proof required for every confirmed navigation. */
				observation_digest: string;
		  }
	| {
				index: number;
				kind: "inspect";
				status: "confirmed";
				evidence: BrowserUseTargetOperationEvidence;
				storybook_document_diagnostic?: BrowserUseStorybookDocumentDiagnostic;
		  }
	| {
				index: number;
				kind: "inspect";
				status: "confirmed";
				/** Schema-v1 inspect proof, retained for the legacy plan contract. */
				observation_digest: string;
		  }
	| {
				index: number;
				kind: "review-state" | "input" | "overlay-cleanup";
				status: "confirmed";
				observation_digest?: string;
		  }
	| {
			index: number;
			kind: "inspect";
			status: "blocked";
			code: "target_operation_evidence_invalid" | "target_operation_evidence_truncated";
			evidence?: BrowserUseTargetOperationEvidence;
			storybook_document_diagnostic?: BrowserUseStorybookDocumentDiagnostic;
	  }
	| {
			index: number;
			kind: BrowserUseTargetOperationStep["kind"];
			status: "unknown";
			effect: "possibly-effectful";
	  };

export type BrowserUseTargetOperationCleanupEvidence = {
	attempted: boolean;
	closed: boolean;
	method?: BrowserUseTargetOperationCleanupMethod;
	surface_selector?: string;
	control_selector?: string;
	visible_owned_surface_count: number;
	exact_target_bound?: boolean;
};

/**
 * What the pre-dispatch baseline proof observed about the target's URL.
 *
 * Identity is the canonical target id and the bound origin, both fail-closed.
 * The URL discovery recorded is a settle hint, not an identity claim: a
 * single-page app rewrites its own query string without navigating, so a
 * same-origin difference is reported here rather than refused.
 */
export type BrowserUseTargetOperationBaseline = {
	/** True when the live URL never matched the URL discovery recorded. */
	url_drifted: boolean;
	/** URL reads the baseline took. 1 means the page matched immediately; more
	 * means it was still converging when the plan started. */
	settle_reads: number;
	/** Structure-only shape of the difference. Never a URL, value, or fragment. */
	drift_shape?: BrowserUseTargetOperationUrlDriftShape;
};

/** Structure-only description of one URL difference (no URL ever crosses this seam). */
export type BrowserUseTargetOperationUrlDriftShape = {
	origin_equal: boolean;
	path_equal: boolean;
	query_key_set_equal: boolean;
	query_keys_only_in_actual: readonly string[];
	query_keys_only_in_expected: readonly string[];
	normalized_href_equal: boolean;
	length_delta: number;
};

export type BrowserUseTargetOperationResult =
	| {
			ok: true;
			scope: "target-local";
			focus: false;
			capability_id: string;
			plan_schema_version: BrowserUseTargetOperationPlan["schema_version"];
			plan_digest: string;
			plan_step_count: number;
			steps: readonly BrowserUseTargetOperationStepOutcome[];
			cleanup: BrowserUseTargetOperationCleanupEvidence;
			baseline?: BrowserUseTargetOperationBaseline;
	  }
	| {
			ok: false;
			code:
				| "target_operation_plan_failed"
				| "target_operation_plan_unsupported"
			| "target_operation_cleanup_incomplete"
			| "target_operation_origin_mismatch"
			| "target_operation_evidence_invalid"
			| "target_operation_evidence_truncated";
			message: string;
			scope: "target-local";
			focus: false;
			capability_id: string;
			plan_schema_version: BrowserUseTargetOperationPlan["schema_version"];
			plan_digest: string;
			plan_step_count: number;
			steps: readonly BrowserUseTargetOperationStepOutcome[];
			cleanup: BrowserUseTargetOperationCleanupEvidence;
			failure_detail?: BrowserUseTargetOperationFailureDetail;
	  };

export type BrowserUseTargetOperationRuntime = {
	runCommand(input: {
		command: string;
		args: readonly string[];
		timeoutMs: number;
	}): Promise<{
		exitCode: number;
		stdout: string;
		stderr: string;
		timedOut?: boolean;
	}>;
};

export type BrowserUseTargetOperationAdapterRequest = {
	runtime: BrowserUseTargetOperationRuntime;
	env: Record<string, string | undefined>;
	handoff: {
		adapter_id: string;
		run_id: string;
		executable: string;
		endpoint_ws: string;
	};
	target_id: string;
	expected_url: string;
	/** Exact origin verified by Browser Use when it selected this target. */
	bound_origin?: string;
	plan: BrowserUseTargetOperationPlan;
	plan_digest: string;
	lifecycle_ref?: string;
	/** Browser Use-owned exact Target Operation Lease validity gate. */
	assert_custody?: () => Promise<{ ok: boolean; message?: string }>;
};

export class BrowserUseTargetOperationPlanError extends Error {
	readonly code = "target_operation_plan_invalid" as const;
}

const SAFE_EVIDENCE_TEXT = /^(?!\s*$)[^\0\n\r]{1,256}$/;
const EXACT_GEOMETRY_KEYS = ["x", "y", "width", "height", "top", "right", "bottom", "left"] as const;
const EXACT_SCROLL_KEYS = ["scroll_left", "scroll_top", "scroll_width", "scroll_height", "client_width", "client_height"] as const;

function evidenceRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function exactEvidenceKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function targetEvidenceFailure(
	reason: BrowserUseTargetOperationFailureReason,
	pointer: string,
	code: "target_operation_evidence_invalid" | "target_operation_evidence_truncated" = "target_operation_evidence_invalid",
	evidence?: BrowserUseTargetOperationEvidence,
): Extract<BrowserUseTargetOperationEvidenceParseResult, { ok: false }> {
	return {
		ok: false,
		code,
		failure_detail: { reason, pointer },
		...(evidence === undefined ? {} : { evidence }),
	};
}

const PUBLIC_FAILURE_STEP = String.raw`\/steps\/(?:0|[1-9][0-9]*)\/inspect`;
const PUBLIC_FAILURE_ROW = String.raw`(?:0|[1-9][0-9]*)`;

function publicFailurePointerMatches(
	reason: BrowserUseTargetOperationFailureReason,
	pointer: string,
): boolean {
	const matches = (suffix: string) => new RegExp(`^${PUBLIC_FAILURE_STEP}${suffix}$`).test(pointer);
	switch (reason) {
		case "adapter_eval_failed":
			return matches(String.raw`\/(?:adapter_result|storybook_document_diagnostic)`);
		case "target_custody_failed":
			return matches(String.raw`\/post-readiness`);
		case "exact_target_proof_failed":
			return matches(String.raw`\/post-readiness\/(?:origin_mismatch|url_read_failed|url_shape_failed|exact_url_mismatch|tab_gone)`);
		case "evidence_budget_exceeded":
		case "serialization_failed":
		case "non_object_payload":
			return matches(String.raw`\/evidence`);
		case "selector_mode_contract_failed":
		case "catalogue_kind_failed":
			return matches(String.raw`\/evidence\/kind`);
		case "selector_metadata_failed":
		case "catalogue_field_mismatch":
			return matches(String.raw`\/evidence\/metadata`);
		case "catalogue_metadata_failed":
			return matches(String.raw`\/evidence\/metadata\/(?:component|catalogue_version|document_ready|interactions_ready|incomplete_image_count|total_row_count|rows)`);
		case "selector_cardinality_failed":
			return matches(String.raw`\/evidence\/matches`);
		case "selector_row_failed":
			return matches(String.raw`\/evidence\/matches\/${PUBLIC_FAILURE_ROW}`);
		case "selector_truncation_missing":
		case "catalogue_truncation_missing":
			return matches(String.raw`\/evidence\/truncation`);
		case "catalogue_cardinality_failed":
			return matches(String.raw`\/evidence\/rows`);
		case "play_readiness_failed":
			return matches(String.raw`\/evidence\/play_readiness`);
		case "overlay_catalogue_failed":
			return matches(String.raw`\/evidence\/overlay_catalogue(?:\/records\/${PUBLIC_FAILURE_ROW})?`);
		case "matrix_region_failed":
			return matches(String.raw`\/evidence\/matrix_regions(?:\/regions\/${PUBLIC_FAILURE_ROW}(?:\/targets\/${PUBLIC_FAILURE_ROW})?)?`);
		case "catalogue_row_failed":
			return matches(String.raw`\/evidence\/rows\/${PUBLIC_FAILURE_ROW}`);
		case "computed_style_property_failed":
			return matches(String.raw`\/evidence\/rows\/${PUBLIC_FAILURE_ROW}\/computed_style_properties`);
		case "observation_shape_failed":
			return matches(String.raw`\/evidence\/(?:matches|rows)\/${PUBLIC_FAILURE_ROW}\/observation`);
		case "row_order_failed":
			return matches(String.raw`\/evidence\/rows\/${PUBLIC_FAILURE_ROW}\/order`);
		case "evidence_truncated":
			return matches(String.raw`\/evidence\/(?:truncation|overlay_catalogue\/truncation|matrix_regions\/truncation|matrix_regions\/regions\/${PUBLIC_FAILURE_ROW}\/target_truncation)`);
	}
}

/** Admit only the closed, code-owned public diagnostic shape. */
export function parseBrowserUseTargetOperationFailureDetail(
	value: unknown,
): BrowserUseTargetOperationFailureDetail | undefined {
	const record = evidenceRecord(value);
	if (
		!record ||
		!exactEvidenceKeys(record, ["reason", "pointer"]) ||
		typeof record.reason !== "string" ||
		!BROWSER_USE_TARGET_OPERATION_FAILURE_REASONS.includes(
			record.reason as BrowserUseTargetOperationFailureReason,
		) ||
		typeof record.pointer !== "string"
	) return undefined;
	const reason = record.reason as BrowserUseTargetOperationFailureReason;
	return publicFailurePointerMatches(reason, record.pointer)
		? { reason, pointer: record.pointer }
		: undefined;
}

function evidenceFiniteObject<T extends readonly string[]>(
	value: unknown,
	keys: T,
): Record<T[number], number> | undefined {
	const record = evidenceRecord(value);
	if (!record || !exactEvidenceKeys(record, keys)) return undefined;
	for (const key of keys) if (typeof record[key] !== "number" || !Number.isFinite(record[key])) return undefined;
	return record as Record<T[number], number>;
}

function evidenceStyles(
	value: unknown,
	properties: readonly BrowserUseTargetOperationCssProperty[],
): Readonly<Record<BrowserUseTargetOperationCssProperty, string>> | undefined {
	const record = evidenceRecord(value);
	if (!record || !exactEvidenceKeys(record, properties)) return undefined;
	for (const property of properties) {
		if (typeof record[property] !== "string" ||
			Buffer.byteLength(record[property] as string, "utf8") > BROWSER_USE_TARGET_OPERATION_MAX_STYLE_VALUE_BYTES ||
			styleValueHasUnsafePrivateText(record[property] as string)) return undefined;
	}
	return Object.fromEntries(
		properties.map((property) => [property, record[property] as string]),
	) as Readonly<Record<BrowserUseTargetOperationCssProperty, string>>;
}

function styleValueHasUnsafePrivateText(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code <= 31 || code === 127) return true;
	}
	return /(?:url\(|https?:|wss?:|file:)/i.test(value);
}

function evidenceTruncation(
	value: unknown,
	total: number,
	emitted: number,
	limit: number,
): BrowserUseTargetOperationEvidenceTruncation | undefined {
	const record = evidenceRecord(value);
	if (!record || !exactEvidenceKeys(record, ["reason", "observed_count", "emitted_count", "limit"]) ||
		record.reason !== "max_rows_exceeded" || record.observed_count !== total ||
		record.emitted_count !== emitted || record.limit !== limit || total <= emitted) return undefined;
	return { reason: "max_rows_exceeded", observed_count: total, emitted_count: emitted, limit };
}

function nullableEvidenceText(value: unknown): string | null | undefined {
	return value === null || (typeof value === "string" && SAFE_EVIDENCE_TEXT.test(value))
		? value
		: undefined;
}

function nullableSelector(value: unknown): string | null | undefined {
	return value === null || (typeof value === "string" && SAFE_SELECTOR.test(value))
		? value
		: undefined;
}

function parseCataloguePlayReadiness(value: unknown): BrowserUseTargetOperationCatalogueEvidence["play_readiness"] | undefined {
	const record = evidenceRecord(value);
	if (!record || !exactEvidenceKeys(record, ["status", "error", "settlement_frames", "visible_owned_overlays", "expanded"]) ||
		record.status !== "complete" || record.error !== null ||
		!Number.isSafeInteger(record.settlement_frames) || (record.settlement_frames as number) < 2 ||
		record.visible_owned_overlays !== 0 || typeof record.expanded !== "boolean") return undefined;
	return {
		status: "complete",
		error: null,
		settlement_frames: record.settlement_frames as number,
		visible_owned_overlays: 0,
		expanded: record.expanded,
	};
}

function parseOverlayCatalogue(
	value: unknown,
	limit: number,
): BrowserUseTargetOperationCatalogueEvidence["overlay_catalogue"] | undefined {
	const record = evidenceRecord(value);
	if (!record || !exactEvidenceKeys(record, ["total_record_count", "records", ...(record.truncation === undefined ? [] : ["truncation"])] ) ||
		!Number.isSafeInteger(record.total_record_count) || (record.total_record_count as number) < 0 ||
		!Array.isArray(record.records) || record.records.length > limit || record.records.length > (record.total_record_count as number)) return undefined;
	const records: BrowserUseTargetOperationCatalogueEvidence["overlay_catalogue"]["records"][number][] = [];
	let prior = "";
	for (const candidate of record.records) {
		const overlay = evidenceRecord(candidate);
		if (!overlay || !exactEvidenceKeys(overlay, ["scenario_id", "implementation", "overlay_present", "target_selector", "overlay_selector", "trigger_selector", "item_selector", "role", "cleanup_strategy", "cleanup_selector", "item_index", "item_interaction", "item_state"]) ||
			typeof overlay.scenario_id !== "string" || !SAFE_EVIDENCE_TEXT.test(overlay.scenario_id) ||
			typeof overlay.implementation !== "string" || !SAFE_EVIDENCE_TEXT.test(overlay.implementation) ||
			typeof overlay.overlay_present !== "boolean") return undefined;
		const targetSelector = nullableSelector(overlay.target_selector);
		const overlaySelector = nullableSelector(overlay.overlay_selector);
		const triggerSelector = nullableSelector(overlay.trigger_selector);
		const itemSelector = nullableSelector(overlay.item_selector);
		const role = nullableEvidenceText(overlay.role);
		const cleanupSelector = nullableSelector(overlay.cleanup_selector);
		const itemState = nullableEvidenceText(overlay.item_state);
		const strategy = overlay.cleanup_strategy === null ? null : TARGET_OPERATION_CLEANUP_METHODS.includes(overlay.cleanup_strategy as BrowserUseTargetOperationCleanupMethod) ? overlay.cleanup_strategy as BrowserUseTargetOperationCleanupMethod : undefined;
		const interaction = overlay.item_interaction === null ? null : ["none", "hover", "focus", "press"].includes(overlay.item_interaction as string) ? overlay.item_interaction as "none" | "hover" | "focus" | "press" : undefined;
		const itemIndex = overlay.item_index === null ? null : Number.isSafeInteger(overlay.item_index) && (overlay.item_index as number) >= 0 ? overlay.item_index as number : undefined;
		if ([targetSelector, overlaySelector, triggerSelector, itemSelector, role, cleanupSelector, itemState, strategy, interaction, itemIndex].some((field) => field === undefined)) return undefined;
		const reviewTuple = [itemSelector, itemIndex, interaction, itemState];
		const reviewTupleAbsent = reviewTuple.every((field) => field === null);
		const reviewTupleComplete = reviewTuple.every((field) => field !== null);
		if (!reviewTupleAbsent && !reviewTupleComplete) return undefined;
		if (!overlay.overlay_present) {
			if ([targetSelector, overlaySelector, triggerSelector, itemSelector, role, cleanupSelector, itemState, strategy, interaction, itemIndex].some((field) => field !== null)) return undefined;
		} else if (targetSelector === null || overlaySelector === null || triggerSelector === null || role === null || strategy === null ||
			(strategy === "close-control" && cleanupSelector === null) ||
			(strategy !== "close-control" && cleanupSelector !== null)) return undefined;
		const key = `${overlay.scenario_id}\0${overlay.implementation}`;
		if (key <= prior) return undefined;
		prior = key;
		records.push({ scenario_id: overlay.scenario_id, implementation: overlay.implementation, overlay_present: overlay.overlay_present, target_selector: targetSelector as string | null, overlay_selector: overlaySelector as string | null, trigger_selector: triggerSelector as string | null, item_selector: itemSelector as string | null, role: role as string | null, cleanup_strategy: strategy as BrowserUseTargetOperationCleanupMethod | null, cleanup_selector: cleanupSelector as string | null, item_index: itemIndex as number | null, item_interaction: interaction as "none" | "hover" | "focus" | "press" | null, item_state: itemState as string | null });
	}
	const truncation = record.truncation === undefined ? undefined : evidenceTruncation(record.truncation, record.total_record_count as number, records.length, limit);
	if ((record.total_record_count as number) > records.length && !truncation) return undefined;
	return { total_record_count: record.total_record_count as number, records, ...(truncation ? { truncation } : {}) };
}

function parseMatrixRegions(
	value: unknown,
	limit: number,
): BrowserUseTargetOperationCatalogueEvidence["matrix_regions"] | undefined {
	const record = evidenceRecord(value);
	if (!record || !exactEvidenceKeys(record, ["total_region_count", "regions", ...(record.truncation === undefined ? [] : ["truncation"])] ) ||
		!Number.isSafeInteger(record.total_region_count) || (record.total_region_count as number) < 0 ||
		!Array.isArray(record.regions) || record.regions.length > limit || record.regions.length > (record.total_region_count as number)) return undefined;
	const regions: BrowserUseTargetOperationCatalogueEvidence["matrix_regions"]["regions"][number][] = [];
	for (let ordinal = 0; ordinal < record.regions.length; ordinal += 1) {
		const region = evidenceRecord(record.regions[ordinal]);
		if (!region || !exactEvidenceKeys(region, ["ordinal", "selector", "total_target_count", "targets", "scroll_left", "scroll_width", "client_width", "at_right_edge", ...(region.target_truncation === undefined ? [] : ["target_truncation"])]) ||
			region.ordinal !== ordinal || region.selector !== '[data-docs-matrix] .scrollbar-table[role="region"]' ||
			!Number.isSafeInteger(region.total_target_count) || (region.total_target_count as number) < 0 || !Array.isArray(region.targets) || region.targets.length > limit || region.targets.length > (region.total_target_count as number) ||
			![region.scroll_left, region.scroll_width, region.client_width].every((metric) => typeof metric === "number" && Number.isFinite(metric) && metric >= 0) ||
			typeof region.at_right_edge !== "boolean" ||
			(region.scroll_width as number) < (region.client_width as number) ||
			(region.scroll_left as number) > (region.scroll_width as number) - (region.client_width as number) ||
			region.at_right_edge !== ((region.scroll_left as number) >= (region.scroll_width as number) - (region.client_width as number))) return undefined;
		const totalTargetCount = region.total_target_count as number;
		const scrollLeft = region.scroll_left as number;
		const scrollWidth = region.scroll_width as number;
		const clientWidth = region.client_width as number;
		const atRightEdge = region.at_right_edge as boolean;
		const targets: BrowserUseTargetOperationCatalogueEvidence["matrix_regions"]["regions"][number]["targets"][number][] = [];
		let targetPrior = "";
		for (const targetCandidate of region.targets) {
			const target = evidenceRecord(targetCandidate);
			if (!target || !exactEvidenceKeys(target, ["scenario_id", "implementation", "target_selector"]) || typeof target.scenario_id !== "string" || !SAFE_EVIDENCE_TEXT.test(target.scenario_id) || typeof target.implementation !== "string" || !SAFE_EVIDENCE_TEXT.test(target.implementation) || typeof target.target_selector !== "string" || !SAFE_SELECTOR.test(target.target_selector)) return undefined;
			const targetKey = `${target.scenario_id}\0${target.implementation}\0${target.target_selector}`;
			if (targetKey <= targetPrior) return undefined;
			targetPrior = targetKey;
			targets.push({ scenario_id: target.scenario_id, implementation: target.implementation, target_selector: target.target_selector });
		}
		const targetTruncation = region.target_truncation === undefined ? undefined : evidenceTruncation(region.target_truncation, totalTargetCount, targets.length, limit);
		if (totalTargetCount > targets.length && !targetTruncation) return undefined;
		regions.push({ ordinal, selector: '[data-docs-matrix] .scrollbar-table[role="region"]', total_target_count: totalTargetCount, targets, ...(targetTruncation ? { target_truncation: targetTruncation } : {}), scroll_left: scrollLeft, scroll_width: scrollWidth, client_width: clientWidth, at_right_edge: atRightEdge });
	}
	const truncation = record.truncation === undefined ? undefined : evidenceTruncation(record.truncation, record.total_region_count as number, regions.length, limit);
	if ((record.total_region_count as number) > regions.length && !truncation) return undefined;
	return { total_region_count: record.total_region_count as number, regions, ...(truncation ? { truncation } : {}) };
}

function requestedEvidenceFields(step: BrowserUseTargetOperationInspectStepV2): {
	geometry: boolean; visibility: boolean; focus: boolean; scroll: boolean;
	properties: readonly BrowserUseTargetOperationCssProperty[];
} {
	return {
		geometry: step.fields.includes("geometry"),
		visibility: step.fields.includes("visibility"),
		focus: step.fields.includes("focus"),
		scroll: step.fields.includes("scroll"),
		properties: step.computed_style_properties ?? [],
	};
}

function parseEvidenceObservation(
	value: unknown,
	ordinal: number,
	fields: ReturnType<typeof requestedEvidenceFields>,
): Record<string, unknown> | undefined {
	const record = evidenceRecord(value);
	const keys = ["ordinal", ...(fields.geometry ? ["geometry"] : []), ...(fields.visibility ? ["visibility"] : []), ...(fields.focus ? ["focus"] : []), ...(fields.scroll ? ["scroll"] : []), ...(fields.properties.length > 0 ? ["computed_styles"] : [])];
	if (!record || !exactEvidenceKeys(record, keys) || record.ordinal !== ordinal) return undefined;
	const result: Record<string, unknown> = { ordinal };
	if (fields.geometry) {
		const geometry = evidenceFiniteObject(record.geometry, EXACT_GEOMETRY_KEYS);
		if (!geometry) return undefined;
		result.geometry = geometry;
	}
	if (fields.visibility) {
		if (typeof record.visibility !== "boolean") return undefined;
		result.visibility = record.visibility;
	}
	if (fields.focus) {
		const focus = evidenceRecord(record.focus);
		if (!focus || !exactEvidenceKeys(focus, ["focused", "contains_focus"]) || typeof focus.focused !== "boolean" || typeof focus.contains_focus !== "boolean") return undefined;
		result.focus = { focused: focus.focused, contains_focus: focus.contains_focus };
	}
	if (fields.scroll) {
		const scroll = evidenceFiniteObject(record.scroll, EXACT_SCROLL_KEYS);
		if (!scroll) return undefined;
		result.scroll = scroll;
	}
	if (fields.properties.length > 0) {
		const styles = evidenceStyles(record.computed_styles, fields.properties);
		if (!styles) return undefined;
		result.computed_styles = styles;
	}
	return result;
}

/** Parse the sealed, adapter-produced typed evidence without exposing adapter bytes on refusal. */
export function parseBrowserUseTargetOperationEvidence(
	value: unknown,
	step: BrowserUseTargetOperationInspectStepV2,
): BrowserUseTargetOperationEvidenceParseResult {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch {
		return targetEvidenceFailure("serialization_failed", "/evidence");
	}
	if (serialized === undefined) return targetEvidenceFailure("non_object_payload", "/evidence");
	if (Buffer.byteLength(serialized, "utf8") > BROWSER_USE_TARGET_OPERATION_MAX_EVIDENCE_BYTES) {
		return targetEvidenceFailure("evidence_budget_exceeded", "/evidence");
	}
	const record = evidenceRecord(value);
	const fields = requestedEvidenceFields(step);
	if (!record) return targetEvidenceFailure("non_object_payload", "/evidence");
	if (record.kind === "selector-observation") {
		if (step.fields.includes("catalogue")) {
			return targetEvidenceFailure("selector_mode_contract_failed", "/evidence/kind");
		}
		const keys = ["kind", "selector", "fields", "computed_style_properties", "max_rows", "total_match_count", "matches", ...(record.truncation === undefined ? [] : ["truncation"])];
		if (!exactEvidenceKeys(record, keys) || record.selector !== step.selector ||
			JSON.stringify(record.fields) !== JSON.stringify(step.fields) ||
			JSON.stringify(record.computed_style_properties) !== JSON.stringify(step.computed_style_properties ?? []) ||
			record.max_rows !== (step.max_rows ?? BROWSER_USE_TARGET_OPERATION_MAX_ROWS)) {
			return targetEvidenceFailure("selector_metadata_failed", "/evidence/metadata");
		}
		if (!Number.isSafeInteger(record.total_match_count) || (record.total_match_count as number) < 0 || !Array.isArray(record.matches)) {
			return targetEvidenceFailure("selector_cardinality_failed", "/evidence/matches");
		}
		const limit = step.max_rows ?? BROWSER_USE_TARGET_OPERATION_MAX_ROWS;
		if (record.matches.length > limit || record.matches.length > (record.total_match_count as number)) {
			return targetEvidenceFailure("selector_cardinality_failed", "/evidence/matches");
		}
		const matches: Record<string, unknown>[] = [];
		for (let index = 0; index < record.matches.length; index += 1) {
			const candidate = evidenceRecord(record.matches[index]);
			if (!candidate || candidate.ordinal !== index) {
				return targetEvidenceFailure("selector_row_failed", `/evidence/matches/${index}`);
			}
			const match = parseEvidenceObservation(candidate, index, fields);
			if (!match) {
				return targetEvidenceFailure("observation_shape_failed", `/evidence/matches/${index}/observation`);
			}
			matches.push(match);
		}
		const truncation = record.truncation === undefined ? undefined : evidenceTruncation(record.truncation, record.total_match_count as number, matches.length, limit);
		if ((record.total_match_count as number) > matches.length && !truncation) {
			return targetEvidenceFailure("selector_truncation_missing", "/evidence/truncation");
		}
		const evidence: BrowserUseTargetOperationSelectorEvidence = { kind: "selector-observation", selector: step.selector, fields: step.fields, computed_style_properties: step.computed_style_properties ?? [], max_rows: step.max_rows ?? BROWSER_USE_TARGET_OPERATION_MAX_ROWS, total_match_count: record.total_match_count as number, matches: matches as unknown as BrowserUseTargetOperationSelectorEvidence["matches"], ...(truncation ? { truncation } : {}) };
		return truncation
			? targetEvidenceFailure("evidence_truncated", "/evidence/truncation", "target_operation_evidence_truncated", evidence)
			: { ok: true, evidence };
	}
	if (record.kind !== "scenario-catalogue") {
		return targetEvidenceFailure("catalogue_kind_failed", "/evidence/kind");
	}
	if (!step.fields.includes("catalogue")) {
		return targetEvidenceFailure("catalogue_field_mismatch", "/evidence/metadata");
	}
	const keys = ["kind", "root_selector", "fields", "computed_style_properties", "max_rows", "component", "catalogue_version", "document_ready", "interactions_ready", "incomplete_image_count", "play_readiness", "overlay_catalogue", "matrix_regions", "total_row_count", "rows", ...(record.truncation === undefined ? [] : ["truncation"])];
	if (!exactEvidenceKeys(record, keys) || record.root_selector !== step.selector ||
		JSON.stringify(record.fields) !== JSON.stringify(step.fields) ||
		JSON.stringify(record.computed_style_properties) !== JSON.stringify(step.computed_style_properties ?? []) ||
		record.max_rows !== (step.max_rows ?? BROWSER_USE_TARGET_OPERATION_MAX_ROWS)) {
		return targetEvidenceFailure("catalogue_field_mismatch", "/evidence/metadata");
	}
	if (typeof record.component !== "string" || !SAFE_EVIDENCE_TEXT.test(record.component) || record.component === "missing" || record.component === "unknown") {
		return targetEvidenceFailure("catalogue_metadata_failed", "/evidence/metadata/component");
	}
	if (typeof record.catalogue_version !== "string" || !SAFE_EVIDENCE_TEXT.test(record.catalogue_version) || record.catalogue_version === "missing" || record.catalogue_version === "unknown") {
		return targetEvidenceFailure("catalogue_metadata_failed", "/evidence/metadata/catalogue_version");
	}
	if (record.document_ready !== true) {
		return targetEvidenceFailure("catalogue_metadata_failed", "/evidence/metadata/document_ready");
	}
	const playReadiness = parseCataloguePlayReadiness(record.play_readiness);
	if (!playReadiness) return targetEvidenceFailure("play_readiness_failed", "/evidence/play_readiness");
	if (record.interactions_ready !== true) {
		return targetEvidenceFailure("catalogue_metadata_failed", "/evidence/metadata/interactions_ready");
	}
	if (!Number.isSafeInteger(record.incomplete_image_count) || record.incomplete_image_count !== 0) {
		return targetEvidenceFailure("catalogue_metadata_failed", "/evidence/metadata/incomplete_image_count");
	}
	if (!Number.isSafeInteger(record.total_row_count) || (record.total_row_count as number) < 1) {
		return targetEvidenceFailure("catalogue_metadata_failed", "/evidence/metadata/total_row_count");
	}
	if (!Array.isArray(record.rows)) {
		return targetEvidenceFailure("catalogue_metadata_failed", "/evidence/metadata/rows");
	}
	const limit = step.max_rows ?? BROWSER_USE_TARGET_OPERATION_MAX_ROWS;
	if (record.rows.length > limit || record.rows.length > (record.total_row_count as number)) {
		return targetEvidenceFailure("catalogue_cardinality_failed", "/evidence/rows");
	}
	const overlayCatalogue = parseOverlayCatalogue(record.overlay_catalogue, limit);
	const matrixRegions = parseMatrixRegions(record.matrix_regions, limit);
	if (!overlayCatalogue) return targetEvidenceFailure("overlay_catalogue_failed", "/evidence/overlay_catalogue");
	if (!matrixRegions) return targetEvidenceFailure("matrix_region_failed", "/evidence/matrix_regions");
	const rows: Record<string, unknown>[] = [];
	let prior = "";
	for (let index = 0; index < record.rows.length; index += 1) {
		const row = evidenceRecord(record.rows[index]);
		if (!row || typeof row.scenario_id !== "string" || typeof row.implementation !== "string" || typeof row.layer_id !== "string" || typeof row.selector !== "string" || !SAFE_EVIDENCE_TEXT.test(row.scenario_id) || !SAFE_EVIDENCE_TEXT.test(row.implementation) || !SAFE_EVIDENCE_TEXT.test(row.layer_id) || !SAFE_SELECTOR.test(row.selector) || !Array.isArray(row.computed_style_properties)) {
			return targetEvidenceFailure("catalogue_row_failed", `/evidence/rows/${index}`);
		}
		const properties = row.computed_style_properties.map((property) => BROWSER_USE_TARGET_OPERATION_CSS_PROPERTY_ALLOWLIST.includes(property as BrowserUseTargetOperationCssProperty) ? property as BrowserUseTargetOperationCssProperty : undefined);
		if (properties.some((property) => property === undefined) || new Set(properties).size !== properties.length || properties.length > BROWSER_USE_TARGET_OPERATION_MAX_COMPUTED_STYLE_PROPERTIES) {
			return targetEvidenceFailure("computed_style_property_failed", `/evidence/rows/${index}/computed_style_properties`);
		}
		const rowFields = { ...fields, properties: properties as BrowserUseTargetOperationCssProperty[] };
		const observed = parseEvidenceObservation({
			ordinal: row.ordinal,
			...(fields.geometry ? { geometry: row.geometry } : {}),
			...(fields.visibility ? { visibility: row.visibility } : {}),
			...(fields.focus ? { focus: row.focus } : {}),
			...(fields.scroll ? { scroll: row.scroll } : {}),
			...(properties.length > 0 ? { computed_styles: row.computed_styles } : {}),
		}, index, rowFields);
		const rowKeys = ["ordinal", "scenario_id", "implementation", "layer_id", "selector", "computed_style_properties", ...(fields.geometry ? ["geometry"] : []), ...(fields.visibility ? ["visibility"] : []), ...(fields.focus ? ["focus"] : []), ...(fields.scroll ? ["scroll"] : []), ...(properties.length > 0 ? ["computed_styles"] : [])];
		if (!observed || !exactEvidenceKeys(row, rowKeys)) {
			return targetEvidenceFailure("observation_shape_failed", `/evidence/rows/${index}/observation`);
		}
		const sortKey = `${row.scenario_id}\0${row.implementation}\0${row.layer_id}\0${row.selector}`;
		if (sortKey <= prior) return targetEvidenceFailure("row_order_failed", `/evidence/rows/${index}/order`);
		prior = sortKey;
		rows.push({ ...observed, scenario_id: row.scenario_id, implementation: row.implementation, layer_id: row.layer_id, selector: row.selector, computed_style_properties: properties });
	}
	const truncation = record.truncation === undefined ? undefined : evidenceTruncation(record.truncation, record.total_row_count as number, rows.length, limit);
	if ((record.total_row_count as number) > rows.length && !truncation) {
		return targetEvidenceFailure("catalogue_truncation_missing", "/evidence/truncation");
	}
	const evidence: BrowserUseTargetOperationCatalogueEvidence = { kind: "scenario-catalogue", root_selector: step.selector, fields: step.fields, computed_style_properties: step.computed_style_properties ?? [], max_rows: step.max_rows ?? BROWSER_USE_TARGET_OPERATION_MAX_ROWS, component: record.component, catalogue_version: record.catalogue_version, document_ready: true, interactions_ready: true, incomplete_image_count: 0, play_readiness: playReadiness, overlay_catalogue: overlayCatalogue, matrix_regions: matrixRegions, total_row_count: record.total_row_count as number, rows: rows as unknown as BrowserUseTargetOperationCatalogueEvidence["rows"], ...(truncation ? { truncation } : {}) };
	if (truncation) return targetEvidenceFailure("evidence_truncated", "/evidence/truncation", "target_operation_evidence_truncated", evidence);
	if (overlayCatalogue.truncation) return targetEvidenceFailure("evidence_truncated", "/evidence/overlay_catalogue/truncation", "target_operation_evidence_truncated", evidence);
	if (matrixRegions.truncation) return targetEvidenceFailure("evidence_truncated", "/evidence/matrix_regions/truncation", "target_operation_evidence_truncated", evidence);
	const truncatedRegion = matrixRegions.regions.findIndex((region) => region.target_truncation !== undefined);
	return truncatedRegion >= 0
		? targetEvidenceFailure("evidence_truncated", `/evidence/matrix_regions/regions/${truncatedRegion}/target_truncation`, "target_operation_evidence_truncated", evidence)
		: { ok: true, evidence };
}

/** Reconstruct the sealed v2 inspect request from public evidence metadata. */
export function parsePublicBrowserUseTargetOperationEvidence(
	value: unknown,
): BrowserUseTargetOperationEvidenceParseResult {
	const record = evidenceRecord(value);
	const selector = record?.kind === "selector-observation" ? record.selector : record?.root_selector;
	if (!record || typeof selector !== "string" || !Array.isArray(record.fields) ||
		!Array.isArray(record.computed_style_properties) || typeof record.max_rows !== "number" ||
		!Number.isSafeInteger(record.max_rows)) {
		return targetEvidenceFailure("non_object_payload", "/evidence");
	}
	try {
		if (!SAFE_SELECTOR.test(selector)) throw new Error();
		const fields = record.fields.map((field, index) => enumValue(
			field, `evidence.fields[${index}]`, TARGET_OPERATION_INSPECT_FIELDS,
		));
		if (fields.includes("dom") || fields.length === 0 || new Set(fields).size !== fields.length ||
			(fields.includes("catalogue") !== (record.kind === "scenario-catalogue"))) throw new Error();
		const properties = record.computed_style_properties.map((property, index) => enumValue(
			property, `evidence.computed_style_properties[${index}]`, BROWSER_USE_TARGET_OPERATION_CSS_PROPERTY_ALLOWLIST,
		));
		if (new Set(properties).size !== properties.length ||
			(fields.includes("computed-styles") !== (properties.length > 0)) ||
			record.max_rows < 1 || record.max_rows > BROWSER_USE_TARGET_OPERATION_MAX_ROWS) throw new Error();
		return parseBrowserUseTargetOperationEvidence(value, {
			kind: "inspect",
			selector,
			fields: fields as Exclude<BrowserUseTargetOperationInspectField, "dom">[],
			...(properties.length === 0 ? {} : { computed_style_properties: properties }),
			max_rows: record.max_rows,
		});
	} catch {
		return targetEvidenceFailure(
			record.kind === "scenario-catalogue" ? "catalogue_field_mismatch" : "selector_metadata_failed",
			"/evidence/metadata",
		);
	}
}

/**
 * The plan is adapter-neutral, but Browser Use binds every navigation to the
 * exact origin proven for the selected target. Adapters call this defensively;
 * the operation lane applies the same preflight before any native dispatch.
 */
export function targetOperationPlanMatchesBoundOrigin(
	plan: BrowserUseTargetOperationPlan,
	boundOrigin: string,
): boolean {
	try {
		const parsedBoundOrigin = new URL(boundOrigin);
		if (parsedBoundOrigin.origin !== boundOrigin) return false;
		return plan.steps.every(
			(step) => step.kind !== "navigate" || new URL(step.url).origin === boundOrigin,
		);
	} catch {
		return false;
	}
}

/** Whether this closed plan can change the selected target or its visible UI state. */
export function targetOperationPlanIsMutating(
	plan: BrowserUseTargetOperationPlan,
): boolean {
	return plan.steps.some((step) => step.kind !== "inspect");
}

function fail(message: string): never {
	throw new BrowserUseTargetOperationPlanError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const accepted = new Set(allowed);
	return Object.keys(value).every((key) => accepted.has(key));
}

function stringValue(value: unknown, label: string, pattern: RegExp): string {
	if (typeof value !== "string" || !pattern.test(value)) fail(`${label} is invalid.`);
	return value;
}

function enumValue<T extends readonly string[]>(
	value: unknown,
	label: string,
	allowed: T,
): T[number] {
	if (typeof value !== "string" || !allowed.includes(value)) {
		fail(`${label} is invalid.`);
	}
	return value as T[number];
}

function finiteNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} is invalid.`);
	return value;
}

function parseStep(
	value: unknown,
	index: number,
	schemaVersion: BrowserUseTargetOperationPlan["schema_version"],
): BrowserUseTargetOperationStep {
	if (!isRecord(value) || typeof value.kind !== "string") {
		fail(`steps[${index}] is invalid.`);
	}
		switch (value.kind) {
		case "navigate":
			if (
				!exactKeys(value, ["kind", "url"]) ||
				typeof value.url !== "string" ||
				!SAFE_URL(value.url)
			) {
				fail(`steps[${index}] navigate is invalid.`);
			}
			return { kind: "navigate", url: value.url };
		case "inspect": {
			const inspectKeys = schemaVersion === "1"
				? ["kind", "selector", "fields"]
				: schemaVersion === "2"
					? ["kind", "selector", "fields", "computed_style_properties", "max_rows"]
					: ["kind", "selector", "fields", "computed_style_properties", "max_rows", "storybook_diagnostic"];
			if (!exactKeys(value, inspectKeys) || !Array.isArray(value.fields)) {
				fail(`steps[${index}] inspect is invalid.`);
			}
			const selector = stringValue(value.selector, `steps[${index}].selector`, SAFE_SELECTOR);
			const fields = value.fields.map((field, fieldIndex) =>
				enumValue(
					field,
					`steps[${index}].fields[${fieldIndex}]`,
					TARGET_OPERATION_INSPECT_FIELDS,
				),
			);
			if (fields.length === 0 || new Set(fields).size !== fields.length) {
				fail(`steps[${index}] inspect fields are invalid.`);
			}
			if (schemaVersion === "1") return { kind: "inspect", selector, fields };
			if (fields.includes("dom")) fail(`steps[${index}] typed inspect does not expose DOM.`);
			const properties = value.computed_style_properties;
			if (properties !== undefined) {
				if (!fields.includes("computed-styles") || !Array.isArray(properties) ||
					properties.length === 0 ||
					properties.length > BROWSER_USE_TARGET_OPERATION_MAX_COMPUTED_STYLE_PROPERTIES) {
					fail(`steps[${index}] computed style properties are invalid.`);
				}
				const normalized = properties.map((property, propertyIndex) => enumValue(
					property,
					`steps[${index}].computed_style_properties[${propertyIndex}]`,
					BROWSER_USE_TARGET_OPERATION_CSS_PROPERTY_ALLOWLIST,
				));
				if (new Set(normalized).size !== normalized.length) fail(`steps[${index}] computed style properties are invalid.`);
			}
			if (fields.includes("computed-styles") !== (properties !== undefined)) {
				fail(`steps[${index}] computed style properties are required exactly with computed-styles.`);
			}
			const maxRows = value.max_rows;
			if (maxRows !== undefined && (typeof maxRows !== "number" || !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > BROWSER_USE_TARGET_OPERATION_MAX_ROWS)) {
				fail(`steps[${index}] max rows are invalid.`);
			}
			let storybookDiagnostic: BrowserUseStorybookDiagnosticExpectation | undefined;
			if (schemaVersion === "3" && value.storybook_diagnostic !== undefined) {
				const diagnostic = value.storybook_diagnostic;
				if (!isRecord(diagnostic) || !exactKeys(diagnostic, [
					"expected_story_id",
					"expected_component",
					"expected_catalogue_version",
				])) fail(`steps[${index}] Storybook diagnostic is invalid.`);
				storybookDiagnostic = {
					expected_story_id: stringValue(
						diagnostic.expected_story_id,
						`steps[${index}].storybook_diagnostic.expected_story_id`,
						SAFE_STORYBOOK_STORY_ID,
					),
					expected_component: stringValue(
						diagnostic.expected_component,
						`steps[${index}].storybook_diagnostic.expected_component`,
						SAFE_STORYBOOK_COMPONENT,
					),
					expected_catalogue_version: stringValue(
						diagnostic.expected_catalogue_version,
						`steps[${index}].storybook_diagnostic.expected_catalogue_version`,
						SAFE_STORYBOOK_CATALOGUE_VERSION,
					),
				};
				if (selector !== "[data-path-parity-catalogue-version]" || !fields.includes("catalogue")) {
					fail(`steps[${index}] Storybook diagnostic requires the fixed Scenario Catalogue selector.`);
				}
			}
			return {
				kind: "inspect",
				selector,
				fields: fields as readonly Exclude<BrowserUseTargetOperationInspectField, "dom">[],
				...(properties === undefined ? {} : { computed_style_properties: properties as readonly BrowserUseTargetOperationCssProperty[] }),
				...(maxRows === undefined ? {} : { max_rows: maxRows }),
				...(storybookDiagnostic === undefined ? {} : { storybook_diagnostic: storybookDiagnostic }),
			};
		}
		case "review-state":
			if (!exactKeys(value, ["kind", "selector", "state"])) {
				fail(`steps[${index}] review-state is invalid.`);
			}
			return {
				kind: "review-state",
				selector: stringValue(value.selector, `steps[${index}].selector`, SAFE_SELECTOR),
				state: enumValue(value.state, `steps[${index}].state`, TARGET_OPERATION_REVIEW_STATES),
			};
		case "input": {
			const action = enumValue(value.action, `steps[${index}].action`, TARGET_OPERATION_INPUT_ACTIONS);
			const allowedKeys = action === "move"
				? ["kind", "action", "x", "y"]
				: action === "click" || action === "focus"
					? ["kind", "action", "selector"]
					: action === "press"
						? ["kind", "action", "key"]
						: action === "release"
							? ["kind", "action"]
							: ["kind", "action", "delta"];
			if (!exactKeys(value, allowedKeys)) fail(`steps[${index}] ${action} input is invalid.`);
			const selector = value.selector === undefined
				? undefined
				: stringValue(value.selector, `steps[${index}].selector`, SAFE_SELECTOR);
			const key = value.key === undefined
				? undefined
				: stringValue(value.key, `steps[${index}].key`, SAFE_KEY);
			const delta = value.delta === undefined ? undefined : finiteNumber(value.delta, `steps[${index}].delta`);
			const x = value.x === undefined ? undefined : finiteNumber(value.x, `steps[${index}].x`);
			const y = value.y === undefined ? undefined : finiteNumber(value.y, `steps[${index}].y`);
			if (["click", "focus"].includes(action) && selector === undefined) {
				fail(`steps[${index}] ${action} requires selector.`);
			}
			if (action === "move" && (selector !== undefined || x === undefined || y === undefined)) {
				fail(`steps[${index}] move requires x and y without a selector.`);
			}
			if (action === "press" && key === undefined) {
				fail(`steps[${index}] ${action} requires key.`);
			}
			if (action === "release" && key !== undefined) {
				fail(`steps[${index}] release must not include key.`);
			}
			if (action === "scroll" && delta === undefined) fail(`steps[${index}] scroll requires delta.`);
			return {
				kind: "input",
				action,
				...(selector === undefined ? {} : { selector }),
				...(key === undefined ? {} : { key }),
				...(delta === undefined ? {} : { delta }),
				...(x === undefined ? {} : { x }),
				...(y === undefined ? {} : { y }),
			};
		}
		case "overlay-cleanup": {
			const method = enumValue(value.method, `steps[${index}].method`, TARGET_OPERATION_CLEANUP_METHODS);
			if (schemaVersion !== "1") {
				const allowedKeys = method === "close-control"
					? ["kind", "method", "surface_selector", "control_selector"]
					: method === "escape"
						? ["kind", "method", "surface_selector"]
						: ["kind", "method"];
				if (!exactKeys(value, allowedKeys)) fail(`steps[${index}] ${method} cleanup is invalid.`);
				if (method === "backdrop") return { kind: "overlay-cleanup", method };
				const surfaceSelector = stringValue(value.surface_selector, `steps[${index}].surface_selector`, SAFE_SELECTOR);
				const controlSelector = method === "close-control"
					? stringValue(value.control_selector, `steps[${index}].control_selector`, SAFE_SELECTOR)
					: undefined;
				if (controlSelector?.includes(",")) fail(`steps[${index}].control_selector must name one control.`);
				return { kind: "overlay-cleanup", method, surface_selector: surfaceSelector, ...(controlSelector === undefined ? {} : { control_selector: controlSelector }) };
			}
			if (
				!exactKeys(
					value,
					method === "close-control"
						? ["kind", "method", "selector"]
						: ["kind", "method"],
				)
			) fail(`steps[${index}] ${method} cleanup is invalid.`);
			const selector = value.selector === undefined
				? undefined
				: stringValue(value.selector, `steps[${index}].selector`, SAFE_SELECTOR);
			if (method === "close-control" && selector === undefined) {
				fail(`steps[${index}] overlay-cleanup requires selector.`);
			}
			return {
				kind: "overlay-cleanup",
				method,
				...(selector === undefined ? {} : { selector }),
			};
		}
		default:
			fail(`steps[${index}] uses an unknown typed step.`);
	}
}

export function parseBrowserUseTargetOperationPlan(
	value: unknown,
): BrowserUseTargetOperationPlan {
	if (!isRecord(value) || !exactKeys(value, ["contract", "schema_version", "steps"])) {
		fail("target operation plan must be a closed object.");
	}
	if (value.contract !== BROWSER_USE_TARGET_OPERATION_PLAN_CONTRACT_ID) {
		fail("target operation plan contract is invalid.");
	}
	if (!BROWSER_USE_TARGET_OPERATION_PLAN_SCHEMA_VERSIONS.includes(
		value.schema_version as BrowserUseTargetOperationPlan["schema_version"],
	)) {
		fail("target operation plan schema version is invalid.");
	}
	if (!Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > BROWSER_USE_TARGET_OPERATION_MAX_STEPS) {
		fail("target operation plan steps are invalid.");
	}
	const schemaVersion = value.schema_version as BrowserUseTargetOperationPlan["schema_version"];
	const steps = value.steps.map((step, index) => parseStep(step, index, schemaVersion));
	if (schemaVersion === "3") {
		const diagnosticIndexes = steps.flatMap((step, index) =>
			step.kind === "inspect" && "storybook_diagnostic" in step && step.storybook_diagnostic !== undefined
				? [index]
				: [],
		);
		if (diagnosticIndexes.length !== 1) fail("target operation plan schema v3 requires exactly one Storybook diagnostic.");
		for (const index of diagnosticIndexes) {
			const diagnosticStep = steps[index] as BrowserUseTargetOperationInspectStepV3;
			const navigate = steps[index - 1];
			if (navigate?.kind !== "navigate") {
				fail(`steps[${index}] Storybook diagnostic requires an immediately preceding navigation.`);
			}
			const url = new URL(navigate.url);
			const keys = [...new Set(url.searchParams.keys())].sort();
			if (
				url.pathname !== "/iframe.html" ||
				JSON.stringify(keys) !== JSON.stringify(["id", "viewMode"]) ||
				url.searchParams.getAll("id").length !== 1 ||
				url.searchParams.getAll("viewMode").length !== 1 ||
				url.searchParams.get("id") !== diagnosticStep.storybook_diagnostic?.expected_story_id ||
				!(["story", "docs"] as const).includes(
					url.searchParams.get("viewMode") as "story" | "docs",
				)
			) fail(`steps[${index}] Storybook diagnostic navigation identity is invalid.`);
		}
	}
	const selectors = new Set(
		steps.flatMap((step) => [
			...("selector" in step && step.selector !== undefined ? [step.selector] : []),
			...("surface_selector" in step && step.surface_selector !== undefined ? [step.surface_selector] : []),
			...("control_selector" in step && step.control_selector !== undefined ? [step.control_selector] : []),
		]),
	);
	if (selectors.size > BROWSER_USE_TARGET_OPERATION_MAX_SELECTORS) {
		fail("target operation plan selectors are invalid.");
	}
	return {
		contract: BROWSER_USE_TARGET_OPERATION_PLAN_CONTRACT_ID,
		schema_version: schemaVersion,
		scope: "target-local",
		steps,
	};
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

const STORYBOOK_READY_STATES = ["loading", "interactive", "complete", "unknown"] as const;
const STORYBOOK_MARKER_CLASSIFICATIONS = ["expected", "missing", "unknown", "mismatch"] as const;
const STORYBOOK_RAW_STATES = ["main", "missing-story", "runtime-error", "loading", "unknown"] as const;
const STORYBOOK_DOCUMENT_CLASSIFICATIONS = ["ready", "missing-story", "runtime-error", "loading", "unknown"] as const;
const STORYBOOK_VIEW_MODES = ["story", "docs", "other", "missing"] as const;

function diagnosticDigest(
	value: Omit<BrowserUseStorybookDocumentDiagnostic, "classification_digest">,
): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * Admit the fixed adapter projection and join it to the exact effective URL
 * proven by the pinned Agent Browser target. Page-controlled values never
 * cross this function: the adapter emits only counts and closed enums.
 */
export function buildBrowserUseStorybookDocumentDiagnostic(input: {
	expectation: BrowserUseStorybookDiagnosticExpectation;
	effective_url: string;
	raw_projection: unknown;
	navigation: {
		attempted: boolean;
		confirmed: boolean;
		changed_document: boolean;
	};
}): BrowserUseStorybookDocumentDiagnostic | undefined {
	if (
		!SAFE_STORYBOOK_STORY_ID.test(input.expectation.expected_story_id) ||
		!SAFE_STORYBOOK_COMPONENT.test(input.expectation.expected_component) ||
		!SAFE_STORYBOOK_CATALOGUE_VERSION.test(input.expectation.expected_catalogue_version) ||
		typeof input.navigation.attempted !== "boolean" ||
		typeof input.navigation.confirmed !== "boolean" ||
		typeof input.navigation.changed_document !== "boolean"
	) return undefined;
	const raw = isRecord(input.raw_projection) ? input.raw_projection : undefined;
	if (
		!raw ||
		!exactKeys(raw, [
			"document_ready_state",
			"catalogue_version_count",
			"component_count",
			"component_classification",
			"catalogue_version_classification",
			"storybook_state",
		]) ||
		!STORYBOOK_READY_STATES.includes(raw.document_ready_state as (typeof STORYBOOK_READY_STATES)[number]) ||
		!STORYBOOK_MARKER_CLASSIFICATIONS.includes(raw.component_classification as (typeof STORYBOOK_MARKER_CLASSIFICATIONS)[number]) ||
		!STORYBOOK_MARKER_CLASSIFICATIONS.includes(raw.catalogue_version_classification as (typeof STORYBOOK_MARKER_CLASSIFICATIONS)[number]) ||
		!STORYBOOK_RAW_STATES.includes(raw.storybook_state as (typeof STORYBOOK_RAW_STATES)[number]) ||
		!Number.isSafeInteger(raw.catalogue_version_count) ||
		!Number.isSafeInteger(raw.component_count) ||
		(raw.catalogue_version_count as number) < 0 ||
		(raw.catalogue_version_count as number) > 1 ||
		(raw.component_count as number) < 0 ||
		(raw.component_count as number) > 1
	) return undefined;
	const componentCount = raw.component_count as number;
	const catalogueVersionCount = raw.catalogue_version_count as number;
	const componentClassification = raw.component_classification as (typeof STORYBOOK_MARKER_CLASSIFICATIONS)[number];
	const catalogueVersionClassification = raw.catalogue_version_classification as (typeof STORYBOOK_MARKER_CLASSIFICATIONS)[number];
	if (
		(componentCount === 0) !== (componentClassification === "missing") ||
		(catalogueVersionCount === 0) !== (catalogueVersionClassification === "missing")
	) return undefined;
	let effective: URL;
	try {
		effective = new URL(input.effective_url);
	} catch {
		return undefined;
	}
	if (
		(effective.protocol !== "http:" && effective.protocol !== "https:") ||
		effective.username !== "" ||
		effective.password !== "" ||
		effective.hash !== ""
	) return undefined;
	const storyIds = effective.searchParams.getAll("id");
	const viewModes = effective.searchParams.getAll("viewMode");
	if (storyIds.length > 1 || viewModes.length > 1) return undefined;
	const expectedStoryIdMatches =
		storyIds.length === 1 && storyIds[0] === input.expectation.expected_story_id;
	const viewMode = viewModes.length === 0
		? "missing"
		: viewModes.length === 1 && (viewModes[0] === "story" || viewModes[0] === "docs")
			? viewModes[0]
			: "other";
	const storybookState = raw.storybook_state as (typeof STORYBOOK_RAW_STATES)[number];
	const documentReadyState = raw.document_ready_state as (typeof STORYBOOK_READY_STATES)[number];
	const storybookDocumentClassification = storybookState === "missing-story"
		? "missing-story"
		: storybookState === "runtime-error"
			? "runtime-error"
			: documentReadyState === "loading" || storybookState === "loading"
				? "loading"
				: storybookState === "main" && componentClassification === "expected" &&
					catalogueVersionClassification === "expected"
					? "ready"
					: "unknown";
	const expectedStoryIdentityRepresented = !expectedStoryIdMatches
		? false
		: componentClassification === "expected"
			? true
			: componentClassification === "mismatch"
				? false
				: "unknown";
	const withoutDigest: Omit<BrowserUseStorybookDocumentDiagnostic, "classification_digest"> = {
		contract: "browser-use.storybook-document-diagnostic",
		schema_version: "1",
		effective_document: {
			origin: effective.origin,
			path: redactPathShape(new URL(effective.pathname, effective.origin)),
			expected_story_id_matches: expectedStoryIdMatches,
			view_mode: viewMode,
		},
		document_ready_state: documentReadyState,
		markers: {
			catalogue_version_count: catalogueVersionCount,
			component_count: componentCount,
		},
		component_classification: componentClassification,
		catalogue_version_classification: catalogueVersionClassification,
		expected_story_identity_represented: expectedStoryIdentityRepresented,
		storybook_document_classification: storybookDocumentClassification,
		navigation: input.navigation,
		continuity: { same_target_ref: true, pinned_session: true },
	};
	return { ...withoutDigest, classification_digest: diagnosticDigest(withoutDigest) };
}

/** Validate the complete sanitized public projection and its canonical digest. */
export function parsePublicBrowserUseStorybookDocumentDiagnostic(
	value: unknown,
): BrowserUseStorybookDocumentDiagnostic | undefined {
	const record = isRecord(value) ? value : undefined;
	const effective = isRecord(record?.effective_document) ? record.effective_document : undefined;
	const markers = isRecord(record?.markers) ? record.markers : undefined;
	const navigation = isRecord(record?.navigation) ? record.navigation : undefined;
	const continuity = isRecord(record?.continuity) ? record.continuity : undefined;
	if (
		!record ||
		!exactKeys(record, [
			"contract", "schema_version", "effective_document", "document_ready_state", "markers",
			"component_classification", "catalogue_version_classification",
			"expected_story_identity_represented", "storybook_document_classification",
			"navigation", "continuity", "classification_digest",
		]) ||
		record.contract !== "browser-use.storybook-document-diagnostic" ||
		record.schema_version !== "1" ||
		!effective || !exactKeys(effective, ["origin", "path", "expected_story_id_matches", "view_mode"]) ||
		typeof effective.origin !== "string" || typeof effective.path !== "string" ||
		typeof effective.expected_story_id_matches !== "boolean" ||
		!STORYBOOK_VIEW_MODES.includes(effective.view_mode as (typeof STORYBOOK_VIEW_MODES)[number]) ||
		!markers || !exactKeys(markers, ["catalogue_version_count", "component_count"]) ||
		!Number.isSafeInteger(markers.catalogue_version_count) ||
		!Number.isSafeInteger(markers.component_count) ||
		(markers.catalogue_version_count as number) < 0 || (markers.catalogue_version_count as number) > 1 ||
		(markers.component_count as number) < 0 || (markers.component_count as number) > 1 ||
		!STORYBOOK_READY_STATES.includes(record.document_ready_state as (typeof STORYBOOK_READY_STATES)[number]) ||
		!STORYBOOK_MARKER_CLASSIFICATIONS.includes(record.component_classification as (typeof STORYBOOK_MARKER_CLASSIFICATIONS)[number]) ||
		!STORYBOOK_MARKER_CLASSIFICATIONS.includes(record.catalogue_version_classification as (typeof STORYBOOK_MARKER_CLASSIFICATIONS)[number]) ||
		!(typeof record.expected_story_identity_represented === "boolean" || record.expected_story_identity_represented === "unknown") ||
		!STORYBOOK_DOCUMENT_CLASSIFICATIONS.includes(record.storybook_document_classification as (typeof STORYBOOK_DOCUMENT_CLASSIFICATIONS)[number]) ||
		!navigation || !exactKeys(navigation, ["attempted", "confirmed", "changed_document"]) ||
		typeof navigation.attempted !== "boolean" || typeof navigation.confirmed !== "boolean" ||
		typeof navigation.changed_document !== "boolean" ||
		!continuity || !exactKeys(continuity, ["same_target_ref", "pinned_session"]) ||
		continuity.same_target_ref !== true || continuity.pinned_session !== true ||
		typeof record.classification_digest !== "string" || !/^[a-f0-9]{64}$/.test(record.classification_digest)
	) return undefined;
	try {
		const origin = new URL(effective.origin);
		if (origin.origin !== effective.origin || origin.pathname !== "/" || origin.search !== "" || origin.hash !== "") return undefined;
		const path = new URL(effective.path, effective.origin);
		if (path.origin !== effective.origin || path.search !== "" || path.hash !== "" || path.pathname !== effective.path) return undefined;
	} catch {
		return undefined;
	}
	const withoutDigest = { ...record } as Record<string, unknown>;
	delete withoutDigest.classification_digest;
	if (record.classification_digest !== createHash("sha256").update(canonicalJson(withoutDigest)).digest("hex")) return undefined;
	return record as BrowserUseStorybookDocumentDiagnostic;
}

export function targetOperationPlanDigest(plan: BrowserUseTargetOperationPlan): string {
	return createHash("sha256").update(canonicalJson(plan)).digest("hex");
}
