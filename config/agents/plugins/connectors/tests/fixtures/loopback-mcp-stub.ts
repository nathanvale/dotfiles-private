// A keyless MCP server on 127.0.0.1 for packaged `run` process proof. It speaks
// only MCP's JSON-over-HTTP transport to the real MCPorter; it never sees the
// Connectors envelope and supplies no cause or effect. Its call count is
// test-owned evidence that MCPorter actually reached it.
const STUB_TOOL_RESULT = { content: [{ type: "text", text: "probe-ok" }] } as const;

export interface LoopbackMcpStub {
	readonly url: string;
	// Tools/call requests answered so far.
	readonly calls: number;
	// A JSON-RPC error message for later tools/call requests, or null to succeed.
	failWith: string | null;
	stop(): void;
}

export function startLoopbackMcpStub(): LoopbackMcpStub {
	let calls = 0;
	const stub = {
		url: "",
		get calls() {
			return calls;
		},
		failWith: null as string | null,
		stop() {
			server.stop(true);
		},
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(request) {
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const message = (await request.json()) as { id?: number; method: string; params?: { protocolVersion?: string } };
			if (message.id === undefined) return new Response(null, { status: 202 });
			const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: message.id, result });
			if (message.method === "initialize") return reply({ protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "loopback-stub", version: "1" } });
			if (message.method === "tools/list") return reply({ tools: [{ name: "probe", inputSchema: { type: "object", properties: {} } }] });
			if (message.method !== "tools/call") return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
			calls += 1;
			if (stub.failWith !== null) return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: stub.failWith } });
			return reply(STUB_TOOL_RESULT);
		},
	});
	stub.url = `http://127.0.0.1:${server.port}/mcp`;
	return stub;
}
