import { randomUUID } from "node:crypto"
import { run } from "./cli.ts"

// The sole production caller of cli.run. runIdentity is generated first (brief 12, 7.2); the process uses
// process.exitCode so a large stdout drains fully through a real pipe (CDS-PE-1).
const runIdentity = `run-${randomUUID()}`
const io = {
	stdout: (text: string) => {
		process.stdout.write(text)
	},
	stderr: (text: string) => {
		process.stderr.write(text)
	},
}
run(process.argv.slice(2), io, process.env, runIdentity, process.cwd()).then(
	(code) => {
		process.exitCode = code
	},
	(error: unknown) => {
		process.stderr.write(`repair-lab: egress invariant: ${error instanceof Error ? error.message : String(error)}\n`)
		process.exitCode = 1
	},
)
