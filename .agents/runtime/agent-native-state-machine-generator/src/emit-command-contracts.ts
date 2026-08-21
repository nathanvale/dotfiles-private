/**
 * Command Surface Contract emission.
 *
 * Produces `Record<Command, CommandFacadeContract>` — the single generated
 * static owner of one product's public CLI meaning. It is generated from the
 * same Admitted State-Machine Specification that generates the Branch
 * Stations, which is what closes the facade's declared-but-undelivered
 * cross-validation: neither side can name an exit code or result contract the
 * other does not.
 *
 * Two obligations are enforced here rather than left for the facade to report
 * as drift, because a generator that emits a contract the facade would refuse
 * has already failed: the Write Preview Capability obligation and the baseline
 * exit meanings.
 */
import type {
	CommandFacadeContract,
	CommandFacadeExecutionMode,
	CommandFacadeOutputMode,
	CommandFacadeSideEffect,
} from '@side-quest/cli-command-facade'
import { type EmitRefusal, emitRefusal } from './emit-contract.ts'
import type { CommandSurface, SpecificationIr } from './ir.ts'

/**
 * The baseline exit meanings every agent-native command contract must declare:
 * `0` success, `1` refusal or runtime failure, `2` invalid usage. Restated
 * from the facade's `COMMAND_FACADE_BASELINE_EXIT_CODES` so emission refuses
 * before publishing; a test proves the two lists agree.
 */
const BASELINE_EXIT_CODES = ['0', '1', '2'] as const

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

/** Mutations that owe the Write Preview Capability obligation. */
const WRITE_IMPLYING_MUTATIONS = new Set([
	'remote_write',
	'local_write',
	'recovery',
])

export interface CommandContractEmission {
	readonly contracts: Readonly<Record<string, CommandFacadeContract>>
	readonly refusals: readonly EmitRefusal[]
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
): CommandContractEmission {
	const surface = ir.commandSurface
	const refusals: EmitRefusal[] = []
	const contracts: Record<string, CommandFacadeContract> = {}

	for (const code of BASELINE_EXIT_CODES) {
		if (surface.exitCodes[code] === undefined) {
			refusals.push(
				emitRefusal({
					cause: 'emit_baseline_exit_missing',
					subject: code,
					message: `The Command Surface Contract omits baseline exit meaning ${code}.`,
				}),
			)
		}
	}

	for (const command of [...surface.commands].sort()) {
		const mutation = surface.mutations[command] ?? 'read'
		const sideEffects = MUTATION_SIDE_EFFECTS[mutation] ?? ['read']
		const executionModes = executionModesFor(mutation)
		const writeImplying = WRITE_IMPLYING_MUTATIONS.has(mutation)
		const declaresPreview =
			executionModes.includes('check') || executionModes.includes('dry_run')

		if (writeImplying && !declaresPreview) {
			refusals.push(
				emitRefusal({
					cause: 'emit_write_preview_missing',
					subject: command,
					message: `Command ${command} declares write-implying mutation ${mutation} but offers no check or dry_run execution mode and no previewExemption reason.`,
				}),
			)
			continue
		}

		const resultContract = resultContractFor(command, surface)
		contracts[command] = {
			script: `src/cli.ts ${command}`,
			summary: summaryFor(command, mutation),
			usage: [`${ir.specMeta.product} ${command}`],
			json: outputModesFor(command, surface).includes('json'),
			audience: 'agent',
			mutation,
			sideEffects,
			executionModes,
			outputModes: outputModesFor(command, surface),
			...(resultContract === undefined ? {} : { resultContract }),
			flags: flagsFor(command, surface),
			exitCodes: { ...surface.exitCodes },
		}
	}

	return { contracts, refusals }
}

/**
 * The execution modes a command offers.
 *
 * A write-implying mutation gets a `check` preview path so the Write Preview
 * Capability obligation is satisfied by construction; the generator never
 * emits a `previewExemption`, because an exemption is a narrow package-owned
 * judgement and a generator cannot author the product's reason for it.
 */
function executionModesFor(
	mutation: string,
): readonly CommandFacadeExecutionMode[] {
	if (WRITE_IMPLYING_MUTATIONS.has(mutation)) return ['normal', 'check']
	if (mutation === 'preview') return ['dry_run']
	return ['normal']
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

function resultContractFor(
	command: string,
	surface: CommandSurface,
): CommandFacadeContract['resultContract'] {
	const contracts = surface.resultContracts
	const role = command === 'commands' ? 'discovery' : command
	const declared = contracts[command] ?? contracts[role] ?? contracts.lifecycle
	if (declared === undefined) return undefined
	return { id: declared.id, schema_version: declared.version }
}

function summaryFor(command: string, mutation: string): string {
	return `${command} performs its declared ${mutation} work and returns one typed result.`
}
