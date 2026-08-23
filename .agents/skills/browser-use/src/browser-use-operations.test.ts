import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	BROWSER_USE_OPERATION_CONTRACT_ID,
	BROWSER_USE_OPERATION_SCHEMA_VERSION,
} from "./command-contract";
import { type BrowserUseRuntime, runForTest } from "./browser-use";
import {
	candidateIdOf,
	handoffEvidenceIdOf,
	targetEnvelopeIdOf,
} from "./browser-use-core";
import type {
	McporterCommandInput,
	McporterCommandResult,
} from "./mcporter-transport";
import {
	commandJsonArgs,
	commandVector,
	enoent,
	listPagesStdout,
	makeRuntime,
	okCommand,
	parseJson,
	TARGETS_CONTRACT,
} from "./browser-use-test-helpers";
import {
	REAL_VERIFIED_HANDOFF_ENVELOPE,
	connectFailureEnvelope,
	verifiedHandoffEnvelope,
} from "./browser-connect-handoff-fixtures";
import { makeTempXdgEnv } from "./browser-use-platform-test-helpers";
import {
	type BrowserUsePlatformFs,
	createDefaultPlatformFs,
	openBrowserUsePaths,
} from "./browser-use-paths";
import { listLeases } from "./browser-use-locks";
import { parseHandoffFacts } from "./browser-use-discovery";
import { captureBrowserUseScreenshotMedia } from "./browser-use-operations";
import { agentBrowserSuccess } from "./browser-use-agent-browser-test-fixture";
import {
	BROWSER_USE_CUSTODY_CONTRACT_ID,
	BROWSER_USE_CUSTODY_SCHEMA_VERSION,
	acquireBrowserLaneLease,
	acquireTargetOperationLease,
	browserAuthorityIdOf,
	ownedTargetRefsForRun,
	releaseBrowserLaneLease,
	releaseRunTargetOwnership,
	releaseTargetOperationLease,
} from "./browser-use-browser-custody";

// =========================================================================
// U7 Browser Operation Front Door (envelope-era contract from migration U1)
// =========================================================================

const FIXTURE_ENVELOPE = JSON.parse(REAL_VERIFIED_HANDOFF_ENVELOPE);
const FIXTURE_RUN_ID = FIXTURE_ENVELOPE.run_id as string;
const FIXTURE_EVIDENCE_ID = handoffEvidenceIdOf({
	runId: FIXTURE_ENVELOPE.run_id,
	environmentName: FIXTURE_ENVELOPE.data.environment.name,
	environmentProfile: FIXTURE_ENVELOPE.data.environment.profile,
	attachmentAdapterId: FIXTURE_ENVELOPE.data.attachment.adapter_id,
	route: FIXTURE_ENVELOPE.data.attachment.route,
	endpointHttp: FIXTURE_ENVELOPE.data.endpoint.http,
	endpointWs: FIXTURE_ENVELOPE.data.endpoint.ws,
	proofContractId: FIXTURE_ENVELOPE.data.proof.environment_contract_id,
	proofSchemaVersion: FIXTURE_ENVELOPE.data.proof.environment_schema_version,
});

// The target envelope id operate derives for the fixture handoff, computed
// through the production hash helpers so state fixtures bind to the same
// identity the pipeline resolves.
const FIXTURE_TARGET_ENVELOPE_ID = targetEnvelopeIdOf({
	runId: FIXTURE_RUN_ID,
	mode: "handoff-bound",
	adapter: "chrome-devtools-mcp",
	handoffEvidenceId: FIXTURE_EVIDENCE_ID,
});

const AGENT_BROWSER_HANDOFF = verifiedHandoffEnvelope((envelope) => {
	envelope.data.attachment.adapter_id = "agent-browser";
});
const AGENT_BROWSER_ENVELOPE = JSON.parse(AGENT_BROWSER_HANDOFF);
const AGENT_BROWSER_EVIDENCE_ID = handoffEvidenceIdOf({
	runId: AGENT_BROWSER_ENVELOPE.run_id,
	environmentName: AGENT_BROWSER_ENVELOPE.data.environment.name,
	environmentProfile: AGENT_BROWSER_ENVELOPE.data.environment.profile,
	attachmentAdapterId: AGENT_BROWSER_ENVELOPE.data.attachment.adapter_id,
	route: AGENT_BROWSER_ENVELOPE.data.attachment.route,
	endpointHttp: AGENT_BROWSER_ENVELOPE.data.endpoint.http,
	endpointWs: AGENT_BROWSER_ENVELOPE.data.endpoint.ws,
	proofContractId: AGENT_BROWSER_ENVELOPE.data.proof.environment_contract_id,
	proofSchemaVersion:
		AGENT_BROWSER_ENVELOPE.data.proof.environment_schema_version,
});
const AGENT_BROWSER_TARGET_ENVELOPE_ID = targetEnvelopeIdOf({
	runId: FIXTURE_RUN_ID,
	mode: "handoff-bound",
	adapter: "agent-browser",
	handoffEvidenceId: AGENT_BROWSER_EVIDENCE_ID,
});

const CREATED_TARGET_REFS = {
	"cdp-stable": "77b3f1d87d986c6c31cefee0e6d08448686b0c90e2aa8df16199f17b3839be19",
	"cdp-owned": "c1a486b477487adb71688104ac33a692facd3507410583be08661e1cc016817c",
	"cdp-target-a": "be34f4fc90ce224f4212af36bd682b5624256ecc60457c73abb00114d970859c",
	"cdp-target-b": "b3a60a4104cfac57f82e6b8314e4ca724028610c436872c6ad071b0c6f74054c",
} as const;

// Independent test-owned SHA-256 oracles for the fixed raw target ids below.
const OPERATION_CLEANUP_TARGET_REFS = {
	"cdp-operation-a": "987f75f6601194a7b19beb6bae53c177e789f0e566d726da9a6ae22d7dffbe61",
	"cdp-persistent-b": "d118f64511717054d803ee14ae4faf0dc0026a2170b6cc034bf73538afade7e2",
} as const;

function expectCleanupOutputRedacted(output: string, xdgBase: string): void {
	for (const privateValue of [
		"cdp-operation-a",
		"cdp-persistent-b",
		...Object.values(OPERATION_CLEANUP_TARGET_REFS),
		xdgBase,
		"/h.json",
	]) {
		expect(output).not.toContain(privateValue);
	}
}

const operationXdgCleanups: Array<() => void> = [];
afterAll(() => {
	for (const cleanup of operationXdgCleanups) cleanup();
});

function operationCandidateId(pageId = "1"): string {
	return candidateIdOf(FIXTURE_TARGET_ENVELOPE_ID, ["adapter_page_id", pageId]);
}

const FIXTURE_BROWSER_AUTHORITY = browserAuthorityIdOf({
	environmentName: FIXTURE_ENVELOPE.data.environment.name,
	environmentProfile: FIXTURE_ENVELOPE.data.environment.profile,
	endpointHttp: FIXTURE_ENVELOPE.data.endpoint.http,
	endpointWs: FIXTURE_ENVELOPE.data.endpoint.ws,
});

async function custodyDeps(runtime: BrowserUseRuntime) {
	const opened = await openBrowserUsePaths(runtime.platformFs, runtime.env);
	if (!opened.ok) throw new Error(`paths refused: ${opened.refusal.code}`);
	return {
		fs: runtime.platformFs,
		paths: opened.paths,
		clock: runtime.now,
	};
}

async function seedPersistentTarget(
	runtime: BrowserUseRuntime,
	rawTargetId: string,
) {
	const deps = await custodyDeps(runtime);
	const persistent = await acquireTargetOperationLease(deps, {
		authorityId: FIXTURE_BROWSER_AUTHORITY,
		runId: FIXTURE_RUN_ID,
		adapterId: "agent-browser",
		rawTargetId,
		operation: "read",
		ttlMs: 30_000,
		ownershipEvidence: {
			kind: "adapter-creation-receipt",
			adapter_id: "agent-browser",
			run_id: FIXTURE_RUN_ID,
			raw_target_id: rawTargetId,
		},
	});
	if (!persistent.ok) throw new Error("fixture persistent ownership failed");
	await releaseTargetOperationLease(deps, persistent.lease);
	return deps;
}

async function seedPersistentTargetB(runtime: BrowserUseRuntime) {
	return await seedPersistentTarget(runtime, "cdp-persistent-b");
}

async function targetOwnershipExpiry(
	runtime: BrowserUseRuntime,
	targetRef: string,
): Promise<number> {
	const deps = await custodyDeps(runtime);
	const raw = await deps.fs.readTextFile(
		`${deps.paths.resolution.roots.state}/browser-custody/registry.json`,
	);
	const registry = JSON.parse(raw) as {
		targets: Record<string, { expires_at_epoch_ms: number }>;
	};
	return registry.targets[targetRef]?.expires_at_epoch_ms ?? -1;
}

async function ownedRegistryTargetRefs(
	runtime: BrowserUseRuntime,
): Promise<readonly string[]> {
	const deps = await custodyDeps(runtime);
	const raw = await deps.fs.readTextFile(
		`${deps.paths.resolution.roots.state}/browser-custody/registry.json`,
	);
	const registry = JSON.parse(raw) as {
		targets: Record<
			string,
			{ owner_run_id: string | null; status: "owned" | "released" }
		>;
	};
	return Object.entries(registry.targets)
		.filter(
			([, binding]) =>
				binding.owner_run_id === FIXTURE_RUN_ID && binding.status === "owned",
		)
		.map(([targetRef]) => targetRef)
		.sort();
}

function selectedStateFile(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		contract: TARGETS_CONTRACT,
		schema_version: "2",
		run_id: FIXTURE_RUN_ID,
		selected_adapter_id: "chrome-devtools-mcp",
		verified_endpoint_identity: "127.0.0.1:9222",
		handoff_evidence_id: FIXTURE_EVIDENCE_ID,
		target_envelope_id: FIXTURE_TARGET_ENVELOPE_ID,
		target_candidate_id: operationCandidateId(),
		selected_candidate_ordinal: 1,
		emitted_at_ms: 1_000,
		expires_at_ms: 1_000 + 15 * 60_000,
		display: { origin: "https://example.com", path_shape: "/app", title: "App" },
		...overrides,
	});
}

function createdSelectedStateFile(
	rawTargetId: keyof typeof CREATED_TARGET_REFS,
	overrides: Record<string, unknown> = {},
): string {
	return selectedStateFile({
		selected_adapter_id: "agent-browser",
		handoff_evidence_id: AGENT_BROWSER_EVIDENCE_ID,
		target_envelope_id: AGENT_BROWSER_TARGET_ENVELOPE_ID,
		target_candidate_id: candidateIdOf(AGENT_BROWSER_TARGET_ENVELOPE_ID, [
			"adapter_page_id",
			"stale-session-tab",
		]),
		ownership: {
			kind: "created-target",
			target_ref: CREATED_TARGET_REFS[rawTargetId],
			retained_lifecycle: {
				adapter_id: "agent-browser",
				capability_id: "agent-browser.exact-target-no-focus.v1",
				lifecycle_ref: `browser-use-${FIXTURE_RUN_ID}`,
			},
		},
		revision: 1,
		...overrides,
	});
}

