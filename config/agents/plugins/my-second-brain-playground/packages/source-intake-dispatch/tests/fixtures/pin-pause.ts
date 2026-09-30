// Test-only preload: with SOURCE_INTAKE_TEST_PAUSE_MARKER set, the first process.cwd() call after process.chdir writes
// the marker and pauses for 300 ms before it returns, so a test can change the configured tree after the item
// directory is pinned and before the receipt is opened. It changes timing only.
import { writeFileSync } from "node:fs"

const marker = process.env.SOURCE_INTAKE_TEST_PAUSE_MARKER

if (marker !== undefined) {
	const chdir = process.chdir.bind(process)
	const cwd = process.cwd.bind(process)
	let pinned = false
	process.chdir = (directory: string) => {
		chdir(directory)
		pinned = true
	}
	process.cwd = () => {
		const current = cwd()
		if (pinned) {
			pinned = false
			writeFileSync(marker, "pinned")
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
		}
		return current
	}
}
