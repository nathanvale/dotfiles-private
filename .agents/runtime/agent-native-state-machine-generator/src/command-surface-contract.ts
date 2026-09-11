/**
 * Command Surface Contract emission.
 *
 * Produces `Record<Command, CommandFacadeContract>`, the single generated
 * static owner of one product's public CLI meaning. It is generated from the
 * same Admitted State-Machine Specification that generates the Branch
 * Stations, which is what closes the facade's declared-but-undelivered
 * cross-validation: neither side can name an exit code or result contract the
 * other does not.
 *
 * This module is the one owner of the baseline exit check, so a Branch Station
 * never restates it. Where the candidate cannot satisfy a facade obligation,
 * emission refuses and names the command; it never fills the gap itself.
 */
import type {
	CommandFacadeContract,
	CommandFacadeOutputMode,
	CommandFacadeSideEffect,
} from '@side-quest/cli-command-facade'
import { resolveResultContract } from './derivation-facts.ts'
import type { CommandSurface, SpecificationIr } from './ir.ts'
import { type ArtifactRefusal, artifactRefusal } from './refusal.ts'
import { BASELINE_EXIT_CODES, isWriteImplyingMutation } from './schema.ts'

/**
 * Declared mutation to facade side effects. A write-implying mutation must
 * declare `write` or `destructive` for the facade to accept it as honest.
 */
const MUTATION_SIDE_EFFECTS: Readonly<
	Record<string, readonly CommandFacadeSideEffect[]>
> = {
	read: ['read'],
	preview: ['read'],
	remote_write: ['write', 'network'],
	local_write: ['write'],
	recovery: ['write'],
}

export interface CommandContractEmission {
	readonly contracts: Readonly<Record<string, CommandFacadeContract>>
	readonly refusals: readonly ArtifactRefusal[]
}

/**
 * Emits the Command Surface Contract record for one compiled specification.
 *
 * Commands are emitted in sorted order so the record's key order depends on
 * the specification's content rather than on how the candidate happened to be
 * written.
 */
export function deriveCommandContracts(
	ir: SpecificationIr,
	options: { readonly entryScript?: string } = {},
): CommandContractEmission {
	const surface = ir.commandSurface
	// Declared beats supplied, and neither means refuse. The generator has no
	// third source: a conventional default would name a path that need not
	// exist, which is what an auditor found in every v1 contract.
	const entryScript = ir.commandSurface.entryScript ?? options.entryScript
	const refusals: ArtifactRefusal[] = []
	const contracts: Record<string, CommandFacadeContract> = {}

	// Collected, not short-circuited: the other columns are still checked so
	// a candidate sees every underivable surface at once rather than one per
	// run, which is the same shape the write-preview refusal already takes.
	const entryRefusal = checkEntryScriptDeclared(ir, entryScript)
	if (entryRefusal !== undefined) refusals.push(entryRefusal)
	refusals.push(...checkBaselineExitCodesDeclared(surface))

	for (const command of [...surface.commands].sort()) {
		const outcome = deriveCommandContract(ir, surface, command, entryScript)
		if ('refusal' in outcome) refusals.push(outcome.refusal)
		else contracts[command] = outcome.contract
	}

	return { contracts, refusals }
}

function checkEntryScriptDeclared(
	ir: SpecificationIr,
	entryScript: string | undefined,
): ArtifactRefusal | undefined {
	if (entryScript !== undefined) return undefined
	return artifactRefusal({
		cause: 'emit_entry_undeclarable',
		subject: ir.specMeta.product,
		message: `Product ${ir.specMeta.product} names no public entry point: the candidate declares no command_surface.entry and the consumer supplied none, so every command contract's script would name a path the generator invented.`,
	})
}

function checkBaselineExitCodesDeclared(
	surface: CommandSurface,
): readonly ArtifactRefusal[] {
	const refusals: ArtifactRefusal[] = []
	for (const code of BASELINE_EXIT_CODES) {
		if (surface.exitCodes[code] === undefined) {
			refusals.push(
				artifactRefusal({
					cause: 'emit_baseline_exit_missing',
					subject: code,
					message: `The Command Surface Contract omits baseline exit meaning ${code}.`,
				}),
			)
		}
	}
	return refusals
}

/**
 * A write-implying command owes the facade's Write Preview Capability
 * obligation: a non-mutating Execution Mode, or a declared reason it owes
 * none. Both are product-owner decisions, so the generator reads what the
 * candidate declared and refuses when it declared neither rather than
 * inventing a `check` mode or authoring an exemption.
 */
function deriveCommandContract(
	ir: SpecificationIr,
	surface: CommandSurface,
	command: string,
	entryScript: string | undefined,
):
	| { readonly contract: CommandFacadeContract }
	| { readonly refusal: ArtifactRefusal } {
	const mutation = surface.mutations[command] ?? 'read'
	const sideEffects = MUTATION_SIDE_EFFECTS[mutation] ?? ['read']

	const declaredModes = surface.executionModes[command] ?? []
	const previewable = declaredModes.some(
		(mode) => mode === 'check' || mode === 'dry_run',
	)
	const exemption = surface.previewExemptions[command]
	if (
		isWriteImplyingMutation(mutation) &&
		!previewable &&
		exemption === undefined
	) {
		return {
			refusal: artifactRefusal({
				cause: 'emit_write_preview_undeclarable',
				subject: command,
				message: `Command ${command} declares write-implying mutation ${mutation}, which owes a check or dry_run preview path, but declares no such execution mode and no preview exemption. Admit one or the other for ${command}.`,
			}),
		}
	}

	const declared = resolveResultContract(command, surface)
	const resultContract =
		declared === undefined
			? undefined
			: { id: declared.id, schema_version: declared.version }
	return {
		contract: {
			script: `${entryScript ?? ''} ${command}`,
			summary: summaryFor(command, mutation),
			usage: [`${ir.specMeta.product} ${command}`],
			json: outputModesFor(command, surface).includes('json'),
			audience: 'agent',
			mutation,
			sideEffects,
			outputModes: outputModesFor(command, surface),
			...(resultContract === undefined ? {} : { resultContract }),
			flags: flagsFor(command, surface),
			exitCodes: { ...surface.exitCodes },
		},
	}
}

function outputModesFor(
	command: string,
	surface: CommandSurface,
): readonly CommandFacadeOutputMode[] {
	const declared =
		surface.outputModesOverrides[command] ?? surface.outputModesDefault
	return declared.filter(
		(mode): mode is CommandFacadeOutputMode =>
			mode === 'json' || mode === 'plain' || mode === 'jsonl',
	)
}

/**
 * Flags become facade flag declarations. Input Schema v1 records a flag's
 * spelling but not its type, so every declared flag is emitted as a boolean:
 * inventing a richer type the specification never admitted would make the
 * generated contract claim more than its authority supports.
 *
 * The facade keys flags by their full `--` spelling and refuses a bare name,
 * so the candidate's spelling is carried through unchanged rather than
 * normalized.
 */
function flagsFor(
	command: string,
	surface: CommandSurface,
): CommandFacadeContract['flags'] {
	const flags: CommandFacadeContract['flags'] = {}
	for (const flag of [...(surface.flags[command] ?? [])].sort()) {
		flags[flag] = { type: 'boolean' }
	}
	return flags
}

function summaryFor(command: string, mutation: string): string {
	return `${command} performs its declared ${mutation} work and returns one typed result.`
}
