import { describe, expect, test } from "bun:test"
import { EgressInvariantError, emitMachine, internalFailureEnvelope, narrowFallback, routeRawArgv } from "../../src/cli.ts"
import { CAUSE, CLI_OPTIONS, COMMANDS, discovery, EXIT, MachineEnvelopeSchema, ROUTES, STATIONS } from "../../src/command-contract.ts"
import type { ExecutionFacts } from "../../src/model.ts"
import { parseFaults } from "../../src/runtime.ts"

// Independent oracle: every expected value below is restated from Contract Core 1.0.0, the fixture or PE revision 3,
// never read from the module under test. The modules supply enumeration only.

const EXPECTED_EXIT_MEANINGS = { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "retryable-or-unavailable" }
const EXPECTED_IDENTITIES = [
	"repair-lab.help",
	"repair-lab.discover",
	"repair-lab.status",
	"repair-lab.inspect",
	"repair-lab.inspect-diagnostics",
	"repair-lab.preview",
	"repair-lab.apply",
	"repair-lab.repair",
	"repair-lab.repair-retry",
	"repair-lab.recover",
] as const
const EXPECTED_OPTIONS = {
	json: { type: "boolean" },
	help: { type: "boolean" },
	discover: { type: "boolean" },
	preview: { type: "boolean" },
	apply: { type: "boolean" },
	automation: { type: "boolean" },
	"retry-once": { type: "boolean" },
	"include-diagnostics": { type: "boolean" },
	state: { type: "string" },
	"preview-id": { type: "string" },
	authorize: { type: "string" },
} as const
const EXPECTED_ROUTES = [
	["help", "repair-lab.help", "help", ["help", "json"], ["help"]],
	["discover", "repair-lab.discover", "discover", ["discover", "json"], ["discover"]],
	["status", "repair-lab.status", "status", ["json"], []],
	["inspect", "repair-lab.inspect", "inspect", ["json", "state"], []],
	["inspect-diagnostics", "repair-lab.inspect-diagnostics", "inspect", ["json", "state", "include-diagnostics"], ["include-diagnostics"]],
	["preview", "repair-lab.preview", "apply", ["json", "preview"], ["preview"]],
	["apply", "repair-lab.apply", "apply", ["json", "preview-id", "authorize", "automation"], []],
	["repair-preview", "repair-lab.repair", "repair", ["json", "preview"], ["preview"]],
	["repair", "repair-lab.repair", "repair", ["json", "apply", "preview-id", "authorize", "automation"], ["apply"]],
	["repair-retry", "repair-lab.repair-retry", "repair", ["json", "apply", "retry-once", "authorize", "automation"], ["apply", "retry-once"]],
	["recover", "repair-lab.recover", "recover", ["json"], []],
] as const
const EXPECTED_COMMANDS = [
	{ identity: "repair-lab.help", argv: "--help", effectClass: "inspect", description: "Show help and usage" },
	{ identity: "repair-lab.discover", argv: "--discover --json", effectClass: "inspect", description: "Describe commands and the contract" },
	{ identity: "repair-lab.status", argv: "status [--json]", effectClass: "inspect", description: "Report the resource status" },
	{ identity: "repair-lab.inspect", argv: "inspect [--state <path>] [--json]", effectClass: "inspect", description: "Inspect the resource and preview readiness" },
	{ identity: "repair-lab.inspect-diagnostics", argv: "inspect --include-diagnostics [--json]", effectClass: "inspect", description: "Inspect with redacted diagnostic fields" },
	{ identity: "repair-lab.preview", argv: "apply --preview [--json]", effectClass: "repository-local", description: "Write an apply preview without mutating state" },
	{ identity: "repair-lab.apply", argv: "apply --preview-id <id> --authorize fixture-authority [--json]", effectClass: "repository-local", description: "Apply a fresh preview with fixture-local authority" },
	{ identity: "repair-lab.repair", argv: "repair --preview | repair --apply --preview-id <id> --authorize fixture-authority [--json]", effectClass: "repository-local", description: "Preview or apply a repair of the derived index" },
	{ identity: "repair-lab.repair-retry", argv: "repair --apply --retry-once --authorize fixture-authority [--json]", effectClass: "repository-local", description: "Apply a repair with one bounded transient retry" },
	{ identity: "repair-lab.recover", argv: "recover [--json]", effectClass: "repository-local", description: "Read the journal and resource to report recovery state" },
] as const
// Independent oracle: the 20 Contract Core 1.0 causes plus the four accepted revision-3 fallback causes, with their classes.
const EXPECTED_CAUSES: Record<string, "usage" | "domain" | "schema" | "internal" | "unavailable"> = {
	USAGE_UNKNOWN_OPTION: "usage",
	USAGE_INVALID_ARGUMENTS: "usage",
	USAGE_COMMAND_REQUIRED: "usage",
	USAGE_UNKNOWN_COMMAND: "usage",
	DOMAIN_INPUT_MISSING: "domain",
	DOMAIN_INPUT_MALFORMED: "domain",
	DOMAIN_INPUT_UNREADABLE: "domain",
	DOMAIN_PATH_ESCAPE: "domain",
	DOMAIN_PREVIEW_STALE: "domain",
	DOMAIN_PREVIEW_CONSUMED: "domain",
	DOMAIN_PREVIEW_MISSING: "domain",
	DOMAIN_AUTHORITY_MISSING: "domain",
	DOMAIN_REPAIR_REQUIRED: "domain",
	DOMAIN_REPAIR_NOT_REQUIRED: "domain",
	DOMAIN_RECOVERY_HANDOFF_REQUIRED: "domain",
	SCHEMA_STATE_INVALID: "schema",
	UNAVAILABLE_STORAGE_BUSY: "unavailable",
	INTERNAL_UNEXPECTED: "internal",
	INTERNAL_EFFECT_OUTCOME_UNKNOWN: "internal",
	INTERNAL_EFFECT_NOT_OBSERVED: "internal",
	INTERNAL_PREPARATION: "internal",
	INTERNAL_RESULT_UNCHANGED: "internal",
	INTERNAL_RESULT_COMPLETED: "internal",
	INTERNAL_RESULT_UNKNOWN: "internal",
}
const ENVELOPE_FIELDS = ["envelopeVersion", "contractVersion", "commandIdentity", "runIdentity", "outcome", "failureClass", "causeCode", "message", "effectClass", "transactionState", "retryable", "retryDelayMilliseconds", "nextAction", "availablePaths", "repairAction", "handoff", "result"]

