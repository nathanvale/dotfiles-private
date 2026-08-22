import { describe, expect, test } from "bun:test";
import {
	STATION_MAP_COMPLETENESS_CLAIM,
	type BranchStation,
	type BranchStationEvidence,
	type CommandDiscoveryTree,
	aggregateStationMapCoverage,
	findBranchStationCatalogDrift,
	projectStationMap,
	type StationMapStation,
} from "@side-quest/cli-command-facade";

const discovery = {
	commands: {
		record: {
			script: "skill-feedback-runner",
			summary: "Capture one report.",
			json: true,
			mutation: "capture",
			audience: "agent",
			usage: ["record --skill <id>"],
			flags: {},
			exit_codes: { "0": "ok", "1": "failed", "2": "usage" },
		},
		review: {
			script: "skill-feedback-runner",
			summary: "Review reports.",
			json: true,
			mutation: "review",
			audience: "agent",
			usage: ["review"],
			flags: {},
			exit_codes: { "0": "ok", "1": "failed", "2": "usage" },
		},
	},
} satisfies CommandDiscoveryTree;

const station = {
	id: "record.success",
	command: "record",
	classification: "required",
	intent: "success",
	trigger: "valid receipt writes one report",
	expectedExitCode: 0,
	expectedEnvelopeStatus: "ok",
	expectedResultContractId: "skill-feedback.record",
	mutationExpectation: "writes_report",
} as const satisfies BranchStation;

function expectDriftedStationMap(input: {
	catalog?: readonly BranchStation[];
	evidence: readonly BranchStationEvidence[];
}): void {
	const map = projectStationMap({
		discovery,
		catalog: input.catalog ?? [station],
		evidence: input.evidence,
	});

	expect(map.stations[0]?.evidence.status).toBe("drifted");
	expect(map.findings[0]?.finding_kind).toBe("drifted");
}

