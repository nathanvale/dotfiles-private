// The exact-item grant gate. Caller input (grant and request) is fully validated before any receipt is touched, and
// every outcome that depends on receipt existence, readability or content collapses into the one fixed denial.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync, type Stats, statSync } from "node:fs"
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
const MAX_LINK_HOPS = 40
// The account record, read by absolute path with an empty environment so $HOME cannot redirect it.
const ACCOUNT_RECORD_COMMANDS: Partial<Record<NodeJS.Platform, (uid: number) => string[]>> = {
	darwin: () => ["/usr/bin/id", "-P"],
	linux: (uid) => ["/usr/bin/getent", "passwd", String(uid)],
}

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

/**
 * The account's default state root from the OS account record, never $HOME, so a caller who redirects
 * XDG_STATE_HOME and HOME still cannot name the account's own receipts. An unreadable record is a denial.
 */
function accountStateRoot(): string {
	const uid = process.getuid?.()
	const command = ACCOUNT_RECORD_COMMANDS[process.platform]
	if (uid === undefined || command === undefined) throw new GateRefusal({ kind: "denied" })
	const record = Bun.spawnSync({ cmd: command(uid), env: {}, stdin: "ignore", stdout: "pipe", stderr: "ignore" })
	const home = new TextDecoder().decode(record.stdout).trim().split(":").at(-2)
	if (record.exitCode !== 0 || home === undefined || !isAbsolute(home)) throw new GateRefusal({ kind: "denied" })
	return join(home, ".local", "state")
}

/** Every spelling and directory identity of the private items trees that a caller path could reach. */
interface ItemsGuard {
	readonly roots: readonly string[]
	readonly identities: ReadonlySet<string>
}

function identity(stat: Stats): string {
	return `${stat.dev}:${stat.ino}`
}

function spellings(stateRoot: string): string[] {
	const lexical = join(stateRoot, ...ITEMS_PATH)
	try {
		return [lexical, realpathSync(lexical)]
	} catch {
		return [lexical]
	}
}

function itemsGuard(stateRoots: readonly string[]): ItemsGuard {
	const roots = stateRoots.flatMap(spellings)
	const identities = new Set<string>()
	for (const root of roots) {
		try {
			identities.add(identity(statSync(root)))
		} catch {
			// An absent items root holds no receipt to protect.
		}
	}
	return { roots, identities }
}

function isInside(path: string, roots: readonly string[]): boolean {
	return roots.some((root) => fold(path) === fold(root) || fold(path).startsWith(`${fold(root)}/`))
}

function components(path: string): string[] {
	return path.split("/").filter((part) => part !== "")
}

/**
 * Resolves a caller path one component at a time and never follows a link physically: each link target is
 * normalized lexically. The walk denies as soon as a path is inside an items root, by spelling before it is touched
 * and by directory identity after lstat, so resolution never depends on whether an item directory exists.
 */
function canonicalCallerPath(path: string, guard: ItemsGuard): string {
	let pending = components(resolve(path))
	let current = "/"
	let hops = 0
	for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
		const candidate = join(current, next)
		if (isInside(candidate, guard.roots)) throw new GateRefusal({ kind: "denied" })
		const stat = lstatSync(candidate)
		if (guard.identities.has(identity(stat))) throw new GateRefusal({ kind: "denied" })
		if (!stat.isSymbolicLink()) {
			current = candidate
			continue
		}
		hops += 1
		if (hops > MAX_LINK_HOPS) throw new GateRefusal({ kind: "denied" })
		pending = [...components(resolve(current, readlinkSync(candidate))), ...pending]
		current = "/"
	}
	return current
}

/**
 * Reads one caller-supplied JSON file. A path that cannot be resolved, or that reaches an items tree, is a denial:
 * otherwise a caller could name a receipt as its grant or request and learn whether it exists.
 */
function readCallerJson(path: string, guard: ItemsGuard): unknown {
	let canonical: string
	try {
		canonical = canonicalCallerPath(path, guard)
	} catch {
		throw new GateRefusal({ kind: "denied" })
	}
	let text: string
	try {
		// Nonblocking so a FIFO caller path cannot hang the command; a regular file ignores the flag. The walk denies a
		// static path before it is touched; O_NOFOLLOW refuses a link at the final component only. A caller that mutates
		// its own path components during the run is outside the guarantee (README, Privacy boundary).
		const descriptor = openSync(canonical, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
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
		const guard = itemsGuard([home, accountStateRoot()])
		grant = asGrant(readCallerJson(grantPath, guard))
		request = asRequest(readCallerJson(requestPath, guard))
	} catch (error) {
		return error instanceof GateRefusal ? error.outcome : { kind: "denied" }
	}
	if (!isAuthorized(grant, request)) return { kind: "denied" }
	return projectReceipt(grant, request, home)
}
