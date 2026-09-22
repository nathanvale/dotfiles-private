// The canva-auth command contract: command identities, options, the closed
// cause vocabulary with its Contract Core 2.0 correlations, the station
// catalogue that selected-command discovery publishes, the help and discovery
// data, and the validated envelope builder. Every public path of the CLI
// returns through `envelope` and `validateEnvelope`.
export const PROGRAM = "canva-auth";
export const CONTRACT_VERSION = "2.0.0" as const;
export const ENVELOPE_VERSION = 2 as const;

export type EffectClass = "inspect" | "repository-local" | "external";
export type Outcome = "success" | "refused" | "failed";
export type TransactionState = "unchanged" | "completed" | "partially-completed" | "unknown";
export type FailureClass = "usage" | "domain" | "schema" | "internal" | "transient";
export type Guidance = "next" | "handoff";

const EXIT: Record<FailureClass | "success", number> = { success: 0, internal: 1, usage: 2, domain: 3, schema: 4, transient: 75 };
export const EXIT_MEANINGS = { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "transient" } as const;

export interface CauseRule {
	failureClass: FailureClass | null;
	outcome: Outcome;
	transactionState: TransactionState;
	retryable: boolean;
	guidance: Guidance;
	exitCode: number;
}

const rule = (failureClass: FailureClass | null, outcome: Outcome, transactionState: TransactionState, retryable: boolean, guidance: Guidance): CauseRule => ({ failureClass, outcome, transactionState, retryable, guidance, exitCode: EXIT[failureClass ?? "success"] });

// The Contract Core 2.0 rows this CLI can reach. Prefix and row agree with
// the failure class, outcome, state, exit, retry policy, and guidance arm.
export const CAUSE_RULES = {
	SUCCESS_UNCHANGED: rule(null, "success", "unchanged", false, "next"),
	SUCCESS_COMPLETED: rule(null, "success", "completed", false, "next"),
	USAGE_INVALID_INVOCATION: rule("usage", "refused", "unchanged", false, "next"),
	USAGE_UNKNOWN_COMMAND: rule("usage", "refused", "unchanged", false, "next"),
	SCHEMA_INVALID_INPUT: rule("schema", "refused", "unchanged", false, "next"),
	DOMAIN_PRECONDITION_UNMET: rule("domain", "refused", "unchanged", false, "next"),
	DOMAIN_AUTHORITY_REQUIRED: rule("domain", "refused", "unchanged", false, "handoff"),
	DOMAIN_DEADLINE_UNCHANGED: rule("domain", "failed", "unchanged", false, "next"),
	DOMAIN_RECOVERY_HANDOFF_REQUIRED: rule("domain", "failed", "unknown", false, "handoff"),
	TRANSIENT_NOT_STARTED: rule("transient", "refused", "unchanged", true, "next"),
	INTERNAL_PREPARATION: rule("internal", "refused", "unchanged", false, "next"),
	INTERNAL_RESULT_UNCHANGED: rule("internal", "failed", "unchanged", false, "handoff"),
	INTERNAL_RESULT_PARTIAL: rule("internal", "failed", "partially-completed", false, "handoff"),
	INTERNAL_RESULT_UNKNOWN: rule("internal", "failed", "unknown", false, "handoff"),
	INTERNAL_UNEXPECTED: rule("internal", "failed", "unchanged", false, "handoff"),
} as const satisfies Record<string, CauseRule>;
export type CauseCode = keyof typeof CAUSE_RULES;

export type CommandIdentity = "canva-auth.help" | "canva-auth.discovery" | "canva-auth.command-discovery" | "canva-auth.dispatch" | "canva-auth.login" | "canva-auth.status" | "canva-auth.logout";

export interface CommandSummary {
	commandIdentity: CommandIdentity;
	route: string[];
	summary: string;
	effectClass: EffectClass;
}

