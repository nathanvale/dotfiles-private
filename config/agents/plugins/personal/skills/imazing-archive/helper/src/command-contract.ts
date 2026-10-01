import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ALBUM_SELECTIONS,
  CONTAINS_MEME,
  IMAGE_TYPES,
  type OperationResult,
} from "./model.ts";

export const COMMANDS = [
  {
    commandIdentity: "imazing-archive.command-discovery",
    effectClass: "inspect",
    route: ["--discover-command"],
    summary: "Describe one command's possible outcomes.",
  },
  {
    commandIdentity: "imazing-archive.decide",
    effectClass: "repository-local",
    route: ["decide"],
    summary: "Record a classification or keeper decision for one item.",
  },
  {
    commandIdentity: "imazing-archive.discovery",
    effectClass: "inspect",
    route: ["--discover"],
    summary: "Describe the CLI contract.",
  },
  {
    commandIdentity: "imazing-archive.dispatch",
    effectClass: "inspect",
    route: [],
    summary: "Refuse an unsupported invocation.",
  },
  {
    commandIdentity: "imazing-archive.help",
    effectClass: "inspect",
    route: ["--help"],
    summary: "Show command usage.",
  },
  {
    commandIdentity: "imazing-archive.import",
    effectClass: "repository-local",
    route: ["import"],
    summary: "Preview or apply one iMazing CSV export into the archive.",
  },
  {
    commandIdentity: "imazing-archive.recover",
    effectClass: "inspect",
    route: ["recover"],
    summary: "Inspect an interrupted import without replaying it.",
  },
  {
    commandIdentity: "imazing-archive.status",
    effectClass: "inspect",
    route: ["status"],
    summary: "Count archive records, unresolved links, and pending images.",
  },
] as const;

const PATHS = COMMANDS.map((command) => command.commandIdentity);
type CommandIdentity = (typeof PATHS)[number];

const CAUSES = [
  "DOMAIN_PRECONDITION_UNMET",
  "DOMAIN_PREVIEW_STALE",
  "DOMAIN_RECOVERY_UNPROVABLE",
  "INTERNAL_RESULT_UNCHANGED",
  "INTERNAL_RESULT_UNKNOWN",
  "SCHEMA_INVALID_INPUT",
  "SUCCESS_COMPLETED",
  "SUCCESS_UNCHANGED",
  "TRANSIENT_NOT_STARTED",
  "USAGE_INVALID_INVOCATION",
] as const;

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/);
const ITEM_KEY = z.string().regex(/^itm_[0-9a-f]{24}$/);
const DIRECTION = z.enum(["incoming", "notification", "outgoing"]);

export const ItemRecordSchema = z.strictObject({
  attachment: z
    .strictObject({ originalName: z.string(), type: z.string() })
    .nullable(),
  deletedDate: z.string().nullable(),
  deliveredDate: z.string(),
  direction: DIRECTION,
  editedDate: z.string(),
  fingerprint: SHA256,
  firstSeen: z.strictObject({
    exportSha256: SHA256,
    row: z.number().int().positive(),
  }),
  itemKey: ITEM_KEY,
  messageDate: z.string(),
  messageId: z.string().nullable(),
  part: z.string().nullable(),
  reactions: z.string().nullable(),
  readDate: z.string(),
  recordVersion: z.literal(1),
  replyingTo: z.string(),
  senderName: z.string(),
  service: z.string(),
  status: z.string(),
  text: z.string(),
});

export const ObservationRecordSchema = z.strictObject({
  ambiguousCandidates: z.array(ITEM_KEY),
  exportSha256: SHA256,
  itemKey: ITEM_KEY.nullable(),
  messageId: z.string().nullable(),
  part: z.string().nullable(),
  recordVersion: z.literal(1),
  row: z.number().int().positive(),
  strategy: z.enum([
    "ambiguous-fingerprint",
    "fingerprint-match",
    "fingerprint-new",
    "message-id-linked-fingerprint",
    "message-id-match",
    "message-id-new",
  ]),
});

