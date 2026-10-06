import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stationsFor } from "./branch-station-catalog.ts";
import { COMMANDS, DecideInput, envelope } from "./command-contract.ts";
import { ExportFormatError } from "./csv.ts";
import { attemptEmergencyDiagnostic, recordDiagnostic } from "./diagnostics.ts";
import {
  derivedUnwritable,
  effectUnknown,
  invalidArchive,
  lockResidue,
  parseOptions,
  recoveryRequired,
  refused,
  succeeded,
  writerBusy,
} from "./engine.ts";
import { JournalIntegrityError } from "./journal.ts";
import { type ArchiveState, DEFAULT_START_DATE, IMAGE_TYPES, type OperationResult } from "./model.ts";
import { planIsEmpty } from "./planner.ts";
import { systemProcessLifecycle } from "./process-lifecycle.ts";
import {
  type ApplyOutcome,
  ArchiveConflictError,
  applyImport,
  archiveStatus,
  checkArchive,
  DECISION_EFFECT,
  DerivedWriteError,
  EffectUncertainError,
  IMPORT_EFFECT,
  JOURNAL_ENTRY,
  type ImportSource,
  InvalidArchiveError,
  inspectRecovery,
  isNewArchive,
  loadArchive,
  PreconditionError,
  type PreparedImport,
  prepareImport,
  receiptFor,
  recordDecision,
  writeReceipt,
} from "./runtime.ts";

const lifecycle = systemProcessLifecycle(attemptEmergencyDiagnostic);
process.on("SIGINT", () => lifecycle.terminate(130));
process.on("SIGTERM", () => lifecycle.terminate(143));

const USAGE = [
  "imazing-archive import --archive DIR --csv FILE --attachments DIR (--preview | --plan DIGEST) [--start-date YYYY-MM-DD] [--json]",
  "imazing-archive status --archive DIR [--json]",
  "imazing-archive recover --archive DIR [--json]",
  "imazing-archive decide --archive DIR --item KEY [--image-type TYPE] [--contains-meme true|false|unknown] [--reviewed] [--album undecided|selected|rejected] [--json]",
];

const HUMAN_HELP = `Usage:
${USAGE.map((line) => `  ${line}`).join("\n")}

Commands:
  import   Preview, then apply with the previewed plan digest, one iMazing CSV export.
           Rows dated before --start-date (default ${DEFAULT_START_DATE}, fixed at creation) are left out.
  status   Count archive items, held messages, message-to-attachment associations, decisions, and pending images.
  recover  Inspect an interrupted import without replaying it.
  decide   Record image type, meme, review, or album decisions for one item.
           TYPE is one of ${IMAGE_TYPES.join(", ")}.

Discovery:
  imazing-archive --discover
  imazing-archive --discover-command COMMAND_IDENTITY
`;

function hasJson(argv: string[]): boolean {
  const separator = argv.indexOf("--");
  return (separator === -1 ? argv : argv.slice(0, separator)).includes(
    "--json",
  );
}

async function waitForLifecycleTest(): Promise<void> {
  if (process.env.NODE_ENV !== "test") return;
  const readyPath = process.env.IMAZING_ARCHIVE_TEST_READY_PATH;
  if (readyPath !== undefined) await writeFile(readyPath, "ready\n");
  const crash = process.env.IMAZING_ARCHIVE_TEST_CRASH;
  if (crash === "uncaught" || crash === "unhandled") {
    await new Promise<void>(() => {
      queueMicrotask(() => {
        if (crash === "uncaught") throw new Error("test uncaught exception");
        void Promise.reject(new Error("test unhandled rejection"));
      });
    });
  }
  const milliseconds = Number(process.env.IMAZING_ARCHIVE_TEST_DELAY_MS ?? "0");
  if (Number.isSafeInteger(milliseconds) && milliseconds > 0) {
    await Bun.sleep(milliseconds);
  }
}

/** One `key: value` line per field; a nested object joins its own pairs. */
function countLines(data: object): string[] {
  return Object.entries(data).map(([key, value]) =>
    typeof value === "object" && value !== null
      ? `${key}: ${Object.entries(value).map(([name, count]) => `${name} ${String(count)}`).join(", ")}`
      : `${key}: ${String(value)}`,
  );
}

function humanLines(result: ReturnType<typeof envelope>): string {
  const lines = [result.message];
  const data = result.result.data;
  if (typeof data === "object" && data !== null) {
    if (result.result.commandIdentity === "imazing-archive.status") {
      lines.push(...countLines(data));
    }
    for (const key of ["planDigest", "receiptPath"] as const) {
      if (key in data) lines.push(`${key}: ${String(data[key as keyof typeof data])}`);
    }
  }
  if (result.result.outcome === "success" && result.result.nextAction !== undefined) {
    lines.push(`Next: ${result.result.nextAction}`);
  }
  return `${lines.join("\n")}\n`;
}

