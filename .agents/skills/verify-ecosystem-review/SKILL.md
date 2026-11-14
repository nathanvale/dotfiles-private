---
name: verify-ecosystem-review
description: Verify the ecosystem-review briefing through fresh read-only Codex sessions, candidate plugin discovery, and retained evidence. Use when changing the skill or qualifying its behavior in Dotfiles.
---

# Verify ecosystem-review

The user touches an agent conversation. There is no application server, port,
container, or database to start. Use the native Codex CLI and its development
marketplace. Read [the feature map](features/README.md) before selecting a journey.
Keep live Linear read-only. Use supplied offline records for adverse evidence.

## Launch

From the isolated task worktree root, inspect `codex exec --help`,
`codex plugin marketplace add --help`, and `codex plugin add --help`. The recipe
was exercised with codex-cli 0.166.0. If the installed interface differs, refresh
these commands before driving it. Follow the repository's skill owner for
validation and production promotion. This recipe authorizes no promotion.

Set the run locations in the foreground shell:

```sh
umask 077
candidate_root=$(git rev-parse --show-toplevel)
run_dir="${XDG_STATE_HOME:-$HOME/.local/state}/ecosystem-review/$(date +%Y%m%dT%H%M%S)-candidate"
export candidate_root run_dir
mkdir -m 700 -p "$run_dir"
```

Capture protected selections before registration. This reads no secret values:

```sh
python3 - <<'PY'
import json, os, pathlib, tomllib
root = pathlib.Path(os.environ['run_dir'])
for name, path, keys in [
    ('codex', pathlib.Path.home()/'.codex/config.toml', ['plugins', 'marketplaces']),
    ('claude', pathlib.Path.home()/'.claude/settings.json', ['enabledPlugins', 'permissions', 'model']),
]:
    data = tomllib.loads(path.read_text()) if name == 'codex' else json.loads(path.read_text())
    (root/(name+'-selections-before.json')).write_text(json.dumps({k:data.get(k) for k in keys}, indent=2)+'\n')
market = root/'marketplace'
(market/'.agents/plugins').mkdir(parents=True)
(market/'personal').symlink_to(pathlib.Path(os.environ['candidate_root'])/'config/agents/plugins/personal', target_is_directory=True)
version = json.loads((market/'personal/.codex-plugin/plugin.json').read_text())['version']
(market/'.agents/plugins/marketplace.json').write_text(json.dumps({
    'name':'ecosystem-review-dev', 'plugins':[{'name':'personal', 'version':version,
    'source':{'source':'local','path':'./personal'}}]}, indent=2)+'\n')
PY
codex plugin marketplace list --json > "$run_dir/marketplaces-before.json"
```

Require `ecosystem-review-dev` to be absent before registering. If it exists,
stop and identify its owner instead of replacing another run. The directory's
`personal` link must resolve to this task worktree's plugin. Register only it:

```sh
codex plugin marketplace add "$run_dir/marketplace" --json > "$run_dir/register.json"
codex plugin add personal@ecosystem-review-dev --json > "$run_dir/install.json"
```

Ready means the installed candidate version and copied `ecosystem-review`
bytes match the worktree, followed by a fresh session that loads that installed
skill. Registration alone does not establish readiness. Keep production
Personal installed. Disable it only in each evaluation invocation below.

## Doctor

Run these read-only checks before the first drive and when anything looks off:

```sh
codex login status > "$run_dir/auth-status.txt" 2>&1
codex --version > "$run_dir/version.txt"
codex plugin list --json > "$run_dir/plugins-doctor.json"
codex plugin marketplace list --json > "$run_dir/marketplaces-doctor.json"
git rev-parse HEAD > "$run_dir/base.txt"
git diff --binary > "$run_dir/candidate.diff"
git status --short > "$run_dir/worktree-before.txt"
```

Require the candidate to be enabled, with the expected version and marketplace
root. Read its `installedPath` from `install.json`; compare its skill bytes with
`config/agents/plugins/personal/library/ecosystem-review/SKILL.md` using `cmp`.
Record the installed path and SHA-256. Save untracked candidate source files
alongside the diff, because `git diff` does not include them. A missing login,
wrong bytes, or absent skill is a failed readiness check. Repair through the
native owner, then retry in a fresh session.

Check the actual offered or discoverable read routes in each fresh session.
Follow [native capability proof](references/native-capabilities.md). Capture
supported discovery/read events and failure details. A self-reported list or a
configured plugin alone is not an independent offered-tool inventory. Record
which entries are offered, actually tested, restricted by the task, or unknown.
An unavailable route is not evidence of an empty backlog. Add no credentials,
clients, connections, or permissions to make a journey pass.

