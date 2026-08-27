import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Real entrypoint proof. The prototype CLI is executed as a process, exactly as
// the advertised live command runs it, against a FAKE browser-use executable.
// Nothing here reaches a browser: the fake records its argv and replies with
// canned public envelopes.

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const CLI = join(SOURCE_DIR, "browser-use-pinned-open-identity-cli.ts");

const DIGEST =
	"f15a8fce32213e8a585a0d9409e58622d12a1266089b71e74727aa88c4572e7f";
const RUN_ID = "pinned-open-entrypoint-run";
const URL_REQUESTED = "http://127.0.0.1:43151/?path=/story/x";
const PRODUCER_CONTRACT = "browser-use.qualification-handoff-producer";

const CALL_SEPARATOR = "---CALL---";

type Harness = {
	readonly bin: string;
	readonly root: string;
	readonly state: string;
	readonly log: string;
	readonly dispose: () => void;
};

function harness(): Harness {
	const dir = mkdtempSync(join(tmpdir(), "pinned-open-entrypoint-"));
	const bin = join(dir, "fake-browser-use");
	const log = join(dir, "calls.log");
	const root = join(dir, "bundles");
	mkdirSync(root, { recursive: true });
	chmodSync(root, 0o700);
	writeFileSync(log, "");
	// The fake records every argv, then answers on stdout. The exec case also
	// writes the adapter's fallback event to stderr, so stream separation is
	// exercised end to end.
	//
	// Fidelity to the public contract, in the three places the approved live
	// probe proved it matters:
	//
	//  1. `qualification prepare` refuses an --output that already exists, and
	//     creates the bundle when it does not.
	//  2. `qualification exec -- qualification handoff --output <h>` is the ONLY
	//     producer of the sealed `<h>.producer.json` receipt, and it refuses an
	//     --output whose handoff or receipt already exists.
	//  3. `qualification exec -- targets open --handoff <h>` refuses with
	//     `qualification_handoff_producer_invalid`, before any adapter mutation,
	//     when `<h>.producer.json` is absent. That is the exact live stop the
	//     probe observed against a `browser-connect connect`-minted handoff,
	//     which carries a Verified Handoff Envelope and no sealed receipt.
	writeFileSync(
		bin,
		[
			"#!/bin/sh",
			'if [ -n "$PINNED_OPEN_FAKE_SLEEP" ]; then sleep "$PINNED_OPEN_FAKE_SLEEP"; fi',
			'if [ -n "$PINNED_OPEN_FAKE_LOG" ]; then',
			`  echo "${CALL_SEPARATOR}" >> "$PINNED_OPEN_FAKE_LOG"`,
			'  for a in "$@"; do echo "$a" >> "$PINNED_OPEN_FAKE_LOG"; done',
			"fi",
			'out=""; runid=""; handoff=""; prev=""',
			'for a in "$@"; do',
			'  if [ "$prev" = "--output" ]; then out="$a"; fi',
			'  if [ "$prev" = "--run-id" ]; then runid="$a"; fi',
			'  if [ "$prev" = "--handoff" ]; then handoff="$a"; fi',
			'  prev="$a"',
			"done",
			`receipt='{"status":"ok","data":{"contract":"${PRODUCER_CONTRACT}","schema_version":"1","command":"qualification-handoff","producer":"browser-connect","adapter":"agent-browser","run_id":"'"$runid"'","expected_manifest_digest":"'"\${PINNED_OPEN_FAKE_RECEIPT_DIGEST:-${DIGEST}}"'","observed_manifest_digest":"'"\${PINNED_OPEN_FAKE_RECEIPT_DIGEST:-${DIGEST}}"'"}}'`,
			'case "$*" in',
			'  *"qualification prepare"*)',
			'    if [ -e "$out" ]; then',
			`      printf '%s' '{"status":"error","error":{"code":"qualification_bundle_exists","exit_code":20,"message":"The sealed Browser Use qualification runtime was not admitted."}}'`,
			"      exit 20",
			"    fi",
			'    mkdir -p "$out" || exit 1',
			`    echo '{}' > "$out/manifest.json"`,
			'    if [ -n "$PINNED_OPEN_FAKE_SEAL_BUNDLE" ]; then',
			'      chmod 400 "$out/manifest.json"',
			'      chmod 500 "$out"',
			"    fi",
			`    printf '%s' '{"status":"ok","run_id":"r","data":{"manifest_digest":"${DIGEST}"}}'`,
			"    ;;",
			'  *"qualification handoff"*)',
			'    if [ -n "$PINNED_OPEN_FAKE_MINT_ERROR_CODE" ]; then',
			`      printf '%s' '{"status":"error","error":{"code":"'"$PINNED_OPEN_FAKE_MINT_ERROR_CODE"'","exit_code":20,"message":"Sanitized fake failure."}}'`,
			"      exit 20",
			"    fi",
			'    if [ -e "$out" ] || [ -e "$out.producer.json" ]; then',
			`      printf '%s' '{"status":"error","error":{"code":"qualification_handoff_producer_input_invalid","exit_code":20,"message":"The sealed Browser Use qualification runtime was not admitted."}}'`,
			"      exit 20",
			"    fi",
			`    printf '%s' '{"status":"ok","run_id":"'"$runid"'","data":{"contract_id":"browser-connect.verified-handoff","schema_version":"1"}}' > "$out"`,
			'    chmod 600 "$out"',
			// The sealed sibling receipt is written unless the switch reproduces
			// the live shape: a real handoff with no sealed receipt beside it.
			'    if [ -z "$PINNED_OPEN_FAKE_MINT_SKIPS_RECEIPT" ]; then',
			'      printf \'%s\' "$receipt" > "$out.producer.json"',
			'      chmod 600 "$out.producer.json"',
			"    fi",
			'    printf \'%s\' "$receipt"',
			"    ;;",
			"  *)",
			'    if [ -n "$PINNED_OPEN_FAKE_EXEC_ERROR_CODE" ]; then',
			`      printf '%s' '{"status":"error","error":{"code":"'"$PINNED_OPEN_FAKE_EXEC_ERROR_CODE"'","exit_code":20,"message":"Sanitized fake failure."}}'`,
			"      exit 20",
			"    fi",
			'    if [ ! -e "$handoff.producer.json" ]; then',
			`      printf '%s' '{"status":"error","error":{"code":"qualification_handoff_producer_invalid","exit_code":20,"message":"The sealed Browser Use qualification runtime was not admitted."}}'`,
			"      exit 20",
			"    fi",
			'    if [ -n "$PINNED_OPEN_FAKE_ADOPTED" ]; then',
			`      printf '%s' '{"status":"ok","run_id":"r","data":{"command":"targets-open","effect":"confirmed","target_mutated":true,"target_present":true,"command_outcome":"adapter-confirmed","ownership":{"kind":"adopted-existing-target","retained":true}}}'`,
			"    else",
			`      printf '%s' '{"status":"ok","run_id":"r","data":{"command":"targets-open","effect":"confirmed","target_mutated":true,"target_present":true,"command_outcome":"adapter-confirmed","ownership":{"kind":"created-target","retained":true}}}'`,
			"    fi",
			`    printf '%s' '{"level":"debug","event":"target-topology-fallback-adopted"}' 1>&2`,
			"    ;;",
			"esac",
			"exit 0",
		].join("\n"),
	);
	chmodSync(bin, 0o700);
	return {
		bin,
		root,
		state: join(root, "selected-target.json"),
		log,
		dispose: () => rmSync(dir, { recursive: true, force: true }),
	};
}

