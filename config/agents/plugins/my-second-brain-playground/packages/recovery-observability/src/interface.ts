import {
	createInvocationTraceStore,
	cleanupTraces,
	queryTraces,
	type TraceAcceptResult,
	type TraceCleanupResult,
	type TraceFilter,
	type TraceQueryResult,
} from "./invocation-trace-store.ts"
import {
	createRecoveryDiagnosticAdapter,
	type DiagnosticInput,
	type DiagnosticMode,
} from "./logtape-diagnostic-adapter.ts"

export interface RecoveryObservability {
	readonly tracePath: string | null
	accept(record: unknown): TraceAcceptResult
	diagnostic(record: DiagnosticInput): void
	cleanup(): TraceCleanupResult
	dispose(): void
}

export function openRecoveryObservability(options: {
	readonly invocationIdentity: string
	readonly stateHome?: string | undefined
	readonly mode?: DiagnosticMode | undefined
	readonly knownSecretValues?: readonly string[] | undefined
}): RecoveryObservability {
	const store = createInvocationTraceStore({
		invocationIdentity: options.invocationIdentity,
		stateHome: options.stateHome,
		knownSecretValues: options.knownSecretValues,
	})
	const adapter = createRecoveryDiagnosticAdapter({
		mode: options.mode,
		knownSecretValues: options.knownSecretValues,
		writeDiagnostic: (line) => {
			store.writeDiagnostic(line)
		},
		retainLifecycle: (record) => store.accept(record),
		disposeOutput: () => store.dispose(),
	})
	return {
		get tracePath() {
			return store.path
		},
		accept: (record) => adapter.accept(record),
		diagnostic: (record) => adapter.diagnostic(record),
		cleanup: () => cleanupTraces({ stateHome: options.stateHome }),
		dispose: () => adapter.dispose(),
	}
}

export function viewRecoveryTraces(options: { readonly stateHome?: string | undefined; readonly filter?: TraceFilter } = {}): TraceQueryResult {
	return queryTraces(options)
}

export function cleanupRecoveryTraces(options: { readonly stateHome?: string | undefined } = {}): TraceCleanupResult {
	return cleanupTraces(options)
}

export type { DiagnosticInput, DiagnosticMode, TraceAcceptResult, TraceCleanupResult, TraceFilter, TraceQueryResult }
export { isRecoveryIdentity, isPluginVersion, MAX_SERIALIZED_RECORD_BYTES } from "./serialized-values.ts"
export type { RecoveryOperation } from "./serialized-values.ts"
