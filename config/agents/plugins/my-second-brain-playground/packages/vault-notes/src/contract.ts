// The one typed owner for vault-notes command identities, routes, stations and the Contract Core 2.0 envelope.
// Help and discovery speak 2.0. check, list and inventory keep their frozen legacy output; discovery declares
// those legacy outcomes instead of 2.0 stations, because those commands never emit an envelope.
import { randomUUID } from "node:crypto";
import { VAULT_FINDING_IDS } from "./check";

const CONTRACT_VERSION = "2.0.0";

export type LegacyCommand = "check" | "list" | "inventory";
export type CommandIdentity = `vault-notes.${LegacyCommand}`;
export type ControlIdentity =
  | "vault-notes.help"
  | "vault-notes.discovery"
  | "vault-notes.command-discovery"
  | "vault-notes.dispatch";

/** One observable result of a legacy command: its exit, trigger and exact output channel. */
interface LegacyOutcome {
  id: string;
  exitCode: 0 | 1;
  trigger: string;
  human: string;
  machine: string;
}

const LEGACY_OUTCOMES: Record<CommandIdentity, readonly LegacyOutcome[]> = {
  "vault-notes.check": [
    {
      id: "check.passed",
      exitCode: 0,
      trigger: "No governed note has a finding.",
      human: "stdout: Vault check passed.",
      machine: 'stdout: {"schema_version":1,"findings":[]}',
    },
    {
      id: "check.findings",
      exitCode: 1,
      trigger: "One or more governed notes have a finding.",
      human: "stderr: one '<file>: <message>' line per finding, a blank line, then '<n> issue(s) found.'",
      machine: "stdout: {schema_version:1, findings:[{id, file, message, repair_id, detail?}]}",
    },
    {
      id: "check.unreadable",
      exitCode: 1,
      trigger: "schemas/frontmatter-contract.json or a note cannot be read, or a local link holds a malformed % escape (inherited URIError).",
      human: "stderr: the uncaught runtime error; no result",
      machine: "stderr: the uncaught runtime error; stdout empty",
    },
  ],
  "vault-notes.list": [
    {
      id: "list.listed",
      exitCode: 0,
      trigger: "Every selected note has title, type, status and summary.",
      human: "stdout: path, then indented title (type, status) and summary per note; or 'No notes found.'",
      machine: "stdout: {schemaVersion:1, ok:true, notes:[{path, title, type, status, summary}]}",
    },
    {
      id: "list.help",
      exitCode: 0,
      trigger: "--help or -h appears anywhere in the arguments.",
      human: "stdout: the legacy list usage text",
      machine: "stdout: the legacy list usage text",
    },
    {
      id: "list.invalid-usage",
      exitCode: 1,
      trigger: "An unknown argument, a repeated or valueless option, or an unknown family.",
      human: "stderr: INVALID_USAGE: <next action>",
      machine: "stdout: {schemaVersion:1, ok:false, code:'INVALID_USAGE', nextAction, files:[]}",
    },
    {
      id: "list.invalid-notes",
      exitCode: 1,
      trigger: "A selected note lacks title, type, status or summary.",
      human: "stderr: INVALID_NOTES: <next action>, then one file per line",
      machine: "stdout: {schemaVersion:1, ok:false, code:'INVALID_NOTES', nextAction, files}",
    },
    {
      id: "list.failed",
      exitCode: 1,
      trigger: "The vault root or its contract cannot be read.",
      human: "stderr: LIST_FAILED: <next action>",
      machine: "stdout: {schemaVersion:1, ok:false, code:'LIST_FAILED', nextAction, files:[]}",
    },
  ],
  "vault-notes.inventory": [
    {
      id: "inventory.counted",
      exitCode: 0,
      trigger: "Every governed note is counted by family, type and status.",
      human: "stdout: 'Vault notes: <n>' then By family, By type and By status sections",
      machine: "stdout: pretty-printed {total, byFamily, byType, byStatus}",
    },
    {
      id: "inventory.unreadable",
      exitCode: 1,
      trigger: "schemas/frontmatter-contract.json or a note cannot be read.",
      human: "stderr: the uncaught runtime error; no result",
      machine: "stderr: the uncaught runtime error; stdout empty",
    },
  ],
};

