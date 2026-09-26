// The account-key adapter: a keyless hosted MCP connector whose account API
// key is optional (Spec #87 AC26, Ticket #137). A Skill passes only its id,
// label, fixed endpoint, and Keychain leaf; this module owns everything else.
//
// keyless: with no registration, run and schema plan the Skill's keyless
// registry entry through the shared route, with no header or credential.
// account: `auth configure` records one 1Password item ID. From then on every
// run and schema goes through the `<id>-account` server, whose stdio command
// is this adapter's Provider role, the only process that reads the key. A
// missing, invalid, or rejected key refuses with a bounded repair; no branch
// ever falls back to the keyless entry while a registration exists.
//
// Both entries carry the identical exact allow-list, checked before any
// process starts. Every prepare step validates purely, and no refusal echoes
// caller input.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Adapter, AdapterRefusal, ExecutionCapabilities, Executed, Prepared, SchemaRequest } from "../adapters/contract.ts";
import { CREDENTIAL_VAULT, OP_SETUP_REPAIR, SERVICE_TOKEN_HANDOFF } from "../one-password-custody.ts";
import { planDispatcherRoute, RouteError } from "../provider-route.ts";
import { INTERNAL_INVOCATION_CONTEXT_ENV, safeEnvironment } from "../safe-environment.ts";
import { accountContext, keyRejectedMarker, type ProviderConnector, runProvider } from "./provider.ts";
import { accountMode, configureAccount, isItemId, itemIdRepair } from "./registration.ts";

export interface AccountKeyConnector extends ProviderConnector {
	readonly label: string;
}

const CALL_TIMEOUT_MS = "30000";
const PROVIDER_FAILURE = /-provider:error:([a-z-]+):/m;
const KEYLESS_KEYS = ["allowedTools", "baseUrl", "description"];
const ACCOUNT_KEYS = ["allowedTools", "args", "command", "description", "env"];

type RefusalKind = AdapterRefusal["kind"];
const refused = (kind: RefusalKind, connectorCause: string, repair: string): Prepared => ({ kind: "refused", refusal: { kind, connectorCause, repair } });
const refusedExecution = (connectorCause: string, repair: string): Executed => ({ kind: "refused", refusal: { kind: "domain", connectorCause, repair } });

const sameList = (left: unknown, right: unknown): boolean => Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);
const hasKeys = (entry: Record<string, unknown> | undefined, keys: readonly string[]): entry is Record<string, unknown> => entry !== undefined && sameList(Object.keys(entry).sort(), keys);

// The keyless allow-list, only when the registry holds exactly the keyless
// entry and the packaged account entry with the identical allow-list.
function allowedTools(connector: AccountKeyConnector, skillsRoot: string): readonly string[] | null {
	let servers: Record<string, Record<string, unknown>>;
	try {
		servers = (JSON.parse(readFileSync(path.join(skillsRoot, connector.id, "config", "mcporter.json"), "utf8")) as { mcpServers: Record<string, Record<string, unknown>> }).mcpServers;
	} catch {
		return null;
	}
	const keyless = servers[connector.id];
	const account = servers[`${connector.id}-account`];
	if (!sameList(Object.keys(servers).sort(), [connector.id, `${connector.id}-account`].sort())) return null;
	if (!hasKeys(keyless, KEYLESS_KEYS) || !hasKeys(account, ACCOUNT_KEYS)) return null;
	const packaged = account.command === "../../../bin/connectors" && sameList(account.args, ["__internal", connector.id, "provider"]) && JSON.stringify(account.env) === JSON.stringify({ [INTERNAL_INVOCATION_CONTEXT_ENV]: `\${${INTERNAL_INVOCATION_CONTEXT_ENV}}` });
	return packaged && sameList(keyless.allowedTools, account.allowedTools) ? (keyless.allowedTools as string[]) : null;
}

function keyHandoff(connector: AccountKeyConnector, item: string): string {
	return `store the ${connector.label} API key yourself in the credential field of the 1Password item with ID ${item}, the ID auth configure recorded, in the ${CREDENTIAL_VAULT} vault; Connectors never creates, rotates, or imports a key, and never falls back to keyless mode while ${connector.label} is registered`;
}

function preflightRepair(connector: AccountKeyConnector, code: string, item: string): string {
	if (code === "op-unavailable") return OP_SETUP_REPAIR;
	if (code === "service-token-missing") return SERVICE_TOKEN_HANDOFF;
	if (code === "item-missing" || code === "credential-invalid") return keyHandoff(connector, item);
	return `${connector.label} account custody could not produce the key; run connectors auth check ${connector.id}`;
}

