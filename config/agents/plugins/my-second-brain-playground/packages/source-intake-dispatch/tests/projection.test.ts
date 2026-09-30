// Ticket #136 and Ticket #155 privacy invariants 1, 2, 4 and 5 through the public process, with the grant and request
// piped on standard input. Invariant 3 (no existence oracle) lives in oracle.test.ts. Every value is synthetic.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, readdirSync, readFileSync, statSync, symlinkSync } from "node:fs"
import { join, resolve } from "node:path"
import {
	createFixture,
	envelope,
	fifoSentinel,
	type Fixture,
	grant,
	input,
	invoke,
	OPAQUE_ITEM_REF,
	REFUSAL_HUMAN,
	REFUSAL_JSON,
	receipt,
	removeFixture,
	request,
	SENTINEL,
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
	const piped = input(grant(fixture), request())

	const machine = invoke(fixture, ["project", "--json"], { stdin: piped })
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

	expect(invoke(fixture, ["project"], { stdin: piped })).toEqual({
		exitCode: 0,
		stderr: "",
		stdout: "Granted projection for synthetic-item-001:\n  displayName: Fictional planning note\n  mimeType: text/plain\n",
	})
})

test("projects a requested subset of the grant and keeps a numeric size", () => {
	writeJson(fixture.receiptPath, receipt())
	const piped = input(grant(fixture, { allowedFields: ["displayName", "sizeBytes"] }), request({ requestedFields: ["sizeBytes"] }))
	expect(envelope(invoke(fixture, ["project", "--json"], { stdin: piped })).result.data).toEqual({ opaqueItemRef: OPAQUE_ITEM_REF, projection: { sizeBytes: 1234 } })
})

// Invariant 4: status and evaluation outputs stay fixed and never read a receipt.
test("status and evaluation receive the fixed redacted projection and never open the receipt", async () => {
	const sentinel = await fifoSentinel(fixture, fixture.receiptPath)
	try {
		for (const recipient of ["status", "evaluation"]) {
			const machine = invoke(fixture, ["--redacted", recipient, "--json"])
			expect(machine.exitCode).toBe(0)
			expect(machine.stderr).toBe("")
			expect(envelope(machine).result).toMatchObject({ commandIdentity: "source-intake-dispatch.redacted", data: { recipient, projection: { receipt: "[REDACTED]" } } })
			expect(invoke(fixture, ["--redacted", recipient])).toEqual({ exitCode: 0, stderr: "", stdout: `${recipient}: receipt [REDACTED]\n` })
		}
		expect(await sentinel.opened()).toBe(false)
		sentinel.openAsReader()
		expect(await sentinel.opened()).toBe(true)
	} finally {
		await sentinel.stop()
	}
})

// Invariants 1 and 2: every authority mismatch is decided before the receipt is opened, and every one emits the same
// fixed bytes. The FIFO sentinels detect any open, blocking or not. Wrong behavior caught: opening or reading the
// receipt before authorization (even with the result discarded), or a refusal that varies with the mismatch.
test("refuses every sampled authority mismatch with identical bytes and never opens the receipt", async () => {
	const outsideReceiptPath = join(fixture.root, "outside.json")
	const [receiptSentinel, outsideSentinel] = await Promise.all([fifoSentinel(fixture, fixture.receiptPath), fifoSentinel(fixture, outsideReceiptPath)])
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
	try {
		for (const [name, caseGrant, caseRequest] of cases) {
			const piped = input(caseGrant, caseRequest)
			expect(invoke(fixture, ["project", "--json"], { stdin: piped }), name).toEqual(refusedJson)
			expect(invoke(fixture, ["project"], { stdin: piped }), name).toEqual(refusedHuman)
		}
		expect({ receipt: await receiptSentinel.opened(), outside: await outsideSentinel.opened() }).toEqual({ receipt: false, outside: false })
		receiptSentinel.openAsReader()
		outsideSentinel.openAsReader()
		expect({ receipt: await receiptSentinel.opened(), outside: await outsideSentinel.opened() }).toEqual({ receipt: true, outside: true })
	} finally {
		await Promise.all([receiptSentinel.stop(), outsideSentinel.stop()])
	}
})

