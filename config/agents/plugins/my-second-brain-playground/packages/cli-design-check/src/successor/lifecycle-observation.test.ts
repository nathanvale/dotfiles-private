import { expect, test } from "bun:test"
import { analyzeLifecycleObservation, type LifecycleFinding, type LifecycleObservation } from "./lifecycle-observation.ts"

const MEBIBYTE = 1024 * 1024
const LARGE_STDOUT = "x".repeat(MEBIBYTE)

// These rows are a test-owned process-receipt oracle. They intentionally do
// not import target contracts, result tables, lifecycle code, or finding values.
const CONFORMANT_ROWS: readonly LifecycleObservation[] = [
	{ claim: "large-output-drain", stdout: LARGE_STDOUT, stderr: "", envelopeCount: 1, drainConfirmed: true, slowConsumer: true, exitCode: 0 },
	{ claim: "epipe-before-drain", stdout: "{\"partial\":true}", stderr: "", envelopeCount: 1, drainConfirmed: false, epipeObserved: true, exitCode: 1 },
	{ claim: "epipe-after-drain", stdout: "{\"complete\":true}\n", stderr: "", envelopeCount: 1, drainConfirmed: true, epipeObserved: true, expectedExitCode: 0, exitCode: 0 },
	{ claim: "stdin-neutral", stdout: "{\"result\":\"ok\"}\n", stderr: "", envelopeCount: 1, drainConfirmed: true, disposition: "closed", stdinReadCount: 0, prompted: false, blocked: false, expectedExitCode: 0, exitCode: 0, domainStateUnchanged: true },
	{ claim: "stdin-neutral", stdout: "{\"result\":\"ok\"}\n", stderr: "", envelopeCount: 1, drainConfirmed: true, disposition: "held-open", stdinReadCount: 0, prompted: false, blocked: false, expectedExitCode: 0, exitCode: 0, domainStateUnchanged: true },
	{ claim: "deadline", stdout: "{\"result\":\"deadline\"}\n", stderr: "", envelopeCount: 1, drainConfirmed: true, phase: "before-dispatch", observedEffectState: "unchanged", reportedEffectState: "unchanged", exitCode: 3, outcome: "refused", causeCode: "DOMAIN_DEADLINE_BEFORE_START", retryable: false, dispatchStarted: false },
	{ claim: "deadline", stdout: "{\"result\":\"deadline\"}\n", stderr: "", envelopeCount: 1, drainConfirmed: true, phase: "after-dispatch", observedEffectState: "unchanged", reportedEffectState: "unchanged", exitCode: 3, outcome: "failed", causeCode: "DOMAIN_DEADLINE_UNCHANGED", retryable: false, dispatchStarted: true },
	{ claim: "deadline", stdout: "{\"result\":\"deadline\"}\n", stderr: "", envelopeCount: 1, drainConfirmed: true, phase: "after-dispatch", observedEffectState: "completed", reportedEffectState: "completed", exitCode: 3, outcome: "failed", causeCode: "DOMAIN_DEADLINE_COMPLETED", retryable: false, dispatchStarted: true },
	{ claim: "deadline", stdout: "{\"result\":\"deadline\"}\n", stderr: "", envelopeCount: 1, drainConfirmed: true, phase: "after-dispatch", observedEffectState: "partially-completed", reportedEffectState: "partially-completed", exitCode: 3, outcome: "failed", causeCode: "DOMAIN_DEADLINE_PARTIAL", retryable: false, dispatchStarted: true },
	{ claim: "deadline", stdout: "{\"result\":\"deadline\"}\n", stderr: "", envelopeCount: 1, drainConfirmed: true, phase: "after-dispatch", observedEffectState: "unknown", reportedEffectState: "unknown", exitCode: 3, outcome: "failed", causeCode: "DOMAIN_DEADLINE_UNKNOWN", retryable: false, dispatchStarted: true },
	{ claim: "signal", stdout: "", stderr: "", envelopeCount: 0, drainConfirmed: false, signal: "SIGINT", phase: "before-output", terminationCount: 1, exitCode: 130, immediateTermination: false },
	{ claim: "signal", stdout: "{\"partial\":true}", stderr: "", envelopeCount: 1, drainConfirmed: false, signal: "SIGTERM", phase: "during-drain", terminationCount: 1, exitCode: 143, immediateTermination: false },
	{ claim: "signal", stdout: "{\"complete\":true}\n", stderr: "", envelopeCount: 1, drainConfirmed: true, signal: "SIGINT", phase: "after-drain", terminationCount: 2, exitCode: 130, immediateTermination: true },
	{ claim: "crash", stdout: "", stderr: "", envelopeCount: 0, drainConfirmed: false, kind: "uncaught-exception", exitCode: 1, emergencyAttempts: 1 },
	{ claim: "crash", stdout: "", stderr: "", envelopeCount: 0, drainConfirmed: false, kind: "unhandled-rejection", exitCode: 1, emergencyAttempts: 1 },
	{ claim: "hostile-input", kind: "diagnostics-path", secretLeaked: false, diagnosticsContained: true, domainStateIntact: true },
	{ claim: "hostile-input", kind: "concurrent-pruning", secretLeaked: false, diagnosticsContained: true, domainStateIntact: true },
	{ claim: "hostile-input", kind: "hostile-string", secretLeaked: false, diagnosticsContained: true, domainStateIntact: true },
	{ claim: "hostile-input", kind: "hostile-path", secretLeaked: false, diagnosticsContained: true, domainStateIntact: true },
	{ claim: "hostile-input", kind: "hostile-json", secretLeaked: false, diagnosticsContained: true, domainStateIntact: true },
]

