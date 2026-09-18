// The vault-note-commits front door: legacy pairwise parser, schemaVersion 1 envelope, exit 0/1, and the legacy
// stream rules (CONTRACT.md section 4). It sequences the shared engine in the legacy order and maps engine refusals
// to legacy codes. Allowed differences from 0.12.0 are listed in CONTRACT.md 4.2 (A1 to A7) and documented for
// callers in skills/vault-note-commits/references/guardrails.md.
import { isAbsolute, join, resolve } from "node:path"
import {
	canonicalVault,
	completeWithoutIntegration,
	configuredVault,
	createCandidate,
	gitQuiet,
	integrate,
	type IntegrationResult,
	planCandidate,
	readManifest,
	readReceipt,
	Refusal,
	stateRoot,
	validateCandidate,
	vaultIdentity,
} from "../engine.ts"
import { observeGuard } from "../guard.ts"
import type { GuardObservation, Manifest, ReceiptCode, RefusalFacts, RefusalReason, ValidReceipt } from "../model.ts"
import { createRuntime, type Runtime } from "../runtime.ts"

const schemaVersion = 1 as const

type Command = "begin" | "finish" | "help"
type State = "none" | "partial" | "complete"

interface LegacyGuard {
	installed: boolean
	current: boolean | null
	selfTest: string
	hookPath: string | null
	branches: string[]
	worktrees: string[]
}

interface Result {
	schemaVersion: 1
	ok: boolean
	command: Command
	code: string
	runId: string | null
	changedState: State
	sideEffects: string[]
	retrySafe: boolean
	nextAction: string
	worktree?: string | undefined
	commit?: string | undefined
	paths?: string[] | undefined
	receipt?: string | undefined
	originalCode?: ReceiptCode
	diagnostics?: string[] | undefined
	diagnosticsPath?: string | undefined
	guard?: LegacyGuard
	warnings?: string[]
}

type Extra = Partial<Omit<Result, "schemaVersion" | "ok" | "command" | "code" | "runId" | "nextAction">>

class LegacyRefusal extends Error {
	constructor(readonly result: Result) {
		super(result.code)
	}
}

function outcome(ok: boolean, command: Command, code: string, runId: string | null, nextAction: string, extra: Extra = {}): Result {
	return { schemaVersion, ok, command, code, runId, changedState: "none", sideEffects: [], retrySafe: true, nextAction, ...extra }
}

function refuse(command: Command, code: string, runId: string | null, nextAction: string, extra: Extra = {}): never {
	throw new LegacyRefusal(outcome(false, command, code, runId, nextAction, extra))
}

// ---------------------------------------------------------------------------------------------------------------------
// Legacy parser (pairwise strict)

function flags(args: string[], allowed: Set<string>, command: "begin" | "finish"): Map<string, string[]> {
	const parsed = new Map<string, string[]>()
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index]
		const value = args[index + 1]
		if (key === undefined || value === undefined || !allowed.has(key) || value.startsWith("--")) {
			refuse(command, "INVALID_USAGE", null, "Run vault-note-commits --help and use the documented flags.")
		}
		parsed.set(key, [...(parsed.get(key) ?? []), value])
	}
	return parsed
}

function one(parsed: Map<string, string[]>, key: string, command: "begin" | "finish"): string {
	const values = parsed.get(key) ?? []
	const value = values[0]
	if (values.length !== 1 || value === undefined) {
		refuse(command, "INVALID_USAGE", null, `Provide ${key} exactly once.`)
	}
	return value
}

// ---------------------------------------------------------------------------------------------------------------------
// Engine refusal to legacy envelope (CONTRACT.md 4.1 reverse map)

function preserved(facts: RefusalFacts, retrySafe: boolean, commit?: string): Extra {
	return {
		changedState: "partial",
		sideEffects: [commit ? "candidate-commit-preserved" : "candidate-worktree-preserved"],
		retrySafe,
		worktree: facts.worktree,
		commit,
		paths: facts.paths,
	}
}

function beginCreated(facts: RefusalFacts): Extra {
	return facts.worktreeCreated ? { changedState: "partial", sideEffects: ["candidate-worktree-created"], worktree: facts.worktree } : {}
}

