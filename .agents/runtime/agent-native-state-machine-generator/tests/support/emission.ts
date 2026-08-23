import {
	compileSpecificationCandidate,
	type DerivationOptions,
	type DerivationSuccess,
	deriveArtifactSet,
	isWriteImplyingMutation,
	type SpecificationIr,
} from '../../src/index.ts'
import { readCandidate } from './candidates.ts'

/**
 * Compiles a spike candidate and closes the two Input Schema v1 expressiveness
 * gaps so the positive emission gates have something to assert against.
 *
 * The gaps are real and are pinned separately by
 * `emit-expressiveness-gaps.test.ts`: v1 declares no execution modes, and no
 * mapping from a blocker to the command it refuses. Rather than weaken the
 * emitters to paper over that, these fixtures supply what a stage-5 admission
 * is expected to supply, and say so.
 *
 * The IR is amended, never the emitter: every derivation under test runs
 * exactly as it will in production, on an IR shaped the way an admitted
 * specification will shape it.
 */
export interface AmendedEmission {
	readonly ir: SpecificationIr
	readonly emission: DerivationSuccess
}

/**
 * Stands in for a stage-5 admitted execution-mode surface by declaring the
 * product's write-implying commands as previewable reads.
 *
 * A write-implying mutation owes the facade's Write Preview Capability
 * obligation, which v1 cannot express. Recasting those commands as `preview`
 * is the narrowest amendment that lets the rest of the derivation be proved;
 * it deliberately does not invent a `check` execution mode inside the emitter.
 */
function withPreviewableMutations(ir: SpecificationIr): SpecificationIr {
	const mutations = Object.fromEntries(
		Object.entries(ir.commandSurface.mutations).map(([command, mutation]) => [
			command,
			isWriteImplyingMutation(mutation) ? 'preview' : mutation,
		]),
	)
	return { ...ir, commandSurface: { ...ir.commandSurface, mutations } }
}

/**
 * Stands in for a stage-5 admitted bare-invocation binding by declaring the
 * command that owns the product's no-argument behavior.
 *
 * v1 names the behavior but never which command bare invocation dispatches to,
 * and the facade's third hard invariant requires a station's command to exist
 * in discovery.
 */
function withNoArgumentCommand(
	ir: SpecificationIr,
	command: string,
): SpecificationIr {
	if (ir.commandSurface.commands.includes(command)) return ir
	return {
		...ir,
		commandSurface: {
			...ir.commandSurface,
			commands: [...ir.commandSurface.commands, command],
			mutations: { ...ir.commandSurface.mutations, [command]: 'read' },
		},
	}
}

/**
 * Stands in for a stage-5 blocker-to-command mapping by narrowing the
 * candidate to exactly one declared blocker, which the emitter accepts as
 * unambiguous.
 *
 * This is v1's fallback and only v1's: it applies where the candidate
 * declares no `station_blocker` routing table. A candidate that declares one
 * has already said which blocker refuses which command, so replacing its
 * blocker list would make the routing rows name blockers the amended IR no
 * longer declares.
 */
function withSingleBlocker(
	ir: SpecificationIr,
	blocker: string,
): SpecificationIr {
	return { ...ir, blockers: [blocker] }
}

function declaresStationBlockerRouting(ir: SpecificationIr): boolean {
	return ir.routing.some((table) => table.role === 'station_blocker')
}

/**
 * The only two refusal stations this harness will supply a row for.
 *
 * The vault-git candidate declares `activation` as a routed command with no
 * row, and declares `commands` without routing it at all, so those two
 * refusal stations have no blocker to name. Both absences are Input Schema
 * shape decisions reserved to the product owner, and the candidate is
 * read-only here.
 *
 * Named rather than derived from absence. A supply defined by "whatever is
 * missing" would absorb a future regression in the candidate's real
 * blocker-to-command mapping and keep the suite green, which is exactly the
 * failure this list exists to prevent.
 */
const RESERVED_BLOCKER_GAPS = ['activation', 'commands'] as const

