import { expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createBundle, createFakeMcporterBinDir, PLUGIN_ROOT, runBundle } from "./harness.ts";

// Supplied by the test runner from an independently fetched official release.
// The process still checks the production pins, Apple signature, and version.
const official = process.env.CONNECTORS_OFFICIAL_RELEASE_FIXTURE;
if (process.env.CI && !official) throw new Error("CONNECTORS_OFFICIAL_RELEASE_FIXTURE is required for CI process proof");

test("explicit repair refuses an unsafe lock with owner-identity recovery instructions", async () => {
	const bundle = createBundle();
	const home = path.join(bundle.root, "home");
	const state = path.join(bundle.root, "state");
	const mcporter = path.join(state, "connectors", "mcporter");
	mkdirSync(home);
	mkdirSync(mcporter, { recursive: true });
	const external = path.join(bundle.root, "unrelated-lock-target");
	writeFileSync(external, "do not change\n");
	symlinkSync(external, path.join(mcporter, ".selection.lock"));
	try {
		const run = await runBundle(bundle, ["deps", "repair", "mcporter"], { home, extraEnv: { XDG_STATE_HOME: state }, timeoutMs: 5000 });
		expect(run.code).toBe(1);
		expect(run.stderr).toBe("");
		const result = JSON.parse(run.stdout).result;
		expect(result.causeCode).toBe("INTERNAL_MCPORTER_REPAIR_UNKNOWN");
		expect(result.repairAction).toBe("Independently verify the .selection.lock owner identity and that its process has ended, then immediately recheck the lock before removing it and retrying the same command");
		expect(readFileSync(external, "utf8")).toBe("do not change\n");
		expect(lstatSync(path.join(mcporter, ".selection.lock")).isSymbolicLink()).toBe(true);
	} finally { bundle.dispose(); }
});

