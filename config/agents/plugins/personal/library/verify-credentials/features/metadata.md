# Diagnose machine and Keychain metadata

Check the intended account and selected login Keychain without reading an item.

## Sub-features

- `metadata-local` runs the copied doctor in a local shell.
- `metadata-ssh` runs the copied doctor through the known SSH target.
- `metadata-refusal` rejects mismatched target expectations and HOME.

## How to get to it (user POV)

Invoke `credential-custody` or run its doctor from the intended shell. For a
remote target, use its existing trusted SSH transport and its own account home.

## Driving it with the metadata doctor

Preconditions:

- The target is macOS with Python 3 and a known hostname, account, and home.
- Both skills have been copied outside the checkout.
- `CREDENTIAL_SKILL_DIR` names the copied credential-custody directory.
- The target expectations and `CREDENTIAL_CONTEXT` are set independently of
  the process being tested.

1. Capture `/usr/bin/security default-keychain -d user` and
   `/usr/bin/security list-keychains -d user` privately before the run. Capture
   the nonsecret configuration observations named in the verification skill.
2. Run the doctor command in `credential-custody`. Save stdout, stderr, and
   exit. Require `metadata-ok`, exit 0, empty stderr, and all credential and
   request-session fields `not_checked`.
3. Repeat with `HOME` set only for the child process to an owned empty scratch
   directory. Require `environment-home-mismatch`, exit 2, and
   `metadata_probes_started: false`. The doctor never creates a keychain there.
4. Repeat with the opposite `--context`. Require `transport-hint-mismatch`,
   exit 2, and no metadata probes. Also use deliberately incorrect expected
   host and user arguments and require their matching refusal codes.
5. Capture the same two security commands and configuration observations after
   the run. Require equality for each observed value. Remove owned scratch and
   copied payload directories. Confirm all retained receipts still exist.

## Gotchas

- Metadata consistency does not prove unlocked state or identify a dialog's
  requesting client. File type and ownership do not imply item access.
- SSH markers can be inherited, removed, or spoofed. This check tests marker
  consistency, not transport authenticity or the request's security session.
- A custom default keychain makes this normal-login journey blocked. Preserve
  that selection and ask its owner to reconcile the precondition.
- A system-generated metadata change during the run invalidates the equality
  claim. Retain the mismatch and investigate before another attempt.
