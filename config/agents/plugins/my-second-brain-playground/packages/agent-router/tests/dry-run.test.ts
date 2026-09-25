// Task hpr-f5n.3 acceptance B2 and B4 through the public process: fixture routes and evidence in, the dry-run card
// or a declared refusal out. Expected values are test-owned literals.
import { afterEach, describe, expect, test } from "bun:test"
import { hostname } from "node:os"
import { join } from "node:path"
import {
	account,
	createFixture,
	daysAgo,
	envelope,
	type Fixture,
	guideRevision,
	invoke,
	quota,
	removeFixture,
	route,
	SECRET_MARKER,
	snapshot,
	tree,
	writeObservations,
	writeRoutes,
} from "./fixtures/harness.ts"

const fixtures: Fixture[] = []

function fixture(options?: Parameters<typeof createFixture>[0]): Fixture {
	const created = createFixture(options)
	fixtures.push(created)
	return created
}

afterEach(() => {
	for (const created of fixtures.splice(0)) removeFixture(created)
})

interface Gate {
	gate: string
	verdict: string
	evidence: string
	reason: string
}

// biome-ignore lint/suspicious/noExplicitAny: tests read the card as plain JSON
function card(created: Fixture, extra: string[] = []): any {
	const result = envelope(invoke(created, ["run", "hpr-f5n.3", "--dry-run", ...extra, "--json"]))
	expect(result.result).toMatchObject({ commandIdentity: "agent-router.run", outcome: "success", causeCode: "SUCCESS_UNCHANGED", exitCode: 0, effectClass: "inspect", transactionState: "unchanged" })
	return result
}

// biome-ignore lint/suspicious/noExplicitAny: tests read the card as plain JSON
function routeOf(result: any, id: string) {
	const found = result.result.data.routes.find((entry: { id: string }) => entry.id === id)
	expect(found).toBeDefined()
	return found
}

function verdicts(gates: Gate[]): string[] {
	return gates.map((gate) => `${gate.gate}:${gate.verdict}:${gate.evidence}`)
}

describe("gates and pick", () => {
	test("a personal route with fresh matching identity and quota is selected with its guide revision", () => {
		const created = fixture()
		writeRoutes(created, [route("personal-claude-code")])
		writeObservations(created, [account("personal-claude-code", "personal", daysAgo(1)), quota("personal-claude-code", "available", daysAgo(2))])
		const result = card(created)
		const selected = routeOf(result, "personal-claude-code")
		expect(verdicts(selected.gates)).toEqual(["G1:pass:declared", "G2:pass:observed", "G3:pass:observed", "G4:pass:observed", "G5:pass:observed"])
		expect(selected.decision).toBe("eligible")
		expect(result.result.data.pick).toMatchObject({ status: "selected", route: "personal-claude-code", provisional: true, typeSafe: "not-consulted", modelGuideRevision: guideRevision() })
		expect(result.result.data.gateOrder.map((gate: { gate: string }) => gate.gate)).toEqual(["G1", "G2", "G3", "G4", "G5"])
	})

	test("unqualified routes are refused at the first failing gate with a reason", () => {
		const created = fixture()
		writeRoutes(created, [
			route("dry-only", { launch: "dry-run-only" }),
			route("other-host", { hosts: ["mini"] }),
			route("no-guide", { harness: "codex", model: { id: "gpt-6-sol" } }),
		])
		const result = card(created)
		expect(routeOf(result, "dry-only").refusal).toEqual({ gate: "G5", reason: "declared dry-run-only" })
		expect(routeOf(result, "other-host").refusal).toEqual({ gate: "G2", reason: "declared for mini, but this host is laptop" })
		expect(routeOf(result, "no-guide").refusal).toEqual({ gate: "G5", reason: "no Model Guide exists for codex and gpt-6-sol" })
		expect(result.result.data.pick).toMatchObject({ status: "none-eligible", route: null, modelGuideRevision: null })
		expect(result.result.nextAction).toBe("Resolve the listed refusals and gaps, then rerun the dry run.")
	})

	test("stale quota and unknown quota are reported distinctly and both ask Nathan on a personal route", () => {
		const created = fixture()
		writeRoutes(created, [route("stale-quota"), route("unknown-quota")])
		writeObservations(created, [quota("stale-quota", "available", daysAgo(10)), account("stale-quota", "personal", daysAgo(1)), account("unknown-quota", "personal", daysAgo(1))])
		const result = card(created)
		const stale = routeOf(result, "stale-quota")
		const unknown = routeOf(result, "unknown-quota")
		expect(stale.gates[3]).toEqual({ gate: "G4", verdict: "confirm", evidence: "stale", reason: "quota evidence is 10 days old; Nathan must confirm" })
		expect(unknown.gates[3]).toEqual({ gate: "G4", verdict: "confirm", evidence: "unknown", reason: "quota unknown: no usage source observed; Nathan must confirm" })
		expect(stale.quota.freshness).toMatchObject({ state: "stale", ageDays: 10 })
		expect(unknown.quota.freshness).toEqual({ state: "not-observed", observedAt: null, ageDays: null })
	})

	test("missing account proof asks Nathan for a personal route and refuses an employer route; a mismatch refuses", () => {
		const created = fixture()
		writeRoutes(created, [route("personal-unproved"), route("employer-unproved", { ownership: "employer" }), route("personal-mismatch")])
		writeObservations(created, [account("personal-mismatch", "someone-else", daysAgo(1))])
		const result = card(created)
		expect(routeOf(result, "personal-unproved").gates[2]).toEqual({ gate: "G3", verdict: "confirm", evidence: "unknown", reason: "identity unknown for declared alias personal; a login is not proof; Nathan must confirm" })
		expect(routeOf(result, "employer-unproved").refusal).toEqual({ gate: "G3", reason: "identity unknown for declared alias personal; a login is not proof; an employer route never launches on it" })
		expect(routeOf(result, "personal-mismatch").refusal).toEqual({ gate: "G3", reason: "observed identity does not match declared alias personal" })
		expect(result.result.data.pick).toMatchObject({ status: "needs-confirmation", route: "personal-unproved", confirmations: ["G3", "G4"] })
		expect(result.result.nextAction).toBe("Ask Nathan to confirm G3, G4 for personal-unproved before any launch.")
	})

	test("more than one qualifying route asks Nathan instead of picking", () => {
		const created = fixture()
		writeRoutes(created, [route("first"), route("second")])
		const result = card(created)
		expect(result.result.data.pick).toMatchObject({ status: "ask", route: null, candidates: ["first", "second"] })
		expect(result.result.nextAction).toBe("Ask Nathan to choose one route: first, second.")
	})

	test("an unknown host role asks Nathan on a personal route", () => {
		const created = fixture({ hostRole: null })
		writeRoutes(created, [route("personal-claude-code")])
		const gate = routeOf(card(created), "personal-claude-code").gates[1]
		expect(gate).toEqual({ gate: "G2", verdict: "confirm", evidence: "unknown", reason: "this host's role is unknown: the installation manifest records no readable host_role; Nathan must confirm" })
	})
})

