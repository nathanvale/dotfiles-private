// Explicit dependency repair and update for `connectors deps repair <tool>`
// and `connectors deps update <revision>` (Spec AC19, AC16; C4). A preview
// records the exact planned effects against the observed selections and
// changes no dependency. An apply claims one preview with a durable receipt,
// under the deps lock, before at most one attempt per planned tool through
// that tool's own verified install primitive, stopping at the first failure.
// A preview whose observed selections changed is stale; a claimed preview is
// never applied again, whatever its outcome, so an interrupted or uncertain
// apply is never replayed. Repair converges one tool; update converges every
// present selection to the one requirements revision packaged in this build.
import path from "node:path";
import { DEPENDENCY_TOOLS, dependencyStatus, type DependencyStatus, type DependencyTool } from "./dependency-status.ts";
import { repairMcporter, withSelectionLock } from "./mcporter-custody.ts";
import { ownedDirectory, publishPrivateFileOnce, readPrivateFile, stateRoot, stateRootAdmitsSetup, writePrivateFile } from "./private-state.ts";
import type { EnvironmentSource } from "./safe-environment.ts";
import { downloadAndInstallMise, downloadAndInstallOp, type ReleaseSource } from "./setup/download.ts";
import { inspectSelectedMise, installPinnedUv } from "./setup/uv.ts";

export const PREVIEW_ID = /^[0-9a-f]{32}$/;

// The caller admits an update's revision before asking for its plan.
export type DepsRequest = { readonly kind: "repair"; readonly tool: DependencyTool } | { readonly kind: "update"; readonly revision: string };

// uv's installer is the plugin-owned mise, so a uv repair also observes mise;
// an update observes every declared tool.
const OBSERVED: Readonly<Record<DependencyTool, readonly DependencyTool[]>> = { mcporter: ["mcporter"], op: ["op"], mise: ["mise"], uv: ["uv", "mise"] };
const observedTools = (request: DepsRequest): readonly DependencyTool[] => (request.kind === "repair" ? OBSERVED[request.tool] : DEPENDENCY_TOOLS);
const toolEffect = (request: DepsRequest, tool: DependencyTool): string => `${tool}-${request.kind}`;
const receiptEffect = (request: DepsRequest): string => `deps-${request.kind}-receipt`;

export type PreviewResult =
	| { kind: "recorded"; previewId: string; observed: DependencyStatus[]; plannedEffects: string[] }
	| { kind: "ready"; observed: DependencyStatus[] }
	| { kind: "prerequisite"; nextAction: string; repairAction: string }
	| { kind: "state-invalid" };

// remaining names each planned effect the apply did not achieve.
export type ApplyResult =
	| { kind: "refused"; cause: "invalid" | "consumed" | "stale" | "locked" | "state-invalid" }
	| { kind: "completed" | "failed"; completed: string[]; remaining: string[] }
	| { kind: "unknown"; completed: string[]; uncertain: string; remaining: string[]; lockFailed?: true };

// Reports durable progress before each attempted effect, so a crash fallback
// can name what completed, what is uncertain, and what remains.
export type Progress = (completed: readonly string[], uncertain: string | null, remaining: readonly string[]) => void;

interface PreviewRecord {
	readonly previewId: string;
	readonly kind?: "update";
	readonly tool?: DependencyTool;
	readonly revision?: string;
	readonly required?: string;
	readonly observed: DependencyStatus[];
	readonly plannedEffects: string[];
	readonly plan?: DependencyTool[];
}

const depsRoot = (env: EnvironmentSource): string => path.join(stateRoot(env), "connectors", "deps");
const previewFile = (env: EnvironmentSource, id: string): string => path.join(depsRoot(env), "previews", `${id}.json`);
const receiptFile = (env: EnvironmentSource, id: string): string => path.join(depsRoot(env), "receipts", `${id}.json`);

const MISE_FIRST: PreviewResult = { kind: "prerequisite", nextAction: "connectors.deps.repair.preview", repairAction: "Run connectors deps repair mise --preview and apply it first" };

