#!/usr/bin/env bun
import { randomUUID } from "node:crypto"
import { closeSync } from "node:fs"
import { join, resolve } from "node:path"
import { createInvocationTraceStore, type InvocationTraceStore } from "./invocation-trace-store.ts"
import {
	type DiagnosticTraceRecord,
	isRecoveryIdentity,
	MAX_SERIALIZED_RECORD_BYTES,
	type RecoveryOperation,
} from "./serialized-values.ts"

type InvocationKind = "hook" | "checkpoint"
type TerminalOutcome = "signalled" | "deadline-exceeded"

const MAX_OBSERVER_DEADLINE_MS = 60_000
const CHILD_REAP_GRACE_MS = 250

function identity(prefix: string): string {
	return `${prefix}-${randomUUID()}`
}

function optionalIdentity(value: string | undefined): string | undefined {
	return isRecoveryIdentity(value) ? value : undefined
}

function monotonicMilliseconds(start: bigint): number {
	return Number(process.hrtime.bigint() - start) / 1_000_000
}

function observerDeadlineMilliseconds(value: string | undefined): number | null {
	if (value === undefined || !/^[1-9][0-9]*$/.test(value)) return null
	const parsed = Number(value)
	return Number.isSafeInteger(parsed) && parsed <= MAX_OBSERVER_DEADLINE_MS ? parsed : null
}

function observerRoot(): string {
	const sourceRoot = resolve(import.meta.dir, "../../..")
	return join(sourceRoot, "packages/recovery-observability/src") === import.meta.dir
		? sourceRoot
		: resolve(import.meta.dir, "..")
}

function observerOperation(kind: InvocationKind, arguments_: readonly string[]): RecoveryOperation {
	if (kind === "hook") return "hook"
	const command = arguments_[1]
	if (command === undefined || command === "--help" || command === "-h") return "help"
	if (command === "bind" || command === "recover" || command === "write" || command === "schema") return command
	return "usage"
}

function childOutcome(exitCode: number | null, signalCode: string | null): "succeeded" | "failed" | "signalled" {
	if (signalCode !== null) return "signalled"
	return exitCode === 0 ? "succeeded" : "failed"
}

function retainObserverFailureDiagnostic(store: InvocationTraceStore): void {
	try {
		const record: DiagnosticTraceRecord = {
			schema_version: 1,
			record_type: "diagnostic",
			category: "my-second-brain-playground/recovery",
			level: "error",
			event: "observer-failure",
			occurred_at: new Date().toISOString(),
			properties: {},
		}
		store.writeDiagnostic(`${JSON.stringify(record)}\n`)
	} catch {
		// Failure diagnostics remain best effort and cannot replace the primary result.
	}
}

function scheduleCleanup(journeyIdentity: string, parentRecordIdentity: string): void {
	try {
		const root = observerRoot()
		const cleanupCommand = import.meta.dir === join(root, "packages/recovery-observability/src")
			? join(import.meta.dir, "trace-command.ts")
			: join(root, "runtime/recovery-traces.js")
		const cleanup = Bun.spawn([process.execPath, cleanupCommand, "cleanup"], {
			cwd: process.cwd(),
			env: { ...process.env, MSB_RECOVERY_CLEANUP_JOURNEY: journeyIdentity, MSB_RECOVERY_CLEANUP_PARENT: parentRecordIdentity },
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			detached: true,
		})
		cleanup.unref()
	} catch {
		// Retention is maintenance only and cannot retain the primary response descriptor.
	}
}

async function forward(stream: ReadableStream<Uint8Array>, output: { write(value: Uint8Array): unknown }, onFirstWrite: () => void): Promise<void> {
	for await (const chunk of stream) {
		onFirstWrite()
		try {
			output.write(chunk)
		} catch {
			// A consumer that closes its response pipe has already made the primary result unavailable.
		}
	}
}

interface LifecycleFrameState {
	pending: Uint8Array
	pendingBytes: number
	discarding: boolean
}

function consumeLifecycleSegment(
	state: LifecycleFrameState,
	segment: Uint8Array,
	terminated: boolean,
	decoder: TextDecoder,
	accept: (record: unknown) => unknown,
	reportFailure: () => void,
): void {
	if (!state.discarding) {
		if (state.pendingBytes + segment.length > MAX_SERIALIZED_RECORD_BYTES) {
			state.discarding = true
			state.pendingBytes = 0
			reportFailure()
		} else {
			state.pending.set(segment, state.pendingBytes)
			state.pendingBytes += segment.length
		}
	}
	if (!terminated || state.discarding) return
	try {
		accept(JSON.parse(decoder.decode(state.pending.subarray(0, state.pendingBytes))))
	} catch {
		reportFailure()
	}
}

