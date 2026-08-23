import { describe, expect, test } from "bun:test";
import {
	acquireBrowserLaneLease,
	acquireTargetOperationLease,
	browserAuthorityIdOf,
	heartbeatBrowserLaneLease,
	heartbeatTargetOperationLease,
	ownedTargetRefsForRun,
	parseBrowserCustodyRegistry,
	persistTargetOwnershipUnderCleanupLease,
	releaseBrowserLaneLease,
	releaseExactTargetOwnershipByRef,
	releaseRunTargetOwnership,
	releaseTargetOperationLease,
	targetRefOf,
	type TargetOperationLease,
} from "./browser-use-browser-custody";
import {
	acquireLease,
	leaseRecordPath,
	releaseLease,
} from "./browser-use-locks";
import {
	createDefaultPlatformFs,
	openBrowserUsePaths,
} from "./browser-use-paths";
import { candidateIdOf } from "./browser-use-core";
import { makeTempXdgEnv } from "./browser-use-platform-test-helpers";

const TARGET_REFS = {
	exact: "fe2226e689327ab4ba1144370dfe2f80d100dbd9d7368b27c7e3657f055205d2",
	explicitAdoption:
		"169e949c48b62e33b6117584fd2c4a2d1d60d9e3f2534e125123e29e3d938a57",
	legacy: "b672b94e58a9ab7a9abe20421b3913990a001fd734063ae857ea283251ff8f3e",
	release: "1025a2c288c989a1533221e585ad8daf516810c548e5a85113c9b368d5b92203",
	preserved: "58ac343dbfdd5e660105ee54d7476be357b16a2b224e370906c0a019d0df6766",
} as const;

async function fixture(input?: { failFirstCustodyRegistryWrite?: boolean }) {
	const xdg = makeTempXdgEnv();
	const realFs = createDefaultPlatformFs();
	let custodyRegistryWriteFailures = 0;
	let custodyRegistryWriteFailureArmed =
		input?.failFirstCustodyRegistryWrite === true;
	let armCustodyRegistryFailureAfterSuccess = false;
	let leaseReadMutation:
		| {
				path: string;
				atRead: number;
				reads: number;
				mutate: (raw: string) => Promise<string>;
		  }
		| undefined;
	const fs = {
		...realFs,
		async readTextFile(path: string) {
			const raw = await realFs.readTextFile(path);
			if (leaseReadMutation?.path !== path) return raw;
			leaseReadMutation.reads += 1;
			return leaseReadMutation.reads === leaseReadMutation.atRead
				? await leaseReadMutation.mutate(raw)
				: raw;
		},
		async writeFileDurable(path: string, contents: string, mode: number) {
			if (
				custodyRegistryWriteFailureArmed &&
				path.includes("/browser-custody/registry.json.tmp-")
			) {
				custodyRegistryWriteFailureArmed = false;
				custodyRegistryWriteFailures += 1;
				throw Object.assign(
					new Error("injected custody registry write failure"),
					{
						code: "EIO",
					},
				);
			}
			await realFs.writeFileDurable(path, contents, mode);
			if (
				armCustodyRegistryFailureAfterSuccess &&
				path.includes("/browser-custody/registry.json.tmp-")
			) {
				armCustodyRegistryFailureAfterSuccess = false;
				custodyRegistryWriteFailureArmed = true;
			}
		},
	};
	const opened = await openBrowserUsePaths(fs, xdg.env);
	if (!opened.ok) throw new Error(`paths refused: ${opened.refusal.code}`);
	let now = 1_000;
	return {
		deps: { fs, paths: opened.paths, clock: () => now },
		advance: (durationMs: number) => {
			now += durationMs;
		},
		armCustodyRegistryWriteFailure: () => {
			custodyRegistryWriteFailureArmed = true;
		},
		failCustodyRegistryWriteAfterNextSuccess: () => {
			armCustodyRegistryFailureAfterSuccess = true;
		},
		mutateLeaseOnRead: (
			path: string,
			atRead: number,
			mutate: (raw: string) => Promise<string>,
		) => {
			leaseReadMutation = { path, atRead, reads: 0, mutate };
		},
		realFs,
		custodyRegistryWriteFailures: () => custodyRegistryWriteFailures,
		cleanup: () => xdg.dispose(),
	};
}

const AUTHORITY = browserAuthorityIdOf({
	environmentName: "agent-chrome",
	environmentProfile: "default",
	endpointHttp: "http://127.0.0.1:9242",
	endpointWs: "ws://127.0.0.1:9242/devtools/browser/authority-a",
});

const OTHER_AUTHORITY = browserAuthorityIdOf({
	environmentName: "agent-chrome",
	environmentProfile: "other",
	endpointHttp: "http://127.0.0.1:9333",
	endpointWs: "ws://127.0.0.1:9333/devtools/browser/authority-b",
});

function creationReceipt(
	runId: string,
	rawTargetId: string,
	adapterId:
		| "agent-browser"
		| "chrome-devtools-mcp"
		| "playwright-cdp" = "agent-browser",
) {
	return {
		kind: "adapter-creation-receipt" as const,
		adapter_id: adapterId,
		run_id: runId,
		raw_target_id: rawTargetId,
	};
}

function adoptionReceipt(runId: string, rawTargetId: string) {
	const targetEnvelopeId = "a".repeat(32);
	return {
		kind: "explicit-adoption" as const,
		adapter_id: "agent-browser" as const,
		run_id: runId,
		raw_target_id: rawTargetId,
		target_envelope_id: targetEnvelopeId,
		target_candidate_id: candidateIdOf(targetEnvelopeId, [
			"cdp_target_id",
			rawTargetId,
		]),
		target_candidate_identity: { kind: "cdp-target-id" as const },
	};
}