function runCli(
	h: Harness,
	overrides: Record<string, string | undefined> = {},
): { stdout: string; stderr: string; status: number | null } {
	const base: Record<string, string> = {
		BROWSER_USE_PINNED_OPEN_IDENTITY_LIVE: "1",
		PINNED_OPEN_BROWSER_USE_BIN: h.bin,
		PINNED_OPEN_BUNDLE_ROOT: h.root,
		PINNED_OPEN_STATE: h.state,
		PINNED_OPEN_RUN_ID: RUN_ID,
		PINNED_OPEN_URL: URL_REQUESTED,
		PINNED_OPEN_EXPECTED_MANIFEST_DIGEST: DIGEST,
		PINNED_OPEN_FAKE_LOG: h.log,
	};
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) delete base[key];
		else base[key] = value;
	}
	const spawned = spawnSync(process.execPath, [CLI], {
		encoding: "utf8",
		env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...base },
		timeout: 60_000,
	});
	return {
		stdout: spawned.stdout ?? "",
		stderr: spawned.stderr ?? "",
		status: spawned.status,
	};
}

function recordedCalls(h: Harness): string[][] {
	const raw = readFileSync(h.log, "utf8");
	return raw
		.split(CALL_SEPARATOR)
		.map((block) => block.split("\n").filter((line) => line.length > 0))
		.filter((call) => call.length > 0);
}

