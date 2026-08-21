import type { DiagnosticCause } from '../../src/index.ts'

/**
 * The one registry of negative fixtures. One focused fixture per rejection
 * cause: each is the minimal valid base document with exactly one rule
 * broken, so a failure names one cause and one repair.
 *
 * compile-negative.test.ts proves every row's fixture really produces its
 * cause; sealed-cause-coverage.test.ts proves every sealed diagnostic cause
 * has a row here. A second copy of this table would let those two claims
 * drift apart.
 */
export interface NegativeFixtureCase {
	readonly fixture: string
	readonly cause: DiagnosticCause
	readonly path: string
}

export const NEGATIVE_FIXTURE_CASES: ReadonlyArray<NegativeFixtureCase> = [
	{ fixture: 'syntax-error', cause: 'jsonc_syntax_error', path: '' },
	{ fixture: 'duplicate-key', cause: 'jsonc_duplicate_key', path: '' },
	{ fixture: 'non-data-value', cause: 'jsonc_non_data_value', path: '' },
	{
		fixture: 'missing-required-key',
		cause: 'structure_missing_required',
		path: 'command_surface.no_argument_behavior',
	},
	{
		fixture: 'unknown-key',
		cause: 'structure_unknown_key',
		path: 'command_surface.telemetry_endpoint',
	},
	{
		fixture: 'type-mismatch',
		cause: 'structure_type_mismatch',
		path: 'transitions',
	},
	{
		fixture: 'unresolved-reference',
		cause: 'semantic_unresolved_reference',
		path: 'actions.resolution.unavailable_projection_blocker',
	},
	{
		fixture: 'duplicate-id',
		cause: 'semantic_duplicate_id',
		path: 'actions.catalog[1].id',
	},
	{
		fixture: 'free-text-branch-value',
		cause: 'semantic_free_text_branch_value',
		path: 'command_surface.mutations.audit',
	},
	{
		fixture: 'missing-action-semantics',
		cause: 'semantic_missing_action_semantics',
		path: 'actions.catalog[1]',
	},
	// The sealed "wait" kind carries a mandatory condition and Progress Owner.
	{
		fixture: 'missing-wait-semantics',
		cause: 'semantic_missing_action_semantics',
		path: 'actions.catalog[1]',
	},
	{
		fixture: 'competing-actions',
		cause: 'semantic_competing_actions',
		path: 'actions.catalog[2]',
	},
	{
		fixture: 'missing-authority-semantics',
		cause: 'semantic_missing_authority_semantics',
		path: 'authority.lease_expiry_grants',
	},
	{
		fixture: 'missing-side-effect-semantics',
		cause: 'semantic_missing_side_effect_semantics',
		path: 'command_surface.exit_codes',
	},
	{
		fixture: 'unsafe-retry-declaration',
		cause: 'semantic_unsafe_retry_declaration',
		path: 'retry_posture.rules[0]',
	},
	// Guarding is per command: covering one write command does not vouch for another.
	{
		fixture: 'unsafe-retry-partial-guard',
		cause: 'semantic_unsafe_retry_declaration',
		path: 'retry_posture.rules[1]',
	},
	{
		fixture: 'incomplete-projection',
		cause: 'semantic_incomplete_projection',
		path: 'actions.resolution.unavailable_projection_stop',
	},
	{
		fixture: 'feature-machinery-conflict',
		cause: 'semantic_feature_machinery_conflict',
		path: 'entities',
	},
	{
		fixture: 'version-custody-conflict',
		cause: 'semantic_feature_machinery_conflict',
		path: 'versioning.incompatible_run_policy',
	},
	// No-argument behavior is sealed to read-only meanings; a write must not hide here.
	{
		fixture: 'free-text-no-argument-behavior',
		cause: 'structure_value_not_permitted',
		path: 'command_surface.no_argument_behavior',
	},
]
