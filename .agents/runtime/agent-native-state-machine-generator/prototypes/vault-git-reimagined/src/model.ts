export type NextSafeActionKind =
	| "invoke"
	| "wait"
	| "needs_input"
	| "needs_human"
	| "none";

export type Acknowledgement =
	| "none"
	| "accepted"
	| "completed"
	| "unknown";

export type CancellationStage =
	| "not_requested"
	| "requested"
	| "delivered"
	| "effective"
	| "cleanup_complete"
	| "cancelled";

export type Action =
	| { type: "start_publication" }
	| { type: "observe_durable_publication" }
	| { type: "capture_action_projection" }
	| { type: "observe_concurrent_revision" }
	| { type: "invoke_projected_action" }
	| { type: "start_logical_operation" }
	| { type: "lose_acknowledgement" }
	| { type: "attempt_blind_retry" }
	| { type: "observe_operation_progress" }
	| { type: "miss_observation_deadline" }
	| { type: "request_cancellation" }
	| { type: "deliver_cancellation" }
	| { type: "observe_cancellation_effective" }
	| { type: "complete_cancellation_cleanup" }
	| { type: "observe_cancelled_outcome" }
	| { type: "attempt_conflicting_work" }
	| { type: "remove_required_evidence" }
	| { type: "restore_required_evidence" }
	| { type: "edit_generated_output" }
	| { type: "restore_generated_output" }
	| { type: "attempt_continuation" };

export interface PrototypeState {
	durableRevision: number;
	projectedRevision: number | null;
	logicalOperationId: string | null;
	attempts: number;
	acknowledgement: Acknowledgement;
	declaredSideEffect: string | null;
	observedSideEffect: string | null;
	gateAvailability: "available" | "unavailable";
	operationProgress: "idle" | "accepted" | "advancing" | "stalled" | "terminal";
	observationDeadline: "not_started" | "healthy" | "missed";
	cancellation: {
		stage: CancellationStage;
		request: "absent" | "recorded";
		delivery: "not_delivered" | "delivered";
		effectiveness: "unknown" | "effective";
		cleanup: "pending" | "complete";
		terminalOutcome: "absent" | "cancelled";
	};
	requiredEvidence: "present" | "missing";
	generatedArtifact: {
		expectedDigest: string;
		observedDigest: string;
	};
	lastOutcome: {
		kind: "ready" | "accepted" | "refused";
		message: string;
	};
}

export interface StateProjection {
	projectionCompleteness: "complete" | "incomplete";
	authority: {
		status: "granted" | "denied";
		reason: string;
	};
	actionFreshness: "current" | "stale" | "not_projected";
	exactSameInputRetrySafety: "not_applicable" | "safe" | "unsafe" | "unknown";
	acknowledgement: Acknowledgement;
	gateAvailability: PrototypeState["gateAvailability"];
	operationProgress: PrototypeState["operationProgress"];
	cancellation: PrototypeState["cancellation"];
	generatedArtifactDrift: "absent" | "present";
	nextSafeAction: {
		kind: NextSafeActionKind;
		directive: string;
		reason: string;
	};
	stopScope: "product_terminal" | "current_agent" | null;
}

const initialCancellation = (): PrototypeState["cancellation"] => ({
	stage: "not_requested",
	request: "absent",
	delivery: "not_delivered",
	effectiveness: "unknown",
	cleanup: "pending",
	terminalOutcome: "absent",
});

export function createInitialState(): PrototypeState {
	return {
		durableRevision: 42,
		projectedRevision: null,
		logicalOperationId: null,
		attempts: 0,
		acknowledgement: "none",
		declaredSideEffect: null,
		observedSideEffect: null,
		gateAvailability: "available",
		operationProgress: "idle",
		observationDeadline: "not_started",
		cancellation: initialCancellation(),
		requiredEvidence: "present",
		generatedArtifact: {
			expectedDigest: "generated:7c91",
			observedDigest: "generated:7c91",
		},
		lastOutcome: {
			kind: "ready",
			message: "Ready for a deterministic walkthrough or free play.",
		},
	};
}

