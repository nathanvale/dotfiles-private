import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	lstatSync,
	readdirSync,
	renameSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifiedHandoffEnvelope } from "./browser-connect-handoff-fixtures";
import { agentBrowserProcessFixtureSource } from "./browser-use-agent-browser-test-fixture";
import { parseBrowserOperationQualificationReceipt } from "./browser-use-operations";
import { parseBrowserTargetTopologyQualificationReceipt } from "./browser-use-target-topology";
import {
	produceSealedQualificationHandoff,
	qualificationHandoffChildEnvironment,
	qualificationHandoffCommandFailureReason,
	qualificationHandoffCommandOutputClass,
	qualificationHandoffCommandPhase,
	qualificationHandoffMintFailureStage,
} from "./browser-use-qualification-runtime";
import { BrowserUseQualificationSessionAuthority } from "./browser-use-qualification-session";
import { acquireSourceLock } from "./browser-use-source-lock";
import {
	SEALED_ARTIFACT_NAME,
	assertBrowserUseQualificationRuntimeEntry,
	executeVerifiedSealedQualificationBundle,
} from "./browser-use-qualification-wrapper";

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SOURCE_DIR, "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "../../../../..");
const NEUTRAL_CWD = realpathSync(
	mkdtempSync(`${tmpdir()}/browser-use-qualification-cwd-`),
);
const RESOLVED_BROWSER_USE = Bun.which("browser-use");
// Reviewed sealed digest. Refreshed for the final nested-spawn environment
// scrub: command-specific variables are preserved, while OP and Browser Use
// token variables are removed immediately before the sealed Agent Browser
// supervisor starts. The failure projection remains bounded to safe stages,
// phases, reasons, output classes, and byte counts.
// Re-derived independently of this harness with `browser-use qualification
// prepare` from the package root, the repo root, and a neutral temporary CWD
// under a neutral HOME; all three agreed on the value below.
// Prior reviewed values, newest first:
// f15a8fce32213e8a585a0d9409e58622d12a1266089b71e74727aa88c4572e7f
// 97b3d98696b18c0fd33efd7a04ce5e9870adc8e0cb5ecdf473ec1fcefeae5913
// ea785d566008a93b8084166ebfae0611ba94ca3e55b00eaa5c5bd48ec7a6b0a0
// 988882ee652cdd0ec763c8353435a40d41a9a4721b621cd3c960df10be720c8e
// 4af8227d7b3747754a335f0bcf7378efaff9b032e7f1026be79bc1901c1e2433
const REVIEWED_REPAIRED_MANIFEST_DIGEST =
	"e6619ba5fbca3e22546ed2b920a8b982a0de8ba1aa08413604d8b59d4c5a6841";
const RUN_ID = "qualification-run-a";
const TARGET_REF =
	"4114c9c79a4b77fb41067891c87621fd5646f883e160cd6a21f0d70ac9f48a4e";

function testSha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function writeTestProducerReceipt(input: {
	handoffPath: string;
	handoffRaw: string;
	bundle: Awaited<ReturnType<typeof prepareBundle>>;
}): string {
	const handoff = JSON.parse(input.handoffRaw) as {
		run_id: string;
		data: {
			environment: { name: string; profile: string };
			attachment: { adapter_id: string; route: string };
			endpoint: { http: string; ws: string };
			proof: { environment_contract_id: string; environment_schema_version: string };
		};
	};
	const evidenceId = testSha256(
		JSON.stringify([
			handoff.run_id,
			handoff.data.environment.name,
			handoff.data.environment.profile,
			handoff.data.attachment.adapter_id,
			handoff.data.attachment.route,
			handoff.data.endpoint.http,
			handoff.data.endpoint.ws,
			handoff.data.proof.environment_contract_id,
			handoff.data.proof.environment_schema_version,
		]),
	).slice(0, 32);
	const authorityId = testSha256(
		JSON.stringify([
			"browser-authority",
			handoff.data.environment.name,
			handoff.data.environment.profile,
			handoff.data.endpoint.http,
			handoff.data.endpoint.ws,
		]),
	);
	const raw = JSON.stringify({
		status: "ok",
		data: {
			contract: "browser-use.qualification-handoff-producer",
			schema_version: "1",
			command: "qualification-handoff",
			producer: "browser-connect",
			adapter: "agent-browser",
			run_id: handoff.run_id,
			handoff_sha256: testSha256(input.handoffRaw),
			handoff_evidence_id: evidenceId,
			browser_authority_id: authorityId,
			expected_manifest_digest: input.bundle.manifest_digest,
			observed_manifest_digest: input.bundle.manifest_digest,
			sealed_artifact_sha256: input.bundle.artifact_sha256,
			producer_identity: (() => {
				const manifest = JSON.parse(
					readFileSync(resolve(input.bundle.bundleRoot, "manifest.json"), "utf8"),
				) as Record<string, unknown>;
				const closure = manifest.execution_closure as Record<string, unknown>;
				const browserConnect = manifest.browser_connect as Record<string, unknown>;
				const warmChrome = manifest.warm_chrome as Record<string, unknown>;
				return {
					execution_closure_sha256: closure.bundle_sha256,
					browser_connect_sha256: browserConnect.content_sha256,
					warm_chrome_sha256: warmChrome.content_sha256,
				};
			})(),
		},
	});
	writeFileSync(`${input.handoffPath}.producer.json`, raw, { mode: 0o600 });
	return raw;
}

function rewriteBundleManifest(
	bundleRoot: string,
	mutate: (manifest: Record<string, unknown>) => void,
): { manifest_digest: string } {
	const manifestPath = resolve(bundleRoot, "manifest.json");
	chmodSync(bundleRoot, 0o700);
	chmodSync(manifestPath, 0o600);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
		string,
		unknown
	>;
	mutate(manifest);
	delete manifest.manifest_digest;
	manifest.manifest_digest = testSha256(JSON.stringify(manifest));
	writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
	chmodSync(manifestPath, 0o400);
	chmodSync(bundleRoot, 0o500);
	return { manifest_digest: String(manifest.manifest_digest) };
}

afterAll(() => {
	for (const name of readdirSync(NEUTRAL_CWD)) {
		const candidate = resolve(NEUTRAL_CWD, name);
		try {
			chmodSync(candidate, 0o700);
		} catch {
			// Files and already-removed fixture paths need no directory unseal.
		}
	}
	rmSync(NEUTRAL_CWD, { recursive: true, force: true });
});

