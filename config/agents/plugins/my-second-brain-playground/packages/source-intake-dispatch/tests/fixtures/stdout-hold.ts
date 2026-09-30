// Test-only preload: only the first stdout write is held undelivered. It marks SOURCE_INTAKE_TEST_READY, keeps the
// process alive, and restores the original write, so a test can signal a run that has emitted no output yet and still
// observe any later write, such as a signal handler's replacement result.
import { writeFileSync } from "node:fs"

const ready = process.env.SOURCE_INTAKE_TEST_READY

if (ready !== undefined) {
	const write = process.stdout.write
	process.stdout.write = (() => {
		process.stdout.write = write
		writeFileSync(ready, "ready")
		setInterval(() => {}, 1_000)
		return true
	}) as typeof process.stdout.write
}