// Q13c: absent MCPorter is first use's to install. Update converges only
// present selections; an absent tool stays with its own setup or first use.
function planFor(request: DepsRequest, observed: DependencyStatus[]): DependencyTool[] | PreviewResult {
	if (request.kind === "repair") {
		if (observed[0]!.ready) return [];
		if (request.tool === "mcporter" && observed[0]!.state === "absent") return { kind: "prerequisite", nextAction: "connectors.run", repairAction: "MCPorter is not installed yet; run connectors run <connector> <operation> and first use installs it" };
		if (request.tool === "uv" && !observed[1]!.ready) return MISE_FIRST;
		return [request.tool];
	}
	const plan = observed.filter((row) => row.state === "not-ready").map((row) => row.tool);
	const mise = observed.find((row) => row.tool === "mise")!;
	if (plan.includes("uv") && !mise.ready && !plan.includes("mise")) return MISE_FIRST;
	return plan;
}

export function previewDeps(env: EnvironmentSource, request: DepsRequest): PreviewResult {
	const observed = dependencyStatus(env, observedTools(request));
	const plan = planFor(request, observed);
	if (!Array.isArray(plan)) return plan;
	if (plan.length === 0) return { kind: "ready", observed };
	const root = depsRoot(env);
	if (!stateRootAdmitsSetup(stateRoot(env)) || !ownedDirectory(path.join(root, "previews")).ok || !ownedDirectory(path.join(root, "receipts")).ok) return { kind: "state-invalid" };
	const previewId = crypto.randomUUID().replaceAll("-", "");
	const plannedEffects = plan.map((tool) => toolEffect(request, tool));
	const record: PreviewRecord = request.kind === "repair"
		? { previewId, tool: request.tool, required: observed[0]!.required, observed, plannedEffects }
		: { previewId, kind: "update", revision: request.revision, observed, plannedEffects, plan };
	const published = publishPrivateFileOnce(previewFile(env, previewId), JSON.stringify(record));
	if (!published.ok || !published.published) return { kind: "state-invalid" };
	return { kind: "recorded", previewId, observed, plannedEffects };
}

// The planned tools, or null when the record is not this request's preview.
function readPlan(env: EnvironmentSource, id: string, request: DepsRequest): { record: PreviewRecord; plan: DependencyTool[] } | null {
	const file = readPrivateFile(previewFile(env, id));
	if (!file.ok) return null;
	try {
		const record = JSON.parse(file.text) as PreviewRecord;
		if (record.previewId !== id || !Array.isArray(record.observed)) return null;
		if (request.kind === "repair") return record.kind === undefined && record.tool === request.tool ? { record, plan: [request.tool] } : null;
		return record.kind === "update" && record.revision === request.revision && Array.isArray(record.plan) && record.plan.every((tool) => DEPENDENCY_TOOLS.includes(tool)) ? { record, plan: record.plan } : null;
	} catch {
		return null;
	}
}

// One attempt's outcome: any MCPorter recovery completed first, and whether
// the tool's own effect committed.
type Attempt = { outcome: "ok" | "failed" | "unknown"; recovered: boolean; committed: boolean; lockFailed?: true };

// Download and extraction failures precede any selection write, so the
// selection is unchanged; an install-stage failure may have published bytes.
const UNCERTAIN_REASONS = new Set(["install-failed", "version-invalid"]);

async function attemptInstall(env: EnvironmentSource, tool: Exclude<DependencyTool, "mcporter">, pluginRoot: string): Promise<Attempt> {
	const source: ReleaseSource | undefined = env.CONNECTORS_TEST_RELEASE_ORIGIN ? { localReleaseOrigin: env.CONNECTORS_TEST_RELEASE_ORIGIN } : undefined;
	let result: { ok: true } | { ok: false; reason: string };
	if (tool === "op") result = await downloadAndInstallOp(source);
	else if (tool === "mise") result = await downloadAndInstallMise(source);
	else {
		const mise = inspectSelectedMise(env).executable;
		result = mise ? await installPinnedUv(mise, path.join(stateRoot(env), "connectors", "setup", "uv"), pluginRoot) : { ok: false, reason: "config-invalid" };
	}
	if (result.ok) return { outcome: "ok", recovered: false, committed: true };
	return { outcome: UNCERTAIN_REASONS.has(result.reason) ? "unknown" : "failed", recovered: false, committed: false };
}

