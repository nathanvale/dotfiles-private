// A stateful stand-in for Figma's hosted MCP on 127.0.0.1. It speaks only
// MCP's JSON-over-HTTP transport to the real MCPorter, advertises the whole
// documented catalog (so MCPorter's allow-list does the filtering), and keeps
// just enough state for read-back: Code Connect mappings, generative plugins,
// shaders, files with their visible frames, node fills, plans, Weave runs,
// and single-use upload slots whose URLs carry UPLOAD_CAPABILITY. It never
// sees the Connectors envelope and supplies no cause or effect. Its call log
// is test-owned evidence of what reached it.
export const CATALOG = [
	"whoami", "get_metadata", "get_design_context", "get_screenshot", "get_variable_defs", "download_assets", "get_motion_context", "get_figjam", "get_libraries", "search_design_system",
	"get_code_connect_map", "get_code_connect_suggestions", "get_context_for_code_connect", "list_generative_plugins", "get_generative_plugin", "list_shaders", "get_shader", "list_file_shaders",
	"add_code_connect_map", "send_code_connect_mappings", "create_generative_plugin", "create_shader", "update_generative_plugin", "update_shader", "create_new_file", "generate_diagram", "use_figma",
	"generate_figma_design", "upload_assets",
	"weave_list_tools", "weave_get_tool_inputs", "weave_get_tool_run_output", "weave_cancel_tool_run", "weave_run_tool", "weave_upload_asset",
];

export type Args = Record<string, any>;
// The secret-shaped token every upload URL carries; no output may contain it.
export const UPLOAD_CAPABILITY = "SENTINEL_FIGMA_UPLOAD_CAPABILITY";
interface Item {
	id: string;
	name: string;
	version: number;
}
export interface FigmaStub {
	readonly url: string;
	readonly calls: { tool: string; args: Args }[];
	// The next call to this tool takes effect (unless skipEffect) and then
	// fails at HTTP, so its reply never reaches MCPorter.
	failNext: { tool: string; skipEffect: boolean } | null;
	// A Weave recipe's quoted cost; 0 runs at once without a quote.
	weaveCost: number;
	// The next use_figma reply succeeds but takes no visible effect.
	silentUseFigma: boolean;
	// Every upload POST the stub accepted, in order.
	readonly posts: { slot: string; contentType: string; sha256: string }[];
	// When set, upload URLs name this origin instead of the stub's own.
	uploadOrigin: string | null;
	// A mapping that lands outside any reply, as a late request would.
	landMapping(fileKey: string, nodeId: string, componentName: string, source: string): void;
	// A run finishes independently of a cancellation request.
	finishRun(runId: string, status: "COMPLETED" | "FAILED"): void;
	stop(): void;
}

