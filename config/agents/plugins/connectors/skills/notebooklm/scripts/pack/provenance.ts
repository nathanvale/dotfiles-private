// Provenance and claim-label check for one pack source. A source opens with a
// front-matter block naming the pack and the manifest's provenance, and labels
// each list-item claim as [verified], [proposal] or [decision]. Private
// inventory and the five known-false trial claims refuse. Reasons carry a
// closed code and a line number, never the matched text.
import type { PackManifest } from "./manifest.ts";

export interface Reason { readonly code: string; readonly line: number }
export interface SourceVerdict {
	readonly provenance: { readonly verdict: "verified" | "missing" | "mismatch" | "refused"; readonly mismatched: readonly string[]; readonly reasons: readonly Reason[] };
	readonly labels: { readonly verdict: "labelled" | "unlabelled" | "none"; readonly claims: number; readonly unlabelled: readonly number[] };
}

const FIELDS = ["pack", "repo", "commit", "subtree", "plugin", "vendor"] as const;
const NEGATION = /\b(?:never|not|no|nothing|none|cannot|neither|nor|without)\b|n't\b/i;
// Each known-false claim is a conjunction of terms in one sentence with no
// negation before its last matched term; the true statement it contradicts is
// in the comment.
const FALSE_CLAIMS: readonly { readonly code: string; readonly terms: readonly RegExp[] }[] = [
	// Preview may read but never dispatches a mutating write.
	{ code: "false-claim:preview-dispatches-write", terms: [/\bpreviews?\b[^.]{0,60}\b(?:dispatch|send|perform|execut)\w*[^.]{0,40}\b(?:writes?|mutat\w*|effects?|create\w*)/i] },
	// Credential headers are provider-specific.
	{ code: "false-claim:shared-credential-headers", terms: [/\b(?:credential|auth\w*)\b/i, /\bheaders?\b/i, /\b(?:shared|generic|common|same|identical|universal)\b/i] },
	// A configured key that fails has no fallback.
	{ code: "false-claim:failed-key-fallback", terms: [/\b(?:keys?|tokens?|credentials?)\b/i, /\bfall(?:s|ing)?[\s-]?backs?\b/i] },
	// Unknown-effect recovery is connector-specific.
	{ code: "false-claim:generic-recovery", terms: [/\brecover\w*/i, /\b(?:unknown|uncertain)\b/i, /\b(?:generic|shared|common|same|uniform|universal)\b/i] },
	// Unlock is neither adjudication nor retry permission.
	{ code: "false-claim:unlock-settles", terms: [/\bunlock\w*/i, /\b(?:adjudicat|settle|retr|resend|resolv)\w*/i] },
];
const PRIVATE: readonly { readonly code: string; readonly pattern: RegExp }[] = [
	{ code: "session-id", pattern: /\b(?:session|thread|conversation|rollout)[\s_-]?(?:id)?\W{0,3}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\brollout-\d{4}-\d{2}-\d{2}|\bsess_[A-Za-z0-9]{8,}/i },
	// Only SSH-remote syntax is exempt, and only as its own token (after the
	// line start or whitespace, optionally behind opening quotes or brackets):
	// a bare SCP remote git@host:path, relative or absolute, and
	// [git+]ssh://git@host[:port]/path. Every other address refuses, git@ in URI
	// userinfo, query or fragment included.
	{ code: "account-email", pattern: /(?<![\w.%+-])(?!(?<=(?:^|\s)["'`(<[]*)git@[A-Za-z0-9.-]+:[\w~./+-])(?!(?<=(?:^|\s)["'`(<[]*(?:git\+)?ssh:\/\/)git@[A-Za-z0-9.-]+(?::\d+)?\/)[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/ },
	{ code: "home-path", pattern: /(?:\/Users\/|\/home\/)[^/\s]+|\/(?:private\/)?var\/folders\/|\b[A-Z]:\\Users\\/ },
	// A host name ends its token; client.internal( and settings.local.json do not.
	{ code: "host-name", pattern: /\b[A-Za-z0-9-]+\.(?:local|lan|home\.arpa|ts\.net|internal)\b(?![\w(/-]|\.\w)/i },
];

function frontMatter(lines: readonly string[]): { fields: Record<string, string>; end: number } | null {
	if (lines[0] !== "---") return null;
	const end = lines.indexOf("---", 1);
	if (end < 0) return null;
	const fields: Record<string, string> = {};
	for (const line of lines.slice(1, end)) {
		const match = /^([a-z]+):\s*(.*?)\s*$/.exec(line);
		if (match?.[1] && match[2] !== undefined) fields[match[1]] = match[2];
	}
	return { fields, end };
}

function privateReasons(lines: readonly string[], hostName: string): Reason[] {
	const reasons: Reason[] = [];
	const host = hostName.trim().toLowerCase();
	for (const [index, line] of lines.entries()) {
		for (const { code, pattern } of PRIVATE) if (pattern.test(line)) reasons.push({ code, line: index + 1 });
		if (host.length >= 4 && line.toLowerCase().includes(host)) reasons.push({ code: "host-name", line: index + 1 });
	}
	return reasons;
}

// The claim's span runs from its first term to its last, plus one directly
// adjacent word each side, or null when a term is absent. "resolves nothing"
// and "no fallback" negate the claim; "With no journal, the preview
// dispatches" and "the write, not a read" do not.
function claimSpan(sentence: string, terms: readonly RegExp[]): string | null {
	const matches = terms.map((term) => term.exec(sentence));
	if (matches.some((match) => match === null)) return null;
	const found = matches as RegExpExecArray[];
	const first = Math.min(...found.map((match) => match.index));
	const last = Math.max(...found.map((match) => match.index + match[0].length));
	return (/\w+\s+$/.exec(sentence.slice(0, first))?.[0] ?? "") + sentence.slice(first, last) + (/^\s+\w+/.exec(sentence.slice(last))?.[0] ?? "");
}

function falseClaims(lines: readonly string[]): Reason[] {
	const reasons: Reason[] = [];
	for (const [index, line] of lines.entries()) {
		for (const sentence of line.split(/(?<=[.!?;])\s+/)) {
			for (const claim of FALSE_CLAIMS) {
				const span = claimSpan(sentence, claim.terms);
				if (span !== null && !NEGATION.test(span)) reasons.push({ code: claim.code, line: index + 1 });
			}
		}
	}
	return reasons;
}

function claimLabels(lines: readonly string[], bodyStart: number): SourceVerdict["labels"] {
	const claims: number[] = [];
	const unlabelled: number[] = [];
	for (const [index, line] of lines.entries()) {
		const item = index < bodyStart ? null : /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
		if (!item) continue;
		claims.push(index + 1);
		if (!/^\[(?:verified|proposal|decision)\]\s/.test(item[1] ?? "")) unlabelled.push(index + 1);
	}
	return { verdict: claims.length === 0 ? "none" : unlabelled.length > 0 ? "unlabelled" : "labelled", claims: claims.length, unlabelled };
}

export function checkSource(text: string, manifest: PackManifest, hostName: string): SourceVerdict {
	const lines = text.split(/\r?\n/);
	const header = frontMatter(lines);
	const reasons = [...privateReasons(lines, hostName), ...falseClaims(lines)];
	const expected: Record<(typeof FIELDS)[number], string> = { pack: manifest.pack.id, ...manifest.pack.provenance };
	const mismatched = header === null ? [] : FIELDS.filter((field) => header.fields[field] !== expected[field]);
	const verdict = reasons.length > 0 ? "refused" : header === null ? "missing" : mismatched.length > 0 ? "mismatch" : "verified";
	return { provenance: { verdict, mismatched, reasons }, labels: claimLabels(lines, header === null ? 0 : header.end + 1) };
}

export const sourceReady = (verdict: SourceVerdict): boolean => verdict.provenance.verdict === "verified" && verdict.labels.verdict === "labelled";
