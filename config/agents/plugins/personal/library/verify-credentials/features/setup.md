# Set up storage through its native owner

Create or configure only the declared credential in its existing custody system.

## Sub-features

- `setup-custody` uses the named capability's native setup and readback.
- `setup-environment` uses 1Password Developer Environments and native mounts.

## How to get to it (user POV)

Invoke `credential-custody` with the requested provider and consumer, or invoke
the installed `1password:1password-environments` skill for a Developer Environment.

## Driving it with the setup owner

Preconditions:

- Exact credential-write authority, target host, provider, and consumer are known.
- The doctor admitted the intended process context and the setup owner verified
  its required storage preconditions. Preserve an unrelated metadata blockage.
- Existing custody was distinguished from a missing item, denied access, or
  expired session.

1. Read the existing setup owner's instructions and installed helper help.
   Use its private input route. Keep secrets out of argv, logs, and chat.
2. Execute the authorized exact setup. Retain its receipt without secret values.
3. Verify native readback and the receiving consumer's declared operation.
   Report storage, access, and consumer outcomes separately.

## Gotchas

- This map provides no new store, reset command, or general credential writer.
- Synthetic disposable setup does not qualify real credential writes.
- Unrun setup remains unqualified. Preserve unknown outcomes and inspect before
  replay. A new `.env` file must remain under its native mount or custody owner.
