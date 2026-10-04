#!/usr/bin/env bun
// Minimal MCP stdio server used only to observe what a real MCPorter stdio
// child receives through the route: cwd, argv, environment key presence, and
// the non-secret selection. It never prints another environment value.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const spawnMarker = process.env.PROBE_SPAWN_MARKER;
if (spawnMarker) writeFileSync(spawnMarker, "spawned\n");
const fixtureRoot = process.env.TMPDIR;
if (fixtureRoot) {
	writeFileSync(path.join(fixtureRoot, "probe-spawned"), "spawned\n");
	if (existsSync(path.join(fixtureRoot, "probe-schema-failure-request"))) process.exit(9);
	const request = path.join(fixtureRoot, "mcporter-noisy-stderr-request.json");
	if (existsSync(request)) {
		const { bytes } = JSON.parse(readFileSync(request, "utf8")) as { bytes: number };
		await new Promise<void>((resolve, reject) => process.stderr.write("x".repeat(bytes), (error) => (error ? reject(error) : resolve())));
		writeFileSync(path.join(fixtureRoot, "mcporter-noisy-stderr-receipt.json"), JSON.stringify({ bytesWritten: bytes }));
	}
}

const probe = {
	cwd: process.cwd(),
	argv: process.argv.slice(2),
	envKeys: Object.keys(process.env).sort(),
	ambientSentinelPresent: "AMBIENT_SENTINEL" in process.env,
	selection: process.env.PROBE_SELECTION ?? null,
};
const tool = {
	name: "probe",
	description: `stdio child probe: ${JSON.stringify(probe)}`,
	inputSchema: { type: "object", properties: {}, additionalProperties: false },
};
// PROBE_TOOL_NAMES (comma-separated) advertises extra tool names so a real
// MCPorter allow-list can be observed filtering a known upstream catalog.
const extraTools = (process.env.PROBE_TOOL_NAMES ?? "")
	.split(",")
	.filter((name) => name.length > 0)
	.map((name) => ({ name, description: "probe catalog tool", inputSchema: tool.inputSchema }));
function reply(id: unknown, result: unknown): void {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
	buffer += new TextDecoder().decode(chunk);
	let newline = buffer.indexOf("\n");
	while (newline !== -1) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		newline = buffer.indexOf("\n");
		if (!line) continue;
		const message = JSON.parse(line) as { id?: unknown; method?: string; params?: { protocolVersion?: string; name?: string } };
		switch (message.method) {
			case "initialize":
				reply(message.id, {
					protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
					capabilities: { tools: {} },
					serverInfo: { name: "stdio-probe-server", version: "0.0.0" },
				});
				break;
			case "ping":
				reply(message.id, {});
				break;
			case "tools/list":
				reply(message.id, { tools: [tool, ...extraTools] });
				break;
			case "tools/call":
				reply(message.id, { content: [{ type: "text", text: JSON.stringify({ ...probe, calledTool: message.params?.name ?? null }) }] });
				break;
			default:
				if (message.id !== undefined) {
					process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } })}\n`);
				}
		}
	}
}
