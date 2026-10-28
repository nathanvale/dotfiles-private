// The Figma Console process machine: one private copy of the whole Connectors
// plugin that differs from source only in declared places, compiled from that
// copy, plus a fixture root holding HOME, state, the fixture Console runtime
// and the fakes' records. Substitutions, each visible in the copy only:
//   scripts/mcporter.ts  the MCPorter process leaf, now console-machine.ts
//   scripts/endpoint.ts  the Figma identity origin, now a loopback server
//   scripts/pins.json    runtimeTreeSha256 of the fixture runtime only
//   bin/keychain-read.ts and requirements.json  the shared fake reader and
//                        fake op digest (see the Atlassian plugin copy)
// The shipped payload, registry, route, adapter, journal and transport are
// byte-identical. Evidence here is substituted process proof, never MCPorter,
// Desktop bridge, 1Password or Figma proof. The copy is verified by content
// digest against source before use; any other difference throws.
import { afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileFrontDoor } from "../../../../tests/compile-front-door.ts";
import { namespace, type Profile } from "../../scripts/profile.ts";
import { changedPaths, FAKE_OP_LAUNCHER, FAKE_UV_LAUNCHER, KEYCHAIN_LEAF, REQUIREMENTS } from "../../../atlassian/tests/fixtures/plugin-copy.ts";

const SOURCE = path.resolve(import.meta.dir, "../../../..");
const MCPORTER_LEAF = "skills/figma-console/scripts/mcporter.ts";
const ENDPOINT_LEAF = "skills/figma-console/scripts/endpoint.ts";
const PINS = "skills/figma-console/scripts/pins.json";
const FAKE_READER = path.resolve(import.meta.dir, "../../../atlassian/tests/fixtures/keychain-read-fake.ts");
const RUNTIME_ENTRY = "figma-console-mcp/dist/local.js";
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

export interface ConsoleMachine {
	readonly root: string;
	readonly plugin: string;
	readonly binary: string;
	readonly home: string;
	readonly state: string;
	readonly runtimeRoot: string;
	readonly nodeFile: string;
}

// The runtime pin is measured here from the fixture's own two files with the
// accepted closure rule (sorted `path\0sha256` lines), never read from source.
function writeRuntime(root: string): { runtimeRoot: string; pin: string } {
	const runtimeRoot = path.join(root, "runtime");
	const dist = path.join(runtimeRoot, path.dirname(RUNTIME_ENTRY));
	mkdirSync(dist, { recursive: true, mode: 0o700 });
	const entry = readFileSync(path.join(import.meta.dir, "console-runtime.ts"));
	writeFileSync(path.join(runtimeRoot, RUNTIME_ENTRY), entry, { mode: 0o600 });
	writeFileSync(path.join(dist, "fixture-root"), `${root}\n`, { mode: 0o600 });
	const lines = [`${RUNTIME_ENTRY}\0${sha256(entry)}`, `${path.dirname(RUNTIME_ENTRY)}/fixture-root\0${sha256(`${root}\n`)}`].sort();
	return { runtimeRoot, pin: sha256(lines.join("\n")) };
}

