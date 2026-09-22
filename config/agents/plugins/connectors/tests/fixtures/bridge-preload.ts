// Test-only observation at the final process replacement. Production bridge
// ownership, digest, and version checks have already run by this point.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DIGESTS: Record<string, string> = {
	"darwin-arm64": "26b92a983fb2f70dc60b0d8b4f7389a502dbce8919fc71c0760cc920fa68a502",
	"linux-arm64": "f0fbc5ee100b4a3ad2d889d94b75e6aa9261b3abfa040242c57ce7c9fef5c6a9",
	"linux-x64": "b6af910017b371c7961f33fff768205c2ac59b4e6e1a41b86caa07481f4e36a5",
};
const originalExecve = process.execve;
if (!originalExecve) throw new Error("fixture requires Bun process.execve");
process.execve = (file, argv, env) => {
	if (path.basename(file) !== "hyper-mcp-remote") return originalExecve(file, argv, env);
	if (!argv || !env) throw new Error("fixture missing bridge arguments or environment");
	const receipts = env.TMPDIR;
	if (!receipts) throw new Error("fixture missing receipt directory");
	const state = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(env.HOME ?? "", ".local", "state");
	const expected = path.join(state, "connectors", "bridge", "0.5.0", "hyper-mcp-remote");
	const digest = new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex");
	const pinnedDigestMatches = file === expected && digest === DIGESTS[`${process.platform}-${process.arch}`];
	if (!pinnedDigestMatches) throw new Error("fixture saw an unpinned bridge replacement");
	const environmentText = JSON.stringify(env);
	writeFileSync(path.join(receipts, "bridge.json"), JSON.stringify({
		executable: file,
		pinnedDigestMatches,
		argv: argv.slice(1),
		basicMatches: env.ATLASSIAN_BASIC === Buffer.from("service@example.invalid:fixture-atlassian-api-key").toString("base64"),
		atlassianBearerPresent: "ATLASSIAN_BEARER" in env,
		rawKeyPresent: "ATLASSIAN_API_KEY" in env,
		canvaTokenMatches: env.CANVA_ACCESS_TOKEN === "fixture-canva-access-token",
		canvaRefreshPresent: environmentText.includes("fixture-canva-refresh-token") || argv.join(" ").includes("fixture-canva-refresh-token"),
		logPath: env.HYPER_MCP_REMOTE_LOG_PATH ?? null,
		ambient: "AMBIENT_SENTINEL" in env,
		opToken: "OP_SERVICE_ACCOUNT_TOKEN" in env,
		environmentKeys: Object.keys(env).sort(),
	}));
	process.exit(0);
};
