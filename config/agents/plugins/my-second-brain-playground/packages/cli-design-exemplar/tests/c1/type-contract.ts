import { EXIT, mintAuthorization, parseResourceId, type ContractResult, type Effects, type Handoff, type JsonValue, type WireResult } from "../../src/command-contract.ts"
import type { Request } from "../../src/engine.ts"

const id = parseResourceId("resource-1")
const authorization = mintAuthorization("fixture-authority")
if (id === null || authorization === null) throw new Error("positive parser specimen failed")
const json: JsonValue = { id, values: [1, null] }
const settled: ContractResult = { runId: "run", commandIdentity: "repair-lab.status", outcome: "success", effectClass: "inspect", transactionState: "unchanged", causeCode: "SUCCESS_UNCHANGED", failureClass: null, exitCode: 0, data: json, retryable: false, repairAction: null, effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true }, nextAction: "repair-lab inspect" }
const nullSuccess: ContractResult = { ...settled, data: null }
const partial: ContractResult = { runId: "run", commandIdentity: "repair-lab.apply", outcome: "failed", effectClass: "repository-local", transactionState: "partially-completed", causeCode: "INTERNAL_RESULT_PARTIAL", failureClass: "internal", exitCode: 1, data: null, retryable: false, repairAction: "inspect", effects: { completed: ["effect.one"], remaining: ["effect.two"], uncertain: [], inventoryComplete: true }, handoff: { owner: "operator", reason: "partial", inspect: ["repair-lab inspect"] } }
const settledFailure: ContractResult = { runId: "run", commandIdentity: "repair-lab.apply", outcome: "failed", effectClass: "repository-local", transactionState: "unchanged", causeCode: "INTERNAL_RESULT_UNCHANGED", failureClass: "internal", exitCode: 1, data: null, retryable: false, repairAction: "inspect", effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true }, handoff: { owner: "operator", reason: "failed", inspect: ["repair-lab inspect"] } }
const transient: ContractResult = { runId: "run", commandIdentity: "repair-lab.apply", outcome: "failed", effectClass: "repository-local", transactionState: "unchanged", causeCode: "TRANSIENT_ATTEMPT_UNCHANGED", failureClass: "transient", exitCode: 75, data: null, retryable: true, retryDelayMilliseconds: 25, repairAction: "wait", effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true }, nextAction: "retry" }
const handoff: Handoff = { owner: "operator", reason: "inspect", inspect: ["repair-lab inspect"] }
const effects: Effects = { completed: [], remaining: [], uncertain: [], inventoryComplete: true }
const allowedExit: ReturnType<typeof import("../../src/command-contract.ts").exitFor> = 75
const wireFromContract: WireResult = settled
const parsedRequest: Request = { route: "apply", statePath: id, previewId: id, authority: authorization, automation: false, includeDiagnostics: false }
void [id, authorization, settled, nullSuccess, partial, settledFailure, transient, handoff, effects, allowedExit, wireFromContract, parsedRequest]