const guardRepair = "Repair the installed reference-transaction hook with 'bun run guard:install' in the vault, then rerun finish with the same worktree."

type Render = (facts: RefusalFacts, command: Command) => Result

const beginRefusal = (code: string, nextAction: string): Render => () => outcome(false, "begin", code, null, nextAction)
const finishPreserved = (code: string, nextAction: string, retrySafe: boolean, withCommit = true): Render => (facts) =>
	outcome(false, "finish", code, facts.runId ?? null, nextAction, preserved(facts, retrySafe, withCommit ? facts.commit : undefined))

// Each engine reason renders exactly one legacy code; the strings are the 0.12.0 strings (CONTRACT.md 2.5). The record
// is total over the reason vocabulary, so a new engine reason is a compile error here until it is mapped.
const legacyRender: Record<RefusalReason, Render> = {
	"config-home-invalid": beginRefusal("CONFIG_HOME_INVALID", "Set XDG_CONFIG_HOME to an absolute path or set HOME, then retry begin."),
	"config-absent": (facts) => outcome(false, "begin", "CONFIG_MISSING", null, `Create ${facts.detail} with the playground vault path, then retry begin.`),
	"config-unparseable": (facts) => outcome(false, "begin", "CONFIG_MISSING", null, `Create ${facts.detail} with the playground vault path, then retry begin.`),
	"config-off-schema": (facts) => outcome(false, "begin", "CONFIG_INVALID", null, `Repair ${facts.detail} to contain only schemaVersion 1 and one absolute vault path.`),
	"vault-not-found": beginRefusal("VAULT_NOT_FOUND", "Provide an existing vault checkout with --vault."),
	"not-canonical-main": beginRefusal("NOT_CANONICAL_MAIN", "Run begin from the root checkout while it has main checked out."),
	"path-form-invalid": beginRefusal("INVALID_PATH", "Use non-empty paths relative to the vault root."),
	"path-escapes-vault": beginRefusal("INVALID_PATH", "Keep every admitted path inside the vault."),
	"path-symlink-component": beginRefusal("SYMLINK_PATH_UNSUPPORTED", "Use a path whose existing components are not symbolic links."),
	"state-home-missing": (_facts, command) => outcome(false, command, "STATE_HOME_MISSING", null, "Set an absolute XDG_STATE_HOME or HOME, then retry."),
	"git-failed": (facts, command) =>
		command === "begin"
			? outcome(false, "begin", "GIT_FAILED", facts.runId ?? null, "Confirm the vault is a healthy local Git checkout, then retry begin.", beginCreated(facts))
			: outcome(false, "finish", "GIT_FAILED", facts.runId ?? null, "Inspect the preserved candidate and local Git state before retrying finish.", {
					changedState: "partial",
					sideEffects: ["candidate-worktree-preserved"],
					retrySafe: false,
				}),
	"candidate-not-found": () => outcome(false, "finish", "CANDIDATE_NOT_FOUND", null, "Run begin to create a new candidate."),
	"manifest-invalid": (facts) =>
		outcome(false, "finish", "MANIFEST_INVALID", facts.runId ?? null, "Preserve the candidate and inspect its Git metadata before continuing.", {
			changedState: "partial",
			sideEffects: ["candidate-worktree-preserved"],
			retrySafe: false,
			worktree: facts.worktree,
		}),
	"receipt-invalid": (facts) =>
		outcome(false, "finish", "RECEIPT_INVALID", null, "Preserve the receipt and inspect its identity and local Git evidence before continuing.", {
			retrySafe: false,
			receipt: facts.receipt,
			worktree: facts.worktree,
		}),
	"guard-incompatible": (facts) =>
		outcome(false, "finish", "GUARD_INCOMPATIBLE", facts.runId ?? null, guardRepair, {
			changedState: "none",
			sideEffects: ["candidate-worktree-preserved"],
			retrySafe: true,
			worktree: facts.worktree,
			paths: facts.paths,
		}),
	"candidate-changed-after-commit": finishPreserved("CANDIDATE_CHANGED_AFTER_COMMIT", "Inspect and restore the candidate to its committed state before retrying.", false),
	"candidate-history-invalid": finishPreserved("CANDIDATE_HISTORY_INVALID", "Inspect the candidate history before continuing.", false),
	"check-changed-candidate": finishPreserved("CHECK_CHANGED_CANDIDATE", "The checker changed the committed candidate. Inspect those changes before retrying.", false),
	"path-set-mismatch": finishPreserved("PATH_SET_MISMATCH", "Change exactly the paths admitted by begin, then retry finish.", true, false),
	"path-set-changed-by-checker": finishPreserved("PATH_SET_MISMATCH", "The checker changed the admitted file set. Inspect the candidate and restore the intended scope before retrying.", true, false),
	"check-failed": checkFailed,
	"rebased-check-failed": checkFailed,
	"format-failed": (facts) =>
		outcome(false, "finish", "FORMAT_FAILED", facts.runId ?? null, "Fix the reported whitespace in the admitted candidate files, then retry finish.", facts.afterRebase
			? { ...preserved(facts, true, facts.commit), diagnostics: facts.diagnostics }
			: { changedState: "partial", sideEffects: ["candidate-worktree-preserved"], worktree: facts.worktree, paths: facts.paths, diagnostics: facts.diagnostics }),
	"integration-busy": finishPreserved("INTEGRATION_BUSY", "Wait for the active finisher to release the local integration lock, then retry.", true, false),
	"canonical-not-ready": finishPreserved("CANONICAL_NOT_READY", "Restore a clean canonical main checkout, then retry finish.", true),
	"main-diverged": finishPreserved("MAIN_DIVERGED", "Preserve the candidate and reconcile canonical main before continuing.", false),
	"semantic-overlap": (facts) =>
		outcome(false, "finish", "SEMANTIC_OVERLAP", facts.runId ?? null, `Resolve the concurrent changes to ${(facts.overlap ?? []).join(", ")} with Nathan.`, preserved(facts, false, facts.commit)),
	"rebase-failed": finishPreserved("REBASE_FAILED", "Preserve the candidate and inspect its relationship to canonical main.", false),
	"rebased-path-set-mismatch": finishPreserved("REBASED_PATH_SET_MISMATCH", "Preserve the candidate and inspect its rebased commit before continuing.", false),
	"integration-unproved": finishPreserved("INTEGRATION_UNPROVED", "Inspect canonical main and the candidate before taking another action.", false),
	"completion-record-failed": (facts) =>
		outcome(false, "finish", "COMPLETION_RECORD_FAILED", facts.runId ?? null, facts.afterFastForward
			? "The commit reached main but its receipt could not be saved. Inspect main and the preserved candidate before retrying."
			: "No note changed but its receipt could not be saved. Preserve the candidate and inspect local state before retrying.", preserved(facts, false, facts.commit)),
	unexpected: unexpectedFailure,
	// Preview and recovery reasons belong to the Vault Steward 2.0 front door; the alias binds its own preview in one
	// process, so reaching one here is an internal error (CONTRACT.md 4.1).
	"preview-not-found": unexpectedFailure,
	"preview-consumed": unexpectedFailure,
	"preview-stale": unexpectedFailure,
	"preview-invalid": unexpectedFailure,
	"recovery-unprovable": unexpectedFailure,
	"input-invalid": (_facts, command) => outcome(false, command, "INVALID_USAGE", null, "Run vault-note-commits --help and use the documented flags."),
}

