// One temp machine for Atlassian 1Password-custody process tests: a HOME,
// plugin-owned state holding a fake op and a fake uv at the paths
// `connectors setup` publishes, and a verified official MCPorter selected
// through the production bootstrap. Receipts are booleans and argv, never
// values.
//
// Keychain: production reads the service token only through the fixed
// /usr/bin/security leaf. A routine fixture runs every process from the
// verified substituted plugin copy (plugin-copy.ts), where that leaf is the
// test-owned reader fake, so its evidence is substituted-reader process
// proof. The attended mode, constructed only by the gated attended suite,
// runs a copy whose leaf is the shipped one, where the real
// /usr/bin/security reads a throwaway keychain file; see attended-keychain.ts.
//
// op and uv: production runs them only when their bytes hash to the plugin
// root's qualified digests. The fixture manifest names the fake launchers'
// digests; the "shipped" manifest keeps the shipped digests, so the same
// fakes must be refused.
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SERVICE_TOKEN_ACCOUNT, SERVICE_TOKEN_SERVICE } from "../../scripts/custody/one-password.ts";
import { ATTENDED_KEYCHAIN, AttendedKeychain } from "./attended-keychain.ts";
import { FAKE_OP_LAUNCHER, FAKE_UV_LAUNCHER, fakeLauncher, REQUIREMENTS, substitutedPluginRoot } from "./plugin-copy.ts";

export const SERVICE_TOKEN = "ops_fixture-service-account-sentinel";
export const PROVIDER_TOKEN = "fixture-atlassian-provider-token-sentinel";
export const OFFICIAL_MCPORTER = process.env.CONNECTORS_OFFICIAL_RELEASE_FIXTURE;
const FIXTURES = import.meta.dir;
const UV_VERSION = (JSON.parse(readFileSync(path.resolve(import.meta.dir, "..", "..", "..", "..", "requirements.json"), "utf8")) as { pins: { uv: string } }).pins.uv;

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

function executable(file: string, content: string): void {
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	writeFileSync(file, content);
	chmodSync(file, 0o700);
}

function privateDirectories(from: string, to: string): void {
	let current = from;
	for (const segment of path.relative(from, to).split(path.sep)) {
		current = path.join(current, segment);
		mkdirSync(current, { recursive: true });
		chmodSync(current, 0o700);
	}
}

// Files that hold a sentinel by design: the fakes' expected values, the
// fake Keychain item's value, and the fake 1Password item.
const SECRET_HOLDERS = new Set(["expected-service-token", "expected-provider-token", "keychain-token", "item.json"]);
// The sweep reads every file below this size; only the MCPorter executable
// is larger.
const SWEEP_LIMIT = 8 * 1024 * 1024;

export class CustodyFixture {
	readonly root = mkdtempSync(path.join(os.tmpdir(), "connectors-atlassian-custody-"));
	readonly home = path.join(this.root, "home");
	// Under HOME, so the state root is the same whether a child resolves it
	// from XDG_STATE_HOME or from HOME.
	readonly state = path.join(this.home, ".local", "state");
	readonly hostileBin = path.join(this.root, "hostile-bin");
	readonly keychain = path.join(this.home, "Library", "Keychains", "login.keychain-db");
	readonly opDirectory = path.join(this.state, "connectors", "setup", "op");
	readonly uvExecutable = path.join(this.state, "connectors", "setup", "uv", "installs", "aqua-astral-sh-uv", UV_VERSION, "uv-aarch64-apple-darwin", "uv");
	readonly mode: "fake" | "attended";
	// The plugin root every process starts from, and its Atlassian skill.
	readonly pluginRoot: string;
	readonly skill: string;
	private readonly attended: AttendedKeychain | null;

