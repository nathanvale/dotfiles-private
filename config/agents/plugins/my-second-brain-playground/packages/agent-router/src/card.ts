// The U1-shaped decision card (D3): gates G1 to G5 in order for every route, one refusal per route, unknown kept
// distinct from stale, a provisional pick without TypeSafe (D10), owned gaps, the Herdr Projects target and the
// Model Guide revision. Pure over the declarations and evidence; it performs no reads of its own.
//
// No owner yet observes account identity or quota, so G3 and G4 are always unknown: a personal route can reach at
// best needs-confirmation (D4, D5), and an employer or shared route is refused. S4 adds observed evidence.
import type { DeclaredRoute, Harness, Ownership, RoutesFile } from "./declarations.ts"
import type { Evidence, GuideEvidence, HarnessEvidence, MonashRoute } from "./evidence.ts"
import { FRESHNESS_DAYS, type Freshness, freshness } from "./freshness.ts"

const GATE_ORDER = [
	{ gate: "G1", name: "model listed" },
	{ gate: "G2", name: "available on host" },
	{ gate: "G3", name: "account ownership and identity" },
	{ gate: "G4", name: "quota and reserve" },
	{ gate: "G5", name: "route qualification" },
] as const

type GateId = (typeof GATE_ORDER)[number]["gate"]
type Verdict = "pass" | "confirm" | "refuse"
type EvidenceState = "declared" | "observed" | "unknown" | "stale"

interface GateResult {
	gate: GateId
	verdict: Verdict
	evidence: EvidenceState
	reason: string
}

interface Route {
	id: string
	origin: "routes-file" | "monash-snapshot"
	harness: Harness
	harnessVersion: string | null
	model: { id: string; alias: string | null; listedBy: string }
	effort: { declared: string | null; observed: "unknown" }
	account: { alias: string | null; ownership: Ownership; plan: string | null; proof: "unknown" }
	quota: { state: "unknown"; freshness: Freshness }
	hosts: { declared: string[]; qualified: string[]; unmappedEvidenceHosts: number }
	availability: { state: string; freshness: Freshness } | null
	launch: "allowed" | "dry-run-only" | "not-declared"
	protocols: string[]
	modelGuide: { status: GuideEvidence["status"]; path: string; revision: string | null }
}

interface Gap {
	id: string
	routes: string[]
	field: string
	reason: string
	owner: string
}

function guideFacts(guide: GuideEvidence): Route["modelGuide"] {
	return { status: guide.status, path: guide.path, revision: guide.status === "reviewed" ? guide.sha256 : null }
}

const UNKNOWN_QUOTA: Route["quota"] = { state: "unknown", freshness: { state: "not-observed", observedAt: null, ageDays: null } }

function declaredRoute(route: DeclaredRoute, evidence: Evidence): Route {
	const harness: HarnessEvidence | undefined = evidence.harnesses[route.harness]
	return {
		id: route.id,
		origin: "routes-file",
		harness: route.harness,
		harnessVersion: harness?.version ?? null,
		model: { id: route.model.id, alias: route.model.alias ?? null, listedBy: "routes file declaration" },
		effort: { declared: route.effort, observed: "unknown" },
		account: { alias: route.account.alias, ownership: route.account.ownership, plan: route.account.plan ?? null, proof: "unknown" },
		quota: UNKNOWN_QUOTA,
		hosts: { declared: route.hosts, qualified: [], unmappedEvidenceHosts: 0 },
		availability: null,
		launch: route.launch,
		protocols: [],
		modelGuide: guideFacts(evidence.guide(route.harness, route.model.id)),
	}
}

function monashRoute(route: MonashRoute, evidence: Evidence, now: number): Route {
	return {
		id: route.id,
		origin: "monash-snapshot",
		harness: route.harness,
		harnessVersion: evidence.harnesses[route.harness]?.version ?? null,
		model: { id: route.modelId, alias: null, listedBy: "Monash snapshot" },
		effort: { declared: null, observed: "unknown" },
		account: { alias: null, ownership: "employer", plan: null, proof: "unknown" },
		quota: UNKNOWN_QUOTA,
		hosts: { declared: [], qualified: route.qualifiedHosts, unmappedEvidenceHosts: route.unmappedEvidenceHosts },
		availability: { state: route.availability, freshness: freshness(evidence.monash.snapshotObservedAt, now) },
		launch: "not-declared",
		protocols: route.protocols,
		modelGuide: guideFacts(evidence.guide(route.harness, route.modelId)),
	}
}

