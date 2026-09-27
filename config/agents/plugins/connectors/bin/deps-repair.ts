// Explicit dependency repair for `connectors deps repair <tool>` (Spec AC19,
// AC16; C4). A preview records the exact planned effect against the observed
// selection and changes no dependency. An apply claims one preview with a
// durable receipt, under the deps lock, before at most one attempt through the
// tool's own verified install primitive. A preview whose observed selection
// changed is stale; a claimed preview is never applied again, whatever its
// outcome, so an interrupted or uncertain apply is never replayed.
import path from "node:path";
import { dependencyStatus, type DependencyStatus, type DependencyTool } from "./dependency-status.ts";
import { repairMcporter, withSelectionLock } from "./mcporter-custody.ts";
import { ownedDirectory, publishPrivateFileOnce, readPrivateFile, stateRoot, stateRootAdmitsSetup, writePrivateFile } from "./private-state.ts";
import type { EnvironmentSource } from "./safe-environment.ts";
import { downloadAndInstallMise, downloadAndInstallOp, type ReleaseSource } from "./setup/download.ts";
import { inspectSelectedMise, installPinnedUv } from "./setup/uv.ts";

export const PREVIEW_ID = /^[0-9a-f]{32}$/;
const RECEIPT_EFFECT = "deps-repair-receipt";

// uv's installer is the plugin-owned mise, so its preview also observes mise.
const OBSERVED: Readonly<Record<DependencyTool, readonly DependencyTool[]>> = { mcporter: ["mcporter"], op: ["op"], mise: ["mise"], uv: ["uv", "mise"] };

export type PreviewResult =
	| { kind: "recorded"; previewId: string; tool: DependencyTool; required: string; observed: DependencyStatus[]; plannedEffects: string[] }
	| { kind: "ready"; tool: DependencyTool; required: string; observed: DependencyStatus[] }
	| { kind: "prerequisite"; nextAction: string; repairAction: string }
	| { kind: "state-invalid" };

export type ApplyResult =
	| { kind: "refused"; cause: "invalid" | "consumed" | "stale" | "locked" }
	| { kind: "repaired" | "failed"; completed: string[] }
	| { kind: "unknown"; completed: string[]; uncertain: string; lockFailed?: true };

// Reports durable progress before each attempted effect, so a crash fallback
// can name what completed and what is uncertain.
export type Progress = (completed: readonly string[], uncertain: string | null) => void;

interface PreviewRecord {
	readonly previewId: string;
	readonly tool: DependencyTool;
	readonly required: string;
	readonly observed: DependencyStatus[];
	readonly plannedEffects: string[];
}

const depsRoot = (env: EnvironmentSource): string => path.join(stateRoot(env), "connectors", "deps");
const previewFile = (env: EnvironmentSource, id: string): string => path.join(depsRoot(env), "previews", `${id}.json`);
const receiptFile = (env: EnvironmentSource, id: string): string => path.join(depsRoot(env), "receipts", `${id}.json`);

function prerequisite(tool: DependencyTool, observed: DependencyStatus[]): PreviewResult | null {
	if (tool === "mcporter" && observed[0]!.state === "absent") return { kind: "prerequisite", nextAction: "connectors.run", repairAction: "MCPorter is not installed yet; run connectors run <connector> <operation> and first use installs it" };
	if (tool === "uv" && !observed[1]!.ready) return { kind: "prerequisite", nextAction: "connectors.deps.repair.preview", repairAction: "Run connectors deps repair mise --preview and apply it first" };
	return null;
}

export function previewRepair(env: EnvironmentSource, tool: DependencyTool): PreviewResult {
	const observed = dependencyStatus(env, OBSERVED[tool]);
	const target = observed[0]!;
	if (target.ready) return { kind: "ready", tool, required: target.required, observed };
	const blocked = prerequisite(tool, observed);
	if (blocked) return blocked;
	const root = depsRoot(env);
	if (!stateRootAdmitsSetup(stateRoot(env)) || !ownedDirectory(path.join(root, "previews")).ok || !ownedDirectory(path.join(root, "receipts")).ok) return { kind: "state-invalid" };
	const record: PreviewRecord = { previewId: crypto.randomUUID().replaceAll("-", ""), tool, required: target.required, observed, plannedEffects: [`${tool}-repair`] };
	const published = publishPrivateFileOnce(previewFile(env, record.previewId), JSON.stringify(record));
	if (!published.ok || !published.published) return { kind: "state-invalid" };
	return { kind: "recorded", ...record };
}

