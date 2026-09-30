// connectors-test-mermaid-endpoint-fake
// Test-owned stand-in for scripts/endpoint.ts. account-fixture.ts writes it
// over that leaf inside a copied plugin root only, so the Provider relays to
// the loopback account stub whose URL the fixture records beside HOME. The
// shipped tree always sends to the one hosted endpoint.
import { readFileSync } from "node:fs";
import path from "node:path";

function fixtureEndpoint(): string {
	try {
		return readFileSync(path.join(path.dirname(process.env.HOME ?? "/nonexistent"), "mermaid-endpoint"), "utf8").trim();
	} catch {
		return "http://127.0.0.1:9/mermaid-endpoint-unset";
	}
}

export const ACCOUNT_ENDPOINT = fixtureEndpoint();
