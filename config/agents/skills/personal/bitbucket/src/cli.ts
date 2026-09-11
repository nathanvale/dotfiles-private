#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { COMMANDS, findCommand, renderHelp, type CommandDefinition } from "./command-contract";
import { resolveRepository, type BitbucketRepository } from "./git-remote";
import { analyzeOpenApiDrift, BITBUCKET_OPENAPI_URL, type OpenApiBaseline, type OpenApiDriftAnalysis } from "./openapi-drift";

const API_BASE_URL = "https://api.bitbucket.org/2.0";
const DEFAULT_OPENAPI_BASELINE = fileURLToPath(new URL("../openapi-baseline.json", import.meta.url));
const BUNDLED_OPENAPI_BASELINE_SHA256 = "afe837be0a2af93e7d17f7def9ede36a39539f2052672454ab4e4c7f77e95b9d";
const ENVELOPE_CONTRACT_ID = "bitbucket.result";
const ENVELOPE_SCHEMA_VERSION = "1";
const VALID_STATES = ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"] as const;
const VALID_STRATEGIES = ["squash", "merge_commit", "fast_forward"] as const;
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);

type RetrySafety = "same_input_safe" | "same_input_unsafe" | "inspect_before_retry";

export interface CliIo {
	stdout: (text: string) => void;
	stderr: (text: string) => void;
}

export type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export interface CliDependencies {
	fetcher: FetchLike;
	environment: Record<string, string | undefined>;
	cwd: string;
	io: CliIo;
	runId: string;
	openApiBaselinePath: string;
	openApiBaselineSha256: string;
}

interface ParsedInput {
	command: CommandDefinition;
	positionals: string[];
	flags: Map<string, string | true>;
	repositoryOverride: { workspace?: string; repo?: string };
}

interface ApiRequest {
	path: string;
	method?: string;
	body?: unknown;
	accept?: string;
	contentType?: string;
	headers?: Record<string, string>;
	previewBody?: unknown;
}

interface RequestContext {
	input: ParsedInput;
	base: string;
	id: () => number;
	limit: () => number;
}

type RequestBuilder = (context: RequestContext) => ApiRequest;

interface CommandResult {
	changed_state: "none" | "preview" | "complete";
	data: unknown;
	next_safe_action: string;
	retry_safety: RetrySafety;
	effect: "read" | "write";
	status?: "ok" | "attention";
	exitCode?: number;
	remediationClass?: "none" | "maintenance_review" | "approval_required" | "untrusted_baseline";
}

/** Provenance state for a baseline used by the drift doctor. */
export interface BaselineProvenance {
	/** Whether the artifact is the reviewed bundle, a modified bundle, or a custom diagnostic input. */
	trust: "bundled_verified" | "bundled_unverified" | "custom_untrusted";
	/** Stable reason for automation and repair guidance. */
	reason: "reviewed_digest_match" | "reviewed_digest_mismatch" | "custom_path";
}

/**
 * Bind drift escalation authority to reviewed baseline bytes rather than a pathname alone.
 *
 * @param input - Candidate path, reviewed path, bytes, and reviewed digest
 * @returns Provenance state used to allow or suppress owner escalation
 *
 * @example
 * ```ts
 * assessBaselineProvenance({ baselinePath, defaultBaselinePath, baselineContent, expectedSha256 })
 * ```
 */
export function assessBaselineProvenance(input: {
	baselinePath: string;
	defaultBaselinePath: string;
	baselineContent: string;
	expectedSha256: string;
}): BaselineProvenance {
	if (resolve(input.baselinePath) !== resolve(input.defaultBaselinePath)) return { trust: "custom_untrusted", reason: "custom_path" };
	const digest = createHash("sha256").update(input.baselineContent).digest("hex");
	return digest === input.expectedSha256
		? { trust: "bundled_verified", reason: "reviewed_digest_match" }
		: { trust: "bundled_unverified", reason: "reviewed_digest_mismatch" };
}

class CliError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly nextSafeAction: string,
		readonly retrySafety: RetrySafety = "same_input_safe",
		readonly retryAfterSeconds?: number,
		readonly maximumAttempts?: number,
	) {
		super(message);
	}
}

function buildErrorEnvelope(runId: string, cliError: CliError, exitCode: number): Record<string, unknown> {
	return {
		contract_id: ENVELOPE_CONTRACT_ID,
		schema_version: ENVELOPE_SCHEMA_VERSION,
		status: "error",
		run_id: runId,
		error: { code: cliError.code, message: cliError.message },
		retry_safety: cliError.retrySafety,
		next_safe_action: cliError.nextSafeAction,
		exit_code: exitCode,
		...(cliError.retryAfterSeconds === undefined ? {} : { retry_after_seconds: cliError.retryAfterSeconds }),
		...(cliError.maximumAttempts === undefined ? {} : { maximum_attempts: cliError.maximumAttempts }),
	};
}

async function runDoctorCommand(input: ParsedInput, dependencies: CliDependencies): Promise<number> {
	const response = await diagnoseOpenApi(input, dependencies);
	dependencies.io.stdout(JSON.stringify(successEnvelope(dependencies.runId, input.command, BITBUCKET_OPENAPI_URL, response)));
	return response.exitCode ?? 0;
}

async function runOperationsCommand(input: ParsedInput, dependencies: CliDependencies): Promise<number> {
	const response = await discoverOperations(input, dependencies);
	dependencies.io.stdout(JSON.stringify(successEnvelope(dependencies.runId, input.command, BITBUCKET_OPENAPI_URL, response)));
	return 0;
}

async function runApiCommand(input: ParsedInput, authHeader: string, dependencies: CliDependencies): Promise<number> {
	const response = await executeCommand(input, undefined, authHeader, dependencies);
	const target = `${API_BASE_URL}${normalizeApiPath(input.positionals[0])}`;
	dependencies.io.stdout(JSON.stringify(successEnvelope(dependencies.runId, input.command, target, response)));
	return 0;
}

