// The Vault Steward CLI 2.0 front door: strict argv routing with the identity derived from raw argv, help and discovery,
// the eight commands over the shared engine, human rendering, and the one machine writer that validates every envelope
// against the strict schema before writing it (CONTRACT.md 3.1, 3.2, 3.5, 3.8, 3.9).
import { isAbsolute, resolve } from "node:path"
import { parseArgs } from "node:util"
import { stationFor, stationIdOf } from "./branch-station-catalog.ts"
import {
	type CliRoute,
	COMMANDS,
	type CommandIdentity,
	type CommandRoute,
	type ContractResult,
	CONTRACT_VERSION,
	declarationForIdentity,
	declarationForRoute,
	type Diagnostics,
	discovery,
	type Effects,
	ENVELOPE_VERSION,
	type EnvelopeV2,
	exitFor,
	type Handoff,
	HELP_DATA,
	isCommandIdentity,
	type JsonValue,
	MachineEnvelopeSchema,
	PARSE_ARGS_CONFIG,
	RETRY_DELAY_MS,
	type StationRow,
	type WireCauseCode,
	causeRule,
	isSafeJson as isJson,
} from "./command-contract.ts"
import { type DiagnosticsStatus, openRunDiagnostics } from "./diagnostics.ts"
import {
	applyPreview,
	bindPreview,
	candidateView,
	canonicalVault,
	configuredVault,
	createCandidate,
	gitQuiet,
	lockView,
	mainView,
	manifestView,
	planCandidate,
	planPreview,
	readManifest,
	readPreview,
	readReceipt,
	receiptView,
	recoverCandidate,
	recoveryEvidence,
	Refusal,
	stateRoot,
	validateCandidate,
	vaultIdentity,
	writePreview,
} from "./engine.ts"
import { parseFaults, withFaults } from "./faults.ts"
import { observeGuard } from "./guard.ts"
import { type EffectId, type GuardObservation, type Manifest, type PreviewRecord, productCause, type ProductCause, type RefusalFacts, type TransactionState } from "./model.ts"
import { createRuntime, type Runtime } from "./runtime.ts"
import { commandDiscovery, handoffOwner, type PublicStation } from "./station-catalogue.ts"

export interface Io {
	stdout(text: string): void
	stderr(text: string): void
}

const HELP_TEXT = `vault-steward: commit declared vault notes onto canonical main through a private candidate worktree
usage: vault-steward <command> [options] [--json]

commands:
  begin --path <relative-path>... [--vault <path>] [--preview]   create a detached candidate worktree (or plan it)
  finish --preview --worktree <path> --message <subject>           validate the candidate, commit, record the plan
  finish --apply --preview-id <id> --worktree <path>               integrate the unconsumed preview under the lock
  inspect --worktree <path>                                        report the candidate's recovery state, read-only
  recover --worktree <path>                                        record completion evidence Git already proves
  --discover --json                                                describe the commands and the contract
  --discover-command <identity> --json                             describe the possible outcomes of one command

Remote sync (push, fetch, publish) is a separate workflow. The alias vault-note-commits keeps the schemaVersion 1 envelope.

example:
  vault-steward begin --vault /path/to/vault --path projects/demo/GOAL.md --json
`

export type Routed = { identity: CommandIdentity; route: CliRoute }

function controls(argv: readonly string[]): readonly string[] {
	const delimiter = argv.indexOf("--")
	return delimiter === -1 ? argv : argv.slice(0, delimiter)
}

export function machineMode(argv: readonly string[]): boolean {
	return controls(argv).includes("--json")
}

function routed(route: CliRoute): Routed {
	return { identity: declarationForRoute(route).identity, route }
}

// Built-in help, discovery, and command-discovery are mutually exclusive: any two together, or a command-discovery
// selector that is missing or option-shaped, is the dispatch refusal before strict parsing.
function builtInRoute(beforeDelimiter: readonly string[]): Routed | undefined {
	const help = beforeDelimiter.includes("--help")
	const discover = beforeDelimiter.includes("--discover")
	const selectorIndex = beforeDelimiter.indexOf("--discover-command")
	const discoverCommand = selectorIndex !== -1
	if ((help && discover) || (help && discoverCommand) || (discover && discoverCommand)) return routed("dispatch")
	if (help) return routed("help")
	if (discover) return routed("discover")
	if (!discoverCommand) return undefined
	const selector = beforeDelimiter[selectorIndex + 1]
	return selector === undefined || selector.startsWith("-") ? routed("dispatch") : routed("command-discovery")
}

// Identity is derived from the raw argv command word and route flags before strict parsing, so a usage refusal keeps
// the routed identity.
export function routeRawArgv(argv: readonly string[]): Routed {
	const beforeDelimiter = controls(argv)
	const builtIn = builtInRoute(beforeDelimiter)
	if (builtIn !== undefined) return builtIn
	const word = beforeDelimiter.find((token) => !token.startsWith("-"))
	switch (word) {
		case "begin":
			return routed("begin")
		case "finish":
			return beforeDelimiter.includes("--apply") && !beforeDelimiter.includes("--preview") ? routed("finish-apply") : routed("finish-preview")
		case "inspect":
			return routed("inspect")
		case "recover":
			return routed("recover")
		default:
			return routed("dispatch")
	}
}

type Parsed = ReturnType<typeof parseArgs<typeof PARSE_ARGS_CONFIG>>

function parse(argv: readonly string[]): Parsed | { usage: string } {
	try {
		return parseArgs({ ...PARSE_ARGS_CONFIG, args: [...argv] })
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined
		return { usage: code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? "unknown option" : "malformed option value" }
	}
}

function shapeViolation(parsed: Parsed, route: Exclude<CliRoute, "dispatch">): string | null {
	const shape = declarationForRoute(route)
	if (route === "help" || route === "discover" || route === "command-discovery") {
		if (parsed.positionals.length !== 0) return `${shape.word} takes no positional arguments`
	} else if (parsed.positionals.length !== 1 || parsed.positionals[0] !== shape.word) return `${shape.word} takes exactly its command word and options`
	const allowed = new Set<string>(shape.allowedOptions)
	const stray = Object.keys(parsed.values).find((name) => !allowed.has(name))
	if (stray !== undefined) return `--${stray} is not an option of ${shape.word}${route === "finish-apply" || route === "finish-preview" ? " in this form" : ""}`
	const missing = shape.requiredOptions.find((name) => parsed.values[name] === undefined)
	return missing === undefined ? null : `${shape.word} requires --${missing}`
}

// ---------------------------------------------------------------------------------------------------------------------
// Decisions: what a command concluded, before rendering

