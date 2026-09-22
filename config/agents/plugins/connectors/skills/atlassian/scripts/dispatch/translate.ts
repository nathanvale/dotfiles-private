// Failure translation at the transport seam. This is the only module that
// inspects provider text: the route transport adapter hands it what a process
// or tool produced, and dispatch policy receives a closed cause, a fixed hint
// from the precondition table, and whether content was observed. No provider
// stdout, stderr, or tool message survives translation.
import type { CauseCode } from "./contract.ts";

// What the transport adapter observed. Text here is untrusted.
export type ObservedFailure =
	| { kind: "process"; exitCode: number; stderr: string; stdout: string; contentObserved: boolean }
	| { kind: "tool-error"; message: string; contentObserved: boolean }
	| { kind: "malformed"; message: string; contentObserved: boolean };

export type ProviderFailureCause = Extract<CauseCode, "refused-precondition" | "refused-auth" | "not-found" | "capability-unavailable" | "failed-transport" | "failed-unknown">;

// What dispatch policy receives. `hint` is fixed text from the table below or
// null; it is never derived from the observed message.
export interface ProviderFailure {
	cause: ProviderFailureCause;
	hint: string | null;
	contentObserved: boolean;
}

const AUTH_PATTERN = /\b(401|403)\b|authentication failed|unauthori[sz]ed|forbidden|permission/i;
const NOT_FOUND_PATTERN = /\b404\b|not found|does not exist/i;
const CAPABILITY_PATTERN = /unknown tool|tool .* not found|no such tool|not exposed/i;
const TRANSPORT_PATTERN = /timed? ?out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|offline|connection|socket/i;

// Our own Provider cause codes: a closed list, matched exactly. Each maps to
// fixed public guidance; the Provider's message text is never carried.
const PROVIDER_CAUSE_HINTS: Record<string, string> = {
	"bridge-version-invalid": "install the pinned hyper-mcp-remote bridge version",
	"executable-missing": "install the missing provider executable on PATH",
	"credential-wrapper-missing": "restore the dotfiles 1Password helper",
	"credential-context-invalid": "restart through the semantic dispatcher",
	"credential-context-stale": "credential item metadata changed; restart the semantic operation",
	"credential-unavailable": "the credential item could not be read; run the helper's check",
	"credential-invalid": "the credential item has malformed fields",
	"username-missing": "add a username field to the tenant's product credential item",
	"community-fields-missing": "the product credential item needs username, credential, and a site_url field",
	"site-url-invalid": "the site_url field must be a plain https atlassian.net origin",
	"tenant-invalid": "the tenant slug was rejected by the provider",
	"product-invalid": "the provider route has no valid product",
	"arguments-invalid": "the provider was invoked with unexpected arguments",
	"log-path-invalid": "restore the Provider's owned bridge log directory",
	"execve-unavailable": "run the Provider with a Bun runtime that supports process replacement",
	"exec-failed": "inspect the Provider executable and runtime",
	"injection-mismatch": "restart through the semantic dispatcher",
};
const PRECONDITION_PATTERN = new RegExp(`atlassian-provider:error:(${Object.keys(PROVIDER_CAUSE_HINTS).join("|")}):`);

function classify(observed: ObservedFailure, text: string): ProviderFailureCause {
	if (PRECONDITION_PATTERN.test(text)) return "refused-precondition";
	if (AUTH_PATTERN.test(text)) return "refused-auth";
	if (NOT_FOUND_PATTERN.test(text)) return "not-found";
	if (CAPABILITY_PATTERN.test(text)) return "capability-unavailable";
	if (observed.kind === "malformed") return "failed-unknown";
	if (TRANSPORT_PATTERN.test(text)) return "failed-transport";
	return "failed-unknown";
}

// A precondition line from our own Provider beats any other signal, because
// it means no request was made. Everything else is classified in order.
export function translateFailure(observed: ObservedFailure): ProviderFailure {
	const text = observed.kind === "process" ? `${observed.stderr}\n${observed.stdout}` : observed.message;
	const cause = classify(observed, text);
	const code = cause === "refused-precondition" ? PRECONDITION_PATTERN.exec(text)?.[1] : undefined;
	return { cause, hint: code === undefined ? null : (PROVIDER_CAUSE_HINTS[code] ?? null), contentObserved: observed.contentObserved };
}