test.skipIf(!official)("packaged first use selects verified MCPorter despite hostile PATH, then reuses and refuses mismatch", async () => {
	const bundle = createBundle();
	const hostile = createFakeMcporterBinDir();
	const source = path.join(bundle.root, "official-source");
	const home = path.join(bundle.root, "home");
	const state = path.join(bundle.root, "state");
	mkdirSync(source, { recursive: true });
	mkdirSync(home, { recursive: true });
	mkdirSync(state, { recursive: true });
	cpSync(path.join(official!, "mcporter_0.14.0_darwin_arm64.tar.gz"), path.join(source, "mcporter_0.14.0_darwin_arm64.tar.gz"));
	cpSync(path.join(official!, "provenance.json"), path.join(source, "provenance.json"));
	bundle.addSkill("keyless-fixture-skill");
	const environment = { XDG_STATE_HOME: state, CONNECTORS_TEST_RELEASE_DIR: source, OP_SERVICE_ACCOUNT_TOKEN: "secret-shaped-sentinel" };
	try {
		writeFileSync(path.join(source, "mcporter_0.14.0_darwin_arm64.tar.gz"), "untrusted release bytes");
		const untrusted = await runBundle(bundle, ["schema", "keyless-fixture-skill"], { home, binDir: hostile.binDir, extraEnv: environment, timeoutMs: 30000 });
		expect(untrusted.code).toBe(3);
		expect(untrusted.stderr).toBe("");
		expect(JSON.parse(untrusted.stdout).result.causeCode).toBe("DOMAIN_MCPORTER_REPAIR_REQUIRED");
		expect(existsSync(path.join(state, "connectors", "mcporter", "current"))).toBe(false);
		cpSync(path.join(official!, "mcporter_0.14.0_darwin_arm64.tar.gz"), path.join(source, "mcporter_0.14.0_darwin_arm64.tar.gz"));
		const first = await runBundle(bundle, ["schema", "keyless-fixture-skill"], { home, binDir: hostile.binDir, extraEnv: environment, timeoutMs: 30000 });
		expect(first.code).toBe(0);
		expect(first.stderr).toBe("");
		expect(first.stdout.trim().split("\n")).toHaveLength(1);
		const envelope = JSON.parse(first.stdout);
		expect(envelope.result.commandIdentity).toBe("connectors.schema");
		expect(envelope.result.causeCode).toBe("SUCCESS_BOOTSTRAPPED");
		expect(envelope.result.effects.completed).toEqual(["mcporter-bootstrap"]);
		expect(envelope.result.data.allowedTools).toEqual(["probe"]);
		expect(first.stdout).not.toContain("secret-shaped-sentinel");
		const selected = path.join(state, "connectors", "mcporter", "current");
		expect(existsSync(path.join(selected, "mcporter"))).toBe(true);
		expect(JSON.parse(readFileSync(path.join(selected, "release.json"), "utf8"))).toEqual({ version: "0.14.0" });
		expect(existsSync(path.join(bundle.root, "mcporter.json"))).toBe(false);

		// Remove source bytes. A second success now proves no download or copy.
		const second = await runBundle(bundle, ["schema", "keyless-fixture-skill"], { home, binDir: hostile.binDir, extraEnv: { ...environment, CONNECTORS_TEST_RELEASE_DIR: path.join(bundle.root, "missing-source") }, timeoutMs: 30000 });
		expect(second.code).toBe(0);
		expect(second.stderr).toBe("");
		expect(JSON.parse(second.stdout).result.causeCode).toBe("SUCCESS_UNCHANGED");

		writeFileSync(path.join(selected, "release.json"), JSON.stringify({ version: "0.0.0" }));
		const mismatch = await runBundle(bundle, ["schema", "keyless-fixture-skill"], { home, binDir: hostile.binDir, extraEnv: environment, timeoutMs: 30000 });
		expect(mismatch.code).toBe(3);
		expect(mismatch.stderr).toBe("");
		expect(JSON.parse(mismatch.stdout).result.causeCode).toBe("DOMAIN_MCPORTER_REPAIR_REQUIRED");
		expect(JSON.parse(mismatch.stdout).result.repairAction).toBe("Run connectors deps repair mcporter");
		const priorBinary = readFileSync(path.join(selected, "mcporter"));
		// Crash window after moving the previous selection aside. The next
		// ordinary process restores it and still refuses the mismatch.
		renameSync(selected, path.join(state, "connectors", "mcporter", ".previous"));
		const recovered = await runBundle(bundle, ["schema", "keyless-fixture-skill"], { home, binDir: hostile.binDir, extraEnv: environment, timeoutMs: 30000 });
		expect(recovered.code).toBe(3);
		expect(recovered.stderr).toBe("");
		expect(JSON.parse(recovered.stdout).result.causeCode).toBe("DOMAIN_MCPORTER_REPAIR_AFTER_RECOVERY");
		expect(JSON.parse(recovered.stdout).result.effects.completed).toEqual(["mcporter-recovery"]);
		expect(readFileSync(path.join(selected, "mcporter"))).toEqual(priorBinary);
		expect(existsSync(path.join(state, "connectors", "mcporter", ".previous"))).toBe(false);
		writeFileSync(path.join(source, "mcporter_0.14.0_darwin_arm64.tar.gz"), "bad release bytes");
		const failedRepair = await runBundle(bundle, ["deps", "repair", "mcporter"], { home, binDir: hostile.binDir, extraEnv: environment, timeoutMs: 30000 });
		expect(failedRepair.code).toBe(3);
		expect(failedRepair.stderr).toBe("");
		expect(JSON.parse(failedRepair.stdout).result.causeCode).toBe("DOMAIN_MCPORTER_REPAIR_FAILED");
		expect(readFileSync(path.join(selected, "mcporter"))).toEqual(priorBinary);
		expect(JSON.parse(readFileSync(path.join(selected, "release.json"), "utf8"))).toEqual({ version: "0.0.0" });
		cpSync(path.join(official!, "mcporter_0.14.0_darwin_arm64.tar.gz"), path.join(source, "mcporter_0.14.0_darwin_arm64.tar.gz"));
		const repaired = await runBundle(bundle, ["deps", "repair", "mcporter"], { home, binDir: hostile.binDir, extraEnv: environment, timeoutMs: 30000 });
		expect(repaired.code).toBe(0);
		expect(repaired.stderr).toBe("");
		expect(JSON.parse(repaired.stdout).result.effects.completed).toEqual(["mcporter-repair"]);
		expect(JSON.parse(readFileSync(path.join(selected, "release.json"), "utf8"))).toEqual({ version: "0.14.0" });
		const requested = await runBundle(bundle, ["schema", "keyless-fixture-skill"], { home, binDir: hostile.binDir, extraEnv: { ...environment, CONNECTORS_TEST_RELEASE_DIR: path.join(bundle.root, "missing-source") }, timeoutMs: 30000 });
		expect(requested.code).toBe(0);
		expect(requested.stderr).toBe("");
		expect(JSON.parse(requested.stdout).result.data.allowedTools).toEqual(["probe"]);
	} finally {
		hostile.dispose();
		bundle.dispose();
	}
}, 30000);