describe("Station Map projection", () => {
	test("a catalog referencing an unknown command produces deterministic drift", () => {
		const drift = findBranchStationCatalogDrift({
			discovery,
			catalog: [{ ...station, id: "purge.preview", command: "purge" }],
		});

		expect(drift.map((entry) => entry.category)).toEqual([
			"branch-station-command-unknown",
		]);
		expect(drift[0]?.action).toContain("purge.preview:purge");
	});

	test("duplicate station ids produce deterministic drift", () => {
		const drift = findBranchStationCatalogDrift({
			discovery,
			catalog: [station, { ...station, intent: "alternate success" }],
		});

		expect(drift.map((entry) => entry.category)).toEqual([
			"branch-station-id-duplicate",
		]);
	});

	test("station declaration structural drift is reported deterministically", () => {
		const cases = [
			{
				name: "invalid station id",
				catalog: [{ ...station, id: "record.Success" }],
				categories: ["branch-station-id-invalid"],
			},
			{
				name: "station id command prefix mismatch",
				catalog: [{ ...station, id: "review.success" }],
				categories: ["branch-station-id-command-mismatch"],
			},
			{
				name: "invalid station classification",
				catalog: [
					{
						...station,
						classification: "future" as BranchStation["classification"],
					},
				],
				categories: ["branch-station-classification-invalid"],
			},
			{
				name: "multiple structural drifts sort by category",
				catalog: [
					{
						...station,
						id: "record.Success",
						classification: "future" as BranchStation["classification"],
					},
				],
				categories: [
					"branch-station-classification-invalid",
					"branch-station-id-invalid",
				],
			},
		] as const satisfies readonly {
			name: string;
			catalog: readonly BranchStation[];
			categories: readonly string[];
		}[];

		for (const { catalog, categories } of cases) {
			const drift = findBranchStationCatalogDrift({ discovery, catalog });

			expect(drift.map((entry) => entry.category)).toEqual([...categories]);
		}
	});

	test("station ids sort canonically in the projected Station Map", () => {
		const map = projectStationMap({
			discovery,
			catalog: [
				{
					id: "review.empty_inbox",
					command: "review",
					classification: "required",
					intent: "success",
					trigger: "empty inbox reports zero items",
					expectedExitCode: 0,
					expectedEnvelopeStatus: "ok",
					expectedResultContractId: "skill-feedback.review",
					mutationExpectation: "none",
				},
				station,
			],
		});

		expect(map.stations.map((entry) => entry.station_id)).toEqual([
			"record.success",
			"review.empty_inbox",
		]);
		expect(map.commands.record.station_ids).toEqual(["record.success"]);
	});

	test("unsafe projected text is rejected with the existing runtime text stance", () => {
		const drift = findBranchStationCatalogDrift({
			discovery,
			catalog: [
				{
					...station,
					trigger: "run bun test to inspect the branch",
				},
			],
		});

		expect(drift.map((entry) => entry.category)).toEqual([
			"branch-station-trigger-unsafe-text",
		]);
	});

	test("evidence declaration drift is reported deterministically", () => {
		const cases = [
			{
				name: "duplicate evidence",
				evidence: [
					{ stationId: "record.success", status: "covered" },
					{ stationId: "record.success", status: "covered" },
				],
				categories: ["branch-station-evidence-duplicate"],
			},
			{
				name: "unknown evidence station",
				evidence: [{ stationId: "review.success", status: "covered" }],
				categories: ["branch-station-evidence-unknown"],
			},
			{
				name: "invalid evidence status",
				evidence: [
					{
						stationId: "record.success",
						status: "pending" as BranchStationEvidence["status"],
					},
				],
				categories: ["branch-station-evidence-status-invalid"],
			},
			{
				name: "skipped evidence missing rationale",
				evidence: [{ stationId: "record.success", status: "skipped" }],
				categories: ["branch-station-evidence-rationale-missing"],
			},
			{
				name: "unsafe evidence rationale",
				evidence: [
					{
						stationId: "record.success",
						status: "skipped",
						rationale: "run bun test to inspect the branch",
					},
				],
				categories: ["branch-station-evidence-rationale-unsafe-text"],
			},
		] as const satisfies readonly {
			name: string;
			evidence: readonly BranchStationEvidence[];
			categories: readonly string[];
		}[];

		for (const { evidence, categories } of cases) {
			const drift = findBranchStationCatalogDrift({
				discovery,
				catalog: [station],
				evidence,
			});

			expect(drift.map((entry) => entry.category)).toEqual([...categories]);
		}
	});

	test("a required station with no observed evidence projects as missing", () => {
		const map = projectStationMap({ discovery, catalog: [station] });

		expect(map.stations[0]?.evidence.status).toBe("missing");
		expect(map.findings).toEqual([
			{
				station_id: "record.success",
				command: "record",
				finding_kind: "missing",
				summary:
					"record.success is missing for declared_branch_coverage.",
			},
		]);
	});

	test("a station with explicit skip rationale projects as skipped", () => {
		const evidence = [
			{
				stationId: "record.success",
				status: "skipped",
				rationale: "host state would make this probe brittle",
			},
		] as const satisfies readonly BranchStationEvidence[];

		const map = projectStationMap({ discovery, catalog: [station], evidence });

		expect(map.stations[0]?.evidence).toMatchObject({
			status: "skipped",
			rationale: "host state would make this probe brittle",
		});
		expect(map.findings[0]?.finding_kind).toBe("skipped");
	});

	test("a station with declared-unreachable rationale projects as declared-unreachable", () => {
		const evidence = [
			{
				stationId: "record.success",
				status: "declared-unreachable",
				rationale: "deterministic setup cannot force this host failure",
			},
		] as const satisfies readonly BranchStationEvidence[];

		const map = projectStationMap({ discovery, catalog: [station], evidence });

		expect(map.stations[0]?.evidence.status).toBe("declared-unreachable");
		expect(map.findings[0]?.finding_kind).toBe("declared-unreachable");
	});

	test("covered evidence can drift when observed result differs from expected", () => {
		const evidence = [
			{
				stationId: "record.success",
				status: "covered",
				observedExitCode: 1,
				observedEnvelopeStatus: "error",
			},
		] as const satisfies readonly BranchStationEvidence[];

		expectDriftedStationMap({ evidence });
	});

	test("covered evidence drifts on envelope mismatch when exit code matches", () => {
		const evidence = [
			{
				stationId: "record.success",
				status: "covered",
				observedExitCode: 0,
				observedEnvelopeStatus: "error",
			},
		] as const satisfies readonly BranchStationEvidence[];

		expectDriftedStationMap({ evidence });
	});

	test("covered evidence projects observed result fields without findings", () => {
		const evidence = [
			{
				stationId: "record.success",
				status: "covered",
				observedExitCode: 0,
				observedEnvelopeStatus: "ok",
				observedResultContractId: "skill-feedback.record",
				observedErrorCode: "none",
			},
		] as const satisfies readonly BranchStationEvidence[];

		const map = projectStationMap({
			discovery,
			catalog: [
				{
					...station,
					expectedErrorCode: "none",
				},
			],
			evidence,
		});

		expect(map.stations[0]?.evidence).toEqual({
			status: "covered",
			provenance: "synthetic",
			observed: {
				exit_code: 0,
				envelope_status: "ok",
				result_contract_id: "skill-feedback.record",
				error_code: "none",
			},
		});
		expect(map.findings).toEqual([]);
	});

	test("covered evidence drifts on result contract or error code mismatch", () => {
		const cases = [
			{
				name: "result contract mismatch",
				catalog: [station],
				evidence: [
					{
						stationId: "record.success",
						status: "covered",
						observedExitCode: 0,
						observedEnvelopeStatus: "ok",
						observedResultContractId: "different.result",
					},
				],
			},
			{
				name: "error code mismatch",
				catalog: [{ ...station, expectedErrorCode: "expected_error" }],
				evidence: [
					{
						stationId: "record.success",
						status: "covered",
						observedExitCode: 0,
						observedEnvelopeStatus: "ok",
						observedResultContractId: "skill-feedback.record",
						observedErrorCode: "actual_error",
					},
				],
			},
		] as const satisfies readonly {
			name: string;
			catalog: readonly BranchStation[];
			evidence: readonly BranchStationEvidence[];
		}[];

		for (const { catalog, evidence } of cases) {
			expectDriftedStationMap({ catalog, evidence });
		}
	});

	test("projection represents Declared Branch Coverage only", () => {
		const map = projectStationMap({ discovery, catalog: [station] });

		expect(map.completeness_claim).toBe(STATION_MAP_COMPLETENESS_CLAIM);
		expect(JSON.stringify(map)).not.toContain("whole-program");
		expect(JSON.stringify(map)).not.toContain("typescript_branch_coverage");
	});

	test("projection preserves package-owned result vocabulary", () => {
		const map = projectStationMap({
			discovery,
			catalog: [
				{
					...station,
					expectedExitCode: 0,
					expectedEnvelopeStatus: "ok",
					expectedResultContractId: "package-owned.custom_result",
					expectedErrorCode: "package_owned_error",
					expectedActionId: "record_report",
					expectedContinuationId: "review_next",
				},
			],
		});

		expect(map.stations[0]?.expected).toMatchObject({
			exit_code: 0,
			envelope_status: "ok",
			result_contract_id: "package-owned.custom_result",
			error_code: "package_owned_error",
			action_id: "record_report",
			continuation_id: "review_next",
		});
	});
});