function expectOnlyCreatedTargetHandoff(h: Harness): void {
	const entries = readdirSync(h.root).sort();
	expect(entries).toHaveLength(2);
	expect(entries.some((entry) => entry.startsWith("bundle-"))).toBe(false);
	const handoff = entries.find(
		(entry) => entry.startsWith("handoff-") && !entry.endsWith(".producer.json"),
	);
	expect(handoff).toBeDefined();
	expect(entries).toContain(`${handoff}.producer.json`);
}

describe("pinned-open prototype CLI entrypoint", () => {
	test("makes exactly three public calls with the exact argv and state binding", () => {
		const h = harness();
		try {
			const result = runCli(h);
			expect(result.status, result.stdout || result.stderr).toBe(0);

			const calls = recordedCalls(h);
			expect(calls).toHaveLength(3);

			const [prepare, mint, exec] = calls as [string[], string[], string[]];
			// The bundle is a fresh child the CLI allocated under the root.
			const bundle = prepare[3] as string;
			expect(bundle.startsWith(`${h.root}/`)).toBe(true);
			expect(bundle).not.toBe(h.root);
			// The handoff is a fresh sibling the CLI allocated under the same
			// root, because only the sealed producer may create it.
			const handoff = mint[12] as string;
			expect(handoff.startsWith(`${h.root}/`)).toBe(true);
			expect(handoff).not.toBe(h.root);

			expect(prepare).toEqual([
				"qualification", "prepare", "--output", bundle, "--json",
			]);
			// The sealed producer mint runs through the SAME bundle, so the
			// receipt it writes is bound to the artifact `targets open` executes.
			expect(mint).toEqual([
				"qualification", "exec",
				"--bundle", bundle,
				"--expected-manifest-digest", DIGEST,
				"--",
				"qualification", "handoff",
				"--run-id", RUN_ID,
				"--output", handoff,
				"--json",
			]);
			expect(exec).toEqual([
				"qualification", "exec",
				"--bundle", bundle,
				"--expected-manifest-digest", DIGEST,
				"--",
				"targets", "open",
				"--url", URL_REQUESTED,
				"--handoff", handoff,
				"--state", h.state,
				"--run-id", RUN_ID,
				"--debug", "--json",
			]);

			// Never raw adapter argv, and never a close.
			for (const call of calls) {
				for (const native of ["--cdp", "--session", "--pin-tab", "close"]) {
					expect(call).not.toContain(native);
				}
			}
		} finally {
			h.dispose();
		}
	});

	test("reproduces the live stop when the sealed producer leaves no receipt", () => {
		const h = harness();
		try {
			// The exact shape the approved live probe hit: a real handoff file
			// with no sealed sibling receipt. `targets open` must refuse before
			// any adapter mutation, and the prototype must surface the owner
			// code rather than collapsing it.
			const result = runCli(h, { PINNED_OPEN_FAKE_MINT_SKIPS_RECEIPT: "1" });
			expect(result.status).toBe(20);
			expect(result.stderr).toBe("");
			const payload = JSON.parse(result.stdout.trim()) as {
				result: {
					ok: boolean;
					code: string;
					prepare_calls: number;
					mint_calls: number;
					exec_calls: number;
					browser_use_error_code: string | null;
				};
			};
			expect(payload.result).toMatchObject({
				ok: false,
				code: "pinned_open_exec_failed",
				prepare_calls: 1,
				mint_calls: 1,
				exec_calls: 1,
				browser_use_error_code: "qualification_handoff_producer_invalid",
			});
			// Failure still releases every invocation-owned path.
			expect(readdirSync(h.root)).toEqual([]);
		} finally {
			h.dispose();
		}
	});

	test("stops after the mint and never opens when the sealed producer refuses", () => {
		const h = harness();
		try {
			const result = runCli(h, {
				PINNED_OPEN_FAKE_MINT_ERROR_CODE:
					"qualification_handoff_producer_input_invalid",
			});
			expect(result.status).toBe(20);
			expect(result.stderr).toBe("");
			expect(recordedCalls(h)).toHaveLength(2);
			const payload = JSON.parse(result.stdout.trim()) as {
				result: { code: string; mint_calls: number; exec_calls: number; browser_use_error_code: string | null };
			};
			expect(payload.result).toMatchObject({
				code: "pinned_open_handoff_mint_failed",
				mint_calls: 1,
				exec_calls: 0,
				browser_use_error_code: "qualification_handoff_producer_input_invalid",
			});
			expect(readdirSync(h.root)).toEqual([]);
		} finally {
			h.dispose();
		}
	});

	test("refuses to open when the sealed receipt is not bound to this bundle", () => {
		const h = harness();
		try {
			const result = runCli(h, {
				PINNED_OPEN_FAKE_RECEIPT_DIGEST:
					"0000000000000000000000000000000000000000000000000000000000000000",
			});
			expect(result.status).toBe(20);
			expect(recordedCalls(h)).toHaveLength(2);
			const payload = JSON.parse(result.stdout.trim()) as {
				result: { code: string; exec_calls: number };
			};
			expect(payload.result).toMatchObject({
				code: "pinned_open_binding_mismatch",
				exec_calls: 0,
			});
			expect(readdirSync(h.root)).toEqual([]);
		} finally {
			h.dispose();
		}
	});

	test("removes only its own child bundle and retains created-target close evidence", () => {
		const h = harness();
		try {
			expect(runCli(h).status).toBe(0);
			expectOnlyCreatedTargetHandoff(h);
		} finally {
			h.dispose();
		}
	});

	test("releases the handoff when the successful open adopted an existing target", () => {
		const h = harness();
		try {
			const result = runCli(h, { PINNED_OPEN_FAKE_ADOPTED: "1" });
			expect(result.status).toBe(0);
			const payload = JSON.parse(result.stdout.trim()) as {
				handoff_removed: boolean;
				handoff_retained: boolean;
			};
			expect(payload).toMatchObject({
				handoff_removed: true,
				handoff_retained: false,
			});
			expect(readdirSync(h.root)).toEqual([]);
		} finally {
			h.dispose();
		}
	});

	test("emits sanitized stdout carrying no url, digest, path, or run id", () => {
		const h = harness();
		try {
			const result = runCli(h);
			const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
			expect(payload).toMatchObject({
				contract: "browser-use.pinned-open-identity-prototype",
				dispatched: true,
				bundle_removed: true,
				bundle_retained: false,
				handoff_removed: false,
				handoff_retained: true,
				target_cleanup: "required-through-retained-handoff",
			});
			expect(payload.result).toMatchObject({
				ok: true,
				code: "pinned_open_observed",
				prepare_calls: 1,
				mint_calls: 1,
				exec_calls: 1,
				ownership_kind: "created-target",
				command_outcome: "adapter-confirmed",
				fallback_adopted: true,
			});
			for (const secret of [URL_REQUESTED, DIGEST, h.state, RUN_ID, h.root, "43151"]) {
				expect(result.stdout).not.toContain(secret);
			}
		} finally {
			h.dispose();
		}
	});

	test("performs zero calls and stays quiet when the gate is off", () => {
		const h = harness();
		try {
			for (const gate of [undefined, "0", "true"] as const) {
				writeFileSync(h.log, "");
				const result = runCli(h, {
					BROWSER_USE_PINNED_OPEN_IDENTITY_LIVE: gate,
				});
				expect(result.status).toBe(0);
				expect(recordedCalls(h)).toHaveLength(0);
				expect(readdirSync(h.root)).toEqual([]);
				const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
				expect(payload).toMatchObject({
					dispatched: false,
					reason: "live_gate_disabled",
				});
			}
		} finally {
			h.dispose();
		}
	});

	test("refuses missing input by name before issuing any command", () => {
		const h = harness();
		try {
			const result = runCli(h, { PINNED_OPEN_RUN_ID: undefined });
			expect(result.status).toBe(2);
			expect(recordedCalls(h)).toHaveLength(0);
			const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
			expect(payload).toMatchObject({
				dispatched: false,
				reason: "missing_required_input",
				missing: ["PINNED_OPEN_RUN_ID"],
			});
		} finally {
			h.dispose();
		}
	});

	test("refuses an unsafe url and an absent bundle root before issuing any command", () => {
		const h = harness();
		try {
			const unsafe = runCli(h, { PINNED_OPEN_URL: "file:///etc/passwd" });
			expect(unsafe.status).toBe(20);
			expect(recordedCalls(h)).toHaveLength(0);
			expect(
				(JSON.parse(unsafe.stdout.trim()) as { result: { code: string } }).result.code,
			).toBe("unsafe_requested_url");

			writeFileSync(h.log, "");
			const absent = runCli(h, {
				PINNED_OPEN_BUNDLE_ROOT: join(h.root, "not-there"),
			});
			expect(absent.status).toBe(2);
			expect(recordedCalls(h)).toHaveLength(0);
			expect(
				(JSON.parse(absent.stdout.trim()) as { reason: string }).reason,
			).toBe("bundle_root_absent");
		} finally {
			h.dispose();
		}
	});
});

