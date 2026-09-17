// Checker preparation: plant one binding that is not schema v3 at the documented session address, so the `recover`
// schema row refuses SCHEMA_BINDING_INVALID (exit 4). Directories are created 0700 and the file 0600 exactly as the
// helper would create them; the bytes are a schema-v2 shaped object, never a valid v3 binding. Usage:
//   bun run tests/fixtures/checker/plant-invalid-binding.ts <session-id>

import { writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { prepare, privateDirectories, usage } from "./preparation.ts"

const [session] = process.argv.slice(2)
if (session === undefined) usage("plant-invalid-binding.ts <session-id>")
const { addresses } = prepare()
const path = addresses.binding(session)
privateDirectories(addresses.helper, dirname(addresses.sessions), addresses.sessions)
writeFileSync(path, `${JSON.stringify({ schemaVersion: 2, sessionIdentity: session, taskIdentity: "legacy-task" })}\n`, { mode: 0o600 })
process.stdout.write(`planted ${path}\n`)
