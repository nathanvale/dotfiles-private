/** Canonical test-only Agent Browser success envelope. */
export function agentBrowserSuccess(data: unknown): string {
	return JSON.stringify({ success: true, data, error: null });
}

/** One canonical stateful process fake for public Agent Browser owner receipts. */
export function agentBrowserProcessFixtureSource(input: {
	statePath: string;
	callLogPath: string;
	targetId: string;
	snapshotPayload?: string;
	snapshotDelayMs?: number;
}): string {
	return [
		`#!${process.execPath}`,
		'import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";',
		`const statePath = ${JSON.stringify(input.statePath)};`,
		`const callLogPath = ${JSON.stringify(input.callLogPath)};`,
		`const targetId = ${JSON.stringify(input.targetId)};`,
		"const args = process.argv.slice(2);",
		"appendFileSync(callLogPath, `${JSON.stringify(args)}\\n`);",
		'if (args.includes("--version")) { process.stdout.write("agent-browser 0.34.0\\n"); process.exit(0); }',
		"const has = (value) => args.includes(value);",
		"let data = {};",
		'if (args[0] === "session" && args[1] === "list") data = { sessions: [] };',
		'else if (has("close") && !has("tab")) data = { closed: true };',
		'else if (has("tab") && has("new")) { const index = args.indexOf("new"); writeFileSync(statePath, JSON.stringify({ url: args[index + 1] })); data = { targetId }; }',
		'else if (has("tab") && has("close")) { rmSync(statePath, { force: true }); data = { closed: true }; }',
		'else if (has("tab") && has("list")) { const present = existsSync(statePath); const state = present ? JSON.parse(readFileSync(statePath, "utf8")) : undefined; data = { tabs: present ? [{ tabId: targetId, targetId, type: "page", active: true, url: state.url, title: "Qualification fixture" }] : [] }; }',
		'else if (has("tab")) data = { selected: true };',
		'else if (has("get") && has("url")) { const state = JSON.parse(readFileSync(statePath, "utf8")); data = { url: state.url }; }',
		'else if (has("get") && has("html")) data = { html: "<main>fixture target</main>" };',
		`else if (has("snapshot")) {${input.snapshotDelayMs === undefined ? "" : ` await Bun.sleep(${input.snapshotDelayMs});`} data = ${input.snapshotPayload === undefined ? '{ snapshot: "fixture snapshot" }' : JSON.stringify(input.snapshotPayload)}; }`,
		"process.stdout.write(JSON.stringify({ success: true, data, error: null }));",
	].join("\n");
}