test("O3 restored literal process rows pass", () => {
	for (const row of CONFORMANT_ROWS) expect(analyzeLifecycleObservation(row)).toEqual([])
})

const SENSITIVE_CONTROLS: ReadonlyArray<{ name: string; row: LifecycleObservation; expectedFinding: LifecycleFinding }> = [
	{ name: "large drain", row: { ...CONFORMANT_ROWS[0], drainConfirmed: false } as LifecycleObservation, expectedFinding: "LIFECYCLE_LARGE_OUTPUT_NOT_DRAINED" },
	{ name: "pre-drain EPIPE", row: { ...CONFORMANT_ROWS[1], exitCode: 0 } as LifecycleObservation, expectedFinding: "LIFECYCLE_EPIPE_BEFORE_EXIT" },
	{ name: "post-drain EPIPE", row: { ...CONFORMANT_ROWS[2], envelopeCount: 2 } as LifecycleObservation, expectedFinding: "LIFECYCLE_EPIPE_AFTER_ENVELOPE" },
	{ name: "closed stdin", row: { ...CONFORMANT_ROWS[3], blocked: true } as LifecycleObservation, expectedFinding: "LIFECYCLE_STDIN_PROMPTED_OR_BLOCKED" },
	{ name: "held-open stdin", row: { ...CONFORMANT_ROWS[4], stdinReadCount: 1 } as LifecycleObservation, expectedFinding: "LIFECYCLE_STDIN_READ" },
	{ name: "deadline before dispatch", row: { ...CONFORMANT_ROWS[5], dispatchStarted: true } as LifecycleObservation, expectedFinding: "LIFECYCLE_DEADLINE_DISPATCH" },
	{ name: "deadline unchanged", row: { ...CONFORMANT_ROWS[6], causeCode: "DOMAIN_DEADLINE_UNKNOWN" } as LifecycleObservation, expectedFinding: "LIFECYCLE_DEADLINE_CAUSE" },
	{ name: "deadline completed", row: { ...CONFORMANT_ROWS[7], retryable: true } as LifecycleObservation, expectedFinding: "LIFECYCLE_DEADLINE_RETRY" },
	{ name: "deadline partial", row: { ...CONFORMANT_ROWS[8], outcome: "refused" } as LifecycleObservation, expectedFinding: "LIFECYCLE_DEADLINE_RESULT" },
	{ name: "deadline unknown", row: { ...CONFORMANT_ROWS[9], exitCode: 1 } as LifecycleObservation, expectedFinding: "LIFECYCLE_DEADLINE_EXIT" },
	{ name: "deadline reported state", row: { ...CONFORMANT_ROWS[9], reportedEffectState: "unchanged" } as LifecycleObservation, expectedFinding: "LIFECYCLE_DEADLINE_STATE" },
	{ name: "SIGINT before output", row: { ...CONFORMANT_ROWS[10], stdout: "unexpected" } as LifecycleObservation, expectedFinding: "LIFECYCLE_SIGNAL_PRE_OUTPUT" },
	{ name: "SIGTERM during drain", row: { ...CONFORMANT_ROWS[11], envelopeCount: 2 } as LifecycleObservation, expectedFinding: "LIFECYCLE_SIGNAL_DRAIN_ENVELOPE" },
	{ name: "signal after drain", row: { ...CONFORMANT_ROWS[12], drainConfirmed: false } as LifecycleObservation, expectedFinding: "LIFECYCLE_SIGNAL_AFTER_DRAIN" },
	{ name: "repeated termination", row: { ...CONFORMANT_ROWS[12], immediateTermination: false } as LifecycleObservation, expectedFinding: "LIFECYCLE_REPEATED_SIGNAL_NOT_IMMEDIATE" },
	{ name: "uncaught exception", row: { ...CONFORMANT_ROWS[13], emergencyAttempts: 0 } as LifecycleObservation, expectedFinding: "LIFECYCLE_CRASH_EMERGENCY_ATTEMPTS" },
	{ name: "unhandled rejection", row: { ...CONFORMANT_ROWS[14], stderr: "stack" } as LifecycleObservation, expectedFinding: "LIFECYCLE_CRASH_STDERR" },
	{ name: "hostile diagnostics path", row: { ...CONFORMANT_ROWS[15], diagnosticsContained: false } as LifecycleObservation, expectedFinding: "LIFECYCLE_HOSTILE_DIAGNOSTICS_ESCAPE" },
	{ name: "concurrent pruning", row: { ...CONFORMANT_ROWS[16], domainStateIntact: false } as LifecycleObservation, expectedFinding: "LIFECYCLE_HOSTILE_DOMAIN_CORRUPTION" },
	{ name: "hostile string", row: { ...CONFORMANT_ROWS[17], secretLeaked: true } as LifecycleObservation, expectedFinding: "LIFECYCLE_HOSTILE_SECRET_LEAK" },
	{ name: "hostile path", row: { ...CONFORMANT_ROWS[18], diagnosticsContained: false } as LifecycleObservation, expectedFinding: "LIFECYCLE_HOSTILE_DIAGNOSTICS_ESCAPE" },
	{ name: "hostile JSON", row: { ...CONFORMANT_ROWS[19], domainStateIntact: false } as LifecycleObservation, expectedFinding: "LIFECYCLE_HOSTILE_DOMAIN_CORRUPTION" },
]

test.each([...SENSITIVE_CONTROLS])("O3 sensitivity: $name has one literal finding", ({ row, expectedFinding }) => {
	expect(analyzeLifecycleObservation(row)).toEqual([expectedFinding])
})