	constructor(options: { keychain?: "fake" | "attended"; manifest?: "fixture" | "shipped" } = {}) {
		this.mode = options.keychain ?? "fake";
		if (this.mode === "attended" && !ATTENDED_KEYCHAIN) throw new Error("the attended Keychain fixture needs CONNECTORS_ATTENDED_KEYCHAIN_TEST=1");
		// Fail closed: substitutedPluginRoot throws unless the copy differs from
		// source by exactly its shape.
		try {
			this.pluginRoot = substitutedPluginRoot({ reader: this.mode === "fake" ? "fake" : "shipped", manifest: options.manifest ?? "fixture" });
		} catch (error) {
			rmSync(this.root, { recursive: true, force: true });
			throw error;
		}
		this.skill = path.join(this.pluginRoot, "skills", "atlassian");
		this.attended = this.mode === "attended" ? new AttendedKeychain(this.keychain) : null;
		mkdirSync(path.dirname(this.keychain), { recursive: true });
		privateDirectories(this.root, path.join(this.state, "connectors"));
		writeFileSync(path.join(this.root, "expected-service-token"), SERVICE_TOKEN);
		writeFileSync(path.join(this.root, "expected-provider-token"), PROVIDER_TOKEN);
		// A same-named MCPorter earlier on PATH must never be selected.
		executable(path.join(this.hostileBin, "mcporter"), fakeLauncher(path.join(FIXTURES, "hostile-mcporter.ts")));
	}

	// Stores the one service-token item. The attended mode creates a fresh
	// keychain each time, because updating an existing item can wait on an
	// interactive access prompt.
	installKeychainToken(token: string = SERVICE_TOKEN): void {
		if (this.attended) {
			this.attended.create(token, SERVICE_TOKEN_SERVICE, SERVICE_TOKEN_ACCOUNT);
			return;
		}
		writeFileSync(path.join(this.root, "keychain-item.json"), JSON.stringify({ keychain: this.keychain, service: SERVICE_TOKEN_SERVICE, account: SERVICE_TOKEN_ACCOUNT }));
		writeFileSync(path.join(this.root, "keychain-token"), token, { mode: 0o600 });
	}

	// The absent-token case. The keychain file itself is never removed by
	// hand: only dispose() removes it, through security.
	removeKeychainToken(): void {
		if (this.attended) {
			this.attended.removeItem(SERVICE_TOKEN_SERVICE, SERVICE_TOKEN_ACCOUNT);
			return;
		}
		rmSync(path.join(this.root, "keychain-token"), { force: true });
	}

	// The fake op under the revision name the plugin root's manifest selects.
	installOp(): void {
		const manifest = JSON.parse(readFileSync(path.join(this.pluginRoot, REQUIREMENTS), "utf8")) as { pins: { op: string }; sources: { op: { binarySha256: string } } };
		const name = `op-${manifest.pins.op}-${manifest.sources.op.binarySha256}`;
		privateDirectories(this.state, this.opDirectory);
		executable(path.join(this.opDirectory, name), FAKE_OP_LAUNCHER);
		writeFileSync(path.join(this.opDirectory, "op-selected"), name, { mode: 0o600 });
	}

	installUv(): void {
		privateDirectories(this.state, path.dirname(this.uvExecutable));
		executable(this.uvExecutable, FAKE_UV_LAUNCHER);
	}

	// The complete configured machine: every custody piece present.
	installAll(serviceToken: string = SERVICE_TOKEN): this {
		this.installKeychainToken(serviceToken);
		this.installOp();
		this.installUv();
		return this;
	}

	writeItem(entries: Record<string, string>, version = 1): void {
		writeFileSync(path.join(this.root, "item.json"), JSON.stringify({ version, fields: Object.entries(entries).map(([label, value]) => ({ id: label, label, value })) }));
	}

	canned(product: "jira" | "confluence", name: string, value: unknown): void {
		mkdirSync(path.join(this.root, "canned", product), { recursive: true });
		writeFileSync(path.join(this.root, "canned", product, `${name}.json`), JSON.stringify(value));
	}

