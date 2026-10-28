// Drives the Figma Console process machine through its compiled front door.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runBundle } from "../../../../tests/harness.ts";
import type { Machine } from "./console-machine.ts";
import { type ConsoleMachine, consoleMachine } from "./plugin-copy.ts";

export const USER = "1614063074302308556";
export const EMAIL = "fixture.user@example.test";
export const ITEM = "abcdefghijklmnopqrstuv1234";
export const SERVER = "figma-console-local";
export interface Envelope { result: { causeCode: string; outcome: string; transactionState: string; exitCode: number; data: Record<string, any> | null; effects: { completed: string[]; uncertain: string[] } } }
export interface Call { argv: string[]; cwd: string; env: Record<string, string> }

export const runningDaemon = (): NonNullable<Machine["daemon"]> => ({ pid: 41000, socketPath: "/fixture/daemon.sock", generation: 1, views: 0, servers: [{ name: SERVER, connectionId: SERVER, connected: true, activeCalls: 0 }] });
export const textNode = () => ({ id: "7:285", type: "TEXT", name: "Fixture text", characters: "Before", fontName: { family: "Inter", style: "Regular" }, fontSize: 16 });
export const UPDATE = { nodeId: "7:285", text: "After", fontFamily: "Inter", fontStyle: "Regular", fontSize: 16 };

export function consoleCli() {
	const machine: ConsoleMachine = consoleMachine();
	const select = (file: string) => ["--select", "account=monash", "--select", `file=${file}`];
	const bundle = { root: machine.root, binary: machine.binary, skillsRoot: path.join(machine.plugin, "skills"), addSkill() {}, dispose() {} };
	const profileRoot = (file: string) => path.join(machine.state, "connectors/figma-console/monash", file);
	const journal = (file: string) => path.join(profileRoot(file), "journal");
	const api = {
		machine, select, profileRoot, journal,
		async run(argv: string[]) {
			const result = await runBundle(bundle, argv, { home: machine.home, extraEnv: { XDG_STATE_HOME: machine.state }, cwd: machine.root, timeoutMs: 30000 });
			return { ...result, envelope: (result.stdout ? JSON.parse(result.stdout) : null) as Envelope | null };
		},
		write(file: string, operation: string, input: unknown, ...phase: string[]) { return api.run(["run", "figma-console", ...select(file), operation, "--input", JSON.stringify(input), ...phase]); },
		recover(file: string, ...rest: string[]) { return api.run(["recover", "figma-console", ...select(file), ...rest]); },
		async configure(file: string, input: Record<string, unknown> = {}) {
			return api.run(["auth", "configure", "figma-console", ...select(file), "--input", JSON.stringify({ email: EMAIL, userId: USER, itemId: ITEM, runtimeRoot: machine.runtimeRoot, nodeFile: machine.nodeFile, ...input })]);
		},
		setMachine(value: Partial<Machine> & { document: Machine["document"] }) {
			rmSync(path.join(machine.root, "mcporter-calls.jsonl"), { force: true });
			writeFileSync(path.join(machine.root, "machine.json"), JSON.stringify({ daemon: runningDaemon(), replies: {}, storage: {}, held: [], heldOutcomes: [], faults: {}, effects: 0, starts: 0, autostarts: 0, ...value }));
		},
		state(): Machine { return JSON.parse(readFileSync(path.join(machine.root, "machine.json"), "utf8")) as Machine; },
		patch(change: (value: Machine) => void) { const value = api.state(); change(value); writeFileSync(path.join(machine.root, "machine.json"), JSON.stringify(value)); },
		calls(): Call[] { const file = path.join(machine.root, "mcporter-calls.jsonl"); return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Call) : []; },
		// Execute calls carrying the fixed mutation script; every other execute is a read.
		mutations(): Call[] { return api.calls().filter((call) => call.argv[3] === `${SERVER}.figma_execute` && call.argv.join(" ").includes("async function mutate()")); },
		entries(file: string): string[] { return existsSync(journal(file)) ? readdirSync(journal(file)).filter((name) => !name.startsWith(".")).sort() : []; },
		receipt(file: string, id: string): Record<string, any> { return JSON.parse(readFileSync(path.join(journal(file), `${id}.json`), "utf8")); },
	};
	return api;
}

export const cause = (envelope: Envelope | null) => envelope?.result.data?.connectorCause;
export const document = (fileKey: string, extra: Partial<Machine["document"]> = {}): Machine["document"] => ({ fileKey, userId: USER, node: textNode(), variables: [], collections: [], ...extra });
