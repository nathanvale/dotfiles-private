import { checkBaseline } from "./baseline.ts";
import type { CheckResult } from "./check-result.ts";
import {
  CAUSES,
  CLI,
  COMMANDS,
  commandStations,
  discoveryData,
  envelope,
  INTERNAL_HANDOFF,
  INVOCATION_IDENTITY,
  type OptionSpec,
} from "./contract.ts";
import { checkCopy } from "./copy.ts";
import { checkDispatch } from "./dispatch.ts";
import { checkGeometry } from "./geometry.ts";
import { checkHandback } from "./handback.ts";
import { InputError, MissingInputError } from "./input.ts";
import { checkProtected } from "./protected.ts";
import { checkStory } from "./story.ts";
import { UsageError } from "./usage.ts";

type Options = Map<string, string>;
type Envelope = ReturnType<typeof envelope>;

const USAGE = `Usage: ${CLI} <command> [options] [--json]`;
const RUNNERS: Record<string, (o: Options) => CheckResult> = {
  baseline: (o) => checkBaseline(need(o, "--binding"), need(o, "--live")),
  copy: (o) => checkCopy(need(o, "--input"), need(o, "--current")),
  dispatch: (o) =>
    checkDispatch({
      maxAgeSeconds: seconds(o, "--max-age-seconds", 120),
      now: o.get("--now"),
      operation: o.get("--operation"),
      receipts: need(o, "--receipts"),
      settleSeconds: seconds(o, "--settle-seconds", 30),
      target: o.get("--target"),
    }),
  geometry: (o) => checkGeometry(need(o, "--snapshot"), need(o, "--contract")),
  handback: (o) => checkHandback(need(o, "--record")),
  protected: (o) => checkProtected(need(o, "--before"), need(o, "--after"), need(o, "--pages")),
  story: (o) =>
    checkStory({
      after: need(o, "--after"),
      before: need(o, "--before"),
      emojiFont: o.get("--emoji-font"),
      expected: need(o, "--expected"),
      target: need(o, "--target"),
    }),
};

function need(options: Options, name: string): string {
  const value = options.get(name);
  if (value === undefined) throw new UsageError(`${name} is required.`);
  return value;
}

function seconds(options: Options, name: string, fallback: number): number {
  const value = options.get(name);
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new UsageError(`${name} must be a whole number of seconds.`);
  return Number(value);
}

function parseOptions(args: string[], specs: OptionSpec[]): Options {
  const options: Options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index] ?? "";
    const value = args[index + 1];
    if (!specs.some((spec) => spec.name === name)) throw new UsageError(`Unknown option ${name}.`);
    if (value === undefined) throw new UsageError(`${name} needs a value.`);
    if (options.has(name)) throw new UsageError(`${name} was given twice.`);
    options.set(name, value);
  }
  for (const spec of specs.filter((s) => s.required)) need(options, spec.name);
  return options;
}

function helpText(): string {
  const lines = [USAGE, "", "Read-only checks for a Bestie chapter build. Commands:"];
  for (const spec of COMMANDS) {
    lines.push(`  ${spec.route[0]}  ${spec.summary}`);
    for (const option of spec.options) {
      const marker = option.required ? "" : " (optional)";
      lines.push(`      ${option.name} ${option.valueName}${marker}  ${option.summary}`);
    }
  }
  lines.push("", `Example: ${CLI} dispatch --receipts OPERATION_DIR --json`);
  return lines.join("\n");
}

function success(commandIdentity: string, data: unknown, message: string, nextAction: string): Envelope {
  return envelope({ cause: CAUSES.success, commandIdentity, data, guidance: { nextAction }, message, repairAction: null });
}

function refusal(commandIdentity: string, cause: (typeof CAUSES)[keyof typeof CAUSES], message: string, repairAction: string): Envelope {
  return envelope({
    cause,
    commandIdentity,
    data: null,
    guidance: { nextAction: `Run ${CLI} --help, correct the invocation or input, and rerun.` },
    message,
    repairAction,
  });
}

function checkEnvelope(identity: string, result: CheckResult): Envelope {
  if (result.passed) {
    return success(identity, result.data, result.message, "Record this verdict with the run evidence.");
  }
  const listed = result.issues.map((issue, i) => `${i + 1}) ${issue}`).join(" ");
  const flags = (result.review ?? []).map((flag, i) => `${String.fromCharCode(97 + (i % 26))}) ${flag}`).join(" ");
  const reviewed = flags ? ` Also review ${result.review?.length} flag(s): ${flags}` : "";
  const message = `${result.message} ${result.issues.length} issue(s): ${listed}${reviewed}`;
  if (result.retryAfterMs !== undefined) {
    return envelope({
      cause: CAUSES.transient,
      commandIdentity: identity,
      data: null,
      guidance: { nextAction: "Wait for the retry delay, then rerun the same command." },
      message,
      repairAction: result.repairAction,
      retryDelayMilliseconds: result.retryAfterMs,
    });
  }
  return envelope({
    cause: CAUSES.checkFailed,
    commandIdentity: identity,
    data: null,
    guidance: { nextAction: "Repair the listed issues and rerun the command." },
    message,
    repairAction: result.repairAction,
  });
}

