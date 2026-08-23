import {
	type ArtifactRefusal,
	type ArtifactRefusalCause,
	compileSpecificationCandidate,
	type DeclaredExtensionPoint,
	deriveArtifactSet,
	deriveCommandContracts,
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
 * Sealed causes no plain-data IR can reach through the derivation seam.
 *
 * Empty, and deliberately kept as a list rather than deleted: the coverage
 * suite pins it exactly, so a future cause added without a producer has a
 * declared place to be recorded and argued about rather than quietly
 * skipped.
 *
 * `emit_expectation_action_unknown` was pinned here on the reasoning that
 * action resolution and the catalog lookup read the same
 * `ir.actions.catalog`, so a resolved id could never be missed. Input Schema
 * v2 broke that: a `station_action` or `station_blocker` routing row supplies
 * its target directly, and that target reaches the lookup without ever being
 * drawn from the catalog. The guard is live, and it is the only thing
 * standing between an IR-level routing target and an emitted row naming an
 * action no catalog declares.
 */
export const UNPRODUCIBLE_REFUSAL_CAUSES =
	[] as const satisfies readonly ArtifactRefusalCause[]

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
	/**
	 * Neither the candidate nor the consumer names the entry point. The
	 * amended IR is the emission-ready one with its declared entry removed,
	 * and no consumer option is supplied, so the only two sources are absent.
	 */
	emit_entry_undeclarable: async () => {
		const { raw } = await emissionReadyVaultGit()
		// Deleted rather than merely omitted from the spread: the candidate
		// declares its own entry now, so a spread copy still carries it and the
		// producer would reach no refusal at all.
		const { entryScript: _entryScript, ...commandSurface } = raw.commandSurface
		const stripped: SpecificationIr = { ...raw, commandSurface }
		return deriveCommandContracts(stripped).refusals
	},
	/**
	 * A routing row supplying an action id the catalog does not declare.
	 *
	 * The row's target reaches the expectation table's catalog lookup without
	 * being drawn from the catalog, which is what makes this reachable at the
	 * IR seam. Compile validation resolves the same target, so a real
	 * candidate is refused earlier; this proves the derivation guard is a
	 * genuine second owner rather than dead code.
	 */
	emit_expectation_action_unknown: () =>
		refusalsFrom(({ ir }) => ({
			...ir,
			routing: [
				...ir.routing,
				{
					name: 'unknown_action_binding',
					role: 'station_action',
					targetKind: 'action',
					discriminants: {
						branch: ['success'],
						command: [ir.commandSurface.commands[0] ?? ''],
					},
					requiresCompleteCoverage: false,
					rows: [
						{
							key: {
								branch: 'success',
								command: ir.commandSurface.commands[0] ?? '',
							},
							target: 'no_such_action',
						},
					],
				},
			],
		})),
	/**
	 * A rendering sharing its identifier with a canonical action id, so one
	 * resolver reading both namespaces has two answers for one identifier.
	 */
	emit_contextual_rendering_collides: () =>
		refusalsFrom(({ ir }) => {
			const canonical = ir.actions.catalog[0]?.id ?? 'none'
			return {
				...ir,
				contextualRenderings: {
					...ir.contextualRenderings,
					[canonical]: [canonical],
				},
			}
		}),
	/**
	 * A route targeting a Branch Station the catalog does not contain. The
	 * command prefix is a genuinely declared command and only the branch
	 * suffix is unknown, which is the case a prefix-only check resolves and
	 * the whole-target check refuses.
	 */
	emit_route_station_unknown: () =>
		refusalsFrom(({ ir }) => ({
			...ir,
			routing: [
				...ir.routing,
				{
					name: 'unknown_station_route',
					role: 'fact_branch',
					targetKind: 'branch_station',
					discriminants: { probe: ['only'] },
					requiresCompleteCoverage: false,
					rows: [
						{
							key: { probe: 'only' },
							target: `${ir.commandSurface.commands[0]}.typo_no_such_station`,
						},
					],
				},
			],
		})),
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
	/**
	 * A declared v2 candidate whose write-implying command carries neither a
	 * non-mutating execution mode nor a Preview Exemption, so the Write Preview
	 * obligation cannot be satisfied from anything it declares.
	 *
	 * The fixture reaches the cause on its own compiled IR, with no amendment
	 * at all: the refusal is a property of what the candidate declares rather
	 * than of a mutation map the harness restored.
	 */
	emit_write_preview_undeclarable: async () => {
		const source = await Bun.file(
			new URL(
				'../../fixtures/v2/derivation-write-preview-undeclarable.jsonc',
				import.meta.url,
			),
		).text()
		const compiled = compileSpecificationCandidate(source)
		if (!compiled.ok) {
			throw new Error('write-preview fixture failed to compile')
		}
		const emission = deriveArtifactSet(
			compiled.ir,
			compiled.digest.specificationDigest,
		)
		return emission.ok ? [] : emission.refusals
	},
	/**
	 * No declared blocker at all: a refusal station cannot name an admitted
	 * refusal cause, so its blocker column is underivable.
	 *
	 * Both sources have to go. The candidate declares a `station_blocker`
	 * routing table, and a row in that table supplies its station's blocker
	 * directly, so emptying only `blockers` leaves every refusal station still
	 * naming one and reaches no refusal.
	 */
	emit_expectation_column_underivable: () =>
		refusalsFrom(({ ir }) => ({
			...ir,
			blockers: [],
			routing: ir.routing.filter((table) => table.role !== 'station_blocker'),
		})),
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
