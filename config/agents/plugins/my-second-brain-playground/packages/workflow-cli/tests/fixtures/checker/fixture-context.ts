// Shim-lane composition: production composition with the Beads pin taken from the executable each scenario names
// (the fixture bd, or a per-root wrapper around it), because the shim lane exercises everything except the accepted
// production pin. The pin itself is proven by tests/unit/beads.test.ts, by the production entry refusing the fixture
// bd in tests/integration/msb-workflow.test.ts, and by the native-storage suite against the pinned executable.

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { type BeadsPin, createBeadsReader } from "../../../src/adapters/beads.ts"
import { type CompositionOptions, productionContext } from "../../../src/adapters/native.ts"
import type { CommandContext } from "../../../src/commands/shared.ts"

/** The named executable pinned to its own bytes; an unreadable file pins to no digest and the Adapter refuses it. */
function selfPin(executable: string): BeadsPin {
	try {
		return { executable, sha256: createHash("sha256").update(readFileSync(executable)).digest("hex") }
	} catch {
		return { executable, sha256: "" }
	}
}

export function fixtureContext(options: CompositionOptions = {}): CommandContext {
	const context = productionContext(process.env, process.cwd(), options)
	return { ...context, openBeads: (executable, workspace, cwd) => createBeadsReader({ executable, workspace, cwd, pin: selfPin(executable) }) }
}
