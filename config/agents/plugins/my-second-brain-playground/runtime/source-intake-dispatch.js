#!/usr/bin/env bun
// @bun

// packages/source-intake-dispatch/src/contract.ts
var CONTRACT_VERSION = "2.0.0";
var COMMANDS = [
  { commandIdentity: "source-intake-dispatch.dispatch", effectClass: "inspect", route: [], summary: "Refuse a missing, unknown or malformed invocation." },
  { commandIdentity: "source-intake-dispatch.help", effectClass: "inspect", route: ["--help"], summary: "Show usage, commands and options." },
  { commandIdentity: "source-intake-dispatch.discovery", effectClass: "inspect", route: ["--discover"], summary: "Describe the contract, commands and effect exclusions." },
  { commandIdentity: "source-intake-dispatch.command-discovery", effectClass: "inspect", route: ["--discover-command"], summary: "Describe the possible stations of one command." },
  {
    commandIdentity: "source-intake-dispatch.project",
    effectClass: "inspect",
    route: ["project"],
    summary: "Project only the granted classification metadata fields after validating a grant and request piped on standard input."
  },
  { commandIdentity: "source-intake-dispatch.redacted", effectClass: "inspect", route: ["--redacted"], summary: "Return the fixed redacted projection for status or evaluation." },
  {
    commandIdentity: "source-intake-dispatch.choose",
    effectClass: "inspect",
    route: ["choose"],
    summary: "Open the native macOS chooser so Nathan selects one file directly inside a local Google Drive 00 Inbox; return its name and local account."
  }
];
var AVAILABLE_PATHS = [
  "source-intake-dispatch.choose",
  "source-intake-dispatch.command-discovery",
  "source-intake-dispatch.discovery",
  "source-intake-dispatch.help",
  "source-intake-dispatch.project",
  "source-intake-dispatch.redacted"
];
var INPUT_RETRY_DELAY_MILLISECONDS = 1000;
var STATIONS = {
  usage: {
    causeCode: "USAGE_INVALID_INVOCATION",
    outcome: "refused",
    failureClass: "usage",
    exitCode: 2,
    trigger: "The arguments do not name one supported command with its required operands.",
    repairAction: "Choose one listed invocation with its required operands and retry.",
    guidance: { nextAction: "Run source-intake-dispatch --help and choose a listed invocation." }
  },
  denied: {
    causeCode: "DOMAIN_PRECONDITION_UNMET",
    outcome: "refused",
    failureClass: "domain",
    exitCode: 3,
    trigger: "The request does not match a verified private grant, or the granted receipt cannot supply the projection.",
    repairAction: "Verify the private grant, then issue a request that matches it exactly.",
    guidance: { nextAction: "Ask Stage Manager to verify the private grant and issue a matching request." }
  },
  inputInvalid: {
    causeCode: "SCHEMA_INVALID_INPUT",
    outcome: "refused",
    failureClass: "schema",
    exitCode: 4,
    trigger: "Standard input is not one JSON object holding a grant and a request of the declared shape.",
    repairAction: "Pipe exactly one JSON object with the grant and request keys and value formats in the package README.",
    guidance: { nextAction: "Fix the piped grant and request against the package README, then retry." }
  },
  inputBusy: {
    causeCode: "TRANSIENT_NOT_STARTED",
    outcome: "refused",
    failureClass: "transient",
    exitCode: 75,
    retryDelayMilliseconds: INPUT_RETRY_DELAY_MILLISECONDS,
    trigger: "A file-descriptor limit was reached before input was read or the chooser opened; nothing was read.",
    repairAction: "Wait for open files to be released, then retry the same command.",
    guidance: { nextAction: "Retry the same command after the stated delay." }
  },
  inputUnreadable: {
    causeCode: "INTERNAL_UNEXPECTED",
    outcome: "failed",
    failureClass: "internal",
    exitCode: 1,
    trigger: "Standard input cannot be read.",
    repairAction: "Pipe the grant and request from a readable file or stream.",
    guidance: {
      handoff: {
        owner: "human",
        reason: "Standard input could not be read, which the command cannot repair.",
        inspect: ["the standard input redirection of the calling command"]
      }
    }
  },
  noInbox: {
    causeCode: "DOMAIN_CONFIG_MISSING",
    outcome: "refused",
    failureClass: "domain",
    exitCode: 3,
    trigger: "No local Google Drive for desktop account folder holds a My Drive/00 Inbox directory at its physical path.",
    repairAction: "Start Google Drive for desktop with the personal account so its 00 Inbox syncs locally.",
    guidance: { nextAction: "Ask Nathan to start Google Drive for desktop, then retry choose." }
  },
  cancelled: {
    causeCode: "DOMAIN_AUTHORITY_REQUIRED",
    outcome: "refused",
    failureClass: "domain",
    exitCode: 3,
    trigger: "Nathan closed the native chooser without selecting a file.",
    repairAction: "Only Nathan selects the item; retry choose while he is present.",
    guidance: {
      handoff: {
        owner: "human",
        reason: "The item is selected only by Nathan in the native chooser.",
        inspect: ["whether Nathan still wants to select one 00 Inbox file now"]
      }
    }
  },
  selectionRefused: {
    causeCode: "DOMAIN_PATH_REFUSED",
    outcome: "refused",
    failureClass: "domain",
    exitCode: 3,
    trigger: "The chooser reply is not one regular, non-hidden file directly inside a local 00 Inbox (for example a folder, a link, a nested or outside file).",
    repairAction: "Select one ordinary file that sits directly inside 00 Inbox, not a folder, link or nested file.",
    guidance: { nextAction: "Ask Nathan to retry choose and select one file directly inside 00 Inbox." }
  },
  chooserUnavailable: {
    causeCode: "INTERNAL_PREPARATION",
    outcome: "refused",
    failureClass: "internal",
    exitCode: 1,
    trigger: "The native chooser could not open, or the local Drive folder could not be read, in this session.",
    repairAction: "Run choose from a process in Nathan's logged-in macOS session that may show a dialog and read the local Drive folder.",
    guidance: { nextAction: "Ask Nathan to run choose from his own terminal in the granted foreground session." }
  },
  serialization: {
    causeCode: "INTERNAL_RESULT_UNCHANGED",
    outcome: "failed",
    failureClass: "internal",
    exitCode: 1,
    trigger: "The command fails unexpectedly, or its result cannot be serialized or fails envelope validation.",
    repairAction: "Inspect the serialization failure before retrying.",
    guidance: {
      handoff: {
        owner: "human",
        reason: "The command produced a result it could not emit safely.",
        inspect: ["source-intake-dispatch --discover --json"]
      }
    }
  }
};
var COMMAND_STATIONS = {
  "source-intake-dispatch.choose": ["usage", "noInbox", "cancelled", "selectionRefused", "chooserUnavailable", "inputBusy", "serialization"],
  "source-intake-dispatch.project": ["usage", "denied", "inputInvalid", "inputBusy", "inputUnreadable", "serialization"],
  "source-intake-dispatch.redacted": ["usage", "serialization"]
};
var SUCCESS_TRIGGERS = {
  "source-intake-dispatch.choose": "Nathan selects one regular file directly inside a local 00 Inbox; its name and local account are returned.",
  "source-intake-dispatch.project": "A matching piped grant and request yield exactly the requested granted fields from the bound receipt.",
  "source-intake-dispatch.redacted": "The recipient is status or evaluation; the fixed redacted projection is returned."
};
var SUCCESS_GUIDANCE = {
  "source-intake-dispatch.choose": "Keep the selection in the granted foreground's private receipt only; no follow-up read or effect is implied.",
  "source-intake-dispatch.project": "Pass the projection to its granted recipient only; no follow-up effect is implied.",
  "source-intake-dispatch.redacted": "Pass the projection to its granted recipient only; no follow-up effect is implied."
};
var EMISSION_FAILURE = "stdout cannot be written. Inspect the output stream before retrying.";
function effects() {
  return { completed: [], inventoryComplete: true, remaining: [], uncertain: [] };
}
function runId(commandIdentity) {
  return `run-${commandIdentity}`;
}
function success(commandIdentity, data, message, nextAction) {
  return {
    envelopeVersion: 2,
    contractVersion: CONTRACT_VERSION,
    message,
    availablePaths: AVAILABLE_PATHS,
    result: {
      runId: runId(commandIdentity),
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
      effects: effects(),
      nextAction
    }
  };
}
function stationResult(commandIdentity, key, message) {
  const station = STATIONS[key];
  const retry = station.retryDelayMilliseconds === undefined ? { retryable: false } : { retryable: true, retryDelayMilliseconds: station.retryDelayMilliseconds };
  return {
    envelopeVersion: 2,
    contractVersion: CONTRACT_VERSION,
    message,
    availablePaths: AVAILABLE_PATHS,
    result: {
      runId: runId(commandIdentity),
      commandIdentity,
      outcome: station.outcome,
      effectClass: "inspect",
      transactionState: "unchanged",
      causeCode: station.causeCode,
      failureClass: station.failureClass,
      exitCode: station.exitCode,
      data: null,
      ...retry,
      repairAction: station.repairAction,
      effects: effects(),
      ...station.guidance
    }
  };
}
var IDENTITIES = COMMANDS.map((command) => command.commandIdentity);
var ENVELOPE_KEYS = ["availablePaths", "contractVersion", "envelopeVersion", "message", "result"];
var BASE_RESULT_KEYS = ["causeCode", "commandIdentity", "data", "effectClass", "effects", "exitCode", "failureClass", "outcome", "repairAction", "retryable", "runId", "transactionState"];
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonblank(value) {
  return typeof value === "string" && value.trim() !== "";
}
function sameKeys(value, keys) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function envelopeHolds(value) {
  const paths = value.availablePaths;
  if (!sameKeys(value, ENVELOPE_KEYS) || value.envelopeVersion !== 2 || value.contractVersion !== CONTRACT_VERSION || !nonblank(value.message))
    return false;
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string" && IDENTITIES.includes(path)))
    return false;
  return JSON.stringify(paths) === JSON.stringify([...new Set(paths)].sort());
}
function baseHolds(result) {
  if (!nonblank(result.runId) || !IDENTITIES.includes(String(result.commandIdentity)))
    return false;
  if (result.effectClass !== "inspect" || result.transactionState !== "unchanged" || !isRecord(result.effects))
    return false;
  return JSON.stringify(result.effects) === JSON.stringify(effects());
}
function successHolds(result) {
  if (!sameKeys(result, [...BASE_RESULT_KEYS, "nextAction"]) || !nonblank(result.nextAction))
    return false;
  return result.causeCode === "SUCCESS_UNCHANGED" && result.failureClass === null && result.exitCode === 0 && result.retryable === false && result.repairAction === null;
}
function handoffHolds(value) {
  if (!isRecord(value) || !sameKeys(value, ["inspect", "owner", "reason"]) || value.owner !== "human" || !nonblank(value.reason))
    return false;
  return Array.isArray(value.inspect) && value.inspect.length > 0 && value.inspect.every(nonblank);
}
function stationHolds(result) {
  const station = Object.values(STATIONS).find((entry) => entry.causeCode === result.causeCode);
  if (station === undefined || result.data !== null || result.repairAction !== station.repairAction)
    return false;
  if (result.outcome !== station.outcome || result.failureClass !== station.failureClass || result.exitCode !== station.exitCode)
    return false;
  const retryKeys = station.retryDelayMilliseconds === undefined ? [] : ["retryDelayMilliseconds"];
  if (result.retryable !== (station.retryDelayMilliseconds !== undefined) || result.retryDelayMilliseconds !== station.retryDelayMilliseconds)
    return false;
  const guidance = "handoff" in station.guidance ? "handoff" : "nextAction";
  if (!sameKeys(result, [...BASE_RESULT_KEYS, ...retryKeys, guidance]))
    return false;
  return guidance === "handoff" ? handoffHolds(result.handoff) : nonblank(result.nextAction);
}
function envelopeValid(value) {
  if (!isRecord(value) || !envelopeHolds(value) || !isRecord(value.result) || !baseHolds(value.result))
    return false;
  return value.result.outcome === "success" ? successHolds(value.result) : stationHolds(value.result);
}
function serializeEnvelope(envelope) {
  try {
    const text = JSON.stringify(envelope);
    return typeof text === "string" && envelopeValid(JSON.parse(text)) ? `${text}
` : null;
  } catch {
    return null;
  }
}
function discoveryData() {
  return {
    contractVersion: CONTRACT_VERSION,
    generationConventionVersion: CONTRACT_VERSION,
    profile: "complex",
    commands: COMMANDS,
    exitMeanings: { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "transient" },
    signalExits: { "130": "SIGINT", "143": "SIGTERM" },
    effectExclusions: [
      "Never writes a file, receipt, grant, request, Beads record, vault note or configuration.",
      "Never reads Google Drive, file content or any network resource; choose observes only the type and parent folder of the one file Nathan selects.",
      "Never shows a folder listing to its caller; only Nathan sees the native chooser.",
      "Never names a selected path, file name or account in a refusal.",
      "Never discloses a receipt value, source label, path or raw error in a refusal.",
      "Never opens a private receipt before the grant and request match.",
      "Never opens a caller-supplied input path; the grant and request arrive on standard input.",
      "Never approves a grant; it only checks one the Stage Manager prepared."
    ]
  };
}
function stationEntry(commandIdentity, station) {
  return {
    commandIdentity,
    causeCode: station.causeCode,
    outcome: station.outcome,
    effectClass: "inspect",
    transactionState: "unchanged",
    failureClass: station.failureClass,
    exitCode: station.exitCode,
    retryable: station.retryDelayMilliseconds !== undefined,
    retryDelayPolicy: station.retryDelayMilliseconds === undefined ? { kind: "none" } : { kind: "fixed", milliseconds: station.retryDelayMilliseconds },
    repairAction: station.repairAction,
    guidance: station.guidance,
    trigger: station.trigger,
    reachability: "required",
    unreachableRationale: null
  };
}
function commandDiscovery(commandIdentity) {
  const command = COMMANDS.find((entry) => entry.commandIdentity === commandIdentity);
  return {
    command,
    semantics: "possible-outcomes",
    stations: [
      {
        commandIdentity,
        causeCode: "SUCCESS_UNCHANGED",
        outcome: "success",
        effectClass: "inspect",
        transactionState: "unchanged",
        failureClass: null,
        exitCode: 0,
        retryable: false,
        retryDelayPolicy: { kind: "none" },
        repairAction: null,
        guidance: { nextAction: SUCCESS_GUIDANCE[commandIdentity] },
        trigger: SUCCESS_TRIGGERS[commandIdentity],
        reachability: "required",
        unreachableRationale: null
      },
      ...COMMAND_STATIONS[commandIdentity].map((key) => stationEntry(commandIdentity, STATIONS[key]))
    ],
    lifecycleExceptions: [EMISSION_FAILURE]
  };
}
function isCommandIdentity(value) {
  return value === "source-intake-dispatch.choose" || value === "source-intake-dispatch.project" || value === "source-intake-dispatch.redacted";
}

