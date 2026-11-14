import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { compose, type Configuration, digest, directory, file, inventory, json, object, Refusal, requireValue, serialize, type Snapshot, snapshot, sources, strings, targetPaths } from "./model.ts";

export type Artifact = { path: string; hash: string };
export type Plan = {
	version: 1;
	id: string;
	nonce: string;
	target: string;
	state: string;
	sourceHash: string;
	before: Snapshot;
	after: Configuration;
	code: Artifact | null;
	vsix: Record<string, Artifact>;
	desiredExtensions: Record<string, string>;
	protectedVersions: Record<string, string>;
	previouslyOwned: string[];
	ownedSettings: string[];
};
type Journal = { plan: Plan; phase: "intent" | "complete" | "rollback-intent" | "rolled-back"; uncertain: string | null };
export type Observation = { completed: string[]; remaining: string[]; uncertain: string[]; inventoryComplete: boolean };

function privateDirectory(path: string): string {
	requireValue(isAbsolute(path), "Use an absolute state path.", "usage");
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const canonical = directory(path);
	requireValue((lstatSync(canonical).mode & 0o077) === 0, "State directory must have mode 0700.");
	return canonical;
}

function atomic(path: string, value: string): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try {
		writeFileSync(fd, value);
		fsyncSync(fd);
		renameSync(temporary, path);
		const parent = openSync(dirname(path), constants.O_RDONLY);
		try { fsyncSync(parent); } finally { closeSync(parent); }
	} finally {
		closeSync(fd);
		rmSync(temporary, { force: true });
	}
}

function artifact(path: string): Artifact {
	requireValue(isAbsolute(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), "Use an absolute regular artifact path.");
	return { path: resolve(path), hash: createHash("sha256").update(readFileSync(path)).digest("hex") };
}

function localArtifacts(args: string[]): Record<string, Artifact> {
	return Object.fromEntries(args.map((arg) => {
		const separator = arg.indexOf("=");
		requireValue(separator > 0, "Use --vsix publisher.name=/absolute/file.vsix.", "usage");
		const id = arg.slice(0, separator);
		const source = sources();
		const record = artifact(arg.slice(separator + 1));
		const metadata = object(json(execFileSync("/usr/bin/unzip", ["-p", record.path, "extension/package.json"], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5000, stdio: ["ignore", "pipe", "pipe"] })));
		requireValue(`${metadata.publisher}.${metadata.name}` === id && source.local[id] === metadata.version, "VSIX identity/version does not match the local extension declaration.");
		return [id, record];
	}));
}

function journalPath(state: string): string { return join(state, "active.json"); }

function readJournal(state: string): Journal | null {
	const text = file(journalPath(state));
	if (text === null) return null;
	const value = object(json(text));
	requireValue(["intent", "complete", "rollback-intent", "rolled-back"].includes(String(value.phase)) && (value.uncertain === null || typeof value.uncertain === "string"), "Invalid journal; inspect and repair it manually.", "schema");
	return { plan: validatePlan(value.plan), phase: value.phase as Journal["phase"], uncertain: value.uncertain as string | null };
}

function configuration(value: unknown): Configuration {
	const row = object(value);
	requireValue((row.settings === null || typeof row.settings === "string") && (row.keybindings === null || typeof row.keybindings === "string"), "Invalid configuration snapshot.", "schema");
	return { settings: row.settings, keybindings: row.keybindings };
}

function validateArtifact(value: unknown): Artifact {
	const row = object(value);
	requireValue(typeof row.path === "string" && isAbsolute(row.path) && typeof row.hash === "string" && /^[a-f0-9]{64}$/.test(row.hash), "Invalid artifact declaration.", "schema");
	return { path: row.path, hash: row.hash };
}

function validatePlan(value: unknown): Plan {
	const row = object(value);
	requireValue(row.version === 1 && typeof row.id === "string" && typeof row.nonce === "string" && typeof row.target === "string" && typeof row.state === "string" && typeof row.sourceHash === "string", "Unsupported plan format.", "schema");
	const before = object(row.before);
	const installed = object(before.extensions);
	requireValue(Object.values(installed).every((version) => typeof version === "string"), "Invalid installed extension snapshot.", "schema");
	const plan: Plan = {
		version: 1, id: row.id, nonce: row.nonce, target: row.target, state: row.state, sourceHash: row.sourceHash,
		before: { ...configuration(before), extensions: installed as Record<string, string> },
		after: configuration(row.after),
		code: row.code === null ? null : validateArtifact(row.code),
		vsix: Object.fromEntries(Object.entries(object(row.vsix)).map(([id, item]) => [id, validateArtifact(item)])),
		desiredExtensions: stringMap(row.desiredExtensions),
		protectedVersions: stringMap(row.protectedVersions),
		previouslyOwned: strings(row.previouslyOwned),
		ownedSettings: strings(row.ownedSettings),
	};
	const { id, ...payload } = plan;
	requireValue(digest(serialize(payload)) === id, "Plan was edited or corrupted; create a fresh preview.", "schema");
	return plan;
}

