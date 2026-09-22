// The one test-owned Canva Session fixture. Process tests vary the account,
// authorization server, clock, or selected fields while this owner keeps the
// sealed persisted record and its token literals identical across consumers.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SessionRecord } from "../../scripts/session/store.ts";

export const FIXTURE_ACCESS_TOKEN = "fixture-canva-access-token";
export const FIXTURE_REFRESH_TOKEN = "fixture-canva-refresh-token";

export interface FixtureServer {
	url: string;
	issuer: string;
	resource: string;
}

export interface SessionFixtureOptions {
	account?: string;
	now?: number;
	server?: FixtureServer;
	overrides?: Partial<Omit<SessionRecord, "version" | "account">>;
}

const DEFAULT_SERVER: FixtureServer = {
	url: "https://mcp.canva.com",
	issuer: "https://mcp.canva.com",
	resource: "https://mcp.canva.com/mcp",
};

export function writeSessionFixture(stateRoot: string, options: SessionFixtureOptions = {}): string {
	const account = options.account ?? "personal";
	const now = options.now ?? Date.now();
	const server = options.server ?? DEFAULT_SERVER;
	const directory = path.join(stateRoot, "connectors", "canva", account);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const record: SessionRecord = {
		version: 1,
		account,
		client: { mode: "dcr", clientId: "fixture-client-1", redirectUri: "http://127.0.0.1:47391/callback" },
		issuer: server.issuer,
		resource: server.resource,
		tokenEndpoint: `${server.url}/token`,
		revocationEndpoint: `${server.url}${server.url.startsWith("http://127.0.0.1:") ? "/revoke" : "/token"}`,
		scope: "design:meta:read",
		accessToken: FIXTURE_ACCESS_TOKEN,
		accessTokenExpiresAt: now + 3_600_000,
		refreshToken: FIXTURE_REFRESH_TOKEN,
		obtainedAt: now,
		...options.overrides,
	};
	const file = path.join(directory, "session.json");
	writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
	return file;
}