test.skipIf(!official)("schema child failure after promotion reports the completed bootstrap effect", async () => {
	const bundle = createBundle();
	const hostile = createFakeMcporterBinDir();
	const source = path.join(bundle.root, "official-source");
	const home = path.join(bundle.root, "home");
	const state = path.join(bundle.root, "state");
	mkdirSync(source, { recursive: true });
	mkdirSync(home, { recursive: true });
	mkdirSync(state, { recursive: true });
	cpSync(path.join(official!, "mcporter_0.14.0_darwin_arm64.tar.gz"), path.join(source, "mcporter_0.14.0_darwin_arm64.tar.gz"));
	cpSync(path.join(official!, "provenance.json"), path.join(source, "provenance.json"));
	bundle.addSkill("keyless-fixture-skill");
	try {
		writeFileSync(path.join(bundle.root, "probe-schema-failure-request"), "fail local schema child\n");
		const run = await runBundle(bundle, ["schema", "keyless-fixture-skill"], {
			home,
			binDir: hostile.binDir,
			extraEnv: { XDG_STATE_HOME: state, CONNECTORS_TEST_RELEASE_DIR: source },
			timeoutMs: 30000,
		});
		const selected = path.join(state, "connectors", "mcporter", "current");
		// Read durable state independently of the CLI's own result.
		expect(JSON.parse(readFileSync(path.join(selected, "release.json"), "utf8"))).toEqual({ version: "0.14.0" });
		expect(existsSync(path.join(selected, "mcporter"))).toBe(true);
		expect(readFileSync(path.join(bundle.root, "probe-spawned"), "utf8")).toBe("spawned\n");
		expect(run.code).toBe(75);
		expect(run.stderr).toBe("");
		const result = JSON.parse(run.stdout).result;
		expect(result.causeCode).toBe("TRANSIENT_PROVIDER_AFTER_BOOTSTRAP");
		expect(result.transactionState).toBe("completed");
		expect(result.effects.completed).toEqual(["mcporter-bootstrap"]);
	} finally {
		hostile.dispose();
		bundle.dispose();
	}
});

