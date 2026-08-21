/**
 * Stable diagnostic vocabulary. Every cause identifier here is part of the
 * package's public contract: callers branch on `cause`, never on `message`.
 */
import { compareCodepoints } from './canonical.ts'

/** Sealed diagnostic causes. Adding a cause is a Generator Contract change. */
export const DIAGNOSTIC_CAUSES = [
	// Parse stage.
	'jsonc_syntax_error',
	'jsonc_duplicate_key',
	'jsonc_non_data_value',
	// Structural stage.
	'structure_missing_required',
	'structure_unknown_key',
	'structure_type_mismatch',
	'structure_value_not_permitted',
	// Semantic stage.
	'semantic_unresolved_reference',
	'semantic_duplicate_id',
	'semantic_free_text_branch_value',
	'semantic_missing_action_semantics',
	'semantic_competing_actions',
	'semantic_missing_authority_semantics',
	'semantic_missing_side_effect_semantics',
	'semantic_unsafe_retry_declaration',
	'semantic_incomplete_projection',
	'semantic_feature_machinery_conflict',
	'semantic_unsupported_schema_version',
	'semantic_missing_phase_state',
] as const

export type DiagnosticCause = (typeof DIAGNOSTIC_CAUSES)[number]

/** The compiler stage that produced a diagnostic. */
export type DiagnosticStage = 'parse' | 'structural' | 'semantic'

/**
 * A 1-based source position. Always present: the brief requires a source
 * location on every diagnostic, and a JSON path alone cannot point at the
 * comment or comma that caused a parse failure.
 */
export interface SourceLocation {
	readonly line: number
	readonly column: number
	readonly offset: number
}

export interface Diagnostic {
	readonly cause: DiagnosticCause
	readonly stage: DiagnosticStage
	readonly message: string
	/** RFC-6901-ish dotted path into the candidate, e.g. `actions.catalog[3].id`. */
	readonly path: string
	readonly location: SourceLocation
	readonly sourcePath?: string
}

export function diagnostic(input: Diagnostic): Diagnostic {
	return input
}

/**
 * Deterministic diagnostic order: source position first, then cause, then path.
 * Callers that snapshot a diagnostic list depend on this being stable.
 */
export function sortDiagnostics(
	diagnostics: readonly Diagnostic[],
): Diagnostic[] {
	return [...diagnostics].sort(
		(a, b) =>
			a.location.offset - b.location.offset ||
			compareCodepoints(a.cause, b.cause) ||
			compareCodepoints(a.path, b.path),
	)
}