describe("Station Map dual coverage", () => {
	test("a real_process covered station raises observed coverage", () => {
		const evidence = [
			{
				stationId: "record.success",
				status: "covered",
				provenance: "real_process",
				observedExitCode: 0,
				observedEnvelopeStatus: "ok",
				observedResultContractId: "skill-feedback.record",
			},
		] as const satisfies readonly BranchStationEvidence[];

		const map = projectStationMap({ discovery, catalog: [station], evidence });

		expect(map.coverage.declared.total).toBe(1);
		expect(map.coverage.observed.total).toBe(1);
		expect(map.coverage.observed.required).toBe(1);
	});

	test("evidence with absent provenance never counts as observed", () => {
		const evidence = [
			{
				stationId: "record.success",
				status: "covered",
				observedExitCode: 0,
				observedEnvelopeStatus: "ok",
				observedResultContractId: "skill-feedback.record",
			},
		] as const satisfies readonly BranchStationEvidence[];

		const map = projectStationMap({ discovery, catalog: [station], evidence });

		// Independent oracle: literals, not counts recomputed from the catalog.
		expect(map.coverage.declared.total).toBe(1);
		expect(map.coverage.observed.total).toBe(0);
	});

	test("an explicitly synthetic covered station never counts as observed", () => {
		const evidence = [
			{
				stationId: "record.success",
				status: "covered",
				provenance: "synthetic",
				observedExitCode: 0,
				observedEnvelopeStatus: "ok",
				observedResultContractId: "skill-feedback.record",
			},
		] as const satisfies readonly BranchStationEvidence[];

		const map = projectStationMap({ discovery, catalog: [station], evidence });

		expect(map.coverage.declared.total).toBe(1);
		expect(map.coverage.observed.total).toBe(0);
		expect(map.stations[0]?.evidence.status).toBe("covered");
	});

	test("a drifted real_process station never counts as observed", () => {
		const evidence = [
			{
				stationId: "record.success",
				status: "covered",
				provenance: "real_process",
				observedExitCode: 1,
				observedEnvelopeStatus: "error",
			},
		] as const satisfies readonly BranchStationEvidence[];

		const map = projectStationMap({ discovery, catalog: [station], evidence });

		expect(map.stations[0]?.evidence.status).toBe("drifted");
		expect(map.coverage.declared.total).toBe(1);
		expect(map.coverage.observed.total).toBe(0);
	});

	test("a map fully covered by synthetic evidence reports observed zero", () => {
		const reviewStation = {
			id: "review.empty_inbox",
			command: "review",
			classification: "required",
			intent: "success",
			trigger: "empty inbox reports zero items",
			expectedExitCode: 0,
			expectedEnvelopeStatus: "ok",
			mutationExpectation: "none",
		} as const satisfies BranchStation;
		const evidence = [
			{
				stationId: "record.success",
				status: "covered",
				observedExitCode: 0,
				observedEnvelopeStatus: "ok",
				observedResultContractId: "skill-feedback.record",
			},
			{
				stationId: "review.empty_inbox",
				status: "covered",
				observedExitCode: 0,
				observedEnvelopeStatus: "ok",
			},
		] as const satisfies readonly BranchStationEvidence[];

		const map = projectStationMap({
			discovery,
			catalog: [station, reviewStation],
			evidence,
		});

		// Every row reconciles covered, yet none crossed a real process seam.
		expect(map.stations.map((entry) => entry.evidence.status)).toEqual([
			"covered",
			"covered",
		]);
		expect(map.coverage.declared.total).toBe(2);
		expect(map.coverage.observed.total).toBe(0);
		expect(map.findings).toEqual([]);
	});

	test("declared and observed counts stay separate in a mixed map", () => {
		const reviewStation = {
			id: "review.empty_inbox",
			command: "review",
			classification: "optional",
			intent: "success",
			trigger: "empty inbox reports zero items",
			expectedExitCode: 0,
			expectedEnvelopeStatus: "ok",
			mutationExpectation: "none",
		} as const satisfies BranchStation;
		const evidence = [
			{
				stationId: "record.success",
				status: "covered",
				provenance: "real_process",
				observedExitCode: 0,
				observedEnvelopeStatus: "ok",
				observedResultContractId: "skill-feedback.record",
			},
			{
				stationId: "review.empty_inbox",
				status: "covered",
				provenance: "synthetic",
				observedExitCode: 0,
				observedEnvelopeStatus: "ok",
			},
		] as const satisfies readonly BranchStationEvidence[];

		const map = projectStationMap({
			discovery,
			catalog: [station, reviewStation],
			evidence,
		});

		expect(map.coverage).toEqual({
			declared: {
				claim: "declared_branch_coverage",
				total: 2,
				required: 1,
			},
			observed: {
				claim: "observed_branch_coverage",
				total: 1,
				required: 1,
			},
		});
	});

	test("the deprecated completeness claim keeps its value alongside coverage", () => {
		const map = projectStationMap({ discovery, catalog: [station] });

		expect(map.completeness_claim).toBe("declared_branch_coverage");
		expect(map.completeness_claim).toBe(STATION_MAP_COMPLETENESS_CLAIM);
		expect(map.coverage.declared.claim).toBe("declared_branch_coverage");
	});

	test("an unknown provenance value produces deterministic drift", () => {
		const drift = findBranchStationCatalogDrift({
			discovery,
			catalog: [station],
			evidence: [
				{
					stationId: "record.success",
					status: "covered",
					provenance:
						"assumed" as BranchStationEvidence["provenance"],
				},
			],
		});

		expect(drift.map((entry) => entry.category)).toEqual([
			"branch-station-evidence-provenance-invalid",
		]);
	});

	test("every projected map carries coverage and every row a provenance", () => {
		const optionalStation = {
			id: "record.optional",
			command: "record",
			classification: "optional",
			intent: "success",
			trigger: "missing receipt reports nothing",
			expectedExitCode: 0,
			expectedEnvelopeStatus: "ok",
			mutationExpectation: "none",
		} as const satisfies BranchStation;

		// No evidence at all: the weakest input the projector accepts.
		const map = projectStationMap({
			discovery,
			catalog: [station, optionalStation],
		});

		// Independent oracle: the type permits both to be absent, so the
		// projector populating them is a behaviour claim, not a type claim.
		expect(map.coverage).toBeDefined();
		expect(map.stations).toHaveLength(2);
		for (const projected of map.stations) {
			expect(projected.evidence.provenance).toBe("synthetic");
		}
		expect(map.coverage).toEqual({
			declared: {
				claim: "declared_branch_coverage",
				total: 2,
				required: 1,
			},
			observed: {
				claim: "observed_branch_coverage",
				total: 0,
				required: 0,
			},
		});
	});

	test("an out-of-union provenance projects the fail-closed default", () => {
		const evidence = [
			{
				stationId: "record.success",
				status: "covered",
				observedExitCode: 0,
				observedEnvelopeStatus: "ok",
				observedResultContractId: "skill-feedback.record",
				provenance: "REAL\u001b[31mPROC" as BranchStationEvidence["provenance"],
			},
		] as const satisfies readonly BranchStationEvidence[];

		const map = projectStationMap({ discovery, catalog: [station], evidence });

		// Independent oracle: the literal term, not the constant the source uses.
		expect(map.stations[0].evidence.provenance).toBe("synthetic");
		expect(JSON.stringify(map.stations)).not.toContain("REAL");
		expect(map.coverage.observed.total).toBe(0);
	});

	test("an out-of-union provenance still reports drift after coercion", () => {
		const evidence = [
			{
				stationId: "record.success",
				status: "covered",
				observedExitCode: 0,
				observedEnvelopeStatus: "ok",
				observedResultContractId: "skill-feedback.record",
				provenance: "assumed" as BranchStationEvidence["provenance"],
			},
		] as const satisfies readonly BranchStationEvidence[];

		const map = projectStationMap({ discovery, catalog: [station], evidence });

		expect(map.drift.map((entry) => entry.category)).toEqual([
			"branch-station-evidence-provenance-invalid",
		]);
		expect(map.stations[0].evidence.provenance).toBe("synthetic");
	});
});

