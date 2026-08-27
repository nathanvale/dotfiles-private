#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { constants, fstatSync, readFileSync } from "node:fs";
import {
	chmod,
	lstat,
	open,
	readFile,
	realpath,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { runBrowserUseCli } from "./browser-use";
import { browserAuthorityIdOf } from "./browser-use-browser-custody";
import { parseBrowserOperationQualificationReceipt } from "./browser-use-operations";
import { createProductionBrowserUseRuntime as createProductionBrowserUseRuntimeInternal } from "./browser-use-runtime";
import { parseBrowserTargetTopologyQualificationReceipt } from "./browser-use-target-topology";
import { parseHandoffFacts } from "./browser-use-discovery";
import {
	BROWSER_USE_QUALIFICATION_RUNTIME_EVIDENCE_CONTRACT_ID,
	BROWSER_USE_QUALIFICATION_RUNTIME_EVIDENCE_SCHEMA_VERSION,
	BROWSER_USE_QUALIFICATION_SESSION_REQUEST_CONTRACT_ID,
	BROWSER_USE_QUALIFICATION_SESSION_REQUEST_SCHEMA_VERSION,
	BROWSER_USE_QUALIFICATION_SESSION_RESULT_CONTRACT_ID,
	BROWSER_USE_QUALIFICATION_SESSION_RESULT_SCHEMA_VERSION,
} from "./command-contract";
import { withSealedQualificationRuntimeEvidence } from "./browser-use-qualification-evidence";
import {
	captureBrowserUseQualificationCustodyInventory,
	validateBrowserUseQualificationEvidence,
	validateBrowserUseQualificationManifest,
} from "./browser-use-qualification";
import {
	BrowserUseQualificationSessionAuthority,
	withBrowserUseQualificationSession,
} from "./browser-use-qualification-session";
import { SEALED_ARTIFACT_NAME } from "./browser-use-qualification-wrapper";

const SHA256 = /^[a-f0-9]{64}$/;

const QUALIFICATION_FORBIDDEN_CHILD_ENVIRONMENT_KEYS = [
	"OP_SERVICE_ACCOUNT_TOKEN",
	"OP_CONNECT_HOST",
	"OP_CONNECT_TOKEN",
	"BROWSER_USE_TOKEN",
	"BROWSER_USE_OP_TOKEN",
] as const;

type BrowserConnectWarmChromeMain = Awaited<
	ReturnType<
		(typeof import("@side-quest/browser-connect/cli"))["createProductionDeps"]
	>
>["warmChromeMain"];

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function flag(argv: readonly string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

function manifestDigest(value: Record<string, unknown>): string {
	const body = { ...value };
	delete body.manifest_digest;
	return sha256(JSON.stringify(body));
}

function refusal(
	code: string,
	data?: Readonly<Record<string, string>>,
): number {
	process.stdout.write(
		`${JSON.stringify({
			status: "error",
			...(data === undefined ? {} : { data }),
			error: {
				code,
				exit_code: 20,
				message: "The sealed Browser Use qualification runtime was not admitted.",
			},
		})}\n`,
	);
	return 20;
}

export type QualificationHandoffMintFailureStage =
	| "producer-exit-nonzero"
	| "producer-stderr-nonempty"
	| "handoff-envelope-invalid"
	| "handoff-not-verified"
	| "adapter-mismatch"
	| "run-mismatch"
	| "probe-executable-mismatch";

export type QualificationHandoffCommandPhase =
	| "version"
	| "attachment"
	| "release"
	| "inventory"
	| "browser-connect-gate";

export function qualificationHandoffCommandPhase(
	args: readonly string[],
): Exclude<QualificationHandoffCommandPhase, "browser-connect-gate"> {
	if (args.includes("--version")) return "version";
	if (args.includes("cdp-url")) return "attachment";
	if (args.includes("close")) return "release";
	return "inventory";
}

export function qualificationHandoffMintFailureStage(input: {
	exitCode: number;
	stderrNonempty: boolean;
	parsed: boolean;
	verified: boolean;
	adapterMatches: boolean;
	runMatches: boolean;
	probeExecutableMatches: boolean;
}): QualificationHandoffMintFailureStage | undefined {
	if (input.exitCode !== 0) return "producer-exit-nonzero";
	if (input.stderrNonempty) return "producer-stderr-nonempty";
	if (!input.parsed) return "handoff-envelope-invalid";
	if (!input.verified) return "handoff-not-verified";
	if (!input.adapterMatches) return "adapter-mismatch";
	if (!input.runMatches) return "run-mismatch";
	if (!input.probeExecutableMatches) return "probe-executable-mismatch";
	return undefined;
}

type AdmittedAgentBrowser = {
	handoffPath: string;
	handoffRaw: string;
	agentLogicalPath: string;
	agentCopyPath: string;
	supervisorCopyPath: string;
};

export type QualificationHandoffCommandFailureReason =
	| "command-not-admitted"
	| "ambient-op-environment"
	| "invalid-arguments"
	| "descriptor-exec-input-invalid"
	| "descriptor-exec-identity-mismatch"
	| "descriptor-exec-spawn-failed"
	| "descriptor-exec-wait-failed"
	| "child-timeout"
	| "child-exit-nonzero";

export type QualificationHandoffCommandOutputClass =
	| "version-output-valid"
	| "permission-denied"
	| "argument-invalid"
	| "runtime-resolution-failed"
	| "silent"
	| "unclassified";

const DESCRIPTOR_EXEC_FAILURE_REASONS = [
	"ambient-op-environment",
	"invalid-arguments",
	"descriptor-exec-input-invalid",
	"descriptor-exec-identity-mismatch",
	"descriptor-exec-spawn-failed",
	"descriptor-exec-wait-failed",
] as const;

export function qualificationHandoffCommandFailureReason(input: {
	commandAdmitted: boolean;
	exitCode: number;
	timedOut: boolean;
	stdout: string;
	stderr: string;
}): QualificationHandoffCommandFailureReason | undefined {
	if (!input.commandAdmitted) return "command-not-admitted";
	if (input.timedOut) return "child-timeout";
	if (input.exitCode === 0) return undefined;
	const output = `${input.stdout}\n${input.stderr}`;
	return (
		DESCRIPTOR_EXEC_FAILURE_REASONS.find((code) => output.includes(code)) ??
		"child-exit-nonzero"
	);
}

export function qualificationHandoffCommandOutputClass(input: {
	phase: QualificationHandoffCommandPhase;
	stdout: string;
	stderr: string;
}): QualificationHandoffCommandOutputClass {
	if (
		input.phase === "version" &&
		/^agent-browser\s+\d+\.\d+\.\d+\s*$/u.test(input.stdout) &&
		input.stderr === ""
	) return "version-output-valid";
	const output = `${input.stdout}\n${input.stderr}`.toLowerCase();
	if (output.trim() === "") return "silent";
	if (output.includes("permission denied") || output.includes("operation not permitted")) {
		return "permission-denied";
	}
	if (output.includes("unknown option") || output.includes("invalid argument")) {
		return "argument-invalid";
	}
	if (
		output.includes("module not found") ||
		output.includes("script not found") ||
		output.includes("no such file")
	) return "runtime-resolution-failed";
	return "unclassified";
}

export function qualificationHandoffChildEnvironment(
	base: Readonly<Record<string, string | undefined>>,
	command: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
	const child = Object.fromEntries(
		Object.entries({ ...base, ...command }).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);
	for (const key of QUALIFICATION_FORBIDDEN_CHILD_ENVIRONMENT_KEYS) {
		delete child[key];
	}
	return child;
}

async function readProcessResult(child: ReturnType<typeof spawn>, timeoutMs: number) {
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, timeoutMs);
	const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
		child.once("error", rejectExit);
		child.once("close", (code) => resolveExit(code ?? 20));
	});
	clearTimeout(timer);
	return {
		exitCode,
		stdout: Buffer.concat(stdout).toString("utf8"),
		stderr: Buffer.concat(stderr).toString("utf8"),
		timedOut,
	};
}