test.skipIf(!official)("independent first-use and repair processes serialize selection in one state root", async () => {
	const bundle = createBundle();
	const hostile = createFakeMcporterBinDir();
	const source = path.join(bundle.root, "official-source");
	const home = path.join(bundle.root, "home");
	const state = path.join(bundle.root, "state");
	mkdirSync(source, { recursive: true });
	mkdirSync(home, { recursive: true });
	mkdirSync(state, { recursive: true });
	cpSync(path.join(official!, "mcporter_0.14.0_darwin_arm64.tar.gz"), path.join(source, "mcporter_0.14.0_darwin_arm64.tar.gz"));
	cpSync(path.join(official!, "provenance.json"), path.join(source, "provenance.json"));
	bundle.addSkill("keyless-fixture-skill");
	const environment = { home, binDir: hostile.binDir, extraEnv: { XDG_STATE_HOME: state, CONNECTORS_TEST_RELEASE_DIR: source }, timeoutMs: 30000 };
	const current = path.join(state, "connectors", "mcporter", "current");
	const previous = path.join(state, "connectors", "mcporter", ".previous");
	try {
		const first = await Promise.all([runBundle(bundle, ["schema", "keyless-fixture-skill"], environment), runBundle(bundle, ["schema", "keyless-fixture-skill"], environment)]);
		expect(first.map((run) => run.code)).toEqual([0, 0]);
		expect(first.map((run) => run.stderr)).toEqual(["", ""]);
		expect(first.map((run) => JSON.parse(run.stdout).result.causeCode).sort()).toEqual(["SUCCESS_BOOTSTRAPPED", "SUCCESS_UNCHANGED"]);
		expect(readFileSync(path.join(current, "mcporter"))).toEqual(readFileSync(path.join(official!, "mcporter")));
		expect(JSON.parse(readFileSync(path.join(current, "release.json"), "utf8"))).toEqual({ version: "0.14.0" });
		writeFileSync(path.join(current, "release.json"), JSON.stringify({ version: "0.0.0" }));
		const repairs = await Promise.all([runBundle(bundle, ["deps", "repair", "mcporter"], environment), runBundle(bundle, ["deps", "repair", "mcporter"], environment)]);
		expect(repairs.map((run) => run.code)).toEqual([0, 0]);
		expect(repairs.map((run) => run.stderr)).toEqual(["", ""]);
		expect(repairs.map((run) => JSON.parse(run.stdout).result.effects.completed)).toEqual([["mcporter-repair"], ["mcporter-repair"]]);
		expect(readFileSync(path.join(current, "mcporter"))).toEqual(readFileSync(path.join(official!, "mcporter")));
		expect(JSON.parse(readFileSync(path.join(current, "release.json"), "utf8"))).toEqual({ version: "0.14.0" });
		expect(existsSync(previous)).toBe(false);
	} finally { hostile.dispose(); bundle.dispose(); }
}, 30000);

test.skipIf(!official)("post-promotion crash window retains verified current and recovers invalid current from intact previous", async () => {
	const bundle = createBundle();
	const hostile = createFakeMcporterBinDir();
	const source = path.join(bundle.root, "official-source");
	const home = path.join(bundle.root, "home");
	const state = path.join(bundle.root, "state");
	mkdirSync(source, { recursive: true });
	mkdirSync(home, { recursive: true });
	mkdirSync(state, { recursive: true });
	cpSync(path.join(official!, "mcporter_0.14.0_darwin_arm64.tar.gz"), path.join(source, "mcporter_0.14.0_darwin_arm64.tar.gz"));
	cpSync(path.join(official!, "provenance.json"), path.join(source, "provenance.json"));
	bundle.addSkill("keyless-fixture-skill");
	const environment = { home, binDir: hostile.binDir, extraEnv: { XDG_STATE_HOME: state, CONNECTORS_TEST_RELEASE_DIR: source }, timeoutMs: 30000 };
	const current = path.join(state, "connectors", "mcporter", "current");
	const previous = path.join(state, "connectors", "mcporter", ".previous");
	try {
		const first = await runBundle(bundle, ["schema", "keyless-fixture-skill"], environment);
		expect(first.code).toBe(0);
		cpSync(current, previous, { recursive: true });
		const afterCommit = await runBundle(bundle, ["schema", "keyless-fixture-skill"], environment);
		expect(afterCommit.code).toBe(0);
		expect(JSON.parse(afterCommit.stdout).result.causeCode).toBe("SUCCESS_UNCHANGED");
		expect(readFileSync(path.join(current, "mcporter"))).toEqual(readFileSync(path.join(official!, "mcporter")));
		expect(existsSync(previous)).toBe(false);
		cpSync(current, previous, { recursive: true });
		writeFileSync(path.join(current, "release.json"), "broken marker");
		const recovered = await runBundle(bundle, ["schema", "keyless-fixture-skill"], environment);
		expect(recovered.code).toBe(0);
		expect(recovered.stderr).toBe("");
		expect(JSON.parse(recovered.stdout).result.causeCode).toBe("SUCCESS_MCPORTER_RECOVERED");
		expect(JSON.parse(recovered.stdout).result.effects.completed).toEqual(["mcporter-recovery"]);
		expect(readFileSync(path.join(current, "mcporter"))).toEqual(readFileSync(path.join(official!, "mcporter")));
		expect(JSON.parse(readFileSync(path.join(current, "release.json"), "utf8"))).toEqual({ version: "0.14.0" });
		expect(existsSync(previous)).toBe(false);
	} finally { hostile.dispose(); bundle.dispose(); }
}, 30000);

