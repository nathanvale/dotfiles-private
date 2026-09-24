// Shared public-process harness for every connector test. One owner of the
// fake processes and custody assertions; per-skill tests add expectations only.
import { expect } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PLUGIN_ROOT = path.resolve(import.meta.dir, "..");
export const ROUTE = path.join(PLUGIN_ROOT, "bin", "provider-route.ts");
export const FRONT_DOOR = path.join(PLUGIN_ROOT, "bin", "connectors");
export const FIXTURES = path.join(PLUGIN_ROOT, "tests", "fixtures");
// Same launcher main, bound to the fixture skills under tests/fixtures.
export const FIXTURE_ROUTE = path.join(FIXTURES, "provider-route-fixture.ts");
export const AMBIENT_SENTINEL = "must-not-cross-route";
export const OP_TOKEN_SENTINEL = "fixture-op-service-account-token";

export const itemJson = (entries: Record<string, string>, version?: number | string): string => JSON.stringify({
	...(version === undefined ? {} : { version }),
	fields: Object.entries(entries).map(([label, value]) => ({ id: label, label, value })),
});

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	pid: number;
}

export interface Harness {
	root: string;
	home: string;
	binDir: string;
	run(argv: string[], extraEnv?: Record<string, string>, entry?: string): Promise<RunResult>;
	receipt<T = Record<string, unknown>>(name: string): T;
	has(name: string): boolean;
	write(name: string, content: string): void;
	dispose(): void;
}

// Sole owner of "spawn a process and capture stdout/stderr/exit code";
// every real-process runner in this file composes it instead of repeating
// the Bun.spawn + Promise.all shape.
async function spawnCapture(argv: string[], env: Record<string, string>, timeoutMs?: number, cwd?: string): Promise<RunResult> {
	const proc = Bun.spawn(argv, { env, ...(cwd === undefined ? {} : { cwd }), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const captured = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = timeoutMs === undefined
			? captured
			: Promise.race([
				captured,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						proc.kill();
						reject(new Error(`process exceeded ${timeoutMs} ms: ${argv[0]}`));
					}, timeoutMs);
				}),
			]);
		const [stdout, stderr, code] = await result;
		return { code, stdout, stderr, pid: proc.pid };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function shim(file: string, modulePath: string): void {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, `#!/usr/bin/env bun\nimport "${modulePath}";\n`);
	chmodSync(file, 0o755);
}

