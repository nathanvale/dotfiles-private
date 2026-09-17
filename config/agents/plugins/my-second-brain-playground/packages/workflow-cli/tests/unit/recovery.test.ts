import { describe, expect, test } from "bun:test"
import type { BeadFacts, RecoveryBinding, StoreFacts } from "../../src/model.ts"
import { BindingSchemaError, buildPanel, sameOwner, validateBinding } from "../../src/recovery.ts"

// Schema v3 and the panel as literals (independent oracle): the twelve fields, the refusals, the freshness label,
// the panel lines, and the one next safe action per Bead state.

const NOW = Date.parse("2026-09-17T09:00:00Z")

function binding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: 3,
		sessionIdentity: "session-1",
		workspace: "/ws",
		storePath: "/ws/.beads",
		storePrefix: "lkr",
		beadsExecutable: "/opt/bd",
		beadsVersion: "1.2.2@6c124203e771",
		beadId: "lkr-1",
		beadObservedAt: "2026-09-17T03:09:16Z",
		sourceRepository: "/repo",
		evidencePath: null,
		observedAt: "2026-09-17T08:30:00Z",
		...overrides,
	}
}

describe("validateBinding", () => {
	test("accepts the closed field set and labels a binding fresh within an hour", () => {
		const validated = validateBinding(binding(), NOW)
		expect(validated.stale).toBe(false)
		expect(validated.binding.beadId).toBe("lkr-1")
		expect(validated.binding.evidencePath).toBeNull()
	})

	test("labels a binding older than one hour stale without invalidating it", () => {
		expect(validateBinding(binding({ observedAt: "2026-09-17T07:59:59Z" }), NOW).stale).toBe(true)
		expect(validateBinding(binding({ observedAt: "2026-09-17T08:00:01Z" }), NOW).stale).toBe(false)
	})

	test("accepts a canonical evidence path and observedAt inside the five-minute future skew", () => {
		expect(validateBinding(binding({ evidencePath: "/repo/evidence.md", observedAt: "2026-09-17T09:04:59Z" }), NOW).binding.evidencePath).toBe("/repo/evidence.md")
	})

	test.each([
		["not an object", ["x"]],
		["schemaVersion 2", binding({ schemaVersion: 2 })],
		["an unknown field", binding({ extra: 1 })],
		["a missing field", (() => {
			const value = binding()
			delete value.storePrefix
			return value
		})()],
		["a null identity", binding({ beadId: null })],
		["an empty workspace", binding({ workspace: "" })],
		["a session outside the grammar", binding({ sessionIdentity: "-bad" })],
		["a non-null non-string evidencePath", binding({ evidencePath: 4 })],
		["a malformed observedAt", binding({ observedAt: "yesterday" })],
		["a non-Z observedAt", binding({ observedAt: "2026-09-17T08:30:00+10:00" })],
		["an observedAt more than five minutes ahead", binding({ observedAt: "2026-09-17T09:05:01Z" })],
		["a malformed beadObservedAt", binding({ beadObservedAt: "" })],
	])("refuses %s", (_label, value) => {
		expect(() => validateBinding(value, NOW)).toThrow(BindingSchemaError)
	})
})

describe("sameOwner", () => {
	const saved = validateBinding(binding(), NOW).binding
	test("the owner is workspace, Bead and session; anything else is a different owner", () => {
		expect(sameOwner(saved, { workspace: "/ws", beadId: "lkr-1", sessionIdentity: "session-1" })).toBe(true)
		expect(sameOwner(saved, { workspace: "/ws", beadId: "lkr-2", sessionIdentity: "session-1" })).toBe(false)
		expect(sameOwner(saved, { workspace: "/other", beadId: "lkr-1", sessionIdentity: "session-1" })).toBe(false)
		expect(sameOwner(saved, { workspace: "/ws", beadId: "lkr-1", sessionIdentity: "session-2" })).toBe(false)
	})
})

const STORE: StoreFacts = { executable: "/opt/bd", executableDigest: "abc", version: "1.2.2@6c124203e771", storePath: "/ws/.beads", prefix: "lkr" }

function bead(overrides: Partial<BeadFacts> = {}): BeadFacts {
	return {
		id: "lkr-1",
		title: "Fixture",
		status: "in_progress",
		assignee: "worker",
		parent: "lkr-0",
		labels: ["a", "b"],
		specId: "https://example.test/spec",
		externalRef: "https://example.test/ticket",
		updatedAt: "2026-09-17T03:09:16Z",
		dependencies: [],
		comments: [
			{ author: "one", createdAt: "t1", text: "c1" },
			{ author: "two", createdAt: "t2", text: "c2\nline" },
			{ author: "three", createdAt: "t3", text: "c3" },
			{ author: "four", createdAt: "t4", text: "x".repeat(2000) },
		],
		...overrides,
	}
}