function operationRuntime(input: {
	files?: Record<string, string>;
	pages?: Array<{
		id?: string;
		targetId?: string;
		url?: string;
		title?: string;
	}>;
	adapter?: "agent-browser" | "chrome-devtools-mcp";
	env?: Record<string, string | undefined>;
	operationResult?: McporterCommandResult;
	nativeResults?: McporterCommandResult[];
	releaseResults?: McporterCommandResult[];
	now?: () => number;
	throwTargetLeaseReleaseAfterOperation?: boolean;
	invalidateBrowserLaneAfterOperation?: boolean;
	handoff?: string;
	onCommand?: (
		call: McporterCommandInput,
		vector: readonly string[],
	) => Promise<McporterCommandResult | undefined>;
} = {}): {
	runtime: BrowserUseRuntime;
	calls: McporterCommandInput[];
	ensuredDirectories: string[];
	xdgBase: string;
	failOwnershipWriteAfter(successfulRegistryWrites: number): void;
} {
	const calls: McporterCommandInput[] = [];
	const ensuredDirectories: string[] = [];
	const nativeResults = [...(input.nativeResults ?? [])];
	const releaseResults = [...(input.releaseResults ?? [])];
	const basePlatformFs = createDefaultPlatformFs();
	let registryWritesBeforeFailure: number | undefined;
	let throwNextClockRead = false;
	let invalidateBrowserLaneAfterOperation =
		input.invalidateBrowserLaneAfterOperation === true;
	const platformFs: BrowserUsePlatformFs = {
		...basePlatformFs,
		async writeFileDurable(path, contents, mode) {
			if (
				path.includes("browser-custody/registry.json.tmp-") &&
				registryWritesBeforeFailure !== undefined
			) {
				if (registryWritesBeforeFailure === 0) {
					registryWritesBeforeFailure = undefined;
					throw Object.assign(new Error("injected registry write failure"), {
						code: "EIO",
					});
				}
				registryWritesBeforeFailure -= 1;
			}
			await basePlatformFs.writeFileDurable(path, contents, mode);
		},
	};
	const files: Record<string, string> = {
		"/h.json":
			input.handoff ?? (input.adapter === "agent-browser"
				? AGENT_BROWSER_HANDOFF
				: REAL_VERIFIED_HANDOFF_ENVELOPE),
		...(input.files ?? {}),
	};
	const pages = input.pages ?? [
		{ id: "1", url: "https://example.com/app", title: "App" },
	];
	let activeTargetId: string | undefined;
	const xdg = makeTempXdgEnv();
	operationXdgCleanups.push(xdg.dispose);
	const clock = input.now ?? (() => 2_000);
	const runtime = makeRuntime({
		env: { ...xdg.env, ...(input.env ?? {}) },
		now: () => {
			if (throwNextClockRead) {
				throwNextClockRead = false;
				throw new Error("injected operation-lease release failure");
			}
			return clock();
		},
		platformFs,
		readTextFile: async (path) => {
			if (path in files) return files[path];
			throw enoent(path);
		},
		ensureDirectory: async (path) => {
			ensuredDirectories.push(path);
		},
		runCommand: async (call) => {
			calls.push(call);
			const vector = commandVector(call);
			if (vector.includes("screenshot") || vector.includes("take_screenshot")) {
				const nativePath = vector.find((entry) => entry.endsWith(".png"));
				const jsonPath = commandJsonArgs(call).filePath;
				const screenshotPath =
					nativePath ?? (typeof jsonPath === "string" ? jsonPath : undefined);
				if (screenshotPath !== undefined) {
					mkdirSync(dirname(screenshotPath), { recursive: true, mode: 0o700 });
					writeFileSync(screenshotPath, Buffer.from("PNG_FIXTURE"), {
						mode: 0o600,
					});
				}
			}
			const intercepted = await input.onCommand?.(call, vector);
			if (intercepted !== undefined) return intercepted;
			if (
				invalidateBrowserLaneAfterOperation &&
				(vector.includes("take_snapshot") ||
					vector.includes("snapshot") ||
					vector.includes("screenshot"))
			) {
				invalidateBrowserLaneAfterOperation = false;
				const deps = await custodyDeps(runtime);
				const leases = await listLeases(deps);
				const projection = leases.find(
					(lease) => lease.live && lease.key.startsWith("browser-lane:"),
				);
				if (!projection) throw new Error("fixture Browser Lane missing");
				const { live: _live, ...lease } = projection;
				await releaseBrowserLaneLease(deps, {
					contract: BROWSER_USE_CUSTODY_CONTRACT_ID,
					schema_version: BROWSER_USE_CUSTODY_SCHEMA_VERSION,
					authority_id: FIXTURE_BROWSER_AUTHORITY,
					run_id: FIXTURE_RUN_ID,
					mutation: "snapshot",
					lease,
				});
			}
			if (call.args.includes("close")) {
				return (
					releaseResults.shift() ??
					okCommand(JSON.stringify({ success: true }))
				);
			}
			if (call.args[0] === "session") {
				return okCommand(
					JSON.stringify({ success: true, data: { sessions: [] } }),
				);
			}
			if (vector.includes("tab") && vector.includes("list")) {
				return okCommand(
					JSON.stringify({
						success: true,
						data: {
							tabs: pages.map((page, index) => ({
								tabId: page.id,
								targetId:
									page.targetId ?? `cdp-target-${page.id ?? "unknown"}`,
								url: page.url,
								title: page.title,
								active:
									activeTargetId === undefined
										? index === 0
										: activeTargetId ===
											(page.targetId ??
												`cdp-target-${page.id ?? "unknown"}`),
							})),
						},
					}),
				);
			}
			if (
				vector.includes("tab") &&
				!vector.includes("list") &&
				vector[vector.indexOf("tab") + 1] !== undefined
			) {
				activeTargetId = vector[vector.indexOf("tab") + 1];
			}
			if (vector.includes("get") && vector.includes("url")) {
				return okCommand(
					JSON.stringify({
						success: true,
						data: { url: pages[0]?.url ?? "https://example.com/app" },
					}),
				);
			}
			if (input.adapter === "agent-browser" && nativeResults.length > 0) {
				const nativeResult = nativeResults.shift();
				if (nativeResult) {
					if (
						input.throwTargetLeaseReleaseAfterOperation === true &&
						vector.includes("snapshot")
					) {
						throwNextClockRead = true;
					}
					return nativeResult;
				}
			}
			// The envelope-derived argv names the tool via --tool (U3); route the
			// fake on that token, mirroring the real ad-hoc invocation shape.
			const toolIndex = call.args.indexOf("--tool");
			const tool = toolIndex >= 0 ? call.args[toolIndex + 1] : undefined;
			if (tool === "list_pages") {
				return okCommand(listPagesStdout(pages));
			}
			if (tool === "select_page") return okCommand("{}");
			return (
				input.operationResult ??
				okCommand(JSON.stringify({ content: [{ type: "text", text: "Root\nButton" }] }))
			);
		},
	});
	return {
		runtime,
		calls,
		ensuredDirectories,
		xdgBase: xdg.base,
		failOwnershipWriteAfter(successfulRegistryWrites) {
			registryWritesBeforeFailure = successfulRegistryWrites;
		},
	};
}

