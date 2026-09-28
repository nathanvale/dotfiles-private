import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { OperationResult } from "./model.ts";

const identity = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9-]+$/),
  name: z.string().min(1).max(256),
});
const nullable = z.string().max(2000).nullable();
const line = z.strictObject({
  accountCode: nullable,
  accountName: nullable,
  taxType: nullable,
  amountMinor: z.number().int().safe(),
  amountBasis: z.enum(["tax-inclusive", "tax-exclusive", "no-tax"]).nullable(),
  tracking: z.record(z.string(), z.string()).optional(),
});
const transaction = z.strictObject({
  id: z.string().min(1).max(256),
  date: z.iso.date(),
  direction: z.enum(["in", "out"]),
  currency: z.string().regex(/^[A-Z]{3}$/),
  amountMinor: z.number().int().safe(),
  payee: nullable,
  description: nullable,
  contact: z.strictObject({ id: nullable, name: nullable }).nullable(),
  reconciled: z.boolean(),
  observedAt: z.iso.datetime(),
  lines: z.array(line).min(1),
});
const coverage = z.strictObject({
  from: z.iso.date().nullable(),
  to: z.iso.date().nullable(),
  query: nullable,
  observedAt: z.iso.datetime(),
  complete: z.boolean(),
});
export const Observation = z.strictObject({
  organisation: identity,
  bankAccount: identity,
  coverage: z.array(coverage),
  transactions: z.array(transaction),
});
export const CacheDocument = Observation.omit({ transactions: true }).extend({
  schemaVersion: z.literal(1),
  updatedAt: z.iso.datetime(),
  transactions: z.record(z.string(), transaction),
}).superRefine((value, ctx) => {
  for (const [key, transaction] of Object.entries(value.transactions)) {
    if (key !== transaction.id) ctx.addIssue({ code: "custom", message: "Transaction key must equal its verified ID." });
  }
});
export const PreviewDocument = z.strictObject({
  previewId: z.uuid(),
  baseHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  expectedHash: z.string().regex(/^[0-9a-f]{64}$/),
  proposed: CacheDocument,
  consumed: z.boolean(),
});
export type Observation = z.infer<typeof Observation>;
export type CacheDocument = z.infer<typeof CacheDocument>;
export type PreviewDocument = z.infer<typeof PreviewDocument>;

export const COMMANDS = [
  { commandIdentity: "xero-history.command-discovery", effectClass: "inspect", route: ["--discover-command"], summary: "Describe one command's possible outcomes." },
  { commandIdentity: "xero-history.discovery", effectClass: "inspect", route: ["--discover"], summary: "Describe the CLI contract." },
  { commandIdentity: "xero-history.help", effectClass: "inspect", route: ["--help"], summary: "Show command usage." },
  { commandIdentity: "xero-history.status", effectClass: "inspect", route: ["status"], summary: "Inspect one private account cache." },
  { commandIdentity: "xero-history.lookup", effectClass: "inspect", route: ["lookup"], summary: "Find cached examples in one account." },
  { commandIdentity: "xero-history.preview", effectClass: "repository-local", route: ["preview"], summary: "Prepare a guarded cache update." },
  { commandIdentity: "xero-history.apply", effectClass: "repository-local", route: ["apply"], summary: "Apply an approved preview." },
  { commandIdentity: "xero-history.recover", effectClass: "inspect", route: ["recover"], summary: "Inspect an interrupted update." },
] as const;
const PATHS = [
  "xero-history.apply", "xero-history.command-discovery", "xero-history.discovery",
  "xero-history.help", "xero-history.lookup", "xero-history.preview",
  "xero-history.recover", "xero-history.status",
] as const;

const effectSchema = z.strictObject({
  completed: z.array(z.string()),
  inventoryComplete: z.boolean(),
  remaining: z.array(z.string()),
  uncertain: z.array(z.string()),
});
const resultSchema = z.strictObject({
  runId: z.uuid(),
  commandIdentity: z.enum(PATHS),
  outcome: z.enum(["success", "refused", "failed"]),
  effectClass: z.enum(["inspect", "repository-local"]),
  transactionState: z.enum(["unchanged", "completed", "unknown"]),
  causeCode: z.enum([
    "SUCCESS_UNCHANGED", "SUCCESS_COMPLETED", "USAGE_INVALID_INVOCATION",
    "SCHEMA_INVALID_INPUT", "DOMAIN_PRECONDITION_UNMET", "DOMAIN_RECOVERY_HANDOFF_REQUIRED",
    "INTERNAL_RESULT_UNKNOWN", "INTERNAL_RESULT_UNCHANGED", "TRANSIENT_NOT_STARTED",
  ]),
  failureClass: z.enum(["usage", "schema", "domain", "internal", "transient"]).nullable(),
  exitCode: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(75)]),
  data: z.unknown(),
  retryable: z.boolean(),
  retryDelayMilliseconds: z.number().int().positive().max(1000).optional(),
  repairAction: z.string().nullable(),
  effects: effectSchema,
  nextAction: z.string().optional(),
  handoff: z.strictObject({ owner: z.enum(["human", "operator"]), reason: z.string().min(1), inspect: z.array(z.string()).min(1) }).optional(),
}).superRefine((value, ctx) => {
  if ((value.nextAction === undefined) === (value.handoff === undefined)) ctx.addIssue({ code: "custom", message: "exactly one guidance arm is required" });
  if (value.outcome === "success" && (value.exitCode !== 0 || value.failureClass !== null || value.repairAction !== null)) ctx.addIssue({ code: "custom", message: "invalid success correlation" });
  if (value.outcome !== "success" && (value.exitCode === 0 || value.failureClass === null || value.repairAction === null)) ctx.addIssue({ code: "custom", message: "invalid failure correlation" });
  if (value.retryable !== (value.retryDelayMilliseconds !== undefined)) ctx.addIssue({ code: "custom", message: "invalid retry correlation" });
  if (value.retryable && (value.exitCode !== 75 || value.failureClass !== "transient" || value.transactionState !== "unchanged")) ctx.addIssue({ code: "custom", message: "invalid transient correlation" });
});
const envelopeSchema = z.strictObject({
  envelopeVersion: z.literal(2),
  contractVersion: z.literal("2.0.0"),
  message: z.string().min(1),
  availablePaths: z.array(z.enum(PATHS)).length(PATHS.length),
  result: resultSchema,
});

export function envelope(result: OperationResult) {
  const { message, ...fields } = result;
  return envelopeSchema.parse({
    envelopeVersion: 2,
    contractVersion: "2.0.0",
    message,
    availablePaths: PATHS,
    result: { runId: randomUUID(), ...fields, nextAction: result.handoff === undefined ? (result.nextAction ?? "No follow-up is required.") : undefined },
  });
}