describe("pinned-open prototype CLI input safety", () => {
	for (const bad of [0o755, 0o750, 0o700 | 0o007] as const) {
		test(`refuses a bundle root whose mode is ${bad.toString(8)}`, () => {
			const h = harness();
			try {
				chmodSync(h.root, bad);
				const result = runCli(h);
				expect(result.status).toBe(2);
				expect(recordedCalls(h)).toHaveLength(0);
				expect(
					(JSON.parse(result.stdout.trim()) as { reason: string }).reason,
				).toBe("bundle_root_unsafe");
			} finally {
				h.dispose();
			}
		});
	}

	test("refuses a relative or non-executable browser-use path", () => {
		const h = harness();
		try {
			const relative = runCli(h, { PINNED_OPEN_BROWSER_USE_BIN: "fake-browser-use" });
			expect(relative.status).toBe(2);
			expect(
				(JSON.parse(relative.stdout.trim()) as { reason: string }).reason,
			).toBe("browser_use_bin_unusable");

			const plain = join(h.root, "..", "not-executable");
			writeFileSync(plain, "#!/bin/sh\nexit 0\n");
			chmodSync(plain, 0o600);
			const notExec = runCli(h, { PINNED_OPEN_BROWSER_USE_BIN: plain });
			expect(notExec.status).toBe(2);
			expect(
				(JSON.parse(notExec.stdout.trim()) as { reason: string }).reason,
			).toBe("browser_use_bin_unusable");
			expect(recordedCalls(h)).toHaveLength(0);
		} finally {
			h.dispose();
		}
	});

	test("refuses a state path that is not a strict child of the bundle root", () => {
		const h = harness();
		try {
			for (const state of [h.root, join(h.root, "..", "escape.json"), "/tmp/elsewhere.json"]) {
				writeFileSync(h.log, "");
				const result = runCli(h, { PINNED_OPEN_STATE: state });
				expect(result.status).toBe(2);
				expect(recordedCalls(h)).toHaveLength(0);
				expect(
					(JSON.parse(result.stdout.trim()) as { reason: string }).reason,
				).toBe("state_path_unsafe");
			}
		} finally {
			h.dispose();
		}
	});
});

