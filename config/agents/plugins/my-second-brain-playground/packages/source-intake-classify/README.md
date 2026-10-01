# Source Intake classify

Run the Source Intake classifier lane for one granted item: a fresh, top-level
`codex exec` that receives only the lane input on standard input and cannot
read the private receipt roots. This is the only item-bearing classifier route
(Ticket #158, mechanism M1, accepted by Nathan on 2026-09-30).

## Command

```sh
source-intake-classify classify [--json] < LANE_INPUT.json
source-intake-classify --help | --discover | --discover-command COMMAND_IDENTITY [--json]
```

`--help --json`, `--discover --json` and `--discover-command` are the
machine-readable contract: Contract Core 2.0, profile `complex`. `classify` has
effect class `external` (it discloses the lane input to the classifier model);
the control routes are `inspect`. Human mode prints one concise block;
`--json` prints one validated 2.0 envelope on stdout with empty stderr.

`classify` reads its input only from standard input, to end of input, and takes
no operands. It never prompts: a terminal on standard input is a usage refusal.
SIGINT exits 130 and SIGTERM exits 143 after killing a running lane and
removing the run's empty workspace. A signal that arrives during the pre-flight
is handled before the lane is spawned: the command yields one event-loop turn
between the pre-flight and the lane, because Bun runs signal handlers only on
the event loop.

## Lane input

Pipe one JSON object of at most 256 KiB with exactly these keys:

- `dispatch`: the `data` of a successful `source-intake-dispatch project --json`
  result, exactly `opaqueItemRef` and `projection`. Projection fields come from
  the closed list `displayName`, `mimeType`, `modifiedTime`, `sizeBytes`; each
  value is a string or finite number.
- `ownerNotes`: up to 50 public owner notes, each exactly `title` and `text`.
- `beadState`: redacted Bead state as one string. Redacted means value-free:
  only the opaque ref, the item state, and fixed or enumerated fields, never a
  projection value or lane free text (the definition is in the
  `source-intake-steward` skill).

Only provider `luna` is supported, as in the dispatch grant: the lane runs
model `gpt-6-luna` at reasoning effort `medium` (the guided `codex-safe`
route). The caller chooses neither.

## The lane

The command resolves `codex` from `PATH` to its physical binary and spawns
exactly one:

```text
codex exec <lane configuration> --ignore-user-config --ignore-rules
  --skip-git-repo-check --json -m gpt-6-luna -C <workspace>
  --output-schema <lane Codex home>/classification.schema.json -
```

- Working directory: a fresh, empty `0700` directory under `TMPDIR`, read-only
  to the lane and removed after the run.
- Codex home: `<configured private root>/source-intake-classify/codex-home`.
  It holds no `config.toml` and no `AGENTS.md`, only a link to the caller's
  `auth.json` (`$CODEX_HOME` or `~/.codex`). Codex 0.159.2 always loads
  `$CODEX_HOME/AGENTS.md`, so this separate home is what keeps the global
  instruction pointer out; the lane runs on its own minimal instruction set,
  [`src/lane-instructions.md`](src/lane-instructions.md), passed as
  `developer_instructions`. The rollout stays here (no `--ephemeral`) for DIS-7
  `turn_context` evidence; the profile denies it to later lanes.
- Credential link: a Codex token refresh writes through the link into the
  caller's `auth.json` and leaves the link in place (proved with synthetic
  tokens and a local refresh endpoint in `tests/auth-link.test.ts`). If a later
  Codex replaces the link with a file, the next run gets the lane refusal
  (`auth.json` is no longer the expected link). Recovery: the foreground
  Steward checks `codex login status` for the caller, deletes only
  `<lane Codex home>/auth.json` (a stale token copy), runs `codex login` if the
  caller's refresh token was rotated by the copy, and reruns.