interface SuccessDecision {
	kind: "success"
	identity: CommandIdentity
	cause: "SUCCESS_UNCHANGED" | "SUCCESS_COMPLETED"
	message: string
	data: JsonValue
	completed: EffectId[]
	nextAction: CommandIdentity
	idempotencyKey?: string
	warnings: readonly { code: string; detail: string }[]
}
interface RefusalDecision {
	kind: "refusal"
	identity: CommandIdentity
	refusal: Refusal
	inventory: EffectId[]
	warnings: readonly { code: string; detail: string }[]
}
type Decision = SuccessDecision | RefusalDecision

interface Session {
	io: Io
	runId: string
	env: Record<string, string | undefined>
	jsonMode: boolean
}

const INVENTORY: Readonly<Record<CommandRoute, EffectId[]>> = {
	begin: ["candidate.manifest", "candidate.worktree"],
	"finish-preview": ["candidate.commit", "preview.record"],
	"finish-apply": ["completion.receipt", "completion.ref", "main.fast-forward"],
	inspect: [],
	recover: ["completion.receipt", "completion.ref"],
}

function warningsOf(observation: GuardObservation | undefined): { code: string; detail: string }[] {
	return observation?.warnings.map((warning) => ({ code: warning.code, detail: warning.detail })) ?? []
}

function guardData(observation: GuardObservation | undefined): JsonValue {
	if (observation === undefined) return null
	const { guard } = observation
	return { installed: guard.installed, executable: guard.executable, hookPath: guard.hookPath, current: guard.current, selfTest: guard.selfTest, hooksPathOverride: guard.hooksPathOverride, branches: guard.branches, worktrees: guard.worktrees }
}

function warningsData(observation: GuardObservation | undefined): JsonValue {
	return warningsOf(observation).map((warning) => ({ code: warning.code, detail: warning.detail }))
}

function candidateRoot(rt: Runtime, vault: string): string {
	const root = stateRoot(rt)
	let resolved: string
	try {
		resolved = rt.realpath(root)
	} catch {
		resolved = root
	}
	return `${resolved}/${vaultIdentity(vault)}`
}

// The 2.0 front door refuses DOMAIN_CANONICAL_NOT_MAIN before the self-test when refs/heads/main is absent (an unborn
// main passes canonicalVault's current-branch check).
function requireMain(rt: Runtime, vault: string, facts: RefusalFacts = {}): void {
	if (gitQuiet(rt, vault, ["rev-parse", "--verify", "refs/heads/main"]).exitCode !== 0) throw new Refusal("not-canonical-main", { ...facts, detail: "refs/heads/main is absent" })
}

function observeForCandidate(rt: Runtime, manifest: Manifest, candidateCommit: string | undefined): GuardObservation {
	requireMain(rt, manifest.vault, { runId: manifest.runId, worktree: manifest.worktree, paths: manifest.paths })
	return observeGuard(rt, { vault: manifest.vault, candidateRoot: candidateRoot(rt, manifest.vault), runId: manifest.runId, candidateCommit, facts: { runId: manifest.runId, worktree: manifest.worktree, paths: manifest.paths } })
}

function knownCandidateCommit(rt: Runtime, manifest: Manifest): string | undefined {
	const view = candidateView(rt, manifest)
	return view.committed && view.head !== null ? view.head : undefined
}

function requireAbsoluteWorktree(input: unknown): string {
	if (typeof input !== "string" || !isAbsolute(input) || resolve(input) !== input) throw new Refusal("input-invalid", { detail: "--worktree must be the exact absolute path returned by begin" })
	return input
}

function requireSubject(input: unknown): string {
	const message = typeof input === "string" ? input.trim() : ""
	if (!message || message.includes("\n")) throw new Refusal("input-invalid", { detail: "--message must be one non-empty commit subject line" })
	return message
}

// begin and begin --preview
function runBegin(rt: Runtime, parsed: Parsed, session: Session): Decision {
	const identity = "vault-steward.begin"
	const requested = parsed.values.path ?? []
	if (typeof parsed.values.vault === "string" && !isAbsolute(parsed.values.vault)) throw new Refusal("input-invalid", { detail: "--vault must be an absolute path" })
	const vault = canonicalVault(rt, parsed.values.vault ?? configuredVault(rt))
	requireMain(rt, vault)
	const plan = planCandidate(rt, vault, requested)
	const observation = observeGuard(rt, { vault, candidateRoot: candidateRoot(rt, vault), runId: plan.runId })
	const warnings = warningsOf(observation)
	if (parsed.values.preview === true) {
		const baseCommit = gitQuiet(rt, vault, ["rev-parse", "main"]).stdout.trim()
		return { kind: "success", identity, cause: "SUCCESS_UNCHANGED", message: "Begin plan reported; nothing was created.", data: { plan: { vault, baseCommit, paths: plan.paths, worktree: null }, guard: guardData(observation), warnings: warningsData(observation) }, completed: [], nextAction: "vault-steward.begin", warnings }
	}
	try {
		const { manifest } = createCandidate(rt, plan)
		return {
			kind: "success",
			identity,
			cause: "SUCCESS_COMPLETED",
			message: `Candidate worktree created at ${manifest.worktree}; edit only the admitted paths, then run finish --preview.`,
			data: { candidate: { runId: manifest.runId, worktree: manifest.worktree, baseCommit: manifest.baseCommit, paths: manifest.paths }, vault, guard: guardData(observation), warnings: warningsData(observation) },
			completed: ["candidate.manifest", "candidate.worktree"],
			nextAction: "vault-steward.finish-preview",
			idempotencyKey: manifest.runId,
			warnings,
		}
	} catch (error) {
		if (error instanceof Refusal) throw new Refusal(error.reason, { ...error.facts, guard: observation }, error.transaction)
		throw error
	}
}

function receiptDecision(identity: CommandIdentity, receipt: NonNullable<ReturnType<typeof readReceipt>>, worktree: string, rt: Runtime): SuccessDecision {
	const { receipt: record, path } = receipt
	return {
		kind: "success",
		identity,
		cause: "SUCCESS_UNCHANGED",
		message: `Completion is already recorded (${record.code}); no new write was performed.`,
		data: { completion: { originalCode: record.code, commit: record.commit ?? null, receipt: path, ref: `refs/vault-note-commits/${record.runId}` }, candidate: { runId: record.runId, worktree, paths: record.paths, retained: rt.exists(worktree) } },
		completed: [],
		nextAction: "vault-steward.inspect",
		idempotencyKey: record.runId,
		warnings: [],
	}
}

