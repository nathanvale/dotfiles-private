#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// Prototype CLI for the gated pinned-open identity observation.
//
// This is the executable the advertised live command runs. It owns exactly two
// things under an operator-supplied root: the fresh child bundle it allocates,
// and the handoff the sealed producer mints into a fresh path it allocates. It
// removes both, or retains one and says so when removal fails.
//
// The handoff is minted here rather than supplied, because `targets open`
// admits a handoff only together with its sealed `<handoff>.producer.json`
// receipt, and only the sealed `qualification handoff` producer writes one.
//
// It never closes a target: the open leaves custody behind on purpose, and
// releasing it belongs to the existing public owner as a separate step. It
// never speaks raw adapter argv, and it refuses missing or unsafe input before
// issuing any command.
//
// Every input arrives by environment variable so the advertised command stays
// short and the gate reads the same way as every other switch here.
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	rmSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
	PINNED_OPEN_IDENTITY_LIVE_GATE,
	dispatchPinnedOpenLive,
	pinnedOpenExecDiagnostic,
	shouldDispatchPinnedOpenLive,
	type PinnedOpenExecRunner,
} from "./browser-use-pinned-open-identity";

const CONTRACT = "browser-use.pinned-open-identity-prototype";

const ENV_BIN = "PINNED_OPEN_BROWSER_USE_BIN";
const ENV_ROOT = "PINNED_OPEN_BUNDLE_ROOT";
const ENV_STATE = "PINNED_OPEN_STATE";
const ENV_RUN_ID = "PINNED_OPEN_RUN_ID";
const ENV_URL = "PINNED_OPEN_URL";
const ENV_DIGEST = "PINNED_OPEN_EXPECTED_MANIFEST_DIGEST";
/** Optional. Bounds every child; the default is deliberately generous. */
const ENV_TIMEOUT_MS = "PINNED_OPEN_TIMEOUT_MS";
const DEFAULT_TIMEOUT_MS = 120_000;

const REQUIRED = [
	ENV_BIN,
	ENV_ROOT,
	ENV_STATE,
	ENV_RUN_ID,
	ENV_URL,
	ENV_DIGEST,
] as const;

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_FAILED = 20;