- Retention: rollouts, `logs_*.sqlite`, `state_*.sqlite` and other Codex files
  in the lane home hold the lane input, including the granted projection,
  verbatim. They fall under the item receipt's 30-day retention review in the
  `source-intake-steward` skill; nothing deletes them automatically.
- Configuration, every value passed with `-c` or `--disable` per invocation:
  `approval_policy="never"`, `web_search="disabled"`,
  `shell_environment_policy.inherit="none"`, `allow_login_shell=false`,
  `agents.enabled=false` (Codex 0.159.2 keeps multi-agent collaboration on
  without it), skill and app instructions off, and the features `apps`,
  `plugins`, `browser_use`,
  `browser_use_external`, `in_app_browser`, `computer_use`, `multi_agent`,
  `multi_agent_v2`, `hooks`, `memories`, `shell_snapshot` and the other
  outward features in [`src/lane.ts`](src/lane.ts) disabled.
- Environment: only `HOME`, `CODEX_HOME` (the lane home), a fixed `PATH`,
  `SHELL=/bin/zsh`, `LANG=C` and `TMPDIR`. Descriptors: only 0, 1 and 2.
- Permission profile `msb_source_intake_classify`, selected with
  `default_permissions`:

```toml
":root" = "deny"
":minimal" = "read"
":tmpdir" = "deny"
":slash_tmp" = "deny"
"<Codex release directory>" = "read"
"<configured private root>" = "deny"
"<account default private root>" = "deny"
":workspace_roots" = { "." = "read" }
network = { enabled = false }
```

The configured private root is
`${XDG_STATE_HOME:-$HOME/.local/state}/my-second-brain-playground` (the account
record's home when `HOME` is unset or empty), which must be its own physical
path, as for `source-intake-dispatch`. The account default private root comes
from the operating system's account record (`id -P`), never from `HOME`, and is
denied independently. `HOME`, `XDG_STATE_HOME`, `CODEX_HOME`, `TMPDIR` and
`PATH` are trusted configuration from the granted foreground caller.

## Fail-closed pre-flight

Before the model starts, every run proves with the lane's exact configuration:

1. `codex --version` names the running binary.
2. Positive control: `codex sandbox` echoes a nonce, so denials below are the
   profile, not a broken sandbox.
3. The sandbox sets `CODEX_SANDBOX_NETWORK_DISABLED=1` for the lane's
   commands.
4. A synthetic receipt at the real layout,
   `drive-inbox-filing/items/.preflight-<nonce>/classification-metadata.json`
   under the configured private root: `cat`, `stat` and `ls` are each denied.
   The command removes it, and any directory it created for it, afterwards.
   The leading dot makes the name an invalid opaque ref, so a pre-flight killed
   before cleanup (SIGKILL) leaves nothing dispatch could accept as an item.
5. Every spelling of both private roots: `cat` and `ls` are each denied. A
   missing root answers "No such file or directory", which is not a denial, so
   both roots must exist.
6. The caller's Codex credential: `cat` is denied.
7. `codex debug prompt-input` renders the session without a model call: it
   carries the lane instructions, no `AGENTS.md` instructions, no multi-agent
   role, approval `never`, restricted network, only the read and deny entry
   formats it recognises (a write entry or any unknown format refuses), a deny
   entry for `:root`, `:tmpdir`, `:slash_tmp` and every private root spelling,
   and no read entry under a denied root except Codex's own
   `<lane Codex home>/tmp/arg0/`.
   A more specific read entry overrides a deny, so this is what proves the rest
   of the subtree the sentinel cannot reach.

"Denied" means a non-zero exit, empty stdout, and "Operation not permitted" on
stderr. Any other result, error or timeout gives one fixed, value-free refusal
and no model start. Probe output never leaves the command. The success result
reports the Codex version, `laneConfigSha256` (SHA-256 over every lane
configuration argument: profile, settings, instructions and disabled features),
the model, the effort and the rollout thread identity; the foreground Steward
records them in the item's private receipt.

With `XDG_STATE_HOME` pointing away from the default, the account default
private root must still exist: a missing one fails the pre-flight with the same
fixed refusal. Create it (mode `0700`) before the first run.

## Writes

The command writes only under the configured private root: the lane Codex home
with its classification schema and `auth.json` link, Codex's own rollouts, logs
and caches there, and the pre-flight sentinel item it removes. Outside it, Codex
may write refreshed tokens through the link into the caller's `auth.json`. It
never writes a receipt, grant, Beads record, vault note or Codex `config.toml`.

## Threat boundary

- May hold item values: the granted foreground Steward process,
  `source-intake-dispatch`, and the classifier model's own context (only the
  granted projection fields). Never: the lane's tools and child processes,
  Stage Manager, Ledger Steward, other workers, or Vault Steward (approved note
  content only).