function stringMap(value: unknown): Record<string, string> {
	const row = object(value);
	requireValue(Object.values(row).every((item) => typeof item === "string"), "Invalid extension versions.", "schema");
	return row as Record<string, string>;
}

export function loadPlan(path: string): Plan {
	const text = file(path);
	requireValue(text !== null && (lstatSync(path).mode & 0o077) === 0, "Plan must exist and have mode 0600.");
	const plan = validatePlan(json(text));
	requireValue(resolve(path) === join(plan.state, `${plan.id}.json`), "Apply the original plan in its own state directory.");
	requireValue(directory(plan.state) === plan.state && targetPaths(plan.target).root === plan.target, "Plan directories changed.");
	return plan;
}

function matchingConfig(actual: Configuration, expected: Configuration): boolean {
	return actual.settings === expected.settings && actual.keybindings === expected.keybindings;
}

function checkManaged(target: string, state: string): void {
	const active = readJournal(state);
	if (!active) return;
	requireValue(active.plan.target === target, "Use a separate state directory for each isolated target.");
	requireValue(active.phase === "complete" || active.phase === "rolled-back", "An unfinished apply exists. Run status, then guarded rollback; do not replay it.");
	const expected = active.phase === "complete" ? active.plan.after : active.plan.before;
	requireValue(matchingConfig(snapshot(target), expected), "Editor settings drifted. Preserve the edit, reconcile it in dotfiles, then restore the last managed bytes before previewing.");
}

export function preview(target: string, stateOption: string | undefined, code: string | undefined, vsix: string[]) {
	const paths = targetPaths(target);
	const state = privateDirectory(stateOption ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "dotfiles-vscode", digest(paths.root).slice(0, 16)));
	requireValue(!state.startsWith(`${paths.root}/`) && state !== paths.root, "Keep preview state outside the editor directories.");
	checkManaged(paths.root, state);
	const before = snapshot(paths.root);
	const source = sources();
	const active = readJournal(state);
	const previouslyOwned = active?.phase === "complete" ? active.plan.ownedSettings : [];
	const payload = { version: 1 as const, nonce: randomUUID(), target: paths.root, state, sourceHash: source.hash, before, after: compose(before, previouslyOwned), code: code ? artifact(code) : null, vsix: localArtifacts(vsix), desiredExtensions: { ...source.client, ...source.local }, protectedVersions: source.protectedVersions, previouslyOwned, ownedSettings: [...new Set([...Object.keys(source.personal), ...Object.keys(source.policy)])].sort() };
	const plan = { ...payload, id: digest(serialize(payload)) };
	const path = join(state, `${plan.id}.json`);
	if (file(path) === null) {
		const fd = openSync(path, "wx", 0o600);
		try { writeFileSync(fd, serialize(plan)); fsyncSync(fd); } finally { closeSync(fd); }
	}
	const installed = before.extensions;
	const clientExtensions = Object.entries({ ...source.client, ...source.local }).filter(([id, version]) => installed[id] !== version).map(([id, version]) => `${id}@${version}`).sort();
	return {
		plan: path,
		clientExtensions,
		workspaceExtensions: source.workspace,
		protectedExtensions: source.protectedVersions,
		settingsChanged: before.settings !== plan.after.settings,
		keybindingsChanged: before.keybindings !== plan.after.keybindings,
		overrides: Object.keys(source.policy).filter((key) => key in source.personal).sort(),
		blockers: blockers(plan),
	};
}

function blockers(plan: Plan): string[] {
	const source = sources();
	const result: string[] = [];
	if (!plan.code) result.push("Preview again with --code /absolute/path/to/code before applying.");
	for (const [id, version] of Object.entries(source.protectedVersions)) {
		if (plan.before.extensions[id] !== version) result.push(`Protected ${id}@${version} must already be installed. Resolve through the connection owner.`);
	}
	for (const [id, version] of Object.entries(source.local)) {
		if (plan.before.extensions[id] !== version && !plan.vsix[id]) result.push(`Provide --vsix ${id}=/absolute/path/to/matching-${version}.vsix in a fresh preview.`);
	}
	return result;
}

