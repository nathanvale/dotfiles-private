// Test-only preload: the first stdout write marks SOURCE_INTAKE_TEST_READY and is held undelivered while an interval
// keeps the process alive, so a test can signal a run that has not yet emitted any output.
import { writeFileSync } from "node:fs"

const ready = process.env.SOURCE_INTAKE_TEST_READY

if (ready !== undefined) {
	process.stdout.write = (() => {
		writeFileSync(ready, "ready")
		setInterval(() => {}, 1_000)
		return true
	}) as typeof process.stdout.write
}
