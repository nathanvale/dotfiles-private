/**
 * Branch Station derivation.
 *
 * Input Schema v1 has no Branch Station section, and that is the point: a
 * Branch Station is not an independently authored fact that could disagree
 * with the command surface. Every station here is derived from the one
 * Admitted State-Machine Specification, so the cross-validations the facade
 * declares but never delivers - a station expecting an exit code its command
 * never declares, or a result contract id mismatching the command's
 * declaration - cannot be expressed rather than merely being caught.
 *
 * Derivation is total and ordered: same IR in, same stations out, in the same
 * order, with no dependence on object key insertion order.
 */
import type { BranchStation } from '@side-quest/cli-command-facade'
import { type EmitRefusal, emitRefusal } from './emit-contract.ts'
import { BRANCH_FACTS, resolveResultContract } from './emit-derivation.ts'
import type { CommandSurface, SpecificationIr } from './ir.ts'
import { type BranchKind, isWriteImplyingMutation } from './schema.ts'

/**
 * The facade's Branch Station id grammar, restated here so derivation refuses
 * a bad id at emit time rather than publishing one for the facade to reject
 * later. Kept byte-identical to `STATION_ID_PATTERN` in the facade's
 * `station-map.ts`; the alignment is proved by a test, not by trust.
 */
const STATION_ID_PATTERN = /^[a-z][a-z0-9:-]*\.[a-z][a-z0-9_:-]*$/

/**
 * The no-argument behaviors a command can be identified by.
 *
 * The spec requires no-argument behavior to be help, get-started guidance, a
 * read-only dashboard, or a repair path, and never a default write. Bare
 * invocation dispatches to one real declared command, and the facade's third
 * hard invariant requires every station's command to be in discovery, so the
 * station must attach to that command rather than to a pseudo-command.
 *
 * Input Schema v1 does not say which command bare invocation dispatches to.
 * Where the behavior's own name matches a declared command the binding is
 * unambiguous; otherwise emission refuses and asks the owner to admit it.
 */
const NO_ARGUMENT_COMMAND_BY_BEHAVIOR: Readonly<Record<string, string>> = {
	help: 'help',
	read_only_dashboard: 'status',
	read_only_restricted_status_dashboard: 'status',
	repair_path: 'repair',
	get_started_guidance: 'setup',
}

/**
 * One derived Branch Station together with the specification facts that
 * produced it. The facade-shaped `station` is what a consumer publishes; the
 * sibling fields are what the generator-owned semantic expectation table joins
 * on, and deliberately never reach a facade type.
 */
export interface DerivedStation {
	readonly station: BranchStation
	readonly branch: BranchKind
	/** The command's declared mutation from the Command Surface Contract. */
	readonly mutation: string
	/** True for the station derived from `command_surface.no_argument_behavior`. */
	readonly noArgumentBehavior?: string
}

export interface StationEmission {
	readonly stations: readonly DerivedStation[]
	readonly refusals: readonly EmitRefusal[]
}

/**
 * Derives the complete Branch Station set for one compiled specification.
 *
 * Every command reaches success, invalid usage, and refusal. Refusal is not
 * restricted to write-implying commands: a declared blocker can deny authority
 * to a read as easily as to a write, so a read-only command that could never
 * be refused would be an unproved claim rather than a derived one.
 *
 * This is Declared Branch Coverage only: it claims the catalog is complete,
 * never that any station crossed a real public-process seam.
 */
export function deriveStations(ir: SpecificationIr): StationEmission {
	const surface = ir.commandSurface
	const refusals: EmitRefusal[] = []
	const stations: DerivedStation[] = []
	const seen = new Set<string>()

	// Sorted so the emitted order depends on the specification's content, not
	// on the order keys happened to be written into the candidate file.
	for (const command of [...surface.commands].sort()) {
		const mutation = surface.mutations[command] ?? 'read'
		for (const branch of branchesFor(command, surface)) {
			const id = `${command}.${branch}`
			const facts = BRANCH_FACTS[branch]
			const contract = resolveResultContract(command, surface)

			if (seen.has(id)) {
				refusals.push(
					emitRefusal({
						cause: 'emit_station_id_duplicate',
						subject: id,
						message: `Two derived Branch Stations claim the id ${id}.`,
					}),
				)
				continue
			}
			seen.add(id)

			if (!STATION_ID_PATTERN.test(id)) {
				refusals.push(
					emitRefusal({
						cause: 'emit_station_id_invalid',
						subject: id,
						message: `Branch Station id ${id} does not satisfy the facade id grammar.`,
					}),
				)
				continue
			}
			// The `id.split(".")[0] === command` invariant and command membership in
			// discovery are not checked here: `id` is constructed as
			// `${command}.${branch}` from a `command` drawn out of
			// `surface.commands`, so neither can fail. Guarding them anyway would
			// claim a check the derivation makes structurally impossible. The
			// facade re-checks both independently, and a test asserts its drift
			// output is empty, so the invariants stay proved rather than assumed.
			//
			// The exit code is likewise not checked against `surface.exit_codes`
			// here: `BRANCH_FACTS` carries only the three baseline exits, and
			// `deriveCommandContracts` refuses a surface that omits any of them, so
			// a station cannot reach an undeclared exit. The cross-validation is
			// enforced at that one owner rather than restated per station.
			if (contract === undefined) {
				refusals.push(
					emitRefusal({
						cause: 'emit_result_contract_undeclared',
						subject: id,
						message: `Branch Station ${id} has no result contract declared for command ${command}; the candidate declares neither a ${command} binding nor a lifecycle contract.`,
					}),
				)
				continue
			}

			stations.push({
				branch,
				mutation,
				station: {
					id,
					command,
					classification: 'required',
					intent: branch,
					trigger: triggerFor(command, branch, mutation),
					expectedExitCode: facts.exitCode,
					expectedEnvelopeStatus: facts.envelopeStatus,
					expectedResultContractId: contract.id,
					mutationExpectation: mutationExpectationFor(branch, mutation),
					...(facts.errorCode === undefined
						? {}
						: { expectedErrorCode: facts.errorCode }),
				},
			})
		}
	}

	const noArgument = deriveNoArgumentStation(ir)
	if (noArgument.station) stations.push(noArgument.station)
	refusals.push(...noArgument.refusals)

	return { stations, refusals }
}

