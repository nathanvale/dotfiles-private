// @bun
// packages/closeout-packet/src/cli.ts
import { randomUUID } from "crypto";
import fs from "fs";

// packages/closeout-packet/src/envelope.ts
var CAUSES = {
  SUCCESS_UNCHANGED: { exitCode: 0, failureClass: null, guidance: "nextAction", outcome: "success", retryable: false },
  USAGE_INVALID_INVOCATION: { exitCode: 2, failureClass: "usage", guidance: "nextAction", outcome: "refused", retryable: false },
  DOMAIN_PRECONDITION_UNMET: { exitCode: 3, failureClass: "domain", guidance: "nextAction", outcome: "refused", retryable: false },
  SCHEMA_INVALID_INPUT: { exitCode: 4, failureClass: "schema", guidance: "nextAction", outcome: "refused", retryable: false },
  TRANSIENT_NOT_STARTED: { exitCode: 75, failureClass: "transient", guidance: "nextAction", outcome: "refused", retryable: true },
  INTERNAL_RESULT_UNCHANGED: { exitCode: 1, failureClass: "internal", guidance: "handoff", outcome: "failed", retryable: false }
};
var TOP_KEYS = ["availablePaths", "contractVersion", "envelopeVersion", "message", "result"];
var RESULT_KEYS = [
  "causeCode",
  "commandIdentity",
  "data",
  "effectClass",
  "effects",
  "exitCode",
  "failureClass",
  "outcome",
  "repairAction",
  "retryable",
  "runId",
  "transactionState"
];
var OPTIONAL_RESULT_KEYS = ["handoff", "nextAction", "retryDelayMilliseconds"];
var isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var isNonblank = (value) => typeof value === "string" && value.trim() !== "";
var isStrings = (value) => Array.isArray(value) && value.every((entry) => typeof entry === "string");
function sortedUnique(values) {
  return values.every((value, index) => index === 0 || values[index - 1] < value);
}
function topValid(value, commands) {
  const paths = value.availablePaths;
  return Object.keys(value).sort().join() === TOP_KEYS.join() && value.contractVersion === "2.0.0" && value.envelopeVersion === 2 && isNonblank(value.message) && isStrings(paths) && sortedUnique(paths) && paths.every((path) => commands.has(path));
}
function keysValid(result) {
  const keys = Object.keys(result);
  return RESULT_KEYS.every((key) => keys.includes(key)) && keys.every((key) => RESULT_KEYS.includes(key) || OPTIONAL_RESULT_KEYS.includes(key));
}
function effectsValid(effects) {
  return isObject(effects) && Object.keys(effects).sort().join() === "completed,inventoryComplete,remaining,uncertain" && effects.inventoryComplete === true && [effects.completed, effects.remaining, effects.uncertain].every((list) => Array.isArray(list) && list.length === 0);
}
var HANDOFF_KEYS = ["inspect", "owner", "reason", "resource"];
function resourceValid(resource) {
  return isObject(resource) && Object.keys(resource).sort().join() === "id,kind" && isNonblank(resource.id) && isNonblank(resource.kind);
}
function handoffValid(handoff) {
  if (!isObject(handoff) || !Object.keys(handoff).every((key) => HANDOFF_KEYS.includes(key)))
    return false;
  if (handoff.owner !== "human" && handoff.owner !== "operator" || !isNonblank(handoff.reason))
    return false;
  const inspect = handoff.inspect;
  if (!isStrings(inspect) || inspect.length === 0 || !inspect.every(isNonblank))
    return false;
  return !("resource" in handoff) || resourceValid(handoff.resource);
}
function guidanceValid(result, row) {
  const hasNext = "nextAction" in result;
  if (hasNext === "handoff" in result)
    return false;
  if (row.guidance === "nextAction")
    return hasNext && isNonblank(result.nextAction);
  return !hasNext && handoffValid(result.handoff);
}
function retryValid(result, row) {
  if (result.retryable !== row.retryable)
    return false;
  if (!row.retryable)
    return !("retryDelayMilliseconds" in result);
  const delay = result.retryDelayMilliseconds;
  return typeof delay === "number" && Number.isSafeInteger(delay) && delay > 0;
}
function outcomeValid(result, row) {
  if (row.outcome === "success")
    return result.repairAction === null;
  return result.data === null && isNonblank(result.repairAction);
}
function resultValid(result, commands) {
  if (!isObject(result) || !keysValid(result))
    return false;
  const row = typeof result.causeCode === "string" ? CAUSES[result.causeCode] : undefined;
  if (row === undefined)
    return false;
  return typeof result.commandIdentity === "string" && commands.has(result.commandIdentity) && isNonblank(result.runId) && result.effectClass === "inspect" && result.transactionState === "unchanged" && result.outcome === row.outcome && result.failureClass === row.failureClass && result.exitCode === row.exitCode && effectsValid(result.effects) && guidanceValid(result, row) && retryValid(result, row) && outcomeValid(result, row);
}
function encodeEnvelope(candidate, commands) {
  let encoded;
  try {
    encoded = JSON.stringify(candidate);
  } catch {
    return null;
  }
  if (typeof encoded !== "string")
    return null;
  const emitted = JSON.parse(encoded);
  if (!isObject(emitted) || !topValid(emitted, commands) || !resultValid(emitted.result, commands))
    return null;
  return `${encoded}
`;
}

