// Fake uvx for the Community Provider. Records which product variables are
// present and whether the token matches the fixture; never records a value.
import { writeFileSync } from "node:fs";
import path from "node:path";

const env = process.env;
const present = (key: string) => key in env;
writeFileSync(
	path.join(env.TMPDIR ?? "/tmp", "community-provider.json"),
	JSON.stringify({
		argv: process.argv.slice(2),
		jiraUrl: env.JIRA_URL ?? null,
		confluenceUrl: env.CONFLUENCE_URL ?? null,
		username: env.JIRA_USERNAME ?? env.CONFLUENCE_USERNAME ?? null,
		jiraKeys: ["JIRA_URL", "JIRA_USERNAME", "JIRA_API_TOKEN"].filter(present),
		confluenceKeys: ["CONFLUENCE_URL", "CONFLUENCE_USERNAME", "CONFLUENCE_API_TOKEN"].filter(present),
		tokenMatches: (env.JIRA_API_TOKEN ?? env.CONFLUENCE_API_TOKEN) === "fixture-community-secret",
		ambient: "AMBIENT_SENTINEL" in env,
		opToken: "OP_SERVICE_ACCOUNT_TOKEN" in env,
	}),
);
