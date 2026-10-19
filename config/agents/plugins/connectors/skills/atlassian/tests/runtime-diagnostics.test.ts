// SMSTX-574 E1 delivery-loop observability gap: a provider call that fails
// through the normal, fully-classified path (never a throw) left no retained
// trace once translateFailure discarded the raw stderr/stdout. The real
// incident envelope was a complete DOMAIN_PROVIDER_CALL_FAILED/failed-unknown
// result (data: null, retryable: false) -- not an uncaught exception. This
// test reproduces that exact shape against the real routeTransport/toResult/
// translateFailure code (a fake MCPorter binary that exits nonzero with text
// matching none of translate.ts's patterns), then proves a safe diagnostic
// record is now retained: the closed cause, exit code, and text lengths only,
// never the stderr/stdout content. An embedded secret-shaped sentinel in the
// fake provider's stderr must not appear anywhere in the retained bytes.
//
// Authoring gate: this fails if the fix is reverted (no record exists; see
// the RED check below, which disables recordProviderFailure's effect by
// pointing it at a fresh unwritable root is not how RED is proven here --
// RED is proven by running this same assertion against the pre-fix runtime.ts
// and observing readProviderFailure return null; see the handback for that
// evidence). It also fails if the record ever contains the sentinel text.
//
// Additive, second repair: a transportCallId (not the outward envelope's
// result.runId -- see diagnostic-record.ts's header for why that id cannot be
// threaded here) correlates the retained record to one specific attempt. The
// remaining tests in this file prove: two separate invocations get two
// distinct ids and the second genuinely overwrites the first (latest-only,
// not a history, and this is named as the documented retention shape, not a
// defect); a success writes nothing; a failed diagnostic write never changes
// the real delivery outcome; and the real packaged bin/connectors CLI's
// `doctor` command safely surfaces a retained record with its explicit
// "not a causal diagnosis" limit and a supported next action, with no
// Provider start, credential read, network call, or secret/free-text leak.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecutionCapabilities } from "../../../bin/adapters/contract.ts";
import { readProviderFailure } from "../../../bin/diagnostic-record.ts";
import type { CredentialBinding } from "../scripts/custody/channel.ts";
import { routeTransport } from "../scripts/dispatch/runtime.ts";

const CJ = "atlassian-community-jira";
const SENTINEL = "runtime-diagnostics-secret-sentinel-7d41";
const binding: CredentialBinding = { principal: "service@example.invalid", itemVersion: "onepassword-item-version:1", origin: "https://example.atlassian.net", item: "jiraitem0000000000000000aa" };

function fakeScript(dir: string, name: string, body: string): string {
	const file = path.join(dir, name);
	writeFileSync(file, `#!/bin/sh\n${body}\n`);
	chmodSync(file, 0o700);
	return file;
}

