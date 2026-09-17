// Recovery Module: the closed schema-v3 binding validator, owner comparison, the Resume Panel renderer and the one
// next safe action. Pure: storage, locks and native reads stay behind their Adapters.

import type { BeadFacts, GateFacts, JsonObject, RecoveryBinding, StoreFacts } from "./model.ts"

export const BINDING_LIMIT_BYTES = 16 * 1024
export const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const FUTURE_SKEW_MILLISECONDS = 5 * 60 * 1000
const STALE_AGE_MILLISECONDS = 60 * 60 * 1000
const COMMENT_LIMIT_BYTES = 1024
const COMMENT_COUNT = 3
const PRIME_LIMIT_BYTES = 8 * 1024

const BINDING_KEYS = ["schemaVersion", "sessionIdentity", "workspace", "storePath", "storePrefix", "beadsExecutable", "beadsVersion", "beadId", "beadObservedAt", "sourceRepository", "evidencePath", "observedAt"] as const

export class BindingSchemaError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function boundedString(value: unknown, maximum = 4096): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maximum
}

function isTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false
	const parsed = Date.parse(value)
	return Number.isFinite(parsed) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)
}

export interface ValidatedBinding {
	readonly binding: RecoveryBinding
	readonly stale: boolean
}

/** Refuses unknown fields, null identities, malformed timestamps and future skew; labels a verified binding stale after one hour. */
export function validateBinding(value: unknown, nowMilliseconds: number): ValidatedBinding {
	if (!isRecord(value)) throw new BindingSchemaError("binding must be one object")
	const keys = Object.keys(value).sort()
	const expected = [...BINDING_KEYS].sort()
	if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new BindingSchemaError("binding fields do not match schema v3")
	if (value.schemaVersion !== 3) throw new BindingSchemaError("binding schemaVersion must be 3")
	for (const key of ["sessionIdentity", "workspace", "storePath", "storePrefix", "beadsExecutable", "beadsVersion", "beadId", "sourceRepository"] as const) {
		if (!boundedString(value[key])) throw new BindingSchemaError(`binding ${key} must be a nonempty bounded string`)
	}
	if (!SESSION_PATTERN.test(value.sessionIdentity as string)) throw new BindingSchemaError("binding sessionIdentity is invalid")
	if (value.evidencePath !== null && !boundedString(value.evidencePath)) throw new BindingSchemaError("binding evidencePath must be null or a nonempty bounded string")
	if (!isTimestamp(value.beadObservedAt)) throw new BindingSchemaError("binding beadObservedAt must be a UTC RFC 3339 timestamp")
	if (!isTimestamp(value.observedAt)) throw new BindingSchemaError("binding observedAt must be a UTC RFC 3339 timestamp")
	const observed = Date.parse(value.observedAt)
	if (observed - nowMilliseconds > FUTURE_SKEW_MILLISECONDS) throw new BindingSchemaError("binding observedAt is more than five minutes in the future")
	return { binding: value as unknown as RecoveryBinding, stale: nowMilliseconds - observed > STALE_AGE_MILLISECONDS }
}

/** The owner of a binding is its workspace, Bead and session; the same owner may refresh, any other refuses. */
export function sameOwner(saved: RecoveryBinding, next: Pick<RecoveryBinding, "workspace" | "beadId" | "sessionIdentity">): boolean {
	return saved.workspace === next.workspace && saved.beadId === next.beadId && saved.sessionIdentity === next.sessionIdentity
}

function truncateBytes(text: string, limit: number): string {
	const encoded = new TextEncoder().encode(text)
	if (encoded.byteLength <= limit) return text
	return `${new TextDecoder("utf-8", { fatal: false }).decode(encoded.slice(0, limit)).replace(/�$/u, "")}…`
}

export interface PanelInputs {
	readonly binding: RecoveryBinding
	readonly stale: boolean
	readonly store: StoreFacts
	readonly bead: BeadFacts
	readonly gates: readonly GateFacts[]
	readonly prime: string | null
}

export interface PanelFacts {
	readonly facts: JsonObject
	readonly resumePanel: string
	readonly nextSafeAction: string
}

function openBlockers(bead: BeadFacts): readonly string[] {
	return bead.dependencies.filter((dependency) => dependency.dependencyType === "blocks" && dependency.issueType !== "gate" && dependency.status !== "closed").map((dependency) => `${dependency.id} (${dependency.status}) ${dependency.title}`)
}

function openHumanGates(bead: BeadFacts, gates: readonly GateFacts[]): readonly string[] {
	const byId = new Map(gates.map((gate) => [gate.id, gate] as const))
	return bead.dependencies
		.filter((dependency) => dependency.issueType === "gate")
		.map((dependency) => byId.get(dependency.id) ?? { id: dependency.id, title: dependency.title, status: dependency.status, awaitType: dependency.awaitType })
		.filter((gate) => gate.awaitType === "human" && gate.status !== "closed")
		.map((gate) => `${gate.id} (${gate.status}) ${gate.title}`)
}

