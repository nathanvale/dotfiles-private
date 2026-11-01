import { readFileSync } from "node:fs";
import path from "node:path";
import type { Adapter, AdapterRequest, Executed, Prepared, RecoverRequest, SchemaRequest, WriteRequest } from "../../bin/adapters/contract.ts";
import registry from "./config/mcporter.json";
import { openJournal, PREVIEW_ID, RUN_ID } from "./scripts/journal.ts";
import { admittedNames, CATALOGUE, hash, inputFor, operation, record } from "./scripts/policy.ts";
import { runProvider } from "./scripts/provider.ts";
import { caller, type Caller } from "./scripts/transport.ts";
import { adjudicate, refusal, write } from "./scripts/writes.ts";

const REPAIR = "Use connectors schema notebooklm for the admitted operations and exact input; unsupported workflows remain blocked";
const refused = (cause: string, repair = REPAIR): Prepared => ({ kind: "refused", refusal: { kind: "domain", connectorCause: cause, repair } });
function checked<T extends SchemaRequest>(prepare: (request: T) => Prepared): (request: T) => Prepared {
	return (request) => {
		try {
			const actual: unknown = JSON.parse(readFileSync(path.join(request.skillsRoot, "notebooklm/config/mcporter.json"), "utf8"));
			if (hash(actual) !== hash(registry)) return refused("registry-invalid", "Restore the exact packaged NotebookLM registry, with imports disabled and exact admitted tools");
		} catch { return refused("registry-invalid"); }
		return prepare(request);
	};
}
function execute(request: SchemaRequest, step: (client: Caller) => Promise<Executed>, ready = true): Prepared {
	return { kind: "execute", async execute(capabilities) {
		const client = caller(request, capabilities);
		if (ready) {
			const status = await client.call("server_info", {});
			if (!status.ok) return refusal(status.cause, "NotebookLM readiness failed; diagnose the vendor runtime before reading content");
			if (status.data.auth_status !== "configured") return refusal("authentication-unready", "Inspect connectors auth status notebooklm for this profile; unverified is degraded, not proof that login is needed");
			if (status.data.version !== CATALOGUE.vendorVersion) return refusal("runtime-version-unqualified", "Qualify this vendor version and its schema before allowing content operations");
		}
		return step(client);
	} };
}
function readiness(request: SchemaRequest): Prepared {
	return execute(request, async (client) => {
		const value = await client.call("server_info", {});
		if (!value.ok) return refusal(value.cause, "Restore the vendor NotebookLM executable or inspect its safe authentication status");
		return { kind: "success", data: { profile: request.selectors.profile, result: { ...value.data, status: value.data.version === CATALOGUE.vendorVersion ? value.data.status : "blocked", schemaQualifiedVersion: CATALOGUE.vendorVersion }, custodyMode: "vendor-managed-profile" } };
	}, false);
}
function prepare(request: AdapterRequest): Prepared {
	if (request.action.kind === "auth") return request.action.verb === "status" || request.action.verb === "check" ? readiness(request) : refused("vendor-login-required", "For an authorized login, use nlm login --profile with this exact profile through the browser-authorization procedure. Connectors never accepts cookies or tokens");
	const { operation: name, input } = request.action;
	if (name === "capabilities" && (input === null || Object.keys(input).length === 0)) return { kind: "inspected", data: { vendorVersion: CATALOGUE.vendorVersion, operations: CATALOGUE.operations.map(({ name, effect, admission }) => ({ name, effect, admission })) } };
	const spec = operation(name);
	if (!spec) return refused("operation-not-allowed");
	if (spec.admission !== "admitted") return refused(spec.effect === "auth-forbidden" ? "auth-tool-forbidden" : "capability-not-qualified");
	if (spec.effect === "write") return refused("write-needs-preview", "Review a --preview, then --apply its one-use preview ID with identical input");
	const args = inputFor(name, input);
	if (args === null) return { kind: "refused", refusal: { kind: "schema", connectorCause: "input-invalid", repair: REPAIR } };
	if (name === "server_info") return readiness(request);
	return execute(request, async (client) => {
		const result = await client.call(name, args);
		if (!result.ok) return refusal(result.cause, result.cause === "authentication-expired" ? "The live read rejected the saved login. Run an authorized nlm login for this profile, then verify with a live read; server_info alone is insufficient" : "The read returned no qualified result; inspect the vendor schema and readiness before retrying");
		if (name === "notebook_get" && (!record(result.data.notebook) || result.data.notebook.id !== args.notebook_id)) return refusal("target-mismatch");
		if (name === "notebook_list" && (!Array.isArray(result.data.notebooks) || result.data.notebooks.length > Number(args.max_results))) return refusal("result-limit-exceeded");
		return { kind: "success", data: { operation: name, profile: request.selectors.profile, result: result.data } };
	});
}
function schemaShape(value: unknown, properties = false): unknown {
	if (Array.isArray(value)) return value.map((item) => schemaShape(item));
	if (!record(value)) return value;
	return Object.fromEntries(Object.entries(value).filter(([key]) => properties || !["description", "title", "default"].includes(key)).map(([key, item]) => [key, schemaShape(item, key === "properties")]));
}
function prepareSchema(request: SchemaRequest): Prepared {
	return execute(request, async (client) => {
		const reply = await client.schema();
		if (!reply.ok || !Array.isArray(reply.data.tools)) return refusal("schema-unavailable");
		const tools = reply.data.tools;
		const compatible = admittedNames.every((name) => {
			const found = tools.find((item) => record(item) && item.name === name);
			return record(found) && hash(schemaShape(found.inputSchema)) === hash(operation(name)?.inputSchema);
		});
		if (!compatible) return refusal("schema-drift", "The live tool schema differs from the qualified snapshot; review it before using this connector");
		return { kind: "success", data: { vendorVersion: CATALOGUE.vendorVersion, compatible: true, operations: CATALOGUE.operations } };
	}, false);
}
function prepareWrite(request: WriteRequest): Prepared {
	const spec = operation(request.operation);
	if (!spec || spec.admission !== "admitted") return refused("capability-not-qualified");
	if (spec.effect !== "write") return refused("read-takes-no-phase");
	const args = inputFor(request.operation, request.input);
	if (args === null) return { kind: "refused", refusal: { kind: "schema", connectorCause: "input-invalid", repair: REPAIR } };
	if (request.phase.kind === "apply" && !PREVIEW_ID.test(request.phase.previewId)) return refused("preview-unknown");
	return execute(request, (client) => write(request, args, client, openJournal(request.env, request.selectors.profile ?? "default")));
}
function prepareRecover(request: RecoverRequest): Prepared {
	if (request.runId !== null && !RUN_ID.test(request.runId)) return refused("run-unknown");
	const local = async (client?: Caller): Promise<Executed> => {
		const journal = openJournal(request.env, request.selectors.profile ?? "default");
		if (!journal) return refusal("journal-unavailable");
		const all = journal.all();
		if (all === null) return refusal("journal-corrupt");
		if (request.runId === null) return { kind: "success", data: { receipts: all.filter((item) => item.status !== "completed") } };
		const receipt = journal.receipt(request.runId);
		if (!receipt) return refusal("run-unknown");
		if (request.recovery.kind === "unlock") return journal.unlock() ? { kind: "recorded", effect: "write-unlock", data: { unlocked: true, runId: receipt.runId } } : refusal("holder-live-or-invalid");
		if (client && request.recovery.kind === "adjudicate") return adjudicate(receipt, client, journal);
		return { kind: "success", data: { receipt } };
	};
	if (request.recovery.kind === "adjudicate") return Object.keys(request.recovery.input).length === 0 ? execute(request, local) : refused("recovery-input-invalid", "Adjudication takes an empty --input object and only reads the receipt's bound target");
	return { kind: "execute", execute: () => local() };
}
export const notebooklmAdapter: Adapter = {
	id: "notebooklm", internalRoles: { provider: { run: runProvider } }, prepare: checked(prepare), prepareSchema: checked(prepareSchema), prepareWrite: checked(prepareWrite), prepareRecover: checked(prepareRecover),
	resolveCustody: () => ({ kind: "resolved", effective: null, notYetEffective: { mode: "vendor-managed-profile", source: "packaged-config:vendor-profile" }, subject: null }),
};
