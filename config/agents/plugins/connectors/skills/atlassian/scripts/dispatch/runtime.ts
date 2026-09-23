// Production adapters for the dispatcher: the route-backed MCPorter transport,
// trusted site origin and principal from the product item's metadata, and the
// private write journal.
import path from "node:path";
import { planDispatcherRoute, type RoutePlan } from "../../../../bin/provider-route.ts";
import { safeEnvironment } from "../../../../bin/safe-environment.ts";
import { bindCredential, bindingChannel, type CredentialBinding, invocationEnvironment, TENANT_PATTERN } from "../custody/index.ts";
import { stageFile } from "../outbox.ts";
import { productFor } from "./contract.ts";
import type { Dependencies, Transport, TransportFailure, TransportResult } from "./engine.ts";
import { openJournal } from "./journal.ts";
import { translateFailure } from "./translate.ts";

const CALL_TIMEOUT_MS = "30000";
const SKILLS_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "skills");
const PROVIDER_SCRIPT = path.resolve(import.meta.dir, "..", "atlassian-community-provider.ts");

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

function spawnRoute(plan: RoutePlan): { code: number; stdout: string; stderr: string } {
	const mcporter = Bun.which("mcporter", { PATH: plan.env.PATH ?? "" });
	if (!mcporter) return { code: 3, stdout: "", stderr: "mcporter is not available" };
	const run = Bun.spawnSync([mcporter, ...plan.argv], { env: plan.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
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
function providerReadiness(env: Environment, tenant: string, binding: CredentialBinding, server: string): TransportResult | null {
	const product = productFor(server);
	if (!product) return { ok: false, ...translateFailure({ kind: "malformed", message: "unknown Provider route" }) };
	const run = Bun.spawnSync([process.execPath, PROVIDER_SCRIPT, "--preflight"], {
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
export function routeTransport(env: Environment, tenant: string, skillsRoot: string = SKILLS_ROOT): Transport {
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
	const request = (binding: CredentialBinding, server: string, mcporterArgs: string[]): TransportResult => {
		const planned = planRoute(env, tenant, binding, server, mcporterArgs, skillsRoot);
		if ("ok" in planned) return planned;
		const readiness = providerReadiness(env, tenant, binding, server);
		if (readiness) return readiness;
		return toResult(spawnRoute(planned));
	};
	return {
		async listTools(binding, server) {
			return request(binding, server, ["list", "--schema", "--json", "--timeout", CALL_TIMEOUT_MS]);
		},
		async call(binding, server, tool, args) {
			return request(binding, server, ["call", tool, "--args", JSON.stringify(args), "--output", "json", "--timeout", CALL_TIMEOUT_MS]);
		},
	};
}

// The production dependency set for one validated tenant. Built exactly once
// per invocation from the parsed tenant, so the transport, the credential
// item, and the trusted origin can never name different tenants.
export function productionDependencies(tenant: string, env: Environment): Dependencies {
	return {
		transport: routeTransport(env, tenant),
		bindCredential: async (slug, product) => bindCredential(slug, product, env),
		journal: (slug) => openJournal(slug, { env }),
		stage: (slug, file) => stageFile(slug, env, file),
		now: Date.now,
	};
}