// The Provider's readiness, run with exactly the environment the route gives
// it; MCPorter flattens a stdio child's startup refusal, so this keeps the
// closed cause. null when ready.
function preflight(connector: AccountKeyConnector, request: SchemaRequest, item: string, capabilities: ExecutionCapabilities): Executed | null {
	const run = Bun.spawnSync([...capabilities.internalCommand("provider"), "--preflight"], { env: { ...safeEnvironment(request.env), [INTERNAL_INVOCATION_CONTEXT_ENV]: accountContext(item) }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	if (run.exitCode === 0 && run.stdout.length === 0 && run.stderr.length === 0) return null;
	const code = PROVIDER_FAILURE.exec(run.stderr.toString())?.[1] ?? "provider-unready";
	return refusedExecution(code, preflightRepair(connector, code, item));
}

// MCPorter 0.14.0 exits 1 on a tool result with isError and still prints it;
// any other failure is its own report. A rejected key leaves the relay's
// fixed marker in that report.
function accountResult(connector: AccountKeyConnector, item: string, exitCode: number, stdout: string, stderr: string): { ok: true; data: unknown } | { ok: false; executed: Executed } {
	let data: unknown;
	try {
		data = JSON.parse(stdout);
	} catch {
		data = undefined;
	}
	const toolError = typeof data === "object" && data !== null && (data as { isError?: unknown }).isError === true;
	const marker = keyRejectedMarker(connector.id);
	if (exitCode !== 0 && `${stdout}\n${stderr}`.includes(marker)) {
		return { ok: false, executed: refusedExecution("key-rejected", `${connector.label} rejected the API key in the 1Password item with ID ${item}; ${keyHandoff(connector, item)}`) };
	}
	if (exitCode === 0 && data !== undefined && !toolError) return { ok: true, data };
	const cause = toolError ? "tool-error" : "transport-failed";
	return { ok: false, executed: { kind: "failed", connectorCause: cause, repair: `The ${connector.label} account request did not complete; check the input against connectors schema ${connector.id}, then run it again` } };
}

// One MCPorter request through the account server: route plan, Provider
// preflight, and MCPorter selection happen before anything can leave.
function accountStep(connector: AccountKeyConnector, request: SchemaRequest, item: string, mcporterArgs: readonly string[], shape: (data: unknown) => Record<string, unknown>): Prepared {
	let plan: ReturnType<typeof planDispatcherRoute>;
	try {
		plan = planDispatcherRoute([connector.id, "--provider", `${connector.id}-account`, "--", ...mcporterArgs], request.skillsRoot, safeEnvironment(request.env), accountContext(item));
	} catch (error) {
		if (error instanceof RouteError) return refused(error.exitCode === 2 ? "usage" : "schema", `route-${error.code}`, `Restore skills/${connector.id}/config to the packaged registry`);
		throw error;
	}
	return {
		kind: "execute",
		async execute(capabilities) {
			const unready = preflight(connector, request, item, capabilities);
			if (unready) return unready;
			const mcporter = await capabilities.selectMcporter();
			if (mcporter === null) return refusedExecution("mcporter-unselected", "Run connectors deps repair mcporter");
			const run = Bun.spawnSync([mcporter, ...plan.argv], { env: plan.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
			const result = accountResult(connector, item, run.exitCode, run.stdout.toString(), run.stderr.toString());
			return result.ok ? { kind: "success", data: shape(result.data) } : result.executed;
		},
	};
}

function keylessStep(connector: AccountKeyConnector, request: SchemaRequest, mcporterArgs: readonly string[], data: Record<string, unknown>): Prepared {
	let plan: ReturnType<typeof planDispatcherRoute>;
	try {
		plan = planDispatcherRoute([connector.id, "--", ...mcporterArgs], request.skillsRoot, safeEnvironment(request.env), `${connector.id}-mode=keyless`);
	} catch (error) {
		if (error instanceof RouteError) return refused(error.exitCode === 2 ? "usage" : "schema", `route-${error.code}`, `Restore skills/${connector.id}/config to the packaged registry`);
		throw error;
	}
	return { kind: "transport", effect: "read", argv: plan.argv, env: plan.env, data: { mode: "keyless", ...data }, commit: () => ({ refusal: null, completed: [] }), settle: () => [] };
}

// Resolve the registry and mode, then hand the chosen mode to its step.
function modeStep(connector: AccountKeyConnector, request: SchemaRequest, keyless: (tools: readonly string[]) => Prepared, account: (tools: readonly string[], item: string) => Prepared): Prepared {
	const tools = allowedTools(connector, request.skillsRoot);
	if (tools === null) return refused("schema", "registry-invalid", `Restore skills/${connector.id}/config/mcporter.json: a keyless entry and the packaged ${connector.id}-account entry with the identical allowedTools`);
	const mode = accountMode(connector.id, connector.label, request.env);
	if (mode.kind === "invalid") return refused("domain", "registration-invalid", mode.repair);
	return mode.kind === "account" ? account(tools, mode.item) : keyless(tools);
}

function prepareRun(connector: AccountKeyConnector, request: SchemaRequest, operation: string, input: Readonly<Record<string, unknown>> | null): Prepared {
	const unknown = refused("operation-unknown", "operation-not-allowed", `Use one ${connector.label} tool from connectors schema ${connector.id}`);
	const args = ["call", operation, "--args", JSON.stringify(input ?? {}), "--output", "json", "--timeout", CALL_TIMEOUT_MS];
	return modeStep(
		connector,
		request,
		(tools) => (tools.includes(operation) ? keylessStep(connector, request, args, {}) : unknown),
		(tools, item) => (tools.includes(operation) ? accountStep(connector, request, item, args, (result) => ({ operation, mode: "account", result })) : unknown),
	);
}

function prepareSchema(connector: AccountKeyConnector, request: SchemaRequest): Prepared {
	const args = ["list", "--schema", "--json", "--timeout", CALL_TIMEOUT_MS];
	return modeStep(
		connector,
		request,
		(tools) => keylessStep(connector, request, args, { server: connector.id, allowedTools: tools }),
		(tools, item) => accountStep(connector, request, item, args, (schema) => ({ mode: "account", server: `${connector.id}-account`, allowedTools: tools, schema })),
	);
}

// Configure records the item ID only: no Keychain, 1Password, MCPorter, or
// Provider. Check proves custody through the Provider's own preflight and
// never starts MCPorter, so it never claims authentication.
function prepareAuth(connector: AccountKeyConnector, request: SchemaRequest, verb: string, input: Readonly<Record<string, unknown>> | null): Prepared {
	const configure = `connectors auth configure ${connector.id} --input '{"item":"<id>"}'`;
	if (verb === "configure") {
		const item = input !== null && Object.keys(input).join(",") === "item" && isItemId(input.item) ? input.item : null;
		if (item === null) return refused("schema", "item-reference-invalid", itemIdRepair(connector.id));
		return {
			kind: "execute",
			async execute(): Promise<Executed> {
				const configured = configureAccount(connector.id, connector.label, item, request.env);
				if (configured.kind === "refused") return refusedExecution(configured.cause, configured.repair);
				const data = { mode: "account", vault: CREDENTIAL_VAULT, item, nextStep: `connectors auth check ${connector.id}` };
				return configured.kind === "published" ? { kind: "recorded", effect: "custody-registration", data } : { kind: "success", data };
			},
		};
	}
	const mode = accountMode(connector.id, connector.label, request.env);
	if (mode.kind === "invalid") return refused("domain", "registration-invalid", mode.repair);
	if (verb === "status") {
		return { kind: "inspected", data: mode.kind === "account" ? { mode: "account", vault: CREDENTIAL_VAULT, item: mode.item, nextStep: `connectors auth check ${connector.id}` } : { mode: "keyless", nextStep: `to use an account key, run ${configure}` } };
	}
	if (verb !== "check") return refused("verb-unsupported", "auth-verb-unsupported", `${connector.label} supports auth configure, status, and check for its optional account key; keyless mode needs no auth`);
	if (mode.kind === "keyless") return refused("domain", "account-unregistered", `${connector.label} is in keyless mode, which needs no custody check; to use an account key, run ${configure} first`);
	const { item } = mode;
	return {
		kind: "execute",
		async execute(capabilities) {
			return preflight(connector, request, item, capabilities) ?? { kind: "success", data: { custodyChecked: true, vault: CREDENTIAL_VAULT, item } };
		},
	};
}

export function accountKeyAdapter(connector: AccountKeyConnector): Adapter {
	return {
		id: connector.id,
		prepare(request) {
			const { action } = request;
			return action.kind === "auth" ? prepareAuth(connector, request, action.verb, action.input) : prepareRun(connector, request, action.operation, action.input);
		},
		prepareSchema: (request) => prepareSchema(connector, request),
		internalRoles: { provider: { run: (argv) => runProvider(connector, argv) } },
	};
}
