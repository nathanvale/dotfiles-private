import { describe, expect, test } from "bun:test"
import { BRANCH_STATIONS, type CatalogueDeclaration, type CatalogueObservation, catalogueSchemaIssues, validateCatalogue } from "../../src/station-catalogue.ts"
import { EXPECTED_STATION_COUNT, expectedStation } from "./expected-station-semantics.ts"

// B1 catalogue enforcement seam (CDS-BC-1): typed declaration and observation specimens copied from the independent
// oracle, one isolated defect per control, the exact expected finding, then the same harness restored to GREEN. The
// production catalogue is enumerated only to pin its size and schema; no expected value is read from it.

const APPLY_PRECONDITION = '["repair-lab.apply","refused","DOMAIN_PRECONDITION_UNMET"]'
const STATUS_HEALTHY = '["repair-lab.status","success","SUCCESS_UNCHANGED"]'
const APPLY_AUTHORITY = '["repair-lab.apply","refused","DOMAIN_AUTHORITY_REQUIRED"]'
const OBSERVABLE = "tests/catalog/station-map.test.ts binding"
const declaration = (identity = APPLY_PRECONDITION): CatalogueDeclaration => ({ ...expectedStation(identity), identity, independentObservable: OBSERVABLE })
const observed = (value: CatalogueDeclaration = declaration()): CatalogueObservation => {
	const { identity, independentObservable: _observable, ...station } = value
	return { identity, station }
}
const GREEN = { findings: [], fullQualification: true }
// The optional C0 handoff resource attached to the handoff specimen; every other field stays the oracle's value.
const withResource = (resource: { readonly kind: string; readonly id: string }): CatalogueDeclaration => {
	const base = declaration(APPLY_AUTHORITY)
	if (!("handoff" in base.guidance)) throw new Error(`${APPLY_AUTHORITY} must be a handoff station`)
	return { ...base, guidance: { handoff: { ...base.guidance.handoff, resource } } }
}