function runFinishPreview(rt: Runtime, parsed: Parsed, session: Session): Decision {
	const identity = "vault-steward.finish-preview"
	const worktree = requireAbsoluteWorktree(parsed.values.worktree)
	const message = requireSubject(parsed.values.message)
	const completed = readReceipt(rt, worktree)
	if (completed) return receiptDecision(identity, completed, worktree, rt)
	const manifest = readManifest(rt, worktree)
	const knownCommit = knownCandidateCommit(rt, manifest)
	const observation = observeForCandidate(rt, manifest, knownCommit)
	try {
		const state = validateCandidate(rt, manifest, message)
		const record = planPreview(rt, manifest, state, session.runId)
		writePreview(rt, record)
		const commitCreated = knownCommit === undefined && state.kind !== "no-changes"
		return {
			kind: "success",
			identity,
			cause: "SUCCESS_COMPLETED",
			message: `Preview ${record.previewId} recorded; apply it with finish --apply --preview-id ${record.previewId} --worktree ${manifest.worktree}.`,
			data: {
				previewId: record.previewId,
				candidate: { runId: manifest.runId, worktree: manifest.worktree, baseCommit: manifest.baseCommit, commit: record.candidateCommit, paths: manifest.paths },
				plan: { kind: record.plan.kind, observedMain: record.observedMain, rebase: record.plan.rebase, expectedEffects: record.plan.expectedEffects },
				guard: guardData(observation),
				warnings: warningsData(observation),
			},
			completed: commitCreated ? ["candidate.commit", "preview.record"] : ["preview.record"],
			nextAction: "vault-steward.finish-apply",
			idempotencyKey: manifest.runId,
			warnings: warningsOf(observation),
		}
	} catch (error) {
		if (error instanceof Refusal) throw new Refusal(error.reason, { ...error.facts, guard: observation }, error.transaction)
		throw error
	}
}

function runFinishApply(rt: Runtime, parsed: Parsed, session: Session): Decision {
	const identity = "vault-steward.finish-apply"
	const worktree = requireAbsoluteWorktree(parsed.values.worktree)
	const previewId = typeof parsed.values["preview-id"] === "string" ? parsed.values["preview-id"] : ""
	const completed = readReceipt(rt, worktree)
	if (completed) return receiptDecision(identity, completed, worktree, rt)
	const manifest = readManifest(rt, worktree)
	const record = bindPreview(rt, manifest, previewId)
	const observation = observeForCandidate(rt, manifest, record.candidateCommit ?? undefined)
	try {
		const result = applyPreview(rt, manifest, record, session.runId)
		if (result.kind === "receipt") return receiptDecision(identity, result.receipt, worktree, rt)
		const { completion } = result
		const completedEffects: EffectId[] = completion.commit ? ["completion.receipt", "completion.ref", "main.fast-forward"] : ["completion.receipt", "completion.ref"]
		return {
			kind: "success",
			identity,
			cause: "SUCCESS_COMPLETED",
			message: completion.commit ? "Canonical main fast-forwarded and the completion recorded. Run remote sync separately when you want to publish main." : "No candidate changes were authored; the no-changes completion is recorded.",
			data: {
				integration: { kind: record.plan.kind, commit: completion.commit ?? null, main: { before: record.observedMain, after: completion.commit ?? record.observedMain } },
				completion: { ref: `refs/vault-note-commits/${manifest.runId}`, receipt: completion.receipt },
				candidate: { runId: manifest.runId, worktree: manifest.worktree, paths: manifest.paths, retained: !completion.removed },
				guard: guardData(observation),
				warnings: warningsData(observation),
			},
			completed: completedEffects,
			nextAction: "vault-steward.inspect",
			idempotencyKey: manifest.runId,
			warnings: warningsOf(observation),
		}
	} catch (error) {
		if (error instanceof Refusal) throw new Refusal(error.reason, { ...error.facts, guard: observation }, error.transaction)
		throw error
	}
}

type RecoveryState = "not-started" | "previewed" | "completed" | "recoverable" | "needs-human"

function inspectNext(state: RecoveryState, worktree: string, hasCandidate: boolean, previewId: string | null): { nextCommand: string | null; nextAction: CommandIdentity } {
	switch (state) {
		case "completed":
			return { nextCommand: null, nextAction: "vault-steward.inspect" }
		case "recoverable":
			return { nextCommand: `vault-steward recover --worktree ${worktree} --json`, nextAction: "vault-steward.recover" }
		case "previewed":
			return { nextCommand: `vault-steward finish --apply --preview-id ${previewId ?? "<previewId>"} --worktree ${worktree} --json`, nextAction: "vault-steward.finish-apply" }
		case "needs-human":
			return { nextCommand: null, nextAction: "vault-steward.inspect" }
		default:
			return hasCandidate ? { nextCommand: `vault-steward finish --preview --worktree ${worktree} --message <subject> --json`, nextAction: "vault-steward.finish-preview" } : { nextCommand: "vault-steward begin --path <relative-path> --json", nextAction: "vault-steward.begin" }
	}
}

// Everything inspect reads before it classifies: receipt, manifest, candidate, main, lock, preview, guard.
interface InspectViews {
	worktree: string
	receipt: ReturnType<typeof receiptView>
	manifest: ReturnType<typeof manifestView>
	record: Manifest | null
	candidate: ReturnType<typeof candidateView> | null
	main: ReturnType<typeof mainView>
	lock: ReturnType<typeof lockView>
	preview: PreviewRecord | null
	previewInvalid: boolean
	previewStale: boolean | null
	observation: GuardObservation | undefined
}

// inspect is read-only: an unreadable preview record is reported, never refused.
function previewViewOf(rt: Runtime, runId: string): { present: false } | { present: true; valid: true; record: PreviewRecord } | { present: true; valid: false } {
	try {
		const stored = readPreview(rt, runId)
		return stored.present ? { present: true, valid: true, record: stored.record } : { present: false }
	} catch (error) {
		if (error instanceof Refusal && error.reason === "preview-invalid") return { present: true, valid: false }
		throw error
	}
}

// The preview part of the inspect view: absent, invalid, or the record with its staleness against the candidate.
function previewViews(rt: Runtime, record: Manifest | null, candidate: ReturnType<typeof candidateView> | null): Pick<InspectViews, "preview" | "previewInvalid" | "previewStale"> {
	if (record === null) return { preview: null, previewInvalid: false, previewStale: null }
	const stored = previewViewOf(rt, record.runId)
	if (!stored.present) return { preview: null, previewInvalid: false, previewStale: null }
	if (!stored.valid) return { preview: null, previewInvalid: true, previewStale: null }
	// CONTRACT.md 3.3: stale when main moved, the candidate HEAD differs from the previewed commit, or the candidate is dirty.
	const mainHead = gitQuiet(rt, record.vault, ["rev-parse", "refs/heads/main"])
	const mainMoved = mainHead.exitCode !== 0 || mainHead.stdout.trim() !== stored.record.observedMain
	const previewStale = candidate === null ? null : candidate.head !== (stored.record.candidateCommit ?? record.baseCommit) || candidate.dirty || mainMoved
	return { preview: stored.record, previewInvalid: false, previewStale }
}

