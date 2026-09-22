import { describe, expect, test } from "bun:test"
import { BINDING_SCHEMA, COMMANDS, collectSecretValues, discovery, exitFor, machineMode, type OutcomeFacts, redactText, renderDiscoveryHuman, renderOutcome } from "../../src/command-contract.ts"

// Contract Core 1.0.0 as literals (independent oracle): identities, effect stances, exits, envelope spelling, redaction.

const IDENTITIES: ReadonlyArray<readonly [identity: string, effectClass: string]> = [
	["msb-workflow.help", "inspect"],
	["msb-workflow.discover", "inspect"],
	["msb-workflow.inspect", "inspect"],
	["msb-workflow.bind", "repository-local"],
	["msb-workflow.recover", "inspect"],
	["msb-workflow.hook", "repository-local"],
]

function facts(overrides: Partial<OutcomeFacts> = {}): OutcomeFacts {
	return {
		commandIdentity: "msb-workflow.recover",
		runIdentity: "run-1",
		outcome: "success",
		failureClass: null,
		causeCode: null,
		message: "ok",
		effectClass: "inspect",
		transactionState: "unchanged",
		retryable: false,
		retryDelayMilliseconds: null,
		nextAction: null,
		availablePaths: [],
		repairAction: null,
		handoff: null,
		result: { station: "recovered" },
		...overrides,
	}
}

describe("command declarations", () => {
	test("exactly the six identities with their fixed effect stances, in order", () => {
		expect(COMMANDS.map((command) => [command.identity, command.effectClass] as [string, string])).toEqual(IDENTITIES.map((row) => [...row] as [string, string]))
	})

	test("the bind invocation is pinned: the verified same-session switch is the trailing optional --from <bead-id>", () => {
		expect(COMMANDS.find((command) => command.identity === "msb-workflow.bind")?.argv).toBe("msb-workflow bind --workspace <absolute-path> --bead <bead-id> [--session <id>] [--evidence <absolute-file>] [--from <bead-id>]")
		expect(COMMANDS.filter((command) => command.identity !== "msb-workflow.bind").some((command) => command.argv.includes("--from"))).toBe(false)
	})

	test("exit mapping is closed and aligned with failure classes", () => {
		expect([exitFor(null), exitFor("internal"), exitFor("usage"), exitFor("domain"), exitFor("schema"), exitFor("unavailable")]).toEqual([0, 1, 2, 3, 4, 75])
	})

	test("machine mode is --json anywhere in argv", () => {
		expect(machineMode(["recover", "--json", "--workspace", "/w"])).toBe(true)
		expect(machineMode(["--json"])).toBe(true)
		expect(machineMode(["recover", "--workspace", "/w"])).toBe(false)
	})
})

