// Shared prelude of the checker preparation fixtures: the state root is selected exactly as production selects it
// (MSB_WORKFLOW_STATE_HOME, XDG_STATE_HOME, $HOME/.local/state), a refused root exits 2 with its reason, and helper
// directories are created 0700 the way the helper creates them.

import { mkdirSync } from "node:fs"
import { productionContext } from "../../../src/adapters/native.ts"
import { stateAddresses } from "../../../src/runtime.ts"

export interface Preparation {
	readonly platform: string
	readonly addresses: ReturnType<typeof stateAddresses>
}

export function prepare(): Preparation {
	const context = productionContext(process.env, process.cwd())
	if (context.stateRoot.status !== "selected") {
		process.stderr.write(`state root refused: ${context.stateRoot.reason}\n`)
		process.exit(2)
	}
	return { platform: context.platform, addresses: stateAddresses(context.stateRoot.path) }
}

export function usage(text: string): never {
	process.stderr.write(`usage: ${text}\n`)
	process.exit(2)
}

export function privateDirectories(...directories: readonly string[]): void {
	for (const directory of directories) mkdirSync(directory, { mode: 0o700, recursive: true })
}