async function validateAgentBrowserIdentity(
	argv: readonly string[],
	manifest: Record<string, unknown>,
internal: {
	supervisorCopyPath?: string;
	agentCopyPath?: string;
	agentLogicalPath?: string;
	agentInstallLockCopyPath?: string;
	handoffCopyPath?: string;
	handoffLogicalPath?: string;
	producerReceiptCopyPath?: string;
},
expectedManifestDigest: string,
sealedArtifactSha256: string,
): Promise<AdmittedAgentBrowser | undefined> {
	if (argv[0] === "qualification") return undefined;
	const handoffPath = flag(argv, "--handoff");
	if (
		!handoffPath ||
		internal.handoffLogicalPath !== handoffPath ||
		!internal.handoffCopyPath ||
		!internal.producerReceiptCopyPath ||
		!internal.agentCopyPath ||
		!internal.agentLogicalPath ||
		!internal.agentInstallLockCopyPath ||
		!internal.supervisorCopyPath
	) return undefined;
	const handoffRaw = await readFile(internal.handoffCopyPath, "utf8");
	const parsed = parseHandoffFacts(handoffRaw);
	if (!parsed.ok || parsed.kind !== "verified" || parsed.facts.adapter !== "agent-browser") {
		return undefined;
	}
	const expected = record(manifest.agent_browser);
	if (
		typeof expected?.executable_realpath !== "string" ||
		typeof expected.executable_sha256 !== "string" ||
		typeof expected.install_lock_realpath !== "string" ||
		typeof expected.install_lock_sha256 !== "string"
	) return undefined;
	try {
		if (
			parsed.facts.probeExecutable !== expected.executable_realpath ||
			internal.agentLogicalPath !== expected.executable_realpath ||
			sha256(await readFile(internal.agentCopyPath)) !== expected.executable_sha256 ||
			sha256(await readFile(internal.agentInstallLockCopyPath)) !==
				expected.install_lock_sha256
		) return undefined;
		const producer = record(JSON.parse(await readFile(internal.producerReceiptCopyPath, "utf8")));
		const producerData = record(producer?.data);
		const producerIdentity = record(producerData?.producer_identity);
		const closure = record(manifest.execution_closure);
		const browserConnect = record(manifest.browser_connect);
		const warmChrome = record(manifest.warm_chrome);
		if (
			producer?.status !== "ok" ||
			producerData?.contract !== "browser-use.qualification-handoff-producer" ||
			producerData.schema_version !== "1" ||
			producerData.command !== "qualification-handoff" ||
			producerData.producer !== "browser-connect" ||
			producerData.adapter !== "agent-browser" ||
			producerData.run_id !== parsed.facts.runId ||
			producerData.handoff_sha256 !== sha256(handoffRaw) ||
			producerData.handoff_evidence_id !== parsed.facts.handoffEvidenceId ||
			producerData.browser_authority_id !== browserAuthorityIdOf(parsed.facts) ||
			producerData.expected_manifest_digest !== expectedManifestDigest ||
			producerData.observed_manifest_digest !== expectedManifestDigest ||
			producerData.sealed_artifact_sha256 !== sealedArtifactSha256 ||
			producerIdentity?.execution_closure_sha256 !== closure?.bundle_sha256 ||
			producerIdentity?.browser_connect_sha256 !== browserConnect?.content_sha256 ||
			producerIdentity?.warm_chrome_sha256 !== warmChrome?.content_sha256
		) return undefined;
		return {
			handoffPath,
			handoffRaw,
			agentLogicalPath: internal.agentLogicalPath,
			agentCopyPath: internal.agentCopyPath,
			supervisorCopyPath: internal.supervisorCopyPath,
		};
	} catch {
		return undefined;
	}
}