function inspectViews(rt: Runtime, worktree: string): InspectViews {
	const receipt = receiptView(rt, worktree)
	const manifest = manifestView(rt, worktree)
	const record = manifest.manifest
	const candidate = record === null ? null : candidateView(rt, record)
	const main = record === null || candidate === null ? { head: null, containsCandidateCommit: null, overlap: [] } : mainView(rt, record, candidate)
	const lock = record === null ? { held: false, ownerPid: null, ownerRunId: null, live: null } : lockView(rt, record.commonGitDirectory)
	// A valid receipt is the completion boundary: no hook spawn on that path.
	const observation = receipt.valid || record === null ? undefined : observeGuard(rt, { vault: record.vault, candidateRoot: candidateRoot(rt, record.vault), runId: record.runId, candidateCommit: candidate?.committed ? (candidate.head ?? undefined) : undefined }, false)
	return { worktree, receipt, manifest, record, candidate, main, lock, ...previewViews(rt, record, candidate), observation }
}

function recoveryStateOf(rt: Runtime, views: InspectViews): RecoveryState {
	if (views.receipt.valid) return "completed"
	if (views.record === null) return views.receipt.present ? "needs-human" : "not-started"
	if (recoveryEvidence(rt, views.record).kind !== "unprovable") return "recoverable"
	const cleanNotOnMain = views.candidate !== null && !views.candidate.dirty && views.main.containsCandidateCommit !== true
	// A consumed preview whose apply never had an effect (crash after consumption, or a refusal after the rebase was
	// restored) needs a fresh preview, not a human: the candidate is clean, exactly as previewed, and main is where the
	// preview observed it.
	if (views.preview?.consumed) return cleanNotOnMain ? "not-started" : "needs-human"
	if (views.preview !== null && views.previewStale === false) return "previewed"
	if (views.candidate?.committed && views.main.overlap.length > 0) return "needs-human"
	return "not-started"
}

function inspectData(views: InspectViews, state: RecoveryState, nextCommand: string | null): JsonValue {
	const { record, candidate, receipt, manifest, preview, lock, main } = views
	return {
		candidate: { runId: record?.runId ?? null, worktree: views.worktree, exists: manifest.worktreeExists, baseCommit: record?.baseCommit ?? null, head: candidate?.head ?? null, committed: candidate?.committed ?? false, dirty: candidate?.dirty ?? false, paths: record?.paths ?? null },
		manifest: { present: manifest.present, valid: manifest.valid },
		receipt: { present: receipt.present, valid: receipt.valid, code: receipt.code, path: receipt.path },
		preview: preview === null ? { present: views.previewInvalid, valid: false, previewId: null, consumed: null, stale: null } : { present: true, valid: true, previewId: preview.previewId, consumed: preview.consumed, stale: views.previewStale },
		lock: { held: lock.held, ownerPid: lock.ownerPid, ownerRunId: lock.ownerRunId, live: lock.live },
		main: { head: main.head, containsCandidateCommit: main.containsCandidateCommit, overlap: main.overlap },
		guard: guardData(views.observation),
		warnings: warningsData(views.observation),
		recovery: { state, nextCommand },
	}
}

function runInspect(rt: Runtime, parsed: Parsed): Decision {
	const worktree = requireAbsoluteWorktree(parsed.values.worktree)
	const views = inspectViews(rt, worktree)
	const state = recoveryStateOf(rt, views)
	const next = inspectNext(state, worktree, views.record !== null, views.preview?.previewId ?? null)
	return {
		kind: "success",
		identity: "vault-steward.inspect",
		cause: "SUCCESS_UNCHANGED",
		message: `Recovery state ${state}${next.nextCommand === null ? "." : `; next: ${next.nextCommand}`}`,
		data: inspectData(views, state, next.nextCommand),
		completed: [],
		nextAction: next.nextAction,
		...(views.record === null ? {} : { idempotencyKey: views.record.runId }),
		warnings: warningsOf(views.observation),
	}
}