describe("branch station catalogue", () => {
	test("strict new CLI rejects an unreached required station and restores green", () => {
		expect(validateCatalogue([declaration()], [], "strict-new")).toEqual({ mode: "strict-new", findings: [{ code: "STATION_UNREACHED", identity: APPLY_PRECONDITION }], fullQualification: false })
		expect(validateCatalogue([declaration()], [observed()], "strict-new")).toEqual({ mode: "strict-new", ...GREEN })
	})
	test("strict new CLI rejects an observed undeclared station and restores green", () => {
		expect(validateCatalogue([], [observed()], "strict-new")).toEqual({ mode: "strict-new", findings: [{ code: "STATION_UNDECLARED", identity: APPLY_PRECONDITION }], fullQualification: false })
		expect(validateCatalogue([declaration()], [observed()], "strict-new")).toEqual({ mode: "strict-new", ...GREEN })
	})
	test("strict new CLI rejects a full guidance semantic mismatch on the same arm and restores green", () => {
		// Same next-action arm, one changed literal instruction: guidance-kind equality must not count as agreement.
		const wrong: CatalogueDeclaration = { ...declaration(), guidance: { nextAction: "repair-lab recover" } }
		expect(validateCatalogue([wrong], [observed()], "strict-new")).toEqual({ mode: "strict-new", findings: [{ code: "STATION_FIELD_MISMATCH", identity: APPLY_PRECONDITION, field: "guidance.nextAction" }], fullQualification: false })
		expect(validateCatalogue([declaration()], [observed()], "strict-new")).toEqual({ mode: "strict-new", ...GREEN })
	})
	test("strict new CLI rejects one duplicate tuple and restores green", () => {
		expect(validateCatalogue([declaration(), declaration()], [observed()], "strict-new")).toEqual({ mode: "strict-new", findings: [{ code: "STATION_DUPLICATE_IDENTITY", identity: APPLY_PRECONDITION }], fullQualification: false })
		expect(validateCatalogue([declaration()], [observed()], "strict-new")).toEqual({ mode: "strict-new", ...GREEN })
	})
	test("strict new CLI rejects an observed declared-unreachable station and restores green", () => {
		const unreachable: CatalogueDeclaration = { ...declaration(), reachability: "declared-unreachable", unreachableRationale: "the fixture cannot reach this station under support" }
		expect(validateCatalogue([unreachable], [observed(unreachable)], "strict-new")).toEqual({ mode: "strict-new", findings: [{ code: "STATION_UNREACHABLE_OBSERVED", identity: APPLY_PRECONDITION }], fullQualification: false })
		expect(validateCatalogue([declaration()], [observed()], "strict-new")).toEqual({ mode: "strict-new", ...GREEN })
	})
	test("gradual existing-project adoption retains an explicit legacy gap without a full-qualification claim", () => {
		expect(validateCatalogue([declaration()], [], "gradual-existing", [APPLY_PRECONDITION])).toEqual({ mode: "gradual-existing", findings: [], fullQualification: false })
		expect(validateCatalogue([declaration()], [], "gradual-existing")).toEqual({ mode: "gradual-existing", findings: [{ code: "STATION_UNREACHED", identity: APPLY_PRECONDITION }], fullQualification: false })
		expect(validateCatalogue([declaration()], [observed()], "gradual-existing")).toEqual({ mode: "gradual-existing", findings: [], fullQualification: false })
	})
	test("gradual existing-project adoption rejects a new or changed gap that the baseline does not name", () => {
		expect(validateCatalogue([], [observed()], "gradual-existing", [STATUS_HEALTHY])).toEqual({ mode: "gradual-existing", findings: [{ code: "STATION_UNDECLARED", identity: APPLY_PRECONDITION }], fullQualification: false })
		const changed: CatalogueDeclaration = { ...declaration(), repairAction: "Retry immediately." }
		expect(validateCatalogue([changed], [observed()], "gradual-existing", [APPLY_PRECONDITION])).toEqual({ mode: "gradual-existing", findings: [{ code: "STATION_FIELD_MISMATCH", identity: APPLY_PRECONDITION, field: "repairAction" }], fullQualification: false })
	})
	test("strict catalogue schema rejects one cross-field contradiction and the production catalogue has none", () => {
		expect(BRANCH_STATIONS).toHaveLength(EXPECTED_STATION_COUNT)
		expect(BRANCH_STATIONS.flatMap((station) => catalogueSchemaIssues(station))).toEqual([])
		const contradiction: CatalogueDeclaration = { ...declaration(), retryable: true }
		expect(catalogueSchemaIssues(contradiction)).toEqual([`${APPLY_PRECONDITION}: retryable disagrees with cause DOMAIN_PRECONDITION_UNMET`, `${APPLY_PRECONDITION}: retryDelayPolicy must be bounded exactly when retryable`])
		expect(catalogueSchemaIssues(declaration())).toEqual([])
	})
	// Accepted C0 (control-contract-evolution.md lines 392-401 and 665-674): an optional handoff resource is strict with
	// nonempty kind and id, and its strings admit only the five substitution tokens like every other guidance string.
	test("strict catalogue schema rejects an empty or non-admitted handoff resource field independently and restores green", () => {
		expect(catalogueSchemaIssues(withResource({ kind: "", id: "journal-1" }))).toEqual([`${APPLY_AUTHORITY}: guidance.handoff.resource.kind must be nonempty`])
		expect(catalogueSchemaIssues(withResource({ kind: "journal", id: "" }))).toEqual([`${APPLY_AUTHORITY}: guidance.handoff.resource.id must be nonempty`])
		expect(catalogueSchemaIssues(withResource({ kind: "{notAdmitted}", id: "journal-1" }))).toEqual([`${APPLY_AUTHORITY}: template token {notAdmitted} is not admitted`])
		expect(catalogueSchemaIssues(withResource({ kind: "journal", id: "{notAdmitted}" }))).toEqual([`${APPLY_AUTHORITY}: template token {notAdmitted} is not admitted`])
		expect(catalogueSchemaIssues(withResource({ kind: "journal", id: "journal-1" }))).toEqual([])
		expect(catalogueSchemaIssues(withResource({ kind: "run", id: "{runId}" }))).toEqual([])
		expect(catalogueSchemaIssues(declaration(APPLY_AUTHORITY))).toEqual([])
	})
})