/** Deterministic, leak-free stdout. Never a url, digest, path, or run id. */
function emit(payload: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** One shape for every pre-command refusal. Reason names only, no values. */
function refuse(reason: string, extra: Record<string, unknown> = {}): number {
	emit({ contract: CONTRACT, dispatched: false, reason, ...extra });
	return EXIT_USAGE;
}

function isSafeAbsolutePath(value: string): boolean {
	return value.startsWith("/") && !value.split("/").includes("..");
}

/** Strictly beneath the root: never the root itself, never a traversal. */
function isStrictChild(root: string, candidate: string): boolean {
	return (
		isSafeAbsolutePath(candidate) &&
		candidate !== root &&
		candidate.startsWith(`${root}/`) &&
		candidate.slice(root.length + 1).length > 0
	);
}

function isUsableExecutable(value: string): boolean {
	if (!isSafeAbsolutePath(value)) return false;
	try {
		const stats = statSync(value);
		return stats.isFile() && (stats.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

function resolveTimeoutMs(raw: string | undefined): number {
	const parsed = Number.parseInt(raw ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

async function main(): Promise<number> {
	const env = process.env;

	if (!shouldDispatchPinnedOpenLive(env)) {
		emit({
			contract: CONTRACT,
			dispatched: false,
			reason: "live_gate_disabled",
			gate: PINNED_OPEN_IDENTITY_LIVE_GATE,
		});
		return EXIT_OK;
	}

	// Names only: an operator needs to know WHICH input is missing, and a
	// variable name carries no value.
	const missing = REQUIRED.filter((name) => (env[name] ?? "") === "");
	if (missing.length > 0) {
		emit({
			contract: CONTRACT,
			dispatched: false,
			reason: "missing_required_input",
			missing,
		});
		return EXIT_USAGE;
	}

	// The executable must be an absolute, real, executable file. A bare name
	// would resolve through PATH, which is not something this prototype should
	// decide on an operator's behalf.
	if (!isUsableExecutable(env[ENV_BIN] as string)) {
		return refuse("browser_use_bin_unusable");
	}

	const bundleRoot = env[ENV_ROOT] as string;
	if (!existsSync(bundleRoot) || !statSync(bundleRoot).isDirectory()) {
		return refuse("bundle_root_absent");
	}
	// Exactly 0700. The bundle holds sealed qualification bytes, so a root any
	// other account can read or traverse is refused rather than tightened here.
	if ((statSync(bundleRoot).mode & 0o777) !== 0o700) {
		return refuse("bundle_root_unsafe");
	}
	// Run-scoped state belongs inside the bundle root this run owns, so cleanup
	// of the root is cleanup of the state.
	if (!isStrictChild(bundleRoot, env[ENV_STATE] as string)) {
		return refuse("state_path_unsafe");
	}

	const timeoutMs = resolveTimeoutMs(env[ENV_TIMEOUT_MS]);

	// Genuinely bounded: the child is killed at the deadline and the outcome is
	// reported as a typed timeout. A spawn that never starts is reported the
	// same sanitized way, so no OS error text can reach the operator's stream.
	const runCommand: PinnedOpenExecRunner = async (input) => {
		const spawnChild = () => {
			try {
				return Bun.spawn([input.command, ...input.args], {
					stdout: "pipe",
					stderr: "pipe",
					env: process.env,
				});
			} catch {
				return undefined;
			}
		};
		const child = spawnChild();
		if (child === undefined) {
			return { exitCode: null, stdout: "", stderr: "", timedOut: false };
		}
		// The deadline is RACED, never awaited through the pipes. Killing a shell
		// does not kill its own children, so a grandchild can hold the stream
		// open long after the deadline; waiting on it would defeat the bound.
		let deadline: ReturnType<typeof setTimeout> | undefined;
		try {
			const completed = (async () => {
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				return { exitCode, stdout, stderr, timedOut: false } as const;
			})();
			const expired = new Promise<{
				readonly exitCode: null;
				readonly stdout: "";
				readonly stderr: "";
				readonly timedOut: true;
			}>((resolve) => {
				deadline = setTimeout(() => {
					try {
						child.kill(9);
					} catch {
						// Already gone; the typed timeout below still stands.
					}
					resolve({ exitCode: null, stdout: "", stderr: "", timedOut: true });
				}, timeoutMs);
			});
			return await Promise.race([completed, expired]);
		} catch {
			return { exitCode: null, stdout: "", stderr: "", timedOut: false };
		} finally {
			if (deadline !== undefined) clearTimeout(deadline);
		}
	};

	const dispatch = await dispatchPinnedOpenLive({
		env,
		runCommand,
		executable: env[ENV_BIN] as string,
		bundleRoot,
		// Public `qualification prepare` refuses an --output that already exists,
		// so this hands it a fresh PATH and lets prepare do the creating. The
		// name is unpredictable rather than sequential so two runs under one
		// root cannot collide or be guessed by anything else on the machine.
		allocateBundleDir: (root) => {
			for (let attempt = 0; attempt < 8; attempt += 1) {
				const candidate = join(root, `bundle-${randomBytes(12).toString("hex")}`);
				if (!existsSync(candidate)) return candidate;
			}
			// Exhausted: hand back the root so the strict-child check refuses.
			return root;
		},
		// Only the sealed `qualification handoff` producer may create the handoff
		// and its receipt, and it refuses an --output that already exists. So
		// this hands it a fresh unpredictable PATH under the same private root
		// and lets it do the creating, exactly as with the bundle above.
		allocateHandoffPath: (root) => {
			for (let attempt = 0; attempt < 8; attempt += 1) {
				const candidate = join(root, `handoff-${randomBytes(12).toString("hex")}.json`);
				if (!existsSync(candidate) && !existsSync(`${candidate}.producer.json`)) {
					return candidate;
				}
			}
			// Exhausted: hand back the root so the strict-child check refuses.
			return root;
		},
		expectedManifestDigest: env[ENV_DIGEST] as string,
		requestedUrl: env[ENV_URL] as string,
		statePath: env[ENV_STATE] as string,
		runId: env[ENV_RUN_ID] as string,
		timeoutMs,
		// Remove only this run's child, and only if prepare actually created it.
		removeBundleDir: (bundleDir) => {
			if (existsSync(bundleDir)) {
				const bundle = lstatSync(bundleDir);
				if (!bundle.isDirectory() || bundle.isSymbolicLink()) {
					throw new Error("bundle_cleanup_identity_invalid");
				}
				// Qualification seals the bundle root 0500. Restore write permission
				// only on this fresh invocation-owned child before exact removal.
				chmodSync(bundleDir, 0o700);
				rmSync(bundleDir, { recursive: true, force: true });
			}
		},
		// The handoff carries a live endpoint and the receipt carries the sealed
		// binding, so both are removed. Each is a plain 0600 regular file the
		// producer wrote; anything else is refused rather than force-removed.
		removeHandoff: (handoff) => {
			for (const path of [handoff, `${handoff}.producer.json`]) {
				if (!existsSync(path)) continue;
				const entry = lstatSync(path);
				if (!entry.isFile() || entry.isSymbolicLink()) {
					throw new Error("handoff_cleanup_identity_invalid");
				}
				unlinkSync(path);
			}
		},
	});

	const run = dispatch.run;
	if (run === undefined) {
		emit({ contract: CONTRACT, dispatched: false, reason: "live_gate_disabled" });
		return EXIT_OK;
	}
	emit({
		contract: CONTRACT,
		dispatched: true,
		result: pinnedOpenExecDiagnostic(run.result),
		// Whether each invocation-owned path was retained, never which one. They
		// sit under the root the operator supplied.
		bundle_removed: run.bundle?.removed ?? false,
		bundle_retained: run.bundle?.retainedPath !== undefined,
		handoff_removed: run.handoff?.removed ?? false,
		handoff_retained: run.handoff?.retainedPath !== undefined,
		target_cleanup:
			run.handoff?.retainedPath !== undefined
				? "required-through-retained-handoff"
				: "not-required-by-this-prototype",
	});
	return run.result.ok ? EXIT_OK : EXIT_FAILED;
}

process.exit(await main());
