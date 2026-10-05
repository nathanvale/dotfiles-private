import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Executed, LocalEffect, Prepared, SchemaRequest } from "../../../bin/adapters/contract.ts";
import { OPERATION_NAMES, OPERATIONS, record } from "./catalogue.ts";
import { checkAccount, planNotionRoute, prepareVault, type AccountVault } from "./custody.ts";

const REPAIR = "Inspect the Notion account grant and retry schema; reconcile reported drift before using changed tools";
interface LiveTool { name: string; inputSchema: Record<string, unknown> }

function stamp(file: string): string | null {
	try { const stat = lstatSync(file, { bigint: true }); return `${stat.ino}:${stat.mtimeNs}:${stat.size}:${stat.mode}`; } catch { return null; }
}
function directoryStamp(vault: AccountVault): string {
	return [vault.root, vault.dataHome, vault.cacheHome].map((file) => { try { return lstatSync(file).mode; } catch { return "absent"; } }).join(",");
}
function observedEffects(vault: AccountVault, directories: string, vaultFile: string | null): LocalEffect[] {
	const effects: LocalEffect[] = [];
	if (directoryStamp(vault) !== directories) effects.push("account-vault");
	if (stamp(path.join(vault.dataHome, "mcporter/credentials.json")) !== vaultFile) effects.push("mcporter-vault-file");
	return effects;
}
function requiredKeys(tool: LiveTool): string[] {
	return Array.isArray(tool.inputSchema.required) ? [...tool.inputSchema.required as string[]].sort() : [];
}
function comparison(tools: LiveTool[]): Record<string, unknown> {
	const names = tools.map((tool) => tool.name);
	const missingTools = OPERATION_NAMES.filter((name) => !names.includes(name)).sort();
	const extraTools = names.filter((name) => !OPERATION_NAMES.includes(name)).sort();
	const requiredKeyDrift = tools.flatMap((tool) => {
		const operation = OPERATIONS.find((item) => item.name === tool.name);
		if (!operation) return [];
		const declared = [...operation.required].sort();
		const live = requiredKeys(tool);
		const added = live.filter((key) => !declared.includes(key));
		const removed = declared.filter((key) => !live.includes(key));
		return added.length + removed.length === 0 ? [] : [{ tool: tool.name, added, removed, declared, live }];
	});
	return { status: missingTools.length + extraTools.length + requiredKeyDrift.length === 0 ? "matched" : "drifted", missingTools, extraTools, requiredKeyDrift, scope: "tool-names-and-top-level-required-keys" };
}
function liveTools(value: unknown): LiveTool[] | null {
	if (!record(value) || value.status !== "ok" || !Array.isArray(value.tools)) return null;
	if (!value.tools.every((tool) => record(tool) && typeof tool.name === "string" && record(tool.inputSchema) && (tool.inputSchema.required === undefined || Array.isArray(tool.inputSchema.required) && tool.inputSchema.required.every((key) => typeof key === "string")))) return null;
	const tools = value.tools as LiveTool[];
	return new Set(tools.map((tool) => tool.name)).size === tools.length ? tools : null;
}

// The shipped registry is validated by the adapter first. Only this fixed
// list command receives an ephemeral unfiltered copy; calls always use the
// exact-name shipped allow-list. MCPorter remains the transport and vault owner.
export function prepareSchema(request: SchemaRequest): Prepared {
	const account = checkAccount(request.selectors.account);
	const { plan, vault } = planNotionRoute(request.env, account, ["list", "--schema", "--json"], request.skillsRoot);
	const registry = JSON.parse(readFileSync(plan.configPath, "utf8"));
	delete registry.mcpServers[plan.server].allowedTools;
	return { kind: "execute", async execute(capabilities): Promise<Executed> {
		const mcporter = await capabilities.selectMcporter();
		if (mcporter === null) return { kind: "failed", connectorCause: "mcporter-unselected", repair: REPAIR };
		const directories = directoryStamp(vault);
		const vaultFile = stamp(path.join(vault.dataHome, "mcporter/credentials.json"));
		let temporary: string | null = null;
		const failed = (cause: string): Executed => ({ kind: "failed", connectorCause: cause, repair: REPAIR, localEffects: observedEffects(vault, directories, vaultFile) });
		try {
			try { prepareVault(vault); } catch { return failed("vault-root-invalid"); }
			temporary = mkdtempSync(path.join(vault.cacheHome, "schema-"));
			const config = path.join(temporary, "mcporter.json");
			writeFileSync(config, JSON.stringify(registry), { mode: 0o600, flag: "wx" });
			const argv = [...plan.argv];
			argv[1] = config;
			const run = Bun.spawnSync([mcporter, ...argv], { env: plan.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
			if (run.exitCode !== 0) return failed("schema-list-failed");
			let live: unknown;
			try { live = JSON.parse(run.stdout.toString()); } catch { return failed("schema-list-invalid"); }
			const tools = liveTools(live);
			if (tools === null) return failed("schema-list-invalid");
			return { kind: "success", data: { account, live, allowedTools: OPERATION_NAMES, operations: OPERATIONS, comparison: comparison(tools), availability: { toolListing: "observed", planAndPermissionAccess: "not-inspected", nextStep: "Run notion-get-tool-access for current plan and permission restrictions" } }, localEffects: observedEffects(vault, directories, vaultFile) };
		} catch { return failed("schema-list-failed"); }
		finally { if (temporary !== null) rmSync(temporary, { recursive: true, force: true }); }
	} };
}
