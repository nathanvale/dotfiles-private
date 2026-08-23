import { createHash } from "node:crypto";

export const BROWSER_USE_TARGET_OPERATION_PLAN_CONTRACT_ID =
	"browser-use.target-operation-plan" as const;
export const BROWSER_USE_TARGET_OPERATION_PLAN_SCHEMA_VERSION = "1" as const;
export const BROWSER_USE_TARGET_OPERATION_CAPABILITY_ID =
	"target-operation-plan.v1" as const;

const SAFE_SELECTOR = /^(?!\s*$)[^\0\n\r]{1,512}$/;
const SAFE_KEY = /^(?!\s*$)[^\0\n\r]{1,64}$/;
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
	| {
			kind: "inspect";
			selector: string;
			fields: readonly BrowserUseTargetOperationInspectField[];
	  }
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
			selector?: string;
	  };

export type BrowserUseTargetOperationPlan = {
	contract: typeof BROWSER_USE_TARGET_OPERATION_PLAN_CONTRACT_ID;
	schema_version: typeof BROWSER_USE_TARGET_OPERATION_PLAN_SCHEMA_VERSION;
	scope: "target-local";
	steps: readonly BrowserUseTargetOperationStep[];
};

export type BrowserUseTargetOperationStepOutcome =
	| {
			index: number;
			kind: BrowserUseTargetOperationStep["kind"];
			status: "confirmed";
			observation_digest?: string;
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
	visible_owned_surface_count: number;
};

export type BrowserUseTargetOperationResult =
	| {
			ok: true;
			scope: "target-local";
			focus: false;
			capability_id: string;
			plan_digest: string;
			steps: readonly BrowserUseTargetOperationStepOutcome[];
			cleanup: BrowserUseTargetOperationCleanupEvidence;
	  }
	| {
			ok: false;
			code:
				| "target_operation_plan_failed"
				| "target_operation_plan_unsupported"
				| "target_operation_cleanup_incomplete"
				| "target_operation_origin_mismatch";
			message: string;
			scope: "target-local";
			focus: false;
			capability_id: string;
			plan_digest: string;
			steps: readonly BrowserUseTargetOperationStepOutcome[];
			cleanup: BrowserUseTargetOperationCleanupEvidence;
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

function parseStep(value: unknown, index: number): BrowserUseTargetOperationStep {
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
			if (!exactKeys(value, ["kind", "selector", "fields"]) || !Array.isArray(value.fields)) {
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
			return { kind: "inspect", selector, fields };
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
	if (value.schema_version !== BROWSER_USE_TARGET_OPERATION_PLAN_SCHEMA_VERSION) {
		fail("target operation plan schema version is invalid.");
	}
	if (!Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > 64) {
		fail("target operation plan steps are invalid.");
	}
	return {
		contract: BROWSER_USE_TARGET_OPERATION_PLAN_CONTRACT_ID,
		schema_version: BROWSER_USE_TARGET_OPERATION_PLAN_SCHEMA_VERSION,
		scope: "target-local",
		steps: value.steps.map(parseStep),
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

export function targetOperationPlanDigest(plan: BrowserUseTargetOperationPlan): string {
	return createHash("sha256").update(canonicalJson(plan)).digest("hex");
}
