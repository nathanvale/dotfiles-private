// Ticket #136 and Ticket #155 privacy invariants 1, 2, 4 and 5 through the public process. Invariant 3 (no existence
// oracle) lives in oracle.test.ts. Every value is synthetic.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, readdirSync, readFileSync, statSync, symlinkSync } from "node:fs"
import { join, resolve } from "node:path"
import {
	createFifo,
	createFixture,
	envelope,
	type Fixture,
	grant,
	invoke,
	OPAQUE_ITEM_REF,
	REFUSAL_HUMAN,
	REFUSAL_JSON,
	receipt,
	removeFixture,
	request,
	SENTINEL,
	writeInputs,
	writeJson,
} from "./fixtures/harness.ts"

let fixture: Fixture

beforeEach(() => {
	fixture = createFixture()
})

afterEach(() => {
	removeFixture(fixture)
})

const refusedJson = { exitCode: 3, stderr: "", stdout: REFUSAL_JSON }
const refusedHuman = { exitCode: 3, stderr: REFUSAL_HUMAN, stdout: "" }

// Invariant 4: only the granted fields reach the projection. Wrong behavior caught: leaking the ungranted
// receiptSummary or any unrequested field.
test("projects exactly the requested granted fields in machine and human mode", () => {
	writeJson(fixture.receiptPath, receipt())
	const [grantPath, requestPath] = writeInputs(fixture, grant(fixture), request())

	const machine = invoke(fixture, [grantPath, requestPath, "--json"])
	expect(machine.exitCode).toBe(0)
	expect(machine.stderr).toBe("")
	expect(envelope(machine).result).toMatchObject({
		commandIdentity: "source-intake-dispatch.project",
		outcome: "success",
		causeCode: "SUCCESS_UNCHANGED",
		data: { opaqueItemRef: OPAQUE_ITEM_REF, projection: { displayName: "Fictional planning note", mimeType: "text/plain" } },
	})
	expect(Object.keys(envelope(machine).result.data.projection)).toEqual(["displayName", "mimeType"])
	expect(machine.stdout).not.toContain(SENTINEL)

	expect(invoke(fixture, [grantPath, requestPath])).toEqual({
		exitCode: 0,
		stderr: "",
		stdout: "Granted projection for synthetic-item-001:\n  displayName: Fictional planning note\n  mimeType: text/plain\n",
	})
})

test("projects a requested subset of the grant and keeps a numeric size", () => {
	writeJson(fixture.receiptPath, receipt())
	const [grantPath, requestPath] = writeInputs(fixture, grant(fixture, { allowedFields: ["displayName", "sizeBytes"] }), request({ requestedFields: ["sizeBytes"] }))
	expect(envelope(invoke(fixture, [grantPath, requestPath, "--json"])).result.data).toEqual({ opaqueItemRef: OPAQUE_ITEM_REF, projection: { sizeBytes: 1234 } })
})

// Invariant 4: status and evaluation outputs stay fixed and never read a receipt.
test("status and evaluation receive the fixed redacted projection", () => {
	createFifo(fixture.receiptPath)
	for (const recipient of ["status", "evaluation"]) {
		const machine = invoke(fixture, ["--redacted", recipient, "--json"])
		expect(machine.exitCode).toBe(0)
		expect(machine.stderr).toBe("")
		expect(envelope(machine).result).toMatchObject({ commandIdentity: "source-intake-dispatch.redacted", data: { recipient, projection: { receipt: "[REDACTED]" } } })
		expect(invoke(fixture, ["--redacted", recipient])).toEqual({ exitCode: 0, stderr: "", stdout: `${recipient}: receipt [REDACTED]\n` })
	}
})

// Invariants 1 and 2: every authority mismatch is decided before the receipt FIFO opens (opening it would hang and
// time out), and every one emits the same fixed bytes. Wrong behavior caught: opening the receipt first, or a refusal
// that varies with the mismatch.
test("refuses every sampled authority mismatch with identical bytes before a private receipt FIFO can open", () => {
	createFifo(fixture.receiptPath)
	const outsideReceiptPath = join(fixture.root, "outside.json")
	createFifo(outsideReceiptPath)
	const base = grant(fixture, { allowedFields: ["displayName"] })
	const cases: readonly [string, unknown, unknown][] = [
		["wrong item", base, request({ opaqueItemRef: "synthetic-item-002", requestedFields: ["displayName"] })],
		["Opus provider with matching valid field", base, request({ provider: "opus", requestedFields: ["displayName"] })],
		["unsupported matching Opus provider", { ...base, provider: "opus" }, request({ provider: "opus", requestedFields: ["displayName"] })],
		["wrong purpose with matching valid field", base, request({ purpose: "status-repair", requestedFields: ["displayName"] })],
		["unsupported matching status-repair purpose", { ...base, purpose: "status-repair" }, request({ purpose: "status-repair", requestedFields: ["displayName"] })],
		["extra field", base, request({ requestedFields: ["displayName", "mimeType"] })],
		["exact Opus status repair", grant(fixture, { provider: "opus", purpose: "status-repair", allowedFields: ["receiptSummary"] }), request({ provider: "opus", purpose: "status-repair", requestedFields: ["receiptSummary"] })],
		["disallowed grant field", { ...base, allowedFields: ["receiptSummary"] }, request({ requestedFields: ["receiptSummary"] })],
		["outside receipt path", { ...base, receiptPath: outsideReceiptPath }, request({ requestedFields: ["displayName"] })],
	]
	for (const [name, caseGrant, caseRequest] of cases) {
		const [grantPath, requestPath] = writeInputs(fixture, caseGrant, caseRequest)
		expect(invoke(fixture, [grantPath, requestPath, "--json"]), name).toEqual(refusedJson)
		expect(invoke(fixture, [grantPath, requestPath]), name).toEqual(refusedHuman)
	}
})