function runRecover(rt: Runtime, parsed: Parsed): Decision {
	const identity = "vault-steward.recover"
	const worktree = requireAbsoluteWorktree(parsed.values.worktree)
	const completed = readReceipt(rt, worktree)
	if (completed) return receiptDecision(identity, completed, worktree, rt)
	const manifest = readManifest(rt, worktree)
	const observation = observeForCandidate(rt, manifest, knownCandidateCommit(rt, manifest))
	try {
		const result = recoverCandidate(rt, manifest)
		if (result.kind === "receipt") return receiptDecision(identity, result.receipt, worktree, rt)
		const { completion } = result
		return {
			kind: "success",
			identity,
			cause: "SUCCESS_COMPLETED",
			message: "Completion evidence recorded from Git; the fast-forward was never replayed. Run remote sync separately when you want to publish main.",
			data: { completion: { ref: `refs/vault-note-commits/${manifest.runId}`, receipt: completion.receipt, commit: completion.commit ?? null }, candidate: { runId: manifest.runId, worktree: manifest.worktree, retained: !completion.removed }, guard: guardData(observation), warnings: warningsData(observation) },
			completed: ["completion.receipt", "completion.ref"],
			nextAction: "vault-steward.inspect",
			idempotencyKey: manifest.runId,
			warnings: warningsOf(observation),
		}
	} catch (error) {
		if (error instanceof Refusal) throw new Refusal(error.reason, { ...error.facts, guard: observation }, error.transaction)
		throw error
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Rendering refusals: product cause, station, guidance

interface Guidance {
	repair: string
	next: CommandIdentity | null
}
const REPAIR: Readonly<Record<ProductCause, Guidance>> = {
	SCHEMA_INVALID_INPUT: { repair: "Correct the option value and rerun; see --help.", next: "vault-steward.help" },
	SCHEMA_CONFIG_INVALID: { repair: "Repair the vault.json file to contain only schemaVersion 1 and one absolute vault path.", next: "vault-steward.help" },
	SCHEMA_MANIFEST_INVALID: { repair: "Preserve the candidate and inspect its Git metadata before continuing.", next: "vault-steward.inspect" },
	SCHEMA_RECEIPT_INVALID: { repair: "Preserve the receipt and inspect its identity and local Git evidence before continuing.", next: "vault-steward.inspect" },
	SCHEMA_PREVIEW_INVALID: { repair: "Inspect the preview record, then run finish --preview again to replace it.", next: "vault-steward.inspect" },
	DOMAIN_CONFIG_MISSING: { repair: "Create the vault.json file with the playground vault path, or pass --vault.", next: "vault-steward.begin" },
	DOMAIN_VAULT_NOT_FOUND: { repair: "Provide an existing vault checkout with --vault.", next: "vault-steward.begin" },
	DOMAIN_CANONICAL_NOT_MAIN: { repair: "Run git switch main in the vault root checkout, then rerun the same command.", next: "vault-steward.begin" },
	DOMAIN_PATH_REFUSED: { repair: "Use non-empty vault-relative paths whose existing components are not symbolic links.", next: "vault-steward.begin" },
	DOMAIN_CANDIDATE_NOT_FOUND: { repair: "Run begin to create a new candidate.", next: "vault-steward.begin" },
	DOMAIN_CANDIDATE_INVALID: { repair: "Inspect the candidate and restore it to one clean commit over the admitted paths before retrying.", next: "vault-steward.inspect" },
	DOMAIN_PATH_SET_MISMATCH: { repair: "Change exactly the paths admitted by begin, then run finish --preview again.", next: "vault-steward.finish-preview" },
	DOMAIN_CHECK_FAILED: { repair: "Read the private checker diagnostics, fix the admitted files in the candidate, then run finish --preview again.", next: "vault-steward.finish-preview" },
	DOMAIN_FORMAT_FAILED: { repair: "Fix the reported whitespace in the admitted candidate files, then run finish --preview again.", next: "vault-steward.finish-preview" },
	DOMAIN_GUARD_INCOMPATIBLE: { repair: "Run 'bun run guard:install' in the vault, then rerun the same command.", next: "vault-steward.inspect" },
	DOMAIN_CANONICAL_NOT_READY: { repair: "Restore a clean canonical main checkout, then retry the same apply; the preview stays valid.", next: "vault-steward.finish-apply" },
	DOMAIN_MAIN_DIVERGED: { repair: "Reconcile canonical main with Nathan; the candidate is preserved.", next: null },
	DOMAIN_SEMANTIC_OVERLAP: { repair: "Resolve the concurrent changes with Nathan; the candidate is preserved.", next: null },
	DOMAIN_PREVIEW_NOT_FOUND: { repair: "Run finish --preview for this worktree, then apply the preview id it returns.", next: "vault-steward.finish-preview" },
	DOMAIN_PREVIEW_CONSUMED: { repair: "Inspect the candidate; the preview was consumed by an earlier apply.", next: "vault-steward.inspect" },
	DOMAIN_PREVIEW_STALE: { repair: "Run finish --preview again and apply the new preview id.", next: "vault-steward.finish-preview" },
	DOMAIN_REBASE_CONFLICT: { repair: "Resolve the conflict with Nathan, then run finish --preview again.", next: null },
	DOMAIN_REBASED_CHECK_FAILED: { repair: "Fix the candidate against the moved main, then run finish --preview again.", next: "vault-steward.finish-preview" },
	DOMAIN_RECOVERY_UNPROVABLE: { repair: "Inspect main and the candidate with Nathan; nothing is replayed automatically.", next: null },
	TRANSIENT_INTEGRATION_BUSY: { repair: "Wait for the active finisher to release the local integration lock, then retry the same command.", next: null },
	INTERNAL_GIT_FAILED_UNCHANGED: { repair: "Confirm the vault is a healthy local Git checkout, then retry.", next: null },
	INTERNAL_GIT_FAILED_PARTIAL: { repair: "Inspect the created candidate worktree before retrying.", next: null },
	INTERNAL_GIT_FAILED_UNKNOWN: { repair: "Inspect canonical main and the candidate before taking another action.", next: null },
	INTERNAL_INTEGRATION_UNPROVED: { repair: "Inspect canonical main and the candidate before taking another action.", next: null },
	INTERNAL_INTEGRATION_UNPROVED_UNCHANGED: { repair: "Run finish --preview again; the candidate was restored before main moved.", next: "vault-steward.finish-preview" },
	INTERNAL_COMPLETION_RECORD_FAILED: { repair: "Run vault-steward recover for this worktree; it records completion only from Git evidence.", next: null },
	INTERNAL_UNEXPECTED_UNCHANGED: { repair: "Inspect the local error and the diagnostics file before retrying.", next: null },
	INTERNAL_UNEXPECTED_UNKNOWN: { repair: "Inspect canonical main and the candidate before taking another action.", next: null },
}

const SENTENCE: Readonly<Record<ProductCause, string>> = {
	SCHEMA_INVALID_INPUT: "An option value has the wrong shape.",
	SCHEMA_CONFIG_INVALID: "The vault configuration file is unreadable or off schema.",
	SCHEMA_MANIFEST_INVALID: "The candidate manifest fails validation.",
	SCHEMA_RECEIPT_INVALID: "A receipt exists for this worktree but fails validation.",
	SCHEMA_PREVIEW_INVALID: "The preview record is unreadable or off shape.",
	DOMAIN_CONFIG_MISSING: "No vault is configured and --vault was not given.",
	DOMAIN_VAULT_NOT_FOUND: "The vault path does not resolve.",
	DOMAIN_CANONICAL_NOT_MAIN: "The vault is not the root checkout with main checked out.",
	DOMAIN_PATH_REFUSED: "An admitted path escapes the vault or crosses a symbolic link.",
	DOMAIN_CANDIDATE_NOT_FOUND: "No candidate worktree exists at that path and no receipt records it.",
	DOMAIN_CANDIDATE_INVALID: "The committed candidate is dirty, has more than one commit, or its paths differ from the admitted set.",
	DOMAIN_PATH_SET_MISMATCH: "The changed paths differ from the admitted set.",
	DOMAIN_CHECK_FAILED: "bun run check failed inside the candidate.",
	DOMAIN_FORMAT_FAILED: "Whitespace findings in the admitted files.",
	DOMAIN_GUARD_INCOMPATIBLE: "The installed reference-transaction hook denies a ref Vault Steward must write.",
	DOMAIN_CANONICAL_NOT_READY: "The canonical checkout is not on main or is dirty.",
	DOMAIN_MAIN_DIVERGED: "The candidate base is no longer an ancestor of main.",
	DOMAIN_SEMANTIC_OVERLAP: "Main changed an admitted path since the candidate began.",
	DOMAIN_PREVIEW_NOT_FOUND: "No preview record exists for this candidate.",
	DOMAIN_PREVIEW_CONSUMED: "The preview was already consumed by an earlier apply.",
	DOMAIN_PREVIEW_STALE: "The preview no longer matches the candidate or main.",
	DOMAIN_REBASE_CONFLICT: "The rebase onto the moved main conflicted and was aborted.",
	DOMAIN_REBASED_CHECK_FAILED: "The checker failed on the rebased candidate.",
	DOMAIN_RECOVERY_UNPROVABLE: "Git does not prove that main contains the candidate's own commit.",
	TRANSIENT_INTEGRATION_BUSY: "Another finisher holds the local integration lock.",
	INTERNAL_GIT_FAILED_UNCHANGED: "A Git command failed before any effect.",
	INTERNAL_GIT_FAILED_PARTIAL: "A Git command failed after a confirmed effect.",
	INTERNAL_GIT_FAILED_UNKNOWN: "A Git command failed while an effect's result was not established.",
	INTERNAL_INTEGRATION_UNPROVED: "The fast-forward of main could not be proven by read-back.",
	INTERNAL_INTEGRATION_UNPROVED_UNCHANGED: "The fast-forward did not happen and the candidate was restored.",
	INTERNAL_COMPLETION_RECORD_FAILED: "The completion record could not be finished after the fast-forward.",
	INTERNAL_UNEXPECTED_UNCHANGED: "An unclassified error occurred before any effect.",
	INTERNAL_UNEXPECTED_UNKNOWN: "An unclassified error occurred while an effect was in flight.",
}

// A human sentence for the message: the cause's sentence plus the facts of this run. Agents match on causeCode.
function describe(cause: ProductCause, facts: RefusalFacts): string {
	const parts: string[] = [SENTENCE[cause]]
	if (facts.detail) parts.push(facts.detail)
	if (facts.overlap?.length) parts.push(`overlapping paths: ${facts.overlap.join(", ")}`)
	if (facts.ref) parts.push(`denied ref: ${facts.ref}`)
	if (facts.diagnostics?.length) parts.push(facts.diagnostics.join("; "))
	if (facts.diagnosticsPath) parts.push(`checker diagnostics at ${facts.diagnosticsPath}`)
	if (facts.worktree) parts.push(`candidate ${facts.worktree}`)
	return parts.join(" ")
}

function nextActionFor(station: StationRow, guidance: Guidance): CommandIdentity {
	const preferred = guidance.next
	if (preferred !== null && (station.nextActions as readonly string[]).includes(preferred)) return preferred
	const first = station.nextActions[0]
	return isCommandIdentity(first) ? first : "vault-steward.help"
}

function handoffFor(station: StationRow, message: string, facts: RefusalFacts): Handoff {
	const inspect = facts.worktree ? [`vault-steward inspect --worktree ${facts.worktree} --json`] : ["vault-steward --discover --json"]
	const owner = handoffOwner(station.causeCode)
	return facts.worktree ? { owner, reason: message, inspect, resource: { kind: "candidate-worktree", id: facts.worktree } } : { owner, reason: message, inspect }
}

function effectsFor(inventory: readonly EffectId[], transaction: TransactionState, facts: RefusalFacts): Effects {
	const completed = [...(facts.completedEffects ?? [])].sort()
	const uncertain = [...(facts.uncertainEffects ?? [])].sort()
	const remaining = inventory.filter((effect) => !completed.includes(effect) && !uncertain.includes(effect)).sort()
	if (transaction === "unchanged") return { completed: [], remaining: [...inventory].sort(), uncertain: [], inventoryComplete: true }
	if (transaction === "partially-completed") return { completed, remaining, uncertain: [], inventoryComplete: true }
	return { completed, remaining: uncertain.length > 0 ? remaining : [], uncertain: uncertain.length > 0 ? uncertain : remaining, inventoryComplete: true }
}

function refusalResult(decision: RefusalDecision, runId: string): { result: ContractResult; message: string } {
	const { identity, refusal, inventory } = decision
	const cause = productCause(refusal.reason, refusal.transaction)
	const declared = stationFor(identity, cause)
	// An undeclared cause on this command is an internal inconsistency; the envelope stays valid and names it.
	const station = declared ?? stationFor(identity, "INTERNAL_UNEXPECTED_UNCHANGED")
	if (station === undefined) throw new Error(`no station for ${identity} ${cause}`)
	const message = declared === undefined ? `Undeclared cause ${cause} on ${identity}; ${describe(cause, refusal.facts)}` : describe(cause, refusal.facts)
	const guidance = REPAIR[cause]
	const effectClass = declarationForIdentity(identity).effectClass
	const transaction = declared === undefined ? "unchanged" : refusal.transaction
	const effects = effectClass === "inspect" ? { completed: [], remaining: [], uncertain: [], inventoryComplete: true } : effectsFor(inventory, transaction, refusal.facts)
	const rule = causeRule(station.causeCode)
	const base = { runId, commandIdentity: identity, effectClass, transactionState: station.transactionState, causeCode: station.causeCode, failureClass: rule.failureClass as ContractResult["failureClass"], exitCode: station.exit, data: null, repairAction: guidance.repair, effects, ...(refusal.facts.runId ? { idempotencyKey: refusal.facts.runId } : {}) }
	const guided = station.guidance === "handoff" ? { ...base, handoff: handoffFor(station, message, refusal.facts) } : { ...base, nextAction: nextActionFor(station, guidance) }
	const retry = station.retryable ? { retryable: true, retryDelayMilliseconds: RETRY_DELAY_MS } : { retryable: false }
	return { result: { ...guided, outcome: station.outcome, ...retry } as unknown as ContractResult, message }
}

function successResult(decision: SuccessDecision, runId: string): ContractResult {
	const effectClass = declarationForIdentity(decision.identity).effectClass
	const completed = [...decision.completed].sort()
	return {
		runId,
		commandIdentity: decision.identity,
		outcome: "success",
		effectClass,
		transactionState: decision.cause === "SUCCESS_COMPLETED" ? "completed" : "unchanged",
		causeCode: decision.cause,
		failureClass: null,
		exitCode: 0,
		data: decision.data,
		retryable: false,
		repairAction: null,
		effects: { completed, remaining: [], uncertain: [], inventoryComplete: true },
		nextAction: decision.nextAction,
		...(decision.idempotencyKey === undefined ? {} : { idempotencyKey: decision.idempotencyKey }),
	} as ContractResult
}

function paths(...extra: (string | undefined)[]): string[] {
	return [...new Set(["vault-steward.discovery", "vault-steward.help", ...extra.filter((value): value is string => value !== undefined && isCommandIdentity(value))])].sort()
}

function envelope(message: string, result: ContractResult, diagnostics?: Diagnostics): EnvelopeV2 {
	return { envelopeVersion: ENVELOPE_VERSION, contractVersion: CONTRACT_VERSION, message, availablePaths: paths(result.nextAction, result.commandIdentity), result, ...(diagnostics === undefined ? {} : { diagnostics }) }
}

function usageEnvelope(identity: CommandIdentity, runId: string, cause: "USAGE_INVALID_INVOCATION" | "USAGE_UNKNOWN_COMMAND", message: string): EnvelopeV2 {
	const effectClass = declarationForIdentity(identity).effectClass
	const route = (Object.keys(INVENTORY) as CommandRoute[]).find((candidate) => declarationForRoute(candidate).identity === identity)
	const remaining = effectClass === "inspect" || route === undefined ? [] : [...INVENTORY[route]].sort()
	const nextAction = cause === "USAGE_UNKNOWN_COMMAND" && identity === "vault-steward.command-discovery" ? "vault-steward.discovery" : "vault-steward.help"
	const result: ContractResult = { runId, commandIdentity: identity, outcome: "refused", effectClass, transactionState: "unchanged", causeCode: cause, failureClass: "usage", exitCode: 2, data: null, retryable: false, repairAction: cause === "USAGE_UNKNOWN_COMMAND" ? "Select a canonical command from --discover --json or run --help." : "Correct the command arguments; run --help for the accepted forms.", effects: { completed: [], remaining, uncertain: [], inventoryComplete: true }, nextAction }
	return envelope(message, result)
}

// ---------------------------------------------------------------------------------------------------------------------
// Diagnostics disclosure and the machine writer

type SinkFailure = Extract<Diagnostics, { status: "available" }>["sinkFailure"]
const SINK_FAILURES: readonly SinkFailure[] = ["capacity", "setup", "write", "flush-timeout", "close"]
function diagnosticsDisclosure(status: DiagnosticsStatus): Diagnostics {
	const sinkFailure = status.sinkFailure === null ? null : SINK_FAILURES.includes(status.sinkFailure as SinkFailure) ? (status.sinkFailure as SinkFailure) : "write"
	if (status.file === null || status.droppedRecords === null || status.unflushedRecords === null || status.truncatedRecords === null || status.countsComplete === null || status.closed === null) {
		return { status: "unavailable", reason: "status-unavailable", trusted: { file: status.file, sinkFailure } }
	}
	return { status: "available", file: status.file, sinkFailure, droppedRecords: status.droppedRecords, unflushedRecords: status.unflushedRecords, truncatedRecords: status.truncatedRecords, countsComplete: status.countsComplete, closed: status.closed }
}

// Every machine outcome emits exactly one validated envelope. A candidate the schema rejects yields the bounded
// internal fallback that keeps the identity and the trusted effect facts (effects and transaction state when they
// validate on their own, else unknown with an incomplete inventory), exit 1, never a replay.
const effectsSchema = MachineEnvelopeSchema.shape.result.options[0].shape.effects
function trustedEffects(candidate: EnvelopeV2): { transactionState: "unchanged" | "partially-completed" | "unknown"; effects: Effects; causeCode: "INTERNAL_UNEXPECTED_UNCHANGED" | "INTERNAL_UNEXPECTED_UNKNOWN" } {
	const parsed = effectsSchema.safeParse(candidate.result?.effects)
	const state = candidate.result?.transactionState
	const unknown = { transactionState: "unknown" as const, effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: false }, causeCode: "INTERNAL_UNEXPECTED_UNKNOWN" as const }
	if (!parsed.success) return unknown
	const effects = parsed.data
	if (state === "unchanged" && effects.completed.length === 0 && effects.uncertain.length === 0 && effects.inventoryComplete) return { transactionState: "unchanged", effects, causeCode: "INTERNAL_UNEXPECTED_UNCHANGED" }
	if (state === "partially-completed" && effects.completed.length > 0 && effects.remaining.length > 0 && effects.uncertain.length === 0 && effects.inventoryComplete) return { transactionState: "partially-completed", effects, causeCode: "INTERNAL_UNEXPECTED_UNKNOWN" }
	return effects.uncertain.length > 0 || !effects.inventoryComplete ? { ...unknown, effects } : unknown
}

function emitMachine(candidate: EnvelopeV2, io: Io): number {
	const parsed = isJson(candidate) ? MachineEnvelopeSchema.safeParse(candidate) : null
	if (parsed?.success) {
		io.stdout(`${JSON.stringify(parsed.data)}\n`)
		return parsed.data.result.exitCode
	}
	const identity = isCommandIdentity(candidate.result?.commandIdentity) ? candidate.result.commandIdentity : "vault-steward.dispatch"
	const effectClass = declarationForIdentity(identity).effectClass
	const facts = effectClass === "inspect" ? { transactionState: "unchanged" as const, effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true }, causeCode: "INTERNAL_UNEXPECTED_UNCHANGED" as const } : trustedEffects(candidate)
	const partial = facts.transactionState === "partially-completed"
	const fallback: EnvelopeV2 = {
		envelopeVersion: ENVELOPE_VERSION,
		contractVersion: CONTRACT_VERSION,
		message: "The result could not be serialized as a valid 2.0 envelope; the effect facts below are the trusted ones.",
		availablePaths: paths(identity),
		result: {
			runId: typeof candidate.result?.runId === "string" && candidate.result.runId ? candidate.result.runId : "run-unknown",
			commandIdentity: identity,
			outcome: "failed",
			effectClass,
			// A partially-completed candidate keeps its state under the unknown cause: the record is what failed.
			transactionState: partial ? "unknown" : facts.transactionState,
			causeCode: facts.causeCode,
			failureClass: "internal",
			exitCode: 1,
			data: null,
			retryable: false,
			repairAction: "Inspect the candidate and the diagnostics file before retrying; nothing is replayed.",
			effects: partial ? { ...facts.effects, uncertain: facts.effects.remaining, remaining: [] } : facts.effects,
			handoff: { owner: "operator", reason: "envelope serialization failed", inspect: ["vault-steward --discover --json"] },
		},
	}
	io.stdout(`${JSON.stringify(fallback)}\n`)
	return 1
}

