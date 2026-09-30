# Source Intake dispatch

Project a granted private receipt into a delegated classifier input without
passing the receipt path or its other records to that classifier. This is a
supported-path guard, not filesystem isolation.

## Command

```sh
source-intake-dispatch project [--json] < GRANT_AND_REQUEST.json
source-intake-dispatch --redacted status [--json]
source-intake-dispatch --redacted evaluation [--json]
source-intake-dispatch --help | --discover | --discover-command COMMAND_IDENTITY [--json]
```

`--help --json`, `--discover --json` and `--discover-command` are the
machine-readable contract: Contract Core 2.0, profile `complex` (the projection
checks an exact-item approval grant). Every command has effect class `inspect`
and writes nothing. Human mode prints one concise line or block; `--json`
prints one validated 2.0 envelope on stdout with empty stderr.

`project` reads its grant and request only from standard input, to end of
input, and takes no operands. It waits until the caller closes standard input;
SIGINT exits 130 and SIGTERM exits 143 while it waits. Empty input is invalid
input. A terminal on standard input is refused as usage; the command never
prompts. No other command reads standard input.

## Grant, request and receipt

Pipe one JSON object of at most 64 KiB with exactly two keys, `grant` and
`request`. Live grant and request input stays in private runtime state, out of
Git and out of Beads.

- The grant has exactly `opaqueItemRef`, `provider`, `purpose`,
  `allowedFields`, and `receiptPath`.
- The request has exactly `opaqueItemRef`, `provider`, `purpose`, and
  `requestedFields`.
- `opaqueItemRef` is a lowercase letter or number followed by up to 63
  lowercase letters, numbers or hyphens. It identifies the sole receipt
  location, and `receiptPath` must be exactly this path:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/my-second-brain-playground/drive-inbox-filing/items/<opaqueItemRef>/classification-metadata.json
```

Only provider `luna` with purpose `classification` is supported. Granted and
requested fields come from this closed metadata list: `displayName`,
`mimeType`, `modifiedTime`, and `sizeBytes`. The metadata file is one flat
JSON object; each projected value is a string or finite number.

## Privacy boundary

- The command opens no caller-supplied input path. The grant and request
  arrive on standard input; an operand after `project` is a usage refusal and
  is never read.
- The grant's `receiptPath` is the only caller-named path, and it is only
  compared as text. Unless it equals the exact receipt path under the
  configured root, the request is denied before anything is touched.
- The receipt is read only after authorization, relative to its pinned item
  directory: the command enters that directory, denies unless it is
  physically the expected one, then opens the receipt without following a
  link. The opened receipt must be a regular file with one link, and after
  the read its name must still be that same file with one link. So a FIFO, a
  directory, a symbolic link, or a hard link planted from another root,
  including one unlinked or relinked around the open, is denied. Every
  failure is the fixed denial.
- `HOME` and `XDG_STATE_HOME` are trusted configuration set by the granted
  foreground caller (Nathan, 2026-09-30). They select the receipt root above.
- No configuration of those variables, and no change to the configured tree
  during a run, reads or reveals a receipt outside the configured root. That
  includes the account's default receipt root, regardless of both variables. A
  change that moves the item directory off its expected physical path before
  it is pinned is denied; after the pin, the read stays inside the pinned
  directory.
- A caller who controls those variables and moves the receipt root to a
  non-default location is outside this supported-path guard, as Ticket #136
  scopes it.
- Piped input (Nathan, 2026-09-30) replaces the earlier exclusion for callers
  that mutate their own path components during a run: no caller-owned path is
  opened, so there is none to swap. Nothing else relaxes: exact-item grants,
  the fixed value-free denial, the guarded account default root, and the
  classifier read prevention (T-2) required before any exact-item filing all
  stand.

## Outcomes

The command validates the grant and the request completely before it touches
the receipt.

| Exit | Cause | When |
| --- | --- | --- |
| 0 | `SUCCESS_UNCHANGED` | The projection holds exactly the requested granted fields; `--redacted` returns `{"recipient":"status","projection":{"receipt":"[REDACTED]"}}` (or `evaluation`). |
| 2 | `USAGE_INVALID_INVOCATION` | An operand after `project`, a terminal on standard input, an unknown option, or an unknown recipient. |
| 3 | `DOMAIN_PRECONDITION_UNMET` | The fixed denial below. |
| 4 | `SCHEMA_INVALID_INPUT` | Standard input is empty, not JSON, over 64 KiB, has other keys, or has a malformed value. |
| 75 | `TRANSIENT_NOT_STARTED` | A file-descriptor limit was reached before input was read; retry after 1000 ms. |
| 1 | `INTERNAL_UNEXPECTED` | Standard input cannot be read, for example a directory. |
| 1 | `INTERNAL_RESULT_UNCHANGED` | An unexpected failure, or the result failed envelope validation. |

The denial is byte-identical for every authority mismatch and for every
outcome that depends on the receipt: a missing receipt or state root; a
`receiptPath` other than the exact bound path; an unreadable, symlinked,
malformed or incomplete receipt; and any receipt I/O error. It never names a path, receipt value, source label or raw error, so it
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
