#!/usr/bin/env bun
// Compiled Connectors front door (T1, Ticket #88 under Spec #87): a
// discovery-only skeleton. It knows nothing about route selection or any
// Provider: `bin/provider-route.ts` remains the sole owner of that logic
// until a later Ticket folds real commands in here. This file exists only
// so the plugin can ship a compiled macOS arm64 `bin/connectors` executable
// that boots and answers one trivial discovery command with a Contract Core
// 2.0 envelope, standalone, with no ambient Bun, Node, mise, or op required.

const CONTRACT_VERSION = "2.0.0";
const PROGRAM = "connectors";

const EXIT_MEANINGS = { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "transient" } as const;
const SIGNAL_EXITS = { "130": "SIGINT", "143": "SIGTERM" } as const;
// What this T1 skeleton does not do yet. Keep honest: only list an exclusion
// once it is actually true, and drop it in the Ticket that stops excluding it.
const EFFECT_EXCLUSIONS = [
	"any credential or custody access",
	"any dependency install, setup, or MCPorter bootstrap",
	"any provider operation",
	"route selection or dispatch to any Provider (bin/provider-route.ts remains the sole owner)",
] as const;

// Exported: each appears in the exported Envelope's public signature.
export type EffectClass = "inspect";
export type Outcome = "success" | "refused" | "failed";
// INTERNAL_UNEXPECTED_UNCHANGED (not the _UNKNOWN cause), because T1's inspect-only
// surface never attempts an effect: assertEnvelope always runs before the one stdout
// write, so a caught internal failure has zero attempted effects, never an uncertain
// one. Matches the existing Contract Core owner's own unchanged/unknown split.
export type CauseCode = "SUCCESS_UNCHANGED" | "USAGE_UNKNOWN_COMMAND" | "INTERNAL_UNEXPECTED_UNCHANGED";

interface CommandDescriptor {
	readonly commandIdentity: string;
	readonly route: readonly string[];
	readonly effectClass: EffectClass;
	readonly summary: string;
}

// This is the complete T1 command surface: discovery, help, and the refusal
// station dispatch falls into on anything else. Later Tickets grow this list;
// do not add a route here without also implementing it, so discovery never
// advertises a command this binary cannot actually answer.
const COMMANDS: readonly CommandDescriptor[] = [
	{ commandIdentity: "connectors.dispatch", route: [], effectClass: "inspect", summary: "Refuse a missing, unknown, or incompatible command selection" },
	{ commandIdentity: "connectors.help", route: ["--help"], effectClass: "inspect", summary: "Show help and usage" },
	{ commandIdentity: "connectors.discovery", route: ["--discover", "--json"], effectClass: "inspect", summary: "Describe the commands and the contract" },
];

// Contract Core 2.0 requires sorted, unique availablePaths, independent of
// COMMANDS' own declaration order (which stays readable/logical instead).
const AVAILABLE_PATHS: readonly string[] = [...new Set(COMMANDS.map((command) => command.commandIdentity))].sort();

export interface Envelope {
	readonly envelopeVersion: 2;
	readonly contractVersion: string;
	readonly message: string;
	readonly availablePaths: readonly string[];
	readonly result: {
		readonly runId: string;
		readonly commandIdentity: string;
		readonly outcome: Outcome;
		readonly failureClass: "usage" | "internal" | null;
		readonly exitCode: number;
		readonly data: Record<string, unknown> | null;
		readonly retryable: boolean;
		readonly repairAction: string | null;
		readonly nextAction: string | null;
		readonly effectClass: EffectClass;
		readonly transactionState: "unchanged";
		readonly causeCode: CauseCode;
		readonly effects: {
			readonly completed: readonly string[];
			readonly remaining: readonly string[];
			readonly uncertain: readonly string[];
			readonly inventoryComplete: boolean;
		};
	};
	readonly diagnostics?: { readonly detail: string };
}

function runId(): string {
	return `run-${crypto.randomUUID()}`;
}

// Cheap, dependency-free contract check on the value we are about to emit.
// Catches a coding mistake before it ships on stdout, per the accepted
// Spec's own rule to validate the complete final envelope immediately
// before serialization. Split into single-purpose checks so each stays
// trivially simple; assertEnvelope only composes their results.

const ENVELOPE_KEYS = ["envelopeVersion", "contractVersion", "message", "availablePaths", "result", "diagnostics"] as const;
const RESULT_KEYS = ["runId", "commandIdentity", "outcome", "failureClass", "exitCode", "data", "retryable", "repairAction", "nextAction", "effectClass", "transactionState", "causeCode", "effects"] as const;
const EFFECTS_KEYS = ["completed", "remaining", "uncertain", "inventoryComplete"] as const;

