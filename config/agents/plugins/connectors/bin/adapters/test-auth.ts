// Packaged, tested test-only auth adapter (T2, Ticket #89 under Spec #87):
// proves a genuinely new authentication mechanism can be added through a
// packaged adapter and its contract without changing bin/connectors.ts
// (Spec AC23). Its only local check is that the manifest's own nonsecret
// credentials.reference field is a non-empty string; it never reads, holds,
// or transmits a credential value.
import type { Adapter, AdapterInspection } from "./contract.ts";
import type { ConnectorManifest } from "../manifest.ts";

function inspectLocal(manifest: ConnectorManifest): AdapterInspection {
	const reference = manifest.credentials?.reference;
	if (typeof reference === "string" && reference.length > 0) {
		return { ready: true, detail: "credentials.reference is declared" };
	}
	return {
		ready: false,
		cause: "CREDENTIAL_REFERENCE_MISSING",
		detail: "declare credentials.reference in the connector manifest",
	};
}

export const testAuthAdapter: Adapter = { id: "test-auth", inspectLocal };
