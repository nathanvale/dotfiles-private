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
import { type JsoncNode, parseJsonc, toPlainValue } from './jsonc.ts'
import { registeredReaderFor } from './registered-readers.ts'
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
	/**
	 * Names the Registered Reader that produced this result, and is absent for
	 * input on the current Input Schema Version.
	 *
	 * Provenance rather than decoration: a caller can tell legacy input from
	 * current input without re-reading the candidate, and the digest identity
	 * it carries is that reader's frozen contract rather than the current
	 * path's.
	 */
	readonly registeredReader?: string
}

export interface CompileFailure {
	readonly ok: false
	readonly diagnostics: readonly Diagnostic[]
}

export type CompileResult = CompileSuccess | CompileFailure

/**
 * Reads the declared Input Schema Version straight from the parsed document.
 *
 * Runs before structural validation, so it cannot assume the field is present
 * or a string: an absent or malformed value simply selects the current
 * surface, and validation then reports the real defect against it.
 */
function declaredVersion(root: JsoncNode): string {
	if (root.kind !== 'object') return ''
	const meta = root.entries.find((entry) => entry.key === 'spec_meta')?.value
	if (meta === undefined || meta.kind !== 'object') return ''
	const version = meta.entries.find(
		(entry) => entry.key === 'input_schema_version',
	)?.value
	return version !== undefined && version.kind === 'string' ? version.value : ''
}

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

	// The declared Input Schema Version selects the surface the candidate is
	// validated against, so it is read before structural validation rather
	// than after. A Registered Reader owns its version's frozen surface; input
	// on the current version is checked against the current shape. Without
	// this, one shared shape would let a candidate claim a superseded version,
	// declare a surface that version never had, and still be digested under
	// that version's frozen envelope.
	const reader = registeredReaderFor(declaredVersion(parsed.root))

	const structural = validateStructure(
		parsed.root,
		sourcePath,
		reader?.acceptedShape,
	)
	if (structural.length > 0)
		return { ok: false, diagnostics: sortDiagnostics(structural) }

	const semantic = validateSemantics(parsed.root, sourcePath)
	if (semantic.length > 0)
		return { ok: false, diagnostics: sortDiagnostics(semantic) }

	const document = toPlainValue(parsed.root)
	const ir = buildIr(document)

	// The same reader that owned the accepted surface owns the digest. The IR
	// carries the declared version verbatim either way; only the digest
	// identity differs, and it differs because a reader freezes its version's
	// bytes.
	if (reader !== undefined)
		return {
			ok: true,
			ir,
			digest: reader.digest(document),
			diagnostics: [],
			registeredReader: reader.name,
		}

	return {
		ok: true,
		ir,
		digest: digestSpecification(document),
		diagnostics: [],
	}
}

export {
	type DerivationFailure,
	type DerivationOptions,
	type DerivationResult,
	type DerivationSuccess,
	deriveArtifactSet,
} from './artifact-derivation.ts'
export {
	type ArtifactEmitter,
	DEFAULT_EMITTERS,
	type EmissionResult,
	type EmittedArtifacts,
	PROVENANCE_MANIFEST_PATH,
	type ProvenanceManifest,
} from './artifact-set.ts'
export {
	type DerivedStation,
	type StationEmission,
	stationIds,
} from './branch-stations.ts'
export {
	GENERATOR_CONTRACT_VERSION,
	INPUT_SCHEMA_VERSION,
	isSupportedInputSchemaVersion,
	type SpecificationDigest,
	SUPPORTED_INPUT_SCHEMA_VERSIONS,
	type SupportedInputSchemaVersion,
} from './canonical.ts'
export {
	type CommandContractEmission,
	deriveCommandContracts,
} from './command-surface-contract.ts'
export {
	projectRetryable,
	type RetryableEvidence,
} from './derivation-facts.ts'
export {
	DIAGNOSTIC_CAUSES,
	type Diagnostic,
	type DiagnosticCause,
	type DiagnosticStage,
	type SourceLocation,
} from './diagnostics.ts'
export type {
	ExpectationEmission,
	SemanticExpectationRow,
} from './expectations.ts'
export {
	type DeclaredExtensionPoint,
	EXTENSION_POINT_KINDS,
	type ExtensionPointKind,
	type RegisteredExtension,
	type RegistryReconciliation,
	reconcileExtensionRegistry,
} from './extension-registry.ts'
export {
	DRIFT_CAUSES,
	type DriftCause,
	type DriftFinding,
	GENERATION_FAILURE_CAUSES,
	type GenerationFailure,
	type GenerationFailureCause,
	type GenerationOptions,
	type GenerationResult,
	type GenerationSuccess,
	generateArtifactSet,
	regenerateArtifactSet,
	VERIFICATION_FAILURE_CAUSES,
	type VerificationClean,
	type VerificationDrift,
	type VerificationFailureCause,
	type VerificationResult,
	verifyArtifactSet,
} from './generate.ts'
export { INPUT_SCHEMA_V1_SHAPE } from './input-schema-v1.ts'
export type {
	ActionEntry,
	CapabilityAvailability,
	CommandSurface,
	ExpectationColumns,
	Features,
	ObservationBudget,
	PauseMode,
	PositionalRoute,
	RetryRule,
	RootBranch,
	RoutingRow,
	RoutingTable,
	SpecificationIr,
	SpecMeta,
	StateDefinition,
	TransitionEntry,
} from './ir.ts'
export {
	attemptWindowMs,
	isObservationExpired,
	isPollUseful,
	type ObservationProgress,
} from './observation-budgets.ts'
export {
	ARTIFACT_REFUSAL_CAUSES,
	type ArtifactRefusal,
	type ArtifactRefusalCause,
} from './refusal.ts'
export {
	isRegisteredReaderVersion,
	REGISTERED_READER_VERSIONS,
	REGISTERED_READERS,
	type RegisteredReader,
	type RegisteredReaderVersion,
	registeredReaderFor,
} from './registered-readers.ts'
export type { RenderedModule } from './render.ts'
export {
	BASELINE_EXIT_CODES,
	CHANGED_STATES,
	type ChangedState,
	EXECUTION_MODES,
	type ExecutionMode,
	isWriteImplyingMutation,
	NEXT_SAFE_ACTION_KINDS,
	type NextSafeActionKind,
	RESULT_CHANNELS,
	RETRY_POSTURES,
	type ResultChannel,
	type RetryPosture,
	ROUTE_TARGET_KINDS,
	ROUTING_ROLES,
	type RouteTargetKind,
	type RoutingRole,
	type Shape,
	V2_ONLY_SURFACE_PATHS,
	type V2OnlySurfacePath,
	WRITE_IMPLYING_MUTATIONS,
	type WriteImplyingMutation,
} from './schema.ts'
export { addedPaths } from './schema-difference.ts'
