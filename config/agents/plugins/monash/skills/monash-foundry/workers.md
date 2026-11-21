# Monash workers

Hand one bounded, independent unit to a Monash Codex worker (Sol 6.1,
`gpt-6.1-sol`, by default) and get a checked handback. Any coordinator,
orchestrator or agent can use this route. The default shape opens the worker in
a Herdr pane; without a running Herdr session, use the shape with no pane and
say so.

`monash-worker` owns the brief wrapper, the handback convention, the bound and
the receipt. Its source is `scripts/foundry/monash-worker`; the installer links
it as `~/.local/bin/monash-worker`. Read `monash-worker --help` for flags.

Workers, with or without a pane, run `codex exec --profile monash-sol` in the worker Codex home
`~/.codex-monash-sol`, which `scripts/foundry/install.py` creates and
`--check` verifies. The profile selects provider `monash_foundry`, model
`gpt-6.1-sol`, high effort, the priority (fast) tier, and the workspace-write
sandbox with network access. Nathan's `~/.codex` is not touched.

The worker home also enables pstack, Matt Pocock's skills, connectors and
monash-tools, never personal. `install.py` copies their marketplace entries
from `~/.codex/config.toml`, so workers use the same plugin sources as Nathan's
Codex; it refuses when one is missing there. Never run a first
`codex plugin add` in the worker home: Codex writes inside the managed
provider block. After an install that changes the plugins, run the fetch
command the installer prints (`codex plugin marketplace upgrade`, then
`codex plugin add` for each declared plugin), and run it again after any
plugin update in `~/.codex`.

## Pick the shape

Start every new worker in a Herdr pane, so Nathan can watch it. Nathan, 20
November 2026, 16:54: "Change it so future workers can do it. So I can see it
and heard it from the future workers."

| Shape | Use for | Command |
| --- | --- | --- |
| Herdr pane (default) | Every new unit | `monash-worker run --pane` |
| No pane | Only when no Herdr session is available; say so in your report | `monash-worker run` |
| Interactive pane | Steering a worker turn by turn by hand | `monash spawn`, then `monash-worker prepare` and `check` |

## Write the brief

- One unit per brief. Name the scope, absolute input paths, the question or
  change, and the evidence form you need (`path:line`, or a command and its
  output).
- Name the inputs. An exec worker has network, so it can fetch a pull request
  or public page itself; a file on disk is still faster and pins what it read.
  It has no credentials for private services such as Linear, so copy that text
  into an input file.