export const COMMANDS = [
  {
    commandIdentity: "vault-notes.dispatch",
    effectClass: "inspect",
    route: [],
    summary: "Refuse a missing, unknown or malformed command selection.",
  },
  {
    commandIdentity: "vault-notes.help",
    effectClass: "inspect",
    route: ["--help"],
    summary: "Show usage, commands and options.",
  },
  {
    commandIdentity: "vault-notes.discovery",
    effectClass: "inspect",
    route: ["--discover"],
    summary: "Describe the contract, commands and effect exclusions.",
  },
  {
    commandIdentity: "vault-notes.command-discovery",
    effectClass: "inspect",
    route: ["--discover-command"],
    summary: "Describe the possible outcomes of one command.",
  },
  {
    commandIdentity: "vault-notes.check",
    effectClass: "inspect",
    route: ["check"],
    summary: "Validate governed notes: frontmatter, routing, identities, body secrets, local links, tickets and folder maps.",
  },
  {
    commandIdentity: "vault-notes.list",
    effectClass: "inspect",
    route: ["list"],
    summary: "List current notes from their metadata, optionally for one family.",
  },
  {
    commandIdentity: "vault-notes.inventory",
    effectClass: "inspect",
    route: ["inventory"],
    summary: "Count governed notes by family, type and status.",
  },
] as const satisfies readonly {
  commandIdentity: CommandIdentity | ControlIdentity;
  effectClass: "inspect";
  route: string[];
  summary: string;
}[];

const AVAILABLE_PATHS = COMMANDS.map((command) => command.commandIdentity)
  .filter((identity) => identity !== "vault-notes.dispatch")
  .sort();

export type Guidance = { nextAction: string };

/** A refusal or failure station. Cause, outcome, exit and retry policy agree with the Contract Core cause table. */
export interface Station {
  causeCode: string;
  outcome: "refused" | "failed";
  failureClass: "usage" | "internal";
  exitCode: 1 | 2;
  trigger: string;
  repairAction: string;
  guidance: Guidance;
}

export const STATIONS = {
  usage: {
    causeCode: "USAGE_INVALID_INVOCATION",
    outcome: "refused",
    failureClass: "usage",
    exitCode: 2,
    trigger: "The arguments name no supported command, or a control option is repeated, combined or lacks its value.",
    repairAction: "Choose check, list, inventory, --help, --discover or --discover-command COMMAND_IDENTITY and retry.",
    guidance: { nextAction: "Run vault-notes --help and choose a listed command." },
  },
  serialization: {
    causeCode: "INTERNAL_RESULT_SERIALIZATION",
    outcome: "failed",
    failureClass: "internal",
    exitCode: 1,
    trigger: "The result cannot be serialized, or the serialized value fails envelope validation.",
    repairAction: "Inspect the serialization failure before retrying.",
    guidance: { nextAction: "Inspect the runtime and retry the command." },
  },
  emission: {
    causeCode: "INTERNAL_RESULT_EMISSION",
    outcome: "failed",
    failureClass: "internal",
    exitCode: 1,
    trigger: "stdout cannot be written. Machine mode then emits no envelope and nothing on stderr; human mode prints this repair on stderr.",
    repairAction: "Inspect the output stream before retrying.",
    guidance: { nextAction: "Inspect the output stream and retry the command." },
  },
} as const satisfies Record<string, Station>;

export type StationKey = keyof typeof STATIONS;

const INSPECT_EFFECTS = { completed: [], inventoryComplete: true, remaining: [], uncertain: [] };

export interface ResultBase {
  runId: string;
  commandIdentity: CommandIdentity | ControlIdentity;
  effectClass: "inspect";
  transactionState: "unchanged";
  effects: typeof INSPECT_EFFECTS;
  retryable: false;
  nextAction: string;
}

export interface SuccessResult extends ResultBase {
  outcome: "success";
  causeCode: "SUCCESS_UNCHANGED";
  failureClass: null;
  exitCode: 0;
  data: unknown;
  repairAction: null;
}

export interface StationResult extends ResultBase {
  outcome: Station["outcome"];
  causeCode: string;
  failureClass: Station["failureClass"];
  exitCode: Station["exitCode"];
  data: null;
  repairAction: string;
}

/** One Contract Core 2.0 machine envelope. */
export interface Envelope {
  envelopeVersion: 2;
  contractVersion: typeof CONTRACT_VERSION;
  message: string;
  availablePaths: string[];
  result: SuccessResult | StationResult;
}

function envelope(message: string, result: SuccessResult | StationResult): Envelope {
  return { envelopeVersion: 2, contractVersion: CONTRACT_VERSION, message, availablePaths: AVAILABLE_PATHS, result };
}

export function success(commandIdentity: ControlIdentity, data: unknown, message: string, nextAction: string): Envelope {
  return envelope(message, {
    runId: randomUUID(),
    commandIdentity,
    outcome: "success",
    effectClass: "inspect",
    transactionState: "unchanged",
    causeCode: "SUCCESS_UNCHANGED",
    failureClass: null,
    exitCode: 0,
    data,
    retryable: false,
    repairAction: null,
    effects: INSPECT_EFFECTS,
    nextAction,
  });
}

