// Git Adapter: read-only. `bind` derives sourceRepository from the top level of its working directory; nothing else
// is read from Git.

import { realpathSync } from "node:fs"
import { runBounded } from "./native-process.ts"

/** The canonical Git top level of `cwd`, or null when `cwd` is not inside a Git working directory. */
export async function gitTopLevel(cwd: string): Promise<string | null> {
	const result = await runBounded(["git", "-C", cwd, "rev-parse", "--show-toplevel"])
	if (result.status !== "exited" || result.exit !== 0) return null
	const top = result.stdout.trim()
	if (top.length === 0) return null
	try {
		return realpathSync(top)
	} catch {
		return null
	}
}
