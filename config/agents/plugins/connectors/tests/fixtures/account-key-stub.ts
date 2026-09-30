// A hosted-MCP-shaped server on 127.0.0.1 standing in for one account-key
// connector's endpoint in both modes. Per request it records only how the
// Authorization header compared with the expected bearer value (absent,
// match, or other), never a value. It lists the connector's tools plus one
// unlisted tool the allow-list must hide, and answers a tools/call with the
// tool name and arguments it received. With reject set, every request is
// refused 401, as a hosted server refuses a revoked key.
export type HeaderSeen = "absent" | "match" | "other";

export interface AccountKeyStub {
	readonly url: string;
	readonly headers: HeaderSeen[];
	readonly calls: { name: string; arguments: Record<string, unknown> }[];
	reject: boolean;
	reset(): void;
	stop(): void;
}

export const UNLISTED_TOOL = "unlisted_tool";

export function startAccountKeyStub(tools: readonly string[], expectedKey: string): AccountKeyStub {
	const stub: AccountKeyStub = {
		url: "",
		headers: [],
		calls: [],
		reject: false,
		reset() {
			stub.headers.length = 0;
			stub.calls.length = 0;
			stub.reject = false;
		},
		stop: () => undefined,
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(request) {
			const authorization = request.headers.get("authorization");
			stub.headers.push(authorization === null ? "absent" : authorization === `Bearer ${expectedKey}` ? "match" : "other");
			if (stub.reject) return new Response("unauthorized", { status: 401 });
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const message = (await request.json()) as { id?: number; method: string; params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> } };
			if (message.id === undefined) return new Response(null, { status: 202 });
			const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: message.id, result });
			if (message.method === "initialize") return reply({ protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "account-key-stub", version: "1" } });
			if (message.method === "tools/list") return reply({ tools: [...tools, UNLISTED_TOOL].map((name) => ({ name, inputSchema: { type: "object", properties: {} } })) });
			if (message.method !== "tools/call") return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
			const call = { name: message.params?.name ?? "", arguments: message.params?.arguments ?? {} };
			stub.calls.push(call);
			return reply({ content: [{ type: "text", text: JSON.stringify({ tool: call.name, arguments: call.arguments }) }] });
		},
	});
	Object.assign(stub, { url: `http://127.0.0.1:${server.port}/mcp`, stop: () => server.stop(true) });
	return stub;
}
