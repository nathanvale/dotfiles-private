import type {
	CommandDiscoveryCommand,
	CommandDiscoveryTree,
	CommandFacadeMetadataDrift,
} from "./command-contract";
import { validateProjectedFreeText } from "./runtime-text-safety";

/**
 * The claim that every required Branch Station is present in the catalog.
 *
 * Catalog presence only. It is not product proof, observed behavior, or
 * tests passed.
 *
 * This is the sole owner of the literal. `STATION_MAP_COMPLETENESS_CLAIM` is
 * defined from it so the two names cannot drift apart.
 */
export const STATION_MAP_DECLARED_COVERAGE_CLAIM =
	"declared_branch_coverage" as const;

/**
 * The only completeness claim a Station Map may make in v1.
 *
 * It names package-declared branch coverage, not TypeScript or whole-program
 * branch completeness. Same value as
 * `STATION_MAP_DECLARED_COVERAGE_CLAIM`, kept as a separate name with its own
 * lifecycle: this alias is removable later without touching the coverage
 * block.
 */
export const STATION_MAP_COMPLETENESS_CLAIM =
	STATION_MAP_DECLARED_COVERAGE_CLAIM;

/**
 * The claim that a Branch Station crossed the real public-process seam and
 * matched its expected result.
 *
 * Never satisfied by catalog completeness, unit-only execution, or synthetic
 * scenarios.
 */
export const STATION_MAP_OBSERVED_COVERAGE_CLAIM =
	"observed_branch_coverage" as const;

/**
 * How a Branch Station evidence row was produced.
 *
 * `real_process` means a real public-process run produced the observed values.
 * `synthetic` means anything else: catalog-derived rows, in-process fakes, or
 * hand-written scenarios.
 */
export const BRANCH_STATION_EVIDENCE_PROVENANCES = [
	"real_process",
	"synthetic",
] as const;

/**
 * Provenance of one Branch Station evidence row.
 */
export type BranchStationEvidenceProvenance =
	(typeof BRANCH_STATION_EVIDENCE_PROVENANCES)[number];

/**
 * Provenance assumed when an evidence row declares none.
 *
 * Fail-closed: an unlabelled row cannot raise Observed Branch Coverage.
 */
export const DEFAULT_BRANCH_STATION_EVIDENCE_PROVENANCE =
	"synthetic" as const satisfies BranchStationEvidenceProvenance;

/**
 * Package-owned coverage classifications for Branch Stations.
 *
 * Required stations produce missing or drifted findings when evidence is absent
 * or mismatched. Optional stations remain visible without expanding the v1 gate.
 */
export const BRANCH_STATION_CLASSIFICATIONS = [
	"required",
	"optional",
] as const;

/**
 * Evidence states a Station Map can project for a declared Branch Station.
 *
 * `missing` is derived by projection when no evidence record exists.
 */
export const BRANCH_STATION_EVIDENCE_STATUSES = [
	"covered",
	"missing",
	"drifted",
	"skipped",
	"declared-unreachable",
] as const;

/**
 * Package-owned Branch Station coverage class.
 */
export type BranchStationClassification =
	(typeof BRANCH_STATION_CLASSIFICATIONS)[number];

/**
 * Projected evidence state for a Branch Station.
 */
export type BranchStationEvidenceStatus =
	(typeof BRANCH_STATION_EVIDENCE_STATUSES)[number];

/**
 * Runtime envelope status expected or observed by one Branch Station.
 */
export type BranchStationEnvelopeStatus = "ok" | "error";

/**
 * Package-owned declaration for one deterministic CLI branch station.
 *
 * @example
 * ```typescript
 * const station: BranchStation = {
 *   id: "record.success",
 *   command: "record",
 *   classification: "required",
 *   intent: "success",
 *   trigger: "valid receipt writes one report",
 *   expectedExitCode: 0,
 *   expectedEnvelopeStatus: "ok",
 *   expectedResultContractId: "skill-feedback.record",
 *   mutationExpectation: "writes_report",
 * }
 * ```
 */