export function deriveProjection(state: PrototypeState): StateProjection {
	const generatedArtifactDrift =
		state.generatedArtifact.expectedDigest === state.generatedArtifact.observedDigest
			? "absent"
			: "present";
	const actionFreshness =
		state.projectedRevision === null
			? "not_projected"
			: state.projectedRevision === state.durableRevision
				? "current"
				: "stale";

	const base = {
		acknowledgement: state.acknowledgement,
		actionFreshness,
		cancellation: state.cancellation,
		gateAvailability: state.gateAvailability,
		generatedArtifactDrift,
		operationProgress: state.operationProgress,
	} as const;

	if (state.requiredEvidence === "missing") {
		return {
			...base,
			projectionCompleteness: "incomplete",
			authority: {
				status: "denied",
				reason: "Projection Completeness fails closed while required evidence is missing.",
			},
			exactSameInputRetrySafety: "unknown",
			nextSafeAction: {
				kind: "needs_human",
				directive: "restore_or_investigate_required_evidence",
				reason: "No continuation can be selected from incomplete observations.",
			},
			stopScope: "current_agent",
		};
	}

	if (generatedArtifactDrift === "present") {
		return {
			...base,
			projectionCompleteness: "incomplete",
			authority: {
				status: "denied",
				reason: "Generated Artifact Drift invalidates the declared Generated Artifact Set.",
			},
			exactSameInputRetrySafety: "unknown",
			nextSafeAction: {
				kind: "needs_human",
				directive: "discard_edit_and_regenerate_artifact_set",
				reason: "Edited generated output is not an admitted input.",
			},
			stopScope: "current_agent",
		};
	}

	if (state.cancellation.stage !== "not_requested") {
		const cancellationProjection: Record<
			Exclude<CancellationStage, "not_requested">,
			Pick<StateProjection, "authority" | "exactSameInputRetrySafety" | "nextSafeAction" | "stopScope">
		> = {
			requested: {
				authority: {
					status: "denied",
					reason: "A Cancellation request denies conflicting work until its outcome is known.",
				},
				exactSameInputRetrySafety: "unsafe",
				nextSafeAction: {
					kind: "invoke",
					directive: "deliver_cancellation",
					reason: "The request is recorded but has not reached the work owner.",
				},
				stopScope: null,
			},
			delivered: {
				authority: {
					status: "denied",
					reason: "Cancellation delivery is not evidence that Cancellation is effective.",
				},
				exactSameInputRetrySafety: "unsafe",
				nextSafeAction: {
					kind: "wait",
					directive: "observe_cancellation_effectiveness",
					reason: "Observe the product before selecting further work.",
				},
				stopScope: null,
			},
			effective: {
				authority: {
					status: "denied",
					reason: "Cancellation is effective, but cleanup is still required.",
				},
				exactSameInputRetrySafety: "unsafe",
				nextSafeAction: {
					kind: "invoke",
					directive: "complete_cancellation_cleanup",
					reason: "Clean up partial work before observing a terminal outcome.",
				},
				stopScope: null,
			},
			cleanup_complete: {
				authority: {
					status: "denied",
					reason: "Cleanup alone does not establish the terminal outcome.",
				},
				exactSameInputRetrySafety: "unsafe",
				nextSafeAction: {
					kind: "wait",
					directive: "observe_cancelled_terminal_outcome",
					reason: "The product still owes authoritative terminal evidence.",
				},
				stopScope: null,
			},
			cancelled: {
				authority: {
					status: "denied",
					reason: "The Logical Operation has a cancelled terminal outcome.",
				},
				exactSameInputRetrySafety: "not_applicable",
				nextSafeAction: {
					kind: "none",
					directive: "none",
					reason: "Cancellation is terminal only after request, delivery, effectiveness, cleanup, and outcome.",
				},
				stopScope: "product_terminal",
			},
		};

		return {
			...base,
			projectionCompleteness: "complete",
			...cancellationProjection[state.cancellation.stage],
		};
	}

	if (actionFreshness === "stale") {
		return {
			...base,
			projectionCompleteness: "complete",
			authority: {
				status: "denied",
				reason: "The durable revision changed after Authority was projected.",
			},
			exactSameInputRetrySafety: "unsafe",
			nextSafeAction: {
				kind: "needs_human",
				directive: "inspect_and_refresh_state_projection",
				reason: "Old Authority cannot cross a newer durable revision.",
			},
			stopScope: "current_agent",
		};
	}

	if (state.acknowledgement === "unknown") {
		return {
			...base,
			projectionCompleteness: "complete",
			authority: {
				status: "denied",
				reason: "Unknown Acknowledgement denies blind retry of the Logical Operation.",
			},
			exactSameInputRetrySafety: "unknown",
			nextSafeAction: {
				kind: "invoke",
				directive: "inspect_logical_operation",
				reason: "Reconcile the existing Logical Operation ID before any retry decision.",
			},
			stopScope: null,
		};
	}

	if (state.observationDeadline === "missed") {
		return {
			...base,
			projectionCompleteness: "complete",
			authority: {
				status: "denied",
				reason: "Operation Progress is stalled despite Gate Availability.",
			},
			exactSameInputRetrySafety: "unsafe",
			nextSafeAction: {
				kind: "needs_human",
				directive: "inspect_stalled_operation",
				reason: "A missed observation deadline escalates healthy wait to needs_human.",
			},
			stopScope: "current_agent",
		};
	}

	if (state.observedSideEffect !== null) {
		return {
			...base,
			projectionCompleteness: "complete",
			authority: {
				status: "denied",
				reason: "The durable publication is already terminal.",
			},
			exactSameInputRetrySafety: "not_applicable",
			nextSafeAction: {
				kind: "none",
				directive: "none",
				reason: "The Observed Side Effect, not process success, establishes terminal publication.",
			},
			stopScope: "product_terminal",
		};
	}

	if (state.operationProgress === "accepted" || state.operationProgress === "advancing") {
		return {
			...base,
			projectionCompleteness: "complete",
			authority: {
				status: "denied",
				reason: "Accepted work owns the current Logical Operation.",
			},
			exactSameInputRetrySafety: "unsafe",
			nextSafeAction: {
				kind: "wait",
				directive: "observe_operation_progress",
				reason: "The observation deadline is healthy; do not create competing work.",
			},
			stopScope: null,
		};
	}

	return {
		...base,
		projectionCompleteness: "complete",
		authority: {
			status: "granted",
			reason: "Required evidence is current and no conflicting Logical Operation exists.",
		},
		exactSameInputRetrySafety: "not_applicable",
		nextSafeAction: {
			kind: "invoke",
			directive: "continue_declared_action",
			reason: "The complete State Projection grants current Authority.",
		},
		stopScope: null,
	};
}

