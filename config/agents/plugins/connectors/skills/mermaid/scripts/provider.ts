// The Mermaid account Provider, run only as the Mermaid adapter's internal
// provider role of the compiled front door. MCPorter starts it with no
// arguments; the adapter's readiness probe and `auth check` start it with
// --preflight alone. It reads the item named on the internal channel through
// 1Password custody and then relays MCPorter's stdio to the one account
// endpoint with the token as the Authorization header. The token lives only
// in this process's memory: never in MCPorter, an argument, an environment,
// or a file, and it ends when MCPorter closes the Provider's stdin.
import { type ProviderProcess, providerProcess } from "../../../bin/provider-process.ts";
import { contextItem, readCredential } from "./custody/index.ts";
import { ACCOUNT_ENDPOINT } from "./endpoint.ts";
import { relay } from "./relay.ts";

const proc = providerProcess("mermaid-provider");
// Annotated so its callers narrow on `never`.
const fail: ProviderProcess["fail"] = proc.fail;

export async function runProvider(argv: readonly string[]): Promise<void> {
	const preflight = argv.length === 1 && argv[0] === "--preflight";
	if (!preflight) proc.refuseArguments([...argv]);
	const item = contextItem(process.env);
	if (item === null) fail("context-invalid", "restart through connectors run mermaid", 2);
	const read = readCredential(item, process.env);
	if (!read.ok) fail(read.cause, "Mermaid account custody could not produce the credential", 3);
	if (preflight) process.exit(0);
	// Mermaid's account tier takes the raw token as the header value, with no
	// scheme prefix (research probe, 2026-09).
	await relay(ACCOUNT_ENDPOINT, read.credential);
	process.exit(0);
}
