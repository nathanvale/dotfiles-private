// Session-start guard audit line (plan 4.4, row F3). Runs `bun run guard:audit --json` in the configured vault only
// when that vault exists and declares the script, prints exactly one line when findings exist, and stays silent
// otherwise. Bounded to a 2 s child budget; every failure is silence, never a non-zero exit, so session start is
// never blocked. Invoked by hooks/recover-context before the existing recovery observer.
import { readFileSync } from "node:fs"
import { join } from "node:path"

const auditBudgetMs = 2_000

interface Finding {
	id: string
	severity: string
}

// Only findings that need attention earn the line; informational rows (for example legacy-backup-refs) stay silent.
const reportedSeverities = new Set(["error", "warn"])

// Same resolution as the hook's recovery owner (compaction-recovery/src/recovery.py): $HOME/.config, never XDG_CONFIG_HOME,
// so a HOME-scoped fixture fully isolates the hook.
function configuredVault(env: Record<string, string | undefined>): string | null {
	if (!env.HOME) return null
	try {
		const payload = JSON.parse(readFileSync(join(env.HOME, ".config", "my-second-brain-playground", "vault.json"), "utf8")) as { vault?: unknown }
		return typeof payload.vault === "string" && payload.vault ? payload.vault : null
	} catch {
		return null
	}
}

function declaresAudit(vault: string): boolean {
	try {
		const manifest = JSON.parse(readFileSync(join(vault, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }
		return typeof manifest.scripts?.["guard:audit"] === "string"
	} catch {
		return false
	}
}

function findingIds(stdout: string): string[] | null {
	try {
		const envelope = JSON.parse(stdout) as { findings?: unknown }
		if (!Array.isArray(envelope.findings)) return null
		return envelope.findings
			.filter((finding: Finding) => typeof finding?.severity === "string" && reportedSeverities.has(finding.severity))
			.map((finding: Finding) => (typeof finding?.id === "string" ? finding.id : "unknown"))
	} catch {
		return null
	}
}

// One line, or nothing.
function auditLine(env: Record<string, string | undefined>): string | null {
	const vault = configuredVault(env)
	if (vault === null || !declaresAudit(vault)) return null
	let stdout: string
	try {
		const child = Bun.spawnSync(["bun", "run", "--silent", "guard:audit", "--json"], {
			cwd: vault,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...env, GIT_TERMINAL_PROMPT: "0" },
			timeout: auditBudgetMs,
			killSignal: "SIGKILL",
		})
		if ("exitedDueToTimeout" in child && child.exitedDueToTimeout === true) return null
		stdout = new TextDecoder().decode(child.stdout)
	} catch {
		return null
	}
	const ids = findingIds(stdout)
	if (ids === null || ids.length === 0) return null
	return `vault-guard: ${ids.length} finding(s) in ${vault}: ${ids.join(", ")} (run 'bun run guard:audit --json' there)`
}

const line = auditLine(process.env)
if (line !== null) console.log(line)
