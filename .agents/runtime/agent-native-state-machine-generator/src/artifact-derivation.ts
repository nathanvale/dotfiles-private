/**
 * The artifact derivation seam: one compiled specification in, the complete
 * Generated Artifact Set or sealed artifact refusals out.
 *
 * Mirrors the compiler's front door. Callers pass the IR and digest that
 * `compileSpecificationCandidate` produced and receive either the complete
 * artifact set or a list of artifact refusals  -  never both, and never a
 * partial set. The generation pipeline that writes files, records provenance and
 * verifies drift consumes this; it is not implemented here.
 *
 * Emission is not Specification Admission.
 */

import {
	type DerivedStation,
	deriveStations,
	stationIds,
} from './branch-stations.ts'
import {
	type CommandContractEmission,
	deriveCommandContracts,
} from './command-surface-contract.ts'
import {
	type DerivedContextualRendering,
	deriveContextualRenderings,
} from './contextual-renderings.ts'
import {
	camel,
	screaming,
	usesLifecycleConvention,
} from './derivation-facts.ts'
import {
	buildExpectationTable,
	type SemanticExpectationRow,
} from './expectations.ts'
import type { SpecificationIr } from './ir.ts'
import { type ArtifactRefusal, sortRefusals } from './refusal.ts'
import {
	type RenderedModule,
	renderActionRouting,
	renderCapabilityGates,
	renderCommandContracts,
	renderContextualRenderings,
	renderExpectationTable,
	renderFactBranchRouting,
	renderObservationBudgets,
	renderPauseModes,
	renderPositionalRoutes,
	renderRootBranches,
	renderStationCatalog,
} from './render.ts'

export interface DerivationOptions {
	/**
	 * Consumer-relative catalog path. The auditor-skill constraint fixes this to
	 * `src/branch-station-catalog.ts`, or a `branch-station-catalog.ts` under a
	 * consumer's `src/front-doors` tree, with exactly one station-array export
	 * per file.
	 */
	readonly catalogPath?: string
	/** Exported symbol prefix, e.g. `vaultGit`. Derived from the product when absent. */
	readonly symbolPrefix?: string
	/** The consumer's discovery projection function to import in the catalog. */
	readonly discoveryImport?: { readonly symbol: string; readonly from: string }
	/**
	 * The consumer's real public entry point, as an emitted Command Surface
	 * Contract names it.
	 *
	 * A per-product fact, like the paths above: the entry lives wherever the
	 * consumer put it, so neither the generator nor a version-owned reader can
	 * know it. An Input Schema v2 candidate declares its own and wins over
	 * this; a candidate that declares none and a consumer that supplies none
	 * leave the contract's mandatory `script` underivable, and emission
	 * refuses rather than naming a path that does not resolve.
	 */
	readonly entryScript?: string
}

/**
 * The complete emitted artifact set for one specification.
 *
 * Typed values and rendered source text sit side by side: a test asserts
 * against the values, and the generation pipeline writes the text.
 */
export interface DerivationSuccess {
	readonly ok: true
	readonly stations: readonly DerivedStation[]
	readonly stationIds: readonly string[]
	readonly commandContracts: CommandContractEmission['contracts']
	readonly expectations: readonly SemanticExpectationRow[]
	readonly contextualRenderings: readonly DerivedContextualRendering[]
	readonly modules: readonly RenderedModule[]
	readonly refusals: readonly []
}

/** Fail-closed by construction: the failure variant carries no artifacts. */
export interface DerivationFailure {
	readonly ok: false
	readonly refusals: readonly ArtifactRefusal[]
}

export type DerivationResult = DerivationSuccess | DerivationFailure

const DEFAULT_CATALOG_PATH = 'src/branch-station-catalog.ts'

/**
 * Derives the Generated Artifact Set for one compiled specification.
 *
 * Every artifact derivation runs before any refusal is reported, so a caller
 * sees the complete artifact repair list rather than only the first problem.
 * Any refusal at all suppresses the whole artifact set: a Generated Artifact
 * Set is replaced as one unit, so a partial set has no valid consumer.
 *
 * Extension Registry reconciliation is NOT part of this list. It needs the
 * product's real bindings, which a Specification Candidate does not carry, so
 * it stays a separate seam (`reconcileExtensionRegistry`) that a caller runs
 * with its own inputs.
 *
 * Feature conditioning is structural. Only feature-applicable machinery is
 * derived, so a stateless product's output contains no durable-operation,
 * liveness, retry, Cancellation or version-custody surface to strip.
 */