describe("Monash snapshot routes", () => {
	test("a stale snapshot refuses at G2 and a fresh one passes G2 but still refuses employer launch", () => {
		const stale = fixture({ snapshot: snapshot(daysAgo(16).slice(0, 10)) })
		writeRoutes(stale, [])
		const staleRoute = routeOf(card(stale), "monash-foundry-claude-model-a")
		expect(staleRoute.refusal.gate).toBe("G2")
		expect(staleRoute.gates[1]).toMatchObject({ verdict: "refuse", evidence: "stale" })
		const fresh = fixture({ snapshot: snapshot(daysAgo(1)) })
		writeRoutes(fresh, [])
		const freshRoute = routeOf(card(fresh), "monash-foundry-claude-model-a")
		expect(verdicts(freshRoute.gates)).toEqual(["G1:pass:observed", "G2:pass:observed", "G3:refuse:unknown", "G4:refuse:unknown", "G5:refuse:unknown"])
		expect(freshRoute.gates[3].reason).toBe("Monash reserve is refused until a supported usage source exists")
	})

	test("evidence hosts normalise profile ids and this machine's hostname; other raw hostnames stay unmapped", () => {
		const created = fixture({ snapshot: snapshot(daysAgo(1), ["mini", hostname(), "some-other-machine"]) })
		writeRoutes(created, [])
		const monash = routeOf(card(created), "monash-foundry-claude-model-a")
		expect(monash.hosts).toEqual({ declared: [], qualified: ["laptop", "mini"], unmappedEvidenceHosts: 1 })
		expect(routeOf(card(created), "monash-foundry-claude-model-a").refusal.gate).toBe("G3")
	})
})

