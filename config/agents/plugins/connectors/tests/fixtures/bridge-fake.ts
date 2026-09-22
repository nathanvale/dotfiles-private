// PATH impostor used only to prove a version string cannot bypass the owned
// bridge pin. Successful Provider tests observe final exec separately.
// Records argv and the presence and shape of the injected authorization
// material against test-written expected values; never records a value.
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
// Independent oracles: the personal-token Basic value and Canva access token.
const EXPECTED_BASIC = Buffer.from("service@example.invalid:fixture-atlassian-api-key").toString("base64");
const EXPECTED_CANVA_ACCESS_TOKEN = "fixture-canva-access-token";
const CANVA_REFRESH_TOKEN = "fixture-canva-refresh-token";
const env = process.env;
const environmentText = JSON.stringify(env);
writeFileSync(
	path.join(receipts, "bridge.json"),
	JSON.stringify({
		argv: process.argv.slice(2),
		basicMatches: env.ATLASSIAN_BASIC === EXPECTED_BASIC,
		atlassianBearerPresent: "ATLASSIAN_BEARER" in env,
		rawKeyPresent: "ATLASSIAN_API_KEY" in env,
		canvaTokenMatches: env.CANVA_ACCESS_TOKEN === EXPECTED_CANVA_ACCESS_TOKEN,
		canvaRefreshPresent: environmentText.includes(CANVA_REFRESH_TOKEN) || process.argv.join(" ").includes(CANVA_REFRESH_TOKEN),
		logPath: env.HYPER_MCP_REMOTE_LOG_PATH ?? null,
		ambient: "AMBIENT_SENTINEL" in env,
		opToken: "OP_SERVICE_ACCOUNT_TOKEN" in env,
		environmentKeys: Object.keys(env).sort(),
	}),
);
