/**
 * The emit seam: one compiled specification in, facade-shaped artifacts out.
 *
 * Mirrors the compiler's front door. Callers pass the IR and digest that
 * `compileSpecificationCandidate` produced and receive either the complete
 * artifact set or a list of emit refusals — never both, and never a partial
 * set. The generation pipeline that writes files, records provenance and
 * verifies drift consumes this; it is not implemented here.
 *
 * Emission is not Specification Admission.
 */
import {
	type CommandContractEmission,
	deriveCommandContracts,
} from './emit-command-contracts.ts'
import { type EmitRefusal, sortRefusals } from './emit-contract.ts'
import {
	buildExpectationTable,
	type SemanticExpectationRow,
} from './emit-expectations.ts'
import {
	type RenderedModule,
	renderCommandContracts,
	renderExpectationTable,
	renderStationCatalog,
} from './emit-render.ts'
import {
	type DerivedStation,
	deriveStations,
	stationIds,
} from './emit-stations.ts'
import type { SpecificationIr } from './ir.ts'

export interface EmitOptions {
	/**
	 * Consumer-relative catalog path. The auditor-skill constraint fixes this
	 * to `src/branch-station-catalog.ts` or a
	 * `src/front-doors/**​/branch-station-catalog.ts` within a consumer, with
	 * exactly one station-array export per file.
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
export interface EmitSuccess {
	readonly ok: true
	readonly stations: readonly DerivedStation[]
	readonly stationIds: readonly string[]
	readonly commandContracts: CommandContractEmission['contracts']
	readonly expectations: readonly SemanticExpectationRow[]
	readonly modules: readonly RenderedModule[]
	readonly refusals: readonly []
}

/** Fail-closed by construction: the failure variant carries no artifacts. */
export interface EmitFailure {
	readonly ok: false
	readonly refusals: readonly EmitRefusal[]
}

export type EmitResult = EmitSuccess | EmitFailure

const DEFAULT_CATALOG_PATH = 'src/branch-station-catalog.ts'

/**
 * Emits the facade-shaped artifact set for one compiled specification.
 *
 * Every derivation runs before any refusal is reported, so a caller sees the
 * complete repair list rather than only the first problem. Any refusal at all
 * suppresses the whole artifact set: a Generated Artifact Set is replaced as
 * one unit, so a partial set has no valid consumer.
 *
 * Feature conditioning is structural. Only feature-applicable machinery is
 * derived, so a stateless product's output contains no durable-operation,
 * liveness, retry, Cancellation or version-custody surface to strip.
 */
export function emitFacadeArtifacts(
	ir: SpecificationIr,
	digest: string,
	options: EmitOptions = {},
): EmitResult {
	const catalogPath = options.catalogPath ?? DEFAULT_CATALOG_PATH
	const symbolPrefix = options.symbolPrefix ?? camel(ir.specMeta.product)
	const constantPrefix = screaming(ir.specMeta.product)
	const discoveryImport = options.discoveryImport ?? {
		symbol: `project${pascal(symbolPrefix)}CommandDiscoveryTree`,
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

	const modules: RenderedModule[] = [
		renderStationCatalog({
			ir,
			digest,
			stations: stationEmission.stations,
			catalogPath,
			symbolPrefix,
			constantPrefix,
			discoveryImport,
		}),
		renderCommandContracts({
			ir,
			digest,
			contracts: contractEmission.contracts,
			path: 'src/command-surface-contract.ts',
			symbolPrefix,
		}),
		renderExpectationTable({
			ir,
			digest,
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

function camel(product: string): string {
	const [first, ...rest] = product.split(/[-_]/)
	return [first ?? product, ...rest.map(pascal)].join('')
}

function screaming(product: string): string {
	return product.replace(/-/g, '_').toUpperCase()
}

function pascal(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1)
}
