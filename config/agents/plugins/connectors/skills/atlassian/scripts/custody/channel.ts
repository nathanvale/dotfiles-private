// The internal channel that carries a nonsecret credential binding from the
// dispatcher, through the route, to a Provider process. The wire form is one
// JSON line with exactly these three keys in this order.
import { singleLine } from "../provider-process.ts";
import { validSiteUrl } from "./item.ts";

export interface CredentialBinding {
	principal: string;
	itemVersion: string;
	origin: string;
}

export function encodeBinding(binding: CredentialBinding): string {
	return JSON.stringify({ principal: binding.principal, itemVersion: binding.itemVersion, origin: binding.origin });
}

export function parseBinding(value: string | undefined): CredentialBinding | null {
	try {
		const parsed: unknown = JSON.parse(value ?? "");
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		const record = parsed as Record<string, unknown>;
		if (Object.keys(record).length !== 3 || typeof record.principal !== "string" || typeof record.itemVersion !== "string" || typeof record.origin !== "string") return null;
		if (!singleLine(record.principal) || record.principal.includes(":") || !/^onepassword-item-version:[1-9][0-9]*$/.test(record.itemVersion) || !validSiteUrl(record.origin)) return null;
		return { principal: record.principal, itemVersion: record.itemVersion, origin: record.origin };
	} catch {
		return null;
	}
}