// ---- gates ----

/** Unknown evidence on a personal route asks Nathan (D4, D5); on any other route it refuses. */
function uncertain(route: Route, gate: GateId, reason: string): GateResult {
	const personal = route.account.ownership === "personal"
	const article = route.account.ownership === "employer" ? "an" : "a"
	return { gate, verdict: personal ? "confirm" : "refuse", evidence: "unknown", reason: personal ? `${reason}; Nathan must confirm` : `${reason}; ${article} ${route.account.ownership} route never launches on it` }
}

function gateModel(route: Route): GateResult {
	const alias = route.model.alias === null ? "" : ` (alias ${route.model.alias})`
	const evidence = route.origin === "routes-file" ? "declared" : "observed"
	return { gate: "G1", verdict: "pass", evidence, reason: `${route.model.id}${alias} listed by the ${route.model.listedBy}` }
}

function gateDeclaredHost(route: Route, evidence: Evidence): GateResult {
	const harness = evidence.harnesses[route.harness]
	if (harness?.status !== "observed") return { gate: "G2", verdict: "refuse", evidence: "unknown", reason: `${route.harness} is ${harness?.status ?? "not-found"} on this host (${harness?.source ?? "--version"})` }
	if (evidence.host.role === null) return uncertain(route, "G2", `this host's role is unknown: ${evidence.host.reason}`)
	if (!route.hosts.declared.includes(evidence.host.role)) {
		return { gate: "G2", verdict: "refuse", evidence: "observed", reason: `declared for ${route.hosts.declared.join(", ")}, but this host is ${evidence.host.role}` }
	}
	return { gate: "G2", verdict: "pass", evidence: "observed", reason: `${route.harness} ${harness.version} present; this host is ${evidence.host.role}` }
}

function gateMonashAvailability(route: Route): GateResult {
	const availability = route.availability
	if (availability === null || availability.state !== "available") return { gate: "G2", verdict: "refuse", evidence: "observed", reason: `the snapshot reports ${availability?.state ?? "no"} availability` }
	const fresh = availability.freshness
	if (fresh.state === "invalid") return { gate: "G2", verdict: "refuse", evidence: "unknown", reason: `the snapshot timestamp ${fresh.observedAt} is in the future or unreadable, so it is not evidence` }
	if (fresh.state === "stale") {
		return { gate: "G2", verdict: "refuse", evidence: "stale", reason: `available per a snapshot ${fresh.ageDays} days old (older than ${FRESHNESS_DAYS} days); stale evidence blocks launch` }
	}
	return { gate: "G2", verdict: "pass", evidence: "observed", reason: `available per the snapshot of ${fresh.observedAt}` }
}

function gateAccount(route: Route): GateResult {
	const label = route.account.alias === null ? `${route.account.ownership} account` : `declared alias ${route.account.alias}`
	return uncertain(route, "G3", `identity unknown for ${label}; no owner observes identity yet and a login is not proof`)
}

function gateQuota(route: Route): GateResult {
	if (route.origin === "monash-snapshot") return { gate: "G4", verdict: "refuse", evidence: "unknown", reason: "Monash reserve is refused until a supported usage source exists" }
	return uncertain(route, "G4", "quota unknown: no usage source observed")
}

function versionAtLeast(version: string | null, minimum: string | null): boolean {
	if (minimum === null) return true
	if (version === null) return false
	const have = version.split(".").map(Number)
	const need = minimum.split(".").map(Number)
	for (let index = 0; index < need.length; index += 1) {
		const difference = (have[index] ?? 0) - (need[index] ?? 0)
		if (difference !== 0) return difference > 0
	}
	return true
}