test.skipIf(!official)("interrupted repair reports both durable recovery and replacement", async () => {
	const bundle = createBundle();
	const hostile = createFakeMcporterBinDir();
	const source = path.join(bundle.root, "official-source");
	const home = path.join(bundle.root, "home");
	const state = path.join(bundle.root, "state");
	mkdirSync(source, { recursive: true }); mkdirSync(home); mkdirSync(state);
	cpSync(path.join(official!, "mcporter_0.14.0_darwin_arm64.tar.gz"), path.join(source, "mcporter_0.14.0_darwin_arm64.tar.gz"));
	cpSync(path.join(official!, "provenance.json"), path.join(source, "provenance.json"));
	bundle.addSkill("keyless-fixture-skill");
	const environment = { home, binDir: hostile.binDir, extraEnv: { XDG_STATE_HOME: state, CONNECTORS_TEST_RELEASE_DIR: source }, timeoutMs: 30000 };
	const root = path.join(state, "connectors", "mcporter");
	try {
		expect((await runBundle(bundle, ["schema", "keyless-fixture-skill"], environment)).code).toBe(0);
		const current = path.join(root, "current");
		writeFileSync(path.join(current, "release.json"), JSON.stringify({ version: "0.0.0" }));
		const priorBinary = readFileSync(path.join(current, "mcporter"));
		renameSync(current, path.join(root, ".previous"));
		const run = await runBundle(bundle, ["deps", "repair", "mcporter"], environment);
		expect(run.code).toBe(0);
		expect(run.stderr).toBe("");
		const result = JSON.parse(run.stdout).result;
		expect(result.commandIdentity).toBe("connectors.deps.repair.mcporter");
		expect(result.effects).toEqual({ completed: ["mcporter-recovery", "mcporter-repair"], remaining: [], uncertain: [], inventoryComplete: true });
		expect(readFileSync(path.join(current, "mcporter"))).toEqual(priorBinary);
		expect(JSON.parse(readFileSync(path.join(current, "release.json"), "utf8"))).toEqual({ version: "0.14.0" });
		expect(existsSync(path.join(root, ".previous"))).toBe(false);
	} finally { hostile.dispose(); bundle.dispose(); }
}, 30000);

