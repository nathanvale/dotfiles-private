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

/**
 * The evidence the facade's `retryable` boolean requires.
 *
 * One field per conjunct ADR 0006 rules, all required: an optional field
 * would let missing evidence read as satisfied, which is the fail-open this
 * predicate exists to prevent. Every field is a generator-internal fact
 * derived from the compiled specification; none of it widens the input
 * schema, because `retryable` is a projection out to a consumer rather than
 * something a product declares.
 */
export interface RetryableEvidence {
	/** Exact Same-Input Retry Safety for this result. */
	readonly posture: RetryPosture
	/** Whether the State Projection is complete enough to be acted on. */
	readonly projectionCompleteness: 'complete' | 'incomplete'
	/** The canonical Next Safe Action is this exact same public invocation. */
	readonly sameInvocationAsNextSafeAction: boolean
	/** The normalized input a repeat would carry is unchanged. */
	readonly normalizedInputUnchanged: boolean
	/** The Logical Operation identity a repeat would carry is unchanged. */
	readonly logicalOperationUnchanged: boolean
	/**
	 * Nothing must happen first: no human handoff, no further input, no
	 * repair, no waiting, no other declared prerequisite.
	 */
	readonly noPrerequisite: boolean
}

/**
 * The facade's `retryable` boolean.
 *
 * True only for an immediately useful identical safe invocation (ADR 0006),
 * which is the conjunction of every field above. Exact Same-Input Retry
 * Safety alone is not enough: a `same_input_safe` result whose next action is
 * a different command, or which needs input first, or whose repeat would
 * carry a new Logical Operation, is safe to repeat and useless to repeat.
 * Mapping every safe posture to true is the alternative the ruling rejected.
 *
 * Fixed by ruling, so it is generator-owned rather than declared: a candidate
 * able to state this mapping could state `operator_required` as retryable.
 *
 * One way only. Nothing reads `retryable` back as evidence about retry
 * safety, posture, or Projection Completeness: it is a projection out to a
 * consumer, and Exact Same-Input Retry Safety remains what decides.
 */
export function projectRetryable(evidence: RetryableEvidence): boolean {
	if (evidence.projectionCompleteness !== 'complete') return false
	if (!evidence.sameInvocationAsNextSafeAction) return false
	if (!evidence.normalizedInputUnchanged) return false
	if (!evidence.logicalOperationUnchanged) return false
	if (!evidence.noPrerequisite) return false

	switch (evidence.posture) {
		case 'same_input_safe':
			return true
		case 'same_input_unsafe':
		case 'operator_required':
			return false
		default: {
			const exhausted: never = evidence.posture
			return exhausted
		}
	}
}