export const AssociationRecordSchema = z.strictObject({
  associationKey: z.string().min(1),
  candidates: z.array(z.string()),
  detectedImageType: z.enum(IMAGE_TYPES),
  exportSha256: SHA256,
  exportedPath: z.string().nullable(),
  itemKey: ITEM_KEY,
  mediaKind: z.enum(["attachment", "audio", "image", "video", "web-link"]),
  originalName: z.string().nullable(),
  recordVersion: z.literal(1),
  row: z.number().int().positive(),
  sha256: SHA256.nullable(),
  source: z.enum(["attachment-cell", "web-link"]),
  status: z.enum(["ambiguous", "missing", "resolved"]),
  strategy: z.enum(["exact", "none", "variant-name", "web-link-timestamp"]),
});

export const BlobRecordSchema = z.strictObject({
  path: z.string().regex(/^blobs\/[0-9a-f]{2}\/[0-9a-f]{64}(\.[a-z0-9]+)?$/),
  recordVersion: z.literal(1),
  sha256: SHA256,
  size: z.number().int().nonnegative(),
  sourcePath: z.string(),
});

export const DecisionRecordSchema = z.strictObject({
  albumSelection: z.enum(ALBUM_SELECTIONS).optional(),
  containsMeme: z.enum(CONTAINS_MEME).optional(),
  imageType: z.enum(IMAGE_TYPES).optional(),
  itemKey: ITEM_KEY,
  recordVersion: z.literal(1),
  recordedAt: z.iso.datetime(),
  visualReview: z.enum(["pending", "reviewed"]).optional(),
});

export const DecideInput = DecisionRecordSchema.omit({
  recordVersion: true,
  recordedAt: true,
}).refine(
  (value) => Object.keys(value).length > 1,
  "Pass at least one decision field.",
);

export const ReceiptMarker = z.object({ planDigest: SHA256 });

const resultSchema = z
  .strictObject({
    causeCode: z.enum(CAUSES),
    commandIdentity: z.enum(PATHS as [CommandIdentity, ...CommandIdentity[]]),
    data: z.unknown(),
    effectClass: z.enum(["inspect", "repository-local"]),
    effects: z.strictObject({
      completed: z.array(z.string()),
      inventoryComplete: z.boolean(),
      remaining: z.array(z.string()),
      uncertain: z.array(z.string()),
    }),
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
      })
      .optional(),
    nextAction: z.string().min(1).optional(),
    outcome: z.enum(["failed", "refused", "success"]),
    repairAction: z.string().min(1).nullable(),
    retryDelayMilliseconds: z.number().int().positive().optional(),
    retryable: z.boolean(),
    runId: z.uuid(),
    transactionState: z.enum(["completed", "unchanged", "unknown"]),
  })
  .superRefine((value, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: "custom", message });
    if ((value.nextAction === undefined) === (value.handoff === undefined)) {
      issue("exactly one guidance arm is required");
    }
    if ((value.outcome === "success") !== (value.exitCode === 0)) {
      issue("outcome and exit disagree");
    }
    if (value.outcome !== "success" && value.data !== null) {
      issue("failure data must be null");
    }
    if (value.retryable !== (value.retryDelayMilliseconds !== undefined)) {
      issue("retry delay must accompany a retryable result");
    }
  });

const envelopeSchema = z.strictObject({
  availablePaths: z.array(z.string()),
  contractVersion: z.literal("2.0.0"),
  envelopeVersion: z.literal(2),
  message: z.string().min(1),
  result: resultSchema,
});

export type Envelope = z.infer<typeof envelopeSchema>;

export function envelope(result: OperationResult): Envelope {
  const { message, handoff, nextAction, ...fields } = result;
  return envelopeSchema.parse({
    availablePaths: [...PATHS].sort(),
    contractVersion: "2.0.0",
    envelopeVersion: 2,
    message,
    result: {
      ...fields,
      ...(handoff === undefined
        ? { nextAction: nextAction ?? "No follow-up is required." }
        : { handoff }),
      runId: randomUUID(),
    },
  });
}