function facts(overrides: Partial<ExecutionFacts>): ExecutionFacts {
	return { commandIdentity: "repair-lab.apply", runIdentity: "run-test", domainOutcome: "success", effectClass: "repository-local", transactionState: "completed", completedEffectIds: ["effect.update-index", "effect.write-journal"], remainingEffectIds: [], stationLabel: "repair-lab.authorized-apply", guidance: { kind: "next-action", target: "repair-lab inspect" }, ...overrides }
}

function valid(): Record<string, unknown> {
	return { envelopeVersion: 1, contractVersion: "1.0.0", commandIdentity: "repair-lab.status", runIdentity: "run-x", outcome: "success", failureClass: null, causeCode: null, message: "ok", effectClass: "inspect", transactionState: "unchanged", retryable: true, retryDelayMilliseconds: null, nextAction: "repair-lab inspect", availablePaths: ["repair-lab --help"], repairAction: null, handoff: null, result: { a: 1 } }
}

describe("discovery and exit map", () => {
	test("discovery lists ten commands, six exit keys with the contract's words, machineMode --json and logtape true", () => {
		const document = discovery() as { commands: Array<{ identity: string; argv: string; effectClass: string; description: string }>; exitMeanings: Record<string, string>; machineMode: string; logtape: boolean; contractVersion: string; generationConventionVersion: string; name: string }
		expect(document.name).toBe("repair-lab")
		expect(document.contractVersion).toBe("1.0.0")
		expect(document.generationConventionVersion).toBe("1.0.0")
		const observedCommands: unknown = document.commands
		expect(observedCommands).toEqual(EXPECTED_COMMANDS)
		expect(document.exitMeanings).toEqual(EXPECTED_EXIT_MEANINGS)
		expect(document.machineMode).toBe("--json")
		expect(document.logtape).toBe(true)
	})
	test("the exit map is the contract's numeric mapping", () => {
		expect(EXIT).toEqual({ success: 0, internal: 1, usage: 2, domain: 3, schema: 4, unavailable: 75 })
	})
	test("every cause code carries its class prefix and the cause owner is exactly the expected set", () => {
		for (const [code, failureClass] of Object.entries(CAUSE)) expect(code.startsWith(`${failureClass.toUpperCase()}_`)).toBe(true)
		expect(Object.keys(CAUSE).sort()).toEqual(Object.keys(EXPECTED_CAUSES).sort())
		expect(Object.keys(CAUSE)).toContain("INTERNAL_PREPARATION")
		expect(Object.keys(CAUSE)).toContain("INTERNAL_RESULT_UNCHANGED")
		expect(Object.keys(CAUSE)).toContain("INTERNAL_RESULT_COMPLETED")
		expect(Object.keys(CAUSE)).toContain("INTERNAL_RESULT_UNKNOWN")
	})
	test("the typed option and route owner projects parser, admission and discovery vocabulary (STD-01)", () => {
		expect(CLI_OPTIONS).toEqual(EXPECTED_OPTIONS)
		const observedRoutes: unknown = ROUTES.map((route) => [route.route, route.identity, route.word, route.allowedOptions, route.requiredOptions])
		const observedCommands: unknown = COMMANDS
		expect(observedRoutes).toEqual(EXPECTED_ROUTES)
		expect(observedCommands).toEqual(EXPECTED_COMMANDS)
	})
})