function saveJournal(journal: Journal): void {
	atomic(journalPath(journal.plan.state), serialize(journal));
}

async function lock<T>(state: string, action: () => T | Promise<T>): Promise<T> {
	const path = join(state, "lock");
	try { mkdirSync(path, { mode: 0o700 }); } catch {
		throw new Refusal("transient", "Another operation owns the state lock. Run status; remove a stale lock only after proving its recorded PID is gone.");
	}
	try {
		writeFileSync(join(path, "pid"), String(process.pid), { flag: "wx", mode: 0o600 });
		return await action();
	} finally { rmSync(path, { recursive: true }); }
}

function record(evidence: Observation, id: string, values: { actual: unknown; before: unknown; after: unknown }): void {
	if (values.before === values.after) return;
	if (values.actual === values.after) evidence.completed.push(id);
	else if (values.actual === values.before) evidence.remaining.push(id);
	else evidence.uncertain.push(id);
}

function configurationEvidence(actual: Configuration, from: Configuration, to: Configuration): Observation {
	const evidence: Observation = { completed: [], remaining: [], uncertain: [], inventoryComplete: true };
	for (const key of ["keybindings", "settings"] as const) {
		record(evidence, key, { actual: actual[key], before: from[key], after: to[key] });
	}
	return evidence;
}

function observe(plan: Plan): Observation {
	const actual = snapshot(plan.target);
	const evidence = configurationEvidence(actual, plan.before, plan.after);
	for (const [id, version] of Object.entries(plan.desiredExtensions)) {
		record(evidence, `extension:${id}`, { actual: actual.extensions[id], before: plan.before.extensions[id], after: version });
	}
	for (const [id, version] of Object.entries(plan.protectedVersions)) {
		if (actual.extensions[id] !== version) evidence.uncertain.push(`extension:${id}`);
	}
	return { ...evidence, completed: evidence.completed.sort(), remaining: evidence.remaining.sort(), uncertain: evidence.uncertain.sort() };
}

export class Incomplete extends Error {
	constructor(public readonly evidence: Observation) {
		super("Apply or rollback did not complete. Run status with this plan; inspect uncertain effects before rollback. Do not retry apply.");
	}
}

function replaceConfiguration(plan: Plan, from: Configuration, to: Configuration): void {
	const paths = targetPaths(plan.target);
	for (const key of ["settings", "keybindings"] as const) {
		const path = join(paths.user, `${key}.json`);
		if (from[key] === to[key]) continue;
		requireValue(file(path) === from[key], "Editor changed during apply. Run status and inspect before rollback.");
		if (to[key] === null) rmSync(path);
		else atomic(path, to[key]);
		requireValue(file(path) === to[key], "Configuration write could not be verified.");
	}
}

let installerPid: number | undefined;

export function stopInstaller(): void {
	if (installerPid === undefined) return;
	try { process.kill(-installerPid, "SIGKILL"); } catch { /* The installer may already have exited. */ }
}

async function runInstaller(code: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
	await new Promise<void>((resolveResult, reject) => {
		const child = spawn(code, args, { env, stdio: "ignore", detached: true });
		installerPid = child.pid;
		const timer = setTimeout(() => {
			stopInstaller();
			reject(new Error("Installer deadline expired."));
		}, 120000);
		child.once("error", reject);
		child.once("close", (code) => code === 0 ? resolveResult() : reject(new Error("Installer did not complete.")));
		child.once("close", () => clearTimeout(timer));
	}).finally(() => { installerPid = undefined; });
}

async function install(plan: Plan, journal: Journal): Promise<void> {
	const paths = targetPaths(plan.target);
	const source = sources();
	requireValue(plan.code, "A bound Code executable is required.");
	for (const [id, version] of Object.entries({ ...source.client, ...source.local })) {
		if (inventory(paths.extensions)[id] === version) continue;
		journal.uncertain = `extension:${id}`;
		saveJournal(journal);
		const env: NodeJS.ProcessEnv = { ...process.env, SSH_AUTH_SOCK: "", ELECTRON_RUN_AS_NODE: "1" };
		delete env.VSCODE_IPC_HOOK_CLI;
		delete env.VSCODE_PORTABLE;
		const specifier = plan.vsix[id]?.path ?? `${id}@${version}`;
		await runInstaller(plan.code.path, ["--user-data-dir", paths.userData, "--extensions-dir", paths.extensions, "--install-extension", specifier, "--do-not-include-pack-dependencies"], env);
		const installed = inventory(paths.extensions);
		requireValue(installed[id] === version && Object.entries(source.protectedVersions).every(([key, expected]) => installed[key] === expected), "Extension readback failed or protected transport changed.");
		journal.uncertain = null;
		saveJournal(journal);
	}
}