async function resolveTargetRepository(input: ParsedInput, dependencies: CliDependencies): Promise<BitbucketRepository> {
	return resolveRepository({
		...input.repositoryOverride,
		environment: dependencies.environment,
		cwd: dependencies.cwd,
	}).catch((error: unknown) => {
		throw new CliError(
			"repository_unresolved",
			error instanceof Error ? error.message : String(error),
			"Run inside the intended Bitbucket clone, or pass --workspace and --repo together.",
		);
	});
}

async function runRepositoryCommand(input: ParsedInput, authHeader: string, dependencies: CliDependencies): Promise<number> {
	const repository = await resolveTargetRepository(input, dependencies);
	const response = await executeCommand(input, repository, authHeader, dependencies);
	dependencies.io.stdout(JSON.stringify(successEnvelope(dependencies.runId, input.command, `${repository.workspace}/${repository.repo}`, response)));
	return 0;
}

async function dispatchCliCommand(argv: string[], dependencies: CliDependencies): Promise<number> {
	const frontDoor = handleFrontDoor(argv, dependencies.io);
	if (frontDoor !== null) return frontDoor;

	const input = parseInput(argv);
	if (input.command.name === "doctor") return runDoctorCommand(input, dependencies);
	if (input.command.name === "operations") return runOperationsCommand(input, dependencies);

	const authHeader = resolveAuthHeader(dependencies.environment);
	if (input.command.name === "api") return runApiCommand(input, authHeader, dependencies);

	return runRepositoryCommand(input, authHeader, dependencies);
}

/** Run the public bb CLI with injectable boundaries for focused proof. */
export async function runCli(
	argv: string[],
	overrides: Partial<CliDependencies> = {},
): Promise<number> {
	const dependencies: CliDependencies = {
		fetcher: overrides.fetcher ?? fetch,
		environment: overrides.environment ?? process.env,
		cwd: overrides.cwd ?? process.cwd(),
		io: overrides.io ?? {
			stdout: (text) => console.log(text),
			stderr: (text) => console.error(text),
		},
		runId: overrides.runId ?? randomUUID(),
		openApiBaselinePath: overrides.openApiBaselinePath ?? DEFAULT_OPENAPI_BASELINE,
		openApiBaselineSha256: overrides.openApiBaselineSha256 ?? BUNDLED_OPENAPI_BASELINE_SHA256,
	};

	try {
		return await dispatchCliCommand(argv, dependencies);
	} catch (error: unknown) {
		const cliError = normalizeError(error);
		const exitCode = cliError.code === "usage_error" || cliError.code === "unknown_command" ? 2 : 1;
		dependencies.io.stderr(JSON.stringify(buildErrorEnvelope(dependencies.runId, cliError, exitCode)));
		return exitCode;
	}
}

function handleHelpCommand(argv: string[], io: CliIo): number {
	if (argv.length > 2) {
		io.stderr("Usage: bb help [command]");
		return 2;
	}
	const command = argv[1];
	if (command && !findCommand(command)) {
		io.stderr(renderHelp(command));
		return 2;
	}
	io.stdout(renderHelp(command));
	return 0;
}

function handleCommandsCommand(argv: string[], io: CliIo): number {
	if (argv.length !== 2 || argv[1] !== "--json") {
		io.stderr("Usage: bb commands --json");
		return 2;
	}
	io.stdout(JSON.stringify({
		contract_id: "bitbucket.commands",
		schema_version: "1",
		commands: COMMANDS,
	}));
	return 0;
}

function handleInlineHelpFlag(argv: string[], io: CliIo): number {
	const command = argv[0];
	if (argv.length !== 2) {
		io.stderr(`Usage: bb ${command} --help`);
		return 2;
	}
	if (!findCommand(command)) {
		io.stderr(renderHelp(command));
		return 2;
	}
	io.stdout(renderHelp(command));
	return 0;
}

function handleFrontDoor(argv: string[], io: CliIo): number | null {
	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
		io.stdout(renderHelp());
		return 0;
	}
	if (argv[0] === "help") return handleHelpCommand(argv, io);
	if (argv[0] === "commands") return handleCommandsCommand(argv, io);
	if (argv.includes("--help") || argv.includes("-h")) return handleInlineHelpFlag(argv, io);
	return null;
}

const VALUE_FLAGS = new Set([
	"--state", "--limit", "--max-chars", "--text", "--path", "--line",
	"--comment-id", "--strategy", "--title", "--source", "--destination",
	"--description", "--workspace", "--repo", "--query", "--method",
	"--body-json", "--body", "--body-file", "--headers-json", "--accept",
	"--content-type", "--baseline-file", "--cursor", "--body-sha256",
]);
const BOOLEAN_FLAGS = new Set(["--execute", "--close-source-branch"]);

function consumeValueFlagToken(
	command: CommandDefinition,
	flags: Map<string, string | true>,
	token: string,
	argv: string[],
	index: number,
): number {
	if (!command.flags.includes(token)) throw usage(`Flag ${token} is not supported by ${command.name}.`);
	if (flags.has(token)) throw usage(`Flag ${token} cannot be repeated.`);
	const value = argv[index + 1];
	if (!value || value.startsWith("--")) throw usage(`Flag ${token} requires a value.`);
	flags.set(token, value);
	return index + 1;
}

function consumeBooleanFlagToken(
	command: CommandDefinition,
	flags: Map<string, string | true>,
	token: string,
	index: number,
): number {
	if (!command.flags.includes(token)) throw usage(`Flag ${token} is not supported by ${command.name}.`);
	if (flags.has(token)) throw usage(`Flag ${token} cannot be repeated.`);
	flags.set(token, true);
	return index;
}

