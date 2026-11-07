---
name: credential-custody
description: Diagnose Mac credential and Keychain failures, route credential setup or storage to its existing owner, and hand access between hosts or agent sessions without exposing secrets.
---

# Credential custody

Start with one failing operation on one host and one process context. A working
credential in another terminal, harness, or Mac does not establish access here.

## Diagnose before repair

1. Name the host, account, harness, intended operation, and credential owner.
   Establish the expected hostname, account home, and account name from the
   known target. An SSH alias is not the kernel hostname.
2. Run the metadata doctor from this loaded skill directory. Set the three
   expectation variables from that target record, independently of the current
   process environment. Set `CREDENTIAL_CONTEXT` to `local` or `ssh`.

   ```sh
   python3 "$CREDENTIAL_SKILL_DIR/scripts/doctor.py" \
     --expect-host "$CREDENTIAL_EXPECTED_HOST" \
     --expect-user "$CREDENTIAL_EXPECTED_USER" \
     --expect-home "$CREDENTIAL_EXPECTED_HOME" \
     --context "$CREDENTIAL_CONTEXT"
   ```

3. Require exit 0 and `status: metadata-ok` for the normal-login metadata journey.
   This proves the selected metadata observations only. Credentials, unlock
   state, authentication, requesting client, and request security session remain
   `not_checked`. SSH environment hints and GUI-domain presence do not prove
   which security session executes a request.
4. On a blocked result, follow [the cause routes](references/causes.md). Preserve
   its fixed cause and the exact host and process context. Complete this step
   when the next owner and unmet precondition are known. Do not repeatedly
   retry a different credential path to hide the original failure. An owner
   that intentionally uses a file store or another keychain can verify its own
   preconditions under existing authority. Keep the normal-login journey
   blocked rather than treating that different path as its recovery.

## Set up or deliver through the owner

Choose the branch that owns the credential. Read that owner's instructions
before executing its operations.

- Scoped 1Password credentials belong to [one-password](../one-password/SKILL.md).
  Its `with-one-password-token` wrapper owns Keychain delivery and its existing
  private fallback. `check` reads actual token custody and can start a temporary
  desktop job over SSH. It is a separate credential operation, not this doctor.
  Use the declared mapping and wrapper injection for an authorized consumer.
- 1Password Developer Environments and `.env` mounts belong to the installed
  `1password:1password-environments` skill. Keep its native approval and mount
  workflow. Never source a credential file to diagnose access.
- Codex and Claude Code sign-in belong to the harness's native auth workflow.
  Read `codex login --help` or `claude auth --help` in the intended process.
  Keep `HOME`, `CODEX_HOME`, and `CLAUDE_CONFIG_DIR` attached to that context.
  Read [native harness routing](references/native-harness.md) before a sign-in
  or storage change. Do not copy, parse, or link auth stores as a generic repair.
- Google Workspace custody belongs to the installed `gog` and corresponding
  service skills. Preserve the selected credential backend and its native
  unlock delivery. A successful read through a file backend does not repair a
  refused Keychain store over SSH. Treat a backend change as a separate
  credential-route decision with its own setup and consumer proof.
- A connector's named capability owns its account, profile, exact item, and
  native setup helper. Invoke its installed skill. Propose shared-owner changes
  with evidence when another task occupies the source.

For new storage, record the exact provider, item or service coordinates,
consumer, host, and intended access mode. Use the owner's existing setup path
under the task's authorization. Keep secret input inside its private native
input channel. A missing credential, denied item, unavailable custody, and
expired provider session require different repairs. Verify a declared consumer
operation after setup and retain a redacted receipt. A local custody pass alone
does not prove provider authentication.

## Hand off access

Use [the handoff fields](references/handoff.md). The receiving process reruns
the metadata doctor and the authorized owner operation in its own context.
Complete the handoff only when that receiver's observed result passes. Preserve
an unknown result and inspect before replaying any credential write.

For a Keychain dialog with an unknown client, retain its exact wording, host,
time, and any independently established client identity. Keep dismissal status
explicit. Leave protected UI actions with the user when automation refuses.
Never infer the client from a generic executable icon, reset defaults, grant all
apps access, or change Keychain permissions to make a check pass.

## Verify a change

Use [verify-credentials](../verify-credentials/SKILL.md) for the executable
metadata journey and maintained feature map. Report source checks, synthetic
tests, real host and harness proof, installation, and activation separately.