describe("pinned-open prototype CLI subprocess bounding", () => {
	test("bounds a slow child and reports the failure sanitized", () => {
		const h = harness();
		try {
			const result = runCli(h, {
				PINNED_OPEN_FAKE_SLEEP: "5",
				PINNED_OPEN_TIMEOUT_MS: "300",
			});
			expect(result.status).toBe(20);
			expect(result.stderr).toBe("");
			const payload = JSON.parse(result.stdout.trim()) as {
				result: { ok: boolean; code: string };
			};
			expect(payload.result.ok).toBe(false);
			expect(payload.result.code).toBe("pinned_open_prepare_failed");
			// Nothing about the child's fate leaks beyond the typed code.
			expect(result.stdout).not.toContain("SIGKILL");
			expect(result.stdout).not.toContain("timeout");
		} finally {
			h.dispose();
		}
	}, 30_000);

	test("reports a sanitized failure when the child cannot be spawned at all", () => {
		const h = harness();
		try {
			const missing = join(h.root, "..", "vanished-bin");
			writeFileSync(missing, "#!/bin/sh\nexit 0\n");
			chmodSync(missing, 0o700);
			rmSync(missing);
			const result = runCli(h, { PINNED_OPEN_BROWSER_USE_BIN: missing });
			// Absent file is caught by input validation before any spawn.
			expect(result.status).toBe(2);
			expect(result.stderr).toBe("");
			expect(
				(JSON.parse(result.stdout.trim()) as { reason: string }).reason,
			).toBe("browser_use_bin_unusable");
		} finally {
			h.dispose();
		}
	});
});