describe("U7 operation gates", () => {
	test("a foreign Target Lease refuses a chrome snapshot before operation dispatch", async () => {
		const { runtime, calls } = operationRuntime();
		const deps = await custodyDeps(runtime);
		const held = await acquireTargetOperationLease(deps, {
			authorityId: FIXTURE_BROWSER_AUTHORITY,
			runId: "other-run",
			adapterId: "agent-browser",
			rawTargetId: "cdp-target-test",
			operation: "read",
			ttlMs: 30_000,
			ownershipEvidence: {
				kind: "adapter-creation-receipt",
				adapter_id: "agent-browser",
				run_id: "other-run",
				raw_target_id: "cdp-target-test",
			},
		});
		if (!held.ok) throw new Error("fixture target lease failed");
		await releaseTargetOperationLease(deps, held.lease);
		try {
			const result = await runForTest(
				["operate", "snapshot", "--handoff", "/h.json", "--json"],
				runtime,
			);
			expect(result.exitCode).toBe(20);
			expect(parseJson(result.stdout).error).toMatchObject({
				code: "target_owned_by_other_run",
			});
			expect(
				calls.some((call) => call.args.includes("take_snapshot")),
			).toBe(false);
		} finally {
			await releaseRunTargetOwnership(deps, "other-run");
		}
	});

	test("a held Browser Lane refuses screenshot capture before dispatch", async () => {
		const { runtime, calls } = operationRuntime({ adapter: "agent-browser" });
		const deps = await custodyDeps(runtime);
		const held = await acquireBrowserLaneLease(deps, {
			authorityId: FIXTURE_BROWSER_AUTHORITY,
			runId: "other-run",
			mutation: "domain-policy",
			ttlMs: 30_000,
		});
		if (!held.ok) throw new Error("fixture Browser Lane failed");
		try {
			const result = await runForTest(
				[
					"operate",
					"screenshot",
					"--out",
					"shot.png",
					"--handoff",
					"/h.json",
					"--json",
				],
				runtime,
			);
			expect(result.exitCode).toBe(20);
			expect(parseJson(result.stdout).error).toMatchObject({
				code: "browser_lane_held",
			});
			expect(calls.some((call) => call.args.includes("screenshot"))).toBe(false);
		} finally {
			await releaseBrowserLaneLease(deps, held.lease);
		}
	});

	test("an unqualified adapter snapshot remains Browser-Lane serialized", async () => {
		const { runtime, calls } = operationRuntime();
		const deps = await custodyDeps(runtime);
		const held = await acquireBrowserLaneLease(deps, {
			authorityId: FIXTURE_BROWSER_AUTHORITY,
			runId: "other-run",
			mutation: "domain-policy",
			ttlMs: 30_000,
		});
		if (!held.ok) throw new Error("fixture Browser Lane failed");
		try {
			const result = await runForTest(
				["operate", "snapshot", "--handoff", "/h.json", "--json"],
				runtime,
			);
			expect(result.exitCode).toBe(20);
			expect(parseJson(result.stdout).error).toMatchObject({
				code: "browser_lane_held",
			});
			expect(
				calls.some((call) => commandVector(call).includes("take_snapshot")),
			).toBe(false);
		} finally {
			await releaseBrowserLaneLease(deps, held.lease);
		}
	});

	test("a Browser Lane refusal preserves its primary cause when target cleanup also fails", async () => {
		const {
			runtime,
			calls,
			failOwnershipWriteAfter,
			xdgBase,
		} = operationRuntime({
			adapter: "agent-browser",
			pages: [
				{
					id: "tab-operation-a",
					targetId: "cdp-operation-a",
					url: "https://example.com/app",
					title: "App",
				},
			],
		});
		const deps = await seedPersistentTargetB(runtime);
		const held = await acquireBrowserLaneLease(deps, {
			authorityId: FIXTURE_BROWSER_AUTHORITY,
			runId: "other-run",
			mutation: "domain-policy",
			ttlMs: 30_000,
		});
		if (!held.ok) throw new Error("fixture Browser Lane failed");
		failOwnershipWriteAfter(1);
		try {
			const result = await runForTest(
				[
					"operate",
					"screenshot",
					"--out",
					"shot.png",
					"--handoff",
					"/h.json",
					"--json",
				],
				runtime,
			);
			const output = `${result.stdout}\n${result.stderr}`;

			expect(result.exitCode).toBe(1);
			expect(parseJson(result.stdout)).toMatchObject({
				error: { code: "browser_operation_cleanup_incomplete" },
				data: {
					primary_cause: "browser_lane_held",
					operation_effect: "not_started",
					cleanup_debt: ["target-ownership-release-failed"],
				},
			});
			expect(calls.some((call) => call.args.includes("screenshot"))).toBe(false);
			expect(await ownedRegistryTargetRefs(runtime)).toEqual([
				OPERATION_CLEANUP_TARGET_REFS["cdp-operation-a"],
				OPERATION_CLEANUP_TARGET_REFS["cdp-persistent-b"],
			]);
			expectCleanupOutputRedacted(output, xdgBase);
		} finally {
			await releaseBrowserLaneLease(deps, held.lease);
			await releaseRunTargetOwnership(deps, FIXTURE_RUN_ID);
		}
	});

	test("operate requires --handoff before any transport", async () => {
		const { runtime, calls } = operationRuntime();
		const result = await runForTest(["operate", "snapshot", "--json"], runtime);
		expect(result.exitCode).toBe(20);
		const json = parseJson(result.stdout);
		expect(json.error).toMatchObject({ code: "browser_operation_handoff_invalid" });
		expect((json.continuation as Record<string, unknown>).next_action_id).toBe(
			"supply_verified_handoff",
		);
		expect(calls).toHaveLength(0);
	});

	test("a real connect failure envelope never authorizes an operation (AE4)", async () => {
		const { runtime, calls } = operationRuntime({
			files: { "/h.json": connectFailureEnvelope() },
		});
		const result = await runForTest(
			["operate", "snapshot", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(20);
		expect(parseJson(result.stdout).error).toMatchObject({
			code: "browser_operation_handoff_invalid",
		});
		expect(calls).toHaveLength(0);
	});

	test("a drift-rejected envelope schema version fails before transport (KTD1)", async () => {
		const { runtime, calls } = operationRuntime({
			files: {
				"/h.json": verifiedHandoffEnvelope((envelope) => {
					envelope.data.schema_version = "99";
				}),
			},
		});
		const result = await runForTest(
			["operate", "snapshot", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(20);
		expect(parseJson(result.stdout).error).toMatchObject({
			code: "browser_operation_handoff_invalid",
		});
		expect(calls).toHaveLength(0);
	});

	test("a caller --run-id disagreeing with the envelope run id fails before transport (R3)", async () => {
		const { runtime, calls } = operationRuntime();
		const result = await runForTest(
			["operate", "snapshot", "--handoff", "/h.json", "--run-id", "other-run", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(20);
		expect(parseJson(result.stdout).error).toMatchObject({
			code: "browser_operation_run_mismatch",
		});
		expect(calls).toHaveLength(0);
	});

	test("an adapter without operation capability is refused before transport (R5)", async () => {
		// playwright-cdp maps to a browser-use adapter with an EMPTY authorized
		// capability set (no operation transport yet): every operation class is
		// refused through the surviving router engine. (agent-browser now
		// authorizes snapshot_refs/element_actions post-U3, so it no longer models
		// the empty-capability case.)
		const { runtime, calls } = operationRuntime({
			files: {
				"/h.json": verifiedHandoffEnvelope((envelope) => {
					envelope.data.attachment.adapter_id = "playwright-cdp";
				}),
			},
		});
		const result = await runForTest(
			["operate", "snapshot", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(20);
		expect(parseJson(result.stdout).error).toMatchObject({
			code: "browser_operation_capability_unauthorized",
		});
		expect(calls).toHaveLength(0);
	});

	// Ported from the deleted browser-adapter-router suite ("emulate authorizes
	// only when viewport_emulation is routed" / "operation capability mapping
	// fails closed when capability not routed"): the operation-class ->
	// capability mapping is still enforced through the surviving engine's
	// authorizesOperationClass, now fed by the handoff adapter's pinned
	// operation capability set (BROWSER_USE_ADAPTER_OPERATION_CAPABILITIES).
	test("emulate is refused before transport when the adapter does not authorize viewport_emulation", async () => {
		const { runtime, calls } = operationRuntime({
			files: {
				"/h.json": verifiedHandoffEnvelope((envelope) => {
					envelope.data.attachment.adapter_id = "agent-browser";
				}),
			},
		});
		const result = await runForTest(
			[
				"operate",
				"emulate",
				"--width",
				"390",
				"--height",
				"844",
				"--handoff",
				"/h.json",
				"--json",
			],
			runtime,
		);
		expect(result.exitCode).toBe(20);
		expect(parseJson(result.stdout).error).toMatchObject({
			code: "browser_operation_capability_unauthorized",
		});
		expect(calls).toHaveLength(0);
	});

	test("agent-browser screenshot dispatches through screenshot_media", async () => {
		const { runtime, calls } = operationRuntime({
			adapter: "agent-browser",
			nativeResults: [
				okCommand(JSON.stringify({ success: true, data: { selected: true } })),
				okCommand(JSON.stringify({ success: true, data: { path: "shot.png" } })),
			],
		});
		const result = await runForTest(
			[
				"operate",
				"screenshot",
				"--out",
				"shot.png",
				"--handoff",
				"/h.json",
				"--json",
			],
			runtime,
		);
		expect(result.exitCode, result.stdout).toBe(0);
		expect(calls.some((call) => call.args.includes("screenshot"))).toBe(true);
		expect(
			calls.some((call) =>
				call.args.some((argument) => argument.endsWith("shot.png")),
			),
		).toBe(true);
	});

	test("screenshot requires --out before transport", async () => {
		const { runtime, calls } = operationRuntime();
		const result = await runForTest(
			["operate", "screenshot", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(2);
		expect(parseJson(result.stdout).error).toMatchObject({
			code: "browser_operation_artifact_path_required",
		});
		expect(calls).toHaveLength(0);
	});

	test("screenshot rejects unsafe artifact paths before transport", async () => {
		const { runtime, calls } = operationRuntime();
		const result = await runForTest(
			["operate", "screenshot", "--out", "../shot.png", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(2);
		expect(parseJson(result.stdout).error).toMatchObject({
			code: "browser_operation_artifact_path_unsafe",
		});
		expect(calls).toHaveLength(0);
	});

	test("screenshot rejects absolute and normalized traversal artifact paths", async () => {
		for (const out of ["/tmp/shot.png", "safe/../../shot.png"]) {
			const { runtime, calls } = operationRuntime();
			const result = await runForTest(
				["operate", "screenshot", "--out", out, "--handoff", "/h.json", "--json"],
				runtime,
			);
			expect(result.exitCode).toBe(2);
			expect(parseJson(result.stdout).error).toMatchObject({
				code: "browser_operation_artifact_path_unsafe",
			});
			expect(calls).toHaveLength(0);
		}
	});

	test("screenshot rejects relative artifact root env before transport", async () => {
		const { runtime, calls } = operationRuntime({
			env: { BROWSER_USE_ARTIFACT_ROOT: "relative-root" },
		});
		const result = await runForTest(
			["operate", "screenshot", "--out", "shot.png", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(2);
		expect(parseJson(result.stdout).error).toMatchObject({
			code: "browser_operation_artifact_path_unsafe",
		});
		expect(calls).toHaveLength(0);
	});

	test("emulate rejects malformed viewport input before transport", async () => {
		const { runtime, calls } = operationRuntime();
		const result = await runForTest(
			["operate", "emulate", "--width", "390", "--height", "0", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(2);
		expect(parseJson(result.stdout).error).toMatchObject({
			code: "browser_operation_viewport_invalid",
		});
		expect(calls).toHaveLength(0);
	});

	test("ambiguous targets emit choose-target recovery without selecting a page", async () => {
		const { runtime, calls } = operationRuntime({
			pages: [
				{ id: "1", url: "https://example.com/a", title: "A" },
				{ id: "2", url: "https://example.com/b", title: "B" },
			],
		});
		const result = await runForTest(
			["operate", "snapshot", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(20);
		const json = parseJson(result.stdout);
		expect(json.error).toMatchObject({ code: "browser_operation_target_ambiguous" });
		expect((json.continuation as Record<string, unknown>).next_action_id).toBe(
			"choose_target_candidate",
		);
		expect(calls).toHaveLength(1);
		expect(commandVector(calls[0])).toContain("list_pages");
	});

	test("target hint no-match emits refine-target recovery without selecting a page", async () => {
		const { runtime, calls } = operationRuntime();
		const result = await runForTest(
			["operate", "snapshot", "--title-contains", "Missing", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(20);
		const json = parseJson(result.stdout);
		expect(json.error).toMatchObject({ code: "browser_operation_target_no_match" });
		expect((json.continuation as Record<string, unknown>).next_action_id).toBe(
			"refine_target_hint",
		);
		expect(calls).toHaveLength(1);
		expect(commandVector(calls[0])).toContain("list_pages");
	});

	test("selected target moved emits refresh target selection", async () => {
		const { runtime } = operationRuntime({
			files: {
				"/state.json": selectedStateFile({ target_candidate_id: "gone" }),
			},
		});
		const result = await runForTest(
			["operate", "snapshot", "--state", "/state.json", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(20);
		const json = parseJson(result.stdout);
		expect(json.error).toMatchObject({ code: "browser_operation_target_moved" });
		expect((json.continuation as Record<string, unknown>).next_action_id).toBe(
			"refresh_target_selection",
		);
	});

	test("selected target does not rebind when the same ordinal now has a different page id", async () => {
		const { runtime, calls } = operationRuntime({
			files: { "/state.json": selectedStateFile() },
			pages: [{ id: "2", url: "https://example.com/app", title: "App" }],
		});
		const result = await runForTest(
			["operate", "snapshot", "--state", "/state.json", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(20);
		expect(parseJson(result.stdout).error).toMatchObject({
			code: "browser_operation_target_moved",
		});
		expect(calls).toHaveLength(1);
		expect(commandVector(calls[0])).toContain("list_pages");
	});

	test("open-created state re-resolves by private target ref when the session tab id changes", async () => {
		const { runtime, calls } = operationRuntime({
			adapter: "agent-browser",
			files: {
				"/state.json": createdSelectedStateFile("cdp-stable"),
			},
			pages: [
				{
					id: "fresh-session-tab",
					targetId: "cdp-stable",
					url: "https://example.com/app",
					title: "App",
				},
			],
			nativeResults: [
				okCommand(
					JSON.stringify({
						success: true,
						data: { snapshot: "Root\nButton", refs: {} },
					}),
				),
			],
		});

		const result = await runForTest(
			[
				"operate",
				"snapshot",
				"--state",
				"/state.json",
				"--handoff",
				"/h.json",
				"--json",
			],
			runtime,
		);

		expect(result.exitCode).toBe(0);
		expect(
			calls.some((call) => {
				const vector = commandVector(call);
				return vector.includes("tab") && vector.includes("cdp-stable");
			}),
		).toBe(false);
		expect([result.stdout, result.stderr].join("\n")).not.toContain(
			"stale-session-tab",
		);
	});

	test("legacy created-target lifecycle state migrates only through the adapter owner", async () => {
		const { runtime } = operationRuntime({
			adapter: "agent-browser",
			files: {
				"/state.json": createdSelectedStateFile("cdp-stable", {
					ownership: {
						kind: "created-target",
						target_ref: CREATED_TARGET_REFS["cdp-stable"],
						adapter_session: {
							kind: "agent-browser-pinned",
							session_name: `browser-use-${FIXTURE_RUN_ID}`,
						},
					},
				}),
			},
			pages: [
				{
					id: "fresh-session-tab",
					targetId: "cdp-stable",
					url: "https://example.com/app",
					title: "App",
				},
			],
			nativeResults: [
				okCommand(
					JSON.stringify({
						success: true,
						data: { snapshot: "Root", refs: {} },
					}),
				),
			],
		});
		const result = await runForTest(
			[
				"operate",
				"snapshot",
				"--state",
				"/state.json",
				"--handoff",
				"/h.json",
				"--json",
			],
			runtime,
		);
		expect(result.exitCode).toBe(0);
	});

	test("open-created state fails closed when no private target-ref match remains", async () => {
		const { runtime, calls } = operationRuntime({
			adapter: "agent-browser",
			files: {
				"/state.json": createdSelectedStateFile("cdp-owned"),
			},
			pages: [
				{
					id: "fresh-tab",
					targetId: "cdp-other",
					url: "https://example.com/app",
					title: "App",
				},
			],
		});

		const result = await runForTest(
			[
				"operate",
				"snapshot",
				"--state",
				"/state.json",
				"--handoff",
				"/h.json",
				"--json",
			],
			runtime,
		);

		expect(result.exitCode).toBe(20);
		expect(parseJson(result.stdout).error).toMatchObject({
			code: "target_state_mismatch",
		});
		expect(calls.some((call) => call.args.includes("snapshot"))).toBe(false);
	});

	test("open-created state fails closed when two tabs match the private target ref", async () => {
		const { runtime, calls } = operationRuntime({
			adapter: "agent-browser",
			files: {
				"/state.json": createdSelectedStateFile("cdp-owned"),
			},
			pages: [
				{
					id: "tab-one",
					targetId: "cdp-owned",
					url: "https://example.com/app",
				},
				{
					id: "tab-two",
					targetId: "cdp-owned",
					url: "https://example.com/app",
				},
			],
		});

		const result = await runForTest(
			[
				"operate",
				"snapshot",
				"--state",
				"/state.json",
				"--handoff",
				"/h.json",
				"--json",
			],
			runtime,
		);

		expect(result.exitCode).toBe(20);
		expect(parseJson(result.stdout).error).toMatchObject({
			code: "target_state_mismatch",
		});
		expect(calls.some((call) => call.args.includes("snapshot"))).toBe(false);
	});

	test("open-created state rejects malformed canonical target inventories", async () => {
		const malformedInventories = [
			{
				label: "empty",
				pages: [
					{ id: "tab-empty", targetId: "", url: "https://example.com/app" },
				],
			},
			{
				label: "oversized",
				pages: [
					{
						id: "tab-oversized",
						targetId: "x".repeat(513),
						url: "https://example.com/app",
					},
				],
			},
			{
				label: "duplicate",
				pages: [
					{
						id: "tab-one",
						targetId: "cdp-other",
						url: "https://example.com/a",
					},
					{
						id: "tab-two",
						targetId: "cdp-other",
						url: "https://example.com/b",
					},
				],
			},
		];

		for (const fixture of malformedInventories) {
			const { runtime, calls } = operationRuntime({
				adapter: "agent-browser",
				files: {
					"/state.json": createdSelectedStateFile("cdp-owned"),
				},
				pages: fixture.pages,
			});
			const result = await runForTest(
				[
					"operate",
					"snapshot",
					"--state",
					"/state.json",
					"--handoff",
					"/h.json",
					"--json",
				],
				runtime,
			);

			expect(result.exitCode, fixture.label).toBe(20);
			expect(parseJson(result.stdout).error, fixture.label).toMatchObject({
				code: "target_state_mismatch",
			});
			expect(
				calls.some((call) => call.args.includes("snapshot")),
				fixture.label,
			).toBe(false);
		}
	});

	test("open-created state rejects an explicit target hint that conflicts with its owned tab", async () => {
		const { runtime, calls } = operationRuntime({
			adapter: "agent-browser",
			files: {
				"/state.json": createdSelectedStateFile("cdp-owned"),
			},
			pages: [
				{
					id: "fresh-tab",
					targetId: "cdp-owned",
					url: "https://example.com/app",
					title: "App",
				},
			],
		});

		const result = await runForTest(
			[
				"operate",
				"snapshot",
				"--title-contains",
				"Different",
				"--state",
				"/state.json",
				"--handoff",
				"/h.json",
				"--json",
			],
			runtime,
		);

		expect(result.exitCode).toBe(20);
		expect(parseJson(result.stdout).error).toMatchObject({
			code: "browser_operation_target_no_match",
		});
		expect(calls.some((call) => call.args.includes("snapshot"))).toBe(false);
	});

	test("open-created state rejects the same target after cross-origin navigation", async () => {
		const { runtime, calls } = operationRuntime({
			adapter: "agent-browser",
			files: {
				"/state.json": createdSelectedStateFile("cdp-owned"),
			},
			pages: [
				{
					id: "fresh-tab",
					targetId: "cdp-owned",
					url: "https://different.example/app",
					title: "App",
				},
			],
		});

		const result = await runForTest(
			[
				"operate",
				"snapshot",
				"--state",
				"/state.json",
				"--handoff",
				"/h.json",
				"--json",
			],
			runtime,
		);

		expect(result.exitCode).toBe(20);
		expect(parseJson(result.stdout).error).toMatchObject({
			code: "target_state_mismatch",
		});
		expect(calls.some((call) => call.args.includes("snapshot"))).toBe(false);
	});

	test("open-created state rejects an opaque lifecycle identity from another run", async () => {
		const { runtime, calls } = operationRuntime({
			adapter: "agent-browser",
			files: {
				"/state.json": createdSelectedStateFile("cdp-owned", {
					ownership: {
						kind: "created-target",
						target_ref: CREATED_TARGET_REFS["cdp-owned"],
						retained_lifecycle: {
							adapter_id: "agent-browser",
							capability_id: "agent-browser.exact-target-no-focus.v1",
							lifecycle_ref: "browser-use-foreign-run",
						},
					},
				}),
			},
		});
		const result = await runForTest(
			[
				"operate",
				"snapshot",
				"--state",
				"/state.json",
				"--handoff",
				"/h.json",
				"--json",
			],
			runtime,
		);
		expect(result.exitCode).toBe(20);
		expect(parseJson(result.stdout).error).toMatchObject({
			code: "target_state_unreadable",
		});
		expect(calls.some((call) => call.args.includes("snapshot"))).toBe(false);
	});

	test.each([
		[
			"adapter",
			{
				adapter_id: "playwright-cdp",
				capability_id: "agent-browser.exact-target-no-focus.v1",
				lifecycle_ref: `browser-use-${FIXTURE_RUN_ID}`,
			},
		],
		[
			"capability",
			{
				adapter_id: "agent-browser",
				capability_id: "foreign-capability",
				lifecycle_ref: `browser-use-${FIXTURE_RUN_ID}`,
			},
		],
	] as const)(
		"open-created state rejects a wrong retained lifecycle %s identity",
		async (_label, retainedLifecycle) => {
			const { runtime, calls } = operationRuntime({
				adapter: "agent-browser",
				files: {
					"/state.json": createdSelectedStateFile("cdp-owned", {
						ownership: {
							kind: "created-target",
							target_ref: CREATED_TARGET_REFS["cdp-owned"],
							retained_lifecycle: retainedLifecycle,
						},
					}),
				},
			});
			const result = await runForTest(
				[
					"operate",
					"snapshot",
					"--state",
					"/state.json",
					"--handoff",
					"/h.json",
					"--json",
				],
				runtime,
			);
			expect(result.exitCode).toBe(20);
			expect(parseJson(result.stdout).error).toMatchObject({
				code: "target_state_mismatch",
			});
			expect(calls.some((call) => call.args.includes("snapshot"))).toBe(false);
		},
	);

	test("near-expiry open-created state fails before operation effect and does not extend custody", async () => {
		const rawTargetId = "cdp-owned";
		const now = 2_000;
		const { runtime, calls } = operationRuntime({
			adapter: "agent-browser",
			now: () => now,
			files: {
				"/state.json": createdSelectedStateFile(rawTargetId, {
					expires_at_ms: now + 119_999,
				}),
			},
			pages: [
				{
					id: "fresh-tab",
					targetId: rawTargetId,
					url: "https://example.com/app",
					title: "App",
				},
			],
		});
		const deps = await custodyDeps(runtime);
		const owned = await acquireTargetOperationLease(deps, {
			authorityId: FIXTURE_BROWSER_AUTHORITY,
			runId: FIXTURE_RUN_ID,
			adapterId: "agent-browser",
			rawTargetId,
			operation: "read",
			ttlMs: 30_000,
			ownershipEvidence: {
				kind: "adapter-creation-receipt",
				adapter_id: "agent-browser",
				run_id: FIXTURE_RUN_ID,
				raw_target_id: rawTargetId,
			},
		});
		if (!owned.ok) throw new Error("fixture target ownership failed");
		await releaseTargetOperationLease(deps, owned.lease);
		const expiresBefore = await targetOwnershipExpiry(
			runtime,
			CREATED_TARGET_REFS[rawTargetId],
		);

		const result = await runForTest(
			[
				"operate",
				"snapshot",
				"--state",
				"/state.json",
				"--handoff",
				"/h.json",
				"--json",
			],
			runtime,
		);

		expect(result.exitCode).toBe(20);
		expect(parseJson(result.stdout).error).toMatchObject({
			code: "target_state_stale",
		});
		expect(calls.some((call) => call.args.includes("snapshot"))).toBe(false);
		expect(
			calls.some((call) => commandVector(call).includes(rawTargetId)),
		).toBe(false);
		expect(
			await targetOwnershipExpiry(runtime, CREATED_TARGET_REFS[rawTargetId]),
		).toBe(expiresBefore);
	});

	test("a v1 (Router-era) selected state fails with target_state_mismatch, never operates", async () => {
		const { runtime, calls } = operationRuntime({
			files: {
				"/state.json": selectedStateFile({
					schema_version: "1",
					warm_chrome_run_id: "warm-1",
					adapter_proof_id: "proof-abc",
					route_evidence_hash: "hash-xyz",
				}),
			},
		});
		const result = await runForTest(
			["operate", "snapshot", "--state", "/state.json", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(20);
		expect(parseJson(result.stdout).error).toMatchObject({
			code: "target_state_mismatch",
		});
		expect(calls.filter((call) => commandVector(call).join(" ").includes("select_page"))).toHaveLength(0);
	});

	test("selected state bound to a different handoff fails with target_state_mismatch", async () => {
		const { runtime } = operationRuntime({
			files: {
				"/state.json": selectedStateFile({ handoff_evidence_id: "other-evidence" }),
			},
		});
		const result = await runForTest(
			["operate", "snapshot", "--state", "/state.json", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(20);
		expect(parseJson(result.stdout).error).toMatchObject({
			code: "target_state_mismatch",
		});
	});
});

describe("U7 operation success and transport", () => {
	test("ordinary operation releases only its exact first ownership and preserves another target for the same run", async () => {
		const { runtime } = operationRuntime({
			adapter: "agent-browser",
			pages: [
				{
					id: "tab-operation-a",
					targetId: "cdp-operation-a",
					url: "https://example.com/app",
					title: "App",
				},
			],
			nativeResults: [
				okCommand(JSON.stringify({ success: true, data: {} })),
				okCommand(JSON.stringify({ success: true, data: "Root\nButton" })),
			],
		});
		const deps = await seedPersistentTargetB(runtime);
		try {
			const result = await runForTest(
				["operate", "snapshot", "--handoff", "/h.json", "--json"],
				runtime,
			);

			expect(result.exitCode).toBe(0);
			expect(
				await ownedTargetRefsForRun(deps, {
					authorityId: FIXTURE_BROWSER_AUTHORITY,
					runId: FIXTURE_RUN_ID,
					adapterId: "agent-browser",
				}),
			).toEqual({
				ok: true,
				targetRefs: [OPERATION_CLEANUP_TARGET_REFS["cdp-persistent-b"]],
			});
		} finally {
			await releaseRunTargetOwnership(deps, FIXTURE_RUN_ID);
		}
	});

	test("a thrown operation-lease release still attempts exact first-ownership cleanup and blocks success", async () => {
		const { runtime, xdgBase } = operationRuntime({
			adapter: "agent-browser",
			pages: [
				{
					id: "tab-operation-a",
					targetId: "cdp-operation-a",
					url: "https://example.com/app",
					title: "App",
				},
			],
			nativeResults: [
				okCommand(JSON.stringify({ success: true, data: {} })),
				okCommand(JSON.stringify({ success: true, data: "Root\nButton" })),
			],
			throwTargetLeaseReleaseAfterOperation: true,
		});
		const deps = await seedPersistentTargetB(runtime);
		try {
			const result = await runForTest(
				["operate", "snapshot", "--handoff", "/h.json", "--json"],
				runtime,
			);
			const output = `${result.stdout}\n${result.stderr}`;

			expect(result.exitCode).toBe(1);
			expect(parseJson(result.stdout)).toMatchObject({
				error: { code: "browser_operation_cleanup_incomplete" },
				data: {
					primary_cause: "browser_operation_completed",
					operation_effect: "confirmed",
					cleanup_debt: ["target-operation-lease-release-failed"],
				},
			});
			expect(
				await ownedTargetRefsForRun(deps, {
					authorityId: FIXTURE_BROWSER_AUTHORITY,
					runId: FIXTURE_RUN_ID,
					adapterId: "agent-browser",
				}),
			).toEqual({
				ok: true,
				targetRefs: [OPERATION_CLEANUP_TARGET_REFS["cdp-persistent-b"]],
			});
			expectCleanupOutputRedacted(output, xdgBase);
		} finally {
			await releaseRunTargetOwnership(deps, FIXTURE_RUN_ID);
		}
	});

	test("a typed exact-ownership release failure is public cleanup debt and preserves same-run B", async () => {
		const { runtime, failOwnershipWriteAfter, xdgBase } = operationRuntime({
			adapter: "agent-browser",
			pages: [
				{
					id: "tab-operation-a",
					targetId: "cdp-operation-a",
					url: "https://example.com/app",
					title: "App",
				},
			],
			nativeResults: [
				okCommand(JSON.stringify({ success: true, data: {} })),
				okCommand(JSON.stringify({ success: true, data: "Root\nButton" })),
			],
		});
		const deps = await seedPersistentTargetB(runtime);
		failOwnershipWriteAfter(1);
		try {
			const result = await runForTest(
				["operate", "snapshot", "--handoff", "/h.json", "--json"],
				runtime,
			);
			const output = `${result.stdout}\n${result.stderr}`;

			expect(result.exitCode).toBe(1);
			expect(parseJson(result.stdout)).toMatchObject({
				error: { code: "browser_operation_cleanup_incomplete" },
				data: {
					primary_cause: "browser_operation_completed",
					operation_effect: "confirmed",
					cleanup_debt: ["target-ownership-release-failed"],
				},
			});
			expect(await ownedRegistryTargetRefs(runtime)).toEqual([
				OPERATION_CLEANUP_TARGET_REFS["cdp-operation-a"],
				OPERATION_CLEANUP_TARGET_REFS["cdp-persistent-b"],
			]);
			expectCleanupOutputRedacted(output, xdgBase);
		} finally {
			await releaseRunTargetOwnership(deps, FIXTURE_RUN_ID);
		}
	});

	test("agent-browser releases its owned session after a successful operation", async () => {
		const { runtime, calls } = operationRuntime({
			adapter: "agent-browser",
			pages: [{ id: "tab-alpha", targetId: "cdp-9f3c", url: "https://example.com/app", title: "App" }],
			nativeResults: [
				okCommand(JSON.stringify({ success: true, data: {} })),
				okCommand(JSON.stringify({ success: true, data: "Root\nButton" })),
			],
		});

		const result = await runForTest(
			["operate", "snapshot", "--handoff", "/h.json", "--json"],
			runtime,
		);
		const closeCalls = calls.filter((call) => call.args.includes("close"));

		expect(result.exitCode).toBe(0);
		// Discovery owns the first release; the operation lane owns the second.
		expect(closeCalls).toHaveLength(2);
		const operationCloseCall = closeCalls[1];
		if (!operationCloseCall) throw new Error("missing operation release call");
		expect(commandVector(operationCloseCall)).toEqual([
			FIXTURE_ENVELOPE.data.attachment.probe_executable,
			"--session",
			`browser-use-${FIXTURE_RUN_ID}`,
			"close",
			"--json",
		]);
		expect(commandVector(operationCloseCall)).not.toContain("--cdp");
	});

	test("agent-browser releases its owned session after a typed operation failure", async () => {
		const { runtime, calls } = operationRuntime({
			adapter: "agent-browser",
			pages: [{ id: "tab-alpha", targetId: "cdp-9f3c", url: "https://example.com/app", title: "App" }],
			nativeResults: [
				okCommand(
					JSON.stringify({ success: false, error: "tab t1 unavailable" }),
				),
			],
		});

		const result = await runForTest(
			["operate", "snapshot", "--handoff", "/h.json", "--json"],
			runtime,
		);
		const closeCalls = calls.filter((call) => call.args.includes("close"));

		expect(result.exitCode).toBe(20);
		expect(parseJson(result.stdout).error).toMatchObject({
			code: "browser_operation_transport_failed",
		});
		// Discovery owns the first release; the failed operation owns the second.
		expect(closeCalls).toHaveLength(2);
		const operationCloseCall = closeCalls[1];
		if (!operationCloseCall) throw new Error("missing operation release call");
		expect(commandVector(operationCloseCall)).not.toContain("--cdp");
	});

	test("blocks successful operation truth when terminal release fails", async () => {
		const { runtime } = operationRuntime({
			adapter: "agent-browser",
			pages: [{ id: "tab-alpha", targetId: "cdp-9f3c", url: "https://example.com/app", title: "App" }],
			nativeResults: [
				okCommand(JSON.stringify({ success: true, data: {} })),
				okCommand(JSON.stringify({ success: true, data: "Root\nButton" })),
			],
			releaseResults: [
				okCommand(JSON.stringify({ success: true })),
				{ exitCode: 7, stdout: "", stderr: "close failed", timedOut: false },
			],
		});

		const result = await runForTest(
			["operate", "snapshot", "--handoff", "/h.json", "--json"],
			runtime,
		);

		expect(result.exitCode).toBe(20);
		expect(parseJson(result.stdout)).toMatchObject({
			error: { code: "browser_operation_transport_failed" },
			data: { release: { released: false, cause: "command-failed" } },
		});
	});

	test("a discovered agent-browser t1 tab survives target resolution and executes", async () => {
		const { runtime, calls } = operationRuntime({
			adapter: "agent-browser",
			pages: [{ id: "tab-alpha", targetId: "cdp-9f3c", url: "https://example.com/app", title: "App" }],
			nativeResults: [
				okCommand(JSON.stringify({ success: true, data: {} })),
				// Real adapter snapshot payload shape: {snapshot, refs}. The lane
				// unwraps data.snapshot and discards refs (opaque-ref contract).
				okCommand(
					JSON.stringify({
						success: true,
						data: { snapshot: "Root\nButton", refs: {} },
					}),
				),
			],
		});
		const result = await runForTest(
			["operate", "snapshot", "--handoff", "/h.json", "--json"],
			runtime,
		);
		const json = parseJson(result.stdout);
		expect(
			calls.some((call) => {
				const vector = commandVector(call);
				return vector.includes("tab") && vector.includes("list");
			}),
		).toBe(true);
		expect((json.error as { code?: string } | undefined)?.code).not.toBe(
			"browser_operation_target_missing",
		);
		expect(result.exitCode).toBe(0);
		expect(json.data).toMatchObject({
			adapter: "agent-browser",
			snapshot: { text: "Root\nButton" },
			// Native tab activation always carries the window-focus side effect,
			// so successful agent-browser operates report focus even without
			// --bring-to-front.
			side_effects: { focus: true },
		});
		const operationCalls = calls.filter(
			(call) =>
				call.args.includes("--cdp") &&
				!call.args.includes("list") &&
				!call.args.includes("close"),
		);
		expect(operationCalls.map(commandVector)).toEqual([
			[
				FIXTURE_ENVELOPE.data.attachment.probe_executable,
				"--cdp",
				FIXTURE_ENVELOPE.data.endpoint.ws,
				"--session",
				`browser-use-${FIXTURE_RUN_ID}`,
				"tab",
				"cdp-9f3c",
				"--json",
			],
			[
				FIXTURE_ENVELOPE.data.attachment.probe_executable,
				"--cdp",
				FIXTURE_ENVELOPE.data.endpoint.ws,
				"--session",
				`browser-use-${FIXTURE_RUN_ID}`,
				"--pin-tab",
				"get",
				"url",
				"--json",
			],
			[
				FIXTURE_ENVELOPE.data.attachment.probe_executable,
				"--cdp",
				FIXTURE_ENVELOPE.data.endpoint.ws,
				"--session",
				`browser-use-${FIXTURE_RUN_ID}`,
				"--pin-tab",
				"snapshot",
				"--json",
			],
		]);
		expect(operationCalls[0]?.timeoutMs).toBe(30_000);
		expect(operationCalls[1]?.timeoutMs).toBe(30_000);
		expect([result.stdout, result.stderr].join("\n")).not.toContain("tab-alpha");
		expect(calls.some((call) => call.command === "mcporter")).toBe(false);
	});

	test("retained pinned sessions run no-focus snapshots with overlapping exact lease intervals", async () => {
		const sharedXdg = makeTempXdgEnv();
		operationXdgCleanups.push(sharedXdg.dispose);
		const runB = "22222222-2222-4222-8222-222222222222";
		const handoffB = verifiedHandoffEnvelope((envelope) => {
			envelope.run_id = runB;
			envelope.data.attachment.adapter_id = "agent-browser";
		});
		const envelopeB = JSON.parse(handoffB);
		const evidenceB = handoffEvidenceIdOf({
			runId: envelopeB.run_id,
			environmentName: envelopeB.data.environment.name,
			environmentProfile: envelopeB.data.environment.profile,
			attachmentAdapterId: envelopeB.data.attachment.adapter_id,
			route: envelopeB.data.attachment.route,
			endpointHttp: envelopeB.data.endpoint.http,
			endpointWs: envelopeB.data.endpoint.ws,
			proofContractId: envelopeB.data.proof.environment_contract_id,
			proofSchemaVersion: envelopeB.data.proof.environment_schema_version,
		});
		const targetEnvelopeB = targetEnvelopeIdOf({
			runId: runB,
			mode: "handoff-bound",
			adapter: "agent-browser",
			handoffEvidenceId: evidenceB,
		});
		let logicalNow = 10_000;
		let activePreparations = 0;
		let maxPreparations = 0;
		let activeSnapshots = 0;
		let maxSnapshots = 0;
		let snapshotArrivals = 0;
		let releaseSnapshots = () => {};
		const bothSnapshotsReady = new Promise<void>((resolve) => {
			releaseSnapshots = resolve;
		});
		const commandHarness = (targetId: string, url: string) =>
			async (
				_call: McporterCommandInput,
				vector: readonly string[],
			): Promise<McporterCommandResult | undefined> => {
				if (vector.includes("tab") && vector.includes("list")) {
					return okCommand(
						JSON.stringify({
							success: true,
							data: {
								tabs: [
									{
										tabId: `tab-${targetId}`,
										targetId,
										url,
										title: targetId,
										active: true,
									},
								],
							},
						}),
					);
				}
				if (
					vector.includes("tab") &&
					vector.includes(targetId) &&
					!vector.includes("list")
				) {
					activePreparations += 1;
					maxPreparations = Math.max(maxPreparations, activePreparations);
					await new Promise((resolve) => setTimeout(resolve, 25));
					activePreparations -= 1;
					return okCommand(JSON.stringify({ success: true, data: {} }));
				}
				if (vector.includes("snapshot")) {
					activeSnapshots += 1;
					maxSnapshots = Math.max(maxSnapshots, activeSnapshots);
					snapshotArrivals += 1;
					if (snapshotArrivals === 2) releaseSnapshots();
					await Promise.race([
						bothSnapshotsReady,
						new Promise((resolve) => setTimeout(resolve, 250)),
					]);
					activeSnapshots -= 1;
					return okCommand(
						JSON.stringify({
							success: true,
							data: { snapshot: targetId, refs: {} },
						}),
					);
				}
				return undefined;
			};
		const runtimeA = operationRuntime({
			adapter: "agent-browser",
			env: sharedXdg.env,
			now: () => logicalNow++,
			files: {
				"/state-a.json": createdSelectedStateFile("cdp-target-a", {
					display: { origin: "https://a.example.test" },
				}),
			},
			pages: [
				{
					id: "tab-a",
					targetId: "cdp-target-a",
					url: "https://a.example.test/",
					title: "A",
				},
			],
			onCommand: commandHarness(
				"cdp-target-a",
				"https://a.example.test/",
			),
		});
		const runtimeB = operationRuntime({
			adapter: "agent-browser",
			handoff: handoffB,
			env: sharedXdg.env,
			now: () => logicalNow++,
			files: {
				"/state-b.json": createdSelectedStateFile("cdp-target-b", {
					run_id: runB,
					handoff_evidence_id: evidenceB,
					target_envelope_id: targetEnvelopeB,
					ownership: {
						kind: "created-target",
						target_ref: CREATED_TARGET_REFS["cdp-target-b"],
						retained_lifecycle: {
							adapter_id: "agent-browser",
							capability_id: "agent-browser.exact-target-no-focus.v1",
							lifecycle_ref: `browser-use-${runB}`,
						},
					},
					display: { origin: "https://b.example.test" },
				}),
			},
			pages: [
				{
					id: "tab-b",
					targetId: "cdp-target-b",
					url: "https://b.example.test/",
					title: "B",
				},
			],
			onCommand: commandHarness(
				"cdp-target-b",
				"https://b.example.test/",
			),
		});

		const [resultA, resultB] = await Promise.all([
			runForTest(
				[
					"operate",
					"snapshot",
					"--state",
					"/state-a.json",
					"--handoff",
					"/h.json",
					"--json",
				],
				runtimeA.runtime,
			),
			runForTest(
				[
					"operate",
					"snapshot",
					"--state",
					"/state-b.json",
					"--handoff",
					"/h.json",
					"--json",
				],
				runtimeB.runtime,
			),
		]);
		expect([resultA.exitCode, resultB.exitCode]).toEqual([0, 0]);
		expect(maxPreparations).toBe(0);
		expect(maxSnapshots).toBe(2);
		const dataA = parseJson(resultA.stdout).data as Record<string, unknown>;
		const dataB = parseJson(resultB.stdout).data as Record<string, unknown>;
		for (const data of [dataA, dataB]) {
			expect(data).toMatchObject({
				execution: {
					scope: "target-local",
					focus: false,
				},
				side_effects: { focus: false },
			});
		}
		const intervalOf = (data: Record<string, unknown>) => {
			const custody = data.custody as Record<string, unknown>;
			const lease = custody.target_operation_lease as Record<string, number>;
			return {
				acquired: lease.acquired_at_epoch_ms,
					released: lease.released_at_epoch_ms,
			};
		};
		const intervalA = intervalOf(dataA);
		const intervalB = intervalOf(dataB);
		expect(
			Math.max(intervalA.acquired, intervalB.acquired) <
				Math.min(intervalA.released, intervalB.released),
		).toBe(true);
		expect(
			[...runtimeA.calls, ...runtimeB.calls].some((call) => {
				const vector = commandVector(call);
				return vector.includes("session") && vector.includes("close");
			}),
		).toBe(false);
	});

	test("retained pinned session refuses active-target drift before snapshot and releases its operation lease", async () => {
		let listCalls = 0;
		const { runtime, calls } = operationRuntime({
			adapter: "agent-browser",
			files: {
				"/state.json": createdSelectedStateFile("cdp-target-a"),
			},
			pages: [
				{
					id: "tab-a",
					targetId: "cdp-target-a",
					url: "https://example.com/app",
					title: "A",
				},
			],
			onCommand: async (_call, vector) => {
				if (!(vector.includes("tab") && vector.includes("list"))) {
					return undefined;
				}
				listCalls += 1;
				if (listCalls === 1) return undefined;
				return okCommand(
					JSON.stringify({
						success: true,
						data: {
							tabs: [
								{
									tabId: "tab-other",
									targetId: "cdp-other",
									url: "https://other.example.test/",
									active: true,
								},
							],
						},
					}),
				);
			},
		});
		const deps = await seedPersistentTarget(runtime, "cdp-target-a");
		const result = await runForTest(
			[
				"operate",
				"snapshot",
				"--state",
				"/state.json",
				"--handoff",
				"/h.json",
				"--json",
			],
			runtime,
		);
		expect(result.exitCode).toBe(20);
		expect(parseJson(result.stdout).error).toMatchObject({
			code: "browser_operation_transport_failed",
		});
		expect(
			calls.some((call) => commandVector(call).includes("snapshot")),
		).toBe(false);
		expect(
			calls.some((call) => {
				const vector = commandVector(call);
				return vector.includes("session") && vector.includes("close");
			}),
		).toBe(false);
		expect(
			(await listLeases(deps)).filter(
				(lease) =>
					lease.live && lease.key.startsWith("browser-target-operation:"),
			),
		).toHaveLength(0);
	});

	test("retained pinned snapshot failure releases its operation lease but keeps lifecycle custody", async () => {
		const { runtime, calls } = operationRuntime({
			adapter: "agent-browser",
			files: {
				"/state.json": createdSelectedStateFile("cdp-target-a"),
			},
			pages: [
				{
					id: "tab-a",
					targetId: "cdp-target-a",
					url: "https://example.com/app",
					title: "A",
				},
			],
			nativeResults: [
				{ exitCode: 1, stdout: "", stderr: "snapshot failed" },
			],
		});
		const deps = await seedPersistentTarget(runtime, "cdp-target-a");
		const result = await runForTest(
			[
				"operate",
				"snapshot",
				"--state",
				"/state.json",
				"--handoff",
				"/h.json",
				"--json",
			],
			runtime,
		);
		expect(result.exitCode).toBe(20);
		expect(parseJson(result.stdout).error).toMatchObject({
			code: "browser_operation_transport_failed",
		});
		expect(
			calls.some((call) => {
				const vector = commandVector(call);
				return vector.includes("session") && vector.includes("close");
			}),
		).toBe(false);
		expect(await ownedRegistryTargetRefs(runtime)).toEqual([
			CREATED_TARGET_REFS["cdp-target-a"],
		]);
		expect(
			(await listLeases(deps)).filter(
				(lease) =>
					lease.live && lease.key.startsWith("browser-target-operation:"),
			),
		).toHaveLength(0);
	});

	test("browser-wide work on a created target retains its session for a later target-local snapshot", async () => {
		const { runtime, calls } = operationRuntime({
			adapter: "agent-browser",
			files: {
				"/state.json": createdSelectedStateFile("cdp-target-a"),
			},
			pages: [
				{
					id: "tab-a",
					targetId: "cdp-target-a",
					url: "https://example.com/app",
					title: "A",
				},
			],
			nativeResults: [
				okCommand(JSON.stringify({ success: true, data: {} })),
				okCommand(JSON.stringify({ success: true, data: {} })),
				okCommand(
					JSON.stringify({
						success: true,
						data: { snapshot: "Root", refs: {} },
					}),
				),
			],
			releaseResults: [
				{ exitCode: 1, stdout: "", stderr: "must remain retained" },
			],
		});
		const deps = await seedPersistentTarget(runtime, "cdp-target-a");
		const screenshot = await runForTest(
			[
				"operate",
				"screenshot",
				"--out",
				"shot.png",
				"--state",
				"/state.json",
				"--handoff",
				"/h.json",
				"--json",
			],
			runtime,
		);
		const snapshot = await runForTest(
			[
				"operate",
				"snapshot",
				"--state",
				"/state.json",
				"--handoff",
				"/h.json",
				"--json",
			],
			runtime,
		);
		expect(parseJson(snapshot.stdout)).toMatchObject({ status: "ok" });
		expect([screenshot.exitCode, snapshot.exitCode]).toEqual([0, 0]);
		expect(parseJson(screenshot.stdout).data).toMatchObject({
			execution: { scope: "browser-wide", focus: true },
			side_effects: { focus: true },
		});
		expect(parseJson(snapshot.stdout).data).toMatchObject({
			execution: { scope: "target-local", focus: false },
			side_effects: { focus: false },
		});
		expect(
			calls.some((call) => {
				const vector = commandVector(call);
				return vector.includes("session") && vector.includes("close");
			}),
		).toBe(false);
		expect(await ownedRegistryTargetRefs(runtime)).toEqual([
			CREATED_TARGET_REFS["cdp-target-a"],
		]);
		expect(
			(await listLeases(deps)).filter(
				(lease) =>
					lease.live && lease.key.startsWith("browser-target-operation:"),
			),
		).toHaveLength(0);
	});

	test("agent-browser snapshot accepts plain string data", async () => {
		const { runtime } = operationRuntime({
			adapter: "agent-browser",
			nativeResults: [
				okCommand(JSON.stringify({ success: true, data: {} })),
				okCommand(
					JSON.stringify({ success: true, data: "Root\nButton" }),
				),
			],
		});
		const result = await runForTest(
			["operate", "snapshot", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(0);
		expect(parseJson(result.stdout).data).toMatchObject({
			snapshot: { text: "Root\nButton" },
		});
	});

	test("agent-browser rejects an unsafe native tab ref before operation spawn", async () => {
		const { runtime, calls } = operationRuntime({
			adapter: "agent-browser",
			pages: [{ id: "bad tab", url: "https://example.com/app", title: "App" }],
		});
		const result = await runForTest(
			["operate", "snapshot", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(20);
		expect(parseJson(result.stdout).error).toMatchObject({
			code: "browser_operation_transport_failed",
		});
		// Discovery lists, closes, and verifies; the unsafe ref prevents any
		// operation spawn after that terminal discovery seam.
		expect(calls).toHaveLength(3);
		expect(result.stdout).not.toContain("bad tab");
		expect(result.stderr).not.toContain("bad tab");
	});

	test("agent-browser maps failure envelopes and timeouts without retry or ref disclosure (AE2)", async () => {
		for (const operationResult of [
			okCommand(JSON.stringify({ success: false, error: "tab t1 unavailable" })),
			{ exitCode: 1, stdout: "", stderr: "", timedOut: true },
		]) {
			const { runtime, calls } = operationRuntime({
				adapter: "agent-browser",
				pages: [{ id: "tab-alpha", targetId: "cdp-9f3c", url: "https://example.com/app", title: "App" }],
				nativeResults: [operationResult],
			});
			const result = await runForTest(
				["operate", "snapshot", "--handoff", "/h.json", "--json"],
				runtime,
			);
			expect(result.exitCode).toBe(20);
			expect(parseJson(result.stdout).error).toMatchObject({
				code: operationResult.timedOut
					? "browser_operation_transport_timeout"
					: "browser_operation_transport_failed",
			});
			// Discovery list + release verification, failed activation, then the
			// operation lane's terminal release verification.
			expect(calls).toHaveLength(6);
			expect([result.stdout, result.stderr].join("\n")).not.toContain("tab-alpha");
			expect(calls.some((call) => call.command === "mcporter")).toBe(false);
		}
	});

	test("agent-browser snapshot-step failures after activation map fail-closed with the focus side effect", async () => {
		// Activation succeeded (window focus already happened), then the snapshot
		// step fails three ways: adapter failure envelope, unparsable stdout, and
		// a success envelope whose data is not a string and has no string
		// `snapshot` field (opaque-ref unwrap contract).
		for (const { snapshotResult, message } of [
			{
				snapshotResult: okCommand(
					JSON.stringify({ success: false, error: "tab t1 unavailable" }),
				),
			},
			{
				snapshotResult: {
					exitCode: 0,
					stdout: "not-json",
					stderr: "",
					timedOut: false,
				},
			},
			{
				snapshotResult: okCommand(
					JSON.stringify({ success: true, data: { refs: {} } }),
				),
				message:
					"The agent-browser snapshot call returned an unexpected payload shape.",
			},
		]) {
			const { runtime, calls } = operationRuntime({
				adapter: "agent-browser",
				pages: [{ id: "tab-alpha", targetId: "cdp-9f3c", url: "https://example.com/app", title: "App" }],
				nativeResults: [
					okCommand(JSON.stringify({ success: true, data: {} })),
					snapshotResult,
				],
			});
			const result = await runForTest(
				["operate", "snapshot", "--handoff", "/h.json", "--json"],
				runtime,
			);
			expect(result.exitCode).toBe(20);
			const json = parseJson(result.stdout);
			expect(json.error).toMatchObject({
				code: "browser_operation_transport_failed",
				...(message ? { message } : {}),
			});
			// Discovery list + release, activation + strict proof + snapshot, then operation release.
			expect(calls).toHaveLength(8);
			// Activation succeeded, so the failure envelope truthfully reports the
			// window-focus side effect.
			expect(json.data).toMatchObject({ side_effects: { focus: true } });
			expect([result.stdout, result.stderr].join("\n")).not.toContain("tab-alpha");
		}
	});

	test("agent-browser discovery release failure stops before custody or operation spawn", async () => {
		// Discovery (tab list) works; every subsequent native spawn throws, as a
		// missing agent-browser binary would. The lane maps the thrown spawn to
		// browser_operation_dependency_missing instead of leaking the throw.
		const calls: McporterCommandInput[] = [];
		const xdg = makeTempXdgEnv();
		operationXdgCleanups.push(xdg.dispose);
		const runtime = makeRuntime({
			env: xdg.env,
			now: () => 2_000,
			readTextFile: async (path) => {
				if (path === "/h.json") {
					return verifiedHandoffEnvelope((envelope) => {
						envelope.data.attachment.adapter_id = "agent-browser";
					});
				}
				throw enoent(path);
			},
			runCommand: async (call) => {
				calls.push(call);
				const vector = commandVector(call);
			if (vector.includes("tab") && vector.includes("list")) {
					return okCommand(
						JSON.stringify({
							success: true,
							data: {
								tabs: [
									{
										tabId: "tab-alpha",
										targetId: "cdp-9f3c",
										url: "https://example.com/app",
										title: "App",
									},
								],
							},
						}),
					);
			}
				throw new Error("spawn agent-browser ENOENT");
			},
		});
		const result = await runForTest(
			["operate", "snapshot", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(20);
		expect(parseJson(result.stdout).error).toMatchObject({
			code: "browser_operation_transport_failed",
		});
		// Discovery list + its failed exact release. No custody or operation call.
		expect(calls).toHaveLength(2);
		expect(calls.some((call) => call.args.includes("cdp-9f3c"))).toBe(false);
		expect([result.stdout, result.stderr].join("\n")).not.toContain("tab-alpha");
	});

	test("a malformed chrome page ref fails as a lane-honest transport failure", async () => {
		const { runtime, calls } = operationRuntime({
			pages: [{ id: "tab-alpha", targetId: "cdp-9f3c", url: "https://example.com/app", title: "App" }],
		});
		const result = await runForTest(
			["operate", "snapshot", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(20);
		expect(parseJson(result.stdout).error).toMatchObject({
			code: "browser_operation_transport_failed",
			message:
				"The chrome-devtools-mcp page ref must be a non-negative integer.",
		});
		expect(calls).toHaveLength(1);
	});

	test("a discovered page without a handle retains target-missing recovery", async () => {
		const { runtime, calls } = operationRuntime({
			pages: [{ url: "https://example.com/app", title: "App" }],
		});
		const result = await runForTest(
			["operate", "snapshot", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(20);
		expect(parseJson(result.stdout)).toMatchObject({
			error: { code: "browser_operation_target_missing" },
			continuation: {
				next_action_id: "rerun_handoff_bound_target_discovery",
			},
		});
		expect(calls).toHaveLength(1);
	});

	test("a discovered page with an empty-string id retains target-missing recovery", async () => {
		// An empty id is not a usable adapter page handle: same fail-closed
		// target-missing mapping as a page with no id at all, before any
		// operation transport.
		const { runtime, calls } = operationRuntime({
			pages: [{ id: "", url: "https://example.com/app", title: "App" }],
		});
		const result = await runForTest(
			["operate", "snapshot", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(20);
		expect(parseJson(result.stdout)).toMatchObject({
			error: { code: "browser_operation_target_missing" },
			continuation: {
				next_action_id: "rerun_handoff_bound_target_discovery",
			},
		});
		expect(calls).toHaveLength(1);
		expect(commandVector(calls[0])).toContain("list_pages");
	});

	test("snapshot emits normalized JSON for the selected Browser Target (AE7)", async () => {
		const { runtime, calls } = operationRuntime({
			files: { "/state.json": selectedStateFile() },
		});
		const result = await runForTest(
			["operate", "snapshot", "--state", "/state.json", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(0);
		const json = parseJson(result.stdout);
		expect(json.status).toBe("ok");
		expect(json.data).toMatchObject({
			contract: BROWSER_USE_OPERATION_CONTRACT_ID,
			schema_version: BROWSER_USE_OPERATION_SCHEMA_VERSION,
			command: "operate-snapshot",
			result_kind: "browser_operation",
			operation: "snapshot",
			adapter: "chrome-devtools-mcp",
			target_source: "selected_state",
			binding: {
				outer_run_id: FIXTURE_RUN_ID,
				run_id: FIXTURE_RUN_ID,
				handoff_evidence_id: FIXTURE_EVIDENCE_ID,
				browser_authority_id:
					"cf17a739b9cc02280d8015e2b2a92a3b244a5c997004754bfb5e5a5fcda16693",
			},
			side_effects: { focus: false },
			execution: { scope: "browser-wide", focus: false },
			target: {
				target_ref:
					"047728b9d44d2e7a88ab755236fa1a2edf8847b2e0a094c5913bef0a43d09aa4",
				origin: "https://example.com",
			},
			custody: {
				browser_lane: {
					acquired_at_epoch_ms: expect.any(Number),
					released_at_epoch_ms: expect.any(Number),
				},
				target_operation_lease: {
					acquired_at_epoch_ms: expect.any(Number),
					released_at_epoch_ms: expect.any(Number),
				},
			},
		});
		expect((json.data as Record<string, any>).snapshot.text).toContain("Root");
		// Default operate path (U3): list_pages then the operation — no
		// select_page call. Page routing rides the args pageId through
		// --experimentalPageIdRouting; process-local selection state in a fresh
		// adapter spawn is meaningless.
		expect(calls).toHaveLength(2);
		expect(
			calls.filter((call) => commandVector(call).includes("select_page")),
		).toHaveLength(0);
		const snapshotVector = commandVector(calls[1]);
		expect(snapshotVector).toContain("take_snapshot");
		// R1/R2: the server portion is envelope-derived — pinned binary and
		// endpoint.http verbatim — with the keep-alive env guard on the spawn.
		expect(snapshotVector).toContain(
			FIXTURE_ENVELOPE.data.attachment.probe_executable,
		);
		expect(snapshotVector).toContain(FIXTURE_ENVELOPE.data.endpoint.http);
		expect(calls[1].env).toEqual({ MCPORTER_NO_KEEPALIVE: "*" });
		expect(commandJsonArgs(calls[1])).toEqual({ pageId: 1 });
	});

	test("an unconfirmed Browser Lane release blocks a browser-wide success receipt", async () => {
		const { runtime } = operationRuntime({
			files: { "/state.json": selectedStateFile() },
			invalidateBrowserLaneAfterOperation: true,
		});
		const result = await runForTest(
			[
				"operate",
				"snapshot",
				"--state",
				"/state.json",
				"--handoff",
				"/h.json",
				"--json",
			],
			runtime,
		);
		expect(result.exitCode).toBe(1);
		expect(parseJson(result.stdout)).toMatchObject({
			status: "error",
			data: {
				primary_cause: "browser_operation_completed",
				cleanup_debt: ["browser-lane-release-failed"],
			},
			error: { code: "browser_operation_cleanup_incomplete" },
		});
	});

	test("screenshot-media capture blocks success when Browser Lane release is unconfirmed", async () => {
		const { runtime } = operationRuntime({
			adapter: "agent-browser",
			invalidateBrowserLaneAfterOperation: true,
			nativeResults: [
				okCommand(agentBrowserSuccess({ selected: true })),
				okCommand(agentBrowserSuccess({ url: "https://example.com/app" })),
				okCommand(agentBrowserSuccess({ captured: true })),
			],
			pages: [
				{
					id: "tab-shot",
					targetId: "cdp-stable",
					url: "https://example.com/app",
					title: "App",
				},
			],
		});
		const parsed = parseHandoffFacts(AGENT_BROWSER_HANDOFF);
		if (!parsed.ok || parsed.kind !== "verified") {
			throw new Error("fixture handoff invalid");
		}
		const deps = await custodyDeps(runtime);
		const acquired = await acquireTargetOperationLease(deps, {
			authorityId: FIXTURE_BROWSER_AUTHORITY,
			runId: FIXTURE_RUN_ID,
			adapterId: "agent-browser",
			rawTargetId: "cdp-stable",
			operation: "read",
			ttlMs: 30_000,
			ownershipEvidence: {
				kind: "adapter-creation-receipt",
				adapter_id: "agent-browser",
				run_id: FIXTURE_RUN_ID,
				raw_target_id: "cdp-stable",
			},
		});
		if (!acquired.ok) throw new Error("fixture target lease failed");
		try {
			const result = await captureBrowserUseScreenshotMedia({
				runtime,
				handoff: parsed.facts,
				adapterPageRef: "cdp-stable",
				artifact: {
					path: `${runtime.env.XDG_STATE_HOME}/capture.png`,
					relativePath: "capture.png",
					root: runtime.env.XDG_STATE_HOME as string,
					format: "png",
					fullPage: false,
				},
				custody: {
					deps,
					rawTargetId: "cdp-stable",
					targetLease: acquired.lease,
					ttlMs: 30_000,
				},
			});
			expect(result).toMatchObject({
				ok: false,
				code: "browser_operation_cleanup_incomplete",
				cleanup_debt: ["browser-lane-release-failed"],
			});
		} finally {
			await releaseTargetOperationLease(deps, acquired.lease);
			await releaseRunTargetOwnership(deps, FIXTURE_RUN_ID);
		}
	});

	test("--bring-to-front issues an explicit select_page focus call before the operation", async () => {
		// --bring-to-front keeps its contract meaning (explicit focus side
		// effect): an explicit select_page {pageId, bringToFront:true} rides the
		// same envelope-derived transport BEFORE the operation. Without the flag
		// no select_page call happens at all.
		const { runtime, calls } = operationRuntime({
			env: { BROWSER_USE_ARTIFACT_ROOT: "/tmp/browser-use-artifacts-test" },
		});
		const result = await runForTest(
			["operate", "screenshot", "--out", "shot.png", "--bring-to-front", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(0);
		expect(calls).toHaveLength(3);
		expect(commandVector(calls[1])).toContain("select_page");
		expect(commandJsonArgs(calls[1])).toEqual({ pageId: 1, bringToFront: true });
		expect(calls[1].env).toEqual({ MCPORTER_NO_KEEPALIVE: "*" });
		expect(commandVector(calls[2])).toContain("take_screenshot");
		expect(parseJson(result.stdout).data).toMatchObject({
			side_effects: { focus: true },
		});
	});

	test("snapshot can operate against adapter page id 0", async () => {
		const { runtime, calls } = operationRuntime({
			files: {
				"/state.json": selectedStateFile({
					target_candidate_id: operationCandidateId("0"),
				}),
			},
			pages: [{ id: "0", url: "https://example.com/app", title: "App" }],
		});
		const result = await runForTest(
			["operate", "snapshot", "--state", "/state.json", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(0);
		// The operation itself carries pageId 0 (no select_page step).
		expect(commandVector(calls[1])).toContain("take_snapshot");
		expect(commandJsonArgs(calls[1])).toEqual({ pageId: 0 });
	});

	test("snapshot --verbose passes verbose transport args alongside the page routing", async () => {
		const { runtime, calls } = operationRuntime({
			files: { "/state.json": selectedStateFile() },
		});
		const result = await runForTest(
			["operate", "snapshot", "--verbose", "--state", "/state.json", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(0);
		expect(commandJsonArgs(calls[1])).toEqual({ pageId: 1, verbose: true });
	});

	test("screenshot writes an artifact path and keeps screenshot bytes out of JSON (AE9)", async () => {
		const { runtime, calls, ensuredDirectories } = operationRuntime({
			env: { BROWSER_USE_ARTIFACT_ROOT: "/tmp/browser-use-artifacts-test" },
			operationResult: okCommand(
				JSON.stringify({ content: [{ type: "image", data: "BASE64SECRET" }] }),
			),
		});
		const result = await runForTest(
			["operate", "screenshot", "--out", "shot.png", "--full-page", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(0);
		const json = parseJson(result.stdout);
		expect(json.data).toMatchObject({
			operation: "screenshot",
			screenshot: {
				artifact: {
					path: "/tmp/browser-use-artifacts-test/shot.png",
					relative_path: "shot.png",
					root: "/tmp/browser-use-artifacts-test",
					format: "png",
					full_page: true,
					byte_count: 11,
					content_sha256:
						"573837877e9e8d282ac2eb535ca9e7fc55caf7efd46d75ea96f588b7e1412f5e",
					media_type: "image/png",
				},
			},
		});
		expect(result.stdout).not.toContain("BASE64SECRET");
		expect(ensuredDirectories).toEqual(["/tmp/browser-use-artifacts-test"]);
		expect(commandVector(calls[1])).toContain("take_screenshot");
		// filePath/fullPage survive alongside the pageId routing.
		expect(commandJsonArgs(calls[1])).toEqual({
			pageId: 1,
			filePath: "/tmp/browser-use-artifacts-test/shot.png",
			fullPage: true,
			format: "png",
		});
	});

	test("emulate emits normalized viewport facts without exposing adapter method names (AE12)", async () => {
		const { runtime, calls } = operationRuntime();
		const result = await runForTest(
			["operate", "emulate", "--width", "390", "--height", "844", "--dpr", "3", "--mobile", "--touch", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(0);
		const json = parseJson(result.stdout);
		expect(json.data).toMatchObject({
			operation: "emulate",
			emulation: {
				viewport: {
					width: 390,
					height: 844,
					device_scale_factor: 3,
					mobile: true,
					touch: true,
					landscape: false,
				},
			},
		});
		expect(result.stdout).not.toContain("chrome-devtools.emulate");
		// The emulate args carry the combined viewport string plus pageId routing.
		expect(commandJsonArgs(calls[1])).toEqual({
			pageId: 1,
			viewport: "390x844x3,mobile,touch",
		});
	});

	test("operation transport timeout maps to browser_operation_transport_timeout", async () => {
		const { runtime } = operationRuntime({
			operationResult: { exitCode: 1, stdout: "", stderr: "", timedOut: true },
		});
		const result = await runForTest(
			["operate", "snapshot", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(20);
		const json = parseJson(result.stdout);
		expect(json.error).toMatchObject({
			code: "browser_operation_transport_timeout",
		});
		// With the default select_page step deleted (U3), no focus side effect
		// occurs unless --bring-to-front was passed.
		expect(json.data).toMatchObject({
			side_effects: { focus: false },
		});
	});

	test("command-vector override prefixes the live operate calls (AE10)", async () => {
		const { runtime, calls } = operationRuntime({
			env: { BROWSER_USE_MCPORTER_COMMAND_JSON: '["bunx","mcporter"]' },
		});
		const result = await runForTest(
			["operate", "snapshot", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(0);
		expect(commandVector(calls[0]).slice(0, 2)).toEqual(["bunx", "mcporter"]);
		expect(commandVector(calls[1]).slice(0, 2)).toEqual(["bunx", "mcporter"]);
	});

	test("the envelope's websocket debugger URL never appears in operation output", async () => {
		const { runtime } = operationRuntime();
		const result = await runForTest(
			["operate", "snapshot", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).not.toContain("ws://");
		expect(result.stdout).not.toContain("devtools/browser");
	});

	test("a chrome-devtools-mcp operation publishes the CDP-resolved target id and http endpoint", async () => {
		const { runtime } = operationRuntime();
		const result = await runForTest(
			["operate", "snapshot", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(0);
		expect(parseJson(result.stdout).data).toMatchObject({
			schema_version: BROWSER_USE_OPERATION_SCHEMA_VERSION,
			adapter: "chrome-devtools-mcp",
			target: {
				target_id: "cdp-target-test",
				cdp_endpoint: FIXTURE_ENVELOPE.data.endpoint.http,
			},
		});
	});

	test("an agent-browser operation publishes the adapter-reported canonical target id", async () => {
		const { runtime } = operationRuntime({
			adapter: "agent-browser",
			pages: [
				{
					id: "tab-alpha",
					targetId: "cdp-9f3c",
					url: "https://example.com/app",
					title: "App",
				},
			],
			nativeResults: [
				okCommand(JSON.stringify({ success: true, data: {} })),
				okCommand(
					JSON.stringify({
						success: true,
						data: { snapshot: "Root\nButton", refs: {} },
					}),
				),
			],
		});
		const result = await runForTest(
			["operate", "snapshot", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(0);
		expect(parseJson(result.stdout).data).toMatchObject({
			adapter: "agent-browser",
			target: {
				target_id: "cdp-9f3c",
				cdp_endpoint: FIXTURE_ENVELOPE.data.endpoint.http,
			},
		});
	});

	test("the published target id addresses a tab without exposing the session-local tab id", async () => {
		// The canonical CDP target id is portable across adapter sessions; the
		// `tN` tab id is not, so publishing one must never leak the other.
		const { runtime } = operationRuntime({
			adapter: "agent-browser",
			pages: [
				{
					id: "tab-alpha",
					targetId: "cdp-9f3c",
					url: "https://example.com/app",
					title: "App",
				},
			],
			nativeResults: [
				okCommand(JSON.stringify({ success: true, data: {} })),
				okCommand(
					JSON.stringify({
						success: true,
						data: { snapshot: "Root\nButton", refs: {} },
					}),
				),
			],
		});
		const result = await runForTest(
			["operate", "snapshot", "--handoff", "/h.json", "--json"],
			runtime,
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("cdp-9f3c");
		expect([result.stdout, result.stderr].join("\n")).not.toContain("tab-alpha");
		expect(result.stdout).not.toContain("ws://");
	});
});