function writeResult(result: ReturnType<typeof envelope>, json: boolean): void {
  if (process.env.NODE_ENV === "test") {
    const paddingBytes = Number(
      process.env.IMAZING_ARCHIVE_TEST_OUTPUT_BYTES ?? "0",
    );
    if (Number.isSafeInteger(paddingBytes) && paddingBytes > 0) {
      result.result.data = {
        original: result.result.data,
        padding: "x".repeat(paddingBytes),
      };
    }
  }
  if (json) {
    lifecycle.stdout(`${JSON.stringify(result)}\n`);
    return;
  }
  if (result.result.outcome === "success") lifecycle.stdout(humanLines(result));
  else lifecycle.stderr(`${result.message} ${result.result.repairAction ?? ""}`.trim().concat("\n"));
}

function discoveryData() {
  return {
    commands: COMMANDS,
    contractVersion: "2.0.0",
    effectExclusions: [
      "Source CSVs and attachment folders are read only.",
      "Preview receipts and diagnostics are not archive effects.",
    ],
    exitMeanings: {
      "0": "success",
      "1": "internal",
      "2": "usage",
      "3": "domain",
      "4": "schema",
      "75": "transient",
    },
    generationConventionVersion: "2.0.0",
    profile: "complex",
    signalExits: { "130": "SIGINT", "143": "SIGTERM" },
  };
}

function usage(commandIdentity: string): OperationResult {
  return refused(
    commandIdentity,
    "USAGE_INVALID_INVOCATION",
    "The invocation is not supported.",
    `Use: ${USAGE.join(" | ")}`,
  );
}

function archiveOption(
  commandIdentity: string,
  args: string[],
): string | OperationResult {
  const options = parseOptions(args, ["archive"], []);
  if (typeof options?.archive !== "string") return usage(commandIdentity);
  return resolve(options.archive);
}

async function status(args: string[]): Promise<OperationResult> {
  const archive = archiveOption("imazing-archive.status", args);
  if (typeof archive !== "string") return archive;
  await checkArchive(archive, true);
  await waitForLifecycleTest();
  return succeeded(
    "imazing-archive.status",
    "Archive inspected.",
    await archiveStatus(archive),
  );
}

async function recover(args: string[]): Promise<OperationResult> {
  const archive = archiveOption("imazing-archive.recover", args);
  if (typeof archive !== "string") return archive;
  await checkArchive(archive, true);
  const observation = await inspectRecovery(archive);
  if (observation.state === "unknown") {
    return recoveryRequired("imazing-archive.recover", observation.effectId, observation.reason);
  }
  return succeeded(
    "imazing-archive.recover",
    observation.state === "completed"
      ? "The interrupted write's durable effects read back complete; it was not replayed."
      : "No interrupted import needs recovery.",
    {
      expectedValueHash: observation.intent?.expectedValueHash ?? null,
      pendingEffect: observation.effectId,
      runId: observation.intent?.runId ?? null,
      state: observation.state,
    },
  );
}

function publicSummary(prepared: PreparedImport, receiptPath: string) {
  const { lists, ...counts } = prepared.summary;
  const listSizes = Object.fromEntries(
    Object.entries(lists).map(([name, values]) => [name, values.length]),
  );
  const { deeperFiles } = prepared.scan;
  return { ...counts, deeperFiles, listSizes, planDigest: prepared.digest, receiptPath };
}

/** A warning when the attachments root looks wrong; empty when it looks right. */
function rootWarning(prepared: PreparedImport): string {
  const { chatFiles, attachmentRows } = prepared.summary;
  const { deeperFiles } = prepared.scan;
  const warnings: string[] = [];
  if (chatFiles === 0 && attachmentRows > 0) {
    warnings.push("Warning: no file for this chat sits within two folders of the attachments root, so no attachment can resolve; the root is likely wrong.");
  }
  if (deeperFiles > 0) {
    warnings.push(`Warning: ${deeperFiles} files sit more than two folders below the attachments root and were not searched; if they are this export's files, pass the folder that holds them.`);
  }
  return warnings.map((warning) => ` ${warning}`).join("");
}

