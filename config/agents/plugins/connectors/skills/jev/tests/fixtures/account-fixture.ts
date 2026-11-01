// One temp machine for JEV account-tier process tests, run from a
// private copy of the whole plugin that differs from source in exactly four
// declared places: the shared Keychain reader holds the one test-owned reader
// fake (owned by the Atlassian fixtures), the JEV endpoint leaf holds
// endpoint-fake.ts, requirements.json names the fake op launcher's digest as
// the qualified op, and bin/connectors is compiled from that copy. Every
// process (front door, Provider preflight, Provider) therefore runs the
// copy's leaves. The fake op and the Keychain fake are Atlassian's, reused
// unchanged. Every process runs under a sandbox that allows loopback only and
// denies the real Keychain tool. Evidence is substituted-source packaged
// process proof, never shipped-binary, live-Keychain, or hosted proof.
import { afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ownedDirectory } from "../../../../bin/private-state.ts";
import { compileFrontDoor } from "../../../../tests/compile-front-door.ts";
import { changedPaths, FAKE_OP_LAUNCHER, fakeLauncher, KEYCHAIN_LEAF, REQUIREMENTS, SHIPPED_ROOT } from "../../../atlassian/tests/fixtures/plugin-copy.ts";

export const OFFICIAL_MCPORTER = process.env.CONNECTORS_OFFICIAL_RELEASE_FIXTURE;
export const SERVICE_TOKEN = "ops_fixture-jev-service-account-sentinel";
export const PROVIDER_TOKEN = "fixture-jev-api-token-sentinel";
// A test-owned 26-character item ID.
export const ITEM_ID = "jevfixtureitem000000000001";
const ENDPOINT_LEAF = path.join("skills", "jev", "scripts", "endpoint.ts");
const FAKE_ENDPOINT = path.join(import.meta.dir, "endpoint-fake.ts");
const ATLASSIAN_FIXTURES = path.resolve(import.meta.dir, "..", "..", "..", "atlassian", "tests", "fixtures");
const FAKE_READER = path.join(ATLASSIAN_FIXTURES, "keychain-read-fake.ts");
const LOOPBACK_ONLY =
	'(version 1)(allow default)(deny network-outbound (remote ip))(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))(allow network-outbound (remote ip "localhost:*"))(deny process-exec (literal "/usr/bin/security"))';
// Files that hold a sentinel by design.
const SECRET_HOLDERS = new Set(["expected-service-token", "expected-provider-token", "keychain-token", "items", "private-input.json"]);
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

function fixtureRequirements(): string {
	const manifest = JSON.parse(readFileSync(path.join(SHIPPED_ROOT, REQUIREMENTS), "utf8")) as { sources: { op: Record<string, unknown> } };
	manifest.sources.op.binarySha256 = sha256(FAKE_OP_LAUNCHER);
	return `${JSON.stringify(manifest, null, "\t")}\n`;
}

// Fail closed: the copy must differ from source by exactly its declared shape.
function verifiedCopy(): string {
	const copy = mkdtempSync(path.join(os.tmpdir(), "connectors-jev-account-plugin-"));
	chmodSync(copy, 0o700);
	cpSync(SHIPPED_ROOT, copy, { recursive: true, verbatimSymlinks: true });
	writeFileSync(path.join(copy, KEYCHAIN_LEAF), readFileSync(FAKE_READER));
	writeFileSync(path.join(copy, ENDPOINT_LEAF), readFileSync(FAKE_ENDPOINT));
	writeFileSync(path.join(copy, REQUIREMENTS), fixtureRequirements());
	compileFrontDoor(path.join(copy, "bin", "connectors.ts"), path.join(copy, "bin", "connectors"));
	const expected = [path.join("bin", "connectors"), REQUIREMENTS, KEYCHAIN_LEAF, ENDPOINT_LEAF].sort();
	const changed = changedPaths(SHIPPED_ROOT, copy);
	if (JSON.stringify(changed) !== JSON.stringify(expected))
		throw new Error(`JEV plugin copy changes ${JSON.stringify(changed)}, expected ${JSON.stringify(expected)}`);
	if (readFileSync(path.join(SHIPPED_ROOT, ENDPOINT_LEAF), "utf8").includes("connectors-test-jev-endpoint-fake"))
		throw new Error("the shipped endpoint leaf carries the test marker");
	return copy;
}

let shared: string | null = null;
// One verified copy per test file, removed when that file's tests finish.
function accountPluginRoot(): string {
	if (shared !== null) return shared;
	const copy = verifiedCopy();
	shared = copy;
	afterAll(() => {
		rmSync(copy, { recursive: true, force: true });
		shared = null;
	});
	return copy;
}

