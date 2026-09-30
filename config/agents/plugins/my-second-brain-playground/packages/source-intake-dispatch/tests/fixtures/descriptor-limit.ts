// Test-only preload: with SOURCE_INTAKE_TEST_EXHAUST_DESCRIPTORS set, exhaust this process's file descriptors just
// before the command reads its arguments, so its first open meets a real EMFILE from the operating system.
import { openSync } from "node:fs"

if (process.env.SOURCE_INTAKE_TEST_EXHAUST_DESCRIPTORS !== undefined) {
	const argv = process.argv
	const slice = argv.slice.bind(argv)
	argv.slice = ((...range: Parameters<typeof argv.slice>) => {
		const held: number[] = []
		try {
			for (;;) held.push(openSync("/dev/null", "r"))
		} catch {
			// The descriptor limit is reached; keep every descriptor open for the rest of the run.
		}
		return slice(...range)
	}) as typeof argv.slice
}
