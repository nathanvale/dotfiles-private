// Fixture `bd`: replays recorded bd 1.2.2 JSON keyed by subcommand and writes nothing. `where.path` and
// `context.beads_dir` echo BEADS_DIR so the helper's exact-store comparison holds for any workspace. An optional
// `<BEADS_DIR>/fixture.json` steers one scenario (wrong version, wrong store, unavailable store, missing Bead,
// contention, changed Bead fields); the checker workspace carries none, so it replays the defaults. The shapes are
// literal restatements of specification/evidence/bd-reads and the probe of the pinned binary (independent oracle).

import { readFileSync } from "node:fs"
import { join } from "node:path"

export const SECRET_MARKER = "CHECK_FIXTURE_SECRET_MARKER"

interface Scenario {
	readonly version?: string
	readonly wherePath?: string
	readonly prefix?: string
	readonly configPrefix?: string
	/** Extra fields merged into the `config list` reply (a secret-pattern key here exercises value redaction). */
	readonly config?: Readonly<Record<string, unknown>>
	readonly redirected?: boolean
	readonly contextError?: string
	/** Every JSON subcommand answers {"error": <value>} with exit 1. */
	readonly unavailable?: string
	/** `show <id>` answers {"error": <value>} with exit 1 for the named ids. */
	readonly showError?: Readonly<Record<string, string>>
	/** Field overrides merged into the named Bead replies. */
	readonly beads?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
	/** Every JSON subcommand prints text that is not JSON with exit 0. */
	readonly noJson?: boolean
	/** Every subcommand sleeps past the helper's deadline. */
	readonly hang?: boolean
	/** Extra gates appended to `gate list --all`. */
	readonly gates?: readonly Record<string, unknown>[]
}

const beadsDir = process.env.BEADS_DIR ?? ""

function scenario(): Scenario {
	try {
		return JSON.parse(readFileSync(join(beadsDir, "fixture.json"), "utf8")) as Scenario
	} catch {
		return {}
	}
}

const GATE = { id: "lkr-gate", title: "Gate: human", description: "Ad-hoc gate blocking lkr-fixture\n\nReason: fixture review", status: "open", priority: 2, issue_type: "gate", owner: "hi@nathanvale.com", created_at: "2026-09-17T08:30:22Z", created_by: "Nathan Vale", updated_at: "2026-09-17T08:30:22Z", await_type: "human" }
const BLOCKER = { id: "lkr-blocker", title: "Blocker bead", status: "open", priority: 2, issue_type: "task", owner: "hi@nathanvale.com", created_at: "2026-09-17T08:30:23Z", created_by: "Nathan Vale", updated_at: "2026-09-17T08:30:23Z" }

const BEADS: Readonly<Record<string, Record<string, unknown>>> = {
	"lkr-fixture": {
		id: "lkr-fixture",
		title: "M1: fixture Bead",
		description: "## Work\n\nFixture work item.",
		acceptance_criteria: "- [ ] fixture criterion",
		spec_id: "https://github.com/nathanvale/dotfiles-private/issues/57",
		status: "in_progress",
		priority: 2,
		issue_type: "task",
		assignee: "migration-engineer",
		owner: "hi@nathanvale.com",
		created_at: "2026-09-16T22:34:05Z",
		created_by: "Nathan Vale",
		updated_at: "2026-09-17T03:09:16Z",
		started_at: "2026-09-16T22:39:57Z",
		external_ref: "https://github.com/nathanvale/dotfiles-private/issues/58",
		metadata: { restart_key: "fixture-v1" },
		labels: ["enhancement", "ready-for-agent"],
		dependencies: [
			{ ...GATE, dependency_type: "blocks" },
			{ ...BLOCKER, dependency_type: "blocks" },
			{ id: "lkr-parent", title: "Parent epic", status: "open", priority: 2, issue_type: "epic", owner: "hi@nathanvale.com", created_at: "2026-09-16T10:30:51Z", created_by: "foreground-coordinator", updated_at: "2026-09-17T01:10:54Z", dependency_type: "parent-child" },
		],
		comments: [
			{ id: "01a0-1", issue_id: "lkr-fixture", author: "ledger-steward", text: "## Checkpoint one\n\nFirst checkpoint body.", created_at: "2026-09-17T00:29:53Z" },
			{ id: "01a0-2", issue_id: "lkr-fixture", author: "Nathan Vale", text: "## Checkpoint two\n\nSecond checkpoint body.", created_at: "2026-09-17T01:53:19Z" },
			{ id: "01a0-3", issue_id: "lkr-fixture", author: "ledger-steward", text: "## Checkpoint three\n\nThird checkpoint body.", created_at: "2026-09-17T05:21:36Z" },
			{ id: "01a0-4", issue_id: "lkr-fixture", author: "ledger-steward", text: "## Checkpoint four\n\nFourth checkpoint body; the newest.", created_at: "2026-09-17T06:09:22Z" },
		],
		parent: "lkr-parent",
		dependent_count: 0,
		dependency_count: 3,
		comment_count: 4,
	},
	"lkr-other": { id: "lkr-other", title: "Another Bead", status: "open", priority: 2, issue_type: "task", owner: "hi@nathanvale.com", created_at: "2026-09-17T08:30:13Z", created_by: "Nathan Vale", updated_at: "2026-09-17T08:30:13Z", dependent_count: 0, dependency_count: 0, comment_count: 0 },
	"lkr-secret": {
		id: "lkr-secret",
		title: "Bead with a secret",
		status: "open",
		priority: 2,
		issue_type: "task",
		owner: "hi@nathanvale.com",
		created_at: "2026-09-17T08:30:13Z",
		created_by: "Nathan Vale",
		updated_at: "2026-09-17T08:30:40Z",
		metadata: { api_key: SECRET_MARKER },
		comments: [{ id: "01a0-s", issue_id: "lkr-secret", author: "Nathan Vale", text: `First probe comment with api_key=${SECRET_MARKER}`, created_at: "2026-09-17T08:30:40Z" }],
		dependent_count: 0,
		dependency_count: 0,
		comment_count: 1,
	},
}