describe("pinned-open prototype CLI stream hygiene", () => {
	test("projects the safe Browser Use public error code instead of collapsing it", () => {
		const h = harness();
		try {
			const result = runCli(h, {
				PINNED_OPEN_FAKE_EXEC_ERROR_CODE:
					"target_topology_create_binding_failed",
			});
			expect(result.status).toBe(20);
			expect(result.stderr).toBe("");
			const payload = JSON.parse(result.stdout.trim()) as {
				result: {
					code: string;
					browser_use_error_code: string | null;
				};
			};
			expect(payload.result).toMatchObject({
				code: "pinned_open_exec_failed",
				browser_use_error_code: "target_topology_create_binding_failed",
			});
		} finally {
			h.dispose();
		}
	});

	test("drops an unsafe Browser Use error code instead of echoing child output", () => {
		const h = harness();
		try {
			const unsafeCode = "https://private.example/token-value";
			const result = runCli(h, {
				PINNED_OPEN_FAKE_EXEC_ERROR_CODE: unsafeCode,
			});
			expect(result.status).toBe(20);
			expect(result.stderr).toBe("");
			const payload = JSON.parse(result.stdout.trim()) as {
				result: { browser_use_error_code: string | null };
			};
			expect(payload.result.browser_use_error_code).toBeNull();
			expect(result.stdout).not.toContain(unsafeCode);
			expect(result.stdout).not.toContain("private.example");
		} finally {
			h.dispose();
		}
	});

	test("keeps its own stderr empty even though the child writes a debug event", () => {
		const h = harness();
		try {
			const result = runCli(h);
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
			// The child's debug event was still observed, via stdout only.
			const payload = JSON.parse(result.stdout.trim()) as {
				result: { fallback_adopted: boolean };
			};
			expect(payload.result.fallback_adopted).toBe(true);
		} finally {
			h.dispose();
		}
	});

	test("keeps stderr empty on every refusal path", () => {
		const h = harness();
		try {
			for (const override of [
				{ PINNED_OPEN_RUN_ID: undefined },
				{ PINNED_OPEN_URL: "file:///etc/passwd" },
				{ PINNED_OPEN_FAKE_MINT_SKIPS_RECEIPT: "1" },
				{ BROWSER_USE_PINNED_OPEN_IDENTITY_LIVE: undefined },
			] as const) {
				expect(runCli(h, override).stderr).toBe("");
			}
		} finally {
			h.dispose();
		}
	});
});

