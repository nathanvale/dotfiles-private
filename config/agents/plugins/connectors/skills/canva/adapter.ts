// Canva's packaged adapter for the generic `connectors auth` and `run`
// commands (Ticket #93 under Spec #87). It composes the Canva custody
// interface unchanged: client-mode switch, per-account MCPorter vault, and the
// shared route plan. Paths come from the core's physical skills root, because
// the custody defaults resolve inside the compiled binary's virtual bundle.
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Adapter, AdapterRefusal, AdapterRequest, Committed, LocalEffect, Prepared } from "../../bin/adapters/contract.ts";
import { CanvaError } from "./scripts/contract.ts";
import { type AccountVault, accountVault, checkAccount, inspectVault, planCanvaRoute, prepareVault, readClientMode, requireAdmittedMode } from "./scripts/custody/index.ts";

const REPAIR: Readonly<Record<AdapterRefusal["kind"], string>> = {
	usage: "Check the connectors run or auth arguments against connectors --help",
	domain: "Resolve the named Canva precondition, then retry",
	schema: "Fix the packaged Canva configuration named by the cause",
	"verb-unsupported": "Canva supports auth status and auth login; run connectors auth status canva --select account=<slug>",
	"operation-unknown": "Use one of the Canva registry's allowed tools as the run operation",
	"client-mode-not-admitted": "Set mode to dcr in skills/canva/config/client.json; the approved client is not yet built",
};

function refused(kind: AdapterRefusal["kind"], connectorCause: string): Prepared {
	return { kind: "refused", refusal: { kind, connectorCause, repair: REPAIR[kind] } };
}

function fromCanvaError(error: CanvaError): AdapterRefusal {
	const kind = error.code === "client-mode-not-admitted" ? "client-mode-not-admitted" : error.exitCode === 2 ? "usage" : error.exitCode === 3 ? "domain" : "schema";
	return { kind, connectorCause: error.code, repair: REPAIR[kind] };
}

function allowedTools(configPath: string, server: string): readonly string[] {
	const registry = JSON.parse(readFileSync(configPath, "utf8")) as { mcpServers: Record<string, { allowedTools: string[] }> };
	return registry.mcpServers[server]?.allowedTools ?? [];
}

// Logout needs a MCPorter vault-reset verb the shared route does not admit
// yet, so only these two auth verbs exist for Canva.
const AUTH_VERBS = new Set(["status", "login"]);

function mcporterArgs(action: AdapterRequest["action"]): readonly string[] {
	if (action.kind === "auth") return ["auth"];
	const flags = action.input === null ? [] : ["--args", JSON.stringify(action.input)];
	return ["call", action.operation, ...flags, "--output", "json"];
}

// Metadata only: the vault file is never opened. MCPorter replaces it by
// rename, so any write changes its inode, modification time, or size.
function vaultFileStamp(vault: AccountVault): string | null {
	try {
		const stat = lstatSync(path.join(vault.dataHome, "mcporter", "credentials.json"), { bigint: true });
		return `${stat.ino}:${stat.mtimeNs}:${stat.size}`;
	} catch {
		return null;
	}
}

// Existence and mode of each directory prepareVault owns: it creates a missing
// one and narrows a wider one, and either change is an account-vault effect.
function vaultDirectoryStamp(vault: AccountVault): string {
	return [vault.root, vault.dataHome, vault.cacheHome].map((directory) => {
		try {
			return String(lstatSync(directory).mode);
		} catch {
			return "absent";
		}
	}).join(",");
}

// The vault file's metadata before MCPorter runs lets settle report a write
// without reading the file.
function vaultEffects(vault: AccountVault): { commit(): Committed; settle(): readonly LocalEffect[] } {
	let before: string | null = null;
	return {
		commit() {
			const directories = vaultDirectoryStamp(vault);
			let refusal: AdapterRefusal | null = null;
			try {
				prepareVault(vault);
			} catch (error) {
				if (!(error instanceof CanvaError)) throw error;
				refusal = fromCanvaError(error);
			}
			before = vaultFileStamp(vault);
			return { refusal, completed: vaultDirectoryStamp(vault) === directories ? [] : ["account-vault"] };
		},
		settle() {
			return vaultFileStamp(vault) === before ? [] : ["mcporter-vault-file"];
		},
	};
}

function prepareCanva(request: AdapterRequest): Prepared {
	const { action } = request;
	if (action.kind === "auth" && !AUTH_VERBS.has(action.verb)) return refused("verb-unsupported", "auth-verb-unsupported");
	const configDir = path.join(request.skillsRoot, "canva", "config");
	const account = checkAccount(request.selectors.account);
	const mode = readClientMode(configDir);
	if (action.kind === "auth" && action.verb === "status") {
		const { vaultFile, legacySession } = inspectVault(request.env, accountVault(request.env, account));
		// MCPorter writes a grant-free index on any call, so a present file
		// says nothing about a grant until something reads it.
		const grant = vaultFile === "present" ? "unknown" : "absent";
		return { kind: "inspected", data: { account, custody: "mcporter-native", clientMode: mode, clientModeAdmitted: mode === "dcr", vaultIndex: vaultFile, grant, legacySession } };
	}
	requireAdmittedMode(mode);
	const { plan, vault } = planCanvaRoute(request.env, account, mcporterArgs(action), request.skillsRoot);
	if (action.kind === "run" && !allowedTools(plan.configPath, plan.server).includes(action.operation)) {
		return refused("operation-unknown", "operation-not-allowed");
	}
	return {
		kind: "transport",
		effect: action.kind === "auth" ? "attended-login" : "read",
		argv: plan.argv,
		env: plan.env,
		data: { account, clientMode: mode },
		...vaultEffects(vault),
	};
}

function prepare(request: AdapterRequest): Prepared {
	try {
		return prepareCanva(request);
	} catch (error) {
		if (error instanceof CanvaError) return { kind: "refused", refusal: fromCanvaError(error) };
		throw error;
	}
}

export const canvaAdapter: Adapter = { id: "canva", prepare };