const PRIME = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "[bd prime] fixture prime context\n\n# Beads Workflow Context\n\nRun `bd prime` after compaction." } }
const CONFIG = { auto_compact_enabled: "false", compaction_enabled: "false", issue_prefix: "lkr", schema_version: 1 }

function emit(value: unknown, exit = 0): never {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
	process.exit(exit)
}

function errorReply(value: string): never {
	process.stderr.write(`Error: ${value}\n`)
	emit({ error: value, schema_version: 1 }, 1)
}

function show(steer: Scenario, id: string): never {
	const error = steer.showError?.[id]
	if (error !== undefined) errorReply(error)
	const bead = BEADS[id]
	if (bead === undefined) errorReply("no issues found matching the provided IDs")
	emit([{ ...bead, ...(steer.beads?.[id] ?? {}) }])
}

function context(steer: Scenario): never {
	if (steer.contextError !== undefined) errorReply(steer.contextError)
	emit({ backend: "dolt", bd_version: "1.2.2", beads_dir: beadsDir, cwd_repo_root: process.cwd(), database: "lkr", dolt_mode: "embedded", is_redirected: steer.redirected === true, is_worktree: false, project_id: "fixture", repo_root: process.cwd(), schema_version: 1 })
}

/** JSON subcommands keyed by their first two words; `version` is handled before steering because it is plain text. */
const JSON_COMMANDS: Readonly<Record<string, (steer: Scenario, second: string | undefined) => never>> = {
	where: (steer) => emit({ database_path: join(steer.wherePath ?? beadsDir, "embeddeddolt"), path: steer.wherePath ?? beadsDir, prefix: steer.prefix ?? "lkr", schema_version: 1 }),
	"config list": (steer) => emit({ ...CONFIG, ...(steer.config ?? {}), issue_prefix: steer.configPrefix ?? "lkr" }),
	context,
	"gate list": (steer) => emit([GATE, ...(steer.gates ?? [])]),
	prime: () => emit(PRIME),
	show: (steer, second) => (second === undefined ? errorReply("no issues found matching the provided IDs") : show(steer, second)),
}

async function main(): Promise<void> {
	const args = process.argv.slice(2)
	const steer = scenario()
	if (steer.hang === true) await Bun.sleep(60_000)
	const [command = "", second] = args
	if (command === "version") {
		process.stdout.write(`${steer.version ?? "bd version 1.2.2 (6c124203e: 6c124203e771)"}\n`)
		process.exit(0)
	}
	const handler = JSON_COMMANDS[`${command} ${second ?? ""}`] ?? JSON_COMMANDS[command]
	if (handler === undefined) {
		process.stderr.write(`fixture bd: unsupported invocation ${args.join(" ")}\n`)
		process.exit(2)
	}
	if (steer.noJson === true) {
		process.stdout.write("not json\n")
		process.exit(0)
	}
	if (steer.unavailable !== undefined) errorReply(steer.unavailable)
	handler(steer, second)
}

await main()
