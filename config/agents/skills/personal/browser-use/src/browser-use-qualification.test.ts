import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
	BROWSER_USE_OPERATION_CONTRACT_ID,
	BROWSER_USE_OPERATION_SCHEMA_VERSION,
	BROWSER_USE_TARGET_TOPOLOGY_CONTRACT_ID,
	BROWSER_USE_TARGET_TOPOLOGY_SCHEMA_VERSION,
} from "./command-contract";
import { verifiedHandoffEnvelope } from "./browser-connect-handoff-fixtures";
import { runForTest } from "./browser-use";
import { makeRuntime, parseJson } from "./browser-use-test-helpers";
import {
	createDefaultPlatformFs,
	openBrowserUsePaths,
} from "./browser-use-paths";
import { makeTempXdgEnv } from "./browser-use-platform-test-helpers";
import { acquireLease } from "./browser-use-locks";
import type { BrowserUseRuntime } from "./browser-use-runtime";
import {
	BROWSER_USE_LOCAL_QUALIFICATION_THREAT_MODEL,
	type BrowserUseQualificationCustodyInventory,
	type BrowserUseQualificationManifest,
	captureBrowserUseQualificationCustodyInventory,
	createBrowserUseQualificationManifest,
	validateBrowserUseQualificationEvidence as validateQualificationEvidenceOwner,
	validateBrowserUseQualificationManifest as validateQualificationManifestOwner,
} from "./browser-use-qualification";
import { sealedQualificationRuntimeEvidence } from "./browser-use-qualification-evidence";
import { BrowserUseQualificationSessionAuthority } from "./browser-use-qualification-session";
import { parseBrowserOperationQualificationReceipt } from "./browser-use-operations";

const RUN_A = "qualification-run-a";
const RUN_B = "qualification-run-b";
const ORIGIN_A = "https://storybook-a.example.test";
const ORIGIN_B = "https://storybook-b.example.test";
const TARGET_ID_A = "target-a-raw";
const TARGET_ID_B = "target-b-raw";
const TARGET_A =
	"4114c9c79a4b77fb41067891c87621fd5646f883e160cd6a21f0d70ac9f48a4e";
const TARGET_B =
	"22a4496c41a9eeddc378b5f2a90b2168abb0199571bc43fe21526bdaa4ec7ba6";
const AUTHORITY =
	"cf17a739b9cc02280d8015e2b2a92a3b244a5c997004754bfb5e5a5fcda16693";
// Independent test-owned oracle: these behaviour owners were derived from an
// external Bun metafile review, never from the production manifest creator.
const OMITTED_WARM_CHROME_EXECUTION_INPUTS = [
	".agents/runtime/warm-chrome/src/branch-station-catalog.ts",
	".agents/runtime/warm-chrome/src/cli.ts",
	".agents/runtime/warm-chrome/src/command-contract.ts",
	".agents/runtime/warm-chrome/src/launch.ts",
	".agents/runtime/warm-chrome/src/model.ts",
	".agents/runtime/warm-chrome/src/proof.ts",
	".agents/runtime/warm-chrome/src/repair.ts",
	".agents/runtime/warm-chrome/src/runtime.ts",
] as const;
const NATIVE_SUPERVISOR = resolve(
	import.meta.dir,
	"../../../../../../.agents/runtime/browser-use-environment-auth/.build/release/browser-use-op-supervisor",
);