function readPreview(env: EnvironmentSource, id: string, tool: DependencyTool): PreviewRecord | null {
	const file = readPrivateFile(previewFile(env, id));
	if (!file.ok) return null;
	try {
		const record = JSON.parse(file.text) as PreviewRecord;
		return record.previewId === id && record.tool === tool && Array.isArray(record.observed) ? record : null;
	} catch {
		return null;
	}
}

// Download and extraction failures precede any selection write, so the
// selection is unchanged; an install-stage failure may have published bytes.
const UNCERTAIN_REASONS = new Set(["install-failed", "version-invalid"]);

async function attemptInstall(env: EnvironmentSource, tool: Exclude<DependencyTool, "mcporter">, pluginRoot: string): Promise<ApplyResult> {
	const source: ReleaseSource | undefined = env.CONNECTORS_TEST_RELEASE_ORIGIN ? { localReleaseOrigin: env.CONNECTORS_TEST_RELEASE_ORIGIN } : undefined;
	const effect = `${tool}-repair`;
	let result: { ok: true } | { ok: false; reason: string };
	if (tool === "op") result = await downloadAndInstallOp(source);
	else if (tool === "mise") result = await downloadAndInstallMise(source);
	else {
		const mise = inspectSelectedMise(env).executable;
		result = mise ? await installPinnedUv(mise, path.join(stateRoot(env), "connectors", "setup", "uv"), pluginRoot) : { ok: false, reason: "config-invalid" };
	}
	if (result.ok) return { kind: "repaired", completed: [RECEIPT_EFFECT, effect] };
	if (UNCERTAIN_REASONS.has(result.reason)) return { kind: "unknown", completed: [RECEIPT_EFFECT], uncertain: effect };
	return { kind: "failed", completed: [RECEIPT_EFFECT] };
}

// MCPorter's own repair keeps the previous revision until a verified
// replacement is selected, and reports any recovery it completed first.
async function attemptMcporter(env: EnvironmentSource): Promise<ApplyResult> {
	const result = await repairMcporter(env);
	if (result.ok) return { kind: "repaired", completed: [RECEIPT_EFFECT, ...(result.recovered ? ["mcporter-recovery"] : []), "mcporter-repair"] };
	if (result.effect === "unknown") return { kind: "unknown", completed: [RECEIPT_EFFECT], uncertain: "mcporter-repair", ...(result.cause === "selection-lock-failed" ? { lockFailed: true as const } : {}) };
	const recovered = result.effect === "recovered" || result.effect === "recovered-and-completed" ? ["mcporter-recovery"] : [];
	const committed = result.effect === "completed" || result.effect === "recovered-and-completed" ? ["mcporter-repair"] : [];
	return { kind: "failed", completed: [RECEIPT_EFFECT, ...recovered, ...committed] };
}

async function applyLocked(env: EnvironmentSource, id: string, tool: DependencyTool, pluginRoot: string, progress: Progress, started: () => void): Promise<ApplyResult> {
	const preview = readPreview(env, id, tool);
	if (!preview) return { kind: "refused", cause: "invalid" };
	const claimed = readPrivateFile(receiptFile(env, id));
	if (claimed.ok || claimed.reason !== "absent") return { kind: "refused", cause: "consumed" };
	if (JSON.stringify(dependencyStatus(env, OBSERVED[tool])) !== JSON.stringify(preview.observed)) return { kind: "refused", cause: "stale" };
	const receipt = { previewId: id, tool, required: preview.required, plannedEffects: preview.plannedEffects };
	started();
	const published = publishPrivateFileOnce(receiptFile(env, id), JSON.stringify({ ...receipt, outcome: "started" }));
	if (!published.ok) throw new Error("receipt-unwritable");
	if (!published.published) return { kind: "refused", cause: "consumed" };
	progress([RECEIPT_EFFECT], `${tool}-repair`);
	const result = tool === "mcporter" ? await attemptMcporter(env) : await attemptInstall(env, tool, pluginRoot);
	progress(result.kind === "refused" ? [] : result.completed, result.kind === "unknown" ? result.uncertain : null);
	// The envelope is the report of record; a failed outcome update leaves
	// the receipt "started", which still blocks any replay.
	writePrivateFile(receiptFile(env, id), JSON.stringify({ ...receipt, outcome: result.kind }));
	return result;
}

export async function applyRepair(env: EnvironmentSource, id: string, tool: DependencyTool, pluginRoot: string, progress: Progress): Promise<ApplyResult> {
	if (!readPreview(env, id, tool)) return { kind: "refused", cause: "invalid" };
	let started = false;
	try {
		return await withSelectionLock(depsRoot(env), () => applyLocked(env, id, tool, pluginRoot, progress, () => { started = true; }));
	} catch (error) {
		if (started) throw error;
		return { kind: "refused", cause: "locked" };
	}
}
