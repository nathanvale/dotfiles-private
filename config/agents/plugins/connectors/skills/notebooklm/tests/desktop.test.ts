import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runNotebooklmCommand } from "../scripts/desktop-command.ts";

// The existing public CLI tests cover routing and guards. This process layer
// proves the embedded transport helper's stream and cleanup contract without
// touching credentials. The real SSH canary separately qualifies macOS launchd.
function fixture(timeout = 65, permissionProbe?: "once" | "always") {
	const root = mkdtempSync(path.join(os.tmpdir(), "notebooklm-desktop-test-"));
	const launchctl = path.join(root, "launchctl");
	copyFileSync(path.join(import.meta.dir, "fixtures/desktop-launchctl.py"), launchctl);
	chmodSync(launchctl, 0o700);
	const helper = path.join(root, "helper.py");
	const source = readFileSync(path.join(import.meta.dir, "../scripts/desktop-command.py"), "utf8");
	// Only this private copy injects an inconclusive group-liveness probe. The
	// actual SIGKILL and the independent PID assertions still cross the OS.
	const probe = permissionProbe === undefined ? "" : `_original_killpg = os.killpg\n_probed = False\ndef _probe(group, number):\n    global _probed\n    if number == 0 and (${permissionProbe === "always" ? "True" : "not _probed"}):\n        _probed = True\n        raise PermissionError(1, 'synthetic inconclusive probe')\n    return _original_killpg(group, number)\nos.killpg = _probe\n`;
	writeFileSync(helper, source.replace('LAUNCHCTL = "/bin/launchctl"', `${probe}\nLAUNCHCTL = ${JSON.stringify(launchctl)}`).replace('TIMEOUT = 65', `TIMEOUT = ${timeout}`));
	const env = { HOME: root, PATH: "/usr/bin:/bin", TMPDIR: root, DESKTOP_FIXTURE: root };
	if (timeout < 65) writeFileSync(path.join(root, "wait-tree"), "");
	function start(program: string, owner = process.pid) {
		const request = { argv: ["/usr/bin/python3", "-c", program], env, owner };
		const child = Bun.spawn(["/usr/bin/python3", helper], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		child.stdin.write(JSON.stringify(request));
		child.stdin.end();
		return child;
	}
	return { root, start, dispose: () => {
		// Test hygiene is independent of the assertions above it, so a RED
		// cleanup perturbation cannot leave its owned synthetic processes alive.
		for (const name of ["running", "grandchild", "job.pid"]) {
			const file = path.join(root, name);
			if (!existsSync(file)) continue;
			try { process.kill(Number(readFileSync(file, "utf8")), "SIGKILL"); } catch { /* already stopped */ }
		}
		rmSync(root, { recursive: true, force: true });
	} };
}
async function result(child: ReturnType<ReturnType<typeof fixture>["start"]>) {
	const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	expect(stderr).toBe("");
	expect(exit).toBe(0);
	return JSON.parse(stdout);
}
async function waitFor(file: string) {
	for (let i = 0; i < 100 && !existsSync(file); i++) await Bun.sleep(20);
	expect(existsSync(file)).toBe(true);
}
async function expectStopped(file: string) {
	const pid = Number(readFileSync(file, "utf8"));
	for (let i = 0; i < 100; i++) {
		try { process.kill(pid, 0); } catch { return; }
		await Bun.sleep(20);
	}
	throw new Error(`owned process ${pid} survived cleanup`);
}
const TREE = "import os,signal,subprocess,time; from pathlib import Path; root=Path(os.environ['HOME']); (root/'running').write_text(str(os.getpid())); subprocess.Popen(['/usr/bin/python3','-c',\"import os,signal,time; from pathlib import Path; signal.signal(signal.SIGTERM,signal.SIG_IGN); (Path(os.environ['HOME'])/'grandchild').write_text(str(os.getpid())); time.sleep(30)\"]); time.sleep(30)";
test("desktop transport returns the exact result only after removing its job", async () => {
	const m = fixture(); try {
		writeFileSync(path.join(m.root, "private-value"), "SENTINEL_PRIVATE_CONTENT");
		const reply = await result(m.start("from pathlib import Path; import os; print((Path(os.environ['HOME'])/'private-value').read_text())"));
		expect(reply).toEqual({ status: 0, stdout: "SENTINEL_PRIVATE_CONTENT\n" });
		expect(existsSync(path.join(m.root, "removed"))).toBe(true);
		expect(existsSync(path.join(m.root, "job.pid"))).toBe(false);
		expect(readFileSync(path.join(m.root, "job.json"), "utf8")).not.toContain("SENTINEL_PRIVATE_CONTENT");
		expect(JSON.parse(readFileSync(path.join(m.root, "permissions.json"), "utf8"))).toEqual([448, 384, 384]);
	} finally { m.dispose(); }
});
test("a vendor failure keeps its exit status and removes the owned job", async () => {
	const m = fixture(); try {
		const reply = await result(m.start("raise SystemExit(7)"));
		expect(reply).toEqual({ status: 7, stdout: "" });
		expect(existsSync(path.join(m.root, "removed"))).toBe(true);
	} finally { m.dispose(); }
});
test("missing desktop refuses without launching a command", async () => {
	const m = fixture(); try {
		writeFileSync(path.join(m.root, "no-gui"), "");
		const reply = await result(m.start("print('should not run')"));
		expect(reply).toEqual({ status: 1, cause: "desktop-session-unavailable" });
		expect(existsSync(path.join(m.root, "job.json"))).toBe(false);
	} finally { m.dispose(); }
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
	test(`${signal} removes the live command before reporting interruption`, async () => {
		const m = fixture(); try {
			const child = m.start(TREE);
			await waitFor(path.join(m.root, "grandchild"));
			child.kill(signal);
			expect(await result(child)).toEqual({ status: 143, cause: "desktop-request-interrupted" });
			expect(existsSync(path.join(m.root, "job.pid"))).toBe(false);
			await expectStopped(path.join(m.root, "running"));
			await expectStopped(path.join(m.root, "grandchild"));
			expect(existsSync(path.join(m.root, "removed"))).toBe(true);
		} finally { m.dispose(); }
	});
}
test("cleanup failure withholds an otherwise successful private result", async () => {
	const m = fixture(); try {
		writeFileSync(path.join(m.root, "cleanup-failure"), "");
		const reply = await result(m.start("print('SENTINEL_PRIVATE_CONTENT')"));
		expect(reply).toEqual({ status: 1, cause: "desktop-cleanup-failed" });
	} finally { m.dispose(); }
});

test("caller death during the GUI check refuses before bootstrap", async () => {
	const m = fixture();
	const owner = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
	try {
		writeFileSync(path.join(m.root, "slow-gui"), "");
		const child = m.start("print('must not run')", owner.pid);
		await waitFor(path.join(m.root, "checking-gui"));
		owner.kill("SIGKILL"); await owner.exited;
		expect(await result(child)).toEqual({ status: 143, cause: "desktop-request-interrupted" });
		expect(existsSync(path.join(m.root, "job.json"))).toBe(false);
	} finally { owner.kill(); m.dispose(); }
});

test("caller death removes the command and its signal-resistant grandchild", async () => {
	const m = fixture();
	const owner = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
	try {
		const child = m.start(TREE, owner.pid);
		await waitFor(path.join(m.root, "grandchild"));
		owner.kill("SIGKILL"); await owner.exited;
		expect(await result(child)).toEqual({ status: 143, cause: "desktop-request-interrupted" });
		await expectStopped(path.join(m.root, "running"));
		await expectStopped(path.join(m.root, "grandchild"));
	} finally { owner.kill(); m.dispose(); }
});

for (const mode of ["bootstrap-failure", "bootstrap-timeout"]) {
	test(`${mode} cleans a job loaded before acknowledgement failed`, async () => {
		const m = fixture(); try {
			writeFileSync(path.join(m.root, mode), "");
			expect(await result(m.start(TREE))).toEqual({ status: 1, cause: "desktop-route-failed" });
			await expectStopped(path.join(m.root, "running"));
			await expectStopped(path.join(m.root, "grandchild"));
			expect(existsSync(path.join(m.root, "job.pid"))).toBe(false);
		} finally { m.dispose(); }
	}, 12000);
}

test("a deadline removes the live process tree and returns no private output", async () => {
	const m = fixture(5); try {
		expect(await result(m.start(TREE))).toEqual({ status: 1, cause: "desktop-request-timeout" });
		await expectStopped(path.join(m.root, "running"));
		await expectStopped(path.join(m.root, "grandchild"));
	} finally { m.dispose(); }
}, 12000);

test("a timed-out bootout still stops the known process group and withholds output", async () => {
	const m = fixture(5); try {
		writeFileSync(path.join(m.root, "bootout-timeout"), "");
		expect(await result(m.start(TREE))).toEqual({ status: 1, cause: "desktop-cleanup-failed" });
		await expectStopped(path.join(m.root, "running"));
		await expectStopped(path.join(m.root, "grandchild"));
	} finally { m.dispose(); }
}, 15000);

test("a transient group permission response still requires observed absence", async () => {
	const m = fixture(5, "once"); try {
		expect(await result(m.start(TREE))).toEqual({ status: 1, cause: "desktop-request-timeout" });
		await expectStopped(path.join(m.root, "running"));
		await expectStopped(path.join(m.root, "grandchild"));
	} finally { m.dispose(); }
}, 12000);

test("persistent group permission failure withholds the result", async () => {
	const m = fixture(5, "always"); try {
		expect(await result(m.start(TREE))).toEqual({ status: 1, cause: "desktop-cleanup-failed" });
		await expectStopped(path.join(m.root, "running"));
		await expectStopped(path.join(m.root, "grandchild"));
	} finally { m.dispose(); }
}, 15000);

// The 8 MB FIFO transfer plus bounded startup and cleanup can exceed Bun's
// default 5-second test deadline on a shared CI runner.
test("oversized output is withheld before removing the owned job", async () => {
	const m = fixture(); try {
		expect(await result(m.start("print('x' * 8000001)"))).toEqual({ status: 1, cause: "desktop-result-too-large" });
		expect(existsSync(path.join(m.root, "removed"))).toBe(true);
	} finally { m.dispose(); }
}, 15000);

test("large replies cross launchd's nonblocking FIFO without truncation", async () => {
	const m = fixture(); try {
		const reply = await result(m.start("import sys; sys.stdout.write('synthetic reply\\n' * 3000)"));
		expect(reply).toEqual({ status: 0, stdout: "synthetic reply\n".repeat(3000) });
	} finally { m.dispose(); }
});

test("a late launcher header recovers the group after the PID probe missed it", async () => {
	const m = fixture(); try {
		writeFileSync(path.join(m.root, "late-start"), "");
		expect(await result(m.start(TREE))).toEqual({ status: 1, cause: "desktop-route-failed" });
		await expectStopped(path.join(m.root, "running"));
		await expectStopped(path.join(m.root, "grandchild"));
		expect(existsSync(path.join(m.root, "job.pid"))).toBe(false);
	} finally { m.dispose(); }
});

const directTest = test.skipIf(process.platform === "darwin" && Bun.spawnSync(["/bin/launchctl", "managername"]).stdout.toString().trim() === "Background");
directTest("direct desktop execution preserves literal arguments and the supplied environment", async () => {
	const reply = await runNotebooklmCommand(["/usr/bin/python3", "-c", "import os,sys; print(sys.argv[1]); print(os.environ.get('PRIVATE_SENTINEL','scrubbed'))", "$(must-stay-literal)"], { PATH: "/usr/bin:/bin" });
	expect(reply).toEqual({ stdout: "$(must-stay-literal)\nscrubbed\n", exit: 0 });
});
directTest("direct desktop execution withholds oversized output", async () => {
	const reply = await runNotebooklmCommand(["/usr/bin/python3", "-c", "print('x' * 8000001)"], { PATH: "/usr/bin:/bin" });
	expect(reply).toEqual({ stdout: "", exit: 1, cause: "desktop-result-too-large" });
});