export const COMMANDS: readonly CommandSummary[] = [
	{ commandIdentity: "canva-auth.help", route: ["--help"], summary: "Show help and usage", effectClass: "inspect" },
	{ commandIdentity: "canva-auth.discovery", route: ["--discover"], summary: "Describe commands and the contract", effectClass: "inspect" },
	{ commandIdentity: "canva-auth.command-discovery", route: ["--discover-command"], summary: "Describe the possible outcomes of one selected command", effectClass: "inspect" },
	{ commandIdentity: "canva-auth.dispatch", route: [], summary: "Refuse a missing or invalid invocation", effectClass: "inspect" },
	{ commandIdentity: "canva-auth.login", route: ["login"], summary: "Run the attended Canva login for one account and store its session", effectClass: "external" },
	{ commandIdentity: "canva-auth.status", route: ["status"], summary: "Report the nonsecret session status for one account", effectClass: "inspect" },
	{ commandIdentity: "canva-auth.logout", route: ["logout"], summary: "Revoke the account's grant when the server allows it and remove the local session", effectClass: "external" },
];
export const AVAILABLE_PATHS: readonly string[] = COMMANDS.map((command) => command.commandIdentity).sort();
export const isCommandIdentity = (value: string): value is CommandIdentity => AVAILABLE_PATHS.includes(value);

export const OPTIONS = [
	{ name: "--help", valueName: null, summary: "Show help" },
	{ name: "--discover", valueName: null, summary: "Show command and contract discovery" },
	{ name: "--discover-command", valueName: "canonical-command-identity", summary: "Describe the possible outcomes of one selected command" },
	{ name: "--json", valueName: null, summary: "Emit one machine-readable 2.0 envelope" },
	{ name: "--account", valueName: "slug", summary: "Select the Canva Account (lowercase slug)" },
	{ name: "--no-browser", valueName: null, summary: "Print the authorization URL in human mode instead of opening the system browser" },
] as const;

const USAGE = "canva-auth <login|status|logout> --account <slug> [--no-browser] [--json]";
export const HELP_DATA = { usage: USAGE, summary: "Attended Canva login, session status, and logout for the Connectors plugin", commands: COMMANDS, options: OPTIONS };
export const HELP_TEXT = `${HELP_DATA.summary}\n\nusage:\n  ${USAGE}\n  canva-auth --discover [--json]\n  canva-auth --discover-command <canonical-command-identity> [--json]\n\ncommands:\n  login    open the system browser for one attended Canva login and store the session (external effect)\n  status   report the nonsecret session status (inspect)\n  logout   revoke the grant when the server allows it and remove the local session (external effect)\n\nexample:\n  canva-auth login --account personal\n  canva-auth status --account personal --json\n`;

export const DISCOVERY_DATA = {
	contractVersion: CONTRACT_VERSION,
	generationConventionVersion: CONTRACT_VERSION,
	profile: "complex",
	commands: COMMANDS,
	exitMeanings: EXIT_MEANINGS,
	signalExits: { "130": "SIGINT", "143": "SIGTERM" },
	effectExclusions: ["the system browser's own state and the Canva-side grant record are outside this CLI's effect inventory"],
} as const;

export type Handoff = { owner: "human" | "operator"; reason: string; inspect: string[] };
export type PublicGuidance = { nextAction: string } | { handoff: Handoff };

export interface Station {
	commandIdentity: CommandIdentity;
	outcome: Outcome;
	causeCode: CauseCode;
	failureClass: FailureClass | null;
	exitCode: number;
	effectClass: EffectClass;
	transactionState: TransactionState;
	retryable: boolean;
	retryDelayPolicy: { kind: "none" } | { kind: "bounded"; minimumMilliseconds: number; maximumMilliseconds: number };
	trigger: string;
	guidance: PublicGuidance;
	repairAction: string | null;
	reachability: "required" | "declared-unreachable";
	unreachableRationale: string | null;
}

export const RETRY_DELAY_MS = 1000;
const STATUS_ACTION = "canva-auth status --account <slug>";
const LOGIN_ACTION = "canva-auth login --account <slug>";
const HELP_ACTION = "canva-auth --help";
const INSPECT = [STATUS_ACTION];

const station = (commandIdentity: CommandIdentity, causeCode: CauseCode, effectClass: EffectClass, trigger: string, guidance: PublicGuidance, repairAction: string | null): Station => {
	const causeRule = CAUSE_RULES[causeCode];
	return {
		commandIdentity,
		outcome: causeRule.outcome,
		causeCode,
		failureClass: causeRule.failureClass,
		exitCode: causeRule.exitCode,
		effectClass,
		transactionState: causeRule.transactionState,
		retryable: causeRule.retryable,
		retryDelayPolicy: causeRule.retryable ? { kind: "bounded", minimumMilliseconds: RETRY_DELAY_MS, maximumMilliseconds: RETRY_DELAY_MS } : { kind: "none" },
		trigger,
		guidance,
		repairAction,
		reachability: "required",
		unreachableRationale: null,
	};
};
const next = (nextAction: string): PublicGuidance => ({ nextAction });
const handoff = (owner: Handoff["owner"], reason: string): PublicGuidance => ({ handoff: { owner, reason, inspect: INSPECT } });

