// The one owner of test-owned process faults. Each fault patches one real seam inside the target process before the
// shipped runtime loads; the product carries no fault hook. Consumers: fault-preload.ts (process tests, through
// BUN_OPTIONS) and checker-adapter.ts (strict checker, through argv markers).
import fs from "node:fs";

export type Fault =
  | { kind: "serializer" }
  | { kind: "stdout-throw" }
  | { kind: "read-errno"; code: string }
  | { kind: "closed-stdout"; ready: string; release: string };

/** The success-envelope serialization throws once, as an unserializable result would. */
function installSerializerFault(): void {
  const stringify = JSON.stringify;
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    const [value] = args;
    if (typeof value === "object" && value !== null && (value as { result?: { outcome?: unknown } }).result?.outcome === "success") {
      JSON.stringify = stringify;
      throw new Error("fixture serializer failure");
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
  else await installClosedStdoutFault(fault.ready, fault.release);
}
