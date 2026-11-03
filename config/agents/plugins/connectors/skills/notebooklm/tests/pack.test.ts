import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBundle, PLUGIN_ROOT, runBundle } from "../../../tests/harness.ts";

// Expectations below are literals from the accepted LP-1 contract (FLS-29
// plan revision 3, Appendix G); they never import the production pack code.
const PACK = "connectors-pr-230";
const TRIAL = "19ae491d-ea63-4da0-be29-aefcdbf8964e";
const QUIZ = "1db41521-77c7-4d8e-9458-a52cc1cb364c";
const MAP = "2da8de7e-e273-4329-8982-c653784b9599";
const AUDIO = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const SELECT = ["--select", "profile=default"];
const PROVENANCE = { repo: "nathanvale/dotfiles", commit: "e3b1ab08", subtree: "config/agents/plugins/connectors", plugin: "connectors 0.8.5", vendor: "notebooklm-mcp-cli 0.15.8" };
const READ_TOOLS = ["server_info", "notebook_list", "notebook_get", "notebook_describe", "source_describe", "source_get_content", "studio_status"];
const release = process.env.CONNECTORS_NOTEBOOKLM_RELEASE ?? process.env.CONNECTORS_OFFICIAL_RELEASE_FIXTURE;
// pack_check is local and starts no child, so it always runs. pack_status
// reaches the fixture vendor through MCPorter and needs the release fixture.
const processTest = test.skipIf(!release);
const header = (fields: Record<string, string> = {}) => Object.entries({ pack: PACK, ...PROVENANCE, ...fields }).map(([key, value]) => `${key}: ${value}`).join("\n");
const source = (body: string, fields: Record<string, string> = {}) => `---\n${header(fields)}\n---\n\n${body}\n`;
const GOOD = source("# Overview\n\n- [verified] Every read goes through one packaged registry.\n- [proposal] A glossary may follow.\n- [decision] Existing notebooks stay read-only unless adopted.");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const manifest = (fields: Record<string, unknown> = {}) => ({ schemaVersion: 1, pack: { id: PACK, title: "Connectors at PR 230", request: "Make a learning pack for Connectors at PR 230.", provenance: PROVENANCE }, sourceRoot: "learning", sources: [{ key: "overview", file: "overview.md" }], ...fields });

