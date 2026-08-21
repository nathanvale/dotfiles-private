/**
 * Branch Station derivation.
 *
 * Input Schema v1 has no Branch Station section, and that is the point: a
 * Branch Station is not an independently authored fact that could disagree
 * with the command surface. Every station here is derived from the one
 * Admitted State-Machine Specification, so the cross-validations the facade
 * declares but never delivers — a station expecting an exit code its command
 * never declares, or a result contract id mismatching the command's
 * declaration — cannot be expressed rather than merely being caught.
 *
 * Derivation is total and ordered: same IR in, same stations out, in the same
 * order, with no dependence on object key insertion order.
 */
import type { BranchStation } from '@side-quest/cli-command-facade'
import { type EmitRefusal, emitRefusal } from './emit-contract.ts'
import type { CommandSurface, SpecificationIr } from './ir.ts'

/**
 * The facade's Branch Station id grammar, restated here so derivation refuses
 * a bad id at emit time rather than publishing one for the facade to reject
 * later. Kept byte-identical to `STATION_ID_PATTERN` in the facade's
 * `station-map.ts`; the alignment is proved by a test, not by trust.
 */
const STATION_ID_PATTERN = /^[a-z][a-z0-9:-]*\.[a-z][a-z0-9_:-]*$/

/**
 * Mutation values that imply a write. Derived from the two spike candidates'
 * `command_surface.mutations` vocabulary. A command whose mutation appears
 * here owes the facade's Write Preview Capability obligation.
 */
const WRITE_IMPLYING_MUTATIONS = new Set([
	'remote_write',
	'local_write',
	'recovery',
])

/** The branch every command reaches when its input parses and its work reads. */
const SUCCESS_BRANCH = 'success'
/** The branch a command reaches when the parser refuses before any state read. */
const USAGE_BRANCH = 'invalid_usage'
/** The branch a command reaches when it is blocked or refuses after reading. */
const REFUSAL_BRANCH = 'refused'

/**
 * The three baseline exit meanings, keyed by branch. The spec fixes success,
 * refusal-or-runtime-failure, and invalid usage as the baseline; a candidate
 * names them in `command_surface.exit_codes` but cannot renumber them.
 */
const BRANCH_EXIT_CODES: Readonly<Record<string, number>> = {
	[SUCCESS_BRANCH]: 0,
	[REFUSAL_BRANCH]: 1,
	[USAGE_BRANCH]: 2,
}

/**
 * One derived Branch Station together with the specification facts that
 * produced it. The facade-shaped `station` is what a consumer publishes; the
 * sibling fields are what the generator-owned semantic expectation table joins
 * on, and deliberately never reach a facade type.
 */
export interface DerivedStation {
	readonly station: BranchStation
	/** The branch identity within the command, e.g. `success`. */
	readonly branch: string
	/** The command's declared mutation from the Command Surface Contract. */
	readonly mutation: string
}

export interface StationEmission {
	readonly stations: readonly DerivedStation[]
	readonly refusals: readonly EmitRefusal[]
}

/**
 * Derives the complete Branch Station set for one compiled specification.
 *
 * Every command in discovery contributes a success station. A command whose
 * declared flags admit operand or flag error contributes a usage station, and
 * a command that can be refused after reading state contributes a refusal
 * station. This is Declared Branch Coverage only: it claims the catalog is
 * complete, never that any station crossed a real public-process seam.
 */
