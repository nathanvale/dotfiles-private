// Observation of the vault's reference-transaction gate (GUARD-INTERACTION.md sections 2 to 5). The CLI observes; it
// never installs, edits, or removes the hook. Every step is a read or a direct, side-effect-free hook execution.
import { join, sep } from "node:path"
import { gitQuiet, refuse } from "./engine.ts"
import {
	type GuardObservation,
	type GuardStatus,
	guardDeniedCode,
	guardFailOpenCode,
	hookName,
	type RefusalFacts,
	type SelfTest,
	selfTestTimeoutMs,
	type Warning,
} from "./model.ts"
import type { Runtime, SpawnOutcome } from "./runtime.ts"

const zeroSha = "0".repeat(40)
const hookSourceRelative = join("scripts", "git-hooks", hookName)

export interface GuardInput {
	vault: string
	// realpath(stateRoot)/<vaultId> when resolvable; candidates below it are never foreign.
	candidateRoot: string
	runId: string
	// The candidate commit when known, else main's sha (self-test line C).
	candidateCommit?: string | undefined
	// Facts the guard refusal inherits from the calling command (worktree, paths).
	facts?: RefusalFacts
}

export type AllowClassification = { selfTest: "continue" } | { selfTest: "incompatible"; ref: string } | { selfTest: "error"; detail: string }
export type ProbeClassification = { selfTest: "pass" } | { selfTest: "probe-allowed"; detail: string } | { selfTest: "error"; detail: string }

function spawnFailure(outcome: SpawnOutcome): string | null {
	if (outcome.spawnError !== null) return `spawn failed: ${outcome.spawnError}`
	if (outcome.timedOut) return `timed out after ${selfTestTimeoutMs} ms`
	return null
}

// Run A (allow): exit 0 continues; exit 1 naming one of the two Vault Steward refs is incompatible; anything else errors.
export function classifyAllowRun(outcome: SpawnOutcome, refs: string[]): AllowClassification {
	const failure = spawnFailure(outcome)
	if (failure !== null) return { selfTest: "error", detail: failure }
	if (outcome.exitCode === 0) return { selfTest: "continue" }
	if (outcome.exitCode === 1) {
		const denied = refs.find((ref) => outcome.stderr.includes(`${guardDeniedCode} ${ref}`))
		if (denied !== undefined) return { selfTest: "incompatible", ref: denied }
	}
	return { selfTest: "error", detail: `unexpected exit ${outcome.exitCode}` }
}

// Run B (probe): exit 1 denying the probe ref passes; exit 0 means the gate allows creations; anything else errors.
export function classifyProbeRun(outcome: SpawnOutcome, probeRef: string): ProbeClassification {
	const failure = spawnFailure(outcome)
	if (failure !== null) return { selfTest: "error", detail: failure }
	if (outcome.exitCode === 1 && outcome.stderr.includes(`${guardDeniedCode} ${probeRef}`)) return { selfTest: "pass" }
	if (outcome.exitCode === 0) {
		const failOpen = outcome.stderr.split("\n").find((line) => line.startsWith(guardFailOpenCode))
		return { selfTest: "probe-allowed", detail: `${probeRef} was not denied (exit 0)${failOpen ? `; ${failOpen}` : ""}` }
	}
	return { selfTest: "error", detail: `unexpected exit ${outcome.exitCode}` }
}

export function sprawlBranches(refNames: string[]): string[] {
	return refNames.filter((name) => name && name !== "refs/heads/main")
}

// Worktrees that are neither the vault nor a Vault Steward candidate of this vault.
export function foreignWorktrees(paths: string[], vault: string, candidateRoot: string): string[] {
	return paths.filter((path) => path !== vault && !path.startsWith(`${candidateRoot}${sep}`))
}

function hookEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined> {
	const copy = { ...env }
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete copy[key]
	copy.GIT_TERMINAL_PROMPT = "0"
	return copy
}

function runHook(rt: Runtime, hookPath: string, vault: string, lines: string[]): SpawnOutcome {
	return rt.spawn([hookPath, "prepared"], { cwd: vault, env: hookEnvironment(rt.env), stdin: `${lines.join("\n")}\n`, timeoutMs: selfTestTimeoutMs })
}

interface HookLocation {
	hookPath: string
	installed: boolean
	executable: boolean
	current: boolean | null
	hooksPathOverride: string | null
	warnings: Warning[]
}