describe("pinned-open prototype CLI lets prepare create the bundle", () => {
	test("removes the exact bundle after qualification seals it read-only", () => {
		const h = harness();
		try {
			const result = runCli(h, { PINNED_OPEN_FAKE_SEAL_BUNDLE: "1" });
			expect(result.status, result.stdout || result.stderr).toBe(0);
			const payload = JSON.parse(result.stdout.trim()) as {
				bundle_removed: boolean;
				bundle_retained: boolean;
			};
			expect(payload).toMatchObject({
				bundle_removed: true,
				bundle_retained: false,
			});
			expectOnlyCreatedTargetHandoff(h);
		} finally {
			// Keep the RED fixture disposable before production learns how to
			// remove a qualification-sealed directory itself.
			for (const entry of readdirSync(h.root)) {
				chmodSync(join(h.root, entry), 0o700);
			}
			h.dispose();
		}
	});

	test("the fake refuses an existing --output, matching the public contract", () => {
		const h = harness();
		try {
			const existing = join(h.root, "already-there");
			mkdirSync(existing, { recursive: true });
			const spawned = spawnSync(
				h.bin,
				["qualification", "prepare", "--output", existing, "--json"],
				{ encoding: "utf8", env: { ...process.env, PINNED_OPEN_FAKE_LOG: h.log } },
			);
			expect(spawned.status).toBe(20);
			expect(
				(JSON.parse(spawned.stdout ?? "") as { error: { code: string } }).error.code,
			).toBe("qualification_bundle_exists");
		} finally {
			h.dispose();
		}
	});

	test("hands prepare a path it did not create, so the run succeeds", () => {
		const h = harness();
		try {
			// Succeeding at all is the proof: the fake refuses any --output that
			// already exists, so a pre-created child could never get this far.
			const result = runCli(h);
			expect(result.status, result.stdout || result.stderr).toBe(0);
			const payload = JSON.parse(result.stdout.trim()) as {
				result: { code: string; prepare_calls: number; mint_calls: number; exec_calls: number };
				bundle_removed: boolean;
				handoff_removed: boolean;
				handoff_retained: boolean;
			};
			expect(payload.result).toMatchObject({
				code: "pinned_open_observed",
				prepare_calls: 1,
				mint_calls: 1,
				exec_calls: 1,
			});
			expect(payload.bundle_removed).toBe(true);
			expect(payload.handoff_removed).toBe(false);
			expect(payload.handoff_retained).toBe(true);
			// The bundle is gone. The handoff and receipt remain only because the
			// created target still needs an exact public close.
			expectOnlyCreatedTargetHandoff(h);
		} finally {
			h.dispose();
		}
	});

	test("allocates an unpredictable child path that differs between runs", () => {
		const h = harness();
		try {
			const seen: string[] = [];
			for (let run = 0; run < 2; run += 1) {
				writeFileSync(h.log, "");
				expect(runCli(h).status).toBe(0);
				const [prepare] = recordedCalls(h) as [string[]];
				const bundle = prepare[3] as string;
				expect(bundle.startsWith(`${h.root}/bundle-`)).toBe(true);
				expect(bundle).not.toBe(h.root);
				seen.push(bundle);
			}
			expect(seen[0]).not.toBe(seen[1]);
			expect(
				readdirSync(h.root).some((entry) => entry.startsWith("bundle-")),
			).toBe(false);
		} finally {
			h.dispose();
		}
	});

	test("leaves nothing behind when prepare refuses", () => {
		const h = harness();
		try {
			// A prepare that fails creates no bundle, so cleanup has nothing to
			// remove and must still report honestly.
			const result = runCli(h, { PINNED_OPEN_FAKE_SLEEP: "5", PINNED_OPEN_TIMEOUT_MS: "300" });
			expect(result.status).toBe(20);
			expect(readdirSync(h.root)).toEqual([]);
			expect(result.stderr).toBe("");
		} finally {
			h.dispose();
		}
	}, 30_000);
});
