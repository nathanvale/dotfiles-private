// Test-only REST boundary for a private compiled-plugin copy. Responses are
// supplied by the test; this process does not implement Jira or a write oracle.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

type Reply = { status: number; body: unknown };
type Responses = Record<string, { before?: Reply; after?: Reply; write?: Reply }>;

export async function runRestProvider(_argv: readonly string[]): Promise<never> {
	const root = process.env.TMPDIR;
	if (!root) return process.exit(2);
	let request: { tool: string; args: unknown };
	try {
		request = JSON.parse(await Bun.stdin.text()) as { tool: string; args: unknown };
		if (typeof request.tool !== "string") return process.exit(2);
	} catch {
		return process.exit(2);
	}
	const entries = JSON.parse(readFileSync(path.join(root, "rest-responses.json"), "utf8")) as Responses;
	const row = entries[request.tool];
	if (!row) return process.exit(2);
	const marker = path.join(root, "rest-write-seen");
	const isWrite = row.write !== undefined;
	const reply = isWrite ? row.write : existsSync(marker) ? (row.after ?? row.before) : row.before;
	if (!reply) return process.exit(2);
	appendFileSync(path.join(root, "rest-calls.jsonl"), `${JSON.stringify(request)}\n`);
	if (isWrite) writeFileSync(marker, request.tool);
	process.stdout.write(`${JSON.stringify(reply)}\n`);
	return process.exit(0);
}
