import { randomUUID } from "node:crypto"
import { machineMode, run } from "./cli.ts"
import { finishActiveDiagnostics } from "./diagnostics.ts"

let terminating = false
function terminate(code: number): void {
	if (terminating) process.exit(code)
	terminating = true
	const deadline = setTimeout(() => process.exit(code), 500)
	void finishActiveDiagnostics().finally(() => { clearTimeout(deadline); process.exit(code) })
}
process.on("SIGINT", () => terminate(130))
process.on("SIGTERM", () => terminate(143))

// The sole production caller of cli.run. runIdentity is generated first (brief 12, 7.2); the process uses
// final write callback so large stdout drains before a timed-out diagnostics operation is abandoned (CDS-PE-1/O2).
const runIdentity = `run-${randomUUID()}`
let outputFinished = Promise.resolve()
const io = {
	stdout: (text: string) => {
		if (!terminating) outputFinished = new Promise<void>((resolve) => { process.stdout.write(text, () => resolve()) })
	},
	stderr: (text: string) => {
		if (!terminating) process.stderr.write(text)
	},
}
const argv = process.argv.slice(2)
run(argv, io, process.env, runIdentity, process.cwd()).then(
	async (code) => {
		// Await the actual final write, not an empty-write callback (Bun may complete empty writes early).
		await outputFinished
		if (!terminating) process.exit(code)
	},
	() => {
		if (!machineMode(argv)) process.stderr.write("repair-lab: internal failure\n")
		process.exitCode = 1
	},
)