export interface BranchStation {
	/** Stable id shaped `<command>.<package_branch>`. */
	id: string;
	/** Public command id that owns this station. */
	command: string;
	/** Coverage class used by reconciliation. */
	classification: BranchStationClassification;
	/** Package-owned branch purpose. */
	intent: string;
	/** Maintainer-authored trigger summary, not setup code. */
	trigger: string;
	/** Expected process exit code when deterministic. */
	expectedExitCode?: number;
	/** Expected runtime envelope status when deterministic. */
	expectedEnvelopeStatus?: BranchStationEnvelopeStatus;
	/** Package-owned result contract id expected from this branch. */
	expectedResultContractId?: string;
	/** Package-owned error code expected from this branch. */
	expectedErrorCode?: string;
	/** Package-owned runtime action id expected from this branch. */
	expectedActionId?: string;
	/** Package-owned continuation action id expected from this branch. */
	expectedContinuationId?: string;
	/** Package-owned mutation stance for this branch. */
	mutationExpectation: string;
}

/**
 * Observed evidence for one Branch Station.
 *
 * Test-owned scenario rows produce this data separately from the package-owned
 * catalog so setup and probe functions never enter the catalog.
 *
 * @example
 * ```typescript
 * const evidence: BranchStationEvidence = {
 *   stationId: "record.success",
 *   status: "covered",
 *   observedExitCode: 0,
 *   observedEnvelopeStatus: "ok",
 * }
 * ```
 */
export interface BranchStationEvidence {
	/** Station id from the package catalog. */
	stationId: string;
	/** Observed or declared evidence state. */
	status: Exclude<BranchStationEvidenceStatus, "missing">;
	/** Observed process exit code. */
	observedExitCode?: number;
	/** Observed runtime envelope status. */
	observedEnvelopeStatus?: BranchStationEnvelopeStatus;
	/** Observed package-owned result contract id. */
	observedResultContractId?: string;
	/** Observed package-owned error code. */
	observedErrorCode?: string;
	/** Required rationale for skipped and declared-unreachable stations. */
	rationale?: string;
	/**
	 * How this row was produced. Absent means `synthetic`.
	 *
	 * Only `real_process` rows can raise Observed Branch Coverage.
	 */
	provenance?: BranchStationEvidenceProvenance;
}

/**
 * Expected station result fields projected into the Station Map JSON.
 */
export interface StationMapExpectedResult {
	/** Expected process exit code when deterministic. */
	exit_code?: number;
	/** Expected runtime envelope status when deterministic. */
	envelope_status?: BranchStationEnvelopeStatus;
	/** Package-owned result contract id expected from this branch. */
	result_contract_id?: string;
	/** Package-owned error code expected from this branch. */
	error_code?: string;
	/** Package-owned runtime action id expected from this branch. */
	action_id?: string;
	/** Package-owned continuation action id expected from this branch. */
	continuation_id?: string;
}

/**
 * Observed station result fields projected into the Station Map JSON.
 */
export interface StationMapObservedResult {
	/** Observed process exit code. */
	exit_code?: number;
	/** Observed runtime envelope status. */
	envelope_status?: BranchStationEnvelopeStatus;
	/** Observed package-owned result contract id. */
	result_contract_id?: string;
	/** Observed package-owned error code. */
	error_code?: string;
}

/**
 * Projected evidence block for one station.
 */
export interface StationMapEvidence {
	/** Reconciled evidence state. */
	status: BranchStationEvidenceStatus;
	/**
	 * How this row was produced.
	 *
	 * Optional so a map built outside `projectStationMap` still satisfies this
	 * type. `projectStationMap` always populates it, so a reader can audit
	 * which rows the observed count excluded; rows with no declared provenance
	 * project `synthetic`. Absent is read as `synthetic`, fail-closed.
	 */
	provenance?: BranchStationEvidenceProvenance;
	/** Rationale for skipped or declared-unreachable states. */
	rationale?: string;
	/** Observed result data used for drift reconciliation. */
	observed?: StationMapObservedResult;
}

/**
 * One Branch Station projected into serializable Station Map JSON.
 */