// packages/source-intake-dispatch/src/main.ts
import { isatty } from "tty";

// packages/source-intake-dispatch/src/choose.ts
import { lstatSync as lstatSync2, readdirSync, realpathSync as realpathSync2 } from "fs";
import { homedir as homedir2 } from "os";
import { basename, dirname, isAbsolute as isAbsolute2, join as join2 } from "path";

// packages/source-intake-dispatch/src/gate.ts
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join } from "path";
var CLASSIFICATION_FIELDS = new Set(["displayName", "mimeType", "modifiedTime", "sizeBytes"]);
var INPUT_KEYS = ["grant", "request"];
var GRANT_KEYS = ["allowedFields", "opaqueItemRef", "provider", "purpose", "receiptPath"];
var REQUEST_KEYS = ["opaqueItemRef", "provider", "purpose", "requestedFields"];
var OPAQUE_ITEM_REF = /^[a-z0-9][a-z0-9-]{0,63}$/;
var DESCRIPTOR_LIMIT_CODES = new Set(["EAGAIN", "EMFILE", "ENFILE"]);
var ITEMS_PATH = ["my-second-brain-playground", "drive-inbox-filing", "items"];
var RECEIPT_FILE = "classification-metadata.json";

class GateRefusal extends Error {
  outcome;
  constructor(outcome) {
    super(outcome.kind);
    this.outcome = outcome;
  }
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
function isFieldList(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString) && new Set(value).size === value.length;
}
function hasOnlyKeys(record, keys) {
  return Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}
