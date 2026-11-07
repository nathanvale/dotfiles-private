# Deliver a declared 1Password credential

Verify local custody and the consumer's access as separate observations.

## Sub-features

- `op-custody` verifies the existing token source with the owning wrapper.
- `op-consumer` injects one declared field into its authorized consumer.

## How to get to it (user POV)

Invoke `personal:one-password` with the exact owning capability and mapping.

## Driving it with the custody owner

Preconditions:

- The doctor admitted the intended host, account, home, and transport hint.
  Require the selected owner's storage preconditions. Preserve a blocked
  normal-login journey when that owner uses its independently verified fallback.
- The task authorizes the credential read and declared consumer operation.

1. Read the sibling [one-password skill](../../one-password/SKILL.md) and run
   `$HOME/code/dotfiles/bin/with-one-password-token --help`.
2. Run its `check` command only under custody-read authority. Retain its redacted
   JSON and original failure code. A fallback success retains the Keychain
   refusal as an unresolved observation.
3. Follow the owner's `inject` or `inject-stdin` recipe for the declared
   consumer. Require that consumer's protected result with no credential output.

## Gotchas

- `check` reads a token and may create a temporary desktop helper over SSH.
  It is outside the metadata-only journey.
- A custody pass does not prove server-side grants or provider access.
- Desktop fallback and unattended delivery require separate proof.