export interface StationMapStation {
	/** Stable id shaped `<command>.<package_branch>`. */
	station_id: string;
	/** Public command id that owns this station. */
	command: string;
	/** Coverage class used by reconciliation. */
	classification: BranchStationClassification;
	/** Package-owned branch purpose. */
	intent: string;
	/** Maintainer-authored trigger summary. */
	trigger: string;
	/** Package-owned mutation stance for this branch. */
	mutation_expectation: string;
	/** Expected result fields. */
	expected: StationMapExpectedResult;
	/** Reconciled evidence data. */
	evidence: StationMapEvidence;
}

/**
 * Station ids grouped under one command in a projected Station Map.
 */
export interface StationMapCommand {
	/** Command summary from facade discovery, when known. */
	summary?: string;
	/** Canonically sorted Branch Station ids for this command. */
	station_ids: readonly string[];
}

/**
 * Finding emitted by Station Map reconciliation.
 */
export interface StationMapFinding {
	/** Station id that produced the finding. */
	station_id: string;
	/** Command id that owns the station. */
	command: string;
	/** Evidence status that caused the finding. */
	finding_kind: Exclude<BranchStationEvidenceStatus, "covered">;
	/** Deterministic human summary for the finding. */
	summary: string;
}

/**
 * Counts backing one coverage claim.
 */
export interface StationMapCoverageCount {
	/** Stations counted against this claim. */
	total: number;
	/** Required-classification stations counted against this claim. */
	required: number;
}

/**
 * Declared and Observed Branch Coverage reported separately.
 *
 * The two claims are different kinds of evidence and never substitute for one
 * another: `declared` counts catalog presence, `observed` counts stations a
 * real process crossed and matched. Reading `declared` as product proof is the
 * failure this split exists to prevent.
 */
export interface StationMapCoverage {
	/** Catalog presence. Not product proof. */
	declared: StationMapCoverageCount & {
		claim: typeof STATION_MAP_DECLARED_COVERAGE_CLAIM;
	};
	/** Real-process stations that matched their expected result. */
	observed: StationMapCoverageCount & {
		claim: typeof STATION_MAP_OBSERVED_COVERAGE_CLAIM;
	};
}

/**
 * Deterministic Station Map projection.
 */
export interface StationMap {
	/**
	 * Explicitly scoped completeness claim.
	 *
	 * @deprecated Read `coverage` instead. This field reports Declared Branch
	 * Coverage only and cannot express Observed Branch Coverage. It keeps its
	 * value and type for existing consumers.
	 */
	completeness_claim: typeof STATION_MAP_COMPLETENESS_CLAIM;
	/**
	 * Declared and Observed Branch Coverage, counted separately.
	 *
	 * Optional so a map built outside `projectStationMap` still satisfies this
	 * type. `projectStationMap` always populates it, so absent means the
	 * producer predates this block, never that coverage is zero.
	 */
	coverage?: StationMapCoverage;
	/** Commands from discovery plus package station declarations. */
	commands: Readonly<Record<string, StationMapCommand>>;
	/** Canonically sorted Branch Stations. */
	stations: readonly StationMapStation[];
	/** Catalog or evidence drift found while projecting. */
	drift: readonly CommandFacadeMetadataDrift[];
	/** Missing, drifted, skipped, or declared-unreachable station findings. */
	findings: readonly StationMapFinding[];
}

/**
 * Inputs for projecting a Station Map.
 */
export interface ProjectStationMapInput {
	/** Facade discovery tree for the target package. */
	discovery: CommandDiscoveryTree<string, CommandDiscoveryCommand>;
	/** Package-owned Branch Station Catalog. */
	catalog: readonly BranchStation[];
	/** Test-owned evidence manifest. @defaultValue [] */
	evidence?: readonly BranchStationEvidence[];
	/** Path label used in drift output. @defaultValue "branch-station-catalog" */
	path?: string;
}

const STATION_ID_PATTERN = /^[a-z][a-z0-9:-]*\.[a-z][a-z0-9_:-]*$/;
const ALLOWED_CLASSIFICATIONS = new Set<string>(BRANCH_STATION_CLASSIFICATIONS);
const ALLOWED_EVIDENCE_STATUSES = new Set<string>(
	BRANCH_STATION_EVIDENCE_STATUSES,
);
const ALLOWED_EVIDENCE_PROVENANCES = new Set<string>(
	BRANCH_STATION_EVIDENCE_PROVENANCES,
);