describe("MachineEnvelopeSchema", () => {
	test("accepts a valid 17-field envelope and rejects an extra key", () => {
		expect(MachineEnvelopeSchema.safeParse(valid()).success).toBe(true)
		expect(Object.keys(valid())).toEqual(ENVELOPE_FIELDS)
		expect(MachineEnvelopeSchema.safeParse({ ...valid(), extra: true }).success).toBe(false)
	})
	// Cross-field negatives use real 1.0 codes so they can fail only for the cross-field reason (PR 184, 4003822444).
	test("rejects success with a failure class (outcome/failureClass rule)", () => {
		expect(MachineEnvelopeSchema.safeParse({ ...valid(), failureClass: "domain", causeCode: "DOMAIN_PREVIEW_STALE" }).success).toBe(false)
	})
	test("rejects a cause code whose prefix disagrees with the class", () => {
		expect(MachineEnvelopeSchema.safeParse({ ...valid(), outcome: "refused", failureClass: "domain", causeCode: "USAGE_UNKNOWN_OPTION" }).success).toBe(false)
	})
	test("rejects an unknown command identity and an unknown prefix-valid cause on otherwise valid envelopes; accepts every declared identity and cause (PR 184, 4003822444)", () => {
		const refused = { ...valid(), outcome: "refused", failureClass: "domain", causeCode: "DOMAIN_PREVIEW_STALE" }
		expect(MachineEnvelopeSchema.safeParse(refused).success).toBe(true)
		expect(MachineEnvelopeSchema.safeParse({ ...valid(), commandIdentity: "repair-lab.unknown" }).success).toBe(false)
		expect(MachineEnvelopeSchema.safeParse({ ...valid(), commandIdentity: "" }).success).toBe(false)
		expect(MachineEnvelopeSchema.safeParse({ ...refused, causeCode: "DOMAIN_NOT_A_CAUSE" }).success).toBe(false)
		expect(MachineEnvelopeSchema.safeParse({ ...refused, failureClass: "usage", causeCode: "USAGE_NOT_A_CAUSE" }).success).toBe(false)
		for (const identity of EXPECTED_IDENTITIES) expect(MachineEnvelopeSchema.safeParse({ ...valid(), commandIdentity: identity }).success).toBe(true)
		for (const [code, failureClass] of Object.entries(EXPECTED_CAUSES)) expect(`${code} ${MachineEnvelopeSchema.safeParse({ ...valid(), outcome: "refused", failureClass, causeCode: code }).success}`).toBe(`${code} true`)
	})
	test("rejects both nextAction and handoff on a refusal, and neither; rejects both on a success too (F10)", () => {
		const refused = { ...valid(), outcome: "refused", failureClass: "domain", causeCode: "DOMAIN_PREVIEW_STALE" }
		expect(MachineEnvelopeSchema.safeParse({ ...refused, handoff: { reason: "r", prerequisites: [] } }).success).toBe(false)
		expect(MachineEnvelopeSchema.safeParse({ ...refused, nextAction: null }).success).toBe(false)
		expect(MachineEnvelopeSchema.safeParse({ ...valid(), handoff: { reason: "r", prerequisites: [] } }).success).toBe(false)
		expect(MachineEnvelopeSchema.safeParse({ ...valid(), nextAction: null }).success).toBe(true)
	})
	test("rejects an unresolved success and a retryable unresolved state", () => {
		expect(MachineEnvelopeSchema.safeParse({ ...valid(), transactionState: "unknown" }).success).toBe(false)
		expect(MachineEnvelopeSchema.safeParse({ ...valid(), outcome: "unknown", failureClass: "internal", causeCode: "INTERNAL_EFFECT_OUTCOME_UNKNOWN", transactionState: "unknown", retryable: true }).success).toBe(false)
		expect(MachineEnvelopeSchema.safeParse({ ...valid(), outcome: "unknown", failureClass: "internal", causeCode: "INTERNAL_EFFECT_OUTCOME_UNKNOWN", transactionState: "unknown", retryable: false }).success).toBe(true)
	})
	test("rejects a non-string message and a bad enum member", () => {
		expect(MachineEnvelopeSchema.safeParse({ ...valid(), message: 42 }).success).toBe(false)
		expect(MachineEnvelopeSchema.safeParse({ ...valid(), outcome: "maybe" }).success).toBe(false)
	})
})