async function retainedCleanupLease(
	state: Awaited<ReturnType<typeof fixture>>,
	input: { runId: string; rawTargetId: string; ttlMs?: number },
): Promise<TargetOperationLease> {
	state.armCustodyRegistryWriteFailure();
	const failed = await acquireTargetOperationLease(state.deps, {
		authorityId: AUTHORITY,
		runId: input.runId,
		adapterId: "agent-browser",
		rawTargetId: input.rawTargetId,
		operation: "close",
		ttlMs: input.ttlMs ?? 30_000,
		ownershipEvidence: creationReceipt(input.runId, input.rawTargetId),
		retainLeaseOnBindingFailure: true,
	});
	if (failed.ok || !("cleanup_lease" in failed)) {
		throw new Error("cleanup lease setup failed");
	}
	return failed.cleanup_lease;
}

async function custodyRegistryBytes(
	state: Awaited<ReturnType<typeof fixture>>,
): Promise<string | undefined> {
	try {
		return await state.deps.fs.readTextFile(
			`${state.deps.paths.resolution.roots.state}/browser-custody/registry.json`,
		);
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return undefined;
		throw error;
	}
}

async function establishOldAuthorityBinding(
	state: Awaited<ReturnType<typeof fixture>>,
	input: { rawTargetId: string; ttlMs?: number },
) {
	const acquired = await acquireTargetOperationLease(state.deps, {
		authorityId: AUTHORITY,
		runId: "OldRun",
		adapterId: "agent-browser",
		rawTargetId: input.rawTargetId,
		operation: "read",
		ttlMs: input.ttlMs ?? 30_000,
		ownershipEvidence: creationReceipt("OldRun", input.rawTargetId),
	});
	if (!acquired.ok) throw new Error("old authority setup failed");
	return acquired.lease;
}

async function attemptNewAuthorityBinding(
	state: Awaited<ReturnType<typeof fixture>>,
	rawTargetId: string,
) {
	return await acquireTargetOperationLease(state.deps, {
		authorityId: OTHER_AUTHORITY,
		runId: "NewRun",
		adapterId: "agent-browser",
		rawTargetId,
		operation: "read",
		ttlMs: 30_000,
		ownershipEvidence: creationReceipt("NewRun", rawTargetId),
	});
}

