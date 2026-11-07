---
name: verify-credentials
description: Verify credential-custody behavior through the real Mac metadata doctor and a maintained feature map. Use after credential workflow changes or before claiming a credential handoff works.
---

# Verify credentials

Read the [feature map](features/README.md), then select the claimed entry point.
The metadata journey is safe during a read-only investigation. Other journeys
retain their owner's credential-operation authorization requirements.

## Launch

This is a short-lived Python 3 tool. Set `CREDENTIAL_SKILL_DIR` to the loaded
sibling `credential-custody` directory. Run
`python3 "$CREDENTIAL_SKILL_DIR/scripts/doctor.py" --help`.
No server, migration, login, seed credential, or persistent process is needed.
Copy both skill directories into a private disposable directory to prove the
packaged payload works outside the checkout. Python's standard library is the
only runtime dependency. This does not install or activate a native plugin.

## Doctor

Run the command in [credential-custody](../credential-custody/SKILL.md) with
independently known target expectations. Require exit 0 and
`status: metadata-ok`. Keep all `not_checked` fields in the receipt. A blocked
metadata check ends the normal-login metadata journey with its cause. A mapped
owner journey with independent storage preconditions remains separate.

## Drive

Execute [diagnose metadata](features/metadata.md) once on the real target.
Exercise a wrong HOME and wrong context as negative controls. An SSH invocation
proves that entry point only. A Codex shell does not establish Claude shell,
desktop GUI, another Mac, login, or reboot recovery.

For another claim, execute its mapped feature. A routed but unrun setup or
credential-write journey remains unqualified. Never replace missing live
credentials with synthetic success.

## Evidence

Use a private runtime-state directory under
`${XDG_STATE_HOME:-$HOME/.local/state}/credential-verification/` with a unique
run name. Retain the command, copied script SHA-256, expected target record,
stdout JSON, stderr, exit code, feature ID, and observation time. Keep raw
Keychain default and search-list snapshots private. Compare their bytes before
and after and emit only equality booleans in a shared report. Also observe
`HOME`, `CODEX_HOME`, and `CLAUDE_CONFIG_DIR` selectors and native configuration
file metadata before and after. Hash selector values inside the observer rather
than printing arbitrary environment values. Use `lstat` for the account's
`.codex/config.toml`, `.claude/settings.json`, `.claude.json`, and the current
custody wrapper and helper source. Compare existence, inode, mode, owner, size,
and timestamps. Keep this claim limited to configuration observations. Do not
open credential files or infer unchanged hidden auth state.

Capture action and result. Require unchanged default and search list for the
metadata journey. The helper invokes only fixed metadata commands, closes
stdin, bounds output and time, and discards subprocess errors. Its output
does not establish credential presence, authentication, or a request's GUI
security session.

## Cleanup

The doctor creates no state or persistent process. Remove only the copied
payload directory that this run created. Preserve the evidence directory and
confirm its receipts still exist after cleanup. Keep failed attempts too.
Do not change credentials, defaults, search lists, ACLs, or security settings.

## Helpers

The executable helper is
`../credential-custody/scripts/doctor.py`. Its `--help` owns its arguments.
Run the structural regression suite from the source checkout with
`python3 -m unittest discover -s config/agents/plugins/personal/library/credential-custody/tests -v`.
Those synthetic tests support the helper contract. They do not replace a real
feature journey.

Use pstack's `maintain-verification-skill` workflow when the owner interfaces
change. Reconcile the map and rerun the affected entry points.
