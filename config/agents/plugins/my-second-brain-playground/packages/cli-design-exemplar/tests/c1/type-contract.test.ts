import { expect, test } from "bun:test"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const fixture = join(import.meta.dir, "type-contract.ts")
const command = ["bunx", "tsc", "--ignoreConfig", "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--noUncheckedIndexedAccess", "--module", "nodenext", "--moduleResolution", "nodenext", "--target", "esnext", "--allowImportingTsExtensions"]
const locks = [
	["N1", "TS2322"], ["N2", "TS2322"], ["N3", "TS2322"], ["N4", "TS2322"], ["N5", "TS2322"], ["N6", "TS2375"], ["N7", "TS2322"], ["N8", "TS2322"], ["N9", "TS2322"], ["N10", "TS2540"],
	["M1", "TS2322"], ["M2", "TS2322"], ["M3", "TS2322"], ["R1", "TS2322"], ["R2", "TS2322"], ["R3", "TS2322"], ["R4", "TS2322"],
] as const

test("C1 compiler locks have 17 independent stripped-directive diagnostics", () => {
	const source = readFileSync(fixture, "utf8")
	for (const [lock, code] of locks) {
		const lines = source.split("\n")
		const directive = lines.findIndex((line) => line.includes(`@ts-expect-error ${lock} `))
		expect(directive, `${lock} directive`).toBeGreaterThanOrEqual(0)
		const temporary = join(import.meta.dir, `.type-contract-${lock}.ts`)
			const specimen = lines[directive + 1] ?? ""
			expect(specimen, `${lock} specimen`).not.toContain("message:")
			writeFileSync(temporary, lines.filter((_, index) => index !== directive).join("\n"))
		try {
			const result = Bun.spawnSync([...command, temporary], { stdout: "pipe", stderr: "pipe" })
			const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`
			expect(result.exitCode, `${lock} compiler exit`).not.toBe(0)
				expect(output).toContain(code)
				expect(output).toContain(`.type-contract-${lock}.ts(${directive + 1},`)
				const diagnosticLines = output.split("\n").filter((line) => line.includes(`.type-contract-${lock}.ts(${directive + 1},`))
				expect(diagnosticLines, `${lock} has one isolated diagnostic at its declaration`).toHaveLength(1)
		} finally {
			rmSync(temporary, { force: true })
		}
	}
}, 30_000)