	lines<T = Record<string, unknown>>(name: "op-calls.jsonl" | "community-starts.jsonl" | "effects.jsonl" | "hostile-mcporter.jsonl" | "hostile-recorders.jsonl" | "keychain-reads.jsonl"): T[] {
		const file = path.join(this.root, name);
		return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as T) : [];
	}

	// Every byte of plugin state the Atlassian dispatcher owns: journal,
	// receipts, locks, and the Upload Outbox.
	atlassianStateText(): string {
		const base = path.join(this.state, "connectors", "atlassian");
		const texts: string[] = [];
		const walk = (directory: string) => {
			if (!existsSync(directory)) return;
			for (const entry of readdirSync(directory)) {
				const full = path.join(directory, entry);
				if (statSync(full).isDirectory()) walk(full);
				else texts.push(readFileSync(full, "utf8"));
			}
		};
		walk(base);
		return texts.join("\n");
	}

	// Every file the run could have written under the fixture root: HOME,
	// all plugin state including MCPorter's, TMPDIR, and the fakes' logs.
	// Only the files that hold a sentinel by design are skipped.
	sweepText(): string {
		const texts: string[] = [];
		const walk = (directory: string) => {
			for (const entry of readdirSync(directory)) {
				const full = path.join(directory, entry);
				const stats = statSync(full);
				if (stats.isDirectory()) walk(full);
				else if (stats.isFile() && stats.size < SWEEP_LIMIT && !(directory === this.root && SECRET_HOLDERS.has(entry))) texts.push(readFileSync(full, "utf8"));
			}
		};
		walk(this.root);
		return texts.join("\n");
	}

	environment(extra: Record<string, string> = {}): Record<string, string> {
		return {
			HOME: this.home,
			PATH: `${this.hostileBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
			TMPDIR: this.root,
			XDG_STATE_HOME: this.state,
			...(OFFICIAL_MCPORTER ? { CONNECTORS_TEST_RELEASE_DIR: OFFICIAL_MCPORTER } : {}),
			...extra,
		};
	}

	// The packaged front door's machine: no Bun, Node, op, uv, uvx, or
	// MCPorter reachable through PATH, only same-named hostile recorders
	// before the system directories.
	packagedEnvironment(extra: Record<string, string> = {}): Record<string, string> {
		for (const name of ["bun", "node", "op", "uv", "uvx"]) executable(path.join(this.hostileBin, name), fakeLauncher(path.join(FIXTURES, "hostile-recorder.ts")));
		return { ...this.environment(extra), PATH: `${this.hostileBin}:/usr/bin:/bin` };
	}

	// One packaged front-door process with stdin closed: the copy's compiled
	// bin/connectors unless another binary is named.
	async frontDoor(argv: string[], options: { binary?: string; extra?: Record<string, string> } = {}): Promise<RunResult> {
		const proc = Bun.spawn([options.binary ?? path.join(this.pluginRoot, "bin", "connectors"), ...argv], { env: this.packagedEnvironment(options.extra), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { code, stdout, stderr };
	}

	async dispatch(argv: string[], extra: Record<string, string> = {}): Promise<RunResult> {
		const proc = Bun.spawn([process.execPath, path.join(this.skill, "scripts", "atlassian-dispatch.ts"), ...argv], { env: this.environment(extra), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { code, stdout, stderr };
	}

	// Idempotent. The attended keychain is unregistered and deleted through
	// security, and any failure is thrown, before the tree is removed.
	dispose(): void {
		this.attended?.destroy();
		rmSync(this.root, { recursive: true, force: true });
	}
}

// Seeds a fixture's MCPorter selection from one verified bootstrap so each
// test does not re-extract the release.
export function seedMcporter(from: CustodyFixture, to: CustodyFixture): void {
	const source = path.join(from.state, "connectors", "mcporter", "current");
	if (!existsSync(source)) return;
	const target = path.join(to.state, "connectors", "mcporter", "current");
	privateDirectories(to.state, path.dirname(target));
	cpSync(source, target, { recursive: true });
	chmodSync(target, 0o700);
	chmodSync(path.join(target, "mcporter"), 0o700);
	chmodSync(path.join(target, "release.json"), 0o600);
}
