import { useMemo, useState } from "react";
import {
	createInitialState,
	deriveProjection,
	reduceState,
	type Action,
	type PrototypeState,
} from "./model.ts";

interface ActionDefinition {
	action: Action;
	label: string;
}

interface Walkthrough {
	id: string;
	shortLabel: string;
	title: string;
	description: string;
	watch: string;
	steps: ActionDefinition[];
}

const actions = {
	startPublication: { action: { type: "start_publication" }, label: "Start publication" },
	observePublication: {
		action: { type: "observe_durable_publication" },
		label: "Observe durable publication",
	},
	captureProjection: {
		action: { type: "capture_action_projection" },
		label: "Project Authority now",
	},
	concurrentRevision: {
		action: { type: "observe_concurrent_revision" },
		label: "Observe concurrent durable revision",
	},
	invokeProjected: {
		action: { type: "invoke_projected_action" },
		label: "Invoke with old projected Authority",
	},
	startOperation: {
		action: { type: "start_logical_operation" },
		label: "Start one Logical Operation",
	},
	loseAcknowledgement: {
		action: { type: "lose_acknowledgement" },
		label: "Lose Acknowledgement",
	},
	blindRetry: { action: { type: "attempt_blind_retry" }, label: "Attempt blind retry" },
	observeProgress: {
		action: { type: "observe_operation_progress" },
		label: "Observe Operation Progress",
	},
	missDeadline: {
		action: { type: "miss_observation_deadline" },
		label: "Miss observation deadline",
	},
	requestCancellation: {
		action: { type: "request_cancellation" },
		label: "Request Cancellation",
	},
	deliverCancellation: {
		action: { type: "deliver_cancellation" },
		label: "Deliver Cancellation",
	},
	observeCancellation: {
		action: { type: "observe_cancellation_effective" },
		label: "Observe Cancellation effective",
	},
	cleanupCancellation: {
		action: { type: "complete_cancellation_cleanup" },
		label: "Complete Cancellation cleanup",
	},
	observeCancelled: {
		action: { type: "observe_cancelled_outcome" },
		label: "Observe cancelled outcome",
	},
	conflictingWork: {
		action: { type: "attempt_conflicting_work" },
		label: "Attempt conflicting work",
	},
	removeEvidence: {
		action: { type: "remove_required_evidence" },
		label: "Remove required evidence",
	},
	restoreEvidence: {
		action: { type: "restore_required_evidence" },
		label: "Restore required evidence",
	},
	editGenerated: {
		action: { type: "edit_generated_output" },
		label: "Edit generated output",
	},
	restoreGenerated: {
		action: { type: "restore_generated_output" },
		label: "Restore generated output",
	},
	attemptContinuation: {
		action: { type: "attempt_continuation" },
		label: "Attempt continuation",
	},
} satisfies Record<string, ActionDefinition>;

const walkthroughs: Walkthrough[] = [
	{
		id: "publication",
		shortLabel: "Publication",
		title: "Publication needs observed durable evidence",
		description:
			"An accepted Logical Operation and a healthy wait are not terminal publication. The terminal outcome arrives only with the Observed Side Effect.",
		watch: "Next Safe Action stays wait until the durable publication is observed, then becomes none with product_terminal Stop Scope.",
		steps: [actions.startPublication, actions.observePublication],
	},
	{
		id: "stale-authority",
		shortLabel: "Stale Authority",
		title: "A concurrent revision invalidates old Authority",
		description:
			"An action is projected from one durable revision. A second writer changes the durable evidence before invocation.",
		watch: "Action freshness becomes stale, Authority is denied, and invoking the old action visibly refuses.",
		steps: [actions.captureProjection, actions.concurrentRevision, actions.invokeProjected],
	},
	{
		id: "lost-acknowledgement",
		shortLabel: "Lost Ack",
		title: "Unknown Acknowledgement preserves one identity",
		description:
			"The transport loses durable knowledge of an accepted Logical Operation. The intended outcome still has one stable identity.",
		watch: "The Logical Operation ID does not change. Blind retry refuses and Next Safe Action projects inspection.",
		steps: [actions.startOperation, actions.loseAcknowledgement, actions.blindRetry],
	},
	{
		id: "stalled-progress",
		shortLabel: "Stalled Progress",
		title: "A healthy wait has a liveness deadline",
		description:
			"The gate remains available while accepted work stops producing authoritative Operation Progress.",
		watch: "Gate Availability remains available, but a missed deadline moves Next Safe Action from wait to needs_human.",
		steps: [actions.startOperation, actions.observeProgress, actions.missDeadline],
	},
	{
		id: "cancellation",
		shortLabel: "Cancellation",
		title: "Cancellation is a lifecycle, not a boolean",
		description:
			"Cancellation moves through request, delivery, effectiveness, cleanup, and an observed terminal outcome.",
		watch: "Conflicting work refuses while Cancellation is in flight. Each stage selects exactly one different Next Safe Action.",
		steps: [
			actions.startOperation,
			actions.requestCancellation,
			actions.conflictingWork,
			actions.deliverCancellation,
			actions.observeCancellation,
			actions.cleanupCancellation,
			actions.observeCancelled,
		],
	},
	{
		id: "fail-closed",
		shortLabel: "Fail Closed",
		title: "Incomplete or drifted evidence cannot continue",
		description:
			"Missing required evidence and edited generated output are two different failures. Neither may default to continuation.",
		watch: "Projection Completeness becomes incomplete in both cases, Authority is denied, and continuation visibly refuses.",
		steps: [
			actions.removeEvidence,
			actions.attemptContinuation,
			actions.restoreEvidence,
			actions.editGenerated,
			actions.attemptContinuation,
		],
	},
];