/**
 * Validate package-owned Branch Station declarations against discovery.
 *
 * @param input - Discovery tree, station catalog, optional evidence, and path
 * @returns Deterministically sorted drift records
 *
 * @example
 * ```typescript
 * const drift = findBranchStationCatalogDrift({
 *   discovery,
 *   catalog,
 *   evidence,
 * })
 * ```
 */
export function findBranchStationCatalogDrift(
	input: ProjectStationMapInput,
): CommandFacadeMetadataDrift[] {
	const path = input.path ?? "branch-station-catalog";
	const knownCommands = new Set(Object.keys(input.discovery.commands).sort());
	const seenStationIds = new Set<string>();
	const drift: CommandFacadeMetadataDrift[] = [];

	for (const station of [...input.catalog].sort((a, b) =>
		a.id.localeCompare(b.id),
	)) {
		if (seenStationIds.has(station.id)) {
			drift.push(driftRecord(path, "branch-station-id-duplicate", station.id));
		}
		seenStationIds.add(station.id);
		if (!STATION_ID_PATTERN.test(station.id)) {
			drift.push(driftRecord(path, "branch-station-id-invalid", station.id));
		}
		if (station.id.split(".")[0] !== station.command) {
			drift.push(
				driftRecord(path, "branch-station-id-command-mismatch", station.id),
			);
		}
		if (!knownCommands.has(station.command)) {
			drift.push(
				driftRecord(
					path,
					"branch-station-command-unknown",
					`${station.id}:${station.command}`,
				),
			);
		}
		if (!ALLOWED_CLASSIFICATIONS.has(station.classification)) {
			drift.push(
				driftRecord(
					path,
					"branch-station-classification-invalid",
					`${station.id}:${station.classification}`,
				),
			);
		}
		drift.push(...safeTextDrift(path, station));
	}

	const knownStationIds = new Set(input.catalog.map((station) => station.id));
	const seenEvidenceIds = new Set<string>();
	for (const evidence of [...(input.evidence ?? [])].sort((a, b) =>
		a.stationId.localeCompare(b.stationId),
	)) {
		if (seenEvidenceIds.has(evidence.stationId)) {
			drift.push(
				driftRecord(path, "branch-station-evidence-duplicate", evidence.stationId),
			);
		}
		seenEvidenceIds.add(evidence.stationId);
		if (!knownStationIds.has(evidence.stationId)) {
			drift.push(
				driftRecord(path, "branch-station-evidence-unknown", evidence.stationId),
			);
		}
		if (!ALLOWED_EVIDENCE_STATUSES.has(evidence.status)) {
			drift.push(
				driftRecord(
					path,
					"branch-station-evidence-status-invalid",
					`${evidence.stationId}:${evidence.status}`,
				),
			);
		}
		if (
			evidence.provenance !== undefined &&
			!ALLOWED_EVIDENCE_PROVENANCES.has(evidence.provenance)
		) {
			drift.push(
				driftRecord(
					path,
					"branch-station-evidence-provenance-invalid",
					`${evidence.stationId}:${evidence.provenance}`,
				),
			);
		}
		if (
			(evidence.status === "skipped" ||
				evidence.status === "declared-unreachable") &&
			!evidence.rationale?.trim()
		) {
			drift.push(
				driftRecord(
					path,
					"branch-station-evidence-rationale-missing",
					evidence.stationId,
				),
			);
		}
		if (evidence.rationale) {
			for (const issue of validateProjectedFreeText(
				`${evidence.stationId}.rationale`,
				evidence.rationale,
			)) {
				drift.push({
					category: "branch-station-evidence-rationale-unsafe-text",
					path,
					action: `Remove unsafe content from evidence ${evidence.stationId} rationale (${issue}).`,
				});
			}
		}
	}

	return drift.sort(byDrift);
}

/**
 * Project facade discovery, a Branch Station Catalog, and evidence into a map.
 *
 * @param input - Discovery tree, station catalog, optional evidence, and path
 * @returns Deterministic Station Map JSON data
 *
 * @example
 * ```typescript
 * const stationMap = projectStationMap({
 *   discovery,
 *   catalog,
 *   evidence,
 * })
 * ```
 */