function renderHuman(decision: Decision, result: ContractResult, message: string, io: Io): void {
	for (const warning of decision.warnings) io.stderr(`warning: ${warning.code} ${warning.detail}\n`)
	if (result.outcome === "success") {
		io.stdout(`${result.causeCode}: ${message}\n`)
		if (decision.kind === "success" && decision.identity === "vault-steward.inspect") io.stdout(`${JSON.stringify(decision.data)}\n`)
		return
	}
	io.stderr(`${result.causeCode}: ${message} (repair: ${result.repairAction})\n`)
}

function stationLine(station: PublicStation): string {
	const guidance = station.guidance.kind === "handoff" ? `handoff ${station.guidance.owners.join("/")}` : `next ${station.guidance.nextActions.join(",")}`
	return `  ${station.outcome} | ${station.causeCode} | ${station.transactionState} | exit ${station.exitCode} | retryable ${station.retryable} | ${guidance} | ${station.reachability}`
}

function discoveryText(): string {
	const data = discovery()
	return `vault-steward contract ${data.contractVersion} (${data.profile})\n${data.commands.map((command) => `  ${command.commandIdentity}  ${command.effectClass}  ${command.summary}`).join("\n")}\nexits: ${Object.entries(data.exitMeanings)
		.map(([code, meaning]) => `${code}=${meaning}`)
		.join(" ")}\n`
}