/**
 * Derives the station proving the admitted no-argument behavior.
 *
 * The station asserts a read-only result: the spec forbids a default write, so
 * the mutation expectation is the proof obligation, not a description.
 */
function deriveNoArgumentStation(ir: SpecificationIr): {
	readonly station?: DerivedStation
	readonly refusals: readonly EmitRefusal[]
} {
	const surface = ir.commandSurface
	const behavior = surface.noArgumentBehavior
	const candidate = NO_ARGUMENT_COMMAND_BY_BEHAVIOR[behavior]
	const command =
		candidate !== undefined && surface.commands.includes(candidate)
			? candidate
			: undefined

	if (command === undefined) {
		return {
			refusals: [
				emitRefusal({
					cause: 'emit_expectation_column_underivable',
					subject: `no_argument_behavior:${behavior}`,
					message: `The candidate declares no_argument_behavior ${behavior} but no declared command owns it, and Input Schema v1 has no binding from bare invocation to a command. Admit which command bare invocation dispatches to.`,
				}),
			],
		}
	}

	const contract = resolveResultContract(command, surface)
	if (contract === undefined) {
		return {
			refusals: [
				emitRefusal({
					cause: 'emit_result_contract_undeclared',
					subject: `${command}.no_argument`,
					message: `The no-argument behavior station on command ${command} has no declared result contract.`,
				}),
			],
		}
	}

	return {
		refusals: [],
		station: {
			branch: 'success',
			mutation: 'read',
			noArgumentBehavior: behavior,
			station: {
				id: `${command}.no_argument`,
				command,
				classification: 'required',
				intent: 'success',
				trigger: `bare invocation performs the admitted read-only ${behavior} and never a default write`,
				expectedExitCode: BRANCH_FACTS.success.exitCode,
				expectedEnvelopeStatus: BRANCH_FACTS.success.envelopeStatus,
				expectedResultContractId: contract.id,
				mutationExpectation: 'read_only_projection',
			},
		},
	}
}

/**
 * The branches one command reaches.
 *
 * Every command reaches success and refusal. A command that accepts any flag
 * can additionally be invoked wrongly and reach invalid usage; a command with
 * no flag surface at all cannot.
 */
function branchesFor(
	command: string,
	surface: CommandSurface,
): readonly BranchKind[] {
	const branches: BranchKind[] = ['success', 'refused']
	const flags = surface.flags[command] ?? []
	if (flags.length > 0 || surface.globalFlags.length > 0) {
		branches.push('invalid_usage')
	}
	return branches.sort()
}

/** A maintainer-readable trigger summary, never setup code. */
function triggerFor(
	command: string,
	branch: BranchKind,
	mutation: string,
): string {
	switch (branch) {
		case 'success':
			return `${command} completes its declared ${mutation} work and returns its result contract`
		case 'invalid_usage':
			return `${command} refuses an unknown flag or operand before reading any state`
		case 'refused':
			return `${command} is refused after reading state because a declared blocker denies its authority`
	}
}

/**
 * The station's mutation stance.
 *
 * A usage failure never reads runtime state, so it cannot have mutated. A
 * success branch on a write-implying command attempts its Declared Side
 * Effect; every other branch projects read-only.
 */
function mutationExpectationFor(branch: BranchKind, mutation: string): string {
	switch (branch) {
		case 'invalid_usage':
			return 'no_runtime_state_read'
		case 'refused':
			return 'refuses_before_mutation'
		case 'success':
			if (isWriteImplyingMutation(mutation)) return `attempts_${mutation}`
			if (mutation === 'preview') return 'preview_only'
			return 'read_only_projection'
	}
}

/**
 * The `STATION_IDS` const tuple contents, canonically sorted.
 *
 * Consumers spread this into `as const satisfies Record<StationId, ...>` to
 * get compile-time scenario exhaustiveness, so the order must be stable.
 */
export function stationIds(
	stations: readonly DerivedStation[],
): readonly string[] {
	return stations.map((derived) => derived.station.id).sort()
}