function accepted(state: PrototypeState, message: string): PrototypeState {
	return { ...state, lastOutcome: { kind: "accepted", message } };
}

function refused(state: PrototypeState, message: string): PrototypeState {
	return { ...state, lastOutcome: { kind: "refused", message } };
}

function startOperation(state: PrototypeState, declaredSideEffect: string): PrototypeState {
	if (state.logicalOperationId !== null && state.operationProgress !== "terminal") {
		return refused(state, `Refused: ${state.logicalOperationId} already owns the intended outcome.`);
	}

	return accepted(
		{
			...state,
			logicalOperationId: "VG-OP-2048",
			attempts: 1,
			acknowledgement: "accepted",
			declaredSideEffect,
			observedSideEffect: null,
			operationProgress: "accepted",
			observationDeadline: "healthy",
			cancellation: initialCancellation(),
		},
		"One Logical Operation was accepted. Terminal meaning still requires observed evidence.",
	);
}

function handleStartPublication(state: PrototypeState): PrototypeState {
	return startOperation(state, "Publish the admitted vault revision durably.");
}

function handleObserveDurablePublication(state: PrototypeState): PrototypeState {
	if (state.logicalOperationId === null || state.declaredSideEffect === null) {
		return refused(state, "Refused: no Declared Side Effect exists to observe.");
	}
	return accepted(
		{
			...state,
			acknowledgement: "completed",
			observedSideEffect: "The admitted vault revision is durably published.",
			operationProgress: "terminal",
			observationDeadline: "not_started",
		},
		"Observed Side Effect recorded. Publication is now terminal.",
	);
}