describe("discovery", () => {
	test("carries the contract, the six commands, the exit meanings, machine mode, logtape and the additive binding schema", () => {
		const data = discovery()
		expect(data.name).toBe("msb-workflow")
		expect(data.contractVersion).toBe("1.0.0")
		expect(data.generationConventionVersion).toBe("1.0.0")
		expect(data.commands.map((command) => command.identity as string)).toEqual(IDENTITIES.map(([identity]) => identity))
		expect(data.exitMeanings).toEqual({ "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "unavailable" })
		expect(data.machineMode).toBe("--json")
		expect(data.logtape).toBe(true)
		expect(data.bindingSchema).toBe(BINDING_SCHEMA)
	})

	test("the binding schema is pinned: v3, session-keyed address, the twelve closed fields, bounds and modes", () => {
		expect(BINDING_SCHEMA.schemaVersion).toBe(3)
		expect(BINDING_SCHEMA.address).toBe("<state-root>/my-second-brain-playground/workflow-cli/recovery/sessions/<session-id>.json")
		expect(BINDING_SCHEMA.required).toEqual(["schemaVersion", "sessionIdentity", "workspace", "storePath", "storePrefix", "beadsExecutable", "beadsVersion", "beadId", "beadObservedAt", "sourceRepository", "evidencePath", "observedAt"])
		expect(BINDING_SCHEMA.additionalProperties).toBe(false)
		expect(BINDING_SCHEMA.nullable).toEqual(["evidencePath"])
		expect(BINDING_SCHEMA.sessionIdentityPattern).toBe("^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
		expect([BINDING_SCHEMA.limitBytes, BINDING_SCHEMA.freshForSeconds, BINDING_SCHEMA.futureSkewSeconds, BINDING_SCHEMA.fileMode, BINDING_SCHEMA.directoryMode]).toEqual([16384, 3600, 300, "0600", "0700"])
		expect(BINDING_SCHEMA.stateRootOrder).toEqual(["MSB_WORKFLOW_STATE_HOME", "XDG_STATE_HOME", "$HOME/.local/state"])
	})

	test("human discovery is prose, not JSON, and names every identity", () => {
		const text = renderDiscoveryHuman()
		expect(() => JSON.parse(text)).toThrow()
		for (const [identity] of IDENTITIES) expect(text).toContain(identity)
		expect(text).toContain("binding schema v3")
	})
})

describe("renderOutcome", () => {
	test("machine mode prints one envelope line with the fixed version fields and nothing on stderr", () => {
		const rendered = renderOutcome(facts(), "machine")
		expect(rendered.stderr).toBe("")
		expect(rendered.exit).toBe(0)
		const lines = rendered.stdout.split("\n")
		expect(lines).toHaveLength(2)
		const envelope = JSON.parse(lines[0] as string) as Record<string, unknown>
		expect(envelope.envelopeVersion).toBe(1)
		expect(envelope.contractVersion).toBe("1.0.0")
		expect(Object.keys(envelope)).toEqual(["envelopeVersion", "contractVersion", "commandIdentity", "runIdentity", "outcome", "failureClass", "causeCode", "message", "effectClass", "transactionState", "retryable", "retryDelayMilliseconds", "nextAction", "availablePaths", "repairAction", "handoff", "result"])
	})

	test("human mode prints a panel as prose on success and exactly one cause-and-repair line on stderr on refusal", () => {
		const success = renderOutcome(facts({ result: { station: "recovered", resumePanel: "# Resume Panel\nSession: s" } }), "human")
		expect(success).toEqual({ stdout: "# Resume Panel\nSession: s\n", stderr: "", exit: 0 })
		const refused = renderOutcome(facts({ outcome: "refused", failureClass: "domain", causeCode: "DOMAIN_BINDING_ABSENT", message: "no binding\nsecond line", nextAction: "msb-workflow bind", repairAction: "bind first" }), "human")
		expect(refused.stdout).toBe("")
		expect(refused.stderr).toBe("msb-workflow: DOMAIN_BINDING_ABSENT: no binding second line; repair: bind first\n")
		expect(refused.exit).toBe(3)
	})

	test.each([
		["a cause code without its class prefix", { outcome: "refused", failureClass: "domain", causeCode: "SCHEMA_X", nextAction: "x" }],
		["a refusal with neither next action nor handoff", { outcome: "refused", failureClass: "domain", causeCode: "DOMAIN_X" }],
		["a refusal with both next action and handoff", { outcome: "refused", failureClass: "domain", causeCode: "DOMAIN_X", nextAction: "a", handoff: { reason: "b", prerequisites: [] } }],
		["an unknown identity", { commandIdentity: "msb-workflow.apply" }],
		["a retryable unknown transaction", { outcome: "unknown", failureClass: "internal", causeCode: "INTERNAL_X", transactionState: "unknown", retryable: true, nextAction: "x" }],
	] as const)("invalid facts (%s) fall back to the fixed INTERNAL_RENDER_FAILURE envelope with exit 1", (_label, overrides) => {
		const rendered = renderOutcome(facts(overrides as Partial<OutcomeFacts>), "machine")
		const envelope = JSON.parse(rendered.stdout) as Record<string, unknown>
		expect(envelope.causeCode).toBe("INTERNAL_RENDER_FAILURE")
		expect(envelope.outcome).toBe("failed")
		expect(envelope.result).toEqual({ station: "render-failed" })
		expect(rendered.exit).toBe(1)
	})

	test("secret-pattern keys and known secret values are redacted on every stream", () => {
		const rendered = renderOutcome(facts({ message: "saw MARKER_9 here", result: { station: "recovered", metadata: { api_key: "MARKER_9", safe: "kept" }, resumePanel: "comment: api_key=MARKER_9", nested: [{ private_key: "x" }] } }), "machine", { knownSecretValues: ["MARKER_9"] })
		expect(rendered.stdout).not.toContain("MARKER_9")
		const envelope = JSON.parse(rendered.stdout) as { message: string; result: Record<string, unknown> }
		expect(envelope.message).toBe("saw [REDACTED] here")
		expect(envelope.result.metadata).toEqual({ api_key: "[REDACTED]", safe: "kept" })
		expect(envelope.result.resumePanel).toBe("comment: api_key=[REDACTED]")
		expect(envelope.result.nested).toEqual([{ private_key: "[REDACTED]" }])
		const human = renderOutcome(facts({ outcome: "refused", failureClass: "domain", causeCode: "DOMAIN_X", message: "MARKER_9", nextAction: "n", repairAction: "MARKER_9" }), "human", { knownSecretValues: ["MARKER_9"] })
		expect(human.stderr).toBe("msb-workflow: DOMAIN_X: [REDACTED]; repair: [REDACTED]\n")
	})
})

describe("secret discovery", () => {
	test("collects every value under a secret-pattern key at any depth and nothing else", () => {
		expect(collectSecretValues([{ metadata: { api_key: "k1", note: "n" }, comments: [{ text: "t", token: "k2" }] }, { nested: { deep: { Private_Key: "k3" } } }, "k4", 5]).sort()).toEqual(["k1", "k2", "k3"])
		expect(collectSecretValues({ password: "" })).toEqual([])
	})

	test("redactText replaces known values only", () => {
		expect(redactText("a k1 b k1", ["k1", ""])).toBe("a [REDACTED] b [REDACTED]")
	})
})
