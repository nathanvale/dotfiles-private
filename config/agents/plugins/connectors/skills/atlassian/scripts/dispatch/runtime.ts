// Production adapters for the dispatcher: the route-backed transport through
// the plugin-owned verified MCPorter, trusted site origin and principal from
// the product item's metadata, and the private write journal. The packaged
// front door supplies its MCPorter selection and its own internal-role
// command; the Bun script entry selects MCPorter here and reaches the plugin's
// compiled front door from source.
import path from "node:path";
import type { ExecutionCapabilities } from "../../../../bin/adapters/contract.ts";
import { ensureMcporter } from "../../../../bin/mcporter-custody.ts";
import { planDispatcherRoute, type RoutePlan } from "../../../../bin/provider-route.ts";
import { safeEnvironment } from "../../../../bin/safe-environment.ts";
import { bindCredential, bindingChannel, type CredentialBinding, invocationEnvironment, type RegisteredItems, sourceInternalCommand, TENANT_PATTERN } from "../custody/index.ts";
import { stageFile } from "../outbox.ts";
import { productFor } from "./contract.ts";
import type { Dependencies, Transport, TransportFailure, TransportResult } from "./engine.ts";
import { openJournal } from "./journal.ts";
import { translateFailure } from "./translate.ts";

const CALL_TIMEOUT_MS = "30000";
const SKILLS_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "skills");

export type Environment = Record<string, string | undefined>;

function scrubbed(env: Environment): Record<string, string> {
	return safeEnvironment(env);
}

// One route call at a time; the dispatcher never overlaps provider calls, so a
// synchronous spawn is sufficient and keeps the process tree simple.
function planRoute(env: Environment, tenant: string, binding: CredentialBinding, server: string, mcporterArgs: string[], skillsRoot: string): RoutePlan | TransportFailure {
	try {
		return planDispatcherRoute(["atlassian", "--provider", server, "--select", `tenant=${tenant}`, "--", ...mcporterArgs], skillsRoot, scrubbed(env), bindingChannel(binding));
	} catch {
		return { ok: false, cause: "refused-precondition", hint: "repair the Connector Skill route registry" };
	}
}

