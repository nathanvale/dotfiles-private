// The lane's Codex home links the caller's auth.json instead of copying it. This proves, with synthetic tokens and a
// local refresh endpoint, that a Codex token refresh writes through the link into the caller's file and leaves the link
// in place. No model call: `codex debug models` refreshes the stale token, then asks the local server for models.
import { afterAll, beforeAll, expect } from "bun:test"
import { lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type Lane, prepareLane } from "../src/lane.ts"
import { createFixture, type Fixture, laneLedger, removeFixture } from "./fixtures/harness.ts"

const proofs = laneLedger()
let fixture: Fixture

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
const token = (claims: Record<string, unknown>) => `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.synthetic`
const ACCOUNT = { "https://api.openai.com/auth": { chatgpt_account_id: "acct-synthetic", chatgpt_plan_type: "plus", chatgpt_user_id: "user-synthetic" } }
const ID_CLAIMS = { email: "synthetic@example.invalid", ...ACCOUNT }

beforeAll(() => {
	fixture = createFixture()
	// An expired synthetic access token makes Codex refresh before its first authenticated request.
	const expired = { OPENAI_API_KEY: null, tokens: { id_token: token({ ...ID_CLAIMS, exp: 1 }), access_token: token({ ...ACCOUNT, exp: 1 }), refresh_token: "ORIGINAL_SYNTHETIC", account_id: "acct-synthetic" }, last_refresh: "2020-01-01T00:00:00Z" }
	writeFileSync(join(fixture.root, "codex-home", "auth.json"), JSON.stringify(expired), { mode: 0o600 })
})

afterAll(() => {
	removeFixture(fixture)
})

function laneFromFixture(): Lane {
	const saved = { ...process.env }
	try {
		Object.assign(process.env, fixture.env)
		const lane = prepareLane()
		if (lane === null) throw new Error("fixture lane did not resolve")
		return lane
	} finally {
		process.env = saved
	}
}

proofs.test("a token refresh writes through the lane link into the caller's auth.json and keeps the link", async () => {
	const lane = laneFromFixture()
	const requests: string[] = []
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname
			requests.push(`${request.method} ${path}`)
			if (path === "/oauth/token") return Response.json({ id_token: token({ ...ID_CLAIMS, exp: 4102444800 }), access_token: token({ ...ACCOUNT, exp: 4102444800 }), refresh_token: "REFRESHED_SYNTHETIC" })
			return Response.json({ models: [] })
		},
	})
	try {
		const base = `http://127.0.0.1:${server.port}`
		const child = Bun.spawn({
			cmd: [lane.codex, "debug", "models", "-c", `chatgpt_base_url="${base}/backend-api/"`, "-c", `openai_base_url="${base}/v1"`],
			cwd: fixture.root,
			env: { ...lane.env, CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${base}/oauth/token` },
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			timeout: 30_000,
		})
		expect(await child.exited).toBe(0)
	} finally {
		server.stop(true)
	}
	expect(requests).toContain("POST /oauth/token")
	const link = join(lane.laneHome, "auth.json")
	expect(lstatSync(link).isSymbolicLink()).toBe(true)
	expect(readlinkSync(link)).toBe(lane.authTarget)
	const caller = JSON.parse(readFileSync(lane.authTarget, "utf8"))
	expect(caller.tokens.refresh_token).toBe("REFRESHED_SYNTHETIC")
}, 60_000)

proofs.pin(1)
