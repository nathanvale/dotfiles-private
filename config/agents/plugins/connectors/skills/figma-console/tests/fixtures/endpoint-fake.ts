// Test-owned stand-in for scripts/endpoint.ts inside a private plugin copy:
// the loopback identity origin recorded beside the fixture HOME.
import { readFileSync } from "node:fs";
import path from "node:path";
export const FIGMA_API_ORIGIN = readFileSync(path.join(path.dirname(process.env.HOME ?? "/nonexistent"), "figma-api-origin"), "utf8").trim();
