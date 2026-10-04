// One temp machine for Figma's packaged process tests, run from a private copy
// of the whole plugin that differs from source in exactly three declared
// places: the Figma endpoint leaf holds endpoint-fake.ts, the Figma registry's
// baseUrl names the loopback stub (its only changed value), and bin/connectors
// is compiled from that copy. Every process runs under a sandbox that allows
// loopback only and denies the real Keychain tool. MCPorter is the official
// 0.14.0 release the front door verifies; a hostile mcporter sits first on
// PATH and must stay unused. Evidence is substituted-source packaged process
// proof, never shipped-binary or hosted proof.
import { afterAll } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileFrontDoor } from "../../../../tests/compile-front-door.ts";
import { changedPaths, fakeLauncher, SHIPPED_ROOT } from "../../../atlassian/tests/fixtures/plugin-copy.ts";

export const OFFICIAL_MCPORTER = process.env.CONNECTORS_OFFICIAL_RELEASE_FIXTURE;
const ENDPOINT_LEAF = path.join("skills", "figma", "scripts", "endpoint.ts");
const REGISTRY = path.join("skills", "figma", "config", "mcporter.json");
const FAKE_ENDPOINT = path.join(import.meta.dir, "endpoint-fake.ts");
const HOSTILE = path.resolve(import.meta.dir, "..", "..", "..", "atlassian", "tests", "fixtures", "hostile-mcporter.ts");
const LOOPBACK_ONLY = '(version 1)(allow default)(deny network-outbound (remote ip))(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))(allow network-outbound (remote ip "localhost:*"))(deny process-exec (literal "/usr/bin/security"))';
// The one port-free placeholder the copied registry carries; each machine's
// stub URL replaces it in that machine's own registry file.
const STUB_PLACEHOLDER = "http://127.0.0.1:9/figma-stub";

// Fail closed: the copy must differ from source by exactly its declared shape.
function verifiedCopy(): string {
	const copy = mkdtempSync(path.join(os.tmpdir(), "connectors-figma-plugin-"));
	cpSync(SHIPPED_ROOT, copy, { recursive: true, verbatimSymlinks: true });
	writeFileSync(path.join(copy, ENDPOINT_LEAF), readFileSync(FAKE_ENDPOINT));
	const registry = JSON.parse(readFileSync(path.join(copy, REGISTRY), "utf8"));
	registry.mcpServers["figma-connectors"].baseUrl = STUB_PLACEHOLDER;
	writeFileSync(path.join(copy, REGISTRY), `${JSON.stringify(registry, null, "\t")}\n`);
	compileFrontDoor(path.join(copy, "bin", "connectors.ts"), path.join(copy, "bin", "connectors"));
	const expected = [path.join("bin", "connectors"), ENDPOINT_LEAF, REGISTRY].sort();
	const changed = changedPaths(SHIPPED_ROOT, copy);
	if (JSON.stringify(changed) !== JSON.stringify(expected)) throw new Error(`Figma plugin copy changes ${JSON.stringify(changed)}, expected ${JSON.stringify(expected)}`);
	return copy;
}

let shared: string | null = null;
function pluginRoot(): string {
	if (shared !== null) return shared;
	const copy = verifiedCopy();
	shared = copy;
	afterAll(() => {
		rmSync(copy, { recursive: true, force: true });
		shared = null;
	});
	return copy;
}

export interface Envelope {
	result: { commandIdentity: string; outcome: string; causeCode: string; exitCode: number; repairAction: string | null; transactionState: string; data: Record<string, any> | null; effects: { completed: string[]; uncertain: string[] } };
}

export class FigmaMachine {
	readonly root = mkdtempSync(path.join(os.tmpdir(), "connectors-figma-machine-"));
	readonly home = path.join(this.root, "home");
	readonly state = path.join(this.home, ".local", "state");
	readonly hostileBin = path.join(this.root, "hostile-bin");
	readonly skillsRoot: string;
	private readonly binary: string;

	constructor(stubUrl: string) {
		const plugin = pluginRoot();
		// Each machine mounts its own skills directory beside its own binary
		// copy, so its registry can name this machine's stub port.
		const bundle = path.join(this.root, "plugin");
		cpSync(plugin, bundle, { recursive: true, verbatimSymlinks: true });
		this.binary = path.join(bundle, "bin", "connectors");
		this.skillsRoot = path.join(bundle, "skills");
		const registry = path.join(this.skillsRoot, "figma", "config", "mcporter.json");
		writeFileSync(registry, readFileSync(registry, "utf8").replace(STUB_PLACEHOLDER, stubUrl));
		writeFileSync(path.join(this.root, "figma-endpoint"), stubUrl);
		mkdirSync(this.state, { recursive: true, mode: 0o700 });
		mkdirSync(this.hostileBin, { recursive: true });
		writeFileSync(path.join(this.hostileBin, "mcporter"), fakeLauncher(HOSTILE), { mode: 0o700 });
	}

	async run(argv: string[]): Promise<{ code: number; envelope: Envelope; stdout: string; stderr: string }> {
		const env = { HOME: this.home, PATH: `${this.hostileBin}:/usr/bin:/bin`, TMPDIR: this.root, XDG_STATE_HOME: this.state, CONNECTORS_TEST_RELEASE_DIR: OFFICIAL_MCPORTER ?? path.join(this.root, "no-release-fixture"), FIGMA_ACCESS_TOKEN: "SENTINEL_AMBIENT_FIGMA_TOKEN" };
		const proc = Bun.spawn(["/usr/bin/sandbox-exec", "-p", LOOPBACK_ONLY, this.binary, ...argv], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		let envelope: Envelope;
		try {
			envelope = JSON.parse(stdout) as Envelope;
		} catch {
			throw new Error(`no envelope (exit ${code}): ${stdout.slice(0, 400)} ${stderr.slice(0, 400)}`);
		}
		return { code, envelope, stdout, stderr };
	}

	// Every invocation of the hostile PATH mcporter; the front door must use none.
	hostileCalls(): unknown[] {
		const file = path.join(this.root, "hostile-mcporter.jsonl");
		return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
	}

	// Writes named files into this machine's asset directory and returns it.
	assets(files: Record<string, string>): string {
		const directory = path.join(this.root, "assets");
		mkdirSync(directory, { recursive: true });
		for (const [name, content] of Object.entries(files)) writeFileSync(path.join(directory, name), content);
		return directory;
	}

	// Every regular file under this machine's Connectors state, as text.
	stateText(): string {
		const root = path.join(this.state, "connectors");
		if (!existsSync(root)) return "";
		return (readdirSync(root, { recursive: true }) as string[]).map((relative) => path.join(root, relative)).filter((file) => lstatSync(file).isFile() && lstatSync(file).size < 8 * 1024 * 1024).map((file) => readFileSync(file, "utf8")).join("\n");
	}

	journalDirectory(): string {
		return path.join(this.state, "connectors", "figma", "journal");
	}

	dispose(): void {
		rmSync(this.root, { recursive: true, force: true });
	}
}