function consumeArgumentToken(
	command: CommandDefinition,
	flags: Map<string, string | true>,
	positionals: string[],
	argv: string[],
	index: number,
): number {
	const token = argv[index];
	if (VALUE_FLAGS.has(token)) return consumeValueFlagToken(command, flags, token, argv, index);
	if (BOOLEAN_FLAGS.has(token)) return consumeBooleanFlagToken(command, flags, token, index);
	if (token.startsWith("--")) throw usage(`Unknown flag: ${token}`);
	positionals.push(token);
	return index;
}

function parseInput(argv: string[]): ParsedInput {
	const command = findCommand(argv[0]);
	if (!command) throw new CliError("unknown_command", `Unknown command: ${argv[0]}`, "Run bb --help or bb commands --json.");
	const positionals: string[] = [];
	const flags = new Map<string, string | true>();

	for (let index = 1; index < argv.length; index += 1) {
		index = consumeArgumentToken(command, flags, positionals, argv, index);
	}
	if (positionals.length < command.positionals.minimum || positionals.length > command.positionals.maximum) {
		throw usage(`Command ${command.name} accepts ${describePositionalCount(command.positionals.minimum, command.positionals.maximum)}.`);
	}

	return {
		command,
		positionals,
		flags,
		repositoryOverride: {
			workspace: stringFlag(flags, "--workspace"),
			repo: stringFlag(flags, "--repo"),
		},
	};
}

function describePositionalCount(minimum: number, maximum: number): string {
	if (minimum === maximum) return `${minimum} positional argument${minimum === 1 ? "" : "s"}`;
	return `${minimum} through ${maximum} positional arguments`;
}

function resolveAuthHeader(environment: Record<string, string | undefined>): string {
	const email = environment.BITBUCKET_EMAIL ?? environment.BITBUCKET_USER ?? environment.BB_USERNAME;
	const token = environment.BITBUCKET_API_TOKEN ?? environment.BITBUCKET_TOKEN ?? environment.BB_TOKEN;
	const accessToken = environment.BITBUCKET_ACCESS_TOKEN ?? environment.BB_ACCESS_TOKEN;
	const jwt = environment.BITBUCKET_JWT ?? environment.BB_JWT;
	const modes = [token, accessToken, jwt].filter((value) => Boolean(value));
	if (modes.length > 1) {
		throw new CliError(
			"auth_ambiguous",
			"Multiple Bitbucket credential modes are present.",
			"Invoke bb with exactly one credential mode: API token, access token, or JWT.",
		);
	}
	if (accessToken) return `Bearer ${accessToken}`;
	if (jwt) return `JWT ${jwt}`;
	if (!email || !token) {
		throw new CliError(
			"auth_missing",
			"Bitbucket credentials are required.",
			"Invoke bb through the credential wrapper you already use. Run bb --help for accepted variable names.",
		);
	}
	return `Basic ${btoa(`${email}:${token}`)}`;
}

async function executeCommand(
	input: ParsedInput,
	repository: BitbucketRepository | undefined,
	authHeader: string,
	dependencies: CliDependencies,
): Promise<CommandResult> {
	const maximumCharacters = input.command.name === "diff" || input.command.name === "api"
		? boundedInteger(stringFlag(input.flags, "--max-chars") ?? "50000", "max chars", 1000, 500000)
		: undefined;
	const request = buildRequest(input, repository);
	const effect = resolveEffect(input);
	const execute = input.flags.has("--execute");
	if (effect === "write" && !execute) {
		return {
			changed_state: "preview",
			data: { target: `${API_BASE_URL}${request.path}`, command: input.command.name, request: sanitizePreview(request) },
			next_safe_action: "Obtain explicit approval for this exact preview, then rerun with --execute.",
			retry_safety: "same_input_safe",
			effect,
		};
	}

	let data = await callApi(request, authHeader, dependencies.fetcher, effect);
	data = redactSensitiveValues(data);
	if (maximumCharacters !== undefined && typeof data === "string") {
		data = {
			format: input.command.name === "diff" ? "diff" : "text",
			content: data.slice(0, maximumCharacters),
			truncated: data.length > maximumCharacters,
			original_characters: data.length,
		};
	}
	return {
		changed_state: effect === "write" ? "complete" : "none",
		data,
		next_safe_action: effect === "write" ? "Inspect the affected Bitbucket resource and confirm the intended state." : nextReadAction(input.command.name),
		retry_safety: effect === "write" ? "same_input_unsafe" : "same_input_safe",
		effect,
	};
}

function buildRequest(input: ParsedInput, repository: BitbucketRepository | undefined): ApiRequest {
	if (input.command.name === "api") return buildGenericApiRequest(input);
	if (!repository) throw new CliError("repository_unresolved", "This command requires repository coordinates.", "Run inside the intended Bitbucket clone, or pass --workspace and --repo together.");
	const base = `/repositories/${encodeURIComponent(repository.workspace)}/${encodeURIComponent(repository.repo)}`;
	const id = () => requirePositiveInteger(input.positionals[0], "pull-request id");
	const limit = () => boundedInteger(stringFlag(input.flags, "--limit") ?? "50", "limit", 1, 100);
	const builder = REQUEST_BUILDERS[input.command.name];
	if (!builder) {
		throw new CliError("unknown_command", `No runtime handler for ${input.command.name}.`, "Run bb commands --json and report command drift.");
	}
	return builder({ input, base, id, limit });
}

