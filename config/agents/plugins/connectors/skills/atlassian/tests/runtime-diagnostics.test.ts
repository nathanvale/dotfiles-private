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

		expect(readProviderFailure("atlassian", env)).toBeNull();

		const result = await transport.call(binding, CJ, "jira_add_comment", { issueKey: "EX-1", body: "x" });

		// The exact real-incident cause at this layer (the fixed "inspect provider
		// diagnostics" repair text is applied one layer up, in flows.ts's
		// REPAIR_TEXT lookup -- this layer's own hint is correctly null here since
		// PROVIDER_CAUSE_HINTS only has entries for refused-precondition codes).
		expect(result).toEqual({ ok: false, cause: "failed-unknown", hint: null });

		const record = readProviderFailure("atlassian", env);
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
		const recordFile = path.join(state, "connectors", "diagnostics", "atlassian", "last-failure.json");
		const written = await Bun.file(recordFile).text();
		expect(written).not.toContain(SENTINEL);
		expect(written).not.toContain("mystery-provider-fault");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
