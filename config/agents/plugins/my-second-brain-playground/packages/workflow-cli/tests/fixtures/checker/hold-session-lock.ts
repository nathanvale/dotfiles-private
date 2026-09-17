// Checker preparation: hold one session lock through the helper's own Lock Adapter until this process is killed, so
// the `bind` row refuses UNAVAILABLE_STORAGE_BUSY after the 2,000 ms bounded wait. Usage:
//   bun run tests/fixtures/checker/hold-session-lock.ts <session-id> [--workspace <absolute-path>]
// With --workspace the workspace lock is held instead, which proves the workspace-before-session order from outside.
// Prints one `held <lock-path>` line once the lock is taken; the caller waits for that line, never for a sleep.

import { dirname } from "node:path"
import { lockAdapterFor } from "../../../src/lock-adapter.ts"
import { prepare, privateDirectories, usage } from "./preparation.ts"

const [session, flag, workspace] = process.argv.slice(2)
if (session === undefined || (flag !== undefined && (flag !== "--workspace" || workspace === undefined))) usage("hold-session-lock.ts <session-id> [--workspace <absolute-path>]")
const { platform, addresses } = prepare()
const lockPath = workspace === undefined ? addresses.sessionLock(session) : addresses.workspaceLock(workspace)
privateDirectories(addresses.helper, dirname(dirname(lockPath)), dirname(lockPath))
await lockAdapterFor(platform).withExclusive(lockPath, () => {
	process.stdout.write(`held ${lockPath}\n`)
	return new Promise<never>(() => undefined)
})
