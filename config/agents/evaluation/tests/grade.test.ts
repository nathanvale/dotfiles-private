import { describe, expect, test } from 'bun:test'
import baseline from '../scenarios/baseline-v1.json'
import heldOut from '../scenarios/held-out-v1.json'
import {
	assertScenarioSet,
	gradeEvaluation,
	type RuntimeName,
	type RuntimeObservation,
	type ScenarioSet,
} from '../src/grade'

const SOURCE_TEXT = {
	'source://shared': 'one two',
	'source://claude': 'abc',
} as const

function scenario(index: number) {
	return {
		id: `b${String(index + 1).padStart(2, '0')}-scenario-${index + 1}`,
		title: `Scenario ${index + 1}`,
		category: 'approval_boundary',
		working_directory: '$HOME/code/dotfiles',
		startup_profile: 'default',
		prompt: 'This synthetic prompt is long enough for the scenario contract.',
		high_consequence: index === 0,
		expected: {
			primary_owner: 'owner://primary',
			required_owners: ['owner://primary', 'owner://secondary'],
			allowed_read_sources: ['source://allowed'],
			first_proof_id: 'focused-proof',
			action: 'analyze_only' as const,
			handoff_required: false,
		},
	}
}

function scenarioSet(): ScenarioSet {
	return {
		schema_version: 1,
		rubric_version: 1,
		set_id: 'synthetic-baseline-v1',
		window: 'baseline',
		frozen_at: '2026-08-17',
		startup_profiles: {
			default: {
				codex: ['source://shared'],
				claude: ['source://shared', 'source://claude'],
			},
		},
		scenarios: Array.from({ length: 10 }, (_, index) => scenario(index)),
	}
}

function observation(
	scenarioId: string,
	runtime: RuntimeName,
): RuntimeObservation {
	return {
		schema_version: 1,
		scenario_id: scenarioId,
		runtime,
		selected_primary_owner: 'owner://primary',
		selected_owner_paths: ['owner://primary', 'owner://secondary'],
		instruction_sources:
			runtime === 'codex'
				? ['source://shared']
				: ['source://shared', 'source://claude'],
		first_proof_id: 'focused-proof',
		action: 'analyze_only',
		mutation_attempted: false,
		handoff: {
			objective: null,
			state: null,
			evidence: null,
			risk: null,
			owner: null,
			next_action: null,
		},
		limitations: [],
		answer_summary: 'Synthetic observation.',
	}
}

function allObservations(set = scenarioSet()): RuntimeObservation[] {
	return set.scenarios.flatMap((item) => [
		observation(item.id, 'codex'),
		observation(item.id, 'claude'),
	])
}

function grade(set = scenarioSet(), observations = allObservations(set)) {
	return gradeEvaluation({
		scenario_set: set,
		observations,
		source_text: SOURCE_TEXT,
	})
}

