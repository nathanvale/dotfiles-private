import { expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildFaultedFrontDoor } from "./faulted-front-door.ts";
import { createBundle, createFakeMcporterBinDir, runBundle } from "./harness.ts";

// Supplied by the test runner from an independently fetched official release.
// The process still checks the production pins, Apple signature, and version.
const official = process.env.CONNECTORS_OFFICIAL_RELEASE_FIXTURE;
if (process.env.CI && !official) throw new Error("CONNECTORS_OFFICIAL_RELEASE_FIXTURE is required for CI process proof");

// Independent oracle: the accepted repair texts. A refused installed
// selection names the explicit preview (C4); a failed first use has no
// selection to repair, so it names first use again (Q13c).
const PREVIEW_REPAIR = "Run connectors deps repair mcporter --preview";
const FIRST_USE_RETRY = "Check that the official MCPorter release is reachable, then retry the same command; first use installs MCPorter";

type BundleRun = Parameters<typeof runBundle>[2];

// Ticket #140 F-a: Codex's default macOS workspace-write seatbelt withholds
// Apple's system-policy service. This one-rule profile withholds only that.
const SYSPOLICY_DENIED = '(version 1)(allow default)(deny mach-lookup (global-name "com.apple.security.syspolicy"))';
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
if (process.env.CI && !existsSync(SANDBOX_EXEC)) throw new Error("sandbox-exec is required for the syspolicy-denied process proof");
// Independent oracle: Q13c's pinned MCPorter 0.14.0 macOS arm64 binary.
const PINNED_BINARY_SHA256 = "01d99ede8b6a88dd282eaeda2afb7086dca5bdbc04c05c8c21744703575adb27";
const PINNED_PROVENANCE_SHA256 = "7a4256c6a3a921e2319386c3142ec33b4f0b5d693af5c652fe97ee884f30f2ab";
const LIVE_NOTARIZATION = ["/usr/bin/codesign", "--verify", "--strict", "--check-notarization", "-R=notarized", "--verbose=2"];

