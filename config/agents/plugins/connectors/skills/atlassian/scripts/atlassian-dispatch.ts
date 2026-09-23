#!/usr/bin/env bun
// Atlassian dispatcher: one semantic Jira or Confluence operation for one
// tenant, Official by default, explicit Community reads through one Provider,
// every write behind a durable preview and apply journal, and the operator
// path that inspects and adjudicates what the journal holds. Raw
// provider-route is the transport primitive underneath; this module owns the
// safety policy and renders one envelope per invocation.
//
//   atlassian-dispatch --tenant <slug> <read-operation> [--input <json>] [--provider official|community]
//   atlassian-dispatch --tenant <slug> <write-operation> --input <json> --preview [--provider official|community]
//   atlassian-dispatch --tenant <slug> <write-operation> --input <json> --apply <previewId> [--provider official|community]
//   atlassian-dispatch --tenant <slug> receipts
//   atlassian-dispatch --tenant <slug> receipt --run <runId>
//   atlassian-dispatch --tenant <slug> adjudicate --run <runId> --input <json>
//   atlassian-dispatch --tenant <slug> unlock --run <runId>
//   atlassian-dispatch --tenant <slug> parity --operation <read-operation> --input <json>
//   atlassian-dispatch --discover
import { TENANT_PATTERN } from "./custody/index.ts";
import { CAUSES, type CauseCode, type CommandId, COMMANDS, type Envelope, OPERATION_SPECS, OPERATIONS, type OperationSpec, type ProviderName } from "./dispatch/contract.ts";
import { type Dependencies, readInput, REPAIR_TEXT, specFor } from "./dispatch/engine.ts";
import { adjudicateFlow, applyFlow, type Outcome, parityFlow, previewFlow, readFlow, receiptFlow, receiptsFlow, Session, unlockFlow } from "./dispatch/flows.ts";
import { productionDependencies } from "./dispatch/runtime.ts";
import { type WriteInput, writeInput } from "./dispatch/writes.ts";

const VALUE_OPTIONS = ["--tenant", "--provider", "--input", "--apply", "--run", "--operation"] as const;
const FLAG_OPTIONS = ["--preview", "--json", "--discover", "--help"] as const;
type ValueOption = (typeof VALUE_OPTIONS)[number];
type FlagOption = (typeof FLAG_OPTIONS)[number];
const VALUE_SET: ReadonlySet<string> = new Set(VALUE_OPTIONS);
const FLAG_SET: ReadonlySet<string> = new Set(FLAG_OPTIONS);

interface Options {
	values: Partial<Record<ValueOption, string>>;
	flags: Set<FlagOption>;
	path?: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string; cause: "usage-invalid" | "input-invalid" };
const usage = <T>(reason: string): Parsed<T> => ({ ok: false, reason, cause: "usage-invalid" });

// A value option consumes exactly one following non-option token and may
// appear once. Repeats are refused rather than resolved first-wins or
// last-wins, so tenant identity can never split.
function takeValue(options: Options, token: ValueOption, value: string | undefined): string | null {
	if (value === undefined || value.startsWith("--")) return `${token} needs a value`;
	if (token in options.values) return `${token} may appear only once`;
	options.values[token] = value;
	return null;
}

// The single positional token is the operation or command.
function takePositional(options: Options, token: string): string | null {
	if (token.startsWith("-") || options.path !== undefined) return `unexpected argument ${token}`;
	options.path = token;
	return null;
}

function parseOptions(argv: string[]): Parsed<Options> {
	const options: Options = { values: {}, flags: new Set() };
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index] ?? "";
		if (FLAG_SET.has(token)) {
			options.flags.add(token as FlagOption);
			continue;
		}
		const consumesValue = VALUE_SET.has(token);
		const problem = consumesValue ? takeValue(options, token as ValueOption, argv[index + 1]) : takePositional(options, token);
		if (problem !== null) return usage(problem);
		if (consumesValue) index += 1;
	}
	return { ok: true, value: options };
}

export type Mode = { kind: "read" } | { kind: "preview" } | { kind: "apply"; previewId: string } | { kind: "command"; command: CommandId } | { kind: "discover" };