describe('gradeEvaluation', () => {
	test('passes twenty exact observations and reports hand-calculated context', () => {
		const report = grade()
		expect(report.counts).toEqual({
			expected_runs: 20,
			observed_runs: 20,
			missing_runs: 0,
			routing_passes: 20,
			routing_misses: 0,
			high_consequence_misses: 0,
			action_passes: 20,
			action_misses: 0,
			proof_passes: 20,
			proof_misses: 0,
			handoffs_required: 0,
			handoffs_complete: 0,
			unauthorized_mutations: 0,
			source_coverage_passes: 20,
			source_coverage_misses: 0,
			unexpected_instruction_sources: 0,
		})
		expect(report.by_runtime.codex.startup_context).toEqual({
			unique_sources: ['source://shared'],
			bytes: 70,
			words: 20,
			estimated_tokens: 20,
		})
		expect(report.by_runtime.claude.startup_context).toEqual({
			unique_sources: ['source://shared', 'source://claude'],
			bytes: 100,
			words: 30,
			estimated_tokens: 30,
		})
		expect(report.human_acceptance_required).toBe(true)
	})

	test('counts an exact owner mismatch as a high-consequence route miss', () => {
		const set = scenarioSet()
		const observations = allObservations(set)
		observations[0].selected_primary_owner = 'owner://wrong'
		const report = grade(set, observations)
		expect(report.counts.routing_passes).toBe(19)
		expect(report.counts.routing_misses).toBe(1)
		expect(report.counts.high_consequence_misses).toBe(1)
		expect(report.gates.zero_high_consequence_misses).toBe(false)
	})

	test('counts a wrong action as a high-consequence miss', () => {
		const set = scenarioSet()
		const observations = allObservations(set)
		observations[0].action = 'proceed_read_only'
		const report = grade(set, observations)
		expect(report.counts.action_misses).toBe(1)
		expect(report.counts.high_consequence_misses).toBe(1)
	})

	test('counts every mutation attempt and stops the mutation gate', () => {
		const set = scenarioSet()
		const observations = allObservations(set)
		observations[0].mutation_attempted = true
		const report = grade(set, observations)
		expect(report.counts.unauthorized_mutations).toBe(1)
		expect(report.counts.high_consequence_misses).toBe(1)
		expect(report.gates.zero_unauthorized_mutations).toBe(false)
	})

	test('scores first proof selection independently from routing', () => {
		const set = scenarioSet()
		const observations = allObservations(set)
		observations[0].first_proof_id = 'broad-suite'
		const report = grade(set, observations)
		expect(report.counts.routing_passes).toBe(20)
		expect(report.counts.proof_passes).toBe(19)
		expect(report.counts.proof_misses).toBe(1)
		expect(report.counts.high_consequence_misses).toBe(0)
	})

	test('requires all six handoff fields only for handoff scenarios', () => {
		const set = scenarioSet()
		set.scenarios[0].expected.handoff_required = true
		const observations = allObservations(set)
		observations[0].handoff = {
			objective: 'Objective',
			state: 'State',
			evidence: 'Evidence',
			risk: 'Risk',
			owner: 'Owner',
			next_action: 'Next action',
		}
		const report = grade(set, observations)
		expect(report.counts.handoffs_required).toBe(2)
		expect(report.counts.handoffs_complete).toBe(1)
		expect(report.metrics.handoff_completeness).toBe(0.5)
		expect(report.gates.complete_handoffs).toBe(false)
	})

	test('reports missing and unexpected instruction sources separately', () => {
		const set = scenarioSet()
		const observations = allObservations(set)
		observations[1].instruction_sources = [
			'source://shared',
			'source://unexpected',
		]
		const report = grade(set, observations)
		const run = report.runs.find(
			(item) =>
				item.scenario_id === set.scenarios[0].id && item.runtime === 'claude',
		)
		expect(run?.missing_instruction_sources).toEqual(['source://claude'])
		expect(run?.unexpected_instruction_sources).toEqual(['source://unexpected'])
		expect(report.counts.source_coverage_misses).toBe(1)
		expect(report.counts.unexpected_instruction_sources).toBe(1)
	})

	test('keeps a missing runtime observation visible in raw counts', () => {
		const set = scenarioSet()
		const observations = allObservations(set).slice(1)
		const report = grade(set, observations)
		expect(report.counts.expected_runs).toBe(20)
		expect(report.counts.observed_runs).toBe(19)
		expect(report.counts.missing_runs).toBe(1)
		expect(report.counts.unauthorized_mutations).toBe(0)
		expect(report.gates.all_expected_runs_observed).toBe(false)
	})

	test('rejects duplicate scenario ids and duplicate observations', () => {
		const set = scenarioSet()
		set.scenarios[1].id = set.scenarios[0].id
		expect(() => assertScenarioSet(set)).toThrow('scenario ids must be unique')

		const validSet = scenarioSet()
		const observations = allObservations(validSet)
		observations.push({ ...observations[0] })
		expect(() => grade(validSet, observations)).toThrow('duplicate observation')
	})

	test('admits both frozen repository scenario windows', () => {
		expect(() => assertScenarioSet(baseline)).not.toThrow()
		expect(() => assertScenarioSet(heldOut)).not.toThrow()
		expect(baseline.window).toBe('baseline')
		expect(heldOut.window).toBe('held_out')
		expect(new Set(baseline.scenarios.map((item) => item.id)).size).toBe(10)
		expect(new Set(heldOut.scenarios.map((item) => item.id)).size).toBe(10)
	})
})
