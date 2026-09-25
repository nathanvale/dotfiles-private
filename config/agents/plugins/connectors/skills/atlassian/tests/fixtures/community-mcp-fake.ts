// Fake plugin-owned uv standing in for `uv tool run ... mcp-atlassian`: a
// minimal MCP stdio server the real MCPorter starts through the real
// Provider. On start it records what the Provider handed it and, from the
// kernel's process table, what its parent MCPorter process holds; as
// booleans, never values. Every tools/call is appended to effects.jsonl, the
// test's independent count of provider requests. Replies come from
// canned/<product>/ files read at call time.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// A process's argv then environment, space-joined as `ps -E -ww -o command=`
// prints them, read through sysctl KERN_PROCARGS2, the table ps reads. ps
// itself is setuid, and macOS refuses a setuid exec inside a sandbox.
function commandLine(pid: number): string {
	const libc = dlopen("/usr/lib/libSystem.B.dylib", { sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 } });
	const CTL_KERN = 1;
	const KERN_PROCARGS2 = 49;
	const name = new Int32Array([CTL_KERN, KERN_PROCARGS2, pid]);
	const size = new BigUint64Array([1n << 20n]);
	const buffer = new Uint8Array(Number(size[0]));
	const failed = libc.symbols.sysctl(ptr(name), name.length, ptr(buffer), ptr(size), null, 0) !== 0;
	libc.close();
	if (failed) return "";
	// Layout: argc, the exec path, NUL padding, then argv and environment
	// strings, each NUL-terminated, ending at the first empty string.
	const [, ...fields] = Buffer.from(buffer.subarray(4, Number(size[0])))
		.toString("utf8")
		.split("\0");
	const start = fields.findIndex((field) => field !== "");
	const strings = start === -1 ? [] : fields.slice(start);
	const end = strings.indexOf("");
	return (end === -1 ? strings : strings.slice(0, end)).join(" ");
}

const root = process.env.TMPDIR ?? "/nonexistent";
const env = process.env;
const serviceToken = readFileSync(path.join(root, "expected-service-token"), "utf8");
const providerToken = readFileSync(path.join(root, "expected-provider-token"), "utf8");
const product = env.JIRA_URL !== undefined ? "jira" : "confluence";
const parent = commandLine(process.ppid);
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
		parentExecutable: parent.trim().split(" ", 1)[0] ?? "",
		parentEnvironmentVisible: parent.includes("MCPORTER_NO_KEEPALIVE="),
		parentHoldsServiceToken: parent.includes(serviceToken),
		parentHoldsProviderToken: parent.includes(providerToken),
	})}\n`,
);

// Test-owned start failure: the Provider's replacement dies before serving,
// so the real MCPorter reports its own startup diagnostic.
if (existsSync(path.join(root, "community-crash"))) {
	process.stderr.write("fixture-private-crash-text\n");
	process.exit(1);
}

const canned = (name: string): unknown => {
	const file = path.join(root, "canned", product, `${name}.json`);
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