test("refuses a symlinked private item directory before its receipt FIFO can open", () => {
	const redirected = join(fixture.root, "redirected-item")
	mkdirSync(redirected)
	createFifo(join(redirected, "classification-metadata.json"))
	const itemsDirectory = resolve(fixture.itemDirectory, "..")
	const linkedItem = join(itemsDirectory, "synthetic-item-003")
	symlinkSync(redirected, linkedItem)
	const receiptPath = join(linkedItem, "classification-metadata.json")
	const [grantPath, requestPath] = writeInputs(fixture, grant(fixture, { opaqueItemRef: "synthetic-item-003", receiptPath }), request({ opaqueItemRef: "synthetic-item-003" }))
	expect(invoke(fixture, [grantPath, requestPath, "--json"])).toEqual(refusedJson)
})

test("refuses a matching unsupported provider or purpose even with valid metadata", () => {
	writeJson(fixture.receiptPath, receipt())
	for (const [overrides, name] of [
		[{ provider: "opus" }, "provider"],
		[{ purpose: "status-repair" }, "purpose"],
	] as const) {
		const [grantPath, requestPath] = writeInputs(fixture, grant(fixture, overrides), request(overrides))
		expect(invoke(fixture, [grantPath, requestPath, "--json"]), name).toEqual(refusedJson)
	}
})

// Invariant 5: a grant is exact-item. It binds one opaque reference, provider, purpose and field list; it cannot
// widen to another item, a wildcard field, or a missing key.
test("a grant covers only its exact item, provider, purpose and listed fields", () => {
	const otherItem = join(resolve(fixture.itemDirectory, ".."), "synthetic-item-002")
	mkdirSync(otherItem)
	writeJson(join(otherItem, "classification-metadata.json"), receipt())
	writeJson(fixture.receiptPath, receipt())
	const refusals: readonly [string, unknown, unknown][] = [
		["grant for item 001 used for item 002", grant(fixture), request({ opaqueItemRef: "synthetic-item-002" })],
		["wildcard field", grant(fixture, { allowedFields: ["*"] }), request({ requestedFields: ["*"] })],
		["grant receipt for another item", grant(fixture, { receiptPath: join(otherItem, "classification-metadata.json") }), request()],
	]
	for (const [name, caseGrant, caseRequest] of refusals) {
		const [grantPath, requestPath] = writeInputs(fixture, caseGrant, caseRequest)
		expect(invoke(fixture, [grantPath, requestPath, "--json"]), name).toEqual(refusedJson)
	}
	const { allowedFields: _omitted, ...withoutFields } = grant(fixture)
	const [grantPath, requestPath] = writeInputs(fixture, withoutFields, request())
	expect(envelope(invoke(fixture, [grantPath, requestPath, "--json"])).result).toMatchObject({ causeCode: "SCHEMA_INVALID_INPUT", exitCode: 4 })
})

// Invariant 1 for the new schema class: a shape refusal is decided from caller input alone, so it still never opens
// the receipt FIFO.
test("refuses an extra grant or request key as invalid input before a private receipt FIFO can open", () => {
	createFifo(fixture.receiptPath)
	for (const [name, caseGrant, caseRequest] of [
		["extra grant key", { ...grant(fixture), extra: true }, request()],
		["extra request key", grant(fixture), { ...request(), extra: true }],
	] as const) {
		const [grantPath, requestPath] = writeInputs(fixture, caseGrant, caseRequest)
		const result = invoke(fixture, [grantPath, requestPath, "--json"])
		expect(result.exitCode, name).toBe(4)
		expect(result.stderr, name).toBe("")
		expect(envelope(result).result, name).toMatchObject({ causeCode: "SCHEMA_INVALID_INPUT", data: null })
	}
})

const GRANT_KEYS = "allowedFields,opaqueItemRef,provider,purpose,receiptPath"
const REQUEST_KEYS = "opaqueItemRef,provider,purpose,requestedFields"

function jsonFiles(directory: string): string[] {
	return readdirSync(directory).flatMap((name) => {
		if (name === "node_modules" || name === "runtime" || name.startsWith(".")) return []
		const path = join(directory, name)
		if (statSync(path).isDirectory()) return jsonFiles(path)
		return name.endsWith(".json") ? [path] : []
	})
}

// Invariant 5: grant and request files stay in private runtime state. Wrong behavior caught: a committed fixture or
// example grant or request anywhere in the plugin source tree.
test("the plugin tree stores no grant or request manifest", () => {
	const files = jsonFiles(resolve(import.meta.dir, "../../.."))
	expect(files.length).toBeGreaterThan(10)
	const manifests = files.filter((path) => {
		try {
			const value: unknown = JSON.parse(readFileSync(path, "utf8"))
			const keys = typeof value === "object" && value !== null ? Object.keys(value).sort().join(",") : ""
			return keys === GRANT_KEYS || keys === REQUEST_KEYS
		} catch {
			return false
		}
	})
	expect(manifests).toEqual([])
})
