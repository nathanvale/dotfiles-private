// Credential item rules: the semantic tenant slug, the product, the
// product-specific 1Password item title, the item's field map, its top-level
// version, and the trusted site origin. Reads go through the dotfiles
// credential helper; nothing here prints a value.
import { statSync } from "node:fs";
import path from "node:path";
import { type EnvironmentSource, safeEnvironment } from "../../../../bin/safe-environment.ts";
import { singleLine } from "../provider-process.ts";
import type { CredentialBinding } from "./channel.ts";

export const TENANT_PATTERN = /^[a-z][a-z0-9-]*$/;
export const PRODUCTS = ["jira", "confluence"] as const;
export type Product = (typeof PRODUCTS)[number];
export const CREDENTIAL_VAULT = "API Credentials";
// The trusted site origin is the custom `site_url` field only.
export const SITE_URL_FIELD = "site_url";
// Raw input must be a bare authority with an optional trailing slash.
// The WHATWG parser normalises an explicit default port, so authority checks
// run on the raw string first to reject credentials and non-default ports.
const RAW_SITE_URL = /^https:\/\/([^\/?#]*)\/?$/i;
const SITE_HOST = /^[a-z0-9-]+\.atlassian\.net$/;

export const isProduct = (value: string): value is Product => (PRODUCTS as readonly string[]).includes(value);

// One owner of the mapping from semantic tenant slug and product to the
// 1Password item title. The two concepts stay distinct.
export function productItemTitle(product: Product, tenant: string): string {
	if (!TENANT_PATTERN.test(tenant)) throw new Error("tenant-invalid: expected a lowercase tenant slug");
	if (!isProduct(product)) throw new Error("product-invalid: expected jira or confluence");
	return `${product.toUpperCase()}_${tenant.replaceAll("-", "_").toUpperCase()}_API_TOKEN`;
}

export function credentialHelperPath(home: string | undefined): string {
	return path.join(home ?? "", "code", "dotfiles", "bin", "with-one-password-token");
}

export function credentialHelperPresent(helper: string): boolean {
	try {
		const metadata = statSync(helper);
		return metadata.isFile() && (metadata.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

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

export type BindingFailure = "credential-invalid" | "credential-revision-unavailable" | "site-url-invalid";

// The nonsecret binding a complete item yields: its principal, its top-level
// positive version, and the trusted site origin. Every other field stays here.
export function itemBinding(item: unknown): { binding: CredentialBinding } | { cause: BindingFailure } {
	if (!isRecord(item)) return { cause: "credential-invalid" };
	const version = versionOf(item);
	const fields = itemFieldMap(item);
	const principal = fields?.get("username");
	const siteUrl = fields?.get(SITE_URL_FIELD);
	if (!fields || !principal || !singleLine(principal) || principal.includes(":")) return { cause: "credential-invalid" };
	if (!siteUrl || !validSiteUrl(siteUrl)) return { cause: "site-url-invalid" };
	if (!version) return { cause: "credential-revision-unavailable" };
	return { binding: { principal, itemVersion: `onepassword-item-version:${version}`, origin: `https://${new URL(siteUrl).hostname}` } };
}

export type ItemReadFailure = "credential-wrapper-missing" | "credential-unavailable" | "credential-invalid";

// One complete item read through the credential helper, inside this process.
export function readItem(itemTitle: string, env: EnvironmentSource): { ok: true; item: unknown } | { ok: false; cause: ItemReadFailure } {
	const helper = credentialHelperPath(env.HOME);
	if (!credentialHelperPresent(helper)) return { ok: false, cause: "credential-wrapper-missing" };
	const read = Bun.spawnSync([helper, "op", "item", "get", itemTitle, "--vault", CREDENTIAL_VAULT, "--format", "json"], { env: safeEnvironment(env), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	if (read.exitCode !== 0) return { ok: false, cause: "credential-unavailable" };
	try {
		return { ok: true, item: JSON.parse(read.stdout.toString()) };
	} catch {
		return { ok: false, cause: "credential-invalid" };
	}
}
