# Scoped CLI examples

Use a known account, vault, item, and field from the owning capability. Keep secret values inside the consumer process.

## Desktop identity check

With app integration enabled, run directly:

```sh
op whoami --account <known-account>
```

For standalone authentication, follow [the session branch](get-started.md#standalone-session).

## Unattended custody check

```sh
"$HOME/code/dotfiles/bin/with-one-password-token" check
```

This reports custody status without returning a credential.

## Shape-only verification

The declared reference reaches only the consumer. This example emits presence and length; it excludes the value and broker token.

```sh
"$HOME/code/dotfiles/bin/with-one-password-token" \
  inject SECRET_VALUE '<op://vault/item/field>' -- \
  python3 -c 'import json, os; value = os.environ["SECRET_VALUE"]; print(json.dumps({"present": bool(value), "length": len(value), "broker_token_absent": "OP_SERVICE_ACCOUNT_TOKEN" not in os.environ}))'
```

Use the actual capability's expected shape for acceptance. Length alone does not prove a valid credential or provider access.

## Deliver a credential

```sh
"$HOME/code/dotfiles/bin/with-one-password-token" \
  inject <ENV_KEY> '<op://vault/item/field>' -- <consumer> [args...]

"$HOME/code/dotfiles/bin/with-one-password-token" \
  inject-stdin '<op://vault/item/field>' -- <consumer> [args...]
```

Select a consumer that accepts the credential through its environment or standard input and keeps it out of output. The launcher's help owns delivery semantics.

## Item reads, creates, and edits

When an approved operation needs item JSON, capture native `op` output inside its trusted consumer. Require one exact field label and type when selecting a value. Emit only a redacted receipt or shape result.

Use JSON on standard input for native item create/edit operations. Keep secret assignments out of command arguments, and capture operation output before returning a receipt. The owning capability supplies input preparation and the exact account and vault.

## Metadata search

Only search when explicitly requested. Restrict listing to the declared vault, parse results inside the consumer, and emit only candidate titles, IDs, categories, and the vault name. After selecting a candidate, return to exact references.
