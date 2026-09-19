import { afterAll, expect, test } from "bun:test"
import { cleanupFixtures } from "../helpers/harness.ts"
import { runChecker, SKIPPED_ROWS } from "./checker-run.ts"

// The strict 2.0 checker (bin/cli-design-check, successor rows) against the real front door. Every required row plus the
// two optional rows the CLI supports must pass; the two skipped rows are named with reasons in checker-run.ts.

afterAll(cleanupFixtures)

test("every applicable checker row passes and the skipped rows are exactly the two named ones", () => {
	const run = runChecker()
	expect(run.stderr).toBe("")
	expect(run.exitCode).toBe(0)
	const result = run.envelope?.result as Record<string, unknown>
	expect(result.causeCode).toBe("SUCCESS_UNCHANGED")
	const data = result.data as { rows: { scenario: string; findings: string[]; observedExit: number | null }[]; passedCount: number; failedCount: number; skippedRows: string[]; targetUnchanged: boolean }
	expect(data.failedCount).toBe(0)
	expect(data.passedCount).toBe(17)
	expect(data.targetUnchanged).toBe(true)
	expect([...data.skippedRows].sort()).toEqual(Object.keys(SKIPPED_ROWS).sort())
	for (const reason of Object.values(SKIPPED_ROWS)) expect(reason.trim().length).toBeGreaterThan(0)
	const byScenario = new Map(data.rows.map((row) => [row.scenario, row]))
	const expectedExits: Record<string, number | null> = { "help-human": 0, "help-json": 0, "discover-human": 0, "discover-json": 0, "no-arguments-human": 2, "no-arguments-json": 2, "unknown-option-human": 2, "unknown-option-json": 2, "success-human": 0, "success-json": 0, "missing-input-json": 3, "malformed-value-json": 4, "unauthorized-effect": 3, "internal-failure-json": 1, "schema-refusal-json": 4, "transient-refusal-json": 75, "target-unchanged": null }
	expect([...byScenario.keys()].sort()).toEqual(Object.keys(expectedExits).sort())
	for (const [scenario, exit] of Object.entries(expectedExits)) {
		const row = byScenario.get(scenario)
		expect(row?.findings, scenario).toEqual([])
		expect(row?.observedExit ?? null, scenario).toBe(exit)
	}
}, 300_000)