// packages/closeout-packet/src/packet.ts
var IDENTITY_FIELDS = ["host", "project", "task", "candidate"];
var PACKET_FIELDS = [
  "identity",
  "outcome",
  "evidence",
  "downstream",
  "unresolved",
  "decision"
];
var EVIDENCE_STATUSES = new Set([
  "fresh",
  "carried",
  "cache",
  "failed",
  "missing",
  "not-applicable"
]);
var BLOCKING_STATUSES = new Set(["failed", "missing"]);
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
function texts(value) {
  return Array.isArray(value) && value.every((item) => text(item) !== null) ? value : null;
}
function records(value) {
  return Array.isArray(value) && value.every(isRecord) ? value : null;
}

class Findings {
  list = [];
  add(code, path, repair) {
    this.list.push({ code, path, repair });
  }
  requireText(source, key, path) {
    const value = text(source[key]);
    if (value === null)
      this.add("FIELD_MISSING", `${path}.${key}`, `Record ${path}.${key}.`);
    return value;
  }
}
function checkExpectedIdentity(expected, findings) {
  const identity = isRecord(expected.identity) ? expected.identity : {};
  const observation = isRecord(expected.observation) ? expected.observation : {};
  const resolved = {};
  const required = [
    ...IDENTITY_FIELDS.map((key) => [identity, key, `expected.identity.${key}`]),
    [observation, "source", "expected.observation.source"],
    [observation, "at", "expected.observation.at"]
  ];
  for (const [source, key, path] of required) {
    const value = text(source[key]);
    if (value === null)
      findings.add("EXPECTED_CONTEXT_MISSING", path, "Supply it from a separately identified owner observation, not from the packet.");
    else
      resolved[path] = value;
  }
  return Object.keys(resolved).length === required.length ? resolved : null;
}
function checkIdentity(packet, expected, findings) {
  const identity = packet.identity;
  for (const key of [...IDENTITY_FIELDS, "observedAt", "executionOwner"]) {
    findings.requireText(identity, key, "identity");
  }
  if (expected === null)
    return;
  for (const key of IDENTITY_FIELDS) {
    const actual = text(identity[key]);
    if (actual !== null && actual !== expected[`expected.identity.${key}`])
      findings.add("IDENTITY_MISMATCH", `identity.${key}`, "Reconcile the packet with the independent expected context before relying on it.");
  }
}
function checkOutcome(packet, findings) {
  const outcome = packet.outcome;
  findings.requireText(outcome, "scopedResult", "outcome");
  findings.requireText(outcome, "proposedDisposition", "outcome");
  if (texts(outcome.limits) === null)
    findings.add("FIELD_MISSING", "outcome.limits", "List the disposition's limits.");
  if (text(outcome.nativeState) === null)
    findings.add("NATIVE_STATE_UNDECLARED", "outcome.nativeState", "State the actual native state beside the proposed disposition.");
}
function inventoryOf(expected, findings) {
  const inventory = isRecord(expected.inventory) ? expected.inventory : {};
  const obligations = texts(inventory.obligations);
  const bound = text(inventory.source) !== null && text(inventory.revision) !== null && inventory.complete === true && obligations !== null;
  if (!bound)
    findings.add("INVENTORY_UNBOUND", "expected.inventory", "Bind a complete obligation inventory to its source and revision; a partial inventory remains a coverage gap.");
  return { obligations: obligations ?? [], bound };
}
function checkEvidenceItem(item, path, candidate, findings) {
  const status = text(item.status);
  const keys = status === "not-applicable" ? ["obligation", "justification"] : ["subject", "sourceCandidate", "obligation", "reportPointer"];
  const unbound = status === null || !EVIDENCE_STATUSES.has(status) || keys.some((key) => text(item[key]) === null);
  if (unbound)
    findings.add("EVIDENCE_BINDING_MISSING", path, "Name the subject, source candidate, supported obligation, original report pointer and execution status.");
  const source = text(item.sourceCandidate);
  if (status !== "not-applicable" && source !== null && candidate !== null && source !== candidate)
    findings.add("REUSE_UNQUALIFIED", path, "Cross-candidate reuse stays incomplete until its applicability assessment is qualified (T02).");
}
function checkEvidence(packet, inventory, candidate, findings) {
  const { obligations, bound } = inventory;
  const items = records(packet.evidence);
  if (items === null || items.length === 0 && obligations.length > 0) {
    findings.add("FIELD_MISSING", "evidence", "Account for every obligation.");
    return [];
  }
  for (const [index, item] of items.entries()) {
    checkEvidenceItem(item, `evidence[${index}]`, candidate, findings);
  }
  const accounted = new Set;
  for (const [index, item] of items.entries()) {
    const obligation = text(item.obligation);
    if (obligation === null)
      continue;
    if (bound && !obligations.includes(obligation))
      findings.add("EVIDENCE_BINDING_MISSING", `evidence[${index}].obligation`, "Reconcile this evidence obligation with the independently bound inventory.");
    if (accounted.has(obligation))
      findings.add("EVIDENCE_BINDING_MISSING", `evidence[${index}].obligation`, "Record exactly one evidence outcome per obligation; reconcile duplicate entries.");
    accounted.add(obligation);
  }
  for (const obligation of obligations) {
    if (!accounted.has(obligation))
      findings.add("OBLIGATION_UNACCOUNTED", `evidence:${obligation}`, "Record its evidence outcome, explicit missing proof or justified non-applicability.");
  }
  return items;
}
function checkDownstream(packet, findings, unknowns) {
  const downstream = packet.downstream;
  const coverage = text(downstream.coverage);
  if (coverage === "complete") {
    if (records(downstream.effects) === null && texts(downstream.effects) === null)
      findings.add("FIELD_MISSING", "downstream.effects", "List the observed effects, or an empty list for none.");
    return true;
  }
  const owner = text(downstream.owner);
  const nextSafeStep = text(downstream.nextSafeStep);
  if (coverage === "partial" || coverage === "unknown")
    unknowns.push({ path: "downstream.coverage", owner, nextSafeStep });
  if (coverage !== "partial" && coverage !== "unknown" || downstream.claim === "no-effects" || owner === null || nextSafeStep === null)
    findings.add("DOWNSTREAM_COVERAGE_UNKNOWN", "downstream.coverage", "Keep unknown coverage explicit with an owner and next safe step; it cannot support a no-effects claim.");
  return false;
}
function checkUnresolved(packet, findings) {
  const unresolved = packet.unresolved;
  const holds = records(unresolved.holds);
  if (holds === null) {
    findings.add("FIELD_MISSING", "unresolved.holds", "List engineering holds, or an empty list for none.");
    return 0;
  }
  holds.forEach((hold, index) => {
    if (text(hold.owner) === null || text(hold.releaseCondition) === null)
      findings.add("HOLD_UNOWNED", `unresolved.holds[${index}]`, "Name the hold's owner and release condition.");
  });
  return holds.length;
}
function checkDecision(packet, findings) {
  const decision = packet.decision;
  findings.requireText(decision, "action", "decision");
  findings.requireText(decision, "readback", "decision");
  const grants = records(decision.grants);
  if (grants === null) {
    findings.add("FIELD_MISSING", "decision.grants", "List relied-on grants, or an empty list for none.");
    return;
  }
  grants.forEach((grant, index) => {
    const bound = ["originalRecord", "action", "scope"].every((key) => text(grant[key]) !== null) && texts(grant.conditions) !== null && texts(grant.exclusions) !== null;
    if (!bound)
      findings.add("GRANT_BINDING_INCOMPLETE", `decision.grants[${index}]`, "Point to the original authorization record with its action, scope, conditions and exclusions.");
  });
}
function presentFields(packet, findings) {
  let present = true;
  for (const field of PACKET_FIELDS) {
    const value = packet[field];
    const ok = field === "evidence" ? Array.isArray(value) : isRecord(value);
    if (!ok) {
      findings.add("FIELD_MISSING", field, `Populate the ${field} field.`);
      present = false;
    }
  }
  return present;
}
function verdictOf(findings) {
  if (findings.some((finding) => finding.code === "IDENTITY_MISMATCH"))
    return "inconsistent";
  return findings.length === 0 ? "complete" : "incomplete";
}
function checkPacket(packet, expected) {
  const findings = new Findings;
  const unknowns = [];
  const expectedIdentity = checkExpectedIdentity(expected, findings);
  const inventory = inventoryOf(expected, findings);
  let blocked = true;
  if (presentFields(packet, findings)) {
    checkIdentity(packet, expectedIdentity, findings);
    checkOutcome(packet, findings);
    const candidate = text(packet.identity.candidate);
    const items = checkEvidence(packet, inventory, candidate, findings);
    const covered = checkDownstream(packet, findings, unknowns);
    const holds = checkUnresolved(packet, findings);
    checkDecision(packet, findings);
    const failedProof = items.some((item) => typeof item.status === "string" && BLOCKING_STATUSES.has(item.status));
    blocked = !covered || holds > 0 || failedProof;
  }
  const sorted = [...findings.list].sort((a, b) => `${a.code}|${a.path}`.localeCompare(`${b.code}|${b.path}`));
  const reporting = verdictOf(sorted);
  return {
    reporting,
    actionability: reporting !== "complete" ? "not-assessed" : blocked ? "blocked" : "supports-requested-action",
    findings: sorted,
    unknowns,
    establishes: "recorded-structure-only",
    doesNotEstablish: [
      "authority",
      "dependency-completeness",
      "evidence-truth",
      "freshness",
      "native-pass"
    ]
  };
}
function isPacketRecord(value) {
  return isRecord(value);
}

