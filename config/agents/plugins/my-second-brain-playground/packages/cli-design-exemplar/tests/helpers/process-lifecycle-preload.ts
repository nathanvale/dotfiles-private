import { mock } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import * as diagnostics from "../../src/diagnostics.ts"
import * as processLifecycle from "../../src/process-lifecycle.ts"

const mode = process.env.O3_MODE
const control = process.env.O3_CONTROL ?? ""
const ready = (name: string): void => { writeFileSync(join(control, name), "ready\n", { mode: 0o600 }) }

if (mode === "stdin-observation") {
	let reads = 0
	const receipt = join(control, "stdin-read-count")
	const recordRead = (): void => { reads += 1; writeFileSync(receipt, `${reads}\n`, { mode: 0o600 }) }
	writeFileSync(receipt, "0\n", { mode: 0o600 })
	const stdin = process.stdin
	const originalRead = stdin.read.bind(stdin)
	const originalResume = stdin.resume.bind(stdin)
	const originalPipe = stdin.pipe.bind(stdin)
	const originalOn = stdin.on.bind(stdin)
	const originalOnce = stdin.once.bind(stdin)
	const originalAddListener = stdin.addListener.bind(stdin)
	const originalPrependListener = stdin.prependListener.bind(stdin)
	const originalIterator = stdin[Symbol.asyncIterator].bind(stdin)
	stdin.read = ((size?: number) => { recordRead(); return originalRead(size) }) as typeof stdin.read
	stdin.resume = (() => { recordRead(); return originalResume() }) as typeof stdin.resume
	stdin.pipe = ((destination: NodeJS.WritableStream, options?: { end?: boolean }) => { recordRead(); return originalPipe(destination, options) }) as typeof stdin.pipe
	stdin.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => { if (event === "data" || event === "readable") recordRead(); return originalOn(event, listener) }) as typeof stdin.on
	stdin.once = ((event: string | symbol, listener: (...args: unknown[]) => void) => { if (event === "data" || event === "readable") recordRead(); return originalOnce(event, listener) }) as typeof stdin.once
	stdin.addListener = ((event: string | symbol, listener: (...args: unknown[]) => void) => { if (event === "data" || event === "readable") recordRead(); return originalAddListener(event, listener) }) as typeof stdin.addListener
	stdin.prependListener = ((event: string | symbol, listener: (...args: unknown[]) => void) => { if (event === "data" || event === "readable") recordRead(); return originalPrependListener(event, listener) }) as typeof stdin.prependListener
	stdin[Symbol.asyncIterator] = (() => { recordRead(); return originalIterator() }) as typeof stdin[typeof Symbol.asyncIterator]
	if (process.env.O3_STDIN_CONTROL === "read") stdin.read(0)
}

if (mode === "run-rejection") {
	mock.module("../../src/diagnostics.ts", () => ({ ...diagnostics, openRunDiagnostics: async () => { throw new Error("test-owned run rejection") } }))
}

if (mode === "uncaught" || mode === "unhandled") {
	const actualOpen = diagnostics.openRunDiagnostics
	mock.module("../../src/diagnostics.ts", () => ({ ...diagnostics, openRunDiagnostics: async (options: Parameters<typeof actualOpen>[0]) => {
		const opened = await actualOpen(options)
		ready("crash-ready")
		setTimeout(() => {
			if (mode === "uncaught") throw new Error("test-owned uncaught failure")
			void Promise.reject(new Error("test-owned unhandled rejection"))
		}, 5)
		return { ...opened, dispose: () => new Promise<diagnostics.DiagnosticsStatus>(() => {}) }
	} }))
}

if (mode === "before-output-signal" || mode === "repeated-signal") {
	mock.module("../../src/diagnostics.ts", () => ({
		...diagnostics,
		openRunDiagnostics: async () => {
			ready("before-output-ready")
			setInterval(() => {}, 1_000)
			return await new Promise<diagnostics.RunDiagnostics>(() => {})
		},
		finishActiveDiagnostics: () => new Promise<void>(() => {}),
	}))
}

if (mode === "during-drain-signal") {
	const actualCreate = processLifecycle.createProcessLifecycle
	mock.module("../../src/process-lifecycle.ts", () => ({
		...processLifecycle,
		createProcessLifecycle: (dependencies: processLifecycle.ProcessLifecycleDependencies) => actualCreate({
			...dependencies,
			writeStdout: (text: string, _callback: (error?: Error | null) => void) => {
				ready("write-started")
				setInterval(() => {}, 1_000)
				dependencies.writeStdout(text, () => {})
			},
		}),
	}))
}

if (mode === "late-epipe" || mode === "after-drain-signal") {
	process.once("beforeExit", () => {
		ready("drain-confirmed")
		if (mode === "late-epipe") process.stdout.emit("error", Object.assign(new Error("test-owned late pipe close"), { code: "EPIPE" }))
		else setInterval(() => {}, 1_000)
	})
}

const deadlineAnswers: Readonly<Record<string, readonly boolean[]>> = {
	"deadline-before-start": [true],
	"deadline-unchanged": [false, true],
	"deadline-completed": [false, false, false, true],
	"deadline-partial": [false, false, true],
	"deadline-unknown": [false, false, false, true],
}

const answers = mode === undefined ? undefined : deadlineAnswers[mode]
if (answers !== undefined) {
	mock.module("../../src/operation-deadline.ts", () => ({
		createOperationDeadline: () => {
			let checks = 0
			return {
				expired: () => {
					checks += 1
					if (checks > 1) ready("deadline-dispatch")
					return answers[checks - 1] ?? true
				},
			}
		},
	}))
}