function unexpectedFailure(facts: RefusalFacts, command: Command): Result {
	return outcome(false, command, "UNEXPECTED_FAILURE", facts.runId ?? null, "Preserve any candidate worktree and inspect the local error before retrying.", { retrySafe: false, ...beginCreated(facts) })
}

function checkFailed(facts: RefusalFacts): Result {
	return outcome(false, "finish", "CHECK_FAILED", facts.runId ?? null, "Read the private checker diagnostics, fix the admitted files in the candidate, then retry finish.", {
		changedState: "partial",
		sideEffects: ["candidate-worktree-preserved", "checker-diagnostics-written"],
		worktree: facts.worktree,
		paths: facts.paths,
		diagnosticsPath: facts.diagnosticsPath,
	})
}

function renderRefusal(command: Command, refusal: Refusal): Result {
	return legacyRender[refusal.reason](refusal.facts, command)
}

// ---------------------------------------------------------------------------------------------------------------------
// Commands

// Guard facts observed by this process; appended to every result rendered after the observation (CONTRACT.md 4.2 A2).
let observation: GuardObservation | undefined

function candidateRoot(rt: Runtime, vault: string): string {
	const root = stateRoot(rt)
	let resolved: string
	try {
		resolved = rt.realpath(root)
	} catch {
		resolved = root
	}
	return join(resolved, vaultIdentity(vault))
}