// Repair texts are fixed per station; the session module's detail is never
// substituted because it is not part of this contract's vocabulary.
export const REPAIR = {
	usage: `Correct the arguments or run ${HELP_ACTION}`,
	unknownCommand: `Select a canonical command identity from availablePaths or run ${HELP_ACTION}`,
	authRequired: `No session exists for this account; run ${LOGIN_ACTION}`,
	sessionInvalid: `The session file is not an owned exact-0600 record; run canva-auth logout --account <slug>, then ${LOGIN_ACTION}`,
	precondition: "Inspect the reported precondition (discovery, client registration, or callback) and repair it before running login again",
	sessionExists: "A session already exists for this account; run canva-auth logout --account <slug> before login",
	registeredSecretRequired: "Set CANVA_CLIENT_SECRET for the registered client configured in oauth.json, then retry; authorization was not started",
	denied: "Grant access in the browser when Canva asks, then run login again",
	timeout: "No callback arrived within the login window; run login again and complete the browser step",
	exchange: "Consent may have created a grant at Canva without a local session; inspect Canva connected apps, then run login again",
	unwritable: "Make the account directory under the state root an owned 0700 directory, then run the command again",
	lockHeld: "Stop all canva-auth and Canva Provider processes for this account, remove only refresh.lock from its private state directory, then run status before retrying",
	clientSecretUnavailable: "Restore CANVA_CLIENT_SECRET and the matching registered client in oauth.json, then retry; the stored session was preserved",
	revokeUncertain: "The local session was removed but Canva did not confirm revocation; revoke the Connectors plugin in Canva connected apps",
	unremovable: "The session directory could not be removed; inspect its permissions, then run logout again",
	unexpected: "Inspect the private state and rerun the command; the envelope could not be validated",
} as const;

