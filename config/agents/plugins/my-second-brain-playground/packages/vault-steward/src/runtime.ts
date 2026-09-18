// Process, file, and Git evidence port for the shared engine. The engine and guard modules only touch the world through
// this interface, so a front door (or a fault-injecting test wrapper) can substitute one implementation.
import { createHash, randomUUID } from "node:crypto"
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { dirname } from "node:path"

export interface SpawnOptions {
	cwd: string
	env?: Record<string, string | undefined>
	stdin?: string
	timeoutMs?: number
}

// One finished child process. `timedOut` is true when the bounded run was killed at its deadline; `spawnError` names
// a failure to start the child at all (both leave exitCode null).
export interface SpawnOutcome {
	exitCode: number | null
	timedOut: boolean
	spawnError: string | null
	stdout: string
	stderr: string
}

export interface FileFacts {
	kind: "missing" | "file" | "directory" | "symlink" | "other"
	mode: number
	mtimeMs: number
}

export interface Runtime {
	env: Record<string, string | undefined>
	execPath: string
	pid: number
	now(): number
	spawn(command: string[], options: SpawnOptions): SpawnOutcome
	realpath(path: string): string
	exists(path: string): boolean
	fileFacts(path: string): FileFacts
	readText(path: string): string
	sha256File(path: string): string
	// Plain private write (mode 0600) used for the candidate manifest and the lock owner file.
	writePrivateText(path: string, text: string): void
	// 0700 directory chain; refuses to continue through a symbolic link.
	privateDirectory(path: string): void
	// Exclusive temp file, fsync, rename, directory fsync (legacy atomicPrivateJson).
	atomicPrivateJson(path: string, payload: unknown): void
	// Recursive 0700-capable mkdir without the symlink refusal (legacy begin semantics for the state root chain).
	makeDirectory(path: string, mode: number): void
	chmod(path: string, mode: number): void
	removeTree(path: string): void
}

function decode(bytes: Uint8Array | null | undefined): string {
	return bytes ? new TextDecoder().decode(bytes) : ""
}

export function createRuntime(): Runtime {
	return {
		env: process.env,
		execPath: process.execPath,
		pid: process.pid,
		now: () => Date.now(),
		spawn(command, options) {
			try {
				const child = Bun.spawnSync(command, {
					cwd: options.cwd,
					stdout: "pipe",
					stderr: "pipe",
					...(options.stdin === undefined ? {} : { stdin: new TextEncoder().encode(options.stdin) }),
					env: options.env ?? { ...process.env, GIT_TERMINAL_PROMPT: "0" },
					...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs, killSignal: "SIGKILL" }),
				})
				const timedOut = "exitedDueToTimeout" in child && child.exitedDueToTimeout === true
				return {
					exitCode: timedOut ? null : child.exitCode,
					timedOut,
					spawnError: null,
					stdout: decode(child.stdout),
					stderr: decode(child.stderr),
				}
			} catch (error) {
				return { exitCode: null, timedOut: false, spawnError: error instanceof Error ? error.message : String(error), stdout: "", stderr: "" }
			}
		},
		realpath: (path) => realpathSync(path),
		exists: (path) => existsSync(path),
		fileFacts(path) {
			try {
				const facts = lstatSync(path)
				const kind = facts.isSymbolicLink() ? "symlink" : facts.isFile() ? "file" : facts.isDirectory() ? "directory" : "other"
				return { kind, mode: facts.mode & 0o777, mtimeMs: facts.mtimeMs }
			} catch {
				return { kind: "missing", mode: 0, mtimeMs: 0 }
			}
		},
		readText: (path) => readFileSync(path, "utf8"),
		sha256File: (path) => createHash("sha256").update(readFileSync(path)).digest("hex"),
		writePrivateText(path, text) {
			writeFileSync(path, text, { mode: 0o600 })
			chmodSync(path, 0o600)
		},
		privateDirectory(path) {
			mkdirSync(path, { recursive: true, mode: 0o700 })
			if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error("Unsafe state directory")
			chmodSync(path, 0o700)
		},
		atomicPrivateJson(path, payload) {
			this.privateDirectory(dirname(path))
			const temporary = `${path}.${randomUUID()}.tmp`
			const descriptor = openSync(temporary, "wx", 0o600)
			try {
				writeFileSync(descriptor, `${JSON.stringify(payload)}\n`)
				fsyncSync(descriptor)
			} finally {
				closeSync(descriptor)
			}
			renameSync(temporary, path)
			const directory = openSync(dirname(path), "r")
			try {
				fsyncSync(directory)
			} finally {
				closeSync(directory)
			}
		},
		makeDirectory: (path, mode) => mkdirSync(path, { recursive: true, mode }),
		chmod: (path, mode) => chmodSync(path, mode),
		removeTree: (path) => rmSync(path, { recursive: true, force: true }),
	}
}