describe("Station Map coverage aggregation", () => {
	const reviewStation = {
		id: "review.empty_inbox",
		command: "review",
		classification: "required",
		intent: "success",
		trigger: "empty inbox reports zero items",
		expectedExitCode: 0,
		expectedEnvelopeStatus: "ok",
		mutationExpectation: "none",
	} as const satisfies BranchStation;
	const optionalStation = {
		id: "record.optional",
		command: "record",
		classification: "optional",
		intent: "success",
		trigger: "missing receipt reports nothing",
		expectedExitCode: 0,
		expectedEnvelopeStatus: "ok",
		mutationExpectation: "none",
	} as const satisfies BranchStation;

	test("aggregating several maps counts only real_process covered rows", () => {
		const realMap = projectStationMap({
			discovery,
			catalog: [station],
			evidence: [
				{
					stationId: "record.success",
					status: "covered",
					provenance: "real_process",
					observedExitCode: 0,
					observedEnvelopeStatus: "ok",
					observedResultContractId: "skill-feedback.record",
				},
			],
		});
		const syntheticMap = projectStationMap({
			discovery,
			catalog: [reviewStation, optionalStation],
			evidence: [
				{
					stationId: "review.empty_inbox",
					status: "covered",
					provenance: "synthetic",
					observedExitCode: 0,
					observedEnvelopeStatus: "ok",
				},
				{
					stationId: "record.optional",
					status: "covered",
					provenance: "real_process",
					observedExitCode: 0,
					observedEnvelopeStatus: "ok",
				},
			],
		});

		const merged = aggregateStationMapCoverage([
			...realMap.stations,
			...syntheticMap.stations,
		]);

		// Independent oracle: three stations, two required (record.success and
		// review.empty_inbox); two real_process covered rows, of which one is
		// required. Written out by hand, not recomputed from the maps.
		expect(merged).toEqual({
			declared: {
				claim: "declared_branch_coverage",
				total: 3,
				required: 2,
			},
			observed: {
				claim: "observed_branch_coverage",
				total: 2,
				required: 1,
			},
		});
	});

	test("rows from a producer that emitted no provenance count as synthetic", () => {
		// A hand-built old-shape row: legal under the optional type, and the
		// reason aggregation counts rows rather than summing coverage blocks.
		const oldShapeRows = [
			{
				station_id: "record.success",
				command: "record",
				classification: "required",
				intent: "success",
				trigger: "valid receipt writes one report",
				mutation_expectation: "writes_report",
				expected: {},
				evidence: { status: "covered" },
			},
		] as const satisfies readonly StationMapStation[];

		expect(aggregateStationMapCoverage(oldShapeRows)).toEqual({
			declared: {
				claim: "declared_branch_coverage",
				total: 1,
				required: 1,
			},
			observed: {
				claim: "observed_branch_coverage",
				total: 0,
				required: 0,
			},
		});
	});

	test("an empty station list aggregates to zero on both claims", () => {
		expect(aggregateStationMapCoverage([])).toEqual({
			declared: {
				claim: "declared_branch_coverage",
				total: 0,
				required: 0,
			},
			observed: {
				claim: "observed_branch_coverage",
				total: 0,
				required: 0,
			},
		});
	});
});
