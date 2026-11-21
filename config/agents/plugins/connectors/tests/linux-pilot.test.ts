// DOTF-10: the Connectors front door in the Linux agents pilot (ADR 0009).
// Each test names the behavior it protects and one wrong behavior that
// fails it:
// - platform tools: Linux declares MCPorter alone. Fails if the pilot offered
//   a macOS op, mise, or uv repair.
// - staged MCPorter: selection accepts only the exact staged layout, launcher
//   text, private modes, and reported version. Fails if a tampered launcher,
//   a writable copy, or another version were selected.
// - staged digests: selection runs nothing unless the Node binary and the
//   mcporter package still hold the bytes the build recorded. Fails if a
//   changed, swapped, or symlinked Node, or an edited, added, or symlinked
//   package file, were selected, or ran before the refusal.
// - lockfile: the committed lockfile pins mcporter to the official release
//   integrity. Fails if the lock drifted from the release bytes.
// - receiver read: a key passes only from a private receiver directory, a
//   live socket, and an answer naming the registered item. Fails if an
//   absent lease, a foreign item, a loose directory, or a malformed answer
//   produced a key.
// - receiver boundary: a receiver directory or socket that another user owns,
//   or that is a symlink, is refused before git runs. Fails if either were
//   asked for a key.
// - packaged (Linux only): the pilot build lists exactly the admitted
//   connectors, reports its staged MCPorter ready, refuses macOS setup, and
//   passes `auth check` only while a receiver holds the registered item,
//   with the contracted exit code and an empty stderr each time. It then
//   refuses its staged MCPorter once a package file or the Node binary
//   differs from the build's record. Fails if an excluded connector shipped,
//   custody read anything else, or changed bytes still reported ready.
// The receiver value is a sentinel; no test reaches 1Password, a Provider
// account, or a hosted endpoint.
import { afterAll, expect, test } from "bun:test";
import { appendFileSync, chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readDeliveredItem, type ReceiverInspect, receiverHost, receiverSocket, type ReceiverRun } from "../bin/delivered-credential.ts";
import { platformDependencyTools } from "../bin/dependency-status.ts";
import { launcherText, PACKAGED_MCPORTER, PACKAGED_MCPORTER_DIR, type PackagedFailure, releaseRecord, selectPackagedMcporter } from "../bin/mcporter-packaged.ts";
import { MCPORTER_RELEASE } from "../bin/mcporter-release.ts";
import { lockedIntegrity } from "../pilot/build.ts";

// Independent oracles, restated rather than imported.
const RELEASE_INTEGRITY = "sha512-R60nKyUcW65WawhVjoESC0HeNibsf+1iqpX0wHPX9P60AFX/DYCBlhS7pDYcuWzeGYqYfZG2Xf5jWWkM74d/+A==";
const ADMITTED = ["context7", "firecrawl", "jev", "mermaid", "notion"];
const ITEM = "abcdefghijklmnopqrstuvwxyz";
const OTHER_ITEM = "zyxwvutsrqponmlkjihgfedcba";
const SENTINEL = "linux-pilot-sentinel-key-7d1f";
// Fixture bytes and their digests, computed apart from the code under test
// with shasum -a 256. The package digest is the sha256 of
// "dist/cli.js\0<sha256>\npackage.json\0<sha256>\n".
const NODE_FIXTURE = "linux-pilot node fixture\n";
const NODE_FIXTURE_SHA256 = "1f83199b9d5ea822a78abc50f967aa3f3319a1c4147cb064ed8a56076ac0f5ea";
const CLI_FIXTURE = "linux-pilot mcporter cli fixture\n";
const PACKAGE_FIXTURE_SHA256 = "e5c748fab17a3ab091cc288712f67df7323c081b229a102a0c8ee823a12b505f";
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

// A staged plugin whose Node is a fixture file beside it, as the build
// records a Node outside the plugin copy.
function stagedPlugin(name: string): { root: string; vendor: string; node: string; packageRoot: string } {
	const root = fresh(name);
	const vendor = path.join(root, PACKAGED_MCPORTER_DIR);
	const packageRoot = path.join(vendor, "node_modules", "mcporter");
	const node = path.join(root, "node");
	mkdirSync(path.join(packageRoot, "dist"), { recursive: true, mode: 0o755 });
	chmodSync(path.join(root, "vendor"), 0o755);
	chmodSync(vendor, 0o755);
	writeFileSync(node, NODE_FIXTURE, { mode: 0o755 });
	writeFileSync(path.join(vendor, "release.json"), releaseRecord({ node, nodeSha256: NODE_FIXTURE_SHA256, mcporterSha256: PACKAGE_FIXTURE_SHA256 }), { mode: 0o644 });
	writeFileSync(path.join(vendor, "mcporter"), launcherText(node), { mode: 0o755 });
	writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version: "0.14.0" }), { mode: 0o644 });
	writeFileSync(path.join(packageRoot, "dist", "cli.js"), CLI_FIXTURE, { mode: 0o644 });
	return { root, vendor, node, packageRoot };
}

