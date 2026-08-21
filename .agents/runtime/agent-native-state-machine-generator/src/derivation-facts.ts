/**
 * Shared derivation facts.
 *
 * One owner for each fact both the Branch Station side and the Command Surface
 * Contract side need. Two copies would let the two sides disagree, which is
 * precisely the drift this generator exists to make impossible.
 */
import type { CommandSurface, SpecificationIr } from './ir.ts'
import type { BranchKind, RetryPosture } from './schema.ts'

/**
 * Per-branch facts, in one table.
 *
 * Every column a branch decides lives on one row, so adding a branch forces a
 * decision about its exit code, envelope status, error code and Projection
 * Completeness together rather than scattering them across switches that can
 * drift apart.
 *
 * `projectionCompleteness` follows the spec: a usage failure never reached
 * runtime state, so no observation backs it and its projection is incomplete.
 */
export const BRANCH_FACTS: Readonly<
	Record<
		BranchKind,
		{
			readonly exitCode: number
			readonly envelopeStatus: 'ok' | 'error'
			readonly errorCode?: string
			readonly projectionCompleteness: 'complete' | 'incomplete'
			readonly state: string
			readonly authority: 'granted' | 'denied'
		}
	>
> = {
	success: {
		exitCode: 0,
		envelopeStatus: 'ok',
		projectionCompleteness: 'complete',
		state: 'observed_success',
		authority: 'granted',
	},
	refused: {
		exitCode: 1,
		envelopeStatus: 'error',
		projectionCompleteness: 'complete',
		state: 'blocked',
		authority: 'denied',
	},
	invalid_usage: {
		exitCode: 2,
		envelopeStatus: 'error',
		errorCode: 'invalid_usage',
		projectionCompleteness: 'incomplete',
		state: 'input_refused',
		authority: 'denied',
	},
}

/**
 * The result contract a command's branches carry.
 *
 * Bindings come from the declared surface first: an exact command key, then a
 * declared role key. Only when neither exists does the `lifecycle` convention
 * apply, and that convention is named in the rendered module header and
 * recorded for stage-5 admission rather than left implicit.
 *
 * Returns undefined when the surface declares nothing usable, so the caller
 * refuses instead of inventing a contract id.
 */
export function resolveResultContract(
	command: string,
	surface: CommandSurface,
): { readonly id: string; readonly version: number } | undefined {
	const contracts = surface.resultContracts
	return contracts[command] ?? contracts.lifecycle
}

/** True when the surface bound this command's contract by convention. */
export function usesLifecycleConvention(
	command: string,
	surface: CommandSurface,
): boolean {
	return (
		surface.resultContracts[command] === undefined &&
		surface.resultContracts.lifecycle !== undefined
	)
}

/**
 * Facts a retry rule may branch on for one Branch Station.
 *
 * Only the columns a station can supply are populated. A rule keyed on a fact
 * the station has no value for cannot match, which is what keeps resolution
 * from guessing.
 */
export interface RetryFacts {
	readonly command: string
	readonly resultKind: string
	readonly blocker?: string
	readonly state?: string
}

/**
 * Resolves Exact Same-Input Retry Safety through the candidate's own ordered
 * rule table, first match wins.
 *
 * The posture is never derived from exit status, absent output or prose. When
 * no declared rule matches, the caller is told so and refuses the row rather
 * than falling back to a default that would masquerade as an admitted meaning.
 */
export function resolveRetryPosture(
	ir: SpecificationIr,
	facts: RetryFacts,
): RetryPosture | undefined {
	for (const rule of ir.retryPosture.rules) {
		if (matchesRule(rule.when, facts)) return rule.then
	}
	return undefined
}

function matchesRule(
	when: Readonly<Record<string, string | readonly string[]>>,
	facts: RetryFacts,
): boolean {
	// Every declared condition must hold. A condition naming a fact the station
	// cannot supply fails the rule rather than being skipped, so a rule never
	// matches more broadly than it was written.
	for (const [key, value] of Object.entries(when)) {
		switch (key) {
			case 'command':
				if (value !== facts.command) return false
				break
			case 'result_kind':
				if (value !== facts.resultKind && value !== 'any_other') return false
				break
			case 'blocker':
				if (facts.blocker === undefined || value !== facts.blocker) return false
				break
			case 'state_in':
				if (
					facts.state === undefined ||
					!Array.isArray(value) ||
					!value.includes(facts.state)
				) {
					return false
				}
				break
			default:
				// A condition on a fact no Branch Station carries (an activation
				// cause, a doctor task terminal) cannot be evaluated here, so the
				// rule does not match this station.
				return false
		}
	}
	return true
}

export function pascal(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1)
}

export function camel(product: string): string {
	const [first, ...rest] = product.split(/[-_]/)
	return [first ?? product, ...rest.map(pascal)].join('')
}

export function screaming(product: string): string {
	return product.replace(/-/g, '_').toUpperCase()
}