interface Artifact { artifact_id: string; title: string; type: string; status: string; custom_instructions?: string | null; source_ids?: string[]; duration_seconds?: number | null }
function machine() {
	const bundle = createBundle();
	const base = realpathSync(bundle.root);
	const home = path.join(base, "home");
	const state = path.join(base, "state");
	const bin = path.join(base, "path");
	const vault = path.join(base, "vault", "packs");
	mkdirSync(home); mkdirSync(bin); mkdirSync(vault, { recursive: true });
	cpSync(path.join(PLUGIN_ROOT, "skills/notebooklm/config"), path.join(bundle.skillsRoot, "notebooklm/config"), { recursive: true });
	if (release) {
		const current = path.join(state, "connectors/mcporter/current");
		mkdirSync(current, { recursive: true, mode: 0o700 });
		for (const file of ["mcporter", "provenance.json"]) cpSync(path.join(release, file), path.join(current, file));
		chmodSync(path.join(current, "mcporter"), 0o700); chmodSync(path.join(current, "provenance.json"), 0o600);
		writeFileSync(path.join(current, "release.json"), '{"version":"0.14.0"}', { mode: 0o600 });
	}
	symlinkSync(process.execPath, path.join(bin, "bun"));
	writeFileSync(path.join(bin, "notebooklm-mcp"), `#!/bin/sh\nexec '${process.execPath}' '${path.join(import.meta.dir, "fixtures/server.ts")}'\n`, { mode: 0o700 });
	const fixture = path.join(home, "fixture.json");
	const change = (fields: Record<string, unknown>) => writeFileSync(fixture, JSON.stringify({ title: "Synthetic notebook", sourceTitle: "Synthetic source", mode: "normal", auth: "configured", version: "0.15.8", ...(existsSync(fixture) ? JSON.parse(readFileSync(fixture, "utf8")) : {}), ...fields }));
	change({});
	const registration = path.join(state, "connectors/notebooklm/pack-roots.json");
	const m = {
		bundle, home, state, vault, change,
		manifestPath: (pack = PACK) => path.join(vault, pack, "manifest.json"),
		register(roots: Record<string, string> = { learning: vault }, mode = 0o600) {
			mkdirSync(path.dirname(registration), { recursive: true, mode: 0o700 });
			writeFileSync(registration, JSON.stringify({ schemaVersion: 1, roots }), { mode });
			chmodSync(registration, mode);
		},
		pack(value: unknown, files: Record<string, string> = { "overview.md": GOOD }, pack = PACK) {
			mkdirSync(path.join(vault, pack, "sources"), { recursive: true });
			writeFileSync(path.join(vault, pack, "manifest.json"), JSON.stringify(value));
			for (const [file, text] of Object.entries(files)) writeFileSync(path.join(vault, pack, "sources", file), text);
		},
		calls: (): { name: string; args: Record<string, unknown> }[] => existsSync(path.join(home, "calls.jsonl")) ? readFileSync(path.join(home, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [],
		async run(operation: string, input: unknown, env: Record<string, string> = {}) {
			const result = await runBundle(bundle, ["run", "notebooklm", ...SELECT, operation, "--input", JSON.stringify(input)], { home, binDir: bin, extraEnv: { XDG_STATE_HOME: state, PRIVATE_SENTINEL: "SENTINEL_AMBIENT_SECRET", ...env }, timeoutMs: 90000 });
			expect(result.stderr).toBe("");
			expect(result.stdout.trim().split("\n")).toHaveLength(1);
			expect(result.stdout).not.toContain("SENTINEL_");
			const envelope = JSON.parse(result.stdout);
			expect(envelope.result.exitCode).toBe(result.code);
			return { code: result.code, stdout: result.stdout, result: envelope.result, data: envelope.result.data };
		},
		check: (pack = PACK) => m.run("pack_check", { manifest: m.manifestPath(pack) }),
		status: (pack = PACK) => m.run("pack_status", { manifest: m.manifestPath(pack) }),
		dispose: () => bundle.dispose(),
	};
	return m;
}
const causeOf = (run: { code: number; data: { connectorCause?: string } }) => [run.code, run.data.connectorCause];

test("pack_check returns digests, verdicts and manifest defaults without opening unlisted files or starting a child", async () => {
	const m = machine(); try {
		m.register();
		m.pack(manifest(), { "overview.md": GOOD, "unlisted.md": "SENTINEL_UNLISTED body" });
		chmodSync(path.join(m.vault, PACK, "sources/unlisted.md"), 0o000);
		const run = await m.check();
		expect([run.code, run.result.outcome, run.data.operation, run.data.ready]).toEqual([0, "success", "pack_check", true]);
		expect(run.data.defaults).toEqual({
			notebook: { mode: "create-if-needed", adopt: false },
			artifacts: { mission: { type: "quiz", questions: 5, difficulty: "easy", bound: false }, audio: { type: "audio", format: "deep_dive", length: "short", bound: false }, map: { type: "mind_map", bound: false } },
			preferences: { audioLength: "short", deeper: false },
		});
		expect(run.data.sources).toEqual([{ key: "overview", file: "overview.md", digest: sha(GOOD), bytes: Buffer.byteLength(GOOD), provenance: { verdict: "verified", mismatched: [], reasons: [] }, labels: { verdict: "labelled", claims: 3, unlabelled: [] }, ready: true }]);
		expect(run.stdout).not.toContain("unlisted");
		m.pack(manifest({ preferences: { audioLength: "long" } }));
		expect((await m.check()).data.defaults.artifacts.audio.length).toBe("long");
		expect(m.calls()).toEqual([]);
	} finally { m.dispose(); }
});

test("an unregistered pack root refuses before the manifest or any source is opened", async () => {
	const m = machine(); try {
		m.pack(manifest());
		chmodSync(m.manifestPath(), 0o000);
		expect(causeOf(await m.check())).toEqual([3, "pack-root-unregistered"]);
		m.register({ learning: path.join(m.bundle.root, "elsewhere") });
		expect(causeOf(await m.status())).toEqual([3, "pack-root-unregistered"]);
		m.register({ learning: m.vault }, 0o644);
		expect(causeOf(await m.check())).toEqual([3, "pack-roots-invalid"]);
		m.register();
		expect(causeOf(await m.run("pack_check", { manifest: path.join(m.vault, PACK, "sources", "manifest.json") }))).toEqual([3, "pack-root-unregistered"]);
		expect(m.calls()).toEqual([]);
	} finally { m.dispose(); }
});

test("containment refuses symlinks, path escapes and special files before reading any selected source", async () => {
	const m = machine(); try {
		m.register();
		const outside = path.join(m.bundle.root, "outside.md");
		writeFileSync(outside, "SENTINEL_OUTSIDE private text");
		const two = (file: string) => manifest({ sources: [{ key: "overview", file: "overview.md" }, { key: "second", file }] });
		const sources = path.join(m.vault, PACK, "sources");
		m.pack(two("linked.md"));
		symlinkSync(outside, path.join(sources, "linked.md"));
		expect(causeOf(await m.check())).toEqual([3, "pack-source-not-contained"]);
		for (const file of ["../outside.md", "nested/inner.md", "..", "/etc/hosts"]) {
			m.pack(two(file));
			expect(causeOf(await m.check())).toEqual([3, "pack-source-not-contained"]);
		}
		m.pack(two("pipe.md"));
		expect(spawnSync("mkfifo", [path.join(sources, "pipe.md")]).status).toBe(0);
		expect(causeOf(await m.check())).toEqual([3, "pack-source-not-contained"]);
		m.pack(two("absent.md"));
		expect(causeOf(await m.status())).toEqual([3, "pack-source-missing"]);
		m.pack(two("large.md"), { "overview.md": GOOD, "large.md": "x".repeat(256 * 1024 + 1) });
		expect(causeOf(await m.check())).toEqual([3, "pack-source-too-large"]);
		const other = "linked-pack";
		mkdirSync(path.join(m.bundle.root, "real-pack/sources"), { recursive: true });
		writeFileSync(path.join(m.bundle.root, "real-pack/manifest.json"), JSON.stringify(manifest({ pack: { ...manifest().pack, id: other } })));
		symlinkSync(path.join(m.bundle.root, "real-pack"), path.join(m.vault, other));
		expect(causeOf(await m.check(other))).toEqual([3, "pack-source-not-contained"]);
		const linkedRoot = path.join(m.bundle.root, "linked-root");
		symlinkSync(m.vault, linkedRoot);
		m.register({ learning: linkedRoot });
		m.pack(manifest());
		expect(causeOf(await m.run("pack_check", { manifest: path.join(linkedRoot, PACK, "manifest.json") }))).toEqual([3, "pack-root-invalid"]);
		m.register();
		const dirLinked = "dir-linked";
		mkdirSync(path.join(m.vault, dirLinked)); mkdirSync(path.join(m.bundle.root, "real-sources"));
		writeFileSync(path.join(m.bundle.root, "real-sources/overview.md"), GOOD);
		writeFileSync(path.join(m.vault, dirLinked, "manifest.json"), JSON.stringify(manifest({ pack: { ...manifest().pack, id: dirLinked } })));
		symlinkSync(path.join(m.bundle.root, "real-sources"), path.join(m.vault, dirLinked, "sources"));
		expect(causeOf(await m.check(dirLinked))).toEqual([3, "pack-source-not-contained"]);
		expect(m.calls()).toEqual([]);
	} finally { m.dispose(); }
});

test("hard links and read-only failures cannot bypass the all-paths-first containment check", async () => {
	const m = machine(); try {
		m.register();
		const outside = path.join(m.bundle.root, "outside.md");
		writeFileSync(outside, "SENTINEL_OUTSIDE private text");
		const sources = path.join(m.vault, PACK, "sources");
		m.pack(manifest({ sources: [{ key: "overview", file: "overview.md" }, { key: "second", file: "hard.md" }] }));
		linkSync(outside, path.join(sources, "hard.md"));
		expect(causeOf(await m.check())).toEqual([3, "pack-source-not-contained"]);
		const hardPack = "hard-manifest";
		const outsideManifest = path.join(m.bundle.root, "outside-manifest.json");
		writeFileSync(outsideManifest, JSON.stringify(manifest({ pack: { ...manifest().pack, id: hardPack } })));
		mkdirSync(path.join(m.vault, hardPack, "sources"), { recursive: true });
		writeFileSync(path.join(m.vault, hardPack, "sources/overview.md"), GOOD);
		linkSync(outsideManifest, path.join(m.vault, hardPack, "manifest.json"));
		expect(causeOf(await m.check(hardPack))).toEqual([3, "pack-source-not-contained"]);
		// The first source fails only when read; the second fails its path check.
		// Checking every path before reading any source reports the second.
		m.pack(manifest({ sources: [{ key: "binary", file: "binary.md" }, { key: "linked", file: "linked.md" }] }));
		writeFileSync(path.join(sources, "binary.md"), Buffer.from([0xff, 0xfe, 0xfd]));
		symlinkSync(outside, path.join(sources, "linked.md"));
		expect(causeOf(await m.check())).toEqual([3, "pack-source-not-contained"]);
		m.pack(manifest({ sources: [{ key: "binary", file: "binary.md" }] }));
		expect(causeOf(await m.check())).toEqual([3, "pack-source-invalid"]);
		expect(m.calls()).toEqual([]);
	} finally { m.dispose(); }
});

test("a directory swapped between the path check and the open never yields outside content", async () => {
	const m = machine(); try {
		m.register();
		const library = path.join(m.bundle.root, "swap-on-open.dylib");
		expect(spawnSync("xcrun", ["clang", "-arch", "arm64", "-dynamiclib", "-O2", "-o", library, path.join(import.meta.dir, "fixtures/swap-on-open.c")]).status).toBe(0);
		const outside = path.join(m.bundle.root, "outside-sources");
		mkdirSync(outside);
		for (const file of ["overview.md", "second.md"]) writeFileSync(path.join(outside, file), "SENTINEL_OUTSIDE private text");
		const second = source("- [verified] Second source.");
		m.pack(manifest({ sources: [{ key: "overview", file: "overview.md" }, { key: "second", file: "second.md" }] }), { "overview.md": GOOD, "second.md": second });
		const sources = path.join(m.vault, PACK, "sources");
		const log = path.join(m.bundle.root, "swap.log");
		const run = await m.run("pack_check", { manifest: m.manifestPath() }, { DYLD_INSERT_LIBRARIES: library, SWAP_TRIGGER: "/sources/second.md", SWAP_DIR: sources, SWAP_TARGET: outside, SWAP_LOG: log });
		expect(readFileSync(log, "utf8")).toBe("SWAP_DONE=1\n");
		expect(lstatSync(sources).isSymbolicLink()).toBe(true);
		expect(causeOf(run)).toEqual([3, "pack-source-not-contained"]);
		expect(run.stdout).not.toContain(sha("SENTINEL_OUTSIDE private text"));
	} finally { m.dispose(); }
});

test("the provenance check refuses private inventory and the five known-false trial claims without echoing them", async () => {
	const m = machine(); try {
		m.register();
		const privateText = source(["- [verified] Owner SENTINEL_ACCOUNT@example.com", "- [verified] Path /Users/SENTINEL_HOME/code", "- [verified] session id 0e583649-baa6-4f97-bba6-90bf3333fe39", "- [verified] Host SENTINEL-HOST.local", `- [verified] Built on ${os.hostname()}`, "- [verified] Contact SENTINEL_REVIEWER@example.test: the reviewer.", "- [verified] Contact git@example.test for the review.", "- [verified] Fetch https://git@example.test:/srv/git/dotfiles.git over HTTPS.", "- [verified] See https://example.com/?git@example.test:/secret for details.", "- [verified] See https://example.com/#git@example.test:/secret for details.", "- [verified] See https://example.com/?ssh://git@example.test/secret for details."].join("\n"));
		const falseClaims = [
			"- [verified] The preview dispatches the mutating write with confirm false.",
			"- [verified] Credential headers are shared across every provider.",
			"- [verified] A configured key that fails falls back to the keyless route.",
			"- [verified] Unknown-effect recovery is generic across connectors.",
			"- [verified] Unlock settles the outcome and permits a retry.",
			"- [verified] Preview may read but never dispatches a mutating write.",
			"- [verified] Credential headers are provider-specific.",
			"- [verified] A configured key that fails has no fallback.",
			"- [verified] Unknown-effect recovery is connector-specific.",
			"- [verified] Unlock is neither adjudication nor retry permission.",
			"- [verified] The preview dispatches the write, not a read.",
			"- [verified] With no journal, the preview dispatches the write.",
		].join("\n");
		const benign = [
			"- [verified] The adapter calls client.internal(\"studio_marker\", args).",
			"- [verified] Clone with git@github.com:nathanvale/dotfiles.git over SSH.",
			"- [verified] Or clone ssh://git@github.com/nathanvale/dotfiles.git instead.",
			"- [verified] A mirror lives at git@git.example.test:/srv/git/dotfiles.git for offline use.",
			"- [verified] The SSH port form ssh://git@git.example.test:22/srv/git/dotfiles.git also works.",
			"- [verified] A relative remote git@example.test:+repo.git also works.",
			"- [verified] Local overrides live in .claude/settings.local.json.",
			"- [verified] Unlock resolves nothing.",
		].join("\n");
		m.pack(manifest({ sources: ["private", "claims", "mismatch", "missing", "unlabelled", "benign"].map((key) => ({ key, file: `${key}.md` })) }), {
			"benign.md": source(benign),
			"private.md": privateText,
			"claims.md": source(falseClaims),
			"mismatch.md": source("- [verified] Right text.", { commit: "0000000" }),
			"missing.md": "- [verified] No provenance header.\n",
			"unlabelled.md": source("- [verified] Labelled.\n- Unlabelled claim."),
		});
		const run = await m.check();
		expect([run.code, run.data.ready]).toEqual([0, false]);
		const byKey = Object.fromEntries(run.data.sources.map((row: { key: string }) => [row.key, row]));
		expect(byKey.private.provenance).toEqual({ verdict: "refused", mismatched: [], reasons: [{ code: "account-email", line: 10 }, { code: "home-path", line: 11 }, { code: "session-id", line: 12 }, { code: "host-name", line: 13 }, { code: "host-name", line: 14 }, { code: "account-email", line: 15 }, { code: "account-email", line: 16 }, { code: "account-email", line: 17 }, { code: "account-email", line: 18 }, { code: "account-email", line: 19 }, { code: "account-email", line: 20 }] });
		expect(byKey.claims.provenance.reasons).toEqual([
			{ code: "false-claim:preview-dispatches-write", line: 10 }, { code: "false-claim:shared-credential-headers", line: 11 }, { code: "false-claim:failed-key-fallback", line: 12 },
			{ code: "false-claim:generic-recovery", line: 13 }, { code: "false-claim:unlock-settles", line: 14 }, { code: "false-claim:preview-dispatches-write", line: 20 }, { code: "false-claim:preview-dispatches-write", line: 21 },
		]);
		expect(byKey.benign.provenance).toEqual({ verdict: "verified", mismatched: [], reasons: [] });
		expect(byKey.mismatch.provenance).toEqual({ verdict: "mismatch", mismatched: ["commit"], reasons: [] });
		expect(byKey.missing.provenance.verdict).toBe("missing");
		expect(byKey.unlabelled.labels).toEqual({ verdict: "unlabelled", claims: 2, unlabelled: [11] });
		expect(run.stdout).not.toContain(os.hostname());
		expect(run.stdout).not.toContain("example.com");
	} finally { m.dispose(); }
});

test("malformed manifests and inputs refuse with closed causes before any child starts", async () => {
	const m = machine(); try {
		m.register();
		const pack = manifest().pack;
		const invalid = [
			{ ...manifest(), schemaVersion: 2 }, { ...manifest(), extra: true }, manifest({ notebook: { mode: "bind" } }), manifest({ notebook: { id: TRIAL } }),
			manifest({ notebook: { adopt: true } }), manifest({ artifacts: { map: { id: MAP } } }), manifest({ artifacts: { audio: { format: "brief" } } }),
			manifest({ pack: { ...pack, id: "another-pack" } }), manifest({ sourceRoot: "other" }), manifest({ sources: [{ key: "a", file: "a.md" }, { key: "a", file: "b.md" }] }),
			manifest({ sources: [] }), manifest({ pack: { ...pack, provenance: { ...PROVENANCE, subtree: "/abs" } } }),
		];
		for (const value of invalid) {
			m.pack(value);
			expect(causeOf(await m.check())).toEqual([3, "pack-manifest-invalid"]);
		}
		m.pack(manifest({ notebook: { mode: "bind", id: TRIAL, adopt: true } }));
		expect(causeOf(await m.status())).toEqual([3, "pack-notebook-adopt-refused"]);
		for (const input of [{}, { manifest: "relative/manifest.json" }, { manifest: m.manifestPath(), extra: 1 }, { manifest: `${m.vault}/../packs/${PACK}/manifest.json` }]) {
			expect(causeOf(await m.run("pack_status", input))).toEqual([4, "input-invalid"]);
		}
		expect(m.calls()).toEqual([]);
	} finally { m.dispose(); }
});

const TRIAL_SOURCES = ["Connectors overview", "Front Door", "Custody", "NotebookLM route", "Refactoring proposals"].map((title, index) => ({ id: `5555555${index}-5555-4555-8555-555555555555`, title }));
const trialArtifacts = (): Artifact[] => [
	{ artifact_id: QUIZ, title: "Connectors quiz", type: "quiz", status: "completed", custom_instructions: null, source_ids: TRIAL_SOURCES.map((row) => row.id), duration_seconds: null },
	{ artifact_id: AUDIO, title: "Connectors Deep Dive", type: "audio", status: "completed", custom_instructions: "Short two-host deep dive", source_ids: TRIAL_SOURCES.map((row) => row.id), duration_seconds: 339 },
	{ artifact_id: MAP, title: "Connectors map", type: "mind_map", status: "completed" },
	{ artifact_id: OTHER, title: "Unrelated report", type: "report", status: "completed", custom_instructions: null, source_ids: [], duration_seconds: null },
];
const trialManifest = () => manifest({
	notebook: { mode: "bind", id: TRIAL },
	sources: TRIAL_SOURCES.map((row, index) => ({ key: `source-${index + 1}`, file: `source-${index + 1}.md`, title: row.title })),
	artifacts: { mission: { id: QUIZ }, audio: { id: AUDIO }, map: { id: MAP } },
});
const trialFiles = () => Object.fromEntries(TRIAL_SOURCES.map((_, index) => [`source-${index + 1}.md`, GOOD]));

processTest("bind-mode status reads five sources by exact title, Studio items and Start Here in at most four read calls", async () => {
	const m = machine(); try {
		m.register();
		m.pack(trialManifest(), trialFiles());
		m.change({ pack: { notebookId: TRIAL, notebookTitle: "Connectors trial", sources: TRIAL_SOURCES, artifacts: trialArtifacts() } });
		const run = await m.status();
		expect([run.code, run.result.outcome, run.data.operation]).toEqual([0, "success", "pack_status"]);
		expect(run.data.notebook).toEqual({ id: TRIAL, title: "Connectors trial", mode: "bind", binding: "manifest", state: "unmarked", url: `https://notebooklm.google.com/notebook/${TRIAL}` });
		expect(run.data.items.map((item: { key: string; state: string; ids: string[] }) => [item.key, item.state, item.ids])).toEqual([
			["notebook", "unmarked", [TRIAL]],
			...TRIAL_SOURCES.map((row, index) => [`source-${index + 1}`, "present", [row.id]]),
			["mission", "completed-unconfirmed", [QUIZ]], ["audio", "completed-unconfirmed", [AUDIO]], ["map", "completed-unconfirmed", [MAP]],
		]);
		const audio = run.data.items.find((item: { key: string }) => item.key === "audio");
		expect(audio.evidence).toEqual({ match: "manifest-id", type: "audio", status: "completed", typeMatches: true, customInstructions: "present", sourceIds: { exposed: 5, equalsPresentSources: true }, durationSeconds: 339 });
		expect(run.data.items.find((item: { key: string }) => item.key === "map").evidence).toMatchObject({ customInstructions: "absent", sourceIds: null, durationSeconds: null });
		const view = run.data.startHere;
		expect([view.primary.role, view.primary.artifactId, view.primary.url, view.links.map((link: { role: string; artifactId: string }) => [link.role, link.artifactId])]).toEqual(["mission", QUIZ, `https://notebooklm.google.com/notebook/${TRIAL}`, [["audio", AUDIO], ["map", MAP]]]);
		expect(view.text.split("\n").length).toBeLessThanOrEqual(15);
		expect(view.text).toContain("Start the 5-minute mission: completed-unconfirmed");
		const calls = m.calls();
		expect(calls.map((call) => call.name)).toEqual(["server_info", "notebook_get", "studio_status"]);
		expect(calls[2]?.args).toEqual({ notebook_id: TRIAL, include_details: true, limit: 20, offset: 0 });
		expect(calls.every((call) => READ_TOOLS.includes(call.name))).toBe(true);
	} finally { m.dispose(); }
}, 120000);

processTest("marker matches, duplicates, pending, stale and missing items come only from read-back", async () => {
	const m = machine(); try {
		m.register();
		const glossary = source("- [verified] Glossary text.");
		m.pack(manifest({ notebook: { mode: "bind", id: TRIAL }, sources: [{ key: "overview", file: "overview.md" }, { key: "glossary", file: "glossary.md" }, { key: "faq", file: "faq.md" }] }), { "overview.md": GOOD, "glossary.md": glossary, "faq.md": source("- [verified] FAQ.") });
		const overviewTitle = `overview [sha256:${sha(GOOD).slice(0, 12)}]`;
		m.change({ pack: { notebookId: TRIAL, notebookTitle: `Pack [lp:${PACK}:a1b2c3]`, sources: [{ id: TRIAL_SOURCES[0]?.id, title: overviewTitle }, { id: TRIAL_SOURCES[1]?.id, title: "glossary [sha256:000000000000]" }], artifacts: [
			{ artifact_id: QUIZ, title: "Quiz", type: "quiz", status: "in_progress", custom_instructions: `Mission lp:${PACK}:mission:n1` },
			{ artifact_id: MAP, title: `Map lp:${PACK}:map:n2`, type: "mind_map", status: "completed" },
			{ artifact_id: OTHER, title: `Map lp:${PACK}:map:n3`, type: "mind_map", status: "completed" },
		] } });
		const run = await m.status();
		expect(run.data.items.map((item: { key: string; state: string; ids: string[] }) => [item.key, item.state, item.ids])).toEqual([
			["notebook", "present", [TRIAL]], ["overview", "present", [TRIAL_SOURCES[0]?.id]], ["glossary", "stale", [TRIAL_SOURCES[1]?.id]], ["faq", "missing", []],
			["mission", "pending", [QUIZ]], ["audio", "missing", []], ["map", "duplicate", [MAP, OTHER]],
		]);
		expect([run.data.startHere.links[1].artifactId, run.data.startHere.next]).toEqual([null, "Generation is still pending. Read pack status again later."]);
		const many = Array.from({ length: 22 }, (_, index) => ({ artifact_id: `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`, title: `Report ${index}`, type: "report", status: "completed" }));
		m.change({ pack: { notebookId: TRIAL, notebookTitle: "Plain", sources: [], artifacts: [...many, { artifact_id: AUDIO, title: `Audio lp:${PACK}:audio:n4`, type: "audio", status: "failed" }] } });
		const paged = await m.status();
		expect([paged.data.studio, paged.data.items.find((item: { key: string }) => item.key === "audio").state]).toEqual([{ read: "completed", pages: 2, complete: true, seen: 23 }, "failed"]);
		m.change({ pack: { notebookId: TRIAL, notebookTitle: "Plain", sources: [], artifacts: [], studio: "no-pagination" } });
		const partial = await m.status();
		expect(partial.data.items.filter((item: { role: string }) => ["mission", "audio", "map"].includes(item.role)).map((item: { state: string }) => item.state)).toEqual(["unknown", "unknown", "unknown"]);
		m.change({ pack: { notebookId: TRIAL, notebookTitle: "Plain", sources: [], artifacts: [], studio: "error" } });
		const failed = await m.status();
		expect([failed.code, failed.data.studio]).toEqual([0, { read: "failed", cause: "provider-rejected" }]);
		const studioCalls = m.calls().filter((call) => call.name === "studio_status");
		expect(studioCalls.map((call) => call.args.offset)).toEqual([0, 0, 20, 0, 0]);
	} finally { m.dispose(); }
}, 180000);

processTest("create-if-needed status binds nothing, never creates and reports only an advisory scan", async () => {
	const m = machine(); try {
		m.register();
		m.pack(manifest());
		m.change({ pack: { notebookId: TRIAL, notebookTitle: "Plain", sources: [], artifacts: [], total: 30, notebooks: [{ id: TRIAL, title: "Trial" }, { id: OTHER, title: `Earlier [lp:${PACK}:n9]` }] } });
		const run = await m.status();
		expect([run.code, run.data.notebook, run.data.scan]).toEqual([0, { id: null, mode: "create-if-needed", binding: "none", state: "unknown" }, { read: "completed", advisory: true, seen: 2, total: 30, complete: false, marked: [OTHER] }]);
		expect(run.data.items.map((item: { state: string }) => item.state)).toEqual(["unknown", "missing", "missing", "missing", "missing"]);
		m.change({ pack: { notebookId: TRIAL, notebookTitle: "Plain", sources: [], artifacts: [], notebooks: [{ id: TRIAL, title: "Trial" }] } });
		const empty = await m.status();
		expect([empty.data.notebook.state, empty.data.scan.complete, empty.data.startHere.primary.state]).toEqual(["missing", true, "missing"]);
		expect(empty.data.startHere.next).toContain("Pack creation is not admitted in this release");
		expect(m.calls().map((call) => [call.name, call.args])).toEqual([["server_info", {}], ["notebook_list", { max_results: 20 }], ["server_info", {}], ["notebook_list", { max_results: 20 }]]);
	} finally { m.dispose(); }
}, 120000);

processTest("bind-mode status refuses an unverified notebook and an unready profile without creating", async () => {
	const m = machine(); try {
		m.register();
		m.pack(manifest({ notebook: { mode: "bind", id: OTHER } }));
		m.change({ pack: { notebookId: TRIAL, notebookTitle: "Plain", sources: [], artifacts: [] } });
		expect(causeOf(await m.status())).toEqual([3, "pack-notebook-unverified"]);
		m.change({ auth: "stale" });
		expect(causeOf(await m.status())).toEqual([3, "authentication-unready"]);
		expect(m.calls().map((call) => call.name)).toEqual(["server_info", "notebook_get", "server_info"]);
	} finally { m.dispose(); }
}, 120000);

processTest("discovery lists both pack reads beside the unchanged 53-operation catalogue", async () => {
	const m = machine(); try {
		const run = await m.run("capabilities", {});
		expect([run.data.operations.length, run.data.packOperations]).toEqual([53, [{ name: "pack_check", effect: "read", input: "manifest" }, { name: "pack_status", effect: "read", input: "manifest" }]]);
		expect(m.calls()).toEqual([]);
	} finally { m.dispose(); }
});

processTest("internal marker reads stay unreachable publicly and the seven public read policies are unchanged", async () => {
	const m = machine(); try {
		const rows = [
			["studio_status", { notebook_id: TRIAL, include_details: true, limit: 20, offset: 0 }, 4, "input-invalid"],
			["studio_marker", { notebook_id: TRIAL, include_details: true, limit: 20, offset: 0 }, 3, "operation-not-allowed"],
			["notebook_scan", { max_results: 20 }, 3, "operation-not-allowed"],
		] satisfies [string, Record<string, unknown>, number, string][];
		for (const [name, input, code, cause] of rows) expect(causeOf(await m.run(name, input))).toEqual([code, cause]);
		expect(m.calls()).toEqual([]);
		m.change({ pack: { notebookId: TRIAL, notebookTitle: "Plain", sources: [], artifacts: trialArtifacts(), total: 30, notebooks: [{ id: TRIAL, title: "Trial" }] } });
		const list = await m.run("notebook_list", { max_results: 20 });
		expect(list.data.result).toEqual({ notebooks: [{ id: TRIAL, title: "Trial" }], returned: 1 });
		const studio = await m.run("studio_status", { notebook_id: TRIAL });
		expect(studio.data.result.artifacts[1]).toEqual({ artifact_id: AUDIO, title: "Connectors Deep Dive", type: "audio", status: "completed" });
	} finally { m.dispose(); }
}, 120000);

processTest("completed artifacts over changed sources read stale-sources, and role markers match whole tokens only", async () => {
	const m = machine(); try {
		m.register();
		const glossary = source("- [verified] Glossary text.");
		m.pack(manifest({ notebook: { mode: "bind", id: TRIAL }, sources: [{ key: "overview", file: "overview.md" }, { key: "glossary", file: "glossary.md" }] }), { "overview.md": GOOD, "glossary.md": glossary });
		const [first, second] = [TRIAL_SOURCES[0]?.id as string, TRIAL_SOURCES[1]?.id as string];
		const overviewTitle = `overview [sha256:${sha(GOOD).slice(0, 12)}]`;
		const glossaryTitle = `glossary [sha256:${sha(glossary).slice(0, 12)}]`;
		const artifacts = (ids: { mission: string[]; audio: string[] | null }) => [
			{ artifact_id: OTHER, title: "Unrelated quiz", type: "quiz", status: "completed", custom_instructions: `lp:${PACK}:missionary:n0`, source_ids: [first] },
			{ artifact_id: QUIZ, title: "Quiz", type: "quiz", status: "completed", custom_instructions: `Mission lp:${PACK}:mission:n1`, source_ids: ids.mission },
			{ artifact_id: AUDIO, title: `Audio lp:${PACK}:audio:n2`, type: "audio", status: "completed", source_ids: ids.audio },
			{ artifact_id: MAP, title: `Map lp:${PACK}:map`, type: "mind_map", status: "completed" },
		];
		const notebook = (glossaryOnNotebook: string, ids: { mission: string[]; audio: string[] | null }) => m.change({ pack: { notebookId: TRIAL, notebookTitle: "Plain", sources: [{ id: first, title: overviewTitle }, { id: second, title: glossaryOnNotebook }], artifacts: artifacts(ids) } });
		const states = (run: { data: { items: { key: string; state: string; ids: string[] }[] } }) => run.data.items.map((item) => [item.key, item.state, item.ids]);
		notebook("glossary [sha256:000000000000]", { mission: [first, second], audio: null });
		const stale = await m.status();
		expect(states(stale)).toEqual([["notebook", "unmarked", [TRIAL]], ["overview", "present", [first]], ["glossary", "stale", [second]], ["mission", "stale-sources", [QUIZ]], ["audio", "stale-sources", [AUDIO]], ["map", "stale-sources", [MAP]]]);
		expect(stale.data.startHere.next).toBe("The mission was built from sources that changed since. Regeneration is not admitted in this release.");
		notebook(glossaryTitle, { mission: [first, OTHER], audio: [first, second] });
		const current = await m.status();
		expect(states(current)).toEqual([["notebook", "unmarked", [TRIAL]], ["overview", "present", [first]], ["glossary", "present", [second]], ["mission", "stale-sources", [QUIZ]], ["audio", "completed-unconfirmed", [AUDIO]], ["map", "completed-unconfirmed", [MAP]]]);
		notebook(glossaryTitle, { mission: [first, first], audio: [first, second] });
		const repeated = await m.status();
		expect(states(repeated)[3]).toEqual(["mission", "stale-sources", [QUIZ]]);
		expect(repeated.data.items[3].evidence.sourceIds).toEqual({ exposed: 2, equalsPresentSources: false });
		notebook(glossaryTitle, { mission: [], audio: [first, second] });
		const empty = await m.status();
		expect(states(empty)[3]).toEqual(["mission", "stale-sources", [QUIZ]]);
		expect(empty.data.items[3].evidence.sourceIds).toEqual({ exposed: 0, equalsPresentSources: false });
		m.change({ pack: { notebookId: TRIAL, notebookTitle: "Plain", sources: [], artifacts: artifacts({ mission: [], audio: null }).slice(0, 1) } });
		expect(states(await m.status())[3]).toEqual(["mission", "missing", []]);
	} finally { m.dispose(); }
}, 180000);

processTest("an artifact repeated across overlapping pages stays one artifact, and a foreign notebook URL is dropped", async () => {
	const m = machine(); try {
		m.register();
		m.pack(manifest({ notebook: { mode: "bind", id: TRIAL }, artifacts: { mission: { id: QUIZ }, map: { id: MAP } } }));
		const reports = Array.from({ length: 20 }, (_, index) => ({ artifact_id: `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`, title: `Report ${index}`, type: "report", status: "completed" }));
		const rows = [{ artifact_id: QUIZ, title: "Quiz", type: "quiz", status: "completed" }, ...reports.slice(0, 18), { artifact_id: MAP, title: "Map", type: "mind_map", status: "completed" }, ...reports.slice(18, 19)];
		m.change({ pack: { notebookId: TRIAL, notebookTitle: "Plain", sources: [], artifacts: rows, studio: "overlap" } });
		const overlap = await m.status();
		expect([overlap.data.studio, overlap.data.items.find((item: { key: string }) => item.key === "map")]).toEqual([{ read: "completed", pages: 2, complete: true, seen: 21 }, { key: "map", role: "map", state: "stale-sources", ids: [MAP], evidence: { match: "manifest-id", type: "mind_map", status: "completed", typeMatches: true, customInstructions: "absent", sourceIds: null, durationSeconds: null } }]);
		expect(overlap.data.startHere.links[1]).toEqual({ role: "map", label: "Map", state: "stale-sources", artifactId: MAP, url: `https://notebooklm.google.com/notebook/${TRIAL}` });
		m.change({ pack: { notebookId: TRIAL, notebookTitle: "Plain", sources: [], artifacts: rows.slice(0, 1), notebookUrl: `https://untrusted.invalid/notebook/${TRIAL}` } });
		const foreign = await m.status();
		expect([foreign.data.notebook.url, foreign.data.startHere.primary.artifactId, foreign.data.startHere.primary.url]).toEqual([null, QUIZ, null]);
		expect(foreign.stdout).not.toContain("untrusted.invalid");
	} finally { m.dispose(); }
}, 120000);
