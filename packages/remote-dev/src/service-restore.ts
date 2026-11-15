import { z } from "zod";
import { runProgram } from "./runtime.ts";

const Reply = z.object({
  attempted: z.boolean(),
  started: z.array(z.enum(["core", "tailscale", "shepherdr"])),
  status: z.enum(["ready", "missing", "failed"]),
  credentials: z.boolean().optional(),
  credentialsChanged: z.boolean().optional(),
});

export type ServiceRestore = { ok: true; changed: boolean } | { ok: false; attempted: boolean };

export async function restoreServices(program: string, args: string[], environment: Record<string, string>, requireCredentials = false): Promise<ServiceRestore> {
  const result = await runProgram(program, args, { environment, timeoutMs: 300_000 });
  if (result.kind === "missing") return { ok: false, attempted: false };
  if (result.kind !== "exited") return { ok: false, attempted: true };
  let data: unknown;
  try { data = JSON.parse(result.stdout); } catch { return { ok: false, attempted: true }; }
  const reply = Reply.safeParse(data);
  if (!reply.success) return { ok: false, attempted: true };
  if (result.exitCode === 0 && reply.data.status === "ready" && (!requireCredentials || reply.data.credentials === true)) return { ok: true, changed: reply.data.started.length > 0 || reply.data.credentialsChanged === true };
  return { ok: false, attempted: reply.data.attempted || reply.data.started.length > 0 };
}
