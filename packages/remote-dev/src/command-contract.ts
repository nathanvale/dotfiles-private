import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { OperationResult } from "./model.ts";

export const COMMANDS = [
  {
    commandIdentity: "remote-dev.help",
    effectClass: "inspect",
    route: ["--help"],
    summary: "Show help, options, and examples.",
  },
  {
    commandIdentity: "remote-dev.discovery",
    effectClass: "inspect",
    route: ["--discover"],
    summary: "Describe commands and the 2.0 contract.",
  },
  {
    commandIdentity: "remote-dev.command-discovery",
    effectClass: "inspect",
    route: ["--discover-command"],
    summary: "Describe one command's possible stations.",
  },
  {
    commandIdentity: "remote-dev.dispatch",
    effectClass: "inspect",
    route: [],
    summary: "Report invalid invocations.",
  },
  {
    commandIdentity: "remote-dev.list",
    effectClass: "inspect",
    route: ["list"],
    summary:
      "List configured development targets (or every container with --all).",
  },
  {
    commandIdentity: "remote-dev.open",
    effectClass: "external",
    route: ["open"],
    summary:
      "Recheck a target, then open it in the isolated VS Code environment.",
  },
  {
    commandIdentity: "remote-dev.start",
    effectClass: "external",
    route: ["start"],
    summary: "Start an opted-in target, restore configured services, then open isolated VS Code.",
  },
  {
    commandIdentity: "remote-dev.logs",
    effectClass: "inspect",
    route: ["logs"],
    summary: "Recheck a target, then show the tail of its native service log.",
  },
  {
    commandIdentity: "remote-dev.board",
    effectClass: "external",
    route: ["board"],
    summary: "Recheck a target, then open its configured task board.",
  },
  {
    commandIdentity: "remote-dev.choose",
    effectClass: "external",
    route: ["choose"],
    summary: "Recent-first fuzzy chooser (TTY only); dispatches one rechecked action.",
  },
] as const;

const AVAILABLE_PATHS = [
  "remote-dev.board",
  "remote-dev.choose",
  "remote-dev.command-discovery",
  "remote-dev.discovery",
  "remote-dev.dispatch",
  "remote-dev.help",
  "remote-dev.list",
  "remote-dev.logs",
  "remote-dev.open",
  "remote-dev.start",
] as const;

