# Codex native candidate route

Use this route when Claude is unavailable. Keep the same feature prompts and
semantic criteria. This is native candidate qualification, not production
activation. Inspect `codex exec --help`, `codex plugin marketplace add --help`,
`codex plugin add --help` and both remove commands before effects.

## Launch and doctor

Use Launch's private run directory and source snapshots. Save
`codex plugin marketplace list --json` and `codex plugin list --json` there.
Require `delivery-slice-dev` to be absent. Capture only `plugins` and
`marketplaces` from `~/.codex/config.toml` with `tomllib` into
`codex-selection-before.json`; preserve unrelated selections and registrations.
Do not print or copy credential configuration.

Create `$run_dir/marketplace/.agents/plugins/marketplace.json` with top-level
`name: delivery-slice-dev` and one plugin named `personal`, using the candidate
manifest version and `source: {source: local, path: ./personal}`. Link
`$run_dir/marketplace/personal` to this worktree's
`config/agents/plugins/personal`. Then run:

```sh
codex plugin marketplace add "$run_dir/marketplace" --json > "$run_dir/register.json"
codex plugin add personal@delivery-slice-dev --json > "$run_dir/install.json"
codex login status > "$run_dir/codex-auth.txt" 2>&1
codex --version > "$run_dir/codex-version.txt"
codex plugin list --json > "$run_dir/plugins-doctor.json"
```

Require login and the expected candidate version. Read `installedPath` from the
install receipt, then compare the installed delivery-slice SKILL.md and publication
reference with the source using `cmp`. Record both paths and hashes. Registration
alone is not readiness. Do not refresh or remove production Personal.

## Drive and evidence

Select the feature prompt and require the session to load delivery-slice from
`personal@delivery-slice-dev` in its catalogue, plus the real installed to-spec
and to-tickets owners. Codex uses its supported read mechanism rather than
Claude's Skill tool. Run from this task worktree:

```sh
caffeinate -dimsu codex exec --ignore-user-config -C "$candidate_root" \
  -s read-only --ephemeral \
  -c 'plugins={"personal@delivery-slice-dev"={enabled=true}}' \
  -c "marketplaces={\"delivery-slice-dev\"={source_type=\"local\",source=\"$run_dir/marketplace\"}}" \
  --json \
  -o "$run_dir/final.md" - < "$run_dir/prompt.txt" \
  > "$run_dir/events.jsonl" 2> "$run_dir/stderr.log" &
run_pid=$!
wait "$run_pid"
run_exit=$?
printf '%s\n' "$run_exit" > "$run_dir/exit.txt"
```

`--ignore-user-config` avoids unrelated user MCP transport incompatibility in
this CLI. The two inline-table overrides select only the native development
marketplace and candidate; they do not rewrite persistent selections. Use the
whole inline tables: this CLI interpreted quoted dotted plugin keys as literal
quote characters and failed candidate discovery in a smoke run. Retain the
exact argv without credential values. Require offline fixture use, no
browser/remote tools, no writes and no nested sessions in the prompt. Read-only
shell sandboxing does not restrict connector writes by itself. Inspect every
actual command/tool event for attempts outside the scope.

Require `turn.completed`, exit 0, a final answer and actual source reads from the
candidate cache and composition owners. Judge the same mapped semantic outcomes;
do not replace successful draft behavior with catalogue discovery alone.
A separate fresh session can prove project-local verifier discovery by loading
`$verify-delivery-slice` and naming the feature map, without starting another run.

## Cleanup

After every drive, wait for the owned process and verify its exit. After the last
journey remove only the registration this run created:

```sh
codex plugin remove personal@delivery-slice-dev --json > "$run_dir/remove.json"
codex plugin marketplace remove delivery-slice-dev --json > "$run_dir/unregister.json"
codex plugin list --json > "$run_dir/plugins-after.json"
codex plugin marketplace list --json > "$run_dir/marketplaces-after.json"
```

Compare the protected config projection semantically with the before snapshot.
Require the candidate registration/cache to be absent, production selection
unchanged, and unrelated registrations preserved. If another agent changes an
unrelated registration concurrently, report the exact independent change;
never restore the whole config. Remove only the owned marketplace symlink and
catalog after unregistration. Preserve the run directory and proof. Complete
the main verifier's Git comparison and evidence-survival checks too.
