// Test-owned strict-checker target adapter. Run only as `bun tests/fixtures/checker-adapter.ts ARGS`; never imported by
// product code. Each marker argument is removed, its fault is installed through the one fault owner (faults.ts), and
// then the shipped runtime loads:
// - `--checker-fault=serializer`: the success-envelope serialization throws, so INTERNAL_RESULT_UNCHANGED answers.
// - `--checker-fault=read-errno:CODE`: the first input-file read throws an error carrying CODE, as the OS would.
import { join } from "node:path";
import { type Fault, installFault } from "./faults.ts";

// The generated runtime is plain JavaScript with no declarations; it is loaded by path as the process entry.
const RUNTIME = join(import.meta.dir, "../../../../runtime/closeout-packet.js");
const MARKER = "--checker-fault=";

function takeFault(): Fault | null {
  const index = process.argv.findIndex((argument) => argument.startsWith(MARKER));
  if (index === -1) return null;
  const [marker = ""] = process.argv.splice(index, 1);
  const spec = marker.slice(MARKER.length);
  if (spec === "serializer") return { kind: "serializer" };
  if (spec.startsWith("read-errno:")) return { kind: "read-errno", code: spec.slice("read-errno:".length) };
  throw new Error(`unknown checker fault ${spec}`);
}

const fault = takeFault();
if (fault !== null) await installFault(fault);
await import(RUNTIME);
