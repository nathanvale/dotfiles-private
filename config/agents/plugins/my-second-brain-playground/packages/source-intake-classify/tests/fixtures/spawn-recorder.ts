// Test-only preload: observes lane starts from the parent side. With SOURCE_INTAKE_TEST_SPAWN_LOG set, every Bun.spawn
// of `codex exec` appends one line to that file synchronously, before the process is created, so a lane killed within
// a millisecond of its spawn still counts as started. A child's own first write cannot prove that.
import { appendFileSync } from "node:fs"

const log = process.env.SOURCE_INTAKE_TEST_SPAWN_LOG

if (log !== undefined) {
	const spawn = Bun.spawn
	Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
		const first: unknown = args[0]
		const cmd = Array.isArray(first) ? first : (first as { cmd?: unknown } | undefined)?.cmd
		if (Array.isArray(cmd) && cmd[1] === "exec") appendFileSync(log, "exec\n")
		return spawn(...args)
	}) as typeof Bun.spawn
}
