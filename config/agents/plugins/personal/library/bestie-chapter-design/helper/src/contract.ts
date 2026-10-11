import { randomUUID } from "node:crypto";

const CONTRACT_VERSION = "2.0.0";
export const CLI = "bestie-chapter-check";

export type OptionSpec = {
  name: string;
  valueName: string;
  required: boolean;
  summary: string;
};

export type CommandSpec = {
  commandIdentity: string;
  effectClass: "inspect";
  route: [string];
  summary: string;
  options: OptionSpec[];
  transient: boolean;
};

const req = (name: string, valueName: string, summary: string): OptionSpec => ({
  name,
  required: true,
  summary,
  valueName,
});
const opt = (name: string, valueName: string, summary: string): OptionSpec => ({
  name,
  required: false,
  summary,
  valueName,
});

const command = (
  name: string,
  summary: string,
  options: OptionSpec[],
  transient = false,
): CommandSpec => ({
  commandIdentity: `${CLI}.${name}`,
  effectClass: "inspect",
  options,
  route: [name],
  summary,
  transient,
});

/** The one typed owner of public commands, routes and options. */
export const COMMANDS: CommandSpec[] = [
  command("baseline", "Refuse a build whose binding differs from the active native baseline.", [
    req("--binding", "FILE", "Build binding: baseline, capture, source revision, art and copy resolution."),
    req("--live", "FILE", "Active-document readback: path, modified, page_count."),
  ]),
  command("protected", "Compare protected pages and typography before and after a build.", [
    req("--before", "FILE", "Format readback of the captured baseline."),
    req("--after", "FILE", "Format readback of the saved candidate."),
    req("--pages", "SPEC", "Protected pages: N, N-M or before>after, comma separated."),
  ]),
  command("copy", "Refuse stale build copy against the current selected blocks.", [
    req("--input", "FILE", "Copy resolution the build was prepared from."),
    req("--current", "FILE", "Copy resolution refreshed immediately before placement."),
  ]),
  command("story", "Prove a whole native story replacement and unchanged protected stories.", [
    req("--before", "FILE", "Story readback before replacement."),
    req("--after", "FILE", "Story readback after replacement."),
    req("--target", "KEY", "Replaced story: pPAGE:LABEL, or a label unique in both readbacks."),
    req("--expected", "FILE", "Selected text; paragraphs separated by one blank line."),
    opt("--emoji-font", "FONT", "The only permitted local font override, for emoji."),
  ]),
  command("geometry", "Check footers, page numbers, backgrounds, bleed, role fonts and reply headers.", [
    req("--snapshot", "FILE", "Format readback of every labelled page item, any object class."),
    req("--contract", "FILE", "Geometry contract derived from the book's production contract."),
  ]),
  command(
    "dispatch",
    "Refuse a native-control dispatch that already started, completed or recorded an error.",
    [
      req("--receipts", "DIR", "Operation folder holding started.txt, completed.txt or error.txt."),
      opt("--operation", "NAME", "Also match older <NAME>-started.txt receipts in a shared folder."),
      opt("--target", "FILE", "Fresh accessibility target with capturedAt. Required to clear a new dispatch; omit only to inspect existing receipts."),
      opt("--max-age-seconds", "N", "Oldest accepted target age; default 120."),
      opt("--settle-seconds", "N", "Wait window after a started receipt; default 30."),
      opt("--now", "ISO", "Evaluation time; default the current time."),
    ],
    true,
  ),
  command("handback", "Refuse a handback whose claims exceed its evidence.", [
    req("--record", "FILE", "Current handback record."),
  ]),
];

const AVAILABLE_PATHS = [
  ...COMMANDS.map((c) => c.commandIdentity),
  `${CLI}.command-discovery`,
  `${CLI}.discovery`,
  `${CLI}.help`,
].sort();

export const INVOCATION_IDENTITY = `${CLI}.invocation`;

/** Help, discovery and refusal identities that every envelope may carry. */
const META_COMMANDS = [
  { commandIdentity: `${CLI}.command-discovery`, effectClass: "inspect", route: ["--discover-command"], summary: "Describe one command's possible stations." },
  { commandIdentity: `${CLI}.discovery`, effectClass: "inspect", route: ["--discover"], summary: "Describe every command." },
  { commandIdentity: `${CLI}.help`, effectClass: "inspect", route: ["--help"], summary: "Show usage and options." },
  { commandIdentity: INVOCATION_IDENTITY, effectClass: "inspect", route: [], summary: "Refuse a missing or unknown command." },
];

export type Guidance =
  | { nextAction: string }
  | {
      handoff: { inspect: readonly string[]; owner: "operator"; reason: string };
    };

export type Cause = {
  causeCode: string;
  exitCode: number;
  failureClass: string | null;
  outcome: "success" | "refused" | "failed";
  retryable: boolean;
};

