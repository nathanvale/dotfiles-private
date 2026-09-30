// The lane input: the #155 dispatch projection, public owner notes and redacted Bead state, piped as one JSON document.
// Validated from unknown before any lane setup. The closed field list keeps a raw receipt or a receipt path out of the
// model's context: only the granted metadata fields can pass.

export interface LaneInput {
	dispatch: { opaqueItemRef: string; projection: Record<string, string | number> }
	ownerNotes: { title: string; text: string }[]
	beadState: string
}

const INPUT_KEYS = ["beadState", "dispatch", "ownerNotes"]
const DISPATCH_KEYS = ["opaqueItemRef", "projection"]
const NOTE_KEYS = ["text", "title"]
const PROJECTION_FIELDS = new Set(["displayName", "mimeType", "modifiedTime", "sizeBytes"])
const OPAQUE_ITEM_REF = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_NOTES = 50
const MAX_TITLE_CHARS = 200
const MAX_NOTE_CHARS = 32 * 1024
const MAX_BEAD_STATE_CHARS = 16 * 1024
const MAX_PROJECTION_VALUE_CHARS = 1024

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys)
}

function isBoundedText(value: unknown, max: number, allowEmpty: boolean): value is string {
	return typeof value === "string" && value.length <= max && (allowEmpty || value.trim() !== "")
}

function isProjectionValue(value: unknown): value is string | number {
	if (typeof value === "number") return Number.isFinite(value)
	return isBoundedText(value, MAX_PROJECTION_VALUE_CHARS, true)
}

function isProjection(value: unknown): value is Record<string, string | number> {
	if (!isRecord(value)) return false
	const entries = Object.entries(value)
	return entries.length > 0 && entries.every(([field, fieldValue]) => PROJECTION_FIELDS.has(field) && isProjectionValue(fieldValue))
}

function isDispatch(value: unknown): value is LaneInput["dispatch"] {
	if (!isRecord(value) || !hasExactKeys(value, DISPATCH_KEYS)) return false
	return typeof value.opaqueItemRef === "string" && OPAQUE_ITEM_REF.test(value.opaqueItemRef) && isProjection(value.projection)
}

function isNote(value: unknown): value is LaneInput["ownerNotes"][number] {
	return isRecord(value) && hasExactKeys(value, NOTE_KEYS) && isBoundedText(value.title, MAX_TITLE_CHARS, false) && isBoundedText(value.text, MAX_NOTE_CHARS, false)
}

/** Parses and validates the piped lane input. Null means the fixed schema refusal. */
export function parseLaneInput(text: string): LaneInput | null {
	let value: unknown
	try {
		value = JSON.parse(text)
	} catch {
		return null
	}
	if (!isRecord(value) || !hasExactKeys(value, INPUT_KEYS) || !isDispatch(value.dispatch)) return null
	const notes = value.ownerNotes
	if (!Array.isArray(notes) || notes.length > MAX_NOTES || !notes.every(isNote)) return null
	if (!isBoundedText(value.beadState, MAX_BEAD_STATE_CHARS, false)) return null
	return { dispatch: value.dispatch, ownerNotes: notes, beadState: value.beadState }
}