function resolveGenericRequestBody(
	input: ParsedInput,
	contentType: string | undefined,
): { body: unknown; previewBody: unknown; contentType: string | undefined } {
	const jsonBody = stringFlag(input.flags, "--body-json");
	const textBody = stringFlag(input.flags, "--body");
	const bodyFile = stringFlag(input.flags, "--body-file");
	if (jsonBody) {
		let body: unknown;
		try {
			body = JSON.parse(jsonBody);
		} catch {
			throw usage("--body-json must contain valid JSON.");
		}
		const previewBody = { source: "inline_json", redacted: redactSensitiveValues(body) };
		return { body, previewBody, contentType: contentType ?? "application/json" };
	}
	if (textBody !== undefined) {
		return { body: textBody, previewBody: { source: "inline_text" }, contentType: contentType ?? "text/plain" };
	}
	if (bodyFile) {
		if (!existsSync(bodyFile)) throw usage(`Body file does not exist: ${bodyFile}`);
		const bytes = readFileSync(bodyFile);
		const previewBody = { source: "file", path: bodyFile, bytes: bytes.byteLength };
		return { body: bytes, previewBody, contentType: contentType ?? (Bun.file(bodyFile).type || "application/octet-stream") };
	}
	return { body: undefined, previewBody: undefined, contentType };
}

function validateGenericRequestBodyDigest(input: ParsedInput, body: unknown, previewBody: unknown): unknown {
	const approvedDigest = stringFlag(input.flags, "--body-sha256");
	if (body === undefined && approvedDigest) throw usage("--body-sha256 is valid only when a request body is present.");
	if (body === undefined) return previewBody;
	const digest = requestBodyDigest(body);
	const updatedPreview = { ...(previewBody as Record<string, unknown>), sha256: digest };
	if (input.flags.has("--execute") && !approvedDigest) throw usage("Generic body execution requires --body-sha256 from the approved preview.");
	if (approvedDigest && approvedDigest.toLowerCase() !== digest) throw usage("--body-sha256 does not match the current request-body bytes.");
	return updatedPreview;
}

function buildGenericApiRequest(input: ParsedInput): ApiRequest {
	const path = normalizeApiPath(input.positionals[0]);
	const method = (stringFlag(input.flags, "--method") ?? "GET").toUpperCase();
	if (!HTTP_METHODS.has(method)) throw usage(`Method must be one of: ${[...HTTP_METHODS].join(", ")}.`);

	const bodyFlags = ["--body-json", "--body", "--body-file"].filter((name) => input.flags.has(name));
	if (bodyFlags.length > 1) throw usage("Use only one of --body-json, --body, or --body-file.");

	const initialContentType = stringFlag(input.flags, "--content-type");
	const { body, previewBody: resolvedPreview, contentType } = resolveGenericRequestBody(input, initialContentType);
	const previewBody = validateGenericRequestBodyDigest(input, body, resolvedPreview);

	return {
		path,
		method,
		body,
		previewBody,
		accept: stringFlag(input.flags, "--accept"),
		contentType,
		headers: parseHeaders(input.flags),
	};
}

function normalizeApiPath(value: string | undefined): string {
	if (!value) throw usage("Missing Bitbucket API path.");
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith("//") || value.includes("\\")) throw usage("Pass a relative Bitbucket REST v2 path, not a URL.");
	const path = value.startsWith("/") ? value : `/${value}`;
	const pathname = path.split("?", 1)[0];
	if (pathname.split("/").some((segment) => segment === ".." || decodeURIComponentSafe(segment) === "..")) throw usage("API paths cannot traverse parent segments.");
	return path;
}

function decodeURIComponentSafe(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		throw usage("API path contains invalid percent encoding.");
	}
}

function parseHeaders(flags: Map<string, string | true>): Record<string, string> | undefined {
	const raw = stringFlag(flags, "--headers-json");
	if (!raw) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw usage("--headers-json must contain a JSON object.");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw usage("--headers-json must contain a JSON object.");
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(parsed)) {
		if (isCredentialHeader(name) || ["host", "content-length"].includes(name.toLowerCase())) throw usage(`Header cannot be overridden: ${name}`);
		if (typeof value !== "string") throw usage(`Header value must be a string: ${name}`);
		headers[name] = value;
	}
	return headers;
}

function resolveEffect(input: ParsedInput): "read" | "write" {
	if (input.command.effect !== "dynamic") return input.command.effect;
	const method = (stringFlag(input.flags, "--method") ?? "GET").toUpperCase();
	return READ_METHODS.has(method) ? "read" : "write";
}

function loadOpenApiBaseline(baselinePath: string): { baseline: OpenApiBaseline; baselineContent: string } {
	if (!existsSync(baselinePath)) {
		throw new CliError("openapi_baseline_missing", `OpenAPI baseline not found: ${baselinePath}`, "Restore the generated baseline from source control, then rerun the doctor.");
	}
	try {
		const baselineContent = readFileSync(baselinePath, "utf8");
		const baseline = JSON.parse(baselineContent) as OpenApiBaseline;
		return { baseline, baselineContent };
	} catch (error: unknown) {
		throw new CliError("openapi_baseline_invalid", error instanceof Error ? error.message : String(error), "Regenerate and review the OpenAPI baseline, then rerun the doctor.");
	}
}

function analyzeAgainstLiveDocument(document: unknown, baseline: OpenApiBaseline): OpenApiDriftAnalysis {
	try {
		return analyzeOpenApiDrift(document, baseline);
	} catch (error: unknown) {
		throw new CliError("openapi_contract_invalid", error instanceof Error ? error.message : String(error), "Inspect the baseline and live Swagger shape before accepting any contract update.");
	}
}