function handleCaptureActionProjection(state: PrototypeState): PrototypeState {
	return accepted(
		{ ...state, projectedRevision: state.durableRevision },
		`Authority projected from durable revision ${state.durableRevision}.`,
	);
}

function handleObserveConcurrentRevision(state: PrototypeState): PrototypeState {
	return accepted(
		{ ...state, durableRevision: state.durableRevision + 1 },
		"A concurrent durable revision was observed. Re-evaluate projected Authority.",
	);
}

function handleInvokeProjectedAction(state: PrototypeState): PrototypeState {
	const projection = deriveProjection(state);
	if (projection.actionFreshness !== "current" || projection.authority.status !== "granted") {
		return refused(state, `Refused: ${projection.authority.reason}`);
	}
	return accepted(state, "Projected action accepted under current Authority.");
}

function handleStartLogicalOperation(state: PrototypeState): PrototypeState {
	return startOperation(state, "Apply one admitted durable revision.");
}

function handleLoseAcknowledgement(state: PrototypeState): PrototypeState {
	if (state.logicalOperationId === null) {
		return refused(state, "Refused: there is no Logical Operation whose Acknowledgement can be lost.");
	}
	return accepted(
		{ ...state, acknowledgement: "unknown" },
		`Acknowledgement is unknown. ${state.logicalOperationId} remains the sole Logical Operation ID.`,
	);
}

function handleAttemptBlindRetry(state: PrototypeState): PrototypeState {
	if (state.acknowledgement !== "unknown") {
		return refused(state, "Refused: blind retry is only being demonstrated for unknown Acknowledgement.");
	}
	return refused(
		state,
		`Refused: inspect ${state.logicalOperationId} before deciding whether the same input is safe to retry.`,
	);
}

function handleObserveOperationProgress(state: PrototypeState): PrototypeState {
	if (state.logicalOperationId === null || state.operationProgress === "terminal") {
		return refused(state, "Refused: no active Logical Operation can supply Operation Progress.");
	}
	return accepted(
		{ ...state, operationProgress: "advancing", observationDeadline: "healthy" },
		"Authoritative Operation Progress was observed within the deadline.",
	);
}

function handleMissObservationDeadline(state: PrototypeState): PrototypeState {
	if (state.logicalOperationId === null || state.operationProgress === "terminal") {
		return refused(state, "Refused: no active observation deadline exists.");
	}
	return accepted(
		{ ...state, operationProgress: "stalled", observationDeadline: "missed" },
		"Observation deadline missed. Gate Availability remains a separate fact.",
	);
}

function handleRequestCancellation(state: PrototypeState): PrototypeState {
	if (state.logicalOperationId === null || state.operationProgress === "terminal") {
		return refused(state, "Refused: Cancellation requires an active Logical Operation.");
	}
	if (state.cancellation.stage !== "not_requested") {
		return refused(state, "Refused: Cancellation has already been requested for this Logical Operation.");
	}
	return accepted(
		{
			...state,
			cancellation: { ...state.cancellation, stage: "requested", request: "recorded" },
		},
		"Cancellation request recorded. Delivery and effectiveness remain unknown.",
	);
}

function handleDeliverCancellation(state: PrototypeState): PrototypeState {
	if (state.cancellation.stage !== "requested") {
		return refused(state, "Refused: Cancellation delivery requires a recorded request.");
	}
	return accepted(
		{
			...state,
			cancellation: {
				...state.cancellation,
				stage: "delivered",
				delivery: "delivered",
			},
		},
		"Cancellation was delivered. Delivery does not prove effectiveness.",
	);
}

function handleObserveCancellationEffective(state: PrototypeState): PrototypeState {
	if (state.cancellation.stage !== "delivered") {
		return refused(state, "Refused: effectiveness can only be observed after delivery.");
	}
	return accepted(
		{
			...state,
			cancellation: {
				...state.cancellation,
				stage: "effective",
				effectiveness: "effective",
			},
		},
		"Cancellation effectiveness observed. Cleanup remains pending.",
	);
}