describe("Browser custody", () => {
	test("custody tombstones reject impossible status and owner combinations", () => {
		const base = {
			contract: "browser-use.browser-custody",
			schema_version: "1",
			authority_id: "a".repeat(64),
			revision: 1,
			targets: {},
		};
		for (const binding of [
			{
				status: "released",
				owner_run_id: "run-that-must-not-survive-release",
				adapters: ["agent-browser"],
				ownership_provenance: "adapter-creation-receipt",
				expires_at_epoch_ms: 0,
				revision: 1,
			},
			{
				status: "owned",
				owner_run_id: null,
				adapters: ["agent-browser"],
				ownership_provenance: "adapter-creation-receipt",
				expires_at_epoch_ms: 10_000,
				revision: 1,
			},
		]) {
			expect(
				parseBrowserCustodyRegistry(
					JSON.stringify({
						...base,
						targets: { ["b".repeat(64)]: binding },
					}),
				),
			).toBeUndefined();
		}
	});

	test("released old authority binding allows new authority ownership", async () => {
		const state = await fixture();
		try {
			const oldLease = await establishOldAuthorityBinding(state, {
				rawTargetId: "old-released",
			});
			await releaseTargetOperationLease(state.deps, oldLease);
			expect(await releaseRunTargetOwnership(state.deps, "OldRun")).toEqual({
				ok: true,
				released: 1,
			});
			expect(
				await ownedTargetRefsForRun(state.deps, {
					authorityId: OTHER_AUTHORITY,
					runId: "NewRun",
					adapterId: "agent-browser",
				}),
			).toEqual({ ok: true, targetRefs: [] });

			const acquired = await attemptNewAuthorityBinding(
				state,
				"new-after-release",
			);
			expect(acquired).toMatchObject({ ok: true, first_ownership: true });
			if (acquired.ok) await releaseTargetOperationLease(state.deps, acquired.lease);
		} finally {
			await state.cleanup();
		}
	});

	test("expired old authority binding allows new authority ownership", async () => {
		const state = await fixture();
		try {
			const oldLease = await establishOldAuthorityBinding(state, {
				rawTargetId: "old-expired",
				ttlMs: 100,
			});
			state.advance(101);
			expect(
				await ownedTargetRefsForRun(state.deps, {
					authorityId: OTHER_AUTHORITY,
					runId: "NewRun",
					adapterId: "agent-browser",
				}),
			).toEqual({ ok: true, targetRefs: [] });

			const acquired = await attemptNewAuthorityBinding(
				state,
				"new-after-expiry",
			);
			expect(acquired).toMatchObject({ ok: true, first_ownership: true });
			if (acquired.ok) await releaseTargetOperationLease(state.deps, acquired.lease);
			await releaseTargetOperationLease(state.deps, oldLease);
		} finally {
			await state.cleanup();
		}
	});

	test("live old authority binding blocks new authority ownership", async () => {
		const state = await fixture();
		try {
			const oldLease = await establishOldAuthorityBinding(state, {
				rawTargetId: "old-live-binding",
			});
			await releaseTargetOperationLease(state.deps, oldLease);

			expect(
				await ownedTargetRefsForRun(state.deps, {
					authorityId: OTHER_AUTHORITY,
					runId: "NewRun",
					adapterId: "agent-browser",
				}),
			).toMatchObject({ ok: false, code: "browser_authority_changed" });
			expect(
				await attemptNewAuthorityBinding(state, "new-blocked-by-binding"),
			).toMatchObject({ ok: false, code: "browser_authority_changed" });
		} finally {
			await state.cleanup();
		}
	});

	test("live old authority target-operation lease blocks new authority ownership", async () => {
		const state = await fixture();
		try {
			const oldLease = await establishOldAuthorityBinding(state, {
				rawTargetId: "old-live-operation",
			});
			expect(await releaseRunTargetOwnership(state.deps, "OldRun")).toEqual({
				ok: true,
				released: 1,
			});

			expect(
				await ownedTargetRefsForRun(state.deps, {
					authorityId: OTHER_AUTHORITY,
					runId: "NewRun",
					adapterId: "agent-browser",
				}),
			).toMatchObject({ ok: false, code: "browser_authority_changed" });
			expect(
				await attemptNewAuthorityBinding(state, "new-blocked-by-operation"),
			).toMatchObject({ ok: false, code: "browser_authority_changed" });
			await releaseTargetOperationLease(state.deps, oldLease);
		} finally {
			await state.cleanup();
		}
	});

	test("live old authority Browser Lane lease blocks new authority ownership", async () => {
		const state = await fixture();
		try {
			const oldTargetLease = await establishOldAuthorityBinding(state, {
				rawTargetId: "old-browser-lane",
			});
			await releaseTargetOperationLease(state.deps, oldTargetLease);
			await releaseRunTargetOwnership(state.deps, "OldRun");
			const oldBrowserLane = await acquireBrowserLaneLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "OldRun",
				mutation: "target-topology",
				ttlMs: 30_000,
			});
			if (!oldBrowserLane.ok) throw new Error("old Browser Lane setup failed");

			expect(
				await ownedTargetRefsForRun(state.deps, {
					authorityId: OTHER_AUTHORITY,
					runId: "NewRun",
					adapterId: "agent-browser",
				}),
			).toMatchObject({ ok: false, code: "browser_authority_changed" });
			expect(
				await attemptNewAuthorityBinding(state, "new-blocked-by-browser-lane"),
			).toMatchObject({ ok: false, code: "browser_authority_changed" });
			await releaseBrowserLaneLease(state.deps, oldBrowserLane.lease);
		} finally {
			await state.cleanup();
		}
	});

	test("one run retains ownership across adapter changes and another run refuses", async () => {
		const state = await fixture();
		try {
			const created = await acquireTargetOperationLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "Alpha",
				adapterId: "agent-browser",
				rawTargetId: "target-alpha",
				operation: "read",
				ttlMs: 30_000,
				ownershipEvidence: creationReceipt("Alpha", "target-alpha"),
			});
			expect(created).toMatchObject({ ok: true, first_ownership: true });
			if (!created.ok) throw new Error("creation failed");
			await releaseTargetOperationLease(state.deps, created.lease);

			const crossAdapter = await acquireTargetOperationLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "Alpha",
				adapterId: "playwright-cdp",
				rawTargetId: "target-alpha",
				operation: "action",
				ttlMs: 30_000,
			});
			expect(crossAdapter).toMatchObject({ ok: true, first_ownership: false });
			if (!crossAdapter.ok) throw new Error("cross adapter failed");
			await releaseTargetOperationLease(state.deps, crossAdapter.lease);

			const refused = await acquireTargetOperationLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "Bravo",
				adapterId: "chrome-devtools-mcp",
				rawTargetId: "target-alpha",
				operation: "close",
				ttlMs: 30_000,
				ownershipEvidence: creationReceipt(
					"Bravo",
					"target-alpha",
					"playwright-cdp",
				),
			});
			expect(refused).toMatchObject({
				ok: false,
				code: "target_owned_by_other_run",
			});
		} finally {
			await state.cleanup();
		}
	});

	test("first ownership refuses absent or mismatched evidence", async () => {
		const state = await fixture();
		try {
			const absent = await acquireTargetOperationLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "Alpha",
				adapterId: "agent-browser",
				rawTargetId: "target-alpha",
				operation: "adopt",
				ttlMs: 30_000,
			});
			expect(absent).toMatchObject({
				ok: false,
				code: "target_ownership_evidence_invalid",
			});

			const mismatched = await acquireTargetOperationLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "Alpha",
				adapterId: "agent-browser",
				rawTargetId: "target-alpha",
				operation: "adopt",
				ttlMs: 30_000,
				ownershipEvidence: creationReceipt("Alpha", "target-other"),
			});
			expect(mismatched).toMatchObject({
				ok: false,
				code: "target_ownership_evidence_invalid",
			});

			const forgedCandidate = await acquireTargetOperationLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "Alpha",
				adapterId: "agent-browser",
				rawTargetId: "target-forged",
				operation: "adopt",
				ttlMs: 30_000,
				ownershipEvidence: {
					kind: "explicit-adoption",
					adapter_id: "agent-browser",
					run_id: "Alpha",
					raw_target_id: "target-forged",
					target_envelope_id: "a".repeat(32),
					target_candidate_id: "b".repeat(24),
					target_candidate_identity: { kind: "cdp-target-id" },
				},
			});
			expect(forgedCandidate).toMatchObject({
				ok: false,
				code: "target_ownership_evidence_invalid",
			});
		} finally {
			await state.cleanup();
		}
	});

	test("bounded real concurrency produces one target owner", async () => {
		const state = await fixture();
		try {
			const inputs = ["Alpha", "Bravo"].map((runId) =>
				acquireTargetOperationLease(state.deps, {
					authorityId: AUTHORITY,
					runId,
					adapterId: "agent-browser" as const,
					rawTargetId: "target-race",
					operation: "read" as const,
					ttlMs: 30_000,
					ownershipEvidence: creationReceipt(runId, "target-race"),
				}),
			);
			const results = await Promise.all(inputs);
			expect(results.filter((result) => result.ok)).toHaveLength(1);
			expect(results.filter((result) => !result.ok)).toHaveLength(1);
			expect(results.find((result) => !result.ok)).toMatchObject({
				code: "target_lease_held",
			});
			for (const result of results) {
				if (result.ok) await releaseTargetOperationLease(state.deps, result.lease);
			}
		} finally {
			await state.cleanup();
		}
	});

	test("an expired owner cannot permanently strand a target", async () => {
		const state = await fixture();
		try {
			const alpha = await acquireTargetOperationLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "Alpha",
				adapterId: "agent-browser",
				rawTargetId: "target-recoverable",
				operation: "read",
				ttlMs: 100,
				ownershipEvidence: creationReceipt("Alpha", "target-recoverable"),
			});
			if (!alpha.ok) throw new Error("alpha setup failed");
			await releaseTargetOperationLease(state.deps, alpha.lease);
			state.advance(101);

			const bravo = await acquireTargetOperationLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "Bravo",
				adapterId: "chrome-devtools-mcp",
				rawTargetId: "target-recoverable",
				operation: "read",
				ttlMs: 100,
				ownershipEvidence: creationReceipt(
					"Bravo",
					"target-recoverable",
					"chrome-devtools-mcp",
				),
			});
			expect(bravo).toMatchObject({ ok: true, first_ownership: true });
			if (bravo.ok) await releaseTargetOperationLease(state.deps, bravo.lease);
		} finally {
			await state.cleanup();
		}
	});

	test("a Target Lease heartbeat extends both operation custody and target ownership", async () => {
		const state = await fixture();
		try {
			const acquired = await acquireTargetOperationLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "Alpha",
				adapterId: "agent-browser",
				rawTargetId: "target-renewed",
				operation: "read",
				ttlMs: 100,
				ownershipEvidence: creationReceipt("Alpha", "target-renewed"),
			});
			if (!acquired.ok) throw new Error("target setup failed");
			state.advance(60);
			const heartbeat = await heartbeatTargetOperationLease(
				state.deps,
				acquired.lease,
				{ ttlMs: 100 },
			);
			expect(heartbeat.ok).toBe(true);
			if (!heartbeat.ok) throw new Error("target heartbeat failed");
			await releaseTargetOperationLease(state.deps, heartbeat.lease);
			state.advance(60);

			const sameRun = await acquireTargetOperationLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "Alpha",
				adapterId: "playwright-cdp",
				rawTargetId: "target-renewed",
				operation: "action",
				ttlMs: 100,
			});
			expect(sameRun).toMatchObject({ ok: true, first_ownership: false });
			if (sameRun.ok) {
				await releaseTargetOperationLease(state.deps, sameRun.lease);
			}
		} finally {
			await state.cleanup();
		}
	});

	test("Browser Lane contention refuses before mutation and admits after release", async () => {
		const state = await fixture();
		try {
			const alpha = await acquireBrowserLaneLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "Alpha",
				mutation: "viewport",
				ttlMs: 30_000,
			});
			expect(alpha.ok).toBe(true);
			if (!alpha.ok) throw new Error("alpha lane failed");
			const bravoHeld = await acquireBrowserLaneLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "Bravo",
				mutation: "capture",
				ttlMs: 30_000,
			});
			expect(bravoHeld).toMatchObject({ ok: false, code: "browser_lane_held" });
			await releaseBrowserLaneLease(state.deps, alpha.lease);
			const bravo = await acquireBrowserLaneLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "Bravo",
				mutation: "capture",
				ttlMs: 30_000,
			});
			expect(bravo.ok).toBe(true);
			if (bravo.ok) await releaseBrowserLaneLease(state.deps, bravo.lease);
		} finally {
			await state.cleanup();
		}
	});

	test("a Browser Lane heartbeat keeps a second run fenced past the original expiry", async () => {
		const state = await fixture();
		try {
			const acquired = await acquireBrowserLaneLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "Alpha",
				mutation: "capture",
				ttlMs: 100,
			});
			if (!acquired.ok) throw new Error("lane setup failed");
			state.advance(60);
			const heartbeat = await heartbeatBrowserLaneLease(
				state.deps,
				acquired.lease,
				{ ttlMs: 100 },
			);
			expect(heartbeat.ok).toBe(true);
			if (!heartbeat.ok) throw new Error("lane heartbeat failed");
			state.advance(60);
			const refused = await acquireBrowserLaneLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "Bravo",
				mutation: "viewport",
				ttlMs: 100,
			});
			expect(refused).toMatchObject({ ok: false, code: "browser_lane_held" });
			await releaseBrowserLaneLease(state.deps, heartbeat.lease);
		} finally {
			await state.cleanup();
		}
	});

	test("releasing one run preserves another run's target ownership", async () => {
		const state = await fixture();
		try {
			for (const [runId, targetId] of [
				["Alpha", "target-alpha"],
				["Bravo", "target-bravo"],
			] as const) {
				const acquired = await acquireTargetOperationLease(state.deps, {
					authorityId: AUTHORITY,
					runId,
					adapterId: "agent-browser",
					rawTargetId: targetId,
					operation: "read",
					ttlMs: 30_000,
					ownershipEvidence: creationReceipt(runId, targetId),
				});
				if (!acquired.ok) throw new Error("target setup failed");
				await releaseTargetOperationLease(state.deps, acquired.lease);
			}
			expect(await releaseRunTargetOwnership(state.deps, "Alpha")).toEqual({
				ok: true,
				released: 1,
			});
			const bravo = await acquireTargetOperationLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "Bravo",
				adapterId: "playwright-cdp",
				rawTargetId: "target-bravo",
				operation: "read",
				ttlMs: 30_000,
			});
			expect(bravo).toMatchObject({ ok: true, first_ownership: false });
			if (bravo.ok) await releaseTargetOperationLease(state.deps, bravo.lease);
		} finally {
			await state.cleanup();
		}
	});

	test("owned target refs require exact authority, run, adapter, and creation provenance", async () => {
		const state = await fixture();
		try {
			for (const [runId, adapterId, targetId] of [
				["Alpha", "agent-browser", "target-exact"],
				["Bravo", "agent-browser", "target-other-run"],
				["Alpha", "playwright-cdp", "target-other-adapter"],
				["Alpha", "agent-browser", "target-explicit-adoption"],
				["Alpha", "agent-browser", "target-legacy"],
			] as const) {
				const acquired = await acquireTargetOperationLease(state.deps, {
					authorityId: AUTHORITY,
					runId,
					adapterId,
					rawTargetId: targetId,
					operation: "read",
					ttlMs: 30_000,
					ownershipEvidence: creationReceipt(runId, targetId, adapterId),
				});
				if (!acquired.ok) throw new Error(`target setup failed: ${targetId}`);
				await releaseTargetOperationLease(state.deps, acquired.lease);
			}

			const registryPath = `${state.deps.paths.resolution.roots.state}/browser-custody/registry.json`;
			const registry = JSON.parse(
				await state.deps.fs.readTextFile(registryPath),
			) as {
				targets: Record<string, { ownership_provenance?: string }>;
			};
			registry.targets[TARGET_REFS.explicitAdoption].ownership_provenance =
				"explicit-adoption";
			delete registry.targets[TARGET_REFS.legacy].ownership_provenance;
			await state.deps.fs.writeFileDurable(
				registryPath,
				`${JSON.stringify(registry)}\n`,
				0o600,
			);

			expect(
				await ownedTargetRefsForRun(state.deps, {
					authorityId: AUTHORITY,
					runId: "Alpha",
					adapterId: "agent-browser",
				}),
			).toEqual({
				ok: true,
				targetRefs: [TARGET_REFS.exact],
			});
			expect(
				await ownedTargetRefsForRun(state.deps, {
					authorityId: OTHER_AUTHORITY,
					runId: "Alpha",
					adapterId: "agent-browser",
				}),
			).toMatchObject({ ok: false, code: "browser_authority_changed" });
		} finally {
			await state.cleanup();
		}
	});

	test("exact target ref release fails closed across authorities and releases only its matching ref", async () => {
		const state = await fixture();
		try {
			for (const targetId of ["target-release", "target-preserved"] as const) {
				const acquired = await acquireTargetOperationLease(state.deps, {
					authorityId: AUTHORITY,
					runId: "Alpha",
					adapterId: "agent-browser",
					rawTargetId: targetId,
					operation: "read",
					ttlMs: 30_000,
					ownershipEvidence: creationReceipt("Alpha", targetId),
				});
				if (!acquired.ok) throw new Error(`target setup failed: ${targetId}`);
				await releaseTargetOperationLease(state.deps, acquired.lease);
			}

			const targetRef = TARGET_REFS.release;
			expect(
				await releaseExactTargetOwnershipByRef(state.deps, {
					authorityId: OTHER_AUTHORITY,
					runId: "Alpha",
					targetRef,
				}),
			).toMatchObject({ ok: false, code: "browser_authority_changed" });
			expect(
				await ownedTargetRefsForRun(state.deps, {
					authorityId: AUTHORITY,
					runId: "Alpha",
					adapterId: "agent-browser",
				}),
			).toEqual({
				ok: true,
				targetRefs: [targetRef, TARGET_REFS.preserved].sort(),
			});

			expect(
				await releaseExactTargetOwnershipByRef(state.deps, {
					authorityId: AUTHORITY,
					runId: "Alpha",
					targetRef,
				}),
			).toEqual({ ok: true, released: true });
			expect(
				await ownedTargetRefsForRun(state.deps, {
					authorityId: AUTHORITY,
					runId: "Alpha",
					adapterId: "agent-browser",
				}),
			).toEqual({
				ok: true,
				targetRefs: [TARGET_REFS.preserved],
			});
		} finally {
			await state.cleanup();
		}
	});

	test("retained cleanup lease is limited to an absent creation binding whose first write fails", async () => {
		const state = await fixture({ failFirstCustodyRegistryWrite: true });
		try {
			const failed = await acquireTargetOperationLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "Alpha",
				adapterId: "agent-browser",
				rawTargetId: "target-first-write-failure",
				operation: "close",
				ttlMs: 30_000,
				ownershipEvidence: creationReceipt(
					"Alpha",
					"target-first-write-failure",
				),
				retainLeaseOnBindingFailure: true,
			});
			expect(failed).toMatchObject({
				ok: false,
				code: "target_lease_store_failed",
				failure_stage:
					"first_ownership_persistence_failed_after_no_live_binding",
				cleanup_lease: {
					authority_id: AUTHORITY,
					run_id: "Alpha",
					adapter_id: "agent-browser",
					operation: "close",
				},
			});
			expect(state.custodyRegistryWriteFailures()).toBe(1);
			if (failed.ok || !("cleanup_lease" in failed)) {
				throw new Error("expected exact cleanup lease authority");
			}
			expect(
				await releaseTargetOperationLease(state.deps, failed.cleanup_lease),
			).toEqual({ ok: true, released_at_epoch_ms: 1_000 });

			const retried = await acquireTargetOperationLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "Alpha",
				adapterId: "agent-browser",
				rawTargetId: "target-first-write-failure",
				operation: "close",
				ttlMs: 30_000,
				ownershipEvidence: creationReceipt(
					"Alpha",
					"target-first-write-failure",
				),
				retainLeaseOnBindingFailure: true,
			});
			expect(retried).toMatchObject({ ok: true, first_ownership: true });
			if (retried.ok) {
				await releaseTargetOperationLease(state.deps, retried.lease);
			}
		} finally {
			await state.cleanup();
		}
	});

	test("other-run ownership never grants cleanup lease authority", async () => {
		const state = await fixture();
		try {
			const owned = await acquireTargetOperationLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "Alpha",
				adapterId: "agent-browser",
				rawTargetId: "target-other-run-retain",
				operation: "read",
				ttlMs: 30_000,
				ownershipEvidence: creationReceipt("Alpha", "target-other-run-retain"),
			});
			if (!owned.ok) throw new Error("ownership setup failed");
			await releaseTargetOperationLease(state.deps, owned.lease);

			const refused = await acquireTargetOperationLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "Bravo",
				adapterId: "agent-browser",
				rawTargetId: "target-other-run-retain",
				operation: "close",
				ttlMs: 30_000,
				ownershipEvidence: creationReceipt("Bravo", "target-other-run-retain"),
				retainLeaseOnBindingFailure: true,
			});
			expect(refused).toMatchObject({
				ok: false,
				code: "target_owned_by_other_run",
			});
			expect("cleanup_lease" in refused).toBe(false);
		} finally {
			await state.cleanup();
		}
	});

	test("explicit adoption persistence failure never grants creator cleanup lease authority", async () => {
		const state = await fixture({ failFirstCustodyRegistryWrite: true });
		try {
			const refused = await acquireTargetOperationLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "Alpha",
				adapterId: "agent-browser",
				rawTargetId: "target-adoption-retain",
				operation: "close",
				ttlMs: 30_000,
				ownershipEvidence: adoptionReceipt("Alpha", "target-adoption-retain"),
				retainLeaseOnBindingFailure: true,
			});
			expect(refused).toMatchObject({
				ok: false,
				code: "target_lease_store_failed",
			});
			expect("cleanup_lease" in refused).toBe(false);
			expect(state.custodyRegistryWriteFailures()).toBe(1);
		} finally {
			await state.cleanup();
		}
	});

	test("released binding creation persistence failure grants exact cleanup lease authority", async () => {
		const state = await fixture();
		try {
			const acquired = await acquireTargetOperationLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "Alpha",
				adapterId: "agent-browser",
				rawTargetId: "target-released-retain",
				operation: "read",
				ttlMs: 30_000,
				ownershipEvidence: creationReceipt("Alpha", "target-released-retain"),
			});
			if (!acquired.ok) throw new Error("released-binding setup failed");
			await releaseTargetOperationLease(state.deps, acquired.lease);
			expect(await releaseRunTargetOwnership(state.deps, "Alpha")).toEqual({
				ok: true,
				released: 1,
			});
			state.armCustodyRegistryWriteFailure();

			const failed = await acquireTargetOperationLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "Alpha",
				adapterId: "agent-browser",
				rawTargetId: "target-released-retain",
				operation: "close",
				ttlMs: 30_000,
				ownershipEvidence: creationReceipt("Alpha", "target-released-retain"),
				retainLeaseOnBindingFailure: true,
			});
			expect(failed).toMatchObject({
				ok: false,
				code: "target_lease_store_failed",
				failure_stage:
					"first_ownership_persistence_failed_after_no_live_binding",
				cleanup_lease: {
					authority_id: AUTHORITY,
					run_id: "Alpha",
					adapter_id: "agent-browser",
					operation: "close",
				},
			});
			expect(state.custodyRegistryWriteFailures()).toBe(1);
			if (failed.ok || !("cleanup_lease" in failed)) {
				throw new Error("expected released-binding cleanup lease authority");
			}
			expect(
				await releaseTargetOperationLease(state.deps, failed.cleanup_lease),
			).toEqual({ ok: true, released_at_epoch_ms: 1_000 });
		} finally {
			await state.cleanup();
		}
	});

	test("expired binding creation persistence failure grants exact cleanup lease authority", async () => {
		const state = await fixture();
		try {
			const acquired = await acquireTargetOperationLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "Alpha",
				adapterId: "agent-browser",
				rawTargetId: "target-expired-retain",
				operation: "read",
				ttlMs: 100,
				ownershipEvidence: creationReceipt("Alpha", "target-expired-retain"),
			});
			if (!acquired.ok) throw new Error("expired-binding setup failed");
			await releaseTargetOperationLease(state.deps, acquired.lease);
			state.advance(101);
			state.armCustodyRegistryWriteFailure();

			const failed = await acquireTargetOperationLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "Bravo",
				adapterId: "agent-browser",
				rawTargetId: "target-expired-retain",
				operation: "close",
				ttlMs: 30_000,
				ownershipEvidence: creationReceipt("Bravo", "target-expired-retain"),
				retainLeaseOnBindingFailure: true,
			});
			expect(failed).toMatchObject({
				ok: false,
				code: "target_lease_store_failed",
				failure_stage:
					"first_ownership_persistence_failed_after_no_live_binding",
				cleanup_lease: {
					authority_id: AUTHORITY,
					run_id: "Bravo",
					adapter_id: "agent-browser",
					operation: "close",
				},
			});
			expect(state.custodyRegistryWriteFailures()).toBe(1);
			if (failed.ok || !("cleanup_lease" in failed)) {
				throw new Error("expected expired-binding cleanup lease authority");
			}
			expect(
				await releaseTargetOperationLease(state.deps, failed.cleanup_lease),
			).toEqual({ ok: true, released_at_epoch_ms: 1_101 });
		} finally {
			await state.cleanup();
		}
	});

	test("authority change and mismatched-authority persistence failure never grant cleanup lease authority", async () => {
		const state = await fixture({ failFirstCustodyRegistryWrite: true });
		try {
			const registryPath = `${state.deps.paths.resolution.roots.state}/browser-custody/registry.json`;
			await state.deps.fs.mkdir(
				`${state.deps.paths.resolution.roots.state}/browser-custody`,
				{ recursive: true, mode: 0o700 },
			);
			await state.deps.fs.writeFileDurable(
				registryPath,
				`${JSON.stringify({
					contract: "browser-use.browser-custody",
					schema_version: "1",
					authority_id: AUTHORITY,
					revision: 1,
					targets: {},
				})}\n`,
				0o600,
			);

			const mismatched = await acquireTargetOperationLease(state.deps, {
				authorityId: OTHER_AUTHORITY,
				runId: "Alpha",
				adapterId: "agent-browser",
				rawTargetId: "target-authority-mismatch",
				operation: "close",
				ttlMs: 30_000,
				ownershipEvidence: creationReceipt(
					"Alpha",
					"target-authority-mismatch",
				),
				retainLeaseOnBindingFailure: true,
			});
			expect(mismatched).toMatchObject({
				ok: false,
				code: "target_lease_store_failed",
			});
			expect("cleanup_lease" in mismatched).toBe(false);
			expect(state.custodyRegistryWriteFailures()).toBe(1);

			const owner = await acquireTargetOperationLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "Owner",
				adapterId: "agent-browser",
				rawTargetId: "target-authority-change-owner",
				operation: "read",
				ttlMs: 30_000,
				ownershipEvidence: creationReceipt(
					"Owner",
					"target-authority-change-owner",
				),
			});
			if (!owner.ok) throw new Error("authority ownership setup failed");
			await releaseTargetOperationLease(state.deps, owner.lease);

			const changed = await acquireTargetOperationLease(state.deps, {
				authorityId: OTHER_AUTHORITY,
				runId: "Bravo",
				adapterId: "agent-browser",
				rawTargetId: "target-authority-change-new",
				operation: "close",
				ttlMs: 30_000,
				ownershipEvidence: creationReceipt(
					"Bravo",
					"target-authority-change-new",
				),
				retainLeaseOnBindingFailure: true,
			});
			expect(changed).toMatchObject({
				ok: false,
				code: "browser_authority_changed",
			});
			expect("cleanup_lease" in changed).toBe(false);
		} finally {
			await state.cleanup();
		}
	});

	test("invalid creation evidence never grants cleanup lease authority", async () => {
		const state = await fixture();
		try {
			const refused = await acquireTargetOperationLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "Alpha",
				adapterId: "agent-browser",
				rawTargetId: "target-invalid-retain",
				operation: "close",
				ttlMs: 30_000,
				ownershipEvidence: creationReceipt("Alpha", "target-other"),
				retainLeaseOnBindingFailure: true,
			});
			expect(refused).toMatchObject({
				ok: false,
				code: "target_ownership_evidence_invalid",
			});
			expect("cleanup_lease" in refused).toBe(false);
		} finally {
			await state.cleanup();
		}
	});

	test("corrupt custody registry never grants cleanup lease authority", async () => {
		const state = await fixture();
		try {
			const registryDirectory = `${state.deps.paths.resolution.roots.state}/browser-custody`;
			await state.deps.fs.mkdir(registryDirectory, {
				recursive: true,
				mode: 0o700,
			});
			await state.deps.fs.writeFileDurable(
				`${registryDirectory}/registry.json`,
				"not-json\n",
				0o600,
			);

			const refused = await acquireTargetOperationLease(state.deps, {
				authorityId: AUTHORITY,
				runId: "Alpha",
				adapterId: "agent-browser",
				rawTargetId: "target-corrupt-retain",
				operation: "close",
				ttlMs: 30_000,
				ownershipEvidence: creationReceipt("Alpha", "target-corrupt-retain"),
				retainLeaseOnBindingFailure: true,
			});
			expect(refused).toMatchObject({
				ok: false,
				code: "target_lease_store_failed",
			});
			expect("cleanup_lease" in refused).toBe(false);
		} finally {
			await state.cleanup();
		}
	});

	test("expired topology cleanup lease cannot persist target ownership", async () => {
		const state = await fixture();
		try {
			const cleanupLease = await retainedCleanupLease(state, {
				runId: "Alpha",
				rawTargetId: "target-expired-cleanup-persist",
				ttlMs: 100,
			});
			const before = await custodyRegistryBytes(state);
			state.advance(101);

			const refused = await persistTargetOwnershipUnderCleanupLease(
				state.deps,
				{
					lease: cleanupLease,
					authorityId: AUTHORITY,
					runId: "Alpha",
					adapterId: "agent-browser",
					rawTargetId: "target-expired-cleanup-persist",
					ttlMs: 30_000,
				},
			);
			expect(refused).toMatchObject({
				ok: false,
				code: "target_lease_lost",
			});
			expect(await custodyRegistryBytes(state)).toBe(before);
			await releaseTargetOperationLease(state.deps, cleanupLease);
		} finally {
			await state.cleanup();
		}
	});

	test("recovered successor token fences the prior topology cleanup lease without registry mutation", async () => {
		const state = await fixture();
		try {
			const cleanupLease = await retainedCleanupLease(state, {
				runId: "Alpha",
				rawTargetId: "target-recovered-cleanup-persist",
				ttlMs: 100,
			});
			state.advance(101);
			const successor = await acquireLease(state.deps, {
				key: cleanupLease.lease.key,
				holderId: "browser-target-run:Successor",
				ttlMs: 30_000,
				scope: cleanupLease.lease.scope,
			});
			if (!successor.ok) throw new Error("successor lease setup failed");
			expect(successor.lease.fencing_token).toBe(
				cleanupLease.lease.fencing_token + 1,
			);
			expect(successor.lease.recovered_from).toMatchObject({
				fencing_token: cleanupLease.lease.fencing_token,
				holder_id: cleanupLease.lease.holder_id,
			});
			const before = await custodyRegistryBytes(state);

			const refused = await persistTargetOwnershipUnderCleanupLease(
				state.deps,
				{
					lease: cleanupLease,
					authorityId: AUTHORITY,
					runId: "Alpha",
					adapterId: "agent-browser",
					rawTargetId: "target-recovered-cleanup-persist",
					ttlMs: 30_000,
				},
			);
			expect(refused).toMatchObject({
				ok: false,
				code: "target_lease_lost",
			});
			expect(await custodyRegistryBytes(state)).toBe(before);
			await releaseTargetOperationLease(state.deps, cleanupLease);
			await releaseLease(state.deps, successor.lease);
		} finally {
			await state.cleanup();
		}
	});

	test("mismatched and forged topology cleanup lease payloads cause zero registry mutation", async () => {
		const state = await fixture();
		let cleanupLease: TargetOperationLease | undefined;
		try {
			cleanupLease = await retainedCleanupLease(state, {
				runId: "Alpha",
				rawTargetId: "target-exact-cleanup-persist",
			});
			const forgedTargetRef = targetRefOf("target-forged-cleanup-persist");
			const variants: Array<{
				name: string;
				lease: TargetOperationLease;
			}> = [
				{
					name: "wrong authority",
					lease: { ...cleanupLease, authority_id: OTHER_AUTHORITY },
				},
				{
					name: "wrong run",
					lease: { ...cleanupLease, run_id: "Bravo" },
				},
				{
					name: "wrong adapter",
					lease: { ...cleanupLease, adapter_id: "playwright-cdp" },
				},
				{
					name: "wrong target ref",
					lease: { ...cleanupLease, target_ref: forgedTargetRef },
				},
				{
					name: "forged lease payload",
					lease: {
						...cleanupLease,
						lease: {
							...cleanupLease.lease,
							expires_at_epoch_ms:
								cleanupLease.lease.expires_at_epoch_ms + 10_000,
						},
					},
				},
			];

			for (const variant of variants) {
				const before = await custodyRegistryBytes(state);
				const refused = await persistTargetOwnershipUnderCleanupLease(
					state.deps,
					{
						lease: variant.lease,
						authorityId: AUTHORITY,
						runId: "Alpha",
						adapterId: "agent-browser",
						rawTargetId: "target-exact-cleanup-persist",
						ttlMs: 30_000,
					},
				);
				if (refused.ok) {
					throw new Error(`${variant.name} cleanup lease was accepted`);
				}
				if ((await custodyRegistryBytes(state)) !== before) {
					throw new Error(`${variant.name} cleanup lease mutated the registry`);
				}
			}
		} finally {
			if (cleanupLease !== undefined) {
				await releaseTargetOperationLease(state.deps, cleanupLease);
				await releaseExactTargetOwnershipByRef(state.deps, {
					authorityId: AUTHORITY,
					runId: "Alpha",
					targetRef: cleanupLease.target_ref,
				});
			}
			await state.cleanup();
		}
	});

	test("post-validation lease loss with failed exact ownership rollback exposes unresolved cleanup debt", async () => {
		const state = await fixture();
		try {
			const cleanupLease = await retainedCleanupLease(state, {
				runId: "Alpha",
				rawTargetId: "target-unresolved-cleanup-debt",
			});
			const leasePath = leaseRecordPath(
				state.deps.paths,
				cleanupLease.lease.key,
			);
			state.mutateLeaseOnRead(leasePath, 3, async (raw) => {
				const current = JSON.parse(raw) as Record<string, unknown> & {
					payload: Record<string, unknown> & {
						fencing_token: number;
						holder_id: string;
						expires_at_epoch_ms: number;
					};
				};
				const successor = {
					...current,
					payload: {
						...current.payload,
						holder_id: "browser-target-run:Successor",
						fencing_token: current.payload.fencing_token + 1,
						heartbeat_at_epoch_ms: 1_001,
						expires_at_epoch_ms: current.payload.expires_at_epoch_ms + 30_000,
						recovered_from: {
							fencing_token: current.payload.fencing_token,
							holder_id: current.payload.holder_id,
							observed_expired_at_epoch_ms: 1_000,
						},
					},
				};
				const replacement = `${JSON.stringify(successor)}\n`;
				await state.realFs.writeFileDurable(leasePath, replacement, 0o600);
				return replacement;
			});
			state.failCustodyRegistryWriteAfterNextSuccess();

			const failed = await persistTargetOwnershipUnderCleanupLease(state.deps, {
				lease: cleanupLease,
				authorityId: AUTHORITY,
				runId: "Alpha",
				adapterId: "agent-browser",
				rawTargetId: "target-unresolved-cleanup-debt",
				ttlMs: 30_000,
			});
			expect(failed).toMatchObject({
				ok: false,
				code: "target_lease_lost",
				cleanup_debt: ["target-ownership-rollback-failed"],
			});
			if (failed.ok)
				throw new Error("expected explicit unresolved cleanup debt");
			expect(failed.message).toContain("rollback is unresolved");
			expect(failed.message).not.toContain("was rolled back");

			const registry = JSON.parse(
				(await custodyRegistryBytes(state)) ?? "null",
			) as {
				targets: Record<
					string,
					{ owner_run_id: string | null; status: string }
				>;
			};
			expect(registry.targets[cleanupLease.target_ref]).toMatchObject({
				owner_run_id: "Alpha",
				status: "owned",
			});
			expect(
				await releaseExactTargetOwnershipByRef(state.deps, {
					authorityId: AUTHORITY,
					runId: "Alpha",
					targetRef: cleanupLease.target_ref,
				}),
			).toEqual({ ok: true, released: true });
		} finally {
			await state.cleanup();
		}
	});
});
