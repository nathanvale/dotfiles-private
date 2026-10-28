// Substituted process fixture: an in-process stand-in for pinned MCPorter
// 0.14.0 and the Console bridge, imported only by the private plugin copy's
// scripts/mcporter.ts. Everything above that leaf (route plan, environment,
// cwd, namespace, session gating, reply decoding, journal) is shipped source.
//
// Modelled, not live-qualified: `daemon status --json` prints null or
// { pid, servers[].activeCalls, idleBlocked } and start/stop print text, as read
// from the pinned MCPorter bytes; a call on a stopped namespace starts its
// daemon, as MCPorter's client ensureDaemon does; figma_execute relays the
// bridge's EXECUTE_CODE_RESULT ({ success, result } or { success:false, error })
// from payload/code.js inside one MCP text item; the bridge's timeout never
// cancels running code, so a held mutation can run after its reply was lost;
// Figma stores numbers as float32 and COLOR values as RGBA; clientStorage is
// the bridge's own device-local store.
//
// State lives beside the caller's HOME, as for the op fake: machine.json holds
// the daemon, the document and test faults; mcporter-calls.jsonl records every
// invocation's argv, cwd and environment (the front door holds no secret).
import { appendFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExecutionCapabilities } from "../../../../bin/adapters/contract.ts";

export type Data = Record<string, unknown>;
export interface Server { name: string; connectionId: string; connected: boolean; activeCalls: number; idleBlocked?: string }
export interface Machine {
	daemon: { pid: number; socketPath: string; generation: number; views: number; servers: Server[] } | null;
	document: { fileKey: string; userId?: string | undefined; node: Data; variables: Data[]; collections: Data[] };
	replies: Record<string, unknown>;
	storage: Record<string, unknown>;
	held: string[];
	heldOutcomes: string[];
	faults: { holdMutation?: boolean; releaseHeld?: boolean; mutationDelayMs?: number; failDaemonStartNoEffect?: boolean; dropAfterEffect?: boolean; killAfterEffect?: boolean; breakJournalAfterEffect?: boolean; snapshotDelayMs?: number; failDaemonStart?: boolean; changeOnExport?: boolean; fontReadback?: "variation" | "wrong" | "mixed" };
	effects: number;
	starts: number;
	autostarts: number;
}
export interface Invocation { readonly argv: readonly string[]; readonly cwd: string; readonly env: Readonly<Record<string, string>> }

const SERVER = "figma-console-local";
const text = (value: unknown) => JSON.stringify({ content: [{ type: "text", text: JSON.stringify(value) }] });
const refused = (message: string) => JSON.stringify({ isError: true, content: [{ type: "text", text: JSON.stringify({ success: false, error: `Error: ${message}` }) }] });

function find(node: Data, id: string): Data | null {
	if (node.id === id) return node;
	for (const child of Array.isArray(node.children) ? node.children as Data[] : []) {
		const found = find(child, id);
		if (found) return found;
	}
	return null;
}

// Only what the fixed scripts touch. Created nodes take fixture ids.
function figmaFor(machine: Machine): Data {
	const { document } = machine;
	let next = 900;
	return {
		fileKey: document.fileKey,
		get currentUser() { if (document.userId === undefined) throw new Error("currentuser permission absent"); return { id: document.userId, name: "Fixture user" }; },
		variables: {
			async getLocalVariablesAsync() { return document.variables; },
			async getLocalVariableCollectionsAsync() { return document.collections; },
			async getVariableByIdAsync(id: string) { const v = document.variables.find((item) => item.id === id); return v ? { ...v, setValueForMode(mode: string, value: unknown) { (v.valuesByMode as Data)[mode] = stored(value); } } : null; },
			async getVariableCollectionByIdAsync(id: string) { return document.collections.find((item) => item.id === id) ?? null; },
		},
		clientStorage: {
			async getAsync(key: string) { return machine.storage[key]; },
			async setAsync(key: string, value: unknown) { machine.storage[key] = value; },
		},
		async getNodeByIdAsync(id: string) { return find(document.node, id); },
		async loadFontAsync() {},
		createText() { next += 1; return { id: `9:${next}`, type: "TEXT", name: "", characters: "", fontName: { family: "Inter", style: "Regular" }, fontSize: 12 }; },
	};
}