function buildDriftContinuation(
	breaking: boolean,
	review: boolean,
	provenanceAttention: boolean,
	trustedBaseline: boolean,
	trustedIssueDraft: OpenApiDriftAnalysis["issue_draft"],
): Record<string, unknown> | null {
	if (provenanceAttention) {
		return {
			action: "restore_reviewed_baseline",
			approval_required: false,
			notification_status: "not_allowed",
			help_path: "references/openapi-drift.md",
		};
	}
	if (breaking) {
		if (trustedBaseline && trustedIssueDraft) {
			return {
				action: "review_and_prepare_owner_issue",
				owner_repository: "nathanvale/claude-code-config",
				dedupe_key: trustedIssueDraft.dedupe_key,
				approval_required: true,
				notification_status: "not_sent",
				issue_url: null,
				help_path: "references/openapi-drift.md",
			};
		}
		return {
			action: "restore_reviewed_baseline",
			approval_required: false,
			notification_status: "not_allowed",
			help_path: "references/openapi-drift.md",
		};
	}
	if (review) {
		return {
			action: "review_contract_drift",
			approval_required: false,
			notification_status: "not_required",
			help_path: "references/openapi-drift.md",
		};
	}
	return null;
}

function buildDriftNextSafeAction(
	breaking: boolean,
	provenanceAttention: boolean,
	trustedBaseline: boolean,
	health: OpenApiDriftAnalysis["health"],
): string {
	if (provenanceAttention) return "Follow data.continuation: restore the reviewed bundled baseline before relying on drift results.";
	if (breaking) {
		return trustedBaseline
			? "Follow data.continuation: review the bounded evidence, deduplicate the owner issue, then obtain explicit approval before creation."
			: "Follow data.continuation: restore the reviewed bundled baseline before any escalation.";
	}
	if (health === "additive_drift") return "Review the additive operations during normal maintenance; no owner notification is required.";
	if (health === "review_drift") return "Follow data.continuation and resolve the indeterminate compatibility change before treating the contract as healthy.";
	return "No OpenAPI repair action is required.";
}

function buildDriftRemediationClass(
	breaking: boolean,
	provenanceAttention: boolean,
	trustedBaseline: boolean,
	health: OpenApiDriftAnalysis["health"],
): "none" | "maintenance_review" | "approval_required" | "untrusted_baseline" {
	if (breaking) return trustedBaseline ? "approval_required" : "untrusted_baseline";
	if (provenanceAttention) return "untrusted_baseline";
	return health === "healthy" ? "none" : "maintenance_review";
}

function buildOwnerNotification(breaking: boolean, trustedBaseline: boolean): Record<string, unknown> {
	return breaking
		? { status: "not_sent", reason: trustedBaseline ? "approval_required" : "untrusted_baseline", issue_url: null }
		: { status: "not_required", issue_url: null };
}

async function diagnoseOpenApi(input: ParsedInput, dependencies: CliDependencies): Promise<CommandResult> {
	if (input.positionals.length !== 1 || input.positionals[0] !== "openapi") throw usage("Doctor target must be: openapi.");
	const baselinePath = stringFlag(input.flags, "--baseline-file") ?? dependencies.openApiBaselinePath;
	const { baseline, baselineContent } = loadOpenApiBaseline(baselinePath);

	const document = await fetchOpenApiDocument(dependencies.fetcher);
	const analysis = analyzeAgainstLiveDocument(document, baseline);

	const breaking = analysis.health === "breaking_drift";
	const review = analysis.health === "review_drift";
	const baselineProvenance = assessBaselineProvenance({
		baselinePath,
		defaultBaselinePath: dependencies.openApiBaselinePath,
		baselineContent,
		expectedSha256: dependencies.openApiBaselineSha256,
	});
	const trustedBaseline = baselineProvenance.trust === "bundled_verified";
	const provenanceAttention = baselineProvenance.trust === "bundled_unverified";
	const attention = breaking || review || provenanceAttention;
	const trustedIssueDraft = trustedBaseline ? analysis.issue_draft : null;
	const continuation = buildDriftContinuation(breaking, review, provenanceAttention, trustedBaseline, trustedIssueDraft);

	return {
		status: attention ? "attention" : "ok",
		exitCode: breaking ? 3 : review || provenanceAttention ? 4 : 0,
		changed_state: "none",
		data: {
			...analysis,
			issue_draft: trustedIssueDraft,
			baseline_file: baselinePath,
			baseline_trust: baselineProvenance.trust,
			baseline_trust_reason: baselineProvenance.reason,
			continuation,
			owner_notification: buildOwnerNotification(breaking, trustedBaseline),
		},
		next_safe_action: buildDriftNextSafeAction(breaking, provenanceAttention, trustedBaseline, analysis.health),
		retry_safety: "same_input_safe",
		effect: "read",
		remediationClass: buildDriftRemediationClass(breaking, provenanceAttention, trustedBaseline, analysis.health),
	};
}

function buildOperationRecord(
	method: string,
	path: string,
	operation: { summary?: unknown; tags?: unknown; parameters?: unknown; consumes?: unknown; produces?: unknown },
	pathParameters: Array<Record<string, unknown>>,
	document: { consumes: unknown; produces: unknown },
): Record<string, unknown> {
	const parameters = [...pathParameters, ...summarizeParameters(operation.parameters)];
	return {
		method: method.toUpperCase(),
		path,
		summary: typeof operation.summary === "string" ? operation.summary : "",
		tags: Array.isArray(operation.tags) ? operation.tags.filter((tag): tag is string => typeof tag === "string") : [],
		parameters,
		consumes: stringArray(operation.consumes ?? document.consumes),
		produces: stringArray(operation.produces ?? document.produces),
		body_schema: parameters.find((parameter) => parameter.in === "body")?.schema ?? null,
	};
}

function collectMatchingOperations(
	paths: Record<string, Record<string, unknown>>,
	document: { consumes: unknown; produces: unknown },
	query: string,
): Array<Record<string, unknown>> {
	const operations: Array<Record<string, unknown>> = [];
	for (const [path, pathItem] of Object.entries(paths)) {
		const pathParameters = summarizeParameters(pathItem.parameters);
		for (const [method, value] of Object.entries(pathItem)) {
			if (!HTTP_METHODS.has(method.toUpperCase()) || !value || typeof value !== "object") continue;
			const operation = value as { summary?: unknown; tags?: unknown; parameters?: unknown; consumes?: unknown; produces?: unknown };
			const candidate = `${method} ${path} ${String(operation.summary ?? "")} ${Array.isArray(operation.tags) ? operation.tags.join(" ") : ""}`.toLowerCase();
			if (query && !candidate.includes(query)) continue;
			operations.push(buildOperationRecord(method, path, operation, pathParameters, document));
		}
	}
	return operations;
}

