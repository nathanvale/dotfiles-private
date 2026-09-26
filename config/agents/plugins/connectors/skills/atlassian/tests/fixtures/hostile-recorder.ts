// A same-named tool placed first on the packaged proof's PATH (bun, node, op,
// uv, uvx). The packaged front door must never resolve any of them from PATH;
// reaching one at all is the failure the tests look for. It records its own
// name and argv, never an environment value, and answers nothing useful.
import { appendFileSync } from "node:fs";
import path from "node:path";

appendFileSync(path.join(process.env.TMPDIR ?? "/tmp", "hostile-recorders.jsonl"), `${JSON.stringify({ name: path.basename(process.argv[1] ?? ""), argv: process.argv.slice(2) })}\n`);
process.exit(97);