// packages/closeout-packet/src/cli.ts
var CONTRACT_VERSION = "2.0.0";
var COMMANDS = [
  {
    commandIdentity: "closeout-packet.check",
    effectClass: "inspect",
    route: ["check"],
    summary: "Compare one closeout packet with its separately supplied expected context; changes nothing."
  },
  {
    commandIdentity: "closeout-packet.command-discovery",
    effectClass: "inspect",
    route: ["--discover-command"],
    summary: "Describe one command's possible stations."
  },
  {
    commandIdentity: "closeout-packet.discovery",
    effectClass: "inspect",
    route: ["--discover"],
    summary: "Describe the contract, commands and effect exclusions."
  },
  {
    commandIdentity: "closeout-packet.dispatch",
    effectClass: "inspect",
    route: [],
    summary: "Refuse an unsupported invocation with repair guidance."
  },
  {
    commandIdentity: "closeout-packet.help",
    effectClass: "inspect",
    route: ["--help"],
    summary: "Show usage and options."
  }
];
var DECLARED_COMMANDS = new Set(COMMANDS.map((command) => command.commandIdentity));
var AVAILABLE_PATHS = [
  "closeout-packet.check",
  "closeout-packet.command-discovery",
  "closeout-packet.discovery",
  "closeout-packet.help"
];
var NO_FOLLOW_UP = "No follow-up is required.";
var CHECK_GUIDANCE = {
  repair: "Repair each listed finding in the packet or expected context, then rerun closeout-packet check.",
  resolve: "Resolve each hold, failed or missing proof and unknown with its named owner before requesting the action; this check approves nothing.",
  review: "Complete original-record review of the inventory, evidence and grants before relying on this structural result."
};
function checkGuidance(data) {
  if (data.reporting !== "complete")
    return CHECK_GUIDANCE.repair;
  return data.actionability === "blocked" ? CHECK_GUIDANCE.resolve : CHECK_GUIDANCE.review;
}
function effects() {
  return {
    completed: [],
    inventoryComplete: true,
    remaining: [],
    uncertain: []
  };
}
function success(commandIdentity, data, message, nextAction = NO_FOLLOW_UP) {
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
      transactionState: "unchanged"
    }
  };
}
function refusal(message, causeCode) {
  const row = REFUSALS[causeCode];
  return {
    availablePaths: AVAILABLE_PATHS,
    contractVersion: CONTRACT_VERSION,
    envelopeVersion: 2,
    message,
    result: {
      causeCode,
      commandIdentity: causeCode === "USAGE_INVALID_INVOCATION" ? "closeout-packet.dispatch" : "closeout-packet.check",
      data: null,
      effectClass: "inspect",
      effects: effects(),
      exitCode: row.exitCode,
      failureClass: row.failureClass,
      nextAction: row.nextAction,
      outcome: "refused",
      repairAction: row.repairAction,
      ...retryArm(causeCode),
      runId: randomUUID(),
      transactionState: "unchanged"
    }
  };
}
function retryArm(causeCode) {
  return causeCode === "TRANSIENT_NOT_STARTED" ? {
    retryable: true,
    retryDelayMilliseconds: TRANSIENT_RETRY_DELAY_MILLISECONDS
  } : { retryable: false };
}
var SERIALIZATION_FAILURE_STATION = {
  causeCode: "INTERNAL_RESULT_UNCHANGED",
  commandIdentity: "closeout-packet.check",
  effectClass: "inspect",
  exitCode: 1,
  failureClass: "internal",
  handoff: {
    inspect: [
      "The packet and expected-context files named on the command line.",
      "The closeout-packet runtime and its Bun version."
    ],
    owner: "operator",
    reason: "The check ran but its machine result could not be serialized; no input or state was changed."
  },
  message: "The machine result could not be serialized.",
  outcome: "failed",
  repairAction: "Hand the serialization failure to an operator; nothing was changed.",
  retryable: false,
  transactionState: "unchanged",
  trigger: "The machine check result cannot be serialized or fails final envelope validation."
};
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
      transactionState: station.transactionState
    }
  };
}
function discoveryData() {
  return {
    commands: COMMANDS,
    contractVersion: CONTRACT_VERSION,
    effectExclusions: [
      "Reads only the two named JSON files; no native task, credential, network, process or write effect."
    ],
    exitMeanings: {
      "0": "success",
      "1": "internal",
      "2": "usage",
      "3": "domain",
      "4": "schema",
      "75": "transient"
    },
    generationConventionVersion: CONTRACT_VERSION,
    profile: "simple",
    signalExits: { "130": "SIGINT", "143": "SIGTERM" }
  };
}
function successDiscoveryStation(nextAction, trigger) {
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
    unreachableRationale: null
  };
}
function commandDiscovery() {
  return {
    command: COMMANDS[0],
    semantics: "possible-outcomes",
    stations: [
      successDiscoveryStation(CHECK_GUIDANCE.repair, "The check completes and reports findings or an identity inconsistency."),
      successDiscoveryStation(CHECK_GUIDANCE.resolve, "The check completes with complete reporting, but a hold, failed or missing proof, or incomplete coverage blocks the action."),
      successDiscoveryStation(CHECK_GUIDANCE.review, "The check completes with complete reporting that structurally supports the requested action."),
      refusalDiscoveryStation("DOMAIN_PRECONDITION_UNMET", "A named packet or expected-context file cannot be read."),
      refusalDiscoveryStation("SCHEMA_INVALID_INPUT", "A named input file is not one JSON object."),
      refusalDiscoveryStation("TRANSIENT_NOT_STARTED", "A named input file read fails with EAGAIN, EBUSY, EMFILE or ENFILE before any check."),
      failureDiscoveryStation()
    ]
  };
}
function refusalDiscoveryStation(causeCode, trigger) {
  const row = REFUSALS[causeCode];
  const transient = causeCode === "TRANSIENT_NOT_STARTED";
  return {
    causeCode,
    commandIdentity: "closeout-packet.check",
    effectClass: "inspect",
    exitCode: row.exitCode,
    failureClass: row.failureClass,
    guidance: { nextAction: row.nextAction },
    outcome: "refused",
    reachability: "required",
    repairAction: row.repairAction,
    retryable: transient,
    retryDelayPolicy: transient ? { kind: "fixed", milliseconds: TRANSIENT_RETRY_DELAY_MILLISECONDS } : { kind: "none" },
    transactionState: "unchanged",
    trigger,
    unreachableRationale: null
  };
}
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
    unreachableRationale: null
  };
}
function hasJson(argv) {
  const separator = argv.indexOf("--");
  const options = separator === -1 ? argv : argv.slice(0, separator);
  return options.includes("--json");
}
function writeStdout(text2) {
  try {
    process.stdout.write(text2);
    return true;
  } catch {
    return false;
  }
}
function emitMachine(candidate) {
  const primary = encodeEnvelope(candidate, DECLARED_COMMANDS);
  const encoded = primary ?? encodeEnvelope(internalFailure(), DECLARED_COMMANDS);
  if (encoded === null || !writeStdout(encoded))
    return 1;
  return primary === null ? 1 : candidate.result.exitCode;
}
var HUMAN_EMISSION_REPAIR = `The check output could not be emitted.
Repair: Inspect the check output stream before retrying.
`;
var humanEmissionReported = false;
function reportHumanEmissionFailure() {
  if (humanEmissionReported)
    return;
  humanEmissionReported = true;
  process.stderr.write(HUMAN_EMISSION_REPAIR);
}
function emitHuman(text2) {
  if (writeStdout(text2))
    return 0;
  reportHumanEmissionFailure();
  return 1;
}
function emitSuccess(json, envelope, human) {
  return json ? emitMachine(envelope) : emitHuman(`${human}
`);
}
var asynchronousStdoutFailure = false;
function onAsynchronousStdoutFailure(json) {
  asynchronousStdoutFailure = true;
  process.exitCode = 1;
  if (!json)
    reportHumanEmissionFailure();
}
var HELP_DATA = {
  commands: COMMANDS,
  options: [
    {
      name: "--packet",
      summary: "The closeout packet JSON file to check.",
      valueName: "PATH"
    },
    {
      name: "--expected",
      summary: "The separately sourced expected context and obligation inventory JSON file.",
      valueName: "PATH"
    },
    {
      name: "--json",
      summary: "Emit one Contract Core envelope.",
      valueName: null
    }
  ],
  summary: "Read-only closeout packet completeness check.",
  usage: "closeout-packet check --packet PATH --expected PATH [--json]"
};
async function main(argv) {
  const json = hasJson(argv);
  process.stdout.on("error", () => onAsynchronousStdoutFailure(json));
  const args = argv.filter((value) => value !== "--json");
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h"))
    return emitSuccess(json, success("closeout-packet.help", HELP_DATA, "Show help."), "Usage: closeout-packet check --packet PATH --expected PATH [--json]");
  if (args.length === 1 && args[0] === "--discover")
    return emitSuccess(json, success("closeout-packet.discovery", discoveryData(), "Describe commands."), "Commands: check (inspect)");
  if (args[0] === "--discover-command" && args[1] === "closeout-packet.check" && args.length === 2)
    return emitSuccess(json, success("closeout-packet.command-discovery", commandDiscovery(), "Describe closeout-packet.check."), "closeout-packet.check: success/unchanged");
  if (args[0] === "check")
    return checkCommand(args.slice(1), json);
  return emitRefusal(json, "USAGE_INVALID_INVOCATION", "Choose a supported command.");
}
function checkCommand(rest, json) {
  const parsed = checkArgs(rest);
  if (typeof parsed === "string")
    return emitRefusal(json, "USAGE_INVALID_INVOCATION", parsed);
  const loaded = loadInputs(parsed);
  if (!loaded.ok)
    return emitRefusal(json, loaded.refusal, loaded.message);
  const data = checkPacket(loaded.packet, loaded.expected);
  const result = success("closeout-packet.check", data, `Closeout packet reporting is ${data.reporting} with ${data.findings.length} findings.`, checkGuidance(data));
  return json ? emitMachine(result) : emitHuman(renderHuman(data));
}
var TRANSIENT_READ_CODES = new Set(["EAGAIN", "EBUSY", "EMFILE", "ENFILE"]);
var TRANSIENT_RETRY_DELAY_MILLISECONDS = 1000;
var REFUSALS = {
  TRANSIENT_NOT_STARTED: {
    exitCode: 75,
    failureClass: "transient",
    nextAction: "Retry the same command after retryDelayMilliseconds.",
    repairAction: "Retry after the stated delay; the input file could not be opened yet."
  },
  DOMAIN_PRECONDITION_UNMET: {
    exitCode: 3,
    failureClass: "domain",
    nextAction: "Name readable packet and expected-context files, then rerun closeout-packet check.",
    repairAction: "Name readable packet and expected-context files."
  },
  SCHEMA_INVALID_INPUT: {
    exitCode: 4,
    failureClass: "schema",
    nextAction: "Supply each input as one JSON object, then rerun closeout-packet check.",
    repairAction: "Supply each input as one JSON object."
  },
  USAGE_INVALID_INVOCATION: {
    exitCode: 2,
    failureClass: "usage",
    nextAction: "Run closeout-packet --help and choose a listed command.",
    repairAction: "Choose one supported command and retry."
  }
};
function emitRefusal(json, causeCode, message) {
  const failure = refusal(message, causeCode);
  if (json)
    return emitMachine(failure);
  process.stderr.write(`${message} Repair: ${failure.result.repairAction}
`);
  return failure.result.exitCode;
}
function checkArgs(rest) {
  const values = new Map;
  for (let index = 0;index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (name !== "--packet" && name !== "--expected" || value === undefined || values.has(name))
      return "check takes exactly --packet PATH and --expected PATH.";
    values.set(name, value);
  }
  const packet = values.get("--packet");
  const expected = values.get("--expected");
  if (packet === undefined || expected === undefined)
    return "check needs both --packet PATH and --expected PATH.";
  return { packet, expected };
}
function readObject(path, label) {
  let raw;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch (error) {
    const code = error.code;
    if (typeof code === "string" && TRANSIENT_READ_CODES.has(code))
      return {
        ok: false,
        refusal: "TRANSIENT_NOT_STARTED",
        message: `The ${label} file could not be opened yet (${code}); nothing was checked.`
      };
    return {
      ok: false,
      refusal: "DOMAIN_PRECONDITION_UNMET",
      message: `The ${label} file cannot be read.`
    };
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    value = null;
  }
  if (!isPacketRecord(value))
    return {
      ok: false,
      refusal: "SCHEMA_INVALID_INPUT",
      message: `The ${label} file is not one JSON object.`
    };
  return { ok: true, value };
}
function loadInputs(paths) {
  const packet = readObject(paths.packet, "packet");
  if (!packet.ok)
    return packet;
  const expected = readObject(paths.expected, "expected-context");
  if (!expected.ok)
    return expected;
  return { ok: true, packet: packet.value, expected: expected.value };
}
function renderHuman(data) {
  const lines = [
    `Reporting: ${data.reporting}. Actionability: ${data.actionability}.`,
    ...data.findings.map((finding) => `${finding.code} ${finding.path}: ${finding.repair}`),
    ...data.unknowns.map((unknown) => `Unknown ${unknown.path}: owner ${unknown.owner ?? "unnamed"}, next ${unknown.nextSafeStep ?? "unnamed"}.`),
    `Next: ${checkGuidance(data)}`,
    "Structure only: this establishes no evidence truth, authority or native PASS."
  ];
  return `${lines.join(`
`)}
`;
}
var exitCode = await main(process.argv.slice(2));
process.exitCode = asynchronousStdoutFailure ? 1 : exitCode;
