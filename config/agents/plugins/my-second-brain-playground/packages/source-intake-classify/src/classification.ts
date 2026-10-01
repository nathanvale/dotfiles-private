// The classifier lane's one result shape: the JSON Schema Codex enforces on the final message, and the validator the
// command applies before returning it. One owner for both.

export interface Classification {
	summary: string
	ownerKind: "area" | "product" | "project" | "none"
	ownerName: string
	competingOwners: string[]
	uncertainty: string
	decisionQuestion: string
	nextAction: string
}

const OWNER_KINDS = ["area", "product", "project", "none"]
const TEXT_FIELDS = ["summary", "ownerName", "uncertainty", "decisionQuestion", "nextAction"] as const
const KEYS = ["competingOwners", "decisionQuestion", "nextAction", "ownerKind", "ownerName", "summary", "uncertainty"]
const MAX_TEXT_CHARS = 4_000

export const CLASSIFICATION_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["summary", "ownerKind", "ownerName", "competingOwners", "uncertainty", "decisionQuestion", "nextAction"],
	properties: {
		summary: { type: "string" },
		ownerKind: { type: "string", enum: OWNER_KINDS },
		ownerName: { type: "string" },
		competingOwners: { type: "array", items: { type: "string" } },
		uncertainty: { type: "string" },
		decisionQuestion: { type: "string" },
		nextAction: { type: "string" },
	},
}

function isText(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_TEXT_CHARS
}

/** Parses the lane's final message. Null means it is not a valid classification. */
export function parseClassification(text: string): Classification | null {
	let value: unknown
	try {
		value = JSON.parse(text)
	} catch {
		return null
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null
	const record = value as Record<string, unknown>
	if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(KEYS)) return null
	if (!TEXT_FIELDS.every((field) => isText(record[field])) || !OWNER_KINDS.includes(String(record.ownerKind))) return null
	const owners = record.competingOwners
	return Array.isArray(owners) && owners.length <= 20 && owners.every(isText) ? (record as unknown as Classification) : null
}
