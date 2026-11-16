// DOTF-10: the Connectors front door in the Linux agents pilot (ADR 0009).
// Each test names the behavior it protects and one wrong behavior that
// fails it:
// - platform tools: Linux declares MCPorter alone. Fails if the pilot offered
//   a macOS op, mise, or uv repair.
// - staged MCPorter: selection accepts only the exact staged layout, launcher
//   text, private modes, and reported version. Fails if a tampered launcher,
//   a writable copy, or another version were selected.
// - lockfile: the committed lockfile pins mcporter to the official release
//   integrity. Fails if the lock drifted from the release bytes.
// - receiver read: a key passes only from a private receiver directory, a
//   live socket, and an answer naming the registered item. Fails if an
//   absent lease, a foreign item, a loose directory, or a malformed answer
//   produced a key.
// - packaged (Linux only): the pilot build lists exactly the admitted
//   connectors, reports its staged MCPorter ready, refuses macOS setup, and
//   passes `auth check` only while a receiver holds the registered item.
//   Fails if an excluded connector shipped or custody read anything else.
// The receiver value is a sentinel; no test reaches 1Password, a Provider
// account, or a hosted endpoint.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readDeliveredItem, receiverHost, receiverSocket, type ReceiverRun } from "../bin/delivered-credential.ts";
import { platformDependencyTools } from "../bin/dependency-status.ts";
import { launcherText, PACKAGED_MCPORTER, PACKAGED_MCPORTER_DIR, releaseRecord, selectPackagedMcporter } from "../bin/mcporter-packaged.ts";
import { MCPORTER_RELEASE } from "../bin/mcporter-release.ts";
import { lockedIntegrity } from "../pilot/build.ts";

// Independent oracles, restated rather than imported.
const RELEASE_INTEGRITY = "sha512-R60nKyUcW65WawhVjoESC0HeNibsf+1iqpX0wHPX9P60AFX/DYCBlhS7pDYcuWzeGYqYfZG2Xf5jWWkM74d/+A==";
const ADMITTED = ["context7", "firecrawl", "jev", "mermaid", "notion"];
const ITEM = "abcdefghijklmnopqrstuvwxyz";
const OTHER_ITEM = "zyxwvutsrqponmlkjihgfedcba";
const SENTINEL = "linux-pilot-sentinel-key-7d1f";
const NODE = "/opt/node/bin/node";
const onLinux = process.platform === "linux";

// A short root: a macOS temp folder would push the receiver socket path past
// the 104-byte Unix socket limit.
const scratch = mkdtempSync("/tmp/cxlp-");
chmodSync(scratch, 0o700);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function fresh(name: string): string {
	const directory = path.join(scratch, name);
	mkdirSync(directory, { mode: 0o700 });
	chmodSync(directory, 0o700);
	return directory;
}

test("platform tools: Linux declares MCPorter alone, macOS keeps all four", () => {
	expect(platformDependencyTools("linux")).toEqual(["mcporter"]);
	expect(platformDependencyTools("darwin")).toEqual(["mcporter", "op", "mise", "uv"]);
});

test("version: every MCPorter pin names the same release", () => {
	const root = path.join(import.meta.dir, "..");
	const requirements = JSON.parse(readFileSync(path.join(root, "requirements.json"), "utf8")) as { pins: { mcporter: string } };
	const linuxPackage = JSON.parse(readFileSync(path.join(root, "config", "mcporter-linux", "package.json"), "utf8")) as { dependencies: { mcporter: string } };
	expect([MCPORTER_RELEASE.version, PACKAGED_MCPORTER.version, linuxPackage.dependencies.mcporter]).toEqual([requirements.pins.mcporter, requirements.pins.mcporter, requirements.pins.mcporter]);
});

test("lockfile: the committed lock pins mcporter to the official release integrity", () => {
	const lock = readFileSync(path.join(import.meta.dir, "..", "config", "mcporter-linux", "bun.lock"), "utf8");
	expect(lockedIntegrity(lock)).toBe(RELEASE_INTEGRITY);
	expect(lockedIntegrity(lock.replace(RELEASE_INTEGRITY, "sha512-AAAA"))).toBe("sha512-AAAA");
});

