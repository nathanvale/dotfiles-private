#!/usr/bin/env bun
// Independent fixture authority (T2, Ticket #89 under Spec #87, Spec AC23).
// A standalone, test-only process consulted by bin/adapters/test-auth.ts's
// attemptAuth: it holds its own fixed, nonsecret accepted identity,
// entirely independent of whatever the caller passes, and the adapter maps
// this process's verdict rather than deciding from its own input shape.
// Never contacted over a network; never reads, writes, or echoes a secret.
const ACCEPTED_IDENTITY = "1Password:API Credentials/fixture-item";
const identityIndex = process.argv.indexOf("--identity");
const identity = identityIndex === -1 ? undefined : process.argv[identityIndex + 1];
const accepted = identity === ACCEPTED_IDENTITY;

// Matches mcporter-fake.ts's own existing receipt convention exactly: write
// to TMPDIR, the one writable path the harness forwards. Independent test
// evidence of what this authority actually observed and decided.
const receiptDir = process.env.TMPDIR ?? "/tmp";
await Bun.write(
	`${receiptDir}/fixture-authority.json`,
	JSON.stringify({
		identity,
		accepted,
		ambientSentinelPresent: process.env.AMBIENT_SENTINEL !== undefined,
		credentialSentinelPresent: process.env.OP_SERVICE_ACCOUNT_TOKEN !== undefined,
	}),
);

process.exit(accepted ? 0 : 1);
