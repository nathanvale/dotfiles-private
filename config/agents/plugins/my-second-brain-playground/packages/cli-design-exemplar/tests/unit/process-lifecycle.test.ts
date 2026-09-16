import { describe, expect, test } from "bun:test"
import { createProcessLifecycle, type ProcessLifecycleDependencies } from "../../src/process-lifecycle.ts"

function fixture() {
	const exits: number[] = []
	const stderr: string[] = []
	const timers = new Map<number, () => void>()
	let nextTimer = 1
	const unrefedTimers: number[] = []
	let writeCallback: ((error?: Error | null) => void) | undefined
	let finishDiagnostics: (() => void) | undefined
	let emergencyAttempts = 0
	const dependencies: ProcessLifecycleDependencies = {
		writeStdout: (_text, callback) => { writeCallback = callback },
		writeStderr: (text, callback) => { stderr.push(text); writeCallback = callback },
		finishDiagnostics: () => new Promise<void>((resolve) => { finishDiagnostics = resolve }),
		attemptEmergencyDiagnostics: () => { emergencyAttempts += 1 },
		setExitCode: (code) => { exits.push(code) },
		exit: (code) => { exits.push(code) },
		setTimer: (callback) => { const id = nextTimer++; timers.set(id, callback); return id },
		unrefTimer: (id) => { if (typeof id === "number") unrefedTimers.push(id) },
		clearTimer: (id) => { if (typeof id === "number") timers.delete(id) },
	}
	return {
		lifecycle: createProcessLifecycle(dependencies),
		exits,
		stderr,
		timers,
		unrefedTimers,
		write: (error?: Error | null) => writeCallback?.(error),
		finish: () => finishDiagnostics?.(),
		emergencyAttempts: () => emergencyAttempts,
	}
}

describe("process lifecycle", () => {
	test("normal completion waits for confirmed stdout drain", async () => {
		const observed = fixture()
		observed.lifecycle.stdout("result\n")
		const completed = observed.lifecycle.complete(3)
		await Promise.resolve()
		expect(observed.exits).toEqual([])
		observed.write(null)
		await completed
		expect(observed.exits).toEqual([3])
		expect(observed.unrefedTimers).toEqual([1])
		observed.timers.get(1)?.()
		expect(observed.exits).toEqual([3, 3])
	})

	test("normal completion waits for confirmed stderr drain", async () => {
		const observed = fixture()
		observed.lifecycle.stderr("refusal\n")
		const completed = observed.lifecycle.complete(2)
		await Promise.resolve()
		expect(observed.exits).toEqual([])
		observed.write(null)
		await completed
		expect(observed.stderr).toEqual(["refusal\n"])
		expect(observed.exits).toEqual([2])
	})

	test("an output failure before confirmed drain exits internal without stderr", async () => {
		const observed = fixture()
		observed.lifecycle.stdout("result\n")
		const completed = observed.lifecycle.complete(0)
		await Promise.resolve()
		observed.write(Object.assign(new Error("reader closed"), { code: "EPIPE" }))
		await completed
		expect(observed.exits).toEqual([1])
		expect(observed.stderr).toEqual([])
	})

	test("first termination waits for diagnostics and a repeated termination exits immediately", async () => {
		const observed = fixture()
		observed.lifecycle.terminate(130)
		expect(observed.exits).toEqual([])
		expect(observed.timers.size).toBe(1)
		observed.lifecycle.terminate(143)
		expect(observed.exits).toEqual([143])
		observed.finish()
		await Promise.resolve()
		expect(observed.exits).toEqual([143])
	})

	test("crash makes one synchronous emergency attempt and exits without output", () => {
		const observed = fixture()
		observed.lifecycle.crash()
		expect(observed.emergencyAttempts()).toBe(1)
		expect(observed.exits).toEqual([1])
		expect(observed.stderr).toEqual([])
	})
})