async function runAdmittedAgentBrowser(
	admitted: AdmittedAgentBrowser,
	input: {
		command: string;
		args: readonly string[];
		timeoutMs: number;
		env?: Record<string, string | undefined>;
	},
): Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	qualificationFailureReason?: QualificationHandoffCommandFailureReason;
	qualificationFailureOutputClass?: QualificationHandoffCommandOutputClass;
	qualificationFailureStdoutBytes?: string;
	qualificationFailureStderrBytes?: string;
}> {
	if (input.command !== admitted.agentLogicalPath) {
		return {
			exitCode: 20,
			stdout: "",
			stderr: "qualification command was not admitted",
			timedOut: false,
			qualificationFailureReason: "command-not-admitted",
		};
	}
	const handle = await open(
		admitted.agentCopyPath,
		constants.O_RDONLY | constants.O_NOFOLLOW,
	);
	try {
		const stat = await handle.stat();
		const digest = sha256(await readFile(admitted.agentCopyPath));
		const child = spawn(
			admitted.supervisorCopyPath,
			[
				"descriptor-exec",
				"--executable-fd", "3",
				"--expected-dev", String(stat.dev),
				"--expected-ino", String(stat.ino),
				"--expected-size", String(stat.size),
				"--expected-sha256", digest,
				"--",
				admitted.agentLogicalPath,
				...input.args,
			],
			{
				stdio: ["ignore", "pipe", "pipe", handle.fd],
				env: qualificationHandoffChildEnvironment(process.env, input.env),
			},
		);
		const result = await readProcessResult(child, input.timeoutMs);
		const qualificationFailureReason =
			qualificationHandoffCommandFailureReason({
				commandAdmitted: true,
				...result,
			});
		const failurePhase = qualificationHandoffCommandPhase(input.args);
		return {
			...result,
			...(qualificationFailureReason === undefined
				? {}
				: {
						qualificationFailureReason,
						qualificationFailureOutputClass:
							qualificationHandoffCommandOutputClass({
								phase: failurePhase,
								stdout: result.stdout,
								stderr: result.stderr,
							}),
						qualificationFailureStdoutBytes: String(
							Buffer.byteLength(result.stdout),
						),
						qualificationFailureStderrBytes: String(
							Buffer.byteLength(result.stderr),
						),
					}),
		};
	} finally {
		await handle.close();
	}
}

function writer() {
	const chunks: string[] = [];
	return {
		port: {
			write: (value: string) => {
				chunks.push(value);
				return true;
			},
		},
		text: () => chunks.join(""),
	};
}

async function mintBrowserConnectHandoff(input: {
	runId: string;
	agent: AdmittedAgentBrowser;
	warmChromeMain?: BrowserConnectWarmChromeMain;
}): Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
	failurePhase?: QualificationHandoffCommandPhase;
	failureReason?: QualificationHandoffCommandFailureReason;
	failureOutputClass?: QualificationHandoffCommandOutputClass;
	failureStdoutBytes?: string;
	failureStderrBytes?: string;
}> {
	const cli = await import("@side-quest/browser-connect/cli");
	const stdout = writer();
	const stderr = writer();
	const deps = await cli.createProductionDeps();
	let failurePhase: QualificationHandoffCommandPhase | undefined;
	let failureReason: QualificationHandoffCommandFailureReason | undefined;
	let failureOutputClass: QualificationHandoffCommandOutputClass | undefined;
	let failureStdoutBytes: string | undefined;
	let failureStderrBytes: string | undefined;
	const exitCode = await cli.main(
		["connect", "agent-browser", "--run-id", input.runId, "--json"],
		{
			...deps,
			...(input.warmChromeMain === undefined
				? {}
				: { warmChromeMain: input.warmChromeMain }),
			stdout: stdout.port,
			stderr: stderr.port,
			adapterRuntime: {
				env: { ...process.env },
				resolveExecutable: (command: string) =>
					command === "agent-browser"
						? { resolved: true as const, path: input.agent.agentLogicalPath }
						: { resolved: false as const },
				runCommand: async (command) => {
					const result = await runAdmittedAgentBrowser(input.agent, {
						command: command.command,
						args: command.args,
						timeoutMs: command.timeoutMs,
						env: command.env,
					});
					if (
						failurePhase === undefined &&
						(result.exitCode !== 0 || result.timedOut)
					) {
						failurePhase = qualificationHandoffCommandPhase(command.args);
						failureReason = result.qualificationFailureReason;
						failureOutputClass = result.qualificationFailureOutputClass;
						failureStdoutBytes = result.qualificationFailureStdoutBytes;
						failureStderrBytes = result.qualificationFailureStderrBytes;
					}
					return result;
				},
			},
		},
	);
	return {
		exitCode,
		stdout: stdout.text(),
		stderr: stderr.text(),
		...(exitCode !== 0
			? {
					failurePhase: failurePhase ?? "browser-connect-gate",
					...(failureReason === undefined ? {} : { failureReason }),
					...(failureOutputClass === undefined
						? {}
						: { failureOutputClass }),
					...(failureStdoutBytes === undefined
						? {}
						: { failureStdoutBytes }),
					...(failureStderrBytes === undefined
						? {}
						: { failureStderrBytes }),
				}
			: {}),
	};
}

