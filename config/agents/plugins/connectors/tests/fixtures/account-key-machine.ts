// One temp machine for the Context7 and Firecrawl account-key process tests,
// run from a private copy of the whole plugin that differs from source in
// exactly its declared places: for each of the two connectors, the Keychain
// leaf holds the test-owned reader fake (owned by the Atlassian fixtures),
// the endpoint leaf names that connector's loopback stub, and the keyless
// registry entry's baseUrl names the same stub; requirements.json names the
// fake op launcher's digest as the qualified op; and bin/connectors is
// compiled from that copy. Every process (front door, Provider preflight,
// Provider) therefore runs the copy's leaves, under a sandbox that allows
// loopback only and denies the real Keychain tool, with a hostile mcporter,
// bun, node, op, uv, and uvx first on PATH. Evidence is substituted-source
// packaged process proof, never shipped-binary, live-Keychain, installed, or
// hosted proof.
import { afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { changedPaths, FAKE_OP_LAUNCHER, fakeLauncher, REQUIREMENTS, SHIPPED_ROOT } from "../../skills/atlassian/tests/fixtures/plugin-copy.ts";
import { ownedDirectory } from "../../bin/private-state.ts";
import { compileFrontDoor } from "../compile-front-door.ts";
import { type AccountKeyStub, startAccountKeyStub } from "./account-key-stub.ts";

export const OFFICIAL_MCPORTER = process.env.CONNECTORS_OFFICIAL_RELEASE_FIXTURE;
export const SERVICE_TOKEN = "ops_fixture-account-key-service-account-sentinel";
const ATLASSIAN_FIXTURES = path.resolve(import.meta.dir, "..", "..", "skills", "atlassian", "tests", "fixtures");
const FAKE_READER = path.join(ATLASSIAN_FIXTURES, "keychain-read-fake.ts");
const ENDPOINT_MARKER = "connectors-test-account-key-endpoint-fake";
const LOOPBACK_ONLY = '(version 1)(allow default)(deny network-outbound (remote ip))(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))(allow network-outbound (remote ip "localhost:*"))(deny process-exec (literal "/usr/bin/security"))';
// Files that hold a sentinel by design.
const SECRET_HOLDERS = new Set(["expected-service-token", "expected-provider-token", "keychain-token", "items"]);
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

export interface ConnectorFixture {
	readonly id: "context7" | "firecrawl";
	readonly tools: [string, string];
	readonly key: string;
	readonly item: string;
}

const leaf = (id: string, name: string) => path.join("skills", id, "scripts", name);
const registryPath = (id: string) => path.join("skills", id, "config", "mcporter.json");

function substitute(copy: string, connector: ConnectorFixture, url: string): void {
	writeFileSync(path.join(copy, leaf(connector.id, "keychain-read.ts")), readFileSync(FAKE_READER));
	writeFileSync(path.join(copy, leaf(connector.id, "endpoint.ts")), `// ${ENDPOINT_MARKER}\nexport const ACCOUNT_ENDPOINT = ${JSON.stringify(url)};\n`);
	const registry = JSON.parse(readFileSync(path.join(copy, registryPath(connector.id)), "utf8")) as { mcpServers: Record<string, { baseUrl?: string }> };
	const keyless = registry.mcpServers[connector.id];
	if (!keyless) throw new Error(`the ${connector.id} registry has no keyless entry`);
	keyless.baseUrl = url;
	writeFileSync(path.join(copy, registryPath(connector.id)), `${JSON.stringify(registry, null, "\t")}\n`);
}

function fixtureRequirements(): string {
	const manifest = JSON.parse(readFileSync(path.join(SHIPPED_ROOT, REQUIREMENTS), "utf8")) as { sources: { op: Record<string, unknown> } };
	manifest.sources.op.binarySha256 = sha256(FAKE_OP_LAUNCHER);
	return `${JSON.stringify(manifest, null, "\t")}\n`;
}

// Fail closed: the copy must differ from source by exactly its declared shape.
function verifiedCopy(connectors: readonly ConnectorFixture[], stubs: ReadonlyMap<string, AccountKeyStub>): string {
	const copy = mkdtempSync(path.join(os.tmpdir(), "connectors-account-key-plugin-"));
	chmodSync(copy, 0o700);
	cpSync(SHIPPED_ROOT, copy, { recursive: true, verbatimSymlinks: true });
	for (const connector of connectors) substitute(copy, connector, stubs.get(connector.id)?.url ?? "");
	writeFileSync(path.join(copy, REQUIREMENTS), fixtureRequirements());
	compileFrontDoor(path.join(copy, "bin", "connectors.ts"), path.join(copy, "bin", "connectors"));
	const expected = [path.join("bin", "connectors"), REQUIREMENTS, ...connectors.flatMap(({ id }) => [leaf(id, "keychain-read.ts"), leaf(id, "endpoint.ts"), registryPath(id)])].sort();
	const changed = changedPaths(SHIPPED_ROOT, copy);
	if (JSON.stringify(changed) !== JSON.stringify(expected)) throw new Error(`account-key plugin copy changes ${JSON.stringify(changed)}, expected ${JSON.stringify(expected)}`);
	for (const { id } of connectors) if (readFileSync(path.join(SHIPPED_ROOT, leaf(id, "endpoint.ts")), "utf8").includes(ENDPOINT_MARKER)) throw new Error(`the shipped ${id} endpoint leaf carries the test marker`);
	return copy;
}

export interface Plugin {
	readonly root: string;
	readonly stubs: ReadonlyMap<string, AccountKeyStub>;
}

// One verified copy and one stub per connector for the calling test file,
// removed when that file's tests finish.
export function accountKeyPlugin(connectors: readonly ConnectorFixture[]): Plugin {
	const stubs = new Map(connectors.map((connector) => [connector.id, startAccountKeyStub(connector.tools, connector.key)] as const));
	const root = verifiedCopy(connectors, stubs);
	afterAll(() => {
		for (const stub of stubs.values()) stub.stop();
		rmSync(root, { recursive: true, force: true });
	});
	return { root, stubs };
}

function launcher(file: string, content: string): void {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content, { mode: 0o700 });
}

