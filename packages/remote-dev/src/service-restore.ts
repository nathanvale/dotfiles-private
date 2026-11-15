import { z } from "zod";
import { runProgram } from "./runtime.ts";

const JobEffect = z.enum(["registered:cache", "registered:delivery", "started:cache", "started:delivery"]);
const CredentialEffects = z.object({ completed: z.array(JobEffect), uncertain: z.array(JobEffect) }).refine(({ completed, uncertain }) => new Set([...completed, ...uncertain]).size === completed.length + uncertain.length);
const Reply = z.object({
  attempted: z.boolean(),
  started: z.array(z.enum(["core", "tailscale", "shepherdr"])),
  status: z.enum(["ready", "missing", "failed"]),
  credentials: z.boolean().optional(),
  credentialsChanged: z.boolean().optional(),
  credentialEffects: CredentialEffects.optional(),
});

export type ServiceRestore = ({ ok: true; changed: boolean } | { ok: false; attempted: boolean }) & { effects: { completed: string[]; uncertain: string[]; inventoryComplete: boolean } };

function unknown(attempted: boolean): ServiceRestore {
  return { ok: false, attempted, effects: { completed: [], uncertain: [], inventoryComplete: !attempted } };
}

export async function restoreServices(program: string, args: string[], environment: Record<string, string>, requireCredentials = false): Promise<ServiceRestore> {
  const result = await runProgram(program, args, { environment, timeoutMs: 300_000 });
  if (result.kind === "missing") return unknown(false);
  if (result.kind !== "exited") return unknown(true);
  let data: unknown;
  try { data = JSON.parse(result.stdout); } catch { return unknown(true); }
  const reply = Reply.safeParse(data);
  if (!reply.success) return unknown(true);
  return interpretReply(reply.data, result.exitCode, requireCredentials);
}

function interpretReply(value: z.infer<typeof Reply>, exitCode: number, requireCredentials: boolean): ServiceRestore {
  if (requireCredentials && value.attempted && value.credentialEffects === undefined) return unknown(true);
  const effects = { completed: value.credentialEffects?.completed ?? [], uncertain: value.credentialEffects?.uncertain ?? [], inventoryComplete: !requireCredentials || value.credentialEffects !== undefined || !value.attempted };
  if (exitCode === 0 && value.status === "ready" && effects.uncertain.length === 0 && (!requireCredentials || value.credentials === true)) return { ok: true, changed: value.started.length > 0 || value.credentialsChanged === true, effects };
  // Credential intents account for credential-only attempts. Preserve an
  // aggregate uncertainty when native service startup or its reply is unknown.
  return { ok: false, attempted: value.started.length > 0 || (value.attempted && effects.completed.length + effects.uncertain.length === 0), effects };
}
