// A keyless Mermaid-shaped MCP server on 127.0.0.1 for packaged process proof.
// It speaks MCP's JSON-over-HTTP transport to the real MCPorter and never sees
// the Connectors envelope. It lists the verified keyless tool names plus two
// write tools the hosted server also lists, so the test can observe that only
// the allow-list reaches the caller. Every request's headers and every
// tools/call it answers are test-owned evidence of what MCPorter sent.
export const STUB_RENDER_RESULT = { content: [{ type: "text", text: "mermaid-stub-ok" }] } as const;

// Names the hosted Mermaid server listed in the 2026-09-26 live receipt
// (SHA-256 9e5388f7...). push_file and create_pr are its GitHub writes, which
// the keyless allow-list must never admit.
const LISTED_TOOLS = [
	"validate_and_render_mermaid_diagram",
	"get_diagram_title",
	"get_diagram_summary",
	"search_mermaid_icons",
	"get_mermaid_syntax_document",
	"push_file",
	"create_pr",
] as const;

export interface MermaidStub {
	readonly url: string;
	readonly headers: readonly string[];
	readonly calls: readonly { readonly name: string; readonly arguments: unknown }[];
	stop(): void;
}

export function startMermaidStub(): MermaidStub {
	const headers: string[] = [];
	const calls: { name: string; arguments: unknown }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(request) {
			headers.push(JSON.stringify([...request.headers]));
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const message = (await request.json()) as { id?: number; method: string; params?: { protocolVersion?: string; name?: string; arguments?: unknown } };
			if (message.id === undefined) return new Response(null, { status: 202 });
			const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: message.id, result });
			if (message.method === "initialize") return reply({ protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "mermaid-stub", version: "1" } });
			if (message.method === "tools/list") return reply({ tools: LISTED_TOOLS.map((name) => ({ name, inputSchema: { type: "object", properties: {} } })) });
			if (message.method !== "tools/call") return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
			calls.push({ name: message.params?.name ?? "", arguments: message.params?.arguments });
			return reply(STUB_RENDER_RESULT);
		},
	});
	return { url: `http://127.0.0.1:${server.port}/mcp`, headers, calls, stop: () => server.stop(true) };
}
