export type TimerHandle = unknown

export interface ProcessLifecycleDependencies {
	writeStdout(text: string, callback: (error?: Error | null) => void): void
	writeStderr(text: string, callback: (error?: Error | null) => void): void
	finishDiagnostics(): Promise<void>
	attemptEmergencyDiagnostics(): void
	setExitCode(code: number): void
	exit(code: number): void
	setTimer(callback: () => void, milliseconds: number): TimerHandle
	unrefTimer(handle: TimerHandle): void
	clearTimer(handle: TimerHandle): void
}

export interface ProcessLifecycle {
	stdout(text: string): void
	stderr(text: string): void
	outputError(error: Error): void
	complete(code: number): Promise<void>
	terminate(code: 130 | 143): void
	crash(): void
	isStopping(): boolean
}

const DIAGNOSTIC_FLUSH_MILLISECONDS = 500
const NORMAL_EXIT_WATCHDOG_MILLISECONDS = 150

export function createProcessLifecycle(dependencies: ProcessLifecycleDependencies): ProcessLifecycle {
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

	function writeOutput(text: string, write: (text: string, callback: (error?: Error | null) => void) => void): void {
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
				try { write(text, finish) } catch (error) { finish(error instanceof Error ? error : new Error("stream write failed")) }
			})
		})
	}

	function stdout(text: string): void { writeOutput(text, dependencies.writeStdout) }

	function terminate(code: 130 | 143): void {
		if (stopping) { exitOnce(code); return }
		stopping = true
		const timer = dependencies.setTimer(() => exitOnce(code), DIAGNOSTIC_FLUSH_MILLISECONDS)
		void dependencies.finishDiagnostics().finally(() => {
			dependencies.clearTimer(timer)
			exitOnce(code)
		})
	}

	return {
		stdout,
		stderr(text) { writeOutput(text, dependencies.writeStderr) },
		outputError(error) { activeWriteDone?.(error) },
		async complete(code) {
			await outputFinished
			if (!stopping) {
				const finalCode = outputFailed ? 1 : code
				dependencies.setExitCode(finalCode)
				const timer = dependencies.setTimer(() => exitOnce(finalCode), NORMAL_EXIT_WATCHDOG_MILLISECONDS)
				dependencies.unrefTimer(timer)
			}
		},
		terminate,
		crash() {
			if (terminal) return
			stopping = true
			try { dependencies.attemptEmergencyDiagnostics() } catch {}
			exitOnce(1)
		},
		isStopping: () => stopping,
	}
}
