import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import registry from "./config/mcporter.json";
import type { Adapter, AdapterRefusal, Executed, ExecutionCapabilities, Prepared, SchemaRequest } from "../../bin/adapters/contract.ts";
import { inferenceInput, operationInput, record, TOOLS, TOOL_SCHEMAS } from "./scripts/catalogue.ts";
import { configureAccount, CREDENTIAL_VAULT, isItemId, ITEM_ID_REPAIR, registeredAccount } from "./scripts/custody/index.ts";
import { payloadDigest, receipt, receipts, reserve, runId, validRunId } from "./scripts/ledger.ts";
import { runProvider } from "./scripts/provider.ts";
import { accountCaller, providerPreflight } from "./scripts/transport.ts";
const REPAIR = "Inspect connectors recover jev; uncertain paid inference is never replayed automatically or unlocked";
function refused(kind: AdapterRefusal["kind"], connectorCause: string, repair = REPAIR): Prepared {
	return { kind: "refused", refusal: { kind, connectorCause, repair } };
}
function account(request: SchemaRequest, step: (item: string, capabilities: ExecutionCapabilities) => Promise<Executed>): Prepared {
	const registered = registeredAccount(request.env);
	return registered.ok
		? {
				kind: "execute",
				execute: (capabilities) => step(registered.item, capabilities),
			}
		: refused("domain", registered.cause, registered.repair);
}
function resultData(value: unknown): Record<string, unknown> | null {
	if (!record(value)) return null;
	if (typeof value.outcome === "string") return value;
	if (!Array.isArray(value.content)) return null;
	const [content] = value.content;
	if (!record(content) || content.type !== "text" || typeof content.text !== "string") return null;
	try {
		const parsed: unknown = JSON.parse(content.text);
		return record(parsed) ? parsed : null;
	} catch {
		return null;
	}
}
function run(request: SchemaRequest, operation: string, input: Readonly<Record<string, unknown>>): Prepared {
	if (!TOOLS.some((name) => name === operation)) return refused("operation-unknown", "operation-not-allowed", "Use list_models or system_one");
	if (!operationInput(operation, input))
		return refused(
			"schema",
			"input-invalid",
			"Use connectors schema jev; system_one requires requestKey, a pinned model, state and choice/noul questions, within 256 KiB and 64 nesting levels",
		);
	if (inferenceInput(input)) {
		const existing = receipt(request.env, runId(input.requestKey));
		if (existing) {
			if (existing.digest !== payloadDigest(input)) return refused("domain", "request-key-mismatch");
			if (existing.status !== "answered") return refused("domain", "inference-replay-blocked");
			return {
				kind: "inspected",
				data: { noCall: true, receipt: existing, resultNotRetained: true },
			};
		}
	}
	return account(request, async (item, capabilities) => {
		const caller = accountCaller(request.env, request.skillsRoot, item, capabilities);
		const ready = await caller.prepare(operation, input);
		if (!ready.ok)
			return {
				kind: "refused",
				refusal: {
					kind: "domain",
					connectorCause: ready.cause,
					repair: ready.repair,
				},
			};
		if (!inferenceInput(input)) {
			const sent = ready.send();
			const data = sent.ok ? resultData(sent.data) : null;
			return data?.outcome === "listed"
				? { kind: "success", data }
				: {
						kind: "failed",
						connectorCause: "models-call-failed",
						repair: "Check connectors auth check jev, then retry list_models",
					};
		}
		const reserved = reserve(request.env, input);
		if (reserved === null) {
            ready.dispose();
			return {
				kind: "refused",
				refusal: {
					kind: "domain",
					connectorCause: "ledger-reservation-refused",
					repair: REPAIR,
				},
			};
        }
		const sent = ready.send();
		const current = receipt(request.env, reserved.runId);
		const data = sent.ok ? resultData(sent.data) : null;
		if (data?.outcome === "answered" && current?.status === "answered")
			return {
				kind: "inference-completed",
				data: { ...data, runId: reserved.runId },
			};
		return {
			kind: "inference-unknown",
			data: { runId: reserved.runId, receipt: current ?? reserved },
			repair: REPAIR,
		};
	});
}
export const jevAdapter: Adapter = {
	id: "jev",
	prepare(request) {
        try {
            const actual: unknown = JSON.parse(readFileSync(path.join(request.skillsRoot, "jev/config/mcporter.json"), "utf8"));
            const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
            if (hash(actual) !== hash(registry)) return refused("domain", "registry-invalid", "Restore the exact packaged JEV registry");
        } catch { return refused("domain", "registry-invalid", "Restore the exact packaged JEV registry"); }
		const { action } = request;
		if (action.kind === "run") return run(request, action.operation, action.input ?? {});
		if (action.verb === "configure") {
			const input = action.input;
			if (!input || Object.keys(input).join(",") !== "item" || !isItemId(input.item)) return refused("schema", "item-reference-invalid", ITEM_ID_REPAIR);
			const item = input.item;
			return {
				kind: "execute",
				async execute() {
					const configured = configureAccount(item, request.env);
					if (configured.kind === "refused")
						return {
							kind: "refused",
							refusal: {
								kind: "domain",
								connectorCause: configured.cause,
								repair: configured.repair,
							},
						};
					const data = {
						vault: CREDENTIAL_VAULT,
						item,
						nextStep: "connectors auth check jev",
					};
					return configured.kind === "published" ? { kind: "recorded", effect: "custody-registration", data } : { kind: "success", data };
				},
			};
		}
		if (action.verb === "status") {
			const registered = registeredAccount(request.env);
			return registered.ok
				? {
						kind: "inspected",
						data: {
							registration: "registered",
							vault: CREDENTIAL_VAULT,
							item: registered.item,
						},
					}
				: registered.cause === "account-unregistered"
					? {
							kind: "inspected",
							data: { registration: "absent", nextStep: registered.repair },
						}
					: refused("domain", registered.cause, registered.repair);
		}
		if (action.verb === "check")
			return account(request, async (item, capabilities) => {
				const unready = providerPreflight(request.env, item, capabilities);
				return unready
					? {
							kind: "refused",
							refusal: {
								kind: "domain",
								connectorCause: unready.cause,
								repair: unready.repair,
							},
						}
					: {
							kind: "success",
							data: { custodyChecked: true, authenticated: false },
						};
			});
		return refused("verb-unsupported", "auth-verb-unsupported", "JEV supports auth configure, status and check");
	},
	prepareSchema() {
		return {
			kind: "inspected",
			data: {
				schemaSource: "packaged-declaration",
				tools: TOOL_SCHEMAS,
				liveSchemaQualified: false,
			},
		};
	},
	prepareRecover(request) {
		if (request.recovery.kind !== "inspect") return refused("usage", "inference-inspect-only", REPAIR);
		if (request.runId !== null && !validRunId(request.runId)) return refused("usage", "run-invalid");
		const found = request.runId === null ? receipts(request.env) : receipt(request.env, request.runId);
		return found === null
			? refused("domain", "ledger-unavailable")
			: {
					kind: "inspected",
					data: {
						receipts: Array.isArray(found) ? found : [found],
						remoteOutcomeResolved: false,
						replayPermitted: false,
					},
				};
	},
	resolveCustody(request) {
		const registered = registeredAccount(request.env);
		if (registered.ok)
			return {
				kind: "resolved",
				effective: {
					mode: "1password-below-mcporter",
					source: "plugin-state:registration",
				},
				notYetEffective: null,
				subject: null,
			};
		return registered.cause === "registration-invalid"
			? {
					kind: "refused",
					refusal: {
						kind: "domain",
						connectorCause: registered.cause,
						repair: registered.repair,
					},
				}
			: {
					kind: "resolved",
					effective: null,
					notYetEffective: {
						mode: "1password-below-mcporter",
						source: "plugin-state:registration-absent",
					},
					subject: null,
				};
	},
	internalRoles: { provider: { run: runProvider } },
};
