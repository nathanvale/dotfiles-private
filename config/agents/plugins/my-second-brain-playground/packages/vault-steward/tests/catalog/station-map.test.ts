import { afterAll, expect, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { STATION_IDS } from "../../src/branch-station-catalog.ts"
import { BRANCH_STATIONS, type CatalogueObservation, validateCatalogue } from "../../src/station-catalogue.ts"
import { HOOK_TEXT } from "../guard/hook-text.ts"
import { cleanupFixtures, type Fixture, fixture, git, installHook, write } from "../helpers/harness.ts"
import { data, observationOf, steward, stewardEnvironment, type StewardRun } from "../helpers/steward.ts"
import { EXPECTED_BY_IDENTITY, EXPECTED_STATION_COUNT, identityOf } from "./expected-station-semantics.ts"

// Strict new-project catalogue qualification: every declared required station is reached by a real child process,
// every observed station is declared with agreeing fields, every declared next action and product reason is observed,
// and the declared-unreachable station is never observed. Expected causes, exits, reasons and next actions per scenario
// are literals; the production catalogue is enumerated only to cross-check completeness.

afterAll(cleanupFixtures)

interface Scenario {
	name: string
	run: () => StewardRun
	cause: string
	exit: number
	reason?: string
	nextAction?: string
	handoffOwner?: string
	transaction?: string
}

const BEGIN = "vault-steward.begin"
const PREVIEW = "vault-steward.finish-preview"
const APPLY = "vault-steward.finish-apply"
const INSPECT = "vault-steward.inspect"
const RECOVER = "vault-steward.recover"
const HELP = "vault-steward.help"

const HOSTILE_HOOK = HOOK_TEXT.replace("    refs/heads/main) ;;\n", "    refs/heads/main) ;;\n    refs/vault-note-commits/*)\n      printf 'VAULT_GUARD_BRANCH_CREATE_DENIED %s\\n' \"$ref\" >&2\n      exit 1 ;;\n")

function run(f: Fixture, args: string[], extra: Record<string, string> = {}): StewardRun {
	return steward(f.vault, args, stewardEnvironment(f, extra))
}

function beginCandidate(f: Fixture, path = "projects/demo/GOAL.md", contents: string | null = "# Goal\n\nCompleted.\n"): string {
	const started = run(f, ["begin", "--vault", f.vault, "--path", path])
	const worktree = (data(started).candidate as { worktree: string }).worktree
	if (contents !== null) write(worktree, path, contents)
	return worktree
}

function previewCandidate(f: Fixture, worktree: string, message = "docs: change"): string {
	const previewed = run(f, ["finish", "--preview", "--worktree", worktree, "--message", message])
	return data(previewed).previewId as string
}

function applied(f: Fixture): { worktree: string; previewId: string } {
	const worktree = beginCandidate(f)
	const previewId = previewCandidate(f, worktree)
	const result = run(f, ["finish", "--apply", "--preview-id", previewId, "--worktree", worktree])
	if (result.envelope?.result.causeCode !== "SUCCESS_COMPLETED") throw new Error(`apply failed: ${result.stdout}`)
	return { worktree, previewId }
}

function receiptPathOf(f: Fixture, worktree: string): string {
	const hash = new Bun.CryptoHasher("sha256").update(worktree).digest("hex")
	return join(f.state, "my-second-brain", "vault-note-commits", "receipts", `${hash}.json`)
}

function manifestPathOf(worktree: string): string {
	return join(git(worktree, "rev-parse", "--absolute-git-dir"), "vault-note-commit.json")
}

function previewPathOf(f: Fixture, worktree: string): string {
	const manifest = JSON.parse(readFileSync(manifestPathOf(worktree), "utf8")) as { runId: string }
	return join(f.state, "my-second-brain", "vault-note-commits", "previews", `${manifest.runId}.json`)
}

// Hold the integration lock with this (live) process as owner; a crashed apply may have left the directory behind.
function holdLock(f: Fixture): void {
	const lock = join(f.vault, ".git", "vault-note-commits.lock")
	mkdirSync(lock, { recursive: true })
	write(lock, "owner.json", `${JSON.stringify({ schemaVersion: 1, runId: "another", pid: process.pid })}\n`)
}

// A candidate whose apply crashed after the fast-forward (halt=after-ff-merge leaves no envelope).
function crashedAfterFastForward(f: Fixture): string {
	const worktree = beginCandidate(f)
	const previewId = previewCandidate(f, worktree)
	const crashed = run(f, ["finish", "--apply", "--preview-id", previewId, "--worktree", worktree], { VAULT_STEWARD_FAULT: "halt=after-ff-merge" })
	if (crashed.signal !== "SIGKILL") throw new Error(`expected the halt fault to kill the apply, got ${crashed.stdout}`)
	return worktree
}

function rebasePlan(f: Fixture, mainFile = "README.md", contents = "# Fixture vault\n\nMoved.\n"): { worktree: string; previewId: string } {
	const worktree = beginCandidate(f)
	write(f.vault, mainFile, contents)
	git(f.vault, "add", "--", mainFile)
	git(f.vault, "commit", "-m", "docs: main moves")
	return { worktree, previewId: previewCandidate(f, worktree) }
}

function withConfig(f: Fixture, payload: string): Record<string, string> {
	mkdirSync(join(f.root, "config", "my-second-brain-playground"), { recursive: true })
	writeFileSync(join(f.root, "config", "my-second-brain-playground", "vault.json"), payload)
	return {}
}

const scenarios: Scenario[] = [
	// Built-ins and dispatch
	{ name: "help json", run: () => run(fixture(), ["--help"]), cause: "SUCCESS_UNCHANGED", exit: 0, nextAction: "vault-steward.discovery" },
	{ name: "help with stray option", run: () => run(fixture(), ["--help", "--bogus"]), cause: "USAGE_INVALID_INVOCATION", exit: 2, reason: "USAGE_INVALID_INVOCATION", nextAction: HELP },
	{ name: "discover json", run: () => run(fixture(), ["--discover"]), cause: "SUCCESS_UNCHANGED", exit: 0, nextAction: "vault-steward.command-discovery" },
	{ name: "discover with positional", run: () => run(fixture(), ["--discover", "extra"]), cause: "USAGE_INVALID_INVOCATION", exit: 2, reason: "USAGE_INVALID_INVOCATION", nextAction: HELP },
	...["vault-steward.begin", "vault-steward.command-discovery", "vault-steward.discovery", "vault-steward.dispatch", "vault-steward.finish-apply", "vault-steward.finish-preview", "vault-steward.help", "vault-steward.inspect", "vault-steward.recover"].map(
		(identity): Scenario => ({ name: `discover-command ${identity}`, run: () => run(fixture(), ["--discover-command", identity]), cause: "SUCCESS_UNCHANGED", exit: 0, nextAction: identity }),
	),
	{ name: "discover-command unknown", run: () => run(fixture(), ["--discover-command", "vault-steward.nope"]), cause: "USAGE_UNKNOWN_COMMAND", exit: 2, reason: "USAGE_UNKNOWN_COMMAND", nextAction: "vault-steward.discovery" },
	{ name: "discover-command with stray option", run: () => run(fixture(), ["--discover-command", "vault-steward.begin", "--vault", "/x"]), cause: "USAGE_INVALID_INVOCATION", exit: 2, reason: "USAGE_INVALID_INVOCATION", nextAction: HELP },
	{ name: "dispatch nothing", run: () => run(fixture(), []), cause: "USAGE_INVALID_INVOCATION", exit: 2, reason: "USAGE_INVALID_INVOCATION", nextAction: HELP },
	{ name: "dispatch conflicting built-ins", run: () => run(fixture(), ["--help", "--discover"]), cause: "USAGE_INVALID_INVOCATION", exit: 2, nextAction: HELP },
	{ name: "dispatch unknown word", run: () => run(fixture(), ["frobnicate"]), cause: "USAGE_UNKNOWN_COMMAND", exit: 2, reason: "USAGE_UNKNOWN_COMMAND", nextAction: HELP },
	// begin
	{ name: "begin completed", run: () => { const f = fixture(); return run(f, ["begin", "--vault", f.vault, "--path", "projects/demo/GOAL.md"]) }, cause: "SUCCESS_COMPLETED", exit: 0, nextAction: PREVIEW, transaction: "completed" },
	{ name: "begin preview", run: () => { const f = fixture(); return run(f, ["begin", "--vault", f.vault, "--path", "projects/demo/GOAL.md", "--preview"]) }, cause: "SUCCESS_UNCHANGED", exit: 0, nextAction: BEGIN },
	{ name: "begin without path", run: () => { const f = fixture(); return run(f, ["begin", "--vault", f.vault]) }, cause: "USAGE_INVALID_INVOCATION", exit: 2, reason: "USAGE_INVALID_INVOCATION", nextAction: HELP },
	{ name: "begin relative vault", run: () => run(fixture(), ["begin", "--vault", "relative", "--path", "a.md"]), cause: "SCHEMA_INVALID_INPUT", exit: 4, reason: "SCHEMA_INVALID_INPUT", nextAction: HELP },
	{ name: "begin empty path", run: () => { const f = fixture(); return run(f, ["begin", "--vault", f.vault, "--path", ""]) }, cause: "SCHEMA_INVALID_INPUT", exit: 4, reason: "SCHEMA_INVALID_INPUT", nextAction: HELP },
	{ name: "begin off-schema config", run: () => { const f = fixture(); return run(f, ["begin", "--path", "a.md"], withConfig(f, JSON.stringify({ schemaVersion: 2, vault: f.vault }))) }, cause: "SCHEMA_INVALID_INPUT", exit: 4, reason: "SCHEMA_CONFIG_INVALID", nextAction: HELP },
	{ name: "begin config missing", run: () => run(fixture(), ["begin", "--path", "a.md"]), cause: "DOMAIN_PRECONDITION_UNMET", exit: 3, reason: "DOMAIN_CONFIG_MISSING", nextAction: BEGIN },
	{ name: "begin vault not found", run: () => run(fixture(), ["begin", "--vault", "/nonexistent/vault", "--path", "a.md"]), cause: "DOMAIN_PRECONDITION_UNMET", exit: 3, reason: "DOMAIN_VAULT_NOT_FOUND", nextAction: BEGIN },
	{ name: "begin not on main", run: () => { const f = fixture(); git(f.vault, "-c", "core.hooksPath=/nonexistent", "checkout", "-q", "-b", "side"); return run(f, ["begin", "--vault", f.vault, "--path", "a.md"]) }, cause: "DOMAIN_PRECONDITION_UNMET", exit: 3, reason: "DOMAIN_CANONICAL_NOT_MAIN", nextAction: BEGIN },
	{ name: "begin path escapes", run: () => { const f = fixture(); return run(f, ["begin", "--vault", f.vault, "--path", "../outside.md"]) }, cause: "DOMAIN_PRECONDITION_UNMET", exit: 3, reason: "DOMAIN_PATH_REFUSED", nextAction: BEGIN },
	{ name: "begin git failed before worktree", run: () => { const f = fixture(); return run(f, ["begin", "--vault", f.vault, "--path", "a.md"], { VAULT_STEWARD_FAULT: "git-failure=rev-parse --show-toplevel" }) }, cause: "INTERNAL_RESULT_UNCHANGED", exit: 1, reason: "INTERNAL_GIT_FAILED_UNCHANGED", handoffOwner: "operator" },
	{ name: "begin git failed after worktree", run: () => { const f = fixture(); return run(f, ["begin", "--vault", f.vault, "--path", "a.md"], { VAULT_STEWARD_FAULT: "git-failure=--git-common-dir" }) }, cause: "INTERNAL_RESULT_PARTIAL", exit: 1, reason: "INTERNAL_GIT_FAILED_PARTIAL", handoffOwner: "operator", transaction: "partially-completed" },
	{ name: "begin unexpected after worktree", run: () => { const f = fixture(); return run(f, ["begin", "--vault", f.vault, "--path", "a.md"], { VAULT_STEWARD_FAULT: "unexpected=--git-common-dir" }) }, cause: "INTERNAL_RESULT_UNKNOWN", exit: 1, reason: "INTERNAL_UNEXPECTED_UNKNOWN", handoffOwner: "operator", transaction: "unknown" },
	{ name: "begin unexpected before worktree", run: () => { const f = fixture(); return run(f, ["begin", "--vault", f.vault, "--path", "a.md"], { VAULT_STEWARD_FAULT: "unexpected=rev-parse --show-toplevel" }) }, cause: "INTERNAL_UNEXPECTED", exit: 1, reason: "INTERNAL_UNEXPECTED_UNCHANGED", handoffOwner: "operator" },
	// finish --preview
	{ name: "preview completed", run: () => { const f = fixture(); const w = beginCandidate(f); return run(f, ["finish", "--preview", "--worktree", w, "--message", "docs: change"]) }, cause: "SUCCESS_COMPLETED", exit: 0, nextAction: APPLY, transaction: "completed" },
	{ name: "preview after completion", run: () => { const f = fixture(); const { worktree } = applied(f); return run(f, ["finish", "--preview", "--worktree", worktree, "--message", "docs: again"]) }, cause: "SUCCESS_UNCHANGED", exit: 0, nextAction: INSPECT },
	{ name: "preview without message", run: () => { const f = fixture(); return run(f, ["finish", "--preview", "--worktree", f.vault]) }, cause: "USAGE_INVALID_INVOCATION", exit: 2, reason: "USAGE_INVALID_INVOCATION", nextAction: HELP },
	{ name: "preview relative worktree", run: () => run(fixture(), ["finish", "--preview", "--worktree", "relative", "--message", "x"]), cause: "SCHEMA_INVALID_INPUT", exit: 4, reason: "SCHEMA_INVALID_INPUT", nextAction: HELP },
	{ name: "preview corrupt manifest", run: () => { const f = fixture(); const w = beginCandidate(f); writeFileSync(manifestPathOf(w), "{broken"); return run(f, ["finish", "--preview", "--worktree", w, "--message", "x"]) }, cause: "SCHEMA_INVALID_INPUT", exit: 4, reason: "SCHEMA_MANIFEST_INVALID", nextAction: INSPECT },
	{ name: "preview corrupt receipt", run: () => { const f = fixture(); const { worktree } = applied(f); writeFileSync(receiptPathOf(f, worktree), "{broken"); return run(f, ["finish", "--preview", "--worktree", worktree, "--message", "x"]) }, cause: "SCHEMA_INVALID_INPUT", exit: 4, reason: "SCHEMA_RECEIPT_INVALID", nextAction: INSPECT },
	{ name: "preview candidate not found", run: () => { const f = fixture(); return run(f, ["finish", "--preview", "--worktree", join(f.root, "absent"), "--message", "x"]) }, cause: "DOMAIN_PRECONDITION_UNMET", exit: 3, reason: "DOMAIN_CANDIDATE_NOT_FOUND", nextAction: BEGIN },
	{ name: "preview main absent", run: () => { const f = fixture(); const w = beginCandidate(f); git(f.vault, "branch", "-m", "main", "renamed"); return run(f, ["finish", "--preview", "--worktree", w, "--message", "x"]) }, cause: "DOMAIN_PRECONDITION_UNMET", exit: 3, reason: "DOMAIN_CANONICAL_NOT_MAIN", nextAction: BEGIN },
	{ name: "preview guard incompatible", run: () => { const f = fixture(); const w = beginCandidate(f); installHook(f.vault, HOSTILE_HOOK); return run(f, ["finish", "--preview", "--worktree", w, "--message", "x"]) }, cause: "DOMAIN_PRECONDITION_UNMET", exit: 3, reason: "DOMAIN_GUARD_INCOMPATIBLE", nextAction: INSPECT },
	{ name: "preview path set mismatch", run: () => { const f = fixture(); const w = beginCandidate(f); write(w, "unexpected.md", "x\n"); return run(f, ["finish", "--preview", "--worktree", w, "--message", "x"]) }, cause: "DOMAIN_PRECONDITION_UNMET", exit: 3, reason: "DOMAIN_PATH_SET_MISMATCH", nextAction: PREVIEW },
	{ name: "preview check failed", run: () => { const f = fixture(); const w = beginCandidate(f, "BROKEN", "fail\n"); return run(f, ["finish", "--preview", "--worktree", w, "--message", "x"]) }, cause: "DOMAIN_PRECONDITION_UNMET", exit: 3, reason: "DOMAIN_CHECK_FAILED", nextAction: PREVIEW },
	{ name: "preview format failed", run: () => { const f = fixture(); const w = beginCandidate(f, "products/lamp.md", "# Lamp\n\n\n"); return run(f, ["finish", "--preview", "--worktree", w, "--message", "x"]) }, cause: "DOMAIN_PRECONDITION_UNMET", exit: 3, reason: "DOMAIN_FORMAT_FAILED", nextAction: PREVIEW },
	{ name: "preview candidate invalid", run: () => { const f = fixture(); const w = beginCandidate(f); previewCandidate(f, w); write(w, "projects/demo/GOAL.md", "# Goal\n\nEdited after commit.\n"); return run(f, ["finish", "--preview", "--worktree", w, "--message", "x"]) }, cause: "DOMAIN_PRECONDITION_UNMET", exit: 3, reason: "DOMAIN_CANDIDATE_INVALID", nextAction: INSPECT },
	{ name: "preview main diverged", run: () => { const f = fixture(); const w = beginCandidate(f); git(f.vault, "commit", "--amend", "--allow-empty", "-m", "rewritten"); return run(f, ["finish", "--preview", "--worktree", w, "--message", "x"]) }, cause: "DOMAIN_AUTHORITY_REQUIRED", exit: 3, reason: "DOMAIN_MAIN_DIVERGED", handoffOwner: "human" },
	{ name: "preview semantic overlap", run: () => { const f = fixture(); const w = beginCandidate(f); write(f.vault, "projects/demo/GOAL.md", "# Goal\n\nConcurrent.\n"); git(f.vault, "add", "--", "projects/demo/GOAL.md"); git(f.vault, "commit", "-m", "docs: concurrent"); return run(f, ["finish", "--preview", "--worktree", w, "--message", "x"]) }, cause: "DOMAIN_AUTHORITY_REQUIRED", exit: 3, reason: "DOMAIN_SEMANTIC_OVERLAP", handoffOwner: "human" },
	{ name: "preview git failed unchanged", run: () => { const f = fixture(); const w = beginCandidate(f); return run(f, ["finish", "--preview", "--worktree", w, "--message", "x"], { VAULT_STEWARD_FAULT: "git-failure=rev-parse --absolute-git-dir" }) }, cause: "INTERNAL_RESULT_UNCHANGED", exit: 1, reason: "INTERNAL_GIT_FAILED_UNCHANGED", handoffOwner: "operator" },
	{ name: "preview git failed during commit", run: () => { const f = fixture(); const w = beginCandidate(f); return run(f, ["finish", "--preview", "--worktree", w, "--message", "x"], { VAULT_STEWARD_FAULT: "git-failure=commit -m" }) }, cause: "INTERNAL_RESULT_UNKNOWN", exit: 1, reason: "INTERNAL_GIT_FAILED_UNKNOWN", handoffOwner: "operator", transaction: "unknown" },
	{ name: "preview unexpected during commit", run: () => { const f = fixture(); const w = beginCandidate(f); return run(f, ["finish", "--preview", "--worktree", w, "--message", "x"], { VAULT_STEWARD_FAULT: "unexpected=commit -m" }) }, cause: "INTERNAL_RESULT_UNKNOWN", exit: 1, reason: "INTERNAL_UNEXPECTED_UNKNOWN", handoffOwner: "operator", transaction: "unknown" },
	{ name: "preview unexpected unchanged", run: () => { const f = fixture(); const w = beginCandidate(f); return run(f, ["finish", "--preview", "--worktree", w, "--message", "x"], { VAULT_STEWARD_FAULT: "unexpected=--git-common-dir" }) }, cause: "INTERNAL_UNEXPECTED", exit: 1, reason: "INTERNAL_UNEXPECTED_UNCHANGED", handoffOwner: "operator" },
	// finish --apply
	{ name: "apply completed", run: () => { const f = fixture(); const w = beginCandidate(f); const id = previewCandidate(f, w); return run(f, ["finish", "--apply", "--preview-id", id, "--worktree", w]) }, cause: "SUCCESS_COMPLETED", exit: 0, nextAction: INSPECT, transaction: "completed" },
	{ name: "apply completed no changes", run: () => { const f = fixture(); const w = beginCandidate(f, "projects/demo/GOAL.md", null); const id = previewCandidate(f, w); return run(f, ["finish", "--apply", "--preview-id", id, "--worktree", w]) }, cause: "SUCCESS_COMPLETED", exit: 0, nextAction: INSPECT, transaction: "completed" },
	{ name: "apply completed with rebase", run: () => { const f = fixture(); const { worktree, previewId } = rebasePlan(f); return run(f, ["finish", "--apply", "--preview-id", previewId, "--worktree", worktree]) }, cause: "SUCCESS_COMPLETED", exit: 0, nextAction: INSPECT, transaction: "completed" },
	{ name: "apply after completion", run: () => { const f = fixture(); const { worktree, previewId } = applied(f); return run(f, ["finish", "--apply", "--preview-id", previewId, "--worktree", worktree]) }, cause: "SUCCESS_UNCHANGED", exit: 0, nextAction: INSPECT },
	{ name: "apply without preview id", run: () => { const f = fixture(); return run(f, ["finish", "--apply", "--worktree", f.vault]) }, cause: "USAGE_INVALID_INVOCATION", exit: 2, reason: "USAGE_INVALID_INVOCATION", nextAction: HELP },
	{ name: "apply relative worktree", run: () => run(fixture(), ["finish", "--apply", "--preview-id", "p", "--worktree", "relative"]), cause: "SCHEMA_INVALID_INPUT", exit: 4, reason: "SCHEMA_INVALID_INPUT", nextAction: HELP },
	{ name: "apply corrupt manifest", run: () => { const f = fixture(); const w = beginCandidate(f); const id = previewCandidate(f, w); writeFileSync(manifestPathOf(w), "{broken"); return run(f, ["finish", "--apply", "--preview-id", id, "--worktree", w]) }, cause: "SCHEMA_INVALID_INPUT", exit: 4, reason: "SCHEMA_MANIFEST_INVALID", nextAction: INSPECT },
	{ name: "apply corrupt receipt", run: () => { const f = fixture(); const { worktree, previewId } = applied(f); writeFileSync(receiptPathOf(f, worktree), "{broken"); return run(f, ["finish", "--apply", "--preview-id", previewId, "--worktree", worktree]) }, cause: "SCHEMA_INVALID_INPUT", exit: 4, reason: "SCHEMA_RECEIPT_INVALID", nextAction: INSPECT },
	{ name: "apply corrupt preview", run: () => { const f = fixture(); const w = beginCandidate(f); const id = previewCandidate(f, w); writeFileSync(previewPathOf(f, w), "{broken"); return run(f, ["finish", "--apply", "--preview-id", id, "--worktree", w]) }, cause: "SCHEMA_INVALID_INPUT", exit: 4, reason: "SCHEMA_PREVIEW_INVALID", nextAction: INSPECT },
	{ name: "apply candidate not found", run: () => { const f = fixture(); return run(f, ["finish", "--apply", "--preview-id", "p", "--worktree", join(f.root, "absent")]) }, cause: "DOMAIN_PRECONDITION_UNMET", exit: 3, reason: "DOMAIN_CANDIDATE_NOT_FOUND", nextAction: BEGIN },
	{ name: "apply main absent", run: () => { const f = fixture(); const w = beginCandidate(f); const id = previewCandidate(f, w); git(f.vault, "branch", "-m", "main", "renamed"); return run(f, ["finish", "--apply", "--preview-id", id, "--worktree", w]) }, cause: "DOMAIN_PRECONDITION_UNMET", exit: 3, reason: "DOMAIN_CANONICAL_NOT_MAIN", nextAction: BEGIN },
	{ name: "apply preview not found", run: () => { const f = fixture(); const w = beginCandidate(f); return run(f, ["finish", "--apply", "--preview-id", "preview-none", "--worktree", w]) }, cause: "DOMAIN_PRECONDITION_UNMET", exit: 3, reason: "DOMAIN_PREVIEW_NOT_FOUND", nextAction: PREVIEW },
	{ name: "apply preview consumed", run: () => { const f = fixture(); const w = beginCandidate(f); const id = previewCandidate(f, w); run(f, ["finish", "--apply", "--preview-id", id, "--worktree", w], { VAULT_STEWARD_FAULT: "halt=before-receipt" }); return run(f, ["finish", "--apply", "--preview-id", id, "--worktree", w]) }, cause: "DOMAIN_PRECONDITION_UNMET", exit: 3, reason: "DOMAIN_PREVIEW_CONSUMED", nextAction: INSPECT },
	{ name: "apply preview stale", run: () => { const f = fixture(); const w = beginCandidate(f); const id = previewCandidate(f, w); write(w, "projects/demo/GOAL.md", "# Goal\n\nEdited after preview.\n"); return run(f, ["finish", "--apply", "--preview-id", id, "--worktree", w]) }, cause: "DOMAIN_PRECONDITION_UNMET", exit: 3, reason: "DOMAIN_PREVIEW_STALE", nextAction: PREVIEW },
	{ name: "apply guard incompatible", run: () => { const f = fixture(); const w = beginCandidate(f); const id = previewCandidate(f, w); installHook(f.vault, HOSTILE_HOOK); return run(f, ["finish", "--apply", "--preview-id", id, "--worktree", w]) }, cause: "DOMAIN_PRECONDITION_UNMET", exit: 3, reason: "DOMAIN_GUARD_INCOMPATIBLE", nextAction: INSPECT },
	{ name: "apply canonical not ready", run: () => { const f = fixture(); const w = beginCandidate(f); const id = previewCandidate(f, w); write(f.vault, "personal-draft.md", "draft\n"); return run(f, ["finish", "--apply", "--preview-id", id, "--worktree", w]) }, cause: "DOMAIN_PRECONDITION_UNMET", exit: 3, reason: "DOMAIN_CANONICAL_NOT_READY", nextAction: APPLY },
	{ name: "apply rebased check failed", run: () => { const f = fixture(); const { worktree, previewId } = rebasePlan(f, "BROKEN", "fail\n"); return run(f, ["finish", "--apply", "--preview-id", previewId, "--worktree", worktree]) }, cause: "DOMAIN_PRECONDITION_UNMET", exit: 3, reason: "DOMAIN_REBASED_CHECK_FAILED", nextAction: PREVIEW },
	{ name: "apply rebase conflict", run: () => { const f = fixture(); const w = beginCandidate(f, "projects/x/y.md", "# y\n"); write(f.vault, "projects/x", "a file where the candidate needs a directory\n"); git(f.vault, "add", "--", "projects/x"); git(f.vault, "commit", "-m", "docs: file at projects/x"); const id = previewCandidate(f, w); return run(f, ["finish", "--apply", "--preview-id", id, "--worktree", w]) }, cause: "DOMAIN_AUTHORITY_REQUIRED", exit: 3, reason: "DOMAIN_REBASE_CONFLICT", handoffOwner: "human" },
	{ name: "apply busy", run: () => { const f = fixture(); const w = beginCandidate(f); const id = previewCandidate(f, w); holdLock(f); return run(f, ["finish", "--apply", "--preview-id", id, "--worktree", w]) }, cause: "TRANSIENT_NOT_STARTED", exit: 75, reason: "TRANSIENT_INTEGRATION_BUSY", nextAction: APPLY },
	{ name: "apply integration unproved", run: () => { const f = fixture(); const w = beginCandidate(f); const id = previewCandidate(f, w); return run(f, ["finish", "--apply", "--preview-id", id, "--worktree", w], { VAULT_STEWARD_FAULT: "git-failure=merge --ff-only" }) }, cause: "INTERNAL_EFFECT_OUTCOME_UNKNOWN", exit: 1, reason: "INTERNAL_INTEGRATION_UNPROVED", handoffOwner: "operator", transaction: "unknown" },
	{ name: "apply completion record failed", run: () => { const f = fixture(); const w = beginCandidate(f); const id = previewCandidate(f, w); return run(f, ["finish", "--apply", "--preview-id", id, "--worktree", w], { VAULT_STEWARD_FAULT: "git-failure=update-ref" }) }, cause: "INTERNAL_RESULT_PARTIAL", exit: 1, reason: "INTERNAL_COMPLETION_RECORD_FAILED", handoffOwner: "operator", transaction: "partially-completed" },
	{ name: "apply git failed before consume", run: () => { const f = fixture(); const w = beginCandidate(f); const id = previewCandidate(f, w); return run(f, ["finish", "--apply", "--preview-id", id, "--worktree", w], { VAULT_STEWARD_FAULT: "git-failure=branch --show-current" }) }, cause: "INTERNAL_RESULT_UNCHANGED", exit: 1, reason: "INTERNAL_GIT_FAILED_UNCHANGED", handoffOwner: "operator" },
	{ name: "apply git failed at read-back", run: () => { const f = fixture(); const w = beginCandidate(f); const id = previewCandidate(f, w); return run(f, ["finish", "--apply", "--preview-id", id, "--worktree", w], { VAULT_STEWARD_FAULT: "git-failure#3=rev-parse HEAD" }) }, cause: "INTERNAL_RESULT_UNKNOWN", exit: 1, reason: "INTERNAL_GIT_FAILED_UNKNOWN", handoffOwner: "operator", transaction: "unknown" },
	{ name: "apply unexpected after consume", run: () => { const f = fixture(); const { worktree, previewId } = rebasePlan(f); return run(f, ["finish", "--apply", "--preview-id", previewId, "--worktree", worktree], { VAULT_STEWARD_FAULT: "unexpected=rebase --onto" }) }, cause: "INTERNAL_RESULT_UNKNOWN", exit: 1, reason: "INTERNAL_UNEXPECTED_UNKNOWN", handoffOwner: "operator", transaction: "unknown" },
	{ name: "apply unexpected before consume", run: () => { const f = fixture(); const w = beginCandidate(f); const id = previewCandidate(f, w); return run(f, ["finish", "--apply", "--preview-id", id, "--worktree", w], { VAULT_STEWARD_FAULT: "unexpected=branch --show-current" }) }, cause: "INTERNAL_UNEXPECTED", exit: 1, reason: "INTERNAL_UNEXPECTED_UNCHANGED", handoffOwner: "operator" },
	// inspect
	{ name: "inspect absent candidate", run: () => { const f = fixture(); return run(f, ["inspect", "--worktree", join(f.root, "absent")]) }, cause: "SUCCESS_UNCHANGED", exit: 0, nextAction: BEGIN },
	{ name: "inspect fresh candidate", run: () => { const f = fixture(); const w = beginCandidate(f); return run(f, ["inspect", "--worktree", w]) }, cause: "SUCCESS_UNCHANGED", exit: 0, nextAction: PREVIEW },
	{ name: "inspect previewed candidate", run: () => { const f = fixture(); const w = beginCandidate(f); previewCandidate(f, w); return run(f, ["inspect", "--worktree", w]) }, cause: "SUCCESS_UNCHANGED", exit: 0, nextAction: APPLY },
	{ name: "inspect recoverable candidate", run: () => { const f = fixture(); const w = crashedAfterFastForward(f); return run(f, ["inspect", "--worktree", w]) }, cause: "SUCCESS_UNCHANGED", exit: 0, nextAction: RECOVER },
	{ name: "inspect completed candidate", run: () => { const f = fixture(); const { worktree } = applied(f); return run(f, ["inspect", "--worktree", worktree]) }, cause: "SUCCESS_UNCHANGED", exit: 0, nextAction: INSPECT },
	{ name: "inspect without worktree", run: () => run(fixture(), ["inspect"]), cause: "USAGE_INVALID_INVOCATION", exit: 2, reason: "USAGE_INVALID_INVOCATION", nextAction: HELP },
	{ name: "inspect relative worktree", run: () => run(fixture(), ["inspect", "--worktree", "relative"]), cause: "SCHEMA_INVALID_INPUT", exit: 4, reason: "SCHEMA_INVALID_INPUT", nextAction: HELP },
	{ name: "inspect git failed", run: () => { const f = fixture(); const w = beginCandidate(f); return run(f, ["inspect", "--worktree", w], { VAULT_STEWARD_FAULT: "git-failure=rev-parse --absolute-git-dir" }) }, cause: "INTERNAL_RESULT_UNCHANGED", exit: 1, reason: "INTERNAL_GIT_FAILED_UNCHANGED", handoffOwner: "operator" },
	{ name: "inspect unexpected", run: () => { const f = fixture(); const w = beginCandidate(f); return run(f, ["inspect", "--worktree", w], { VAULT_STEWARD_FAULT: "unexpected=--git-common-dir" }) }, cause: "INTERNAL_UNEXPECTED", exit: 1, reason: "INTERNAL_UNEXPECTED_UNCHANGED", handoffOwner: "operator" },
	// recover
	{ name: "recover completed after crash", run: () => { const f = fixture(); const w = crashedAfterFastForward(f); return run(f, ["recover", "--worktree", w]) }, cause: "SUCCESS_COMPLETED", exit: 0, nextAction: INSPECT, transaction: "completed" },
	{ name: "recover after completion", run: () => { const f = fixture(); const { worktree } = applied(f); return run(f, ["recover", "--worktree", worktree]) }, cause: "SUCCESS_UNCHANGED", exit: 0, nextAction: INSPECT },
	{ name: "recover without worktree", run: () => run(fixture(), ["recover"]), cause: "USAGE_INVALID_INVOCATION", exit: 2, reason: "USAGE_INVALID_INVOCATION", nextAction: HELP },
	{ name: "recover relative worktree", run: () => run(fixture(), ["recover", "--worktree", "relative"]), cause: "SCHEMA_INVALID_INPUT", exit: 4, reason: "SCHEMA_INVALID_INPUT", nextAction: HELP },
	{ name: "recover corrupt manifest", run: () => { const f = fixture(); const w = beginCandidate(f); writeFileSync(manifestPathOf(w), "{broken"); return run(f, ["recover", "--worktree", w]) }, cause: "SCHEMA_INVALID_INPUT", exit: 4, reason: "SCHEMA_MANIFEST_INVALID", nextAction: INSPECT },
	{ name: "recover corrupt receipt", run: () => { const f = fixture(); const { worktree } = applied(f); writeFileSync(receiptPathOf(f, worktree), "{broken"); return run(f, ["recover", "--worktree", worktree]) }, cause: "SCHEMA_INVALID_INPUT", exit: 4, reason: "SCHEMA_RECEIPT_INVALID", nextAction: INSPECT },
	{ name: "recover candidate not found", run: () => { const f = fixture(); return run(f, ["recover", "--worktree", join(f.root, "absent")]) }, cause: "DOMAIN_PRECONDITION_UNMET", exit: 3, reason: "DOMAIN_CANDIDATE_NOT_FOUND", nextAction: BEGIN },
	{ name: "recover main absent", run: () => { const f = fixture(); const w = beginCandidate(f); git(f.vault, "branch", "-m", "main", "renamed"); return run(f, ["recover", "--worktree", w]) }, cause: "DOMAIN_PRECONDITION_UNMET", exit: 3, reason: "DOMAIN_CANONICAL_NOT_MAIN", nextAction: BEGIN },
	{ name: "recover guard incompatible", run: () => { const f = fixture(); const w = crashedAfterFastForward(f); installHook(f.vault, HOSTILE_HOOK); return run(f, ["recover", "--worktree", w]) }, cause: "DOMAIN_PRECONDITION_UNMET", exit: 3, reason: "DOMAIN_GUARD_INCOMPATIBLE", nextAction: INSPECT },
	{ name: "recover unprovable", run: () => { const f = fixture(); const w = beginCandidate(f); return run(f, ["recover", "--worktree", w]) }, cause: "DOMAIN_AUTHORITY_REQUIRED", exit: 3, reason: "DOMAIN_RECOVERY_UNPROVABLE", handoffOwner: "human" },
	{ name: "recover busy", run: () => { const f = fixture(); const w = crashedAfterFastForward(f); holdLock(f); return run(f, ["recover", "--worktree", w]) }, cause: "TRANSIENT_NOT_STARTED", exit: 75, reason: "TRANSIENT_INTEGRATION_BUSY", nextAction: RECOVER },
	{ name: "recover receipt write failed", run: () => { const f = fixture(); const w = crashedAfterFastForward(f); const receipts = join(f.state, "my-second-brain", "vault-note-commits", "receipts"); rmSync(receipts, { recursive: true, force: true }); writeFileSync(receipts, ""); const result = run(f, ["recover", "--worktree", w]); rmSync(receipts, { force: true }); return result }, cause: "INTERNAL_RESULT_PARTIAL", exit: 1, reason: "INTERNAL_COMPLETION_RECORD_FAILED", handoffOwner: "operator", transaction: "partially-completed" },
	{ name: "recover ref write failed", run: () => { const f = fixture(); const w = crashedAfterFastForward(f); return run(f, ["recover", "--worktree", w], { VAULT_STEWARD_FAULT: "git-failure=update-ref" }) }, cause: "INTERNAL_RESULT_UNCHANGED", exit: 1, reason: "INTERNAL_COMPLETION_RECORD_FAILED", handoffOwner: "operator" },
	{ name: "recover git failed", run: () => { const f = fixture(); const w = beginCandidate(f); return run(f, ["recover", "--worktree", w], { VAULT_STEWARD_FAULT: "git-failure=rev-parse --absolute-git-dir" }) }, cause: "INTERNAL_RESULT_UNCHANGED", exit: 1, reason: "INTERNAL_GIT_FAILED_UNCHANGED", handoffOwner: "operator" },
	{ name: "recover unexpected", run: () => { const f = fixture(); const w = beginCandidate(f); return run(f, ["recover", "--worktree", w], { VAULT_STEWARD_FAULT: "unexpected=--git-common-dir" }) }, cause: "INTERNAL_UNEXPECTED", exit: 1, reason: "INTERNAL_UNEXPECTED_UNCHANGED", handoffOwner: "operator" },
]

const observations: CatalogueObservation[] = []

for (const scenario of scenarios) {
	test(`station: ${scenario.name}`, () => {
		const result = scenario.run()
		expect(result.stderr, scenario.name).toBe("")
		const envelope = result.envelope
		if (envelope === null) throw new Error(`${scenario.name}: no envelope (${result.stdout || result.signal})`)
		expect(envelope.result.causeCode, scenario.name).toBe(scenario.cause)
		expect(result.exitCode, scenario.name).toBe(scenario.exit)
		expect(envelope.result.exitCode, scenario.name).toBe(scenario.exit)
		const observed = observationOf(envelope)
		if (scenario.reason !== undefined) expect(observed.reason, scenario.name).toBe(scenario.reason)
		if (scenario.nextAction !== undefined) expect(observed.nextAction, scenario.name).toBe(scenario.nextAction)
		if (scenario.handoffOwner !== undefined) expect(observed.handoffOwner, scenario.name).toBe(scenario.handoffOwner)
		if (scenario.transaction !== undefined) expect(envelope.result.transactionState, scenario.name).toBe(scenario.transaction)
		const expected = EXPECTED_BY_IDENTITY.get(observed.identity)
		if (expected === undefined) throw new Error(`${scenario.name}: ${observed.identity} is not an expected station`)
		expect(envelope.result.failureClass, scenario.name).toBe(expected.failureClass)
		expect(envelope.result.effectClass, scenario.name).toBe(expected.effectClass)
		expect(envelope.result.transactionState, scenario.name).toBe(expected.state)
		expect(envelope.result.retryable, scenario.name).toBe(expected.retryable)
		expect((envelope.result.retryDelayMilliseconds as number | undefined) ?? null, scenario.name).toBe(expected.delay)
		expect(envelope.result.data === null, scenario.name).toBe(expected.failureClass !== null)
		observations.push({
			identity: observed.identity,
			failureClass: envelope.result.failureClass as CatalogueObservation["failureClass"],
			exitCode: envelope.result.exitCode as number,
			effectClass: envelope.result.effectClass as string,
			transactionState: envelope.result.transactionState as string,
			retryable: envelope.result.retryable as boolean,
			retryDelayMilliseconds: (envelope.result.retryDelayMilliseconds as number | undefined) ?? null,
			reason: observed.reason,
			nextAction: observed.nextAction,
			handoffOwner: observed.handoffOwner,
			repairAction: typeof envelope.result.repairAction === "string",
		})
	}, 30_000)
}

test("the production catalogue enumerates exactly the expected stations", () => {
	expect(new Set(STATION_IDS)).toEqual(new Set(EXPECTED_BY_IDENTITY.keys()))
	expect(STATION_IDS).toHaveLength(EXPECTED_STATION_COUNT)
	for (const station of BRANCH_STATIONS) {
		const expected = EXPECTED_BY_IDENTITY.get(station.identity)
		if (expected === undefined) throw new Error(`${station.identity} is not an expected station`)
		const declared: Record<string, unknown> = { failureClass: station.failureClass, exit: station.exitCode, effectClass: station.effectClass, state: station.transactionState, retryable: station.retryable, guidance: station.guidance.kind, reasons: [...station.reasons], nextActions: station.guidance.kind === "next-action" ? [...station.guidance.nextActions] : [], reachability: station.reachability }
		expect(declared, station.identity).toEqual({ ...expected, delay: undefined } as Record<string, unknown>)
	}
})

test("strict catalogue qualification: declared = observed, every next action and reason reached", () => {
	const report = validateCatalogue(BRANCH_STATIONS, observations)
	expect(report.findings).toEqual([])
	expect(report.fullQualification).toBe(true)
	expect(new Set(observations.map((observation) => observation.identity)).size).toBe(EXPECTED_STATION_COUNT - 1)
	expect(BRANCH_STATIONS.filter((station) => station.reachability === "declared-unreachable").map((station) => station.identity)).toEqual([identityOf("vault-steward.recover", "failed", "INTERNAL_RESULT_UNKNOWN")])
})