test.skipIf(!official)("post-repair output validation failure retains the durably completed repair", async () => {
	const bundle = createBundle();
	const hostile = createFakeMcporterBinDir();
	const sourceBin = path.join(PLUGIN_ROOT, "bin");
	const testBin = path.join(bundle.root, "test-source");
	const release = path.join(bundle.root, "official-source");
	const state = path.join(bundle.root, "state");
	const home = path.join(bundle.root, "home");
	mkdirSync(release); mkdirSync(state); mkdirSync(home);
	cpSync(sourceBin, testBin, { recursive: true, filter: (source) => source !== path.join(sourceBin, "connectors") });
	const entry = path.join(testBin, "connectors.ts");
	const original = readFileSync(entry, "utf8");
	const successCause = 'causeCode: "SUCCESS_MCPORTER_REPAIRED",';
	expect(original.split(successCause)).toHaveLength(2);
	writeFileSync(entry, original.replace(successCause, 'causeCode: "SUCCESS_UNCHANGED",'));
	const built = Bun.spawnSync(["bun", "build", entry, "--compile", "--target=bun-darwin-arm64", "--outfile", bundle.binary], { stdout: "pipe", stderr: "pipe" });
	if (built.exitCode !== 0) throw new Error(new TextDecoder().decode(built.stderr));
	cpSync(path.join(official!, "mcporter_0.14.0_darwin_arm64.tar.gz"), path.join(release, "mcporter_0.14.0_darwin_arm64.tar.gz"));
	cpSync(path.join(official!, "provenance.json"), path.join(release, "provenance.json"));
	const env = { home, binDir: hostile.binDir, extraEnv: { XDG_STATE_HOME: state, CONNECTORS_TEST_RELEASE_DIR: release }, timeoutMs: 30000 };
	try {
		bundle.addSkill("keyless-fixture-skill");
		expect((await runBundle(bundle, ["schema", "keyless-fixture-skill"], env)).code).toBe(0);
		const selected = path.join(state, "connectors", "mcporter", "current");
		writeFileSync(path.join(selected, "release.json"), JSON.stringify({ version: "0.0.0" }));
		const first = await runBundle(bundle, ["deps", "repair", "mcporter"], env);
		expect(first.code).toBe(1);
		expect(first.stderr).toBe("");
		expect(first.stdout.trim().split("\n")).toHaveLength(1);
		expect(JSON.parse(readFileSync(path.join(selected, "release.json"), "utf8"))).toEqual({ version: "0.14.0" });
		expect(existsSync(path.join(selected, "mcporter"))).toBe(true);
		const result = JSON.parse(first.stdout).result;
		expect(result.causeCode).toBe("INTERNAL_UNEXPECTED_AFTER_REPAIR");
		expect(result.transactionState).toBe("completed");
		expect(result.effects.completed).toEqual(["mcporter-repair"]);
		writeFileSync(path.join(selected, "release.json"), JSON.stringify({ version: "0.0.0" }));
		renameSync(selected, path.join(state, "connectors", "mcporter", ".previous"));
		const recovered = await runBundle(bundle, ["deps", "repair", "mcporter"], env);
		expect(recovered.code).toBe(1);
		expect(recovered.stderr).toBe("");
		expect(recovered.stdout.trim().split("\n")).toHaveLength(1);
		expect(JSON.parse(readFileSync(path.join(selected, "release.json"), "utf8"))).toEqual({ version: "0.14.0" });
		expect(existsSync(path.join(state, "connectors", "mcporter", ".previous"))).toBe(false);
		expect(JSON.parse(recovered.stdout).result.effects.completed).toEqual(["mcporter-recovery", "mcporter-repair"]);
	} finally { hostile.dispose(); bundle.dispose(); }
}, 30000);

