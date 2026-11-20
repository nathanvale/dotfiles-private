import { expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const command = resolve(import.meta.dir, "cli.ts");

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "shared-editor-")));
	const target = join(root, "pilot");
	const user = join(target, "user-data", "User");
	const extensions = join(target, "extensions");
	const state = join(root, "state");
	const source = join(root, "config", "vscode");
	mkdirSync(user, { recursive: true });
	mkdirSync(extensions);
	cpSync(resolve(import.meta.dir, "../../config/vscode"), source, { recursive: true });
	cpSync(import.meta.dir, join(root, "tooling", "vscode"), { recursive: true, filter: (path) => !path.endsWith(".test.ts") });
	const settings = join(user, "settings.json");
	const before = '{"dev.containers.copyGitConfig":false,"custom.keep":true}\n';
	writeFileSync(settings, before);
	writeFileSync(join(extensions, "extensions.json"), JSON.stringify([
		{ identifier: { id: "ms-vscode-remote.remote-containers" }, version: "0.469.0" },
		{ identifier: { id: "ms-vscode-remote.remote-ssh" }, version: "0.128.0" },
		{ identifier: { id: "ms-vscode-remote.remote-ssh-edit" }, version: "0.87.0" },
		{ identifier: { id: "ms-vscode.remote-explorer" }, version: "0.5.0" },
		{ identifier: { id: "nathanvale.diff-toggle" }, version: "0.3.6" },
	]));
	const code = join(root, "fake-code");
	writeFileSync(code, `#!${process.execPath}
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
const root = dirname(process.argv[1]);
appendFileSync(join(root, "calls.jsonl"), JSON.stringify({args, socket:process.env.SSH_AUTH_SOCK, ipc:process.env.VSCODE_IPC_HOOK_CLI, portable:process.env.VSCODE_PORTABLE})+"\\n");
if(existsSync(join(root,"corrupt"))) { writeFileSync(join(args[args.indexOf("--extensions-dir")+1],"extensions.json"),"{bad"); process.exit(9); }
if(existsSync(join(root,"hold"))) { writeFileSync(join(root,"started"),String(process.pid)); await new Promise(()=>{}); }
if(existsSync(join(root,"fail"))) process.exit(9);
const registry = join(args[args.indexOf("--extensions-dir")+1], "extensions.json");
const [id, version] = args[args.indexOf("--install-extension")+1].split("@");
const entries = JSON.parse(readFileSync(registry,"utf8")).filter(row=>row.identifier.id!==id);
entries.push({identifier:{id},version});
writeFileSync(registry,JSON.stringify(entries));
`);
	chmodSync(code, 0o700);
	const cli = join(root, "tooling", "vscode", "cli.ts");
	const run = (...args: string[]) => {
		const result = Bun.spawnSync([process.execPath, cli, ...args, "--json"], {
			stdin: "ignore", env: { ...process.env, SSH_AUTH_SOCK: "/must-not-leak", VSCODE_IPC_HOOK_CLI: "/daily-editor", VSCODE_PORTABLE: "/daily-portable" },
		});
		expect(result.stderr.toString()).toBe("");
		const output = JSON.parse(result.stdout.toString());
		expect(output.envelopeVersion).toBe(2);
		expect(result.exitCode).toBe(output.result.exitCode);
		return output.result;
	};
	const preview = () => run("preview", "--target", target, "--state", state, "--code", code);
	const apply = (plan: string) => run("apply", "--plan", plan, "--editor-closed");
	const calls = () => existsSync(join(root, "calls.jsonl")) ? readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
	return { root, target, user, extensions, state, source, code, settings, before, cli, run, preview, apply, calls, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("preview prepares a plan without changing the editor or launching Code", () => {
	const root = mkdtempSync(join(tmpdir(), "shared-editor-"));
	try {
		const target = join(root, "pilot");
		mkdirSync(join(target, "user-data", "User"), { recursive: true });
		mkdirSync(join(target, "extensions"));
		const settings = join(target, "user-data", "User", "settings.json");
		writeFileSync(settings, '{"dev.containers.copyGitConfig":false}\n');
		writeFileSync(join(target, "extensions", "extensions.json"), "[]\n");
		const result = Bun.spawnSync([process.execPath, command, "preview", "--target", target, "--state", join(root, "state"), "--json"], { stdin: "ignore" });
		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toBe("");
		const output = JSON.parse(result.stdout.toString());
		expect(output.envelopeVersion).toBe(2);
		expect(output.result.commandIdentity).toBe("vscode.preview");
		expect(readFileSync(settings, "utf8")).toBe('{"dev.containers.copyGitConfig":false}\n');
		expect(output.result.data.clientExtensions).toContain("sdras.night-owl@2.1.1");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("apply preserves protections, targets only isolated client installs, is idempotent and rolls back owned files", () => {
	const f = fixture();
	try {
		const preview = f.preview();
		expect(preview.data.blockers).toEqual([]);
		expect(f.calls()).toEqual([]);
		expect(statSync(preview.data.plan).mode & 0o777).toBe(0o600);
		const result = f.apply(preview.data.plan);
		expect(result.causeCode).toBe("SUCCESS_COMPLETED");
		const settings = JSON.parse(readFileSync(f.settings, "utf8"));
		expect(settings["editor.fontSize"]).toBe(14);
		expect(settings["custom.keep"]).toBe(true);
		for (const key of ["dev.containers.copyGitConfig", "dev.containers.dockerCredentialHelper", "remote.autoForwardPorts", "remote.restoreForwardedPorts", "chat.tools.global.autoApprove", "chat.tools.terminal.enableAutoApprove", "markdown-preview-enhanced.enableScriptExecution"]) expect(settings[key]).toBe(false);
		expect(settings["dev.containers.gitCredentialHelperConfigLocation"]).toBe("none");
		expect(settings["extensions.autoUpdate"]).toBe("off");
		expect(settings["files.autoSave"]).toBe("off");
		expect(settings["chat.disableAIFeatures"]).toBe(true);
		expect(settings["remote.SSH.defaultExtensions"]).toEqual([]);
		expect(settings["dev.containers.defaultExtensions"]).toEqual(["vsls-contrib.codetour", "dbaeumer.vscode-eslint", "mermaidchart.vscode-mermaid-chart", "fallow-rs.fallow-vscode"]);
		expect(readFileSync(join(f.user, "keybindings.json"), "utf8")).toBe(readFileSync(join(f.source, "keybindings.json"), "utf8"));
		const calls = f.calls();
		expect(calls).toHaveLength(4);
		for (const call of calls) {
			expect(call.args.slice(0, 4)).toEqual(["--user-data-dir", join(f.target, "user-data"), "--extensions-dir", f.extensions]);
			expect(call.args[4]).toBe("--install-extension");
			expect(call.args[6]).toBe("--do-not-include-pack-dependencies");
			expect(call.args).toHaveLength(7);
			expect(call.socket).toBe("");
			expect(call.ipc).toBeUndefined();
			expect(call.portable).toBeUndefined();
		}
		expect(calls.map((call) => call.args[5])).toContain("sdras.night-owl@2.1.1");
		expect(calls.some((call) => call.args[5].startsWith("ms-vscode-remote.remote-containers"))).toBe(false);
		expect(JSON.parse(readFileSync(join(f.state, "active.json"), "utf8")).phase).toBe("complete");
		const modified = statSync(f.settings).mtimeMs;
		expect(f.apply(preview.data.plan).causeCode).toBe("SUCCESS_UNCHANGED");
		expect(statSync(f.settings).mtimeMs).toBe(modified);
		expect(f.calls()).toHaveLength(4);
		expect(f.run("rollback", "--plan", preview.data.plan, "--editor-closed").causeCode).toBe("SUCCESS_COMPLETED");
		expect(readFileSync(f.settings, "utf8")).toBe(f.before);
		expect(existsSync(join(f.user, "keybindings.json"))).toBe(false);
		expect(JSON.parse(readFileSync(join(f.extensions, "extensions.json"), "utf8"))).toHaveLength(9);
		expect(f.run("rollback", "--plan", preview.data.plan, "--editor-closed").causeCode).toBe("SUCCESS_UNCHANGED");
		expect(f.apply(preview.data.plan).causeCode).toBe("DOMAIN_PRECONDITION_UNMET");
		expect(f.apply(f.preview().data.plan).exitCode).toBe(0);
	} finally { f.cleanup(); }
});

test.each(["settings", "source", "registry", "code"] as const)("apply refuses stale %s without writing or installing", (changed) => {
	const f = fixture();
	try {
		const plan = f.preview().data.plan;
		if (changed === "settings") writeFileSync(f.settings, '{"editor.fontSize":99}');
		if (changed === "source") writeFileSync(join(f.source, "settings.json"), '{"editor.fontSize":99}');
		if (changed === "registry") writeFileSync(join(f.extensions, "extensions.json"), "[]");
		if (changed === "code") writeFileSync(f.code, "# changed");
		const before = readFileSync(f.settings, "utf8");
		expect(f.apply(plan).causeCode).toBe("DOMAIN_PRECONDITION_UNMET");
		expect(readFileSync(f.settings, "utf8")).toBe(before);
		expect(f.calls()).toEqual([]);
	} finally { f.cleanup(); }
});

test("source changes need a new preview, removed settings disappear, and direct editor drift is preserved", () => {
	const f = fixture();
	try {
		const first = f.preview().data.plan;
		expect(f.apply(first).exitCode).toBe(0);
		const managed = readFileSync(f.settings, "utf8");
		writeFileSync(f.settings, '{"editor.fontSize":77}');
		expect(f.preview().causeCode).toBe("DOMAIN_PRECONDITION_UNMET");
		expect(f.run("rollback", "--plan", first, "--editor-closed").causeCode).toBe("DOMAIN_PRECONDITION_UNMET");
		expect(readFileSync(f.settings, "utf8")).toBe('{"editor.fontSize":77}');
		writeFileSync(f.settings, managed);
		writeFileSync(join(f.source, "settings.json"), '{ // JSONC remains supported\n "editor.fontSize":20,\n "remote.SSH.path":"/bad",\n "files.autoSave":"afterDelay",\n }');
		expect(f.apply(f.preview().data.plan).exitCode).toBe(0);
		const settings = JSON.parse(readFileSync(f.settings, "utf8"));
		expect(settings["editor.fontSize"]).toBe(20);
		expect(settings["workbench.colorTheme"]).toBeUndefined();
		expect(settings["remote.SSH.path"]).toBeUndefined();
		expect(settings["files.autoSave"]).toBe("off");
		expect(settings["custom.keep"]).toBe(true);
		expect(f.calls()).toHaveLength(4);
	} finally { f.cleanup(); }
});

test("missing protected transport and missing local VSIX block apply", () => {
	const f = fixture();
	try {
		writeFileSync(join(f.extensions, "extensions.json"), "[]");
		const preview = f.preview();
		expect(preview.data.blockers.some((message: string) => message.includes("nathanvale.diff-toggle"))).toBe(true);
		expect(preview.data.blockers.some((message: string) => message.includes("0.469.0"))).toBe(true);
		expect(f.apply(preview.data.plan).causeCode).toBe("DOMAIN_PRECONDITION_UNMET");
		expect(readFileSync(f.settings, "utf8")).toBe(f.before);
		expect(f.calls()).toEqual([]);
	} finally { f.cleanup(); }
});

test("malformed JSONC and symlink targets refuse without changing editor files", () => {
	const f = fixture();
	try {
		writeFileSync(join(f.source, "settings.json"), "{bad");
		expect(f.preview().causeCode).toBe("SCHEMA_INVALID_INPUT");
		writeFileSync(join(f.source, "settings.json"), "{}");
		const outside = join(f.root, "outside");
		writeFileSync(outside, f.before);
		rmSync(f.settings);
		symlinkSync(outside, f.settings);
		expect(f.preview().causeCode).toBe("DOMAIN_PRECONDITION_UNMET");
		expect(readFileSync(outside, "utf8")).toBe(f.before);
	} finally { f.cleanup(); }
});

test("failed native install leaves durable intent, reports unknown and cannot replay; rollback restores configuration", () => {
	const f = fixture();
	try {
		writeFileSync(join(f.root, "fail"), "");
		const plan = f.preview().data.plan;
		const result = f.apply(plan);
		expect(result.causeCode).toBe("INTERNAL_RESULT_UNKNOWN");
		expect(result.retryable).toBe(false);
		expect(result.effects.completed).toEqual(["keybindings", "settings"]);
		expect(result.effects.uncertain).toEqual(["extension:sdras.night-owl"]);
		expect(JSON.parse(readFileSync(join(f.state, "active.json"), "utf8")).phase).toBe("intent");
		expect(f.run("status", "--plan", plan).data.uncertainAttempt).toBe("extension:sdras.night-owl");
		expect(f.apply(plan).causeCode).toBe("DOMAIN_PRECONDITION_UNMET");
		expect(f.calls()).toHaveLength(1);
		expect(f.run("rollback", "--plan", plan, "--editor-closed").exitCode).toBe(0);
		expect(readFileSync(f.settings, "utf8")).toBe(f.before);
	} finally { f.cleanup(); }
});

test("unreadable native readback retains unknown effects instead of reporting unchanged", () => {
	const f = fixture();
	try {
		writeFileSync(join(f.root, "corrupt"), "");
		const plan = f.preview().data.plan;
		const result = f.apply(plan);
		expect(result.causeCode).toBe("INTERNAL_RESULT_UNKNOWN");
		expect(result.effects.inventoryComplete).toBe(false);
		expect(result.retryable).toBe(false);
		expect(JSON.parse(readFileSync(f.settings, "utf8"))["editor.fontSize"]).toBe(14);
		const status = f.run("status", "--plan", plan);
		expect(status.data.phase).toBe("intent");
		expect(status.data.effects.inventoryComplete).toBe(false);
		expect(f.apply(plan).causeCode).toBe("DOMAIN_PRECONDITION_UNMET");
		expect(f.calls()).toHaveLength(1);
	} finally { f.cleanup(); }
});

test("strict options, discovery, missing authority and an occupied lock return declared results", () => {
	const f = fixture();
	try {
		expect(f.run("apply", "--unknown").causeCode).toBe("USAGE_INVALID_INVOCATION");
		expect(f.run("preview").exitCode).toBe(2);
		const metadata = f.run("--discover-command", "vscode.apply").data;
		expect(metadata.profile).toBe("complex");
		expect(metadata.commands[0].commandIdentity).toBe("vscode.apply");
		expect(metadata.commands[0].stations.some((station: { causeCode: string }) => station.causeCode === "INTERNAL_RESULT_UNKNOWN")).toBe(true);
		const plan = f.preview().data.plan;
		expect(f.run("apply", "--plan", plan).causeCode).toBe("DOMAIN_PRECONDITION_UNMET");
		mkdirSync(join(f.state, "lock"));
		expect(f.apply(plan).causeCode).toBe("TRANSIENT_NOT_STARTED");
		expect(readFileSync(f.settings, "utf8")).toBe(f.before);
	} finally { f.cleanup(); }
});

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!existsSync(path)) {
		if (Date.now() > deadline) throw new Error("Fixture installer did not reach its barrier.");
		await Bun.sleep(10);
	}
}

test("concurrent apply has one owner and SIGTERM leaves inspectable intent without an orphan installer", async () => {
	const f = fixture();
	let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
	try {
		writeFileSync(join(f.root, "hold"), "");
		const plan = f.preview().data.plan;
		child = Bun.spawn([process.execPath, f.cli, "apply", "--plan", plan, "--editor-closed", "--json"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		await waitForFile(join(f.root, "started"));
		expect(f.apply(plan).causeCode).toBe("TRANSIENT_NOT_STARTED");
		expect(f.calls()).toHaveLength(1);
		const installer = Number(readFileSync(join(f.root, "started"), "utf8"));
		child.kill("SIGTERM");
		expect(await child.exited).toBe(143);
		expect(await new Response(child.stdout).text()).toBe("");
		expect(await new Response(child.stderr).text()).toBe("");
		const status = f.run("status", "--plan", plan);
		expect(status.data.phase).toBe("intent");
		expect(status.data.uncertainAttempt).toBe("extension:sdras.night-owl");
		// The lock survives forced exit. Only remove after proving its owner died.
		const owner = Number(status.data.lockPid);
		expect(() => process.kill(owner, 0)).toThrow();
		rmSync(join(f.state, "lock"), { recursive: true });
		const stopped = Date.now() + 1000;
		while (Date.now() < stopped) {
			try { process.kill(installer, 0); } catch { break; }
			await Bun.sleep(10);
		}
		expect(() => process.kill(installer, 0)).toThrow();
		expect(f.apply(plan).causeCode).toBe("DOMAIN_PRECONDITION_UNMET");
		expect(f.run("rollback", "--plan", plan, "--editor-closed").exitCode).toBe(0);
		expect(readFileSync(f.settings, "utf8")).toBe(f.before);
	} finally { child?.kill(); f.cleanup(); }
});