function usageRefusal(session: Session, identity: CommandIdentity, cause: "USAGE_INVALID_INVOCATION" | "USAGE_UNKNOWN_COMMAND", message: string): number {
	if (!session.jsonMode) {
		session.io.stderr(`${cause}: ${message} (repair: run vault-steward --help)\n`)
		return 2
	}
	return emitMachine(usageEnvelope(identity, session.runId, cause, message), session.io)
}

function successEnvelope(identity: CommandIdentity, runId: string, message: string, data: JsonValue, nextAction: CommandIdentity): EnvelopeV2 {
	const result: ContractResult = { runId, commandIdentity: identity, outcome: "success", effectClass: "inspect", transactionState: "unchanged", causeCode: "SUCCESS_UNCHANGED", failureClass: null, exitCode: 0, data, retryable: false, repairAction: null, effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true }, nextAction }
	return envelope(message, result)
}

function runHelp(session: Session): number {
	if (!session.jsonMode) {
		session.io.stdout(HELP_TEXT)
		return 0
	}
	return emitMachine(successEnvelope("vault-steward.help", session.runId, "Help and usage", HELP_DATA as unknown as JsonValue, "vault-steward.discovery"), session.io)
}

function runDiscover(session: Session): number {
	if (!session.jsonMode) {
		session.io.stdout(discoveryText())
		return 0
	}
	return emitMachine(successEnvelope("vault-steward.discovery", session.runId, "Command discovery completed", discovery() as unknown as JsonValue, "vault-steward.command-discovery"), session.io)
}

