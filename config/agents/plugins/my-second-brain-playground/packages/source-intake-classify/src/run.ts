// The one model run: a fresh, top-level `codex exec` under the lane configuration the pre-flight proved. The lane
// input reaches it only on standard input. Only the final message and the thread identity are read back; tool output,
// reasoning and stderr are never forwarded.
import type { Subprocess } from "bun"
import { type Classification, parseClassification } from "./classification.ts"
import type { LaneInput } from "./input.ts"
import { LANE_MODEL, type Lane, schemaPathFor } from "./lane.ts"

const MODEL_TIMEOUT_MS = 15 * 60_000

export type LaneOutcome = { kind: "classified"; classification: Classification; threadId: string } | { kind: "resultCompleted" } | { kind: "outcomeUnknown" }

let active: Subprocess | null = null

/** Stops a running lane on SIGINT or SIGTERM, so no model process outlives the command. */
export function stopLane(): void {
	active?.kill("SIGKILL")
}

function lanePrompt(input: LaneInput): string {
	return `Classify this one Source Intake item. The lane input is JSON between the tags.\n<lane_input>\n${JSON.stringify(input, null, 2)}\n</lane_input>\n`
}

type LaneEvent = { type?: unknown; thread_id?: unknown; item?: { type?: unknown; text?: unknown } }

function events(stdout: string): LaneEvent[] {
	return stdout.split("\n").flatMap((line) => {
		try {
			const value: unknown = JSON.parse(line)
			return typeof value === "object" && value !== null ? [value as LaneEvent] : []
		} catch {
			return []
		}
	})
}

/** A completed turn with a thread identity means the model received the input; without both, the effect is unknown. */
function interpret(stdout: string): LaneOutcome {
	let threadId: string | null = null
	let message: string | null = null
	let completed = false
	for (const event of events(stdout)) {
		if (event.type === "thread.started" && typeof event.thread_id === "string") threadId = event.thread_id
		if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") message = event.item.text
		if (event.type === "turn.completed") completed = true
	}
	if (!completed || threadId === null) return { kind: "outcomeUnknown" }
	const classification = message === null ? null : parseClassification(message)
	return classification === null ? { kind: "resultCompleted" } : { kind: "classified", classification, threadId }
}

function laneExecArgs(lane: Lane, workspace: string): string[] {
	return [lane.codex, "exec", ...lane.configArgs, "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--json", "-m", LANE_MODEL, "-C", workspace, "--output-schema", schemaPathFor(lane), "-"]
}

export async function runLane(lane: Lane, workspace: string, input: LaneInput): Promise<LaneOutcome> {
	const child = Bun.spawn({ cmd: laneExecArgs(lane, workspace), cwd: workspace, env: lane.env, stdin: "pipe", stdout: "pipe", stderr: "ignore" })
	active = child
	const timer = setTimeout(() => child.kill("SIGKILL"), MODEL_TIMEOUT_MS)
	try {
		child.stdin.write(lanePrompt(input))
		await child.stdin.end()
		const stdout = await new Response(child.stdout).text()
		await child.exited
		return interpret(stdout)
	} catch {
		return { kind: "outcomeUnknown" }
	} finally {
		clearTimeout(timer)
		active = null
	}
}
