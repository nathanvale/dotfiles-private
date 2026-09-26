import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const pluginRoot = resolve(import.meta.dir, "../../..")
const command = join(pluginRoot, "bin/source-intake-dispatch")
const opaqueItemRef = "synthetic-item-001"
const sentinel = "RECEIPT_SENTINEL_MUST_NOT_LEAK"
const refusal = '{"message":"Request denied. Stage Manager must verify the private grant before retrying.","nextAction":"Ask Stage Manager to verify the private grant and issue a matching request.","outcome":"refused"}\n'

type ProcessResult = { exitCode: number; stderr: string; stdout: string }

function invoke(args: readonly string[], stateHome: string): ProcessResult {
	const child = Bun.spawnSync({
		cmd: [command, ...args],
		cwd: pluginRoot,
		env: { ...process.env, XDG_STATE_HOME: stateHome },
		stderr: "pipe",
		stdout: "pipe",
		timeout: 500,
	})
	return {
		exitCode: child.exitCode,
		stderr: new TextDecoder().decode(child.stderr),
		stdout: new TextDecoder().decode(child.stdout),
	}
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, JSON.stringify(value))
}

function createFifo(path: string): void {
	const result = Bun.spawnSync({ cmd: ["mkfifo", path], stderr: "pipe", stdout: "pipe" })
	expect(result.exitCode).toBe(0)
}

test("projects exactly granted Luna metadata and fixed redacted status or evaluation results", () => {
	const stateHome = realpathSync(mkdtempSync(join(tmpdir(), "source-intake-dispatch-")))
	try {
		const itemDirectory = join(stateHome, "my-second-brain-playground", "drive-inbox-filing", "items", opaqueItemRef)
		mkdirSync(itemDirectory, { recursive: true })
		const receiptPath = join(itemDirectory, "classification-metadata.json")
		const grantPath = join(stateHome, "grant.json")
		const requestPath = join(stateHome, "request.json")
		writeJson(receiptPath, { displayName: "Fictional planning note", mimeType: "text/plain", receiptSummary: sentinel })
		writeJson(grantPath, { opaqueItemRef, provider: "luna", purpose: "classification", allowedFields: ["displayName", "mimeType"], receiptPath })
		writeJson(requestPath, { opaqueItemRef, provider: "luna", purpose: "classification", requestedFields: ["displayName", "mimeType"] })

		expect(invoke([grantPath, requestPath], stateHome)).toEqual({
			exitCode: 0,
			stderr: "",
			stdout: '{"outcome":"allowed","projection":{"displayName":"Fictional planning note","mimeType":"text/plain"}}\n',
		})
		for (const recipient of ["status", "evaluation"] as const) {
			expect(invoke(["--redacted", recipient], stateHome)).toEqual({
				exitCode: 0,
				stderr: "",
				stdout: '{"outcome":"redacted","projection":{"receipt":"[REDACTED]"}}\n',
			})
		}
		expect(invoke(["--help"], stateHome)).toEqual({
			exitCode: 0,
			stderr: "",
			stdout: expect.stringContaining("source-intake-dispatch <private-grant.json> <private-request.json>"),
		})
	} finally {
		rmSync(stateHome, { force: true, recursive: true })
	}
})

test("refuses sampled ungranted requests before a private receipt FIFO can open", () => {
	const stateHome = realpathSync(mkdtempSync(join(tmpdir(), "source-intake-dispatch-")))
	try {
		const itemDirectory = join(stateHome, "my-second-brain-playground", "drive-inbox-filing", "items", opaqueItemRef)
		mkdirSync(itemDirectory, { recursive: true })
		const receiptPath = join(itemDirectory, "classification-metadata.json")
		const outsideReceiptPath = join(stateHome, "outside.json")
		createFifo(receiptPath)
		createFifo(outsideReceiptPath)
		const grantPath = join(stateHome, "grant.json")
		const requestPath = join(stateHome, "request.json")
		const grant = { opaqueItemRef, provider: "luna", purpose: "classification", allowedFields: ["displayName"], receiptPath }
		writeJson(grantPath, grant)

		const cases: readonly [string, unknown, unknown][] = [
			["wrong item", grant, { opaqueItemRef: "synthetic-item-002", provider: "luna", purpose: "classification", requestedFields: ["displayName"] }],
			["Opus provider with matching valid field", grant, { opaqueItemRef, provider: "opus", purpose: "classification", requestedFields: ["displayName"] }],
			["wrong purpose with matching valid field", grant, { opaqueItemRef, provider: "luna", purpose: "status-repair", requestedFields: ["displayName"] }],
			["extra field", grant, { opaqueItemRef, provider: "luna", purpose: "classification", requestedFields: ["displayName", "mimeType"] }],
			["exact Opus status repair", { opaqueItemRef, provider: "opus", purpose: "status-repair", allowedFields: ["receiptSummary"], receiptPath }, { opaqueItemRef, provider: "opus", purpose: "status-repair", requestedFields: ["receiptSummary"] }],
			["disallowed grant field", { ...grant, allowedFields: ["receiptSummary"] }, { opaqueItemRef, provider: "luna", purpose: "classification", requestedFields: ["receiptSummary"] }],
			["outside receipt path", { ...grant, receiptPath: outsideReceiptPath }, { opaqueItemRef, provider: "luna", purpose: "classification", requestedFields: ["displayName"] }],
			["extra grant key", { ...grant, extra: true }, { opaqueItemRef, provider: "luna", purpose: "classification", requestedFields: ["displayName"] }],
			["extra request key", grant, { opaqueItemRef, provider: "luna", purpose: "classification", requestedFields: ["displayName"], extra: true }],
		]
		for (const [name, caseGrant, request] of cases) {
			writeJson(grantPath, caseGrant)
			writeJson(requestPath, request)
			const result = invoke([grantPath, requestPath], stateHome)
			expect(result, name).toEqual({ exitCode: 3, stderr: "", stdout: refusal })
		}
		expect(invoke([grantPath], stateHome)).toEqual({ exitCode: 3, stderr: "", stdout: refusal })
	} finally {
		rmSync(stateHome, { force: true, recursive: true })
	}
})

test("refuses a symlinked private item directory before its receipt FIFO can open", () => {
	const stateHome = realpathSync(mkdtempSync(join(tmpdir(), "source-intake-dispatch-")))
	try {
		const itemsDirectory = join(stateHome, "my-second-brain-playground", "drive-inbox-filing", "items")
		const redirectedDirectory = join(stateHome, "redirected-item")
		const itemDirectory = join(itemsDirectory, opaqueItemRef)
		const receiptPath = join(itemDirectory, "classification-metadata.json")
		mkdirSync(itemsDirectory, { recursive: true })
		mkdirSync(redirectedDirectory)
		createFifo(join(redirectedDirectory, "classification-metadata.json"))
		symlinkSync(redirectedDirectory, itemDirectory)
		const grantPath = join(stateHome, "grant.json")
		const requestPath = join(stateHome, "request.json")
		writeJson(grantPath, { opaqueItemRef, provider: "luna", purpose: "classification", allowedFields: ["displayName"], receiptPath })
		writeJson(requestPath, { opaqueItemRef, provider: "luna", purpose: "classification", requestedFields: ["displayName"] })

		expect(invoke([grantPath, requestPath], stateHome)).toEqual({ exitCode: 3, stderr: "", stdout: refusal })
	} finally {
		rmSync(stateHome, { force: true, recursive: true })
	}
})
