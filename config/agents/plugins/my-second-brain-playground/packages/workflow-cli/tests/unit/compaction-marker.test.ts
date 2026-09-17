import { describe, expect, test } from "bun:test"
import { claimForPrompt, type CompactionMarker, emptyMarker, MarkerSchemaError, parseMarker, recordDelivered, recordGeneration, summarizeMarker } from "../../src/compaction-marker.ts"

// The marker state machine as literals: monotonic generations, claim-all-at-once, delivered after output, and the
// uncertain-to-notice handoff. Expected states are restated here, not derived from the module.

const T1 = "2026-09-17T08:00:00.000Z"
const T2 = "2026-09-17T08:01:00.000Z"
const T3 = "2026-09-17T08:02:00.000Z"

describe("recordGeneration", () => {
	test("mints monotonic generations starting at 1", () => {
		const first = recordGeneration(emptyMarker("s"), T1)
		const second = recordGeneration(first.marker, T2)
		expect([first.generation, second.generation]).toEqual([1, 2])
		expect(second.marker.generations).toEqual([
			{ generation: 1, state: "pending", recordedAt: T1, claimedAt: null, claimedBy: null, settledAt: null },
			{ generation: 2, state: "pending", recordedAt: T2, claimedAt: null, claimedBy: null, settledAt: null },
		])
	})
})

describe("claimForPrompt", () => {
	test("nothing pending is silent", () => {
		expect(claimForPrompt(emptyMarker("s"), "run-1", T1)).toEqual({ kind: "silent" })
	})

	test("every pending generation is claimed at once and recorded delivered together after output", () => {
		const two = recordGeneration(recordGeneration(emptyMarker("s"), T1).marker, T1).marker
		const decision = claimForPrompt(two, "run-1", T2)
		expect(decision.kind).toBe("deliver")
		if (decision.kind !== "deliver") throw new Error("expected deliver")
		expect(decision.claimed).toEqual([1, 2])
		expect(decision.marker.generations.map((generation) => [generation.generation, generation.state, generation.claimedBy])).toEqual([
			[1, "claimed", "run-1"],
			[2, "claimed", "run-1"],
		])
		const delivered = recordDelivered(decision.marker, decision.claimed, T3)
		expect(delivered.generations.map((generation) => [generation.state, generation.settledAt])).toEqual([
			["delivered", T3],
			["delivered", T3],
		])
		expect(claimForPrompt(delivered, "run-2", T3)).toEqual({ kind: "silent" })
		expect(summarizeMarker(delivered)).toEqual({ pending: [], uncertain: [], delivered: 2, notified: 0 })
	})

	test("a claimed generation that was never delivered becomes a notice on the next prompt and settles as notified", () => {
		const one = recordGeneration(emptyMarker("s"), T1).marker
		const claimed = claimForPrompt(one, "run-1", T2)
		if (claimed.kind !== "deliver") throw new Error("expected deliver")
		// The process died between output and the delivery record: the persisted marker still says claimed.
		const pendingToo = recordGeneration(claimed.marker, T2).marker
		expect(summarizeMarker(pendingToo)).toEqual({ pending: [2], uncertain: [1], delivered: 0, notified: 0 })
		const decision = claimForPrompt(pendingToo, "run-2", T3)
		expect(decision.kind).toBe("notice")
		if (decision.kind !== "notice") throw new Error("expected notice")
		expect(decision.uncertain).toEqual([1])
		expect(decision.folded).toEqual([2])
		expect(decision.marker.generations.map((generation) => [generation.generation, generation.state])).toEqual([
			[1, "notified"],
			[2, "notified"],
		])
		expect(claimForPrompt(decision.marker, "run-3", T3)).toEqual({ kind: "silent" })
	})

	test("settled generations are bounded to the newest sixteen while open ones are always kept", () => {
		let marker: CompactionMarker = emptyMarker("s")
		for (let index = 0; index < 20; index += 1) {
			const recorded = recordGeneration(marker, T1)
			const decision = claimForPrompt(recorded.marker, "run", T2)
			if (decision.kind !== "deliver") throw new Error("expected deliver")
			marker = recordDelivered(decision.marker, decision.claimed, T3)
		}
		expect(marker.generations).toHaveLength(16)
		expect(marker.generations[0]?.generation).toBe(5)
		expect(recordGeneration(marker, T1).generation).toBe(21)
	})
})

describe("parseMarker", () => {
	test("round-trips through JSON and refuses another session, unknown fields, unknown states, or non-monotonic generations", () => {
		const marker = recordGeneration(emptyMarker("s"), T1).marker
		expect(parseMarker(JSON.parse(JSON.stringify(marker)), "s")).toEqual(marker)
		expect(() => parseMarker(JSON.parse(JSON.stringify(marker)), "other")).toThrow(MarkerSchemaError)
		expect(() => parseMarker({ ...marker, extra: 1 }, "s")).toThrow(MarkerSchemaError)
		expect(() => parseMarker({ ...marker, generations: [{ ...marker.generations[0], state: "lost" }] }, "s")).toThrow(MarkerSchemaError)
		expect(() => parseMarker({ ...marker, generations: [marker.generations[0], marker.generations[0]] }, "s")).toThrow(MarkerSchemaError)
		expect(() => parseMarker({ ...marker, schemaVersion: 2 }, "s")).toThrow(MarkerSchemaError)
	})
})
