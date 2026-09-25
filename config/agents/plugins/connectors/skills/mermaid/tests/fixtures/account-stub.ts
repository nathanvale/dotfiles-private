// A stateful Mermaid-account-shaped MCP server on 127.0.0.1, reached only by
// the Provider's relay. It keeps one project's diagrams in memory, answers
// the five admitted account tools in the reply shape scripts/diagrams.ts
// assumes (one JSON text content), and records, per request, only whether
// the Authorization header equalled the expected token, never a value.
// mode: normal; drop-write applies a write, then answers it with HTTP 502 so
// the reply never arrives; lose-write answers a write with HTTP 502 and holds
// it until landPending() applies it, a delayed effect; reject-write answers a
// write with a tool error and changes nothing. hold(tool) holds that tool's
// next call until release(), so a test can act while a caller waits on it.
export interface StubDiagram {
	documentID: string;
	title: string;
	code: string;
}

export interface AccountStub {
	readonly url: string;
	readonly authorized: boolean[];
	readonly calls: { name: string; arguments: Record<string, unknown> }[];
	readonly diagrams: StubDiagram[];
	mode: "normal" | "drop-write" | "lose-write" | "reject-write";
	landPending(): void;
	hold(tool: string): { reached: Promise<void>; release(): void };
	stop(): void;
}

const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const WRITES = new Set(["create_mermaid_chart_diagram", "update_mermaid_chart_diagram"]);

function answer(stub: AccountStub, name: string, args: Record<string, unknown>): unknown {
	const found = stub.diagrams.find((diagram) => diagram.documentID === args.documentID);
	switch (name) {
		case "list_mermaid_chart_projects":
			return text([{ projectID: "proj-1", title: "Fixture project" }]);
		case "list_mermaid_chart_diagrams":
			return text(stub.diagrams.map(({ documentID, title }) => ({ documentID, title })));
		case "get_mermaid_chart_diagram":
			return found ? text(found) : { isError: true, content: [{ type: "text", text: "not found" }] };
		case "create_mermaid_chart_diagram": {
			const created = { documentID: `doc-${stub.diagrams.length + 1}`, title: String(args.title), code: String(args.code ?? "") };
			stub.diagrams.push(created);
			return text(created);
		}
		case "update_mermaid_chart_diagram":
			if (!found) return { isError: true, content: [{ type: "text", text: "not found" }] };
			if (typeof args.title === "string") found.title = args.title;
			if (typeof args.code === "string") found.code = args.code;
			return text(found);
		default:
			return { isError: true, content: [{ type: "text", text: "unknown tool" }] };
	}
}

export function startAccountStub(expectedToken: string, seed: StubDiagram[]): AccountStub {
	const pending: { name: string; args: Record<string, unknown> }[] = [];
	const holds = new Map<string, { reach(): void; released: Promise<void> }>();
	const stub: AccountStub = {
		url: "", authorized: [], calls: [], diagrams: seed.map((diagram) => ({ ...diagram })), mode: "normal",
		landPending: () => {
			for (const write of pending.splice(0)) answer(stub, write.name, write.args);
		},
		hold: (tool) => {
			const reached = Promise.withResolvers<void>();
			const released = Promise.withResolvers<void>();
			holds.set(tool, { reach: reached.resolve, released: released.promise });
			return { reached: reached.promise, release: released.resolve };
		},
		stop: () => undefined,
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(request) {
			stub.authorized.push(request.headers.get("authorization") === expectedToken);
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const message = (await request.json()) as { id?: number; method: string; params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> } };
			if (message.id === undefined) return new Response(null, { status: 202 });
			const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: message.id, result });
			if (message.method === "initialize") return reply({ protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "mermaid-account-stub", version: "1" } });
			if (message.method === "tools/list") return reply({ tools: [...WRITES, "list_mermaid_chart_projects", "list_mermaid_chart_diagrams", "get_mermaid_chart_diagram", "repair_mermaid_chart_diagram"].map((name) => ({ name, inputSchema: { type: "object", properties: {} } })) });
			if (message.method !== "tools/call") return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
			const name = message.params?.name ?? "";
			const args = message.params?.arguments ?? {};
			stub.calls.push({ name, arguments: args });
			const held = holds.get(name);
			if (held) {
				holds.delete(name);
				held.reach();
				await held.released;
			}
			if (WRITES.has(name) && stub.mode === "reject-write") return reply({ isError: true, content: [{ type: "text", text: "rejected" }] });
			if (WRITES.has(name) && stub.mode === "lose-write") {
				pending.push({ name, args });
				return new Response("upstream reset", { status: 502 });
			}
			const result = answer(stub, name, args);
			return WRITES.has(name) && stub.mode === "drop-write" ? new Response("upstream reset", { status: 502 }) : reply(result);
		},
	});
	Object.assign(stub, { url: `http://127.0.0.1:${server.port}/mcp`, stop: () => server.stop(true) });
	return stub;
}
