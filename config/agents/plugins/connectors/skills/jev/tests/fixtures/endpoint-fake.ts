import { readFileSync } from "node:fs";
import path from "node:path";
// connectors-test-jev-endpoint-fake: substituted only in the verified test copy.
export const API_ORIGIN = readFileSync(path.join(path.dirname(process.env.HOME ?? "/nonexistent"), "jev-endpoint"), "utf8").trim();
export const HTTP_TIMEOUT_MS = Number(readFileSync(path.join(path.dirname(process.env.HOME ?? "/nonexistent"), "jev-http-timeout"), "utf8"));