function browserFreeWarmChromeFixture(
	manifest: Record<string, unknown>,
): BrowserConnectWarmChromeMain | undefined {
	const fixture = record(manifest.qualification_test_fixture);
	if (
		fixture?.id !== "browser-use.browser-free-warm-chrome-fixture-v1" ||
		fixture.qualification_eligible !== false ||
		typeof fixture.endpoint !== "string" ||
		typeof fixture.web_socket_debugger_url !== "string"
	) return undefined;
	return async (argv, deps = {}) => {
		const runId = flag(argv, "--run-id") ?? "qualification-browser-free-fixture";
		deps.stdout?.write(`${JSON.stringify({
			status: "ok",
			run_id: runId,
			data: {
				contract_id: "warm-chrome.browser-entry",
				schema_version: "1",
				endpoint: fixture.endpoint,
				web_socket_debugger_url: fixture.web_socket_debugger_url,
			},
		})}\n`);
		return 0;
	};
}

export async function produceSealedQualificationHandoff(input: {
	argv: readonly string[];
	manifest: Record<string, unknown>;
	expectedManifestDigest: string;
	sealedArtifactSha256: string;
	agent: AdmittedAgentBrowser;
	mint?: typeof mintBrowserConnectHandoff;
	writeReceipt?: (raw: string) => void;
}): Promise<number> {
	const runId = flag(input.argv, "--run-id");
	const outputPath = flag(input.argv, "--output");
	if (!runId || !outputPath || !isAbsolute(outputPath)) {
		return refusal("qualification_handoff_producer_input_invalid");
	}
	const parent = await realpath(dirname(outputPath)).catch(() => undefined);
	const parentStat = parent ? await lstat(parent).catch(() => undefined) : undefined;
	if (
		!parent ||
		!parentStat?.isDirectory() ||
		parentStat.isSymbolicLink() ||
		(parentStat.mode & 0o777) !== 0o700 ||
		resolve(dirname(outputPath)) !== parent ||
		resolve(outputPath) !== outputPath ||
		(await lstat(outputPath).catch(() => undefined)) !== undefined ||
		(await lstat(`${outputPath}.producer.json`).catch(() => undefined)) !== undefined
	) return refusal("qualification_handoff_producer_input_invalid");
	const minted = await (input.mint ?? mintBrowserConnectHandoff)({
		runId,
		agent: input.agent,
	});
	const parsed = parseHandoffFacts(minted.stdout);
	const verified = parsed.ok && parsed.kind === "verified" ? parsed : undefined;
	const failureStage = qualificationHandoffMintFailureStage({
		exitCode: minted.exitCode,
		stderrNonempty: minted.stderr !== "",
		parsed: parsed.ok,
		verified: verified !== undefined,
		adapterMatches: verified?.facts.adapter === "agent-browser",
		runMatches: verified?.facts.runId === runId,
		probeExecutableMatches:
			verified?.facts.probeExecutable === input.agent.agentLogicalPath,
	});
	if (failureStage !== undefined) {
		return refusal("qualification_handoff_producer_failed", {
			failure_stage: failureStage,
			...(minted.failurePhase === undefined
				? {}
				: { failure_phase: minted.failurePhase }),
			...(minted.failureReason === undefined
				? {}
				: { failure_reason: minted.failureReason }),
			...(minted.failureOutputClass === undefined
				? {}
				: { failure_output_class: minted.failureOutputClass }),
			...(minted.failureStdoutBytes === undefined
				? {}
				: { failure_stdout_bytes: minted.failureStdoutBytes }),
			...(minted.failureStderrBytes === undefined
				? {}
				: { failure_stderr_bytes: minted.failureStderrBytes }),
		});
	}
	const facts = verified?.facts;
	if (facts === undefined) {
		return refusal("qualification_handoff_producer_failed", {
			failure_stage: "handoff-envelope-invalid",
		});
	}
	const closure = record(input.manifest.execution_closure);
	const browserConnect = record(input.manifest.browser_connect);
	const warmChrome = record(input.manifest.warm_chrome);
	const receipt = {
		status: "ok",
		data: {
			contract: "browser-use.qualification-handoff-producer",
			schema_version: "1",
			command: "qualification-handoff",
			producer: "browser-connect",
			adapter: "agent-browser",
			run_id: runId,
			handoff_sha256: sha256(minted.stdout),
			handoff_evidence_id: facts.handoffEvidenceId,
			browser_authority_id: browserAuthorityIdOf(facts),
			expected_manifest_digest: input.expectedManifestDigest,
			observed_manifest_digest: input.expectedManifestDigest,
			sealed_artifact_sha256: input.sealedArtifactSha256,
			producer_identity: {
				execution_closure_sha256: closure?.bundle_sha256,
				browser_connect_sha256: browserConnect?.content_sha256,
				warm_chrome_sha256: warmChrome?.content_sha256,
			},
		},
	};
	try {
		await writeFile(outputPath, minted.stdout, { flag: "wx", mode: 0o600 });
		await chmod(outputPath, 0o600);
		await writeFile(`${outputPath}.producer.json`, `${JSON.stringify(receipt)}\n`, {
			flag: "wx",
			mode: 0o600,
		});
		await chmod(`${outputPath}.producer.json`, 0o600);
	} catch {
		await unlink(outputPath).catch(() => undefined);
		await unlink(`${outputPath}.producer.json`).catch(() => undefined);
		return refusal("qualification_handoff_producer_write_failed");
	}
	(input.writeReceipt ?? ((raw) => process.stdout.write(raw)))(
		`${JSON.stringify(receipt)}\n`,
	);
	return 0;
}

function sessionWriter() {
	const chunks: string[] = [];
	return {
		port: {
			write: (value: string) => {
				chunks.push(value);
				return true;
			},
		},
		text: () => chunks.join(""),
	};
}

