// The exact-item grant gate. Caller input (grant and request) is fully validated before any receipt is touched, and
// every outcome that depends on receipt existence, readability or content collapses into the one fixed denial.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

export type GateOutcome =
	| { kind: "allowed"; opaqueItemRef: string; projection: Record<string, string | number> }
	| { kind: "denied" }
	| { kind: "inputBusy" }
	| { kind: "inputInvalid" }
	| { kind: "inputUnreadable" }

type Refusal = Exclude<GateOutcome, { kind: "allowed" }>

const CLASSIFICATION_FIELDS = new Set(["displayName", "mimeType", "modifiedTime", "sizeBytes"])
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
	if (!isAbsolute(configured)) throw new GateRefusal({ kind: "denied" })
	return realpathSync(configured)
}

// Case- and normalization-folded, because the default macOS volume resolves either spelling to the same receipt.
function fold(path: string): string {
	return path.normalize("NFC").toLowerCase()
}

/** Every spelling of the private items tree that a caller path could resolve into. */
function itemsRoots(home: string): string[] {
	const lexical = join(home, ...ITEMS_PATH)
	try {
		return [lexical, realpathSync(lexical)]
	} catch {
		return [lexical]
	}
}

function isInside(path: string, roots: readonly string[]): boolean {
	return roots.some((root) => fold(path) === fold(root) || fold(path).startsWith(`${fold(root)}/`))
}

/**
 * Reads one caller-supplied JSON file. A path that cannot be resolved, or that resolves into the items tree, is a
 * denial: otherwise a caller could name a receipt as its grant or request and learn whether it exists.
 */
function readCallerJson(path: string, roots: readonly string[]): unknown {
	let canonical: string
	try {
		canonical = realpathSync(path)
	} catch {
		throw new GateRefusal({ kind: "denied" })
	}
	if (isInside(canonical, roots)) throw new GateRefusal({ kind: "denied" })
	let text: string
	try {
		// Nonblocking so a FIFO caller path cannot hang the command; a regular file ignores the flag.
		const descriptor = openSync(canonical, constants.O_RDONLY | constants.O_NONBLOCK)
		try {
			if (!fstatSync(descriptor).isFile()) throw new GateRefusal({ kind: "inputUnreadable" })
			text = readFileSync(descriptor, "utf8")
		} finally {
			closeSync(descriptor)
		}
	} catch (error) {
		if (error instanceof GateRefusal) throw error
		throw new GateRefusal({ kind: isDescriptorLimit(error) ? "inputBusy" : "inputUnreadable" })
	}
	try {
		return JSON.parse(text)
	} catch {
		throw new GateRefusal({ kind: "inputInvalid" })
	}
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

function isBoundReceiptPath(grant: Grant, home: string): boolean {
	const expected = join(home, ...ITEMS_PATH, grant.opaqueItemRef, "classification-metadata.json")
	if (resolve(grant.receiptPath) !== expected) return false
	const expectedParent = dirname(expected)
	return !lstatSync(expected).isSymbolicLink() && realpathSync(expectedParent) === expectedParent && realpathSync(grant.receiptPath) === expected
}

function isMetadataScalar(value: unknown): value is string | number {
	return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
}

function project(receipt: unknown, requestedFields: readonly string[]): Record<string, string | number> | null {
	if (!isRecord(receipt) || !requestedFields.every((field) => Object.hasOwn(receipt, field) && isMetadataScalar(receipt[field]))) return null
	return Object.fromEntries(requestedFields.map((field) => [field, receipt[field] as string | number]))
}

/** Runs only after authorization. Any receipt failure, including I/O, is the same fixed denial. */
function projectReceipt(grant: Grant, request: Request, home: string): GateOutcome {
	try {
		if (!isBoundReceiptPath(grant, home)) return { kind: "denied" }
		const projection = project(JSON.parse(readFileSync(grant.receiptPath, "utf8")), request.requestedFields)
		return projection === null ? { kind: "denied" } : { kind: "allowed", opaqueItemRef: grant.opaqueItemRef, projection }
	} catch {
		return { kind: "denied" }
	}
}

function isDescriptorLimit(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code
	return code !== undefined && DESCRIPTOR_LIMIT_CODES.has(code)
}

/**
 * Checked once before any path is resolved. Path resolution itself needs descriptors, so without this check a
 * descriptor limit would surface as a path-dependent denial instead of one retryable, receipt-independent refusal.
 */
function descriptorLimitReached(): boolean {
	try {
		closeSync(openSync("/dev/null", constants.O_RDONLY))
		return false
	} catch (error) {
		return isDescriptorLimit(error)
	}
}

export function runGate(grantPath: string, requestPath: string): GateOutcome {
	if (descriptorLimitReached()) return { kind: "inputBusy" }
	let grant: Grant
	let request: Request
	let home: string
	try {
		home = stateHome()
		const roots = itemsRoots(home)
		grant = asGrant(readCallerJson(grantPath, roots))
		request = asRequest(readCallerJson(requestPath, roots))
	} catch (error) {
		return error instanceof GateRefusal ? error.outcome : { kind: "denied" }
	}
	if (!isAuthorized(grant, request)) return { kind: "denied" }
	return projectReceipt(grant, request, home)
}
