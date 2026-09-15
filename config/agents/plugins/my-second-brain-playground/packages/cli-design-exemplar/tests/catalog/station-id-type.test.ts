import { expect, test } from "bun:test"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { EXPECTED_STATION_COUNT } from "./expected-station-semantics.ts"

// B1 exhaustive identity lock (CDS-BC-1): the finite StationId union derived from the one production declaration
// table must make an unhandled switch arm a compiler error. Same stripped-directive process as tests/c1: the
// fixture compiles complete; one added finite identity without its arm is RED with exactly one TS2322 at the
// recorded line; the restored fixture is the GREEN run. `--pretty false` keeps the `file(line,col)` diagnostic form.

const fixture = join(import.meta.dir, "station-id-type.ts")
const command = ["bunx", "tsc", "--ignoreConfig", "--noEmit", "--pretty", "false", "--strict", "--exactOptionalPropertyTypes", "--noUncheckedIndexedAccess", "--module", "nodenext", "--moduleResolution", "nodenext", "--target", "esnext", "--allowImportingTsExtensions"]
// An undeclared but well-formed identity: widening the union by it must leave the switch non-exhaustive.
const addedIdentity = '["repair-lab.command-discovery","refused","DOMAIN_AUTHORITY_REQUIRED"]'

function compile(path: string): { readonly exitCode: number | null; readonly output: string } {
	const result = Bun.spawnSync([...command, path], { stdout: "pipe", stderr: "pipe" })
	return { exitCode: result.exitCode, output: `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}` }
}

test("finite StationId rejects one added identity without a switch arm and restores green", () => {
	const source = readFileSync(fixture, "utf8")
	expect(source.split("\n").filter((line) => line.startsWith("\t\tcase '[\"repair-lab.")), "one switch arm per expected station").toHaveLength(EXPECTED_STATION_COUNT)
	const temporary = join(import.meta.dir, ".station-id-type-b1.ts")
	const restored = compile(fixture)
	expect(restored.output.split("\n").filter((line) => line.includes("station-id-type.ts(")), "complete StationId switch has no fixture diagnostic").toEqual([])
	const markedMutation = source
		.replace("type CandidateStationId = StationId", `type CandidateStationId = StationId | ${JSON.stringify(addedIdentity)}`)
		.replace("\t\t\tconst impossible: never = stationId", "\t\t\t// @ts-expect-error B1 added finite identity lacks a switch arm\n\t\t\tconst impossible: never = stationId")
	expect(markedMutation).not.toBe(source)
	try {
		writeFileSync(temporary, markedMutation)
		expect(compile(temporary).output.split("\n").filter((line) => line.includes(".station-id-type-b1.ts(")), "marked mutation has no fixture diagnostic").toEqual([])
		const directiveLine = markedMutation.split("\n").findIndex((line) => line.includes("@ts-expect-error B1 "))
		expect(directiveLine).toBeGreaterThanOrEqual(0)
		writeFileSync(temporary, markedMutation.split("\n").filter((_, index) => index !== directiveLine).join("\n"))
		const red = compile(temporary)
		expect(red.exitCode, "stripped mutation fails").not.toBe(0)
		const diagnostics = red.output.split("\n").filter((line) => line.includes(".station-id-type-b1.ts("))
		expect(diagnostics, "one diagnostic identifies the omitted switch arm").toHaveLength(1)
		expect(diagnostics[0]).toContain(`.station-id-type-b1.ts(${directiveLine + 1},`)
		expect(diagnostics[0]).toContain("error TS2322")
	} finally {
		rmSync(temporary, { force: true })
	}
}, 60_000)