function observedQualificationReceipt(input: {
	raw: string;
	runId: string;
	handoffEvidenceId: string;
}): string | undefined {
	const parsed =
		parseBrowserOperationQualificationReceipt(input.raw) ??
		parseBrowserTargetTopologyQualificationReceipt(input.raw);
	if (
		!parsed ||
		parsed.receipt.run_id !== input.runId ||
		parsed.binding.outer_run_id !== input.runId ||
		parsed.binding.run_id !== input.runId ||
		parsed.binding.handoff_evidence_id !== input.handoffEvidenceId
	) return undefined;
	return input.raw;
}

function capturedReceiptEvidence(input: {
	evidence: Record<string, unknown>;
	authority: BrowserUseQualificationSessionAuthority;
}):
	| { ok: true; evidence: Record<string, unknown>; consumed: number }
	| { ok: false; code: string } {
	if (!Array.isArray(input.evidence.runs) || input.evidence.runs.length === 0) {
		return { ok: false, code: "qualification_evidence_invalid" };
	}
	let consumed = 0;
	const runs: Record<string, unknown>[] = [];
	for (const rawRun of input.evidence.runs) {
		const run = record(rawRun);
		const receiptCapabilities = Array.isArray(run?.receipt_capabilities)
			? run.receipt_capabilities.map((value) => record(value))
			: undefined;
		if (
			!run ||
			"receipt_raws" in run ||
			"receipt_capability_handles" in run ||
			typeof run.run_id !== "string" ||
			typeof run.handoff_capability_handle !== "string" ||
			!receiptCapabilities ||
			receiptCapabilities.length === 0 ||
			receiptCapabilities.some(
				(value) =>
					!value ||
					Object.keys(value).sort().join(",") !== "handle,request_id" ||
					typeof value.handle !== "string" ||
					typeof value.request_id !== "string",
			)
		) {
			return { ok: false, code: "qualification_receipt_capability_invalid" };
		}
		const resolved = input.authority.consumeReceipts({
			receiptCapabilities: receiptCapabilities as Array<{
				handle: string;
				request_id: string;
			}>,
			handoffHandle: run.handoff_capability_handle,
			runId: run.run_id,
		});
		if (!resolved.ok) return resolved;
		consumed += resolved.raws.length;
		const admitted = { ...run };
		delete admitted.receipt_capabilities;
		admitted.receipt_raws = resolved.raws;
		runs.push(admitted);
	}
	const counts = input.authority.receiptCounts();
	if (counts.admitted === 0 || counts.consumed !== counts.admitted) {
		return { ok: false, code: "qualification_receipt_capability_unconsumed" };
	}
	return { ok: true, consumed, evidence: { ...input.evidence, runs } };
}