function errorEnvelope(identity: string, error: unknown): Envelope {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof UsageError) {
    return refusal(identity, CAUSES.invalidInvocation, message, "Supply every required option exactly once.");
  }
  if (error instanceof MissingInputError) {
    return refusal(identity, CAUSES.missingInput, message, "Supply an existing input path.");
  }
  if (error instanceof InputError) {
    return refusal(identity, CAUSES.invalidInput, message, "Correct the input file shape.");
  }
  return envelope({
    cause: CAUSES.internal,
    commandIdentity: identity,
    data: null,
    guidance: INTERNAL_HANDOFF,
    message: `Unexpected runtime error: ${message}`,
    repairAction: "Inspect the runtime error before retrying.",
  });
}

function runCommand(name: string, args: string[]): Envelope {
  const spec = COMMANDS.find((c) => c.route[0] === name);
  if (spec === undefined) {
    return refusal(INVOCATION_IDENTITY, CAUSES.unknownCommand, `Unknown command ${name || "(none)"}.`, "Choose a listed command.");
  }
  try {
    const options = parseOptions(args, spec.options);
    const runner = RUNNERS[name] as (o: Options) => CheckResult;
    return checkEnvelope(spec.commandIdentity, runner(options));
  } catch (error) {
    return errorEnvelope(spec.commandIdentity, error);
  }
}

function discoverCommand(identity: string | undefined): Envelope {
  const spec = COMMANDS.find((c) => c.commandIdentity === identity);
  if (spec === undefined) {
    return refusal(INVOCATION_IDENTITY, CAUSES.unknownCommand, `Unknown command identity ${identity ?? "(none)"}.`, "Choose an identity from --discover.");
  }
  return success(`${CLI}.command-discovery`, commandStations(spec), `Describe ${identity}.`, "Use these stations to interpret results.");
}

function helpEnvelope(): Envelope {
  return success(
    `${CLI}.help`,
    {
      commands: COMMANDS.map(({ commandIdentity, options, route, summary }) => ({ commandIdentity, options, route, summary })),
      options: [{ name: "--json", summary: "Emit one Contract Core envelope.", valueName: null }],
      summary: "Read-only checks for a Bestie chapter build.",
      usage: USAGE,
    },
    "Show help.",
    "Choose a command.",
  );
}

/** Routes argv to one envelope plus its human rendering. */
function route(args: string[]): { value: Envelope; human: string } {
  const [first, ...rest] = args;
  if (args.length === 1 && (first === "--help" || first === "-h")) {
    return { human: helpText(), value: helpEnvelope() };
  }
  if (args.length === 1 && first === "--discover") {
    const value = success(`${CLI}.discovery`, discoveryData(), "Describe commands.", "Choose a command.");
    return { human: `Commands: ${COMMANDS.map((c) => `${c.route[0]} (inspect)`).join(", ")}`, value };
  }
  if (first === "--discover-command" && rest.length === 1) {
    const value = discoverCommand(rest[0]);
    return { human: value.message, value };
  }
  const value = runCommand(first ?? "", rest);
  return { human: humanResult(value), value };
}

function humanResult(value: Envelope): string {
  if (value.result.outcome === "success") return value.message;
  return `${value.message}\nRepair: ${value.result.repairAction}`;
}

function emit(value: Envelope, human: string, json: boolean): number {
  const failed = value.result.outcome !== "success";
  if (json) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  } else if (failed && value.result.failureClass === "usage") {
    process.stderr.write(`${value.message} Run ${CLI} --help.\n`);
  } else if (failed) {
    process.stderr.write(`${human}\n`);
  } else {
    process.stdout.write(`${human}\n`);
  }
  return value.result.exitCode;
}

function main(argv: string[]): number {
  const json = argv.includes("--json");
  const args = argv.filter((value) => value !== "--json");
  let routed: { value: Envelope; human: string };
  try {
    routed = route(args);
  } catch (error) {
    const value = errorEnvelope(INVOCATION_IDENTITY, error);
    routed = { human: value.message, value };
  }
  return emit(routed.value, routed.human, json);
}

process.exitCode = main(process.argv.slice(2));
