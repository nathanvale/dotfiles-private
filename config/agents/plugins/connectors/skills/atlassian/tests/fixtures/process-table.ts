// One process's executable, argv, and initial environment, read from the
// kernel: the absolute executable path through proc_pidpath (the exec path
// in the argument table is as the spawner spelled it, possibly relative),
// and argv and environment through sysctl KERN_PROCARGS2, the table ps reads.
// ps itself is setuid, and macOS refuses a setuid exec inside a sandbox.
// Fakes read their parent here and record its executable path, at most its
// role argv, and booleans about its strings; never a token value.
import { dlopen, FFIType, ptr } from "bun:ffi";

export interface ProcessStrings {
	executable: string;
	argv: string[];
	environment: string[];
}

// A process's parent pid through proc_pidinfo PROC_PIDTBSDINFO: pbi_ppid is
// the fifth u32 of struct proc_bsdinfo (136 bytes). 0 when unreadable.
export function parentPid(pid: number): number {
	const libc = dlopen("/usr/lib/libSystem.B.dylib", { proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 } });
	const PROC_PIDTBSDINFO = 3;
	const info = new Uint8Array(136);
	const read = libc.symbols.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ptr(info), info.length);
	libc.close();
	return read === info.length ? new DataView(info.buffer).getUint32(16, true) : 0;
}

export function processStrings(pid: number): ProcessStrings {
	const libc = dlopen("/usr/lib/libSystem.B.dylib", {
		sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
		proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
	});
	const PROC_PIDPATHINFO_MAXSIZE = 4096;
	const pathBuffer = new Uint8Array(PROC_PIDPATHINFO_MAXSIZE);
	const pathLength = libc.symbols.proc_pidpath(pid, ptr(pathBuffer), PROC_PIDPATHINFO_MAXSIZE);
	const executable = pathLength > 0 ? Buffer.from(pathBuffer.subarray(0, pathLength)).toString("utf8") : "";
	const CTL_KERN = 1;
	const KERN_PROCARGS2 = 49;
	const name = new Int32Array([CTL_KERN, KERN_PROCARGS2, pid]);
	const size = new BigUint64Array([1n << 20n]);
	const buffer = new Uint8Array(Number(size[0]));
	const failed = libc.symbols.sysctl(ptr(name), name.length, ptr(buffer), ptr(size), null, 0) !== 0;
	libc.close();
	if (failed) return { executable, argv: [], environment: [] };
	// Layout: argc, the exec path, NUL padding, then argc argv strings and the
	// environment strings, each NUL-terminated, ending at the first empty one.
	const argc = new DataView(buffer.buffer).getInt32(0, true);
	const [, ...fields] = Buffer.from(buffer.subarray(4, Number(size[0])))
		.toString("utf8")
		.split("\0");
	const start = fields.findIndex((field) => field !== "");
	const strings = start === -1 ? [] : fields.slice(start);
	const end = strings.indexOf("");
	const listed = end === -1 ? strings : strings.slice(0, end);
	return { executable, argv: listed.slice(0, argc), environment: listed.slice(argc) };
}