function hasItemIdentity(value) {
  return isNonEmptyString(value.opaqueItemRef) && OPAQUE_ITEM_REF.test(value.opaqueItemRef) && isNonEmptyString(value.provider) && isNonEmptyString(value.purpose);
}
function asGrant(value) {
  if (!isRecord2(value) || !hasOnlyKeys(value, GRANT_KEYS) || !hasItemIdentity(value) || !isNonEmptyString(value.receiptPath) || !isFieldList(value.allowedFields)) {
    throw new GateRefusal({ kind: "inputInvalid" });
  }
  return value;
}
function asRequest(value) {
  if (!isRecord2(value) || !hasOnlyKeys(value, REQUEST_KEYS) || !hasItemIdentity(value) || !isFieldList(value.requestedFields)) {
    throw new GateRefusal({ kind: "inputInvalid" });
  }
  return value;
}
function configuredStateHome() {
  const configured = process.env.XDG_STATE_HOME || `${homedir()}/.local/state`;
  if (!isAbsolute(configured))
    throw new Error("relative state home");
  return configured;
}
function parseInput(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new GateRefusal({ kind: "inputInvalid" });
  }
  if (!isRecord2(value) || !hasOnlyKeys(value, INPUT_KEYS))
    throw new GateRefusal({ kind: "inputInvalid" });
  return { grant: asGrant(value.grant), request: asRequest(value.request) };
}
function isAuthorized(grant, request) {
  return grant.provider === "luna" && grant.purpose === "classification" && grant.allowedFields.every((field) => CLASSIFICATION_FIELDS.has(field)) && grant.opaqueItemRef === request.opaqueItemRef && grant.provider === request.provider && grant.purpose === request.purpose && request.requestedFields.every((field) => grant.allowedFields.includes(field));
}
function boundItemDirectory(grant) {
  const configured = configuredStateHome();
  if (grant.receiptPath !== join(configured, ...ITEMS_PATH, grant.opaqueItemRef, RECEIPT_FILE))
    return null;
  const physical = realpathSync(configured);
  if (physical !== configured)
    return null;
  return join(physical, ...ITEMS_PATH, grant.opaqueItemRef);
}
function readBoundReceipt(itemDirectory) {
  process.chdir(itemDirectory);
  if (process.cwd() !== itemDirectory)
    return null;
  const descriptor = openSync(RECEIPT_FILE, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1)
      return null;
    const text = readFileSync(descriptor, "utf8");
    const named = lstatSync(RECEIPT_FILE);
    return named.dev === stat.dev && named.ino === stat.ino && named.nlink === 1 ? text : null;
  } finally {
    closeSync(descriptor);
  }
}
function isMetadataScalar(value) {
  return typeof value === "string" || typeof value === "number" && Number.isFinite(value);
}
function project(receipt, requestedFields) {
  if (!isRecord2(receipt) || !requestedFields.every((field) => Object.hasOwn(receipt, field) && isMetadataScalar(receipt[field])))
    return null;
  return Object.fromEntries(requestedFields.map((field) => [field, receipt[field]]));
}
function projectReceipt(grant, request) {
  try {
    const itemDirectory = boundItemDirectory(grant);
    const text = itemDirectory === null ? null : readBoundReceipt(itemDirectory);
    if (text === null)
      return { kind: "denied" };
    const projection = project(JSON.parse(text), request.requestedFields);
    return projection === null ? { kind: "denied" } : { kind: "allowed", opaqueItemRef: grant.opaqueItemRef, projection };
  } catch {
    return { kind: "denied" };
  }
}
function isDescriptorLimit(error) {
  const code = error.code;
  return code !== undefined && DESCRIPTOR_LIMIT_CODES.has(code);
}
function descriptorLimitReached() {
  try {
    closeSync(openSync("/dev/null", constants.O_RDONLY));
    return false;
  } catch (error) {
    return isDescriptorLimit(error);
  }
}
function runGate(text) {
  let input;
  try {
    input = parseInput(text);
  } catch (error) {
    return error instanceof GateRefusal ? error.outcome : { kind: "inputInvalid" };
  }
  if (!isAuthorized(input.grant, input.request))
    return { kind: "denied" };
  return projectReceipt(input.grant, input.request);
}