// @ts-expect-error N1 unknown effects cannot be retryable
const n1: ContractResult = { runId: "run", commandIdentity: "repair-lab.apply", outcome: "failed", effectClass: "repository-local", transactionState: "unknown", causeCode: "INTERNAL_RESULT_UNKNOWN", failureClass: "internal", exitCode: 1, data: null, retryable: true, retryDelayMilliseconds: 25, repairAction: "inspect", effects: { completed: [], remaining: [], uncertain: ["effect.one"], inventoryComplete: true }, handoff }
// @ts-expect-error N2 cause cannot be paired with another failure class
const n2: ContractResult = { runId: "run", commandIdentity: "repair-lab.apply", outcome: "failed", effectClass: "repository-local", transactionState: "unchanged", causeCode: "DOMAIN_DEADLINE_UNCHANGED", failureClass: "internal", exitCode: 3, data: null, retryable: false, repairAction: "inspect", effects, nextAction: "repair-lab inspect" }
// @ts-expect-error N3 recovery has one guidance arm
const n3: ContractResult = { runId: "run", commandIdentity: "repair-lab.apply", outcome: "failed", effectClass: "repository-local", transactionState: "unchanged", causeCode: "INTERNAL_RESULT_UNCHANGED", failureClass: "internal", exitCode: 1, data: null, retryable: false, repairAction: "inspect", effects, nextAction: "retry", handoff }
// @ts-expect-error N4 partial completion requires a handoff
const n4: ContractResult = { runId: "run", commandIdentity: "repair-lab.apply", outcome: "failed", effectClass: "repository-local", transactionState: "partially-completed", causeCode: "INTERNAL_RESULT_PARTIAL", failureClass: "internal", exitCode: 1, data: null, retryable: false, repairAction: "inspect", effects: { completed: ["effect.one"], remaining: ["effect.two"], uncertain: [], inventoryComplete: true }, nextAction: "retry" }
// @ts-expect-error N5 success cannot have unknown transaction state
const n5: ContractResult = { runId: "run", commandIdentity: "repair-lab.status", outcome: "success", effectClass: "repository-local", transactionState: "unknown", causeCode: "SUCCESS_UNCHANGED", failureClass: null, exitCode: 0, data: json, retryable: false, repairAction: null, effects: { completed: [], remaining: [], uncertain: ["effect.one"], inventoryComplete: true }, nextAction: "repair-lab inspect" }
// @ts-expect-error N6 exact optional properties omit undefined
const n6: Handoff = { owner: "operator", reason: "inspect", inspect: ["repair-lab inspect"], resource: undefined }
// @ts-expect-error N7 ResourceId is not Authorization
const n7: Request = { route: "apply", statePath: id, previewId: id, authority: id, automation: false, includeDiagnostics: false }
// @ts-expect-error N8 raw strings are not parser brands
const n8: Request = { route: "inspect", statePath: "raw", previewId: id, authority: authorization, automation: false, includeDiagnostics: false }
// @ts-expect-error N9 closed exits exclude 5
const n9: ReturnType<typeof import("../../src/command-contract.ts").exitFor> = 5
// @ts-expect-error N10 EXIT is readonly
EXIT.success = 5
// @ts-expect-error M1 retryable recovery needs a delay
const m1: ContractResult = { runId: "run", commandIdentity: "repair-lab.apply", outcome: "failed", effectClass: "repository-local", transactionState: "unchanged", causeCode: "TRANSIENT_ATTEMPT_UNCHANGED", failureClass: "transient", exitCode: 75, data: null, retryable: true, repairAction: "wait", effects, nextAction: "retry" }
// @ts-expect-error M2 partial completion needs effect identifiers
const m2: ContractResult = { runId: "run", commandIdentity: "repair-lab.apply", outcome: "failed", effectClass: "repository-local", transactionState: "partially-completed", causeCode: "INTERNAL_RESULT_PARTIAL", failureClass: "internal", exitCode: 1, data: null, retryable: false, repairAction: "inspect", effects, handoff }
// @ts-expect-error M3 inspect does not admit unresolved recovery
const m3: ContractResult = { runId: "run", commandIdentity: "repair-lab.inspect", outcome: "failed", effectClass: "inspect", transactionState: "unknown", causeCode: "INTERNAL_RESULT_UNKNOWN", failureClass: "internal", exitCode: 1, data: null, retryable: false, repairAction: "inspect", effects: { completed: [], remaining: [], uncertain: ["effect.one"], inventoryComplete: true }, handoff }
// @ts-expect-error R1 refusal cannot claim unknown transaction state
const r1: ContractResult = { runId: "run", commandIdentity: "repair-lab.apply", outcome: "refused", effectClass: "repository-local", transactionState: "unknown", causeCode: "DOMAIN_PRECONDITION_UNMET", failureClass: "domain", exitCode: 3, data: null, retryable: false, repairAction: "inspect", effects: { completed: [], remaining: [], uncertain: ["effect.one"], inventoryComplete: true }, nextAction: "repair-lab inspect" }
// @ts-expect-error R2 Date is not JsonValue
const r2: JsonValue = new Date()
// @ts-expect-error R3 undefined is not JsonValue
const r3: JsonValue = { absent: undefined }
// @ts-expect-error R4 refusal cannot claim completed transaction state
const r4: ContractResult = { runId: "run", commandIdentity: "repair-lab.apply", outcome: "refused", effectClass: "repository-local", transactionState: "completed", causeCode: "DOMAIN_PRECONDITION_UNMET", failureClass: "domain", exitCode: 3, data: null, retryable: false, repairAction: "inspect", effects: { completed: ["effect.one"], remaining: [], uncertain: [], inventoryComplete: true }, nextAction: "repair-lab inspect" }
declare const wire: WireResult
// @ts-expect-error arbitrary wire values do not widen into a correlated domain result
const reverse: ContractResult = wire
void [n1, n2, n3, n4, n5, n6, n7, n8, n9, m1, m2, m3, r1, r2, r3, r4, reverse]