export function stationResult(commandIdentity: ControlIdentity, key: StationKey, message: string): Envelope {
  const station: Station = STATIONS[key];
  return envelope(message, {
    runId: randomUUID(),
    commandIdentity,
    outcome: station.outcome,
    effectClass: "inspect",
    transactionState: "unchanged",
    causeCode: station.causeCode,
    failureClass: station.failureClass,
    exitCode: station.exitCode,
    data: null,
    retryable: false,
    repairAction: station.repairAction,
    effects: INSPECT_EFFECTS,
    ...station.guidance,
  });
}

// ---- validated serialization ----

type Json = Record<string, unknown>;

const IDENTITIES: readonly string[] = COMMANDS.map((command) => command.commandIdentity);
const ENVELOPE_KEYS = ["availablePaths", "contractVersion", "envelopeVersion", "message", "result"];
const RESULT_KEYS = [
  "causeCode",
  "commandIdentity",
  "data",
  "effectClass",
  "effects",
  "exitCode",
  "failureClass",
  "nextAction",
  "outcome",
  "repairAction",
  "retryable",
  "runId",
  "transactionState",
];

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonblank(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function sameKeys(value: Json, keys: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function envelopeHolds(value: Json): boolean {
  if (!sameKeys(value, ENVELOPE_KEYS) || value.envelopeVersion !== 2 || value.contractVersion !== CONTRACT_VERSION) return false;
  return nonblank(value.message) && JSON.stringify(value.availablePaths) === JSON.stringify(AVAILABLE_PATHS);
}

function baseHolds(result: Json): boolean {
  if (!sameKeys(result, RESULT_KEYS) || !nonblank(result.runId) || !nonblank(result.nextAction)) return false;
  if (!IDENTITIES.includes(String(result.commandIdentity)) || result.retryable !== false) return false;
  if (result.effectClass !== "inspect" || result.transactionState !== "unchanged") return false;
  return JSON.stringify(result.effects) === JSON.stringify(INSPECT_EFFECTS);
}

function armHolds(result: Json): boolean {
  if (result.outcome === "success") {
    return result.causeCode === "SUCCESS_UNCHANGED" && result.failureClass === null && result.exitCode === 0 && result.repairAction === null;
  }
  const station: Station | undefined = Object.values(STATIONS).find((entry: Station) => entry.causeCode === result.causeCode);
  if (station === undefined || result.data !== null || result.repairAction !== station.repairAction) return false;
  return result.outcome === station.outcome && result.failureClass === station.failureClass && result.exitCode === station.exitCode;
}

/** Serializes, then validates the complete serialized value against the correlated result arms. Null means unsafe. */
export function serializeEnvelope(value: Envelope): string | null {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== "string") return null;
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || !envelopeHolds(parsed) || !isRecord(parsed.result)) return null;
    return baseHolds(parsed.result) && armHolds(parsed.result) ? `${text}\n` : null;
  } catch {
    return null;
  }
}

export function discoveryData() {
  return {
    contractVersion: CONTRACT_VERSION,
    generationConventionVersion: CONTRACT_VERSION,
    profile: "simple",
    commands: COMMANDS,
    exitMeanings: { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "transient" },
    signalExits: { "130": "SIGINT", "143": "SIGTERM" },
    effectExclusions: [
      "Never writes, moves or deletes a vault note, schema, script or configuration file.",
      "Never creates a Git commit, branch or worktree, and never runs Vault Steward.",
      "Never contacts a network service; check reads the canonical checkout's .gitignore through git check-ignore only.",
    ],
  };
}

/** check, list and inventory keep the vault's frozen output: no 2.0 envelope, and a two-valued exit. */
const LEGACY_OUTPUT_CONTRACT = {
  kind: "legacy",
  envelope: false,
  exitMeanings: { "0": "success", "1": "findings, refusal or failure; read the outcomes" },
};

export function commandDiscovery(commandIdentity: CommandIdentity) {
  return {
    command: COMMANDS.find((entry) => entry.commandIdentity === commandIdentity),
    semantics: "possible-outcomes",
    outputContract: LEGACY_OUTPUT_CONTRACT,
    outcomes: LEGACY_OUTCOMES[commandIdentity],
    ...(commandIdentity === "vault-notes.check" ? { findingIds: VAULT_FINDING_IDS } : {}),
  };
}

export function isCommandIdentity(value: string | undefined): value is CommandIdentity {
  return value === "vault-notes.check" || value === "vault-notes.list" || value === "vault-notes.inventory";
}
