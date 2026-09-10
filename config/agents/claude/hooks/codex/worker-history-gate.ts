interface PreToolUseInput {
	tool_name: string
	tool_input: Record<string, unknown>
}

const REPAIR = 'Retry the spawn_agent call with fork_turns: none.'

function refuse(reason: string): never {
	console.error(`Worker history gate refused the launch: ${reason} ${REPAIR}`)
	process.exit(2)
}

function parseInput(raw: string): PreToolUseInput {
	let value: unknown
	try {
		value = JSON.parse(raw)
	} catch {
		refuse('Hook input is not valid JSON.')
	}

	if (!value || typeof value !== 'object') {
		refuse('Hook input must be a JSON object.')
	}

	const input = value as Record<string, unknown>
	if (typeof input.tool_name !== 'string') {
		refuse('Hook input has no valid tool_name.')
	}
	if (
		!input.tool_input ||
		typeof input.tool_input !== 'object' ||
		Array.isArray(input.tool_input)
	) {
		refuse('Hook input has no valid tool_input object.')
	}

	return {
		tool_name: input.tool_name,
		tool_input: input.tool_input as Record<string, unknown>,
	}
}

const input = parseInput(await Bun.stdin.text())

if (input.tool_name !== 'spawn_agent') {
	process.exit(0)
}

if (input.tool_input.fork_turns !== 'none') {
	refuse('fork_turns must be the explicit string "none".')
}
