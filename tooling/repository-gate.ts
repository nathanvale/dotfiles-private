import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverPluginSteps } from "./plugin-tests.ts";

// Runs the repository gate as concurrent lanes. Steps inside a lane keep their
// declared order; lanes run side by side after the barrier steps finish. Every
// step runs even when another fails, and the gate fails when any step exits
// non-zero, dies by signal, or cannot start. Each step's combined output is
// held in its own log and printed as one block under its own header.

const repoRoot = path.resolve(import.meta.dir, "..");
const DEFAULT_PLAN = path.join(repoRoot, "tooling/repository-gate.json");
const TEARDOWN_GRACE_MS = 2000;

interface StepSpec {
	name: string;
	cwd?: string;
	run: string[];
}

interface LaneSpec {
	name: string;
	steps: StepSpec[];
}

type PlanLane = LaneSpec | { pluginLanes: true };

interface Plan {
	version: 1;
	barrier: StepSpec[];
	lanes: PlanLane[];
	profiles?: Record<string, { barrier?: StepSpec[]; lanes: LaneSpec[] }>;
}

interface StepResult {
	label: string;
	exitCode: number | null;
	signal: string | null;
	error?: string;
	durationMs: number;
	leaked: boolean;
}

interface Options {
	planPath: string;
	profile?: string;
	jobs: number;
}

const running = new Set<ChildProcess>();
const inGitHubActions = process.env.GITHUB_ACTIONS === "true";

function parseArgs(argv: string[]): Options {
	const options: Options = { planPath: DEFAULT_PLAN, jobs: Number.POSITIVE_INFINITY };
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (value === undefined) throw new Error(`${flag} needs a value`);
		if (flag === "--plan") options.planPath = path.resolve(value);
		else if (flag === "--profile") options.profile = value;
		else if (flag === "--jobs" && Number(value) >= 1) options.jobs = Number(value);
		else throw new Error(`unknown or invalid argument: ${flag} ${value}`);
		index++;
	}
	return options;
}

function pluginLanes(): LaneSpec[] {
	const lanes = new Map<string, LaneSpec>();
	for (const step of discoverPluginSteps()) {
		const lane = lanes.get(step.plugin) ?? { name: step.plugin, steps: [] };
		lane.steps.push({ name: step.script, cwd: `config/agents/plugins/${step.plugin}`, run: ["bun", "run", step.script] });
		lanes.set(step.plugin, lane);
	}
	return [...lanes.values()];
}

// A profile lane whose name matches a base lane appends its steps there, so a
// profile can extend a lane whose steps must stay sequential.
function resolveLanes(plan: Plan, profile: string | undefined): LaneSpec[] {
	const lanes = plan.lanes.flatMap((lane) => ("pluginLanes" in lane ? pluginLanes() : [{ ...lane, steps: [...lane.steps] }]));
	if (profile === undefined) return lanes;
	const extra = plan.profiles?.[profile];
	if (extra === undefined) throw new Error(`unknown profile: ${profile}`);
	for (const lane of extra.lanes) {
		const existing = lanes.find((candidate) => candidate.name === lane.name);
		if (existing) existing.steps.push(...lane.steps);
		else lanes.push({ ...lane, steps: [...lane.steps] });
	}
	return lanes;
}

// A profile's barrier steps run after the base barrier, before any lane.
function resolveBarrier(plan: Plan, profile: string | undefined): StepSpec[] {
	const extra = profile === undefined ? [] : (plan.profiles?.[profile]?.barrier ?? []);
	return [...plan.barrier, ...extra];
}

function expandArgs(run: string[]): string[] {
	return run.map((arg) =>
		arg.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
			const value = process.env[name];
			if (!value) throw new Error(`environment variable ${name} is required`);
			return value;
		}),
	);
}

function groupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		// The group already exited.
	}
}

// A step runs as its own process group. Anything still in that group after the
// step's leader exits is a leaked process: terminate it so it cannot contend
// with, or hold resources from, steps in other lanes.
async function reapGroup(pid: number | undefined): Promise<boolean> {
	if (pid === undefined || !groupAlive(pid)) return false;
	signalGroup(pid, "SIGTERM");
	const deadline = Date.now() + TEARDOWN_GRACE_MS;
	while (groupAlive(pid) && Date.now() < deadline) await Bun.sleep(50);
	if (groupAlive(pid)) signalGroup(pid, "SIGKILL");
	return true;
}

function startChild(step: StepSpec, logFd: number): ChildProcess {
	const argv = expandArgs(step.run);
	return spawn(argv[0] ?? "", argv.slice(1), {
		cwd: path.resolve(repoRoot, step.cwd ?? "."),
		detached: true,
		env: process.env,
		stdio: ["ignore", logFd, logFd],
	});
}

function waitForChild(child: ChildProcess): Promise<Pick<StepResult, "exitCode" | "signal" | "error">> {
	return new Promise((resolve) => {
		child.once("error", (error) => resolve({ exitCode: null, signal: null, error: error.message }));
		child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
	});
}

