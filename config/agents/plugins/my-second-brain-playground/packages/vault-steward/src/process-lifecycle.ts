// Process lifecycle owner (restored from the pinned starter 7f6d950 `starters/complex/src/process-lifecycle.ts`,
// diagnostics flush injected): stdout drain, EPIPE, SIGINT 130 and SIGTERM 143 after a bounded diagnostics flush,
// repeated termination exits immediately, and the crash boundary with one emergency diagnostics attempt.
type TimerHandle = ReturnType<typeof setTimeout>

interface ProcessLifecycleDependencies {
	attemptEmergencyDiagnostics(): void
	clearTimer(handle: TimerHandle): void
	exit(code: number): void
	finishDiagnostics(): Promise<void>
	setExitCode(code: number): void
	setTimer(callback: () => void, milliseconds: number): TimerHandle
	unrefTimer(handle: TimerHandle): void
	writeStderr(text: string): void
	writeStdout(text: string, callback: (error?: Error | null) => void): void
}

export interface ProcessLifecycle {
	complete(code: number): Promise<void>
	crash(): void
	isStopping(): boolean
	outputError(error: Error): void
	stderr(text: string): void
	stdout(text: string): void
	terminate(code: 130 | 143): void
}

const FLUSH_DEADLINE_MS = 500
const EXIT_WATCHDOG_MS = 150

function createProcessLifecycle(dependencies: ProcessLifecycleDependencies): ProcessLifecycle {
	let stopping = false
	let terminal = false
	let outputFailed = false
	let activeWriteDone: ((error?: Error | null) => void) | null = null
	let outputFinished = Promise.resolve()

	function exitOnce(code: number): void {
		if (terminal) return
		terminal = true
		dependencies.exit(code)
	}

	function stdout(text: string): void {
		if (stopping || terminal) return
		outputFinished = outputFinished.then(() => {
			if (stopping || terminal) return
			return new Promise<void>((resolve) => {
				let settled = false
				const finish = (error?: Error | null): void => {
					if (settled) return
					settled = true
					activeWriteDone = null
					if (error != null) outputFailed = true
					resolve()
				}
				activeWriteDone = finish
				try {
					dependencies.writeStdout(text, finish)
				} catch (error) {
					finish(error instanceof Error ? error : new Error("stdout write failed"))
				}
			})
		})
	}

	function terminate(code: 130 | 143): void {
		if (stopping) {
			exitOnce(code)
			return
		}
		stopping = true
		const deadline = dependencies.setTimer(() => exitOnce(code), FLUSH_DEADLINE_MS)
		void dependencies.finishDiagnostics().finally(() => {
			dependencies.clearTimer(deadline)
			exitOnce(code)
		})
	}

	return {
		async complete(code) {
			await outputFinished
			if (stopping) return
			const finalCode = outputFailed ? 1 : code
			dependencies.setExitCode(finalCode)
			const watchdog = dependencies.setTimer(() => exitOnce(finalCode), EXIT_WATCHDOG_MS)
			dependencies.unrefTimer(watchdog)
		},
		crash() {
			if (terminal) return
			stopping = true
			try {
				dependencies.attemptEmergencyDiagnostics()
			} catch {
				// Emergency diagnostics remain best-effort.
			}
			exitOnce(1)
		},
		isStopping: () => stopping,
		outputError(error) {
			activeWriteDone?.(error)
		},
		stderr(text) {
			if (!stopping && !terminal) dependencies.writeStderr(text)
		},
		stdout,
		terminate,
	}
}

export function systemProcessLifecycle(attemptEmergencyDiagnostics: () => void, finishDiagnostics: () => Promise<void>): ProcessLifecycle {
	const lifecycle = createProcessLifecycle({
		attemptEmergencyDiagnostics,
		clearTimer: clearTimeout,
		exit: (code) => process.exit(code),
		finishDiagnostics,
		setExitCode: (code) => {
			process.exitCode = code
		},
		setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
		unrefTimer: (handle) => handle.unref(),
		writeStderr: (text) => {
			process.stderr.write(text)
		},
		writeStdout: (text, callback) => {
			process.stdout.write(text, callback)
		},
	})
	process.stdout.on("error", (error) => lifecycle.outputError(error))
	process.stderr.on("error", (error) => lifecycle.outputError(error))
	process.on("SIGINT", () => lifecycle.terminate(130))
	process.on("SIGTERM", () => lifecycle.terminate(143))
	process.on("uncaughtException", () => lifecycle.crash())
	process.on("unhandledRejection", () => lifecycle.crash())
	return lifecycle
}