function stored(value: unknown): unknown {
	if (typeof value === "number") return Math.fround(value);
	if (typeof value === "object" && value !== null && "r" in value) return Object.fromEntries(Object.entries({ a: 1, ...value }).map(([key, item]) => [key, Math.fround(item as number)]));
	return value;
}

function nodeAppend(node: Data): void {
	const walk = (n: Data) => {
		if (Array.isArray(n.children)) {
			n.appendChild = (child: Data) => { (n.children as Data[]).push(child); };
			for (const child of n.children as Data[]) walk(child);
		}
	};
	walk(node);
}
function strip(node: Data): void {
	delete node.appendChild;
	for (const child of Array.isArray(node.children) ? node.children as Data[] : []) strip(child);
}

export function fixtureRoot(env: Readonly<Record<string, string>>): string { return path.dirname(env.HOME ?? "/nonexistent"); }
export function machineFile(root: string): string { return path.join(root, "machine.json"); }
const load = (root: string) => JSON.parse(readFileSync(machineFile(root), "utf8")) as Machine;
const save = (root: string, machine: Machine) => writeFileSync(machineFile(root), JSON.stringify(machine));

const run = (machine: Machine, code: string): Promise<unknown> => new Function("figma", `return (async function() {\n${code}\n})()`)(figmaFor(machine));

function shapeFontReadback(machine: Machine, mutation: boolean): void {
	if (!mutation) return;
	const node = machine.document.node;
	if (machine.faults.fontReadback === "variation") node.fontName = { family: "Inter", style: "Regular", variationSettings: { slnt: 0, wght: 400 } };
	if (machine.faults.fontReadback === "wrong") node.fontName = { family: "Wrong", style: "Regular", variationSettings: { slnt: 0, wght: 400 } };
	if (machine.faults.fontReadback === "mixed") node.fontName = { kind: "mixed" };
}

// Held mutations land late, in a later process, exactly as code the bridge
// timed out on keeps running in Desktop.
async function releaseHeld(root: string, machine: Machine): Promise<void> {
	for (const code of machine.held.splice(0)) {
		const before = JSON.stringify(machine.document);
		nodeAppend(machine.document.node);
		try { await run(machine, code); machine.heldOutcomes.push("ran"); } catch (error) { machine.heldOutcomes.push(error instanceof Error ? error.message : String(error)); }
		strip(machine.document.node);
		if (JSON.stringify(machine.document) !== before) machine.effects += 1;
	}
	save(root, machine);
}

async function execute(root: string, machine: Machine, invocation: Invocation, code: string): Promise<{ exit: number; stdout: string }> {
	const mutation = code.includes("async function mutate()");
	if (machine.faults.releaseHeld) await releaseHeld(root, machine);
	if (mutation && machine.faults.holdMutation) { machine.held.push(code); save(root, machine); return { exit: 1, stdout: "" }; }
	if (!mutation && machine.faults.snapshotDelayMs) await Bun.sleep(machine.faults.snapshotDelayMs);
	// A slow send: the mutation reaches Desktop late and sees the state then.
	if (mutation && machine.faults.mutationDelayMs) { await Bun.sleep(machine.faults.mutationDelayMs); Object.assign(machine, load(root)); }
	const before = JSON.stringify(machine.document), storage = JSON.stringify(machine.storage);
	nodeAppend(machine.document.node);
	try {
		const result: unknown = await run(machine, code);
		strip(machine.document.node);
		shapeFontReadback(machine, mutation);
		if (JSON.stringify(machine.storage) !== storage) save(root, machine);
		if (JSON.stringify(machine.document) === before) return { exit: 0, stdout: text({ success: true, result, resultAnalysis: { type: typeof result, warning: null }, fileContext: { fileName: "Fixture", fileKey: machine.document.fileKey } }) };
		machine.effects += 1;
		save(root, machine);
		if (machine.faults.breakJournalAfterEffect) chmodSync(path.join(invocation.cwd, "journal"), 0o500);
		if (machine.faults.killAfterEffect) process.kill(process.pid, "SIGKILL");
		if (machine.faults.dropAfterEffect) return { exit: 1, stdout: "" };
		return { exit: 0, stdout: text({ success: true, result, resultAnalysis: { type: typeof result, warning: null }, fileContext: { fileName: "Fixture", fileKey: machine.document.fileKey } }) };
	} catch (error) {
		strip(machine.document.node);
		return { exit: 0, stdout: refused(error instanceof Error ? error.message : String(error)) };
	}
}