// `fakes` maps an executable name on PATH to the TypeScript module that
// implements it. The 1Password helper is always installed at the path the
// Providers resolve below HOME.
export function createHarness(fakes: Record<string, string>): Harness {
	const root = mkdtempSync(path.join(os.tmpdir(), "connectors-test-"));
	const home = path.join(root, "home");
	const binDir = path.join(root, "bin");
	shim(path.join(home, "code", "dotfiles", "bin", "with-one-password-token"), path.join(FIXTURES, "one-password-fake.ts"));
	shim(path.join(binDir, "mcporter"), path.join(FIXTURES, "mcporter-fake.ts"));
	symlinkSync(process.execPath, path.join(binDir, "bun"));
	for (const [name, modulePath] of Object.entries(fakes)) shim(path.join(binDir, name), modulePath);
	return {
		root,
		home,
		binDir,
		async run(argv, extraEnv = {}, entry = ROUTE) {
			return spawnCapture([process.execPath, entry, ...argv], {
				HOME: home,
				PATH: `${binDir}:${process.env.PATH ?? ""}`,
				TMPDIR: root,
				XDG_STATE_HOME: root,
				AMBIENT_SENTINEL,
				OP_SERVICE_ACCOUNT_TOKEN: OP_TOKEN_SENTINEL,
				...extraEnv,
			});
		},
		receipt(name) {
			return JSON.parse(readFileSync(path.join(root, name), "utf8"));
		},
		has(name) {
			return existsSync(path.join(root, name));
		},
		write(name, content) {
			writeFileSync(path.join(root, name), content);
		},
		dispose() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

// Spawns the compiled front door itself (never the .ts source, never through
// `bun`), with an empty HOME and a PATH holding only fixed system directories,
// no Bun, Node, mise, or op shim of any kind. Fails loudly if the packaged
// binary is missing rather than silently falling back to the interpreted
// source: a missing artifact is a build gap, not a lower-layer substitute.
export async function runFrontDoor(argv: string[]): Promise<RunResult> {
	if (!existsSync(FRONT_DOOR)) {
		throw new Error(`compiled front door missing at ${FRONT_DOOR}; run \`bun run build\` in the plugin directory first`);
	}
	const home = mkdtempSync(path.join(os.tmpdir(), "connectors-front-door-home-"));
	try {
		return await spawnCapture([FRONT_DOOR, ...argv], { HOME: home, PATH: "/usr/bin:/bin" });
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

export interface McporterReceipt {
	argv: string[];
	env: Record<string, string>;
	pid: number;
	cwd: string;
	kind: "stdio" | "http";
	url?: string;
	headers?: Record<string, string> | null;
	command?: string;
}

// Below-MCPorter Provider custody assertion. Native OAuth routes use
// MCPorter's private cache and assert their attended auth path separately.
// Ordinary calls still disable interactive OAuth and keep-alive; fixture
// secrets and ambient authority stay out of public streams.
export function assertCustody(harness: Harness, result: RunResult, secrets: string[], ownership: "replacement" | "child" = "replacement"): McporterReceipt {
	const receipt = harness.receipt<McporterReceipt>("mcporter.json");
	for (const key of ["AMBIENT_SENTINEL", "OP_SERVICE_ACCOUNT_TOKEN"]) {
		expect(receipt.env).not.toHaveProperty(key);
	}
	expect(receipt.env.MCPORTER_NO_KEEPALIVE).toBe("*");
	expect(receipt.argv[0]).toBe("--config");
	expect(receipt.argv.filter((token) => token === "--no-oauth")).toHaveLength(1);
	if (ownership === "replacement") expect(receipt.pid).toBe(result.pid);
	else expect(receipt.pid).not.toBe(result.pid);
	const serialized = JSON.stringify(receipt);
	for (const secret of [OP_TOKEN_SENTINEL, ...secrets]) {
		expect(serialized).not.toContain(secret);
		expect(result.stdout).not.toContain(secret);
		expect(result.stderr).not.toContain(secret);
	}
	return receipt;
}

// T2 (Ticket #89 under Spec #87): an isolated bundle of the compiled binary
// plus a skills/ directory, laid out exactly like the installed plugin
// (<bundle>/bin/connectors, <bundle>/skills/<id>/config/...). The generic
// command core resolves skills/ relative to process.execPath, so copying the
// binary elsewhere and mutating the copy's own skills/ directory between two
// runs of the exact same binary file is what proves manifest-only Connector
// Skill extensibility, never a git-diff or SHA assertion inside a test.
export interface Bundle {
	readonly root: string;
	readonly binary: string;
	readonly skillsRoot: string;
	addSkill(fixtureName: string): void;
	dispose(): void;
}

const REAL_KEYLESS_SKILLS = ["context7", "firecrawl"] as const;

export function createBundle(): Bundle {
	const root = mkdtempSync(path.join(os.tmpdir(), "connectors-bundle-"));
	mkdirSync(path.join(root, "bin"), { recursive: true });
	const binary = path.join(root, "bin", "connectors");
	if (!existsSync(FRONT_DOOR)) {
		throw new Error(`compiled front door missing at ${FRONT_DOOR}; run \`bun run build\` in the plugin directory first`);
	}
	cpSync(FRONT_DOOR, binary);
	chmodSync(binary, 0o755);
	cpSync(path.join(PLUGIN_ROOT, "requirements.json"), path.join(root, "requirements.json"));
	cpSync(path.join(PLUGIN_ROOT, "config"), path.join(root, "config"), { recursive: true });
	const skillsRoot = path.join(root, "skills");
	mkdirSync(skillsRoot, { recursive: true });
	for (const id of REAL_KEYLESS_SKILLS) {
		cpSync(path.join(PLUGIN_ROOT, "skills", id, "config"), path.join(skillsRoot, id, "config"), { recursive: true });
	}
	return {
		root,
		binary,
		skillsRoot,
		addSkill(fixtureName: string) {
			cpSync(path.join(FIXTURES, fixtureName, "config"), path.join(skillsRoot, fixtureName, "config"), { recursive: true });
			// The fixture's own mcporter.json declares its stdio command as
			// "../../stdio-probe-server.ts", relative to tests/fixtures/ in the
			// real repository layout; carry that one shared probe server into
			// the bundle at the same relative position so the copied registry
			// resolves identically once mounted under <bundle>/skills/.
			cpSync(path.join(FIXTURES, "stdio-probe-server.ts"), path.join(skillsRoot, "stdio-probe-server.ts"));
		},
		dispose() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

// Runs a bundle's own compiled binary (never the shared FRONT_DOOR path
// directly), with a fully controlled HOME/PATH/TMPDIR so a schema fetch can
// resolve a fake `mcporter` from binDir without touching any real network.
export async function runBundle(bundle: Bundle, argv: string[], env: { home: string; binDir?: string; extraEnv?: Record<string, string>; timeoutMs?: number; cwd?: string }): Promise<RunResult> {
	const path_ = env.binDir ? `${env.binDir}:/usr/bin:/bin` : "/usr/bin:/bin";
	return spawnCapture([bundle.binary, ...argv], { HOME: env.home, PATH: path_, TMPDIR: bundle.root, ...env.extraEnv }, env.timeoutMs, env.cwd);
}

// A PATH directory carrying only the fake mcporter (and the bun shebang
// target it needs), independent of createHarness's own dotfiles-shaped
// binDir: the generic command core never resolves a below-MCPorter dotfiles
// wrapper, only `mcporter` itself.
export function createFakeMcporterBinDir(): { binDir: string; dispose(): void } {
	const root = mkdtempSync(path.join(os.tmpdir(), "connectors-mcporter-bin-"));
	shim(path.join(root, "mcporter"), path.join(FIXTURES, "mcporter-fake.ts"));
	symlinkSync(process.execPath, path.join(root, "bun"));
	return {
		binDir: root,
		dispose() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

// T2 (Ticket #89 under Spec #87, Spec AC23): put the independent authority
// at the test bundle's fixed path. The PATH directory supplies only Bun for
// its shebang; the adapter never resolves the authority from PATH. This
// fixture file is absent from a real install by design.
export function createFixtureAuthorityBinDir(bundle: Bundle): { binDir: string; dispose(): void } {
	const root = mkdtempSync(path.join(os.tmpdir(), "connectors-fixture-authority-bin-"));
	// Only the test bundle carries this authority. The adapter resolves this
	// bundle-owned path, never a same-named executable supplied by PATH.
	shim(path.join(bundle.root, "tests", "fixture-authority"), path.join(FIXTURES, "fixture-authority-fake.ts"));
	symlinkSync(process.execPath, path.join(root, "bun"));
	return {
		binDir: root,
		dispose() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

export function createChallengeAuthorityBinDir(bundle: Bundle): { binDir: string; dispose(): void } {
	const root = mkdtempSync(path.join(os.tmpdir(), "connectors-challenge-authority-bin-"));
	shim(path.join(bundle.root, "tests", "challenge-authority"), path.join(FIXTURES, "challenge-authority-fake.ts"));
	symlinkSync(process.execPath, path.join(root, "bun"));
	return { binDir: root, dispose() { rmSync(root, { recursive: true, force: true }); } };
}
