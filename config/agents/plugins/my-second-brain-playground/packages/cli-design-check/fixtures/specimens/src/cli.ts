// The conformant CLI plus exactly one mutation selected by CLI_DESIGN_SPECIMEN=<id>.
// Mutations act on the conformant CLI's streams, exit code and side effects at this shim,
// so fixtures/conformant carries no switch and stays the runnable conformant example.
// Expectations live only in src/specimen-manifest.ts; this file owns the mutations.
// S-ids are the frozen oracle's specimens; C-ids cover the remaining finding codes.
import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SPECIMEN = process.env.CLI_DESIGN_SPECIMEN ?? "";
// The checker's matrix rows have fixed argv, so the row is the joined argv.
const ROW = process.argv.slice(2).join(" ");
const HELP = "--help";
const HELP_JSON = "--json --help";
const DISCOVER = "--discover --json";
const NO_ARGUMENTS = "";
const NO_ARGUMENTS_JSON = "--json";
const SUCCESS_HUMAN = "config/valid.json";
const SUCCESS_JSON = "config/valid.json --json";
const MISSING_INPUT = "config/missing.json --json";
const MALFORMED_VALUE_JSON = "config/malformed.json.txt --json";
const LARGE_ENVELOPE = "config/valid.json --large --json";
const SECRET_REDACTION = "config/secret.json --json";
const SECRET_MARKER = "CHECK_FIXTURE_SECRET_MARKER";

type Envelope = Record<string, unknown>;
type Write = typeof process.stdout.write;
type AnyWrite = (...args: unknown[]) => boolean;

const realStdoutWrite: Write = process.stdout.write.bind(process.stdout);
let exitOverride: number | undefined;
let exitImmediatelyAfterWrite = false;

function parseEnvelope(text: string): Envelope | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Envelope) : null;
  } catch {
    return null;
  }
}

function withResult(envelope: Envelope, change: (result: Record<string, unknown>) => void): Envelope {
  const result = { ...(envelope.result as Record<string, unknown>) };
  change(result);
  return { ...envelope, result };
}

function withExitMeanings(envelope: Envelope, change: (exitMeanings: Record<string, unknown>) => void): Envelope {
  return withResult(envelope, (result) => {
    const exitMeanings = { ...(result.exitMeanings as Record<string, unknown>) };
    change(exitMeanings);
    result.exitMeanings = exitMeanings;
  });
}

function without(envelope: Envelope, field: string): Envelope {
  const { [field]: _removed, ...rest } = envelope;
  return rest;
}

// Discovery-row mutations, one per id.
// S02: exit meaning "0" is not `success`.
// S03: an undeclared exit key "99" is added.
// S04: exit meaning "75" is present but empty.
// S05: the success envelope reports transactionState unknown.
// C10: exit key "75" is absent.
function mutateDiscovery(envelope: Envelope): Envelope {
  if (SPECIMEN === "S02") return withExitMeanings(envelope, (exitMeanings) => { exitMeanings["0"] = "banana"; });
  if (SPECIMEN === "S03") return withExitMeanings(envelope, (exitMeanings) => { exitMeanings["99"] = "extra"; });
  if (SPECIMEN === "S04") return withExitMeanings(envelope, (exitMeanings) => { exitMeanings["75"] = ""; });
  if (SPECIMEN === "S05") return { ...envelope, transactionState: "unknown" };
  if (SPECIMEN === "C10") return withExitMeanings(envelope, (exitMeanings) => { delete exitMeanings["75"]; });
  return envelope;
}

// Missing-input refusal mutations, one per id.
// S06: the refusal reports an unresolved state (unknown) yet claims a safe retry.
// S07: nextAction is present but empty.
// S08: repairAction is present but empty.
// S11: both nextAction and a handoff are present.
// S12: neither nextAction nor a handoff is present.
function mutateMissingInput(envelope: Envelope): Envelope {
  if (SPECIMEN === "S06") return { ...envelope, transactionState: "unknown", retryable: true };
  if (SPECIMEN === "S07") return { ...envelope, nextAction: "" };
  if (SPECIMEN === "S08") return { ...envelope, repairAction: "" };
  if (SPECIMEN === "S11") return { ...envelope, handoff: { reason: "needs review", prerequisites: [] } };
  if (SPECIMEN === "S12") return { ...envelope, nextAction: null };
  return envelope;
}

// Malformed-row mutations, one per id.
// S13: the row declares the schema class (with its cause prefix) but keeps exit 3.
// S15: malformed input is reported as a success (exit 0, success envelope, no repair guidance).
// C14: the row declares the schema class and exits 4 (the oracle's other accepted pairing).
// C15: the row keeps the domain class but exits 4 (misaligned).
function mutateMalformed(envelope: Envelope): Envelope {
  if (SPECIMEN === "S13") return { ...envelope, failureClass: "schema", causeCode: "SCHEMA_INPUT_MALFORMED" };
  if (SPECIMEN === "C14") {
    exitOverride = 4;
    return { ...envelope, failureClass: "schema", causeCode: "SCHEMA_INPUT_MALFORMED" };
  }
  if (SPECIMEN === "C15") exitOverride = 4;
  if (SPECIMEN === "S15") {
    exitOverride = 0;
    return { ...envelope, outcome: "success", failureClass: null, causeCode: null, message: "Configuration read successfully", nextAction: null, repairAction: null };
  }
  return envelope;
}

