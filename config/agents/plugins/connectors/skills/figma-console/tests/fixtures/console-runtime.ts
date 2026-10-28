// Fixture Console entrypoint the Provider replaces itself with. It records
// what reached it: argv, pid, cwd, environment key names, and whether the
// token equals the fixture PAT; never a value. Its fixture root is HOME's
// grandparent: the Provider gives it HOME=<profile>/home under the state root.
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.env.FIGMA_CONSOLE_FIXTURE_ROOT ?? readFileSync(path.join(path.dirname(process.argv[1] ?? ""), "fixture-root"), "utf8").trim();
const expected = readFileSync(path.join(root, "expected-figma-token"), "utf8");
appendFileSync(path.join(root, "console-starts.jsonl"), `${JSON.stringify({ argv: process.argv.slice(1), pid: process.pid, envKeys: Object.keys(process.env).sort(), tokenMatches: process.env.FIGMA_ACCESS_TOKEN === expected, home: process.env.HOME, tmpdir: process.env.TMPDIR, path: process.env.PATH })}\n`);