export function projectStationMap(input: ProjectStationMapInput): StationMap {
	const evidenceByStation = new Map(
		(input.evidence ?? []).map((evidence) => [evidence.stationId, evidence]),
	);
	const stations = [...input.catalog]
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((station) => projectStation(station, evidenceByStation.get(station.id)));
	const commandIds = [
		...new Set([
			...Object.keys(input.discovery.commands),
			...stations.map((station) => station.command),
		]),
	].sort();
	const commands = Object.fromEntries(
		commandIds.map((command) => [
			command,
			{
				...(input.discovery.commands[command]?.summary
					? { summary: input.discovery.commands[command]?.summary }
					: {}),
				station_ids: stations
					.filter((station) => station.command === command)
					.map((station) => station.station_id),
			},
		]),
	);
	const findings = stations
		.filter((station) => station.evidence.status !== "covered")
		.map((station) => stationFinding(station));

	return {
		completeness_claim: STATION_MAP_COMPLETENESS_CLAIM,
		coverage: aggregateStationMapCoverage(stations),
		commands,
		stations,
		drift: findBranchStationCatalogDrift(input),
		findings,
	};
}

/**
 * Count Declared and Observed Branch Coverage separately over station rows.
 *
 * Declared counts every station given. Observed counts only stations whose
 * evidence came from a real process and reconciled to `covered`: a synthetic
 * row cannot raise it, and neither can a real-process row that drifted. A row
 * declaring no provenance is read as `synthetic`, fail-closed.
 *
 * This is the single owner of the counting rule. A caller merging several
 * Station Maps passes the merged station rows here rather than summing the
 * maps' `coverage` blocks, so rows from a producer that emitted no `coverage`
 * are still counted truthfully.
 *
 * @param stations - Projected station rows to count
 * @returns Declared and Observed Branch Coverage for those rows
 *
 * @example
 * ```typescript
 * const coverage = aggregateStationMapCoverage(
 *   maps.flatMap((map) => [...map.stations]),
 * )
 * ```
 */
export function aggregateStationMapCoverage(
	stations: readonly StationMapStation[],
): StationMapCoverage {
	const observedStations = stations.filter(
		(entry) =>
			(entry.evidence.provenance ??
				DEFAULT_BRANCH_STATION_EVIDENCE_PROVENANCE) === "real_process" &&
			entry.evidence.status === "covered",
	);
	return {
		declared: {
			claim: STATION_MAP_DECLARED_COVERAGE_CLAIM,
			total: stations.length,
			required: countRequired(stations),
		},
		observed: {
			claim: STATION_MAP_OBSERVED_COVERAGE_CLAIM,
			total: observedStations.length,
			required: countRequired(observedStations),
		},
	};
}

function countRequired(stations: readonly StationMapStation[]): number {
	return stations.filter((entry) => entry.classification === "required").length;
}

/**
 * Project the provenance of one evidence row, fail-closed.
 *
 * A row declaring no provenance, or a value outside
 * `BRANCH_STATION_EVIDENCE_PROVENANCES`, projects the default so the emitted
 * union stays honest and an unrecognised value cannot reach a consumer that
 * trusts the declared type. An invalid value is reported separately by the
 * `branch-station-evidence-provenance-invalid` drift record.
 */
function projectProvenance(
	evidence: BranchStationEvidence | undefined,
): BranchStationEvidenceProvenance {
	const declared = evidence?.provenance;
	return declared !== undefined && ALLOWED_EVIDENCE_PROVENANCES.has(declared)
		? declared
		: DEFAULT_BRANCH_STATION_EVIDENCE_PROVENANCE;
}

function projectStation(
	station: BranchStation,
	evidence: BranchStationEvidence | undefined,
): StationMapStation {
	const observed = projectObservedResult(evidence);
	const expected = projectExpectedResult(station);
	const status = reconcileStatus(expected, evidence, observed);
	return {
		station_id: station.id,
		command: station.command,
		classification: station.classification,
		intent: station.intent,
		trigger: station.trigger,
		mutation_expectation: station.mutationExpectation,
		expected,
		evidence: {
			status,
			provenance: projectProvenance(evidence),
			...(evidence?.rationale ? { rationale: evidence.rationale } : {}),
			...(Object.keys(observed).length > 0 ? { observed } : {}),
		},
	};
}