// Rejects any key this T1 shape does not declare, so a fabricated envelope
// cannot smuggle an extra field (a station-level key like
// retryDelayMilliseconds that belongs to a different Ticket's shape, for
// example) through as if it were part of this one.
function checkExactKeys(value: object, allowed: readonly string[], label: string): string[] {
	const extra = Object.keys(value).filter((key) => !(allowed as readonly string[]).includes(key));
	return extra.length > 0 ? [`${label} has unexpected key(s): ${extra.join(", ")}`] : [];
}

function checkEnvelopeShape(envelope: Envelope): string[] {
	const problems: string[] = [...checkExactKeys(envelope, ENVELOPE_KEYS, "envelope")];
	if (envelope.envelopeVersion !== 2) problems.push("envelopeVersion must be 2");
	if (envelope.contractVersion !== CONTRACT_VERSION) problems.push(`contractVersion must be exactly "${CONTRACT_VERSION}"`);
	if (typeof envelope.message !== "string" || envelope.message.length === 0) problems.push("message must be a non-empty string");
	return problems;
}

// T1's command surface is fixed and closed, so its canonical, already
// sorted/unique/string constant is the one valid value; no separately
// maintained sortedness/uniqueness/type logic can drift from it.
function checkAvailablePaths(paths: unknown): string[] {
	if (JSON.stringify(paths) !== JSON.stringify(AVAILABLE_PATHS)) {
		return ["availablePaths must exactly equal T1's canonical sorted command list"];
	}
	return [];
}

function checkResultIdentity(result: Envelope["result"]): string[] {
	const problems: string[] = [...checkExactKeys(result, RESULT_KEYS, "result")];
	if (typeof result.runId !== "string" || !result.runId.startsWith("run-")) problems.push("result.runId must be a run- prefixed string");
	if (typeof result.commandIdentity !== "string" || !AVAILABLE_PATHS.includes(result.commandIdentity)) {
		problems.push(`result.commandIdentity must name one of T1's admitted commands, not "${result.commandIdentity}"`);
	}
	if (result.outcome !== "success" && result.outcome !== "refused" && result.outcome !== "failed") problems.push("result.outcome must be success, refused, or failed");
	if (typeof result.exitCode !== "number") problems.push("result.exitCode must be a number");
	if (typeof result.nextAction !== "string" || result.nextAction.length === 0) problems.push("result.nextAction must be a non-empty string; T1 has no handoff concept yet");
	else if (!AVAILABLE_PATHS.includes(result.nextAction)) problems.push(`result.nextAction must name one of T1's admitted commands, not "${result.nextAction}"`);
	return problems;
}

// A value that would silently change shape, or throw, across JSON.stringify
// (Contract Core's actual wire format) is not safe to call "the final
// value": `undefined`/function/symbol vanish without a trace, BigInt throws,
// a cycle throws, and a non-finite number serializes as the string "null",
// none of which is the object we just validated. Only plain JSON values are
// admitted: string, boolean, finite number, null, plain array, plain object.
function isJsonSafeValue(value: unknown, seen: WeakSet<object>): boolean {
	if (value === null) return true;
	const type = typeof value;
	if (type === "string" || type === "boolean") return true;
	if (type === "number") return Number.isFinite(value);
	if (type !== "object") return false; // undefined, function, symbol, bigint
	const obj = value as object;
	if (seen.has(obj)) return false; // cycle
	seen.add(obj);
	if (Array.isArray(obj)) return obj.every((item) => isJsonSafeValue(item, seen));
	const proto = Object.getPrototypeOf(obj);
	if (proto !== Object.prototype && proto !== null) return false; // reject class instances, Date, Map, and similar
	return Object.values(obj).every((item) => isJsonSafeValue(item, seen));
}

function checkDataIsJsonSafe(data: Envelope["result"]["data"]): string[] {
	if (data !== null && !isJsonSafeValue(data, new WeakSet())) {
		return ["result.data must be a plain JSON-safe value (no undefined, function, symbol, bigint, non-finite number, cycle, or non-plain object), so the shipped envelope matches what was validated"];
	}
	return [];
}

// The only diagnostics this T1 shape ever emits, so any other shape (an
// extra key, a different detail string) is fabricated, not merely unusual;
// buildInternalFailureEnvelope is the single producer and reuses this exact
// constant, so the two can never independently drift.
const FIXED_INTERNAL_DIAGNOSTIC_DETAIL = "internal contract validation or serialization failed before output";

