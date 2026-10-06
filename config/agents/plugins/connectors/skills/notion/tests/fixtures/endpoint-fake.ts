import { readFileSync } from "node:fs";
import path from "node:path";
export const NOTION_ENDPOINT = readFileSync(path.join(path.dirname(process.env.HOME ?? "/nonexistent"), "notion-endpoint"), "utf8").trim();