async function runSealedQualificationSession(input: {
	manifest: Record<string, unknown>;
	expectedManifestDigest: string;
	sealedArtifactSha256: string;
	agent: AdmittedAgentBrowser;
	runtime: Awaited<ReturnType<typeof createProductionBrowserUseRuntimeInternal>>;
}): Promise<number> {
	const authority = new BrowserUseQualificationSessionAuthority();
	const handoffPaths = new Map<string, string>();
	const state = {
		handoffMinted: false,
		receiptProducingRequests: 0,
		validatedReceipts: 0,
		validationSucceeded: false,
		validationAttempted: false,
		finalCustodyChecked: false,
		cleanupConfirmed: false,
		requestFailed: false,
	};
	const terminalState = () => ({
		handoff_minted: state.handoffMinted,
		required_requests_completed:
			state.receiptProducingRequests > 0 &&
			state.validatedReceipts === state.receiptProducingRequests,
		validation_succeeded: state.validationSucceeded,
		validation_attempted: state.validationAttempted,
		final_custody_checked: state.finalCustodyChecked,
		cleanup_confirmed: state.cleanupConfirmed,
		request_failed: state.requestFailed,
	});
	const complete = () =>
		state.handoffMinted &&
		state.receiptProducingRequests > 0 &&
		state.validatedReceipts === state.receiptProducingRequests &&
		state.validationSucceeded &&
		state.finalCustodyChecked &&
		state.cleanupConfirmed &&
		!state.requestFailed;
	const writeSessionError = (requestId: string, code: string) => {
		process.stdout.write(`${JSON.stringify({
			status: "error",
			request_id: requestId,
			data: {
				contract: BROWSER_USE_QUALIFICATION_SESSION_RESULT_CONTRACT_ID,
				schema_version: BROWSER_USE_QUALIFICATION_SESSION_RESULT_SCHEMA_VERSION,
				command: "terminal",
				session_state: terminalState(),
			},
			error: { code, exit_code: 20 },
		})}\n`);
	};
	const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			let request: Record<string, unknown> | undefined;
			try {
				request = record(JSON.parse(line));
			} catch {
				request = undefined;
			}
			const requestId = typeof request?.request_id === "string" ? request.request_id : "invalid";
			if (
				request?.contract !== BROWSER_USE_QUALIFICATION_SESSION_REQUEST_CONTRACT_ID ||
				request.schema_version !== BROWSER_USE_QUALIFICATION_SESSION_REQUEST_SCHEMA_VERSION
			) {
				state.requestFailed = true;
				process.stdout.write(`${JSON.stringify({ status: "error", request_id: requestId, error: { code: "qualification_session_request_invalid", exit_code: 20 } })}\n`);
				continue;
			}
			if (state.validationAttempted && request.command !== "close") {
				state.requestFailed = true;
				writeSessionError(requestId, "qualification_session_terminal");
				continue;
			}
			if (request.command === "close") {
				if (!complete()) {
					writeSessionError(requestId, "qualification_session_incomplete");
					return 20;
				}
				process.stdout.write(`${JSON.stringify({ status: "ok", request_id: requestId, data: { contract: BROWSER_USE_QUALIFICATION_SESSION_RESULT_CONTRACT_ID, schema_version: BROWSER_USE_QUALIFICATION_SESSION_RESULT_SCHEMA_VERSION, command: "close", session_state: terminalState(), threat_model: input.manifest.threat_model } })}\n`);
				return 0;
			}
			if (request.command === "validate") {
				state.validationAttempted = true;
			}
			if (request.command === "mint-handoff" && typeof request.run_id === "string") {
				const minted = await mintBrowserConnectHandoff({
					runId: request.run_id,
					agent: input.agent,
					warmChromeMain: browserFreeWarmChromeFixture(input.manifest),
				});
				const parsed = minted.exitCode === 0 ? parseHandoffFacts(minted.stdout) : undefined;
				if (!parsed?.ok || parsed.kind !== "verified" || parsed.facts.runId !== request.run_id) {
					state.requestFailed = true;
					process.stdout.write(`${JSON.stringify({ status: "error", request_id: requestId, error: { code: "qualification_handoff_producer_failed", exit_code: 20 } })}\n`);
					continue;
				}
				const closure = record(input.manifest.execution_closure);
				const browserConnect = record(input.manifest.browser_connect);
				const warmChrome = record(input.manifest.warm_chrome);
				const producerReceipt = JSON.stringify({ status: "ok", data: {
					contract: "browser-use.qualification-handoff-producer", schema_version: "1",
					command: "qualification-handoff", producer: "browser-connect", adapter: "agent-browser",
					run_id: request.run_id, handoff_sha256: sha256(minted.stdout),
					handoff_evidence_id: parsed.facts.handoffEvidenceId,
					browser_authority_id: browserAuthorityIdOf(parsed.facts),
					expected_manifest_digest: input.expectedManifestDigest,
					observed_manifest_digest: input.expectedManifestDigest,
					sealed_artifact_sha256: input.sealedArtifactSha256,
					producer_identity: {
						execution_closure_sha256: closure?.bundle_sha256,
						browser_connect_sha256: browserConnect?.content_sha256,
						warm_chrome_sha256: warmChrome?.content_sha256,
					},
				} });
				const handle = authority.admitHandoff({
					runId: request.run_id,
					raw: minted.stdout,
					producerReceiptRaw: producerReceipt,
				});
				const virtualPath = `/browser-use-sealed-session/${authority.session_id}/${handle}.json`;
				handoffPaths.set(handle, virtualPath);
				state.handoffMinted = true;
				process.stdout.write(`${JSON.stringify({ status: "ok", request_id: requestId, data: {
					contract: BROWSER_USE_QUALIFICATION_SESSION_RESULT_CONTRACT_ID, schema_version: BROWSER_USE_QUALIFICATION_SESSION_RESULT_SCHEMA_VERSION,
					command: "mint-handoff", session_id: authority.session_id,
					handoff_capability_handle: handle, run_id: request.run_id,
					handoff_sha256: sha256(minted.stdout), handoff_evidence_id: parsed.facts.handoffEvidenceId,
					producer_receipt: JSON.parse(producerReceipt), threat_model: input.manifest.threat_model,
				} })}\n`);
				continue;
			}
			if (
				request.command === "validate" &&
				typeof request.expected_manifest_digest === "string" &&
				record(request.evidence)
			) {
				const admittedEvidence = capturedReceiptEvidence({
					evidence: record(request.evidence) as Record<string, unknown>,
					authority,
				});
				if (!admittedEvidence.ok) {
					state.requestFailed = true;
					writeSessionError(requestId, admittedEvidence.code);
					continue;
				}
				const manifestAdmission = await validateBrowserUseQualificationManifest(
					input.manifest,
					request.expected_manifest_digest,
				);
				const observedFinalCustody = manifestAdmission.ok
					? await captureBrowserUseQualificationCustodyInventory({
							fs: input.runtime.platformFs,
							env: input.runtime.env,
							runCommand: input.runtime.runCommand,
							clock: input.runtime.now,
						})
					: undefined;
				const validated = !manifestAdmission.ok
					? manifestAdmission
					: observedFinalCustody === undefined
					? {
							ok: false as const,
							code: "qualification_custody_inventory_unavailable",
							message: "Browser Use could not exhaustively read the canonical custody roots.",
						}
					: await validateBrowserUseQualificationEvidence({
							manifest: input.manifest,
							evidence: admittedEvidence.evidence,
							expectedManifestDigest: request.expected_manifest_digest,
							observedFinalCustody,
							sessionAuthority: authority,
						});
				state.finalCustodyChecked = observedFinalCustody !== undefined;
				if (validated.ok) {
					state.validationSucceeded = true;
					state.validatedReceipts = admittedEvidence.consumed;
					state.cleanupConfirmed = true;
				} else {
					state.requestFailed = true;
				}
				process.stdout.write(`${JSON.stringify(validated.ok
					? {
							status: "ok",
							request_id: requestId,
							data: {
								contract: BROWSER_USE_QUALIFICATION_SESSION_RESULT_CONTRACT_ID,
								schema_version: BROWSER_USE_QUALIFICATION_SESSION_RESULT_SCHEMA_VERSION,
								command: "validate",
								...validated,
							},
						}
					: {
							status: "error",
							request_id: requestId,
							error: { code: validated.code, message: validated.message, exit_code: 20 },
						})}\n`);
				continue;
			}
			if (
				request.command === "execute" &&
				typeof request.handoff_capability_handle === "string" &&
				Array.isArray(request.argv) &&
				request.argv.every((value) => typeof value === "string")
			) {
				const handle = request.handoff_capability_handle;
				const runId = typeof request.run_id === "string" ? request.run_id : "";
				const raw = authority.resolveHandoff(handle, runId);
				const liveHandoff = authority.resolveHandoffCapability(handle, runId);
				const virtualPath = handoffPaths.get(handle);
				if (!raw || !liveHandoff || !virtualPath || request.argv.includes("--handoff")) {
					state.requestFailed = true;
					process.stdout.write(`${JSON.stringify({ status: "error", request_id: requestId, error: { code: "qualification_handoff_capability_not_live", exit_code: 20 } })}\n`);
					continue;
				}
				const stdout = sessionWriter();
				const stderr = sessionWriter();
				const runtime = { ...input.runtime, readTextFile: async (path: string) =>
					path === virtualPath ? raw : await input.runtime.readTextFile(path) };
				const fixture = record(input.manifest.qualification_test_fixture);
				const fixtureOutputs = record(fixture?.session_execute_stdout_by_request_id);
				const fixtureOutput =
					fixture?.id === "browser-use.browser-free-warm-chrome-fixture-v1" &&
					fixture.qualification_eligible === false &&
					typeof fixtureOutputs?.[requestId] === "string"
						? String(fixtureOutputs[requestId])
						: undefined;
				let exitCode: number;
				if (fixtureOutput === undefined) {
					exitCode = await withBrowserUseQualificationSession(authority, async () =>
						await runBrowserUseCli(
							[...(request.argv as string[]), "--handoff", virtualPath],
							{ runtime, stdout: stdout.port, stderr: stderr.port },
						),
					);
				} else {
					stdout.port.write(fixtureOutput);
					exitCode = 0;
				}
				const parsedHandoff = parseHandoffFacts(liveHandoff.raw);
				const receiptRaw =
					exitCode === 0 && parsedHandoff.ok && parsedHandoff.kind === "verified"
						? observedQualificationReceipt({
								raw: stdout.text(),
								runId,
								handoffEvidenceId: parsedHandoff.facts.handoffEvidenceId,
							})
						: undefined;
				if (exitCode !== 0 || !receiptRaw) {
					state.requestFailed = true;
					writeSessionError(
						requestId,
						exitCode === 0
							? "qualification_execute_receipt_invalid"
							: "qualification_execute_failed",
					);
					continue;
				}
				let receiptHandle: string;
				try {
					receiptHandle = authority.admitReceipt({
						handoffHandle: handle,
						runId,
						requestId,
						raw: receiptRaw,
					});
				} catch (error) {
					state.requestFailed = true;
					writeSessionError(
						requestId,
						error instanceof Error &&
							error.message === "qualification_receipt_capability_duplicate"
							? error.message
							: "qualification_execute_receipt_invalid",
					);
					continue;
				}
				state.receiptProducingRequests += 1;
				process.stdout.write(`${JSON.stringify({ status: "ok", request_id: requestId, data: {
					contract: BROWSER_USE_QUALIFICATION_SESSION_RESULT_CONTRACT_ID, schema_version: BROWSER_USE_QUALIFICATION_SESSION_RESULT_SCHEMA_VERSION, command: "execute",
					exit_code: exitCode,
					receipt_capability: { handle: receiptHandle, request_id: requestId },
					threat_model: input.manifest.threat_model,
				} })}\n`);
				continue;
			}
			state.requestFailed = true;
			process.stdout.write(`${JSON.stringify({ status: "error", request_id: requestId, error: { code: "qualification_session_request_invalid", exit_code: 20 } })}\n`);
		}
		writeSessionError("eof", "qualification_session_incomplete");
		return 20;
	} finally {
		authority.close();
		lines.close();
	}
}

