// Atlassian meaning that lives below the shared route: the semantic tenant
// slug, the product, the product-specific credential item title, item
// metadata reads through the credential helper, the trusted site origin, and
// process replacement. Nothing here prints a secret value.
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { INTERNAL_INVOCATION_CONTEXT_ENV, safeEnvironment } from "../../../bin/safe-environment.ts";

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

export function fail(code: string, message: string, exitCode: 2 | 4 = 4): never {
	process.stderr.write(`atlassian-provider:error:${code}:${message}\n`);
	process.exit(exitCode);
}

export function refuseArguments(argv: string[]): void {
	if (argv.length !== 0) fail("arguments-invalid", "no provider arguments are accepted", 2);
}

export function tenantFromEnvironment(): string {
	const tenant = process.env.ATLASSIAN_TENANT ?? "";
	if (!TENANT_PATTERN.test(tenant)) fail("tenant-invalid", "expected a lowercase tenant slug", 2);
	return tenant;
}

export function productFromEnvironment(): Product {
	const product = process.env.ATLASSIAN_PRODUCT ?? "";
	if (!(PRODUCTS as readonly string[]).includes(product)) fail("product-invalid", "expected ATLASSIAN_PRODUCT to be jira or confluence", 2);
	return product as Product;
}

// One owner of the mapping from semantic tenant slug and product to the
// 1Password item title. The two concepts stay distinct.
export function productItemTitle(product: Product, tenant: string): string {
	if (!TENANT_PATTERN.test(tenant)) throw new Error("tenant-invalid: expected a lowercase tenant slug");
	if (!(PRODUCTS as readonly string[]).includes(product)) throw new Error("product-invalid: expected jira or confluence");
	return `${product.toUpperCase()}_${tenant.replaceAll("-", "_").toUpperCase()}_API_TOKEN`;
}

export function credentialWrapperPath(home: string | undefined): string {
	return path.join(home ?? "", "code", "dotfiles", "bin", "with-one-password-token");
}

export function credentialWrapper(): string {
	const wrapper = credentialWrapperPath(process.env.HOME);
	if (!credentialWrapperPresent(wrapper)) fail("credential-wrapper-missing", "restore the dotfiles 1Password wrapper");
	return wrapper;
}

