// Closeout packet public entry point: strict argv, the read-only check, and the Contract Core 2.0 output path.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { encodeEnvelope } from "./envelope.ts";
import { checkPacket, isPacketRecord, type JsonObject } from "./packet.ts";

const CONTRACT_VERSION = "2.0.0";
const COMMANDS = [
  {
    commandIdentity: "closeout-packet.check",
    effectClass: "inspect",
    route: ["check"],
    summary:
      "Compare one closeout packet with its separately supplied expected context; changes nothing.",
  },
  {
    commandIdentity: "closeout-packet.command-discovery",
    effectClass: "inspect",
    route: ["--discover-command"],
    summary: "Describe one command's possible stations.",
  },
  {
    commandIdentity: "closeout-packet.discovery",
    effectClass: "inspect",
    route: ["--discover"],
    summary: "Describe the contract, commands and effect exclusions.",
  },
  {
    commandIdentity: "closeout-packet.dispatch",
    effectClass: "inspect",
    route: [],
    summary: "Refuse an unsupported invocation with repair guidance.",
  },
  {
    commandIdentity: "closeout-packet.help",
    effectClass: "inspect",
    route: ["--help"],
    summary: "Show usage and options.",
  },
] as const;

const DECLARED_COMMANDS: ReadonlySet<string> = new Set(
  COMMANDS.map((command) => command.commandIdentity),
);

const AVAILABLE_PATHS = [
  "closeout-packet.check",
  "closeout-packet.command-discovery",
  "closeout-packet.discovery",
  "closeout-packet.help",
];

const NO_FOLLOW_UP = "No follow-up is required.";

// A completed check's guidance follows its verdict; it never implies the proposal may proceed.
const CHECK_GUIDANCE = {
  repair:
    "Repair each listed finding in the packet or expected context, then rerun closeout-packet check.",
  resolve:
    "Resolve each hold, failed or missing proof and unknown with its named owner before requesting the action; this check approves nothing.",
  review:
    "Complete original-record review of the inventory, evidence and grants before relying on this structural result.",
} as const;

function checkGuidance(data: ReturnType<typeof checkPacket>): string {
  if (data.reporting !== "complete") return CHECK_GUIDANCE.repair;
  return data.actionability === "blocked"
    ? CHECK_GUIDANCE.resolve
    : CHECK_GUIDANCE.review;
}

function effects() {
  return {
    completed: [],
    inventoryComplete: true,
    remaining: [],
    uncertain: [],
  };
}

function success(
  commandIdentity: string,
  data: unknown,
  message: string,
  nextAction: string = NO_FOLLOW_UP,
) {
  return {
    availablePaths: AVAILABLE_PATHS,
    contractVersion: CONTRACT_VERSION,
    envelopeVersion: 2,
    message,
    result: {
      causeCode: "SUCCESS_UNCHANGED",
      commandIdentity,
      data,
      effectClass: "inspect",
      effects: effects(),
      exitCode: 0,
      failureClass: null,
      nextAction,
      outcome: "success",
      repairAction: null,
      retryable: false,
      runId: randomUUID(),
      transactionState: "unchanged",
    },
  };
}

function refusal(message: string, causeCode: RefusalCause) {
  const row = REFUSALS[causeCode];
  return {
    availablePaths: AVAILABLE_PATHS,
    contractVersion: CONTRACT_VERSION,
    envelopeVersion: 2,
    message,
    result: {
      causeCode,
      commandIdentity:
        causeCode === "USAGE_INVALID_INVOCATION"
          ? "closeout-packet.dispatch"
          : "closeout-packet.check",
      data: null,
      effectClass: "inspect",
      effects: effects(),
      exitCode: row.exitCode,
      failureClass: row.failureClass,
      nextAction: REFUSAL_NEXT_ACTION,
      outcome: "refused",
      repairAction: row.repairAction,
      ...retryArm(causeCode),
      runId: randomUUID(),
      transactionState: "unchanged",
    },
  };
}

function retryArm(
  causeCode: RefusalCause,
): { retryable: false } | { retryable: true; retryDelayMilliseconds: number } {
  return causeCode === "TRANSIENT_NOT_STARTED"
    ? {
        retryable: true,
        retryDelayMilliseconds: TRANSIENT_RETRY_DELAY_MILLISECONDS,
      }
    : { retryable: false };
}

type Handoff = { inspect: string[]; owner: "operator"; reason: string };