function spawnRoute(mcporter: string, plan: RoutePlan): { code: number; stdout: string; stderr: string } {
	const run = Bun.spawnSync([mcporter, ...plan.argv], { env: plan.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

type McporterSelection = () => Promise<{ ok: true; binary: string } | TransportFailure>;

// The plugin-owned MCPorter, selected once per transport. PATH never
// supplies it; first use may bootstrap the pinned release, and any later
// mismatch refuses with the explicit repair.
function verifiedMcporter(env: Environment): McporterSelection {
	let selection: ReturnType<typeof ensureMcporter> | undefined;
	return async () => {
		selection ??= ensureMcporter(env);
		const selected = await selection;
		return selected.ok ? { ok: true, binary: selected.binary } : { ok: false, cause: "refused-precondition", hint: selected.repair };
	};
}

// The packaged front door's selection. It renders its own failure, so this
// transport only stops before any send.
function packagedMcporter(capabilities: ExecutionCapabilities): McporterSelection {
	return async () => {
		const binary = await capabilities.selectMcporter();
		return binary === null ? { ok: false, cause: "refused-precondition", hint: null } : { ok: true, binary };
	};
}

function parseJson(text: string): unknown | undefined {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

// The Community tools report some failures in band: a successful tool result
// whose only payload is {error: "..."} (observed live for a deleted page).
// That is a tool error, translated like any other, never data.
function inBandError(data: unknown): string | undefined {
	const payload = typeof data === "object" && data !== null && typeof (data as { result?: unknown }).result === "string" ? parseJson((data as { result: string }).result) : data;
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
	const record = payload as Record<string, unknown>;
	const keys = Object.keys(record);
	if (typeof record.error !== "string") return undefined;
	if (record.success === false) return record.error;
	return keys.length === 1 ? record.error : undefined;
}

// The Provider's local readiness operation, run before MCPorter starts.
// MCPorter 0.13.13 omits a stdio child's stderr from its JSON startup
// failure, so a Provider refusal that ran under MCPorter would be flattened
// into an offline transport failure; running --preflight here first keeps the
// refusal and its fixed hint.
function providerReadiness(env: Environment, tenant: string, binding: CredentialBinding, server: string, providerCommand: readonly string[]): TransportResult | null {
	const product = productFor(server);
	if (!product) return { ok: false, ...translateFailure({ kind: "malformed", message: "unknown Provider route" }) };
	const run = Bun.spawnSync([...providerCommand, "--preflight"], {
		env: { ...scrubbed(env), ...invocationEnvironment({ tenant, product, binding }) },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (run.exitCode !== 0) {
		return { ok: false, ...translateFailure({ kind: "process", exitCode: run.exitCode, stderr: run.stderr.toString(), stdout: run.stdout.toString() }) };
	}
	if (run.stdout.length > 0 || run.stderr.length > 0) {
		return { ok: false, ...translateFailure({ kind: "malformed", message: "Provider readiness emitted unexpected output" }) };
	}
	return null;
}

// MCPorter's JSON shapes are not fully documented; a result that is not JSON is
// reported as malformed rather than guessed. This adapter is the only place
// provider text is seen; it leaves here as a translated closed cause.
export function routeTransport(env: Environment, tenant: string, skillsRoot: string = SKILLS_ROOT, packaged?: ExecutionCapabilities): Transport {
	if (!TENANT_PATTERN.test(tenant)) throw new Error("tenant-invalid: the transport needs the validated tenant slug");
	const toResult = (run: { code: number; stdout: string; stderr: string }): TransportResult => {
		if (run.code !== 0) return { ok: false, ...translateFailure({ kind: "process", exitCode: run.code, stderr: run.stderr, stdout: run.stdout }) };
		const data = parseJson(run.stdout);
		if (data === undefined) return { ok: false, ...translateFailure({ kind: "malformed", message: "MCPorter output was not JSON" }) };
		if (typeof data === "object" && data !== null && (data as { isError?: unknown }).isError === true) {
			return { ok: false, ...translateFailure({ kind: "tool-error", message: JSON.stringify(data).slice(0, 2000) }) };
		}
		const inBand = inBandError(data);
		if (inBand !== undefined) return { ok: false, ...translateFailure({ kind: "tool-error", message: inBand.slice(0, 2000) }) };
		return { ok: true, data };
	};
	const mcporter = packaged ? packagedMcporter(packaged) : verifiedMcporter(env);
	const providerCommand = packaged ? packaged.internalCommand("provider") : sourceInternalCommand("provider");
	const request = async (binding: CredentialBinding, server: string, mcporterArgs: string[]): Promise<TransportResult> => {
		const planned = planRoute(env, tenant, binding, server, mcporterArgs, skillsRoot);
		if ("ok" in planned) return planned;
		const readiness = providerReadiness(env, tenant, binding, server, providerCommand);
		if (readiness) return readiness;
		const selected = await mcporter();
		if (!selected.ok) return selected;
		return toResult(spawnRoute(selected.binary, planned));
	};
	return {
		listTools(binding, server) {
			return request(binding, server, ["list", "--schema", "--json", "--timeout", CALL_TIMEOUT_MS]);
		},
		call(binding, server, tool, args) {
			return request(binding, server, ["call", tool, "--args", JSON.stringify(args), "--output", "json", "--timeout", CALL_TIMEOUT_MS]);
		},
	};
}

// What a credential binding may use: the item IDs of the tenant's validated
// registration; the Bun entry's registration refusal, reported at the first
// bind and so before any custody read; or null for a journal-only command,
// which never binds.
export type Custody = { items: RegisteredItems } | { unregistered: string } | null;

// The production dependency set for one validated tenant. Built exactly once
// per invocation from the parsed tenant, so the transport, the credential
// item, and the trusted origin can never name different tenants: a binding
// for any other slug is an adapter defect, never a use of another tenant's
// item IDs. The packaged front door passes its physical skills root and its
// capabilities.
export function productionDependencies(tenant: string, env: Environment, custody: Custody, packaged?: { skillsRoot: string; capabilities: ExecutionCapabilities }): Dependencies {
	const custodyCommand = packaged ? packaged.capabilities.internalCommand("custody-child") : sourceInternalCommand("custody-child");
	return {
		transport: routeTransport(env, tenant, packaged?.skillsRoot, packaged?.capabilities),
		bindCredential: async (slug, product) => {
			if (slug !== tenant) throw new Error("an Atlassian binding named another tenant");
			if (custody === null) throw new Error("an Atlassian binding without a validated registration");
			if ("unregistered" in custody) return { ok: false, cause: "refused-credential-unconfigured", detail: custody.unregistered };
			return bindCredential(slug, product, custody.items[product], env, custodyCommand);
		},
		journal: (slug) => openJournal(slug, { env }),
		stage: (slug, file) => stageFile(slug, env, file),
		now: Date.now,
	};
}
