// Secret custody ends here, below MCPorter. The original pinned upstream
// entrypoint replaces this process with a credential-bearing environment.
import path from "node:path";
import { readKeychain } from "../../../bin/keychain-read.ts";
import { readOnePasswordItem } from "../../../bin/one-password-custody.ts";
import { providerProcess } from "../../../bin/provider-process.ts";
import { FIGMA_API_ORIGIN } from "./endpoint.ts";
import { ConsoleRefusal, record } from "./model.ts";
import { configured, CANONICAL_PATH, profileRoot, verifyPayload } from "./profile.ts";
import { CONTEXT } from "./transport.ts";

function credential(item: unknown): string {
	if (!record(item) || !Array.isArray(item.fields)) throw new ConsoleRefusal("credential-invalid");
	const matches = item.fields.filter((field: unknown) => record(field) && field.label === "credential" && field.type === "CONCEALED");
	const field: unknown = matches[0];
	if (matches.length !== 1 || !record(field) || typeof field.value !== "string" || !/^figd_[A-Za-z0-9_-]+$/.test(field.value)) throw new ConsoleRefusal("credential-invalid");
	return field.value;
}

export async function runProvider(argv: readonly string[]): Promise<void> {
	const processOwner = providerProcess("figma-console-provider");
	processOwner.refuseArguments([...argv]);
	try {
		if (process.env.CONNECTORS_INTERNAL_INVOCATION_CONTEXT !== CONTEXT) throw new ConsoleRefusal("internal-context-invalid");
		const profile = configured(process.env, { account: process.env.FIGMA_CONSOLE_ACCOUNT ?? "", file: process.env.FIGMA_CONSOLE_FILE ?? "" });
		// Internal roles run only from the physical compiled packaged binary.
		const skillsRoot = path.resolve(path.dirname(process.execPath), "..", "skills");
		verifyPayload(profile, skillsRoot);
		const read = readOnePasswordItem(profile.itemId, process.env, readKeychain);
		if (!read.ok) throw new ConsoleRefusal(read.cause);
		const token = credential(read.item);
		const response = await fetch(`${FIGMA_API_ORIGIN}/v1/me`, { headers: { "X-Figma-Token": token }, signal: AbortSignal.timeout(15000), redirect: "error" });
		if (!response.ok) throw new ConsoleRefusal("pat-identity-unavailable");
		const identity: unknown = await response.json();
		if (!record(identity) || identity.id !== profile.userId || identity.email !== profile.email) throw new ConsoleRefusal("pat-identity-mismatch");
		const root = profileRoot(process.env, profile);
		processOwner.replaceProcess(profile.nodeFile, [profile.nodeFile, path.join(profile.runtimeRoot, "figma-console-mcp", "dist", "local.js")], { HOME: path.join(root, "home"), PATH: CANONICAL_PATH, TMPDIR: path.join(root, "tmp"), LANG: "en_AU.UTF-8", LC_ALL: "en_AU.UTF-8", LOG_LEVEL: "silent", FIGMA_WS_HOST: "localhost", FIGMA_WS_PORT: "9223", ENABLE_MCP_APPS: "false", FIGMA_ACCESS_TOKEN: token });
	} catch (error) {
		processOwner.fail(error instanceof ConsoleRefusal ? error.reason : "provider-unavailable", "Resolve the named provider precondition; no credential was printed", 3);
	}
}
