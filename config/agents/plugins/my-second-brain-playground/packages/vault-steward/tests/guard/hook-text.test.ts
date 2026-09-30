import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { HOOK_TEXT } from "./hook-text.ts"

// Independent oracle: the digest the Stage Manager accepted for unit0/hook-final.sh (shasum -a 256), restated here.
const acceptedDigest = "c77100a5ae6f452d21ebac044d875f6e30868259d0b3b23abd2681b1646402fc"

test("the embedded hook text hashes to the accepted Unit 0 digest", () => {
	expect(createHash("sha256").update(HOOK_TEXT).digest("hex")).toBe(acceptedDigest)
})
