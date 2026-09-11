import { describe, expect, test } from 'bun:test'
import {
	createInitialState,
	deriveProjection,
	reduceState,
} from '../prototypes/vault-git-reimagined/src/model.ts'

/**
 * Characterization coverage for the vault-git-reimagined prototype's
 * `reduceState`/`deriveProjection` pair.
 *
 * Every expected value below was captured from the pre-refactor
 * implementation (git rev 36f146d6) by running these exact action
 * sequences and transcribing the resulting state and projection objects.
 * They are independent literals, not values re-derived from the code
 * under test: a regression in the extracted per-action handlers or the
 * lookup table dispatch would show up as a mismatch here.
 */
describe('vault-git-reimagined prototype model', () => {
	test('createInitialState returns the deterministic walkthrough seed', () => {
		expect(createInitialState()).toEqual({
			durableRevision: 42,
			projectedRevision: null,
			logicalOperationId: null,
			attempts: 0,
			acknowledgement: 'none',
			declaredSideEffect: null,
			observedSideEffect: null,
			gateAvailability: 'available',
			operationProgress: 'idle',
			observationDeadline: 'not_started',
			cancellation: {
				stage: 'not_requested',
				request: 'absent',
				delivery: 'not_delivered',
				effectiveness: 'unknown',
				cleanup: 'pending',
				terminalOutcome: 'absent',
			},
			requiredEvidence: 'present',
			generatedArtifact: {
				expectedDigest: 'generated:7c91',
				observedDigest: 'generated:7c91',
			},
			lastOutcome: {
				kind: 'ready',
				message: 'Ready for a deterministic walkthrough or free play.',
			},
		})
	})

	test('happy-path publication lifecycle, staleness, and terminal refusals', () => {
		const s0 = createInitialState()

		const s1 = reduceState(s0, { type: 'start_publication' })
		expect(s1.lastOutcome).toEqual({
			kind: 'accepted',
			message:
				'One Logical Operation was accepted. Terminal meaning still requires observed evidence.',
		})
		expect(s1.logicalOperationId).toBe('VG-OP-2048')
		expect(s1.operationProgress).toBe('accepted')
		expect(s1.observationDeadline).toBe('healthy')
		expect(s1.declaredSideEffect).toBe('Publish the admitted vault revision durably.')

		const s2 = reduceState(s1, { type: 'start_publication' })
		expect(s2.lastOutcome).toEqual({
			kind: 'refused',
			message: 'Refused: VG-OP-2048 already owns the intended outcome.',
		})

		const s3 = reduceState(s1, { type: 'observe_durable_publication' })
		expect(s3.lastOutcome).toEqual({
			kind: 'accepted',
			message: 'Observed Side Effect recorded. Publication is now terminal.',
		})
		expect(s3.acknowledgement).toBe('completed')
		expect(s3.observedSideEffect).toBe(
			'The admitted vault revision is durably published.',
		)
		expect(s3.operationProgress).toBe('terminal')
		expect(s3.observationDeadline).toBe('not_started')

		const s4 = reduceState(s3, { type: 'capture_action_projection' })
		expect(s4.lastOutcome).toEqual({
			kind: 'accepted',
			message: 'Authority projected from durable revision 42.',
		})
		expect(s4.projectedRevision).toBe(42)

		const s5 = reduceState(s4, { type: 'observe_concurrent_revision' })
		expect(s5.lastOutcome).toEqual({
			kind: 'accepted',
			message:
				'A concurrent durable revision was observed. Re-evaluate projected Authority.',
		})
		expect(s5.durableRevision).toBe(43)

		expect(deriveProjection(s5)).toEqual({
			acknowledgement: 'completed',
			actionFreshness: 'stale',
			cancellation: {
				stage: 'not_requested',
				request: 'absent',
				delivery: 'not_delivered',
				effectiveness: 'unknown',
				cleanup: 'pending',
				terminalOutcome: 'absent',
			},
			gateAvailability: 'available',
			generatedArtifactDrift: 'absent',
			operationProgress: 'terminal',
			projectionCompleteness: 'complete',
			authority: {
				status: 'denied',
				reason: 'The durable revision changed after Authority was projected.',
			},
			exactSameInputRetrySafety: 'unsafe',
			nextSafeAction: {
				kind: 'needs_human',
				directive: 'inspect_and_refresh_state_projection',
				reason: 'Old Authority cannot cross a newer durable revision.',
			},
			stopScope: 'current_agent',
		})

		const s6 = reduceState(s5, { type: 'invoke_projected_action' })
		expect(s6.lastOutcome).toEqual({
			kind: 'refused',
			message: 'Refused: The durable revision changed after Authority was projected.',
		})

		const s7 = reduceState(s5, { type: 'capture_action_projection' })
		expect(s7.lastOutcome).toEqual({
			kind: 'accepted',
			message: 'Authority projected from durable revision 43.',
		})
		expect(s7.projectedRevision).toBe(43)

		expect(deriveProjection(s7)).toEqual({
			acknowledgement: 'completed',
			actionFreshness: 'current',
			cancellation: {
				stage: 'not_requested',
				request: 'absent',
				delivery: 'not_delivered',
				effectiveness: 'unknown',
				cleanup: 'pending',
				terminalOutcome: 'absent',
			},
			gateAvailability: 'available',
			generatedArtifactDrift: 'absent',
			operationProgress: 'terminal',
			projectionCompleteness: 'complete',
			authority: {
				status: 'denied',
				reason: 'The durable publication is already terminal.',
			},
			exactSameInputRetrySafety: 'not_applicable',
			nextSafeAction: {
				kind: 'none',
				directive: 'none',
				reason:
					'The Observed Side Effect, not process success, establishes terminal publication.',
			},
			stopScope: 'product_terminal',
		})

		const s8 = reduceState(s7, { type: 'invoke_projected_action' })
		expect(s8.lastOutcome).toEqual({
			kind: 'refused',
			message: 'Refused: The durable publication is already terminal.',
		})

		const s9 = reduceState(s7, { type: 'attempt_continuation' })
		expect(s9.lastOutcome).toEqual({
			kind: 'refused',
			message:
				'Refused: The Observed Side Effect, not process success, establishes terminal publication.',
		})
	})

	test('observe_durable_publication refuses with no active side effect', () => {
		const s0 = createInitialState()
		const s1 = reduceState(s0, { type: 'observe_durable_publication' })
		expect(s1.lastOutcome).toEqual({
			kind: 'refused',
			message: 'Refused: no Declared Side Effect exists to observe.',
		})
	})

	test('acknowledgement loss and blind retry', () => {
		const s0 = createInitialState()
		const s1 = reduceState(s0, { type: 'start_logical_operation' })
		expect(s1.declaredSideEffect).toBe('Apply one admitted durable revision.')

		const s2 = reduceState(s1, { type: 'lose_acknowledgement' })
		expect(s2.lastOutcome).toEqual({
			kind: 'accepted',
			message: 'Acknowledgement is unknown. VG-OP-2048 remains the sole Logical Operation ID.',
		})
		expect(s2.acknowledgement).toBe('unknown')

		expect(deriveProjection(s2)).toEqual({
			acknowledgement: 'unknown',
			actionFreshness: 'not_projected',
			cancellation: {
				stage: 'not_requested',
				request: 'absent',
				delivery: 'not_delivered',
				effectiveness: 'unknown',
				cleanup: 'pending',
				terminalOutcome: 'absent',
			},
			gateAvailability: 'available',
			generatedArtifactDrift: 'absent',
			operationProgress: 'accepted',
			projectionCompleteness: 'complete',
			authority: {
				status: 'denied',
				reason: 'Unknown Acknowledgement denies blind retry of the Logical Operation.',
			},
			exactSameInputRetrySafety: 'unknown',
			nextSafeAction: {
				kind: 'invoke',
				directive: 'inspect_logical_operation',
				reason: 'Reconcile the existing Logical Operation ID before any retry decision.',
			},
			stopScope: null,
		})

		const s3 = reduceState(s2, { type: 'attempt_blind_retry' })
		expect(s3.lastOutcome).toEqual({
			kind: 'refused',
			message:
				'Refused: inspect VG-OP-2048 before deciding whether the same input is safe to retry.',
		})

		const s4 = reduceState(s0, { type: 'attempt_blind_retry' })
		expect(s4.lastOutcome).toEqual({
			kind: 'refused',
			message: 'Refused: blind retry is only being demonstrated for unknown Acknowledgement.',
		})

		const s5 = reduceState(s0, { type: 'lose_acknowledgement' })
		expect(s5.lastOutcome).toEqual({
			kind: 'refused',
			message: 'Refused: there is no Logical Operation whose Acknowledgement can be lost.',
		})
	})

	test('operation progress observation and missed deadlines', () => {
		const s0 = createInitialState()
		const s1 = reduceState(s0, { type: 'start_logical_operation' })

		const s2 = reduceState(s1, { type: 'observe_operation_progress' })
		expect(s2.lastOutcome).toEqual({
			kind: 'accepted',
			message: 'Authoritative Operation Progress was observed within the deadline.',
		})
		expect(s2.operationProgress).toBe('advancing')
		expect(s2.observationDeadline).toBe('healthy')

		expect(deriveProjection(s2)).toEqual({
			acknowledgement: 'accepted',
			actionFreshness: 'not_projected',
			cancellation: {
				stage: 'not_requested',
				request: 'absent',
				delivery: 'not_delivered',
				effectiveness: 'unknown',
				cleanup: 'pending',
				terminalOutcome: 'absent',
			},
			gateAvailability: 'available',
			generatedArtifactDrift: 'absent',
			operationProgress: 'advancing',
			projectionCompleteness: 'complete',
			authority: {
				status: 'denied',
				reason: 'Accepted work owns the current Logical Operation.',
			},
			exactSameInputRetrySafety: 'unsafe',
			nextSafeAction: {
				kind: 'wait',
				directive: 'observe_operation_progress',
				reason: 'The observation deadline is healthy; do not create competing work.',
			},
			stopScope: null,
		})

		const s3 = reduceState(s2, { type: 'miss_observation_deadline' })
		expect(s3.lastOutcome).toEqual({
			kind: 'accepted',
			message: 'Observation deadline missed. Gate Availability remains a separate fact.',
		})
		expect(s3.operationProgress).toBe('stalled')
		expect(s3.observationDeadline).toBe('missed')

		expect(deriveProjection(s3)).toEqual({
			acknowledgement: 'accepted',
			actionFreshness: 'not_projected',
			cancellation: {
				stage: 'not_requested',
				request: 'absent',
				delivery: 'not_delivered',
				effectiveness: 'unknown',
				cleanup: 'pending',
				terminalOutcome: 'absent',
			},
			gateAvailability: 'available',
			generatedArtifactDrift: 'absent',
			operationProgress: 'stalled',
			projectionCompleteness: 'complete',
			authority: {
				status: 'denied',
				reason: 'Operation Progress is stalled despite Gate Availability.',
			},
			exactSameInputRetrySafety: 'unsafe',
			nextSafeAction: {
				kind: 'needs_human',
				directive: 'inspect_stalled_operation',
				reason: 'A missed observation deadline escalates healthy wait to needs_human.',
			},
			stopScope: 'current_agent',
		})

		const s4 = reduceState(s0, { type: 'observe_operation_progress' })
		expect(s4.lastOutcome).toEqual({
			kind: 'refused',
			message: 'Refused: no active Logical Operation can supply Operation Progress.',
		})

		const s5 = reduceState(s0, { type: 'miss_observation_deadline' })
		expect(s5.lastOutcome).toEqual({
			kind: 'refused',
			message: 'Refused: no active observation deadline exists.',
		})
	})

	test('full cancellation lifecycle', () => {
		const s0 = createInitialState()
		const s1 = reduceState(s0, { type: 'start_logical_operation' })

		const s2 = reduceState(s1, { type: 'request_cancellation' })
		expect(s2.lastOutcome).toEqual({
			kind: 'accepted',
			message: 'Cancellation request recorded. Delivery and effectiveness remain unknown.',
		})
		expect(s2.cancellation).toEqual({
			stage: 'requested',
			request: 'recorded',
			delivery: 'not_delivered',
			effectiveness: 'unknown',
			cleanup: 'pending',
			terminalOutcome: 'absent',
		})
		expect(deriveProjection(s2).authority).toEqual({
			status: 'denied',
			reason: 'A Cancellation request denies conflicting work until its outcome is known.',
		})
		expect(deriveProjection(s2).nextSafeAction).toEqual({
			kind: 'invoke',
			directive: 'deliver_cancellation',
			reason: 'The request is recorded but has not reached the work owner.',
		})

		const s2b = reduceState(s2, { type: 'request_cancellation' })
		expect(s2b.lastOutcome).toEqual({
			kind: 'refused',
			message: 'Refused: Cancellation has already been requested for this Logical Operation.',
		})

		const s2c = reduceState(s2, { type: 'attempt_conflicting_work' })
		expect(s2c.lastOutcome).toEqual({
			kind: 'refused',
			message: 'Refused: Cancellation in flight denies conflicting work.',
		})

		const s3 = reduceState(s2, { type: 'deliver_cancellation' })
		expect(s3.lastOutcome).toEqual({
			kind: 'accepted',
			message: 'Cancellation was delivered. Delivery does not prove effectiveness.',
		})
		expect(s3.cancellation.stage).toBe('delivered')
		expect(s3.cancellation.delivery).toBe('delivered')
		expect(deriveProjection(s3).authority).toEqual({
			status: 'denied',
			reason: 'Cancellation delivery is not evidence that Cancellation is effective.',
		})

		const s3b = reduceState(s0, { type: 'deliver_cancellation' })
		expect(s3b.lastOutcome).toEqual({
			kind: 'refused',
			message: 'Refused: Cancellation delivery requires a recorded request.',
		})

		const s4 = reduceState(s3, { type: 'observe_cancellation_effective' })
		expect(s4.lastOutcome).toEqual({
			kind: 'accepted',
			message: 'Cancellation effectiveness observed. Cleanup remains pending.',
		})
		expect(s4.cancellation.stage).toBe('effective')
		expect(s4.cancellation.effectiveness).toBe('effective')
		expect(deriveProjection(s4).authority).toEqual({
			status: 'denied',
			reason: 'Cancellation is effective, but cleanup is still required.',
		})

		const s4b = reduceState(s0, { type: 'observe_cancellation_effective' })
		expect(s4b.lastOutcome).toEqual({
			kind: 'refused',
			message: 'Refused: effectiveness can only be observed after delivery.',
		})

		const s5 = reduceState(s4, { type: 'complete_cancellation_cleanup' })
		expect(s5.lastOutcome).toEqual({
			kind: 'accepted',
			message: 'Cancellation cleanup completed. The terminal outcome is still absent.',
		})
		expect(s5.cancellation.stage).toBe('cleanup_complete')
		expect(s5.cancellation.cleanup).toBe('complete')
		expect(deriveProjection(s5).nextSafeAction).toEqual({
			kind: 'wait',
			directive: 'observe_cancelled_terminal_outcome',
			reason: 'The product still owes authoritative terminal evidence.',
		})

		const s5b = reduceState(s0, { type: 'complete_cancellation_cleanup' })
		expect(s5b.lastOutcome).toEqual({
			kind: 'refused',
			message: 'Refused: cleanup follows observed Cancellation effectiveness.',
		})

		const s6 = reduceState(s5, { type: 'observe_cancelled_outcome' })
		expect(s6.lastOutcome).toEqual({
			kind: 'accepted',
			message: 'Cancelled terminal outcome observed.',
		})
		expect(s6.cancellation).toEqual({
			stage: 'cancelled',
			request: 'recorded',
			delivery: 'delivered',
			effectiveness: 'effective',
			cleanup: 'complete',
			terminalOutcome: 'cancelled',
		})
		expect(s6.operationProgress).toBe('terminal')

		expect(deriveProjection(s6)).toEqual({
			acknowledgement: 'completed',
			actionFreshness: 'not_projected',
			cancellation: {
				stage: 'cancelled',
				request: 'recorded',
				delivery: 'delivered',
				effectiveness: 'effective',
				cleanup: 'complete',
				terminalOutcome: 'cancelled',
			},
			gateAvailability: 'available',
			generatedArtifactDrift: 'absent',
			operationProgress: 'terminal',
			projectionCompleteness: 'complete',
			authority: {
				status: 'denied',
				reason: 'The Logical Operation has a cancelled terminal outcome.',
			},
			exactSameInputRetrySafety: 'not_applicable',
			nextSafeAction: {
				kind: 'none',
				directive: 'none',
				reason:
					'Cancellation is terminal only after request, delivery, effectiveness, cleanup, and outcome.',
			},
			stopScope: 'product_terminal',
		})

		const s6b = reduceState(s0, { type: 'observe_cancelled_outcome' })
		expect(s6b.lastOutcome).toEqual({
			kind: 'refused',
			message: 'Refused: terminal Cancellation requires completed cleanup.',
		})

		const s7 = reduceState(s6, { type: 'attempt_conflicting_work' })
		expect(s7.lastOutcome).toEqual({
			kind: 'accepted',
			message:
				'One Logical Operation was accepted. Terminal meaning still requires observed evidence.',
		})
		expect(s7.declaredSideEffect).toBe('Start conflicting durable work.')
	})

	test('required evidence missing and restored', () => {
		const s0 = createInitialState()
		const s1 = reduceState(s0, { type: 'remove_required_evidence' })
		expect(s1.lastOutcome).toEqual({
			kind: 'accepted',
			message: 'A required observation is missing. Projection Completeness now fails closed.',
		})
		expect(s1.requiredEvidence).toBe('missing')

		expect(deriveProjection(s1)).toEqual({
			acknowledgement: 'none',
			actionFreshness: 'not_projected',
			cancellation: {
				stage: 'not_requested',
				request: 'absent',
				delivery: 'not_delivered',
				effectiveness: 'unknown',
				cleanup: 'pending',
				terminalOutcome: 'absent',
			},
			gateAvailability: 'available',
			generatedArtifactDrift: 'absent',
			operationProgress: 'idle',
			projectionCompleteness: 'incomplete',
			authority: {
				status: 'denied',
				reason: 'Projection Completeness fails closed while required evidence is missing.',
			},
			exactSameInputRetrySafety: 'unknown',
			nextSafeAction: {
				kind: 'needs_human',
				directive: 'restore_or_investigate_required_evidence',
				reason: 'No continuation can be selected from incomplete observations.',
			},
			stopScope: 'current_agent',
		})

		const s2 = reduceState(s1, { type: 'restore_required_evidence' })
		expect(s2.lastOutcome).toEqual({
			kind: 'accepted',
			message: 'Required evidence restored and ready for a fresh State Projection.',
		})
		expect(s2.requiredEvidence).toBe('present')
	})

	test('generated artifact drift and restoration', () => {
		const s0 = createInitialState()
		const s1 = reduceState(s0, { type: 'edit_generated_output' })
		expect(s1.lastOutcome).toEqual({
			kind: 'accepted',
			message: 'Generated output was edited outside isolated regeneration.',
		})
		expect(s1.generatedArtifact).toEqual({
			expectedDigest: 'generated:7c91',
			observedDigest: 'edited:91ad',
		})

		expect(deriveProjection(s1)).toEqual({
			acknowledgement: 'none',
			actionFreshness: 'not_projected',
			cancellation: {
				stage: 'not_requested',
				request: 'absent',
				delivery: 'not_delivered',
				effectiveness: 'unknown',
				cleanup: 'pending',
				terminalOutcome: 'absent',
			},
			gateAvailability: 'available',
			generatedArtifactDrift: 'present',
			operationProgress: 'idle',
			projectionCompleteness: 'incomplete',
			authority: {
				status: 'denied',
				reason: 'Generated Artifact Drift invalidates the declared Generated Artifact Set.',
			},
			exactSameInputRetrySafety: 'unknown',
			nextSafeAction: {
				kind: 'needs_human',
				directive: 'discard_edit_and_regenerate_artifact_set',
				reason: 'Edited generated output is not an admitted input.',
			},
			stopScope: 'current_agent',
		})

		const s2 = reduceState(s1, { type: 'restore_generated_output' })
		expect(s2.lastOutcome).toEqual({
			kind: 'accepted',
			message: 'The Generated Artifact Set matches isolated regeneration again.',
		})
		expect(s2.generatedArtifact).toEqual({
			expectedDigest: 'generated:7c91',
			observedDigest: 'generated:7c91',
		})
	})

	test('attempt_continuation is granted from the initial state', () => {
		const s0 = createInitialState()

		expect(deriveProjection(s0)).toEqual({
			acknowledgement: 'none',
			actionFreshness: 'not_projected',
			cancellation: {
				stage: 'not_requested',
				request: 'absent',
				delivery: 'not_delivered',
				effectiveness: 'unknown',
				cleanup: 'pending',
				terminalOutcome: 'absent',
			},
			gateAvailability: 'available',
			generatedArtifactDrift: 'absent',
			operationProgress: 'idle',
			projectionCompleteness: 'complete',
			authority: {
				status: 'granted',
				reason: 'Required evidence is current and no conflicting Logical Operation exists.',
			},
			exactSameInputRetrySafety: 'not_applicable',
			nextSafeAction: {
				kind: 'invoke',
				directive: 'continue_declared_action',
				reason: 'The complete State Projection grants current Authority.',
			},
			stopScope: null,
		})

		const s1 = reduceState(s0, { type: 'attempt_continuation' })
		expect(s1.lastOutcome).toEqual({
			kind: 'accepted',
			message: 'Continuation accepted by a complete State Projection with current Authority.',
		})
	})
})