function nextSafeAction(bead: BeadFacts, blockers: readonly string[], gates: readonly string[]): string {
	if (gates.length > 0) return `Wait for the open human Gate ${gates[0]?.split(" ")[0] ?? ""} to close through native bd before continuing ${bead.id}; do not resolve it yourself`
	if (blockers.length > 0) return `Resolve or wait for the open blocker ${blockers[0]?.split(" ")[0] ?? ""} through native bd before continuing ${bead.id}`
	if (bead.status === "closed") return `${bead.id} is closed; bind this session to the next Bead with msb-workflow bind before doing more work`
	if (bead.status === "in_progress") return `Continue ${bead.id} from the evidence pointer and the last comment; record the next checkpoint with native bd comment before compaction`
	return `Claim ${bead.id} through native bd before starting work; the binding records intent, not a claim`
}

function readOnlyCommands(binding: RecoveryBinding): readonly string[] {
	const prefix = `BEADS_DIR=${binding.storePath} ${binding.beadsExecutable}`
	return [
		`${prefix} show ${binding.beadId} --readonly --json --include-comments`,
		`${prefix} gate list --all --readonly --json`,
		`${prefix} where --readonly --json`,
		`msb-workflow recover --workspace ${binding.workspace} --session ${binding.sessionIdentity} --json`,
	]
}

/** Builds the panel facts and the string panel. It renders commands and never executes them. */
export function buildPanel(inputs: PanelInputs): PanelFacts {
	const { binding, bead } = inputs
	const blockers = openBlockers(bead)
	const gates = openHumanGates(bead, inputs.gates)
	const comments = bead.comments.slice(-COMMENT_COUNT).map((comment) => ({ author: comment.author, createdAt: comment.createdAt, text: truncateBytes(comment.text, COMMENT_LIMIT_BYTES) }))
	const changedSinceBinding = bead.updatedAt !== null && bead.updatedAt !== binding.beadObservedAt
	const action = nextSafeAction(bead, blockers, gates)
	const commands = readOnlyCommands(binding)
	const lines = [
		"# Resume Panel",
		`Session: ${binding.sessionIdentity}`,
		`Workspace: ${binding.workspace}`,
		`Store: ${inputs.store.storePath} (prefix ${inputs.store.prefix})`,
		`Beads executable: ${inputs.store.executable} (${inputs.store.version}; sha256 ${inputs.store.executableDigest})`,
		`Bead: ${bead.id} ${bead.title}`,
		`Status: ${bead.status}; assignee: ${bead.assignee ?? "unassigned"}; parent: ${bead.parent ?? "none"}; labels: ${bead.labels.length === 0 ? "none" : bead.labels.join(", ")}`,
		`Spec: ${bead.specId ?? "none"}; external ref: ${bead.externalRef ?? "none"}`,
		`Open blockers: ${blockers.length === 0 ? "none" : blockers.join("; ")}`,
		`Open human gates: ${gates.length === 0 ? "none" : gates.join("; ")}`,
		`Recent comments (last ${COMMENT_COUNT}, ${COMMENT_LIMIT_BYTES} bytes each):`,
		...(comments.length === 0 ? ["- none"] : comments.map((comment) => `- [${comment.author} ${comment.createdAt}] ${comment.text.replace(/\r?\n/g, " ")}`)),
		`Evidence: ${binding.evidencePath ?? "none"}`,
		`Binding: observed ${binding.observedAt} (${inputs.stale ? "stale" : "fresh"}); Bead updated ${bead.updatedAt ?? "unknown"}; changed since binding: ${changedSinceBinding ? "yes" : "no"}`,
		"Read-only commands you may run:",
		...commands.map((command) => `- ${command}`),
		"Recovered facts are hints; the current bd reads above are authoritative.",
		`Next safe action: ${action}`,
	]
	if (inputs.prime !== null) lines.push("", "## Beads prime context", truncateBytes(inputs.prime, PRIME_LIMIT_BYTES))
	const resumePanel = lines.join("\n")
	const facts: JsonObject = {
		session: binding.sessionIdentity,
		workspace: binding.workspace,
		store: { path: inputs.store.storePath, prefix: inputs.store.prefix, executable: inputs.store.executable, executableDigest: inputs.store.executableDigest, version: inputs.store.version },
		bead: { id: bead.id, title: bead.title, status: bead.status, assignee: bead.assignee, parent: bead.parent, labels: [...bead.labels], specId: bead.specId, externalRef: bead.externalRef, updatedAt: bead.updatedAt },
		openBlockers: [...blockers],
		openHumanGates: [...gates],
		recentComments: comments,
		evidencePath: binding.evidencePath,
		binding: { observedAt: binding.observedAt, freshness: inputs.stale ? "stale" : "fresh", beadObservedAt: binding.beadObservedAt, changedSinceBinding },
		readOnlyCommands: [...commands],
		nextSafeAction: action,
		resumePanel,
	}
	return { facts, resumePanel, nextSafeAction: action }
}