test("a provider call that fails through the normal classified path (never a throw), with text matching no known pattern, is now explainable from a retained safe diagnostic record, with no secret text retained", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "runtime-diagnostics-"));
	const state = path.join(root, "state");
	mkdirSync(state, { recursive: true });
	try {
		// Passes --preflight silently, as providerReadiness requires.
		const providerScript = fakeScript(root, "fake-provider", "if [ \"$1\" = \"--preflight\" ]; then exit 0; fi\nexit 1");
		// The real incident shape: a nonzero exit, with stderr text that matches
		// none of translate.ts's AUTH/NOT_FOUND/CAPABILITY/TRANSPORT patterns, so
		// classify() falls through to its default "failed-unknown" -- exactly the
		// envelope the saved original receipt recorded (causeCode
		// DOMAIN_PROVIDER_CALL_FAILED, data: null, retryable: false). The sentinel
		// proves nothing from this text is ever retained.
		const mcporterScript = fakeScript(root, "fake-mcporter", `echo "mystery-provider-fault ${SENTINEL}" 1>&2\nexit 9`);
		const capabilities: ExecutionCapabilities = {
			selectMcporter: async () => mcporterScript,
			internalCommand: () => [providerScript],
		};
		const env = { HOME: root, PATH: process.env.PATH ?? "", XDG_STATE_HOME: state, LANG: "en_AU.UTF-8", LC_ALL: "en_AU.UTF-8" };
		const skillsRoot = path.join(import.meta.dir, "..", "..");
		const transport = routeTransport(env, "example", skillsRoot, capabilities);

		expect(readProviderFailure("atlassian", "example", env)).toBeNull();

		const result = await transport.call(binding, CJ, "jira_add_comment", { issueKey: "EX-1", body: "x" });

		// The exact real-incident cause at this layer (the fixed "inspect provider
		// diagnostics" repair text is applied one layer up, in flows.ts's
		// REPAIR_TEXT lookup -- this layer's own hint is correctly null here since
		// PROVIDER_CAUSE_HINTS only has entries for refused-precondition codes).
		expect(result).toEqual({ ok: false, cause: "failed-unknown", hint: null });

		const record = readProviderFailure("atlassian", "example", env);
		expect(record).not.toBeNull();
		expect(record?.connector).toBe("atlassian");
		expect(record?.tool).toBe("jira_add_comment");
		expect(record?.server).toBe(CJ);
		expect(record?.cause).toBe("failed-unknown");
		expect(record?.kind).toBe("process");
		expect(record?.exitCode).toBe(9);
		expect(record?.stderrLength).toBeGreaterThan(0);
		expect(JSON.parse(JSON.stringify(record))).not.toHaveProperty("stderr");
		expect(JSON.parse(JSON.stringify(record))).not.toHaveProperty("message");

		// The critical secret-safety assertion: the sentinel must not survive
		// anywhere in the retained private-state tree, byte for byte.
		const recordFile = path.join(state, "connectors", "diagnostics", "atlassian", "example", "last-failure.json");
		const written = await Bun.file(recordFile).text();
		expect(written).not.toContain(SENTINEL);
		expect(written).not.toContain("mystery-provider-fault");

		// Present, well-formed, and non-empty -- but is NOT the outward envelope's
		// result.runId (see diagnostic-record.ts's header for why that id cannot be
		// threaded here: it does not exist yet at this point in the control flow).
		expect(typeof record?.transportCallId).toBe("string");
		expect(record?.transportCallId.length).toBeGreaterThan(0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("two separate failing invocations get two distinct transportCallIds, and the second genuinely overwrites the first (latest-only, not a history)", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "runtime-diagnostics-correlate-"));
	const state = path.join(root, "state");
	mkdirSync(state, { recursive: true });
	try {
		const providerScript = fakeScript(root, "fake-provider", "if [ \"$1\" = \"--preflight\" ]; then exit 0; fi\nexit 1");
		const env = { HOME: root, PATH: process.env.PATH ?? "", XDG_STATE_HOME: state, LANG: "en_AU.UTF-8", LC_ALL: "en_AU.UTF-8" };
		const skillsRoot = path.join(import.meta.dir, "..", "..");

		const firstMcporter = fakeScript(root, "fake-mcporter-1", 'echo "first-mystery-fault" 1>&2\nexit 7');
		const firstTransport = routeTransport(env, "example", skillsRoot, { selectMcporter: async () => firstMcporter, internalCommand: () => [providerScript] });
		await firstTransport.call(binding, CJ, "jira_add_comment", { issueKey: "EX-1", body: "x" });
		const first = readProviderFailure("atlassian", "example", env);
		expect(first?.exitCode).toBe(7);

		const secondMcporter = fakeScript(root, "fake-mcporter-2", 'echo "second-mystery-fault" 1>&2\nexit 8');
		const secondTransport = routeTransport(env, "example", skillsRoot, { selectMcporter: async () => secondMcporter, internalCommand: () => [providerScript] });
		await secondTransport.call(binding, CJ, "jira_get_issue", { issueKey: "EX-2" });
		const second = readProviderFailure("atlassian", "example", env);
		expect(second?.exitCode).toBe(8);
		expect(second?.tool).toBe("jira_get_issue");

		// Distinct ids: each attempt is correlated to itself, not conflated.
		expect(first?.transportCallId).not.toBe(second?.transportCallId);
		// Overwrite honesty: only the second is now readable. There is no history;
		// this is the documented, bounded, single-record retention shape, not a
		// defect -- the first attempt's exitCode (7) is genuinely gone.
		const onlyRecord = readProviderFailure("atlassian", "example", env);
		expect(onlyRecord?.exitCode).toBe(8);
		expect(onlyRecord?.exitCode).not.toBe(first?.exitCode);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a successful provider call writes no diagnostic record", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "runtime-diagnostics-success-"));
	const state = path.join(root, "state");
	mkdirSync(state, { recursive: true });
	try {
		const providerScript = fakeScript(root, "fake-provider", "if [ \"$1\" = \"--preflight\" ]; then exit 0; fi\nexit 1");
		const mcporterScript = fakeScript(root, "fake-mcporter-ok", "echo '{\"ok\":true}'\nexit 0");
		const env = { HOME: root, PATH: process.env.PATH ?? "", XDG_STATE_HOME: state, LANG: "en_AU.UTF-8", LC_ALL: "en_AU.UTF-8" };
		const skillsRoot = path.join(import.meta.dir, "..", "..");
		const transport = routeTransport(env, "example", skillsRoot, { selectMcporter: async () => mcporterScript, internalCommand: () => [providerScript] });

		const result = await transport.call(binding, CJ, "jira_add_comment", { issueKey: "EX-1", body: "x" });
		expect(result.ok).toBe(true);
		expect(readProviderFailure("atlassian", "example", env)).toBeNull();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a failed diagnostic-record write never changes the real delivery outcome", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "runtime-diagnostics-write-fault-"));
	const state = path.join(root, "state");
	mkdirSync(state, { recursive: true });
	try {
		// A regular file sitting where the "connectors" state segment must be a
		// directory forces ownedDirectory to fail closed (not-directory), without
		// touching any real permission bit this process doesn't own.
		writeFileSync(path.join(state, "connectors"), "not a directory");
		const providerScript = fakeScript(root, "fake-provider", "if [ \"$1\" = \"--preflight\" ]; then exit 0; fi\nexit 1");
		const mcporterScript = fakeScript(root, "fake-mcporter-fault", 'echo "mystery-fault-under-write-failure" 1>&2\nexit 9');
		const env = { HOME: root, PATH: process.env.PATH ?? "", XDG_STATE_HOME: state, LANG: "en_AU.UTF-8", LC_ALL: "en_AU.UTF-8" };
		const skillsRoot = path.join(import.meta.dir, "..", "..");
		const transport = routeTransport(env, "example", skillsRoot, { selectMcporter: async () => mcporterScript, internalCommand: () => [providerScript] });

		const result = await transport.call(binding, CJ, "jira_add_comment", { issueKey: "EX-1", body: "x" });
		// The real TransportResult the caller depends on is identical to the
		// no-write-fault case: observability must not become a new failure mode.
		expect(result).toEqual({ ok: false, cause: "failed-unknown", hint: null });
		expect(readProviderFailure("atlassian", "example", env)).toBeNull();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a malformed on-disk record -- an extra key, a wrong-typed field, or an unknown kind -- reads as absent, never thrown or silently accepted", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "runtime-diagnostics-malformed-"));
	const state = path.join(root, "state");
	mkdirSync(state, { recursive: true });
	try {
		const env = { HOME: root, XDG_STATE_HOME: state };
		const recordFile = path.join(state, "connectors", "diagnostics", "atlassian", "example", "last-failure.json");
		mkdirSync(path.dirname(recordFile), { recursive: true });
		const wellFormedBase = { schemaVersion: 1, connector: "atlassian", tenant: "example", tool: "jira_add_comment", server: CJ, cause: "failed-unknown", kind: "process", exitCode: 9, stderrLength: 1, stdoutLength: 0, transportCallId: "call-malformed", observedAt: "2026-10-19T05:00:00.000Z" };

		// Shape: an extra key breaks the closed key set, even though every named
		// field is otherwise valid.
		writeFileSync(recordFile, `${JSON.stringify({ ...wellFormedBase, extra: "unexpected" })}\n`);
		expect(readProviderFailure("atlassian", "example", env)).toBeNull();

		// Scalar/type: exitCode as a string, not the required nullable integer.
		writeFileSync(recordFile, `${JSON.stringify({ ...wellFormedBase, exitCode: "9" })}\n`);
		expect(readProviderFailure("atlassian", "example", env)).toBeNull();

		// Closed enum: kind outside the three observed kinds.
		writeFileSync(recordFile, `${JSON.stringify({ ...wellFormedBase, kind: "unknown-kind" })}\n`);
		expect(readProviderFailure("atlassian", "example", env)).toBeNull();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// Local-doctor proof: the actual packaged bin/connectors CLI subprocess (not a
// unit-level call), reading a record this same diagnostic-record.ts module
// wrote, through connectors.doctor -- a command that starts no Provider, reads
// no credential, and makes no network call. Depends on `bun run build` having
// produced the current bin/connectors binary (already true whenever `bun run
// test` is invoked; it runs the build first).
test("the packaged bin/connectors CLI's doctor command surfaces the retained failure with its explicit limit and next action, and leaks no secret", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "runtime-diagnostics-doctor-cli-"));
	const state = path.join(root, "state");
	mkdirSync(state, { recursive: true });
	try {
		const env = { HOME: root, XDG_STATE_HOME: state };
		const { recordProviderFailure } = await import("../../../bin/diagnostic-record.ts");
		// Seeded the same way the write-side tests above already prove is
		// secret-free: recordProviderFailure's own closed field set has no room
		// for raw stderr/message text, so there is nothing further to leak here.
		// This test's job is the read/surface side: the real CLI, not a unit call.
		recordProviderFailure({ connector: "atlassian", tenant: "example", tool: "jira_add_comment", server: CJ, cause: "failed-unknown", kind: "process", exitCode: 9, stderrLength: 42, stdoutLength: 0, transportCallId: "call-doctor-cli-proof", env, observedAt: new Date("2026-10-19T05:00:00.000Z") });

		const binary = path.join(import.meta.dir, "..", "..", "..", "bin", "connectors");
		const run = Bun.spawnSync([binary, "doctor", "atlassian", "--select", "tenant=example"], { env: { ...env, PATH: process.env.PATH ?? "" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const stderr = run.stderr.toString();
		const stdout = run.stdout.toString();
		expect([run.exitCode, stderr]).toEqual([0, ""]);

		const envelope = JSON.parse(stdout) as { result: { commandIdentity: string; data: { lastFailure?: Record<string, unknown> } } };
		expect(envelope.result.commandIdentity).toBe("connectors.doctor");
		const lastFailure = envelope.result.data.lastFailure;
		expect(lastFailure).toBeDefined();
		expect(lastFailure?.cause).toBe("failed-unknown");
		expect(lastFailure?.exitCode).toBe(9);
		expect(lastFailure?.transportCallId).toBe("call-doctor-cli-proof");
		expect(lastFailure?.reasonKnown).toBe(false);
		expect(typeof lastFailure?.limit).toBe("string");
		expect(lastFailure?.limit as string).toContain("not a causal diagnosis");
		expect(typeof lastFailure?.supportedNextAction).toBe("string");

		// No credential, origin, or free-text channel appears anywhere in the
		// command's real stdout -- not just in the typed lastFailure view.
		expect(stdout).not.toContain("example.atlassian.net");
		expect(stdout).not.toContain("onepassword-item-version");
		expect(stdout).not.toContain(SENTINEL);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
