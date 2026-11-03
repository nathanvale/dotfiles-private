// Closeout packet public entry point: strict argv, the read-only check, and the Contract Core 2.0 output path.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
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

const AVAILABLE_PATHS = [
  "closeout-packet.check",
  "closeout-packet.command-discovery",
  "closeout-packet.discovery",
  "closeout-packet.help",
];

function effects() {
  return {
    completed: [],
    inventoryComplete: true,
    remaining: [],
    uncertain: [],
  };
}

function success(commandIdentity: string, data: unknown, message: string) {
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
      nextAction: "No follow-up is required.",
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

type InternalFailureStationBase = {
  commandIdentity: "closeout-packet.check";
  effectClass: "inspect";
  exitCode: 1;
  failureClass: "internal";
  outcome: "failed";
  retryable: false;
  transactionState: "unchanged";
};

type Handoff = { inspect: string[]; owner: "operator"; reason: string };

// The check ran but its result could not be serialized: attempted, nothing changed, hand off rather than retry.
type SerializationFailureStation = InternalFailureStationBase & {
  causeCode: "INTERNAL_RESULT_UNCHANGED";
  handoff: Handoff;
  message: "The machine result could not be serialized.";
  repairAction: "Hand the serialization failure to an operator; nothing was changed.";
  trigger: "The machine check result cannot be serialized.";
};

type OutputEmissionFailureStation = InternalFailureStationBase & {
  causeCode: "INTERNAL_RESULT_EMISSION";
  message: "The check output could not be emitted.";
  nextAction: "Inspect the check output and retry closeout-packet check.";
  repairAction: "Inspect the check output stream before retrying.";
  trigger: "The check output cannot be emitted.";
};

type InternalFailureStation =
  | SerializationFailureStation
  | OutputEmissionFailureStation;

const SERIALIZATION_FAILURE_STATION: SerializationFailureStation = {
  commandIdentity: "closeout-packet.check",
  effectClass: "inspect",
  exitCode: 1,
  failureClass: "internal",
  causeCode: "INTERNAL_RESULT_UNCHANGED",
  handoff: {
    inspect: [
      "The packet and expected-context files named on the command line.",
      "The closeout-packet runtime and its Bun version.",
    ],
    owner: "operator",
    reason:
      "The check ran but its machine result could not be serialized; no input or state was changed.",
  },
  message: "The machine result could not be serialized.",
  outcome: "failed",
  repairAction:
    "Hand the serialization failure to an operator; nothing was changed.",
  retryable: false,
  transactionState: "unchanged",
  trigger: "The machine check result cannot be serialized.",
};

const OUTPUT_EMISSION_FAILURE_STATION: OutputEmissionFailureStation = {
  commandIdentity: "closeout-packet.check",
  effectClass: "inspect",
  exitCode: 1,
  failureClass: "internal",
  causeCode: "INTERNAL_RESULT_EMISSION",
  message: "The check output could not be emitted.",
  nextAction: "Inspect the check output and retry closeout-packet check.",
  outcome: "failed",
  repairAction: "Inspect the check output stream before retrying.",
  retryable: false,
  transactionState: "unchanged",
  trigger: "The check output cannot be emitted.",
};

function guidanceArm(
  station: InternalFailureStation,
): { handoff: Handoff } | { nextAction: string } {
  return "handoff" in station
    ? { handoff: station.handoff }
    : { nextAction: station.nextAction };
}

function internalFailure(station: InternalFailureStation) {
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
      ...guidanceArm(station),
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

function commandDiscovery() {
  return {
    command: COMMANDS[0],
    semantics: "possible-outcomes",
    stations: [
      {
        causeCode: "SUCCESS_UNCHANGED",
        commandIdentity: "closeout-packet.check",
        effectClass: "inspect",
        exitCode: 0,
        failureClass: null,
        guidance: { nextAction: "No follow-up is required." },
        outcome: "success",
        reachability: "required",
        repairAction: null,
        retryable: false,
        retryDelayPolicy: { kind: "none" },
        transactionState: "unchanged",
        trigger: "The closeout packet check completes.",
        unreachableRationale: null,
      },
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
      failureDiscoveryStation(SERIALIZATION_FAILURE_STATION),
      failureDiscoveryStation(OUTPUT_EMISSION_FAILURE_STATION),
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

function failureDiscoveryStation(station: InternalFailureStation) {
  return {
    causeCode: station.causeCode,
    commandIdentity: station.commandIdentity,
    effectClass: station.effectClass,
    exitCode: station.exitCode,
    failureClass: station.failureClass,
    guidance: guidanceArm(station),
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

function serialize(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function emit(value: string): void {
  process.stdout.write(value);
}

function render(value: unknown, json: boolean, human: string): void {
  emit(json ? serialize(value) : `${human}\n`);
}

let internalFailureReported = false;

function reportInternalFailureToStderr(
  failure: ReturnType<typeof internalFailure>,
): void {
  if (internalFailureReported) return;
  internalFailureReported = true;
  process.stderr.write(
    `${failure.message}\nRepair: ${failure.result.repairAction}\n`,
  );
}

function reportInternalFailure(
  station: InternalFailureStation,
  json: boolean,
): number {
  const failure = internalFailure(station);
  if (json) {
    try {
      render(failure, true, failure.message);
    } catch {
      reportInternalFailureToStderr(failure);
    }
  } else {
    reportInternalFailureToStderr(failure);
  }
  return 1;
}

let asynchronousStdoutFailure = false;

function reportAsynchronousStdoutFailure(): void {
  asynchronousStdoutFailure = true;
  process.exitCode = 1;
  reportInternalFailureToStderr(
    internalFailure(OUTPUT_EMISSION_FAILURE_STATION),
  );
}

async function main(argv: string[]): Promise<number> {
  const json = hasJson(argv);
  const args = argv.filter((value) => value !== "--json");
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    render(
      success(
        "closeout-packet.help",
        {
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
        },
        "Show help.",
      ),
      json,
      "Usage: closeout-packet check --packet PATH --expected PATH [--json]",
    );
    return 0;
  }
  if (args.length === 1 && args[0] === "--discover") {
    render(
      success("closeout-packet.discovery", discoveryData(), "Describe commands."),
      json,
      "Commands: check (inspect)",
    );
    return 0;
  }
  if (
    args[0] === "--discover-command" &&
    args[1] === "closeout-packet.check" &&
    args.length === 2
  ) {
    render(
      success(
        "closeout-packet.command-discovery",
        commandDiscovery(),
        "Describe closeout-packet.check.",
      ),
      json,
      "closeout-packet.check: success/unchanged",
    );
    return 0;
  }
  if (args[0] === "check") return checkCommand(args.slice(1), json);
  return emitRefusal(
    json,
    "USAGE_INVALID_INVOCATION",
    "Choose a supported command.",
  );
}

/** The `check` route: parse, load, check, then serialize and emit through the declared stations. */
function checkCommand(rest: string[], json: boolean): number {
  const parsed = checkArgs(rest);
  if (typeof parsed === "string")
    return emitRefusal(json, "USAGE_INVALID_INVOCATION", parsed);
  const loaded = loadInputs(parsed);
  if ("refusal" in loaded)
    return emitRefusal(json, loaded.refusal, loaded.message);
  process.stdout.on("error", reportAsynchronousStdoutFailure);
  const data = checkPacket(loaded.packet, loaded.expected);
  const result = success(
    "closeout-packet.check",
    data,
    `Closeout packet reporting is ${data.reporting} with ${data.findings.length} findings.`,
  );
  let output: string;
  try {
    output = json ? serialize(result) : renderHuman(data);
  } catch {
    return reportInternalFailure(SERIALIZATION_FAILURE_STATION, json);
  }
  try {
    emit(output);
  } catch {
    return reportInternalFailure(OUTPUT_EMISSION_FAILURE_STATION, json);
  }
  return 0;
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
  if (json) process.stdout.write(`${JSON.stringify(failure)}\n`);
  else
    process.stderr.write(
      `${message} Repair: ${failure.result.repairAction}\n`,
    );
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

type Loaded =
  | { packet: JsonObject; expected: JsonObject }
  | { refusal: RefusalCause; message: string };

function readObject(
  path: string,
  label: string,
): JsonObject | { refusal: RefusalCause; message: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT_READ_CODES.has(code))
      return {
        refusal: "TRANSIENT_NOT_STARTED",
        message: `The ${label} file could not be opened yet (${code}); nothing was checked.`,
      };
    return {
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
      refusal: "SCHEMA_INVALID_INPUT",
      message: `The ${label} file is not one JSON object.`,
    };
  return value;
}

function loadInputs(paths: CheckPaths): Loaded {
  const packet = readObject(paths.packet, "packet");
  if ("refusal" in packet && typeof packet.refusal === "string")
    return packet as Loaded;
  const expected = readObject(paths.expected, "expected-context");
  if ("refusal" in expected && typeof expected.refusal === "string")
    return expected as Loaded;
  return { packet, expected };
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
    "Structure only: this establishes no evidence truth, authority or native PASS.",
  ];
  return `${lines.join("\n")}\n`;
}

const exitCode = await main(process.argv.slice(2));
process.exitCode = asynchronousStdoutFailure ? 1 : exitCode;
