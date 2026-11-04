// The one owner of test-owned process faults. Each fault patches one real seam inside the target process before the
// shipped runtime loads; the product carries no fault hook. Consumers: fault-preload.ts (process tests, through
// BUN_OPTIONS) and checker-adapter.ts (strict checker, through argv markers).
import fs from "node:fs";

export type HandoffCorruption = "extra-key" | "resource-missing-kind" | "resource-blank-id" | "resource-extra-key" | "resource-valid";

export type Fault =
  | { kind: "serializer" }
  | { kind: "stdout-throw" }
  | { kind: "read-errno"; code: string }
  | { kind: "closed-stdout"; ready: string; release: string }
  | { kind: "handoff-corrupt"; variant: HandoffCorruption };

export type Envelope = { result: { handoff: Record<string, unknown> } & Record<string, unknown> } & Record<string, unknown>;

const HANDOFF_CHANGES: Readonly<Record<HandoffCorruption, Record<string, unknown>>> = {
  "extra-key": { escalate: true },
  "resource-missing-kind": { resource: { id: "closeout-packet" } },
  "resource-blank-id": { resource: { id: " ", kind: "file" } },
  "resource-extra-key": { resource: { id: "closeout-packet", kind: "file", path: "/tmp" } },
  "resource-valid": { resource: { id: "closeout-packet", kind: "file" } },
};

/** One handoff corruption applied to an envelope copy; also used by tests to ask the owned contract about it. */
export function corruptHandoff(envelope: Envelope, variant: HandoffCorruption): Envelope {
  return { ...envelope, result: { ...envelope.result, handoff: { ...envelope.result.handoff, ...HANDOFF_CHANGES[variant] } } };
}

function hasHandoff(value: unknown): value is Envelope {
  const result = (value as { result?: { handoff?: unknown } } | null)?.result;
  return typeof result?.handoff === "object" && result.handoff !== null;
}

/** The success-envelope serialization throws once, as an unserializable result would. Stacks with later faults. */
function installSerializerFault(): void {
  const stringify = JSON.stringify;
  let fired = false;
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    const [value] = args;
    if (!fired && typeof value === "object" && value !== null && (value as { result?: { outcome?: unknown } }).result?.outcome === "success") {
      fired = true;
      throw new Error("fixture serializer failure");
    }
    return stringify(...args);
  }) as typeof JSON.stringify;
}

/** The first handoff-bearing envelope serializes with one corrupted handoff, so final validation sees the bad bytes. */
function installHandoffCorruptFault(variant: HandoffCorruption): void {
  const stringify = JSON.stringify;
  let fired = false;
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    const [value, ...rest] = args;
    if (!fired && hasHandoff(value)) {
      fired = true;
      return stringify(corruptHandoff(value, variant), ...rest);
    }
    return stringify(...args);
  }) as typeof JSON.stringify;
}

/** The first stdout write throws synchronously, as a broken transport would. */
function installStdoutThrowFault(): void {
  const write = process.stdout.write.bind(process.stdout);
  let failed = false;
  process.stdout.write = ((...args: Parameters<typeof process.stdout.write>) => {
    if (!failed) {
      failed = true;
      throw new Error("fixture stdout failure");
    }
    return write(...args);
  }) as typeof process.stdout.write;
}

/** The first input-file read throws an error carrying the errno code, as the OS would. */
function installReadErrnoFault(code: string): void {
  const read = fs.readFileSync;
  fs.readFileSync = ((..._args: Parameters<typeof fs.readFileSync>) => {
    fs.readFileSync = read;
    throw Object.assign(new Error(`fixture ${code}`), { code });
  }) as typeof fs.readFileSync;
}

/** Hold the process before it writes until the test has closed its real stdout reader. */
async function installClosedStdoutFault(ready: string, release: string): Promise<void> {
  fs.writeFileSync(ready, "ready");
  while (!fs.existsSync(release)) await Bun.sleep(1);
}

export async function installFault(fault: Fault): Promise<void> {
  if (fault.kind === "serializer") installSerializerFault();
  else if (fault.kind === "stdout-throw") installStdoutThrowFault();
  else if (fault.kind === "read-errno") installReadErrnoFault(fault.code);
  else if (fault.kind === "handoff-corrupt") installHandoffCorruptFault(fault.variant);
  else await installClosedStdoutFault(fault.ready, fault.release);
}

/** Installs faults in order; a later fault wraps the earlier ones. */
export async function installFaults(faults: readonly Fault[]): Promise<void> {
  for (const fault of faults) await installFault(fault);
}