/** Safe identifier: cannot carry shell metacharacters or control sequences. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SAFE_REMOTE_PATH = /^\/[A-Za-z0-9_./-]{0,511}$/;
const SAFE_LOCAL_PATH = /^(~\/|\/)[A-Za-z0-9 _./()-]{0,511}$/;
const SAFE_DOCKER_HOST = /^unix:\/\/\/[A-Za-z0-9_./-]{1,255}$/;
const CONTAINER_ID = /^[0-9a-f]{64}$/;
const NO_CONTROL = /^[^\p{Cc}]+$/u;

export const TargetArgument = z.string().regex(SAFE_NAME);

const BoardUrl = z
  .string()
  .max(512)
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  }, "Board URLs must be https with no credentials, query, or fragment.");

const Host = z.strictObject({
  dockerHost: z.string().regex(SAFE_DOCKER_HOST),
  dockerPath: z.string().regex(SAFE_REMOTE_PATH),
  id: z.string().regex(SAFE_NAME),
  label: z.string().min(1).max(80).regex(NO_CONTROL),
  sshAlias: z.string().regex(SAFE_NAME),
});

const Target = z.strictObject({
  allowStart: z.boolean().optional(),
  board: BoardUrl.optional(),
  container: z.string().regex(SAFE_NAME),
  containerId: z.string().regex(CONTAINER_ID),
  guide: z.string().regex(SAFE_REMOTE_PATH).optional(),
  host: z.string().regex(SAFE_NAME),
  id: z.string().regex(SAFE_NAME),
  label: z.string().min(1).max(80).regex(NO_CONTROL),
  restore: z.strictObject({
    kind: z.literal("shepherdr-pilot"),
    claudeOAuthRef: z.string().regex(/^op:\/\/[^\r\n\0]+$/),
    shepherdrVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    credentialJobs: z.strictObject({
      manifest: z.string().startsWith("/").regex(SAFE_LOCAL_PATH),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }).optional(),
  }).optional(),
  role: z.enum(["development", "ui-pilot"]),
  serviceLog: z.string().regex(SAFE_REMOTE_PATH).optional(),
  workspaceFolder: z.string().regex(SAFE_REMOTE_PATH),
});

export const Config = z
  .strictObject({
    editor: z.strictObject({
      extensionsDir: z.string().regex(SAFE_LOCAL_PATH),
      userDataDir: z.string().regex(SAFE_LOCAL_PATH),
    }),
    hosts: z.array(Host).min(1).max(8),
    targets: z.array(Target).max(64),
    tools: z
      .strictObject({
        code: z.string().regex(SAFE_LOCAL_PATH).optional(),
        fzf: z.string().regex(SAFE_LOCAL_PATH).optional(),
        opener: z.string().regex(SAFE_LOCAL_PATH).optional(),
        pilotRuntime: z.string().regex(SAFE_LOCAL_PATH).optional(),
        ssh: z.string().regex(SAFE_LOCAL_PATH).optional(),
      })
      .optional(),
    version: z.literal(1),
  })
  .superRefine((config, context) => {
    const hostIds = new Set(config.hosts.map((host) => host.id));
    const targetIds = new Set<string>();
    for (const target of config.targets) {
      if (target.restore !== undefined && (!target.serviceLog?.startsWith("/home/agent/.local/state/pilot-runtime/") || !target.serviceLog.endsWith("/service.log") || target.serviceLog.split("/").includes(".."))) {
        context.addIssue({ code: "custom", message: "A pilot restore requires its retained native service.log path." });
      }
      if (!hostIds.has(target.host)) {
        context.addIssue({
          code: "custom",
          message: `Target ${target.id} names an unknown host.`,
        });
      }
      if (targetIds.has(target.id)) {
        context.addIssue({
          code: "custom",
          message: `Target ${target.id} is declared twice.`,
        });
      }
      targetIds.add(target.id);
    }
  });

export type RemoteDevConfig = z.infer<typeof Config>;
export type ConfiguredTarget = RemoteDevConfig["targets"][number];
export type ConfiguredHost = RemoteDevConfig["hosts"][number];

const Effects = z.strictObject({
  completed: z.array(z.string()),
  inventoryComplete: z.boolean(),
  remaining: z.array(z.string()),
  uncertain: z.array(z.string()),
});

const CAUSE_PREFIX = {
  domain: "DOMAIN_",
  internal: "INTERNAL_",
  schema: "SCHEMA_",
  transient: "TRANSIENT_",
  usage: "USAGE_",
} as const;

interface ResultFacts {
  causeCode: string;
  data: unknown;
  effectClass: string;
  effects: OperationResult["effects"];
  exitCode: number;
  failureClass: keyof typeof CAUSE_PREFIX | null;
  handoff?: unknown;
  nextAction?: string | undefined;
  outcome: string;
  repairAction: string | null;
  retryable: boolean;
  retryDelayMilliseconds?: number | undefined;
  transactionState: string;
}

function effectViolations(result: ResultFacts): string[] {
  const { completed, remaining, uncertain, inventoryComplete } = result.effects;
  const inventories = [completed, remaining, uncertain];
  const all = inventories.flat();
  const checks: [boolean, string][] = [
    [new Set(all).size === all.length, "Effect inventories must be disjoint and contain unique effects."],
    [inventories.every((items) => items.join("\n") === [...items].sort().join("\n")), "Effect inventories must be sorted."],
    [result.transactionState !== "partially-completed" || (completed.length > 0 && remaining.length > 0 && uncertain.length === 0 && inventoryComplete), "Partial results require a complete inventory of completed and remaining effects, with no uncertain effects."],
    [result.transactionState !== "unknown" || uncertain.length > 0, "Unknown results require uncertain effects."],
  ];
  return checks.filter(([valid]) => !valid).map(([, message]) => message);
}

function outcomeViolations(result: ResultFacts): string[] {
  if (result.outcome === "success") {
    const valid = result.exitCode === 0 && result.failureClass === null && result.causeCode.startsWith("SUCCESS_");
    return valid ? [] : ["Success requires exit 0, no failure class, and a SUCCESS_ cause."];
  }
  const prefix = result.failureClass === null ? "?" : CAUSE_PREFIX[result.failureClass];
  const violations: string[] = [];
  if (!result.causeCode.startsWith(prefix)) violations.push("Cause prefix must agree with the failure class.");
  if (result.data !== null || result.repairAction === null) violations.push("Failures carry null data and a repair action.");
  return violations;
}

/** Correlated Contract Core invariants checked before any envelope is written. */
function contractViolations(result: ResultFacts): string[] {
  const checks: [boolean, string][] = [
    [(result.handoff === undefined) !== (result.nextAction === undefined), "Exactly one of nextAction or handoff is required."],
    [result.outcome !== "refused" || result.transactionState === "unchanged", "Refusals leave the transaction unchanged."],
    [result.retryable === (result.retryDelayMilliseconds !== undefined), "Only retryable rows carry a retry delay."],
    [result.effectClass !== "inspect" || result.effects.completed.length === 0, "Inspect results complete no effects."],
  ];
  return [...outcomeViolations(result), ...effectViolations(result), ...checks.filter(([valid]) => !valid).map(([, message]) => message)];
}

