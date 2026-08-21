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
 * Every cause names a cross-validation the generator closes by construction:
 * one Admitted State-Machine Specification generates both the Branch Station
 * side and the Command Surface Contract side, so a disagreement between them
 * is a generator defect and never a consumer's problem to reconcile.
 */
export const EMIT_REFUSAL_CAUSES = [
	/** A Branch Station expects an exit code its command never declares. */
	'emit_station_exit_code_undeclared',
	/** A Branch Station result contract id mismatches the command's declaration. */
	'emit_station_result_contract_mismatch',
	/** A Branch Station id does not satisfy the facade's id grammar. */
	'emit_station_id_invalid',
	/** `id.split(".")[0] !== command` for a derived Branch Station. */
	'emit_station_id_command_mismatch',
	/** A Branch Station names a command absent from discovery. */
	'emit_station_command_unknown',
	/** Two derived Branch Stations claim the same id. */
	'emit_station_id_duplicate',
	/** A write-implying mutation declares no preview mode and no exemption. */
	'emit_write_preview_missing',
	/** The Command Surface Contract omits a baseline exit meaning. */
	'emit_baseline_exit_missing',
	/** A Branch Station's expectedActionId is absent from the action catalog. */
	'emit_expectation_action_unknown',
	/** A station joined to zero or more than one semantic expectation row. */
	'emit_expectation_join_ambiguous',
	/** A declared Extension Point has no Handwritten Extension bound. */
	'emit_registry_binding_missing',
	/** A Handwritten Extension is bound to no declared Extension Point. */
	'emit_registry_binding_extra',
	/** A binding names a specification revision that is no longer current. */
	'emit_registry_binding_stale',
	/** A binding survives for an Extension Point the specification withdrew. */
	'emit_registry_binding_orphaned',
] as const

export type EmitRefusalCause = (typeof EMIT_REFUSAL_CAUSES)[number]

/**
 * One fail-closed emit refusal.
 *
 * `subject` names the artifact that could not be published (a station id, a
 * command, an Extension Point id) so a caller can repair the specification
 * without reading generator internals. Callers branch on `cause`, never on
 * `message` — the wording is contract surface but the identifier is the API.
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