function stagedPlugin(name: string): { root: string; vendor: string } {
	const root = fresh(name);
	const vendor = path.join(root, PACKAGED_MCPORTER_DIR);
	mkdirSync(path.join(vendor, "node_modules", "mcporter"), { recursive: true, mode: 0o755 });
	chmodSync(path.join(root, "vendor"), 0o755);
	chmodSync(vendor, 0o755);
	writeFileSync(path.join(vendor, "release.json"), releaseRecord(NODE), { mode: 0o644 });
	writeFileSync(path.join(vendor, "mcporter"), launcherText(NODE), { mode: 0o755 });
	writeFileSync(path.join(vendor, "node_modules", "mcporter", "package.json"), JSON.stringify({ version: "0.14.0" }), { mode: 0o644 });
	return { root, vendor };
}

test("staged MCPorter: only the exact staged layout and version are selected", () => {
	const reports = (stdout: string) => () => ({ exitCode: 0, stdout });
	const { root, vendor } = stagedPlugin("staged-ok");
	expect(selectPackagedMcporter(root, reports("0.14.0"))).toEqual({ ok: true, binary: path.join(vendor, "mcporter") });
	expect(selectPackagedMcporter(root, reports("0.13.0"))).toEqual({ ok: false, cause: "version-invalid" });
	expect(selectPackagedMcporter(fresh("staged-missing"), reports("0.14.0"))).toEqual({ ok: false, cause: "packaged-mcporter-missing" });

	const tampered = stagedPlugin("staged-tampered");
	writeFileSync(path.join(tampered.vendor, "mcporter"), `${launcherText(NODE)}curl example.invalid\n`);
	expect(selectPackagedMcporter(tampered.root, reports("0.14.0"))).toEqual({ ok: false, cause: "packaged-mcporter-invalid" });

	const writable = stagedPlugin("staged-writable");
	chmodSync(path.join(writable.vendor, "mcporter"), 0o775);
	expect(selectPackagedMcporter(writable.root, reports("0.14.0"))).toEqual({ ok: false, cause: "packaged-mcporter-invalid" });

	const otherNode = stagedPlugin("staged-other-node");
	writeFileSync(path.join(otherNode.vendor, "release.json"), releaseRecord("/usr/bin/node"));
	expect(selectPackagedMcporter(otherNode.root, reports("0.14.0"))).toEqual({ ok: false, cause: "packaged-mcporter-invalid" });

	const otherVersion = stagedPlugin("staged-other-version");
	writeFileSync(path.join(otherVersion.vendor, "node_modules", "mcporter", "package.json"), JSON.stringify({ version: "0.17.1" }));
	expect(selectPackagedMcporter(otherVersion.root, reports("0.14.0"))).toEqual({ ok: false, cause: "packaged-mcporter-invalid" });
});

// A receiver directory with a real listening socket, so the socket check is
// the production one; the answer comes from the injected run.
function receiverHome(name: string): { home: string; close: () => void } {
	const home = fresh(name);
	const socket = receiverSocket(home, "context7");
	mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });
	chmodSync(path.dirname(socket), 0o700);
	const listener = Bun.listen({ unix: socket, socket: { data() {} } });
	return { home, close: () => listener.stop(true) };
}

