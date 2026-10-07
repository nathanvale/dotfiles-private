// Test-only preload: with SOURCE_INTAKE_TEST_EXHAUST_DESCRIPTORS set, exhaust this process's file descriptors just
// before the command reads its arguments, so its first open meets a real EMFILE from the operating system.
// On macOS it first lowers the soft descriptor limit, because Bun raises it to the per-process cap (about 92,000);
// filling that many costs the kernel close to a second per process and drains the system-wide file table that
// concurrent tests share.
import { dlopen, FFIType, ptr } from "bun:ffi"
import { openSync } from "node:fs"

const SOFT_DESCRIPTOR_LIMIT = 256n

function lowerSoftDescriptorLimit(): void {
	if (process.platform !== "darwin") return
	const RLIMIT_NOFILE = 8
	const libc = dlopen("/usr/lib/libSystem.B.dylib", {
		getrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
		setrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
	})
	const limit = new BigUint64Array(2)
	if (libc.symbols.getrlimit(RLIMIT_NOFILE, ptr(limit)) !== 0) throw new Error("getrlimit(RLIMIT_NOFILE) failed")
	if ((limit[0] ?? 0n) <= SOFT_DESCRIPTOR_LIMIT) return
	limit[0] = SOFT_DESCRIPTOR_LIMIT
	if (libc.symbols.setrlimit(RLIMIT_NOFILE, ptr(limit)) !== 0) throw new Error("setrlimit(RLIMIT_NOFILE) failed")
}

if (process.env.SOURCE_INTAKE_TEST_EXHAUST_DESCRIPTORS !== undefined) {
	const argv = process.argv
	const slice = argv.slice.bind(argv)
	argv.slice = ((...range: Parameters<typeof argv.slice>) => {
		lowerSoftDescriptorLimit()
		const held: number[] = []
		try {
			for (;;) held.push(openSync("/dev/null", "r"))
		} catch {
			// The descriptor limit is reached; keep every descriptor open for the rest of the run.
		}
		return slice(...range)
	}) as typeof argv.slice
}
