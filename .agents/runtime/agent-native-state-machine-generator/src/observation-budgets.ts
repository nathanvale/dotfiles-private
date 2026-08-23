/**
 * Observation Expiry: what a declared wait bound means.
 *
 * The bound is the candidate's; its meaning is ADR 0002's and lives here.
 * The expiry anchors to one Attempt, a new Attempt gets a fresh bound, and
 * neither polling nor a heartbeat renews one. A candidate declares how long,
 * never what renews it, so no product can turn a heartbeat into a renewal by
 * declaring it that way.
 *
 * Evidence never renews Authority, and this is the same rule at the
 * observation level: a Liveness Evidence Provider's heartbeat says work is
 * advancing, not that the observation window reopened.
 */
import type { ObservationBudget } from './ir.ts'

/**
 * What happened since one Attempt's observation window opened.
 *
 * `elapsedMs` is measured from the window of the Attempt being asked about,
 * and binding it to the right Attempt is the caller's job. Nothing here
 * verifies that: the compiled specification carries no Attempt identity, so
 * evidence mislabelled as belonging to another Attempt is not detected. That
 * refusal needs an input the generator does not have and is not claimed.
 */
export interface ObservationProgress {
	/** Milliseconds since this Attempt's window opened. */
	readonly elapsedMs: number
	/**
	 * Whether a heartbeat arrived inside the window. Carried so the
	 * never-renews rule is exercised rather than assumed: it changes no
	 * result here, and a caller that expected it to is reading the wrong
	 * contract.
	 */
	readonly heartbeatObserved: boolean
	/** How many times the caller polled inside the window. */
	readonly pollCount: number
}

/**
 * Whether this Attempt's observation still supports a safe State Projection.
 *
 * Expiry depends only on elapsed time against the declared bound.
 * `heartbeatObserved` and `pollCount` are deliberately unread: the rule is
 * that neither renews the window, and taking them as inputs and ignoring
 * them is what lets a test prove it.
 */
export function isObservationExpired(
	budget: ObservationBudget,
	progress: ObservationProgress,
): boolean {
	return progress.elapsedMs >= budget.attemptExpiryMs
}

/**
 * The window any Attempt observes under.
 *
 * Always the declared budget, never what remained of an earlier Attempt's:
 * that is what "a new Attempt gets a fresh bound" means, and it holds because
 * the window is a function of the budget alone.
 */
export function attemptWindowMs(budget: ObservationBudget): number {
	return budget.attemptExpiryMs
}

/**
 * Whether observing again is useful yet.
 *
 * Separate from expiry: a caller that polls sooner than the declared
 * poll-after learns nothing new, and one that polls after expiry learns
 * nothing safe.
 */
export function isPollUseful(
	budget: ObservationBudget,
	progress: ObservationProgress,
): boolean {
	if (isObservationExpired(budget, progress)) return false
	return progress.elapsedMs >= budget.pollAfterMs
}
