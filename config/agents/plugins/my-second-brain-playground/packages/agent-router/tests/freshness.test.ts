// D6 boundary on the freshness module with a fixed clock: the process tests cannot hold a timestamp at exactly seven
// days, because the child process reads its own clock. card.ts is the production caller of this interface.
import { expect, test } from "bun:test"
import { freshness } from "../src/freshness.ts"

const NOW = Date.parse("2026-09-25T02:00:00.000Z")
const SEVEN_DAYS = 7 * 86_400_000

test("exactly seven days old is fresh", () => {
	expect(freshness(new Date(NOW - SEVEN_DAYS).toISOString(), NOW)).toEqual({ state: "fresh", observedAt: "2026-09-18T02:00:00.000Z", ageDays: 7 })
})

test("seven days and one millisecond old is stale", () => {
	expect(freshness(new Date(NOW - SEVEN_DAYS - 1).toISOString(), NOW)).toEqual({ state: "stale", observedAt: "2026-09-18T01:59:59.999Z", ageDays: 7 })
})

test("a future timestamp is invalid, never fresh", () => {
	expect(freshness("2026-09-25T02:00:00.001Z", NOW)).toEqual({ state: "invalid", observedAt: "2026-09-25T02:00:00.001Z", ageDays: null })
})

test("an unreadable timestamp is invalid and a missing one is not observed", () => {
	expect(freshness("not a date", NOW).state).toBe("invalid")
	expect(freshness(null, NOW)).toEqual({ state: "not-observed", observedAt: null, ageDays: null })
})
