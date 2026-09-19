// The sole production entry of the Vault Steward CLI 2.0 front door: generate the process run identity, wire the
// lifecycle (drain, EPIPE, signals, crash), run, and complete through the lifecycle so output drains before exit.
import { randomUUID } from "node:crypto"
import { machineMode, run } from "./cli.ts"
import { attemptEmergencyDiagnostics, finishActiveDiagnostics, writeBytesSync } from "./diagnostics.ts"
import { systemProcessLifecycle } from "./process-lifecycle.ts"

const runId = `run-${randomUUID()}`
const argv = process.argv.slice(2)
const lifecycle = systemProcessLifecycle(attemptEmergencyDiagnostics, finishActiveDiagnostics)
const io = { stdout: lifecycle.stdout, stderr: lifecycle.stderr }
// Faults (VAULT_STEWARD_FAULT) are honoured only from source; the bundle under runtime/ ignores them.
const faultsAllowed = import.meta.url.endsWith("/src/main.ts")
run(argv, io, process.env, runId, { faultsAllowed }).then(
	(code) => lifecycle.complete(code),
	() => {
		if (!machineMode(argv)) writeBytesSync(2, Buffer.from("vault-steward: internal failure\n"))
		lifecycle.crash()
	},
)