export function deriveArtifactSet(
	ir: SpecificationIr,
	digest: string,
	options: DerivationOptions = {},
): DerivationResult {
	const catalogPath = options.catalogPath ?? DEFAULT_CATALOG_PATH
	const symbolPrefix = options.symbolPrefix ?? camel(ir.specMeta.product)
	const constantPrefix = screaming(ir.specMeta.product)
	const discoveryImport = options.discoveryImport ?? {
		symbol: `project${symbolPrefix.charAt(0).toUpperCase()}${symbolPrefix.slice(1)}CommandDiscoveryTree`,
		from: './command-contract.ts',
	}

	const stationEmission = deriveStations(ir)
	const contractEmission = deriveCommandContracts(ir, {
		...(options.entryScript === undefined
			? {}
			: { entryScript: options.entryScript }),
	})
	const expectationEmission = buildExpectationTable(
		ir,
		stationEmission.stations,
	)
	const renderingEmission = deriveContextualRenderings(ir)

	const refusals = sortRefusals([
		...stationEmission.refusals,
		...contractEmission.refusals,
		...expectationEmission.refusals,
		...renderingEmission.refusals,
	])
	if (refusals.length > 0) return { ok: false, refusals }

	// Any binding the candidate did not declare outright is a derivation
	// convention, named in the rendered header so a reader sees which meanings
	// the specification admitted and which the generator inferred. Each one is
	// recorded for stage-5 admission rather than left implicit.
	const conventions = [...ir.commandSurface.commands]
		.sort()
		.filter((command) => usesLifecycleConvention(command, ir.commandSurface))
		.map(
			(command) =>
				`result contract for "${command}" bound by the lifecycle convention (the candidate declares no ${command} binding)`,
		)

	const modules: RenderedModule[] = [
		renderStationCatalog({
			ir,
			digest,
			conventions,
			stations: stationEmission.stations,
			catalogPath,
			symbolPrefix,
			constantPrefix,
			discoveryImport,
		}),
		renderCommandContracts({
			ir,
			digest,
			conventions,
			contracts: contractEmission.contracts,
			path: 'src/command-surface-contract.ts',
			symbolPrefix,
		}),
		renderExpectationTable({
			ir,
			digest,
			conventions,
			rows: expectationEmission.rows,
			path: 'src/semantic-expectations.ts',
			symbolPrefix,
		}),
	]

	// S4. Capability gates carry no installed value: a Liveness Evidence
	// Provider observes that at runtime against the declared Extension Point,
	// and the emitted selector routes on the evidence it is given.
	if (ir.capabilities.length > 0) {
		modules.push(
			renderCapabilityGates({
				ir,
				digest,
				conventions,
				capabilities: ir.capabilities,
				path: 'src/capability-gates.ts',
				symbolPrefix,
			}),
		)
	}

	// S4. Pause Modes are externally owned gates; the emitted action requests
	// release and never performs it.
	if (ir.pauseModes.length > 0) {
		modules.push(
			renderPauseModes({
				ir,
				digest,
				conventions,
				pauseModes: ir.pauseModes,
				path: 'src/pause-modes.ts',
				symbolPrefix,
			}),
		)
	}

	// Action routing: which canonical action a complete key selects (ADR
	// 0005). Every declared table whose rows target actions is published as
	// data; the one Projection Composer still selects the public State
	// Projection, so this adds no second action owner.
	const actionRoutingTables = ir.routing.filter(
		(table) => table.targetKind === 'action',
	)
	if (actionRoutingTables.length > 0) {
		modules.push(
			renderActionRouting({
				ir,
				digest,
				conventions,
				tables: actionRoutingTables,
				path: 'src/action-routing.ts',
				symbolPrefix,
			}),
		)
	}

	// Fact-to-branch selection: which station an observed fact reaches. Only
	// the tables the product declared with that role, never every routing
	// table - a table's role is what says derivation may read it this way,
	// and reading one by its shape is how a branch becomes an action.
	const factBranchTables = ir.routing.filter(
		(table) => table.role === 'fact_branch',
	)
	if (factBranchTables.length > 0) {
		modules.push(
			renderFactBranchRouting({
				ir,
				digest,
				conventions,
				tables: factBranchTables,
				path: 'src/fact-branch-routing.ts',
				symbolPrefix,
			}),
		)
	}

	// Positional routes are parsing facts about the command surface, emitted
	// beside the contract because the facade's contract type has no field
	// that carries token-to-action routing.
	if (ir.commandSurface.positionalRoutes.length > 0) {
		modules.push(
			renderPositionalRoutes({
				ir,
				digest,
				conventions,
				routes: ir.commandSurface.positionalRoutes,
				path: 'src/positional-routes.ts',
				symbolPrefix,
			}),
		)
	}

	// Root branches are front-door branches, so they are emitted beside the
	// station catalog rather than inside it: a station names its owning
	// command and these are reached before a command is selected.
	if (ir.commandSurface.rootBranches.length > 0) {
		modules.push(
			renderRootBranches({
				ir,
				digest,
				conventions,
				rootBranches: ir.commandSurface.rootBranches,
				path: 'src/root-branches.ts',
				symbolPrefix,
			}),
		)
	}

	// Same rule as the renderings module below: emitted only for a product
	// that declares observations, so a stateless product's set carries no
	// wait surface to strip.
	if (ir.observations.length > 0) {
		modules.push(
			renderObservationBudgets({
				ir,
				digest,
				conventions,
				observations: ir.observations,
				path: 'src/observation-budgets.ts',
				symbolPrefix,
			}),
		)
	}

	// Emitted only for a product that declares renderings. A product with no
	// compatibility identifiers gets no module rather than an empty one: the
	// Generated Artifact Set is replaced as one unit, and a file that exists
	// only to say "nothing here" is a surface a consumer could come to depend
	// on.
	if (renderingEmission.renderings.length > 0) {
		modules.push(
			renderContextualRenderings({
				ir,
				digest,
				conventions,
				renderings: renderingEmission.renderings,
				path: 'src/contextual-renderings.ts',
				symbolPrefix,
			}),
		)
	}

	return {
		ok: true,
		stations: stationEmission.stations,
		stationIds: stationIds(stationEmission.stations),
		commandContracts: contractEmission.contracts,
		expectations: expectationEmission.rows,
		contextualRenderings: renderingEmission.renderings,
		modules,
		refusals: [],
	}
}
