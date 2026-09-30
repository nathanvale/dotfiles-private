// Evidence states for `status` and `doctor` (Spec #87 AC21). Each of the
// eight states names its verdict, the basis for it, when it was observed,
// and the boundary the observation crossed. Local states come from checks
// this invocation performs: the declared dependency selections, the resolved
// selection, and the adapter's effective custody mode read from metadata.
// schemaQualified and liveReadProven come only from a retained hosted-read
// observation that bin/evidence-record.ts still admits for this selection;
// without one they stay unobserved. fixtureTested comes only from a retained
// fixture-auth record that bin/evidence-record.ts still admits for these
// packaged bytes, at the fixture boundary; it feeds no other state. Nothing
// here contacts a Provider, reads a credential, or writes state. Custody,
// authentication, and write results are not retained, so those stay
// unobserved rather than promoted. A write is never proven without an exact
// effect receipt, and status reads none.
import type { Adapter, CustodyResolution } from "./adapters/contract.ts";
import { dependencyStatus, isDependencyTool } from "./dependency-status.ts";
import { type ObservationKind, readFixtureObservation, readObservation } from "./evidence-record.ts";
import type { ConnectorManifest } from "./manifest.ts";
import type { EnvironmentSource } from "./safe-environment.ts";

export type Verdict = "proven" | "not-proven" | "unobserved" | "not-applicable";

export interface Observation {
	readonly verdict: Verdict;
	readonly basis: string;
	readonly observedAt: string | null;
	readonly boundary: "local" | "hosted" | "fixture" | null;
	readonly [detail: string]: unknown;
}

// selection: null when a required selector was not supplied; otherwise the
// resolved values. custody: null when the adapter cannot resolve custody or
// the selection is missing.
export interface EvidenceRequest {
	readonly manifest: ConnectorManifest;
	readonly adapter: Adapter | undefined;
	readonly selectionResolved: boolean;
	readonly selectors: Readonly<Record<string, string>>;
	readonly custody: CustodyResolution | null;
	readonly env: EnvironmentSource;
	readonly observedAt: string;
}

interface DependencyRow {
	readonly tool: string;
	readonly state: string;
	readonly cause: string | null;
}

// A declared requirement outside the plugin's selection owners can never be
// ready, so it is reported as such rather than skipped.
function unreadyDependencies(requirements: readonly string[], env: EnvironmentSource): DependencyRow[] {
	return requirements.flatMap((name): DependencyRow[] => {
		if (!isDependencyTool(name)) return [{ tool: name, state: "not-ready", cause: "no-selection-owner" }];
		const [row] = dependencyStatus(env, [name]);
		return row && !row.ready ? [{ tool: name, state: row.state, cause: row.cause }] : [];
	});
}

function localReady(request: EvidenceRequest): Observation {
	const dependencies = unreadyDependencies(request.manifest.requirements, request.env);
	const local = { observedAt: request.observedAt, boundary: "local" as const, dependencies };
	if (dependencies.length > 0) return { verdict: "not-proven", basis: "declared-dependencies-not-ready", ...local };
	if (!request.selectionResolved) return { verdict: "unobserved", basis: "selection-not-supplied", ...local };
	return { verdict: "proven", basis: "declared-dependencies-ready-and-selection-resolved", ...local };
}

// Keyless custody makes custody and authentication not applicable. Any other
// resolved mode is configured, not checked: a registration or vault index
// never proves a credential record or authentication.
function custodyState(request: EvidenceRequest, unobservedBasis: string): Observation {
	const unobserved = (basis: string, custody: unknown, extra: Record<string, unknown> = {}): Observation => ({ verdict: "unobserved", basis, observedAt: null, boundary: null, custody, ...extra });
	if (request.manifest.adapter === null) {
		return { verdict: "not-applicable", basis: "effective-custody-keyless", observedAt: request.observedAt, boundary: "local", custody: { mode: "keyless", source: "packaged-manifest-default" } };
	}
	const { custody } = request;
	if (!request.selectionResolved) return unobserved("selection-not-supplied", null);
	if (custody === null) return unobserved("custody-not-resolvable", null);
	if (custody.kind === "refused") return unobserved("custody-unresolved", null, { connectorCause: custody.refusal.connectorCause });
	const effective = custody.effective;
	if (effective?.mode === "keyless") {
		return { verdict: "not-applicable", basis: "effective-custody-keyless", observedAt: request.observedAt, boundary: "local", custody: { mode: effective.mode, source: effective.source } };
	}
	return unobserved(unobservedBasis, effective ? { mode: effective.mode, source: effective.source } : null);
}

function liveWrite(request: EvidenceRequest): Observation {
	if (request.adapter?.prepareWrite === undefined) return { verdict: "not-applicable", basis: "no-write-capability", observedAt: request.observedAt, boundary: "local" };
	return { verdict: "unobserved", basis: "status-reads-no-effect-receipt", observedAt: null, boundary: null };
}

const noProvider = (): Observation => ({ verdict: "unobserved", basis: "status-contacts-no-provider", observedAt: null, boundary: null });

// A manifest without an adapter is keyless; otherwise the adapter's own
// effective mode, and null when none is in effect.
function custodyMode(request: EvidenceRequest): string | null {
	if (request.manifest.adapter === null) return "keyless";
	return request.custody?.kind === "resolved" ? (request.custody.effective?.mode ?? null) : null;
}

function retained(request: EvidenceRequest, kind: ObservationKind): Observation {
	const verdict = readObservation({ manifest: request.manifest, kind, selectors: request.selectors, custodyMode: custodyMode(request), env: request.env, now: Date.parse(request.observedAt) });
	if (verdict.kind === "absent") return noProvider();
	if (verdict.kind === "rejected") return { verdict: "unobserved", basis: verdict.basis, observedAt: null, boundary: null };
	const { record } = verdict;
	const operation = record.operation === undefined ? {} : { operation: record.operation };
	return {
		verdict: "proven",
		basis: kind === "schema" ? "retained-hosted-keyless-schema" : "retained-hosted-keyless-read",
		observedAt: record.observedAt,
		boundary: "hosted",
		observation: { route: record.route, ...operation, binding: record.binding, validUntil: record.validUntil },
	};
}

function fixtureTested(request: EvidenceRequest): Observation {
	const verdict = readFixtureObservation(request.manifest, request.env, Date.parse(request.observedAt));
	if (verdict.kind === "absent") return { verdict: "unobserved", basis: "status-retains-no-fixture-observation", observedAt: null, boundary: null };
	if (verdict.kind === "rejected") return { verdict: "unobserved", basis: verdict.basis, observedAt: null, boundary: null };
	const { record } = verdict;
	return { verdict: "proven", basis: "retained-fixture-auth", observedAt: record.observedAt, boundary: "fixture", observation: { command: "connectors.fixtureAuth", binding: record.binding, validUntil: record.validUntil } };
}

export function observeEvidence(request: EvidenceRequest): Record<string, Observation> {
	return {
		configured: { verdict: "proven", basis: "manifest-registry-requirements-validated", observedAt: request.observedAt, boundary: "local" },
		localReady: localReady(request),
		custodyChecked: custodyState(request, "status-reads-no-credential"),
		authenticated: custodyState(request, "status-contacts-no-provider"),
		schemaQualified: retained(request, "schema"),
		liveReadProven: retained(request, "read"),
		liveWriteProven: liveWrite(request),
		fixtureTested: fixtureTested(request),
	};
}