test("receiver read: a key passes only from a private receiver naming the registered item", () => {
	const answers = (stdout: string, status = 0): ReceiverRun => () => ({ status, stdout });
	const seen: string[] = [];
	const recording: ReceiverRun = (argv, input, env) => {
		seen.push(JSON.stringify({ argv: argv.slice(1, 3), input, env: Object.keys(env).sort() }));
		return { status: 0, stdout: `username=${ITEM}\npassword=${SENTINEL}\n` };
	};
	const absent = fresh("receiver-absent");
	expect(readDeliveredItem("context7", ITEM, { HOME: absent }, recording)).toEqual({ ok: false, cause: "credential-not-delivered" });
	expect(seen).toEqual([]);

	const { home, close } = receiverHome("receiver-live");
	try {
		expect(readDeliveredItem("context7", ITEM, { HOME: home }, recording)).toEqual({ ok: true, item: { id: ITEM, fields: [{ label: "credential", value: SENTINEL }] } });
		expect(seen).toEqual([JSON.stringify({ argv: ["credential-cache", "--socket"], input: `protocol=https\nhost=${receiverHost("context7")}\nusername=${ITEM}\n\n`, env: ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "HOME", "PATH"] })]);
		expect(readDeliveredItem("context7", ITEM, { HOME: home }, answers(""))).toEqual({ ok: false, cause: "credential-not-delivered" });
		expect(readDeliveredItem("context7", ITEM, { HOME: home }, answers(`username=${OTHER_ITEM}\npassword=${SENTINEL}\n`))).toEqual({ ok: false, cause: "credential-invalid" });
		expect(readDeliveredItem("context7", ITEM, { HOME: home }, answers(`username=${ITEM}\npassword=${SENTINEL}\npassword_expiry_utc=2000000000\ncapability[]=authtype\n`))).toEqual({ ok: true, item: { id: ITEM, fields: [{ label: "credential", value: SENTINEL }] } });
		expect(readDeliveredItem("context7", ITEM, { HOME: home }, answers(`username=${ITEM}\npassword=${SENTINEL}\npassword=other\n`))).toEqual({ ok: false, cause: "credential-invalid" });
		expect(readDeliveredItem("context7", ITEM, { HOME: home }, answers(`password=${SENTINEL}\n`))).toEqual({ ok: false, cause: "credential-invalid" });
		expect(readDeliveredItem("context7", ITEM, { HOME: home }, answers(`username=${ITEM}\nnot-an-attribute\npassword=${SENTINEL}\n`))).toEqual({ ok: false, cause: "credential-invalid" });
		expect(readDeliveredItem("context7", ITEM, { HOME: home }, answers(`username=${ITEM}\npassword=\n`))).toEqual({ ok: false, cause: "credential-invalid" });
		expect(readDeliveredItem("context7", ITEM, { HOME: home }, answers("", 128))).toEqual({ ok: false, cause: "receiver-invalid" });
		expect(readDeliveredItem("context7", "not-an-item", { HOME: home }, recording)).toEqual({ ok: false, cause: "receiver-invalid" });
		chmodSync(path.dirname(receiverSocket(home, "context7")), 0o755);
		expect(readDeliveredItem("context7", ITEM, { HOME: home }, recording)).toEqual({ ok: false, cause: "receiver-invalid" });
	} finally {
		close();
	}
});

// The real git credential-cache receiver, as the operator's sender fills it.
const GIT_ENV = (home: string) => ({ HOME: home, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });

function deliver(home: string, item: string, connector = "context7"): void {
	const directory = path.dirname(receiverSocket(home, connector));
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	const store = Bun.spawnSync(["/usr/bin/git", "credential-cache", "--timeout", "120", "--socket", receiverSocket(home, connector), "store"], {
		stdin: Buffer.from(`protocol=https\nhost=${receiverHost(connector)}\nusername=${item}\npassword=${SENTINEL}\n\n`),
		env: GIT_ENV(home),
	});
	if (store.exitCode !== 0) throw new Error("credential-cache store failed");
}

function revoke(home: string, connector = "context7"): void {
	Bun.spawnSync(["/usr/bin/git", "credential-cache", "--socket", receiverSocket(home, connector), "exit"], { env: GIT_ENV(home) });
}

test.skipIf(!onLinux)("receiver read: the real git credential-cache receiver answers only for the registered item", () => {
	const home = fresh("receiver-git");
	expect(readDeliveredItem("context7", ITEM, { HOME: home })).toEqual({ ok: false, cause: "credential-not-delivered" });
	deliver(home, ITEM);
	try {
		expect(readDeliveredItem("context7", ITEM, { HOME: home })).toEqual({ ok: true, item: { id: ITEM, fields: [{ label: "credential", value: SENTINEL }] } });
		expect(readDeliveredItem("context7", OTHER_ITEM, { HOME: home })).toEqual({ ok: false, cause: "credential-not-delivered" });
	} finally {
		revoke(home);
	}
	expect(readDeliveredItem("context7", ITEM, { HOME: home })).toEqual({ ok: false, cause: "credential-not-delivered" });
});