describe("buildPanel", () => {
	const saved: RecoveryBinding = validateBinding(binding({ evidencePath: "/repo/evidence.md" }), NOW).binding

	test("renders every required panel line from current facts and bounds comments to the last three, 1 KiB each", () => {
		const panel = buildPanel({ binding: saved, stale: false, store: STORE, bead: bead(), gates: [], prime: null })
		const lines = panel.resumePanel.split("\n")
		expect(lines[0]).toBe("# Resume Panel")
		expect(lines).toContain("Session: session-1")
		expect(lines).toContain("Workspace: /ws")
		expect(lines).toContain("Store: /ws/.beads (prefix lkr)")
		expect(lines).toContain("Beads executable: /opt/bd (1.2.2@6c124203e771; sha256 abc)")
		expect(lines).toContain("Bead: lkr-1 Fixture")
		expect(lines).toContain("Status: in_progress; assignee: worker; parent: lkr-0; labels: a, b")
		expect(lines).toContain("Spec: https://example.test/spec; external ref: https://example.test/ticket")
		expect(lines).toContain("Open blockers: none")
		expect(lines).toContain("Open human gates: none")
		expect(lines).toContain("Evidence: /repo/evidence.md")
		expect(lines).toContain("Binding: observed 2026-09-17T08:30:00Z (fresh); Bead updated 2026-09-17T03:09:16Z; changed since binding: no")
		expect(lines).toContain("- BEADS_DIR=/ws/.beads /opt/bd show lkr-1 --readonly --json --include-comments")
		expect(lines).toContain("- BEADS_DIR=/ws/.beads /opt/bd gate list --all --readonly --json")
		expect(lines).toContain("- msb-workflow recover --workspace /ws --session session-1 --json")
		expect(lines.filter((line) => line.startsWith("Next safe action: "))).toHaveLength(1)
		const comments = panel.facts.recentComments as Array<{ author: string; text: string }>
		expect(comments.map((comment) => comment.author)).toEqual(["two", "three", "four"])
		expect(new TextEncoder().encode(comments[2]?.text ?? "").byteLength).toBeLessThanOrEqual(1024 + 3)
		expect(lines).toContain("- [two t2] c2 line")
		expect(panel.resumePanel).not.toContain("[one t1]")
	})

	test("prime context is appended after the panel when supplied", () => {
		const panel = buildPanel({ binding: saved, stale: true, store: STORE, bead: bead(), gates: [], prime: "PRIME TEXT" })
		expect(panel.resumePanel).toContain("Binding: observed 2026-09-17T08:30:00Z (stale)")
		expect(panel.resumePanel.endsWith("## Beads prime context\nPRIME TEXT")).toBe(true)
		expect((panel.facts.binding as { freshness: string }).freshness).toBe("stale")
	})

	test("changed since binding follows the Bead's updated_at against beadObservedAt", () => {
		const panel = buildPanel({ binding: saved, stale: false, store: STORE, bead: bead({ updatedAt: "2026-09-17T07:00:00Z" }), gates: [], prime: null })
		expect((panel.facts.binding as { changedSinceBinding: boolean }).changedSinceBinding).toBe(true)
	})

	test.each([
		["an open human gate on the Bead", bead({ dependencies: [{ id: "lkr-g", title: "Gate: human", status: "open", issueType: "gate", dependencyType: "blocks", awaitType: "human" }] }), [], "Wait for the open human Gate lkr-g to close through native bd before continuing lkr-1; do not resolve it yourself"],
		["a closed gate per gate list overrides the show status", bead({ dependencies: [{ id: "lkr-g", title: "Gate: human", status: "open", issueType: "gate", dependencyType: "blocks", awaitType: "human" }] }), [{ id: "lkr-g", title: "Gate: human", status: "closed", awaitType: "human" }], "Continue lkr-1 from the evidence pointer and the last comment; record the next checkpoint with native bd comment before compaction"],
		["an open blocker", bead({ dependencies: [{ id: "lkr-b", title: "Blocker", status: "open", issueType: "task", dependencyType: "blocks", awaitType: null }, { id: "lkr-p", title: "Parent", status: "open", issueType: "epic", dependencyType: "parent-child", awaitType: null }] }), [], "Resolve or wait for the open blocker lkr-b through native bd before continuing lkr-1"],
		["an in-progress Bead", bead(), [], "Continue lkr-1 from the evidence pointer and the last comment; record the next checkpoint with native bd comment before compaction"],
		["an open unclaimed Bead", bead({ status: "open", assignee: null }), [], "Claim lkr-1 through native bd before starting work; the binding records intent, not a claim"],
		["a closed Bead", bead({ status: "closed" }), [], "lkr-1 is closed; bind this session to the next Bead with msb-workflow bind before doing more work"],
	])("names exactly one next safe action for %s", (_label, facts, gates, expected) => {
		const panel = buildPanel({ binding: saved, stale: false, store: STORE, bead: facts, gates, prime: null })
		expect(panel.nextSafeAction).toBe(expected)
		expect(panel.resumePanel).toContain(`Next safe action: ${expected}`)
	})

	test("open blockers exclude gates and parent-child edges; open human gates exclude closed and non-human gates", () => {
		const facts = bead({
			dependencies: [
				{ id: "lkr-b", title: "Blocker", status: "open", issueType: "task", dependencyType: "blocks", awaitType: null },
				{ id: "lkr-c", title: "Closed blocker", status: "closed", issueType: "task", dependencyType: "blocks", awaitType: null },
				{ id: "lkr-g", title: "Gate: human", status: "open", issueType: "gate", dependencyType: "blocks", awaitType: "human" },
				{ id: "lkr-t", title: "Gate: timer", status: "open", issueType: "gate", dependencyType: "blocks", awaitType: "timer" },
				{ id: "lkr-p", title: "Parent", status: "open", issueType: "epic", dependencyType: "parent-child", awaitType: null },
			],
		})
		const panel = buildPanel({ binding: saved, stale: false, store: STORE, bead: facts, gates: [], prime: null })
		expect(panel.facts.openBlockers).toEqual(["lkr-b (open) Blocker"])
		expect(panel.facts.openHumanGates).toEqual(["lkr-g (open) Gate: human"])
	})
})