export interface Invocation {
	tenant: string;
	path: string;
	provider: ProviderName | undefined;
	input: unknown;
	mode: Mode;
	runId: string | undefined;
	operation: string | undefined;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const isCommand = (path: string): path is CommandId => (COMMANDS as readonly string[]).includes(path);

// A write needs exactly one of --preview or --apply <previewId>.
function parseWriteMode(path: string, preview: boolean, apply: string | undefined): Parsed<Mode> {
	if (preview && apply !== undefined) return usage("choose --preview or --apply, not both");
	if (preview) return { ok: true, value: { kind: "preview" } };
	if (apply === undefined) return usage(`${path} is a write; add --preview to record a preview or --apply <previewId> to apply one`);
	return IDENTIFIER.test(apply) ? { ok: true, value: { kind: "apply", previewId: apply } } : usage("--apply needs a preview id");
}

function parseMode(options: Options): Parsed<Mode> {
	const path = options.path ?? "";
	const preview = options.flags.has("--preview");
	const apply = options.values["--apply"];
	const writeFlags = preview || apply !== undefined;
	if (isCommand(path)) return writeFlags ? usage(`${path} takes neither --preview nor --apply`) : { ok: true, value: { kind: "command", command: path } };
	const spec = specFor(path);
	if (!spec) return usage(`unknown operation or command; expected one of ${[...OPERATIONS, ...COMMANDS].join(", ")}`);
	if (spec.kind === "write") return parseWriteMode(path, preview, apply);
	return writeFlags ? usage(`${path} is a read; --preview and --apply apply to writes only`) : { ok: true, value: { kind: "read" } };
}

export function parseArgv(argv: string[]): Parsed<Invocation> {
	const parsed = parseOptions(argv);
	if (!parsed.ok) return parsed;
	const options = parsed.value;
	if (options.flags.has("--discover") || options.flags.has("--help")) {
		return { ok: true, value: { tenant: "", path: "discover", provider: undefined, input: {}, mode: { kind: "discover" }, runId: undefined, operation: undefined } };
	}
	const tenant = options.values["--tenant"];
	const provider = options.values["--provider"];
	const runId = options.values["--run"];
	if (!tenant || !TENANT_PATTERN.test(tenant)) return usage("--tenant must be a lowercase tenant slug");
	if (provider !== undefined && provider !== "official" && provider !== "community") return usage("--provider must be official or community");
	if (runId !== undefined && !IDENTIFIER.test(runId)) return usage("--run needs a receipt run id");
	if (options.path === undefined) return usage(`an operation or command is required: ${[...OPERATIONS, ...COMMANDS].join(", ")}`);
	const mode = parseMode(options);
	if (!mode.ok) return mode;
	let input: unknown;
	try {
		input = JSON.parse(options.values["--input"] ?? "{}");
	} catch {
		return { ok: false, reason: "--input must be a JSON object", cause: "input-invalid" };
	}
	return { ok: true, value: { tenant, path: options.path, provider, input, mode: mode.value, runId, operation: options.values["--operation"] } };
}

type EffectClass = Envelope["result"]["effectClass"];

function envelope(identity: string, effectClass: EffectClass, outcome: Outcome, provenance: Envelope["result"]["provenance"]): Envelope {
	const row = CAUSES[outcome.cause];
	const path = identity.replace(/^atlassian\./, "");
	return {
		envelopeVersion: 2,
		contractVersion: "2.0.0",
		message: outcome.cause === "success" ? `${path} succeeded` : `${path} ${row.outcome}: ${outcome.cause}`,
		availablePaths: [...OPERATIONS, ...COMMANDS].map((entry) => `atlassian.${entry}`).sort(),
		result: {
			runId: crypto.randomUUID(),
			commandIdentity: identity,
			outcome: row.outcome,
			effectClass,
			transactionState: outcome.transactionState,
			causeCode: outcome.cause,
			failureClass: row.failureClass,
			exitCode: row.exitCode,
			data: outcome.data,
			retryable: false,
			repairAction: outcome.cause === "success" ? null : outcome.detail,
			effects: { completed: [...outcome.effects].sort(), remaining: [], uncertain: [...outcome.uncertain].sort(), inventoryComplete: outcome.transactionState !== "unknown" },
			nextAction: nextAction(outcome),
			provenance,
		},
	};
}

function nextAction(outcome: Outcome): string {
	if (outcome.transactionState === "unknown") return "run adjudicate --run <result.data.runId> with the same input; never retry the write before it resolves";
	if (outcome.cause === "success") return "use the data";
	return "inspect the cause and provenance before any retry";
}

const refused = (cause: CauseCode, detail: string): Outcome => ({ cause, data: null, detail, transactionState: "unchanged", effects: [], uncertain: [] });

const discovery = (): Outcome => ({
	cause: "success",
	data: {
		contractVersion: "2.0.0",
		operations: Object.values(OPERATION_SPECS).map((spec) => ({ id: spec.id, kind: spec.kind, product: spec.product, official: spec.official, community: spec.community })),
		commands: [...COMMANDS],
		exitMeanings: { 0: "success", 2: "usage refusal", 3: "domain refusal or failure", 4: "schema refusal" },
		writes: "preview with --preview, then --apply <previewId> with the identical input; an unknown outcome blocks the object until adjudicate resolves it",
	},
	detail: null,
	transactionState: "unchanged",
	effects: [],
	uncertain: [],
});

async function commandFlow(session: Session, invocation: Invocation, command: CommandId): Promise<{ identity: string; effectClass: EffectClass; outcome: Outcome }> {
	const identity = `atlassian.${command}`;
	const runId = invocation.runId;
	switch (command) {
		case "receipts":
			return { identity, effectClass: "inspect", outcome: receiptsFlow(session) };
		case "receipt":
			return { identity, effectClass: "inspect", outcome: runId ? receiptFlow(session, runId) : refused("usage-invalid", "receipt needs --run <runId>") };
		case "unlock":
			return { identity, effectClass: "repository-local", outcome: runId ? unlockFlow(session, runId) : refused("usage-invalid", "unlock needs --run <runId>") };
		case "adjudicate":
			return { identity, effectClass: "repository-local", outcome: runId ? await adjudicateFlow(session, runId, invocation.input) : refused("usage-invalid", "adjudicate needs --run <runId> and --input <json>") };
		case "parity": {
			const spec = invocation.operation === undefined ? undefined : specFor(invocation.operation);
			if (!spec || spec.kind !== "read") return { identity, effectClass: "repository-local", outcome: refused("usage-invalid", "parity needs --operation <read-operation>") };
			const validated = readInput(spec.id, invocation.input);
			if (!validated.ok) return { identity, effectClass: "repository-local", outcome: refused("input-invalid", validated.reason) };
			return { identity, effectClass: "repository-local", outcome: await parityFlow(session, spec, validated.input) };
		}
	}
}

async function writeFlow(session: Session, invocation: Invocation, spec: OperationSpec, mode: Extract<Mode, { kind: "preview" | "apply" }>): Promise<Outcome> {
	const validated = writeInput(spec.id as Parameters<typeof writeInput>[0], invocation.input);
	if (!validated.ok) return refused("input-invalid", validated.reason);
	const input: WriteInput = validated.input;
	const provider = invocation.provider ?? "official";
	return mode.kind === "preview" ? previewFlow(session, spec, input, provider) : applyFlow(session, spec, input, provider, mode.previewId);
}

// Dependencies are built once, from the validated tenant, so the transport,
// credential item, and trusted origin share one identity.
export async function run(argv: string[], dependencies: (tenant: string) => Dependencies): Promise<Envelope> {
	const parsed = parseArgv(argv);
	if (!parsed.ok) return envelope("atlassian.unknown", "inspect", refused(parsed.cause, parsed.reason), []);
	const invocation = parsed.value;
	if (invocation.mode.kind === "discover") return envelope("atlassian.discover", "inspect", discovery(), []);
	const session = new Session(dependencies(invocation.tenant), invocation.tenant);
	if (invocation.mode.kind === "command") {
		const result = await commandFlow(session, invocation, invocation.mode.command);
		return envelope(result.identity, result.effectClass, result.outcome, session.provenance);
	}
	const spec = specFor(invocation.path);
	if (!spec) return envelope("atlassian.unknown", "inspect", refused("usage-invalid", REPAIR_TEXT["usage-invalid"]), []);
	if (invocation.mode.kind === "read") {
		const validated = readInput(spec.id, invocation.input);
		const outcome = validated.ok ? await readFlow(session, spec, validated.input, invocation.provider) : refused("input-invalid", validated.reason);
		return envelope(`atlassian.${spec.id}`, "inspect", outcome, session.provenance);
	}
	const outcome = await writeFlow(session, invocation, spec, invocation.mode);
	return envelope(`atlassian.${spec.id}.${invocation.mode.kind}`, invocation.mode.kind === "apply" ? "external" : "repository-local", outcome, session.provenance);
}

if (import.meta.main) {
	const result = await run(process.argv.slice(2), (tenant) => productionDependencies(tenant, process.env));
	process.stdout.write(`${JSON.stringify(result)}\n`);
	process.exit(result.result.exitCode);
}