interface Envelope {
	result: { causeCode: string; repairAction: string | null; nextAction: string; data: Record<string, unknown> | null };
}

test.skipIf(!onLinux || process.arch !== "arm64")(
	"packaged: the pilot build ships the admitted connectors with staged MCPorter and receiver custody",
	() => {
		const out = path.join(fresh("build"), "marketplace");
		const build = Bun.spawnSync([process.execPath, "run", path.join(import.meta.dir, "..", "pilot", "build.ts"), "--out", out], { stdout: "pipe", stderr: "pipe" });
		expect(build.stderr.toString()).toBe("");
		expect(build.exitCode).toBe(0);
		const home = fresh("packaged-home");
		const connectors = path.join(out, "connectors", "bin", "connectors");
		const run = (...argv: string[]): Envelope => {
			const proc = Bun.spawnSync([connectors, ...argv], { cwd: "/", env: { HOME: home, XDG_STATE_HOME: path.join(home, "state"), PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
			const stdout = proc.stdout.toString();
			expect(`${stdout}${proc.stderr.toString()}`).not.toContain(SENTINEL);
			return JSON.parse(stdout) as Envelope;
		};
		expect((run("list").result.data?.connectors as { id: string }[]).map((entry) => entry.id).sort()).toEqual(ADMITTED);
		const deps = run("deps", "status").result.data?.dependencies as { tool: string; ready: boolean; selected: { executable: string } }[];
		expect(deps.map((row) => [row.tool, row.ready, row.selected.executable])).toEqual([["mcporter", true, "vendor/mcporter/mcporter"]]);
		const evidence = (run("status", "context7").result.data?.connectors as { evidence: Record<string, { verdict: string; custody?: { mode: string } }> }[])[0]!.evidence;
		expect(evidence.localReady!.verdict).toBe("proven");
		const setup = run("setup").result;
		expect(setup.causeCode).toBe("DOMAIN_SETUP_FAILED_UNCHANGED");
		expect(setup.repairAction).toContain("Nothing to set up on Linux");
		expect(setup.nextAction).toBe("connectors.deps.status");
		expect(run("auth", "configure", "context7", "--input", JSON.stringify({ item: ITEM })).result.causeCode).toBe("SUCCESS_RUN_RECORDED");
		const undelivered = run("auth", "check", "context7").result;
		expect([undelivered.causeCode, undelivered.data?.connectorCause]).toEqual(["DOMAIN_ADAPTER_REFUSED", "credential-not-delivered"]);
		const custody = (run("status", "context7").result.data?.connectors as { evidence: Record<string, { custody?: { mode: string } }> }[])[0]!.evidence.custodyChecked!.custody;
		expect(custody?.mode).toBe("delivered-receiver-below-mcporter");
		deliver(home, OTHER_ITEM);
		try {
			expect(run("auth", "check", "context7").result.data?.connectorCause).toBe("credential-not-delivered");
			deliver(home, ITEM);
			const checked = run("auth", "check", "context7").result;
			expect([checked.causeCode, checked.data?.custodyChecked]).toEqual(["SUCCESS_UNCHANGED", true]);
		} finally {
			revoke(home);
		}
		// Mermaid's own Provider reads its own receiver, never Context7's.
		expect(run("auth", "configure", "mermaid", "--input", JSON.stringify({ item: ITEM })).result.causeCode).toBe("SUCCESS_RUN_RECORDED");
		deliver(home, ITEM);
		try {
			expect(run("auth", "check", "mermaid").result.data?.connectorCause).toBe("credential-not-delivered");
			deliver(home, ITEM, "mermaid");
			try {
				expect(run("auth", "check", "mermaid").result.causeCode).toBe("SUCCESS_UNCHANGED");
			} finally {
				revoke(home, "mermaid");
			}
		} finally {
			revoke(home);
		}
	},
	120_000,
);