export async function apply(plan: Plan, editorClosed: boolean) {
	requireValue(editorClosed, "Close the isolated editor and pass --editor-closed. Unsaved buffers cannot be inspected by this command.");
	return lock(plan.state, async () => {
		const active = readJournal(plan.state);
		if (active?.plan.id === plan.id) {
			requireValue(active.phase === "complete" && matchingConfig(snapshot(plan.target), plan.after), "This plan was consumed. Run status and rollback; do not replay.");
			const evidence = observe(plan);
			requireValue(evidence.remaining.length === 0 && evidence.uncertain.length === 0, "Installed extensions drifted; inspect with status.");
			return { unchanged: true, effects: evidence };
		}
		checkManaged(plan.target, plan.state);
		requireValue(sources().hash === plan.sourceHash && serialize(snapshot(plan.target)) === serialize(plan.before), "Preview is stale. Create a fresh preview; preserve any direct editor changes first.");
		requireValue(serialize(compose(plan.before, plan.previouslyOwned)) === serialize(plan.after), "Preview output does not match the current source.");
		requireValue(blockers(plan).length === 0, blockers(plan).join(" "));
		for (const value of [plan.code, ...Object.values(plan.vsix)]) {
			if (value) requireValue(artifact(value.path).hash === value.hash, "A bound executable or VSIX changed. Create a fresh preview.");
		}
		const journal: Journal = { plan, phase: "intent", uncertain: null };
		saveJournal(journal);
		try {
			replaceConfiguration(plan, plan.before, plan.after);
			await install(plan, journal);
			const effects = safeObserve(plan);
			requireValue(effects.remaining.length === 0 && effects.uncertain.length === 0, "Apply readback did not match.");
			journal.phase = "complete";
			saveJournal(journal);
			return { unchanged: effects.completed.length === 0, effects };
		} catch {
			const effects = safeObserve(plan);
			if (journal.uncertain && !effects.completed.includes(journal.uncertain)) {
				effects.remaining = effects.remaining.filter((id) => id !== journal.uncertain);
				if (!effects.uncertain.includes(journal.uncertain)) effects.uncertain.push(journal.uncertain);
			}
			effects.uncertain.sort();
			throw new Incomplete(effects);
		}
	});
}

function safeObserve(plan: Plan): Observation {
	try { return observe(plan); } catch {
		return { completed: [], remaining: [], uncertain: ["configuration"], inventoryComplete: false };
	}
}

export async function rollback(plan: Plan, editorClosed: boolean) {
	requireValue(editorClosed, "Close the isolated editor and pass --editor-closed before rollback.");
	return lock(plan.state, () => {
		const active = readJournal(plan.state);
		requireValue(active?.plan.id === plan.id, "Only the active plan can be rolled back.");
		const actual = snapshot(plan.target);
		for (const key of ["settings", "keybindings"] as const) {
			requireValue(actual[key] === plan.before[key] || actual[key] === plan.after[key], "Rollback found edited settings. Preserve and reconcile those edits manually first.");
		}
		if (active.phase === "rolled-back") return { unchanged: true, retainedExtensions: inventory(targetPaths(plan.target).extensions) };
		active.phase = "rollback-intent";
		saveJournal(active);
		try {
			replaceConfiguration(plan, actual, plan.before);
			active.phase = "rolled-back";
			saveJournal(active);
			return { unchanged: matchingConfig(actual, plan.before), retainedExtensions: inventory(targetPaths(plan.target).extensions) };
		} catch {
			let evidence: Observation;
			try { evidence = configurationEvidence(snapshot(plan.target), actual, plan.before); }
			catch { evidence = { completed: [], remaining: [], uncertain: ["configuration"], inventoryComplete: false }; }
			throw new Incomplete(evidence);
		}
	});
}

export function status(plan: Plan) {
	const active = readJournal(plan.state);
	const effects = safeObserve(plan);
	if (active?.plan.id === plan.id && active.uncertain && !effects.completed.includes(active.uncertain)) {
		effects.remaining = effects.remaining.filter((id) => id !== active.uncertain);
		if (!effects.uncertain.includes(active.uncertain)) effects.uncertain.push(active.uncertain);
	}
	return {
		phase: active?.plan.id === plan.id ? active.phase : "not-active",
		effects,
		lockPid: file(join(plan.state, "lock", "pid")),
		uncertainAttempt: active?.plan.id === plan.id ? active.uncertain : null,
	};
}
