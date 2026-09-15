/**
 * The lifecycle oracle deliberately accepts observations captured by a process
 * harness. It does not invoke the target or derive expectations from its
 * contract, catalogue, exit helper, or lifecycle implementation.
 */

const LIFECYCLE_FINDINGS = {
	LARGE_OUTPUT_TOO_SMALL: "LIFECYCLE_LARGE_OUTPUT_TOO_SMALL",
	LARGE_OUTPUT_NOT_DRAINED: "LIFECYCLE_LARGE_OUTPUT_NOT_DRAINED",
	LARGE_OUTPUT_EXIT: "LIFECYCLE_LARGE_OUTPUT_EXIT",
	LARGE_OUTPUT_STDERR: "LIFECYCLE_LARGE_OUTPUT_STDERR",
	EPIPE_BEFORE_DRAIN: "LIFECYCLE_EPIPE_BEFORE_DRAIN",
	EPIPE_BEFORE_EXIT: "LIFECYCLE_EPIPE_BEFORE_EXIT",
	EPIPE_BEFORE_STDERR: "LIFECYCLE_EPIPE_BEFORE_STDERR",
	EPIPE_REPLACEMENT_ENVELOPE: "LIFECYCLE_EPIPE_REPLACEMENT_ENVELOPE",
	EPIPE_AFTER_DRAIN: "LIFECYCLE_EPIPE_AFTER_DRAIN",
	EPIPE_AFTER_EXIT: "LIFECYCLE_EPIPE_AFTER_EXIT",
	EPIPE_AFTER_STDERR: "LIFECYCLE_EPIPE_AFTER_STDERR",
	EPIPE_AFTER_ENVELOPE: "LIFECYCLE_EPIPE_AFTER_ENVELOPE",
	STDIN_PROMPTED_OR_BLOCKED: "LIFECYCLE_STDIN_PROMPTED_OR_BLOCKED",
	STDIN_READ: "LIFECYCLE_STDIN_READ",
	STDIN_EXIT: "LIFECYCLE_STDIN_EXIT",
	STDIN_STDERR: "LIFECYCLE_STDIN_STDERR",
	STDIN_STATE: "LIFECYCLE_STDIN_STATE",
	DEADLINE_DISPATCH: "LIFECYCLE_DEADLINE_DISPATCH",
	DEADLINE_EXIT: "LIFECYCLE_DEADLINE_EXIT",
	DEADLINE_RESULT: "LIFECYCLE_DEADLINE_RESULT",
	DEADLINE_CAUSE: "LIFECYCLE_DEADLINE_CAUSE",
	DEADLINE_STATE: "LIFECYCLE_DEADLINE_STATE",
	DEADLINE_RETRY: "LIFECYCLE_DEADLINE_RETRY",
	SIGNAL_EXIT: "LIFECYCLE_SIGNAL_EXIT",
	SIGNAL_PRE_OUTPUT: "LIFECYCLE_SIGNAL_PRE_OUTPUT",
	SIGNAL_DRAIN_ENVELOPE: "LIFECYCLE_SIGNAL_DRAIN_ENVELOPE",
	SIGNAL_AFTER_DRAIN: "LIFECYCLE_SIGNAL_AFTER_DRAIN",
	REPEATED_SIGNAL_NOT_IMMEDIATE: "LIFECYCLE_REPEATED_SIGNAL_NOT_IMMEDIATE",
	CRASH_EXIT: "LIFECYCLE_CRASH_EXIT",
	CRASH_OUTPUT: "LIFECYCLE_CRASH_OUTPUT",
	CRASH_STDERR: "LIFECYCLE_CRASH_STDERR",
	CRASH_EMERGENCY_ATTEMPTS: "LIFECYCLE_CRASH_EMERGENCY_ATTEMPTS",
	HOSTILE_SECRET_LEAK: "LIFECYCLE_HOSTILE_SECRET_LEAK",
	HOSTILE_DIAGNOSTICS_ESCAPE: "LIFECYCLE_HOSTILE_DIAGNOSTICS_ESCAPE",
	HOSTILE_DOMAIN_CORRUPTION: "LIFECYCLE_HOSTILE_DOMAIN_CORRUPTION",
} as const

export type LifecycleFinding = (typeof LIFECYCLE_FINDINGS)[keyof typeof LIFECYCLE_FINDINGS]
export type EffectState = "unchanged" | "completed" | "partially-completed" | "unknown"

export interface OutputObservation {
	stdout: string
	stderr: string
	envelopeCount: number
	drainConfirmed: boolean
}

export interface LargeOutputObservation extends OutputObservation {
	claim: "large-output-drain"
	slowConsumer: boolean
	exitCode: number
}

