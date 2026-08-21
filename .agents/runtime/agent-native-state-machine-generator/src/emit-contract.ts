/**
 * The emit stage's own fail-closed vocabulary.
 *
 * Kept separate from the compiler's sealed `DiagnosticCause` list on purpose.
 * A compiler diagnostic points at a source location inside a Specification
 * Candidate; an emit refusal points at a derived artifact that the candidate
 * compiled cleanly into but that cannot be published without contradicting a
 * facade obligation. The two vocabularies answer different questions, so a
 * caller must be able to branch on them independently.
 *
 * Emission is not Specification Admission. A candidate whose artifacts emit
 * has no semantic authority until the product owner admits it explicitly.
 */

/**
 * Sealed emit refusal causes. Adding a cause is a Generator Contract change.
 *
 * Every cause here is reachable. The cross-validations the facade declares but
 * never delivers - a station expecting an exit code its command never
 * declares, a station id that does not name its own command, a station naming
 * a command absent from discovery - have no cause in this list because one
 * Admitted State-Machine Specification generates both sides, which makes those
 * disagreements unexpressible rather than merely detected. A cause for an
 * impossible state would advertise a check nothing can raise.
 */
export const EMIT_REFUSAL_CAUSES = [
	/** A Branch Station id does not satisfy the facade's id grammar. */
	'emit_station_id_invalid',
	/** Two derived Branch Stations claim the same id. */
	'emit_station_id_duplicate',
	/** The Command Surface Contract omits a baseline exit meaning. */
	'emit_baseline_exit_missing',
	/** A Branch Station's expectedActionId is absent from the action catalog. */
	'emit_expectation_action_unknown',
	/** A declared Extension Point has no Handwritten Extension bound. */
	'emit_registry_binding_missing',
	/** A Handwritten Extension is bound to no declared Extension Point. */
	'emit_registry_binding_extra',
	/** A binding names a specification revision that is no longer current. */
	'emit_registry_binding_stale',
	/** A binding survives for an Extension Point the specification withdrew. */
	'emit_registry_binding_orphaned',
	/**
	 * A write-implying command's declared surface cannot satisfy the Write
	 * Preview Capability obligation. The generator refuses rather than inventing
	 * an execution mode or authoring a previewExemption reason: both are
	 * product-owner decisions.
	 */
	'emit_write_preview_undeclarable',
	/**
	 * A required semantic column cannot be derived from anything the candidate
	 * declares. Input Schema v1 has no surface for it, so emitting a default
	 * would publish an invented meaning as though it were admitted.
	 */
	'emit_expectation_column_underivable',
	/** No declared retry rule matches a Branch Station's facts. */
	'emit_retry_posture_unresolved',
	/** The candidate declares no result contract usable for a command. */
	'emit_result_contract_undeclared',
] as const

export type EmitRefusalCause = (typeof EMIT_REFUSAL_CAUSES)[number]

/**
 * One fail-closed emit refusal.
 *
 * `subject` names the artifact that could not be published (a station id, a
 * command, an Extension Point id) so a caller can repair the specification
 * without reading generator internals. Callers branch on `cause`, never on
 * `message`  -  the wording is contract surface but the identifier is the API.
 */
export interface EmitRefusal {
	readonly cause: EmitRefusalCause
	readonly subject: string
	readonly message: string
}

export function emitRefusal(input: EmitRefusal): EmitRefusal {
	return input
}

/**
 * Deterministic refusal order: cause first, then subject. A caller that
 * snapshots a refusal list depends on this being stable across runs.
 */
export function sortRefusals(
	refusals: readonly EmitRefusal[],
): readonly EmitRefusal[] {
	return [...refusals].sort(
		(a, b) =>
			a.cause.localeCompare(b.cause) || a.subject.localeCompare(b.subject),
	)
}
