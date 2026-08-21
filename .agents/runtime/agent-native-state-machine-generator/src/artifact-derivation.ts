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
	renderCommandContracts,
	renderExpectationTable,
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
	const contractEmission = deriveCommandContracts(ir)
	const expectationEmission = buildExpectationTable(
		ir,
		stationEmission.stations,
	)

	const refusals = sortRefusals([
		...stationEmission.refusals,
		...contractEmission.refusals,
		...expectationEmission.refusals,
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

	return {
		ok: true,
		stations: stationEmission.stations,
		stationIds: stationIds(stationEmission.stations),
		commandContracts: contractEmission.contracts,
		expectations: expectationEmission.rows,
		modules,
		refusals: [],
	}
}
