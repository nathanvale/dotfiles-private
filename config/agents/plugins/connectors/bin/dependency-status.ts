// Read-only dependency status for `connectors deps status` (Spec AC19). Each
// tool's selection owner applies the rule ordinary use applies; this module
// only names the one explicit route that owns a missing or refused
// selection. It never installs, repairs, creates state, or searches PATH.
import path from "node:path";
import { inspectSelectedMcporter } from "./mcporter-custody.ts";
import { stateRoot } from "./private-state.ts";
import type { EnvironmentSource } from "./safe-environment.ts";
import { inspectSelectedOp } from "./setup/op.ts";
import { inspectSelectedMise, inspectSelectedUv, type SelectionView } from "./setup/uv.ts";

export const DEPENDENCY_TOOLS = ["mcporter", "op", "mise", "uv"] as const;
export type DependencyTool = (typeof DEPENDENCY_TOOLS)[number];

export interface RepairRoute {
	readonly commandIdentity: string;
	readonly command: string;
}

export interface DependencyStatus {
	readonly tool: DependencyTool;
	readonly owner: "connectors";
	readonly required: string;
	readonly state: "absent" | "ready" | "not-ready";
	readonly ready: boolean;
	// Relative to the XDG state root, so no home or state path is public.
	readonly selected: { readonly executable: string; readonly version: string } | null;
	readonly cause: string | null;
	readonly repair: RepairRoute | null;
}

// Q13c: MCPorter's first use installs it; after that, and for op, mise, and
// uv at any time, C4's explicit repair preview owns a missing or refused
// selection and leads to its apply.
const FIRST_USE: RepairRoute = { commandIdentity: "connectors.run", command: "connectors run <connector> <operation>" };

const READERS: Readonly<Record<DependencyTool, (env: EnvironmentSource) => SelectionView>> = {
	mcporter: inspectSelectedMcporter,
	op: inspectSelectedOp,
	mise: inspectSelectedMise,
	uv: inspectSelectedUv,
};

// A fresh object per row: the envelope's JSON-safety check refuses a value
// reached twice, so rows never share one route object.
function repairFor(tool: DependencyTool, present: boolean): RepairRoute {
	if (tool === "mcporter" && !present) return { ...FIRST_USE };
	return { commandIdentity: "connectors.deps.repair.preview", command: `connectors deps repair ${tool} --preview` };
}

export function isDependencyTool(value: string): value is DependencyTool {
	return (DEPENDENCY_TOOLS as readonly string[]).includes(value);
}

export function dependencyStatus(env: EnvironmentSource, tools: readonly DependencyTool[]): DependencyStatus[] {
	const root = stateRoot(env);
	return tools.map((tool) => {
		const view = READERS[tool](env);
		const base = { tool, owner: "connectors" as const, required: view.required };
		if (view.executable) return { ...base, state: "ready", ready: true, selected: { executable: path.relative(root, view.executable), version: view.required }, cause: null, repair: null };
		return { ...base, state: view.present ? "not-ready" : "absent", ready: false, selected: null, cause: view.cause, repair: repairFor(tool, view.present) };
	});
}