function runCommandDiscovery(session: Session, parsed: Parsed): number {
	const identity = "vault-steward.command-discovery"
	const selected = parsed.values["discover-command"]
	const command = COMMANDS.find((candidate) => candidate.commandIdentity === selected)
	if (command === undefined) return usageRefusal(session, identity, "USAGE_UNKNOWN_COMMAND", `unknown command identity ${String(selected)}`)
	const data = commandDiscovery(command)
	if (!session.jsonMode) {
		session.io.stdout(`${data.command.commandIdentity}: possible outcomes\n`)
		for (const station of data.stations) session.io.stdout(`${stationLine(station)}\n`)
		return 0
	}
	return emitMachine(successEnvelope(identity, session.runId, `Possible outcomes of ${command.commandIdentity}`, data as unknown as JsonValue, command.commandIdentity), session.io)
}

function decide(rt: Runtime, route: CommandRoute, parsed: Parsed, session: Session): Decision {
	const identity = declarationForRoute(route).identity
	let inventory = INVENTORY[route]
	try {
		switch (route) {
			case "begin":
				return runBegin(rt, parsed, session)
			case "finish-preview":
				return runFinishPreview(rt, parsed, session)
			case "finish-apply":
				return runFinishApply(rt, parsed, session)
			case "inspect":
				return runInspect(rt, parsed)
			default:
				return runRecover(rt, parsed)
		}
	} catch (error) {
		const refusal = error instanceof Refusal ? error : new Refusal("unexpected", { detail: error instanceof Error ? error.message : String(error) })
		if (route === "finish-preview" && refusal.facts.commit !== undefined && refusal.reason !== "check-failed") inventory = ["preview.record"]
		return { kind: "refusal", identity, refusal, inventory, warnings: warningsOf(refusal.facts.guard) }
	}
}

async function runCommand(session: Session, route: CommandRoute, parsed: Parsed): Promise<number> {
	const faults = parseFaults(session.env.VAULT_STEWARD_FAULT)
	const identity = declarationForRoute(route).identity
	if (faults === null) return usageRefusal(session, identity, "USAGE_INVALID_INVOCATION", "VAULT_STEWARD_FAULT is not a supported fault specification")
	const diagnostics = await openRunDiagnostics({ runId: session.runId, command: identity, env: session.env })
	const rt = withFaults(createRuntime(), faults)
	diagnostics.log("command.start", { route })
	const decision = decide(rt, route, parsed, session)
	const rendered = decision.kind === "success" ? { result: successResult(decision, session.runId), message: decision.message } : refusalResult(decision, session.runId)
	const { result, message } = rendered
	diagnostics.setStation(stationIdOf(result))
	diagnostics.log("command.result", { cause: result.causeCode, transaction: result.transactionState, warnings: decision.warnings.map((warning) => warning.code) })
	const status = await diagnostics.dispose()
	if (!session.jsonMode) {
		renderHuman(decision, result, message, session.io)
		return exitFor(result.failureClass)
	}
	return emitMachine(envelope(message, result, diagnosticsDisclosure(status)), session.io)
}

export interface RunOptions {
	// The fault channel is honoured only when the process runs from source; the shipped bundle ignores it.
	faultsAllowed: boolean
}

export async function run(argv: readonly string[], io: Io, env: Record<string, string | undefined>, runId: string, options: RunOptions): Promise<number> {
	const routed = routeRawArgv(argv)
	const session: Session = { io, runId, env: options.faultsAllowed ? env : { ...env, VAULT_STEWARD_FAULT: undefined }, jsonMode: machineMode(argv) }
	const parsed = parse(argv)
	if ("usage" in parsed) return usageRefusal(session, routed.identity, "USAGE_INVALID_INVOCATION", parsed.usage)
	if (routed.route === "dispatch") {
		const word = controls(argv).find((token) => !token.startsWith("-"))
		return word === undefined ? usageRefusal(session, routed.identity, "USAGE_INVALID_INVOCATION", "a command or a built-in option is required, and built-in options are mutually exclusive") : usageRefusal(session, routed.identity, "USAGE_UNKNOWN_COMMAND", `unknown command ${word}`)
	}
	const violation = shapeViolation(parsed, routed.route)
	if (violation !== null) return usageRefusal(session, routed.identity, "USAGE_INVALID_INVOCATION", violation)
	if (routed.route === "help") return runHelp(session)
	if (routed.route === "discover") return runDiscover(session)
	if (routed.route === "command-discovery") return runCommandDiscovery(session, parsed)
	return runCommand(session, routed.route, parsed)
}
