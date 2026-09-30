// Test-only preload: when an argument names busy-grant.json, exhaust this process's file descriptors just before the
// command reads its arguments, so its first grant open meets a real EMFILE from the operating system.
import { openSync } from "node:fs"

if (process.argv.some((argument) => argument.endsWith("/busy-grant.json"))) {
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
