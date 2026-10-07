import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Public seam: the gate CLI as a process, driven by a fixture plan of real
// shell steps. Expected values are test-owned literals.

const GATE = path.join(import.meta.dir, "repository-gate.ts");
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Step = { name: string; run: string[] };

function sh(name: string, script: string): Step {
	return { name, run: ["/bin/sh", "-c", script] };
}

function fixtureRoot(): string {
	const root = mkdtempSync(path.join(tmpdir(), "repository-gate-test-"));
	roots.push(root);
	return root;
}

async function runGate(
	root: string,
	plan: { barrier?: Step[]; lanes: { name: string; steps: Step[] }[]; profiles?: unknown },
	args: string[] = [],
	env: Record<string, string> = {},
) {
	const planPath = path.join(root, "plan.json");
	writeFileSync(planPath, JSON.stringify({ version: 1, barrier: [], ...plan }));
	const child = Bun.spawn(["bun", GATE, "--plan", planPath, ...args], {
		env: { ...process.env, GITHUB_ACTIONS: "", GITHUB_STEP_SUMMARY: "", ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, exitCode };
}

// The block printed for one step: its header up to the next step's header.
function blockFor(stdout: string, header: string): string {
	const start = stdout.indexOf(header);
	if (start === -1) return "";
	const next = stdout.indexOf("\n=== ", start + header.length);
	return stdout.slice(start, next === -1 ? undefined : next);
}

test("a failing step fails the gate while every other step still runs under its own header", async () => {
	const root = fixtureRoot();
	const result = await runGate(root, {
		lanes: [
			{
				name: "alpha",
				steps: [sh("breaks", "echo alpha-output; exit 3"), sh("after", `touch ${root}/alpha-after`)],
			},
			{ name: "beta", steps: [sh("works", `echo beta-output; touch ${root}/beta`)] },
		],
	});

	expect(result.exitCode).toBe(1);
	expect(existsSync(`${root}/alpha-after`)).toBe(true);
	expect(existsSync(`${root}/beta`)).toBe(true);
	expect(blockFor(result.stdout, "FAIL alpha > breaks (exit 3,")).toContain("alpha-output");
	expect(blockFor(result.stdout, "FAIL alpha > breaks (exit 3,")).not.toContain("beta-output");
	expect(blockFor(result.stdout, "PASS beta > works (exit 0,")).toContain("beta-output");
	expect(result.stdout).toContain("FAIL: 2/3 steps passed");
});

test("a step killed by a signal fails the gate", async () => {
	const result = await runGate(fixtureRoot(), { lanes: [{ name: "alpha", steps: [sh("dies", "kill -KILL $$")] }] });

	expect(result.exitCode).toBe(1);
	expect(result.stdout).toContain("FAIL alpha > dies (killed by SIGKILL,");
});

test("a step that cannot start fails the gate and names why", async () => {
	const result = await runGate(fixtureRoot(), {
		lanes: [
			{
				name: "alpha",
				steps: [
					{ name: "missing binary", run: ["/nonexistent/repository-gate-binary"] },
					{ name: "missing variable", run: ["echo", "${REPOSITORY_GATE_TEST_UNSET}"] },
				],
			},
		],
	});

	expect(result.exitCode).toBe(1);
	expect(result.stdout).toContain("FAIL alpha > missing binary (could not start:");
	expect(result.stdout).toContain(
		"FAIL alpha > missing variable (could not start: environment variable REPOSITORY_GATE_TEST_UNSET is required,",
	);
	expect(result.stdout).toContain("FAIL: 0/2 steps passed");
});

test("a gate whose steps all pass exits zero", async () => {
	const result = await runGate(fixtureRoot(), {
		lanes: [
			{ name: "alpha", steps: [sh("one", "true")] },
			{ name: "beta", steps: [sh("two", "true")] },
		],
	});

	expect(result.exitCode).toBe(0);
	expect(result.stdout).toContain("PASS: 2/2 steps passed");
});

test("lanes start after the barrier and run at the same time", async () => {
	const root = fixtureRoot();
	// Each lane waits for the other's marker, so serial lanes would time out.
	const waitFor = (marker: string) =>
		`test -f ${root}/barrier || exit 4; touch ${root}/${marker}-started; i=0; while [ ! -f ${root}/${marker === "alpha" ? "beta" : "alpha"}-started ]; do i=$((i+1)); [ $i -gt 100 ] && exit 5; sleep 0.05; done`;
	const result = await runGate(root, {
		barrier: [sh("slow barrier", `sleep 0.3; touch ${root}/barrier`)],
		lanes: [
			{ name: "alpha", steps: [sh("waits", waitFor("alpha"))] },
			{ name: "beta", steps: [sh("waits", waitFor("beta"))] },
		],
	});

	expect(result.stdout).toContain("PASS barrier > slow barrier");
	expect(result.stdout).toContain("PASS alpha > waits");
	expect(result.stdout).toContain("PASS beta > waits");
	expect(result.exitCode).toBe(0);
});

test("a process a step leaves running is terminated when the step ends", async () => {
	const root = fixtureRoot();
	const result = await runGate(root, {
		lanes: [{ name: "alpha", steps: [sh("leaks", `sleep 30 & echo $! > ${root}/pid`)] }],
	});
	const pid = Number(readFileSync(`${root}/pid`, "utf8"));
	let alive = true;
	try {
		process.kill(pid, 0);
	} catch {
		alive = false;
	}

	expect(alive).toBe(false);
	expect(result.stdout).toContain("WARN alpha > leaks: terminated processes left running after the step exited");
	expect(result.exitCode).toBe(0);
});

test("a profile appends its steps to the base lane of the same name, in order", async () => {
	const root = fixtureRoot();
	const result = await runGate(
		root,
		{
			lanes: [{ name: "static", steps: [sh("base", `sleep 0.2; touch ${root}/base`)] }],
			profiles: { ci: { lanes: [{ name: "static", steps: [sh("extra", `test -f ${root}/base`)] }] } },
		},
		["--profile", "ci"],
	);

	expect(result.stdout).toContain("PASS static > extra");
	expect(result.exitCode).toBe(0);
});

test("a profile's barrier steps run after the base barrier and before every lane", async () => {
	const root = fixtureRoot();
	const result = await runGate(
		root,
		{
			barrier: [sh("base", `touch ${root}/base`)],
			lanes: [{ name: "alpha", steps: [sh("needs barrier", `test -f ${root}/profile || exit 4`)] }],
			profiles: {
				ci: {
					barrier: [sh("profile", `test -f ${root}/base || exit 4; sleep 0.2; touch ${root}/profile`)],
					lanes: [],
				},
			},
		},
		["--profile", "ci"],
	);

	expect(result.stdout).toContain("PASS barrier > profile");
	expect(result.stdout).toContain("PASS alpha > needs barrier");
	expect(result.exitCode).toBe(0);
});

test("an unknown profile refuses before any step runs", async () => {
	const root = fixtureRoot();
	const result = await runGate(root, { lanes: [{ name: "alpha", steps: [sh("one", `touch ${root}/ran`)] }] }, [
		"--profile",
		"missing",
	]);

	expect(result.exitCode).toBe(2);
	expect(result.stderr).toContain("unknown profile: missing");
	expect(existsSync(`${root}/ran`)).toBe(false);
});

test("an interrupted gate terminates its running steps and removes its step logs", async () => {
	const root = fixtureRoot();
	const scratch = path.join(root, "tmp");
	mkdirSync(scratch);
	const planPath = path.join(root, "plan.json");
	writeFileSync(
		planPath,
		JSON.stringify({ version: 1, barrier: [], lanes: [{ name: "alpha", steps: [sh("hangs", `echo $$ > ${root}/pid; sleep 30`)] }] }),
	);
	const gate = Bun.spawn(["bun", GATE, "--plan", planPath], {
		env: { ...process.env, GITHUB_ACTIONS: "", GITHUB_STEP_SUMMARY: "", TMPDIR: scratch },
		stdout: "ignore",
		stderr: "ignore",
	});
	for (let attempt = 0; attempt < 100 && !existsSync(`${root}/pid`); attempt++) await Bun.sleep(50);
	const pid = Number(readFileSync(`${root}/pid`, "utf8"));
	gate.kill("SIGTERM");
	const exitCode = await gate.exited;
	await Bun.sleep(100);
	let alive = true;
	try {
		process.kill(pid, 0);
	} catch {
		alive = false;
	}

	expect(exitCode).toBe(143);
	expect(alive).toBe(false);
	expect(readdirSync(scratch)).toEqual([]);
});
