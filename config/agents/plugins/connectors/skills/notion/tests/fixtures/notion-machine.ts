import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileFrontDoor } from "../../../../tests/compile-front-door.ts";
import { PLUGIN_ROOT, runBundle } from "../../../../tests/harness.ts";

export interface Envelope {
	result: { causeCode: string; data: (Record<string, unknown> & { previewId?: string; runId?: string; receipt?: { status: string } }) | null; transactionState: string; effects: { completed: string[]; uncertain: string[] } };
}

// Source-substituted process proof. Only the endpoint and registry endpoint vary.
// Real pinned MCPorter and the compiled front door own transport and envelopes.
// After-send failures are reached by construction, never by a wall-clock race:
// a delayed response ends its MCPorter client only once the write has arrived.
export function notionMachine(tools: string[]) {
	const root = mkdtempSync(path.join(os.tmpdir(), "connectors-notion-machine-"));
	const plugin = path.join(root, "plugin");
	const home = path.join(root, "home");
	const state = path.join(root, "state");
	const calls: { tool: string; args: Record<string, unknown> }[] = [];
	let text = "Original page";
	let pending = false;
	let silent = false;
	let mutationOverride: unknown;
	let taskResult: unknown = { pages: [{ id: "created-page" }] };
	let failure: "none" | "tool-error" | "partial-error" | "task-failed" | "transport-error" | "delayed-response" | "post-send-drop" = "none";
	const pendingResponses: ((apply: boolean) => void)[] = [];
	const objects = new Map<string, string>();
	function taskReply(): unknown {
		if (failure === "task-failed") return { response: { async_task: { task_id: "task-1", status: "failed", error: "fixture rejection" } } };
		return pending ? { status: "running" } : { status: "succeeded", result: taskResult };
	}
	function mutationReply(tool: string, args: Record<string, unknown>): unknown {
		if (mutationOverride !== undefined) return mutationOverride;
		if (tool === "notion-create-file-upload") return { upload_url: "https://upload.example.test/file?SENTINEL_SIGNED", upload_headers: { Authorization: "SENTINEL_UPLOAD_HEADER" } };
		if (tool === "notion-create-attachment") return { markdown_source: "file-upload://attachment-1" };
		if (tool === "notion-upload-skill" && args.action === "prepare") return { upload_url: "https://upload.example.test/skill", upload_headers: {}, upload_token: "SENTINEL_UPLOAD_TOKEN" };
		if (failure === "partial-error") text = "Partially changed";
		if (!silent && !pending && failure === "none") text = String(args.new_str ?? "Requested value");
		if (tool === "notion-spawn-session") return { session_url: "session://space-1/session-1" };
		return pending || failure === "task-failed" ? { response: { async_task: { task_id: "task-1" } } } : { pages: [{ id: "created-page" }], page_id: "page-1" };
	}
	function toolReply(tool: string, args: Record<string, unknown>): unknown {
		if (tool === "notion-get-async-task") return taskReply();
		if (tool === "notion-fetch") return { text: args.include_transcript === true ? `<meeting-notes><summary>AI summary</summary><transcript>Raw spoken words</transcript></meeting-notes>${text}` : objects.get(String(args.id)) ?? text };
		if (/^notion-(?:create|update|move|duplicate|convert|upload|spawn|stop|send)/.test(tool)) return mutationReply(tool, args);
		return { results: [], current_tool_access: {}, text };
	}
	let fixtureFault: unknown;
	// The client gives up after the write arrived: the held reply can no longer
	// reach it, so the effect can land later while the outcome stays unknown.
	async function endClient(port: number | undefined) {
		if (port === undefined) throw new Error("delayed-response fixture cannot identify its client");
		const lsof = Bun.spawn(["/usr/sbin/lsof", "-nP", "-t", `-iTCP@127.0.0.1:${port}`], { stdout: "pipe", stderr: "ignore" });
		const clients = (await new Response(lsof.stdout).text()).split("\n").map(Number).filter((pid) => pid > 0 && pid !== process.pid);
		if (clients.length === 0) throw new Error("delayed-response fixture found no client process");
		for (const pid of clients) process.kill(pid, "SIGKILL");
	}
	function failureResponse(tool: string, args: Record<string, unknown>, data: unknown, reply: (result: unknown) => Response, clientPort: number | undefined): Response | Promise<Response> | null {
		if (tool !== "notion-update-page") return null;
		if (failure === "delayed-response") {
			const held = new Promise<Response>((resolve) => {
				pendingResponses.push((apply) => {
					if (apply) text = String(args.new_str);
					resolve(apply ? reply({ content: [{ type: "text", text: JSON.stringify(data) }] }) : new Response(null, { status: 503 }));
				});
			});
			endClient(clientPort).catch((error: unknown) => { fixtureFault = error; });
			return held;
		}
		if (failure === "post-send-drop") return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{\"jsonrpc\":\"2.0\",\"result\":")); setTimeout(() => controller.error(new Error("fixture post-send response drop")), 10); } }), { headers: { "content-type": "application/json" } });
		return failure === "transport-error" ? new Response("fixture transport failure", { status: 503 }) : null;
	}
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request, served) {
		if (request.method !== "POST") return new Response(null, { status: 405 });
		const message = await request.json() as { id?: number; method: string; params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> } };
		if (message.id === undefined) return new Response(null, { status: 202 });
		const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: message.id, result });
		if (message.method === "initialize") return reply({ protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "notion-fixture", version: "1" } });
		if (message.method === "tools/list") return reply({ tools: tools.map((name) => ({ name, inputSchema: { type: "object", properties: {}, additionalProperties: true } })) });
		if (message.method !== "tools/call") return new Response(null, { status: 400 });
		const tool = String(message.params?.name);
		const args = message.params?.arguments ?? {};
		calls.push({ tool, args });
		const produced = toolReply(tool, args);
		const data = (failure === "tool-error" || failure === "partial-error") && /^notion-(?:create|update)/.test(tool) ? { status: 400, code: "validation_error", message: "fixture validation rejected the operation" } : produced;
		const altered = failureResponse(tool, args, data, reply, served.requestIP(request)?.port);
		if (altered !== null) return altered;
		return reply({ isError: (failure === "tool-error" || failure === "partial-error") && /^notion-(?:create|update)/.test(tool), content: [{ type: "text", text: JSON.stringify(data) }] });
	} });
	const endpoint = `http://127.0.0.1:${server.port}/mcp`;
	mkdirSync(home);mkdirSync(state);
	cpSync(PLUGIN_ROOT, plugin, { recursive: true, verbatimSymlinks: true });
	cpSync(path.join(import.meta.dir, "endpoint-fake.ts"), path.join(plugin, "skills/notion/scripts/endpoint.ts"));
	writeFileSync(path.join(root, "notion-endpoint"), endpoint);
	const registryFile = path.join(plugin, "skills/notion/config/mcporter.json");
	const registry = JSON.parse(readFileSync(registryFile, "utf8"));registry.mcpServers["notion-connectors"].baseUrl = endpoint;writeFileSync(registryFile, JSON.stringify(registry));
	compileFrontDoor(path.join(plugin, "bin/connectors.ts"), path.join(plugin, "bin/connectors"));
	return {
		root, home, state, calls,
		releaseDelayed() { for (const release of pendingResponses.splice(0)) release(true); },
		setMutationReply(value: unknown) { mutationOverride = value; }, setTaskResult(value: unknown) { taskResult = value; },
		setText(value: string) { text = value; }, setObject(id: string, value: string) { objects.set(id, value); }, setFailure(value: typeof failure) { failure = value; }, setPending(value: boolean) { pending = value; }, setSilent(value: boolean) { silent = value; },
		async run(argv: string[]) {
			const result = await runBundle({ root: plugin, binary: path.join(plugin, "bin/connectors"), skillsRoot: path.join(plugin, "skills"), addSkill() {}, dispose() {} }, argv, { home, extraEnv: { XDG_STATE_HOME: state, CONNECTORS_TEST_RELEASE_DIR: process.env.CONNECTORS_OFFICIAL_RELEASE_FIXTURE ?? "/nonexistent", NOTION_TOKEN: "SENTINEL_AMBIENT_NOTION" }, timeoutMs: 60000 });
			if (fixtureFault !== undefined) throw fixtureFault;
			return { ...result, envelope: JSON.parse(result.stdout) as Envelope };
		},
		dispose() { for (const release of pendingResponses.splice(0)) release(false); server.stop(true);rmSync(root, { recursive: true, force: true }); },
	};
}