async function prepareBundle(
	cwd: string,
	label: string,
	identity?: { executable: string; installLock: string },
) {
	if (!RESOLVED_BROWSER_USE) throw new Error("browser-use is not resolved on PATH");
	const bundleRoot = resolve(NEUTRAL_CWD, `sealed-${label}`);
	const child = Bun.spawn(
		[
			RESOLVED_BROWSER_USE,
			"qualification",
			"prepare",
			"--output",
			bundleRoot,
			...(identity
				? [
						"--agent-browser-executable",
						identity.executable,
						"--agent-browser-install-lock",
						identity.installLock,
					]
				: []),
			"--json",
		],
		{
			cwd,
			env: { ...process.env, HOME: NEUTRAL_CWD },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(exitCode, stdout || stderr).toBe(0);
	expect(stderr).toBe("");
	const envelope = JSON.parse(stdout) as {
		status: string;
		data: {
			manifest_digest: string;
			artifact_sha256: string;
			[key: string]: unknown;
		};
	};
	return { bundleRoot, ...envelope.data };
}

async function prepareBrowserFreeSessionFixture(input: {
	label: string;
	executeStdoutByRequestId?: Record<string, string>;
}) {
	const root = resolve(NEUTRAL_CWD, input.label);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const fakeAgent = resolve(root, "agent-browser-fixture");
	const fakeInstallLock = resolve(root, "agent-browser-package-lock.json");
	const callLog = resolve(root, "agent-browser-calls.jsonl");
	writeFileSync(
		fakeAgent,
		agentBrowserProcessFixtureSource({
			statePath: resolve(root, "agent-state.json"),
			callLogPath: callLog,
			targetId: "session-positive-target",
		}),
		{ mode: 0o700 },
	);
	chmodSync(fakeAgent, 0o700);
	writeFileSync(fakeInstallLock, "{\"lockfileVersion\":3}\n", { mode: 0o600 });
	const bundle = await prepareBundle(PACKAGE_ROOT, input.label, {
		executable: fakeAgent,
		installLock: fakeInstallLock,
	});
	const rewritten = rewriteBundleManifest(bundle.bundleRoot, (candidate) => {
		candidate.qualification_test_fixture = {
			id: "browser-use.browser-free-warm-chrome-fixture-v1",
			qualification_eligible: false,
			endpoint: "http://127.0.0.1:49229",
			web_socket_debugger_url:
				"ws://127.0.0.1:49229/devtools/browser/browser-free-fixture",
			...(input.executeStdoutByRequestId
				? { session_execute_stdout_by_request_id: input.executeStdoutByRequestId }
				: {}),
		};
	});
	const manifest = JSON.parse(
		readFileSync(resolve(bundle.bundleRoot, "manifest.json"), "utf8"),
	) as { source_inventory: { digest: string } };
	return { root, callLog, bundle, rewritten, manifest };
}

function startBrowserFreeSession(input: Awaited<ReturnType<typeof prepareBrowserFreeSessionFixture>>) {
	if (!RESOLVED_BROWSER_USE) throw new Error("browser-use is not resolved on PATH");
	const child = Bun.spawn(
		[
			RESOLVED_BROWSER_USE,
			"qualification",
			"session",
			"--bundle",
			input.bundle.bundleRoot,
			"--expected-manifest-digest",
			input.rewritten.manifest_digest,
			"--expected-source-digest",
			input.manifest.source_inventory.digest,
			"--jsonl",
		],
		{
			cwd: NEUTRAL_CWD,
			env: { ...process.env, HOME: input.root },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	return {
		child,
		write(request: Record<string, unknown>) {
			child.stdin.write(`${JSON.stringify({
				contract: "browser-use.qualification-session-request",
				schema_version: "1",
				...request,
			})}\n`);
		},
		async read(): Promise<Record<string, unknown>> {
			while (!pending.includes("\n")) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error("sealed session stdout closed before its envelope");
				pending += decoder.decode(chunk.value, { stream: true });
			}
			const newline = pending.indexOf("\n");
			const raw = pending.slice(0, newline);
			pending = pending.slice(newline + 1);
			return JSON.parse(raw) as Record<string, unknown>;
		},
	};
}

function testSessionEvidence(input: {
	digest: string;
	runId: string;
	handoffHandle: string;
	receiptHandles?: Array<{ handle: string; request_id: string }>;
	receiptRaws?: string[];
	expectedOrigin?: string;
}) {
	return {
		contract: "browser-use.qualification-evidence",
		schema_version: "1",
		adapter_capability_id: "agent-browser.exact-target-no-focus.v1",
		threat_model: {
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
		},
		expected_manifest_digest: input.digest,
		observed_manifest_digest: input.digest,
		runs: [
			{
				run_id: input.runId,
				handoff_capability_handle: input.handoffHandle,
				expected_origin:
					input.expectedOrigin ?? "https://qualification.example.test",
				expected_target_ref:
					"ce49c2af1cc30292aba33bce61ad7d050dd68f7dcd9abd2e86ceb00d5b317575",
				...(input.receiptHandles
					? { receipt_capabilities: input.receiptHandles }
					: {}),
				...(input.receiptRaws ? { receipt_raws: input.receiptRaws } : {}),
			},
		],
	};
}

async function mintSessionHandoff(
	session: ReturnType<typeof startBrowserFreeSession>,
	runId: string,
	requestId = "mint",
): Promise<string> {
	session.write({ request_id: requestId, command: "mint-handoff", run_id: runId });
	const response = await session.read();
	expect(response).toMatchObject({ status: "ok", request_id: requestId });
	return String((response.data as Record<string, unknown>).handoff_capability_handle);
}

async function executeSessionReceipt(input: {
	session: ReturnType<typeof startBrowserFreeSession>;
	runId: string;
	handoffHandle: string;
	requestId: string;
	argv: string[];
}): Promise<{ handle: string; request_id: string }> {
	input.session.write({
		request_id: input.requestId,
		command: "execute",
		run_id: input.runId,
		handoff_capability_handle: input.handoffHandle,
		argv: input.argv,
	});
	const response = await input.session.read();
	expect(response).toMatchObject({
		status: "ok",
		request_id: input.requestId,
		data: { command: "execute", exit_code: 0 },
	});
	const data = response.data as Record<string, unknown>;
	expect(data.stdout).toBeUndefined();
	return data.receipt_capability as { handle: string; request_id: string };
}

async function createSessionRunReceipts(input: {
	fixture: Awaited<ReturnType<typeof prepareBrowserFreeSessionFixture>>;
	session: ReturnType<typeof startBrowserFreeSession>;
	runId: string;
	handoffHandle: string;
	label: string;
	includeSnapshot?: boolean;
}): Promise<Array<{ handle: string; request_id: string }>> {
	const statePath = resolve(input.fixture.root, `${input.label}-selected.json`);
	const common = [
		"--state",
		statePath,
		"--run-id",
		input.runId,
		"--json",
	];
	const handles = [
		await executeSessionReceipt({
			session: input.session,
			runId: input.runId,
			handoffHandle: input.handoffHandle,
			requestId: `${input.label}-open`,
			argv: [
				"targets",
				"open",
				"--url",
				"https://qualification.example.test/",
				...common,
			],
		}),
	];
	if (input.includeSnapshot) {
		handles.push(
			await executeSessionReceipt({
				session: input.session,
				runId: input.runId,
				handoffHandle: input.handoffHandle,
				requestId: `${input.label}-snapshot`,
				argv: ["operate", "snapshot", ...common],
			}),
		);
	}
	handles.push(
		await executeSessionReceipt({
			session: input.session,
			runId: input.runId,
			handoffHandle: input.handoffHandle,
			requestId: `${input.label}-close`,
			argv: ["targets", "close", ...common],
		}),
	);
	return handles;
}

async function closeStoppedSession(
	session: ReturnType<typeof startBrowserFreeSession>,
	requestId = "close",
): Promise<void> {
	session.write({ request_id: requestId, command: "close" });
	expect(await session.read()).toMatchObject({
		status: "error",
		request_id: requestId,
		error: { code: "qualification_session_incomplete" },
	});
	session.child.stdin.end();
	expect(await session.read()).toMatchObject({ status: "stopped" });
	expect(await session.child.exited).toBe(20);
}

async function manifestFrom(
	cwd: string,
	label: string,
	identity?: { executable: string; installLock: string },
) {
	if (!RESOLVED_BROWSER_USE) throw new Error("browser-use is not resolved on PATH");
	const bundle = await prepareBundle(cwd, label, identity);
	const child = Bun.spawn(
		[
			RESOLVED_BROWSER_USE,
			"qualification",
			"manifest",
			"--bundle",
			bundle.bundleRoot,
			"--expected-manifest-digest",
			bundle.manifest_digest,
			"--json",
		],
		{ cwd, env: { ...process.env, HOME: NEUTRAL_CWD }, stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(exitCode, stdout || stderr).toBe(0);
	expect(stderr).toBe("");
	return {
		bundle,
		envelope: JSON.parse(stdout) as {
			status: string;
			data: {
				manifest_digest: string;
				wrapper: { resolved_executable_realpath: string };
				[key: string]: unknown;
			};
		},
	};
}

async function sealedExec(input: {
	bundle: Awaited<ReturnType<typeof prepareBundle>>;
	args: readonly string[];
	env: Record<string, string | undefined>;
}) {
	if (!RESOLVED_BROWSER_USE) throw new Error("browser-use is not resolved on PATH");
	const child = Bun.spawn(
		[
			RESOLVED_BROWSER_USE,
			"qualification",
			"exec",
			"--bundle",
			input.bundle.bundleRoot,
			"--expected-manifest-digest",
			input.bundle.manifest_digest,
			"--",
			...input.args,
		],
		{ cwd: NEUTRAL_CWD, env: input.env, stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, exitCode };
}

function expectQualificationFailureDiagnosticTrail(input: {
	stderr: string;
	command: "session" | "validate";
	verificationOutcomes: readonly ("completed" | "root_admitted")[];
	failureKind:
		| "source_guard_failed"
		| "execution_failed"
		| "bundle_verification_failed";
	sensitiveValues?: readonly string[];
}): void {
	const records = input.stderr
		.trimEnd()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
	const diagnosticRecord = (
		event: string,
		level: "debug" | "error",
		properties: Record<string, unknown>,
	): Record<string, unknown> => ({
		level,
		category: ["browser-use", "qualification"],
		message: event,
		event,
		qualification_command: input.command,
		qualification_contract_id: "browser-use.qualification-bundle",
		qualification_schema_version: "1",
		...properties,
	});
	const expected: Record<string, unknown>[] = [
		diagnosticRecord("qualification-front-door-dispatch", "debug", {
			command: input.command,
			machine_output: true,
		}),
	];
	for (const outcome of input.verificationOutcomes) {
		expected.push(
			diagnosticRecord(
				"qualification-bundle-verification-started",
				"debug",
				{
					contract_id: "browser-use.qualification-bundle",
					schema_version: "1",
				},
			),
			diagnosticRecord("qualification-bundle-root-classified", "debug", {
				bundle_root_state: "admitted",
				admitted: true,
				recommended_phase: "bundle_verification",
			}),
		);
		if (outcome === "completed") {
			expected.push(
				diagnosticRecord(
					"qualification-bundle-verification-completed",
					"debug",
					{
						contract_id: "browser-use.qualification-bundle",
						schema_version: "1",
						artifact_count: 2,
					},
				),
			);
		}
	}
	expected.push(
		diagnosticRecord("qualification-terminal-failure", "error", {
			failure_kind: input.failureKind,
			exit_code: 20,
			cleanup_debt_count: 0,
		}),
	);

	const metadata = records.map((record) => ({
		timestamp: record.timestamp,
		run_id: record.run_id,
		started_at_ms: record.started_at_ms,
	}));
	for (const entry of metadata) {
		expect(entry.timestamp).toBeString();
		expect(Number.isNaN(Date.parse(String(entry.timestamp)))).toBe(false);
		expect(entry.run_id).toBeString();
		expect(String(entry.run_id)).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
		expect(entry.started_at_ms).toBeNumber();
		expect(Number.isInteger(entry.started_at_ms)).toBe(true);
	}
	expect(new Set(metadata.map((entry) => entry.run_id)).size).toBe(1);
	expect(new Set(metadata.map((entry) => entry.started_at_ms)).size).toBe(1);
	expect(
		records.map(
			({ timestamp: _timestamp, run_id: _runId, started_at_ms: _startedAtMs, ...record }) =>
				record,
		),
	).toEqual(expected);

	for (const sensitive of [
		NEUTRAL_CWD,
		process.env.HOME,
		...(input.sensitiveValues ?? []),
	]) {
		if (sensitive) expect(input.stderr).not.toContain(sensitive);
	}
	expect(input.stderr).not.toMatch(/https?:\/\/|wss?:\/\//i);
	expect(input.stderr).not.toMatch(/authorization|bearer|cookie|token/i);
}

describe("qualification public process fixed point", () => {
	test("sealed sessions stop on close-only, EOF-only, failed-request, and missing-validation lifecycles", async () => {
		if (!RESOLVED_BROWSER_USE) throw new Error("browser-use is not resolved on PATH");
		const root = resolve(NEUTRAL_CWD, "sealed-session-incomplete");
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const fakeAgent = resolve(root, "agent-browser-fixture");
		const fakeInstallLock = resolve(root, "agent-browser-package-lock.json");
		writeFileSync(
			fakeAgent,
			agentBrowserProcessFixtureSource({
				statePath: resolve(root, "agent-state.json"),
				callLogPath: resolve(root, "agent-browser-calls.jsonl"),
				targetId: "session-incomplete-target",
			}),
			{ mode: 0o700 },
		);
		chmodSync(fakeAgent, 0o700);
		writeFileSync(fakeInstallLock, "{\"lockfileVersion\":3}\n", { mode: 0o600 });
		const bundle = await prepareBundle(PACKAGE_ROOT, "sealed-session-incomplete", {
			executable: fakeAgent,
			installLock: fakeInstallLock,
		});
		const rewritten = rewriteBundleManifest(bundle.bundleRoot, (candidate) => {
			candidate.qualification_test_fixture = {
				id: "browser-use.browser-free-warm-chrome-fixture-v1",
				qualification_eligible: false,
				endpoint: "http://127.0.0.1:49228",
				web_socket_debugger_url:
					"ws://127.0.0.1:49228/devtools/browser/browser-free-fixture",
			};
		});
		const manifest = JSON.parse(
			readFileSync(resolve(bundle.bundleRoot, "manifest.json"), "utf8"),
		) as { source_inventory: { digest: string } };
		const request = (requestId: string, command: string) => JSON.stringify({
			contract: "browser-use.qualification-session-request",
			schema_version: "1",
			request_id: requestId,
			command,
		});
		const scenarios = [
			{ label: "close-only", stdin: `${request("close-only", "close")}\n` },
			{ label: "eof-only", stdin: "" },
			{
				label: "failure-then-close",
				stdin: `${request("failed", "unknown-command")}\n${request("close", "close")}\n`,
			},
			{
				label: "validation-missing",
				stdin: `${JSON.stringify({
					contract: "browser-use.qualification-session-request",
					schema_version: "1",
					request_id: "mint",
					command: "mint-handoff",
					run_id: "validation-missing-run",
				})}\n${request("close", "close")}\n`,
			},
		] as const;
		for (const scenario of scenarios) {
			const child = Bun.spawn(
				[
					RESOLVED_BROWSER_USE,
					"qualification",
					"session",
					"--bundle",
					bundle.bundleRoot,
					"--expected-manifest-digest",
					rewritten.manifest_digest,
					"--expected-source-digest",
					manifest.source_inventory.digest,
					"--jsonl",
				],
				{
					cwd: NEUTRAL_CWD,
					env: { ...process.env, HOME: root },
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			child.stdin.write(scenario.stdin);
			child.stdin.end();
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(exitCode, `${scenario.label}: ${stdout || stderr}`).toBe(20);
			expectQualificationFailureDiagnosticTrail({
				stderr,
				command: "session",
				verificationOutcomes: ["completed", "completed"],
				failureKind: "execution_failed",
				sensitiveValues: [
					root,
					bundle.bundleRoot,
					fakeAgent,
					"http://127.0.0.1:49228",
					"ws://127.0.0.1:49228/devtools/browser/browser-free-fixture",
					scenario.stdin,
				],
			});
			const envelopes = stdout
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(envelopes.at(-1), scenario.label).toMatchObject({
				status: "stopped",
				data: {
					contract: "browser-use.qualification-campaign-receipt",
					child_exit_code: 20,
				},
			});
		}
	}, 60_000);

	test("the installed wrapper refuses a conflicting cooperative source drift guard before starting its sealed child", async () => {
		if (!RESOLVED_BROWSER_USE) throw new Error("browser-use is not resolved on PATH");
		const root = resolve(NEUTRAL_CWD, "source-drift-guard-conflict");
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const fakeAgent = resolve(root, "agent-browser-fixture");
		const fakeInstallLock = resolve(root, "agent-browser-package-lock.json");
		const callLog = resolve(root, "agent-browser-calls.jsonl");
		writeFileSync(
			fakeAgent,
			agentBrowserProcessFixtureSource({
				statePath: resolve(root, "agent-state.json"),
				callLogPath: callLog,
				targetId: "source-drift-guard-target",
			}),
			{ mode: 0o700 },
		);
		chmodSync(fakeAgent, 0o700);
		writeFileSync(fakeInstallLock, "{\"lockfileVersion\":3}\n", { mode: 0o600 });
		const bundle = await prepareBundle(PACKAGE_ROOT, "source-drift-guard-conflict", {
			executable: fakeAgent,
			installLock: fakeInstallLock,
		});
		const manifest = JSON.parse(
			readFileSync(resolve(bundle.bundleRoot, "manifest.json"), "utf8"),
		) as { source_inventory: { digest: string } };
		const held = await acquireSourceLock({
			lockPath: resolve(REPO_ROOT, ".git/browser-use-qualification-source-drift-guard.lock"),
			subject: "qualification process conflict fixture",
			binding: {
				generation: Number.parseInt(String(bundle.manifest_digest).slice(0, 12), 16),
				source_digest: manifest.source_inventory.digest,
				manifest_digest: String(bundle.manifest_digest),
			},
		});
		expect(held.ok).toBe(true);
		if (!held.ok) return;
		try {
			const child = Bun.spawn(
				[
					RESOLVED_BROWSER_USE,
					"qualification",
					"session",
					"--bundle",
					bundle.bundleRoot,
					"--expected-manifest-digest",
					String(bundle.manifest_digest),
					"--expected-source-digest",
					manifest.source_inventory.digest,
					"--jsonl",
				],
				{ cwd: NEUTRAL_CWD, env: { ...process.env, HOME: root }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
			);
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(exitCode, stdout || stderr).toBe(20);
			expectQualificationFailureDiagnosticTrail({
				stderr,
				command: "session",
				verificationOutcomes: [],
				failureKind: "source_guard_failed",
				sensitiveValues: [root, bundle.bundleRoot, fakeAgent, callLog],
			});
			expect(JSON.parse(stdout)).toMatchObject({
				status: "error",
				error: { code: "qualification_source_drift_guard_conflict", exit_code: 20 },
			});
			expect(() => readFileSync(callLog, "utf8")).toThrow();
		} finally {
			expect(await held.release()).toMatchObject({ ok: true, status: "released" });
		}
	}, 30_000);
	test("the installed sealed session mints and consumes one in-memory handoff through the real Browser Connect boundary", async () => {
		if (!RESOLVED_BROWSER_USE) throw new Error("browser-use is not resolved on PATH");
		const root = resolve(NEUTRAL_CWD, "sealed-session-positive");
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const fakeAgent = resolve(root, "agent-browser-fixture");
		const fakeInstallLock = resolve(root, "agent-browser-package-lock.json");
		const callLog = resolve(root, "agent-browser-calls.jsonl");
		const agentState = resolve(root, "agent-state.json");
		writeFileSync(
			fakeAgent,
			agentBrowserProcessFixtureSource({
				statePath: agentState,
				callLogPath: callLog,
				targetId: "session-positive-target",
			}),
			{ mode: 0o700 },
		);
		chmodSync(fakeAgent, 0o700);
		writeFileSync(fakeInstallLock, "{\"lockfileVersion\":3}\n", { mode: 0o600 });
		const bundle = await prepareBundle(PACKAGE_ROOT, "sealed-session-positive", {
			executable: fakeAgent,
			installLock: fakeInstallLock,
		});
		const rewritten = rewriteBundleManifest(bundle.bundleRoot, (manifest) => {
			manifest.qualification_test_fixture = {
				id: "browser-use.browser-free-warm-chrome-fixture-v1",
				qualification_eligible: false,
				endpoint: "http://127.0.0.1:49227",
				web_socket_debugger_url:
					"ws://127.0.0.1:49227/devtools/browser/browser-free-fixture",
			};
		});
		const manifest = JSON.parse(
			readFileSync(resolve(bundle.bundleRoot, "manifest.json"), "utf8"),
		) as { source_inventory: { digest: string } };
		const child = Bun.spawn(
			[
				RESOLVED_BROWSER_USE,
				"qualification",
				"session",
				"--bundle",
				bundle.bundleRoot,
				"--expected-manifest-digest",
				rewritten.manifest_digest,
				"--expected-source-digest",
				manifest.source_inventory.digest,
				"--jsonl",
			],
			{
				cwd: NEUTRAL_CWD,
				env: { ...process.env, HOME: root },
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const reader = child.stdout.getReader();
		const decoder = new TextDecoder();
		let pending = "";
		const readEnvelope = async (): Promise<Record<string, unknown>> => {
			while (!pending.includes("\n")) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error("sealed session stdout closed before its envelope");
				pending += decoder.decode(chunk.value, { stream: true });
			}
			const newline = pending.indexOf("\n");
			const raw = pending.slice(0, newline);
			pending = pending.slice(newline + 1);
			return JSON.parse(raw) as Record<string, unknown>;
		};
		child.stdin.write(
			`${JSON.stringify({
				contract: "browser-use.qualification-session-request",
				schema_version: "1",
				request_id: "mint",
				command: "mint-handoff",
				run_id: "qualification-session-positive-run",
			})}\n`,
		);
		const minted = await readEnvelope();
		expect(minted).toMatchObject({
			status: "ok",
			request_id: "mint",
			data: {
				command: "mint-handoff",
				run_id: "qualification-session-positive-run",
			},
		});
		const mintedData = minted.data as Record<string, unknown>;
		const handle = String(mintedData.handoff_capability_handle);
		const selectedState = resolve(root, "selected-target.json");
		child.stdin.write(
			`${JSON.stringify({
				contract: "browser-use.qualification-session-request",
				schema_version: "1",
				request_id: "consume",
				command: "execute",
				run_id: "qualification-session-positive-run",
				handoff_capability_handle: handle,
				handoff_raw: "caller replacement bytes are not authority",
				argv: [
					"targets",
					"open",
					"--url",
					"https://qualification.example.test/",
					"--state",
					selectedState,
					"--run-id",
					"qualification-session-positive-run",
					"--json",
				],
			})}\n`,
		);
		const consumed = await readEnvelope();
		expect(consumed).toMatchObject({
			status: "ok",
			request_id: "consume",
			data: { command: "execute", exit_code: 0 },
		});
		const consumedData = consumed.data as Record<string, unknown>;
		expect(consumedData.stdout).toBeUndefined();
		const openReceiptHandle = consumedData.receipt_capability as {
			handle: string;
			request_id: string;
		};
		expect(openReceiptHandle.handle).not.toBe("");
		child.stdin.write(
			`${JSON.stringify({
				contract: "browser-use.qualification-session-request",
				schema_version: "1",
				request_id: "snapshot",
				command: "execute",
				run_id: "qualification-session-positive-run",
				handoff_capability_handle: handle,
				argv: [
					"operate",
					"snapshot",
					"--state",
					selectedState,
					"--run-id",
					"qualification-session-positive-run",
					"--json",
				],
			})}\n`,
		);
		const snapshot = await readEnvelope();
		expect(snapshot).toMatchObject({
			status: "ok",
			request_id: "snapshot",
			data: { command: "execute", exit_code: 0 },
		});
		const snapshotData = snapshot.data as Record<string, unknown>;
		expect(snapshotData.stdout).toBeUndefined();
		const snapshotReceiptHandle = snapshotData.receipt_capability as {
			handle: string;
			request_id: string;
		};
		expect(snapshotReceiptHandle.handle).not.toBe("");
		child.stdin.write(
			`${JSON.stringify({
				contract: "browser-use.qualification-session-request",
				schema_version: "1",
				request_id: "cleanup-target",
				command: "execute",
				run_id: "qualification-session-positive-run",
				handoff_capability_handle: handle,
				argv: [
					"targets",
					"close",
					"--state",
					selectedState,
					"--run-id",
					"qualification-session-positive-run",
					"--json",
				],
			})}\n`,
		);
		const cleanupTarget = await readEnvelope();
		expect(cleanupTarget).toMatchObject({
			status: "ok",
			request_id: "cleanup-target",
			data: { command: "execute", exit_code: 0 },
		});
		const cleanupData = cleanupTarget.data as Record<string, unknown>;
		expect(cleanupData.stdout).toBeUndefined();
		const closeReceiptHandle = cleanupData.receipt_capability as {
			handle: string;
			request_id: string;
		};
		expect(closeReceiptHandle.handle).not.toBe("");
		child.stdin.write(
			`${JSON.stringify({
				contract: "browser-use.qualification-session-request",
				schema_version: "1",
				request_id: "validate",
				command: "validate",
				expected_manifest_digest: rewritten.manifest_digest,
				evidence: {
					contract: "browser-use.qualification-evidence",
					schema_version: "1",
					adapter_capability_id: "agent-browser.exact-target-no-focus.v1",
					threat_model: {
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
					},
					expected_manifest_digest: rewritten.manifest_digest,
					observed_manifest_digest: rewritten.manifest_digest,
					runs: [
						{
							run_id: "qualification-session-positive-run",
							handoff_capability_handle: handle,
							expected_origin: "https://qualification.example.test",
							expected_target_ref:
								"ce49c2af1cc30292aba33bce61ad7d050dd68f7dcd9abd2e86ceb00d5b317575",
						receipt_capabilities: [
							openReceiptHandle,
							snapshotReceiptHandle,
							closeReceiptHandle,
						],
						},
					],
				},
			})}\n`,
		);
		expect(await readEnvelope()).toMatchObject({
			status: "ok",
			request_id: "validate",
			data: { command: "validate", ok: true },
		});
		child.stdin.write(
			`${JSON.stringify({
				contract: "browser-use.qualification-session-request",
				schema_version: "1",
				request_id: "close",
				command: "close",
			})}\n`,
		);
		child.stdin.end();
		expect(await readEnvelope()).toMatchObject({ status: "ok", request_id: "close" });
		const campaign = await readEnvelope();
		const stderr = await new Response(child.stderr).text();
		const exitCode = await child.exited;
		expect(exitCode, stderr).toBe(0);
		expect(stderr).toBe("");
		expect(campaign).toMatchObject({
			status: "ok",
			data: {
				contract: "browser-use.qualification-campaign-receipt",
				source_drift_guard: { released: true },
			},
		});
		const calls = readFileSync(callLog, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as string[]);
		expect(calls.some((argv) => argv.includes("--version"))).toBe(true);
		expect(calls.some((argv) => argv.includes("cdp-url"))).toBe(true);
		expect(
			calls.some(
				(argv) => argv.join("\0").includes("--pin-tab\0tab\0new"),
			),
		).toBe(true);
		expect(calls.some((argv) => argv.includes("close"))).toBe(true);
	}, 30_000);

	test("the installed session rejects exit-zero non-receipts and malformed or multi-document stdout", async () => {
		const fixture = await prepareBrowserFreeSessionFixture({
			label: "sealed-session-observed-receipts",
			executeStdoutByRequestId: {
				"non-receipt": JSON.stringify({
					status: "ok",
					data: {
						contract: "browser-use.unrelated-success",
						schema_version: "1",
					},
				}),
				malformed: "{not-json",
				multi: '{"status":"ok"}\n{"status":"ok"}\n',
			},
		});
		for (const scenario of [
			{ label: "non-receipt", requestId: "non-receipt" },
			{ label: "malformed", requestId: "malformed" },
			{ label: "multi", requestId: "multi" },
		] as const) {
			const session = startBrowserFreeSession(fixture);
			const runId = `qualification-${scenario.label}-run`;
			const handoffHandle = await mintSessionHandoff(session, runId);
			session.write({
				request_id: scenario.requestId,
				command: "execute",
				run_id: runId,
				handoff_capability_handle: handoffHandle,
				argv: ["targets", "list", "--json"],
			});
			expect(await session.read()).toMatchObject({
				status: "error",
				request_id: scenario.requestId,
				data: {
					session_state: { required_requests_completed: false },
				},
				error: { code: "qualification_execute_receipt_invalid" },
			});
			await closeStoppedSession(session, `${scenario.label}-close`);
		}
	}, 30_000);

	test("receipt capabilities reject caller raws, unknown, mismatched, duplicate, replayed, and unconsumed handles", async () => {
		const fixture = await prepareBrowserFreeSessionFixture({
			label: "sealed-session-receipt-capabilities",
		});
		const validate = async (
			session: ReturnType<typeof startBrowserFreeSession>,
			requestId: string,
			evidence: Record<string, unknown>,
		) => {
			session.write({
				request_id: requestId,
				command: "validate",
				expected_manifest_digest: fixture.rewritten.manifest_digest,
				evidence,
			});
			return await session.read();
		};

		{
			const authority = new BrowserUseQualificationSessionAuthority();
			const runId = "qualification-replayed-capability-run";
			const handoffHandle = authority.admitHandoff({
				runId,
				raw: "test-owned-handoff",
				producerReceiptRaw: "test-owned-producer-receipt",
			});
			const requestId = "replayed-capability-request";
			const receiptCapabilities = [
				{
					handle: authority.admitReceipt({
						handoffHandle,
						runId,
						requestId,
						raw: "test-owned-receipt",
					}),
					request_id: requestId,
				},
			];
			expect(
				authority.consumeReceipts({
					receiptCapabilities,
					handoffHandle,
					runId,
				}),
			).toMatchObject({ ok: true });
			expect(
				authority.consumeReceipts({
					receiptCapabilities,
					handoffHandle,
					runId,
				}),
			).toEqual({
				ok: false,
				code: "qualification_receipt_capability_replayed",
			});
			authority.close();
		}

		{
			const session = startBrowserFreeSession(fixture);
			const runId = "qualification-caller-raw-run";
			const handoffHandle = await mintSessionHandoff(session, runId);
			expect(
				await validate(
					session,
					"caller-raw",
					testSessionEvidence({
						digest: fixture.rewritten.manifest_digest,
						runId,
						handoffHandle,
						receiptRaws: [
							JSON.stringify({
								status: "ok",
								data: {
									qualification_runtime: {
										expected_manifest_digest:
											fixture.rewritten.manifest_digest,
										observed_manifest_digest:
											fixture.rewritten.manifest_digest,
									},
								},
							}),
						],
					}),
				),
			).toMatchObject({
				status: "error",
				error: { code: "qualification_receipt_capability_invalid" },
			});
			await closeStoppedSession(session);
		}

		{
			const session = startBrowserFreeSession(fixture);
			const runId = "qualification-unknown-handle-run";
			const handoffHandle = await mintSessionHandoff(session, runId);
			expect(
				await validate(
					session,
					"unknown",
					testSessionEvidence({
						digest: fixture.rewritten.manifest_digest,
						runId,
						handoffHandle,
						receiptHandles: [
							{ handle: "unknown-receipt-handle", request_id: "unknown" },
						],
					}),
				),
			).toMatchObject({
				status: "error",
				error: { code: "qualification_receipt_capability_not_live" },
			});
			await closeStoppedSession(session);
		}

		for (const scenario of [
			"duplicate",
			"missing",
			"wrong-run",
			"wrong-handoff",
			"wrong-request",
		] as const) {
			const session = startBrowserFreeSession(fixture);
			const runId = `qualification-${scenario}-run`;
			const handoffHandle = await mintSessionHandoff(session, runId, `${scenario}-mint-a`);
			const handles = await createSessionRunReceipts({
				fixture,
				session,
				runId,
				handoffHandle,
				label: scenario,
			});
			const secondHandoff = scenario === "wrong-handoff"
				? await mintSessionHandoff(session, runId, `${scenario}-mint-b`)
				: handoffHandle;
			const evidenceRunId = scenario === "wrong-run" ? `${runId}-other` : runId;
			const selectedHandles = scenario === "duplicate"
				? [handles[0]!, handles[0]!]
				: scenario === "missing"
					? [handles[0]!]
					: scenario === "wrong-request"
						? [
								{ ...handles[0]!, request_id: "different-execute-request" },
								...handles.slice(1),
							]
						: handles;
			const response = await validate(
				session,
				`${scenario}-validate`,
				testSessionEvidence({
					digest: fixture.rewritten.manifest_digest,
					runId: evidenceRunId,
					handoffHandle: secondHandoff,
					receiptHandles: selectedHandles,
				}),
			);
			const expectedCode = scenario === "duplicate"
				? "qualification_receipt_capability_invalid"
				: scenario === "missing"
					? "qualification_receipt_capability_unconsumed"
					: "qualification_receipt_capability_mismatch";
			expect(response).toMatchObject({
				status: "error",
				error: { code: expectedCode },
			});
			await closeStoppedSession(session, `${scenario}-terminal-close`);
		}

		{
			const session = startBrowserFreeSession(fixture);
			try {
				const runId = "qualification-replayed-run";
				const handoffHandle = await mintSessionHandoff(session, runId);
				const handles = await createSessionRunReceipts({
					fixture,
					session,
					runId,
					handoffHandle,
					label: "replayed",
				});
				const invalidOrigin = testSessionEvidence({
					digest: fixture.rewritten.manifest_digest,
					runId,
					handoffHandle,
					receiptHandles: handles,
					expectedOrigin: "https://wrong-origin.example.test",
				});
				expect(
					await validate(session, "consume-once", invalidOrigin),
				).toMatchObject({
					status: "error",
					error: { code: "qualification_origin_mismatch" },
				});
				expect(await validate(session, "replay", invalidOrigin)).toMatchObject({
					status: "error",
					error: { code: "qualification_session_terminal" },
				});
			} finally {
				await closeStoppedSession(session);
			}
		}
	}, 90_000);

	test("terminal validation rejects execute, mint, and revalidate and makes close nonzero", async () => {
		const fixture = await prepareBrowserFreeSessionFixture({
			label: "sealed-session-terminal-state",
		});
		const session = startBrowserFreeSession(fixture);
		const runId = "qualification-terminal-run";
		const handoffHandle = await mintSessionHandoff(session, runId);
		const handles = await createSessionRunReceipts({
			fixture,
			session,
			runId,
			handoffHandle,
			label: "terminal",
			includeSnapshot: true,
		});
		const evidence = testSessionEvidence({
			digest: fixture.rewritten.manifest_digest,
			runId,
			handoffHandle,
			receiptHandles: handles,
		});
		session.write({
			request_id: "terminal-validate",
			command: "validate",
			expected_manifest_digest: fixture.rewritten.manifest_digest,
			evidence,
		});
		expect(await session.read()).toMatchObject({
			status: "ok",
			request_id: "terminal-validate",
			data: { command: "validate", ok: true },
		});
		for (const request of [
			{
				request_id: "after-validate-execute",
				command: "execute",
				run_id: runId,
				handoff_capability_handle: handoffHandle,
				argv: ["targets", "list", "--json"],
			},
			{
				request_id: "after-validate-mint",
				command: "mint-handoff",
				run_id: `${runId}-other`,
			},
			{
				request_id: "after-validate-revalidate",
				command: "validate",
				expected_manifest_digest: fixture.rewritten.manifest_digest,
				evidence,
			},
		]) {
			session.write(request);
			expect(await session.read()).toMatchObject({
				status: "error",
				request_id: request.request_id,
				error: { code: "qualification_session_terminal" },
			});
		}
		await closeStoppedSession(session, "terminal-close");
	}, 45_000);

	test("failed validation is terminal before execute, mint, or revalidate", async () => {
		const fixture = await prepareBrowserFreeSessionFixture({
			label: "sealed-session-failed-validation-terminal",
		});
		for (const later of ["execute", "mint-handoff", "validate"] as const) {
			const session = startBrowserFreeSession(fixture);
			const runId = `qualification-failed-validation-${later}`;
			const handoffHandle = await mintSessionHandoff(
				session,
				runId,
				`${later}-mint`,
			);
			session.write({
				request_id: `${later}-failed-validate`,
				command: "validate",
				expected_manifest_digest: fixture.rewritten.manifest_digest,
				evidence: testSessionEvidence({
					digest: fixture.rewritten.manifest_digest,
					runId,
					handoffHandle,
					receiptHandles: [
						{
							handle: "unknown-receipt-handle",
							request_id: `${later}-unknown`,
						},
					],
				}),
			});
			expect(await session.read()).toMatchObject({
				status: "error",
				error: { code: "qualification_receipt_capability_not_live" },
			});
			const request =
				later === "execute"
					? {
							request_id: `${later}-after-failure`,
							command: later,
							run_id: runId,
							handoff_capability_handle: handoffHandle,
							argv: ["targets", "list", "--json"],
						}
					: later === "mint-handoff"
						? {
								request_id: `${later}-after-failure`,
								command: later,
								run_id: `${runId}-other`,
							}
						: {
								request_id: `${later}-after-failure`,
								command: later,
								expected_manifest_digest:
									fixture.rewritten.manifest_digest,
								evidence: testSessionEvidence({
									digest: fixture.rewritten.manifest_digest,
									runId,
									handoffHandle,
									receiptHandles: [
										{
											handle: "unknown-receipt-handle",
											request_id: `${later}-unknown`,
										},
									],
								}),
							};
			session.write(request);
			expect(await session.read()).toMatchObject({
				status: "error",
				request_id: request.request_id,
				error: { code: "qualification_session_terminal" },
			});
			await closeStoppedSession(session, `${later}-close`);
		}
	}, 60_000);

	test("invocation-copy close and removal failures are terminal cleanup debt", async () => {
		if (!RESOLVED_BROWSER_USE) throw new Error("browser-use is not resolved on PATH");
		const bundle = await prepareBundle(PACKAGE_ROOT, "cleanup-debt");
		type CleanupInjectedExecute = (
			input: Parameters<typeof executeVerifiedSealedQualificationBundle>[0] & {
				cleanupForTest: {
					closeHandle: () => Promise<void>;
					removeInvocationRoot: () => Promise<void>;
				};
			},
		) => ReturnType<typeof executeVerifiedSealedQualificationBundle>;
		const executeWithCleanupFaults =
			executeVerifiedSealedQualificationBundle as unknown as CleanupInjectedExecute;
		await expect(
			executeWithCleanupFaults({
				bundleRoot: bundle.bundleRoot,
				expectedManifestDigest: String(bundle.manifest_digest),
				wrapperPath: RESOLVED_BROWSER_USE,
				childArgv: ["qualification", "manifest", "--json"],
				env: { ...process.env, HOME: NEUTRAL_CWD },
				cleanupForTest: {
					closeHandle: async () => {
						throw new Error("test-owned close failure");
					},
					removeInvocationRoot: async () => {
						throw new Error("test-owned remove failure");
					},
				},
			}),
		).rejects.toMatchObject({
			primaryCode: "qualification_invocation_cleanup_failed",
			cleanupDebt: [
				"qualification_invocation_handle_close_failed",
				"qualification_invocation_root_remove_failed",
			],
		});
	}, 30_000);
	test("a restarted sealed session rejects a fabricated or replayed handoff handle before adapter mutation", async () => {
		if (!RESOLVED_BROWSER_USE) throw new Error("browser-use is not resolved on PATH");
		const root = resolve(NEUTRAL_CWD, "sealed-session-replay");
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const fakeAgent = resolve(root, "agent-browser-fixture");
		const fakeInstallLock = resolve(root, "agent-browser-package-lock.json");
		const callLog = resolve(root, "agent-browser-calls.jsonl");
		writeFileSync(
			fakeAgent,
			agentBrowserProcessFixtureSource({
				statePath: resolve(root, "agent-state.json"),
				callLogPath: callLog,
				targetId: "session-target",
			}),
			{ mode: 0o700 },
		);
		chmodSync(fakeAgent, 0o700);
		writeFileSync(fakeInstallLock, "{\"lockfileVersion\":3}\n", { mode: 0o600 });
		const bundle = await prepareBundle(PACKAGE_ROOT, "sealed-session-replay", {
			executable: fakeAgent,
			installLock: fakeInstallLock,
		});
		const bundleManifest = JSON.parse(
			readFileSync(resolve(bundle.bundleRoot, "manifest.json"), "utf8"),
		) as { source_inventory: { digest: string } };
		for (const label of ["fabricated", "restarted"] as const) {
			const child = Bun.spawn(
				[
					RESOLVED_BROWSER_USE,
					"qualification",
					"session",
					"--bundle",
					bundle.bundleRoot,
					"--expected-manifest-digest",
					bundle.manifest_digest,
					"--expected-source-digest",
					bundleManifest.source_inventory.digest,
					"--jsonl",
				],
				{
					cwd: NEUTRAL_CWD,
					env: { ...process.env, HOME: root },
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			child.stdin.write(
				`${JSON.stringify({
					contract: "browser-use.qualification-session-request",
					schema_version: "1",
					request_id: label,
					command: "execute",
					run_id: "qualification-run-a",
					handoff_capability_handle: "persisted-or-forged-handle",
					argv: ["targets", "list", "--json"],
				})}\n${JSON.stringify({
					contract: "browser-use.qualification-session-request",
					schema_version: "1",
					request_id: `${label}-close`,
					command: "close",
				})}\n`,
			);
			child.stdin.end();
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(exitCode, stdout || stderr).toBe(20);
			expectQualificationFailureDiagnosticTrail({
				stderr,
				command: "session",
				verificationOutcomes: ["completed", "completed"],
				failureKind: "execution_failed",
				sensitiveValues: [
					root,
					bundle.bundleRoot,
					fakeAgent,
					callLog,
					"persisted-or-forged-handle",
				],
			});
			const envelopes = stdout.trim().split("\n").map((line) => JSON.parse(line));
			expect(envelopes[0]).toMatchObject({
				status: "error",
				request_id: label,
				error: { code: "qualification_handoff_capability_not_live" },
			});
			expect(envelopes[1]).toMatchObject({
				status: "error",
				request_id: `${label}-close`,
				error: { code: "qualification_session_incomplete" },
			});
		}
		expect(() => readFileSync(callLog, "utf8")).toThrow();
	}, 30_000);
	test("the sealed producer writes one Browser Connect-owned handoff and bound private receipt", async () => {
		const root = resolve(NEUTRAL_CWD, "sealed-producer-owner");
		mkdirSync(root, { recursive: true, mode: 0o700 });
		chmodSync(root, 0o700);
		const fakeAgent = resolve(root, "agent-browser");
		const installLock = resolve(root, "package-lock.json");
		const output = resolve(root, "handoff.json");
		writeFileSync(fakeAgent, agentBrowserProcessFixtureSource({
			statePath: resolve(root, "agent-state.json"),
			callLogPath: resolve(root, "agent-calls.jsonl"),
			targetId: "producer-target",
		}), { mode: 0o700 });
		chmodSync(fakeAgent, 0o700);
		writeFileSync(installLock, "{\"lockfileVersion\":3}\n", { mode: 0o600 });
		const bundle = await prepareBundle(PACKAGE_ROOT, "sealed-producer-owner", {
			executable: fakeAgent,
			installLock,
		});
		const manifest = JSON.parse(
			readFileSync(resolve(bundle.bundleRoot, "manifest.json"), "utf8"),
		) as Record<string, unknown>;
		const handoffRaw = verifiedHandoffEnvelope((envelope) => {
			envelope.run_id = "producer-run";
			envelope.data.attachment.adapter_id = "agent-browser";
			envelope.data.attachment.probe_executable = fakeAgent;
		});
		let publicReceipt = "";
		const exitCode = await produceSealedQualificationHandoff({
			argv: ["qualification", "handoff", "--run-id", "producer-run", "--output", output, "--json"],
			manifest,
			expectedManifestDigest: bundle.manifest_digest,
			sealedArtifactSha256: bundle.artifact_sha256,
			agent: {
				handoffPath: "",
				handoffRaw: "",
				agentLogicalPath: fakeAgent,
				agentCopyPath: fakeAgent,
				supervisorCopyPath: String(
					(manifest.native_supervisor as Record<string, unknown>)
						.resolved_executable_realpath,
				),
			},
			mint: async () => ({ exitCode: 0, stdout: handoffRaw, stderr: "" }),
			writeReceipt: (raw) => {
				publicReceipt += raw;
			},
		});
		expect(exitCode).toBe(0);
		expect(readFileSync(output, "utf8")).toBe(handoffRaw);
		expect(lstatSync(output).mode & 0o777).toBe(0o600);
		expect(lstatSync(`${output}.producer.json`).mode & 0o777).toBe(0o600);
		expect(readFileSync(`${output}.producer.json`, "utf8")).toBe(publicReceipt);
		expect(JSON.parse(publicReceipt)).toMatchObject({
			status: "ok",
			data: {
				contract: "browser-use.qualification-handoff-producer",
				command: "qualification-handoff",
				producer: "browser-connect",
				run_id: "producer-run",
				expected_manifest_digest: bundle.manifest_digest,
				sealed_artifact_sha256: bundle.artifact_sha256,
			},
		});
	}, 30_000);

	test("the sealed producer classifies only safe handoff failure stages", () => {
		const accepted = {
			exitCode: 0,
			stderrNonempty: false,
			parsed: true,
			verified: true,
			adapterMatches: true,
			runMatches: true,
			probeExecutableMatches: true,
		};
		expect(qualificationHandoffMintFailureStage(accepted)).toBeUndefined();
		expect(
			qualificationHandoffMintFailureStage({
				...accepted,
				exitCode: 20,
			}),
		).toBe("producer-exit-nonzero");
		expect(
			qualificationHandoffMintFailureStage({
				...accepted,
				stderrNonempty: true,
			}),
		).toBe("producer-stderr-nonempty");
		expect(
			qualificationHandoffMintFailureStage({ ...accepted, parsed: false }),
		).toBe("handoff-envelope-invalid");
		expect(
			qualificationHandoffMintFailureStage({ ...accepted, verified: false }),
		).toBe("handoff-not-verified");
		expect(
			qualificationHandoffMintFailureStage({
				...accepted,
				adapterMatches: false,
			}),
		).toBe("adapter-mismatch");
		expect(
			qualificationHandoffMintFailureStage({
				...accepted,
				runMatches: false,
			}),
		).toBe("run-mismatch");
		expect(
			qualificationHandoffMintFailureStage({
				...accepted,
				probeExecutableMatches: false,
			}),
		).toBe("probe-executable-mismatch");
	});

	test("the sealed producer classifies only bounded Browser Connect phases", () => {
		expect(qualificationHandoffCommandPhase(["--version"])).toBe("version");
		expect(
			qualificationHandoffCommandPhase([
				"--cdp",
				"redacted-endpoint",
				"get",
				"cdp-url",
			]),
		).toBe("attachment");
		expect(
			qualificationHandoffCommandPhase(["--session", "redacted", "close"]),
		).toBe("release");
		expect(qualificationHandoffCommandPhase(["session", "list"])).toBe(
			"inventory",
		);
	});

	test("the sealed producer classifies only bounded command failures", () => {
		const accepted = {
			commandAdmitted: true,
			exitCode: 0,
			timedOut: false,
			stdout: "agent-browser 0.34.0",
			stderr: "",
		};
		expect(qualificationHandoffCommandFailureReason(accepted)).toBeUndefined();
		expect(
			qualificationHandoffCommandFailureReason({
				...accepted,
				commandAdmitted: false,
			}),
		).toBe("command-not-admitted");
		expect(
			qualificationHandoffCommandFailureReason({
				...accepted,
				exitCode: 20,
				stdout: '{"error":{"code":"descriptor-exec-identity-mismatch"}}',
			}),
		).toBe("descriptor-exec-identity-mismatch");
		expect(
			qualificationHandoffCommandFailureReason({
				...accepted,
				exitCode: 20,
				stdout: '{"error":{"code":"ambient-op-environment"}}',
			}),
		).toBe("ambient-op-environment");
		expect(
			qualificationHandoffCommandFailureReason({
				...accepted,
				exitCode: 20,
				timedOut: true,
			}),
		).toBe("child-timeout");
		expect(
			qualificationHandoffCommandFailureReason({
				...accepted,
				exitCode: 7,
			}),
		).toBe("child-exit-nonzero");
	});

	test("the sealed producer exposes only allowlisted command output classes", () => {
		expect(
			qualificationHandoffCommandOutputClass({
				phase: "version",
				stdout: "agent-browser 0.34.0\n",
				stderr: "",
			}),
		).toBe("version-output-valid");
		expect(
			qualificationHandoffCommandOutputClass({
				phase: "version",
				stdout: "",
				stderr: "permission denied",
			}),
		).toBe("permission-denied");
		expect(
			qualificationHandoffCommandOutputClass({
				phase: "version",
				stdout: "",
				stderr: "unknown option",
			}),
		).toBe("argument-invalid");
		expect(
			qualificationHandoffCommandOutputClass({
				phase: "version",
				stdout: "",
				stderr: "",
			}),
		).toBe("silent");
		expect(
			qualificationHandoffCommandOutputClass({
				phase: "version",
				stdout: "",
				stderr: "sensitive-looking arbitrary text",
			}),
		).toBe("unclassified");
	});

	test("the sealed producer scrubs forbidden child environment at the final spawn", () => {
		expect(
			qualificationHandoffChildEnvironment(
				{
					PATH: "/reviewed/bin",
					OP_SERVICE_ACCOUNT_TOKEN: "must-not-cross",
					BROWSER_USE_OP_TOKEN: "must-not-cross",
				},
				{
					MCPORTER_NO_KEEPALIVE: "*",
					OP_CONNECT_TOKEN: "must-not-cross-either",
				},
			),
		).toEqual({
			PATH: "/reviewed/bin",
			MCPORTER_NO_KEEPALIVE: "*",
		});
	});

	test("a bundle prepared for one Bun image rejects a different Bun pathname before sealed logic", async () => {
		if (!RESOLVED_BROWSER_USE) throw new Error("browser-use is not resolved on PATH");
		const prepared = await prepareBundle(PACKAGE_ROOT, "bun-runtime-mismatch-red");
		const admittedBun = realpathSync(process.execPath);
		const otherBun = resolve(NEUTRAL_CWD, "same-bytes-different-path-bun");
		copyFileSync(admittedBun, otherBun);
		chmodSync(otherBun, 0o700);
		const child = Bun.spawn(
			[
				otherBun,
				RESOLVED_BROWSER_USE,
				"qualification",
				"manifest",
				"--bundle",
				prepared.bundleRoot,
				"--expected-manifest-digest",
				prepared.manifest_digest,
				"--json",
			],
			{ cwd: NEUTRAL_CWD, env: { ...process.env, HOME: NEUTRAL_CWD }, stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode, stdout || stderr).toBe(20);
		expect(stdout).toContain("qualification_runtime_identity_mismatch");
	}, 30_000);

	test("a native supervisor replacement after external admission never executes", async () => {
		if (!RESOLVED_BROWSER_USE) throw new Error("browser-use is not resolved on PATH");
		const prepared = await prepareBundle(PACKAGE_ROOT, "supervisor-replacement-red");
		const originalManifest = JSON.parse(
			readFileSync(resolve(prepared.bundleRoot, "manifest.json"), "utf8"),
		) as Record<string, unknown>;
		const originalSupervisor = (originalManifest.native_supervisor as Record<string, unknown>)
			.resolved_executable_realpath;
		if (typeof originalSupervisor !== "string") throw new Error("supervisor identity missing");
		const admittedSupervisor = resolve(NEUTRAL_CWD, "admitted-supervisor");
		const replacementMarker = resolve(NEUTRAL_CWD, "replacement-supervisor-ran");
		copyFileSync(originalSupervisor, admittedSupervisor);
		chmodSync(admittedSupervisor, 0o500);
		const rewritten = rewriteBundleManifest(prepared.bundleRoot, (manifest) => {
			manifest.native_supervisor = {
				resolved_executable_realpath: admittedSupervisor,
				content_sha256: testSha256(readFileSync(admittedSupervisor)),
				argv_contract: ["custody-snapshot", "--state-root", "<canonical-xdg-state-root>"],
			};
		});
		let externalAdmissionObserved = false;
		const executeWithExternalAdmission = executeVerifiedSealedQualificationBundle as unknown as (
			input: Parameters<typeof executeVerifiedSealedQualificationBundle>[0] & {
				afterExternalAdmissionForTest: () => Promise<void>;
			},
		) => ReturnType<typeof executeVerifiedSealedQualificationBundle>;
		const executed = await executeWithExternalAdmission({
			bundleRoot: prepared.bundleRoot,
			expectedManifestDigest: rewritten.manifest_digest,
			wrapperPath: RESOLVED_BROWSER_USE,
			childArgv: ["qualification", "manifest", "--json"],
			env: { ...process.env, HOME: NEUTRAL_CWD },
			afterExternalAdmissionForTest: async () => {
				externalAdmissionObserved = true;
				renameSync(admittedSupervisor, `${admittedSupervisor}.reviewed`);
				writeFileSync(
					admittedSupervisor,
					`#!/bin/sh\nprintf replacement > ${JSON.stringify(replacementMarker)}\nexit 20\n`,
					{ mode: 0o500 },
				);
			},
		});
		expect(externalAdmissionObserved).toBe(true);
		expect(executed.exitCode, executed.stdout || executed.stderr).toBe(0);
		expect(() => readFileSync(replacementMarker)).toThrow();
	}, 30_000);

	test("cooperative admission detects source-path drift and continues only with its reviewed private copy", async () => {
		const root = resolve(NEUTRAL_CWD, "external-admission-races");
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const reviewedCalls = resolve(root, "reviewed-calls.jsonl");
		const replacementCalls = resolve(root, "replacement-calls.jsonl");
		const fakeAgent = resolve(root, "agent-browser");
		const installLock = resolve(root, "package-lock.json");
		const handoffPath = resolve(root, "handoff.json");
		writeFileSync(fakeAgent, agentBrowserProcessFixtureSource({
			statePath: resolve(root, "reviewed-state.json"),
			callLogPath: reviewedCalls,
			targetId: "reviewed-target",
		}), { mode: 0o700 });
		chmodSync(fakeAgent, 0o700);
		writeFileSync(installLock, "{\"lockfileVersion\":3}\n", { mode: 0o600 });
		writeFileSync(handoffPath, verifiedHandoffEnvelope((envelope) => {
			envelope.run_id = "admitted-run-a";
			envelope.data.attachment.adapter_id = "agent-browser";
			envelope.data.attachment.probe_executable = fakeAgent;
		}), { mode: 0o600 });
		const bundle = await prepareBundle(PACKAGE_ROOT, "external-admission-races", {
			executable: fakeAgent,
			installLock,
		});
		writeTestProducerReceipt({ handoffPath, handoffRaw: readFileSync(handoffPath, "utf8"), bundle });
		let externalAdmissionObserved = false;
		const executeWithExternalAdmission = executeVerifiedSealedQualificationBundle as unknown as (
			input: Parameters<typeof executeVerifiedSealedQualificationBundle>[0] & {
				afterExternalAdmissionForTest: () => Promise<void>;
			},
		) => ReturnType<typeof executeVerifiedSealedQualificationBundle>;
		const executed = await executeWithExternalAdmission({
			bundleRoot: bundle.bundleRoot,
			expectedManifestDigest: bundle.manifest_digest,
			wrapperPath: RESOLVED_BROWSER_USE ?? "",
			childArgv: [
				"targets", "open",
				"--url", "https://admitted.example.test/",
				"--handoff", handoffPath,
				"--state", resolve(root, "selected.json"),
				"--run-id", "replacement-run-b",
				"--json",
			],
			env: {
				...process.env,
				HOME: root,
				XDG_CONFIG_HOME: resolve(root, "config"),
				XDG_DATA_HOME: resolve(root, "data"),
				XDG_STATE_HOME: resolve(root, "state"),
				XDG_CACHE_HOME: resolve(root, "cache"),
				XDG_RUNTIME_DIR: resolve(root, "runtime"),
			},
			afterExternalAdmissionForTest: async () => {
				externalAdmissionObserved = true;
				renameSync(fakeAgent, `${fakeAgent}.reviewed`);
				writeFileSync(fakeAgent, agentBrowserProcessFixtureSource({
					statePath: resolve(root, "replacement-state.json"),
					callLogPath: replacementCalls,
					targetId: "replacement-target",
				}), { mode: 0o700 });
				chmodSync(fakeAgent, 0o700);
				writeFileSync(handoffPath, verifiedHandoffEnvelope((envelope) => {
					envelope.run_id = "replacement-run-b";
					envelope.data.attachment.adapter_id = "agent-browser";
					envelope.data.attachment.probe_executable = fakeAgent;
				}), { mode: 0o600 });
			},
		});
		expect(externalAdmissionObserved).toBe(true);
		expect(executed.exitCode).toBe(20);
		expect(executed.stdout).toContain("target_discovery_run_mismatch");
		expect(() => readFileSync(replacementCalls)).toThrow();
	}, 30_000);

	test("an Agent Browser pathname replacement after admission executes only the reviewed adapter bytes", async () => {
		const root = resolve(NEUTRAL_CWD, "agent-executable-admission-race");
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const reviewedCalls = resolve(root, "reviewed-calls.jsonl");
		const replacementCalls = resolve(root, "replacement-calls.jsonl");
		const fakeAgent = resolve(root, "agent-browser");
		const reviewedAgent = `${fakeAgent}.reviewed`;
		const installLock = resolve(root, "package-lock.json");
		const handoffPath = resolve(root, "handoff.json");
		const selectedState = resolve(root, "selected.json");
		writeFileSync(fakeAgent, agentBrowserProcessFixtureSource({
			statePath: resolve(root, "reviewed-state.json"),
			callLogPath: reviewedCalls,
			targetId: "reviewed-race-target",
		}), { mode: 0o700 });
		chmodSync(fakeAgent, 0o700);
		writeFileSync(installLock, "{\"lockfileVersion\":3}\n", { mode: 0o600 });
		const handoffRaw = verifiedHandoffEnvelope((envelope) => {
			envelope.run_id = "agent-race-run";
			envelope.data.attachment.adapter_id = "agent-browser";
			envelope.data.attachment.probe_executable = fakeAgent;
		});
		writeFileSync(handoffPath, handoffRaw, { mode: 0o600 });
		const bundle = await prepareBundle(PACKAGE_ROOT, "agent-executable-admission-race", {
			executable: fakeAgent,
			installLock,
		});
		writeTestProducerReceipt({ handoffPath, handoffRaw, bundle });
		const env = {
			...process.env,
			HOME: root,
			XDG_CONFIG_HOME: resolve(root, "config"),
			XDG_DATA_HOME: resolve(root, "data"),
			XDG_STATE_HOME: resolve(root, "state"),
			XDG_CACHE_HOME: resolve(root, "cache"),
			XDG_RUNTIME_DIR: resolve(root, "runtime"),
		};
		const executeWithExternalAdmission = executeVerifiedSealedQualificationBundle as unknown as (
			input: Parameters<typeof executeVerifiedSealedQualificationBundle>[0] & {
				afterExternalAdmissionForTest: () => Promise<void>;
			},
		) => ReturnType<typeof executeVerifiedSealedQualificationBundle>;
		let externalAdmissionObserved = false;
		const opened = await executeWithExternalAdmission({
			bundleRoot: bundle.bundleRoot,
			expectedManifestDigest: bundle.manifest_digest,
			wrapperPath: RESOLVED_BROWSER_USE ?? "",
			childArgv: [
				"targets", "open",
				"--url", "https://agent-race.example.test/",
				"--handoff", handoffPath,
				"--state", selectedState,
				"--run-id", "agent-race-run",
				"--json",
			],
			env,
			afterExternalAdmissionForTest: async () => {
				externalAdmissionObserved = true;
				renameSync(fakeAgent, reviewedAgent);
				writeFileSync(fakeAgent, agentBrowserProcessFixtureSource({
					statePath: resolve(root, "replacement-state.json"),
					callLogPath: replacementCalls,
					targetId: "replacement-race-target",
				}), { mode: 0o700 });
				chmodSync(fakeAgent, 0o700);
			},
		});
		expect(externalAdmissionObserved).toBe(true);
		expect(opened.exitCode, opened.stdout || opened.stderr).toBe(0);
		expect(readFileSync(reviewedCalls, "utf8")).toContain(
			'"--pin-tab","tab","new"',
		);
		expect(() => readFileSync(replacementCalls)).toThrow();
		rmSync(fakeAgent, { force: true });
		renameSync(reviewedAgent, fakeAgent);
		const closed = await sealedExec({
			bundle,
			env,
			args: [
				"targets", "close",
				"--handoff", handoffPath,
				"--state", selectedState,
				"--run-id", "agent-race-run",
				"--json",
			],
		});
		expect(closed.exitCode, closed.stdout || closed.stderr).toBe(0);
	}, 30_000);

	test("a verified bundle pathname cannot authorize replacement bytes", async () => {
		if (!RESOLVED_BROWSER_USE) throw new Error("browser-use is not resolved on PATH");
		const prepared = await prepareBundle(PACKAGE_ROOT, "replacement-red");
		let verifiedPath = "";
		let reviewedPath = "";
		const executed = await executeVerifiedSealedQualificationBundle({
			bundleRoot: prepared.bundleRoot,
			expectedManifestDigest: prepared.manifest_digest,
			wrapperPath: RESOLVED_BROWSER_USE,
			childArgv: ["qualification", "manifest", "--json"],
			env: { ...process.env, HOME: NEUTRAL_CWD },
			afterVerifiedForTest: async (verified) => {
				verifiedPath = verified.artifactPath;
				reviewedPath = `${verified.artifactPath}.reviewed`;
				chmodSync(verified.root, 0o700);
				renameSync(verified.artifactPath, reviewedPath);
				writeFileSync(
					verified.artifactPath,
					"#!/usr/bin/env bun\nprocess.stdout.write('UNREVIEWED_REPLACEMENT_EXECUTED\\n')\n",
					{ mode: 0o500 },
				);
				chmodSync(verified.root, 0o500);
			},
		});
		expect(executed.exitCode, executed.stdout || executed.stderr).toBe(0);
		expect(executed.stdout).not.toContain("UNREVIEWED_REPLACEMENT_EXECUTED");
		expect(readFileSync(resolve(prepared.bundleRoot, SEALED_ARTIFACT_NAME))).not.toEqual(
			readFileSync(reviewedPath),
		);
		expect(verifiedPath).not.toBe("");
	});

	test("sealed execution rejects a handoff-selected Agent Browser executable not bound by prepare", async () => {
		const root = resolve(NEUTRAL_CWD, "agent-browser-identity-red");
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const reviewedAgent = resolve(root, "reviewed-agent-browser");
		const otherAgent = resolve(root, "other-agent-browser");
		const installLock = resolve(root, "package-lock.json");
		const handoffPath = resolve(root, "handoff.json");
		const selectedState = resolve(root, "selected-state.json");
		writeFileSync(reviewedAgent, agentBrowserProcessFixtureSource({
			statePath: resolve(root, "reviewed-state.json"),
			callLogPath: resolve(root, "reviewed-calls.jsonl"),
			targetId: "reviewed-target",
		}), { mode: 0o700 });
		writeFileSync(otherAgent, agentBrowserProcessFixtureSource({
			statePath: resolve(root, "other-state.json"),
			callLogPath: resolve(root, "other-calls.jsonl"),
			targetId: "other-target",
		}), { mode: 0o700 });
		chmodSync(reviewedAgent, 0o700);
		chmodSync(otherAgent, 0o700);
		writeFileSync(installLock, "{\"lockfileVersion\":3}\n", { mode: 0o600 });
		const handoffRaw = verifiedHandoffEnvelope((envelope) => {
			envelope.run_id = "agent-browser-identity-run";
			envelope.data.attachment.adapter_id = "agent-browser";
			envelope.data.attachment.probe_executable = otherAgent;
		});
		writeFileSync(handoffPath, handoffRaw, { mode: 0o600 });
		const bundle = await prepareBundle(PACKAGE_ROOT, "agent-browser-identity", {
			executable: reviewedAgent,
			installLock,
		});
		writeTestProducerReceipt({ handoffPath, handoffRaw, bundle });
		const result = await sealedExec({
			bundle,
			env: {
				...process.env,
				HOME: root,
				XDG_CONFIG_HOME: resolve(root, "config"),
				XDG_DATA_HOME: resolve(root, "data"),
				XDG_STATE_HOME: resolve(root, "state"),
				XDG_CACHE_HOME: resolve(root, "cache"),
				XDG_RUNTIME_DIR: resolve(root, "runtime"),
			},
			args: [
				"targets",
				"open",
				"--url",
				"https://identity.example.test/",
				"--handoff",
				handoffPath,
				"--state",
				selectedState,
				"--run-id",
				"agent-browser-identity-run",
				"--json",
			],
		});
		expect(result.exitCode).toBe(20);
		expect(result.stdout).toContain("qualification_agent_browser_identity_mismatch");
	});

	test("a handoff without this sealed Browser Connect producer receipt fails before adapter mutation", async () => {
		const root = resolve(NEUTRAL_CWD, "missing-producer-receipt");
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const callLog = resolve(root, "agent-calls.jsonl");
		const fakeAgent = resolve(root, "agent-browser");
		const installLock = resolve(root, "package-lock.json");
		const handoffPath = resolve(root, "handoff.json");
		writeFileSync(fakeAgent, agentBrowserProcessFixtureSource({
			statePath: resolve(root, "agent-state.json"),
			callLogPath: callLog,
			targetId: "missing-producer-target",
		}), { mode: 0o700 });
		chmodSync(fakeAgent, 0o700);
		writeFileSync(installLock, "{\"lockfileVersion\":3}\n", { mode: 0o600 });
		writeFileSync(handoffPath, verifiedHandoffEnvelope((envelope) => {
			envelope.run_id = "missing-producer-run";
			envelope.data.attachment.adapter_id = "agent-browser";
			envelope.data.attachment.probe_executable = fakeAgent;
		}), { mode: 0o600 });
		const bundle = await prepareBundle(PACKAGE_ROOT, "missing-producer-receipt", {
			executable: fakeAgent,
			installLock,
		});
		const result = await sealedExec({
			bundle,
			env: {
				...process.env,
				HOME: root,
				XDG_CONFIG_HOME: resolve(root, "config"),
				XDG_DATA_HOME: resolve(root, "data"),
				XDG_STATE_HOME: resolve(root, "state"),
				XDG_CACHE_HOME: resolve(root, "cache"),
				XDG_RUNTIME_DIR: resolve(root, "runtime"),
			},
			args: [
				"targets", "open",
				"--url", "https://producer.example.test/",
				"--handoff", handoffPath,
				"--state", resolve(root, "selected.json"),
				"--run-id", "missing-producer-run",
				"--json",
			],
		});
		expect(result.exitCode).toBe(20);
		expect(result.stdout).toContain("qualification_handoff_producer_invalid");
		expect(() => readFileSync(callLog)).toThrow();
	}, 30_000);

	test("sealed execution rejects same-path Agent Browser byte drift and a non-verified handoff", async () => {
		for (const scenario of ["changed-bytes", "unverified-handoff"] as const) {
			const root = resolve(NEUTRAL_CWD, `agent-browser-${scenario}`);
			mkdirSync(root, { recursive: true, mode: 0o700 });
			const fakeAgent = resolve(root, "agent-browser");
			const installLock = resolve(root, "package-lock.json");
			const handoffPath = resolve(root, "handoff.json");
			writeFileSync(fakeAgent, agentBrowserProcessFixtureSource({
				statePath: resolve(root, "state.json"),
				callLogPath: resolve(root, "calls.jsonl"),
				targetId: "identity-target",
			}), { mode: 0o700 });
			chmodSync(fakeAgent, 0o700);
			writeFileSync(installLock, "{\"lockfileVersion\":3}\n", { mode: 0o600 });
			const bundle = await prepareBundle(PACKAGE_ROOT, `agent-browser-${scenario}-bundle`, {
				executable: fakeAgent,
				installLock,
			});
			if (scenario === "changed-bytes") {
				writeFileSync(fakeAgent, "#!/usr/bin/env bun\nprocess.exit(0)\n", { mode: 0o700 });
			}
			const handoffDocument = JSON.parse(
				verifiedHandoffEnvelope((envelope) => {
					envelope.run_id = `identity-${scenario}`;
					envelope.data.attachment.adapter_id = "agent-browser";
					envelope.data.attachment.probe_executable = fakeAgent;
				}),
			) as Record<string, unknown>;
			if (scenario === "unverified-handoff") {
				(handoffDocument.data as Record<string, unknown>).outcome = "failed";
			}
			writeFileSync(handoffPath, JSON.stringify(handoffDocument), { mode: 0o600 });
			writeTestProducerReceipt({
				handoffPath,
				handoffRaw: JSON.stringify(handoffDocument),
				bundle,
			});
			const result = await sealedExec({
				bundle,
				env: {
					...process.env,
					HOME: root,
					XDG_CONFIG_HOME: resolve(root, "config"),
					XDG_DATA_HOME: resolve(root, "data"),
					XDG_STATE_HOME: resolve(root, "xdg-state"),
					XDG_CACHE_HOME: resolve(root, "cache"),
					XDG_RUNTIME_DIR: resolve(root, "runtime"),
				},
				args: [
					"targets", "open",
					"--url", "https://identity.example.test/",
					"--handoff", handoffPath,
					"--state", resolve(root, "selected.json"),
					"--run-id", `identity-${scenario}`,
					"--json",
				],
			});
			expect(result.exitCode, scenario).toBe(20);
			expect(result.stdout).toContain(
				scenario === "changed-bytes"
					? "qualification_external_identity_mismatch"
					: "qualification_agent_browser_identity_mismatch",
			);
		}
	}, 30_000);

	test("forged qualification environment cannot stamp an ordinary source receipt", async () => {
		if (!RESOLVED_BROWSER_USE) throw new Error("browser-use is not resolved on PATH");
		const root = resolve(NEUTRAL_CWD, "forged-source-evidence");
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const fakeAgent = resolve(root, "agent-browser");
		const handoffPath = resolve(root, "handoff.json");
		const selectedState = resolve(root, "selected.json");
		writeFileSync(fakeAgent, agentBrowserProcessFixtureSource({
			statePath: resolve(root, "state.json"),
			callLogPath: resolve(root, "calls.jsonl"),
			targetId: "source-target",
		}), { mode: 0o700 });
		chmodSync(fakeAgent, 0o700);
		writeFileSync(
			handoffPath,
			verifiedHandoffEnvelope((envelope) => {
				envelope.run_id = "forged-source-run";
				envelope.data.attachment.adapter_id = "agent-browser";
				envelope.data.attachment.probe_executable = fakeAgent;
			}),
			{ mode: 0o600 },
		);
		const env = {
			...process.env,
			HOME: root,
			XDG_CONFIG_HOME: resolve(root, "config"),
			XDG_DATA_HOME: resolve(root, "data"),
			XDG_STATE_HOME: resolve(root, "xdg-state"),
			XDG_CACHE_HOME: resolve(root, "cache"),
			XDG_RUNTIME_DIR: resolve(root, "runtime"),
			BROWSER_USE_QUALIFICATION_EXPECTED_MANIFEST_DIGEST: "a".repeat(64),
			BROWSER_USE_QUALIFICATION_OBSERVED_MANIFEST_DIGEST: "a".repeat(64),
			BROWSER_USE_QUALIFICATION_SEALED_ARTIFACT_SHA256: "b".repeat(64),
		};
		const common = [
			"--handoff", handoffPath,
			"--state", selectedState,
			"--run-id", "forged-source-run",
			"--json",
		];
		const opened = Bun.spawn(
			[RESOLVED_BROWSER_USE, "targets", "open", "--url", "https://source.example.test/", ...common],
			{ env, stdout: "pipe", stderr: "pipe" },
		);
		const openedStdout = await new Response(opened.stdout).text();
		expect(await opened.exited, openedStdout).toBe(0);
		expect((JSON.parse(openedStdout).data as Record<string, unknown>).qualification_runtime).toBeUndefined();
		const closed = Bun.spawn(
			[RESOLVED_BROWSER_USE, "targets", "close", ...common],
			{ env, stdout: "pipe", stderr: "pipe" },
		);
		expect(await closed.exited, await new Response(closed.stdout).text()).toBe(0);
	}, 30_000);

	test("the public wrapper prepares one private sealed qualification bundle without overwrite", async () => {
		if (!RESOLVED_BROWSER_USE) throw new Error("browser-use is not resolved on PATH");
		const bundleRoot = resolve(NEUTRAL_CWD, "sealed-public-bundle");
		const child = Bun.spawn(
			[
				RESOLVED_BROWSER_USE,
				"qualification",
				"prepare",
				"--output",
				bundleRoot,
				"--json",
			],
			{ cwd: PACKAGE_ROOT, env: { ...process.env, HOME: NEUTRAL_CWD }, stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode, stdout || stderr).toBe(0);
		expect(stderr).toBe("");
		const envelope = JSON.parse(stdout) as { status: string; data: Record<string, unknown> };
		expect(envelope).toMatchObject({
			status: "ok",
			data: {
				contract: "browser-use.qualification-bundle",
				schema_version: "1",
				bundle_root: bundleRoot,
				artifact_mode: 0o500,
				manifest_mode: 0o400,
			},
		});
		expect(lstatSync(bundleRoot).mode & 0o777).toBe(0o500);
		expect(lstatSync(resolve(bundleRoot, SEALED_ARTIFACT_NAME)).mode & 0o777).toBe(0o500);
		expect(lstatSync(resolve(bundleRoot, "manifest.json")).mode & 0o777).toBe(0o400);
		const repeated = Bun.spawn(
			[RESOLVED_BROWSER_USE, "qualification", "prepare", "--output", bundleRoot, "--json"],
			{ cwd: PACKAGE_ROOT, env: { ...process.env, HOME: NEUTRAL_CWD }, stdout: "pipe", stderr: "pipe" },
		);
		expect(await repeated.exited).toBe(20);
		const help = Bun.spawn(
			[RESOLVED_BROWSER_USE, "qualification", "exec", "--help"],
			{ cwd: PACKAGE_ROOT, stdout: "pipe", stderr: "pipe" },
		);
		const helpStdout = await new Response(help.stdout).text();
		expect(await help.exited).toBe(0);
		expect(helpStdout).toBe(
			"Usage: browser-use qualification exec --bundle <private-dir> --expected-manifest-digest <sha256> -- <browser-use-argv>\n",
		);
		const handoffHelp = Bun.spawn(
			[RESOLVED_BROWSER_USE, "qualification", "handoff", "--help"],
			{ cwd: PACKAGE_ROOT, stdout: "pipe", stderr: "pipe" },
		);
		const handoffHelpStdout = await new Response(handoffHelp.stdout).text();
		expect(await handoffHelp.exited).toBe(0);
		expect(handoffHelpStdout).toBe(
			"Usage: browser-use qualification handoff --bundle <private-dir> --expected-manifest-digest <sha256> --run-id <id> --output <private-path> --json\n",
		);
		const missingChildArgv = Bun.spawn(
			[
				RESOLVED_BROWSER_USE,
				"qualification",
				"exec",
				"--bundle",
				bundleRoot,
				"--expected-manifest-digest",
				String(envelope.data.manifest_digest),
			],
			{ cwd: PACKAGE_ROOT, stdout: "pipe", stderr: "pipe" },
		);
		expect(await missingChildArgv.exited).toBe(20);
	}, 30_000);

	test("qualification bundle-root diagnostics classify every admission predicate without leaking inputs", async () => {
		if (!RESOLVED_BROWSER_USE) throw new Error("browser-use is not resolved on PATH");
		const fixtureRoot = resolve(NEUTRAL_CWD, "diagnostic-private-path-sentinel");
		mkdirSync(fixtureRoot, { mode: 0o700 });
		const nonDirectoryRoot = resolve(fixtureRoot, "non-directory");
		writeFileSync(nonDirectoryRoot, "not-a-bundle\n", { mode: 0o500 });
		const symlinkTarget = resolve(fixtureRoot, "symlink-target");
		mkdirSync(symlinkTarget, { mode: 0o500 });
		const symlinkRoot = resolve(fixtureRoot, "symlink-root");
		symlinkSync(symlinkTarget, symlinkRoot);
		const wrongModeRoot = resolve(fixtureRoot, "wrong-mode");
		mkdirSync(wrongModeRoot, { mode: 0o700 });
		const realParent = resolve(fixtureRoot, "real-parent");
		mkdirSync(realParent, { mode: 0o700 });
		const noncanonicalTarget = resolve(realParent, "noncanonical-root");
		mkdirSync(noncanonicalTarget, { mode: 0o500 });
		const aliasParent = resolve(fixtureRoot, "alias-parent");
		symlinkSync(realParent, aliasParent);
		const unpreparedRoot = resolve(fixtureRoot, "unprepared-root");
		mkdirSync(unpreparedRoot, { mode: 0o500 });

		const expectedEvents = [
			"qualification-front-door-dispatch",
			"qualification-bundle-verification-started",
			"qualification-bundle-root-classified",
			"qualification-terminal-failure",
		];
		const sensitiveValues = [
			fixtureRoot,
			"https://diagnostic-leak.invalid/private",
			"diagnostic-token-sentinel",
			"diagnostic-cookie-sentinel",
			"diagnostic-env-sentinel",
		];
		const scenarios = [
			{
				label: "missing",
				bundleRoot: resolve(fixtureRoot, "missing-root"),
				expectedClassification: "missing_root",
			},
			{
				label: "non-directory",
				bundleRoot: nonDirectoryRoot,
				expectedClassification: "non_directory",
			},
			{
				label: "symlink",
				bundleRoot: symlinkRoot,
				expectedClassification: "symlink",
			},
			{
				label: "wrong-mode",
				bundleRoot: wrongModeRoot,
				expectedClassification: "wrong_mode",
			},
			{
				label: "noncanonical",
				bundleRoot: resolve(aliasParent, "noncanonical-root"),
				expectedClassification: "noncanonical_realpath",
			},
			{
				label: "unprepared",
				bundleRoot: unpreparedRoot,
				expectedClassification: "unprepared_or_unsealed_root",
			},
		] as const;

		const invoke = async (
			scenario: (typeof scenarios)[number],
			mode?: "--debug" | "--quiet",
		) => {
			const runId = `qualification-root-${scenario.label}${mode ?? "-default"}`;
			const child = Bun.spawn(
				[
					RESOLVED_BROWSER_USE,
					"qualification",
					"manifest",
					"--bundle",
					scenario.bundleRoot,
					"--expected-manifest-digest",
					"a".repeat(64),
					"--json",
					"--run-id",
					runId,
					...(mode ? [mode] : []),
				],
				{
					cwd: NEUTRAL_CWD,
					env: {
						...process.env,
						BROWSER_USE_TEST_ENDPOINT:
							"https://diagnostic-leak.invalid/private",
						BROWSER_USE_TEST_TOKEN: "diagnostic-token-sentinel",
						BROWSER_USE_TEST_COOKIE: "diagnostic-cookie-sentinel",
						BROWSER_USE_TEST_ENV: "diagnostic-env-sentinel",
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { runId, stdout, stderr, exitCode };
		};

		for (const scenario of scenarios) {
			const result = await invoke(scenario);
			expect(result.exitCode, result.stdout || result.stderr).toBe(20);
			const stdoutLines = result.stdout.trimEnd().split("\n");
			expect(stdoutLines).toHaveLength(1);
			expect(JSON.parse(stdoutLines[0])).toEqual({
				status: "error",
				error: {
					code: "qualification_bundle_root_invalid",
					exit_code: 20,
					message: "The sealed Browser Use qualification runtime was not admitted.",
				},
			});
			const records = result.stderr
				.trimEnd()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(records.map((record) => record.event)).toEqual(expectedEvents);
			expect(records.every((record) => record.run_id === result.runId)).toBe(true);
			expect(records).toContainEqual(
					expect.objectContaining({
					level: "debug",
					category: ["browser-use", "qualification"],
					event: "qualification-bundle-root-classified",
					bundle_root_state: scenario.expectedClassification,
					admitted: false,
					recommended_phase: "qualification_prepare",
				}),
			);
			for (const sensitive of sensitiveValues) {
				expect(result.stderr).not.toContain(sensitive);
			}
		}

		const debugResult = await invoke(scenarios[0], "--debug");
		const debugEvents = debugResult.stderr
			.trimEnd()
			.split("\n")
			.filter(Boolean)
			.map((line) => (JSON.parse(line) as { event?: string }).event);
		expect(debugEvents).toEqual(expectedEvents);

		const quietResult = await invoke(scenarios[0], "--quiet");
		expect(quietResult.exitCode).toBe(20);
		expect(quietResult.stderr).toBe("");
		expect(quietResult.stdout.trimEnd().split("\n")).toHaveLength(1);
		expect(JSON.parse(quietResult.stdout).error?.code).toBe(
			"qualification_bundle_root_invalid",
		);

		const successfulHelp = Bun.spawn(
			[RESOLVED_BROWSER_USE, "qualification", "--help"],
			{ cwd: NEUTRAL_CWD, stdout: "pipe", stderr: "pipe" },
		);
		const [helpStdout, helpStderr, helpExitCode] = await Promise.all([
			new Response(successfulHelp.stdout).text(),
			new Response(successfulHelp.stderr).text(),
			successfulHelp.exited,
		]);
		expect(helpExitCode, helpStdout || helpStderr).toBe(0);
		expect(helpStdout).toBe(
			"Usage: browser-use qualification <prepare|manifest|validate|exec|handoff|session> --help\n",
		);
		expect(helpStderr).toBe("");
	}, 30_000);

	test("the resolved public front door emits one CWD-invariant manifest", async () => {
		if (!RESOLVED_BROWSER_USE) throw new Error("browser-use is not resolved on PATH");
		const manifests = await Promise.all(
			[PACKAGE_ROOT, REPO_ROOT, NEUTRAL_CWD].map((cwd, index) => manifestFrom(cwd, `cwd-${index}`)),
		);
		expect(
			new Set(manifests.map((manifest) => manifest.envelope.data.manifest_digest)),
		).toEqual(new Set([REVIEWED_REPAIRED_MANIFEST_DIGEST]));
		expect(
			new Set(
				manifests.map(
					(manifest) => manifest.envelope.data.wrapper.resolved_executable_realpath,
				),
			),
		).toEqual(new Set([realpathSync(RESOLVED_BROWSER_USE)]));
	}, 30_000);

	test("the resolved public validator rejects replayed persisted producer evidence outside its sealed session", async () => {
		if (!RESOLVED_BROWSER_USE) throw new Error("browser-use is not resolved on PATH");
		const fixtureRoot = resolve(NEUTRAL_CWD, "validator-success-process");
		const stateHome = resolve(fixtureRoot, "state");
		const fakeAgent = resolve(fixtureRoot, "agent-browser-fixture");
		const fakeState = resolve(fixtureRoot, "agent-browser-state.json");
		const callLog = resolve(fixtureRoot, "agent-browser-calls.jsonl");
		const handoffPath = resolve(fixtureRoot, "handoff.json");
		const selectedState = resolve(fixtureRoot, "selected-state.json");
		const evidencePath = resolve(fixtureRoot, "evidence.json");
		const fakeInstallLock = resolve(fixtureRoot, "agent-browser-package-lock.json");
		mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 });
		chmodSync(fixtureRoot, 0o700);
		writeFileSync(fakeAgent, agentBrowserProcessFixtureSource({ statePath: fakeState, callLogPath: callLog, targetId: "target-a-raw" }), { mode: 0o700 });
		chmodSync(fakeAgent, 0o700);
		writeFileSync(fakeInstallLock, "{\"lockfileVersion\":3}\n", { mode: 0o600 });
		const handoffRaw = verifiedHandoffEnvelope((envelope) => {
			envelope.run_id = RUN_ID;
			envelope.data.attachment.adapter_id = "agent-browser";
			envelope.data.attachment.probe_executable = fakeAgent;
		});
		writeFileSync(handoffPath, handoffRaw, { mode: 0o600 });
		const manifest = await manifestFrom(PACKAGE_ROOT, "validator-success", {
			executable: fakeAgent,
			installLock: fakeInstallLock,
		});
		const producerReceiptRaw = writeTestProducerReceipt({
			handoffPath,
			handoffRaw,
			bundle: manifest.bundle,
		});
		const expectedDigest = manifest.bundle.manifest_digest;
		const env = {
			...process.env,
			HOME: fixtureRoot,
			XDG_CONFIG_HOME: resolve(fixtureRoot, "config"),
			XDG_DATA_HOME: resolve(fixtureRoot, "data"),
			XDG_STATE_HOME: stateHome,
			XDG_CACHE_HOME: resolve(fixtureRoot, "cache"),
			XDG_RUNTIME_DIR: resolve(fixtureRoot, "runtime"),
		};
		const common = ["--handoff", handoffPath, "--state", selectedState, "--run-id", RUN_ID, "--json"];
		const opened = await sealedExec({ bundle: manifest.bundle, env, args: ["targets", "open", "--url", "https://storybook-a.example.test/", ...common] });
		expect(opened, opened.stdout || opened.stderr).toMatchObject({ exitCode: 0, stderr: "" });
		const snapshot = await sealedExec({ bundle: manifest.bundle, env, args: ["operate", "snapshot", ...common] });
		expect(snapshot, snapshot.stdout || snapshot.stderr).toMatchObject({ exitCode: 0, stderr: "" });
		const closed = await sealedExec({ bundle: manifest.bundle, env, args: ["targets", "close", ...common] });
		expect(closed, closed.stdout || closed.stderr).toMatchObject({ exitCode: 0, stderr: "" });
		for (const receipt of [opened.stdout, snapshot.stdout, closed.stdout]) {
			const parsedReceipt = JSON.parse(receipt);
			expect(parsedReceipt).toMatchObject({
				status: "ok",
				run_id: RUN_ID,
				data: {
					qualification_runtime: {
						contract: "browser-use.qualification-runtime-evidence",
						schema_version: "1",
						expected_manifest_digest: expectedDigest,
						observed_manifest_digest: expectedDigest,
						sealed_artifact_sha256: manifest.bundle.artifact_sha256,
					},
				},
			});
			const contract = parsedReceipt.data?.contract;
			expect(
				contract === "browser-use.browser-operation"
					? parseBrowserOperationQualificationReceipt(receipt)
					: parseBrowserTargetTopologyQualificationReceipt(receipt),
				receipt,
			).toBeDefined();
		}
		const evidence = {
			contract: "browser-use.qualification-evidence",
			schema_version: "1",
			adapter_capability_id: "agent-browser.exact-target-no-focus.v1",
			threat_model: {
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
			},
			expected_manifest_digest: expectedDigest,
			observed_manifest_digest: expectedDigest,
			runs: [{ run_id: RUN_ID, handoff_raw: handoffRaw, handoff_capability_handle: "replayed-persisted-handle", producer_receipt_raw: producerReceiptRaw, expected_origin: "https://storybook-a.example.test", expected_target_ref: TARGET_REF, receipt_raws: [opened.stdout, snapshot.stdout, closed.stdout] }],
		};
		const missingRuntimeEvidencePath = resolve(
			fixtureRoot,
			"evidence-missing-runtime.json",
		);
		const missingRuntimeReceipt = JSON.parse(snapshot.stdout);
		delete missingRuntimeReceipt.data.qualification_runtime;
		writeFileSync(
			missingRuntimeEvidencePath,
			JSON.stringify({
				...evidence,
				runs: [
					{
						...evidence.runs[0],
						receipt_raws: [
							opened.stdout,
							JSON.stringify(missingRuntimeReceipt),
							closed.stdout,
						],
					},
				],
			}),
			{ mode: 0o600 },
		);
		const missingRuntime = Bun.spawn(
			[
				RESOLVED_BROWSER_USE,
				"qualification",
				"validate",
				"--bundle",
				manifest.bundle.bundleRoot,
				"--expected-manifest-digest",
				expectedDigest,
				"--evidence",
				missingRuntimeEvidencePath,
				"--json",
			],
			{ cwd: NEUTRAL_CWD, env, stdout: "pipe", stderr: "pipe" },
		);
		const missingRuntimeStdout = await new Response(
			missingRuntime.stdout,
		).text();
		expect(await missingRuntime.exited).toBe(20);
		expect(JSON.parse(missingRuntimeStdout).error?.code).toBe(
			"qualification_handoff_capability_not_live",
		);
		writeFileSync(evidencePath, JSON.stringify(evidence), { mode: 0o600 });
		const child = Bun.spawn(
			[RESOLVED_BROWSER_USE, "qualification", "validate", "--bundle", manifest.bundle.bundleRoot, "--expected-manifest-digest", expectedDigest, "--evidence", evidencePath, "--json"],
			{ cwd: NEUTRAL_CWD, env, stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		expect(exitCode, stdout || stderr).toBe(20);
		expectQualificationFailureDiagnosticTrail({
			stderr,
			command: "validate",
			verificationOutcomes: ["completed"],
			failureKind: "execution_failed",
			sensitiveValues: [
				fixtureRoot,
				manifest.bundle.bundleRoot,
				handoffPath,
				evidencePath,
				"replayed-persisted-handle",
				"https://storybook-a.example.test",
			],
		});
		const validationEnvelope = JSON.parse(stdout) as {
			status: string;
			data?: Record<string, unknown>;
			error?: { code?: string };
		};
		expect(validationEnvelope).toMatchObject({
			status: "error",
			error: { code: "qualification_handoff_capability_not_live" },
		});
		expect(readFileSync(callLog, "utf8")).toContain("snapshot");
	}, 30_000);
	test("the resolved public validator requires the externally reviewed digest", async () => {
		if (!RESOLVED_BROWSER_USE) throw new Error("browser-use is not resolved on PATH");
		const fixtureRoot = resolve(NEUTRAL_CWD, "validator-process");
		const stateHome = resolve(fixtureRoot, "state");
		const stateRoot = resolve(stateHome, "browser-use");
		const custodyDir = resolve(stateRoot, "browser-custody");
		mkdirSync(custodyDir, { recursive: true, mode: 0o700 });
		chmodSync(fixtureRoot, 0o700);
		chmodSync(stateHome, 0o700);
		chmodSync(stateRoot, 0o700);
		writeFileSync(
			resolve(custodyDir, "registry.json"),
			JSON.stringify({
				contract: "browser-use.browser-custody",
				schema_version: "1",
				authority_id: "0".repeat(64),
				revision: 0,
				targets: {},
			}),
			{ mode: 0o600 },
		);
		const manifest = await manifestFrom(PACKAGE_ROOT, "validator-mismatch");
		const evidencePath = resolve(fixtureRoot, "evidence.json");
		writeFileSync(evidencePath, "{}", { mode: 0o600 });
		const child = Bun.spawn(
			[
				RESOLVED_BROWSER_USE,
				"qualification",
				"validate",
				"--bundle",
				manifest.bundle.bundleRoot,
				"--expected-manifest-digest",
				"d".repeat(64),
				"--evidence",
				evidencePath,
				"--json",
			],
			{
				cwd: NEUTRAL_CWD,
				env: {
					...process.env,
					HOME: fixtureRoot,
					XDG_CONFIG_HOME: resolve(fixtureRoot, "config"),
					XDG_DATA_HOME: resolve(fixtureRoot, "data"),
					XDG_STATE_HOME: stateHome,
					XDG_CACHE_HOME: resolve(fixtureRoot, "cache"),
					XDG_RUNTIME_DIR: resolve(fixtureRoot, "runtime"),
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode, stdout || stderr).toBe(20);
		expectQualificationFailureDiagnosticTrail({
			stderr,
			command: "validate",
			verificationOutcomes: ["root_admitted"],
			failureKind: "bundle_verification_failed",
			sensitiveValues: [fixtureRoot, manifest.bundle.bundleRoot, evidencePath],
		});
		expect(JSON.parse(stdout)).toMatchObject({
			status: "error",
			error: { code: "qualification_manifest_mismatch", exit_code: 20 },
		});
	}, 30_000);
});

describe("pre-live executable-bundle gate", () => {
	test("session refuses before execution when the expected source digest is absent", async () => {
		if (!RESOLVED_BROWSER_USE) throw new Error("browser-use is not resolved on PATH");
		const child = Bun.spawn(
			[
				RESOLVED_BROWSER_USE,
				"qualification",
				"session",
				"--bundle",
				resolve(NEUTRAL_CWD, "gate-absent-digest-bundle"),
				"--expected-manifest-digest",
				"a".repeat(64),
				"--jsonl",
			],
			{ cwd: NEUTRAL_CWD, env: { ...process.env, HOME: NEUTRAL_CWD }, stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode, stdout || stderr).toBe(20);
		expect(JSON.parse(stdout.trim())).toMatchObject({
			status: "error",
			error: { code: "qualification_source_identity_invalid", exit_code: 20 },
		});
		// The refusal precedes any sealed child: no campaign receipt is emitted.
		expect(stdout).not.toContain("child_exit_code");
	}, 30_000);

	test("session refuses a source digest that drifts from the sealed and current manifests", async () => {
		if (!RESOLVED_BROWSER_USE) throw new Error("browser-use is not resolved on PATH");
		const admitted = await manifestFrom(PACKAGE_ROOT, "gate-source-drift");
		const child = Bun.spawn(
			[
				RESOLVED_BROWSER_USE,
				"qualification",
				"session",
				"--bundle",
				admitted.bundle.bundleRoot,
				"--expected-manifest-digest",
				admitted.envelope.data.manifest_digest,
				"--expected-source-digest",
				"b".repeat(64),
				"--jsonl",
			],
			{ cwd: NEUTRAL_CWD, env: { ...process.env, HOME: NEUTRAL_CWD }, stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode, stdout || stderr).not.toBe(0);
		expect(stdout).not.toContain("child_exit_code");
	}, 60_000);

	test("the exact freshly built artifact is admitted and bound by the sealed manifest", async () => {
		const entryPath = await assertBrowserUseQualificationRuntimeEntry();
		expect(entryPath).toBe(
			resolve(
				REPO_ROOT,
				"config/agents/skills/personal/browser-use/src/browser-use-qualification-runtime.ts",
			),
		);
		expect(lstatSync(entryPath).isFile()).toBe(true);

		const admitted = await manifestFrom(PACKAGE_ROOT, "gate-fresh-artifact");
		const artifactPath = resolve(admitted.bundle.bundleRoot, SEALED_ARTIFACT_NAME);
		const builtSha256 = createHash("sha256")
			.update(readFileSync(artifactPath))
			.digest("hex");
		const sealedRuntime = admitted.envelope.data.sealed_runtime as {
			artifact_sha256: string;
		};
		expect(sealedRuntime.artifact_sha256).toBe(builtSha256);
	}, 60_000);

	test("a packaged bin root cannot bypass the gate to qualify stale dist bytes", async () => {
		const packagedRoot = mkdtempSync(`${tmpdir()}/browser-use-packaged-bin-`);
		const distDir = resolve(packagedRoot, "dist");
		mkdirSync(distDir, { recursive: true, mode: 0o700 });
		writeFileSync(resolve(distDir, "browser-use.js"), "// stale packaged bundle\n", {
			mode: 0o600,
		});
		await expect(
			assertBrowserUseQualificationRuntimeEntry(packagedRoot),
		).rejects.toThrow("qualification_bundle_source_entry_unavailable");

		// A symlinked entrypoint is not a real in-checkout source file either.
		const symlinkedRoot = mkdtempSync(`${tmpdir()}/browser-use-symlinked-entry-`);
		const entryDir = resolve(
			symlinkedRoot,
			"config/agents/skills/personal/browser-use/src",
		);
		mkdirSync(entryDir, { recursive: true, mode: 0o700 });
		symlinkSync(
			resolve(
				REPO_ROOT,
				"config/agents/skills/personal/browser-use/src/browser-use-qualification-runtime.ts",
			),
			resolve(entryDir, "browser-use-qualification-runtime.ts"),
		);
		await expect(
			assertBrowserUseQualificationRuntimeEntry(symlinkedRoot),
		).rejects.toThrow("qualification_bundle_source_entry_unavailable");

		rmSync(packagedRoot, { recursive: true, force: true });
		rmSync(symlinkedRoot, { recursive: true, force: true });
	}, 30_000);
});