function build(): ConsoleMachine {
	const root = mkdtempSync(path.join(os.tmpdir(), "connectors-figma-console-"));
	chmodSync(root, 0o700);
	const plugin = path.join(root, "plugin");
	cpSync(SOURCE, plugin, { recursive: true, verbatimSymlinks: true });
	const { runtimeRoot, pin } = writeRuntime(root);
	writeFileSync(path.join(plugin, MCPORTER_LEAF), `export { runMcporter } from ${JSON.stringify(path.join(import.meta.dir, "console-machine.ts"))};\n`);
	writeFileSync(path.join(plugin, ENDPOINT_LEAF), readFileSync(path.join(import.meta.dir, "endpoint-fake.ts")));
	writeFileSync(path.join(plugin, KEYCHAIN_LEAF), readFileSync(FAKE_READER));
	const requirements = JSON.parse(readFileSync(path.join(SOURCE, REQUIREMENTS), "utf8")) as { sources: { op: Record<string, unknown>; uv: Record<string, unknown> } };
	requirements.sources.op.binarySha256 = sha256(FAKE_OP_LAUNCHER);
	requirements.sources.uv.binarySha256 = sha256(FAKE_UV_LAUNCHER);
	writeFileSync(path.join(plugin, REQUIREMENTS), `${JSON.stringify(requirements, null, "\t")}\n`);
	const pins = JSON.parse(readFileSync(path.join(SOURCE, PINS), "utf8")) as Record<string, unknown>;
	writeFileSync(path.join(plugin, PINS), JSON.stringify({ ...pins, runtimeTreeSha256: pin }));
	compileFrontDoor(path.join(plugin, "bin/connectors.ts"), path.join(plugin, "bin/connectors"));
	const expected = ["bin/connectors", ENDPOINT_LEAF, KEYCHAIN_LEAF, MCPORTER_LEAF, PINS, REQUIREMENTS].sort();
	const changed = changedPaths(SOURCE, plugin);
	if (JSON.stringify(changed) !== JSON.stringify(expected)) throw new Error(`figma-console plugin copy changed undeclared source: ${JSON.stringify(changed)}`);
	// Content, not only paths: each changed manifest differs in its declared
	// fields alone, and the copy's binary carries every substitute's own code.
	const copied = (file: string) => JSON.parse(readFileSync(path.join(plugin, file), "utf8")) as unknown;
	if (!Bun.deepEquals(copied(REQUIREMENTS), requirements, true) || !Bun.deepEquals(copied(PINS), { ...pins, runtimeTreeSha256: pin }, true)) throw new Error("figma-console plugin copy changed an undeclared manifest field");
	const binary = readFileSync(path.join(plugin, "bin/connectors")), shipped = readFileSync(path.join(SOURCE, "bin/connectors"));
	for (const marker of ["mcporter-calls.jsonl", "keychain-reads.jsonl", "figma-api-origin", pin]) {
		if (!binary.includes(marker)) throw new Error(`figma-console plugin copy binary lacks substitute marker ${marker}`);
		if (shipped.includes(marker)) throw new Error(`the shipped binary carries substitute marker ${marker}`);
	}
	const home = path.join(root, "home"), state = path.join(root, "state");
	mkdirSync(home, { mode: 0o700 }); mkdirSync(state, { mode: 0o700 });
	// Discard port until a custody test serves identity; nothing listens there.
	writeFileSync(path.join(root, "figma-api-origin"), "http://127.0.0.1:9\n");
	// A launcher stands in for the measured Node binary, so its digest can move.
	const nodeFile = path.join(root, "node");
	writeFileSync(nodeFile, `#!/bin/sh\nexec ${process.execPath} "$@"\n`, { mode: 0o700 });
	return { root, plugin, binary: path.join(plugin, "bin/connectors"), home, state, runtimeRoot, nodeFile };
}

let shared: ConsoleMachine | undefined;
// One verified copy per test process; removal binds to the first asking scope.
export function consoleMachine(): ConsoleMachine {
	if (shared) return shared;
	const machine = build();
	shared = machine;
	afterAll(() => {
		if (shared === machine) shared = undefined;
		// The transport's daemon namespace is a short /tmp path (socket length);
		// remove exactly the ones this machine's profiles derive.
		const profiles = path.join(machine.state, "connectors/figma-console/monash");
		for (const fileKey of existsSync(profiles) ? readdirSync(profiles) : []) rmSync(namespace({ XDG_STATE_HOME: machine.state }, { account: "monash", fileKey } as Profile), { recursive: true, force: true });
		// A storage-fault row may leave an owner-read-only journal behind.
		Bun.spawnSync(["/bin/chmod", "-R", "u+rwx", machine.root]);
		rmSync(machine.root, { recursive: true, force: true });
	});
	return machine;
}