## Drive

Use the normal user question in a fresh native session. This command captures
the action, complete event stream, final answer, diagnostics, and exit status:

```sh
cat > "$run_dir/prompt.txt" <<'PROMPT'
Where are we with the agent ecosystem, and what needs me next?
Use the candidate ecosystem-review skill from the available skill catalogue.
Keep this a read-only current snapshot, with no baseline. Prefer existing
connected Linear reads; if insufficient, use this Harness's supported native
browser and existing signed-in personal session through the browser owner.
Substantiate access limits with offered/discovered capabilities and supported
read attempts. If no route is available, name its prerequisite and distinguish
saved context from live evidence. Do not write files,
save a review, reconnect services, drive Fable or Claude Desktop, or dispatch work.
State which skill path you loaded.
PROMPT
caffeinate -dimsu codex exec -C "$candidate_root" -s read-only --ephemeral \
  -c 'plugins."personal@personal".enabled=false' --json \
  -o "$run_dir/final.txt" - < "$run_dir/prompt.txt" \
  > "$run_dir/events.jsonl" 2> "$run_dir/stderr.log" &
run_pid=$!
wait "$run_pid"
run_exit=$?
printf '%s\n' "$run_exit" > "$run_dir/exit.txt"
```

Use [the offline journey](features/evidence.md) for supplied evidence, and
[the comparison journey](features/comparison.md) for a baseline. Use
[the delivery journey](features/delivery.md) to verify stage recognition and a
read-only handoff recommendation. Keep each
journey's files in a separate run directory. Reuse one owned registration
sequentially, never double-drive the same browser session. A run ends when the
process exits and a final answer plus `turn.completed` exist. Record an absent
final event as incomplete, even if the outer shell exits successfully.

For project-local discovery, start a separate fresh session in this worktree
and ask it to identify `$verify-ecosystem-review` and its feature map from the
catalogue, without launching another run. Require the loaded path to be this
`.agents/skills/verify-ecosystem-review/SKILL.md`. Claude plugin discovery can be
checked separately with `claude --plugin-dir "$candidate_root/config/agents/plugins/personal"`.
Use [native capability proof](references/native-capabilities.md) for the bounded
fresh Claude recipe. Keep its tool, quota, and runtime outcomes separate from
Codex. Do not report an unrun or denied route as qualified.

## Evidence

Judge the answer against the selected feature's observable criteria. Record
pass, fail, partial, or unrun per sub-feature, with source and event references.
Have an independent reader inspect the source packet, user request, events,
and answer without giving it the intended answer. Evaluate meaning, links,
coverage, and attempted side effects, rather than matching phrases in prose.

Capture the exact candidate skill and feature sources, hashes, CLI version,
working directory, command, prompt, start/end time, exit, and final completeness.
Keep raw records in the private run directory. Refresh no remote state. Inspect
events for attempted writes, dispatch, or unrelated exploration. Read-only
sandboxing protects shell writes; it does not authorize connector mutations.
Record final Git status and compare it with the pre-run status. Report the
limits of remote side-effect observation when no audit route is available.

Offline supplied artifacts are an existing input boundary. They qualify
interpretation, not live Linear access, browser authentication, or current
planning state. A partial live snapshot can prove routing and honest access
handling while leaving whole-outcome coverage unqualified.

## Cleanup

After every successful or failed iteration, wait for the owned CLI process.
If interrupted, inspect the recorded PID and its children before terminating
only that run's processes. Never kill by process name. Record their exit and
verify no owned process survives.

After the last journey, remove only this run's native candidate registration:

```sh
codex plugin remove personal@ecosystem-review-dev --json > "$run_dir/remove.json"
codex plugin marketplace remove ecosystem-review-dev --json > "$run_dir/unregister.json"
```

Recapture the protected selection projections from Launch and compare them
semantically with the before snapshots. Require unrelated selections and
Claude state to match. Check that the candidate cache and registration are
absent while production Personal remains selected. Preserve any unexpected
change for its owner instead of restoring whole configuration files.

Remove the owned `marketplace/personal` link and generated catalog only after
unregistration. Keep the run directory, prompt, copied sources, all outputs,
and judged result. List and hash those proof files after cleanup. Evidence
survival is part of the proof. Keep the task worktree for PR review.

## Helpers and maintenance

No new executable helper or Linear client is needed. Native CLI help owns the
command interface. Use pstack's `maintain-verification-skill` when updating the
map as the briefing changes. Keep maintenance user-triggered unless scheduled
separately.