describe("raw argv routing", () => {
	test("identity is derived before strict parsing", () => {
		expect(routeRawArgv(["status", "--bogus", "--json"]).identity).toBe("repair-lab.status")
		expect(routeRawArgv(["--discover", "--bogus", "--json"]).identity).toBe("repair-lab.discover")
		expect(routeRawArgv(["apply", "--preview", "--bogus"]).identity).toBe("repair-lab.preview")
		expect(routeRawArgv(["recover", "--bogus"]).identity).toBe("repair-lab.recover")
		expect(routeRawArgv(["repair", "--apply", "--retry-once"]).identity).toBe("repair-lab.repair-retry")
		expect(routeRawArgv(["inspect", "--include-diagnostics"]).identity).toBe("repair-lab.inspect-diagnostics")
		expect(routeRawArgv(["--json"]).identity).toBe("repair-lab.help")
	})
})

describe("fault channel", () => {
	test("one domain fault plus one egress fault compose; duplicates and two of a kind are rejected", () => {
		expect(parseFaults(undefined)).toEqual({ domain: null, egress: null })
		expect(parseFaults("throw-internal+egress-non-json:cycle")).toEqual({ domain: "throw-internal", egress: { kind: "egress-non-json", variant: "cycle" } })
		expect(parseFaults("halt-before-effect:effect.update-index")).toEqual({ domain: { kind: "halt-before-effect", effectId: "effect.update-index" }, egress: null })
		expect(parseFaults("throw-internal+silent-no-op")).toBeNull()
		expect(parseFaults("egress-non-json:cycle+egress-schema-invalid:extra-key")).toBeNull()
		expect(parseFaults("throw-internal+throw-internal")).toBeNull()
		expect(parseFaults("nope")).toBeNull()
	})
})

