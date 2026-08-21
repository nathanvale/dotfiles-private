import {
	type ArtifactRefusal,
	type ArtifactRefusalCause,
	compileSpecificationCandidate,
	type DeclaredExtensionPoint,
	deriveArtifactSet,
	type RegisteredExtension,
	reconcileExtensionRegistry,
	type SpecificationIr,
} from '../../src/index.ts'
import { readCandidate } from './candidates.ts'
import { amendForEmission } from './emission.ts'

/**
 * One producer per sealed artifact refusal cause, each running the real seam:
 * `deriveArtifactSet` over an amended IR, or Extension Registry
 * reconciliation for the four binding causes a Specification Candidate
 * cannot carry. Producers amend IR only, never emitters, so every refusal
 * observed here is one the production pipeline can genuinely raise.
 *
 * sealed-cause-coverage.test.ts iterates ARTIFACT_REFUSAL_CAUSES against
 * this registry; the Record type keeps it total, so adding a sealed cause
 * without a producer fails typecheck before it fails the suite.
 */
export type RefusalProducer = () => Promise<readonly ArtifactRefusal[]>

/**
 * Sealed causes no plain-data IR can currently reach through the derivation
 * seam. `buildExpectationTable` looks each resolved action up in a catalog
 * map built from the same `ir.actions.catalog` its own action resolution
 * chooses from, so the lookup cannot miss; only a self-mutating IR fake
 * could split the two reads, and a fake proves nothing about the pipeline.
 * The dead guard is recorded for a src-side repair. The coverage suite pins
 * this list exactly, so a repair that makes the cause reachable must
 * register a real producer here and remove the pin.
 */
export const UNPRODUCIBLE_REFUSAL_CAUSES = [
	'emit_expectation_action_unknown',
] as const satisfies readonly ArtifactRefusalCause[]

export type UnproducibleRefusalCause =
	(typeof UNPRODUCIBLE_REFUSAL_CAUSES)[number]

export type ProducibleRefusalCause = Exclude<
	ArtifactRefusalCause,
	UnproducibleRefusalCause
>

export function isUnproducibleRefusalCause(
	cause: ArtifactRefusalCause,
): cause is UnproducibleRefusalCause {
	return (
		UNPRODUCIBLE_REFUSAL_CAUSES as readonly ArtifactRefusalCause[]
	).includes(cause)
}

interface EmissionReadyVaultGit {
	/** The compiled IR exactly as the candidate declares it. */
	readonly raw: SpecificationIr
	/** The same IR through the shared stage-5 amendment chain; emits cleanly. */
	readonly ir: SpecificationIr
	readonly digest: string
}

let cached: EmissionReadyVaultGit | undefined

async function emissionReadyVaultGit(): Promise<EmissionReadyVaultGit> {
	if (cached) return cached
	const compiled = compileSpecificationCandidate(
		await readCandidate('vault-git'),
	)
	if (!compiled.ok) throw new Error('vault-git candidate failed to compile')
	cached = {
		raw: compiled.ir,
		ir: amendForEmission(compiled.ir),
		digest: compiled.digest.specificationDigest,
	}
	return cached
}

async function refusalsFrom(
	amend: (ready: EmissionReadyVaultGit) => SpecificationIr,
): Promise<readonly ArtifactRefusal[]> {
	const ready = await emissionReadyVaultGit()
	const emission = deriveArtifactSet(amend(ready), ready.digest)
	return emission.ok ? [] : emission.refusals
}

// Reconciliation inputs mirroring extension-registry.test.ts: one declared
// point, bindings varied per cause.
const REVISION = 'rev-2'
const OLDER = 'rev-1'

const FACT_PROVIDER: DeclaredExtensionPoint = {
	id: 'vault_git.remote_lease_state',
	kind: 'fact_provider',
	specificationRevision: REVISION,
}

function bind(id: string, revision = REVISION): RegisteredExtension {
	return { extensionPointId: id, specificationRevision: revision }
}

export const REFUSAL_CAUSE_PRODUCERS: Readonly<
	Record<ProducibleRefusalCause, RefusalProducer>