function importSource(args: string[]): {
  plan: string | null;
  source: ImportSource;
} | OperationResult {
  const options = parseOptions(args, ["archive", "attachments", "csv", "plan", "start-date"], ["preview"]);
  const { archive, attachments, csv, plan, preview } = options ?? {};
  const startDate = options?.["start-date"] ?? DEFAULT_START_DATE;
  if (
    typeof archive !== "string" ||
    typeof attachments !== "string" ||
    typeof csv !== "string" ||
    (preview === undefined) === (plan === undefined) ||
    typeof startDate !== "string"
  ) {
    return usage("imazing-archive.import");
  }
  if (!isCalendarDate(startDate)) {
    return refused(
      "imazing-archive.import",
      "SCHEMA_INVALID_INPUT",
      "The start date is not a YYYY-MM-DD calendar date.",
      `Pass --start-date YYYY-MM-DD, or omit it for ${DEFAULT_START_DATE}.`,
    );
  }
  if (typeof plan === "string" && !/^[0-9a-f]{64}$/.test(plan)) {
    return refused(
      "imazing-archive.import",
      "SCHEMA_INVALID_INPUT",
      "The plan digest is not a 64-character lowercase hex value.",
      "Pass the planDigest printed by --preview.",
    );
  }
  const source = {
    archive: resolve(archive),
    attachments: resolve(attachments),
    csv: resolve(csv),
    startDate,
  };
  return { plan: typeof plan === "string" ? plan : null, source };
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d\d-\d\d$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function appliedResult(outcome: ApplyOutcome): OperationResult {
  const identity = "imazing-archive.import";
  switch (outcome.status) {
    case "applied":
      return succeeded(identity, `Export imported.${rootWarning(outcome.prepared)}`, { ...publicSummary(outcome.prepared, outcome.receiptPath), runId: outcome.runId }, IMPORT_EFFECT, "Review the receipt's missing and ambiguous lists.");
    case "empty":
      return succeeded(identity, `No rows fall on or after the start date; nothing was imported.${rootWarning(outcome.prepared)}`, publicSummary(outcome.prepared, outcome.receiptPath));
    case "unchanged":
      return succeeded(identity, `Export already imported; nothing changed.${rootWarning(outcome.prepared)}`, publicSummary(outcome.prepared, outcome.receiptPath));
    case "stale":
      return refused(identity, "DOMAIN_PREVIEW_STALE", "The archive or sources changed since the preview.", "Run --preview again and review the new plan.");
    case "blocked":
      return recoveryRequired(identity, outcome.effectId, outcome.reason);
    case "busy":
      return writerBusy(identity);
    case "residue":
      return lockResidue(identity);
  }
}

async function previewMessage(archive: string, prepared: PreparedImport, state: ArchiveState): Promise<string> {
  if (!planIsEmpty(prepared.plan)) return "Preview: nothing was written to the archive.";
  return (await isNewArchive(archive, state))
    ? "No rows fall on or after the start date; nothing was imported."
    : "Preview: export already imported; nothing would change.";
}

async function importCommand(args: string[]): Promise<OperationResult> {
  const parsed = importSource(args);
  if ("commandIdentity" in parsed) return parsed;
  const { plan, source } = parsed;
  await checkArchive(source.archive, false);
  if (plan !== null) return appliedResult(await applyImport(source, plan));
  const state = await loadArchive(source.archive);
  const prepared = await prepareImport(source, state);
  const receiptPath = await writeReceipt(receiptFor(source, prepared, "preview"));
  return succeeded(
    "imazing-archive.import",
    `${await previewMessage(source.archive, prepared, state)}${rootWarning(prepared)}`,
    publicSummary(prepared, receiptPath),
    null,
    planIsEmpty(prepared.plan)
      ? "Nothing to apply; review the receipt's unresolved lists."
      : `Review the receipt, then rerun with --plan ${prepared.digest} to apply.`,
  );
}

function decisionInput(args: string[]) {
  const options = parseOptions(
    args,
    ["album", "archive", "contains-meme", "image-type", "item"],
    ["reviewed"],
  );
  if (typeof options?.archive !== "string") return null;
  const fields = {
    albumSelection: options.album,
    containsMeme: options["contains-meme"],
    imageType: options["image-type"],
    itemKey: options.item,
    visualReview: options.reviewed === true ? "reviewed" : undefined,
  };
  const defined = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
  return { archive: resolve(options.archive), parsed: DecideInput.safeParse(defined) };
}

async function decide(args: string[]): Promise<OperationResult> {
  const identity = "imazing-archive.decide";
  const input = decisionInput(args);
  if (input === null) return usage(identity);
  if (!input.parsed.success) {
    return refused(identity, "SCHEMA_INVALID_INPUT", "The decision is invalid.", "Pass --item KEY and at least one valid decision field.");
  }
  await checkArchive(input.archive, true);
  const decision = { ...input.parsed.data, recordVersion: 1 as const, recordedAt: new Date().toISOString() };
  const outcome = await recordDecision(input.archive, decision);
  if (outcome.status === "recorded") {
    return succeeded(identity, "Decision recorded.", decision, DECISION_EFFECT);
  }
  if (outcome.status === "unknown-item") {
    return refused(identity, "DOMAIN_PRECONDITION_UNMET", "The item key is not in the archive.", "Use an item_key from derived/messages.csv.");
  }
  if (outcome.status === "blocked") return recoveryRequired(identity, outcome.effectId, outcome.reason);
  return outcome.status === "busy" ? writerBusy(identity) : lockResidue(identity);
}

const HANDLERS: Record<string, (args: string[]) => Promise<OperationResult>> = {
  decide,
  import: importCommand,
  recover,
  status,
};

async function guarded(
  commandIdentity: string,
  run: () => Promise<OperationResult>,
): Promise<OperationResult> {
  try {
    return await run();
  } catch (error) {
    const result = knownFailure(commandIdentity, error);
    if (result === null) throw error;
    return result;
  }
}

/** The envelope for an expected failure; null for an unexpected one. */
function knownFailure(commandIdentity: string, error: unknown): OperationResult | null {
  if (error instanceof ArchiveConflictError) {
    return refused(commandIdentity, "DOMAIN_ARCHIVE_CONFLICT", error.message, "Inspect the named archive file; restore or move it aside, then preview again.");
  }
  if (error instanceof PreconditionError) {
    return refused(commandIdentity, "DOMAIN_PRECONDITION_UNMET", error.message, "Check the archive, CSV, and attachments paths.");
  }
  if (error instanceof ExportFormatError) {
    return refused(commandIdentity, "SCHEMA_INVALID_INPUT", error.message, "Pass an unmodified iMazing CSV export.");
  }
  if (error instanceof JournalIntegrityError) {
    return recoveryRequired(commandIdentity, JOURNAL_ENTRY, error.message);
  }
  if (error instanceof DerivedWriteError) {
    return derivedUnwritable(commandIdentity, error.message);
  }
  if (error instanceof InvalidArchiveError) {
    return invalidArchive(commandIdentity, error.message);
  }
  if (error instanceof EffectUncertainError) {
    return effectUnknown(commandIdentity, error.effectId);
  }
  const unusable = unusablePath(error);
  if (unusable !== null) {
    return refused(commandIdentity, "DOMAIN_PRECONDITION_UNMET", unusable, "Check the archive, CSV, and attachments paths.");
  }
  return null;
}

const PATH_KIND_ERRORS: Record<string, string> = {
  EACCES: "is not accessible",
  EISDIR: "is a directory where a file is expected",
  ENOTDIR: "is not a directory where one is expected",
  EPERM: "is not permitted",
};

/** A wrong path kind or permission, named with the offending path. */
function unusablePath(error: unknown): string | null {
  if (!(error instanceof Error) || !("code" in error)) return null;
  const problem = PATH_KIND_ERRORS[String(error.code)];
  if (problem === undefined) return null;
  const path = "path" in error ? String(error.path) : error.message;
  return `The path ${path} ${problem} (${String(error.code)}).`;
}

/** Help and discovery; null means human help was already written. */
function informational(
  args: string[],
  json: boolean,
): OperationResult | null | undefined {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    if (!json) {
      lifecycle.stdout(HUMAN_HELP);
      return null;
    }
    return succeeded("imazing-archive.help", "Show help.", {
      commands: COMMANDS,
      summary: "Append iMazing message exports into a private archive.",
      usage: USAGE,
    });
  }
  if (args.length === 1 && args[0] === "--discover") {
    return succeeded("imazing-archive.discovery", "Describe commands.", discoveryData());
  }
  const command = COMMANDS.find((candidate) => candidate.commandIdentity === args[1]);
  if (args[0] === "--discover-command" && args.length === 2 && command !== undefined) {
    return succeeded("imazing-archive.command-discovery", `Describe ${command.commandIdentity}.`, {
      command,
      semantics: "possible-outcomes",
      stations: stationsFor(command.commandIdentity),
    });
  }
  return undefined;
}

async function main(argv: string[]): Promise<number> {
  const json = hasJson(argv);
  const args = argv.filter((value) => value !== "--json");
  const info = informational(args, json);
  if (info === null) return 0;
  if (info !== undefined) {
    writeResult(envelope(info), json);
    return info.exitCode;
  }
  const [name = "", ...rest] = args;
  const handler = Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : undefined;
  const commandIdentity = handler === undefined ? "imazing-archive.dispatch" : `imazing-archive.${name}`;
  if (handler !== undefined) await recordDiagnostic(commandIdentity);
  const result =
    handler === undefined
      ? usage(commandIdentity)
      : await guarded(commandIdentity, () => handler(rest));
  writeResult(envelope(result), json);
  return result.exitCode;
}

await lifecycle.complete(await main(process.argv.slice(2)));