async function discoverOperations(input: ParsedInput, dependencies: CliDependencies): Promise<CommandResult> {
	const document = await fetchOpenApiDocument(dependencies.fetcher) as { swagger?: unknown; basePath?: unknown; consumes?: unknown; produces?: unknown; paths?: Record<string, Record<string, unknown>> };
	if (!document.paths || typeof document.paths !== "object") throw new CliError("openapi_invalid", "The canonical OpenAPI response has no paths object.", "Inspect the canonical OpenAPI URL for a contract change.");

	const queryText = stringFlag(input.flags, "--query") ?? "";
	const query = queryText.toLowerCase();
	const limit = boundedInteger(stringFlag(input.flags, "--limit") ?? "50", "limit", 1, 200);
	const cursor = boundedInteger(stringFlag(input.flags, "--cursor") ?? "0", "cursor", 0, Number.MAX_SAFE_INTEGER);
	const operations = collectMatchingOperations(document.paths, { consumes: document.consumes, produces: document.produces }, query);

	operations.sort((left, right) => `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`));
	const page = operations.slice(cursor, cursor + limit);
	const nextCursor = cursor + page.length < operations.length ? cursor + page.length : null;
	return {
		changed_state: "none",
		data: {
			contract_url: BITBUCKET_OPENAPI_URL,
			swagger: document.swagger,
			base_path: document.basePath,
			matched: operations.length,
			cursor,
			returned: page.length,
			truncated: nextCursor !== null,
			next_cursor: nextCursor,
			next_invocation: nextCursor === null ? null : {
				argv: ["operations", ...(queryText ? ["--query", queryText] : []), "--cursor", String(nextCursor), "--limit", String(limit)],
			},
			operations: page,
		},
		next_safe_action: nextCursor === null
			? "Choose an operation, substitute its path parameters, then run bb api with the documented method and body."
			: "Continue discovery with data.next_invocation.argv, which preserves the active query and page bounds.",
		retry_safety: "same_input_safe",
		effect: "read",
	};
}

async function fetchOpenApiDocument(fetcher: FetchLike): Promise<unknown> {
	let response: Response;
	try {
		response = await fetcher(BITBUCKET_OPENAPI_URL, { signal: AbortSignal.timeout(30_000) });
	} catch (error: unknown) {
		throw new CliError("openapi_unavailable", error instanceof Error ? error.message : String(error), "Retry once, then inspect Atlassian service health and the canonical OpenAPI URL.");
	}
	if (!response.ok) throw new CliError("openapi_unavailable", `OpenAPI request failed with HTTP ${response.status}.`, "Retry once, then inspect Atlassian service health and the canonical OpenAPI URL.");
	try {
		return await response.json();
	} catch (error: unknown) {
		throw new CliError("openapi_invalid", error instanceof Error ? error.message : String(error), "Inspect the canonical OpenAPI URL for a malformed or changed contract.");
	}
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function summarizeParameters(value: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(value)) return [];
	return value.flatMap((parameter) => {
		if (!parameter || typeof parameter !== "object") return [];
		const item = parameter as Record<string, unknown>;
		return [{ name: item.name, in: item.in, required: item.required === true, type: item.type, schema: item.schema }];
	});
}

const repositoryRequest: RequestBuilder = ({ base }) => ({ path: base });
const pullRequestResource = (suffix = ""): RequestBuilder => ({ base, id }) => ({ path: `${base}/pullrequests/${id()}${suffix}` });
const pagedPullRequestResource = (suffix: string): RequestBuilder => ({ base, id, limit }) => ({ path: `${base}/pullrequests/${id()}${suffix}?pagelen=${limit()}` });

const REQUEST_BUILDERS: Record<string, RequestBuilder> = {
	status: repositoryRequest,
	repo: repositoryRequest,
	list: ({ input, base }) => {
		const state = (stringFlag(input.flags, "--state") ?? "OPEN").toUpperCase();
		if (!VALID_STATES.includes(state as (typeof VALID_STATES)[number])) throw usage(`State must be one of: ${VALID_STATES.join(", ")}.`);
		const listLimit = boundedInteger(stringFlag(input.flags, "--limit") ?? "25", "limit", 1, 100);
		return { path: `${base}/pullrequests?state=${state}&pagelen=${listLimit}` };
	},
	view: pullRequestResource(),
	diff: ({ base, id }) => ({ path: `${base}/pullrequests/${id()}/diff`, accept: "text/plain" }),
	diffstat: pagedPullRequestResource("/diffstat"),
	comments: pagedPullRequestResource("/comments"),
	activity: pagedPullRequestResource("/activity"),
	checks: pagedPullRequestResource("/statuses"),
	comment: ({ input, base, id }) => ({
		path: `${base}/pullrequests/${id()}/comments`,
		method: "POST",
		body: { content: { raw: requiredFlag(input.flags, "--text") } },
	}),
	"inline-comment": ({ input, base, id }) => ({
		path: `${base}/pullrequests/${id()}/comments`,
		method: "POST",
		body: {
			content: { raw: requiredFlag(input.flags, "--text") },
			inline: { path: requiredFlag(input.flags, "--path"), to: boundedInteger(requiredFlag(input.flags, "--line"), "line", 1, Number.MAX_SAFE_INTEGER) },
		},
	}),
	reply: ({ input, base, id }) => ({
		path: `${base}/pullrequests/${id()}/comments`,
		method: "POST",
		body: {
			content: { raw: requiredFlag(input.flags, "--text") },
			parent: { id: boundedInteger(requiredFlag(input.flags, "--comment-id"), "comment id", 1, Number.MAX_SAFE_INTEGER) },
		},
	}),
	approve: ({ base, id }) => ({ path: `${base}/pullrequests/${id()}/approve`, method: "POST" }),
	unapprove: ({ base, id }) => ({ path: `${base}/pullrequests/${id()}/approve`, method: "DELETE" }),
	merge: ({ input, base, id }) => {
		const strategy = stringFlag(input.flags, "--strategy") ?? "squash";
		if (!VALID_STRATEGIES.includes(strategy as (typeof VALID_STRATEGIES)[number])) throw usage(`Strategy must be one of: ${VALID_STRATEGIES.join(", ")}.`);
		return {
			path: `${base}/pullrequests/${id()}/merge`,
			method: "POST",
			body: { merge_strategy: strategy, close_source_branch: input.flags.has("--close-source-branch") },
		};
	},
	decline: ({ base, id }) => ({ path: `${base}/pullrequests/${id()}/decline`, method: "POST" }),
	create: ({ input, base }) => ({
		path: `${base}/pullrequests`,
		method: "POST",
		body: {
			title: requiredFlag(input.flags, "--title"),
			source: { branch: { name: requiredFlag(input.flags, "--source") } },
			destination: { branch: { name: requiredFlag(input.flags, "--destination") } },
			description: stringFlag(input.flags, "--description") ?? "",
			close_source_branch: input.flags.has("--close-source-branch"),
		},
	}),
	branches: ({ base, limit }) => ({ path: `${base}/refs/branches?pagelen=${limit()}` }),
};