export function credentialWrapperPresent(wrapper: string): boolean {
	try {
		const metadata = statSync(wrapper);
		return metadata.isFile() && (metadata.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

export function executableOnPath(name: string): string {
	const found = Bun.which(name, { PATH: process.env.PATH ?? "" });
	if (!found || !existsSync(found)) fail("executable-missing", `${name} is not available on PATH`);
	return found;
}

export function cleanEnvironment(): Record<string, string> {
	return safeEnvironment(process.env);
}

export function singleLine(value: string | undefined): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\n") && !value.includes("\r");
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

export interface InvocationContext {
	principal: string;
	itemVersion: string;
	origin: string;
}

export type InvocationContextFailure = "credential-invalid" | "credential-revision-unavailable" | "site-url-invalid";

export function itemInvocationContextResult(item: unknown): { context: InvocationContext } | { cause: InvocationContextFailure } {
	if (typeof item !== "object" || item === null || Array.isArray(item)) return { cause: "credential-invalid" };
	const version = versionOf(item as Record<string, unknown>);
	const fields = itemFieldMap(item);
	const principal = fields?.get("username");
	const siteUrl = fields?.get(SITE_URL_FIELD);
	if (!fields || !principal || !singleLine(principal) || principal.includes(":")) return { cause: "credential-invalid" };
	if (!siteUrl || !validSiteUrl(siteUrl)) return { cause: "site-url-invalid" };
	if (!version) return { cause: "credential-revision-unavailable" };
	return { context: { principal, itemVersion: `onepassword-item-version:${version}`, origin: `https://${new URL(siteUrl).hostname}` } };
}

export function itemInvocationContext(item: unknown): InvocationContext | null {
	const result = itemInvocationContextResult(item);
	return "context" in result ? result.context : null;
}

export function encodeInvocationContext(context: InvocationContext): string {
	return JSON.stringify(context);
}

export function parseInvocationContext(value: string | undefined): InvocationContext | null {
	try {
		const parsed: unknown = JSON.parse(value ?? "");
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		const record = parsed as Record<string, unknown>;
		if (Object.keys(record).length !== 3 || typeof record.principal !== "string" || typeof record.itemVersion !== "string" || typeof record.origin !== "string") return null;
		if (!singleLine(record.principal) || record.principal.includes(":" ) || !/^onepassword-item-version:[1-9][0-9]*$/.test(record.itemVersion) || !validSiteUrl(record.origin)) return null;
		return { principal: record.principal, itemVersion: record.itemVersion, origin: record.origin };
	} catch {
		return null;
	}
}

// Provider startup receives only the dispatcher-bound safe context. The exact
// full item is read separately by readBoundItem immediately before a child
// executable can be probed or spawned.
export function selectedProviderInvocation(): { tenant: string; product: Product; itemTitle: string; context: InvocationContext } {
	const tenant = tenantFromEnvironment();
	const product = productFromEnvironment();
	const context = parseInvocationContext(process.env[INTERNAL_INVOCATION_CONTEXT_ENV]);
	if (!context) fail("credential-context-invalid", "restart through the semantic dispatcher");
	return { tenant, product, itemTitle: productItemTitle(product, tenant), context };
}

export function readCredentialItem(itemTitle: string): unknown {
	const wrapper = credentialWrapper();
	const read = Bun.spawnSync([wrapper, "op", "item", "get", itemTitle, "--vault", CREDENTIAL_VAULT, "--format", "json"], { env: cleanEnvironment(), stdin: "ignore" });
	if (read.exitCode !== 0) fail("credential-unavailable", `cannot read ${itemTitle}; run with-one-password-token check`);
	try {
		return JSON.parse(read.stdout.toString());
	} catch {
		return fail("credential-invalid", `${itemTitle} returned invalid JSON`);
	}
}

// A Provider re-reads the exact item immediately before its downstream
// executable starts. A rotated item or changed site is a precondition failure,
// never a retry or a provider fallback.
export function readBoundItem(itemTitle: string, expected: InvocationContext): Map<string, string> {
	const item = readCredentialItem(itemTitle);
	const actual = itemInvocationContext(item);
	if (!actual) fail("credential-invalid", `${itemTitle} needs a valid version, username, and ${SITE_URL_FIELD}`);
	if (actual.principal !== expected.principal || actual.itemVersion !== expected.itemVersion || actual.origin !== expected.origin) fail("credential-context-stale", "credential item changed; restart the semantic operation");
	const fields = itemFieldMap(item);
	if (!fields) fail("credential-invalid", `${itemTitle} returned an invalid item or duplicate field labels`);
	return fields;
}

// Metadata or full item read through the credential helper, inside this
// process. With `fields`, only those labels are requested from 1Password.
export function readItemFields(itemTitle: string, fields?: readonly string[]): Map<string, string> {
	const wrapper = credentialWrapper();
	const selector = fields && fields.length > 0 ? ["--fields", fields.map((field) => `label=${field}`).join(",")] : [];
	const read = Bun.spawnSync([wrapper, "op", "item", "get", itemTitle, "--vault", CREDENTIAL_VAULT, ...selector, "--format", "json"], {
		env: cleanEnvironment(),
		stdin: "ignore",
	});
	if (read.exitCode !== 0) fail("credential-unavailable", `cannot read ${itemTitle}; run with-one-password-token check`);
	let item: unknown;
	try {
		item = JSON.parse(read.stdout.toString());
	} catch {
		fail("credential-invalid", `${itemTitle} returned invalid JSON`);
	}
	const values = itemFieldMap(item);
	if (!values) fail("credential-invalid", `${itemTitle} returned an invalid item or duplicate field labels`);
	return values;
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

export function siteOrigins(url: string): { origin: string; jira: string; confluence: string } {
	if (!validSiteUrl(url)) fail("site-url-invalid", "the site_url field must be an https://*.atlassian.net origin");
	const origin = `https://${new URL(url).hostname}`;
	return { origin, jira: origin, confluence: `${origin}/wiki` };
}

// Replace this process so no resident parent sits between MCPorter and the
// credential-bearing child.
export function replaceProcess(file: string, argv: string[], environment: Record<string, string>): never {
	const execve = process.execve;
	if (!execve) fail("execve-unavailable", "this Bun runtime cannot replace the process");
	execve(file, argv, environment);
	fail("exec-failed", `${path.basename(file)} did not start`);
}