> = {
	// A command name the facade's lowercase station id grammar cannot express.
	emit_station_id_invalid: () =>
		refusalsFrom(({ ir }) => ({
			...ir,
			commandSurface: {
				...ir.commandSurface,
				commands: [...ir.commandSurface.commands, 'Begin'],
				mutations: { ...ir.commandSurface.mutations, Begin: 'read' },
			},
		})),
	// A duplicate command declaration would derive two stations with one id.
	emit_station_id_duplicate: () =>
		refusalsFrom(({ ir }) => ({
			...ir,
			commandSurface: {
				...ir.commandSurface,
				commands: [...ir.commandSurface.commands, 'status'],
			},
		})),
	// A surface withdrawing baseline exit meaning 2 while every command still
	// reaches an invalid-usage branch.
	emit_baseline_exit_missing: () =>
		refusalsFrom(({ ir }) => ({
			...ir,
			commandSurface: {
				...ir.commandSurface,
				exitCodes: { '0': 'success', '1': 'refused_blocked_or_failed' },
			},
		})),
	emit_registry_binding_missing: async () =>
		reconcileExtensionRegistry({
			declared: [FACT_PROVIDER],
			registered: [],
			currentRevision: REVISION,
		}).refusals,
	emit_registry_binding_extra: async () =>
		reconcileExtensionRegistry({
			declared: [FACT_PROVIDER],
			registered: [bind(FACT_PROVIDER.id), bind('vault_git.invented_point')],
			currentRevision: REVISION,
		}).refusals,
	emit_registry_binding_stale: async () =>
		reconcileExtensionRegistry({
			declared: [FACT_PROVIDER],
			registered: [bind(FACT_PROVIDER.id, OLDER)],
			currentRevision: REVISION,
		}).refusals,
	emit_registry_binding_orphaned: async () =>
		reconcileExtensionRegistry({
			declared: [FACT_PROVIDER],
			registered: [
				bind(FACT_PROVIDER.id),
				bind('vault_git.withdrawn_point', OLDER),
			],
			currentRevision: REVISION,
		}).refusals,
	// The candidate's own write-implying mutations restored onto the otherwise
	// amended IR: v1 declares no execution mode that could satisfy the Write
	// Preview Capability obligation.
	emit_write_preview_undeclarable: () =>
		refusalsFrom(({ ir, raw }) => ({
			...ir,
			commandSurface: {
				...ir.commandSurface,
				mutations: raw.commandSurface.mutations,
			},
		})),
	// No declared blocker at all: a refusal station cannot name an admitted
	// refusal cause, so its blocker column is underivable.
	emit_expectation_column_underivable: () =>
		refusalsFrom(({ ir }) => ({ ...ir, blockers: [] })),
	// A declared rule table that matches no station: retry posture cannot be
	// derived from exit status or prose.
	emit_retry_posture_unresolved: () =>
		refusalsFrom(({ ir }) => ({
			...ir,
			retryPosture: {
				...ir.retryPosture,
				rules: [
					// biome-ignore lint/suspicious/noThenProperty: schema field name, not a thenable
					{ when: { command: 'no_such_command' }, then: 'same_input_safe' },
				],
			},
		})),
	// No result contract anywhere on the surface: no station can name one.
	emit_result_contract_undeclared: () =>
		refusalsFrom(({ ir }) => ({
			...ir,
			commandSurface: { ...ir.commandSurface, resultContracts: {} },
		})),
}

/**
 * The nearest legitimate attempt at `emit_expectation_action_unknown`: a
 * catalog declaring no terminal `none` entry. Action resolution refuses one
 * step earlier with `emit_expectation_column_underivable`, which is exactly
 * what the coverage suite pins.
 */
export async function attemptExpectationActionUnknown(): Promise<
	readonly ArtifactRefusal[]
> {
	return await refusalsFrom(({ ir }) => ({
		...ir,
		actions: {
			...ir.actions,
			catalog: ir.actions.catalog.filter((entry) => entry.id !== 'none'),
		},
	}))
}
