import { createInvocationTraceStore } from "../invocation-trace-store.ts"

const [stateHome, invocationIdentity, producerIdentity] = process.argv.slice(2)
if (!stateHome || !invocationIdentity || !producerIdentity) process.exit(64)

const store = createInvocationTraceStore({ invocationIdentity, stateHome })
const result = store.accept({
	schema_version: 1,
	record_type: "lifecycle",
	record_identity: `${producerIdentity}-record-0`,
	journey_identity: "concurrent-journey",
	invocation_identity: invocationIdentity,
	producer_identity: producerIdentity,
	producer_sequence: 0,
	harness_kind: "command",
	operation: "recover",
	phase: "invocation",
	occurred_at: "2026-09-06T00:00:00.000Z",
	outcome: "started",
})
store.dispose()
process.exit(result.accepted ? 0 : 1)