export const CAUSES = {
  checkFailed: { causeCode: "DOMAIN_CHECK_FAILED", exitCode: 3, failureClass: "domain", outcome: "refused", retryable: false },
  internal: { causeCode: "INTERNAL_UNEXPECTED", exitCode: 1, failureClass: "internal", outcome: "failed", retryable: false },
  invalidInput: { causeCode: "SCHEMA_INVALID_INPUT", exitCode: 4, failureClass: "schema", outcome: "refused", retryable: false },
  invalidInvocation: { causeCode: "USAGE_INVALID_INVOCATION", exitCode: 2, failureClass: "usage", outcome: "refused", retryable: false },
  missingInput: { causeCode: "DOMAIN_PRECONDITION_UNMET", exitCode: 3, failureClass: "domain", outcome: "refused", retryable: false },
  success: { causeCode: "SUCCESS_UNCHANGED", exitCode: 0, failureClass: null, outcome: "success", retryable: false },
  transient: { causeCode: "TRANSIENT_NOT_STARTED", exitCode: 75, failureClass: "transient", outcome: "refused", retryable: true },
  unknownCommand: { causeCode: "USAGE_UNKNOWN_COMMAND", exitCode: 2, failureClass: "usage", outcome: "refused", retryable: false },
} as const satisfies Record<string, Cause>;

export const INTERNAL_HANDOFF = {
  handoff: {
    inspect: ["The command's input files", "The helper bundle version"],
    owner: "operator",
    reason: "The check stopped on an unexpected runtime error before a verdict.",
  },
} as const;

export function envelope(options: {
  commandIdentity: string;
  cause: Cause;
  message: string;
  data: unknown;
  repairAction: string | null;
  guidance: Guidance;
  retryDelayMilliseconds?: number;
}) {
  const { cause } = options;
  return {
    availablePaths: AVAILABLE_PATHS,
    contractVersion: CONTRACT_VERSION,
    envelopeVersion: 2,
    message: options.message,
    result: {
      causeCode: cause.causeCode,
      commandIdentity: options.commandIdentity,
      data: cause.outcome === "success" ? options.data : null,
      effectClass: "inspect",
      effects: { completed: [], inventoryComplete: true, remaining: [], uncertain: [] },
      exitCode: cause.exitCode,
      failureClass: cause.failureClass,
      outcome: cause.outcome,
      repairAction: options.repairAction,
      retryable: cause.retryable,
      runId: randomUUID(),
      transactionState: "unchanged",
      ...options.guidance,
      ...(options.retryDelayMilliseconds === undefined
        ? {}
        : { retryDelayMilliseconds: options.retryDelayMilliseconds }),
    },
  };
}

export function discoveryData() {
  return {
    commands: [
      ...COMMANDS.map(({ commandIdentity, effectClass, route, summary }) => ({
        commandIdentity,
        effectClass,
        route,
        summary,
      })),
      ...META_COMMANDS,
    ],
    contractVersion: CONTRACT_VERSION,
    effectExclusions: [
      "Every command only reads its named files; it never changes native documents, Canva, the vault or receipts.",
      "A passing check is not native execution, visual acceptance, Print PASS or Nathan's approval.",
    ],
    exitMeanings: { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "transient" },
    generationConventionVersion: CONTRACT_VERSION,
    profile: "simple",
    signalExits: { "130": "SIGINT", "143": "SIGTERM" },
  };
}

function station(identity: string, cause: Cause, trigger: string, guidance: Guidance, repairAction: string | null) {
  return {
    causeCode: cause.causeCode,
    commandIdentity: identity,
    effectClass: "inspect",
    exitCode: cause.exitCode,
    failureClass: cause.failureClass,
    guidance: "nextAction" in guidance ? { nextAction: guidance.nextAction } : { handoff: guidance.handoff },
    outcome: cause.outcome,
    reachability: "required",
    repairAction,
    retryable: cause.retryable,
    retryDelayPolicy: cause.retryable ? { kind: "bounded", maximumMilliseconds: 600000 } : { kind: "none" },
    transactionState: "unchanged",
    trigger,
    unreachableRationale: null,
  };
}

export function commandStations(spec: CommandSpec) {
  const id = spec.commandIdentity;
  const next = (nextAction: string) => ({ nextAction });
  const stations = [
    station(id, CAUSES.success, "Every check passes.", next("Record the passing verdict with the run evidence."), null),
    station(id, CAUSES.checkFailed, "One or more checks fail.", next("Repair the listed issues and rerun the command."), "Repair the listed issues."),
    station(id, CAUSES.missingInput, "A named input path is absent.", next("Create or locate the input, then rerun."), "Supply an existing input path."),
    station(id, CAUSES.invalidInput, "An input file is not valid JSON or lacks required fields.", next("Correct the input shape, then rerun."), "Correct the input file."),
    station(id, CAUSES.invalidInvocation, "A required option is missing or unknown.", next(`Run ${CLI} --help and supply every required option.`), "Supply the required options."),
    station(id, CAUSES.internal, "An unexpected runtime error stops the check.", INTERNAL_HANDOFF, "Inspect the runtime error before retrying."),
  ];
  if (spec.transient) {
    stations.push(
      station(id, CAUSES.transient, "A started receipt is inside its settle window.", next("Wait, then rerun dispatch."), "Wait for the settle window."),
    );
  }
  return {
    command: { commandIdentity: id, effectClass: spec.effectClass, route: spec.route, summary: spec.summary },
    semantics: "possible-outcomes",
    stations,
  };
}