function consumeLifecycleChunk(
	chunk: Uint8Array,
	state: LifecycleFrameState,
	decoder: TextDecoder,
	accept: (record: unknown) => unknown,
	reportFailure: () => void,
): void {
	let offset = 0
	while (offset < chunk.length) {
		const newline = chunk.indexOf(10, offset)
		const end = newline < 0 ? chunk.length : newline
		consumeLifecycleSegment(state, chunk.subarray(offset, end), newline >= 0, decoder, accept, reportFailure)
		if (newline < 0) return
		state.pendingBytes = 0
		// Only a delimiter ends a rejected frame, never a transport chunk boundary.
		state.discarding = false
		offset = newline + 1
	}
}

async function consumeLifecycle(fd: number, accept: (record: unknown) => unknown, reportFailure: () => void): Promise<void> {
	const decoder = new TextDecoder()
	const state: LifecycleFrameState = {
		pending: new Uint8Array(MAX_SERIALIZED_RECORD_BYTES),
		pendingBytes: 0,
		discarding: false,
	}
	try {
		for await (const chunk of Bun.file(fd).stream()) {
			consumeLifecycleChunk(chunk, state, decoder, accept, reportFailure)
		}
		if (state.pendingBytes > 0 || state.discarding) reportFailure()
	} catch {
		reportFailure()
	}
}

async function closePrimaryResponseDescriptors(): Promise<void> {
	await Promise.all([process.stdout, process.stderr].map((output) => new Promise<void>((done) => {
		const close = () => {
			try {
				closeSync(output.fd)
			} catch {
				// A caller may already have closed its response descriptor.
			}
			done()
		}
		try {
			output.end(close)
		} catch {
			close()
		}
	})))
}