function handleCompleteCancellationCleanup(state: PrototypeState): PrototypeState {
	if (state.cancellation.stage !== "effective") {
		return refused(state, "Refused: cleanup follows observed Cancellation effectiveness.");
	}
	return accepted(
		{
			...state,
			cancellation: {
				...state.cancellation,
				stage: "cleanup_complete",
				cleanup: "complete",
			},
		},
		"Cancellation cleanup completed. The terminal outcome is still absent.",
	);
}

function handleObserveCancelledOutcome(state: PrototypeState): PrototypeState {
	if (state.cancellation.stage !== "cleanup_complete") {
		return refused(state, "Refused: terminal Cancellation requires completed cleanup.");
	}
	return accepted(
		{
			...state,
			acknowledgement: "completed",
			operationProgress: "terminal",
			observationDeadline: "not_started",
			cancellation: {
				...state.cancellation,
				stage: "cancelled",
				terminalOutcome: "cancelled",
			},
		},
		"Cancelled terminal outcome observed.",
	);
}

function handleAttemptConflictingWork(state: PrototypeState): PrototypeState {
	if (state.cancellation.stage !== "not_requested" && state.cancellation.stage !== "cancelled") {
		return refused(state, "Refused: Cancellation in flight denies conflicting work.");
	}
	return startOperation(state, "Start conflicting durable work.");
}

function handleRemoveRequiredEvidence(state: PrototypeState): PrototypeState {
	return accepted(
		{ ...state, requiredEvidence: "missing" },
		"A required observation is missing. Projection Completeness now fails closed.",
	);
}

function handleRestoreRequiredEvidence(state: PrototypeState): PrototypeState {
	return accepted(
		{ ...state, requiredEvidence: "present" },
		"Required evidence restored and ready for a fresh State Projection.",
	);
}

function handleEditGeneratedOutput(state: PrototypeState): PrototypeState {
	return accepted(
		{
			...state,
			generatedArtifact: { ...state.generatedArtifact, observedDigest: "edited:91ad" },
		},
		"Generated output was edited outside isolated regeneration.",
	);
}

function handleRestoreGeneratedOutput(state: PrototypeState): PrototypeState {
	return accepted(
		{
			...state,
			generatedArtifact: {
				...state.generatedArtifact,
				observedDigest: state.generatedArtifact.expectedDigest,
			},
		},
		"The Generated Artifact Set matches isolated regeneration again.",
	);
}

function handleAttemptContinuation(state: PrototypeState): PrototypeState {
	const projection = deriveProjection(state);
	if (
		projection.projectionCompleteness !== "complete" ||
		projection.authority.status !== "granted"
	) {
		return refused(state, `Refused: ${projection.nextSafeAction.reason}`);
	}
	return accepted(state, "Continuation accepted by a complete State Projection with current Authority.");
}

const ACTION_HANDLERS: Readonly<Record<Action["type"], (state: PrototypeState) => PrototypeState>> = {
	start_publication: handleStartPublication,
	observe_durable_publication: handleObserveDurablePublication,
	capture_action_projection: handleCaptureActionProjection,
	observe_concurrent_revision: handleObserveConcurrentRevision,
	invoke_projected_action: handleInvokeProjectedAction,
	start_logical_operation: handleStartLogicalOperation,
	lose_acknowledgement: handleLoseAcknowledgement,
	attempt_blind_retry: handleAttemptBlindRetry,
	observe_operation_progress: handleObserveOperationProgress,
	miss_observation_deadline: handleMissObservationDeadline,
	request_cancellation: handleRequestCancellation,
	deliver_cancellation: handleDeliverCancellation,
	observe_cancellation_effective: handleObserveCancellationEffective,
	complete_cancellation_cleanup: handleCompleteCancellationCleanup,
	observe_cancelled_outcome: handleObserveCancelledOutcome,
	attempt_conflicting_work: handleAttemptConflictingWork,
	remove_required_evidence: handleRemoveRequiredEvidence,
	restore_required_evidence: handleRestoreRequiredEvidence,
	edit_generated_output: handleEditGeneratedOutput,
	restore_generated_output: handleRestoreGeneratedOutput,
	attempt_continuation: handleAttemptContinuation,
};

export function reduceState(state: PrototypeState, action: Action): PrototypeState {
	return ACTION_HANDLERS[action.type](state);
}