- The lane cannot read file data or list directories under either private
  root, cannot read through a link placed in its workspace (it can write
  nothing, so it cannot plant one), inherits no descriptor beyond 0, 1 and 2,
  sees no receipt value in its environment, and has no approval escalation.
- Residual, recorded not prevented (accepted by Nathan on 2026-09-30, M1):
  Seatbelt still answers path existence ("No such file or directory" versus
  "Operation not permitted") and directory metadata such as entry counts below
  a denied root. Opaque refs and fixed file names are the only facts exposed.
  Under the per-user temporary directory Codex's sandbox also answers file
  metadata inside a denied path; the pre-flight's `stat` probe refuses a root
  there. Codex also grants itself read of its helper-link directory
  `<lane Codex home>/tmp/arg0/`, which holds only links to the Codex binary. A
  separate macOS account (M2) is the escalation if this residual is rejected.
- Profiles govern sandboxed commands and sandbox-aware file tools. MCP
  servers, connectors, browser, computer use and web search have their own
  controls, so the lane disables them.

## Outcomes

| Exit | Cause | When |
| --- | --- | --- |
| 0 | `SUCCESS_COMPLETED` | The pre-flight passed and the turn completed with a valid classification; effect `classifier-model-call` completed. |
| 2 | `USAGE_INVALID_INVOCATION` | An operand after `classify`, a terminal on standard input, or an unknown option. |
| 3 | `DOMAIN_PRECONDITION_UNMET` | The fixed lane refusal below; no model started. |
| 4 | `SCHEMA_INVALID_INPUT` | Standard input is empty, not JSON, over 256 KiB, or not the lane input shape. |
| 75 | `TRANSIENT_NOT_STARTED` | A file-descriptor limit was reached before input was read; retry after 1000 ms. |
| 1 | `INTERNAL_UNEXPECTED` | Standard input cannot be read, for example a directory. |
| 1 | `INTERNAL_EFFECT_OUTCOME_UNKNOWN` | The lane started but ended without a completed turn; the model call is uncertain. Inspect the rollout; never replay automatically. |
| 1 | `INTERNAL_RESULT_COMPLETED` | The turn completed but its result is not a valid classification, or could not be emitted. Inspect the rollout; do not rerun to repair reporting. |
| 1 | `INTERNAL_RESULT_UNCHANGED` | An unexpected failure before the lane started, or a result that failed envelope validation. |

The lane refusal is byte-identical for every setup and pre-flight failure. It
names no path, projection value or probe output. Human mode prints this one
line on stderr:

```text
Classifier lane not started. Its read-prevention pre-flight did not pass. Next: Ask the granted foreground Steward to inspect the classifier lane pre-flight before any retry.
```

## Proof

`bun run test:source-intake-classify` from the plugin root. Lane proofs need
macOS, an installed `codex` and the account default private root; without them
they skip. Each test file's ledger asserts the skip rationale and pins how many
lane proofs ran and skipped in this environment. Enforcement evidence comes from `codex sandbox`
probes on synthetic files; a fake `codex` records the spawned lane's
descriptors, environment, arguments and input without calling a model.
