// Bounded process execution shared by the native Adapters. stdin is never connected, both streams are captured,
// the child is killed at the deadline, and the caller receives a classified result rather than an exception.

export interface ProcessResult {
	readonly status: "exited" | "timed-out" | "failed-to-start"
	readonly exit: number | null
	readonly stdout: string
	readonly stderr: string
}

export interface ProcessOptions {
	readonly cwd?: string | undefined
	readonly env?: Readonly<Record<string, string>> | undefined
	readonly timeoutMilliseconds?: number | undefined
}

const DEFAULT_TIMEOUT_MILLISECONDS = 20_000

function baseEnvironment(): Record<string, string> {
	const env: Record<string, string> = {}
	for (const key of ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "SSH_AUTH_SOCK"]) {
		const value = process.env[key]
		if (value !== undefined) env[key] = value
	}
	env.NO_COLOR = "1"
	env.TERM = "dumb"
	env.GH_PROMPT_DISABLED = "1"
	return env
}

export async function runBounded(command: readonly string[], options: ProcessOptions = {}): Promise<ProcessResult> {
	let child: Bun.Subprocess<"ignore", "pipe", "pipe">
	try {
		child = Bun.spawn([...command], { ...(options.cwd === undefined ? {} : { cwd: options.cwd }), env: { ...baseEnvironment(), ...(options.env ?? {}) }, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
	} catch {
		return { status: "failed-to-start", exit: null, stdout: "", stderr: "" }
	}
	let timedOut = false
	const timer = setTimeout(() => {
		timedOut = true
		child.kill("SIGKILL")
	}, options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS)
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
	const exit = await child.exited
	clearTimeout(timer)
	if (timedOut) return { status: "timed-out", exit: null, stdout, stderr }
	return { status: "exited", exit, stdout, stderr }
}

export function parseJson(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function stringField(record: Record<string, unknown>, key: string): string | null {
	const value = record[key]
	return typeof value === "string" ? value : null
}

/** A short, non-secret description of a failed process for owner observations: exit or status only, never output. */
export function describeFailure(result: ProcessResult): string {
	if (result.status === "exited") return `exit ${result.exit}`
	return result.status
}