test.skipIf(!official)("unsafe current directory is never recursively removed during recovery", async () => {
	const bundle = createBundle();
	const hostile = createFakeMcporterBinDir();
	const source = path.join(bundle.root, "official-source");
	const home = path.join(bundle.root, "home");
	const state = path.join(bundle.root, "state");
	mkdirSync(source, { recursive: true }); mkdirSync(home); mkdirSync(state);
	cpSync(path.join(official!, "mcporter_0.14.0_darwin_arm64.tar.gz"), path.join(source, "mcporter_0.14.0_darwin_arm64.tar.gz"));
	cpSync(path.join(official!, "provenance.json"), path.join(source, "provenance.json"));
	bundle.addSkill("keyless-fixture-skill");
	const environment = { home, binDir: hostile.binDir, extraEnv: { XDG_STATE_HOME: state, CONNECTORS_TEST_RELEASE_DIR: source }, timeoutMs: 30000 };
	const root = path.join(state, "connectors", "mcporter");
	try {
		expect((await runBundle(bundle, ["schema", "keyless-fixture-skill"], environment)).code).toBe(0);
		const current = path.join(root, "current");
		const previous = path.join(root, ".previous");
		cpSync(current, previous, { recursive: true });
		writeFileSync(path.join(current, "release.json"), "invalid marker");
		chmodSync(current, 0o755);
		const wrongMode = await runBundle(bundle, ["schema", "keyless-fixture-skill"], environment);
		expect(wrongMode.code).not.toBe(0);
		expect(wrongMode.stderr).toBe("");
		expect(JSON.parse(wrongMode.stdout).result.effects.completed).toEqual([]);
		expect(existsSync(path.join(current, "release.json"))).toBe(true);
		expect(existsSync(path.join(previous, "mcporter"))).toBe(true);
		chmodSync(current, 0o700);
		renameSync(current, path.join(root, "unsafe-target"));
		symlinkSync(path.join(root, "unsafe-target"), current);
		const symlink = await runBundle(bundle, ["schema", "keyless-fixture-skill"], environment);
		expect(symlink.code).not.toBe(0);
		expect(symlink.stderr).toBe("");
		expect(lstatSync(current).isSymbolicLink()).toBe(true);
		expect(readlinkSync(current)).toBe(path.join(root, "unsafe-target"));
		expect(existsSync(path.join(root, "unsafe-target", "release.json"))).toBe(true);
		expect(existsSync(path.join(previous, "mcporter"))).toBe(true);
	} finally { hostile.dispose(); bundle.dispose(); }
}, 30000);

test.skipIf(!official)("a second process waits for the lock and reclaims it after the owner is killed", async () => {
	const bundle = createBundle();
	const hostile = createFakeMcporterBinDir();
	const source = path.join(bundle.root, "official-source");
	const home = path.join(bundle.root, "home");
	const state = path.join(bundle.root, "state");
	mkdirSync(source, { recursive: true }); mkdirSync(home); mkdirSync(state);
	cpSync(path.join(official!, "mcporter_0.14.0_darwin_arm64.tar.gz"), path.join(source, "mcporter_0.14.0_darwin_arm64.tar.gz"));
	cpSync(path.join(official!, "provenance.json"), path.join(source, "provenance.json"));
	bundle.addSkill("keyless-fixture-skill");
	const environment = { home, binDir: hostile.binDir, extraEnv: { XDG_STATE_HOME: state, CONNECTORS_TEST_RELEASE_DIR: source }, timeoutMs: 30000 };
	const lock = path.join(state, "connectors", "mcporter", ".selection.lock");
	const child = Bun.spawn([bundle.binary, "schema", "keyless-fixture-skill"], { env: { HOME: home, PATH: `${hostile.binDir}:/usr/bin:/bin`, TMPDIR: bundle.root, ...environment.extraEnv }, stdout: "pipe", stderr: "pipe" });
	let stopped = false;
	try {
		const deadline = Date.now() + 10000;
		while (!existsSync(lock) && Date.now() < deadline) await Bun.sleep(1);
		expect(existsSync(lock)).toBe(true);
		const modeDeadline = Date.now() + 1000;
		while ((lstatSync(lock).mode & 0o777) !== 0o600 && Date.now() < modeDeadline) await Bun.sleep(1);
		expect(lstatSync(lock).mode & 0o777).toBe(0o600);
		process.kill(child.pid, "SIGSTOP");
		stopped = true;
		const competitor = runBundle(bundle, ["schema", "keyless-fixture-skill"], environment);
		let competitorFinished = false;
		void competitor.then(() => { competitorFinished = true; });
		await Bun.sleep(200);
		expect(competitorFinished).toBe(false);
		expect(existsSync(path.join(state, "connectors", "mcporter", "current"))).toBe(false);
		process.kill(child.pid, "SIGKILL");
		stopped = false;
		const [code, b] = await Promise.all([child.exited, competitor]);
		expect(code).not.toBe(0);
		expect(b.code).toBe(0);
		expect(b.stderr).toBe("");
		expect(JSON.parse(b.stdout).result.causeCode).toBe("SUCCESS_BOOTSTRAPPED");
		expect(JSON.parse(readFileSync(path.join(state, "connectors", "mcporter", "current", "release.json"), "utf8"))).toEqual({ version: "0.14.0" });
	} finally { if (stopped) process.kill(child.pid, "SIGCONT"); hostile.dispose(); bundle.dispose(); }
}, 30000);

