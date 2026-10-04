// connectors-test-figma-endpoint-fake
// Test-owned stand-in for scripts/endpoint.ts. figma-machine.ts writes it over
// that leaf inside a copied plugin root only, so the adapter accepts the
// loopback stub whose URL the machine records beside HOME. The shipped tree
// always names the one hosted endpoint.
import { readFileSync } from "node:fs";
import path from "node:path";

function fixtureEndpoint(): string {
	try {
		return readFileSync(path.join(path.dirname(process.env.HOME ?? "/nonexistent"), "figma-endpoint"), "utf8").trim();
	} catch {
		return "http://127.0.0.1:9/figma-endpoint-unset";
	}
}

export const FIGMA_ENDPOINT = fixtureEndpoint();
