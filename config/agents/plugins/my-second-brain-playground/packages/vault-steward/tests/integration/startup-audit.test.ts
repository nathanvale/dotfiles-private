import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// Every row spawns several real Git and CLI processes on a machine shared with other agents: a process budget, not the
// 5 s unit default.
setDefaultTimeout(60_000)

// Row F3 (plan section 7): hooks/recover-context prints one guard line only when the configured vault's audit reports
// findings, keeps silent otherwise, stays inside a 2 s budget when the audit hangs, and never changes the hook's exit.
// The hook is exercised as installed (sh entry plus the committed runtime bundle), with fixture vaults whose
// `guard:audit` script prints canned envelopes.

const hook = resolve(import.meta.dir, "../../../../hooks/recover-context")
const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// `config` is the fixture HOME: the hook resolves $HOME/.config/my-second-brain-playground/vault.json like its recovery owner.
function vaultWithAudit(script: string | null): { config: string; vault: string } {
	const root = mkdtempSync(join(tmpdir(), "vault-steward-f3-"))
	roots.push(root)
	const vault = join(root, "vault")
	const config = join(root, "home")
	mkdirSync(vault)
	mkdirSync(join(config, ".config", "my-second-brain-playground"), { recursive: true })
	writeFileSync(join(config, ".config", "my-second-brain-playground", "vault.json"), JSON.stringify({ schemaVersion: 1, vault }))
	writeFileSync(join(vault, "package.json"), JSON.stringify({ private: true, scripts: script === null ? {} : { "guard:audit": "bun run audit.ts" } }))
	if (script !== null) writeFileSync(join(vault, "audit.ts"), script)
	return { config, vault }
}

function runHook(config: string): { exitCode: number; stdout: string; stderr: string; ms: number } {
	const started = Date.now()
	const result = Bun.spawnSync([hook], { cwd: tmpdir(), stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, HOME: config, XDG_STATE_HOME: join(config, "state") } })
	return { exitCode: result.exitCode, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr), ms: Date.now() - started }
}

const findings = 'console.log(JSON.stringify({ schemaVersion: 1, ok: false, findings: [{ id: "guard-hook-missing", severity: "error" }, { id: "legacy-backup-refs", severity: "info" }, { id: "stale-integration-lock", severity: "warn" }] }))\nprocess.exit(1)\n'
const clean = 'console.log(JSON.stringify({ schemaVersion: 1, ok: true, findings: [] }))\n'
const informational = 'console.log(JSON.stringify({ schemaVersion: 1, ok: true, findings: [{ id: "legacy-backup-refs", severity: "info" }] }))\n'

test("F3: error and warn findings produce exactly one line (info rows omitted) and the hook still exits 0", () => {
	const { config, vault } = vaultWithAudit(findings)
	const result = runHook(config)
	expect(result.exitCode).toBe(0)
	expect(result.stdout).toBe(`vault-guard: 2 finding(s) in ${vault}: guard-hook-missing, stale-integration-lock (run 'bun run guard:audit --json' there)\n`)
})

test("F3: a clean audit, an info-only audit, a vault without guard:audit, and no configured vault all print nothing", () => {
	for (const config of [vaultWithAudit(clean).config, vaultWithAudit(informational).config, vaultWithAudit(null).config, join(mkdtempSync(join(tmpdir(), "vault-steward-f3-none-")), "home")]) {
		const result = runHook(config)
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toBe("")
	}
})

test("F3: a hanging or crashing audit never blocks or fails session start", () => {
	const hanging = vaultWithAudit("await Bun.sleep(10_000)\n")
	const slow = runHook(hanging.config)
	expect(slow.exitCode).toBe(0)
	expect(slow.stdout).toBe("")
	expect(slow.ms).toBeLessThan(4_000)
	const crashing = vaultWithAudit('console.log("not json"); process.exit(3)\n')
	const crashed = runHook(crashing.config)
	expect(crashed.exitCode).toBe(0)
	expect(crashed.stdout).toBe("")
}, 15_000)