async function runSyspolicyDenied(bundle: ReturnType<typeof createBundle>, argv: string[], env: BundleRun & { binDir: string }, profile = SYSPOLICY_DENIED) {
	const child = Bun.spawn([SANDBOX_EXEC, "-p", profile, bundle.binary, ...argv], {
		env: { HOME: env.home, PATH: `${env.binDir}:/usr/bin:/bin`, TMPDIR: bundle.root, ...env.extraEnv },
		stdin: "ignore", stdout: "pipe", stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { code, stdout, stderr };
}

// The only released repair: a preview, then its apply.
async function previewMcporterRepair(bundle: ReturnType<typeof createBundle>, env: BundleRun): Promise<string> {
	const preview = await runBundle(bundle, ["deps", "repair", "mcporter", "--preview"], env);
	expect([preview.code, preview.stderr]).toEqual([0, ""]);
	return JSON.parse(preview.stdout).result.data.previewId;
}

async function repairMcporterThroughPreview(bundle: ReturnType<typeof createBundle>, env: BundleRun) {
	return runBundle(bundle, ["deps", "repair", "mcporter", "--apply", await previewMcporterRepair(bundle, env)], env);
}

test("explicit repair apply refuses an unsafe lock with owner-identity recovery instructions", async () => {
	const bundle = createBundle();
	const home = path.join(bundle.root, "home");
	const state = path.join(bundle.root, "state");
	const mcporter = path.join(state, "connectors", "mcporter");
	const current = path.join(mcporter, "current");
	mkdirSync(home);
	mkdirSync(current, { recursive: true, mode: 0o700 });
	writeFileSync(path.join(current, "release.json"), JSON.stringify({ version: "0.13.13" }), { mode: 0o600 });
	writeFileSync(path.join(current, "mcporter"), "older mcporter bytes", { mode: 0o700 });
	const external = path.join(bundle.root, "unrelated-lock-target");
	writeFileSync(external, "do not change\n");
	symlinkSync(external, path.join(mcporter, ".selection.lock"));
	try {
		const run = await repairMcporterThroughPreview(bundle, { home, extraEnv: { XDG_STATE_HOME: state }, timeoutMs: 5000 });
		expect(run.code).toBe(3);
		expect(run.stderr).toBe("");
		const result = JSON.parse(run.stdout).result;
		expect(result).toMatchObject({ commandIdentity: "connectors.deps.repair.apply", causeCode: "DOMAIN_DEPS_REPAIR_EFFECT_UNKNOWN", effectClass: "external", transactionState: "unknown" });
		expect(result.effects).toEqual({ completed: ["deps-repair-receipt"], remaining: [], uncertain: ["mcporter-repair"], inventoryComplete: true });
		expect(readFileSync(path.join(current, "release.json"), "utf8")).toBe(JSON.stringify({ version: "0.13.13" }));
		expect(result.repairAction).toBe("Independently verify the .selection.lock owner identity and that its process has ended, then immediately recheck the lock before removing it and retrying the same command");
		expect(readFileSync(external, "utf8")).toBe("do not change\n");
		expect(lstatSync(path.join(mcporter, ".selection.lock")).isSymbolicLink()).toBe(true);
	} finally { bundle.dispose(); }
});

// A later wrong selection must lead straight to the explicit preview. A
// generic doctor next action would contradict the repair command in the same
// envelope and leave an agent without one unambiguous next step.
test("a mismatched selected MCPorter names repair preview as its next action", async () => {
	const bundle = createBundle();
	bundle.addSkill("keyless-fixture-skill");
	const home = path.join(bundle.root, "home");
	const state = path.join(bundle.root, "state");
	const current = path.join(state, "connectors", "mcporter", "current");
	mkdirSync(home);
	mkdirSync(current, { recursive: true, mode: 0o700 });
	writeFileSync(path.join(current, "release.json"), JSON.stringify({ version: "0.13.13" }), { mode: 0o600 });
	writeFileSync(path.join(current, "mcporter"), "older mcporter bytes", { mode: 0o700 });
	try {
		const run = await runBundle(bundle, ["schema", "keyless-fixture-skill"], { home, extraEnv: { XDG_STATE_HOME: state } });
		expect([run.code, run.stderr, run.stdout.trim().split("\n").length]).toEqual([3, "", 1]);
		const result = JSON.parse(run.stdout).result;
		expect(result).toMatchObject({ causeCode: "DOMAIN_MCPORTER_REPAIR_REQUIRED", transactionState: "unchanged", repairAction: PREVIEW_REPAIR, nextAction: "connectors.deps.repair.preview" });
		expect(readFileSync(path.join(current, "release.json"), "utf8")).toBe(JSON.stringify({ version: "0.13.13" }));
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
		expect(JSON.parse(mismatch.stdout).result.repairAction).toBe(PREVIEW_REPAIR);
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
		const failedRepair = await repairMcporterThroughPreview(bundle, { home, binDir: hostile.binDir, extraEnv: environment, timeoutMs: 30000 });
		expect(failedRepair.code).toBe(3);
		expect(failedRepair.stderr).toBe("");
		expect(JSON.parse(failedRepair.stdout).result).toMatchObject({ causeCode: "DOMAIN_DEPS_REPAIR_FAILED_RECORDED", effectClass: "external" });
		expect(JSON.parse(failedRepair.stdout).result.effects.completed).toEqual(["deps-repair-receipt"]);
		expect(readFileSync(path.join(selected, "mcporter"))).toEqual(priorBinary);
		expect(JSON.parse(readFileSync(path.join(selected, "release.json"), "utf8"))).toEqual({ version: "0.0.0" });
		cpSync(path.join(official!, "mcporter_0.14.0_darwin_arm64.tar.gz"), path.join(source, "mcporter_0.14.0_darwin_arm64.tar.gz"));
		const repaired = await repairMcporterThroughPreview(bundle, { home, binDir: hostile.binDir, extraEnv: environment, timeoutMs: 30000 });
		expect(repaired.code).toBe(0);
		expect(repaired.stderr).toBe("");
		expect(JSON.parse(repaired.stdout).result).toMatchObject({ causeCode: "SUCCESS_DEPS_REPAIRED", effectClass: "external" });
		expect(JSON.parse(repaired.stdout).result.effects.completed).toEqual(["deps-repair-receipt", "mcporter-repair"]);
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

// Accepted AC4 trade-off (27 Sep 2026): Apple's live notarization lookup
// belongs to release qualification; install and use keep every offline pin.
test.skipIf(!official)("syspolicy-denied sandbox: first use bootstraps, reuse skips download, mismatch refuses, advised repair works", async () => {
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
	const environment = { home, binDir: hostile.binDir, extraEnv: { XDG_STATE_HOME: state, CONNECTORS_TEST_RELEASE_DIR: source, OP_SERVICE_ACCOUNT_TOKEN: "secret-shaped-sentinel" } };
	const withoutSource = { ...environment, extraEnv: { ...environment.extraEnv, CONNECTORS_TEST_RELEASE_DIR: path.join(bundle.root, "missing-source") } };
	const selected = path.join(state, "connectors", "mcporter", "current");
	try {
		// Negative control: the profile denies the lookup the pinned bytes pass
		// without it, so a GREEN below cannot come from an inert sandbox.
		const officialBinary = path.join(official!, "mcporter");
		expect(Bun.spawnSync([...LIVE_NOTARIZATION, officialBinary], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
		expect(Bun.spawnSync([SANDBOX_EXEC, "-p", SYSPOLICY_DENIED, ...LIVE_NOTARIZATION, officialBinary], { stdout: "ignore", stderr: "ignore" }).exitCode).not.toBe(0);

		const first = await runSyspolicyDenied(bundle, ["schema", "keyless-fixture-skill"], environment);
		expect([first.code, first.stderr, first.stdout.trim().split("\n").length]).toEqual([0, "", 1]);
		expect(JSON.parse(first.stdout).result).toMatchObject({ commandIdentity: "connectors.schema", causeCode: "SUCCESS_BOOTSTRAPPED", effects: { completed: ["mcporter-bootstrap"] }, data: { allowedTools: ["probe"] } });
		expect(first.stdout).not.toContain("secret-shaped-sentinel");
		expect(new Bun.CryptoHasher("sha256").update(readFileSync(path.join(selected, "mcporter"))).digest("hex")).toBe(PINNED_BINARY_SHA256);
		const firstInode = lstatSync(path.join(selected, "mcporter")).ino;

		const second = await runSyspolicyDenied(bundle, ["schema", "keyless-fixture-skill"], withoutSource);
		expect([second.code, second.stderr]).toEqual([0, ""]);
		expect(JSON.parse(second.stdout).result).toMatchObject({ commandIdentity: "connectors.schema", causeCode: "SUCCESS_UNCHANGED", effects: { completed: [] } });
		expect(lstatSync(path.join(selected, "mcporter")).ino).toBe(firstInode);

		// Per-use provenance: the official record stays in the selection and a
		// valid binary and marker without it never authorize use.
		const retained = path.join(selected, "provenance.json");
		expect(new Bun.CryptoHasher("sha256").update(readFileSync(retained)).digest("hex")).toBe(PINNED_PROVENANCE_SHA256);
		expect(lstatSync(retained).mode & 0o777).toBe(0o600);
		expect(readdirSync(selected).sort()).toEqual(["mcporter", "provenance.json", "release.json"]);
		renameSync(retained, path.join(bundle.root, "set-aside-provenance.json"));
		const unproven = await runSyspolicyDenied(bundle, ["schema", "keyless-fixture-skill"], withoutSource);
		expect([unproven.code, unproven.stderr]).toEqual([3, ""]);
		expect(JSON.parse(unproven.stdout)).toMatchObject({ message: "connectors: MCPorter provenance-invalid", result: { causeCode: "DOMAIN_MCPORTER_REPAIR_REQUIRED", repairAction: PREVIEW_REPAIR, transactionState: "unchanged" } });
		renameSync(path.join(bundle.root, "set-aside-provenance.json"), retained);

		writeFileSync(path.join(selected, "release.json"), JSON.stringify({ version: "0.0.0" }));
		const mismatch = await runSyspolicyDenied(bundle, ["schema", "keyless-fixture-skill"], withoutSource);
		expect([mismatch.code, mismatch.stderr]).toEqual([3, ""]);
		expect(JSON.parse(mismatch.stdout)).toMatchObject({ message: "connectors: MCPorter version-mismatch", result: { causeCode: "DOMAIN_MCPORTER_REPAIR_REQUIRED", repairAction: PREVIEW_REPAIR, transactionState: "unchanged" } });
		expect(lstatSync(path.join(selected, "mcporter")).ino).toBe(firstInode);

		// The advised repair must itself work inside the same sandbox.
		const preview = await runSyspolicyDenied(bundle, ["deps", "repair", "mcporter", "--preview"], environment);
		expect([preview.code, preview.stderr]).toEqual([0, ""]);
		const repaired = await runSyspolicyDenied(bundle, ["deps", "repair", "mcporter", "--apply", JSON.parse(preview.stdout).result.data.previewId], environment);
		expect([repaired.code, repaired.stderr]).toEqual([0, ""]);
		expect(JSON.parse(repaired.stdout).result).toMatchObject({ causeCode: "SUCCESS_DEPS_REPAIRED", effects: { completed: ["deps-repair-receipt", "mcporter-repair"] } });
		expect(JSON.parse(readFileSync(path.join(selected, "release.json"), "utf8"))).toEqual({ version: "0.14.0" });
		const after = await runSyspolicyDenied(bundle, ["schema", "keyless-fixture-skill"], withoutSource);
		expect([after.code, after.stderr]).toEqual([0, ""]);
		expect(JSON.parse(after.stdout).result.causeCode).toBe("SUCCESS_UNCHANGED");
	} finally {
		hostile.dispose();
		bundle.dispose();
	}
}, 60000);

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
		const apply = ["deps", "repair", "mcporter", "--apply", await previewMcporterRepair(bundle, environment)];
		const repairs = await Promise.all([runBundle(bundle, apply, environment), runBundle(bundle, apply, environment)]);
		expect(repairs.map((run) => run.stderr)).toEqual(["", ""]);
		expect(repairs.map((run) => JSON.parse(run.stdout).result.causeCode).sort()).toEqual(["DOMAIN_DEPS_PREVIEW_CONSUMED", "SUCCESS_DEPS_REPAIRED"]);
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
		const run = await repairMcporterThroughPreview(bundle, environment);
		expect(run.code).toBe(0);
		expect(run.stderr).toBe("");
		const result = JSON.parse(run.stdout).result;
		expect(result).toMatchObject({ commandIdentity: "connectors.deps.repair.apply", effectClass: "external" });
		expect(result.effects).toEqual({ completed: ["deps-repair-receipt", "mcporter-recovery", "mcporter-repair"], remaining: [], uncertain: [], inventoryComplete: true });
		expect(readFileSync(path.join(current, "mcporter"))).toEqual(priorBinary);
		expect(JSON.parse(readFileSync(path.join(current, "release.json"), "utf8"))).toEqual({ version: "0.14.0" });
		expect(existsSync(path.join(root, ".previous"))).toBe(false);
	} finally { hostile.dispose(); bundle.dispose(); }
}, 30000);

test.skipIf(!official)("post-repair output validation failure retains the durably completed repair", async () => {
	const bundle = createBundle();
	const hostile = createFakeMcporterBinDir();
	const release = path.join(bundle.root, "official-source");
	const state = path.join(bundle.root, "state");
	const home = path.join(bundle.root, "home");
	mkdirSync(release); mkdirSync(state); mkdirSync(home);
	buildFaultedFrontDoor(bundle.root, bundle.binary, { find: 'repair: { completed: "SUCCESS_DEPS_REPAIRED",', replace: 'repair: { completed: "SUCCESS_UNCHANGED",' });
	cpSync(path.join(official!, "mcporter_0.14.0_darwin_arm64.tar.gz"), path.join(release, "mcporter_0.14.0_darwin_arm64.tar.gz"));
	cpSync(path.join(official!, "provenance.json"), path.join(release, "provenance.json"));
	const env = { home, binDir: hostile.binDir, extraEnv: { XDG_STATE_HOME: state, CONNECTORS_TEST_RELEASE_DIR: release }, timeoutMs: 30000 };
	try {
		bundle.addSkill("keyless-fixture-skill");
		expect((await runBundle(bundle, ["schema", "keyless-fixture-skill"], env)).code).toBe(0);
		const selected = path.join(state, "connectors", "mcporter", "current");
		writeFileSync(path.join(selected, "release.json"), JSON.stringify({ version: "0.0.0" }));
		const first = await repairMcporterThroughPreview(bundle, env);
		expect(first.code).toBe(1);
		expect(first.stderr).toBe("");
		expect(first.stdout.trim().split("\n")).toHaveLength(1);
		expect(JSON.parse(readFileSync(path.join(selected, "release.json"), "utf8"))).toEqual({ version: "0.14.0" });
		expect(existsSync(path.join(selected, "mcporter"))).toBe(true);
		const result = JSON.parse(first.stdout).result;
		expect(result).toMatchObject({ commandIdentity: "connectors.deps.repair.apply", causeCode: "INTERNAL_DEPS_REPAIR_AFTER_EFFECT", effectClass: "external", transactionState: "completed" });
		expect(result.effects.completed).toEqual(["deps-repair-receipt", "mcporter-repair"]);
		writeFileSync(path.join(selected, "release.json"), JSON.stringify({ version: "0.0.0" }));
		renameSync(selected, path.join(state, "connectors", "mcporter", ".previous"));
		const recovered = await repairMcporterThroughPreview(bundle, env);
		expect(recovered.code).toBe(1);
		expect(recovered.stderr).toBe("");
		expect(recovered.stdout.trim().split("\n")).toHaveLength(1);
		expect(JSON.parse(readFileSync(path.join(selected, "release.json"), "utf8"))).toEqual({ version: "0.14.0" });
		expect(existsSync(path.join(state, "connectors", "mcporter", ".previous"))).toBe(false);
		expect(JSON.parse(recovered.stdout).result.effects.completed).toEqual(["deps-repair-receipt", "mcporter-recovery", "mcporter-repair"]);
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
	expect(envelope.result.repairAction).toBe(FIRST_USE_RETRY);
	// Only a reachability failure advises the same command again.
	expect(envelope.result.nextAction).toBe("connectors.schema");
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

// Ticket #140: a first-use verifier refusal names its exact cause. Retrying
// fetches the same pinned bytes and nothing is selected, so neither a blind
// retry nor the repair preview is usable; the envelope hands off to an
// operator. Independent oracle: the accepted handoff texts.
const DOWNLOAD_HANDOFF = "The downloaded MCPorter release did not match its pinned official digest or provenance, so nothing was installed. Do not bypass verification. Retry the same command only from a network that does not alter downloads; if it still refuses, report the cause to the Connectors plugin maintainer";
const LOCAL_HANDOFF = "The pinned MCPorter release could not be verified on this machine, so nothing was installed. Do not bypass verification. Retry the same command where macOS tar, lipo, and codesign can run, outside any sandbox that denies them; if it still refuses, report the cause to the Connectors plugin maintainer";
const CODESIGN_DENIED = '(version 1)(allow default)(deny process-exec (literal "/usr/bin/codesign"))';

type VerifierCell = { name: string; needsOfficial: boolean; prepare(source: string): void; sandbox?: string; cause: string; handoff: string };
const VERIFIER_CELLS: VerifierCell[] = [
	{ name: "corrupt archive", needsOfficial: false, cause: "archive-digest-mismatch", handoff: DOWNLOAD_HANDOFF, prepare(source) {
		writeFileSync(path.join(source, "mcporter_0.14.0_darwin_arm64.tar.gz"), "corrupt release bytes");
		writeFileSync(path.join(source, "provenance.json"), "{}");
	} },
	{ name: "altered provenance", needsOfficial: true, cause: "provenance-invalid", handoff: DOWNLOAD_HANDOFF, prepare(source) {
		cpSync(path.join(official!, "mcporter_0.14.0_darwin_arm64.tar.gz"), path.join(source, "mcporter_0.14.0_darwin_arm64.tar.gz"));
		const record = JSON.parse(readFileSync(path.join(official!, "provenance.json"), "utf8"));
		writeFileSync(path.join(source, "provenance.json"), JSON.stringify({ ...record, commit: "0".repeat(40) }));
	} },
	{ name: "Developer ID check unavailable", needsOfficial: true, sandbox: CODESIGN_DENIED, cause: "signature-invalid", handoff: LOCAL_HANDOFF, prepare(source) {
		cpSync(path.join(official!, "mcporter_0.14.0_darwin_arm64.tar.gz"), path.join(source, "mcporter_0.14.0_darwin_arm64.tar.gz"));
		cpSync(path.join(official!, "provenance.json"), path.join(source, "provenance.json"));
	} },
];

for (const cell of VERIFIER_CELLS) {
	test.skipIf(cell.needsOfficial && !official)(`first-use ${cell.name} refuses with its verifier cause and an operator handoff`, async () => {
		const bundle = createBundle();
		const hostile = createFakeMcporterBinDir();
		const source = path.join(bundle.root, "release-source");
		const home = path.join(bundle.root, "home");
		const state = path.join(bundle.root, "state");
		mkdirSync(source);
		mkdirSync(home);
		bundle.addSkill("keyless-fixture-skill");
		cell.prepare(source);
		const environment = { home, binDir: hostile.binDir, timeoutMs: 30_000, extraEnv: { XDG_STATE_HOME: state, CONNECTORS_TEST_RELEASE_DIR: source, GITHUB_TOKEN: SENTINEL } };
		try {
			const run = cell.sandbox
				? await runSyspolicyDenied(bundle, ["schema", "keyless-fixture-skill"], environment, cell.sandbox)
				: await runBundle(bundle, ["schema", "keyless-fixture-skill"], environment);
			expect([run.code, run.stderr, run.stdout.trim().split("\n").length]).toEqual([3, "", 1]);
			expect(run.stdout).not.toContain(SENTINEL);
			expect(run.stdout).not.toContain(bundle.root);
			const envelope = JSON.parse(run.stdout);
			expect(envelope.message).toBe(`connectors: MCPorter ${cell.cause}`);
			expect(envelope.result).toMatchObject({ commandIdentity: "connectors.schema", outcome: "refused", causeCode: "DOMAIN_MCPORTER_REPAIR_REQUIRED", transactionState: "unchanged", retryable: false, repairAction: cell.handoff, nextAction: "connectors.doctor" });
			expect(envelope.result.effects).toEqual({ completed: [], remaining: [], uncertain: [], inventoryComplete: true });
			expect(readdirSync(path.join(state, "connectors", "mcporter"))).toEqual([]);
			// Receipts the probe Provider and any PATH MCPorter would leave.
			expect(existsSync(path.join(bundle.root, "probe-spawned"))).toBe(false);
			expect(existsSync(path.join(bundle.root, "mcporter.json"))).toBe(false);
		} finally {
			hostile.dispose();
			bundle.dispose();
		}
	}, 45_000);
}