// Independent literals: the official asset paths the loopback seam must keep.
const OFFICIAL_ARCHIVE_PATH = "/openclaw/mcporter/releases/download/v0.14.0/mcporter_0.14.0_darwin_arm64.tar.gz";
const OFFICIAL_PROVENANCE_PATH = "/openclaw/mcporter/releases/download/v0.14.0/provenance.json";
const SENTINEL = "ghp_connectorsStalledReleaseSentinel000000";

function stalledReleaseHost() {
	const requests: string[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch(request) {
		requests.push(new URL(request.url).pathname);
		// Headers and a first chunk arrive, then the body never progresses.
		return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(16)); } }));
	} });
	return { server, requests };
}

async function firstUseAgainst(origin: (port: number) => string) {
	const bundle = createBundle();
	const host = stalledReleaseHost();
	const home = path.join(bundle.root, "home");
	const state = path.join(bundle.root, "state");
	mkdirSync(home);
	bundle.addSkill("keyless-fixture-skill");
	const started = performance.now();
	const run = await runBundle(bundle, ["schema", "keyless-fixture-skill"], { home, timeoutMs: 15_000, extraEnv: {
		XDG_STATE_HOME: state, GITHUB_TOKEN: SENTINEL, CONNECTORS_TEST_MCPORTER_ORIGIN: origin(host.server.port!),
	} });
	return { bundle, host, run, elapsed: performance.now() - started, selectionRoot: path.join(state, "connectors", "mcporter") };
}

function expectBootstrapRefusal(run: Awaited<ReturnType<typeof runBundle>>) {
	expect(run.code).toBe(3);
	expect(run.stderr).toBe("");
	expect(run.stdout.trim().split("\n")).toHaveLength(1);
	expect(run.stdout).not.toContain(SENTINEL);
	const envelope = JSON.parse(run.stdout);
	expect(envelope.message).toContain("bootstrap-failed");
	expect(envelope.result.commandIdentity).toBe("connectors.schema");
	expect(envelope.result.causeCode).toBe("DOMAIN_MCPORTER_REPAIR_REQUIRED");
	expect(envelope.result.transactionState).toBe("unchanged");
	expect(envelope.result.repairAction).toBe("Run connectors deps repair mcporter");
}

test("packaged first use behind a stalled release host refuses at its deadline and leaves no lock or staging", async () => {
	const { bundle, host, run, elapsed, selectionRoot } = await firstUseAgainst((port) => `http://127.0.0.1:${port}/`);
	try {
		expectBootstrapRefusal(run);
		// The loopback deadline is 3 s; a hang would reach the 15 s process bound.
		expect(elapsed).toBeGreaterThanOrEqual(2_900);
		expect(elapsed).toBeLessThan(10_000);
		expect(host.requests.slice().sort()).toEqual([OFFICIAL_ARCHIVE_PATH, OFFICIAL_PROVENANCE_PATH]);
		expect(readdirSync(selectionRoot)).toEqual([]);
	} finally {
		host.server.stop(true);
		bundle.dispose();
	}
}, 20_000);

test("packaged first use refuses a release origin that is not literal 127.0.0.1 before any request", async () => {
	const { bundle, host, run, selectionRoot } = await firstUseAgainst((port) => `http://localhost:${port}/`);
	try {
		expectBootstrapRefusal(run);
		expect(host.requests).toEqual([]);
		expect(readdirSync(selectionRoot)).toEqual([]);
	} finally {
		host.server.stop(true);
		bundle.dispose();
	}
}, 20_000);