async function nativeSnapshotCommand(
	input: Parameters<BrowserUseRuntime["runCommand"]>[0],
): ReturnType<BrowserUseRuntime["runCommand"]> {
	const child = Bun.spawn([input.command, ...input.args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr, timedOut: false };
}

function nativeSnapshotEnv(env: Record<string, string | undefined>) {
	return { ...env, BROWSER_USE_QUALIFICATION_SUPERVISOR_PATH: NATIVE_SUPERVISOR };
}

function testSha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function finalCustody(
	authorityId = AUTHORITY,
	leaseRecordRaws: string[] = [],
	revision = 1,
): BrowserUseQualificationCustodyInventory {
	const registryRaw = JSON.stringify({
		contract: "browser-use.browser-custody",
		schema_version: "1",
		authority_id: authorityId,
		revision,
		targets: {},
	});
	const entries = [
		{
			kind: "registry" as const,
			path: "browser-custody/registry.json",
			sha256: testSha256(registryRaw),
		},
		...leaseRecordRaws.map((raw, index) => ({
			kind: "lease" as const,
			path: `leases/${String(index).padStart(32, "0")}.json`,
			sha256: testSha256(raw),
		})),
	];
	return {
		inventory_receipt: {
			contract: "browser-use.qualification-custody-inventory",
			schema_version: "1",
			authority_id: authorityId,
			root_path: "/private/state/canonical",
			root_realpath: "/private/state/canonical",
			registry_count: 1,
			lease_count: leaseRecordRaws.length,
			entry_count: entries.length,
			inventory_digest: testSha256(JSON.stringify(entries)),
			registry_revision: revision,
			native_snapshot_digest: "f".repeat(64),
			entries,
		},
		registry_raw: registryRaw,
		lease_record_raws: leaseRecordRaws,
	};
}

async function validateBrowserUseQualificationManifest(
	manifest: Awaited<ReturnType<typeof createBrowserUseQualificationManifest>>,
	deps?: Parameters<typeof validateQualificationManifestOwner>[2],
) {
	return await validateQualificationManifestOwner(
		manifest,
		manifest.manifest_digest,
		deps,
	);
}

async function validateBrowserUseQualificationEvidence(input: {
	manifest: Awaited<ReturnType<typeof createBrowserUseQualificationManifest>>;
	evidence: unknown;
	observedFinalCustody?: Parameters<
		typeof validateQualificationEvidenceOwner
	>[0]["observedFinalCustody"];
}) {
	const bound = structuredClone(input.evidence) as Record<string, unknown>;
	const sessionAuthority = new BrowserUseQualificationSessionAuthority();
	const expected =
		typeof bound.expected_manifest_digest === "string"
			? bound.expected_manifest_digest
			: input.manifest.manifest_digest;
	bound.expected_manifest_digest = expected;
	bound.observed_manifest_digest ??= input.manifest.manifest_digest;
	const sealedRuntime = (input.manifest as unknown as Record<string, unknown>)
		.sealed_runtime;
	for (const rawRun of Array.isArray(bound.runs) ? bound.runs : []) {
		const run = rawRun as Record<string, unknown>;
		if (typeof run.handoff_raw !== "string" || typeof run.run_id !== "string") continue;
		if (run.producer_receipt_raw === "__TEST_OWNER_FILL__") {
			const manifestRecord = input.manifest as unknown as Record<string, unknown>;
			const closure = manifestRecord.execution_closure as Record<string, unknown>;
			const browserConnect = manifestRecord.browser_connect as Record<string, unknown>;
			const warmChrome = manifestRecord.warm_chrome as Record<string, unknown>;
			run.producer_receipt_raw = producerReceipt({
				runId: String(run.run_id),
				handoffRaw: String(run.handoff_raw),
				manifestDigest: expected,
				artifactSha256:
					typeof sealedRuntime === "object" && sealedRuntime !== null
						? String(
								(sealedRuntime as Record<string, unknown>).artifact_sha256 ?? "",
							)
						: undefined,
				executionClosureSha256: String(closure.bundle_sha256),
				browserConnectSha256: String(browserConnect.content_sha256),
				warmChromeSha256: String(warmChrome.content_sha256),
			});
		}
		run.handoff_capability_handle = sessionAuthority.admitHandoff({
			runId: run.run_id,
			raw: run.handoff_raw,
			producerReceiptRaw: String(run.producer_receipt_raw ?? ""),
			handle:
				typeof run.handoff_capability_handle === "string"
					? run.handoff_capability_handle
					: undefined,
		});
	}
	return await validateQualificationEvidenceOwner({
		manifest: input.manifest,
		evidence: bound,
		expectedManifestDigest: expected,
		observedFinalCustody:
			input.observedFinalCustody ??
			(structuredClone(
				bound.final_custody ?? finalCustody(),
			) as Parameters<typeof validateQualificationEvidenceOwner>[0]["observedFinalCustody"]),
		sessionAuthority,
	});
}

function handoff(runId: string): string {
	return verifiedHandoffEnvelope((envelope) => {
		envelope.run_id = runId;
		envelope.data.attachment.adapter_id = "agent-browser";
		envelope.data.attachment.probe_executable =
			"/opt/side-quest/browser-connect/adapters/agent-browser";
	});
}

function producerReceipt(input: {
	runId: string;
	handoffRaw: string;
	manifestDigest: string;
	artifactSha256?: string;
	executionClosureSha256: string;
	browserConnectSha256: string;
	warmChromeSha256: string;
}): string {
	return JSON.stringify({
		status: "ok",
		data: {
			contract: "browser-use.qualification-handoff-producer",
			schema_version: "1",
			command: "qualification-handoff",
			producer: "browser-connect",
			adapter: "agent-browser",
			run_id: input.runId,
			handoff_sha256: testSha256(input.handoffRaw),
			handoff_evidence_id:
				input.runId === RUN_A
					? "168ed585dd6cff44d7eb7983ebf64137"
					: "905e90cb2e2ae4a92c9b51b668464090",
			browser_authority_id: AUTHORITY,
			expected_manifest_digest: input.manifestDigest,
			observed_manifest_digest: input.manifestDigest,
			...(input.artifactSha256 === undefined
				? {}
				: { sealed_artifact_sha256: input.artifactSha256 }),
			producer_identity: {
				execution_closure_sha256: input.executionClosureSha256,
				browser_connect_sha256: input.browserConnectSha256,
				warm_chrome_sha256: input.warmChromeSha256,
			},
		},
	});
}

function receipt(input: {
	runId: string;
	origin: string;
	targetRef: string;
	scope?: "target-local" | "browser-wide";
	acquired?: number;
	released?: number;
}): string {
	const scope = input.scope ?? "target-local";
	const evidenceId =
		input.runId === RUN_A
			? "168ed585dd6cff44d7eb7983ebf64137"
			: "905e90cb2e2ae4a92c9b51b668464090";
	return JSON.stringify({
		status: "ok",
		run_id: input.runId,
		duration_ms: 1,
		runtime_actions: [{ id: "inspect_operation_result", summary: "Inspect.", sideEffects: ["check"] }],
		continuation: { next_action_id: "inspect_operation_result" },
		data: {
			contract: BROWSER_USE_OPERATION_CONTRACT_ID,
			schema_version: BROWSER_USE_OPERATION_SCHEMA_VERSION,
			command: scope === "target-local" ? "operate-snapshot" : "operate-screenshot",
			result_kind: "browser_operation",
			operation: scope === "target-local" ? "snapshot" : "screenshot",
			adapter: "agent-browser",
			effect: "confirmed",
			binding: {
				outer_run_id: input.runId,
				run_id: input.runId,
				handoff_evidence_id: evidenceId,
				browser_authority_id:
					"cf17a739b9cc02280d8015e2b2a92a3b244a5c997004754bfb5e5a5fcda16693",
				target_candidate_id: input.runId === RUN_A ? "candidate-a" : "candidate-b",
			},
			target_source: "selected_state",
			target: {
				candidate_ordinal: 0,
				candidate_id: input.runId === RUN_A ? "candidate-a" : "candidate-b",
				target_id: input.runId === RUN_A ? TARGET_ID_A : TARGET_ID_B,
				target_ref: input.targetRef,
				cdp_endpoint: "http://127.0.0.1:9222",
				origin: input.origin,
			},
			execution: {
				scope,
				focus: scope !== "target-local",
				...(scope === "target-local"
					? {
							capability_id:
								"agent-browser.exact-target-no-focus.v1",
						}
					: {}),
			},
			side_effects: { focus: scope !== "target-local" },
			custody: {
				target_operation_lease: {
					acquired_at_epoch_ms: input.acquired ?? 10,
					released_at_epoch_ms: input.released ?? 20,
				},
				...(scope === "browser-wide"
					? {
							browser_lane: {
								acquired_at_epoch_ms: input.acquired ?? 10,
								released_at_epoch_ms: input.released ?? 20,
							},
						}
					: {}),
			},
			...(scope === "target-local"
				? { snapshot: { text: "page", line_count: 1, byte_count: 4, truncated: false, limits: { max_bytes: 1, max_lines: 1 } } }
				: {
						screenshot: {
							artifact: {
								path: "/private/evidence/a.png",
								relative_path: "a.png",
								root: "/private/evidence",
								format: "png",
								full_page: false,
								byte_count: 7,
								content_sha256: "c".repeat(64),
								media_type: "image/png",
							},
						},
					}),
		},
	});
}

function topologyReceipt(input: {
	runId: string;
	origin: string;
	targetRef: string;
	acquired: number;
	released: number;
}): string {
	const evidenceId =
		input.runId === RUN_A
			? "168ed585dd6cff44d7eb7983ebf64137"
			: "905e90cb2e2ae4a92c9b51b668464090";
	return JSON.stringify({
		status: "ok",
		run_id: input.runId,
		duration_ms: 1,
		runtime_actions: [{ id: "inspect_operation_result", summary: "Inspect.", sideEffects: ["check"] }],
		continuation: { next_action_id: "inspect_operation_result" },
		data: {
			contract: BROWSER_USE_TARGET_TOPOLOGY_CONTRACT_ID,
			schema_version: BROWSER_USE_TARGET_TOPOLOGY_SCHEMA_VERSION,
			adapter: "agent-browser",
			effect: "confirmed",
			command: "targets-open",
			result_kind: "browser_target_topology",
			target_mutated: true,
			target_present: true,
			already_absent: false,
			qualification_eligible: true,
			binding: {
				outer_run_id: input.runId,
				run_id: input.runId,
				handoff_evidence_id: evidenceId,
				browser_authority_id:
					"cf17a739b9cc02280d8015e2b2a92a3b244a5c997004754bfb5e5a5fcda16693",
			},
			target_ref: input.targetRef,
			normalized_origin: input.origin,
			target: { target_ref: input.targetRef, origin: input.origin },
			custody: {
				target_operation_lease: {
					acquired_at_epoch_ms: input.acquired,
					released_at_epoch_ms: input.released,
				},
				browser_lane: {
					acquired_at_epoch_ms: input.acquired,
					released_at_epoch_ms: input.released,
				},
			},
		},
	});
}

function evidence(overrides: Record<string, unknown> = {}) {
	return {
		contract: "browser-use.qualification-evidence",
		schema_version: "1",
		adapter_capability_id: "agent-browser.exact-target-no-focus.v1",
		threat_model: structuredClone(BROWSER_USE_LOCAL_QUALIFICATION_THREAT_MODEL),
		runs: [
			{
				run_id: RUN_A,
				handoff_raw: handoff(RUN_A),
				handoff_capability_handle: "qualification-test-handoff-a",
				producer_receipt_raw: "__TEST_OWNER_FILL__",
				expected_origin: ORIGIN_A,
				expected_target_ref: TARGET_A,
				receipt_raws: [
					topologyReceipt({
						runId: RUN_A,
						origin: ORIGIN_A,
						targetRef: TARGET_A,
						acquired: 1,
						released: 2,
					}),
					receipt({ runId: RUN_A, origin: ORIGIN_A, targetRef: TARGET_A }),
				],
			},
		],
		...overrides,
	};
}

describe("Browser Use qualification authority", () => {
	test("receipt capabilities bind one exact execute request and reject duplicate observed bytes", () => {
		const authority = new BrowserUseQualificationSessionAuthority();
		const handoffHandle = authority.admitHandoff({
			runId: RUN_A,
			raw: handoff(RUN_A),
			producerReceiptRaw: "test-owned-producer-evidence",
		});
		const receiptRaw = '{"status":"ok","data":{"receipt":"literal-a"}}';
		const receiptHandle = authority.admitReceipt({
			handoffHandle,
			runId: RUN_A,
			requestId: "execute-a",
			raw: receiptRaw,
		});

		expect(
			(authority.consumeReceipts as unknown as (input: unknown) => unknown)({
				receiptCapabilities: [
					{ handle: receiptHandle, request_id: "execute-b" },
				],
				handoffHandle,
				runId: RUN_A,
			}),
		).toEqual({
			ok: false,
			code: "qualification_receipt_capability_mismatch",
		});
		expect(() =>
			authority.admitReceipt({
				handoffHandle,
				runId: RUN_A,
				requestId: "execute-c",
				raw: receiptRaw,
			}),
		).toThrow("qualification_receipt_capability_duplicate");
	});

	test("the manifest declares the exact cooperative same-uid threat model and no hostile-writer guarantee", async () => {
		const manifest = await createBrowserUseQualificationManifest() as BrowserUseQualificationManifest & {
			threat_model?: {
				id?: string;
				properties_proved?: string[];
				does_not_protect?: string[];
			};
		};
		expect(manifest.threat_model).toEqual({
			id: "cooperative-same-uid-canonical-writer-v1",
			properties_proved: [
				"procedural-single-writer-custody-declared",
				"cooperative-source-drift-detected-before-and-after",
				"reviewed-closure-byte-identical-before-and-after",
				"sealed-session-handoff-capability-not-replayable",
			],
			does_not_protect: [
				"malicious-or-noncooperating-same-uid-writers",
				"compliant-writer-that-does-not-consult-the-private-drift-guard",
				"debugger-injection",
				"forged-source-drift-guard-files",
				"adversarial-time-of-check-time-of-use",
			],
		});
	});

	test("missing or hostile same-uid threat-model claims never validate", async () => {
		const manifest = await createBrowserUseQualificationManifest();
		for (const candidate of [
			undefined,
			{
				...structuredClone(BROWSER_USE_LOCAL_QUALIFICATION_THREAT_MODEL),
				properties_proved: [
					...BROWSER_USE_LOCAL_QUALIFICATION_THREAT_MODEL.properties_proved,
					"hostile-same-uid-immutability",
				],
			},
		]) {
			const input = evidence();
			(input as Record<string, unknown>).threat_model = candidate;
			expect(
				await validateBrowserUseQualificationEvidence({ manifest, evidence: input }),
			).toMatchObject({ ok: false, code: "qualification_threat_model_invalid" });
		}
	});

	test("a structurally perfect persisted producer receipt is evidence, never replayable authority", async () => {
		const manifest = await createBrowserUseQualificationManifest();
		const input = evidence();
		(input as Record<string, unknown>).expected_manifest_digest =
			manifest.manifest_digest;
		(input as Record<string, unknown>).observed_manifest_digest =
			manifest.manifest_digest;
		expect(
			await validateQualificationEvidenceOwner({
				manifest,
				evidence: input,
				expectedManifestDigest: manifest.manifest_digest,
				observedFinalCustody: finalCustody(),
			}),
		).toMatchObject({
			ok: false,
			code: "qualification_handoff_capability_not_live",
		});
	});

	test("the SwiftPM-owned compiled source inventory includes every supervisor dependency", async () => {
		const manifest = await createBrowserUseQualificationManifest() as BrowserUseQualificationManifest & {
			native_source_inventory?: {
				owner?: string;
				entries?: Array<{ path?: string }>;
			};
		};
		expect(manifest.native_source_inventory?.owner).toBe("swiftpm-package-description-v1");
		const paths = manifest.native_source_inventory?.entries?.map((entry) => entry.path) ?? [];
		for (const changedPath of [
			".agents/runtime/browser-use-environment-auth/Sources/BrowserUseEnvironmentAuth/DeliveryOriginSafety.swift",
			".agents/runtime/browser-use-environment-auth/Sources/BrowserUseEnvironmentAuth/CustodySnapshot.swift",
		]) {
			expect(paths).toContain(changedPath);
			expect(
				await validateQualificationManifestOwner(
					manifest,
					manifest.manifest_digest,
					{
						readFileBytes: async (absolutePath) => {
							const bytes = await readFile(absolutePath);
							return absolutePath.endsWith(changedPath)
								? Buffer.concat([bytes, Buffer.from("\n// independent mutation")])
								: bytes;
						},
					},
				),
			).toMatchObject({ ok: false, code: "qualification_manifest_mismatch" });
		}
	});
	test("a freehand or foreign handoff without the sealed producer receipt cannot qualify", async () => {
		const manifest = await createBrowserUseQualificationManifest();
		const input = evidence();
		delete (input.runs[0] as Record<string, unknown>).producer_receipt_raw;
		expect(
			await validateBrowserUseQualificationEvidence({ manifest, evidence: input }),
		).toMatchObject({ ok: false, code: "qualification_handoff_producer_invalid" });
	});

	test("a handoff producer from different Browser Connect or Warm Chrome bytes cannot qualify", async () => {
		const manifest = await createBrowserUseQualificationManifest();
		for (const field of ["browser_connect_sha256", "warm_chrome_sha256"] as const) {
			const input = evidence();
			const run = input.runs[0] as Record<string, unknown>;
			const bound = structuredClone(input) as Record<string, unknown>;
			const boundRun = (bound.runs as Array<Record<string, unknown>>)[0];
			if (!boundRun) throw new Error("test evidence run missing");
			boundRun.producer_receipt_raw = producerReceipt({
				runId: RUN_A,
				handoffRaw: String(run.handoff_raw),
				manifestDigest: manifest.manifest_digest,
				executionClosureSha256: manifest.execution_closure.bundle_sha256,
				browserConnectSha256: manifest.browser_connect.content_sha256,
				warmChromeSha256: manifest.warm_chrome.content_sha256,
			});
			const producer = JSON.parse(String(boundRun.producer_receipt_raw));
			producer.data.producer_identity[field] = "0".repeat(64);
			boundRun.producer_receipt_raw = JSON.stringify(producer);
			expect(
				await validateBrowserUseQualificationEvidence({
					manifest,
					evidence: bound,
				}),
			).toMatchObject({
				ok: false,
				code: "qualification_handoff_producer_invalid",
			});
		}
	});

	test("caller-controlled environment strings cannot mint sealed runtime evidence", () => {
		expect(
			sealedQualificationRuntimeEvidence({
				BROWSER_USE_QUALIFICATION_EXPECTED_MANIFEST_DIGEST: "a".repeat(64),
				BROWSER_USE_QUALIFICATION_OBSERVED_MANIFEST_DIGEST: "a".repeat(64),
				BROWSER_USE_QUALIFICATION_SEALED_ARTIFACT_SHA256: "b".repeat(64),
			}),
		).toBeUndefined();
	});

	test("operation qualification parser requires exact snapshot and screenshot payloads", () => {
		const snapshot = JSON.parse(
			receipt({ runId: RUN_A, origin: ORIGIN_A, targetRef: TARGET_A }),
		) as { data: Record<string, unknown> };
		const snapshotPayload = snapshot.data.snapshot as Record<string, unknown>;
		for (const field of ["text", "line_count", "byte_count", "truncated", "limits"]) {
			const candidate = structuredClone(snapshot);
			delete (candidate.data.snapshot as Record<string, unknown>)[field];
			expect(parseBrowserOperationQualificationReceipt(JSON.stringify(candidate))).toBeUndefined();
		}

		const screenshot = JSON.parse(
			receipt({
				runId: RUN_A,
				origin: ORIGIN_A,
				targetRef: TARGET_A,
				scope: "browser-wide",
			}),
		) as { data: Record<string, unknown> };
		const artifact = ((screenshot.data.screenshot as Record<string, unknown>)
			.artifact ?? {}) as Record<string, unknown>;
		artifact.byte_count = 7;
		artifact.content_sha256 = "c".repeat(64);
		artifact.media_type = "image/png";
		for (const field of [
			"path",
			"relative_path",
			"root",
			"format",
			"full_page",
			"byte_count",
			"content_sha256",
			"media_type",
		]) {
			const candidate = structuredClone(screenshot);
			delete (((candidate.data.screenshot as Record<string, unknown>)
				.artifact as Record<string, unknown>)[field]);
			expect(parseBrowserOperationQualificationReceipt(JSON.stringify(candidate))).toBeUndefined();
		}
		expect(snapshotPayload).toBeDefined();
		const extraSnapshot = structuredClone(snapshot);
		(extraSnapshot.data.snapshot as Record<string, unknown>).unexpected = true;
		expect(
			parseBrowserOperationQualificationReceipt(JSON.stringify(extraSnapshot)),
		).toBeUndefined();
		const mismatchedArtifactPath = structuredClone(screenshot);
		((mismatchedArtifactPath.data.screenshot as Record<string, unknown>)
			.artifact as Record<string, unknown>).path = "/private/evidence/other.png";
		expect(
			parseBrowserOperationQualificationReceipt(JSON.stringify(mismatchedArtifactPath)),
		).toBeUndefined();
	});

	test("operation qualification binds the public target endpoint to the verified handoff", async () => {
		const manifest = await createBrowserUseQualificationManifest();
		const input = evidence();
		const run = input.runs[0] as Record<string, unknown>;
		const receipts = run.receipt_raws as string[];
		const forged = JSON.parse(receipts[1]!) as { data: Record<string, unknown> };
		(forged.data.target as Record<string, unknown>).cdp_endpoint =
			"http://127.0.0.1:9333";
		receipts[1] = JSON.stringify(forged);
		expect(
			await validateBrowserUseQualificationEvidence({ manifest, evidence: input }),
		).toMatchObject({
			ok: false,
			code: "qualification_handoff_invalid",
		});
	});

	test("the already-loaded source runner cannot self-authorize a qualification manifest", async () => {
		const manifestResult = await runForTest(
			["qualification", "manifest", "--json"],
			makeRuntime(),
		);
		expect(manifestResult.exitCode).toBe(1);
		expect(parseJson(manifestResult.stdout)).toMatchObject({
			status: "error",
			error: { code: "qualification_manifest_unavailable" },
		});
	});

	test("manifest validation rejects canonical source inventory drift", async () => {
		const manifest = await createBrowserUseQualificationManifest();
		const changedPath =
			"/browser-use/src/browser-use-operations.ts";
		const validated = await validateBrowserUseQualificationManifest(manifest, {
			readFileBytes: async (absolutePath) => {
				const bytes = await readFile(absolutePath);
				return absolutePath.endsWith(changedPath)
					? Buffer.concat([bytes, Buffer.from("\n")])
					: bytes;
			},
		});
		expect(validated).toMatchObject({
			ok: false,
			code: "qualification_manifest_mismatch",
		});
	});

	test("the actual Browser Connect and Warm Chrome execution closure changes for every behaviour-owning input", async () => {
		const manifest = await createBrowserUseQualificationManifest();
		for (const changedPath of OMITTED_WARM_CHROME_EXECUTION_INPUTS) {
			const validated = await validateQualificationManifestOwner(
				manifest,
				manifest.manifest_digest,
				{
					readFileBytes: async (absolutePath) => {
						const bytes = await readFile(absolutePath);
						return absolutePath.endsWith(changedPath)
							? Buffer.concat([bytes, Buffer.from("\n// test-owned drift")])
							: bytes;
					},
				},
			);
			expect(validated, changedPath).toMatchObject({
				ok: false,
				code: "qualification_manifest_mismatch",
			});
		}
	});

	test("owner custody capture rejects registry aliases instead of following them", async () => {
		const xdg = makeTempXdgEnv();
		try {
			const platformFs = createDefaultPlatformFs();
			const opened = await openBrowserUsePaths(platformFs, xdg.env);
			if (!opened.ok) throw new Error(opened.refusal.code);
			const custodyDir = join(
				opened.paths.resolution.roots.state,
				"browser-custody",
			);
			await platformFs.mkdir(custodyDir, { recursive: true, mode: 0o700 });
			const alternate = join(xdg.base, "outside-registry.json");
			await writeFile(alternate, finalCustody().registry_raw, { mode: 0o600 });
			await symlink(alternate, join(custodyDir, "registry.json"));
			expect(
				await captureBrowserUseQualificationCustodyInventory({
					fs: platformFs,
					env: nativeSnapshotEnv(xdg.env),
					runCommand: nativeSnapshotCommand,
				}),
			).toBeUndefined();
		} finally {
			xdg.dispose();
		}
	});

	test("owner custody capture rejects aliased custody directories, lease directories, and lease records", async () => {
		for (const aliasKind of ["custody", "lease-directory", "lease-record"] as const) {
			const xdg = makeTempXdgEnv();
			try {
				const platformFs = createDefaultPlatformFs();
				const opened = await openBrowserUsePaths(platformFs, xdg.env);
				if (!opened.ok) throw new Error(opened.refusal.code);
				const stateRoot = opened.paths.resolution.roots.state;
				const custodyDir = join(stateRoot, "browser-custody");
				const registryPath = join(custodyDir, "registry.json");
				if (aliasKind === "custody") {
					const alternateCustody = join(xdg.base, "alternate-custody");
					await platformFs.mkdir(alternateCustody, {
						recursive: true,
						mode: 0o700,
					});
					await platformFs.writeFileDurable(
						join(alternateCustody, "registry.json"),
						finalCustody().registry_raw,
						0o600,
					);
					await symlink(alternateCustody, custodyDir, "dir");
				} else {
					await platformFs.mkdir(custodyDir, {
						recursive: true,
						mode: 0o700,
					});
					await platformFs.writeFileDurable(
						registryPath,
						finalCustody().registry_raw,
						0o600,
					);
					if (aliasKind === "lease-directory") {
						const alternateLeases = join(xdg.base, "alternate-leases");
						await platformFs.mkdir(alternateLeases, {
							recursive: true,
							mode: 0o700,
						});
						await symlink(alternateLeases, opened.paths.state.leasesDir, "dir");
					} else {
						await platformFs.mkdir(opened.paths.state.leasesDir, {
							recursive: true,
							mode: 0o700,
						});
						const alternateLease = join(xdg.base, "alternate-lease.json");
						await writeFile(alternateLease, "{}", { mode: 0o600 });
						await symlink(
							alternateLease,
							join(opened.paths.state.leasesDir, `${"0".repeat(32)}.json`),
						);
					}
				}
				expect(
					await captureBrowserUseQualificationCustodyInventory({
						fs: platformFs,
						env: nativeSnapshotEnv(xdg.env),
						runCommand: nativeSnapshotCommand,
					}),
					aliasKind,
				).toBeUndefined();
			} finally {
				xdg.dispose();
			}
		}
	});

	test("owner custody capture serializes a concurrent lease create instead of omitting it", async () => {
		const xdg = makeTempXdgEnv();
		try {
			const platformFs = createDefaultPlatformFs();
			const opened = await openBrowserUsePaths(platformFs, xdg.env);
			if (!opened.ok) throw new Error(opened.refusal.code);
			const registryPath = join(
				opened.paths.resolution.roots.state,
				"browser-custody",
				"registry.json",
			);
			await platformFs.mkdir(dirname(registryPath), {
				recursive: true,
				mode: 0o700,
			});
			await platformFs.writeFileDurable(
				registryPath,
				finalCustody().registry_raw,
				0o600,
			);
			let releaseList!: () => void;
			const listGate = new Promise<void>((resolve) => {
				releaseList = resolve;
			});
			let listed!: () => void;
			const listedPromise = new Promise<void>((resolve) => {
				listed = resolve;
			});
			const captured = captureBrowserUseQualificationCustodyInventory({
				fs: platformFs,
				env: nativeSnapshotEnv(xdg.env),
				runCommand: async (input) => {
					listed();
					await listGate;
					return await nativeSnapshotCommand(input);
				},
			});
			await listedPromise;
			let leaseSettled = false;
			const acquired = acquireLease(
				{ fs: platformFs, paths: opened.paths, clock: () => 1_000 },
				{
					key: "qualification-concurrent-lease",
					holderId: "qualification-test-holder",
					ttlMs: 1_000,
					scope: { target_id: TARGET_A },
				},
			).then((result) => {
				leaseSettled = true;
				return result;
			});
			await Bun.sleep(10);
			const settledWhileCaptureHeld = leaseSettled;
			releaseList();
			expect((await acquired).ok).toBe(true);
			expect(await captured).toBeDefined();
			expect(settledWhileCaptureHeld).toBe(false);
		} finally {
			xdg.dispose();
		}
	});

	test("forged handoff fields fail before receipt acceptance", async () => {
		const manifest = await createBrowserUseQualificationManifest();
		const forged = JSON.parse(handoff(RUN_A));
		forged.data.attachment.route = "forged-route";
		const input = evidence();
		(input.runs[0] as Record<string, unknown>).handoff_raw = JSON.stringify(forged);
		expect(
			await validateBrowserUseQualificationEvidence({ manifest, evidence: input }),
		).toMatchObject({
			ok: false,
			code: "qualification_handoff_producer_invalid",
		});
	});

	test("wrong run, origin, and target identity fail independently", async () => {
		const manifest = await createBrowserUseQualificationManifest();
		for (const [field, value, code] of [
			["run_id", RUN_B, "qualification_run_mismatch"],
			["expected_origin", ORIGIN_B, "qualification_origin_mismatch"],
			["expected_target_ref", TARGET_B, "qualification_target_mismatch"],
		] as const) {
			const input = evidence();
			(input.runs[0] as Record<string, unknown>)[field] = value;
			expect(
				await validateBrowserUseQualificationEvidence({ manifest, evidence: input }),
			).toMatchObject({ ok: false, code });
		}
	});

	test("unconfirmed release and overlapping Browser Lane intervals fail closed", async () => {
		const manifest = await createBrowserUseQualificationManifest();
		const missingRelease = evidence();
		(missingRelease.runs[0] as Record<string, unknown>).receipt_raws = [
			receipt({
				runId: RUN_A,
				origin: ORIGIN_A,
				targetRef: TARGET_A,
				scope: "browser-wide",
				released: Number.NaN,
			}),
		];
		expect(
			await validateBrowserUseQualificationEvidence({
				manifest,
				evidence: missingRelease,
			}),
		).toMatchObject({ ok: false, code: "qualification_release_unconfirmed" });

		const overlapping = evidence({
			runs: [
				{
					run_id: RUN_A,
					handoff_raw: handoff(RUN_A),
					producer_receipt_raw: "__TEST_OWNER_FILL__",
					expected_origin: ORIGIN_A,
					expected_target_ref: TARGET_A,
					receipt_raws: [
						receipt({ runId: RUN_A, origin: ORIGIN_A, targetRef: TARGET_A, scope: "browser-wide", acquired: 10, released: 30 }),
					],
				},
				{
					run_id: RUN_B,
					handoff_raw: handoff(RUN_B),
					producer_receipt_raw: "__TEST_OWNER_FILL__",
					expected_origin: ORIGIN_B,
					expected_target_ref: TARGET_B,
					receipt_raws: [
						receipt({ runId: RUN_B, origin: ORIGIN_B, targetRef: TARGET_B, scope: "browser-wide", acquired: 20, released: 40 }),
					],
				},
			],
		});
		expect(
			await validateBrowserUseQualificationEvidence({ manifest, evidence: overlapping }),
		).toMatchObject({
			ok: false,
			code: "qualification_browser_lane_overlap",
		});
	});

	test("browser-wide evidence requires both exact Target Operation Lease and Browser Lane release intervals", async () => {
		const manifest = await createBrowserUseQualificationManifest();
		const input = evidence();
		const browserWide = JSON.parse(
			receipt({
				runId: RUN_A,
				origin: ORIGIN_A,
				targetRef: TARGET_A,
				scope: "browser-wide",
			}),
		) as Record<string, unknown>;
		const browserWideData = browserWide.data as Record<string, unknown>;
		delete (browserWideData.custody as Record<string, unknown>)
			.target_operation_lease;
		(input.runs[0] as Record<string, unknown>).receipt_raws = [
			JSON.stringify(browserWide),
		];
		expect(
			await validateBrowserUseQualificationEvidence({ manifest, evidence: input }),
		).toMatchObject({ ok: false, code: "qualification_release_unconfirmed" });
	});

	test("expired run-owned bindings and leases remain residue", async () => {
		const manifest = await createBrowserUseQualificationManifest();
		const ownedCustody = finalCustody(AUTHORITY, [], 2);
		const ownedRegistry = JSON.parse(ownedCustody.registry_raw) as Record<
			string,
			unknown
		>;
		ownedRegistry.targets = {
			[TARGET_A]: {
				status: "owned",
				owner_run_id: RUN_A,
				adapters: ["agent-browser"],
				ownership_provenance: "adapter-creation-receipt",
				expires_at_epoch_ms: 1,
				revision: 1,
			},
		};
		const ownedRaw = JSON.stringify(ownedRegistry);
		ownedCustody.registry_raw = ownedRaw;
		const ownedRegistryEntry = ownedCustody.inventory_receipt.entries[0];
		if (!ownedRegistryEntry) throw new Error("registry inventory entry missing");
		ownedRegistryEntry.sha256 = testSha256(ownedRaw);
		ownedCustody.inventory_receipt.inventory_digest = testSha256(
			JSON.stringify(ownedCustody.inventory_receipt.entries),
		);
		const owned = evidence({
			final_custody: ownedCustody,
		});
		expect(
			await validateBrowserUseQualificationEvidence({ manifest, evidence: owned }),
		).toMatchObject({ ok: false, code: "qualification_owned_residue" });

		const leaseRaw = JSON.stringify({
						record: "run-lease",
						schema_version: "1",
						payload: {
							key: `browser-target-operation:fixture:${TARGET_A}`,
							holder_id: `browser-target-run:${RUN_A}`,
							fencing_token: 1,
							activation_epoch: 1,
							acquired_at_epoch_ms: 0,
							heartbeat_at_epoch_ms: 0,
							expires_at_epoch_ms: 1,
							recovered_from: null,
							scope: { target_id: TARGET_A },
						},
					});
		const leased = evidence({
			final_custody: finalCustody(AUTHORITY, [leaseRaw]),
		});
		expect(
			await validateBrowserUseQualificationEvidence({ manifest, evidence: leased }),
		).toMatchObject({ ok: false, code: "qualification_lease_residue" });
	});

	test("malformed and multi-document receipts never parse as evidence", async () => {
		const manifest = await createBrowserUseQualificationManifest();
		for (const raw of ["{", `${receipt({ runId: RUN_A, origin: ORIGIN_A, targetRef: TARGET_A })}\n{}`]) {
			const input = evidence();
			(input.runs[0] as Record<string, unknown>).receipt_raws = [raw];
			expect(
				await validateBrowserUseQualificationEvidence({ manifest, evidence: input }),
			).toMatchObject({ ok: false, code: "qualification_receipt_invalid" });
		}
	});

	test("external reviewed manifest identity cannot be self-authorized by observed bytes", async () => {
		const manifest = await createBrowserUseQualificationManifest();
		const input = evidence({
			expected_manifest_digest: "d".repeat(64),
			observed_manifest_digest: manifest.manifest_digest,
		});
		expect(
			await validateBrowserUseQualificationEvidence({
				manifest,
				evidence: input,
			}),
		).toMatchObject({ ok: false, code: "qualification_manifest_mismatch" });
	});

	test("manifest binds qualification contracts and resolved runtime owners", async () => {
		const manifest = await createBrowserUseQualificationManifest();
		expect(manifest).toMatchObject({
			contracts: {
				qualification_manifest: {
					id: "browser-use.qualification-manifest",
					schema_version: "1",
				},
				qualification_validation: {
					id: "browser-use.qualification-validation",
					schema_version: "1",
				},
				qualification_evidence: {
					id: "browser-use.qualification-evidence",
					schema_version: "1",
				},
				qualification_handoff_producer: {
					id: "browser-use.qualification-handoff-producer",
					schema_version: "1",
				},
			},
			front_door: {
				resolved_executable_realpath: expect.any(String),
				content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
			runtime: {
				executable_realpath: expect.any(String),
				executable_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
			agent_browser: {
				executable_realpath: expect.any(String),
				executable_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
				install_lock_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
			browser_connect: {
				resolved_executable_realpath: expect.any(String),
				content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
			warm_chrome: {
				resolved_executable_realpath: expect.any(String),
				content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
		});
	});

	test("a screenshot cannot qualify by merely declaring target-local scope", async () => {
		const manifest = await createBrowserUseQualificationManifest();
		const input = evidence();
		const run = input.runs[0] as Record<string, unknown>;
		const receipts = run.receipt_raws as string[];
		const forged = JSON.parse(receipts[1] ?? "null") as Record<string, unknown>;
		const data = forged.data as Record<string, unknown>;
		data.command = "operate-screenshot";
		data.operation = "screenshot";
		receipts[1] = JSON.stringify(forged);
		expect(
			await validateBrowserUseQualificationEvidence({ manifest, evidence: input }),
		).toMatchObject({ ok: false, code: "qualification_capability_mismatch" });
	});

	test("an incomplete operation owner receipt is rejected instead of accepted by subset predicates", async () => {
		const manifest = await createBrowserUseQualificationManifest();
		const input = evidence();
		const run = (input.runs as Array<Record<string, unknown>>)[0]!;
		const receipts = run.receipt_raws as string[];
		const partial = JSON.parse(receipts[1]!) as { data: Record<string, unknown> };
		delete partial.data.target_source;
		receipts[1] = JSON.stringify(partial);
		expect(
			await validateBrowserUseQualificationEvidence({ manifest, evidence: input }),
		).toMatchObject({ ok: false, code: "qualification_receipt_invalid" });
	});

	test("missing or unknown execution scope never qualifies", async () => {
		const manifest = await createBrowserUseQualificationManifest();
		for (const scope of [undefined, "parallel-ish"]) {
			const input = evidence();
			const run = (input.runs as Array<Record<string, unknown>>)[0]!;
			const receipts = run.receipt_raws as string[];
			const forged = JSON.parse(receipts[1]!) as { data: Record<string, unknown> };
			const execution = forged.data.execution as Record<string, unknown>;
			if (scope === undefined) delete execution.scope;
			else execution.scope = scope;
			receipts[1] = JSON.stringify(forged);
			expect(
				await validateBrowserUseQualificationEvidence({ manifest, evidence: input }),
			).toMatchObject({ ok: false, code: "qualification_receipt_invalid" });
		}
	});

	test("Agent Browser viewport emulation is excluded by the sealed capability table", async () => {
		const manifest = await createBrowserUseQualificationManifest();
		const input = evidence();
		const run = (input.runs as Array<Record<string, unknown>>)[0]!;
		const receipts = run.receipt_raws as string[];
		const forged = JSON.parse(receipts[1]!) as { data: Record<string, unknown> };
		forged.data.command = "operate-emulate";
		forged.data.operation = "emulate";
		forged.data.execution = { scope: "browser-wide", focus: true };
		forged.data.side_effects = { focus: true };
		forged.data.custody = {
			target_operation_lease: { acquired_at_epoch_ms: 10, released_at_epoch_ms: 20 },
			browser_lane: { acquired_at_epoch_ms: 10, released_at_epoch_ms: 20 },
		};
		receipts[1] = JSON.stringify(forged);
		expect(
			await validateBrowserUseQualificationEvidence({ manifest, evidence: input }),
		).toMatchObject({ ok: false, code: "qualification_capability_mismatch" });
	});

	test("browser-wide Agent Browser receipts require their exact focus effect", async () => {
		const manifest = await createBrowserUseQualificationManifest();
		const input = evidence();
		const run = (input.runs as Array<Record<string, unknown>>)[0]!;
		const receipts = run.receipt_raws as string[];
		const forged = JSON.parse(
			receipt({ runId: RUN_A, origin: ORIGIN_A, targetRef: TARGET_A, scope: "browser-wide" }),
		) as { data: Record<string, unknown> };
		forged.data.execution = { scope: "browser-wide", focus: false };
		forged.data.side_effects = { focus: false };
		receipts[1] = JSON.stringify(forged);
		expect(
			await validateBrowserUseQualificationEvidence({ manifest, evidence: input }),
		).toMatchObject({ ok: false, code: "qualification_capability_mismatch" });
	});

	test("sealed owner command mapping rejects a success-shaped operation mismatch", async () => {
		const manifest = await createBrowserUseQualificationManifest();
		const input = evidence();
		const run = input.runs[0] as Record<string, unknown>;
		const receipts = run.receipt_raws as string[];
		const forged = JSON.parse(
			receipt({
				runId: RUN_A,
				origin: ORIGIN_A,
				targetRef: TARGET_A,
				scope: "browser-wide",
			}),
		) as Record<string, unknown>;
		const data = forged.data as Record<string, unknown>;
		data.command = "operate-click";
		data.operation = "screenshot";
		receipts[1] = JSON.stringify(forged);
		expect(
			await validateBrowserUseQualificationEvidence({ manifest, evidence: input }),
		).toMatchObject({ ok: false, code: "qualification_capability_mismatch" });
	});

	test("a confirmed already-absent topology receipt is ineligible for qualification", async () => {
		const manifest = await createBrowserUseQualificationManifest();
		const input = evidence();
		const run = input.runs[0] as Record<string, unknown>;
		const receipts = run.receipt_raws as string[];
		const forged = JSON.parse(receipts[0] ?? "null") as Record<string, unknown>;
		const data = forged.data as Record<string, unknown>;
		data.command = "targets-close";
		data.effect = "confirmed";
		data.target_mutated = false;
		data.target_present = false;
		data.already_absent = true;
		data.qualification_eligible = true;
		receipts[0] = JSON.stringify(forged);
		expect(
			await validateBrowserUseQualificationEvidence({ manifest, evidence: input }),
		).toMatchObject({ ok: false, code: "qualification_receipt_invalid" });
	});

	test("final custody is captured by the owner and caller custody cannot authorize validation", async () => {
		const manifest = await createBrowserUseQualificationManifest();
		expect(
			await validateBrowserUseQualificationEvidence({
				manifest,
				evidence: evidence(),
				observedFinalCustody: finalCustody("c".repeat(64)),
			}),
		).toMatchObject({
			ok: false,
			code: "qualification_custody_authority_mismatch",
		});
		expect(
			await validateBrowserUseQualificationEvidence({
				manifest,
				evidence: evidence({ final_custody: finalCustody("d".repeat(64)) }),
				observedFinalCustody: finalCustody(),
			}),
		).toMatchObject({
			ok: true,
		});
	});

	test("owner custody inventory rejects root aliases and mutated stable fields", async () => {
		const manifest = await createBrowserUseQualificationManifest();
		for (const inventory_receipt of [
			{
				contract: "browser-use.qualification-custody-inventory",
				schema_version: "1",
				authority_id:
					"cf17a739b9cc02280d8015e2b2a92a3b244a5c997004754bfb5e5a5fcda16693",
				root_path: "/private/state/alias",
				root_realpath: "/private/state/canonical",
				registry_count: 1,
				lease_count: 0,
				entry_count: 1,
				inventory_digest: "1".repeat(64),
			},
			{
				contract: "browser-use.qualification-custody-inventory",
				schema_version: "1",
				authority_id:
					"cf17a739b9cc02280d8015e2b2a92a3b244a5c997004754bfb5e5a5fcda16693",
				root_path: "/private/state/canonical",
				root_realpath: "/private/state/canonical",
				registry_count: 1,
				lease_count: 1,
				entry_count: 2,
				inventory_digest: "2".repeat(64),
			},
			{
				contract: "browser-use.qualification-custody-inventory",
				schema_version: "1",
				authority_id:
					"cf17a739b9cc02280d8015e2b2a92a3b244a5c997004754bfb5e5a5fcda16693",
				root_path: "/private/state/canonical",
				root_realpath: "/private/state/canonical",
				registry_count: 1,
				lease_count: 0,
				entry_count: 1,
				inventory_digest: "3".repeat(64),
				registry_revision: 9,
			},
		] as const) {
			const observedFinalCustody = {
					inventory_receipt,
					registry_raw: JSON.stringify({
						contract: "browser-use.browser-custody",
						schema_version: "1",
						authority_id:
							"cf17a739b9cc02280d8015e2b2a92a3b244a5c997004754bfb5e5a5fcda16693",
						revision: 1,
						targets: {},
					}),
					lease_record_raws: [],
				};
			expect(
				await validateBrowserUseQualificationEvidence({
					manifest,
					evidence: evidence(),
					observedFinalCustody:
						observedFinalCustody as unknown as BrowserUseQualificationCustodyInventory,
				}),
			).toMatchObject({
				ok: false,
				code: "qualification_custody_inventory_invalid",
			});
		}
	});
});