async function main(argv: readonly string[]): Promise<number> {
	const verifyFd = Number(flag(argv, "--sealed-artifact-verify-fd"));
	const execFd = Number(flag(argv, "--sealed-artifact-exec-fd"));
	const manifestFd = Number(flag(argv, "--sealed-manifest-fd"));
	const expectedManifestDigest = flag(argv, "--expected-manifest-digest");
	const expectedDev = Number(flag(argv, "--sealed-artifact-dev"));
	const expectedIno = Number(flag(argv, "--sealed-artifact-ino"));
	const expectedSize = Number(flag(argv, "--sealed-artifact-size"));
	const sizeIndex = argv.indexOf("--sealed-artifact-size");
	const childArgvIndex = argv.indexOf("--sealed-child-argv");
	if (
		!Number.isSafeInteger(execFd) ||
		!Number.isSafeInteger(verifyFd) ||
		!Number.isSafeInteger(manifestFd) ||
		!SHA256.test(expectedManifestDigest ?? "") ||
		!Number.isSafeInteger(expectedDev) ||
		!Number.isSafeInteger(expectedIno) ||
		!Number.isSafeInteger(expectedSize) ||
		sizeIndex < 0 ||
		childArgvIndex < 0 ||
		childArgvIndex + 1 >= argv.length
	) return refusal("qualification_bundle_input_invalid");
	const exactManifestDigest = expectedManifestDigest;
	if (!exactManifestDigest) return refusal("qualification_bundle_input_invalid");
	const executing = fstatSync(execFd);
	const verifying = fstatSync(verifyFd);
	if (
		!executing.isFile() ||
		!verifying.isFile() ||
		executing.dev !== expectedDev ||
		executing.ino !== expectedIno ||
		executing.size !== expectedSize ||
		verifying.dev !== expectedDev ||
		verifying.ino !== expectedIno ||
		verifying.size !== expectedSize
	) return refusal("qualification_bundle_file_changed");
	const artifactBytes = readFileSync(verifyFd);
	const manifestRaw = readFileSync(manifestFd, "utf8");
	let manifest: Record<string, unknown> | undefined;
	try {
		manifest = record(JSON.parse(manifestRaw));
	} catch {
		return refusal("qualification_manifest_mismatch");
	}
	const sealed = record(manifest?.sealed_runtime);
	if (
		!manifest ||
		manifest.manifest_digest !== expectedManifestDigest ||
		manifestDigest(manifest) !== expectedManifestDigest ||
		sealed?.artifact_name !== SEALED_ARTIFACT_NAME ||
		sealed?.artifact_sha256 !== sha256(artifactBytes)
	) return refusal("qualification_manifest_mismatch");
	const nativeSupervisor = record(manifest.native_supervisor);
	if (typeof nativeSupervisor?.resolved_executable_realpath !== "string") {
		return refusal("qualification_manifest_mismatch");
	}
	const childArgv = argv.slice(childArgvIndex + 1);
	const internal = {
		supervisorCopyPath: flag(argv, "--sealed-supervisor-copy-path"),
		agentCopyPath: flag(argv, "--sealed-agent-browser-copy-path"),
		agentLogicalPath: flag(argv, "--sealed-agent-browser-logical-path"),
		agentInstallLockCopyPath: flag(
			argv,
			"--sealed-agent-browser-install-lock-copy-path",
		),
		handoffCopyPath: flag(argv, "--sealed-handoff-copy-path"),
		handoffLogicalPath: flag(argv, "--sealed-handoff-logical-path"),
		producerReceiptCopyPath: flag(argv, "--sealed-producer-receipt-copy-path"),
	};
	if (!internal.supervisorCopyPath) return refusal("qualification_manifest_mismatch");
	process.env.BROWSER_USE_QUALIFICATION_SUPERVISOR_PATH = internal.supervisorCopyPath;
	let admittedAgent = await validateAgentBrowserIdentity(
		childArgv,
		manifest,
		internal,
		exactManifestDigest,
		String(sealed.artifact_sha256),
	);
	if (
		childArgv[0] === "qualification" &&
		(childArgv[1] === "handoff" || childArgv[1] === "session") &&
		!admittedAgent
	) {
		const expected = record(manifest.agent_browser);
		if (
			!internal.agentCopyPath ||
			!internal.agentLogicalPath ||
			!internal.agentInstallLockCopyPath ||
			!internal.supervisorCopyPath ||
			internal.agentLogicalPath !== expected?.executable_realpath ||
			sha256(await readFile(internal.agentCopyPath)) !== expected.executable_sha256 ||
			sha256(await readFile(internal.agentInstallLockCopyPath)) !== expected.install_lock_sha256
		) return refusal("qualification_agent_browser_identity_mismatch");
		admittedAgent = {
			handoffPath: "",
			handoffRaw: "",
			agentLogicalPath: internal.agentLogicalPath,
			agentCopyPath: internal.agentCopyPath,
			supervisorCopyPath: internal.supervisorCopyPath,
		};
	}
	if (childArgv[0] !== "qualification" && !admittedAgent) {
		return refusal("qualification_agent_browser_identity_mismatch");
	}
	if (childArgv[0] === "qualification" && childArgv[1] === "handoff") {
		return admittedAgent
			? await produceSealedQualificationHandoff({
					argv: childArgv,
					manifest,
					expectedManifestDigest: exactManifestDigest,
					sealedArtifactSha256: String(sealed.artifact_sha256),
					agent: admittedAgent,
				})
			: refusal("qualification_agent_browser_identity_mismatch");
	}
	const runtime = await createProductionBrowserUseRuntimeInternal({
		env: { ...process.env },
		readTextFile: async (path) =>
			admittedAgent && path === admittedAgent.handoffPath
				? admittedAgent.handoffRaw
				: await readFile(path, "utf8"),
		runCommand: async (command) => {
			if (admittedAgent && command.command === admittedAgent.agentLogicalPath) {
				return await runAdmittedAgentBrowser(admittedAgent, command);
			}
			if (command.command === internal.supervisorCopyPath) {
				const supervisorCopyPath = internal.supervisorCopyPath;
				if (!supervisorCopyPath) {
					return { exitCode: 20, stdout: "", stderr: "qualification supervisor was not admitted", timedOut: false };
				}
				return await readProcessResult(
					spawn(supervisorCopyPath, command.args, {
						stdio: ["ignore", "pipe", "pipe"],
					}),
					command.timeoutMs,
				);
			}
			return { exitCode: 20, stdout: "", stderr: "qualification command was not admitted", timedOut: false };
		},
	});
	if (childArgv[0] === "qualification" && childArgv[1] === "session") {
		return admittedAgent
			? await withSealedQualificationRuntimeEvidence(
					{
						contract: BROWSER_USE_QUALIFICATION_RUNTIME_EVIDENCE_CONTRACT_ID,
						schema_version: BROWSER_USE_QUALIFICATION_RUNTIME_EVIDENCE_SCHEMA_VERSION,
						expected_manifest_digest: expectedManifestDigest,
						observed_manifest_digest: expectedManifestDigest,
						sealed_artifact_sha256: String(sealed.artifact_sha256),
					},
					manifest,
					async () =>
						await runSealedQualificationSession({
							manifest,
							expectedManifestDigest: exactManifestDigest,
							sealedArtifactSha256: String(sealed.artifact_sha256),
							agent: admittedAgent,
							runtime,
						}),
				)
			: refusal("qualification_agent_browser_identity_mismatch");
	}
	return await withSealedQualificationRuntimeEvidence(
		{
			contract: BROWSER_USE_QUALIFICATION_RUNTIME_EVIDENCE_CONTRACT_ID,
			schema_version: BROWSER_USE_QUALIFICATION_RUNTIME_EVIDENCE_SCHEMA_VERSION,
			expected_manifest_digest: expectedManifestDigest,
			observed_manifest_digest: expectedManifestDigest,
			sealed_artifact_sha256: String(sealed.artifact_sha256),
		},
		manifest,
		async () => await runBrowserUseCli(childArgv, { runtime }),
	);
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