const freePlayActions = Object.values(actions);

function Field({ label, value }: { label: string; value: string | number | null }) {
	return (
		<div className="field">
			<dt>{label}</dt>
			<dd>{value ?? "none"}</dd>
		</div>
	);
}

function EvidencePanel({ state }: { state: PrototypeState }) {
	return (
		<section className="state-card" aria-labelledby="evidence-heading">
			<div className="card-heading">
				<p className="eyebrow">Observed facts</p>
				<h2 id="evidence-heading">Current evidence</h2>
			</div>
			<dl className="field-grid">
				<Field label="Durable revision" value={state.durableRevision} />
				<Field label="Projected revision" value={state.projectedRevision} />
				<Field label="Logical Operation ID" value={state.logicalOperationId} />
				<Field label="Attempts" value={state.attempts} />
				<Field label="Acknowledgement" value={state.acknowledgement} />
				<Field label="Gate Availability" value={state.gateAvailability} />
				<Field label="Operation Progress" value={state.operationProgress} />
				<Field label="Observation deadline" value={state.observationDeadline} />
				<Field label="Declared Side Effect" value={state.declaredSideEffect} />
				<Field label="Observed Side Effect" value={state.observedSideEffect} />
				<Field label="Required evidence" value={state.requiredEvidence} />
				<Field label="Expected generated digest" value={state.generatedArtifact.expectedDigest} />
				<Field label="Observed generated digest" value={state.generatedArtifact.observedDigest} />
			</dl>
			<div className="lifecycle" aria-label="Cancellation lifecycle evidence">
				<p className="lifecycle-title">Cancellation evidence</p>
				{[
					["Request", state.cancellation.request],
					["Delivery", state.cancellation.delivery],
					["Effectiveness", state.cancellation.effectiveness],
					["Cleanup", state.cancellation.cleanup],
					["Terminal outcome", state.cancellation.terminalOutcome],
				].map(([label, value]) => (
					<div className="lifecycle-step" key={label}>
						<span>{label}</span>
						<strong>{value}</strong>
					</div>
				))}
			</div>
		</section>
	);
}

