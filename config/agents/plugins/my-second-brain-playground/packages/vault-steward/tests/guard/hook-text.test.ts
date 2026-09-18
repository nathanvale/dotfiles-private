import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { HOOK_SHA256, HOOK_TEXT } from "./hook-text.ts"

// Independent oracle: the digest the Stage Manager accepted for unit0/hook-final.sh (shasum -a 256), restated here.
const acceptedDigest = "80d081bad079dbede935c785c0f5d2e4772736a22674df475386263b40e31e13"

test("the embedded hook text hashes to the accepted Unit 0 digest", () => {
	expect(HOOK_SHA256).toBe(acceptedDigest)
	expect(createHash("sha256").update(HOOK_TEXT).digest("hex")).toBe(acceptedDigest)
})

test("the embedded hook is the main-only gate in its final fail-open form", () => {
	expect(HOOK_TEXT.startsWith("#!/bin/sh\n")).toBe(true)
	expect(HOOK_TEXT.endsWith("exit 0\n")).toBe(true)
	expect(HOOK_TEXT).toContain("VAULT_GUARD_BRANCH_CREATE_DENIED %s")
	expect(HOOK_TEXT).toContain("VAULT_GUARD_FAIL_OPEN git not found on PATH")
	expect(HOOK_TEXT).toContain("VAULT_GUARD_FAIL_OPEN git rev-parse failed for %s")
})