// Success-json mutations, one per id.
// S09: a handoff with an empty reason is attached to the success.
// S10: nextAction is present but empty on the success.
// C05: the envelope is also written to stderr.
// C09: the retryDelayMilliseconds field is absent.
function mutateSuccessJson(envelope: Envelope): Envelope {
  if (SPECIMEN === "S09") return { ...envelope, handoff: { reason: "", prerequisites: [] } };
  if (SPECIMEN === "S10") return { ...envelope, nextAction: "" };
  if (SPECIMEN === "C05") process.stderr.write(`${JSON.stringify(envelope)}\n`);
  if (SPECIMEN === "C09") return without(envelope, "retryDelayMilliseconds");
  return envelope;
}

// Large-envelope mutations, one per id.
// S16: the process is force-exited with status 0 right after writing the large envelope.
// C01: the declared large result is small.
function mutateLargeEnvelope(envelope: Envelope): Envelope {
  if (SPECIMEN === "S16") exitImmediatelyAfterWrite = true;
  if (SPECIMEN === "C01") return withResult(envelope, (result) => { result.largePayload = "small"; });
  return envelope;
}

// Secret-redaction mutations, one per id.
// C11: the secret marker appears in the envelope message.
// C12: a secret-named key inside result is not redacted (and does not carry the marker).
function mutateSecretRedaction(envelope: Envelope): Envelope {
  if (SPECIMEN === "C11") return { ...envelope, message: `Configuration read successfully (${SECRET_MARKER})` };
  if (SPECIMEN === "C12") return withResult(envelope, (result) => { result.values = { ...(result.values as Record<string, unknown>), apiToken: "plain-token-value" }; });
  return envelope;
}

// Side effects, applied on the success-json row before the CLI runs.
// S17: a file is written outside --cwd (the target-unchanged row cannot see it).
// S18: a symlink is created inside --cwd (an excluded entry kind).
// C07: a regular file is written inside --cwd.
function applySideEffects(): void {
  if (ROW !== SUCCESS_JSON) return;
  if (SPECIMEN === "S17") writeFileSync(join(tmpdir(), "cli-design-specimen-S17.txt"), "written outside the target root\n");
  if (SPECIMEN === "S18" && !existsSync("config/specimen-link.json")) symlinkSync("valid.json", "config/specimen-link.json");
  if (SPECIMEN === "C07") writeFileSync("SPECIMEN_WROTE", "written inside the target root\n");
}

// S01: prose on `--help --json` (the conformant fixture before its admitted correction).
function mutateEnvelope(envelope: Envelope): Envelope | string {
  if (ROW === HELP_JSON && SPECIMEN === "S01") return "usage: config-peek [--json] [--discover] <path>\n";
  if (ROW === DISCOVER) return mutateDiscovery(envelope);
  if (ROW === MISSING_INPUT) return mutateMissingInput(envelope);
  if (ROW === SUCCESS_JSON) return mutateSuccessJson(envelope);
  if (ROW === MALFORMED_VALUE_JSON) return mutateMalformed(envelope);
  if (ROW === LARGE_ENVELOPE) return mutateLargeEnvelope(envelope);
  if (ROW === SECRET_REDACTION) return mutateSecretRedaction(envelope);
  return envelope;
}

// Human-row stdout mutations, one per id.
// S19: bare `--json` is answered like human mode: one line on stderr, nothing on stdout.
// S20: human success output is a JSON array.
// C03: human success output is empty.
// C08: help text has no usage line.
function mutateHumanStdout(): string | null {
  if (ROW === NO_ARGUMENTS_JSON && SPECIMEN === "S19") {
    process.stderr.write("config-peek: a path is required; run config-peek --help\n");
    return "";
  }
  if (ROW === SUCCESS_HUMAN && SPECIMEN === "S20") return "[]\n";
  if (ROW === SUCCESS_HUMAN && SPECIMEN === "C03") return "";
  if (ROW === HELP && SPECIMEN === "C08") return "config-peek: inspect one JSON configuration file\n";
  return null;
}

function mutateStdout(text: string): string {
  const human = mutateHumanStdout();
  if (human !== null) return human;
  const envelope = parseEnvelope(text);
  if (envelope === null) return text;
  const mutated = mutateEnvelope(envelope);
  return typeof mutated === "string" ? mutated : `${JSON.stringify(mutated)}\n`;
}

// Stream and lifecycle mutations that do not go through a stdout write, one per id.
// C02: the no-arguments refusal also prints to stdout.
// C04: the no-arguments refusal prints a second stderr line.
// C06: the no-arguments refusal never exits (the event loop is kept alive).
// C13: the help row also prints a diagnostic on stderr.
function applyStreamMutations(): void {
  if (ROW === NO_ARGUMENTS && SPECIMEN === "C02") realStdoutWrite("nothing to do\n");
  if (ROW === NO_ARGUMENTS && SPECIMEN === "C04") process.stderr.write("config-peek: see also config-peek --discover --json\n");
  if (ROW === NO_ARGUMENTS && SPECIMEN === "C06") setInterval(() => undefined, 1000);
  if (ROW === HELP && SPECIMEN === "C13") process.stderr.write("config-peek: help requested\n");
}

const patchedStdoutWrite = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
  const written = (realStdoutWrite as AnyWrite)(mutateStdout(String(chunk)), ...rest);
  // S16: the forced exit is the mutation; whatever the pipe has not taken yet is lost.
  if (exitImmediatelyAfterWrite) process.exit(0);
  return written;
};
process.stdout.write = patchedStdoutWrite as Write;

applySideEffects();
applyStreamMutations();
await import("../../conformant/src/cli.ts");
if (exitOverride !== undefined) process.exitCode = exitOverride;