function locateHook(rt: Runtime, vault: string): HookLocation {
	const warnings: Warning[] = []
	const override = gitQuiet(rt, vault, ["config", "--get", "core.hooksPath"])
	const hooksPathOverride = override.exitCode === 0 && override.stdout.trim() ? override.stdout.trim() : null
	if (hooksPathOverride !== null) warnings.push({ code: "HOOKS_PATH_OVERRIDE", detail: `core.hooksPath=${hooksPathOverride}` })
	const hooksDirectory = gitQuiet(rt, vault, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]).stdout.trim()
	const hookPath = join(hooksDirectory, hookName)
	const facts = rt.fileFacts(hookPath)
	const installed = facts.kind === "file"
	const executable = installed && (facts.mode & 0o111) !== 0
	if (!installed) warnings.push({ code: "GUARD_MISSING", detail: `${hookPath} ${facts.kind === "missing" ? "is absent" : "is not a regular file"}` })
	else if (!executable) warnings.push({ code: "GUARD_MISSING", detail: `${hookPath} is not executable` })
	let current: boolean | null = null
	const source = join(vault, hookSourceRelative)
	if (installed && rt.fileFacts(source).kind === "file") {
		const installedHash = rt.sha256File(hookPath)
		const sourceHash = rt.sha256File(source)
		current = installedHash === sourceHash
		if (!current) warnings.push({ code: "GUARD_STALE", detail: `installed ${installedHash.slice(0, 12)} differs from scripts/git-hooks/${hookName} ${sourceHash.slice(0, 12)}` })
	}
	return { hookPath, installed, executable, current, hooksPathOverride, warnings }
}

// Two direct hook executions before any lock (GUARD-INTERACTION.md section 3). Refuses only when the gate denies a
// Vault Steward line; every other surprise is a warning and the command proceeds (fail-open symmetry).
interface SelfTestOutcome {
	selfTest: SelfTest
	// The Vault Steward ref the installed hook denied, when incompatible.
	deniedRef: string | null
}

function selfTest(rt: Runtime, location: HookLocation, input: GuardInput, warnings: Warning[]): SelfTestOutcome {
	if (!location.installed || !location.executable) return { selfTest: "missing", deniedRef: null }
	const main = gitQuiet(rt, input.vault, ["rev-parse", "refs/heads/main"])
	if (main.exitCode !== 0) return { selfTest: "skipped", deniedRef: null }
	const mainSha = main.stdout.trim()
	const candidate = input.candidateCommit ?? mainSha
	const completionRef = `refs/vault-note-commits/${input.runId}`
	const probeRef = `refs/heads/probe-${input.runId}`
	const allow = classifyAllowRun(runHook(rt, location.hookPath, input.vault, [`${zeroSha} ${candidate} ${completionRef}`, `${mainSha} ${candidate} refs/heads/main`]), [completionRef, "refs/heads/main"])
	if (allow.selfTest === "incompatible") return { selfTest: "incompatible", deniedRef: allow.ref }
	if (allow.selfTest === "error") {
		warnings.push({ code: "GUARD_SELFTEST_ERROR", detail: allow.detail })
		return { selfTest: "error", deniedRef: null }
	}
	const probe = classifyProbeRun(runHook(rt, location.hookPath, input.vault, [`${zeroSha} ${candidate} ${probeRef}`]), probeRef)
	if (probe.selfTest === "probe-allowed") warnings.push({ code: "GUARD_PROBE_ALLOWED", detail: probe.detail })
	if (probe.selfTest === "error") warnings.push({ code: "GUARD_SELFTEST_ERROR", detail: probe.detail })
	return { selfTest: probe.selfTest, deniedRef: null }
}

function observeSprawl(rt: Runtime, input: GuardInput, warnings: Warning[]): { branches: string[]; worktrees: string[] } {
	const refs = gitQuiet(rt, input.vault, ["for-each-ref", "--format=%(refname)", "refs/heads"])
	const branches = sprawlBranches(refs.stdout.split("\n").map((line) => line.trim()))
	if (branches.length > 0) warnings.push({ code: "BRANCH_SPRAWL_PRESENT", detail: branches.join(", ") })
	const list = gitQuiet(rt, input.vault, ["worktree", "list", "--porcelain"])
	const paths = list.stdout
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length))
		.map((path) => {
			try {
				return rt.realpath(path)
			} catch {
				return path
			}
		})
	const worktrees = foreignWorktrees(paths, input.vault, input.candidateRoot)
	if (worktrees.length > 0) warnings.push({ code: "FOREIGN_WORKTREE_PRESENT", detail: worktrees.join(", ") })
	return { branches, worktrees }
}

// Location, staleness, hooksPath, self-test, sprawl, foreign worktrees: the full observation every command makes
// unless a valid receipt already short-circuits it (GUARD-INTERACTION.md section 4).
export function observeGuard(rt: Runtime, input: GuardInput, enforce = true): GuardObservation {
	const location = locateHook(rt, input.vault)
	const warnings = [...location.warnings]
	const tested = selfTest(rt, location, input, warnings)
	const sprawl = observeSprawl(rt, input, warnings)
	const guard: GuardStatus = {
		installed: location.installed,
		executable: location.executable,
		hookPath: location.hookPath,
		current: location.current,
		selfTest: tested.selfTest,
		hooksPathOverride: location.hooksPathOverride,
		branches: sprawl.branches,
		worktrees: sprawl.worktrees,
	}
	const observation = { guard, warnings }
	// The refusal carries the full observation so the front door still reports guard status on this path (A2).
	if (enforce && tested.deniedRef !== null) refuse("guard-incompatible", { ...input.facts, ref: tested.deniedRef, runId: input.runId, guard: observation })
	return observation
}
