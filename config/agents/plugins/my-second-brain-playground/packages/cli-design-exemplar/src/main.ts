import { randomUUID } from "node:crypto"
import { machineMode, run } from "./cli.ts"
import { attemptEmergencyDiagnostics, finishActiveDiagnostics } from "./diagnostics.ts"
import { createProcessLifecycle } from "./process-lifecycle.ts"

// The sole production caller of cli.run. runIdentity is generated first (brief 12, 7.2); the process uses
// final write callback so large stdout drains before a timed-out diagnostics operation is abandoned (CDS-PE-1/O2).
const runIdentity = `run-${randomUUID()}`
const argv = process.argv.slice(2)
const lifecycle = createProcessLifecycle({
	writeStdout: (text, callback) => { process.stdout.write(text, callback) },
	writeStderr: (text) => { process.stderr.write(text) },
	finishDiagnostics: finishActiveDiagnostics,
	attemptEmergencyDiagnostics,
	setExitCode: (code) => { process.exitCode = code },
	exit: (code) => { process.exit(code) },
	setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
	unrefTimer: (handle) => { (handle as ReturnType<typeof setTimeout>).unref() },
	clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
})
process.stdout.on("error", (error) => { lifecycle.outputError(error) })
process.on("SIGINT", () => lifecycle.terminate(130))
process.on("SIGTERM", () => lifecycle.terminate(143))
process.on("uncaughtException", () => lifecycle.crash())
process.on("unhandledRejection", () => lifecycle.crash())
const io = { stdout: lifecycle.stdout, stderr: lifecycle.stderr }
run(argv, io, process.env, runIdentity, process.cwd()).then(
	(code) => lifecycle.complete(code),
	() => {
		if (!machineMode(argv)) lifecycle.stderr("repair-lab: internal failure\n")
		lifecycle.crash()
	},
)