function begin(rt: Runtime, args: string[]): Result {
	const parsed = flags(args, new Set(["--vault", "--path"]), "begin")
	const vaultValues = parsed.get("--vault") ?? []
	if (vaultValues.length > 1) refuse("begin", "INVALID_USAGE", null, "Provide --vault at most once.")
	const vault = canonicalVault(rt, vaultValues[0] ?? configuredVault(rt))
	const requested = parsed.get("--path") ?? []
	if (requested.length === 0) refuse("begin", "INVALID_USAGE", null, "Provide at least one --path.")
	const plan = planCandidate(rt, vault, requested)
	observation = observeGuard(rt, { vault, candidateRoot: candidateRoot(rt, vault), runId: plan.runId })
	const { manifest } = createCandidate(rt, plan)
	return outcome(true, "begin", "CANDIDATE_READY", manifest.runId, "Edit only the admitted paths in the returned worktree, then run finish.", {
		changedState: "partial",
		sideEffects: ["candidate-worktree-created"],
		worktree: manifest.worktree,
		paths: manifest.paths,
	})
}

function renderReceipt(rt: Runtime, worktree: string, valid: ValidReceipt): Result {
	const { receipt, path } = valid
	return outcome(true, "finish", "ALREADY_COMPLETED", receipt.runId, rt.exists(worktree)
		? "Completion is recorded. Inspect the retained candidate before removing it; no new write was performed."
		: "The original finish completed. No new write was performed.", {
		originalCode: receipt.code, worktree, commit: receipt.commit, paths: receipt.paths, receipt: path,
	})
}

// `recovered`: the fast-forward happened in an earlier crashed run (hazard H1); this run wrote only the record.
function renderIntegration(rt: Runtime, manifest: Manifest, result: IntegrationResult, recovered = false): Result {
	if (result.kind === "receipt") return renderReceipt(rt, manifest.worktree, result.receipt)
	const { code, commit, receipt, removed } = result.completion
	return outcome(true, "finish", code, manifest.runId, removed
		? commit ? "Run remote sync separately when you want to publish main." : "No candidate changes were authored. This does not verify the freshness of canonical notes."
		: "Completion is recorded. Inspect the retained candidate before removing it.", {
		changedState: commit ? "complete" : "none",
		sideEffects: [...(commit && !recovered ? ["canonical-main-fast-forwarded"] : []), "completion-reference-written", "completion-receipt-written", ...(removed ? ["candidate-worktree-removed"] : [])],
		worktree: manifest.worktree, commit, paths: manifest.paths, receipt,
	})
}

// The candidate commit when the candidate is already committed (self-test line C), else undefined.
function knownCandidateCommit(rt: Runtime, manifest: Manifest): string | undefined {
	const head = gitQuiet(rt, manifest.worktree, ["rev-parse", "HEAD"])
	const sha = head.stdout.trim()
	return head.exitCode === 0 && sha !== manifest.baseCommit ? sha : undefined
}

