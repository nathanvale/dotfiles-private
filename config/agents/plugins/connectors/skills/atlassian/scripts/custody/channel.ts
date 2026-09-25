// The internal channel that carries a nonsecret credential binding from the
// dispatcher, through the route, to a Provider process. The wire form is one
// JSON line with exactly these four keys in this order. item is the
// configured 1Password item ID the Provider re-reads; it never reads the
// tenant registration itself.
import { singleLine } from "../provider-process.ts";
import { isItemId, validSiteUrl } from "./item.ts";

export interface CredentialBinding {
	principal: string;
	itemVersion: string;
	origin: string;
	item: string;
}

const BINDING_KEYS = "principal,itemVersion,origin,item";

export function encodeBinding(binding: CredentialBinding): string {
	return JSON.stringify({ principal: binding.principal, itemVersion: binding.itemVersion, origin: binding.origin, item: binding.item });
}

export function parseBinding(value: string | undefined): CredentialBinding | null {
	try {
		const parsed: unknown = JSON.parse(value ?? "");
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		const record = parsed as Record<string, unknown>;
		if (Object.keys(record).join(",") !== BINDING_KEYS || typeof record.principal !== "string" || typeof record.itemVersion !== "string" || typeof record.origin !== "string" || !isItemId(record.item)) return null;
		if (!singleLine(record.principal) || record.principal.includes(":") || !/^onepassword-item-version:[1-9][0-9]*$/.test(record.itemVersion) || !validSiteUrl(record.origin)) return null;
		return { principal: record.principal, itemVersion: record.itemVersion, origin: record.origin, item: record.item };
	} catch {
		return null;
	}
}