function projectExpectedResult(station: BranchStation): StationMapExpectedResult {
	return {
		...(station.expectedExitCode === undefined
			? {}
			: { exit_code: station.expectedExitCode }),
		...(station.expectedEnvelopeStatus
			? { envelope_status: station.expectedEnvelopeStatus }
			: {}),
		...(station.expectedResultContractId
			? { result_contract_id: station.expectedResultContractId }
			: {}),
		...(station.expectedErrorCode ? { error_code: station.expectedErrorCode } : {}),
		...(station.expectedActionId ? { action_id: station.expectedActionId } : {}),
		...(station.expectedContinuationId
			? { continuation_id: station.expectedContinuationId }
			: {}),
	};
}

function projectObservedResult(
	evidence: BranchStationEvidence | undefined,
): StationMapObservedResult {
	if (!evidence) return {};
	return {
		...(evidence.observedExitCode === undefined
			? {}
			: { exit_code: evidence.observedExitCode }),
		...(evidence.observedEnvelopeStatus
			? { envelope_status: evidence.observedEnvelopeStatus }
			: {}),
		...(evidence.observedResultContractId
			? { result_contract_id: evidence.observedResultContractId }
			: {}),
		...(evidence.observedErrorCode
			? { error_code: evidence.observedErrorCode }
			: {}),
	};
}

function reconcileStatus(
	expected: StationMapExpectedResult,
	evidence: BranchStationEvidence | undefined,
	observed: StationMapObservedResult,
): BranchStationEvidenceStatus {
	if (!evidence) return "missing";
	if (evidence.status !== "covered") return evidence.status;
	if (expected.exit_code !== undefined && observed.exit_code !== expected.exit_code) {
		return "drifted";
	}
	if (
		expected.envelope_status !== undefined &&
		observed.envelope_status !== expected.envelope_status
	) {
		return "drifted";
	}
	if (
		expected.result_contract_id !== undefined &&
		observed.result_contract_id !== expected.result_contract_id
	) {
		return "drifted";
	}
	if (
		expected.error_code !== undefined &&
		observed.error_code !== expected.error_code
	) {
		return "drifted";
	}
	return "covered";
}

function stationFinding(station: StationMapStation): StationMapFinding {
	const status = station.evidence.status as Exclude<
		BranchStationEvidenceStatus,
		"covered"
	>;
	return {
		station_id: station.station_id,
		command: station.command,
		finding_kind: status,
		summary: `${station.station_id} is ${status} for ${STATION_MAP_COMPLETENESS_CLAIM}.`,
	};
}

function safeTextDrift(
	path: string,
	station: BranchStation,
): CommandFacadeMetadataDrift[] {
	const fields = [
		["intent", station.intent],
		["trigger", station.trigger],
		["mutationExpectation", station.mutationExpectation],
		["expectedResultContractId", station.expectedResultContractId],
		["expectedErrorCode", station.expectedErrorCode],
		["expectedActionId", station.expectedActionId],
		["expectedContinuationId", station.expectedContinuationId],
	] as const;
	return fields.flatMap(([field, value]) => {
		if (value === undefined) return [];
		return validateProjectedFreeText(`${station.id}.${field}`, value).map(
			(issue) => ({
				category: `branch-station-${kebabCase(field)}-unsafe-text`,
				path,
				action: `Remove unsafe content from ${station.id} ${field} (${issue}).`,
			}),
		);
	});
}

function driftRecord(
	path: string,
	category: string,
	value: string,
): CommandFacadeMetadataDrift {
	return {
		category,
		path,
		action: `${category}: ${value}`,
	};
}

function byDrift(
	a: CommandFacadeMetadataDrift,
	b: CommandFacadeMetadataDrift,
): number {
	return (
		a.category.localeCompare(b.category) ||
		a.path.localeCompare(b.path) ||
		a.action.localeCompare(b.action)
	);
}

function kebabCase(value: string): string {
	return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
