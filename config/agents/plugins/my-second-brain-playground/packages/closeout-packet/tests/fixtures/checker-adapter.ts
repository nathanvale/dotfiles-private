// Test-owned strict-checker target adapter. Run only as `bun tests/fixtures/checker-adapter.ts ARGS`; never imported by
// product code. Each marker argument is removed before the real CLI loads, then injects one fault at a real seam:
// - `--checker-fault=serializer`: the success-envelope serialization throws, so INTERNAL_RESULT_UNCHANGED answers.
// - `--checker-fault=read-errno:CODE`: the first input-file read throws an error carrying CODE, as the OS would.
import fs from "node:fs";

const SERIALIZER_FAULT = "--checker-fault=serializer";
const READ_ERRNO_FAULT = "--checker-fault=read-errno:";

function takeMarker(match: (argument: string) => boolean): string | null {
  const index = process.argv.findIndex(match);
  if (index === -1) return null;
  const [marker] = process.argv.splice(index, 1);
  return marker ?? null;
}

if (takeMarker((argument) => argument === SERIALIZER_FAULT) !== null) {
  const stringify = JSON.stringify;
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    const [value] = args;
    if (typeof value === "object" && value !== null && (value as { result?: { outcome?: string } }).result?.outcome === "success") {
      JSON.stringify = stringify;
      throw new Error("fixture serializer failure");
    }
    return stringify(...args);
  }) as typeof JSON.stringify;
}

const readErrno = takeMarker((argument) => argument.startsWith(READ_ERRNO_FAULT));
if (readErrno !== null) {
  const read = fs.readFileSync;
  const code = readErrno.slice(READ_ERRNO_FAULT.length);
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    fs.readFileSync = read;
    throw Object.assign(new Error(`fixture ${code}`), { code });
  }) as typeof fs.readFileSync;
}

await import("../../src/cli.ts");