export const STATIONS: readonly Station[] = [
	station("canva-auth.help", "SUCCESS_UNCHANGED", "inspect", "--help", next(STATUS_ACTION), null),
	station("canva-auth.discovery", "SUCCESS_UNCHANGED", "inspect", "--discover", next(STATUS_ACTION), null),
	station("canva-auth.command-discovery", "SUCCESS_UNCHANGED", "inspect", "--discover-command with a canonical identity", next(STATUS_ACTION), null),
	station("canva-auth.command-discovery", "USAGE_UNKNOWN_COMMAND", "inspect", "--discover-command with an unknown identity", next(HELP_ACTION), REPAIR.unknownCommand),
	station("canva-auth.dispatch", "USAGE_INVALID_INVOCATION", "inspect", "no command, an unknown option, a repeated or valueless option, or an invalid --account", next(HELP_ACTION), REPAIR.usage),
	station("canva-auth.login", "SUCCESS_COMPLETED", "external", "the browser callback returned a code and the token exchange stored a session; with --no-browser the authorization URL was written to human stdout before the wait", next(STATUS_ACTION), null),
	station("canva-auth.login", "USAGE_INVALID_INVOCATION", "external", "--account missing or not a lowercase slug, or --no-browser was combined with --json", next(HELP_ACTION), REPAIR.usage),
	station("canva-auth.login", "INTERNAL_PREPARATION", "external", "the account directory is not an owned 0700 directory, or oauth.json is invalid", next(STATUS_ACTION), REPAIR.unwritable),
	station("canva-auth.login", "DOMAIN_PRECONDITION_UNMET", "external", "a session already exists, a registered client secret is unavailable, or discovery, client registration, or the callback did not meet the contract", next(STATUS_ACTION), REPAIR.precondition),
	station("canva-auth.login", "TRANSIENT_NOT_STARTED", "external", "the account session lock is held and may be active or abandoned", next(`retry canva-auth login once after ${RETRY_DELAY_MS} ms`), REPAIR.lockHeld),
	station("canva-auth.login", "DOMAIN_AUTHORITY_REQUIRED", "external", "consent was denied or the callback state did not match this login", handoff("human", "Canva did not grant access for this login."), REPAIR.denied),
	station("canva-auth.login", "DOMAIN_DEADLINE_UNCHANGED", "external", "no callback arrived before the login window closed", next(LOGIN_ACTION), REPAIR.timeout),
	station("canva-auth.login", "DOMAIN_RECOVERY_HANDOFF_REQUIRED", "external", "consent completed but the token exchange failed", handoff("human", "A grant may exist at Canva with no local session."), REPAIR.exchange),
	station("canva-auth.status", "SUCCESS_UNCHANGED", "inspect", "a valid session exists", next(STATUS_ACTION), null),
	station("canva-auth.status", "USAGE_INVALID_INVOCATION", "inspect", "--account missing or not a lowercase slug", next(HELP_ACTION), REPAIR.usage),
	station("canva-auth.status", "DOMAIN_PRECONDITION_UNMET", "inspect", "no session exists for the account", next(LOGIN_ACTION), REPAIR.authRequired),
	station("canva-auth.status", "SCHEMA_INVALID_INPUT", "inspect", "the session file is not an owned exact-0600 valid record", next(LOGIN_ACTION), REPAIR.sessionInvalid),
	station("canva-auth.logout", "SUCCESS_COMPLETED", "external", "the session was removed, with revocation confirmed or unsupported", next(STATUS_ACTION), null),
	station("canva-auth.logout", "SUCCESS_UNCHANGED", "external", "no session existed", next(STATUS_ACTION), null),
	station("canva-auth.logout", "USAGE_INVALID_INVOCATION", "external", "--account missing or not a lowercase slug", next(HELP_ACTION), REPAIR.usage),
	station("canva-auth.logout", "DOMAIN_PRECONDITION_UNMET", "external", "a stored registered session cannot authenticate because CANVA_CLIENT_SECRET is missing or does not match oauth.json", next(STATUS_ACTION), REPAIR.clientSecretUnavailable),
	station("canva-auth.logout", "TRANSIENT_NOT_STARTED", "external", "the account session lock is held and may be active or abandoned", next(`retry canva-auth logout once after ${RETRY_DELAY_MS} ms`), REPAIR.lockHeld),
	station("canva-auth.logout", "DOMAIN_RECOVERY_HANDOFF_REQUIRED", "external", "the session was removed but the revocation request did not confirm", handoff("human", "Canva did not confirm revocation of the grant."), REPAIR.revokeUncertain),
	station("canva-auth.logout", "INTERNAL_RESULT_UNCHANGED", "external", "the session directory could not be removed and no revocation was sent", handoff("operator", "The local session could not be removed."), REPAIR.unremovable),
	station("canva-auth.logout", "INTERNAL_RESULT_PARTIAL", "external", "revocation was confirmed but the session directory could not be removed", handoff("operator", "The grant is revoked but the local session remains."), REPAIR.unremovable),
	station("canva-auth.logout", "INTERNAL_RESULT_UNKNOWN", "external", "revocation did not confirm and the session directory could not be removed", handoff("operator", "Neither the grant nor the local session is in a known state."), REPAIR.unremovable),
];

export interface Effects {
	completed: string[];
	remaining: string[];
	uncertain: string[];
	inventoryComplete: boolean;
}

export interface Result {
	runId: string;
	commandIdentity: CommandIdentity;
	outcome: Outcome;
	effectClass: EffectClass;
	transactionState: TransactionState;
	causeCode: CauseCode;
	failureClass: FailureClass | null;
	exitCode: number;
	data: unknown;
	retryable: boolean;
	retryDelayMilliseconds?: number;
	repairAction: string | null;
	effects: Effects;
	nextAction?: string;
	handoff?: Handoff;
}

export interface Envelope {
	envelopeVersion: 2;
	contractVersion: "2.0.0";
	message: string;
	availablePaths: string[];
	result: Result;
}

export interface Rendering {
	identity: CommandIdentity;
	cause: CauseCode;
	effectClass: EffectClass;
	message: string;
	data: unknown;
	effects?: Partial<Effects>;
	guidance: PublicGuidance;
	repairAction: string | null;
}

const sorted = (values: string[] = []): string[] => [...new Set(values)].sort();

