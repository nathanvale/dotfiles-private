# Source Intake dispatch

Project a granted private receipt into a delegated classifier input without
passing the receipt path or its other records to that classifier. This is a
supported-path guard, not filesystem isolation.

## Command

```sh
source-intake-dispatch GRANT REQUEST [--json]
source-intake-dispatch --redacted status [--json]
source-intake-dispatch --redacted evaluation [--json]
source-intake-dispatch --help | --discover | --discover-command COMMAND_IDENTITY [--json]
```

`--help --json`, `--discover --json` and `--discover-command` are the
machine-readable contract: Contract Core 2.0, profile `complex` (the projection
checks an exact-item approval grant). Every command has effect class `inspect`
and writes nothing. Human mode prints one concise line or block; `--json`
prints one validated 2.0 envelope on stdout with empty stderr.

## Grant, request and receipt

The grant and request are private runtime JSON files. Keep them outside the
item receipts tree, out of Git and out of Beads; a grant or request path that
reaches an items tree is denied (see Privacy boundary).

- The grant has exactly `opaqueItemRef`, `provider`, `purpose`,
  `allowedFields`, and `receiptPath`.
- The request has exactly `opaqueItemRef`, `provider`, `purpose`, and
  `requestedFields`.
- `opaqueItemRef` is a lowercase letter or number followed by up to 63
  lowercase letters, numbers or hyphens. It identifies the sole receipt
  location:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/my-second-brain-playground/drive-inbox-filing/items/<opaqueItemRef>/classification-metadata.json
```

Only provider `luna` with purpose `classification` is supported. Granted and
requested fields come from this closed metadata list: `displayName`,
`mimeType`, `modifiedTime`, and `sizeBytes`. The metadata file is one flat
JSON object; each projected value is a string or finite number.

## Privacy boundary

- `HOME` and `XDG_STATE_HOME` are trusted configuration set by the granted
  foreground caller (Nathan, 2026-09-30). They select the receipt root above.
- The account's default receipt root stays guarded regardless of both
  variables. The command reads the account's home from the operating-system
  account record (`/usr/bin/id -P` on macOS, `getent passwd` on Linux; Bun's
  `os.userInfo().homedir` follows `HOME`, so it is not used) and denies any
  caller path that reaches
  `<home>/.local/state/my-second-brain-playground/drive-inbox-filing/items`.
  An unreadable account record denies every request.
- A caller who controls those variables and moves the receipt root to a
  non-default location is outside this supported-path guard, as Ticket #136
  scopes it.
- Grant and request paths resolve one component at a time. A link target is
  normalized lexically, so its `..` never visits the directory before it. A
  static path that reaches either items tree, by spelling or by directory
  identity, is denied before it is touched. At open, the final component is
  not followed.
- Concurrent caller mutation is outside the supported-path guarantee
  (Nathan, 2026-09-30): a caller that swaps, relinks or otherwise mutates its
  own path components while the command runs is out of scope, as Ticket #136
  already scopes a caller with filesystem access. The no-existence-oracle
  guarantee holds for caller paths that do not change during the invocation.
  This relaxes nothing else: exact-item grants, the fixed value-free denial,
  the guarded account default root, and the classifier read prevention (T-2)
  required before any exact-item filing all stand.
- Known residual: a hardlink to a receipt placed outside the items tree is
  not detected.

## Outcomes

The command validates the grant and the request completely before it touches
the receipt.

| Exit | Cause | When |
| --- | --- | --- |
| 0 | `SUCCESS_UNCHANGED` | The projection holds exactly the requested granted fields; `--redacted` returns `{"receipt":"[REDACTED]"}`. |
| 2 | `USAGE_INVALID_INVOCATION` | Wrong operand count, unknown option or unknown recipient. |
| 3 | `DOMAIN_PRECONDITION_UNMET` | The fixed denial below. |
| 4 | `SCHEMA_INVALID_INPUT` | The grant or request is not JSON, has other keys, or has a malformed value. |
| 75 | `TRANSIENT_NOT_STARTED` | A file-descriptor limit stopped the grant or request from opening; retry after 1000 ms. |
| 1 | `INTERNAL_UNEXPECTED` | The grant or request path, outside the items tree, is not a readable regular file. |
| 1 | `INTERNAL_RESULT_UNCHANGED` | An unexpected failure, or the result failed envelope validation. |

The denial is byte-identical for every authority mismatch and for every
outcome that depends on the receipt: a missing grant, request or receipt; an
unreadable, symlinked, malformed or incomplete receipt; and any receipt I/O
error. It never names a path, receipt value, source label or raw error, so it
is no existence oracle. Human mode prints this one line on stderr:

```text
Request denied. Stage Manager must verify the private grant before retrying. Next: Ask Stage Manager to verify the private grant and issue a matching request.
```

`--json` prints the same refusal as a 2.0 envelope with `causeCode`
`DOMAIN_PRECONDITION_UNMET`, exit 3, and that `nextAction`. The run identity
is fixed per command because the command keeps no journal to correlate; this
keeps the denial byte-identical.

When stdout cannot be written the command exits 1 without a replacement
envelope; human mode adds one repair line on stderr. SIGINT exits 130 and
SIGTERM exits 143 without writing anything.

Vault Steward is not a command recipient. It receives only Nathan-approved
note content from the foreground Steward or Stage Manager.
