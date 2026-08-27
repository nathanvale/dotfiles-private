import { describe, expect, test } from "bun:test";
import { parseBrowserUseArgv } from "./browser-use-parser";

function completeCatalogueMetadata() {
	return {
		play_readiness: { status: "complete", error: null, settlement_frames: 2, visible_owned_overlays: 0, expanded: false },
		overlay_catalogue: { total_record_count: 0, records: [] },
		matrix_regions: { total_region_count: 0, regions: [] },
	};
}

describe("browser-use operate target plan contract", () => {
	test("the public parser admits the structured target plan command", () => {
		const parsed = parseBrowserUseArgv([
			"operate",
			"target",
			"--plan",
			"/private/run/plan.json",
			"--handoff",
			"/private/run/handoff.json",
			"--json",
		]);
		expect(parsed.kind).toBe("command");
		if (parsed.kind !== "command") return;
		expect(parsed.command).toBe("operate-target");
	});

	test("operate help exposes the target-plan leaf", () => {
		const parsed = parseBrowserUseArgv(["operate", "target", "--help"]);
		expect(parsed).toMatchObject({ kind: "help", family: "operate", command: "operate-target" });
	});

	test("the plan parser rejects raw or unknown step shapes before mutation", async () => {
		const operations = await import("./browser-use-target-operations");
		expect(() =>
			operations.parseBrowserUseTargetOperationPlan({
				steps: [{ kind: "eval", script: "document.body" }],
			}),
		).toThrow();
	});

	test("typed steps map without exposing native command vocabulary", async () => {
		const operations = await import("./browser-use-target-operations");
		const parsed = operations.parseBrowserUseTargetOperationPlan({
			contract: "browser-use.target-operation-plan",
			schema_version: "1",
			steps: [
				{ kind: "navigate", url: "https://example.test/form" },
				{ kind: "inspect", selector: "#name", fields: ["dom", "geometry", "visibility"] },
				{ kind: "review-state", selector: "#name", state: "focus" },
				{ kind: "input", action: "focus", selector: "#name" },
				{ kind: "overlay-cleanup", method: "escape" },
			],
		});
		expect(parsed.steps).toHaveLength(5);
		expect(JSON.stringify(parsed)).not.toMatch(/agent-browser|--cdp|session|tab/);
	});

	test("plan digest is deterministic and target-local", async () => {
		const operations = await import("./browser-use-target-operations");
		const plan = operations.parseBrowserUseTargetOperationPlan({
			contract: "browser-use.target-operation-plan",
			schema_version: "1",
			steps: [{ kind: "inspect", selector: "#name", fields: ["focus"] }],
		});
		expect(operations.targetOperationPlanDigest(plan)).toMatch(/^[a-f0-9]{64}$/);
		expect(plan.scope).toBe("target-local");
	});

	test("the public input vocabulary keeps press keyed and release keyless", async () => {
		const operations = await import("./browser-use-target-operations");
		expect(() =>
			operations.parseBrowserUseTargetOperationPlan({
				contract: "browser-use.target-operation-plan",
				schema_version: "1",
				steps: [{ kind: "input", action: "release" }],
			}),
		).not.toThrow();
		expect(() =>
			operations.parseBrowserUseTargetOperationPlan({
				contract: "browser-use.target-operation-plan",
				schema_version: "1",
				steps: [{ kind: "input", action: "release", key: "Enter" }],
			}),
		).toThrow();
		expect(() =>
			operations.parseBrowserUseTargetOperationPlan({
				contract: "browser-use.target-operation-plan",
				schema_version: "1",
				steps: [{ kind: "input", action: "key", key: "Enter" }],
			}),
		).toThrow();
	});

	test("navigation plans are checked against Browser Use's exact bound origin", async () => {
		const operations = await import("./browser-use-target-operations");
		const plan = operations.parseBrowserUseTargetOperationPlan({
			contract: "browser-use.target-operation-plan",
			schema_version: "1",
			steps: [{ kind: "navigate", url: "https://example.test/next" }],
		});
		expect(
			operations.targetOperationPlanMatchesBoundOrigin(plan, "https://example.test"),
		).toBe(true);
		expect(
			operations.targetOperationPlanMatchesBoundOrigin(plan, "https://other.example.test"),
		).toBe(false);
	});

	test("rejects ignored input fields and classifies mutating plans exactly", async () => {
		const operations = await import("./browser-use-target-operations");
		for (const step of [
			{ kind: "input", action: "press", key: "Enter", selector: "#ignored" },
			{ kind: "input", action: "release", delta: 1 },
			{ kind: "input", action: "click", selector: "#ok", key: "Enter" },
			{ kind: "input", action: "move", x: 1, y: 2, key: "Enter" },
		] as const) {
			expect(() =>
				operations.parseBrowserUseTargetOperationPlan({
					contract: "browser-use.target-operation-plan",
					schema_version: "1",
					steps: [step],
				}),
			).toThrow();
		}
		const observational = operations.parseBrowserUseTargetOperationPlan({
			contract: "browser-use.target-operation-plan",
			schema_version: "1",
			steps: [{ kind: "inspect", selector: "main", fields: ["dom"] }],
		});
		const mutating = operations.parseBrowserUseTargetOperationPlan({
			contract: "browser-use.target-operation-plan",
			schema_version: "1",
			steps: [{ kind: "input", action: "press", key: "Enter" }],
		});
		expect(operations.targetOperationPlanIsMutating(observational)).toBe(false);
		expect(operations.targetOperationPlanIsMutating(mutating)).toBe(true);
	});

	test("the closed target-plan evidence parses from success and controlled cleanup-failure receipts", async () => {
		const { parseBrowserOperationTargetPlanReceipt } = await import("./browser-use-operations");
		const targetPlan = {
			contract: "browser-use.target-operation-result",
			schema_version: "2",
			plan_schema_version: "1",
			plan_digest: "a".repeat(64),
			plan_step_count: 1,
			steps: [{ index: 0, kind: "input", status: "confirmed" }],
			cleanup: { attempted: true, closed: false, visible_owned_surface_count: 1 },
		};
		for (const receipt of [
			{ status: "ok", data: { target_plan: targetPlan } },
			{ status: "error", data: { target_plan: targetPlan }, error: { code: "browser_operation_cleanup_incomplete" } },
		]) {
			expect(parseBrowserOperationTargetPlanReceipt(JSON.stringify(receipt))).toMatchObject(targetPlan);
		}
	});

	test("the public target-plan boundary requires a lowercase observation digest for navigate and keeps cleanup digestless", async () => {
		const { parseBrowserOperationTargetPlanReceipt } = await import("./browser-use-operations");
		const targetPlan = (step: Record<string, unknown>) => ({
			contract: "browser-use.target-operation-result",
			schema_version: "2",
			plan_schema_version: "1",
			plan_digest: "a".repeat(64),
			plan_step_count: 1,
			steps: [step],
			cleanup: { attempted: false, closed: false, visible_owned_surface_count: 0 },
		});
		const receipt = (plan: Record<string, unknown>) => JSON.stringify({ status: "ok", data: { target_plan: plan } });

		expect(parseBrowserOperationTargetPlanReceipt(receipt(targetPlan({ index: 0, kind: "navigate", status: "confirmed" })))).toBeUndefined();
		expect(parseBrowserOperationTargetPlanReceipt(receipt(targetPlan({ index: 0, kind: "navigate", status: "confirmed", observation_digest: "A".repeat(64) })))).toBeUndefined();
		expect(parseBrowserOperationTargetPlanReceipt(receipt(targetPlan({ index: 0, kind: "navigate", status: "confirmed", observation_digest: "a".repeat(64) })))).toMatchObject({ steps: [{ kind: "navigate", observation_digest: "a".repeat(64) }] });
		expect(parseBrowserOperationTargetPlanReceipt(receipt(targetPlan({ index: 0, kind: "overlay-cleanup", status: "confirmed" })))).toMatchObject({ steps: [{ kind: "overlay-cleanup", status: "confirmed" }] });
	});

	test("the closed target-plan receipt admits only explicit possibly-effectful unknown steps", async () => {
		const { parseBrowserOperationTargetPlanReceipt } = await import("./browser-use-operations");
		const cleanup = { attempted: false, closed: false, visible_owned_surface_count: 0 };
		const unknown = {
			status: "error",
			data: {
				target_plan: {
					contract: "browser-use.target-operation-result",
					schema_version: "2",
					plan_schema_version: "1",
					plan_digest: "a".repeat(64),
					plan_step_count: 1,
					steps: [{ index: 0, kind: "input", status: "unknown", effect: "possibly-effectful" }],
					cleanup,
				},
			},
		};
		expect(parseBrowserOperationTargetPlanReceipt(JSON.stringify(unknown))).toMatchObject(unknown.data.target_plan);
		expect(
			parseBrowserOperationTargetPlanReceipt(
				JSON.stringify({
					...unknown,
					data: { target_plan: { steps: [{ index: 0, kind: "input", status: "unknown" }], cleanup } },
				}),
			),
		).toBeUndefined();
	});

	test("schema v2 closes inspect inputs around typed evidence and the public CSS vocabulary", async () => {
		const operations = await import("./browser-use-target-operations");
		const parsed = operations.parseBrowserUseTargetOperationPlan({
			contract: "browser-use.target-operation-plan",
			schema_version: "2",
			steps: [
				{
					kind: "inspect",
					selector: "[data-path-parity-component]",
					fields: ["catalogue", "geometry", "visibility", "focus", "scroll", "computed-styles"],
					computed_style_properties: ["color", "width", "outline-width"],
					max_rows: 2,
				},
			],
		});
		expect(parsed.schema_version).toBe("2");
		expect(parsed.steps[0]).toMatchObject({
			computed_style_properties: ["color", "width", "outline-width"],
			max_rows: 2,
		});
		expect(operations.BROWSER_USE_TARGET_OPERATION_CSS_PROPERTY_ALLOWLIST).toContain("border-top-width");
		for (const inspect of [
			{ kind: "inspect", selector: "#x", fields: ["geometry"], computed_style_properties: ["color"] },
			{ kind: "inspect", selector: "#x", fields: ["computed-styles"] },
			{ kind: "inspect", selector: "#x", fields: ["dom"] },
			{ kind: "inspect", selector: "#x", fields: ["visibility"], extra: true },
		] as const) {
			expect(() => operations.parseBrowserUseTargetOperationPlan({
				contract: "browser-use.target-operation-plan",
				schema_version: "2",
				steps: [inspect],
			})).toThrow();
		}
	});

	test("typed catalogue evidence is ordered, bounded, and fails closed on truncation or malformed metrics", async () => {
		const operations = await import("./browser-use-target-operations");
		const plan = operations.parseBrowserUseTargetOperationPlan({
			contract: "browser-use.target-operation-plan", schema_version: "2",
			steps: [{ kind: "inspect", selector: "#catalogue", fields: ["catalogue", "geometry", "computed-styles"], computed_style_properties: ["color"], max_rows: 1 }],
		});
		const step = plan.steps[0] as Extract<typeof plan.steps[number], { kind: "inspect" }>;
		const row = { ordinal: 0, scenario_id: "a", implementation: "control", layer_id: "root", selector: "#catalogue", computed_style_properties: ["color"], geometry: { x: 0, y: 0, width: 1, height: 1, top: 0, right: 1, bottom: 1, left: 0 }, computed_styles: { color: "rgb(0, 0, 0)" } };
		const truncated = { kind: "scenario-catalogue", root_selector: "#catalogue", fields: ["catalogue", "geometry", "computed-styles"], computed_style_properties: ["color"], max_rows: 1, component: "Button", catalogue_version: "1", document_ready: true, interactions_ready: true, incomplete_image_count: 0, ...completeCatalogueMetadata(), total_row_count: 2, rows: [row], truncation: { reason: "max_rows_exceeded", observed_count: 2, emitted_count: 1, limit: 1 } };
		expect(operations.parseBrowserUseTargetOperationEvidence(truncated, step as never)).toMatchObject({ ok: false, code: "target_operation_evidence_truncated", evidence: { rows: [row] } });
		expect(operations.parseBrowserUseTargetOperationEvidence({ ...truncated, truncation: undefined }, step as never)).toMatchObject({ ok: false, code: "target_operation_evidence_invalid" });
		expect(operations.parseBrowserUseTargetOperationEvidence({ ...truncated, total_row_count: 1, rows: [{ ...row, geometry: { ...row.geometry, width: Number.NaN } }], truncation: undefined }, step as never)).toMatchObject({ ok: false, code: "target_operation_evidence_invalid" });
	});

	test("adapter evidence kind must match the schema-v2 inspect catalogue field", async () => {
		const operations = await import("./browser-use-target-operations");
		const geometry = { x: 0, y: 0, width: 1, height: 1, top: 0, right: 1, bottom: 1, left: 0 };
		const selectorPlan = operations.parseBrowserUseTargetOperationPlan({
			contract: "browser-use.target-operation-plan",
			schema_version: "2",
			steps: [{ kind: "inspect", selector: "#target", fields: ["geometry"] }],
		});
		const cataloguePlan = operations.parseBrowserUseTargetOperationPlan({
			contract: "browser-use.target-operation-plan",
			schema_version: "2",
			steps: [{ kind: "inspect", selector: "#catalogue", fields: ["catalogue", "geometry"], max_rows: 1 }],
		});
		const selectorEvidence = {
			kind: "selector-observation",
			selector: "#target",
			fields: ["geometry"],
			computed_style_properties: [],
			max_rows: 128,
			total_match_count: 1,
			matches: [{ ordinal: 0, geometry }],
		};
		const catalogueEvidence = {
			kind: "scenario-catalogue",
			root_selector: "#catalogue",
			fields: ["catalogue", "geometry"],
			computed_style_properties: [],
			max_rows: 1,
			component: "Button",
			catalogue_version: "1",
			document_ready: true,
			interactions_ready: true,
			incomplete_image_count: 0,
			...completeCatalogueMetadata(),
			total_row_count: 1,
			rows: [{ ordinal: 0, scenario_id: "default", implementation: "control", layer_id: "root", selector: "#catalogue", computed_style_properties: [], geometry }],
		};
		const selectorStep = selectorPlan.steps[0] as never;
		const catalogueStep = cataloguePlan.steps[0] as never;
		expect(operations.parseBrowserUseTargetOperationEvidence(selectorEvidence, selectorStep)).toMatchObject({ ok: true });
		expect(operations.parseBrowserUseTargetOperationEvidence(catalogueEvidence, catalogueStep)).toMatchObject({ ok: true });
		expect(operations.parseBrowserUseTargetOperationEvidence({ ...selectorEvidence, selector: "#catalogue", fields: ["catalogue", "geometry"], max_rows: 1 }, catalogueStep)).toMatchObject({ ok: false, code: "target_operation_evidence_invalid" });
		expect(operations.parseBrowserUseTargetOperationEvidence({ ...catalogueEvidence, root_selector: "#target", fields: ["geometry"], max_rows: 128 }, selectorStep)).toMatchObject({ ok: false, code: "target_operation_evidence_invalid" });
	});

	test("catalogue rows retain local same-selector geometry and their declared style maps", async () => {
		const operations = await import("./browser-use-target-operations");
		const plan = operations.parseBrowserUseTargetOperationPlan({ contract: "browser-use.target-operation-plan", schema_version: "2", steps: [{ kind: "inspect", selector: "#catalogue", fields: ["catalogue", "geometry", "computed-styles"], computed_style_properties: ["color"], max_rows: 2 }] });
		const step = plan.steps[0] as never;
		const evidence = { kind: "scenario-catalogue", root_selector: "#catalogue", fields: ["catalogue", "geometry", "computed-styles"], computed_style_properties: ["color"], max_rows: 2, component: "Button", catalogue_version: "1", document_ready: true, interactions_ready: true, incomplete_image_count: 0, ...completeCatalogueMetadata(), total_row_count: 2, rows: [
			{ ordinal: 0, scenario_id: "a", implementation: "control", layer_id: "root", selector: ".same", computed_style_properties: ["color"], geometry: { x: 1, y: 0, width: 2, height: 2, top: 0, right: 3, bottom: 2, left: 1 }, computed_styles: { color: "red" } },
			{ ordinal: 1, scenario_id: "b", implementation: "control", layer_id: "root", selector: ".same", computed_style_properties: ["width"], geometry: { x: 9, y: 0, width: 4, height: 2, top: 0, right: 13, bottom: 2, left: 9 }, computed_styles: { width: "4px" } },
		] };
		expect(operations.parseBrowserUseTargetOperationEvidence(evidence, step)).toMatchObject({ ok: true, evidence: { rows: [{ geometry: { x: 1 }, computed_styles: { color: "red" } }, { geometry: { x: 9 }, computed_styles: { width: "4px" } }] } });
		expect(operations.parsePublicBrowserUseTargetOperationEvidence({ ...evidence, rows: [{ ...evidence.rows[0], geometry: { x: 1 } }] })).toMatchObject({ ok: false, code: "target_operation_evidence_invalid" });
	});

	test("schema-v2 catalogue projects complete play, overlay, and matrix evidence and refuses malformed projections", async () => {
		const operations = await import("./browser-use-target-operations");
		const plan = operations.parseBrowserUseTargetOperationPlan({ contract: "browser-use.target-operation-plan", schema_version: "2", steps: [{ kind: "inspect", selector: "#catalogue", fields: ["catalogue", "computed-styles"], computed_style_properties: ["align-items", "color"], max_rows: 4 }] });
		const step = plan.steps[0] as never;
		const evidence = {
			kind: "scenario-catalogue", root_selector: "#catalogue", fields: ["catalogue", "computed-styles"], computed_style_properties: ["align-items", "color"], max_rows: 4,
			component: "DatePickerField", catalogue_version: "3", document_ready: true, interactions_ready: true, incomplete_image_count: 0,
			play_readiness: { status: "complete", error: null, settlement_frames: 2, visible_owned_overlays: 0, expanded: true },
			overlay_catalogue: { total_record_count: 2, records: [
				{ scenario_id: "calendar-selected", implementation: "path-mrds", overlay_present: true, target_selector: ".path-field", overlay_selector: "[role=dialog]", trigger_selector: ".path-field", item_selector: ".day", role: "dialog", cleanup_strategy: "escape", cleanup_selector: null, item_index: 22, item_interaction: "focus", item_state: "selected" },
				{ scenario_id: "dialog-content", implementation: "portal-ui", overlay_present: true, target_selector: "button", overlay_selector: "[role=dialog]", trigger_selector: "button", item_selector: null, role: "dialog", cleanup_strategy: "close-control", cleanup_selector: "[data-path-parity-overlay-cleanup]", item_index: null, item_interaction: null, item_state: null },
			] },
			matrix_regions: { total_region_count: 1, regions: [{ ordinal: 0, selector: '[data-docs-matrix] .scrollbar-table[role="region"]', total_target_count: 2, targets: [{ scenario_id: "calendar-selected", implementation: "path-mrds", target_selector: ".path-field" }, { scenario_id: "dialog-content", implementation: "portal-ui", target_selector: "button" }], scroll_left: 20, scroll_width: 120, client_width: 100, at_right_edge: true }] },
			total_row_count: 1, rows: [{ ordinal: 0, scenario_id: "calendar-selected", implementation: "path-mrds", layer_id: "root", selector: ".path-field", computed_style_properties: ["align-items", "color"], computed_styles: { "align-items": "center", color: "rgb(0, 0, 0)" } }],
		};
		expect(operations.parseBrowserUseTargetOperationEvidence(evidence, step)).toMatchObject({ ok: true, evidence: { play_readiness: { status: "complete", expanded: true }, overlay_catalogue: { records: [{ cleanup_strategy: "escape" }, { cleanup_strategy: "close-control" }] }, matrix_regions: { regions: [{ at_right_edge: true }] } } });
		for (const malformed of [
			{ ...evidence, play_readiness: { ...evidence.play_readiness, status: "running" } },
			{ ...evidence, play_readiness: { ...evidence.play_readiness, status: "failed", error: "play failed" } },
			{ ...evidence, play_readiness: { ...evidence.play_readiness, visible_owned_overlays: 1 } },
			{ ...evidence, overlay_catalogue: { ...evidence.overlay_catalogue, records: [{ ...evidence.overlay_catalogue.records[0], item_interaction: "click" }, evidence.overlay_catalogue.records[1]] } },
			{ ...evidence, overlay_catalogue: { ...evidence.overlay_catalogue, records: [evidence.overlay_catalogue.records[0], { ...evidence.overlay_catalogue.records[1], item_state: "default" }] } },
			{ ...evidence, overlay_catalogue: { ...evidence.overlay_catalogue, records: [{ ...evidence.overlay_catalogue.records[0], cleanup_selector: "[data-close]" }, evidence.overlay_catalogue.records[1]] } },
			{ ...evidence, overlay_catalogue: { ...evidence.overlay_catalogue, records: [evidence.overlay_catalogue.records[0], { ...evidence.overlay_catalogue.records[0] }] } },
			{ ...evidence, matrix_regions: { ...evidence.matrix_regions, regions: [{ ...evidence.matrix_regions.regions[0], targets: [evidence.matrix_regions.regions[0].targets[0], { ...evidence.matrix_regions.regions[0].targets[0] }] }] } },
		]) expect(operations.parseBrowserUseTargetOperationEvidence(malformed, step)).toMatchObject({ ok: false, code: "target_operation_evidence_invalid" });
		expect(operations.parseBrowserUseTargetOperationEvidence({ ...evidence, total_row_count: 2, rows: [evidence.rows[0], { ...evidence.rows[0], ordinal: 1 }] }, step)).toMatchObject({ ok: false, code: "target_operation_evidence_invalid" });
		expect(operations.parseBrowserUseTargetOperationEvidence({ ...evidence, matrix_regions: { ...evidence.matrix_regions, regions: [{ ...evidence.matrix_regions.regions[0], total_target_count: 2, targets: [evidence.matrix_regions.regions[0].targets[0]], target_truncation: { reason: "max_rows_exceeded", observed_count: 2, emitted_count: 1, limit: 4 } }] } }, step)).toMatchObject({ ok: false, code: "target_operation_evidence_truncated" });
	});

	test("strict target evidence maps every rejection group to a closed reason and code-owned pointer", async () => {
		const operations = await import("./browser-use-target-operations");
		const geometry = { x: 0, y: 0, width: 1, height: 1, top: 0, right: 1, bottom: 1, left: 0 };
		const selectorStep = operations.parseBrowserUseTargetOperationPlan({
			contract: "browser-use.target-operation-plan",
			schema_version: "2",
			steps: [{ kind: "inspect", selector: "#target", fields: ["geometry"], max_rows: 1 }],
		}).steps[0] as never;
		const catalogueStep = operations.parseBrowserUseTargetOperationPlan({
			contract: "browser-use.target-operation-plan",
			schema_version: "2",
			steps: [{ kind: "inspect", selector: "#catalogue", fields: ["catalogue", "geometry", "computed-styles"], computed_style_properties: ["color"], max_rows: 2 }],
		}).steps[0] as never;
		const selectorEvidence = {
			kind: "selector-observation",
			selector: "#target",
			fields: ["geometry"],
			computed_style_properties: [],
			max_rows: 1,
			total_match_count: 1,
			matches: [{ ordinal: 0, geometry }],
		};
		const row = {
			ordinal: 0,
			scenario_id: "default",
			implementation: "control",
			layer_id: "root",
			selector: "#catalogue",
			computed_style_properties: ["color"],
			geometry,
			computed_styles: { color: "rgb(0, 0, 0)" },
		};
		const catalogueEvidence = {
			kind: "scenario-catalogue",
			root_selector: "#catalogue",
			fields: ["catalogue", "geometry", "computed-styles"],
			computed_style_properties: ["color"],
			max_rows: 2,
			component: "SanitizedComponent",
			catalogue_version: "fixture-v2",
			document_ready: true,
			interactions_ready: true,
			incomplete_image_count: 0,
			play_readiness: { status: "complete", error: null, settlement_frames: 2, visible_owned_overlays: 0, expanded: false },
			overlay_catalogue: { total_record_count: 0, records: [] },
			matrix_regions: { total_region_count: 0, regions: [] },
			total_row_count: 1,
			rows: [row],
		};
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const cases = [
			{ input: circular, step: selectorStep, reason: "serialization_failed", pointer: "/evidence" },
			{ input: null, step: selectorStep, reason: "non_object_payload", pointer: "/evidence" },
			{ input: { ...selectorEvidence, matches: [{ ordinal: 0, geometry, private: "x".repeat(300_000) }] }, step: selectorStep, reason: "evidence_budget_exceeded", pointer: "/evidence" },
			{ input: selectorEvidence, step: catalogueStep, reason: "selector_mode_contract_failed", pointer: "/evidence/kind" },
			{ input: { ...selectorEvidence, selector: "#wrong" }, step: selectorStep, reason: "selector_metadata_failed", pointer: "/evidence/metadata" },
			{ input: { ...selectorEvidence, total_match_count: -1 }, step: selectorStep, reason: "selector_cardinality_failed", pointer: "/evidence/matches" },
			{ input: { ...selectorEvidence, matches: [{ ordinal: 1, geometry }] }, step: selectorStep, reason: "selector_row_failed", pointer: "/evidence/matches/0" },
			{ input: { ...selectorEvidence, matches: [{ ordinal: 0, geometry: { x: 0 } }] }, step: selectorStep, reason: "observation_shape_failed", pointer: "/evidence/matches/0/observation" },
			{ input: { ...selectorEvidence, total_match_count: 2 }, step: selectorStep, reason: "selector_truncation_missing", pointer: "/evidence/truncation" },
			{ input: { kind: "unexpected" }, step: catalogueStep, reason: "catalogue_kind_failed", pointer: "/evidence/kind" },
			{ input: catalogueEvidence, step: selectorStep, reason: "catalogue_field_mismatch", pointer: "/evidence/metadata" },
			{ input: { ...catalogueEvidence, component: "unknown" }, step: catalogueStep, reason: "catalogue_metadata_failed", pointer: "/evidence/metadata/component" },
			{ input: { ...catalogueEvidence, catalogue_version: "unknown" }, step: catalogueStep, reason: "catalogue_metadata_failed", pointer: "/evidence/metadata/catalogue_version" },
			{ input: { ...catalogueEvidence, document_ready: false }, step: catalogueStep, reason: "catalogue_metadata_failed", pointer: "/evidence/metadata/document_ready" },
			{ input: { ...catalogueEvidence, interactions_ready: false }, step: catalogueStep, reason: "catalogue_metadata_failed", pointer: "/evidence/metadata/interactions_ready" },
			{ input: { ...catalogueEvidence, incomplete_image_count: 1 }, step: catalogueStep, reason: "catalogue_metadata_failed", pointer: "/evidence/metadata/incomplete_image_count" },
			{ input: { ...catalogueEvidence, total_row_count: 0 }, step: catalogueStep, reason: "catalogue_metadata_failed", pointer: "/evidence/metadata/total_row_count" },
			{ input: { ...catalogueEvidence, rows: {} }, step: catalogueStep, reason: "catalogue_metadata_failed", pointer: "/evidence/metadata/rows" },
			{ input: { ...catalogueEvidence, total_row_count: 1, rows: [row, { ...row, ordinal: 1, scenario_id: "second" }] }, step: catalogueStep, reason: "catalogue_cardinality_failed", pointer: "/evidence/rows" },
			{ input: { ...catalogueEvidence, play_readiness: { ...catalogueEvidence.play_readiness, status: "running" } }, step: catalogueStep, reason: "play_readiness_failed", pointer: "/evidence/play_readiness" },
			{ input: { ...catalogueEvidence, overlay_catalogue: { total_record_count: 1, records: [{ scenario_id: "private-endpoint", implementation: "control", overlay_present: true, target_selector: "#target", overlay_selector: "[role=dialog]", trigger_selector: "button", item_selector: ".item", role: "dialog", cleanup_strategy: "escape", cleanup_selector: null, item_index: null, item_interaction: "focus", item_state: "selected" }] } }, step: catalogueStep, reason: "overlay_catalogue_failed", pointer: "/evidence/overlay_catalogue" },
			{ input: { ...catalogueEvidence, matrix_regions: { total_region_count: 1, regions: [{ ordinal: 0, selector: "page-controlled-secret", total_target_count: 0, targets: [], scroll_left: 0, scroll_width: 1, client_width: 1, at_right_edge: true }] } }, step: catalogueStep, reason: "matrix_region_failed", pointer: "/evidence/matrix_regions" },
			{ input: { ...catalogueEvidence, rows: [{ ...row, scenario_id: "bad\nrow" }] }, step: catalogueStep, reason: "catalogue_row_failed", pointer: "/evidence/rows/0" },
			{ input: { ...catalogueEvidence, rows: [{ ...row, computed_style_properties: ["private-property"], computed_styles: { "private-property": "x" } }] }, step: catalogueStep, reason: "computed_style_property_failed", pointer: "/evidence/rows/0/computed_style_properties" },
			{ input: { ...catalogueEvidence, total_row_count: 2, rows: [row, { ...row, ordinal: 1 }] }, step: catalogueStep, reason: "row_order_failed", pointer: "/evidence/rows/1/order" },
			{ input: { ...catalogueEvidence, total_row_count: 2 }, step: catalogueStep, reason: "catalogue_truncation_missing", pointer: "/evidence/truncation" },
			{ input: { ...selectorEvidence, total_match_count: 2, truncation: { reason: "max_rows_exceeded", observed_count: 2, emitted_count: 1, limit: 1 } }, step: selectorStep, reason: "evidence_truncated", pointer: "/evidence/truncation", code: "target_operation_evidence_truncated" },
		] as const;
		for (const entry of cases) {
			const expectedCode = "code" in entry
				? entry.code
				: "target_operation_evidence_invalid";
			const parsed = operations.parseBrowserUseTargetOperationEvidence(entry.input, entry.step);
			expect(parsed).toMatchObject({
				ok: false,
				code: expectedCode,
				failure_detail: { reason: entry.reason, pointer: entry.pointer },
			});
			expect(JSON.stringify(parsed)).not.toContain("private-endpoint");
			expect(JSON.stringify(parsed)).not.toContain("page-controlled-secret");
		}
	});

	test("catalogue metadata failures retain the first invalid gate in validation order", async () => {
		const operations = await import("./browser-use-target-operations");
		const step = operations.parseBrowserUseTargetOperationPlan({
			contract: "browser-use.target-operation-plan",
			schema_version: "2",
			steps: [{ kind: "inspect", selector: "#catalogue", fields: ["catalogue"], max_rows: 1 }],
		}).steps[0] as never;
		const evidence = {
			kind: "scenario-catalogue",
			root_selector: "#catalogue",
			fields: ["catalogue"],
			computed_style_properties: [],
			max_rows: 1,
			component: "Button",
			catalogue_version: "fixture-v2",
			document_ready: true,
			interactions_ready: true,
			incomplete_image_count: 0,
			...completeCatalogueMetadata(),
			total_row_count: 1,
			rows: [{ ordinal: 0, scenario_id: "default", implementation: "control", layer_id: "root", selector: "#catalogue", computed_style_properties: [] }],
		};
		for (const entry of [
			{ input: { ...evidence, component: "unknown", catalogue_version: "unknown" }, pointer: "/evidence/metadata/component" },
			{ input: { ...evidence, catalogue_version: "unknown", document_ready: false }, pointer: "/evidence/metadata/catalogue_version" },
			{ input: { ...evidence, document_ready: false, interactions_ready: false }, pointer: "/evidence/metadata/document_ready" },
			{ input: { ...evidence, interactions_ready: false, incomplete_image_count: 1 }, pointer: "/evidence/metadata/interactions_ready" },
			{ input: { ...evidence, incomplete_image_count: 1, total_row_count: 0 }, pointer: "/evidence/metadata/incomplete_image_count" },
			{ input: { ...evidence, total_row_count: 0, rows: {} }, pointer: "/evidence/metadata/total_row_count" },
			{ input: { ...evidence, rows: {} }, pointer: "/evidence/metadata/rows" },
		]) {
			expect(operations.parseBrowserUseTargetOperationEvidence(entry.input, step)).toMatchObject({
				ok: false,
				failure_detail: { reason: "catalogue_metadata_failed", pointer: entry.pointer },
			});
		}
	});

	test("r10 DialogContent accepts reordered JSON style keys and restores declared order", async () => {
		const operations = await import("./browser-use-target-operations");
		const step = operations.parseBrowserUseTargetOperationPlan({
			contract: "browser-use.target-operation-plan",
			schema_version: "3",
			steps: [{
				kind: "navigate",
				url: "http://127.0.0.1:6182/iframe.html?id=components-feedback-dialog--path-docs&viewMode=story",
			}, {
				kind: "inspect",
				selector: "[data-path-parity-catalogue-version]",
				fields: ["catalogue", "geometry", "computed-styles", "visibility"],
				computed_style_properties: ["width", "height", "border-radius", "background-color"],
				max_rows: 128,
				storybook_diagnostic: {
					expected_story_id: "components-feedback-dialog--path-docs",
					expected_component: "DialogContent",
					expected_catalogue_version: "3",
				},
			}],
		}).steps[1] as never;
		const geometry = {
			x: 0, y: 0, width: 200, height: 40,
			top: 0, right: 200, bottom: 40, left: 0,
		};
		const result = operations.parseBrowserUseTargetOperationEvidence({
			kind: "scenario-catalogue",
			root_selector: "[data-path-parity-catalogue-version]",
			fields: ["catalogue", "geometry", "computed-styles", "visibility"],
			computed_style_properties: ["width", "height", "border-radius", "background-color"],
			max_rows: 128,
			component: "DialogContent",
			catalogue_version: "3",
			document_ready: true,
			interactions_ready: true,
			incomplete_image_count: 0,
			...completeCatalogueMetadata(),
			total_row_count: 1,
			rows: [{
				ordinal: 0,
				scenario_id: "api-dialog-content-aria-label",
				implementation: "path-mrds",
				layer_id: "trigger",
				selector: "button",
				computed_style_properties: ["width", "height", "border-radius", "background-color"],
				geometry,
				visibility: true,
				computed_styles: {
					"background-color": "rgb(255, 255, 255)",
					"border-radius": "4px",
					height: "40px",
					width: "200px",
				},
			}],
		}, step);

		expect(result).toMatchObject({ ok: true });
		if (!result.ok) return;
		expect(result.evidence.kind).toBe("scenario-catalogue");
		if (result.evidence.kind !== "scenario-catalogue") return;
		expect(Object.keys(result.evidence.rows[0]?.computed_styles ?? {})).toEqual([
			"width",
			"height",
			"border-radius",
			"background-color",
		]);
	});

	test("catalogue play readiness precedes the coarse interactions metadata gate", async () => {
		const operations = await import("./browser-use-target-operations");
		const step = operations.parseBrowserUseTargetOperationPlan({
			contract: "browser-use.target-operation-plan",
			schema_version: "2",
			steps: [{ kind: "inspect", selector: "#catalogue", fields: ["catalogue"], max_rows: 1 }],
		}).steps[0] as never;
		const evidence = {
			kind: "scenario-catalogue",
			root_selector: "#catalogue",
			fields: ["catalogue"],
			computed_style_properties: [],
			max_rows: 1,
			component: "Button",
			catalogue_version: "fixture-v2",
			document_ready: true,
			interactions_ready: false,
			incomplete_image_count: 0,
			play_readiness: { status: "running", error: null, settlement_frames: 0, visible_owned_overlays: 0, expanded: false },
			overlay_catalogue: { total_record_count: 0, records: [] },
			matrix_regions: { total_region_count: 0, regions: [] },
			total_row_count: 1,
			rows: [{ ordinal: 0, scenario_id: "default", implementation: "control", layer_id: "root", selector: "#catalogue", computed_style_properties: [] }],
		};
		expect(operations.parseBrowserUseTargetOperationEvidence(evidence, step)).toMatchObject({
			ok: false,
			code: "target_operation_evidence_invalid",
			failure_detail: { reason: "play_readiness_failed", pointer: "/evidence/play_readiness" },
		});
		expect(operations.parseBrowserUseTargetOperationEvidence({
			...evidence,
			interactions_ready: false,
			play_readiness: { status: "complete", error: null, settlement_frames: 2, visible_owned_overlays: 0, expanded: false },
		}, step)).toMatchObject({
			ok: false,
			code: "target_operation_evidence_invalid",
			failure_detail: { reason: "catalogue_metadata_failed", pointer: "/evidence/metadata/interactions_ready" },
		});
	});

	test("public failure detail accepts only the closed catalogue metadata pointer vocabulary", async () => {
		const operations = await import("./browser-use-target-operations");
		for (const pointer of [
			"/steps/1/inspect/evidence/metadata/component",
			"/steps/1/inspect/evidence/metadata/catalogue_version",
			"/steps/1/inspect/evidence/metadata/document_ready",
			"/steps/1/inspect/evidence/metadata/interactions_ready",
			"/steps/1/inspect/evidence/metadata/incomplete_image_count",
			"/steps/1/inspect/evidence/metadata/total_row_count",
			"/steps/1/inspect/evidence/metadata/rows",
		]) {
			expect(operations.parseBrowserUseTargetOperationFailureDetail({ reason: "catalogue_metadata_failed", pointer })).toEqual({ reason: "catalogue_metadata_failed", pointer });
		}
		expect(operations.parseBrowserUseTargetOperationFailureDetail({ reason: "catalogue_field_mismatch", pointer: "/steps/1/inspect/evidence/metadata" })).toEqual({ reason: "catalogue_field_mismatch", pointer: "/steps/1/inspect/evidence/metadata" });
		for (const pointer of [
			"/steps/1/inspect/evidence/metadata",
			"/steps/1/inspect/evidence/metadata/unknown",
			"/steps/1/inspect/evidence/metadata/component/extra",
			"/steps/1/observe/evidence/metadata/component",
			"/steps/1/evidence/metadata/component",
			"/steps/01/inspect/evidence/metadata/component",
		]) {
			expect(operations.parseBrowserUseTargetOperationFailureDetail({ reason: "catalogue_metadata_failed", pointer })).toBeUndefined();
		}
	});

	test("public failure detail accepts the exact Storybook diagnostic pointer and rejects adjacent variants", async () => {
		const operations = await import("./browser-use-target-operations");
		const reason = "adapter_eval_failed" as const;
		const pointer = "/steps/1/inspect/storybook_document_diagnostic";
		expect(operations.parseBrowserUseTargetOperationFailureDetail({ reason, pointer })).toEqual({ reason, pointer });
		for (const invalidPointer of [
			"/steps/1/inspect/storybook_document_diagnostic_extra",
			"/steps/1/inspect/storybook_document_diagnostic/extra",
			"/steps/1/observe/storybook_document_diagnostic",
			"/steps/1/storybook_document_diagnostic",
			"/steps/1/inspect/evidence/storybook_document_diagnostic",
		]) {
			expect(operations.parseBrowserUseTargetOperationFailureDetail({ reason, pointer: invalidPointer })).toBeUndefined();
		}
	});

	test("public failure detail admits only closed post-readiness custody and target-proof pointers", async () => {
		const operations = await import("./browser-use-target-operations");
		expect(operations.parseBrowserUseTargetOperationFailureDetail({
			reason: "target_custody_failed",
			pointer: "/steps/1/inspect/post-readiness",
		})).toEqual({
			reason: "target_custody_failed",
			pointer: "/steps/1/inspect/post-readiness",
		});
		for (const proofReason of [
			"origin_mismatch",
			"url_read_failed",
			"url_shape_failed",
			"exact_url_mismatch",
			"tab_gone",
		] as const) {
			const detail = {
				reason: "exact_target_proof_failed" as const,
				pointer: `/steps/1/inspect/post-readiness/${proofReason}`,
			};
			expect(operations.parseBrowserUseTargetOperationFailureDetail(detail)).toEqual(detail);
		}
		for (const invalid of [
			{ reason: "target_custody_failed", pointer: "/steps/1/inspect/post-readiness/extra" },
			{ reason: "exact_target_proof_failed", pointer: "/steps/1/inspect/post-readiness" },
			{ reason: "exact_target_proof_failed", pointer: "/steps/1/inspect/post-readiness/private-url" },
			{ reason: "exact_target_proof_failed", pointer: "/steps/1/navigate/post-readiness/url_read_failed" },
		]) {
			expect(operations.parseBrowserUseTargetOperationFailureDetail(invalid)).toBeUndefined();
		}
	});

	test("schema-v2 overlay cleanup requires a surface and a separate close control while v1 remains compatible", async () => {
		const operations = await import("./browser-use-target-operations");
		expect(() => operations.parseBrowserUseTargetOperationPlan({ contract: "browser-use.target-operation-plan", schema_version: "2", steps: [{ kind: "overlay-cleanup", method: "escape", surface_selector: "[role=dialog]" }] })).not.toThrow();
		expect(() => operations.parseBrowserUseTargetOperationPlan({ contract: "browser-use.target-operation-plan", schema_version: "2", steps: [{ kind: "overlay-cleanup", method: "close-control", surface_selector: "[role=dialog]", control_selector: "[data-close]" }] })).not.toThrow();
		for (const step of [
			{ kind: "overlay-cleanup", method: "escape" },
			{ kind: "overlay-cleanup", method: "close-control", surface_selector: "[role=dialog]" },
			{ kind: "overlay-cleanup", method: "close-control", selector: "[data-close]" },
			{ kind: "overlay-cleanup", method: "close-control", surface_selector: "[role=dialog]", control_selector: "[data-close], [data-foreign-close]" },
		] as const) expect(() => operations.parseBrowserUseTargetOperationPlan({ contract: "browser-use.target-operation-plan", schema_version: "2", steps: [step] })).toThrow();
		expect(() => operations.parseBrowserUseTargetOperationPlan({ contract: "browser-use.target-operation-plan", schema_version: "1", steps: [{ kind: "overlay-cleanup", method: "close-control", selector: "[data-close]" }] })).not.toThrow();
	});

	test("nested target receipts prove step-vector completeness and exact blocked evidence", async () => {
		const { parseBrowserOperationTargetPlanReceipt } = await import("./browser-use-operations");
		const evidence = {
			kind: "selector-observation",
			selector: "#field",
			fields: ["computed-styles"],
			computed_style_properties: ["color"],
			max_rows: 1,
			total_match_count: 2,
			matches: [{ ordinal: 0, computed_styles: { color: "rgb(0, 0, 0)" } }],
			truncation: { reason: "max_rows_exceeded", observed_count: 2, emitted_count: 1, limit: 1 },
		};
		const targetPlan = {
			contract: "browser-use.target-operation-result",
			schema_version: "2",
			plan_schema_version: "2",
			plan_digest: "a".repeat(64),
			plan_step_count: 2,
			steps: [{ index: 0, kind: "inspect", status: "blocked", code: "target_operation_evidence_truncated", evidence }],
			cleanup: { attempted: false, closed: false, visible_owned_surface_count: 0 },
		};
		expect(parseBrowserOperationTargetPlanReceipt(JSON.stringify({ status: "error", data: { target_plan: targetPlan } }))).toMatchObject(targetPlan);
		expect(parseBrowserOperationTargetPlanReceipt(JSON.stringify({
			status: "error",
			data: { target_plan: { ...targetPlan, steps: [{ ...targetPlan.steps[0], code: "target_operation_evidence_invalid", evidence: undefined }] } },
		}))).toBeDefined();
		for (const malformed of [
			{ ...targetPlan, plan_step_count: undefined },
			{ ...targetPlan, plan_step_count: 0 },
			{ ...targetPlan, steps: [{ ...targetPlan.steps[0], index: 1 }] },
			{ ...targetPlan, steps: [targetPlan.steps[0], { ...targetPlan.steps[0], index: 0 }] },
			{ ...targetPlan, plan_step_count: 1, steps: [targetPlan.steps[0], { ...targetPlan.steps[0], index: 1 }] },
			{ ...targetPlan, steps: [{ ...targetPlan.steps[0], index: 1 }, { ...targetPlan.steps[0], index: 0 }] },
			{ ...targetPlan, steps: [{ ...targetPlan.steps[0], code: "target_operation_evidence_invalid", evidence }] },
			{ ...targetPlan, steps: [{ ...targetPlan.steps[0], evidence: { nope: true } }] },
		]) {
			expect(parseBrowserOperationTargetPlanReceipt(JSON.stringify({ status: "error", data: { target_plan: malformed } }))).toBeUndefined();
		}
		expect(parseBrowserOperationTargetPlanReceipt(JSON.stringify({ status: "ok", data: { target_plan: targetPlan } }))).toBeUndefined();
	});

	test("public typed evidence rejects cross-kind selectors, unsafe selectors, and private-looking style values", async () => {
		const operations = await import("./browser-use-target-operations");
		const selectorEvidence = (selector: string, color = "rgb(0, 0, 0)") => ({
			kind: "selector-observation",
			selector,
			fields: ["computed-styles"],
			computed_style_properties: ["color"],
			max_rows: 1,
			total_match_count: 1,
			matches: [{ ordinal: 0, computed_styles: { color } }],
		});
		expect(operations.parsePublicBrowserUseTargetOperationEvidence(selectorEvidence("#field"))).toMatchObject({ ok: true });
		for (const malformed of [
			{ ...selectorEvidence("#field"), fields: ["catalogue", "computed-styles"] },
			selectorEvidence(""),
			selectorEvidence("x".repeat(513)),
			selectorEvidence("#field", "url(https://private.example.test/secret)"),
			selectorEvidence("#field", "red\nprivate"),
			selectorEvidence("#field", "red\u000bprivate"),
		]) {
			expect(operations.parsePublicBrowserUseTargetOperationEvidence(malformed)).toMatchObject({ ok: false, code: "target_operation_evidence_invalid" });
		}
	});

	test("public nested receipts enforce the aggregate typed-evidence budget", async () => {
		const { parseBrowserOperationTargetPlanReceipt } = await import("./browser-use-operations");
		const largeEvidence = (selector: string, count = 64) => ({
			kind: "selector-observation",
			selector,
			fields: ["computed-styles"],
			computed_style_properties: ["color"],
			max_rows: 128,
			total_match_count: count,
			matches: Array.from({ length: count }, (_, ordinal) => ({
				ordinal,
				computed_styles: { color: "a".repeat(2_048) },
			})),
		});
		const nearLimit = {
			contract: "browser-use.target-operation-result",
			schema_version: "2",
			plan_schema_version: "2",
			plan_digest: "c".repeat(64),
			plan_step_count: 1,
			steps: [{ index: 0, kind: "inspect", status: "confirmed", evidence: largeEvidence("#near", 124) }],
			cleanup: { attempted: false, closed: false, visible_owned_surface_count: 0 },
		};
		expect(parseBrowserOperationTargetPlanReceipt(JSON.stringify({ status: "ok", data: { target_plan: nearLimit } }))).toBeDefined();
		const targetPlan = {
			contract: "browser-use.target-operation-result",
			schema_version: "2",
			plan_schema_version: "2",
			plan_digest: "b".repeat(64),
			plan_step_count: 2,
			steps: [
				{ index: 0, kind: "inspect", status: "confirmed", evidence: largeEvidence("#one") },
				{ index: 1, kind: "inspect", status: "confirmed", evidence: largeEvidence("#two") },
			],
			cleanup: { attempted: false, closed: false, visible_owned_surface_count: 0 },
		};
		expect(parseBrowserOperationTargetPlanReceipt(JSON.stringify({ status: "ok", data: { target_plan: targetPlan } }))).toBeUndefined();
	});

	test("schema v3 admits exactly one fixed Storybook diagnostic after its exact preview navigation", async () => {
		const { parseBrowserUseTargetOperationPlan } = await import("./browser-use-target-operations");
		const storyId = "components-forms-atoms-datepickerfield--path-docs";
		const diagnostic = {
			expected_story_id: storyId,
			expected_component: "DatePickerField",
			expected_catalogue_version: "3",
		};
		const plan = (navigateUrl: string, inspect: Record<string, unknown> = {}) => ({
			contract: "browser-use.target-operation-plan",
			schema_version: "3",
			steps: [
				{ kind: "navigate", url: navigateUrl },
				{
					kind: "inspect",
					selector: "[data-path-parity-catalogue-version]",
					fields: ["catalogue"],
					max_rows: 1,
					storybook_diagnostic: diagnostic,
					...inspect,
				},
			],
		});
		const preview = `https://example.test/iframe.html?id=${storyId}&viewMode=story`;
		expect(parseBrowserUseTargetOperationPlan(plan(preview))).toMatchObject({ schema_version: "3" });
		for (const malformed of [
			{ ...plan(preview), steps: plan(preview).steps.slice(0, 1) },
			plan(`https://example.test/?path=/story/${storyId}`),
			plan(`https://example.test/iframe.html?id=wrong-story&viewMode=story`),
			plan(`${preview}&token=secret`),
			plan(preview, { selector: "[data-caller-selected]" }),
			plan(preview, { storybook_diagnostic: { ...diagnostic, query_keys: ["id"] } }),
		]) expect(() => parseBrowserUseTargetOperationPlan(malformed)).toThrow();
	});

	test("fixed Storybook document diagnostics classify safe states and fail closed on unsafe projections", async () => {
		const {
			buildBrowserUseStorybookDocumentDiagnostic,
			parsePublicBrowserUseStorybookDocumentDiagnostic,
		} = await import("./browser-use-target-operations");
		const expectation = {
			expected_story_id: "components-forms-atoms-datepickerfield--path-docs",
			expected_component: "DatePickerField",
			expected_catalogue_version: "3",
		};
		const raw = {
			document_ready_state: "complete",
			catalogue_version_count: 1,
			component_count: 1,
			component_classification: "expected",
			catalogue_version_classification: "expected",
			storybook_state: "main",
		};
		const build = (effective_url: string, raw_projection: unknown = raw) =>
			buildBrowserUseStorybookDocumentDiagnostic({
				expectation,
				effective_url,
				raw_projection,
				navigation: { attempted: true, confirmed: true, changed_document: true },
			});
		const preview = `https://example.test/iframe.html?id=${expectation.expected_story_id}&viewMode=story`;
		const ready = build(preview);
		expect(ready).toMatchObject({
			effective_document: { path: "/iframe.html", expected_story_id_matches: true, view_mode: "story" },
			expected_story_identity_represented: true,
			storybook_document_classification: "ready",
		});
		expect(parsePublicBrowserUseStorybookDocumentDiagnostic(ready)).toEqual(ready);
		expect(build("https://example.test/")).toMatchObject({
			effective_document: { path: "/", expected_story_id_matches: false, view_mode: "missing" },
			expected_story_identity_represented: false,
		});
		expect(build("https://example.test/iframe.html?id=wrong-story&viewMode=docs")).toMatchObject({
			effective_document: { expected_story_id_matches: false, view_mode: "docs" },
		});
		for (const [projection, classification] of [
			[{ ...raw, document_ready_state: "loading", storybook_state: "loading" }, "loading"],
			[{ ...raw, storybook_state: "missing-story" }, "missing-story"],
			[{ ...raw, storybook_state: "runtime-error" }, "runtime-error"],
			[{
				...raw,
				catalogue_version_count: 0,
				component_count: 0,
				component_classification: "missing",
				catalogue_version_classification: "missing",
			}, "unknown"],
		] as const) expect(build(preview, projection)).toMatchObject({ storybook_document_classification: classification });
		for (const malformed of [
			{ ...raw, component_count: 2 },
			{ ...raw, catalogue_version_count: Number.POSITIVE_INFINITY },
			{ ...raw, component_count: 0, component_classification: "expected" },
			{ ...raw, raw_text: "page-controlled secret" },
			{ ...raw, storybook_state: "other" },
		]) expect(build(preview, malformed)).toBeUndefined();
		expect(build(`${preview}&id=duplicate`)).toBeUndefined();
		expect(buildBrowserUseStorybookDocumentDiagnostic({
			expectation: { ...expectation, expected_component: "unsafe component value" },
			effective_url: preview,
			raw_projection: raw,
			navigation: { attempted: true, confirmed: true, changed_document: true },
		})).toBeUndefined();
		expect(JSON.stringify(ready)).not.toMatch(/DatePickerField|components-forms|viewMode|raw_text|secret/);
		expect(parsePublicBrowserUseStorybookDocumentDiagnostic({ ...ready, classification_digest: "0".repeat(64) })).toBeUndefined();
	});

});