describe("refusals", () => {
	test("run without --dry-run is refused before any probe runs", () => {
		const created = fixture()
		writeRoutes(created, [route("personal-claude-code")])
		const result = envelope(invoke(created, ["run", "hpr-f5n.3", "--json"]))
		expect(result.result).toMatchObject({
			causeCode: "DOMAIN_AUTHORITY_REQUIRED",
			outcome: "refused",
			exitCode: 3,
			data: null,
			handoff: { owner: "human", inspect: ["agent-router run TASK --dry-run"] },
		})
		expect(Bun.file(created.probeLog).size).toBe(0)
	})

	test("the dry run needs a routes file; the inventory reports it missing", () => {
		const created = fixture()
		const refused = envelope(invoke(created, ["run", "hpr-f5n.3", "--dry-run", "--json"]))
		expect(refused.result).toMatchObject({ causeCode: "DOMAIN_CONFIG_MISSING", exitCode: 3, data: null })
		const listed = envelope(invoke(created, ["routes", "--json"]))
		expect(listed.result.data.sources.routesFile).toEqual({ path: created.routesPath, status: "missing" })
		expect(listed.result.data.routes.map((entry: { id: string }) => entry.id)).toEqual(["monash-foundry-claude-model-a"])
	})

	test("a routes file with an undeclared field is a schema refusal that does not echo the value", async () => {
		const created = fixture()
		await Bun.write(created.routesPath, JSON.stringify({ schemaVersion: 1, routes: [{ ...route("leaky"), token: SECRET_MARKER }] }))
		const invocation = invoke(created, ["run", "hpr-f5n.3", "--dry-run", "--json"])
		expect(envelope(invocation).result).toMatchObject({ causeCode: "SCHEMA_CONFIG_INVALID", exitCode: 4 })
		expect(invocation.stdout).toContain("routes[0].token is not a declared field")
		expect(invocation.stdout).not.toContain(SECRET_MARKER)
	})

	test("Task text is refused without being echoed", () => {
		const created = fixture()
		writeRoutes(created, [route("personal-claude-code")])
		const invocation = invoke(created, ["run", "Fix the private billing thing", "--dry-run", "--json"])
		expect(envelope(invocation).result).toMatchObject({ causeCode: "SCHEMA_INVALID_INPUT", exitCode: 4 })
		expect(invocation.stdout).not.toContain("billing")
	})

	test("a probe past its time budget is a bounded transient refusal", () => {
		const created = fixture({ monashDelaySeconds: 0.5 })
		writeRoutes(created, [route("personal-claude-code")])
		const result = envelope(invoke(created, ["run", "hpr-f5n.3", "--dry-run", "--probe-timeout-ms", "50", "--json"]))
		expect(result.result).toMatchObject({ causeCode: "TRANSIENT_NOT_STARTED", exitCode: 75, retryable: true, retryDelayMilliseconds: 5000, data: null })
	})

	test("an unreadable routes path is an internal failure with a handoff", () => {
		const created = fixture()
		const result = envelope(invoke(created, ["run", "hpr-f5n.3", "--dry-run", "--routes-file", created.root, "--json"]))
		expect(result.result).toMatchObject({ causeCode: "INTERNAL_UNEXPECTED", outcome: "failed", exitCode: 1, handoff: { owner: "human" } })
	})
})

describe("no secrets and no effects (B2, B4)", () => {
	test("the card and inventory carry no secret from the Monash configuration and no Task text", () => {
		const created = fixture()
		writeRoutes(created, [route("personal-claude-code")])
		for (const args of [["run", "hpr-f5n.3", "--dry-run"], ["routes"]]) {
			for (const mode of [[], ["--json"]]) {
				const invocation = invoke(created, [...args, ...mode])
				expect(invocation.exitCode).toBe(0)
				expect(invocation.stdout).not.toContain(SECRET_MARKER)
				expect(invocation.stdout).not.toMatch(/apiKey|subscription/)
			}
		}
	})

	test("a dry run and an inventory change no file and run only the declared read-only probes", async () => {
		const created = fixture()
		writeRoutes(created, [route("personal-claude-code"), route("personal-codex", { harness: "codex", model: { id: "gpt-6-sol" } })])
		writeObservations(created, [])
		await Bun.write(join(created.root, "herdr-projects", "demo", "PROJECT.md"), "# Demo\n")
		const before = tree(created.root)
		expect(invoke(created, ["run", "hpr-f5n.3", "--dry-run", "--project", "demo", "--json"]).exitCode).toBe(0)
		expect(invoke(created, ["routes", "--json"]).exitCode).toBe(0)
		expect(tree(created.root)).toEqual(before)
		const probes = (await Bun.file(created.probeLog).text()).trim().split("\n").sort()
		expect([...new Set(probes)]).toEqual(["claude --version", "codex --version", "monash models --json"])
	})

	test("the card names the Herdr Projects target and reports a missing project as a gap", async () => {
		const created = fixture()
		writeRoutes(created, [route("personal-claude-code")])
		await Bun.write(join(created.root, "herdr-projects", "demo", "PROJECT.md"), "# Demo\n")
		expect(card(created, ["--project", "demo"]).result.data.target).toEqual({ status: "present", project: "demo", root: join(created.root, "herdr-projects") })
		const missing = card(created, ["--project", "absent"]).result.data
		expect(missing.target.status).toBe("missing")
		expect(missing.gaps.find((gap: { field: string }) => gap.field === "Herdr Projects target")).toMatchObject({ reason: "target missing" })
	})
})