// packages/source-intake-dispatch/src/choose.ts
var OSASCRIPT = "/usr/bin/osascript";
var ACCOUNT_PREFIX = "GoogleDrive-";
var INBOX_PATH = ["My Drive", "00 Inbox"];
var PROMPT = "Choose one file in 00 Inbox for Source Intake";
var USER_CANCELLED = "(-128)";
var CHOOSER_SCRIPT = [
  "on run argv",
  "set startFolder to POSIX file (item 1 of argv) as alias",
  "return POSIX path of (choose file with prompt (item 2 of argv) default location startFolder without invisibles and multiple selections allowed)",
  "end run"
];
var chooser = null;
function closeChooser() {
  chooser?.kill();
}
var ABSENT_CODES = new Set(["ENOENT", "ENOTDIR"]);
function probeFailure(error) {
  if (isDescriptorLimit(error))
    return "inputBusy";
  return ABSENT_CODES.has(error.code ?? "") ? "absent" : "chooserUnavailable";
}
function probeDirectory(path) {
  try {
    return lstatSync2(path).isDirectory() && realpathSync2(path) === path ? "present" : "absent";
  } catch (error) {
    return probeFailure(error);
  }
}
function localInboxes(storage) {
  let entries;
  try {
    entries = readdirSync(storage);
  } catch (error) {
    const failure = probeFailure(error);
    return failure === "absent" ? [] : failure;
  }
  const inboxes = [];
  for (const entry of entries.filter((name) => name.startsWith(ACCOUNT_PREFIX) && name.length > ACCOUNT_PREFIX.length)) {
    const candidate = { account: entry.slice(ACCOUNT_PREFIX.length), inbox: join2(storage, entry, ...INBOX_PATH) };
    const probe = probeDirectory(candidate.inbox);
    if (probe === "present")
      inboxes.push(candidate);
    else if (probe !== "absent")
      return probe;
  }
  return inboxes.sort((left, right) => left.inbox.localeCompare(right.inbox));
}
async function runChooser(startFolder) {
  try {
    chooser = Bun.spawn([OSASCRIPT, ...CHOOSER_SCRIPT.flatMap((line) => ["-e", line]), startFolder, PROMPT], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    return { kind: isDescriptorLimit(error) ? "inputBusy" : "chooserUnavailable" };
  }
  const [exitCode, text, stderr] = await Promise.all([chooser.exited, new Response(chooser.stdout).text(), new Response(chooser.stderr).text()]);
  chooser = null;
  if (exitCode === 0)
    return { kind: "reply", text };
  return { kind: stderr.includes(USER_CANCELLED) ? "cancelled" : "chooserUnavailable" };
}
function acceptSelection(reply, inboxes) {
  const path = reply.endsWith(`
`) ? reply.slice(0, -1) : reply;
  if (!isAbsolute2(path) || /[\0\n\r]/.test(path) || path.endsWith("/"))
    return { kind: "selectionRefused" };
  const fileName = basename(path);
  const match = inboxes.find((candidate) => candidate.inbox === dirname(path));
  if (match === undefined || fileName.startsWith("."))
    return { kind: "selectionRefused" };
  const probe = probeDirectory(match.inbox);
  if (probe !== "present")
    return { kind: probe === "absent" ? "selectionRefused" : probe };
  try {
    if (!lstatSync2(path).isFile())
      return { kind: "selectionRefused" };
  } catch {
    return { kind: "selectionRefused" };
  }
  return { kind: "selected", fileName, localAccount: match.account };
}
async function chooseItem() {
  const home = homedir2();
  if (!isAbsolute2(home))
    return { kind: "noInbox" };
  const storage = join2(home, "Library", "CloudStorage");
  const inboxes = localInboxes(storage);
  if (typeof inboxes === "string")
    return { kind: inboxes };
  const [only, ...others] = inboxes;
  if (only === undefined)
    return { kind: "noInbox" };
  const reply = await runChooser(others.length === 0 ? only.inbox : storage);
  if (reply.kind !== "reply")
    return { kind: reply.kind };
  return acceptSelection(reply.text, inboxes);
}

// packages/source-intake-dispatch/src/main.ts
var USAGE = [
  "Usage:",
  "  source-intake-dispatch project [--json] < GRANT_AND_REQUEST.json",
  "  source-intake-dispatch choose [--json]",
  "  source-intake-dispatch --redacted RECIPIENT [--json]",
  "  source-intake-dispatch --discover [--json] | --discover-command COMMAND_IDENTITY [--json] | --help [--json]"
];
var OPTIONS = [
  { name: "--json", valueName: null, summary: "Emit one Contract Core 2.0 envelope on stdout." },
  { name: "--redacted", valueName: "RECIPIENT", summary: "Return the fixed redacted projection for status or evaluation." },
  { name: "--discover", valueName: null, summary: "Describe the contract, commands and effect exclusions." },
  { name: "--discover-command", valueName: "COMMAND_IDENTITY", summary: "Describe one command's possible stations." },
  { name: "--help", valueName: null, summary: "Show this help." }
];
var REDACTED_RECIPIENTS = new Set(["status", "evaluation"]);
var INPUT_LIMIT_BYTES = 64 * 1024;
var MESSAGES = {
  cancelled: "No file was selected.",
  chooserBusy: "A file-descriptor limit was reached before the chooser opened; nothing was read.",
  chooserUnavailable: "The native chooser is unavailable in this session.",
  denied: "Request denied. Stage Manager must verify the private grant before retrying.",
  inputBusy: "A file-descriptor limit was reached before input was read; no receipt was touched.",
  inputInvalid: "Standard input is not a valid grant and request.",
  inputUnreadable: "Standard input cannot be read.",
  noInbox: "No local Google Drive 00 Inbox was found.",
  selectionRefused: "The selection is not one file directly inside a local 00 Inbox."
};

class UsageError extends Error {
  identity;
  constructor(identity, message) {
    super(message);
    this.identity = identity;
  }
}
function helpOutput() {
  const data = { summary: "Project exactly granted Source Intake metadata, let Nathan choose one local 00 Inbox file, or return a fixed redacted result.", usage: USAGE.slice(1).map((line) => line.trim()), commands: COMMANDS, options: OPTIONS };
  const human = [...USAGE, "", "Options:", ...OPTIONS.map((option) => `  ${option.name}${option.valueName === null ? "" : ` ${option.valueName}`}  ${option.summary}`)].join(`
`);
  return { envelope: success("source-intake-dispatch.help", data, "Show help.", "Choose an invocation from the usage lines."), human };
}
function discoverOutput() {
  const human = "Profile complex. Commands: project (inspect, reads standard input), choose (inspect, attended native chooser), --redacted RECIPIENT (inspect).";
  return { envelope: success("source-intake-dispatch.discovery", discoveryData(), "Describe commands.", "Choose a command to run."), human };
}
function discoverCommandOutput(selector) {
  if (!isCommandIdentity(selector))
    throw new UsageError("source-intake-dispatch.command-discovery", "--discover-command needs a listed command identity.");
  const data = commandDiscovery(selector);
  const human = `${selector}: ${data.stations.map((station) => `${station.causeCode}/${station.outcome}`).join(", ")}`;
  return { envelope: success("source-intake-dispatch.command-discovery", data, `Describe ${selector}.`, "Read the stations; discovery reports no live state or grant."), human };
}
function redactedOutput(recipient) {
  if (!REDACTED_RECIPIENTS.has(recipient))
    throw new UsageError("source-intake-dispatch.redacted", "--redacted needs status or evaluation.");
  const data = { recipient, projection: { receipt: "[REDACTED]" } };
  return { envelope: success("source-intake-dispatch.redacted", data, `Redacted projection for ${recipient}.`, "Use only the redacted projection."), human: `${recipient}: receipt [REDACTED]` };
}
async function readInput() {
  const chunks = [];
  let size = 0;
  try {
    const reader = Bun.stdin.stream().getReader();
    for (let chunk = await reader.read();!chunk.done; chunk = await reader.read()) {
      size += chunk.value.byteLength;
      if (size > INPUT_LIMIT_BYTES) {
        await reader.cancel();
        return { kind: "inputInvalid" };
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    return { kind: isDescriptorLimit(error) ? "inputBusy" : "inputUnreadable" };
  }
  return { kind: "text", text: Buffer.concat(chunks).toString("utf8") };
}
function refusalOutput(identity, key, message = MESSAGES[key]) {
  return { envelope: stationResult(identity, key, message), human: "" };
}
async function projectOutput() {
  const identity = "source-intake-dispatch.project";
  if (isatty(0))
    throw new UsageError(identity, "Pipe the grant and request on standard input; the command never prompts.");
  if (descriptorLimitReached())
    return refusalOutput(identity, "inputBusy");
  const input = await readInput();
  if (input.kind !== "text")
    return refusalOutput(identity, input.kind);
  const outcome = runGate(input.text);
  if (outcome.kind !== "allowed")
    return refusalOutput(identity, outcome.kind);
  const fields = Object.keys(outcome.projection);
  const envelope = success(identity, { opaqueItemRef: outcome.opaqueItemRef, projection: outcome.projection }, `Projected ${fields.length} granted fields.`, "Pass the projection to its granted recipient only.");
  const human = [`Granted projection for ${outcome.opaqueItemRef}:`, ...Object.entries(outcome.projection).map(([field, value]) => `  ${field}: ${value}`)].join(`
`);
  return { envelope, human };
}
async function chooseOutput() {
  const identity = "source-intake-dispatch.choose";
  if (descriptorLimitReached())
    return refusalOutput(identity, "inputBusy", MESSAGES.chooserBusy);
  const outcome = await chooseItem();
  if (outcome.kind === "inputBusy")
    return refusalOutput(identity, "inputBusy", MESSAGES.chooserBusy);
  if (outcome.kind !== "selected")
    return refusalOutput(identity, outcome.kind);
  const { fileName, localAccount } = outcome;
  const envelope = success(identity, { fileName, localAccount }, "Nathan selected one file in a local 00 Inbox.", "Keep the selection in the granted foreground's private receipt only.");
  return { envelope, human: ["Selected one file in a local 00 Inbox:", `  fileName: ${fileName}`, `  localAccount: ${localAccount}`].join(`
`) };
}
function optionRoute(args) {
  const [first, second, ...rest] = args;
  if (args.length === 1 && (first === "--help" || first === "-h"))
    return helpOutput();
  if (args.length === 1 && first === "--discover")
    return discoverOutput();
  const valued = first === "--discover-command" || first === "--redacted";
  if (!valued)
    return null;
  const identity = first === "--redacted" ? "source-intake-dispatch.redacted" : "source-intake-dispatch.command-discovery";
  if (second === undefined || rest.length > 0)
    throw new UsageError(identity, `${first} needs exactly one value.`);
  return first === "--redacted" ? redactedOutput(second) : discoverCommandOutput(second);
}
async function dispatch(args) {
  const routed = optionRoute(args);
  if (routed !== null)
    return routed;
  if (args.some((arg) => arg.startsWith("-")))
    throw new UsageError("source-intake-dispatch.dispatch", "An option is not recognised.");
  if (args.length === 0)
    throw new UsageError("source-intake-dispatch.dispatch", "Choose a supported invocation.");
  if (args[0] === "choose") {
    if (args.length > 1)
      throw new UsageError("source-intake-dispatch.choose", "choose takes no operands; Nathan selects the file in the native chooser.");
    return chooseOutput();
  }
  if (args[0] !== "project")
    throw new UsageError("source-intake-dispatch.dispatch", "Choose a supported invocation.");
  if (args.length > 1)
    throw new UsageError("source-intake-dispatch.project", "project takes no operands; pipe the grant and request on standard input.");
  return projectOutput();
}
var humanFailureReported = false;
var transportFailed = false;
function guidanceLine(envelope) {
  const result = envelope.result;
  return "nextAction" in result ? `Next: ${result.nextAction}` : `Repair: ${String(result.repairAction)}`;
}
function reportToStderr(line) {
  if (humanFailureReported)
    return;
  humanFailureReported = true;
  process.stderr.write(`${line}
`);
}
function transportFailure(json) {
  transportFailed = true;
  if (!json)
    reportToStderr(EMISSION_FAILURE);
  return 1;
}
function write(text, json) {
  try {
    process.stdout.write(text);
    return null;
  } catch {
    return transportFailure(json);
  }
}
function emitMachine(envelope) {
  const text = serializeEnvelope(envelope);
  if (text !== null)
    return write(text, true) ?? envelope.result.exitCode;
  const fallback = serializeEnvelope(stationResult(envelope.result.commandIdentity, "serialization", "The result could not be emitted safely."));
  if (fallback === null)
    return 1;
  return write(fallback, true) ?? 1;
}
function emit(output, json) {
  if (json)
    return emitMachine(output.envelope);
  const exitCode = output.envelope.result.exitCode;
  if (exitCode !== 0) {
    reportToStderr(`${output.envelope.message} ${guidanceLine(output.envelope)}`);
    return exitCode;
  }
  return write(`${output.human}
`, false) ?? exitCode;
}
async function main(argv) {
  const json = argv.includes("--json");
  const args = argv.filter((value) => value !== "--json");
  process.stdout.on("error", () => {
    transportFailure(json);
    if (process.exitCode === undefined || process.exitCode === 0)
      process.exitCode = 1;
  });
  let output;
  try {
    output = await dispatch(args);
  } catch (error) {
    const envelope = error instanceof UsageError ? stationResult(error.identity, "usage", error.message) : stationResult("source-intake-dispatch.dispatch", "serialization", "The command failed unexpectedly.");
    output = { envelope, human: "" };
  }
  return emit(output, json);
}
process.on("SIGINT", () => {
  closeChooser();
  process.exit(130);
});
process.on("SIGTERM", () => {
  closeChooser();
  process.exit(143);
});
process.once("SIGHUP", () => {
  closeChooser();
  process.kill(process.pid, "SIGHUP");
});
var exitCode = await main(process.argv.slice(2));
process.exitCode = transportFailed ? 1 : exitCode;