// The one application-controlled internal station: the check ran, but its machine result could not be serialized or
// failed final envelope validation. Attempted, nothing changed, so it hands off rather than retries. A stdout transport
// failure is not this station: it is the no-envelope exception and emits nothing further.
const SERIALIZATION_FAILURE_STATION = {
  causeCode: "INTERNAL_RESULT_UNCHANGED",
  commandIdentity: "closeout-packet.check",
  effectClass: "inspect",
  exitCode: 1,
  failureClass: "internal",
  handoff: {
    inspect: [
      "The packet and expected-context files named on the command line.",
      "The closeout-packet runtime and its Bun version.",
    ],
    owner: "operator",
    reason:
      "The check ran but its machine result could not be serialized; no input or state was changed.",
  } satisfies Handoff,
  message: "The machine result could not be serialized.",
  outcome: "failed",
  repairAction:
    "Hand the serialization failure to an operator; nothing was changed.",
  retryable: false,
  transactionState: "unchanged",
  trigger:
    "The machine check result cannot be serialized or fails final envelope validation.",
} as const;

function internalFailure() {
  const station = SERIALIZATION_FAILURE_STATION;
  return {
    availablePaths: AVAILABLE_PATHS,
    contractVersion: CONTRACT_VERSION,
    envelopeVersion: 2,
    message: station.message,
    result: {
      causeCode: station.causeCode,
      commandIdentity: station.commandIdentity,
      data: null,
      effectClass: station.effectClass,
      effects: effects(),
      exitCode: station.exitCode,
      failureClass: station.failureClass,
      handoff: station.handoff,
      outcome: station.outcome,
      repairAction: station.repairAction,
      retryable: station.retryable,
      runId: randomUUID(),
      transactionState: station.transactionState,
    },
  };
}

function discoveryData() {
  return {
    commands: COMMANDS,
    contractVersion: CONTRACT_VERSION,
    effectExclusions: [
      "Reads only the two named JSON files; no native task, credential, network, process or write effect.",
    ],
    exitMeanings: {
      "0": "success",
      "1": "internal",
      "2": "usage",
      "3": "domain",
      "4": "schema",
      "75": "transient",
    },
    generationConventionVersion: CONTRACT_VERSION,
    profile: "simple",
    signalExits: { "130": "SIGINT", "143": "SIGTERM" },
  };
}

function successDiscoveryStation(nextAction: string, trigger: string) {
  return {
    causeCode: "SUCCESS_UNCHANGED",
    commandIdentity: "closeout-packet.check",
    effectClass: "inspect",
    exitCode: 0,
    failureClass: null,
    guidance: { nextAction },
    outcome: "success",
    reachability: "required",
    repairAction: null,
    retryable: false,
    retryDelayPolicy: { kind: "none" },
    transactionState: "unchanged",
    trigger,
    unreachableRationale: null,
  };
}

function commandDiscovery() {
  return {
    command: COMMANDS[0],
    semantics: "possible-outcomes",
    stations: [
      successDiscoveryStation(
        CHECK_GUIDANCE.repair,
        "The check completes and reports findings or an identity inconsistency.",
      ),
      successDiscoveryStation(
        CHECK_GUIDANCE.resolve,
        "The check completes with complete reporting, but a hold, failed or missing proof, or incomplete coverage blocks the action.",
      ),
      successDiscoveryStation(
        CHECK_GUIDANCE.review,
        "The check completes with complete reporting that structurally supports the requested action.",
      ),
      refusalDiscoveryStation(
        "DOMAIN_PRECONDITION_UNMET",
        "A named packet or expected-context file cannot be read.",
      ),
      refusalDiscoveryStation(
        "SCHEMA_INVALID_INPUT",
        "A named input file is not one JSON object.",
      ),
      refusalDiscoveryStation(
        "TRANSIENT_NOT_STARTED",
        "A named input file read fails with EAGAIN, EBUSY, EMFILE or ENFILE before any check.",
      ),
      failureDiscoveryStation(),
    ],
  };
}

function refusalDiscoveryStation(
  causeCode:
    | "DOMAIN_PRECONDITION_UNMET"
    | "SCHEMA_INVALID_INPUT"
    | "TRANSIENT_NOT_STARTED",
  trigger: string,
) {
  const row = REFUSALS[causeCode];
  const transient = causeCode === "TRANSIENT_NOT_STARTED";
  return {
    causeCode,
    commandIdentity: "closeout-packet.check",
    effectClass: "inspect",
    exitCode: row.exitCode,
    failureClass: row.failureClass,
    guidance: { nextAction: REFUSAL_NEXT_ACTION },
    outcome: "refused",
    reachability: "required",
    repairAction: row.repairAction,
    retryable: transient,
    retryDelayPolicy: transient
      ? { kind: "fixed", milliseconds: TRANSIENT_RETRY_DELAY_MILLISECONDS }
      : { kind: "none" },
    transactionState: "unchanged",
    trigger,
    unreachableRationale: null,
  };
}

