// Closed validation of every final machine envelope immediately before output (Contract Core 2.0, simple profile).
// The validator checks the serialized bytes that would be written, not the in-memory candidate.

type FailureClass = "usage" | "domain" | "schema" | "transient" | "internal";

interface CauseRow {
  exitCode: number;
  failureClass: FailureClass | null;
  guidance: "nextAction" | "handoff";
  outcome: "success" | "refused" | "failed";
  retryable: boolean;
}

/** This CLI's admitted causes; each row agrees with the closed Contract Core cause vocabulary. */
const CAUSES: Readonly<Record<string, CauseRow>> = {
  SUCCESS_UNCHANGED: { exitCode: 0, failureClass: null, guidance: "nextAction", outcome: "success", retryable: false },
  USAGE_INVALID_INVOCATION: { exitCode: 2, failureClass: "usage", guidance: "nextAction", outcome: "refused", retryable: false },
  DOMAIN_PRECONDITION_UNMET: { exitCode: 3, failureClass: "domain", guidance: "nextAction", outcome: "refused", retryable: false },
  SCHEMA_INVALID_INPUT: { exitCode: 4, failureClass: "schema", guidance: "nextAction", outcome: "refused", retryable: false },
  TRANSIENT_NOT_STARTED: { exitCode: 75, failureClass: "transient", guidance: "nextAction", outcome: "refused", retryable: true },
  INTERNAL_RESULT_UNCHANGED: { exitCode: 1, failureClass: "internal", guidance: "handoff", outcome: "failed", retryable: false },
};

const TOP_KEYS = ["availablePaths", "contractVersion", "envelopeVersion", "message", "result"];
const RESULT_KEYS = [
  "causeCode", "commandIdentity", "data", "effectClass", "effects", "exitCode", "failureClass", "outcome", "repairAction",
  "retryable", "runId", "transactionState",
];
const OPTIONAL_RESULT_KEYS = ["handoff", "nextAction", "retryDelayMilliseconds"];

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isNonblank = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");

function sortedUnique(values: string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] as string) < value);
}

function topValid(value: Json, commands: ReadonlySet<string>): boolean {
  const paths = value.availablePaths;
  return (
    Object.keys(value).sort().join() === TOP_KEYS.join() &&
    value.contractVersion === "2.0.0" &&
    value.envelopeVersion === 2 &&
    isNonblank(value.message) &&
    isStrings(paths) &&
    sortedUnique(paths) &&
    paths.every((path) => commands.has(path))
  );
}

function keysValid(result: Json): boolean {
  const keys = Object.keys(result);
  return RESULT_KEYS.every((key) => keys.includes(key)) && keys.every((key) => RESULT_KEYS.includes(key) || OPTIONAL_RESULT_KEYS.includes(key));
}

function effectsValid(effects: unknown): boolean {
  return (
    isObject(effects) &&
    Object.keys(effects).sort().join() === "completed,inventoryComplete,remaining,uncertain" &&
    effects.inventoryComplete === true &&
    [effects.completed, effects.remaining, effects.uncertain].every((list) => Array.isArray(list) && list.length === 0)
  );
}

const HANDOFF_KEYS = ["inspect", "owner", "reason", "resource"];

/** An optional handoff resource is exactly a nonblank id and kind. */
function resourceValid(resource: unknown): boolean {
  return isObject(resource) && Object.keys(resource).sort().join() === "id,kind" && isNonblank(resource.id) && isNonblank(resource.kind);
}

/** The handoff is closed: owner, reason, a nonempty inspect list and an optional resource, and nothing else. */
function handoffValid(handoff: unknown): boolean {
  if (!isObject(handoff) || !Object.keys(handoff).every((key) => HANDOFF_KEYS.includes(key))) return false;
  if ((handoff.owner !== "human" && handoff.owner !== "operator") || !isNonblank(handoff.reason)) return false;
  const inspect = handoff.inspect;
  if (!isStrings(inspect) || inspect.length === 0 || !inspect.every(isNonblank)) return false;
  return !("resource" in handoff) || resourceValid(handoff.resource);
}

function guidanceValid(result: Json, row: CauseRow): boolean {
  const hasNext = "nextAction" in result;
  if (hasNext === "handoff" in result) return false;
  if (row.guidance === "nextAction") return hasNext && isNonblank(result.nextAction);
  return !hasNext && handoffValid(result.handoff);
}

function retryValid(result: Json, row: CauseRow): boolean {
  if (result.retryable !== row.retryable) return false;
  if (!row.retryable) return !("retryDelayMilliseconds" in result);
  const delay = result.retryDelayMilliseconds;
  return typeof delay === "number" && Number.isSafeInteger(delay) && delay > 0;
}

function outcomeValid(result: Json, row: CauseRow): boolean {
  if (row.outcome === "success") return result.repairAction === null;
  return result.data === null && isNonblank(result.repairAction);
}

function resultValid(result: unknown, commands: ReadonlySet<string>): boolean {
  if (!isObject(result) || !keysValid(result)) return false;
  const row = typeof result.causeCode === "string" ? CAUSES[result.causeCode] : undefined;
  if (row === undefined) return false;
  return (
    typeof result.commandIdentity === "string" &&
    commands.has(result.commandIdentity) &&
    isNonblank(result.runId) &&
    result.effectClass === "inspect" &&
    result.transactionState === "unchanged" &&
    result.outcome === row.outcome &&
    result.failureClass === row.failureClass &&
    result.exitCode === row.exitCode &&
    effectsValid(result.effects) &&
    guidanceValid(result, row) &&
    retryValid(result, row) &&
    outcomeValid(result, row)
  );
}

/**
 * Serializes one machine envelope and validates the exact bytes. Returns the line to write, or null when the candidate
 * cannot be serialized or the serialized value breaks the closed contract.
 */
export function encodeEnvelope(candidate: unknown, commands: ReadonlySet<string>): string | null {
  let encoded: string;
  try {
    encoded = JSON.stringify(candidate);
  } catch {
    return null;
  }
  if (typeof encoded !== "string") return null;
  const emitted: unknown = JSON.parse(encoded);
  if (!isObject(emitted) || !topValid(emitted, commands) || !resultValid(emitted.result, commands)) return null;
  return `${encoded}\n`;
}