async function sendApiRequest(request: ApiRequest, authHeader: string, fetcher: FetchLike, effect: "read" | "write"): Promise<Response> {
	try {
		return await fetcher(`${API_BASE_URL}${request.path}`, {
			method: request.method ?? "GET",
			headers: {
				...request.headers,
				Authorization: authHeader,
				Accept: request.accept ?? "application/json",
				...(request.body !== undefined ? { "Content-Type": request.contentType ?? "application/json" } : {}),
			},
			body: serializeRequestBody(request.body),
			signal: AbortSignal.timeout(30_000),
		});
	} catch (error: unknown) {
		throw new CliError(
			"network_failure",
			error instanceof Error ? error.message : String(error),
			effect === "write" ? "Inspect the pull request before retrying." : "Check network access, then retry the same read.",
			effect === "write" ? "inspect_before_retry" : "same_input_safe",
		);
	}
}

async function readApiResponseText(response: Response, effect: "read" | "write"): Promise<string> {
	try {
		return await response.text();
	} catch (error: unknown) {
		throw new CliError(
			"network_failure",
			error instanceof Error ? error.message : String(error),
			effect === "write" ? "Inspect the affected Bitbucket resource before retrying." : "Check network access, then retry the same read.",
			effect === "write" ? "inspect_before_retry" : "same_input_safe",
		);
	}
}

function parseApiResponseBody(text: string, response: Response, effect: "read" | "write"): unknown {
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.includes("json") || !text) return text;
	try {
		return JSON.parse(text);
	} catch {
		if (response.ok) {
			throw new CliError(
				"invalid_api_response",
				"Bitbucket returned malformed JSON for a successful response.",
				effect === "write" ? "Inspect the affected Bitbucket resource before retrying." : "Retry once; if it repeats, inspect Bitbucket service health.",
				effect === "write" ? "inspect_before_retry" : "same_input_safe",
			);
		}
		return text;
	}
}

async function callApi(request: ApiRequest, authHeader: string, fetcher: FetchLike, effect: "read" | "write"): Promise<unknown> {
	const response = await sendApiRequest(request, authHeader, fetcher, effect);
	const text = await readApiResponseText(response, effect);
	const body = parseApiResponseBody(text, response, effect);
	if (!response.ok) {
		const classification = classifyHttpError(response.status, effect, response.headers);
		throw new CliError(classification.code, `Bitbucket API ${response.status}: request rejected`, classification.nextSafeAction, classification.retrySafety, classification.retryAfterSeconds, classification.maximumAttempts);
	}
	return body;
}