// One envelope from a rendering; outcome, state, class, exit, and retry
// policy derive from the cause rule so they cannot disagree with it.
export function envelope(rendering: Rendering): Envelope {
	const causeRule = CAUSE_RULES[rendering.cause];
	const effects: Effects = { completed: sorted(rendering.effects?.completed), remaining: sorted(rendering.effects?.remaining), uncertain: sorted(rendering.effects?.uncertain), inventoryComplete: rendering.effects?.inventoryComplete ?? true };
	const result: Result = {
		runId: crypto.randomUUID(),
		commandIdentity: rendering.identity,
		outcome: causeRule.outcome,
		effectClass: rendering.effectClass,
		transactionState: causeRule.transactionState,
		causeCode: rendering.cause,
		failureClass: causeRule.failureClass,
		exitCode: causeRule.exitCode,
		data: causeRule.outcome === "success" ? rendering.data : null,
		retryable: causeRule.retryable,
		...(causeRule.retryable ? { retryDelayMilliseconds: RETRY_DELAY_MS } : {}),
		repairAction: causeRule.outcome === "success" ? null : rendering.repairAction,
		effects,
		...rendering.guidance,
	};
	return { envelopeVersion: ENVELOPE_VERSION, contractVersion: CONTRACT_VERSION, message: rendering.message, availablePaths: [...AVAILABLE_PATHS], result };
}

// Contract Core 2.0 state and effect correlation as one declarative table:
// per state, which effect collections must be empty, which must not, and
// whether the inventory must be complete. "unknown" is the one state that
// is satisfied by an incomplete inventory alone.
type Presence = "empty" | "some" | "any";
const EFFECT_SHAPES: Record<TransactionState, { completed: Presence; remaining: Presence; uncertain: Presence; inventoryComplete: boolean | "any" }> = {
	unchanged: { completed: "empty", remaining: "any", uncertain: "empty", inventoryComplete: true },
	completed: { completed: "some", remaining: "empty", uncertain: "empty", inventoryComplete: true },
	"partially-completed": { completed: "some", remaining: "some", uncertain: "empty", inventoryComplete: true },
	unknown: { completed: "any", remaining: "any", uncertain: "any", inventoryComplete: "any" },
};
const presenceHolds = (presence: Presence, values: string[]): boolean => presence === "any" || (presence === "empty") === (values.length === 0);

function stateEffectsAgree(state: TransactionState, effects: Effects): boolean {
	if (state === "unknown") return !effects.inventoryComplete || effects.uncertain.length > 0;
	const shape = EFFECT_SHAPES[state];
	return presenceHolds(shape.completed, effects.completed) && presenceHolds(shape.remaining, effects.remaining) && presenceHolds(shape.uncertain, effects.uncertain) && (shape.inventoryComplete === "any" || effects.inventoryComplete === shape.inventoryComplete);
}

// The validation the serializer runs immediately before output: every
// correlation Contract Core 2.0 names, checked independently of `envelope`.
export function validateEnvelope(value: Envelope): string[] {
	const findings: string[] = [];
	const { result } = value;
	const causeRule = CAUSE_RULES[result.causeCode];
	if (value.message.trim() === "") findings.push("message-blank");
	if (!isCommandIdentity(result.commandIdentity)) findings.push("command-undeclared");
	if (result.outcome !== causeRule.outcome || result.failureClass !== causeRule.failureClass || result.transactionState !== causeRule.transactionState || result.exitCode !== causeRule.exitCode || result.retryable !== causeRule.retryable) findings.push("cause-correlation");
	if (("nextAction" in result) === ("handoff" in result) || (causeRule.guidance === "next") !== "nextAction" in result) findings.push("guidance-arm");
	if (result.retryable !== ("retryDelayMilliseconds" in result)) findings.push("retry-correlation");
	if (result.outcome === "success" ? result.repairAction !== null : result.data !== null || !result.repairAction) findings.push("outcome-data");
	if (!stateEffectsAgree(result.transactionState, result.effects)) findings.push("effect-state");
	if (result.effectClass === "inspect" && (result.transactionState !== "unchanged" || result.effects.completed.length + result.effects.remaining.length + result.effects.uncertain.length > 0)) findings.push("inspect-effects");
	const all = [...result.effects.completed, ...result.effects.remaining, ...result.effects.uncertain];
	if (new Set(all).size !== all.length) findings.push("effects-overlap");
	return findings;
}