function qualificationProblems(route: Route, guide: GuideEvidence, evidence: Evidence): string[] {
	const problems: string[] = []
	if (route.origin === "monash-snapshot") {
		if (evidence.host.role === null) problems.push(`qualified on ${route.hosts.qualified.join(", ") || "no mapped host"}, but this host's role is unknown`)
		else if (!route.hosts.qualified.includes(evidence.host.role)) problems.push(`not qualified on this host (${evidence.host.role})`)
		problems.push("not declared for launch in the routes file (D1: dry run only)")
	} else if (route.launch === "dry-run-only") problems.push("declared dry-run-only")
	if (guide.status !== "reviewed") problems.push(guide.reason)
	else if (!versionAtLeast(route.harnessVersion, guide.harnessMinVersion)) problems.push(`the guide needs ${route.harness} ${guide.harnessMinVersion} or later`)
	return problems
}

function gateQualification(route: Route, evidence: Evidence): GateResult {
	const guide = evidence.guide(route.harness, route.model.id)
	const problems = qualificationProblems(route, guide, evidence)
	if (problems.length > 0) return { gate: "G5", verdict: "refuse", evidence: guide.status === "reviewed" ? "observed" : "unknown", reason: problems.join("; ") }
	return { gate: "G5", verdict: "pass", evidence: "observed", reason: `launch allowed; reviewed Model Guide ${guide.path}` }
}

function judge(route: Route, evidence: Evidence) {
	const host = route.origin === "routes-file" ? gateDeclaredHost(route, evidence) : gateMonashAvailability(route)
	const results = [gateModel(route), host, gateAccount(route), gateQuota(route), gateQualification(route, evidence)]
	const refusal = results.find((result) => result.verdict === "refuse") ?? null
	const confirmations = results.filter((result) => result.verdict === "confirm").map((result) => result.gate)
	return {
		...route,
		gates: results,
		decision: refusal === null ? "needs-confirmation" : "refused",
		refusal: refusal === null ? null : { gate: refusal.gate, reason: refusal.reason },
		confirmations,
	}
}

type JudgedRoute = ReturnType<typeof judge>

// ---- gaps ----

function routeGaps(route: Route): Omit<Gap, "id" | "routes">[] {
	const monash = route.origin === "monash-snapshot"
	const gaps: Omit<Gap, "id" | "routes">[] = [
		monash
			? { field: "effort", reason: "the snapshot does not state effort", owner: "Monash CLI owner or Agent Router" }
			: { field: "effort (observed)", reason: `declared ${route.effort.declared}; no inspect probe observes effort (D7)`, owner: "hpr-f5n.4 launch receipt" },
	]
	if (!monash) gaps.push({ field: "model (native setting)", reason: "declared only; launch must check the native setting (D2)", owner: "hpr-f5n.4 launch receipt" })
	gaps.push({ field: "account proof", reason: "identity unknown; no owner observes identity yet", owner: monash ? "Monash CLI owner" : "a non-secret identity source observed at launch (hpr-f5n.4)" })
	gaps.push({ field: "quota", reason: "no usage source observed", owner: monash ? "Monash CLI owner or Agent Router" : "a supported usage source" })
	if (route.modelGuide.status !== "reviewed") {
		gaps.push({ field: "model guide", reason: `${route.modelGuide.status}: no accepted guide for the exact harness and model`, owner: "Stage Manager skill guides (Code Reviewer acceptance)" })
	}
	if (route.hosts.unmappedEvidenceHosts > 0) {
		gaps.push({ field: "qualification host", reason: "evidence names a host that is neither this host's role nor a declared host", owner: "Monash snapshot owner" })
	}
	return gaps
}

function snapshotGap(evidence: Evidence, now: number): Omit<Gap, "id"> | null {
	if (evidence.monash.status !== "observed") return { routes: ["monash"], field: "Monash snapshot", reason: `snapshot ${evidence.monash.status}`, owner: "Monash CLI owner" }
	const fresh = freshness(evidence.monash.snapshotObservedAt, now)
	if (fresh.state === "stale") {
		return { routes: ["monash"], field: "snapshot freshness", reason: `observed ${fresh.observedAt}, older than ${FRESHNESS_DAYS} days`, owner: "Nathan (monash models --refresh is outside this command)" }
	}
	if (fresh.state === "invalid") return { routes: ["monash"], field: "snapshot freshness", reason: `observed_at ${fresh.observedAt} is in the future or unreadable`, owner: "Monash CLI owner" }
	return null
}

