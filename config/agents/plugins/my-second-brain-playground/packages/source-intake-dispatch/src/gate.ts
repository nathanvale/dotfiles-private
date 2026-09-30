// The exact-item grant gate. The grant and request arrive as one piped JSON document, so the command opens no
// caller-supplied input path. Caller input is fully validated and authorized before any receipt is touched, and every
// outcome that depends on receipt existence, readability or content collapses into the one fixed denial.
import { closeSync, constants, lstatSync, openSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

export type GateOutcome =
	| { kind: "allowed"; opaqueItemRef: string; projection: Record<string, string | number> }
	| { kind: "denied" }
	| { kind: "inputInvalid" }

type Refusal = Exclude<GateOutcome, { kind: "allowed" }>

const CLASSIFICATION_FIELDS = new Set(["displayName", "mimeType", "modifiedTime", "sizeBytes"])
const INPUT_KEYS = ["grant", "request"] as const
const GRANT_KEYS = ["allowedFields", "opaqueItemRef", "provider", "purpose", "receiptPath"] as const
const REQUEST_KEYS = ["opaqueItemRef", "provider", "purpose", "requestedFields"] as const
const OPAQUE_ITEM_REF = /^[a-z0-9][a-z0-9-]{0,63}$/
const DESCRIPTOR_LIMIT_CODES = new Set(["EAGAIN", "EMFILE", "ENFILE"])
const ITEMS_PATH = ["my-second-brain-playground", "drive-inbox-filing", "items"] as const

type Grant = {
	readonly opaqueItemRef: string
	readonly provider: string
	readonly purpose: string
	readonly allowedFields: readonly string[]
	readonly receiptPath: string
}

type Request = Omit<Grant, "allowedFields" | "receiptPath"> & { readonly requestedFields: readonly string[] }

class GateRefusal extends Error {
	constructor(readonly outcome: Refusal) {
		super(outcome.kind)
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0
}

function isFieldList(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString) && new Set(value).size === value.length
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key))
}

function hasItemIdentity(value: Record<string, unknown>): boolean {
	return isNonEmptyString(value.opaqueItemRef) && OPAQUE_ITEM_REF.test(value.opaqueItemRef) && isNonEmptyString(value.provider) && isNonEmptyString(value.purpose)
}

function asGrant(value: unknown): Grant {
	if (!isRecord(value) || !hasOnlyKeys(value, GRANT_KEYS) || !hasItemIdentity(value) || !isNonEmptyString(value.receiptPath) || !isFieldList(value.allowedFields)) {
		throw new GateRefusal({ kind: "inputInvalid" })
	}
	return value as Grant
}

function asRequest(value: unknown): Request {
	if (!isRecord(value) || !hasOnlyKeys(value, REQUEST_KEYS) || !hasItemIdentity(value) || !isFieldList(value.requestedFields)) {
		throw new GateRefusal({ kind: "inputInvalid" })
	}
	return value as Request
}

function stateHome(): string {
	const configured = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state")
	if (!isAbsolute(configured)) throw new Error("relative state home")
	return realpathSync(configured)
}

function parseInput(text: string): { grant: Grant; request: Request } {
	let value: unknown
	try {
		value = JSON.parse(text)
	} catch {
		throw new GateRefusal({ kind: "inputInvalid" })
	}
	if (!isRecord(value) || !hasOnlyKeys(value, INPUT_KEYS)) throw new GateRefusal({ kind: "inputInvalid" })
	return { grant: asGrant(value.grant), request: asRequest(value.request) }
}

function isAuthorized(grant: Grant, request: Request): boolean {
	return (
		grant.provider === "luna" &&
		grant.purpose === "classification" &&
		grant.allowedFields.every((field) => CLASSIFICATION_FIELDS.has(field)) &&
		grant.opaqueItemRef === request.opaqueItemRef &&
		grant.provider === request.provider &&
		grant.purpose === request.purpose &&
		request.requestedFields.every((field) => grant.allowedFields.includes(field))
	)
}

/**
 * The grant's receiptPath is the only caller-named path. It must equal the exact receipt path under the configured
 * state root before anything is touched, and that receipt must not be reached through a link.
 */
function boundReceiptPath(grant: Grant, home: string): string | null {
	const expected = join(home, ...ITEMS_PATH, grant.opaqueItemRef, "classification-metadata.json")
	if (resolve(grant.receiptPath) !== expected) return null
	const expectedParent = dirname(expected)
	const unlinked = !lstatSync(expected).isSymbolicLink() && realpathSync(expectedParent) === expectedParent && realpathSync(expected) === expected
	return unlinked ? expected : null
}

function isMetadataScalar(value: unknown): value is string | number {
	return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
}

function project(receipt: unknown, requestedFields: readonly string[]): Record<string, string | number> | null {
	if (!isRecord(receipt) || !requestedFields.every((field) => Object.hasOwn(receipt, field) && isMetadataScalar(receipt[field]))) return null
	return Object.fromEntries(requestedFields.map((field) => [field, receipt[field] as string | number]))
}

/** Runs only after authorization. Any receipt failure, including I/O and a missing state root, is the same denial. */
function projectReceipt(grant: Grant, request: Request): GateOutcome {
	try {
		const receiptPath = boundReceiptPath(grant, stateHome())
		if (receiptPath === null) return { kind: "denied" }
		const projection = project(JSON.parse(readFileSync(receiptPath, "utf8")), request.requestedFields)
		return projection === null ? { kind: "denied" } : { kind: "allowed", opaqueItemRef: grant.opaqueItemRef, projection }
	} catch {
		return { kind: "denied" }
	}
}

export function isDescriptorLimit(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code
	return code !== undefined && DESCRIPTOR_LIMIT_CODES.has(code)
}

/**
 * Checked once before input is read or any path is resolved, so a descriptor limit is one retryable,
 * receipt-independent refusal instead of a receipt failure folded into the denial.
 */
export function descriptorLimitReached(): boolean {
	try {
		closeSync(openSync("/dev/null", constants.O_RDONLY))
		return false
	} catch (error) {
		return isDescriptorLimit(error)
	}
}

/** Validates the piped grant and request, authorizes them, and only then reads the one bound receipt. */
export function runGate(text: string): GateOutcome {
	let input: { grant: Grant; request: Request }
	try {
		input = parseInput(text)
	} catch (error) {
		return error instanceof GateRefusal ? error.outcome : { kind: "inputInvalid" }
	}
	if (!isAuthorized(input.grant, input.request)) return { kind: "denied" }
	return projectReceipt(input.grant, input.request)
}
