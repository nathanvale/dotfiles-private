// Task hpr-f5n.3 acceptance B2 and B4 through the public process: fixture routes and evidence in, the dry-run card
// or a declared refusal out. Expected values are test-owned literals.
import { afterEach, describe, expect, test } from "bun:test"
import { statSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import {
	ago,
	createFixture,
	daysAgo,
	envelope,
	type Fixture,
	guideRevision,
	invoke,
	removeFixture,
	route,
	SECRET_MARKER,
	snapshot,
	tree,
	writeRoutes,
} from "./fixtures/harness.ts"

const DAY = 86_400_000
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
	test("a qualified personal route needs Nathan's confirmation of unknown identity and quota and carries its guide revision", () => {
		const created = fixture()
		writeRoutes(created, [route("personal-claude-code")])
		const result = card(created)
		const qualified = routeOf(result, "personal-claude-code")
		expect(verdicts(qualified.gates)).toEqual(["G1:pass:declared", "G2:pass:observed", "G3:confirm:unknown", "G4:confirm:unknown", "G5:pass:observed"])
		expect(qualified.decision).toBe("needs-confirmation")
		expect(result.result.data.pick).toMatchObject({
			status: "needs-confirmation",
			route: "personal-claude-code",
			confirmations: ["G3", "G4"],
			provisional: true,
			typeSafe: "not-consulted",
			modelGuideRevision: guideRevision(),
		})
		expect(result.result.data.gateOrder.map((gate: { gate: string }) => gate.gate)).toEqual(["G1", "G2", "G3", "G4", "G5"])
		expect(result.result.nextAction).toBe("Ask Nathan to confirm G3, G4 for personal-claude-code before any launch.")
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

	test("missing account proof asks Nathan for a personal route and refuses an employer route", () => {
		const created = fixture()
		writeRoutes(created, [route("personal-unproved"), route("employer-unproved", { ownership: "employer" })])
		const result = card(created)
		expect(routeOf(result, "personal-unproved").gates[2]).toEqual({
			gate: "G3",
			verdict: "confirm",
			evidence: "unknown",
			reason: "identity unknown for declared alias personal; no owner observes identity yet and a login is not proof; Nathan must confirm",
		})
		expect(routeOf(result, "employer-unproved").refusal).toEqual({
			gate: "G3",
			reason: "identity unknown for declared alias personal; no owner observes identity yet and a login is not proof; an employer route never launches on it",
		})
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

describe("freshness and Monash snapshot routes", () => {
	function monashG2(observedAt: string): Gate {
		const created = fixture({ snapshot: snapshot(observedAt) })
		writeRoutes(created, [])
		return routeOf(card(created), "monash-foundry-claude-model-a").gates[1]
	}

	test("stale snapshot evidence and unknown quota are reported distinctly", () => {
		const created = fixture({ snapshot: snapshot(daysAgo(16)) })
		writeRoutes(created, [route("personal-claude-code")])
		const result = card(created)
		expect(routeOf(result, "monash-foundry-claude-model-a").gates[1]).toMatchObject({ gate: "G2", verdict: "refuse", evidence: "stale" })
		expect(routeOf(result, "personal-claude-code").gates[3]).toEqual({ gate: "G4", verdict: "confirm", evidence: "unknown", reason: "quota unknown: no usage source observed; Nathan must confirm" })
		expect(routeOf(result, "personal-claude-code").quota.freshness).toEqual({ state: "not-observed", observedAt: null, ageDays: null })
	})

	test("evidence one millisecond past seven days is stale", () => {
		expect(monashG2(ago(7 * DAY + 1))).toMatchObject({ verdict: "refuse", evidence: "stale" })
	})

	test("evidence just inside seven days is fresh", () => {
		expect(monashG2(ago(7 * DAY - 60_000))).toMatchObject({ verdict: "pass", evidence: "observed" })
	})

	test("a future snapshot timestamp is invalid evidence, never fresh", () => {
		const observedAt = new Date(Date.now() + DAY).toISOString()
		expect(monashG2(observedAt)).toEqual({ gate: "G2", verdict: "refuse", evidence: "unknown", reason: `the snapshot timestamp ${observedAt} is in the future or unreadable, so it is not evidence` })
	})

	test("a fresh snapshot passes G2 but an employer route is still refused", () => {
		const created = fixture()
		writeRoutes(created, [])
		const monash = routeOf(card(created), "monash-foundry-claude-model-a")
		expect(verdicts(monash.gates)).toEqual(["G1:pass:observed", "G2:pass:observed", "G3:refuse:unknown", "G4:refuse:unknown", "G5:refuse:unknown"])
		expect(monash.gates[3].reason).toBe("Monash reserve is refused until a supported usage source exists")
	})

	test("evidence hosts map declared ids, this host's role and this machine's hostname; other names stay unmapped", () => {
		const created = fixture({ snapshot: snapshot(daysAgo(1), ["mini", hostname(), "some-other-machine"]) })
		writeRoutes(created, [route("mini-route", { hosts: ["mini"] })])
		const monash = routeOf(card(created), "monash-foundry-claude-model-a")
		expect(monash.hosts).toEqual({ declared: [], qualified: ["laptop", "mini"], unmappedEvidenceHosts: 1 })
	})
})

describe("refusals", () => {
	test("run without --dry-run is refused before any probe runs", async () => {
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
		expect(await Bun.file(created.probeLog).text()).toBe("")
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
})

describe("no secrets and no effects (B2, B4)", () => {
	test("the card and inventory carry no secret from the snapshot and no Task text", () => {
		const created = fixture()
		writeRoutes(created, [route("personal-claude-code")])
		for (const args of [["run", "hpr-f5n.3", "--dry-run"], ["routes"]]) {
			for (const mode of [[], ["--json"]]) {
				const invocation = invoke(created, [...args, ...mode])
				expect(invocation.exitCode).toBe(0)
				expect(invocation.stdout).not.toContain(SECRET_MARKER)
			}
		}
	})

	test("a dry run and an inventory change no file, open no credential file and run only the declared read-only probes", async () => {
		const created = fixture()
		writeRoutes(created, [route("personal-claude-code"), route("personal-codex", { harness: "codex", model: { id: "gpt-6-sol" } })])
		await Bun.write(join(created.root, "herdr-projects", "demo", "PROJECT.md"), "# Demo\n")
		const before = tree(created.root)
		// Each credential sentinel is mode 000, so any open by the router ends the run with INTERNAL_UNEXPECTED (exit 1).
		expect(created.credentialSentinels.map((path) => statSync(path).mode & 0o777)).toEqual([0, 0, 0])
		expect(envelope(invoke(created, ["run", "hpr-f5n.3", "--dry-run", "--project", "demo", "--json"])).result.exitCode).toBe(0)
		expect(envelope(invoke(created, ["routes", "--json"])).result.exitCode).toBe(0)
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
