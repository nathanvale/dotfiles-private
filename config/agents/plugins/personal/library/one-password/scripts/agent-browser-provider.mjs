import { resolveAgentBrowserCredential } from "./browser-login.mjs";
import { fillAgentBrowserCredential } from "./agent-browser-fill.mjs";

const protocol = "agent-browser.plugin.v1";

/** Bound the private protocol request before any credential custody operation. */
async function input() {
	let body = "";
	for await (const chunk of process.stdin) {
		body += chunk.toString();
		if (Buffer.byteLength(body) > 65_536) throw new Error("request-too-large");
	}
	return JSON.parse(body);
}

/** Keep credential responses on private stdout and collapse failures to a secret-free result. */
async function response() {
	if (process.argv[2] === "--help") {
		return { protocol, success: true, manifest: { name: "one-password", capabilities: ["credential.read", "credential.fill"],
			description: "Agent Browser private credential provider. Use auth login for a complete form or credential.fill for one approved stage." } };
	}
	try {
		if (process.argv.length > 2 || process.stdin.isTTY) throw new Error("invalid-invocation");
		const message = await input();
		if (message?.protocol !== protocol) throw new Error("invalid-protocol");
		if (message.type === "plugin.manifest") {
			return { protocol, success: true, manifest: { name: "one-password", capabilities: ["credential.read", "credential.fill"] } };
		}
		if (message.type === "credential.fill" && message.capability === "credential.fill") {
			return { protocol, success: true, data: await fillAgentBrowserCredential(message.request) };
		}
		if (message.type !== "credential.resolve" || message.capability !== "credential.read") throw new Error("invalid-capability");
		return { protocol, success: true, credential: await resolveAgentBrowserCredential(message.request) };
	} catch {
		return { protocol, success: false, error: "approved-credential-unavailable" };
	}
}

process.stdout.on("error", () => process.exit(1));
process.stdout.write(`${JSON.stringify(await response())}\n`);