/**
 * Harness-only supply: gives the two reserved refusal stations a
 * `station_blocker` row so the emission path downstream of the gap can be
 * proved, exactly as the `entryScript` amendment above supplies what an
 * admission would.
 *
 * What it supplies: the routing key (one reserved command per declared refusal
 * branch), `blocker`, and `target`. Both values are arbitrary choices from the
 * candidate's own declared vocabularies, and no test asserts either:
 *
 * - `blocker` is `ir.blockers[0]`. Which blocker actually refuses these two
 *   commands is part of the reserved decision.
 * - `target` is borrowed from the table's first declared row, which makes it
 *   the `begin` command's remediation action attached to two stations it does
 *   not describe. It is supplied only because `RoutingRow.target` is a
 *   required field, so a row cannot omit it; omitting it derives cleanly but
 *   does not typecheck.
 *
 * What it deliberately does NOT supply: `retrySafety`, which is optional on
 * the row. Supplying it would override declared meaning, because
 * `src/expectations.ts` resolves posture as `routed ?? resolved`, so a
 * supplied column wins over the candidate's own rules. Omitted, the declared
 * surface answers: the candidate's ordered `retry_posture` table ends
 * `result_kind: refusal -> same_input_unsafe`. Supplying it would be a
 * hardcoded default masquerading as derivation.
 *
 * The unamended gap is pinned by `the accepted candidate's own reserved
 * blocker gap` in `v2-derivation.test.ts`, which derives this candidate with
 * no amendment and asserts exactly these two subjects.
 *
 * Throws rather than backfilling when the missing set is anything else. A
 * broad suite failure naming the unexpected set is the intended outcome: it
 * means the candidate's mapping changed, not that the harness broke.
 */
function withCompleteStationBlockerRows(ir: SpecificationIr): SpecificationIr {
	const routing = ir.routing.map((table) => {
		if (table.role !== 'station_blocker') return table
		const branches = table.discriminants.branch ?? []
		const covered = new Set(table.rows.map((row) => row.key.command))
		const missing = ir.commandSurface.commands
			.filter((command) => !covered.has(command))
			.sort()
		// Sorted both sides: a routing reorder must not flip this comparison.
		const reserved = [...RESERVED_BLOCKER_GAPS].sort()
		if (missing.join(',') !== reserved.join(',')) {
			throw new Error(
				`station_blocker supply expects exactly [${reserved.join(', ')}], found [${missing.join(', ')}]`,
			)
		}
		const blocker = ir.blockers[0]
		if (blocker === undefined) {
			throw new Error('station_blocker supply needs a declared blocker')
		}
		const target = table.rows[0]?.target ?? 'none'
		const supplied = missing.flatMap((command) =>
			branches.map((branch) => ({ key: { branch, command }, blocker, target })),
		)
		return {
			...table,
			discriminants: {
				...table.discriminants,
				command: [...ir.commandSurface.commands].sort(),
			},
			rows: [...table.rows, ...supplied],
		}
	})
	return { ...ir, routing }
}

/**
 * The complete amendment chain as one owner, exported so a test that amends a
 * compiled IR itself applies exactly the amendments `emitAmended` applies
 * rather than inlining a divergent copy.
 */
export function amendForEmission(ir: SpecificationIr): SpecificationIr {
	// A stage-5 admitted candidate declares its own entry; these fixtures are
	// on a superseded version that has no such surface, so the amendment
	// supplies what the admission would. The real per-product value comes from
	// the consumer at derivation, which is what the pilot lane does.
	const withEntry: SpecificationIr = {
		...ir,
		commandSurface: { ...ir.commandSurface, entryScript: 'src/cli.ts' },
	}
	const withBinding = withNoArgumentCommand(
		withPreviewableMutations(withEntry),
		// The behavior each candidate declares; `help` for fallow, the status
		// dashboard for vault-git (whose `status` command already exists).
		ir.commandSurface.noArgumentBehavior === 'help' ? 'help' : 'status',
	)
	// A candidate declaring a station_blocker table has already mapped blockers
	// to commands, so it needs the rows completed rather than the blocker list
	// narrowed. v1 declares no such table and takes the single-blocker
	// fallback.
	return declaresStationBlockerRouting(withBinding)
		? withCompleteStationBlockerRows(withBinding)
		: withSingleBlocker(withBinding, ir.blockers[0] ?? 'runtime_unavailable')
}

export async function emitAmended(
	product: 'vault-git' | 'fallow',
	options: DerivationOptions = {},
): Promise<AmendedEmission> {
	const compiled = compileSpecificationCandidate(await readCandidate(product))
	if (!compiled.ok) throw new Error(`${product} candidate failed to compile`)

	const ir = amendForEmission(compiled.ir)
	const emission = deriveArtifactSet(
		ir,
		compiled.digest.specificationDigest,
		options,
	)
	if (!emission.ok) {
		throw new Error(
			`${product} emission refused: ${emission.refusals
				.map((refusal) => `${refusal.cause}@${refusal.subject}`)
				.join(', ')}`,
		)
	}
	return { ir, emission }
}
