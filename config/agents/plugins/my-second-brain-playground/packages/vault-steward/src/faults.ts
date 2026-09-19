// The test-only fault channel (CONTRACT.md section 5): VAULT_STEWARD_FAULT is read only when set and wraps the Runtime
// port. Faults are separated by ";" and take one of these forms:
//   git-failure=<argv fragment>      the first Git spawn whose argv contains the fragment exits 128
//   git-failure#<n>=<argv fragment>  the n-th such spawn
//   unexpected=<argv fragment>       the first such spawn throws a plain Error (an unclassified exception)
//   halt=<fault point>               SIGKILL this process at the named engine fault point (no envelope)
//   pause=<fault point>:<ms>         sleep at the named fault point (two-process tests)
//   barrier=<fault point>:<path>     wait until the test creates the path at the named fault point
import { existsSync } from "node:fs"
import type { Runtime, SpawnOptions, SpawnOutcome } from "./runtime.ts"

export type Fault = { kind: "git-failure" | "unexpected"; occurrence: number; fragment: string } | { kind: "halt"; point: string } | { kind: "pause"; point: string; milliseconds: number } | { kind: "barrier"; point: string; path: string }

export function parseFaults(value: string | undefined): Fault[] | null {
	if (value === undefined || value === "") return []
	const faults: Fault[] = []
	for (const part of value.split(";")) {
		const spawn = /^(git-failure|unexpected)(?:#([1-9][0-9]*))?=(.+)$/.exec(part)
		const halt = /^halt=([a-z-]+)$/.exec(part)
		const pause = /^pause=([a-z-]+):([1-9][0-9]*)$/.exec(part)
		const barrier = /^barrier=([a-z-]+):(.+)$/.exec(part)
		if (spawn?.[1] !== undefined && spawn[3] !== undefined) faults.push({ kind: spawn[1] as "git-failure" | "unexpected", occurrence: Number(spawn[2] ?? "1"), fragment: spawn[3] })
		else if (halt?.[1] !== undefined) faults.push({ kind: "halt", point: halt[1] })
		else if (pause?.[1] !== undefined && pause[2] !== undefined) faults.push({ kind: "pause", point: pause[1], milliseconds: Number(pause[2]) })
		else if (barrier?.[1] !== undefined && barrier[2] !== undefined) faults.push({ kind: "barrier", point: barrier[1], path: barrier[2] })
		else return null
	}
	return faults
}

function pause(milliseconds: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function waitForPath(path: string): void {
	while (!existsSync(path)) pause(10)
}

// Wrap a runtime so the declared faults fire at their spawn or fault point. Counting is per fragment.
export function withFaults(rt: Runtime, faults: readonly Fault[]): Runtime {
	if (faults.length === 0) return rt
	const seen = new Map<string, number>()
	const spawnFaults = faults.filter((fault): fault is Extract<Fault, { fragment: string }> => fault.kind === "git-failure" || fault.kind === "unexpected")
	// The fault whose fragment matches this Git argv on its declared occurrence, if any.
	const firing = (argv: string): Extract<Fault, { fragment: string }> | undefined =>
		spawnFaults.find((fault) => {
			if (!argv.includes(fault.fragment)) return false
			const key = `${fault.kind}:${fault.fragment}`
			const count = (seen.get(key) ?? 0) + 1
			seen.set(key, count)
			return count === fault.occurrence
		})
	return {
		...rt,
		spawn(command: string[], options: SpawnOptions): SpawnOutcome {
			const fault = command[0] === "git" ? firing(command.slice(1).join(" ")) : undefined
			if (fault === undefined) return rt.spawn(command, options)
			if (fault.kind === "unexpected") throw new Error(`injected unexpected failure at ${fault.fragment}`)
			return { exitCode: 128, timedOut: false, spawnError: null, stdout: "", stderr: `fatal: injected git failure at ${fault.fragment}` }
		},
		faultPoint(name: string): void {
			for (const fault of faults) {
				if (fault.kind === "halt" && fault.point === name) process.kill(process.pid, "SIGKILL")
				if (fault.kind === "pause" && fault.point === name) pause(fault.milliseconds)
				if (fault.kind === "barrier" && fault.point === name) waitForPath(fault.path)
			}
			rt.faultPoint(name)
		},
	}
}