export function startFigmaStub(): FigmaStub {
	const mappings = new Map<string, { componentName: string; source: string }[]>();
	const plugins: Item[] = [];
	const shaders: Item[] = [];
	const files = new Map<string, string[]>([["FileKeyExisting01", ["Root"]]]);
	const runs: { runId: string; status: string }[] = [{ runId: "run-0", status: "COMPLETED" }];
	const fills = new Map<string, string>();
	const slots = new Map<string, { fileKey: string; nodeId: string | null; used: boolean }>();
	let counter = 0;
	const next = (prefix: string) => `${prefix}${String(++counter).padStart(4, "0")}`;
	const metadata = (fileKey: string) => {
		const names = files.get(fileKey);
		return names === undefined ? null : { xml: names.map((name, index) => `<frame id="1:${index + 1}" name="${name}" />`).join("\n") };
	};
	const effects: Record<string, (args: Args) => unknown> = {
		whoami: () => ({ email: "fixture@example.test", plans: [{ key: "team::1", name: "Fixture team", seat: "Full" }] }),
		get_metadata: (args) => metadata(args.fileKey),
		get_design_context: (args) => ({ code: `<div data-node-id="${args.nodeId}" data-fill="${fills.get(`${args.fileKey}:${args.nodeId}`) ?? "none"}" />` }),
		upload_assets: (args) => {
			if (!files.has(args.fileKey)) return null;
			const uploads = Array.from({ length: args.count }, (_, index) => {
				const slot = next("slot-");
				const nodeId = args.nodeIds?.[index] ?? null;
				slots.set(slot, { fileKey: args.fileKey, nodeId, used: false });
				return { uploadUrl: `${stub.uploadOrigin ?? origin()}/upload/${slot}?token=${UPLOAD_CAPABILITY}`, ...(nodeId ? { targetNodeId: nodeId } : {}) };
			});
			return { uploads };
		},
		get_code_connect_map: (args) => ({ mappings: mappings.get(`${args.fileKey}:${args.nodeId}`) ?? [] }),
		add_code_connect_map: (args) => {
			const key = `${args.fileKey}:${args.nodeId}`;
			mappings.set(key, [...(mappings.get(key) ?? []), { componentName: args.componentName, source: args.source }]);
			return { mapped: true };
		},
		send_code_connect_mappings: (args) => {
			const key = `${args.fileKey}:${args.nodeId}`;
			for (const mapping of args.mappings) mappings.set(key, [...(mappings.get(key) ?? []), { componentName: mapping.componentName, source: mapping.source }]);
			return { saved: args.mappings.length };
		},
		list_generative_plugins: () => ({ plugins }),
		get_generative_plugin: (args) => plugins.find((plugin) => plugin.id === args.id) ?? null,
		create_generative_plugin: (args) => {
			const plugin = { id: next("gp-"), name: args.name, version: 1 };
			plugins.push(plugin);
			return { id: plugin.id };
		},
		update_generative_plugin: (args) => {
			const plugin = plugins.find((item) => item.id === args.id);
			if (plugin) plugin.version += 1;
			return { id: args.id, version: plugin?.version };
		},
		list_shaders: () => ({ shaders }),
		get_shader: (args) => shaders.find((shader) => shader.id === args.id) ?? null,
		create_shader: (args) => {
			const shader = { id: next("sh-"), name: args.name, version: 1 };
			shaders.push(shader);
			return { id: shader.id };
		},
		update_shader: (args) => {
			const shader = shaders.find((item) => item.id === args.id);
			if (shader) shader.version += 1;
			return { id: args.id, version: shader?.version };
		},
		create_new_file: (args) => {
			const key = next("FileKeyNewFile");
			files.set(key, ["Page 1"]);
			return { file_key: key, url: `https://www.figma.com/design/${key}/${encodeURIComponent(args.fileName)}` };
		},
		generate_diagram: (args) => {
			if (args.fileKey) {
				files.get(args.fileKey)?.push(args.name);
				return { url: `https://www.figma.com/board/${args.fileKey}/board` };
			}
			const key = next("BoardKeyNewOne");
			files.set(key, [args.name]);
			return { url: `https://www.figma.com/board/${key}/board` };
		},
		use_figma: (args) => {
			if (!stub.silentUseFigma) for (const match of String(args.code).matchAll(/add\("([^"]+)"\)/g)) files.get(args.fileKey)?.push(match[1] as string);
			stub.silentUseFigma = false;
			return { result: "ok" };
		},
		weave_get_tool_inputs: () => ({ version: 1, inputs: [{ nodeId: "prompt", name: "Prompt", type: "text" }] }),
		weave_list_tools: () => ({ tools: [{ recipeId: "recipe-1", name: "Fixture tool" }], total: 1 }),
		weave_get_tool_run_output: (args) => ({ runs: args.runIds ? runs.filter((run) => args.runIds.includes(run.runId)) : runs }),
		weave_run_tool: (args) => {
			if (stub.weaveCost > 0 && args.acknowledgedCost === undefined) return { status: "cost_confirmation_required", cost: stub.weaveCost, costDisclosure: "Fixture runs spend fixture credits." };
			if (stub.weaveCost > 0 && args.acknowledgedCost !== stub.weaveCost) return { status: "cost_confirmation_required", cost: stub.weaveCost };
			const started = Array.from({ length: args.numberOfRuns ?? 1 }, () => ({ runId: next("run-"), status: "RUNNING" }));
			runs.push(...started);
			return { runIds: started.map((run) => run.runId) };
		},
		weave_cancel_tool_run: (args) => {
			for (const run of runs) if (args.runIds.includes(run.runId) && run.status === "RUNNING") run.status = "CANCELED";
			return { canceled: args.runIds.length };
		},
	};
	const stub: FigmaStub = {
		url: "",
		calls: [],
		failNext: null,
		weaveCost: 0,
		silentUseFigma: false,
		posts: [],
		uploadOrigin: null,
		landMapping(fileKey, nodeId, componentName, source) {
			const key = `${fileKey}:${nodeId}`;
			mappings.set(key, [...(mappings.get(key) ?? []), { componentName, source }]);
		},
		finishRun(runId, status) {
			const run = runs.find((item) => item.runId === runId);
			if (run?.status === "RUNNING") run.status = status;
		},
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
			const url = new URL(request.url);
			if (url.pathname.startsWith("/upload/")) return upload(url, request);
			const message = (await request.json()) as { id?: number; method: string; params?: { protocolVersion?: string; name?: string; arguments?: Args } };
			if (message.id === undefined) return new Response(null, { status: 202 });
			const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: message.id, result });
			if (message.method === "initialize") return reply({ protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "figma-stub", version: "1" } });
			if (message.method === "tools/list") return reply({ tools: CATALOG.map((name) => ({ name, inputSchema: { type: "object", properties: {} } })) });
			if (message.method !== "tools/call") return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
			const tool = message.params?.name ?? "";
			const args = message.params?.arguments ?? {};
			stub.calls.push({ tool, args });
			const failing = stub.failNext?.tool === tool ? stub.failNext : null;
			if (failing) stub.failNext = null;
			const effect = effects[tool];
			if (failing?.skipEffect) return new Response("upstream failure", { status: 500 });
			const result = effect ? effect(args) : null;
			if (failing) return new Response("upstream failure", { status: 500 });
			if (result === null) return reply({ isError: true, content: [{ type: "text", text: "not found" }] });
			return reply({ content: [{ type: "text", text: JSON.stringify(result) }] });
		},
	});
	function origin(): string {
		return `http://127.0.0.1:${server.port}`;
	}
	// One single-use slot: the POST places its bytes as a node fill or a new
	// frame, as Figma documents for an upload URL.
	async function upload(url: URL, request: Request): Promise<Response> {
		const slot = slots.get(url.pathname.slice("/upload/".length));
		if (url.searchParams.get("token") !== UPLOAD_CAPABILITY || slot === undefined || slot.used) return new Response(null, { status: 410 });
		slot.used = true;
		const bytes = new Uint8Array(await request.arrayBuffer());
		const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
		stub.posts.push({ slot: url.pathname.slice("/upload/".length), contentType: request.headers.get("content-type") ?? "", sha256 });
		if (slot.nodeId) fills.set(`${slot.fileKey}:${slot.nodeId}`, sha256.slice(0, 12));
		else files.get(slot.fileKey)?.push(`Image ${sha256.slice(0, 8)}`);
		return Response.json({ ok: true });
	}
	(stub as { url: string }).url = `${origin()}/mcp`;
	return stub;
}