// MCPorter's own repair keeps the previous revision until a verified
// replacement is selected, and reports any recovery it completed first.
async function attemptMcporter(env: EnvironmentSource): Promise<Attempt> {
	const result = await repairMcporter(env);
	if (result.ok) return { outcome: "ok", recovered: result.recovered, committed: true };
	if (result.effect === "unknown") return { outcome: "unknown", recovered: false, committed: false, ...(result.cause === "selection-lock-failed" ? { lockFailed: true as const } : {}) };
	return { outcome: "failed", recovered: result.effect === "recovered" || result.effect === "recovered-and-completed", committed: result.effect === "completed" || result.effect === "recovered-and-completed" };
}

// Folds one attempt into the apply's inventory: its durable effects join
// completed, and a failed or uncertain attempt ends the plan.
function settle(attempt: Attempt, effect: string, later: string[], completed: string[]): ApplyResult | null {
	if (attempt.recovered) completed.push("mcporter-recovery");
	if (attempt.committed) completed.push(effect);
	if (attempt.outcome === "unknown") return { kind: "unknown", completed, uncertain: effect, remaining: later, ...(attempt.lockFailed ? { lockFailed: true as const } : {}) };
	if (attempt.outcome === "failed") return { kind: "failed", completed, remaining: attempt.committed ? later : [effect, ...later] };
	return null;
}

async function runPlan(env: EnvironmentSource, request: DepsRequest, plan: readonly DependencyTool[], pluginRoot: string, progress: Progress): Promise<ApplyResult> {
	const completed = [receiptEffect(request)];
	for (const [index, tool] of plan.entries()) {
		const effect = toolEffect(request, tool);
		const later = plan.slice(index + 1).map((next) => toolEffect(request, next));
		progress(completed, effect, later);
		const attempt = tool === "mcporter" ? await attemptMcporter(env) : await attemptInstall(env, tool, pluginRoot);
		const ended = settle(attempt, effect, later, completed);
		if (ended) return ended;
	}
	return { kind: "completed", completed, remaining: [] };
}

async function applyLocked(env: EnvironmentSource, id: string, request: DepsRequest, pluginRoot: string, progress: Progress, started: () => void): Promise<ApplyResult> {
	const preview = readPlan(env, id, request);
	if (!preview) return { kind: "refused", cause: "invalid" };
	const claimed = readPrivateFile(receiptFile(env, id));
	if (claimed.ok || claimed.reason !== "absent") return { kind: "refused", cause: "consumed" };
	if (JSON.stringify(dependencyStatus(env, observedTools(request))) !== JSON.stringify(preview.record.observed)) return { kind: "refused", cause: "stale" };
	const receipt = { previewId: id, ...(request.kind === "repair" ? { tool: request.tool, required: preview.record.required } : { kind: "update", revision: request.revision }), plannedEffects: preview.record.plannedEffects };
	started();
	const published = publishPrivateFileOnce(receiptFile(env, id), JSON.stringify({ ...receipt, outcome: "started" }));
	// An unpublishable receipt claims nothing and precedes every attempt: the
	// preview stays unclaimed and no dependency changed.
	if (!published.ok) return { kind: "refused", cause: "state-invalid" };
	if (!published.published) return { kind: "refused", cause: "consumed" };
	const result = await runPlan(env, request, preview.plan, pluginRoot, progress);
	if (result.kind !== "refused") progress(result.completed, result.kind === "unknown" ? result.uncertain : null, result.remaining);
	// The envelope is the report of record; a failed outcome update leaves
	// the receipt "started", which still blocks any replay.
	writePrivateFile(receiptFile(env, id), JSON.stringify({ ...receipt, outcome: result.kind === "completed" && request.kind === "repair" ? "repaired" : result.kind }));
	return result;
}

export async function applyDeps(env: EnvironmentSource, id: string, request: DepsRequest, pluginRoot: string, progress: Progress): Promise<ApplyResult> {
	if (!readPlan(env, id, request)) return { kind: "refused", cause: "invalid" };
	let started = false;
	try {
		return await withSelectionLock(depsRoot(env), () => applyLocked(env, id, request, pluginRoot, progress, () => { started = true; }));
	} catch (error) {
		if (started) throw error;
		return { kind: "refused", cause: "locked" };
	}
}