// An owner-only executable launcher, in a directory created as needed.
function launcher(file: string, content: string): void {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content, { mode: 0o700 });
}

export interface Envelope {
	result: {
		commandIdentity: string;
		outcome: string;
		causeCode: string;
		exitCode: number;
		repairAction: string | null;
		transactionState: string;
		data: Record<string, unknown> | null;
		effects: { completed: string[]; uncertain: string[] };
	};
}

export class JevMachine {
	readonly root = mkdtempSync(path.join(os.tmpdir(), "connectors-jev-account-"));
	readonly home = path.join(this.root, "home");
	readonly state = path.join(this.home, ".local", "state");
	readonly hostileBin = path.join(this.root, "hostile-bin");
	readonly pluginRoot: string;

	constructor(endpoint: string) {
		this.pluginRoot = accountPluginRoot();
		mkdirSync(path.join(this.home, "Library", "Keychains"), {
			recursive: true,
		});
		if (!ownedDirectory(path.join(this.state, "connectors")).ok) throw new Error("the fixture state root could not be made private");
		// The fakes' expected values and the stub's URL, beside HOME.
		for (const [name, value] of [
			["jev-endpoint", endpoint],
			["expected-service-token", SERVICE_TOKEN],
			["expected-provider-token", PROVIDER_TOKEN],
		] as const)
			writeFileSync(path.join(this.root, name), value);
		const hostile = {
			mcporter: "hostile-mcporter.ts",
			bun: "hostile-recorder.ts",
			node: "hostile-recorder.ts",
			op: "hostile-recorder.ts",
			uv: "hostile-recorder.ts",
			uvx: "hostile-recorder.ts",
		};
		for (const [name, fake] of Object.entries(hostile)) launcher(path.join(this.hostileBin, name), fakeLauncher(path.join(ATLASSIAN_FIXTURES, fake)));
	}

	// The service token in the fake Keychain, the fake op where setup
	// publishes it, and the one item carrying the provider token.
	installCustody(): this {
		writeFileSync(
			path.join(this.root, "keychain-item.json"),
			JSON.stringify({
				keychain: path.join(this.home, "Library", "Keychains", "login.keychain-db"),
				service: "connectors.1password.service-account",
				account: "connectors",
			}),
		);
		writeFileSync(path.join(this.root, "keychain-token"), SERVICE_TOKEN, {
			mode: 0o600,
		});
		const manifest = JSON.parse(readFileSync(path.join(this.pluginRoot, REQUIREMENTS), "utf8")) as {
			pins: { op: string };
			sources: { op: { binarySha256: string } };
		};
		const name = `op-${manifest.pins.op}-${manifest.sources.op.binarySha256}`;
		const opDirectory = path.join(this.state, "connectors", "setup", "op");
		if (!ownedDirectory(opDirectory).ok) throw new Error("the fixture op directory could not be made private");
		launcher(path.join(opDirectory, name), FAKE_OP_LAUNCHER);
		writeFileSync(path.join(opDirectory, "op-selected"), name, { mode: 0o600 });
		mkdirSync(path.join(this.root, "items"), { recursive: true });
		writeFileSync(
			path.join(this.root, "items", `${ITEM_ID}.json`),
			JSON.stringify({
				id: ITEM_ID,
				version: 1,
				fields: [{ id: "credential", label: "credential", value: PROVIDER_TOKEN }],
			}),
		);
		return this;
	}

	lines<T = Record<string, unknown>>(name: string): T[] {
		const file = path.join(this.root, name);
		return existsSync(file)
			? readFileSync(file, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as T)
			: [];
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

	start(argv: string[]) {
		const env = {
			HOME: this.home,
			PATH: `${this.hostileBin}:/usr/bin:/bin`,
			TMPDIR: this.root,
			XDG_STATE_HOME: this.state,
			CONNECTORS_TEST_RELEASE_DIR: OFFICIAL_MCPORTER ?? path.join(this.root, "no-release-fixture"),
			TYPESAFE_API_KEY: "SENTINEL_AMBIENT_TYPESAFE_TOKEN",
			TYPESAFE_BASE_URL: "https://evil.invalid",
			TYPESAFE_LOG_LEVEL: "debug",
		};
		return Bun.spawn(["/usr/bin/sandbox-exec", "-p", LOOPBACK_ONLY, path.join(this.pluginRoot, "bin", "connectors"), ...argv], {
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
	}

	async run(argv: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
		const proc = this.start(argv);
        if (input !== undefined) proc.stdin.write(input);
        proc.stdin.end();
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { code, stdout, stderr };
	}

	dispose(): void {
		rmSync(this.root, { recursive: true, force: true });
	}
}