function serializeRequestBody(body: unknown): BodyInit | undefined {
	if (body === undefined) return undefined;
	if (typeof body === "string" || body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body as BodyInit;
	return JSON.stringify(body);
}

function requestBodyDigest(body: unknown): string {
	const serialized = serializeRequestBody(body);
	if (typeof serialized === "string") return createHash("sha256").update(serialized).digest("hex");
	if (ArrayBuffer.isView(serialized)) return createHash("sha256").update(new Uint8Array(serialized.buffer, serialized.byteOffset, serialized.byteLength)).digest("hex");
	if (serialized instanceof ArrayBuffer) return createHash("sha256").update(new Uint8Array(serialized)).digest("hex");
	throw usage("Request body cannot be bound to a deterministic digest.");
}

type HttpErrorClassification = {
	code: string;
	nextSafeAction: string;
	retrySafety: RetrySafety;
	retryAfterSeconds?: number;
	maximumAttempts?: number;
};

function classifyAuthRejected(): HttpErrorClassification {
	return { code: "auth_rejected", nextSafeAction: "Refresh the process-scoped Bitbucket credentials, then run bb status.", retrySafety: "same_input_safe" };
}

function classifyPermissionDenied(): HttpErrorClassification {
	return { code: "permission_denied", nextSafeAction: "Check API-token scopes and repository access. Do not retry unchanged credentials.", retrySafety: "same_input_safe" };
}

function requestRejectionCode(status: number): string {
	if (status === 404) return "not_found";
	if (status === 405) return "method_not_allowed";
	if (status === 415) return "unsupported_media_type";
	return "request_rejected";
}

function classifyRequestRejected(status: number, effect: "read" | "write", retrySafety: RetrySafety): HttpErrorClassification {
	return {
		code: requestRejectionCode(status),
		nextSafeAction: effect === "write"
			? "Inspect the affected Bitbucket resource first. Then run bb doctor openapi; execute again only after confirming no change and correcting the request."
			: "Run bb doctor openapi. If it is healthy, correct the path, method, content type, or request body before retrying.",
		retrySafety,
	};
}

function classifyRateLimited(effect: "read" | "write", retrySafety: RetrySafety, headers: Headers): HttpErrorClassification {
	const retryAfterSeconds = parseRetryAfter(headers.get("retry-after"));
	return {
		code: "rate_limited",
		nextSafeAction: effect === "write"
			? `Wait ${retryAfterSeconds} seconds, inspect the affected Bitbucket resource, then retry at most once only when no change occurred.`
			: `Wait ${retryAfterSeconds} seconds, then retry at most once. Inspect service health if rate limiting continues.`,
		retrySafety,
		retryAfterSeconds,
		maximumAttempts: 1,
	};
}

function classifyGenericApiFailure(effect: "read" | "write", retrySafety: RetrySafety): HttpErrorClassification {
	return { code: "api_failure", nextSafeAction: effect === "write" ? "Inspect the pull request before retrying." : "Retry once, then inspect Bitbucket service health.", retrySafety };
}

function classifyHttpError(status: number, effect: "read" | "write", headers: Headers): HttpErrorClassification {
	const retrySafety: RetrySafety = effect === "write" ? "inspect_before_retry" : "same_input_safe";
	if (status === 401) return classifyAuthRejected();
	if (status === 403) return classifyPermissionDenied();
	if ([404, 405, 415, 422].includes(status)) return classifyRequestRejected(status, effect, retrySafety);
	if (status === 429) return classifyRateLimited(effect, retrySafety, headers);
	return classifyGenericApiFailure(effect, retrySafety);
}

function parseRetryAfter(value: string | null): number {
	const fallback = 30;
	if (!value) return fallback;
	if (/^\d+$/.test(value)) return Math.min(300, Math.max(1, Number(value)));
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) return fallback;
	return Math.min(300, Math.max(1, Math.ceil((timestamp - Date.now()) / 1000)));
}

function successEnvelope(runId: string, command: CommandDefinition, target: string, result: CommandResult) {
	return {
		contract_id: ENVELOPE_CONTRACT_ID,
		schema_version: ENVELOPE_SCHEMA_VERSION,
		status: result.status ?? "ok",
		run_id: runId,
		command: command.name,
		effect: result.effect,
		target,
		changed_state: result.changed_state,
		data: result.data,
		retry_safety: result.retry_safety,
		next_safe_action: result.next_safe_action,
		exit_code: result.exitCode ?? 0,
		remediation_class: result.remediationClass ?? "none",
	};
}

function sanitizePreview(request: ApiRequest): Record<string, unknown> {
	return {
		path: request.path,
		method: request.method,
		body: request.previewBody ?? request.body,
		accept: request.accept,
		content_type: request.contentType,
		headers: request.headers && Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name, `sha256:${createHash("sha256").update(value).digest("hex")}`])),
	};
}

function isCredentialHeader(name: string): boolean {
	return /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$/i.test(name)
		|| /(secret|credential|access[-_]?token)/i.test(name);
}

function redactSensitiveValues(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactSensitiveValues);
	if (!value || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	const securedValue = record.secured === true || record.is_secured === true;
	return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
		key,
		isSensitiveResponseKey(key) || (securedValue && key === "value") ? "[REDACTED]" : redactSensitiveValues(item),
	]));
}

function isSensitiveResponseKey(key: string): boolean {
	const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
	return ["token", "password", "secret", "credential", "authorization", "cookie", "privatekey", "apikey", "accesstoken", "refreshtoken", "clientsecret"].includes(normalized)
		|| normalized.endsWith("password")
		|| normalized.endsWith("secret")
		|| normalized.endsWith("credential")
		|| normalized.endsWith("token");
}

function requirePositiveInteger(value: string | undefined, label: string): number {
	if (!value) throw usage(`Missing ${label}.`);
	return boundedInteger(value, label, 1, Number.MAX_SAFE_INTEGER);
}

function boundedInteger(value: string, label: string, minimum: number, maximum: number): number {
	if (!/^\d+$/.test(value)) throw usage(`${label} must be an integer.`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw usage(`${label} must be between ${minimum} and ${maximum}.`);
	return parsed;
}

function requiredFlag(flags: Map<string, string | true>, name: string): string {
	const value = stringFlag(flags, name);
	if (!value) throw usage(`Missing required flag: ${name}.`);
	return value;
}

function stringFlag(flags: Map<string, string | true>, name: string): string | undefined {
	const value = flags.get(name);
	return typeof value === "string" ? value : undefined;
}

function usage(message: string): CliError {
	return new CliError("usage_error", message, "Run bb help <command> and correct the invocation.");
}

function normalizeError(error: unknown): CliError {
	if (error instanceof CliError) return error;
	return new CliError("unexpected_failure", error instanceof Error ? error.message : String(error), "Run bb status. If it passes, rerun the read or preview; inspect state before retrying a write.", "inspect_before_retry");
}

function nextReadAction(command: string): string {
	if (command === "list") return "Choose a pull-request identifier and run bb view <id>.";
	if (command === "view") return "Inspect diffstat, checks, comments, or activity for this pull request.";
	if (command === "diffstat") return "Request a bounded diff for files that need inspection.";
	return "Use the returned evidence to choose the next safe read or an approved write preview.";
}

if (import.meta.main) {
	process.exitCode = await runCli(process.argv.slice(2));
}
