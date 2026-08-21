/**
 * Agent-Native State Machine Generator — stage 1 public compiler seam.
 *
 * One front door: JSONC Specification Candidate text in, either a canonical
 * typed intermediate representation plus a specification digest, or a list of
 * located diagnostics. Parsing, structural validation, semantic validation,
 * canonicalization and digesting stay inside this module; callers never reach
 * an internal stage.
 *
 * Compilation is not Specification Admission. A candidate that compiles has
 * no semantic authority until the product owner admits it explicitly.
 */

import { buildIr } from './build-ir.ts'
import { digestSpecification, type SpecificationDigest } from './canonical.ts'
import { type Diagnostic, sortDiagnostics } from './diagnostics.ts'
import type { SpecificationIr } from './ir.ts'
import { parseJsonc, toPlainValue } from './jsonc.ts'
import { validateSemantics } from './semantic.ts'
import { validateStructure } from './structural.ts'

export interface CompileOptions {
	/** Attached to every diagnostic so a caller can report the origin file. */
	readonly sourcePath?: string
}

/**
 * Fail-closed by construction: the failure variant carries no `ir` and no
 * `digest` field, so partial output cannot be read even by mistake.
 */
export interface CompileSuccess {
	readonly ok: true
	readonly ir: SpecificationIr
	readonly digest: SpecificationDigest
	readonly diagnostics: readonly []
}

export interface CompileFailure {
	readonly ok: false
	readonly diagnostics: readonly Diagnostic[]
}

export type CompileResult = CompileSuccess | CompileFailure

/**
 * Compiles one Specification Candidate.
 *
 * Stages run in order and stop at the first stage that produced diagnostics:
 * semantic checks assume a structurally valid document, so reporting semantic
 * noise on top of a structural failure would only obscure the real repair.
 *
 * Never throws for invalid input; every rejection is a returned diagnostic.
 */
export function compileSpecificationCandidate(
	source: string,
	options: CompileOptions = {},
): CompileResult {
	const { sourcePath } = options

	const parsed = parseJsonc(source, sourcePath)
	if (!parsed.ok)
		return { ok: false, diagnostics: sortDiagnostics(parsed.diagnostics) }

	const structural = validateStructure(parsed.root, sourcePath)
	if (structural.length > 0)
		return { ok: false, diagnostics: sortDiagnostics(structural) }

	const semantic = validateSemantics(parsed.root, sourcePath)
	if (semantic.length > 0)
		return { ok: false, diagnostics: sortDiagnostics(semantic) }

	const document = toPlainValue(parsed.root)
	const ir = buildIr(document)

	return {
		ok: true,
		ir,
		digest: digestSpecification(document),
		diagnostics: [],
	}
}

export {
	GENERATOR_CONTRACT_VERSION,
	INPUT_SCHEMA_VERSION,
	type SpecificationDigest,
} from './canonical.ts'
export {
	DIAGNOSTIC_CAUSES,
	type Diagnostic,
	type DiagnosticCause,
	type DiagnosticStage,
	type SourceLocation,
} from './diagnostics.ts'
export type {
	ActionEntry,
	CommandSurface,
	Features,
	RetryRule,
	SpecificationIr,
	SpecMeta,
	StateDefinition,
	TransitionEntry,
} from './ir.ts'
export {
	NEXT_SAFE_ACTION_KINDS,
	type NextSafeActionKind,
	RETRY_POSTURES,
	type RetryPosture,
} from './schema.ts'