export function deriveStations(ir: SpecificationIr): StationEmission {
	const surface = ir.commandSurface
	const refusals: EmitRefusal[] = []
	const stations: DerivedStation[] = []
	const seen = new Set<string>()
	const declaredExits = declaredExitCodes(surface)

	// Sorted so the emitted order depends on the specification's content, not
	// on the order keys happened to be written into the candidate file.
	for (const command of [...surface.commands].sort()) {
		const mutation = surface.mutations[command] ?? 'read'
		for (const branch of branchesFor(command, surface)) {
			const id = `${command}.${branch}`
			const exitCode = BRANCH_EXIT_CODES[branch] ?? 1
			const resultContractId = resultContractFor(command, surface)

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
			if (!declaredExits.has(exitCode)) {
				refusals.push(
					emitRefusal({
						cause: 'emit_station_exit_code_undeclared',
						subject: `${id}:${exitCode}`,
						message: `Branch Station ${id} expects exit code ${exitCode}, which command ${command} never declares.`,
					}),
				)
				continue
			}
			if (resultContractId === undefined) {
				refusals.push(
					emitRefusal({
						cause: 'emit_station_result_contract_mismatch',
						subject: id,
						message: `Branch Station ${id} has no result contract declared for command ${command}.`,
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
					intent: branch === SUCCESS_BRANCH ? 'success' : branch,
					trigger: triggerFor(command, branch, mutation),
					expectedExitCode: exitCode,
					expectedEnvelopeStatus: exitCode === 0 ? 'ok' : 'error',
					expectedResultContractId: resultContractId,
					mutationExpectation: mutationExpectationFor(branch, mutation),
					...(branch === USAGE_BRANCH
						? { expectedErrorCode: 'invalid_usage' }
						: {}),
				},
			})
		}
	}

	return { stations, refusals }
}

/**
 * The exit codes a specification actually declares, as numbers.
 *
 * `command_surface.exit_codes` is keyed by the decimal exit string, so a key
 * that is not a base-10 integer is not a declared exit and must not silently
 * widen the set a station may expect.
 */
function declaredExitCodes(surface: CommandSurface): ReadonlySet<number> {
	const codes = new Set<number>()
	for (const key of Object.keys(surface.exitCodes)) {
		if (/^\d+$/.test(key)) codes.add(Number.parseInt(key, 10))
	}
	return codes
}

/**
 * The branches one command reaches.
 *
 * Every command reaches success. A command that accepts any flag can be
 * invoked wrongly, so it reaches invalid usage. A command whose mutation
 * implies a write can be refused after reading state — a read-only command
 * cannot, because there is no authority for it to be denied.
 */
function branchesFor(
	command: string,
	surface: CommandSurface,
): readonly string[] {
	const branches = [SUCCESS_BRANCH]
	const flags = surface.flags[command] ?? []
	if (flags.length > 0 || surface.globalFlags.length > 0) {
		branches.push(USAGE_BRANCH)
	}
	if (WRITE_IMPLYING_MUTATIONS.has(surface.mutations[command] ?? 'read')) {
		branches.push(REFUSAL_BRANCH)
	}
	return branches
}

/**
 * The result contract id a command's branches carry.
 *
 * A candidate keys `result_contracts` by role. `discovery` belongs to the
 * command that projects the command surface; `activation` to the activation
 * command; everything else carries the product's lifecycle contract. Selecting
 * here rather than at each station is what makes the station-to-contract
 * agreement structural.
 */
function resultContractFor(
	command: string,
	surface: CommandSurface,
): string | undefined {
	const contracts = surface.resultContracts
	const byRole = contracts[command] ?? contracts[roleFor(command)]
	return (byRole ?? contracts.lifecycle)?.id
}

function roleFor(command: string): string {
	if (command === 'commands') return 'discovery'
	return command
}

/** A maintainer-readable trigger summary, never setup code. */
function triggerFor(command: string, branch: string, mutation: string): string {
	switch (branch) {
		case SUCCESS_BRANCH:
			return `${command} completes its declared ${mutation} work and returns its result contract`
		case USAGE_BRANCH:
			return `${command} refuses an unknown flag or operand before reading any state`
		default:
			return `${command} is refused after reading state because its declared authority is denied`
	}
}

/**
 * The station's mutation stance.
 *
 * A usage failure never reads runtime state, so it cannot have mutated. A
 * success branch on a write-implying command attempts its Declared Side
 * Effect; every other branch projects read-only.
 */
function mutationExpectationFor(branch: string, mutation: string): string {
	if (branch === USAGE_BRANCH) return 'no_runtime_state_read'
	if (branch === REFUSAL_BRANCH) return 'refuses_before_mutation'
	if (WRITE_IMPLYING_MUTATIONS.has(mutation)) return `attempts_${mutation}`
	if (mutation === 'preview') return 'preview_only'
	return 'read_only_projection'
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
