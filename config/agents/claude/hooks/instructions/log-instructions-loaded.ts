#!/usr/bin/env bun
// Measures which instruction files are actually reached. Records metadata only:
// no prompt text, no file content. See the goal at
// my-second-brain-vault-spike/projects/agent-instructions-improvement-loop/decisions/pointer-following-measurement.md

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const LOG = `${process.env.HOME}/.claude/logs/instructions-loaded.jsonl`

type Payload = {
	session_id?: string
	hook_event_name?: string
	load_reason?: string
	cwd?: string
	agent_type?: string
	agent_id?: string
	[k: string]: unknown
}

// Exit 0 on every path. A measurement hook must never block a session.
try {
	const raw = await Bun.stdin.text()
	const p: Payload = JSON.parse(raw)

	// The file field is undocumented, so probe the plausible keys and keep the
	// raw key set when none matches, rather than silently logging nothing.
	const fileKeys = ['file_path', 'path', 'file', 'instruction_file', 'source']
	const found = fileKeys.find((k) => typeof p[k] === 'string')

	const row = {
		ts: new Date().toISOString(),
		session: p.session_id ?? null,
		reason: p.load_reason ?? null,
		file: found ? (p[found] as string) : null,
		file_key: found ?? null,
		agent: p.agent_type ?? 'main',
		cwd: p.cwd ?? null,
		unresolved: found ? undefined : Object.keys(p),
	}

	mkdirSync(dirname(LOG), { recursive: true })
	appendFileSync(LOG, `${JSON.stringify(row)}\n`)
} catch {
	// Swallow. A broken logger must not cost a session.
}
