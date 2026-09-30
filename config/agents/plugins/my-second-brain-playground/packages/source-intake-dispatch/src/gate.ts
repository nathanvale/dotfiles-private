// The exact-item grant gate. The grant and request arrive as one piped JSON document, so the command opens no
// caller-supplied input path. Caller input is fully validated and authorized before any receipt is touched, and every
// outcome that depends on receipt existence, readability or content collapses into the one fixed denial.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

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
const RECEIPT_FILE = "classification-metadata.json"

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

/**
 * The configured state root, unnormalized: XDG_STATE_HOME as the caller spells it, else HOME as spelled plus
 * /.local/state. An empty XDG_STATE_HOME counts as unset. With HOME unset or empty, homedir() returns the home in the
 * operating system's account record instead, so the root is that home plus /.local/state.
 */
function configuredStateHome(): string {
	const configured = process.env.XDG_STATE_HOME || `${homedir()}/.local/state`
	if (!isAbsolute(configured)) throw new Error("relative state home")
	return configured
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
 * state root as raw text, with no normalization of the caller's spelling; nothing is touched before this comparison.
 * The configured root must then be its own canonical physical path (Nathan, 2026-09-30, option 1): a linked root, a
 * root under a linked ancestor, or a non-canonical spelling is denied, so replacing the root node with a link before
 * it is resolved cannot redirect the read. Returns the physical item directory to pin.
 */
function boundItemDirectory(grant: Grant): string | null {
	const configured = configuredStateHome()
	if (grant.receiptPath !== join(configured, ...ITEMS_PATH, grant.opaqueItemRef, RECEIPT_FILE)) return null
	const physical = realpathSync(configured)
	if (physical !== configured) return null
	return join(physical, ...ITEMS_PATH, grant.opaqueItemRef)
}

/**
 * Reads the receipt through its pinned item directory, so no change to the configured tree during the run can move
 * the read into another root. The pinned directory must physically be the expected one; the receipt is opened
 * relative to it without following a link and must be a regular file (a FIFO cannot hang the read) with one link.
 * After the read, the name must still be that same single-link file: a hard link that another root still names is
 * refused, including one unlinked or relinked around the open. Moving a receipt into the configured tree from outside
 * it (by rename, or by linking and then unlinking the original) changes that other root and is outside this guard.
 * Null means the fixed denial.
 */
function readBoundReceipt(itemDirectory: string): string | null {
	process.chdir(itemDirectory)
	if (process.cwd() !== itemDirectory) return null
	const descriptor = openSync(RECEIPT_FILE, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
	try {
		const stat = fstatSync(descriptor)
		if (!stat.isFile() || stat.nlink !== 1) return null
		const text = readFileSync(descriptor, "utf8")
		const named = lstatSync(RECEIPT_FILE)
		return named.dev === stat.dev && named.ino === stat.ino && named.nlink === 1 ? text : null
	} finally {
		closeSync(descriptor)
	}
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
		const itemDirectory = boundItemDirectory(grant)
		const text = itemDirectory === null ? null : readBoundReceipt(itemDirectory)
		if (text === null) return { kind: "denied" }
		const projection = project(JSON.parse(text), request.requestedFields)
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