const REFUSAL_NEXT_ACTION =
  "Run closeout-packet --help and choose a listed command.";

function failureDiscoveryStation() {
  const station = SERIALIZATION_FAILURE_STATION;
  return {
    causeCode: station.causeCode,
    commandIdentity: station.commandIdentity,
    effectClass: station.effectClass,
    exitCode: station.exitCode,
    failureClass: station.failureClass,
    guidance: { handoff: station.handoff },
    outcome: station.outcome,
    reachability: "required",
    repairAction: station.repairAction,
    retryable: station.retryable,
    retryDelayPolicy: { kind: "none" },
    transactionState: station.transactionState,
    trigger: station.trigger,
    unreachableRationale: null,
  };
}

function hasJson(argv: string[]): boolean {
  const separator = argv.indexOf("--");
  const options = separator === -1 ? argv : argv.slice(0, separator);
  return options.includes("--json");
}

/** Writes once to stdout; false means the transport failed synchronously. */
function writeStdout(text: string): boolean {
  try {
    process.stdout.write(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Machine output: exactly one validated envelope. An unserializable or invalid candidate is replaced by the bounded
 * internal fallback before anything is written. A stdout transport failure is the no-envelope exception: nothing goes
 * to stderr and no replacement envelope follows.
 */
function emitMachine(candidate: { result: { exitCode: number } }): number {
  const primary = encodeEnvelope(candidate, DECLARED_COMMANDS);
  const encoded = primary ?? encodeEnvelope(internalFailure(), DECLARED_COMMANDS);
  if (encoded === null || !writeStdout(encoded)) return 1;
  return primary === null ? 1 : candidate.result.exitCode;
}

const HUMAN_EMISSION_REPAIR =
  "The check output could not be emitted.\nRepair: Inspect the check output stream before retrying.\n";

let humanEmissionReported = false;

function reportHumanEmissionFailure(): void {
  if (humanEmissionReported) return;
  humanEmissionReported = true;
  process.stderr.write(HUMAN_EMISSION_REPAIR);
}

/** Human output: the text on stdout, or the repair on stderr when stdout cannot take it. */
function emitHuman(text: string): number {
  if (writeStdout(text)) return 0;
  reportHumanEmissionFailure();
  return 1;
}

function emitSuccess(
  json: boolean,
  envelope: ReturnType<typeof success>,
  human: string,
): number {
  return json ? emitMachine(envelope) : emitHuman(`${human}\n`);
}

let asynchronousStdoutFailure = false;

/** A late stdout error (for example EPIPE after the reader closed). Machine mode stays silent on stderr. */
function onAsynchronousStdoutFailure(json: boolean): void {
  asynchronousStdoutFailure = true;
  process.exitCode = 1;
  if (!json) reportHumanEmissionFailure();
}

const HELP_DATA = {
  commands: COMMANDS,
  options: [
    {
      name: "--packet",
      summary: "The closeout packet JSON file to check.",
      valueName: "PATH",
    },
    {
      name: "--expected",
      summary:
        "The separately sourced expected context and obligation inventory JSON file.",
      valueName: "PATH",
    },
    {
      name: "--json",
      summary: "Emit one Contract Core envelope.",
      valueName: null,
    },
  ],
  summary: "Read-only closeout packet completeness check.",
  usage: "closeout-packet check --packet PATH --expected PATH [--json]",
};

async function main(argv: string[]): Promise<number> {
  const json = hasJson(argv);
  process.stdout.on("error", () => onAsynchronousStdoutFailure(json));
  const args = argv.filter((value) => value !== "--json");
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h"))
    return emitSuccess(
      json,
      success("closeout-packet.help", HELP_DATA, "Show help."),
      "Usage: closeout-packet check --packet PATH --expected PATH [--json]",
    );
  if (args.length === 1 && args[0] === "--discover")
    return emitSuccess(
      json,
      success("closeout-packet.discovery", discoveryData(), "Describe commands."),
      "Commands: check (inspect)",
    );
  if (
    args[0] === "--discover-command" &&
    args[1] === "closeout-packet.check" &&
    args.length === 2
  )
    return emitSuccess(
      json,
      success(
        "closeout-packet.command-discovery",
        commandDiscovery(),
        "Describe closeout-packet.check.",
      ),
      "closeout-packet.check: success/unchanged",
    );
  if (args[0] === "check") return checkCommand(args.slice(1), json);
  return emitRefusal(
    json,
    "USAGE_INVALID_INVOCATION",
    "Choose a supported command.",
  );
}

/** The `check` route: parse, load, check, then emit through the validated output path. */
function checkCommand(rest: string[], json: boolean): number {
  const parsed = checkArgs(rest);
  if (typeof parsed === "string")
    return emitRefusal(json, "USAGE_INVALID_INVOCATION", parsed);
  const loaded = loadInputs(parsed);
  if (!loaded.ok) return emitRefusal(json, loaded.refusal, loaded.message);
  const data = checkPacket(loaded.packet, loaded.expected);
  const result = success(
    "closeout-packet.check",
    data,
    `Closeout packet reporting is ${data.reporting} with ${data.findings.length} findings.`,
    checkGuidance(data),
  );
  return json ? emitMachine(result) : emitHuman(renderHuman(data));
}

type RefusalCause = keyof typeof REFUSALS;

// Resource-exhaustion and busy errnos on the input read: nothing was checked, so a bounded retry may succeed.
// ENOENT, EACCES and every other read failure stay DOMAIN_PRECONDITION_UNMET.
const TRANSIENT_READ_CODES = new Set(["EAGAIN", "EBUSY", "EMFILE", "ENFILE"]);
const TRANSIENT_RETRY_DELAY_MILLISECONDS = 1000;

const REFUSALS = {
  TRANSIENT_NOT_STARTED: {
    exitCode: 75,
    failureClass: "transient",
    repairAction:
      "Retry after the stated delay; the input file could not be opened yet.",
  },
  DOMAIN_PRECONDITION_UNMET: {
    exitCode: 3,
    failureClass: "domain",
    repairAction: "Name readable packet and expected-context files.",
  },
  SCHEMA_INVALID_INPUT: {
    exitCode: 4,
    failureClass: "schema",
    repairAction: "Supply each input as one JSON object.",
  },
  USAGE_INVALID_INVOCATION: {
    exitCode: 2,
    failureClass: "usage",
    repairAction: "Choose one supported command and retry.",
  },
} as const;

function emitRefusal(
  json: boolean,
  causeCode: RefusalCause,
  message: string,
): number {
  const failure = refusal(message, causeCode);
  if (json) return emitMachine(failure);
  process.stderr.write(`${message} Repair: ${failure.result.repairAction}\n`);
  return failure.result.exitCode;
}

interface CheckPaths {
  packet: string;
  expected: string;
}

function checkArgs(rest: string[]): CheckPaths | string {
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index] as string;
    const value = rest[index + 1];
    if (
      (name !== "--packet" && name !== "--expected") ||
      value === undefined ||
      values.has(name)
    )
      return "check takes exactly --packet PATH and --expected PATH.";
    values.set(name, value);
  }
  const packet = values.get("--packet");
  const expected = values.get("--expected");
  if (packet === undefined || expected === undefined)
    return "check needs both --packet PATH and --expected PATH.";
  return { packet, expected };
}

// Loading results are tagged by the loader itself; nothing is inferred from properties of the external JSON.
type LoadRefusal = { ok: false; refusal: RefusalCause; message: string };
type ReadResult = { ok: true; value: JsonObject } | LoadRefusal;
type Loaded =
  | { ok: true; packet: JsonObject; expected: JsonObject }
  | LoadRefusal;

function readObject(path: string, label: string): ReadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT_READ_CODES.has(code))
      return {
        ok: false,
        refusal: "TRANSIENT_NOT_STARTED",
        message: `The ${label} file could not be opened yet (${code}); nothing was checked.`,
      };
    return {
      ok: false,
      refusal: "DOMAIN_PRECONDITION_UNMET",
      message: `The ${label} file cannot be read.`,
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = null;
  }
  if (!isPacketRecord(value))
    return {
      ok: false,
      refusal: "SCHEMA_INVALID_INPUT",
      message: `The ${label} file is not one JSON object.`,
    };
  return { ok: true, value };
}

function loadInputs(paths: CheckPaths): Loaded {
  const packet = readObject(paths.packet, "packet");
  if (!packet.ok) return packet;
  const expected = readObject(paths.expected, "expected-context");
  if (!expected.ok) return expected;
  return { ok: true, packet: packet.value, expected: expected.value };
}

function renderHuman(data: ReturnType<typeof checkPacket>): string {
  const lines = [
    `Reporting: ${data.reporting}. Actionability: ${data.actionability}.`,
    ...data.findings.map(
      (finding) => `${finding.code} ${finding.path}: ${finding.repair}`,
    ),
    ...data.unknowns.map(
      (unknown) =>
        `Unknown ${unknown.path}: owner ${unknown.owner ?? "unnamed"}, next ${unknown.nextSafeStep ?? "unnamed"}.`,
    ),
    `Next: ${checkGuidance(data)}`,
    "Structure only: this establishes no evidence truth, authority or native PASS.",
  ];
  return `${lines.join("\n")}\n`;
}

const exitCode = await main(process.argv.slice(2));
process.exitCode = asynchronousStdoutFailure ? 1 : exitCode;
