// D6 freshness: evidence older than exactly seven days is stale. The comparison is on elapsed milliseconds, so a
// partial day never rounds back to fresh; a timestamp in the future is invalid evidence, never fresh.
export const FRESHNESS_DAYS = 7
const DAY_MILLISECONDS = 86_400_000
const LIMIT_MILLISECONDS = FRESHNESS_DAYS * DAY_MILLISECONDS

export interface Freshness {
	state: "fresh" | "stale" | "invalid" | "not-observed"
	observedAt: string | null
	/** Whole days elapsed, for people; the state never derives from it. */
	ageDays: number | null
}

export function freshness(observedAt: string | null, now: number): Freshness {
	if (observedAt === null) return { state: "not-observed", observedAt: null, ageDays: null }
	const elapsed = now - Date.parse(observedAt)
	if (Number.isNaN(elapsed) || elapsed < 0) return { state: "invalid", observedAt, ageDays: null }
	return { state: elapsed > LIMIT_MILLISECONDS ? "stale" : "fresh", observedAt, ageDays: Math.floor(elapsed / DAY_MILLISECONDS) }
}
