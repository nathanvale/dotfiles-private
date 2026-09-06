import { test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { queryTraces } from "./invocation-trace-store.ts"

test("trace reader recognises retries and exposes conflicting original identities", () => {
	const root = mkdtempSync(join(tmpdir(), "trace-delivery-"))
	try {
		const directory = join(root, "my-second-brain-playground", "recovery-traces")
		mkdirSync(directory, { recursive: true })
		const original = {
			schema_version: 1, record_type: "lifecycle", record_identity: "delivery-1",
			journey_identity: "journey-1", invocation_identity: "invocation-1",
			producer_identity: "producer-1", producer_sequence: 0, harness_kind: "unknown",
			operation: "hook", phase: "invocation", occurred_at: "2026-09-06T00:00:00.000Z", outcome: "started",
		}
		const retry = Object.fromEntries(Object.entries(original).reverse())
		const next = { ...original, record_identity: "delivery-2", producer_sequence: 1, outcome: "succeeded" }
		writeFileSync(join(directory, "first.jsonl"), [original, next, retry].map(value => JSON.stringify(value)).join("\n") + "\n")
		const retried = queryTraces({ stateHome: root })
		expect(retried.records).toHaveLength(2)
		expect(retried.anomalies.map(value => value.code)).toEqual(["duplicate-delivery"])
		writeFileSync(join(directory, "second.jsonl"), JSON.stringify({ ...original, outcome: "failed" }) + "\n")
		const conflicting = queryTraces({ stateHome: root })
		expect(conflicting.records).toHaveLength(3)
		expect(conflicting.anomalies.map(value => value.code)).toContain("record-identity-conflict")
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})


test("detached cleanup entry records its own duration with the originating journey", () => {
	const root = mkdtempSync(join(tmpdir(), "trace-cleanup-"))
	try {
		const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "trace-command.ts"), "cleanup", "--state-home", root], {
			env: { ...process.env, MSB_RECOVERY_CLEANUP_JOURNEY: "journey-1", MSB_RECOVERY_CLEANUP_PARENT: "parent-record-1" },
			stdout: "pipe", stderr: "pipe",
		})
		expect(child.exitCode).toBe(0)
		expect(child.stderr.toString()).toBe("")
		expect(JSON.parse(child.stdout.toString())).toMatchObject({ command: "cleanup", ok: true })
		const trace = queryTraces({ stateHome: root, filter: { journey_identity: "journey-1" } })
		expect(trace.records).toHaveLength(2)
		expect(trace.records[0]).toMatchObject({ operation: "cleanup", phase: "cleanup", outcome: "started", parent_record_identity: "parent-record-1" })
		expect(trace.records[1]).toMatchObject({ phase: "cleanup", outcome: "succeeded" })
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})


test("journey view includes recorded ancestors without changing their original journey", () => {
	const root = mkdtempSync(join(tmpdir(), "trace-ancestors-"))
	try {
		const directory = join(root, "my-second-brain-playground", "recovery-traces")
		mkdirSync(directory, { recursive: true })
		const parent = { schema_version: 1, record_type: "lifecycle", record_identity: "parent-1", journey_identity: "invocation-1", invocation_identity: "invocation-1", producer_identity: "observer-1", producer_sequence: 0, harness_kind: "unknown", operation: "bind", phase: "invocation", occurred_at: "2026-09-06T00:00:00.000Z", outcome: "started" }
		const child = { ...parent, record_identity: "child-1", producer_sequence: 1, journey_identity: "session-1", parent_record_identity: "parent-1" }
		writeFileSync(join(directory, "records.jsonl"), `${JSON.stringify(parent)}\n${JSON.stringify(child)}\n`)
		const view = queryTraces({ stateHome: root, filter: { journey_identity: "session-1" } })
		expect(view.records.map(value => value.record_type === "lifecycle" ? value.record_identity : "diagnostic")).toEqual(["parent-1", "child-1"])
		expect(view.records[0]).toMatchObject({ journey_identity: "invocation-1" })
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
