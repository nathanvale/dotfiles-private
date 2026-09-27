#!/usr/bin/env bun
import { lstatSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

const REFUSAL = {
	message: "Request denied. Stage Manager must verify the private grant before retrying.",
	nextAction: "Ask Stage Manager to verify the private grant and issue a matching request.",
	outcome: "refused",
} as const

const REDACTED_PROJECTION = { outcome: "redacted", projection: { receipt: "[REDACTED]" } } as const
const CLASSIFICATION_FIELDS = new Set(["displayName", "mimeType", "modifiedTime", "sizeBytes"])
const GRANT_KEYS = ["allowedFields", "opaqueItemRef", "provider", "purpose", "receiptPath"] as const
const REQUEST_KEYS = ["opaqueItemRef", "provider", "purpose", "requestedFields"] as const
const OPAQUE_ITEM_REF = /^[a-z0-9][a-z0-9-]{0,63}$/
const USAGE = `Usage:
  source-intake-dispatch --help
  source-intake-dispatch --redacted <status|evaluation>
  source-intake-dispatch <private-grant.json> <private-request.json>

The manifest and request are private JSON. A matching Luna classification request
returns only its granted flat metadata projection. A mismatch exits 3 with the
fixed redacted refusal. Status and evaluation receive the fixed redacted result.
`

type Grant = {
	readonly opaqueItemRef: string
	readonly provider: string
	readonly purpose: string
	readonly allowedFields: readonly string[]
	readonly receiptPath: string
}

type Request = Omit<Grant, "allowedFields" | "receiptPath"> & { readonly requestedFields: readonly string[] }

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

function asGrant(value: unknown): Grant | null {
	if (!isRecord(value) || !hasOnlyKeys(value, GRANT_KEYS)) return null
	if (
		!isNonEmptyString(value.opaqueItemRef) ||
		!OPAQUE_ITEM_REF.test(value.opaqueItemRef) ||
		!isNonEmptyString(value.provider) ||
		!isNonEmptyString(value.purpose) ||
		!isNonEmptyString(value.receiptPath) ||
		!isFieldList(value.allowedFields) ||
		!value.allowedFields.every((field) => CLASSIFICATION_FIELDS.has(field))
	) {
		return null
	}
	return {
		allowedFields: value.allowedFields,
		opaqueItemRef: value.opaqueItemRef,
		provider: value.provider,
		purpose: value.purpose,
		receiptPath: value.receiptPath,
	}
}

function asRequest(value: unknown): Request | null {
	if (!isRecord(value) || !hasOnlyKeys(value, REQUEST_KEYS)) return null
	if (
		!isNonEmptyString(value.opaqueItemRef) ||
		!OPAQUE_ITEM_REF.test(value.opaqueItemRef) ||
		!isNonEmptyString(value.provider) ||
		!isNonEmptyString(value.purpose) ||
		!isFieldList(value.requestedFields)
	) {
		return null
	}
	return {
		opaqueItemRef: value.opaqueItemRef,
		provider: value.provider,
		purpose: value.purpose,
		requestedFields: value.requestedFields,
	}
}

function parseJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"))
}

function expectedReceiptPath(opaqueItemRef: string): string | null {
	const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state")
	if (!isAbsolute(stateHome)) return null
	return join(realpathSync(stateHome), "my-second-brain-playground", "drive-inbox-filing", "items", opaqueItemRef, "classification-metadata.json")
}

function isBoundReceiptPath(grant: Grant): boolean {
	const expected = expectedReceiptPath(grant.opaqueItemRef)
	if (expected === null || resolve(grant.receiptPath) !== expected) return false
	const expectedParent = dirname(expected)
	return (
		!lstatSync(expected).isSymbolicLink() &&
		realpathSync(expectedParent) === expectedParent &&
		realpathSync(grant.receiptPath) === expected
	)
}

function isAuthorized(grant: Grant, request: Request): boolean {
	return (
		grant.provider === "luna" &&
		grant.purpose === "classification" &&
		grant.opaqueItemRef === request.opaqueItemRef &&
		grant.provider === request.provider &&
		grant.purpose === request.purpose &&
		request.requestedFields.every((field) => grant.allowedFields.includes(field))
	)
}

function isMetadataScalar(value: unknown): value is string | number {
	return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
}

function project(receipt: unknown, requestedFields: readonly string[]): Record<string, string | number> | null {
	if (!isRecord(receipt) || !requestedFields.every((field) => Object.hasOwn(receipt, field) && isMetadataScalar(receipt[field]))) return null
	return Object.fromEntries(requestedFields.map((field) => [field, receipt[field] as string | number]))
}

function refuse(): number {
	process.stdout.write(`${JSON.stringify(REFUSAL)}\n`)
	return 3
}

function runSourceIntakeDispatch(args: readonly string[]): number {
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
		process.stdout.write(USAGE)
		return 0
	}
	if (args.length === 2 && args[0] === "--redacted" && (args[1] === "status" || args[1] === "evaluation")) {
		process.stdout.write(`${JSON.stringify(REDACTED_PROJECTION)}\n`)
		return 0
	}
	if (args.length !== 2) return refuse()
	const [grantPath, requestPath] = args
	if (grantPath === undefined || requestPath === undefined) return refuse()
	try {
		const grant = asGrant(parseJson(grantPath))
		const request = asRequest(parseJson(requestPath))
		if (grant === null || request === null || !isBoundReceiptPath(grant) || !isAuthorized(grant, request)) return refuse()
		const projection = project(parseJson(grant.receiptPath), request.requestedFields)
		if (projection === null) return refuse()
		process.stdout.write(`${JSON.stringify({ outcome: "allowed", projection })}\n`)
		return 0
	} catch {
		return refuse()
	}
}

if (import.meta.main) process.exitCode = runSourceIntakeDispatch(process.argv.slice(2))
