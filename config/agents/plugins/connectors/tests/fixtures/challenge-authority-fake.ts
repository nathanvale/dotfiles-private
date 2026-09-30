#!/usr/bin/env bun
// Independent, test-owned policy. The adapter cannot choose an accepted item.
const ACCEPTED_REFERENCE = "fixture-challenge/allowed";
const request = JSON.parse(await Bun.stdin.text()) as { nonce?: unknown; reference?: unknown };
const accepted = request.reference === ACCEPTED_REFERENCE && typeof request.nonce === "string" && /^[0-9a-f-]{36}$/.test(request.nonce);
await Bun.write(`${process.env.TMPDIR ?? "/tmp"}/challenge-authority.json`, JSON.stringify({
	reference: request.reference,
	nonce: request.nonce,
	accepted,
	ambientSentinelPresent: process.env.AMBIENT_SENTINEL !== undefined,
	credentialSentinelPresent: process.env.OP_SERVICE_ACCOUNT_TOKEN !== undefined,
}));
// A deliberate mismatched response proves the adapter checks the protocol,
// rather than treating any affirmative authority output as authentication.
const replay = request.reference === "fixture-challenge/replay";
process.stdout.write(JSON.stringify({ nonce: replay ? "00000000-0000-0000-0000-000000000000" : request.nonce, decision: accepted || replay ? "allow" : "deny" }));
