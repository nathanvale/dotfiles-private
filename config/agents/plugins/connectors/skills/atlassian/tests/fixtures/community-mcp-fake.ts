// Fake plugin-owned uv standing in for `uv tool run ... mcp-atlassian`: a
// minimal MCP stdio server the real MCPorter starts through the real
// Provider. On start it records what the Provider handed it and, from the
// kernel's process table, what its parent MCPorter process holds; as
// booleans, never values. Every tools/call is appended to effects.jsonl, the
// test's independent count of provider requests. Replies come from
// canned/<product>/ files read at call time.
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { processStrings } from "./process-table.ts";

const root = process.env.TMPDIR ?? "/nonexistent";
const env = process.env;
const serviceToken = readFileSync(path.join(root, "expected-service-token"), "utf8");
const providerToken = readFileSync(path.join(root, "expected-provider-token"), "utf8");
const product = env.JIRA_URL !== undefined ? "jira" : "confluence";
const parent = processStrings(process.ppid);
// argv then environment, space-joined as `ps -E -ww -o command=` prints them.
const parentCommandLine = [...parent.argv, ...parent.environment].join(" ");
const envValues = Object.values(env).join("\n");
appendFileSync(
	path.join(root, "community-starts.jsonl"),
	`${JSON.stringify({
		argv: process.argv.slice(2),
		cwd: process.cwd(),
		envKeys: Object.keys(env).sort(),
		product,
		jiraUrl: env.JIRA_URL ?? null,
		confluenceUrl: env.CONFLUENCE_URL ?? null,
		username: env.JIRA_USERNAME ?? env.CONFLUENCE_USERNAME ?? null,
		providerTokenMatches: (env.JIRA_API_TOKEN ?? env.CONFLUENCE_API_TOKEN) === providerToken,
		serviceTokenInEnvironment: envValues.includes(serviceToken),
		parentExecutable: parent.argv[0] ?? "",
		parentEnvironmentVisible: parentCommandLine.includes("MCPORTER_NO_KEEPALIVE="),
		parentHoldsServiceToken: parentCommandLine.includes(serviceToken),
		parentHoldsProviderToken: parentCommandLine.includes(providerToken),
	})}\n`,
);

// Test-owned start failure: the Provider's replacement dies before serving,
// so the real MCPorter reports its own startup diagnostic.
if (existsSync(path.join(root, "community-crash"))) {
	process.stderr.write("fixture-private-crash-text\n");
	process.exit(1);
}

// Test-owned post-write state: once this product's effects.jsonl records a
// call to <write tool>, canned/<product>/<name>.after.<write tool>.json
// replaces <name>.json, as a site shows a landed write to later reads. The
// only trigger is the fake's own recorded call; the dispatcher still decides
// what each read proves.
const recordedTools = (): Set<string> => {
	const file = path.join(root, "effects.jsonl");
	if (!existsSync(file)) return new Set();
	const calls = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { product: string; tool: string });
	return new Set(calls.filter((call) => call.product === product).map((call) => call.tool));
};
const canned = (name: string): unknown => {
	const directory = path.join(root, "canned", product);
	const prefix = `${name}.after.`;
	const written = recordedTools();
	const after = existsSync(directory) ? readdirSync(directory).filter((entry) => entry.startsWith(prefix) && entry.endsWith(".json") && written.has(entry.slice(prefix.length, -".json".length))) : [];
	// Fixture invariant: at most one post-write reply applies to a read, so the
	// choice never depends on directory order.
	if (after.length > 1) throw new Error(`community-mcp-fake: more than one post-write reply for ${name}`);
	const file = path.join(directory, after[0] ?? `${name}.json`);
	return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
};
const reply = (id: unknown, result: unknown) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
	buffer += new TextDecoder().decode(chunk);
	for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (!line) continue;
		const message = JSON.parse(line) as { id?: unknown; method?: string; params?: { protocolVersion?: string; name?: string; arguments?: unknown } };
		if (message.method === "initialize") reply(message.id, { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "community-mcp-fake", version: "0.0.0" } });
		else if (message.method === "ping") reply(message.id, {});
		else if (message.method === "tools/list") reply(message.id, { tools: canned("list") ?? [] });
		else if (message.method === "tools/call") {
			const tool = message.params?.name ?? "";
			appendFileSync(path.join(root, "effects.jsonl"), `${JSON.stringify({ product, tool, args: message.params?.arguments ?? null })}\n`);
			const value = canned(tool) as { toolErrorText?: string; exitAfterRecord?: true; plantMetaLock?: true; reply?: unknown } | null;
			// Test-owned write behaviors, after the call is recorded above:
			// {exitAfterRecord} dies without replying, as a Provider that received
			// the write and then failed; {plantMetaLock, reply} first leaves the
			// tenant journal's meta-lock held by an exited process, then replies.
			if (value?.exitAfterRecord === true) process.exit(1);
			if (value?.plantMetaLock === true) {
				const meta = path.join(env.XDG_STATE_HOME ?? "/nonexistent", "connectors", "atlassian", "example", "locks", ".meta");
				writeFileSync(meta, JSON.stringify({ pid: 2_147_483_000, lockId: "fixture-held", at: Date.now() }), { mode: 0o600 });
				reply(message.id, { content: [{ type: "text", text: JSON.stringify(value.reply) }] });
			}
			// A canned {toolErrorText} is a real MCP tool error, not data.
			else if (typeof value?.toolErrorText === "string") reply(message.id, { isError: true, content: [{ type: "text", text: value.toolErrorText }] });
			else reply(message.id, { content: [{ type: "text", text: JSON.stringify(value) }] });
		} else if (message.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } })}\n`);
	}
}
