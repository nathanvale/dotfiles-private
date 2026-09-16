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
// stream callbacks so ordinary output drains before a timed-out diagnostics operation is abandoned (CDS-PE-1/O2).
const runIdentity = `run-${randomUUID()}`
const pendingWrites = new Set<Promise<void>>()
function writeOutput(stream: NodeJS.WriteStream, text: string): void {
	const pending = new Promise<void>((resolve) => { stream.write(text, () => resolve()) })
	pendingWrites.add(pending)
	void pending.finally(() => pendingWrites.delete(pending))
}
async function finishOutput(): Promise<void> {
	while (pendingWrites.size > 0) await Promise.all([...pendingWrites])
}
const io = {
	stdout: (text: string) => {
		if (!terminating) writeOutput(process.stdout, text)
	},
	stderr: (text: string) => {
		if (!terminating) writeOutput(process.stderr, text)
	},
}
const argv = process.argv.slice(2)
run(argv, io, process.env, runIdentity, process.cwd()).then(
	async (code) => {
		// Await actual stream writes, not empty-write callbacks (Bun may complete empty writes early).
		await finishOutput()
		if (!terminating) process.exit(code)
	},
	() => {
		if (!machineMode(argv)) process.stderr.write("repair-lab: internal failure\n")
		process.exitCode = 1
	},
)