function sharedGaps(evidence: Evidence, now: number): Omit<Gap, "id">[] {
	const gaps: Omit<Gap, "id">[] = []
	if (evidence.host.role === null) gaps.push({ routes: ["all"], field: "this host's role", reason: evidence.host.reason, owner: "Monash Foundry installation manifest" })
	const snapshot = snapshotGap(evidence, now)
	if (snapshot !== null) gaps.push(snapshot)
	if (evidence.target.status !== "present") gaps.push({ routes: ["all"], field: "Herdr Projects target", reason: `target ${evidence.target.status}`, owner: "Stage Manager (--project and --herdr-projects-root)" })
	return gaps
}

function mergeGaps(routes: Route[], shared: Omit<Gap, "id">[]): Gap[] {
	const merged = new Map<string, Omit<Gap, "id">>()
	for (const route of routes) {
		for (const gap of routeGaps(route)) {
			const key = `${gap.field}|${gap.reason}|${gap.owner}`
			const existing = merged.get(key)
			if (existing === undefined) merged.set(key, { ...gap, routes: [route.id] })
			else existing.routes.push(route.id)
		}
	}
	return [...merged.values(), ...shared].map((gap, index) => ({ id: `GAP-${String(index + 1).padStart(2, "0")}`, ...gap }))
}

// ---- pick ----

function pick(routes: JudgedRoute[]) {
	const candidates = routes.filter((route) => route.decision !== "refused")
	const base = { provisional: true, typeSafe: "not-consulted", order: "routes file order, then Monash snapshot order" }
	const [only] = candidates
	if (only === undefined) return { ...base, status: "none-eligible", route: null, candidates: [], confirmations: [], modelGuideRevision: null }
	if (candidates.length > 1) return { ...base, status: "ask", route: null, candidates: candidates.map((route) => route.id), confirmations: [], modelGuideRevision: null }
	return { ...base, status: "needs-confirmation", route: only.id, candidates: [only.id], confirmations: only.confirmations, modelGuideRevision: only.modelGuide.revision }
}

// ---- public builders ----

export interface Inputs {
	routesFile: RoutesFile
	evidence: Evidence
	now: number
}

function routesOf(inputs: Inputs): Route[] {
	const { evidence, now } = inputs
	return [...inputs.routesFile.routes.map((route) => declaredRoute(route, evidence)), ...evidence.monash.routes.map((route) => monashRoute(route, evidence, now))]
}

function sources(inputs: Inputs) {
	const { evidence, now } = inputs
	return {
		routesFile: { path: inputs.routesFile.path, status: inputs.routesFile.status },
		monash: {
			status: evidence.monash.status,
			source: evidence.monash.source,
			readAt: evidence.monash.readAt,
			snapshot: freshness(evidence.monash.snapshotObservedAt, now),
			unqualifiedCombinations: evidence.monash.unqualifiedCombinations,
		},
		host: evidence.host,
		harnesses: evidence.harnesses,
	}
}

export function inventory(inputs: Inputs) {
	const routes = routesOf(inputs)
	return { generatedAt: new Date(inputs.now).toISOString(), freshnessDays: FRESHNESS_DAYS, sources: sources(inputs), routes, gaps: mergeGaps(routes, sharedGaps(inputs.evidence, inputs.now)) }
}

export type Inventory = ReturnType<typeof inventory>

export function decisionCard(task: string, inputs: Inputs) {
	const routes = routesOf(inputs)
	const judged = routes.map((route) => judge(route, inputs.evidence))
	return {
		task,
		generatedAt: new Date(inputs.now).toISOString(),
		mode: "dry-run",
		freshnessDays: FRESHNESS_DAYS,
		gateOrder: GATE_ORDER,
		target: inputs.evidence.target,
		sources: sources(inputs),
		routes: judged,
		pick: pick(judged),
		gaps: mergeGaps(routes, sharedGaps(inputs.evidence, inputs.now)),
	}
}

export type DecisionCard = ReturnType<typeof decisionCard>