export function App() {
	const [state, setState] = useState(createInitialState);
	const [activeWalkthroughId, setActiveWalkthroughId] = useState(walkthroughs[0].id);
	const [stepIndex, setStepIndex] = useState(0);
	const projection = useMemo(() => deriveProjection(state), [state]);
	const activeWalkthrough =
		walkthroughs.find((walkthrough) => walkthrough.id === activeWalkthroughId) ?? walkthroughs[0];

	function dispatch(action: Action) {
		setState((current) => reduceState(current, action));
	}

	function selectWalkthrough(id: string) {
		setActiveWalkthroughId(id);
		setStepIndex(0);
		setState(createInitialState());
	}

	function runGuidedStep(step: ActionDefinition, index: number) {
		dispatch(step.action);
		if (index === stepIndex) setStepIndex((current) => current + 1);
	}

	return (
		<main>
			<header className="hero">
				<div>
					<p className="kicker">Vault Git reimagined</p>
					<h1>Feel the State Projection before building the generator.</h1>
					<p className="intro">
						Can a product owner distinguish valid continuation, healthy waiting, stale Authority,
						unknown Acknowledgement, stalled Operation Progress, Cancellation in flight, and
						fail-closed Projection Completeness?
					</p>
				</div>
				<aside className="prototype-notice">
					<strong>Conversation aid, not acceptance evidence.</strong>
					<p>
						This in-memory React prototype does not compile JSONC, generate code, run Vault Git,
						cross the public CLI process seam, or satisfy Observed Branch Coverage.
					</p>
				</aside>
			</header>

			<section className="outcome" data-kind={state.lastOutcome.kind} aria-live="polite">
				<span>{state.lastOutcome.kind}</span>
				<p>{state.lastOutcome.message}</p>
			</section>

			<div className="projection-layout">
				<EvidencePanel state={state} />
				<section className="state-card projection-card" aria-labelledby="projection-heading">
					<div className="card-heading">
						<p className="eyebrow">Derived meaning</p>
						<h2 id="projection-heading">Complete State Projection</h2>
					</div>
					<div className="next-action" data-kind={projection.nextSafeAction.kind}>
						<p>Next Safe Action</p>
						<strong>{projection.nextSafeAction.kind}</strong>
						<code>{projection.nextSafeAction.directive}</code>
						<span>{projection.nextSafeAction.reason}</span>
					</div>
					<dl className="field-grid projection-fields">
						<Field label="Projection Completeness" value={projection.projectionCompleteness} />
						<Field label="Authority" value={projection.authority.status} />
						<Field label="Authority reason" value={projection.authority.reason} />
						<Field label="Action freshness" value={projection.actionFreshness} />
						<Field
							label="Exact Same-Input Retry Safety"
							value={projection.exactSameInputRetrySafety}
						/>
						<Field label="Acknowledgement" value={projection.acknowledgement} />
						<Field label="Gate Availability" value={projection.gateAvailability} />
						<Field label="Operation Progress" value={projection.operationProgress} />
						<Field label="Cancellation stage" value={projection.cancellation.stage} />
						<Field label="Generated Artifact Drift" value={projection.generatedArtifactDrift} />
						<Field label="Stop Scope" value={projection.stopScope} />
					</dl>
				</section>
			</div>

			<section className="walkthroughs" aria-labelledby="walkthrough-heading">
				<div className="section-heading">
					<p className="eyebrow">Deterministic resets</p>
					<h2 id="walkthrough-heading">Guided walkthroughs</h2>
				</div>
				<div className="tabs" role="tablist" aria-label="Guided walkthroughs">
					{walkthroughs.map((walkthrough) => (
						<button
							aria-selected={activeWalkthroughId === walkthrough.id}
							className="tab"
							key={walkthrough.id}
							onClick={() => selectWalkthrough(walkthrough.id)}
							role="tab"
							type="button"
						>
							{walkthrough.shortLabel}
						</button>
					))}
				</div>
				<article className="walkthrough-panel" role="tabpanel">
					<div className="walkthrough-copy">
						<p className="step-count">
							Step {Math.min(stepIndex + 1, activeWalkthrough.steps.length)} of{" "}
							{activeWalkthrough.steps.length}
						</p>
						<h3>{activeWalkthrough.title}</h3>
						<p>{activeWalkthrough.description}</p>
						<p className="watch"><strong>Watch:</strong> {activeWalkthrough.watch}</p>
					</div>
					<ol className="guided-steps">
						{activeWalkthrough.steps.map((step, index) => (
							<li
								data-status={
									index < stepIndex ? "complete" : index === stepIndex ? "current" : "later"
								}
								key={`${activeWalkthrough.id}-${index}-${step.action.type}`}
							>
								<button onClick={() => runGuidedStep(step, index)} type="button">
									<span>{index + 1}</span>
									{step.label}
								</button>
							</li>
						))}
					</ol>
					<button className="reset-button" onClick={() => selectWalkthrough(activeWalkthrough.id)} type="button">
						Reset this walkthrough
					</button>
				</article>
			</section>

			<section className="free-play" aria-labelledby="free-play-heading">
				<div className="section-heading">
					<p className="eyebrow">Nothing is disabled</p>
					<h2 id="free-play-heading">Free play</h2>
					<p>Push events in any order. Invalid actions stay available so the refusal is visible.</p>
				</div>
				<div className="button-grid">
					{freePlayActions.map((definition) => (
						<button key={definition.action.type} onClick={() => dispatch(definition.action)} type="button">
							{definition.label}
						</button>
					))}
				</div>
				<button className="reset-button" onClick={() => setState(createInitialState())} type="button">
					Reset all evidence
				</button>
			</section>
		</main>
	);
}
