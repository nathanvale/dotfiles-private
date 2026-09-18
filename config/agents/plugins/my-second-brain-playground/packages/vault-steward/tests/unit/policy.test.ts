import { expect, test } from "bun:test"
import { configuredVaultFrom, fencePath, manifestShapeValid, overlappingPaths, Refusal, samePaths, validateReceiptShape, whitespaceFindings } from "../../src/engine.ts"
import type { Manifest, Receipt } from "../../src/model.ts"

// Pure policy of the shared engine: fencing, the closed config schema, receipt and manifest shapes, whitespace
// finding extraction. Expected reasons and values are literals.

function reasonOf(action: () => unknown): string {
	try {
		action()
	} catch (error) {
		if (error instanceof Refusal) return error.reason
		throw error
	}
	return "no-refusal"
}

test("fencing refuses empty, absolute, root, and escaping paths and admits the rest relative to the vault", () => {
	expect(reasonOf(() => fencePath("/vault", ""))).toBe("path-form-invalid")
	expect(reasonOf(() => fencePath("/vault", "/etc/passwd"))).toBe("path-form-invalid")
	expect(reasonOf(() => fencePath("/vault", "."))).toBe("path-escapes-vault")
	expect(reasonOf(() => fencePath("/vault", ".."))).toBe("path-escapes-vault")
	expect(reasonOf(() => fencePath("/vault", "../outside/note.md"))).toBe("path-escapes-vault")
	expect(reasonOf(() => fencePath("/vault", "notes/../../x"))).toBe("path-escapes-vault")
	expect(fencePath("/vault", "notes/../projects/a.md")).toBe("projects/a.md")
	expect(fencePath("/vault", "./projects/a.md")).toBe("projects/a.md")
})

test("the config schema is closed: exactly schemaVersion 1 and one absolute vault", () => {
	expect(configuredVaultFrom({ schemaVersion: 1, vault: "/vault" })).toBe("/vault")
	expect(configuredVaultFrom({ schemaVersion: 1, vault: "relative" })).toBeNull()
	expect(configuredVaultFrom({ schemaVersion: 2, vault: "/vault" })).toBeNull()
	expect(configuredVaultFrom({ schemaVersion: 1, vault: "/vault", extra: true })).toBeNull()
	expect(configuredVaultFrom({ vault: "/vault" })).toBeNull()
	expect(configuredVaultFrom(["/vault"])).toBeNull()
	expect(configuredVaultFrom(null)).toBeNull()
	expect(configuredVaultFrom("/vault")).toBeNull()
})

const receipt: Receipt = {
	schemaVersion: 1,
	runId: "vnc-00000000000000000000000000000001",
	vault: "/vault",
	worktree: "/state/x/vnc-00000000000000000000000000000001",
	commonGitDirectory: "/vault/.git",
	baseCommit: "a".repeat(40),
	paths: ["a.md", "b/c.md"],
	code: "INTEGRATED",
	commit: "b".repeat(40),
}

test("receipt shape validation is closed over keys, patterns, and sorted unique relative paths", () => {
	expect(() => validateReceiptShape(receipt)).not.toThrow()
	expect(() => validateReceiptShape({ ...receipt, code: "NO_CHANGES" })).toThrow("Invalid receipt")
	const { commit: _commit, ...noChanges } = receipt
	expect(() => validateReceiptShape({ ...noChanges, code: "NO_CHANGES" })).not.toThrow()
	expect(() => validateReceiptShape({ ...receipt, runId: "vnc-short" })).toThrow()
	expect(() => validateReceiptShape({ ...receipt, paths: ["b/c.md", "a.md"] })).toThrow()
	expect(() => validateReceiptShape({ ...receipt, paths: ["a.md", "a.md"] })).toThrow()
	expect(() => validateReceiptShape({ ...receipt, paths: ["../outside"] })).toThrow()
	expect(() => validateReceiptShape({ ...receipt, paths: [] })).toThrow()
	expect(() => validateReceiptShape({ ...receipt, vault: "relative" })).toThrow()
	expect(() => validateReceiptShape({ ...receipt, baseCommit: "zz" })).toThrow()
	expect(() => validateReceiptShape({ ...receipt, code: "DONE" as Receipt["code"] })).toThrow()
})

test("manifest shape validation requires a non-empty, sorted, normalised relative path set", () => {
	const manifest: Manifest = { schemaVersion: 1, runId: receipt.runId, vault: "/vault", worktree: "/w", commonGitDirectory: "/vault/.git", baseCommit: "a".repeat(40), paths: ["a.md", "b/c.md"] }
	expect(manifestShapeValid(manifest, "/w")).toBe(true)
	expect(manifestShapeValid(manifest, "/other")).toBe(false)
	expect(manifestShapeValid({ ...manifest, runId: "x" }, "/w")).toBe(false)
	expect(manifestShapeValid({ ...manifest, schemaVersion: 2 as 1 }, "/w")).toBe(false)
	expect(manifestShapeValid({ ...manifest, paths: "a.md" as unknown as string[] }, "/w")).toBe(false)
	for (const paths of [[], ["a.md", "a.md"], ["b/c.md", "a.md"], ["/outside"], ["../outside"], ["a/../b.md"], ["a/./b.md"], ["a//b.md"], ["a/"]]) {
		expect(manifestShapeValid({ ...manifest, paths }, "/w"), JSON.stringify(paths)).toBe(false)
	}
})

test("path set helpers and whitespace finding extraction", () => {
	expect(samePaths(["a", "b"], ["a", "b"])).toBe(true)
	expect(samePaths(["a"], ["a", "b"])).toBe(false)
	expect(overlappingPaths(["a", "b", "c"], ["c", "a", "z"])).toEqual(["a", "c"])
	expect(whitespaceFindings("products/lamp.md:2: new blank line at EOF.\n+\nnotes.md:7: trailing whitespace.\n+x \n")).toEqual([
		"products/lamp.md:2: new blank line at EOF.",
		"notes.md:7: trailing whitespace.",
	])
	expect(whitespaceFindings("")).toEqual([])
})
