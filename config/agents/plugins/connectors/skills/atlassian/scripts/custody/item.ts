// Credential item rules: the semantic tenant slug, the product, the
// 1Password item ID, the item's field map, its top-level id and version, and
// the trusted site origin. one-password.ts reads the item; nothing here
// prints a value.
import { singleLine } from "../provider-process.ts";
import type { CredentialBinding } from "./channel.ts";

export const TENANT_PATTERN = /^[a-z][a-z0-9-]*$/;
export const PRODUCTS = ["jira", "confluence"] as const;
export type Product = (typeof PRODUCTS)[number];
// The trusted site origin is the custom `site_url` field only.
export const SITE_URL_FIELD = "site_url";
// Raw input must be a bare authority with an optional trailing slash.
// The WHATWG parser normalises an explicit default port, so authority checks
// run on the raw string first to reject credentials and non-default ports.
const RAW_SITE_URL = /^https:\/\/([^\/?#]*)\/?$/i;
const SITE_HOST = /^[a-z0-9-]+\.atlassian\.net$/;

export const isProduct = (value: string): value is Product => (PRODUCTS as readonly string[]).includes(value);

// The one syntax rule for a configured 1Password item reference: a strict
// item ID. 1Password documents an ID as 26 numbers and letters; lowercase is
// the observed shape, so an uppercase letter fails closed. An allowlist, not a
// blocklist: an item name, `-` (op's stdin form), a share link, an op://
// reference, a URL, and every token shape are refused by construction, so a
// value that passes is nonsecret and safe to store, pass in argv, and print.
const ITEM_ID_PATTERN = /^[a-z0-9]{26}$/;
export const isItemId = (value: unknown): value is string => typeof value === "string" && ITEM_ID_PATTERN.test(value);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// `op item get` returns the whole item, a single field object with --fields,
// or a field array. Any other shape is not an item.
function itemFields(data: unknown): unknown[] | null {
	if (Array.isArray(data)) return data;
	if (!isRecord(data)) return null;
	if (Array.isArray(data.fields)) return data.fields;
	return [data];
}

// A field is keyed by its label, or by its id when the label is absent or
// empty; a field without a non-empty string value is ignored.
function fieldEntry(field: unknown): [string, string] | null {
	if (!isRecord(field)) return null;
	const label = typeof field.label === "string" && field.label !== "" ? field.label : field.id;
	const value = field.value;
	if (typeof label !== "string" || typeof value !== "string" || value === "") return null;
	return [label.toLowerCase(), value];
}

export function itemFieldMap(data: unknown): Map<string, string> | null {
	const fields = itemFields(data);
	if (!fields) return null;
	const values = new Map<string, string>();
	for (const field of fields) {
		const entry = fieldEntry(field);
		if (!entry) continue;
		if (values.has(entry[0])) return null;
		values.set(entry[0], entry[1]);
	}
	return values;
}

function versionOf(item: Record<string, unknown>): string | null {
	const version = item.version;
	if (typeof version === "number") return Number.isSafeInteger(version) && version > 0 ? String(version) : null;
	return typeof version === "string" && /^(?:[1-9][0-9]*)$/.test(version) ? version : null;
}

export function validSiteUrl(url: string): boolean {
	if (!singleLine(url)) return false;
	const raw = RAW_SITE_URL.exec(url);
	if (!raw) return false;
	const authority = raw[1] ?? "";
	if (authority.includes("@")) return false;
	const portIndex = authority.lastIndexOf(":");
	const host = (portIndex === -1 ? authority : authority.slice(0, portIndex)).toLowerCase();
	if (portIndex !== -1) return false;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	return parsed.protocol === "https:" && SITE_HOST.test(host) && parsed.hostname === host && parsed.username === "" && parsed.password === "" && parsed.port === "" && parsed.pathname === "/" && parsed.search === "" && parsed.hash === "";
}

export type BindingFailure = "credential-invalid" | "credential-revision-unavailable" | "site-url-invalid" | "item-id-mismatch";

// The nonsecret binding the item read by requestedId yields: that ID, its
// principal, its top-level positive version, and the trusted site origin.
// Identity is checked, never inferred from op's resolution: an item whose
// top-level id is absent or differs is refused. Every other field stays here.
export function itemBinding(item: unknown, requestedId: string): { binding: CredentialBinding } | { cause: BindingFailure } {
	if (!isRecord(item)) return { cause: "credential-invalid" };
	if (!isItemId(requestedId) || item.id !== requestedId) return { cause: "item-id-mismatch" };
	const version = versionOf(item);
	const fields = itemFieldMap(item);
	const principal = fields?.get("username");
	const siteUrl = fields?.get(SITE_URL_FIELD);
	if (!fields || !principal || !singleLine(principal) || principal.includes(":")) return { cause: "credential-invalid" };
	if (!siteUrl || !validSiteUrl(siteUrl)) return { cause: "site-url-invalid" };
	if (!version) return { cause: "credential-revision-unavailable" };
	return { binding: { principal, itemVersion: `onepassword-item-version:${version}`, origin: `https://${new URL(siteUrl).hostname}`, item: requestedId } };
}