export interface EpipeBeforeDrainObservation extends OutputObservation {
	claim: "epipe-before-drain"
	epipeObserved: boolean
	exitCode: number
}

export interface EpipeAfterDrainObservation extends OutputObservation {
	claim: "epipe-after-drain"
	epipeObserved: boolean
	expectedExitCode: number
	exitCode: number
}

export interface StdinObservation extends OutputObservation {
	claim: "stdin-neutral"
	disposition: "closed" | "held-open"
	stdinReadCount: number
	prompted: boolean
	blocked: boolean
	expectedExitCode: number
	exitCode: number
	domainStateUnchanged: boolean
}

export interface DeadlineObservation extends OutputObservation {
	claim: "deadline"
	phase: "before-dispatch" | "after-dispatch"
	observedEffectState: EffectState
	reportedEffectState: EffectState
	exitCode: number
	outcome: "refused" | "failed"
	causeCode: string
	retryable: boolean
	dispatchStarted: boolean
}

export interface SignalObservation extends OutputObservation {
	claim: "signal"
	signal: "SIGINT" | "SIGTERM"
	phase: "before-output" | "during-drain" | "after-drain"
	terminationCount: 1 | 2
	exitCode: number
	immediateTermination: boolean
}

export interface CrashObservation extends OutputObservation {
	claim: "crash"
	kind: "uncaught-exception" | "unhandled-rejection"
	exitCode: number
	emergencyAttempts: number
}

export interface HostileInputObservation {
	claim: "hostile-input"
	kind: "diagnostics-path" | "concurrent-pruning" | "hostile-string" | "hostile-path" | "hostile-json"
	secretLeaked: boolean
	diagnosticsContained: boolean
	domainStateIntact: boolean
}

export type LifecycleObservation = LargeOutputObservation | EpipeBeforeDrainObservation | EpipeAfterDrainObservation | StdinObservation | DeadlineObservation | SignalObservation | CrashObservation | HostileInputObservation

const MEBIBYTE = 1024 * 1024

function firstFinding(checks: ReadonlyArray<readonly [boolean, LifecycleFinding]>): LifecycleFinding[] {
	const failed = checks.find(([holds]) => !holds)
	return failed === undefined ? [] : [failed[1]]
}

function largeOutputFindings(observation: LargeOutputObservation): LifecycleFinding[] {
	return firstFinding([
		[observation.slowConsumer && Buffer.byteLength(observation.stdout, "utf8") >= MEBIBYTE, LIFECYCLE_FINDINGS.LARGE_OUTPUT_TOO_SMALL],
		[observation.drainConfirmed && observation.envelopeCount === 1, LIFECYCLE_FINDINGS.LARGE_OUTPUT_NOT_DRAINED],
		[observation.exitCode === 0, LIFECYCLE_FINDINGS.LARGE_OUTPUT_EXIT],
		[observation.stderr === "", LIFECYCLE_FINDINGS.LARGE_OUTPUT_STDERR],
	])
}

function epipeBeforeFindings(observation: EpipeBeforeDrainObservation): LifecycleFinding[] {
	return firstFinding([
		[observation.epipeObserved && !observation.drainConfirmed, LIFECYCLE_FINDINGS.EPIPE_BEFORE_DRAIN],
		[observation.exitCode === 1, LIFECYCLE_FINDINGS.EPIPE_BEFORE_EXIT],
		[observation.stderr === "", LIFECYCLE_FINDINGS.EPIPE_BEFORE_STDERR],
		[observation.envelopeCount <= 1, LIFECYCLE_FINDINGS.EPIPE_REPLACEMENT_ENVELOPE],
	])
}

function epipeAfterFindings(observation: EpipeAfterDrainObservation): LifecycleFinding[] {
	return firstFinding([
		[observation.epipeObserved && observation.drainConfirmed, LIFECYCLE_FINDINGS.EPIPE_AFTER_DRAIN],
		[observation.exitCode === observation.expectedExitCode, LIFECYCLE_FINDINGS.EPIPE_AFTER_EXIT],
		[observation.stderr === "", LIFECYCLE_FINDINGS.EPIPE_AFTER_STDERR],
		[observation.envelopeCount === 1, LIFECYCLE_FINDINGS.EPIPE_AFTER_ENVELOPE],
	])
}

function stdinFindings(observation: StdinObservation): LifecycleFinding[] {
	return firstFinding([
		[!observation.prompted && !observation.blocked, LIFECYCLE_FINDINGS.STDIN_PROMPTED_OR_BLOCKED],
		[observation.stdinReadCount === 0, LIFECYCLE_FINDINGS.STDIN_READ],
		[observation.exitCode === observation.expectedExitCode && observation.envelopeCount === 1, LIFECYCLE_FINDINGS.STDIN_EXIT],
		[observation.stderr === "", LIFECYCLE_FINDINGS.STDIN_STDERR],
		[observation.domainStateUnchanged, LIFECYCLE_FINDINGS.STDIN_STATE],
	])
}