function checkDiagnostics(diagnostics: Envelope["diagnostics"]): string[] {
	if (diagnostics === undefined) return [];
	const problems = checkExactKeys(diagnostics, ["detail"], "diagnostics");
	if (diagnostics.detail !== FIXED_INTERNAL_DIAGNOSTIC_DETAIL) {
		problems.push("diagnostics.detail must be T1's one fixed, safe string; no other value, dynamic or otherwise, is admitted");
	}
	return problems;
}

interface CauseRow {
	readonly outcome: Outcome;
	readonly effectClass: EffectClass;
	readonly transactionState: "unchanged";
	readonly failureClass: "usage" | "internal" | null;
	readonly exitCode: number;
	readonly retryable: boolean;
	readonly dataRule: "object" | "null";
	readonly repairActionRule: "null" | "nonempty-string";
}

// The complete, closed set of cause codes T1 may ever emit, each pinned to
// every other field a fabricated envelope could otherwise mismatch (a
// "failed" outcome carrying SUCCESS_UNCHANGED, an unchanged transactionState
// carrying a non-empty completed list, and so on). A later Ticket that adds
// a cause code must add its own row here, never widen an existing one.
const ADMITTED_CAUSE_ROWS: Readonly<Record<CauseCode, CauseRow>> = {
	SUCCESS_UNCHANGED: { outcome: "success", effectClass: "inspect", transactionState: "unchanged", failureClass: null, exitCode: 0, retryable: false, dataRule: "object", repairActionRule: "null" },
	USAGE_UNKNOWN_COMMAND: { outcome: "refused", effectClass: "inspect", transactionState: "unchanged", failureClass: "usage", exitCode: 2, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
	INTERNAL_UNEXPECTED_UNCHANGED: { outcome: "failed", effectClass: "inspect", transactionState: "unchanged", failureClass: "internal", exitCode: 1, retryable: false, dataRule: "null", repairActionRule: "nonempty-string" },
};

// Scalar fields a cause row pins to one exact value; table-driven so this
// stays a flat comparison, not a chain of individual if statements.
function checkCauseRowScalars(result: Envelope["result"], row: CauseRow, cause: string): string[] {
	const comparisons: ReadonlyArray<readonly [unknown, unknown, string]> = [
		[result.outcome, row.outcome, "outcome"],
		[result.effectClass, row.effectClass, "effectClass"],
		[result.transactionState, row.transactionState, "transactionState"],
		[result.failureClass, row.failureClass, "failureClass"],
		[result.exitCode, row.exitCode, "exitCode"],
		[result.retryable, row.retryable, "retryable"],
	];
	return comparisons.filter(([actual, expected]) => actual !== expected).map(([, expected, label]) => `causeCode ${cause} requires ${label} ${JSON.stringify(expected)}`);
}

function checkCauseRowData(result: Envelope["result"], row: CauseRow, cause: string): string[] {
	if (row.dataRule === "object" && (result.data === null || typeof result.data !== "object")) return [`causeCode ${cause} requires result.data to be an object`];
	if (row.dataRule === "null" && result.data !== null) return [`causeCode ${cause} requires result.data to be null`];
	return [];
}

function checkCauseRowRepairAction(result: Envelope["result"], row: CauseRow, cause: string): string[] {
	if (row.repairActionRule === "null" && result.repairAction !== null) return [`causeCode ${cause} requires result.repairAction to be null`];
	if (row.repairActionRule === "nonempty-string" && !(typeof result.repairAction === "string" && result.repairAction.length > 0)) {
		return [`causeCode ${cause} requires a nonempty string result.repairAction`];
	}
	return [];
}

function checkCauseRow(result: Envelope["result"]): string[] {
	const row = ADMITTED_CAUSE_ROWS[result.causeCode as CauseCode];
	if (!row) return [`result.causeCode ${JSON.stringify(result.causeCode)} is not one of T1's admitted cause rows`];
	const cause = result.causeCode;
	return [...checkCauseRowScalars(result, row, cause), ...checkCauseRowData(result, row, cause), ...checkCauseRowRepairAction(result, row, cause)];
}

// T1 never attempts an effect, so every envelope's effects are vacuously
// empty and fully inventoried; a fabricated "unchanged" state must not be
// able to smuggle a fake completed/remaining/uncertain entry through.
function checkEffectsEmptyAndComplete(effects: Envelope["result"]["effects"]): string[] {
	const problems: string[] = [...checkExactKeys(effects, EFFECTS_KEYS, "result.effects")];
	for (const key of ["completed", "remaining", "uncertain"] as const) {
		if (!Array.isArray(effects[key])) problems.push(`result.effects.${key} must be an array`);
		else if (effects[key].length > 0) problems.push(`result.effects.${key} must be empty; T1 never attempts an effect`);
	}
	if (effects.inventoryComplete !== true) problems.push("result.effects.inventoryComplete must be true for T1");
	return problems;
}

export function assertEnvelope(envelope: Envelope): void {
	const problems = [
		...checkEnvelopeShape(envelope),
		...checkAvailablePaths(envelope.availablePaths),
		...checkResultIdentity(envelope.result),
		...checkCauseRow(envelope.result),
		...checkEffectsEmptyAndComplete(envelope.result.effects),
		...checkDataIsJsonSafe(envelope.result.data),
		...checkDiagnostics(envelope.diagnostics),
	];
	if (problems.length > 0) throw new Error(`internal contract violation: ${problems.join("; ")}`);
}

// Hand-verified, dependency-free fallback for the one path that must never
// itself depend on assertEnvelope succeeding: if envelope construction or
// validation throws anywhere above, this is what ships. T1 is inspect-only,
// so a caught failure here always has zero attempted effects (never partial
// or uncertain), independent of what specifically went wrong.
//
// Deliberately takes no detail from the caught exception: `error.message`
// is arbitrary text this front door does not control, and could echo a
// secret-shaped argv value back through a thrown validation message. This
// fallback's `diagnostics.detail` is always the same fixed, safe string.
export function buildInternalFailureEnvelope(): Envelope {
	return {
		envelopeVersion: 2,
		contractVersion: CONTRACT_VERSION,
		message: `${PROGRAM}: internal error`,
		availablePaths: AVAILABLE_PATHS,
		result: {
			runId: runId(),
			commandIdentity: "connectors.dispatch",
			outcome: "failed",
			failureClass: "internal",
			exitCode: 1,
			data: null,
			retryable: false,
			repairAction: "Report this internal error; the requested command was not completed",
			nextAction: "connectors.help",
			effectClass: "inspect",
			transactionState: "unchanged",
			causeCode: "INTERNAL_UNEXPECTED_UNCHANGED",
			effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true },
		},
		diagnostics: { detail: FIXED_INTERNAL_DIAGNOSTIC_DETAIL },
	};
}