export async function runRecoveryObserver(
	arguments_: readonly string[],
	dependencies: { readonly createTraceStore?: typeof createInvocationTraceStore } = {},
): Promise<number> {
	const kind = arguments_[0]
	if (kind !== "hook" && kind !== "checkpoint") return 2
	const invocationKind: InvocationKind = kind
	const operation = observerOperation(invocationKind, arguments_)
	const started = process.hrtime.bigint()
	const invocationIdentity = identity("recovery-invocation")
	let journeyIdentity = invocationIdentity
	const observerIdentity = identity("recovery-observer")
	const inheritedParentIdentity = invocationKind === "checkpoint" ? optionalIdentity(process.env.CODEX_SESSION_ID) : undefined
	const traceStore = (dependencies.createTraceStore ?? createInvocationTraceStore)({ invocationIdentity })
	let diagnosticReported = false
	const reportObserverFailure = () => {
		if (diagnosticReported) return
		diagnosticReported = true
		retainObserverFailureDiagnostic(traceStore)
	}
	let observerSequence = 0
	let responseObserved = false
	const acceptObserverRecord = (
		phase: "invocation" | "response-available" | "terminal",
		outcome: "started" | "succeeded" | "failed" | "signalled" | "deadline-exceeded",
		parentRecordIdentity?: string,
	): string => {
		const recordIdentity = `${observerIdentity}-${observerSequence}`
		try {
			const result = traceStore.accept({
				schema_version: 1,
				record_type: "lifecycle",
				record_identity: recordIdentity,
				journey_identity: journeyIdentity,
				invocation_identity: invocationIdentity,
				producer_identity: observerIdentity,
				producer_sequence: observerSequence++,
				...(parentRecordIdentity === undefined ? {} : { parent_record_identity: parentRecordIdentity }),
				...(inheritedParentIdentity === undefined ? {} : { inherited_parent_identity: inheritedParentIdentity }),
				harness_kind: "unknown",
				operation,
				phase,
				occurred_at: new Date().toISOString(),
				duration_ms: monotonicMilliseconds(started),
				outcome,
			})
			if (!result.accepted) reportObserverFailure()
		} catch {
			reportObserverFailure()
		}
		return recordIdentity
	}
	const invocationRecordIdentity = acceptObserverRecord("invocation", "started")

	// Explicit type arguments keep stdout/stderr typed as the "pipe" ReadableStream
	// this call actually requests; the bare ReturnType<typeof Bun.spawn> erases to
	// each parameter's full constraint instead of the literals passed below.
	let child: ReturnType<typeof Bun.spawn<Bun.SpawnOptions.Writable, "pipe", "pipe">>
	try {
		child = Bun.spawn(
			[
				"/usr/bin/python3",
				"-B",
				join(observerRoot(), "packages/compaction-recovery/src/recovery.py"),
				invocationKind,
				...arguments_.slice(1),
			],
			{
				cwd: process.cwd(),
				env: {
					...process.env,
					MSB_RECOVERY_OBSERVABILITY_FD: "3",
					MSB_RECOVERY_OBSERVATION_INVOCATION_IDENTITY: invocationIdentity,
					MSB_RECOVERY_OBSERVATION_JOURNEY_IDENTITY: journeyIdentity,
					MSB_RECOVERY_OBSERVATION_PARENT_RECORD_IDENTITY: invocationRecordIdentity,
				},
				// process.stdin is a Node ReadStream; Bun accepts it as a stdin source at
				// runtime even though its stdio[0] type declares only Bun-native shapes.
				stdio: [process.stdin as unknown as Bun.SpawnOptions.Writable, "pipe", "pipe", "pipe"],
			},
		)
	} catch {
		acceptObserverRecord("terminal", "failed", invocationRecordIdentity)
		reportObserverFailure()
		traceStore.dispose()
		return 2
	}

	let terminalOutcome: TerminalOutcome | undefined
	let reapTimer: ReturnType<typeof setTimeout> | undefined
	const stopChild = (signal: "SIGTERM" | "SIGINT", outcome?: TerminalOutcome) => {
		// The first terminal cause is retained: a deadline after an external signal, or a signal after the deadline,
		// never rewrites it.
		terminalOutcome ??= outcome
		try {
			process.stdin.destroy()
		} catch {
			// A signal or observer deadline may arrive after input is already closed.
		}
		try {
			child.kill(signal)
		} catch {
			// A child which already exited needs no further signal handling.
		}
		if (reapTimer === undefined) {
			reapTimer = setTimeout(() => {
				try {
					child.kill("SIGKILL")
				} catch {
					// The child may have exited during the bounded grace period.
				}
			}, CHILD_REAP_GRACE_MS)
			reapTimer.unref()
		}
	}
	const deadlineMilliseconds = observerDeadlineMilliseconds(process.env.MSB_RECOVERY_OBSERVER_DEADLINE_MS)
	const deadlineTimer = deadlineMilliseconds === null
		? undefined
		: setTimeout(() => stopChild("SIGTERM", "deadline-exceeded"), deadlineMilliseconds)
	deadlineTimer?.unref()
	const onSigterm = () => stopChild("SIGTERM", "signalled")
	const onSigint = () => stopChild("SIGINT", "signalled")
	process.on("SIGTERM", onSigterm)
	process.on("SIGINT", onSigint)

	const observeFirstPrimaryWrite = () => {
		if (responseObserved) return
		responseObserved = true
		acceptObserverRecord("response-available", "succeeded", invocationRecordIdentity)
	}
	const lifecycle = consumeLifecycle(child.stdio[3] as number, (record) => {
		const result = traceStore.accept(record)
		if (!result.accepted) {
			reportObserverFailure()
			return
		}
		// Only a validated producer observation can supply the session journey.
		if (typeof record === "object" && record !== null && "journey_identity" in record) {
			const observed = optionalIdentity(typeof record.journey_identity === "string" ? record.journey_identity : undefined)
			if (observed !== undefined && observed !== invocationIdentity) journeyIdentity = observed
		}
	}, reportObserverFailure)
	const stdout = forward(child.stdout, process.stdout, observeFirstPrimaryWrite)
	const stderr = forward(child.stderr, process.stderr, observeFirstPrimaryWrite)
	const exitCode = await child.exited
	if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
	if (reapTimer !== undefined) clearTimeout(reapTimer)
	process.off("SIGTERM", onSigterm)
	process.off("SIGINT", onSigint)
	await Promise.all([stdout, stderr])
	await closePrimaryResponseDescriptors()
	await lifecycle
	if (exitCode !== 0 || terminalOutcome !== undefined) reportObserverFailure()
	acceptObserverRecord("terminal", terminalOutcome ?? childOutcome(exitCode, child.signalCode), invocationRecordIdentity)

	// The child response is complete. Close our response descriptors before detached retention starts.
	traceStore.dispose()
	scheduleCleanup(journeyIdentity, invocationRecordIdentity)
	return exitCode
}

if (import.meta.main) {
	process.exitCode = await runRecoveryObserver(process.argv.slice(2))
}
