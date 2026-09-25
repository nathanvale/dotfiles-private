// A wrong MCPorter placed first on PATH. Reaching it at all is the failure
// the tests look for; it records that it ran and answers nothing useful.
import { appendFileSync } from "node:fs";
import path from "node:path";

appendFileSync(path.join(process.env.TMPDIR ?? "/tmp", "hostile-mcporter.jsonl"), `${JSON.stringify({ argv: process.argv.slice(2) })}\n`);
process.stdout.write('{"hijacked":true}\n');
process.exit(0);