function deadlineCause(phase: DeadlineObservation["phase"], state: EffectState): string {
	if (phase === "before-dispatch") return "DOMAIN_DEADLINE_BEFORE_START"
	if (state === "unchanged") return "DOMAIN_DEADLINE_UNCHANGED"
	if (state === "completed") return "DOMAIN_DEADLINE_COMPLETED"
	if (state === "partially-completed") return "DOMAIN_DEADLINE_PARTIAL"
	return "DOMAIN_DEADLINE_UNKNOWN"
}

function deadlineFindings(observation: DeadlineObservation): LifecycleFinding[] {
	const expectedOutcome = observation.phase === "before-dispatch" ? "refused" : "failed"
	const expectedState = observation.phase === "before-dispatch" ? "unchanged" : observation.observedEffectState
	return firstFinding([
		[observation.dispatchStarted === (observation.phase === "after-dispatch"), LIFECYCLE_FINDINGS.DEADLINE_DISPATCH],
		[observation.exitCode === 3 && observation.envelopeCount === 1 && observation.stderr === "", LIFECYCLE_FINDINGS.DEADLINE_EXIT],
		[observation.outcome === expectedOutcome, LIFECYCLE_FINDINGS.DEADLINE_RESULT],
		[observation.causeCode === deadlineCause(observation.phase, expectedState), LIFECYCLE_FINDINGS.DEADLINE_CAUSE],
		[observation.reportedEffectState === expectedState, LIFECYCLE_FINDINGS.DEADLINE_STATE],
		[!observation.retryable, LIFECYCLE_FINDINGS.DEADLINE_RETRY],
	])
}

function signalFindings(observation: SignalObservation): LifecycleFinding[] {
	const expectedExit = observation.signal === "SIGINT" ? 130 : 143
	const phaseChecks: ReadonlyArray<readonly [boolean, LifecycleFinding]> = observation.phase === "before-output"
		? [[observation.envelopeCount === 0 && observation.stdout === "", LIFECYCLE_FINDINGS.SIGNAL_PRE_OUTPUT]]
		: observation.phase === "during-drain"
			? [[observation.envelopeCount <= 1, LIFECYCLE_FINDINGS.SIGNAL_DRAIN_ENVELOPE]]
			: [[observation.drainConfirmed && observation.envelopeCount === 1, LIFECYCLE_FINDINGS.SIGNAL_AFTER_DRAIN]]
	return firstFinding([
		[observation.exitCode === expectedExit, LIFECYCLE_FINDINGS.SIGNAL_EXIT],
		...phaseChecks,
		[observation.terminationCount === 1 || observation.immediateTermination, LIFECYCLE_FINDINGS.REPEATED_SIGNAL_NOT_IMMEDIATE],
	])
}

function crashFindings(observation: CrashObservation): LifecycleFinding[] {
	return firstFinding([
		[observation.exitCode === 1, LIFECYCLE_FINDINGS.CRASH_EXIT],
		[observation.stdout === "" && observation.envelopeCount === 0, LIFECYCLE_FINDINGS.CRASH_OUTPUT],
		[observation.stderr === "", LIFECYCLE_FINDINGS.CRASH_STDERR],
		[observation.emergencyAttempts === 1, LIFECYCLE_FINDINGS.CRASH_EMERGENCY_ATTEMPTS],
	])
}

function hostileInputFindings(observation: HostileInputObservation): LifecycleFinding[] {
	return firstFinding([
		[!observation.secretLeaked, LIFECYCLE_FINDINGS.HOSTILE_SECRET_LEAK],
		[observation.diagnosticsContained, LIFECYCLE_FINDINGS.HOSTILE_DIAGNOSTICS_ESCAPE],
		[observation.domainStateIntact, LIFECYCLE_FINDINGS.HOSTILE_DOMAIN_CORRUPTION],
	])
}

/** Returns the first literal lifecycle violation for one process receipt row. */
export function analyzeLifecycleObservation(observation: LifecycleObservation): LifecycleFinding[] {
	switch (observation.claim) {
		case "large-output-drain": return largeOutputFindings(observation)
		case "epipe-before-drain": return epipeBeforeFindings(observation)
		case "epipe-after-drain": return epipeAfterFindings(observation)
		case "stdin-neutral": return stdinFindings(observation)
		case "deadline": return deadlineFindings(observation)
		case "signal": return signalFindings(observation)
		case "crash": return crashFindings(observation)
		case "hostile-input": return hostileInputFindings(observation)
	}
}
