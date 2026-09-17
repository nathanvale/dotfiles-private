# msb-workflow

The thin recovery helper for the My Second Brain Playground. It is the Bun and
TypeScript replacement for the Python compaction helper
(`packages/compaction-recovery/src/recovery.py`), built under
[Spec #57](https://github.com/nathanvale/dotfiles-private/issues/57) revision 2
and [Ticket #58](https://github.com/nathanvale/dotfiles-private/issues/58)
revision 2.

Stage `M1` is source-only. The helper is built, tested, and documented here;
it is not installed, not activated, and registered in no hook manifest. The
Python route, the schema-v2 checkpoints, both legacy launchers under `hooks/`,
and every hook registration are unchanged and remain the live path. `M2`
(Ticket #52) owns the switch of the hook manifests to `bin/msb-workflow hook`.

## Purpose and boundary

Beads owns task state. Native `bd` owns Beads, dependencies, claims, human
Gates, checkpoint comments, and closeout. This helper owns exactly four things:

1. The private session binding: one session identity bound to one Bead in one
   selected store, written once and refreshed by the same owner.
2. The compaction refresh marker beside it, which makes Resume Panel delivery
   after compaction exactly-once on the normal completed path.
3. The Resume Panel, rebuilt from read-only native `bd` reads at the moment of
   every read, delivered by `recover` and by `hook`.
4. Its own inspection, diagnostics, help, and discovery.

It is not a Beads workflow wrapper. It never runs a `bd` command that writes
(`create`, `update`, `claim`, `close`, `comment`, a Gate change, or any other
mutation), never executes a command it renders in the panel, and never reads
`PATH` to find `bd`. It is not a graph engine, a task store, a journal, a cast
registry, or a board product, and it does not become one by extension: a
command with an external effect is outside this package. The pinned `bd 1.2.2`
rewrites the store's `last-touched` hint file even under `--readonly`; that is
a `bd` side effect of a read, not a helper write.

## Python replacement

The Python owner exposed `hook` and `checkpoint <subcommand>`. This table is the
complete mapping.

| Python (`recovery-checkpoint`) | `msb-workflow` | Status |
| --- | --- | --- |
| `checkpoint --help` | `--help` | Retained. Human usage text; the machine form is discovery. |
| `checkpoint schema` | `--discover --json`, `result.bindingSchema` | Folded into discovery. |
| `checkpoint write` (validate one checkpoint JSON object on stdin and write its session file) | none | Not carried. Every binding field is derived from verified owners; a deliberate same-session task switch is a later verified protocol under Spec #51. |
| `checkpoint bind <GOAL.md> --agent-ledger <executable>` | `bind --workspace <path> --bead <id>` | Retained. The Agent Ledger Task and `GOAL.md` are replaced by one Bead in the selected `.beads` store. |
| `checkpoint recover` | `recover --workspace <path>` | Retained. The panel comes from live `bd` reads, not from stored checkpoint fields. |
| `hook` | `hook` | Retained. Adds the PreCompact, PostCompact, and UserPromptSubmit lifecycle and the marker. |

Intentional differences beyond the table:

- Schema v2 at `<root>/my-second-brain-playground/recovery/sessions/` is
  replaced by schema v3 at a new address (below). The helper never reads,
  rewrites, or deletes the v2 files, and never translates v3 to v2.
- The Python command envelope (`schemaVersion: 1`) is replaced by Contract Core
  `1.0.0` (below).
- The state root order gains `MSB_WORKFLOW_STATE_HOME` ahead of
  `XDG_STATE_HOME` and `$HOME/.local/state`.
- Vault, project map, and Register lookups are gone; the only owners are the
  selected `.beads` store, the Git top level, and the private state root.
- The Python fd-3 observation protocol and the Bun supervisor that spawned
  Python stay in the rollback route only.

## Commands

Machine mode applies when `--json` appears anywhere in argv. Six identities
exist; discovery lists exactly these.

| Identity | Invocation | Effect | What it does |
| --- | --- | --- | --- |
| `msb-workflow.help` | `msb-workflow --help` | `inspect` | One usage line, one example, the command list, and the environment rules. |
| `msb-workflow.discover` | `msb-workflow --discover --json` | `inspect` | The contract: name, versions, commands, exit meanings, machine mode, `logtape: true`, and the additive `bindingSchema`. |
| `msb-workflow.inspect` | `msb-workflow inspect --workspace <absolute-path> [--session <id>]` | `inspect` | Checks the executable pin, the store identity, the state root, the diagnostics directory, and (with a session) the binding, the marker, the lock files, and the sessions directory when it exists. Names each failure with one repair. Writes no binding, marker, or lock file; in machine mode it writes its diagnostics run file, the accepted reading of "without writing". |
| `msb-workflow.bind` | `msb-workflow bind --workspace <absolute-path> --bead <bead-id> [--session <id>] [--evidence <absolute-file>]` | `repository-local` | The one private write. Verifies the store and the Bead, takes the workspace lock then the session lock, reads any saved binding, and writes the binding atomically. Same owner refreshes; a different Bead, a different workspace, or malformed saved bytes refuses and preserves the saved bytes. No override flag exists. |
| `msb-workflow.recover` | `msb-workflow recover --workspace <absolute-path> [--session <id>]` | `inspect` | Reads this session's binding, verifies its stored workspace, repeats the store gate with the bound executable, reads the Bead and the Gates now, and returns the Resume Panel with one next safe action. Writes nothing but diagnostics. |
| `msb-workflow.hook` | `msb-workflow hook` with the Harness event JSON on stdin | `repository-local` | Delivers session guidance, the availability check, the generation marker, or the Resume Panel for one Harness event. Harness JSON out, always exit `0`. |

Environment and arguments:

- `--workspace` is the directory whose `.beads` store is selected. It must be
  an existing canonical absolute directory; nothing is resolved against the
  working directory. `hook` takes no `--workspace`: it finds the workspace
  through the binding.
- `--session` or `CODEX_SESSION_ID` supplies the session identity, grammar
  `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`. Both present and different refuses. An
  identity that came only from the environment can never replace a saved
  owner. `inspect` runs without a session and then skips the session checks.
- `MSB_WORKFLOW_BD_EXECUTABLE` names the `bd` executable for `inspect` and
  `bind`. `bind` stores the verified executable in the binding, and `recover`
  and `hook` use the stored one. `PATH` discovery never happens.
- `bind` must run inside a Git working directory; `sourceRepository` is the
  canonical top level of that directory and there is no `--source` flag.
  `--evidence`, when given, must be a canonical regular file inside
  `sourceRepository`.
- No arguments exits `2` with one stderr line naming `--help`. Nothing ever
  prompts; stdin is read only by `hook`.
- Every `bd` call runs with `BEADS_DIR=<workspace>/.beads`, a filtered
  environment, and a 20 second bound.

## Public envelope and exits

The five envelope commands return through one envelope builder and one exit
mapping in `src/command-contract.ts`. Human mode prints the primary result on
stdout and, on refusal or failure, exactly one `msb-workflow: <CAUSE>: <message>;
repair: <repair>` line on stderr with empty stdout. Machine mode prints exactly
one Contract Core `1.0.0` envelope on stdout and nothing on stderr, usage
errors included, with the same exit code.

| Exit | Class | Cause codes this helper emits |
| --- | --- | --- |
| `0` | success | none (`causeCode` is `null`) |
| `1` | internal | `INTERNAL_UNEXPECTED` (handoff, nothing written), `INTERNAL_WRITE_OUTCOME_UNKNOWN` (`transactionState: unknown`, next action `recover`), `INTERNAL_RENDER_FAILURE` (the fixed fallback envelope) |
| `2` | usage | `USAGE_INVALID_INVOCATION` |
| `3` | domain | `DOMAIN_STATE_ROOT_UNSAFE`, `DOMAIN_WORKSPACE_INVALID`, `DOMAIN_SESSION_INVALID`, `DOMAIN_SESSION_CONFLICT`, `DOMAIN_EXECUTABLE_INVALID`, `DOMAIN_STORE_MISMATCH`, `DOMAIN_STATE_UNSAFE`, `DOMAIN_BEAD_MISSING`, `DOMAIN_PREREQUISITE_FAILED`, `DOMAIN_SOURCE_REPOSITORY_MISSING`, `DOMAIN_EVIDENCE_INVALID`, `DOMAIN_BINDING_OWNERSHIP_CONFLICT`, `DOMAIN_SESSION_INHERITED_CONFLICT`, `DOMAIN_BINDING_ABSENT`, `DOMAIN_BINDING_WORKSPACE_MISMATCH` |
| `4` | schema | `SCHEMA_BINDING_INVALID` (the saved binding is not one bounded schema-v3 object; the bytes are preserved) |
| `75` | unavailable | `UNAVAILABLE_BEADS_READ` (retryable, 1,000 ms hint), `UNAVAILABLE_STORAGE_BUSY` (retryable, 2,000 ms hint), `UNAVAILABLE_WRITE_FAILED` (retryable, nothing changed), `UNAVAILABLE_LOCK_UNSUPPORTED` (not retryable) |

Every envelope carries `envelopeVersion: 1`, `commandIdentity`, a per-process
`runIdentity` (`run-<uuid>`), `outcome`, `failureClass`, `causeCode`, `message`,
`effectClass`, `transactionState`, `retryable`, `retryDelayMilliseconds`,
`nextAction`, `availablePaths`, `repairAction`, `handoff`, and `result`. A
refused, failed, or unknown outcome carries exactly one of `nextAction` or
`handoff`. Success results carry `result.station` and the command facts; the
`recover` and `bind` results carry the panel string under `result.resumePanel`
beside the structured facts, and human mode prints the panel as is.

A missing Bead is a domain refusal, exit `3`, never a retry invitation. A
`bd` reply whose `error` value is `no_beads_directory`, a contention message,
or anything unclassified is `UNAVAILABLE_BEADS_READ`, exit `75`. The `bd`
process exit code never decides the class, because the pinned `bd 1.2.2` exits
`1` for both an absent Bead and an absent store.

Every Branch Station is declared in `src/branch-station-catalog.ts`, and the
catalog suite fails any declared station that no real process reached.

## Private state addresses

The state root is `MSB_WORKFLOW_STATE_HOME`, else `XDG_STATE_HOME`, else
`$HOME/.local/state`. An explicit value is never skipped: it must be a
nonempty absolute path to an existing real directory the effective user owns,
or every routed command refuses with `DOMAIN_STATE_ROOT_UNSAFE`. The root's
mode is the operator's (a shared XDG state home is commonly `0755`); every
helper directory beneath it is created `0700` and every file `0600`.

| Record | Address under `<root>/my-second-brain-playground/workflow-cli/` |
| --- | --- |
| Binding, schema v3 | `recovery/sessions/<session-id>.json` (16 KiB limit) |
| Compaction marker | `recovery/sessions/<session-id>.marker.json` (64 KiB limit) |
| Workspace lock | `locks/workspaces/<first 32 hex of sha256(workspace)>.lock` |
| Session lock | `locks/sessions/<first 32 hex of sha256(session)>.lock` |
| Diagnostics run file | `diagnostics/<runIdentity>.jsonl` |

Schema v3 is closed: `schemaVersion` (`3`), `sessionIdentity`, `workspace`,
`storePath`, `storePrefix`, `beadsExecutable`, `beadsVersion`, `beadId`,
`beadObservedAt` (the Bead's `updated_at` at bind time, a hint only),
`sourceRepository`, `evidencePath` (`null` or a file inside
`sourceRepository`), and `observedAt`. Unknown fields, missing fields, null
identities, duplicate keys, a `__proto__` member, malformed timestamps, and an
`observedAt` more than five minutes in the future refuse. A binding older than
one hour is labelled `stale` and stays valid. The stored `workspace` is
verified on every read. `--discover --json` publishes the same description
under `result.bindingSchema`.

Every private read opens the named path with `O_NOFOLLOW`, refuses a symlink,
another owner, a mode other than `0600`, more than one link, or an identity
change between the name and the descriptor, and re-checks the descriptor
after the read. Every private write is an exclusive same-directory temporary
file, `fsync`, rename, and directory `fsync`.

## Pinned bd discovery

The helper never searches `PATH`. The executable it uses is exactly the
absolute path named by `MSB_WORKFLOW_BD_EXECUTABLE` (`inspect`, `bind`) or
stored in the binding (`recover`, `hook`). That path must be canonical (no
symlink in any segment), a regular file, and executable. On every store read
the helper then:

1. requires the path to equal the accepted pin exactly, computes the SHA-256
   of the executable's bytes, and requires that to equal the pinned digest,
   all before the executable is run; the digest is also recorded: `inspect`
   prints it in the `executable` check, the Resume Panel prints it on the
   `Beads executable` line, and the `bind.started` diagnostic carries it;
2. runs `bd version` and parses the first line as
   `bd version <version> (<build>: [<branch>@]<revision>)`, requiring the
   version `1.2.2` and the revision field, the hex after the last `@` inside
   the parentheses, to be `6c124203e771`; the branch text `bd` appends inside
   a Git repository is never compared, so a branch spelled like the revision
   cannot satisfy the pin;
3. requires `bd where --readonly --json` to report `path` exactly equal to
   `<workspace>/.beads` (a missing store silently falls back to `~/.beads`, so
   equality is the guard), `bd config list --readonly --json` to agree on the
   prefix, and, inside a Git working directory, `bd context --readonly --json`
   to name the same store and not be redirected.

The path, digest, version and revision are all enforced; the digest is also
reported so a reader can check it. For this rollout the pinned executable is
`/Users/nathanvale/.local/state/trustworthy-engineering-loop-prototype/beads/bd`,
SHA-256 `9581d8bcd9662ccf9d889ee8d879787e32cd4c0249d93374eeac5044e9f24351`,
`bd version 1.2.2` at `6c124203e771`, and the selected store is
`/Users/nathanvale/.local/state/my-second-brain-playground/legacy-kit-rollout-20260916/store/.beads`
with prefix `lkr`. Homebrew `bd 1.3.0` on `PATH` must never be used; the
version gate refuses it. The test fixture shim at
`tests/fixtures/checker/bd` replays recorded `bd 1.2.2` JSON and has its own
digest; that digest is never the pin and never appears in a production
binding, so the production entry refuses the shim. The shim-lane tests and the
`cli-design` checker spawn `tests/fixtures/checker/cli.ts` instead: the same
`main()` over `productionContext` with the pin composed from the executable
each scenario names (`tests/fixtures/checker/fixture-context.ts`). The pin is
proven by `tests/unit/beads.test.ts`, by the production entry refusing the
shim in `tests/integration/msb-workflow.test.ts`, and by the native-storage
suite against the pinned executable.

## Hook

`hook` accepts exactly the argv `hook` and reads one Harness event from stdin
(128 KiB limit). Any other argv containing `hook` is an ordinary usage failure.
Output is `{"hookSpecificOutput":{"hookEventName":<event>,"additionalContext":<text>}}`
on stdout, and the exit code is always `0`.

| Event | Delivery |
| --- | --- |
| `SessionStart` with `source` `startup`, `resume`, or `clear` | Bounded session guidance naming the Bead, the workspace, and the exact `recover` and `bind` commands for this session. Never consumes a marker. |
| `SessionStart` with `source` `compact` | The Resume Panel plus bounded `bd prime --readonly --hook-json` context (8 KiB). |
| `PreCompact` | The read-only availability result: available, or unavailable with the cause and repair. |
| `PostCompact` | Records one monotonic generation as `pending` in the marker under the session lock. No output. |
| `UserPromptSubmit` | Inspects the marker under the session lock, runs the native reads with no lock held, then re-decides under the lock: claims every pending generation at once (including one minted during the read), persists the claim, emits one panel with prime context, then records each claimed generation `delivered`. A second prompt is silent, and a prompt that a concurrent prompt beat to delivery settles silent. |

Payload assumptions. The shapes are fixture-derived from the example hook
scripts in the upstream Beads document at revision `6c124203e771`
(`docs/CODEX_INTEGRATION.md`) together with the Harness hook contract; that
document enumerates no stdin fields, so nothing here is observed on the
installed Codex until `M2`. The helper requires `hook_event_name` from the four
events above, `session_id` matching the session grammar, `cwd` as an absolute
existing directory (spelled as its canonical path; a symlink alias, trailing slash, or dot segment is refused, never resolved), and `source` on `SessionStart`
from `startup`, `resume`, `clear`, `compact`. No configured default and no
environment value can stand in for those fields.

Silence rules. The hook fails open with empty stdout and exit `0` when stdin
is not one bounded JSON object, the event or `source` is unknown, the session
identity is unsafe, `cwd` is not the canonical spelling of a real directory, no state root can be
selected, the binding is absent, invalid, unsafe, or unavailable, `cwd` is
neither inside the binding's `sourceRepository` nor equal to its `workspace`,
the marker cannot be read or is not one schema-v1 marker (corrupt marker), a
panel read is refused, or anything throws. Once the event parsed and a state
root was selected, each silent path leaves one record in the private
diagnostics file (`hook.binding-unavailable`, `hook.cwd-refused`,
`hook.marker-unreadable`, `hook.read-failed`, `hook.failed`). The run file
is opened as soon as a state root is selected, before stdin is parsed, so an
unparseable event with a usable state root leaves one run file holding only
its `hook.completed` record with `delivery` `silent` and no cause record; an
unusable state root leaves no run file, because none can be opened. Nothing
reaches stderr, because stderr may reach the Harness.
`PreCompact` is the one event that reports an unavailable read in its output
instead of staying silent.

Missing binding. A session that never ran `bind` gets no guidance and no
panel; the hook is silent. `inspect --session <id>` names the absent binding
and the exact `bind` command.

Corrupt marker. The helper never rewrites or deletes a marker it cannot parse,
so `PostCompact` and `UserPromptSubmit` stay silent for that session. Run
`msb-workflow inspect --workspace <path> --session <id>`: the `marker` check
fails with the parse reason and the repair is to move or delete
`recovery/sessions/<session-id>.marker.json` after reading it. The next
`PostCompact` starts a fresh marker.

Notice folding. The claim is persisted before any output and `delivered` is
recorded after it. A process that dies between the claim and the delivery
record leaves those generations `claimed`, which the helper treats as
uncertain. The next prompt does not replay the panel: it emits one line naming
the uncertain generations, the still `pending` generations folded into the
notice, and the exact `msb-workflow recover ... --json` command to rebuild the
panel, then records every `claimed` and `pending` generation `notified`. A
death between the notice and that record repeats the notice on the following
prompt, which is harmless; the handoff is never lost. `inspect` reports the
same uncertain generations while they are open. The marker keeps every open
generation and the newest 16 settled ones.

Exactly-once holds for the normal completed path: two `PostCompact` events
before one prompt yield one panel and a silent second prompt. Crash-safe
exactly-once is not claimed; the notice is the honest outcome after a crash.

## Diagnostics: LogTape and redaction

Dependencies are exactly `@logtape/logtape` `2.3.1` and `@logtape/redaction`
`2.3.1`; the lock uses no package. Each run configures LogTape through a scoped
configuration (`withConfigSync`) so its sinks are private to the run and any
other LogTape owner in the process is untouched; the global configuration is
initialised only when the process has none.

- Every record is one JSON Lines object with `runIdentity`, `commandIdentity`,
  `sequence`, `eventKind`, `level`, `@timestamp`, plus `stationId`, `beadId`,
  and `generation` when known.
- Human mode sends records to stderr at `warning` and above only, so an
  ordinary run keeps Contract Core's one-line stderr rule. Expected refusals
  such as a binding conflict are logged below that level because the envelope
  already names them.
- Machine mode and `hook` write to the private run file above, created `0600`
  with `wx`, one file per `runIdentity`.
- Bounds: 4,096 bytes per record (an oversized or unserializable record is
  refused and counted), 512 records per run (further records are dropped and a
  `diagnostics.truncated` warning is written on dispose), and the newest 64
  run files are retained (older files are pruned by modification time when a
  run opens).
- Redaction happens at the sink and again on the formatted line. Known secret
  values are replaced first, then `redactByField` renders every value under a
  key matching `/(token|secret|password|passwd|credential|api[-_]?key|private[-_]?key)/i`
  as `[REDACTED]`. The known secret values of a run are every value the helper
  observed under such a key in any `bd` reply during that run; they are
  replaced wherever they recur, including inside comment bodies and the panel
  text. An `Error` is recorded by name only. A cyclic or over-deep value is
  refused rather than partially copied.
- The same key pattern and known-value replacement apply to every public
  envelope field and to the hook text before output.
- Failure containment: a diagnostics open, write, flush, or close failure is
  classified by stage and errno and never changes the command outcome. A
  Diagnostics Module that cannot open is replaced by a silent one.

## The two accepted cli-design exceptions

The complex profile of the `cli-design` skill applies (`bind` crosses session
ownership and has more than one recovery branch), so the Branch Station
catalog and LogTape apply. Spec #57 names two exceptions to the shared skill;
they are recorded here and in the catalog and change nothing in the skill.

1. Preview and apply. The `1.0.0` rule that every non-inspect command previews
   effect identities and applies a matching unconsumed preview is not applied
   to `bind` or to the hook marker. Each effect is one local file, idempotent
   by owner comparison, with no external effect identity to preview; a
   preview journal would reintroduce the second private state store that made
   the retired candidate heavy. Any future command with an external effect is
   outside this exception.
2. `hook`. Its output contract belongs to the Harness, so it never emits the
   envelope, never writes a human-mode refusal line, exits `0` on invalid
   input or any read failure with empty output, sends diagnostics to the
   private file sink only, and is excluded from the checker rows. The
   exception covers the argv `hook` alone.

## Lock and TOCTOU limits

The admitted lock (Gate `lkr-yoc`) is BSD `flock(2)` through `bun:ffi` on
macOS: permanent private `0600` lock files, authority held by the open
descriptor only, a 2,000 ms bounded wait polled every 25 ms, and no age-based
or PID-based stealing. The binding write takes the workspace lock, then the
session lock, in that order everywhere; the marker sections take the session
lock alone, and no native `bd` read ever runs under a lock, so a `PostCompact`
is never dropped behind a prompt's reads. A holder killed with `SIGKILL` releases the lock to the next
process through the kernel. A holder that is alive but stuck blocks the next
process for the full bound, which then returns `UNAVAILABLE_STORAGE_BUSY` with
the 2,000 ms retry hint.

Limits stated plainly:

- Only `darwin` has an admitted Lock Adapter. Every other platform returns
  `UNAVAILABLE_LOCK_UNSUPPORTED` before any effect; a Linux `flock` Adapter is
  a later unit behind the same interface.
- No holder identity is recorded, so a busy lock names no owner and `inspect`
  can only report whether each lock file is absent, safe, or unsafe.
- The lock descriptor is re-checked against its own inode after acquisition,
  and every private file is opened with `O_NOFOLLOW` and checked by descriptor.
  Those checks close the symlink and replacement races on the file itself.
  They do not defend against the effective user's own concurrent tampering
  with ancestor directories or lock files between a check and the following
  open, and a lock file that is unlinked and recreated by that user while a
  holder is inside its section is not detected. The threat model is another
  cooperating helper process, not a hostile same-user actor.
- The write is one file, so there is no partial state: a failure before the
  rename is `unchanged` and retryable; a failure after the rename became
  visible is `unknown`, not retryable, with `recover` as the next action.
- The helper makes no atomicity claim between Beads and local state, because
  it never writes Beads.

## Recovery and rollback

Helper-side recovery, by cause:

| Cause | What to do |
| --- | --- |
| `INTERNAL_WRITE_OUTCOME_UNKNOWN` | Run `msb-workflow recover --workspace <path> --session <id>` to read the durable binding, then decide whether to bind again. |
| `UNAVAILABLE_STORAGE_BUSY` | Wait for the other helper process, then repeat the same command. |
| `UNAVAILABLE_BEADS_READ`, `UNAVAILABLE_WRITE_FAILED` | Repair the named cause (store present, no other `bd` holding it, private directory owner and mode, free space), then repeat the same command. |
| `SCHEMA_BINDING_INVALID` | Read the named file, move or delete it, then bind again. The helper never rewrites a malformed binding. |
| `DOMAIN_STATE_UNSAFE`, an unsafe lock file in `inspect` | Repair the named entry (owner, mode `0600` or `0700`, no symlink, one link) or remove it; a removed lock file is recreated `0600` on the next locked write. |
| `DOMAIN_BINDING_OWNERSHIP_CONFLICT` | Recover the saved binding and continue that Bead, or use a different session for the new Bead. No flag replaces a saved owner. |
| Uncertain marker generations | Run `recover`; the next prompt hook emits the notice, not the panel, and settles them. |

Rollback of the helper in `M1`: stop using it. There is nothing to unwind in
Beads because the helper never wrote it. The Python route, the schema-v2
checkpoints, the launchers under `hooks/`, and the hook registrations are
untouched, so the proven path is still the live path. Keep the helper's
private v3 state readable and do not translate it to schema v2.

## Build, run, and prove

From the plugin root:

```sh
bun run build            # regenerates every runtime bundle, including runtime/msb-workflow.js
bun run test:workflow-cli
bun run test
bun run typecheck
```

- `runtime/msb-workflow.js` is generated from `packages/workflow-cli/src/cli.ts`
  by `bun build --target=bun` (the plugin `build` script). Edit the source,
  then regenerate; never edit the bundle. The bundle inlines `@logtape/*`
  `2.3.1` and uses `bun:ffi` for the lock, so it runs only under `bun`. The
  entry is `cli.ts` rather than `main.ts` for one packaging reason: Bun folds
  the `import.meta.main` guard of a non-entry module to a constant `if (false)`
  that the repository's Biome gate rejects, while the same guard in the entry
  module stays a runtime expression and runs `main()` exactly once.
- `bin/msb-workflow` is the thin launcher: it resolves the plugin root from
  its own location and runs `exec bun "$plugin_root/runtime/msb-workflow.js" "$@"`,
  so stdin passes through for `hook`. It needs `bun` on `PATH`; if `bun` is
  missing, the shell exits `127` before the helper runs, which is a launcher
  limit `M2` must weigh when it registers the hook.
- `src/cli.ts` is the production entry with the accepted bd pin and the
  bundle entry; `src/main.ts` is the unconditional entry that always runs
  `main()`; `tests/fixtures/checker/cli.ts` is the shim-lane entry the tests
  and the checker spawn with the fixture `bd`. All four paths run the same
  `main()`.
- `bun run test:workflow-cli` runs the three complex-profile layers: `tests/unit`,
  `tests/integration` (real processes through the shim-lane entry against the
  fixture `bd` with a reset private state root per scenario, plus one row
  through the production entry proving it refuses the fixture `bd`), and
  `tests/catalog` (every Branch Station reached through a real process). The
  plugin `test` script includes the same three directories.
- `bun test packages/workflow-cli/tests/native-storage` runs against the
  pinned executable and an isolated throwaway store created by `bd init`,
  never the selected trial store. It is bound to the machine that holds the
  pinned executable and fails, never skips, without it, so it is not part of
  the plugin `test` script; run it directly as Ticket #58 lists it.
- `bun run typecheck` covers this package through the plugin `tsconfig.json`
  globs (`packages/*/src/**/*.ts`, `packages/*/tests/**/*.ts`).
- The `cli-design` checker invocation, its preparation fixtures
  (`tests/fixtures/checker/`), and the expected row record live in Ticket #58.
  Since the production entry enforces the accepted pin, that invocation's
  `bun run "$P/src/cli.ts" bind ...` preparation lines and its
  `--command "bun run src/cli.ts"` must name `tests/fixtures/checker/cli.ts`
  when they run with the fixture `bd`.
  The installed checker is the `2.0.0` successor and this helper keeps
  Contract Core `1.0.0`, so every machine row records
  `TARGET_CONTRACT_UNSUPPORTED` and the run exits `4`; the human rows and the
  target-unchanged row are judged on their own terms. No green is claimed. An
  upgrade to Contract Core `2.0.0` is a separately authorised unit under the
  skill's Versioning section.

## Layout

| Owner | File |
| --- | --- |
| CLI: parsing, mode, dispatch, exit | `src/cli.ts`, `src/main.ts` |
| Contract: envelope, discovery, exits, redaction, human rendering | `src/command-contract.ts` |
| Model: closed types | `src/model.ts` |
| Recovery: schema-v3 validation, owner comparison, panel, next safe action | `src/recovery.ts` |
| Compaction marker state machine | `src/compaction-marker.ts` |
| Runtime: private addresses, descriptor-checked reads, atomic writes, lock ordering | `src/runtime.ts`, `src/lock-adapter.ts` |
| Closed JSON parsing | `src/closed-json.ts` |
| Beads read Adapter, Git read, bounded processes, production composition, Recovery Adapter | `src/adapters/` |
| Commands | `src/commands/bind.ts`, `inspect.ts`, `recover.ts`, `hook.ts`, `shared.ts` |
| Branch Station catalog | `src/branch-station-catalog.ts` |
| Diagnostics | `src/diagnostics.ts` |
