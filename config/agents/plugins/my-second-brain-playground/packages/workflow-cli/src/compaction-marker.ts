// The compaction refresh marker state machine. Pure: the Recovery Adapter owns the bytes beside the binding.
//
// Each PostCompact mints one monotonic generation under the session lock ("pending"). The next UserPromptSubmit
// reads the panel, then claims every pending generation at once ("claimed", persisted before any output), emits one
// panel, then records each claimed generation as "delivered". A refused read before the claim leaves the generations
// "pending" so the next prompt retries. A process that dies between the claim and the delivery record leaves
// "claimed" generations behind; the next prompt treats them as uncertain, emits the one-line notice instead of a
// panel, and records them (and any newer pending generation) as "notified" so the notice is an explicit handoff
// rather than a repeating replay.

export type GenerationState = "pending" | "claimed" | "delivered" | "notified"

export interface MarkerGeneration {
	readonly generation: number
	readonly state: GenerationState
	readonly recordedAt: string
	readonly claimedAt: string | null
	readonly claimedBy: string | null
	readonly settledAt: string | null
}

export interface CompactionMarker {
	readonly schemaVersion: 1
	readonly sessionIdentity: string
	readonly generations: readonly MarkerGeneration[]
}

export const MARKER_LIMIT_BYTES = 64 * 1024
const RETAINED_SETTLED = 16

export class MarkerSchemaError extends Error {}

const STATES: readonly GenerationState[] = ["pending", "claimed", "delivered", "notified"]

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string"
}

function parseGeneration(value: unknown): MarkerGeneration {
	if (!isRecord(value)) throw new MarkerSchemaError("generation must be one object")
	const keys = Object.keys(value).sort().join(",")
	if (keys !== "claimedAt,claimedBy,generation,recordedAt,settledAt,state") throw new MarkerSchemaError("generation fields do not match marker schema v1")
	if (typeof value.generation !== "number" || !Number.isInteger(value.generation) || value.generation < 1) throw new MarkerSchemaError("generation must be a positive integer")
	if (!STATES.includes(value.state as GenerationState)) throw new MarkerSchemaError("generation state is unknown")
	if (typeof value.recordedAt !== "string" || !nullableString(value.claimedAt) || !nullableString(value.claimedBy) || !nullableString(value.settledAt)) throw new MarkerSchemaError("generation timestamps are invalid")
	return value as unknown as MarkerGeneration
}

export function emptyMarker(sessionIdentity: string): CompactionMarker {
	return { schemaVersion: 1, sessionIdentity, generations: [] }
}

export function parseMarker(value: unknown, sessionIdentity: string): CompactionMarker {
	if (!isRecord(value)) throw new MarkerSchemaError("marker must be one object")
	if (Object.keys(value).sort().join(",") !== "generations,schemaVersion,sessionIdentity") throw new MarkerSchemaError("marker fields do not match marker schema v1")
	if (value.schemaVersion !== 1) throw new MarkerSchemaError("marker schemaVersion must be 1")
	if (value.sessionIdentity !== sessionIdentity) throw new MarkerSchemaError("marker belongs to another session")
	if (!Array.isArray(value.generations)) throw new MarkerSchemaError("marker generations must be an array")
	const generations = value.generations.map(parseGeneration)
	for (let index = 1; index < generations.length; index += 1) {
		if ((generations[index]?.generation ?? 0) <= (generations[index - 1]?.generation ?? 0)) throw new MarkerSchemaError("marker generations must be strictly increasing")
	}
	return { schemaVersion: 1, sessionIdentity, generations }
}

/** Keeps every open generation and only the newest settled ones so the marker stays bounded. */
function bounded(generations: readonly MarkerGeneration[]): readonly MarkerGeneration[] {
	const settled = generations.filter((generation) => generation.state === "delivered" || generation.state === "notified")
	const drop = new Set(settled.slice(0, Math.max(0, settled.length - RETAINED_SETTLED)).map((generation) => generation.generation))
	return generations.filter((generation) => !drop.has(generation.generation))
}

/** PostCompact: mint the next monotonic generation as pending. */
export function recordGeneration(marker: CompactionMarker, now: string): { readonly marker: CompactionMarker; readonly generation: number } {
	const last = marker.generations.at(-1)?.generation ?? 0
	const generation = last + 1
	return { marker: { ...marker, generations: bounded([...marker.generations, { generation, state: "pending", recordedAt: now, claimedAt: null, claimedBy: null, settledAt: null }]) }, generation }
}

export type PromptDecision =
	| { readonly kind: "silent" }
	| { readonly kind: "deliver"; readonly claimed: readonly number[]; readonly marker: CompactionMarker }
	/** `uncertain` were claimed and never recorded delivered; `folded` were still pending and settle with the notice. */
	| { readonly kind: "notice"; readonly uncertain: readonly number[]; readonly folded: readonly number[]; readonly marker: CompactionMarker }

/** UserPromptSubmit, first half: decide what this prompt does and produce the marker to persist before any output. */
export function claimForPrompt(marker: CompactionMarker, runIdentity: string, now: string): PromptDecision {
	const uncertain = marker.generations.filter((generation) => generation.state === "claimed").map((generation) => generation.generation)
	if (uncertain.length > 0) {
		// Every open generation, claimed or still pending, is folded into the one notice; nothing is replayed blind.
		const folded = marker.generations.filter((generation) => generation.state === "pending").map((generation) => generation.generation)
		const generations = marker.generations.map((generation) => (generation.state === "claimed" || generation.state === "pending" ? { ...generation, state: "notified" as const, settledAt: now } : generation))
		return { kind: "notice", uncertain, folded, marker: { ...marker, generations: bounded(generations) } }
	}
	const pending = marker.generations.filter((generation) => generation.state === "pending").map((generation) => generation.generation)
	if (pending.length === 0) return { kind: "silent" }
	const generations = marker.generations.map((generation) => (generation.state === "pending" ? { ...generation, state: "claimed" as const, claimedAt: now, claimedBy: runIdentity } : generation))
	return { kind: "deliver", claimed: pending, marker: { ...marker, generations } }
}

/** UserPromptSubmit, second half: after the panel left the process, record every claimed generation as delivered. */
export function recordDelivered(marker: CompactionMarker, claimed: readonly number[], now: string): CompactionMarker {
	const set = new Set(claimed)
	return { ...marker, generations: bounded(marker.generations.map((generation) => (set.has(generation.generation) && generation.state === "claimed" ? { ...generation, state: "delivered" as const, settledAt: now } : generation))) }
}

export interface MarkerSummary {
	readonly pending: readonly number[]
	readonly uncertain: readonly number[]
	readonly delivered: number
	readonly notified: number
}

export function summarizeMarker(marker: CompactionMarker): MarkerSummary {
	const of = (state: GenerationState): number[] => marker.generations.filter((generation) => generation.state === state).map((generation) => generation.generation)
	return { pending: of("pending"), uncertain: of("claimed"), delivered: of("delivered").length, notified: of("notified").length }
}