- Phrase review work as expected behaviour to confirm. Attack wording ("try
  to break it") has tripped the provider's content filter, which replaces the
  answer with "This content can't be shown".
- Leave the handback rules out of the brief: `monash-worker` appends them,
  and each unit's `prompt.md` shows the exact text the worker received.

## Run a worker

```sh
monash-worker run --pane --brief BRIEF.md --out OUT_DIR --cwd /abs/repo
```

- `--pane` opens a new Herdr tab labelled `sol: <OUT_DIR name>` in session
  `default` (`--herdr-session` names another), without taking focus. Codex's
  live output shows there once the tab's shell is ready. The worker gets that
  pane's own Herdr identity, not the caller's. The command waits within the
  bound (a result after it is not accepted), writes the same
  receipt as a run without a pane, and closes the tab once the handback and
  exit code are captured; the pane's output is kept in `codex.log`.
- With `--pane` and no running Herdr session, the command refuses (exit 2)
  before writing anything and names the repair. It never falls back to a run
  without a pane; drop `--pane` only when no Herdr session is available, and
  say so.

- Fan out by running one call per unit at the same time, each with its own new
  `--out`. Wait for every call, then judge each receipt.

  ```sh
  monash-worker run --pane --brief a.md --out "$OUT/a" --cwd "$REPO" >/dev/null & a=$!
  monash-worker run --pane --brief b.md --out "$OUT/b" --cwd "$REPO" >/dev/null & b=$!
  wait $a || echo "unit a exited $?" >&2
  wait $b || echo "unit b exited $?" >&2
  ```

  Each call creates its `--out`, parents included, and writes
  `receipt.json` there; `test_monash_worker.py` runs this example.
  In Claude Code, a background Bash call per unit works the same way.
- `--out` must be new or empty; the command refuses to overwrite a unit's
  results. Keep it outside the worker's repository, in the coordinator's
  scratch or shared notes folder (`<notes>/workers/<unit>/`).
- Sandbox: by default the profile's workspace-write, with network; the worker
  can write in `--cwd`, `/tmp` and `$TMPDIR`. Point `--cwd` at a worktree or
  scratch directory made for that unit, never a checkout someone else is
  using. `--sandbox read-only` keeps the worker from writing and also turns
  network off. The worker's edits are a proposal: the coordinator reviews the
  diff, runs checks, and commits and pushes itself.
- Effort: `high` by default (`--effort`). Tier: the profile asks for priority
  (fast); the receipt's `route.service_tier` records what Codex applied.
- Bound: the default 1800 seconds suits reviews (Sol reviews have taken 3.5 to
  6 minutes; small read-only questions 20 to 45 seconds). A timeout stops the
  whole worker process group.

Each `--out` holds `brief.md`, `prompt.md` (what the worker received),
`events.jsonl` (Codex JSON events), `codex.log` (Codex's stderr),
`last-message.md` (the handback) and `receipt.json`. The receipt's `route`
comes from the thread's session record in the worker home: the last applied
model, provider, service tier, effort and network, plus any model reroute,
which fails the run. The same
receipt prints as one JSON line on stdout. Rerunning `check` on an exec unit
keeps its recorded launch facts, so a timeout, start failure or wrong route
stays in the verdict. It checks the route against the receipt's requested
model unless `--model` names another.

| Exit | `status` | Meaning |
| --- | --- | --- |
| 0 | `done` | Handback says done and the route ran the requested model on `monash_foundry`. |
| 2 | `usage` | Refused before launch (bad flag, missing brief, used `--out`, no worker profile). |
| 3 | `blocked` | Worker handed back blocked; `handback.reason` says why. |
| 4 | `timed_out` | No handback within the bound. |
| 5 | `failed` | Codex did not start or exited nonzero, no session record, wrong model or provider, a model reroute, or no exact `HANDBACK` line; see `problems`. |
| 130 | `interrupted` | The caller interrupted the run; the worker's process group was stopped. |

## Steer an interactive pane by hand

Use this only to talk to a worker between turns; `run --pane` covers watching.

1. Spawn one fresh pane per unit, without focus:
   `monash spawn --host laptop --model gpt-6.1-sol --agent codex --cwd /abs/repo --pane EXISTING_PANE --no-input --verify`.
   From outside Herdr, `--pane` names an existing pane in session `default`
   whose tab receives the sibling.
2. On `startup_blocked`, read the pane (`herdr --session default agent read NAME`).
   Codex's "Hooks need review" prompt: choose "Continue without trusting"
   unless Nathan has trusted those hooks. A folder trust prompt is Nathan's.
   Then run `monash verify NAME`. Do not rerun `spawn`.
3. Set effort with Codex `/model` (the launcher default is medium) and the
   fast tier with `/fast`, then confirm with `/status`: model GPT-6.1-Sol,
   the chosen effort, provider `monash_foundry`. The launcher's default tier
   applies only at launch; `/fast` sets `service_tier: priority` for the
   session, and the session file's `thread_settings_applied` event records it.
4. `monash-worker prepare --brief BRIEF.md --out OUT_DIR` writes `prompt.md`,
   which tells the worker to write its handback to `OUT_DIR/last-message.md`,
   and prints the one line to send. Send it:
   `herdr --session default agent prompt NAME "<send>" --wait --until done --until idle --until blocked --timeout 1800000`.
5. `monash-worker check --out OUT_DIR` writes and prints the receipt. An
   interactive pane's receipt has `launch: null` and no route check (unlike `run --pane`), so confirm the model from
   the pane footer or `/status`.
6. Close the pane once the handback is captured:
   `herdr --session default pane close PANE`.

## Units that end in a pull request

Every pull request follows three rules (Nathan, 20 November 2026). External
writes stay with the coordinator, so the worker prepares and the coordinator
publishes. Put the worker's half in the brief.

Worker, in its unit worktree (`--sandbox workspace-write`):

1. Run the `code-review` skill on the unit's diff and fix what it finds.
   List each finding and its fix, or why it was left, in the handback.
2. Write the pull request body with the `pr` skill: Summary, Evidence with
   Before and After, Merge Danger with Door and Blast Radius. Put it in the
   handback under a `## PR body` heading, above the `HANDBACK` line.

Coordinator, after the checks in the next section pass:

3. Commit and push the branch, then open the pull request ready for review
   with that body. Ready, not draft: this replaces the draft default for
   these pull requests.
4. Drive it with the Babysit playbook of pstack's `poteto-mode` skill, in
   `drive` mode, until the forge reports it merge-ready. Merging stays
   Nathan's call.

When the coordinator writes the change itself, it runs steps 1 and 2 too.

## Check before use

1. Require `status: done`; for `run`, with or without `--pane`, the receipt has already checked
   `route.model` and `route.provider`. Treat `blocked`, `timed_out` and `failed` as no result: read the
   reason, fix the brief or inputs, and run a new unit with a new `--out`.
2. Open every cited `path:line` or rerun the cited command, and confirm the
   claim before acting on it. A done receipt proves delivery, not correctness.
3. Keep external writes (push, pull request, comments, messages) in the
   coordinator.

## Route trade-off

Exec workers bypass `monash-foundry launch` (Nathan, 20 November 2026), which
pinned the default tier and allowed no network. The cost:

- Workers inherit only the environment names the launcher route passed to
  Codex (`monash-foundry`'s allowlist) plus `CODEX_HOME`, so credentials and
  proxy settings stay out. The launcher's argument guard no longer applies:
  the profile pins the provider and model instead, and the receipt fails a run
  whose session record names another model or provider.
- `monash-worker run` refuses a worker home that is a link, not yours, or not
  mode 700, or managed files that are not mode 600; rerun the installer.
- Network access applies to every workspace-write exec worker, and only to
  them: the separate home keeps it out of Nathan's own Codex sessions.
- The worker home has no `AGENTS.md`, so Nathan's global Codex instructions do
  not load in exec workers. The appended handback rules still apply.

## Known gaps

- A worker's tier is client-side evidence: the request asked for
  priority and the turns completed. Whether Azure served priority is not
  observed.
- `monash doctor` reports Herdr `failed` while `herdr status --json` shows the
  server running: the doctor reads plain `herdr status` as JSON. Trust
  `herdr status --json`.
- `model-selection-preflight --provider monash` returns `probe_nonzero` when
  any configured deployment is unavailable, because `monash models --refresh
  --json` then exits 3 even though the requested model's row says
  `available`. Read that row, or rely on the worker receipt's route check.