// True once a stdout write has actually been attempted. A pre-drain EPIPE
// (the reader closed the pipe) can throw out of that attempt; once this
// flag is set, the top-level handler must not attempt a second, replacement
// write, matching the accepted Spec's "never emit a replacement after a
// partial stream" rule.
let outputStarted = false;

function writeStdout(text: string): void {
	outputStarted = true;
	process.stdout.write(text);
}

// Sets the process exit code and returns without forcing an exit. Calling
// `process.exit()` immediately after a stdout write races Bun's own async
// flush when stdout is a pipe (never a TTY for this front door) and can
// truncate the very envelope callers rely on; letting the event loop drain
// naturally is the only way this proof-required "stdout drain" holds.
function emit(envelope: Envelope): void {
	assertEnvelope(envelope);
	writeStdout(`${JSON.stringify(envelope)}\n`);
	process.exitCode = envelope.result.exitCode;
}

function discover(): void {
	emit({
		envelopeVersion: 2,
		contractVersion: CONTRACT_VERSION,
		message: "Command discovery completed",
		availablePaths: AVAILABLE_PATHS,
		result: {
			runId: runId(),
			commandIdentity: "connectors.discovery",
			outcome: "success",
			failureClass: null,
			exitCode: 0,
			data: {
				contractVersion: CONTRACT_VERSION,
				generationConventionVersion: CONTRACT_VERSION,
				profile: "complex",
				commands: COMMANDS,
				exitMeanings: EXIT_MEANINGS,
				signalExits: SIGNAL_EXITS,
				effectExclusions: EFFECT_EXCLUSIONS,
			},
			retryable: false,
			repairAction: null,
			nextAction: "connectors.help",
			effectClass: "inspect",
			transactionState: "unchanged",
			causeCode: "SUCCESS_UNCHANGED",
			effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true },
		},
	});
}

function helpText(): string {
	return [
		`${PROGRAM}: Connectors plugin front door (T1 discovery skeleton)`,
		"",
		"Commands:",
		"  --discover --json   Describe the commands and the contract (machine JSON)",
		"  --help              Show this human-readable help",
		"  --help --json       Show help as a machine Contract Core envelope",
		"",
		"Examples:",
		`  ${PROGRAM} --discover --json`,
		`  ${PROGRAM} --help`,
		"",
	].join("\n");
}