test("refuses a symlinked private item directory and never opens the receipt behind it", async () => {
	const redirected = join(fixture.root, "redirected-item")
	mkdirSync(redirected)
	const sentinel = await fifoSentinel(fixture, join(redirected, "classification-metadata.json"))
	try {
		const itemsDirectory = resolve(fixture.itemDirectory, "..")
		const linkedItem = join(itemsDirectory, "synthetic-item-003")
		symlinkSync(redirected, linkedItem)
		const receiptPath = join(linkedItem, "classification-metadata.json")
		const piped = input(grant(fixture, { opaqueItemRef: "synthetic-item-003", receiptPath }), request({ opaqueItemRef: "synthetic-item-003" }))
		expect(invoke(fixture, ["project", "--json"], { stdin: piped })).toEqual(refusedJson)
		expect(await sentinel.opened()).toBe(false)
		sentinel.openAsReader()
		expect(await sentinel.opened()).toBe(true)
	} finally {
		await sentinel.stop()
	}
})

test("refuses a matching unsupported provider or purpose even with valid metadata", () => {
	writeJson(fixture.receiptPath, receipt())
	for (const [overrides, name] of [
		[{ provider: "opus" }, "provider"],
		[{ purpose: "status-repair" }, "purpose"],
	] as const) {
		const piped = input(grant(fixture, overrides), request(overrides))
		expect(invoke(fixture, ["project", "--json"], { stdin: piped }), name).toEqual(refusedJson)
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
		const piped = input(caseGrant, caseRequest)
		expect(invoke(fixture, ["project", "--json"], { stdin: piped }), name).toEqual(refusedJson)
	}
	const { allowedFields: _omitted, ...withoutFields } = grant(fixture)
	const piped = input(withoutFields, request())
	expect(envelope(invoke(fixture, ["project", "--json"], { stdin: piped })).result).toMatchObject({ causeCode: "SCHEMA_INVALID_INPUT", exitCode: 4 })
})

// Invariant 1 for the schema class: a shape refusal is decided from piped caller input alone, so it never opens the
// receipt.
test("refuses a malformed piped document as invalid input and never opens the receipt", async () => {
	const sentinel = await fifoSentinel(fixture, fixture.receiptPath)
	const cases: readonly [string, string][] = [
		["extra grant key", input({ ...grant(fixture), extra: true }, request())],
		["extra request key", input(grant(fixture), { ...request(), extra: true })],
		["extra top-level key", JSON.stringify({ grant: grant(fixture), request: request(), extra: true })],
		["missing request", JSON.stringify({ grant: grant(fixture) })],
		["a JSON array", JSON.stringify([grant(fixture), request()])],
		["empty input", ""],
		["input over 64 KiB", input(grant(fixture), request({ padding: "x".repeat(70 * 1024) }))],
	]
	try {
		for (const [name, piped] of cases) {
			const result = invoke(fixture, ["project", "--json"], { stdin: piped })
			expect(result.exitCode, name).toBe(4)
			expect(result.stderr, name).toBe("")
			expect(envelope(result).result, name).toMatchObject({ causeCode: "SCHEMA_INVALID_INPUT", data: null })
		}
		expect(await sentinel.opened()).toBe(false)
		sentinel.openAsReader()
		expect(await sentinel.opened()).toBe(true)
	} finally {
		await sentinel.stop()
	}
})

// Independent oracle: restated from the README grant and request shapes, not imported from src/gate.ts.
const GRANT_KEYS = "allowedFields,opaqueItemRef,provider,purpose,receiptPath"
const REQUEST_KEYS = "opaqueItemRef,provider,purpose,requestedFields"
const INPUT_KEYS = "grant,request"

function jsonFiles(directory: string): string[] {
	return readdirSync(directory).flatMap((name) => {
		if (name === "node_modules" || name === "runtime" || name.startsWith(".")) return []
		const path = join(directory, name)
		if (statSync(path).isDirectory()) return jsonFiles(path)
		return name.endsWith(".json") ? [path] : []
	})
}

// Invariant 5: grants and requests stay in private runtime state. Wrong behavior caught: a committed fixture or
// example grant, request or piped input document anywhere in the plugin source tree.
test("the plugin tree stores no grant or request manifest", () => {
	const files = jsonFiles(resolve(import.meta.dir, "../../.."))
	expect(files.length).toBeGreaterThan(10)
	const manifests = files.filter((path) => {
		try {
			const value: unknown = JSON.parse(readFileSync(path, "utf8"))
			const keys = typeof value === "object" && value !== null ? Object.keys(value).sort().join(",") : ""
			return keys === GRANT_KEYS || keys === REQUEST_KEYS || keys === INPUT_KEYS
		} catch {
			return false
		}
	})
	expect(manifests).toEqual([])
})
