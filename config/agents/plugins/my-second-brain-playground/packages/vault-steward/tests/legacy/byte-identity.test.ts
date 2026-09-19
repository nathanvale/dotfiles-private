import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// Independent oracle: sha256 of packages/vault-note-commits/src/main.test.ts recorded before the facade landed
// (shasum -a 256, 2026-09-18). The legacy suite is the alias contract; any edit to it must change this literal on purpose.
const legacySuiteSha256 = "6edfc37e87809bb60c1c51ab05e219fd6b4cc5c2c25a594c32ca2576eab07bf0"
const legacySuite = resolve(import.meta.dir, "../../../vault-note-commits/src/main.test.ts")

test("the legacy vault-note-commits suite stays byte-identical", () => {
	expect(createHash("sha256").update(readFileSync(legacySuite)).digest("hex")).toBe(legacySuiteSha256)
})

test("the alias package entry is the one-line re-export of the legacy front door", () => {
	const entry = readFileSync(resolve(import.meta.dir, "../../../vault-note-commits/src/main.ts"), "utf8")
	const code = entry.split("\n").filter((line) => line && !line.startsWith("//"))
	expect(code).toEqual(['import "../../vault-steward/src/legacy/main.ts"'])
})
