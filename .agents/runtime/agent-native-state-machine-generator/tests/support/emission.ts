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
 */
function withSingleBlocker(
	ir: SpecificationIr,
	blocker: string,
): SpecificationIr {
	return { ...ir, blockers: [blocker] }
}

export async function emitAmended(
	product: 'vault-git' | 'fallow',
	options: DerivationOptions = {},
): Promise<AmendedEmission> {
	const compiled = compileSpecificationCandidate(await readCandidate(product))
	if (!compiled.ok) throw new Error(`${product} candidate failed to compile`)

	const withBinding = withNoArgumentCommand(
		withPreviewableMutations(compiled.ir),
		// The behavior each candidate declares; `help` for fallow, the status
		// dashboard for vault-git (whose `status` command already exists).
		compiled.ir.commandSurface.noArgumentBehavior === 'help'
			? 'help'
			: 'status',
	)
	const ir = withSingleBlocker(
		withBinding,
		compiled.ir.blockers[0] ?? 'runtime_unavailable',
	)
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