function helpEnvelope(): void {
	emit({
		envelopeVersion: 2,
		contractVersion: CONTRACT_VERSION,
		message: `${PROGRAM}: run with --discover --json to see available commands`,
		availablePaths: AVAILABLE_PATHS,
		result: {
			runId: runId(),
			commandIdentity: "connectors.help",
			outcome: "success",
			failureClass: null,
			exitCode: 0,
			data: { usage: `${PROGRAM} --discover --json`, commands: COMMANDS },
			retryable: false,
			repairAction: null,
			nextAction: "connectors.discovery",
			effectClass: "inspect",
			transactionState: "unchanged",
			causeCode: "SUCCESS_UNCHANGED",
			effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true },
		},
	});
}

function refuse(message: string): void {
	emit({
		envelopeVersion: 2,
		contractVersion: CONTRACT_VERSION,
		message,
		availablePaths: AVAILABLE_PATHS,
		result: {
			runId: runId(),
			commandIdentity: "connectors.dispatch",
			outcome: "refused",
			failureClass: "usage",
			exitCode: 2,
			data: null,
			retryable: false,
			repairAction: `Run ${PROGRAM} --discover --json to see available commands`,
			nextAction: "connectors.help",
			effectClass: "inspect",
			transactionState: "unchanged",
			causeCode: "USAGE_UNKNOWN_COMMAND",
			effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true },
		},
	});
}

function main(): void {
	const args = process.argv.slice(2);
	if (args.length === 2 && args[0] === "--discover" && args[1] === "--json") {
		discover();
		return;
	}
	if (args.length === 1 && args[0] === "--help") {
		writeStdout(helpText());
		process.exitCode = 0;
		return;
	}
	if (args.length === 2 && args[0] === "--help" && args[1] === "--json") {
		helpEnvelope();
		return;
	}
	if (args.length === 0) {
		refuse(`${PROGRAM}: no command given. Run with --discover --json to see available commands.`);
		return;
	}
	// Never echo the caller's raw argv into public output: an argument can
	// carry a secret-shaped value, and machine stdout must stay redacted
	// regardless of what was actually typed. Fixed message only.
	refuse(`${PROGRAM}: unsupported command. Run with --discover --json to see available commands.`);
}

// Guarded so a test can `import` this module (to reach buildInternalFailureEnvelope
// and assertEnvelope directly) without running the CLI against the test runner's
// own argv; Bun sets import.meta.main only for the actual entry invocation.
if (import.meta.main) {
	// A write to a closed reader (the classic pre-drain EPIPE) surfaces as an
	// asynchronous 'error' event on the stream, not a synchronous throw from
	// `.write()` itself; the synchronous try/catch below never sees it. An
	// EventEmitter with no 'error' listener crashes with a raw stack on
	// stderr by default, exactly the forbidden output. Register this before
	// any write is attempted (main() has not run yet), and only for the
	// real entry invocation: importing this module for a unit test must
	// never attach a listener to the test runner's own stdout.
	process.stdout.on("error", (error: NodeJS.ErrnoException) => {
		// Contract Core permits ending without an envelope on pre-drain
		// EPIPE; never emit a replacement after a partial/failed stream,
		// and never let this reach the runtime's own uncaught-exception
		// reporting. A write that failed did not reliably reach the
		// caller, so exit nonzero regardless of what the in-flight
		// command would otherwise have reported.
		void error;
		process.exitCode = 1;
	});
	try {
		main();
	} catch {
		process.exitCode = 1;
		if (outputStarted) {
			// A write was already attempted and threw (the classic pre-drain
			// EPIPE: the reader closed the pipe). Contract Core permits ending
			// without an envelope here; stderr stays empty, and attempting a
			// second, replacement write is exactly the forbidden replay after
			// a partial stream.
		} else {
			// Nothing was written yet, so this is a genuine internal failure,
			// not a broken pipe: safe to ship the one bounded fallback
			// envelope. Guard this attempt too, since stdout could still be
			// gone for an unrelated reason; a second failure must never
			// escape to the runtime's own uncaught-exception reporting.
			try {
				const envelope = buildInternalFailureEnvelope();
				writeStdout(`${JSON.stringify(envelope)}\n`);
				process.exitCode = envelope.result.exitCode;
			} catch {
				process.exitCode = 1;
			}
		}
	}
}
