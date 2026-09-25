// Human rendering of the inventory and the decision card. Plain text, never JSON; the machine envelope carries the
// same facts under result.data.
import type { DecisionCard, Inventory } from "./card.ts"

type Sources = Inventory["sources"]
type InventoryRoute = Inventory["routes"][number]
type Gap = Inventory["gaps"][number]

function freshnessText(value: { state: string; observedAt: string | null; ageDays: number | null }): string {
	if (value.state === "not-observed") return "not observed"
	if (value.state === "invalid") return `invalid timestamp ${value.observedAt}`
	return `${value.state}, ${value.ageDays} days, observed ${value.observedAt}`
}

function sourceLines(sources: Sources): string[] {
	const host = sources.host.role === null ? `unknown (${sources.host.reason})` : sources.host.role
	const monash = sources.monash.status === "observed" ? `snapshot ${freshnessText(sources.monash.snapshot)}; ${sources.monash.unqualifiedCombinations} unqualified combinations not listed` : sources.monash.status
	const harnesses = Object.entries(sources.harnesses).map(([name, value]) => `${name} ${value?.version ?? value?.status}`)
	return [
		`Routes file: ${sources.routesFile.path} (${sources.routesFile.status})`,
		`This host: ${host}`,
		`Monash: ${monash}`,
		`Harnesses: ${harnesses.length === 0 ? "none probed" : harnesses.join(", ")}`,
	]
}

function routeLines(route: InventoryRoute): string[] {
	const alias = route.model.alias === null ? "" : ` (alias ${route.model.alias})`
	const hosts = route.origin === "routes-file" ? `declared ${route.hosts.declared.join(", ")}` : `qualified ${route.hosts.qualified.join(", ") || "none mapped"}`
	const account = `${route.account.alias ?? "no alias"}, ${route.account.ownership}${route.account.plan === null ? "" : ` (${route.account.plan})`}, proof ${route.account.proof}`
	return [
		`${route.id} [${route.origin}]`,
		`  harness ${route.harness} ${route.harnessVersion ?? "(version not observed)"}; model ${route.model.id}${alias}`,
		`  effort declared ${route.effort.declared ?? "unknown"}, observed ${route.effort.observed}; hosts ${hosts}; launch ${route.launch}`,
		`  account ${account}`,
		`  quota ${route.quota.state} (${freshnessText(route.quota.freshness)})${route.availability === null ? "" : `; availability ${route.availability.state} (${freshnessText(route.availability.freshness)})`}`,
		`  model guide ${route.modelGuide.status}${route.modelGuide.revision === null ? "" : ` sha256 ${route.modelGuide.revision}`}`,
	]
}

function gapLines(gaps: Gap[]): string[] {
	return [`Gaps (${gaps.length}):`, ...gaps.map((gap) => `  ${gap.id} ${gap.routes.join(", ")}: ${gap.field}: ${gap.reason} (owner: ${gap.owner})`)]
}

export function renderInventory(value: Inventory): string {
	return [
		"Agent Router route inventory (inspect only)",
		...sourceLines(value.sources),
		`Freshness: evidence older than ${value.freshnessDays} days is stale.`,
		"",
		...value.routes.flatMap((route) => [...routeLines(route), ""]),
		...gapLines(value.gaps),
	].join("\n")
}

function pickLines(pick: DecisionCard["pick"]): string[] {
	const head = "Provisional pick (TypeSafe not consulted):"
	if (pick.status === "none-eligible") return [head, "  none: no route passes every gate."]
	if (pick.status === "ask") return [head, `  ask Nathan: ${pick.candidates.length} routes qualify (${pick.candidates.join(", ")}).`]
	const confirm = pick.confirmations.length === 0 ? "" : `; Nathan must confirm ${pick.confirmations.join(", ")}`
	return [head, `  ${pick.status}: ${pick.route}${confirm}.`, `  Model Guide revision: ${pick.modelGuideRevision ?? "none"}`]
}

export function renderCard(card: DecisionCard): string {
	const target = card.target.status === "not-given" ? "not given" : `project ${card.target.project} under ${card.target.root} (${card.target.status})`
	return [
		`Agent Router decision card (dry run) for Task ${card.task}`,
		`Herdr Projects target: ${target}`,
		...sourceLines(card.sources),
		`Gates, in order: ${card.gateOrder.map((gate) => `${gate.gate} ${gate.name}`).join("; ")}.`,
		"",
		...card.routes.flatMap((route) => [
			`${route.id}: ${route.decision}${route.refusal === null ? "" : ` at ${route.refusal.gate}: ${route.refusal.reason}`}`,
			...route.gates.map((gate) => `  ${gate.gate} ${gate.verdict} [${gate.evidence}] ${gate.reason}`),
			"",
		]),
		...pickLines(card.pick),
		"",
		...gapLines(card.gaps),
	].join("\n")
}