test("staged MCPorter: only the exact staged layout and version are selected", () => {
	const reports = (stdout: string) => () => ({ exitCode: 0, stdout });
	const { root, vendor } = stagedPlugin("staged-ok");
	expect(selectPackagedMcporter(root, reports("0.14.0"))).toEqual({ ok: true, binary: path.join(vendor, "mcporter") });
	expect(selectPackagedMcporter(root, reports("0.13.0"))).toEqual({ ok: false, cause: "version-invalid" });
	expect(selectPackagedMcporter(fresh("staged-missing"), reports("0.14.0"))).toEqual({ ok: false, cause: "packaged-mcporter-missing" });

	const tampered = stagedPlugin("staged-tampered");
	writeFileSync(path.join(tampered.vendor, "mcporter"), `${launcherText(tampered.node)}curl example.invalid\n`);
	expect(selectPackagedMcporter(tampered.root, reports("0.14.0"))).toEqual({ ok: false, cause: "packaged-mcporter-invalid" });

	const writable = stagedPlugin("staged-writable");
	chmodSync(path.join(writable.vendor, "mcporter"), 0o775);
	expect(selectPackagedMcporter(writable.root, reports("0.14.0"))).toEqual({ ok: false, cause: "packaged-mcporter-invalid" });

	const otherNode = stagedPlugin("staged-other-node");
	writeFileSync(path.join(otherNode.vendor, "release.json"), releaseRecord({ node: "/usr/bin/node", nodeSha256: NODE_FIXTURE_SHA256, mcporterSha256: PACKAGE_FIXTURE_SHA256 }));
	expect(selectPackagedMcporter(otherNode.root, reports("0.14.0"))).toEqual({ ok: false, cause: "packaged-mcporter-invalid" });

	const otherVersion = stagedPlugin("staged-other-version");
	writeFileSync(path.join(otherVersion.vendor, "node_modules", "mcporter", "package.json"), JSON.stringify({ version: "0.17.1" }));
	expect(selectPackagedMcporter(otherVersion.root, reports("0.14.0"))).toEqual({ ok: false, cause: "packaged-mcporter-invalid" });
});