const ResultSchema = z
  .strictObject({
    causeCode: z.string().regex(/^[A-Z][A-Z_]+$/),
    commandIdentity: z.enum(AVAILABLE_PATHS),
    data: z.unknown(),
    effectClass: z.enum(["external", "inspect"]),
    effects: Effects,
    exitCode: z.union([
      z.literal(0),
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(75),
    ]),
    failureClass: z
      .enum(["domain", "internal", "schema", "transient", "usage"])
      .nullable(),
    handoff: z
      .strictObject({
        inspect: z.array(z.string().min(1)).min(1),
        owner: z.enum(["human", "operator"]),
        reason: z.string().min(1),
        resource: z.strictObject({ id: z.string().min(1), kind: z.string().min(1) }).optional(),
      })
      .optional(),
    nextAction: z.string().min(1).optional(),
    outcome: z.enum(["failed", "refused", "success"]),
    repairAction: z.string().min(1).nullable(),
    retryable: z.boolean(),
    retryDelayMilliseconds: z.number().int().positive().max(60_000).optional(),
    runId: z.uuid(),
    transactionState: z.enum(["completed", "partially-completed", "unchanged", "unknown"]),
  })
  .superRefine((result, context) => {
    for (const message of contractViolations(result)) {
      context.addIssue({ code: "custom", message });
    }
  });

const EnvelopeSchema = z.strictObject({
  availablePaths: z.array(z.enum(AVAILABLE_PATHS)),
  contractVersion: z.literal("2.0.0"),
  envelopeVersion: z.literal(2),
  message: z.string().min(1),
  result: ResultSchema,
});

export type Envelope = z.infer<typeof EnvelopeSchema>;

export function envelope(result: OperationResult): Envelope {
  const { handoff, message: _message, nextAction, retryDelayMilliseconds, ...rest } =
    result;
  return EnvelopeSchema.parse({
    availablePaths: [...AVAILABLE_PATHS],
    contractVersion: "2.0.0",
    envelopeVersion: 2,
    message: result.message,
    result: {
      ...rest,
      ...(handoff === undefined
        ? { nextAction: nextAction ?? "No follow-up is required." }
        : { handoff }),
      ...(retryDelayMilliseconds === undefined ? {} : { retryDelayMilliseconds }),
      runId: randomUUID(),
    },
  });
}
