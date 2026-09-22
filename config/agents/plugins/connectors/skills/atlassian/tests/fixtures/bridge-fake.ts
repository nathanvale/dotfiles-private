// Fake hyper-mcp-remote bridge. Records argv and the presence and shape of
// the injected authorization material; never records a value.
// TMPDIR/bridge-version overrides --version.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const receipts = process.env.TMPDIR ?? "/tmp";
if (process.argv[2] === "--version") {
	const pin = path.join(receipts, "bridge-version");
	const version = existsSync(pin) ? readFileSync(pin, "utf8").trim() : "0.5.0";
	process.stdout.write(`hyper-mcp-remote ${version}\n`);
	process.exit(0);
}
// Independent oracle: the Basic credential the fixture username and secret must produce.
const EXPECTED_BASIC = Buffer.from("service@example.invalid:fixture-atlassian-api-key").toString("base64");
writeFileSync(
	path.join(receipts, "official-provider.json"),
	JSON.stringify({
		argv: process.argv.slice(2),
		basicMatches: process.env.ATLASSIAN_BASIC === EXPECTED_BASIC,
		rawKeyPresent: "ATLASSIAN_API_KEY" in process.env,
		logPath: process.env.HYPER_MCP_REMOTE_LOG_PATH ?? null,
		ambient: "AMBIENT_SENTINEL" in process.env,
		opToken: "OP_SERVICE_ACCOUNT_TOKEN" in process.env,
	}),
);
