# Monash workers

Hand one bounded, independent unit to a Monash Codex worker (Sol 6.1,
`gpt-6.1-sol`, by default) and get a checked handback. Any coordinator,
orchestrator or agent can use this route; it needs no Herdr session for the
default shape.

`monash-worker` owns the brief wrapper, the handback convention, the bound and
the receipt. Its source is `scripts/foundry/monash-worker`; the installer links
it as `~/.local/bin/monash-worker`. Read `monash-worker --help` for flags.

## Pick the shape

| Shape | Use for | Command |
| --- | --- | --- |
| Exec (default) | Unattended units: questions, reviews, analysis, a patch in a worktree | `monash-worker run` |
| Herdr pane | Long work a coordinator watches or steers between turns | `monash spawn`, then `monash-worker prepare` and `check` |

## Write the brief

- One unit per brief. Name the scope, absolute input paths, the question or
  change, and the evidence form you need (`path:line`, or a command and its
  output).
- Give the worker every input it needs on disk. The worker's sandbox has no
  network, so fetch a pull request diff, Linear issue text or remote state first
  (for example `gh pr diff 18 > /abs/out/pr-18.diff`).
- Phrase review work as expected behaviour to confirm. Attack wording ("try
  to break it") has tripped the provider's content filter, which replaces the
  answer with "This content can't be shown".
- `monash-worker` appends the handback rules to every prompt: stay in scope,
  no push, pull request, post or message, cite evidence, and end with
  `HANDBACK: done` or `HANDBACK: blocked: <reason>`. Leave those out of the
  brief.

## Run exec workers

```sh
monash-worker run --brief BRIEF.md --out OUT_DIR --cwd /abs/repo \
  [--effort high] [--sandbox read-only] [--timeout-seconds 1800]
```

- Fan out by running one call per unit at the same time, each with its own new
  `--out`. Wait for every call, then judge each receipt.

  ```sh
  monash-worker run --brief a.md --out "$OUT/a" --cwd "$REPO" > "$OUT/a.json" & a=$!
  monash-worker run --brief b.md --out "$OUT/b" --cwd "$REPO" > "$OUT/b.json" & b=$!
  wait $a; wait $b
  ```

  In Claude Code, a background Bash call per unit works the same way.
- `--out` must be new or empty; the command refuses to overwrite a unit's
  results. Keep it outside the worker's repository, in the coordinator's
  scratch or shared notes folder (`<notes>/workers/<unit>/`).
- `--sandbox read-only` is the default. Use `workspace-write` only with
  `--cwd` set to a worktree made for that unit. The worker's edits there are a
  proposal: the coordinator reviews the diff, runs checks, and commits and
  pushes itself.
- Effort: `high` by default; the launcher validates the value against its
  catalogue.
- Tier: exec runs on the default tier. The launcher passes
  `service_tier="default"` and refuses `-c service_tier=...` and `-p` with
  exit 2 before launch. Use a pane worker when a unit needs the fast tier.
- Bound: the default 1800 seconds suits reviews (Sol reviews have taken 3.5 to
  6 minutes; small read-only questions 20 to 45 seconds). A timeout stops the
  whole worker process group.

Each `--out` holds `brief.md`, `prompt.md` (what the worker received),
`events.jsonl` (Codex JSON events), `launcher.log` (the launcher's route line
and errors), `last-message.md` (the handback) and `receipt.json`. The same
receipt prints as one JSON line on stdout.

| Exit | `status` | Meaning |
| --- | --- | --- |
| 0 | `done` | Handback says done and the route ran the requested model. |
| 2 | `usage` | Refused before launch (bad flag, missing brief, used `--out`). |
| 3 | `blocked` | Worker handed back blocked; `handback.reason` says why. |
| 4 | `timed_out` | No handback within the bound. |
| 5 | `failed` | Launcher refused or exited nonzero, wrong model, or no `HANDBACK` line; see `problems`. |

## Run a pane worker

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
5. `monash-worker check --out OUT_DIR` writes and prints the receipt. A pane
   receipt has `launch: null` and no route check, so confirm the model from
   the pane footer or `/status`.
6. Close the pane once the handback is captured:
   `herdr --session default pane close PANE`.

## Check before use

1. Require `status: done` and, for exec, `route.model` equal to the requested
   model. Treat `blocked`, `timed_out` and `failed` as no result: read the
   reason, fix the brief or inputs, and run a new unit with a new `--out`.
2. Open every cited `path:line` or rerun the cited command, and confirm the
   claim before acting on it. A done receipt proves delivery, not correctness.
3. Keep external writes (push, pull request, comments, messages) in the
   coordinator.

## Known gaps

- Fast stays pane-only (Nathan, 20 November 2026): the launcher keeps
  exec on the default tier.
- A pane worker's tier is client-side evidence: the request asked for
  priority and the turns completed. Whether Azure served priority is not
  observed.

- `monash doctor` reports Herdr `failed` while `herdr status --json` shows the
  server running: the doctor reads plain `herdr status` as JSON. Trust
  `herdr status --json`.
- `model-selection-preflight --provider monash` returns `probe_nonzero` when
  any configured deployment is unavailable, because `monash models --refresh
  --json` then exits 3 even though the requested model's row says
  `available`. Read that row, or rely on the worker receipt's route check.