export interface Envelope {
	result: { commandIdentity: string; outcome: string; causeCode: string; exitCode: number; repairAction: string | null; data: Record<string, any> | null; effects: { completed: string[]; uncertain: string[] } };
}

export class AccountKeyMachine {
	readonly root = mkdtempSync(path.join(os.tmpdir(), "connectors-account-key-"));
	readonly home = path.join(this.root, "home");
	readonly state = path.join(this.home, ".local", "state");
	readonly hostileBin = path.join(this.root, "hostile-bin");

	constructor(
		readonly plugin: Plugin,
		readonly ambient: Readonly<Record<string, string>>,
	) {
		mkdirSync(path.join(this.home, "Library", "Keychains"), { recursive: true });
		if (!ownedDirectory(path.join(this.state, "connectors")).ok) throw new Error("the fixture state root could not be made private");
		writeFileSync(path.join(this.root, "expected-service-token"), SERVICE_TOKEN);
		const hostile = { mcporter: "hostile-mcporter.ts", bun: "hostile-recorder.ts", node: "hostile-recorder.ts", op: "hostile-recorder.ts", uv: "hostile-recorder.ts", uvx: "hostile-recorder.ts" };
		for (const [name, fake] of Object.entries(hostile)) launcher(path.join(this.hostileBin, name), fakeLauncher(path.join(ATLASSIAN_FIXTURES, fake)));
		// The service token in the fake Keychain and the fake op where setup
		// publishes it.
		writeFileSync(path.join(this.root, "keychain-item.json"), JSON.stringify({ keychain: path.join(this.home, "Library", "Keychains", "login.keychain-db"), service: "connectors.1password.service-account", account: "connectors" }));
		writeFileSync(path.join(this.root, "keychain-token"), SERVICE_TOKEN, { mode: 0o600 });
		const manifest = JSON.parse(readFileSync(path.join(plugin.root, REQUIREMENTS), "utf8")) as { pins: { op: string }; sources: { op: { binarySha256: string } } };
		const name = `op-${manifest.pins.op}-${manifest.sources.op.binarySha256}`;
		const opDirectory = path.join(this.state, "connectors", "setup", "op");
		if (!ownedDirectory(opDirectory).ok) throw new Error("the fixture op directory could not be made private");
		launcher(path.join(opDirectory, name), FAKE_OP_LAUNCHER);
		writeFileSync(path.join(opDirectory, "op-selected"), name, { mode: 0o600 });
		mkdirSync(path.join(this.root, "items"), { recursive: true });
		writeFileSync(path.join(this.root, "expected-provider-token"), "no-provider-token-expected");
	}

	// One 1Password item; credential null stores an item with no credential
	// field. The op fake's parent checks look for this key.
	storeItem(item: string, credential: string | null): void {
		const fields = credential === null ? [{ id: "notes", label: "notes", value: "no key here" }] : [{ id: "credential", label: "credential", value: credential }];
		writeFileSync(path.join(this.root, "items", `${item}.json`), JSON.stringify({ id: item, version: 1, fields }));
		if (credential !== null) writeFileSync(path.join(this.root, "expected-provider-token"), credential);
	}

	registrationFile(id: string): string {
		return path.join(this.state, "connectors", id, "registration.json");
	}

	lines<T = Record<string, unknown>>(name: string): T[] {
		const file = path.join(this.root, name);
		return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as T) : [];
	}

	// Every file under the machine root except the declared secret holders
	// and files too large to be a log (the MCPorter binary).
	sweepText(): string {
		return (readdirSync(this.root, { recursive: true }) as string[])
			.filter((relative) => !SECRET_HOLDERS.has(relative.split(path.sep)[0] ?? ""))
			.map((relative) => path.join(this.root, relative))
			.filter((file) => lstatSync(file).isFile() && lstatSync(file).size < 8 * 1024 * 1024)
			.map((file) => readFileSync(file, "utf8"))
			.join("\n");
	}

	async run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
		const env = { HOME: this.home, PATH: `${this.hostileBin}:/usr/bin:/bin`, TMPDIR: this.root, XDG_STATE_HOME: this.state, CONNECTORS_TEST_RELEASE_DIR: OFFICIAL_MCPORTER ?? path.join(this.root, "no-release-fixture"), ...this.ambient };
		const proc = Bun.spawn(["/usr/bin/sandbox-exec", "-p", LOOPBACK_ONLY, path.join(this.plugin.root, "bin", "connectors"), ...argv], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { code, stdout, stderr };
	}

	dispose(): void {
		rmSync(this.root, { recursive: true, force: true });
	}
}