function daemon(root: string, machine: Machine, verb: string | undefined, namespace: string): { exit: number; stdout: string } {
	if (verb === "status") return { exit: 0, stdout: `${JSON.stringify(machine.daemon)}\n` };
	if (verb === "stop") { machine.daemon = null; save(root, machine); return { exit: 0, stdout: "Daemon stopped (if it was running).\n" }; }
	if (machine.daemon) return { exit: 0, stdout: `Daemon already running (pid ${machine.daemon.pid}).\n` };
	if (machine.faults.failDaemonStartNoEffect) return { exit: 1, stdout: "" };
	machine.starts += 1;
	machine.daemon = { pid: 40000 + machine.starts, socketPath: path.join(namespace, "daemon", "fixture.sock"), generation: 1, views: 0, servers: [] };
	save(root, machine);
	return machine.faults.failDaemonStart ? { exit: 1, stdout: "" } : { exit: 0, stdout: "Single-user daemon started.\n" };
}

export async function runMcporter(_capabilities: ExecutionCapabilities, invocation: Invocation): Promise<{ exit: number; stdout: string }> {
	const root = fixtureRoot(invocation.env);
	appendFileSync(path.join(root, "mcporter-calls.jsonl"), `${JSON.stringify({ argv: invocation.argv, cwd: invocation.cwd, env: invocation.env })}\n`);
	const machine = load(root);
	const [configFlag, , verb, target, ...flags] = invocation.argv;
	if (configFlag !== "--config") return { exit: 9, stdout: "" };
	if (verb === "daemon") return daemon(root, machine, target, invocation.env.MCPORTER_DAEMON_DIR ?? "");
	if (verb !== "call" || !target?.startsWith(`${SERVER}.`)) return { exit: 1, stdout: "" };
	if (machine.daemon === null) { machine.autostarts += 1; daemon(root, machine, "start", invocation.env.MCPORTER_DAEMON_DIR ?? ""); }
	const daemonState = machine.daemon as NonNullable<Machine["daemon"]>;
	if (daemonState.servers.length === 0) { daemonState.servers.push({ name: SERVER, connectionId: SERVER, connected: true, activeCalls: 0 }); save(root, machine); }
	const tool = target.slice(SERVER.length + 1);
	const args = JSON.parse(flags[flags.indexOf("--args") + 1] ?? "{}") as Data;
	if (tool === "figma_execute") return execute(root, machine, invocation, String(args.code));
	if (tool === "figma_export_tokens" && machine.faults.changeOnExport) {
		machine.document.variables = [...machine.document.variables, { id: "VariableID:9:9", name: "changed/during", resolvedType: "FLOAT", scopes: ["GAP"], valuesByMode: { "1:0": 8 }, variableCollectionId: "VariableCollectionId:8:1" }];
		save(root, machine);
	}
	return { exit: 0, stdout: text(machine.replies[tool] ?? { ok: true, tool }) };
}