test("staged digests: nothing runs unless Node and the mcporter package match the build's record", () => {
	let ran = 0;
	const counted = () => {
		ran += 1;
		return { exitCode: 0, stdout: "0.14.0" };
	};
	const refused = (root: string, cause: PackagedFailure) => {
		const before = ran;
		expect(selectPackagedMcporter(root, counted)).toEqual({ ok: false, cause });
		expect(ran).toBe(before);
	};
	const intact = stagedPlugin("digest-ok");
	expect(selectPackagedMcporter(intact.root, counted)).toEqual({ ok: true, binary: path.join(intact.vendor, "mcporter") });
	expect(ran).toBe(1);

	const changedNode = stagedPlugin("digest-node-changed");
	appendFileSync(changedNode.node, "x");
	refused(changedNode.root, "packaged-node-mismatch");

	// The same bytes behind a symlink are not the recorded binary.
	const linkedNode = stagedPlugin("digest-node-linked");
	writeFileSync(`${linkedNode.node}-real`, NODE_FIXTURE, { mode: 0o755 });
	rmSync(linkedNode.node);
	symlinkSync(`${linkedNode.node}-real`, linkedNode.node);
	refused(linkedNode.root, "packaged-node-mismatch");

	const missingNode = stagedPlugin("digest-node-missing");
	rmSync(missingNode.node);
	refused(missingNode.root, "packaged-node-mismatch");

	const editedCli = stagedPlugin("digest-cli-edited");
	writeFileSync(path.join(editedCli.packageRoot, "dist", "cli.js"), `${CLI_FIXTURE}process.exit(0)\n`);
	refused(editedCli.root, "packaged-mcporter-mismatch");

	const addedFile = stagedPlugin("digest-file-added");
	writeFileSync(path.join(addedFile.packageRoot, "dist", "extra.js"), "", { mode: 0o644 });
	refused(addedFile.root, "packaged-mcporter-mismatch");

	const linkedFile = stagedPlugin("digest-file-linked");
	writeFileSync(path.join(linkedFile.root, "cli-real.js"), CLI_FIXTURE, { mode: 0o644 });
	rmSync(path.join(linkedFile.packageRoot, "dist", "cli.js"));
	symlinkSync(path.join(linkedFile.root, "cli-real.js"), path.join(linkedFile.packageRoot, "dist", "cli.js"));
	refused(linkedFile.root, "packaged-mcporter-mismatch");

	// A record without well-formed digests, as a 0.9.1 build wrote, is not a record.
	const oldRecord = stagedPlugin("digest-record-old");
	writeFileSync(path.join(oldRecord.vendor, "release.json"), `${JSON.stringify({ version: "0.14.0", integrity: RELEASE_INTEGRITY, node: oldRecord.node })}\n`);
	refused(oldRecord.root, "packaged-mcporter-invalid");
	const looseRecord = stagedPlugin("digest-record-loose");
	writeFileSync(path.join(looseRecord.vendor, "release.json"), releaseRecord({ node: looseRecord.node, nodeSha256: NODE_FIXTURE_SHA256.toUpperCase(), mcporterSha256: PACKAGE_FIXTURE_SHA256 }));
	refused(looseRecord.root, "packaged-mcporter-invalid");
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

test("receiver boundary: a foreign-owned or symlinked receiver is refused before git runs", () => {
	let asked = 0;
	const answering: ReceiverRun = () => {
		asked += 1;
		return { status: 0, stdout: `username=${ITEM}\npassword=${SENTINEL}\n` };
	};
	// The fake boundary: the real lstat, with one path reported as another user's.
	const ownedByAnother = (target: string): ReceiverInspect => (inspected) => {
		const entry = lstatSync(inspected);
		if (inspected === target) entry.uid += 1;
		return entry;
	};
	const refused = (home: string, inspect?: ReceiverInspect) => {
		const before = asked;
		expect(readDeliveredItem("context7", ITEM, { HOME: home }, answering, inspect)).toEqual({ ok: false, cause: "receiver-invalid" });
		expect(asked).toBe(before);
	};

	const owned = receiverHome("boundary-owner");
	try {
		const socket = receiverSocket(owned.home, "context7");
		// The control: this receiver answers until one path changes owner.
		expect(readDeliveredItem("context7", ITEM, { HOME: owned.home }, answering).ok).toBe(true);
		expect(asked).toBe(1);
		refused(owned.home, ownedByAnother(path.dirname(socket)));
		refused(owned.home, ownedByAnother(socket));
	} finally {
		owned.close();
	}

	// A private directory holding a live socket, reached only through a symlink.
	const elsewhere = receiverHome("boundary-real");
	try {
		const real = path.dirname(receiverSocket(elsewhere.home, "context7"));
		const linkedDirectory = fresh("boundary-dir-link");
		const directory = path.dirname(receiverSocket(linkedDirectory, "context7"));
		mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
		symlinkSync(real, directory);
		refused(linkedDirectory);

		const linkedSocket = fresh("boundary-socket-link");
		const socket = receiverSocket(linkedSocket, "context7");
		mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });
		chmodSync(path.dirname(socket), 0o700);
		symlinkSync(path.join(real, "socket"), socket);
		refused(linkedSocket);
	} finally {
		elsewhere.close();
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
		// The build binds to a test-owned copy of this host's Node, so the test
		// can later change the bytes at the recorded path.
		const nodeDirectory = fresh("node");
		const node = path.join(nodeDirectory, "node");
		copyFileSync(realpathSync(Bun.which("node")!), node);
		chmodSync(node, 0o755);
		const build = Bun.spawnSync([process.execPath, "run", path.join(import.meta.dir, "..", "pilot", "build.ts"), "--out", out], { env: { ...process.env, PATH: `${nodeDirectory}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
		expect(build.stderr.toString()).toBe("");
		expect(build.exitCode).toBe(0);
		const home = fresh("packaged-home");
		const connectors = path.join(out, "connectors", "bin", "connectors");
		// Each call names the exit code its contract gives it; stderr stays empty.
		const run = (exitCode: number, ...argv: string[]): Envelope => {
			const proc = Bun.spawnSync([connectors, ...argv], { cwd: "/", env: { HOME: home, XDG_STATE_HOME: path.join(home, "state"), PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
			const stdout = proc.stdout.toString();
			const stderr = proc.stderr.toString();
			expect(`${stdout}${stderr}`).not.toContain(SENTINEL);
			expect([argv.join(" "), proc.exitCode, stderr]).toEqual([argv.join(" "), exitCode, ""]);
			return JSON.parse(stdout) as Envelope;
		};
		type DependencyRow = { tool: string; ready: boolean; cause: string | null; selected: { executable: string } | null; repair: { command: string } | null };
		const dependencies = (): DependencyRow[] => run(0, "deps", "status").result.data?.dependencies as DependencyRow[];
		expect((run(0, "list").result.data?.connectors as { id: string }[]).map((entry) => entry.id).sort()).toEqual(ADMITTED);
		expect(dependencies().map((row) => [row.tool, row.ready, row.selected?.executable])).toEqual([["mcporter", true, "vendor/mcporter/mcporter"]]);
		const evidence = (run(0, "status", "context7").result.data?.connectors as { evidence: Record<string, { verdict: string; custody?: { mode: string } }> }[])[0]!.evidence;
		expect(evidence.localReady!.verdict).toBe("proven");
		const setup = run(3, "setup").result;
		expect(setup.causeCode).toBe("DOMAIN_SETUP_FAILED_UNCHANGED");
		expect(setup.repairAction).toContain("Nothing to set up on Linux");
		expect(setup.nextAction).toBe("connectors.deps.status");
		expect(run(0, "auth", "configure", "context7", "--input", JSON.stringify({ item: ITEM })).result.causeCode).toBe("SUCCESS_RUN_RECORDED");
		const undelivered = run(3, "auth", "check", "context7").result;
		expect([undelivered.causeCode, undelivered.data?.connectorCause]).toEqual(["DOMAIN_ADAPTER_REFUSED", "credential-not-delivered"]);
		const custody = (run(0, "status", "context7").result.data?.connectors as { evidence: Record<string, { custody?: { mode: string } }> }[])[0]!.evidence.custodyChecked!.custody;
		expect(custody?.mode).toBe("delivered-receiver-below-mcporter");
		deliver(home, OTHER_ITEM);
		try {
			expect(run(3, "auth", "check", "context7").result.data?.connectorCause).toBe("credential-not-delivered");
			deliver(home, ITEM);
			const checked = run(0, "auth", "check", "context7").result;
			expect([checked.causeCode, checked.data?.custodyChecked]).toEqual(["SUCCESS_UNCHANGED", true]);
		} finally {
			revoke(home);
		}
		// Mermaid's own Provider reads its own receiver, never Context7's.
		expect(run(0, "auth", "configure", "mermaid", "--input", JSON.stringify({ item: ITEM })).result.causeCode).toBe("SUCCESS_RUN_RECORDED");
		deliver(home, ITEM);
		try {
			expect(run(3, "auth", "check", "mermaid").result.data?.connectorCause).toBe("credential-not-delivered");
			deliver(home, ITEM, "mermaid");
			try {
				expect(run(0, "auth", "check", "mermaid").result.causeCode).toBe("SUCCESS_UNCHANGED");
			} finally {
				revoke(home, "mermaid");
			}
		} finally {
			revoke(home);
		}
		// Bytes that differ from the build's record are refused, never repaired
		// in place: first one mcporter package file, then the Node binary.
		const refusal = (cause: string) => {
			expect(dependencies().map((row) => [row.tool, row.ready, row.cause, row.selected, row.repair?.command])).toEqual([["mcporter", false, cause, null, "bun run build:pilot"]]);
		};
		const cli = path.join(out, "connectors", "vendor", "mcporter", "node_modules", "mcporter", "dist", "cli.js");
		const original = readFileSync(cli);
		appendFileSync(cli, "\n");
		refusal("packaged-mcporter-mismatch");
		writeFileSync(cli, original);
		expect(dependencies().map((row) => row.ready)).toEqual([true]);
		// A different binary now sits at the recorded path, as an upgrade leaves it.
		copyFileSync(node, `${node}.next`);
		appendFileSync(`${node}.next`, "\0");
		renameSync(`${node}.next`, node);
		refusal("packaged-node-mismatch");
		// A read stops there too, before MCPorter or any hosted endpoint, and
		// hands off to the pilot build.
		const refusedRead = run(3, "schema", "firecrawl").result;
		expect([refusedRead.causeCode, refusedRead.repairAction?.includes("bun run build:pilot")]).toEqual(["DOMAIN_MCPORTER_REPAIR_REQUIRED", true]);
	},
	120_000,
);