async function runStep(step: StepSpec, label: string, logPath: string): Promise<StepResult> {
	const started = performance.now();
	const logFd = openSync(logPath, "w");
	let outcome: Pick<StepResult, "exitCode" | "signal" | "error">;
	let leaked = false;
	try {
		const child = startChild(step, logFd);
		running.add(child);
		outcome = await waitForChild(child);
		running.delete(child);
		leaked = await reapGroup(child.pid);
	} catch (error) {
		outcome = { exitCode: null, signal: null, error: error instanceof Error ? error.message : String(error) };
	} finally {
		closeSync(logFd);
	}
	return { label, ...outcome, durationMs: performance.now() - started, leaked };
}

function passed(result: StepResult): boolean {
	return result.exitCode === 0 && result.signal === null && result.error === undefined;
}

function describe(result: StepResult): string {
	if (result.error !== undefined) return `could not start: ${result.error}`;
	if (result.signal !== null) return `killed by ${result.signal}`;
	return `exit ${result.exitCode}`;
}

function seconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function printBlock(result: StepResult, logPath: string): void {
	const ok = passed(result);
	const header = `${ok ? "PASS" : "FAIL"} ${result.label} (${describe(result)}, ${seconds(result.durationMs)})`;
	const body = readFileSync(logPath, "utf8");
	const leak = result.leaked ? `WARN ${result.label}: terminated processes left running after the step exited\n` : "";
	const grouped = ok && inGitHubActions;
	process.stdout.write(
		`${grouped ? "::group::" : "\n=== "}${header}\n${body}${body.endsWith("\n") || body === "" ? "" : "\n"}${leak}${grouped ? "::endgroup::\n" : ""}`,
	);
}

class StepRunner {
	private sequence = 0;
	readonly results: StepResult[] = [];

	constructor(private readonly logDir: string) {}

	async run(step: StepSpec, laneName: string): Promise<void> {
		this.sequence++;
		const label = `${laneName} > ${step.name}`;
		const logPath = path.join(this.logDir, `${this.sequence}.log`);
		console.log(`START ${label}`);
		const result = await runStep(step, label, logPath);
		this.results.push(result);
		printBlock(result, logPath);
	}
}

async function runLanes(lanes: LaneSpec[], jobs: number, runner: StepRunner): Promise<void> {
	const queue = [...lanes];
	const worker = async (): Promise<void> => {
		for (let lane = queue.shift(); lane !== undefined; lane = queue.shift()) {
			for (const step of lane.steps) await runner.run(step, lane.name);
		}
	};
	await Promise.all(Array.from({ length: Math.min(jobs, lanes.length) }, worker));
}

function summarize(results: StepResult[], wallMs: number): string {
	const rows = results.map((result) => `| ${passed(result) ? "pass" : "FAIL"} | ${result.label} | ${describe(result)} | ${seconds(result.durationMs)} |${result.leaked ? " leaked processes terminated" : ""}`);
	const failed = results.filter((result) => !passed(result)).length;
	const summed = results.reduce((total, result) => total + result.durationMs, 0);
	return [
		"| status | step | result | duration |",
		"| --- | --- | --- | --- |",
		...rows,
		"",
		`${failed === 0 ? "PASS" : "FAIL"}: ${results.length - failed}/${results.length} steps passed; wall ${seconds(wallMs)}, summed step time ${seconds(summed)}.`,
	].join("\n");
}

function installSignalHandlers(logDir: string): void {
	for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
		process.once(signal, () => {
			for (const child of running) if (child.pid !== undefined) signalGroup(child.pid, "SIGTERM");
			rmSync(logDir, { recursive: true, force: true });
			console.error(`\nrepository gate interrupted by ${signal}; terminated ${running.size} running step(s).`);
			process.exit(code);
		});
	}
}

async function main(): Promise<number> {
	const options = parseArgs(process.argv.slice(2));
	const plan = JSON.parse(readFileSync(options.planPath, "utf8")) as Plan;
	const lanes = resolveLanes(plan, options.profile);
	const barrier = resolveBarrier(plan, options.profile);
	const logDir = mkdtempSync(path.join(os.tmpdir(), "repository-gate-"));
	const runner = new StepRunner(logDir);
	installSignalHandlers(logDir);
	const started = performance.now();
	try {
		for (const step of barrier) await runner.run(step, "barrier");
		await runLanes(lanes, options.jobs, runner);
	} finally {
		rmSync(logDir, { recursive: true, force: true });
	}
	const summary = summarize(runner.results, performance.now() - started);
	console.log(`\n${summary}`);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Repository gate\n\n${summary}\n`);
	return runner.results.every(passed) ? 0 : 1;
}

process.exitCode = await main().catch((error: unknown) => {
	console.error(`repository gate could not run: ${error instanceof Error ? error.message : String(error)}`);
	return 2;
});