describe("D6-c fallback builder", () => {
	const ADMITTED: Array<[ExecutionFacts["domainOutcome"], ExecutionFacts["transactionState"], string, string]> = [
		["refused", "unchanged", "INTERNAL_PREPARATION", "refused"],
		["failed", "unchanged", "INTERNAL_RESULT_UNCHANGED", "failed"],
		["success", "unchanged", "INTERNAL_RESULT_UNCHANGED", "failed"],
		["success", "completed", "INTERNAL_RESULT_COMPLETED", "failed"],
		["failed", "completed", "INTERNAL_RESULT_COMPLETED", "failed"],
		["failed", "unknown", "INTERNAL_RESULT_UNKNOWN", "failed"],
		["unknown", "unknown", "INTERNAL_RESULT_UNKNOWN", "unknown"],
	]
	test("every admitted case validates, keeps the transaction state and maps to the accepted cause", () => {
		for (const [domainOutcome, transactionState, cause, outcome] of ADMITTED) {
			for (const commandIdentity of EXPECTED_IDENTITIES) {
				for (const guidance of [{ kind: "next-action", target: "repair-lab inspect" }, { kind: "handoff", station: "repair-lab.required-handoff" }] as const) {
					const envelope = internalFailureEnvelope(facts({ commandIdentity, domainOutcome, transactionState, guidance, completedEffectIds: [], remainingEffectIds: [] }), ["issue"])
					expect(MachineEnvelopeSchema.safeParse(envelope).success).toBe(true)
					expect(envelope.causeCode as string).toBe(cause)
					expect(envelope.outcome as string).toBe(outcome)
					expect(envelope.transactionState).toBe(transactionState)
					expect(envelope.failureClass).toBe("internal")
					expect(envelope.retryable).toBe(false)
					expect(envelope.retryDelayMilliseconds).toBeNull()
					if (guidance.kind === "handoff") {
						expect(envelope.nextAction).toBeNull()
						expect(envelope.handoff?.reason).toBe("The fixture cannot prove whether the remaining effect committed.")
					} else if (transactionState === "unknown") expect(envelope.nextAction).toBe("repair-lab recover")
					else expect(envelope.nextAction).toBe("repair-lab inspect")
				}
			}
		}
	})
	test("every combination outside the accepted union is an invariant failure, never an envelope", () => {
		const outcomes: ExecutionFacts["domainOutcome"][] = ["success", "refused", "failed", "unknown"]
		const states: ExecutionFacts["transactionState"][] = ["unchanged", "completed", "unknown"]
		const admitted = new Set(ADMITTED.map(([outcome, state]) => `${outcome}/${state}`))
		let rejected = 0
		for (const domainOutcome of outcomes) {
			for (const transactionState of states) {
				if (admitted.has(`${domainOutcome}/${transactionState}`)) continue
				expect(() => narrowFallback(facts({ domainOutcome, transactionState }))).toThrow(EgressInvariantError)
				rejected += 1
			}
		}
		expect(rejected).toBe(5)
	})
	test("completed facts with a non-JSON candidate yield completed, never unchanged; refused facts stay refused", () => {
		const out: string[] = []
		const io = { stdout: (text: string) => out.push(text), stderr: () => {} }
		const cyclic: Record<string, unknown> = { ...valid() }
		cyclic.self = cyclic
		expect(emitMachine(cyclic, facts({}), io)).toBe(1)
		const envelope = JSON.parse(out[0] as string) as Record<string, unknown>
		expect(envelope.transactionState).toBe("completed")
		expect(envelope.causeCode).toBe("INTERNAL_RESULT_COMPLETED")
		expect((envelope.result as Record<string, unknown>).completed_effect_ids).toEqual(["effect.update-index", "effect.write-journal"])
		out.length = 0
		expect(emitMachine({ ...valid(), message: 5 }, facts({ domainOutcome: "refused", transactionState: "unchanged", completedEffectIds: [], remainingEffectIds: ["effect.update-index", "effect.write-journal"] }), io)).toBe(1)
		const refused = JSON.parse(out[0] as string) as Record<string, unknown>
		expect(refused.outcome).toBe("refused")
		expect(refused.causeCode).toBe("INTERNAL_PREPARATION")
		expect(refused.transactionState).toBe("unchanged")
	})
	test("a valid candidate is written once with the exit of its failure class", () => {
		const out: string[] = []
		const io = { stdout: (text: string) => out.push(text), stderr: () => {} }
		expect(emitMachine(valid(), facts({}), io)).toBe(0)
		expect(out).toHaveLength(1)
		expect(out[0]?.endsWith("\n")).toBe(true)
	})
})

describe("STATIONS enumeration", () => {
	test("declares exactly the ten identities and the 30 fallback rows (28 in the brief plus the two repair-identity unknown rows, F3)", () => {
		expect([...new Set(STATIONS.map((row) => row.commandIdentity as string))].sort()).toEqual([...EXPECTED_IDENTITIES].sort())
		const fallback = STATIONS.filter((row) => row.causeCode !== null && ["INTERNAL_PREPARATION", "INTERNAL_RESULT_UNCHANGED", "INTERNAL_RESULT_COMPLETED", "INTERNAL_RESULT_UNKNOWN"].includes(row.causeCode))
		expect(fallback).toHaveLength(30)
	})
})