function finish(rt: Runtime, args: string[]): Result {
	const parsed = flags(args, new Set(["--worktree", "--message"]), "finish")
	const worktree = one(parsed, "--worktree", "finish")
	const message = one(parsed, "--message", "finish").trim()
	if (!message || message.includes("\n")) refuse("finish", "INVALID_USAGE", null, "Provide one non-empty commit subject with --message.")
	if (!isAbsolute(worktree) || resolve(worktree) !== worktree) refuse("finish", "INVALID_USAGE", null, "Use the exact absolute worktree path returned by begin.")
	const completed = readReceipt(rt, worktree)
	if (completed) return renderReceipt(rt, worktree, completed)
	const manifest = readManifest(rt, worktree)
	// One self-test per finish process, after the manifest read and before the candidate commit and the lock (A1).
	observation = observeGuard(rt, {
		vault: manifest.vault,
		candidateRoot: candidateRoot(rt, manifest.vault),
		runId: manifest.runId,
		candidateCommit: knownCandidateCommit(rt, manifest),
		facts: { worktree: manifest.worktree, paths: manifest.paths },
	})
	const state = validateCandidate(rt, manifest, message)
	const result = state.kind === "commit"
		? integrate(rt, manifest, state.commit)
		: completeWithoutIntegration(rt, manifest, state.kind === "already-on-main" ? state.commit : undefined)
	return renderIntegration(rt, manifest, result, state.kind === "already-on-main")
}

const usage = `Vault Note Commits

Usage:
  vault-note-commits begin [--vault <path>] --path <relative-path> [--path <relative-path>...] [--json]
  vault-note-commits finish --worktree <path> --message <subject> [--json]

begin creates a detached candidate worktree from local main. finish admits exactly the declared paths,
runs bun run check and Git whitespace checks including new files, creates one commit,
and integrates it into a clean canonical main checkout.
Disjoint candidates rebase onto newer local main; overlapping paths stop for semantic resolution.
Unchanged candidates return NO_CHANGES without a commit. Partially changed declared sets still refuse.
Completion receipts are stored in private XDG state before candidate cleanup. Retry finish with the
same absolute worktree path to recover ALREADY_COMPLETED, originalCode, and the original commit.
Retries perform no new write. A crash before receipt persistence still requires inspection.
Without --vault, begin reads ~/.config/my-second-brain-playground/vault.json (or XDG_CONFIG_HOME).
Remote sync is a separate operation.`

function runCommand(rt: Runtime, command: string, args: string[]): Result {
	if (command === "begin") return begin(rt, args)
	if (command === "finish") return finish(rt, args)
	return refuse("help", "INVALID_USAGE", null, "Run vault-note-commits --help.")
}

function failureResult(command: string | undefined, error: unknown): Result {
	const safeCommand = command === "begin" || command === "finish" ? command : "help"
	if (error instanceof LegacyRefusal) return error.result
	if (error instanceof Refusal) {
		if (error.facts.guard) observation = error.facts.guard
		return renderRefusal(safeCommand, error)
	}
	return outcome(false, safeCommand, "UNEXPECTED_FAILURE", null, "Preserve any candidate worktree and inspect the local error before retrying.", { retrySafe: false })
}

// Additive fields (A2, A3): the observed guard status and warning codes, never bumping schemaVersion.
function withObservation(result: Result): Result {
	if (!observation) return result
	const { guard, warnings } = observation
	result.guard = { installed: guard.installed, current: guard.current, selfTest: guard.selfTest, hookPath: guard.hookPath, branches: guard.branches, worktrees: guard.worktrees }
	if (warnings.length > 0) result.warnings = warnings.map((warning) => warning.code)
	return result
}

function printWarnings(): void {
	for (const warning of observation?.warnings ?? []) console.error(`warning: ${warning.code} ${warning.detail}`)
}

function printFailure(result: Result, json: boolean): void {
	if (json) console.log(JSON.stringify(result))
	else console.error(`${result.code}: ${result.nextAction}`)
	if (result.diagnostics?.length) console.error(result.diagnostics.join("\n"))
	if (!json) printWarnings()
	process.exitCode = 1
}

function main(): void {
	const raw = process.argv.slice(2)
	const json = raw.includes("--json")
	const args = raw.filter((argument) => argument !== "--json")
	const command = args.shift()
	if (command === "--help" || command === "-h" || command === undefined) {
		console.log(usage)
		return
	}
	const rt = createRuntime()
	try {
		const result = withObservation(runCommand(rt, command, args))
		console.log(json ? JSON.stringify(result) : `${result.code}: ${result.nextAction}`)
		if (!json) printWarnings()
	} catch (error) {
		printFailure(withObservation(failureResult(command, error)), json)
	}
}

main()
