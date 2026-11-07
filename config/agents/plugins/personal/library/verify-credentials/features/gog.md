# Verify Google Workspace credential access

Verify a declared gog account and credential backend in the process that needs it.

## Sub-features

- `gog-receiver` verifies one authorized read in the receiving shell.
- `gog-backend` preserves the backend and distinguishes a changed access route.

## How to get to it (user POV)

Invoke the installed `gog` and service-specific skill with the target account
and operation. Keep OAuth setup and consent with those native owners.

## Driving it with gog

Preconditions:

- The doctor admitted the intended host, account home, and transport hint.
- The gog owner verified its selected backend's storage preconditions.
- The task authorizes the declared account read. Set `GOG_EXPECTED_ACCOUNT`
  from that declaration, without enumerating accounts to guess it.

1. Read `gog --help`, `gog auth doctor --help`, and the installed owner skill.
   Keep an auth check separate from the metadata-only doctor.
2. For an authorized Gmail read, use the corresponding `gog-gmail` skill and
   the current help for this bounded command:
   `gog --readonly --gmail-no-send --account "$GOG_EXPECTED_ACCOUNT" gmail search 'newer_than:1d' --max 1 --json --wrap-untrusted --no-input`.
   Capture privately. Require the actual account-scoped response and exit 0.
   Return only status and result shape.
3. Record the selected backend and receiving process. A separate desktop check
   qualifies only that route. Retain any original SSH Keychain refusal.

## Gotchas

- An authenticated read through another backend is a different operation from
  storing OAuth credentials in Keychain. Keep both outcomes explicit.
- Backend setup, OAuth writes, and browser consent require their own authority.
- A successful read can carry a token-persistence warning. Retain that warning
  and leave durable credential storage unqualified until the owner verifies
  readback in a fresh process.
- Inspect the current installed owner. A historical wrapper commit is not proof
  that the wrapper is installed, on the current branch, or still selected.
