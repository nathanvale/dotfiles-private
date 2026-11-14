---
name: verify-delivery-slice
description: Verify delivery-slice through a fresh native Claude Code candidate session, supplied Wayfinder records, and retained draft/effect evidence. Use when changing or qualifying delivery-slice in Dotfiles.
---

# Verify delivery-slice

The user surface is an agent conversation, not an application server. Read
[the feature map](features/README.md). This project-local verifier is discovered
at `.agents/skills/` by Codex and through the `.claude/skills/` tracking link by
Claude. Candidate Personal is loaded for one Claude session via `--plugin-dir`;
there is no installation or production refresh. For the native Codex candidate route, read
[the candidate recipe](references/codex-candidate.md) and use the same feature
criteria. Qualify each Harness separately; one does not prove the other.

## Launch

From the isolated task worktree root, inspect `claude --help` and
`claude plugin validate --help`. Require the documented flags below. Start each
journey with a unique private run directory; never reuse another run's files.

```sh
umask 077
candidate_root=$(git rev-parse --show-toplevel)
run_dir=$(mktemp -d "${XDG_STATE_HOME:-$HOME/.local/state}/delivery-slice-XXXXXXXX")
export candidate_root run_dir
claude --version > "$run_dir/version.txt"
git rev-parse HEAD > "$run_dir/base.txt"
git status --short > "$run_dir/worktree-before.txt"
git diff --binary > "$run_dir/candidate.diff"
cp -R .agents/skills/verify-delivery-slice "$run_dir/verifier-source"
cp -R config/agents/plugins/personal/library/delivery-slice "$run_dir/skill-source"
shasum -a 256 config/agents/plugins/personal/library/delivery-slice/SKILL.md   config/agents/plugins/personal/library/delivery-slice/references/publication.md   > "$run_dir/source-hashes.txt"
```

The parent state directory must already exist. If absent, create only the chosen
runtime-state parent before `mktemp`. Capture protected plugin selections before
and after the run without reading credentials:

```sh
python3 - <<'PYPROJECTION'
import json, os
from pathlib import Path
p = Path.home()/'.claude/settings.json'
d = json.loads(p.read_text()) if p.exists() else {}
(Path(os.environ['run_dir'])/'claude-selection-before.json').write_text(
    json.dumps({'enabledPlugins': d.get('enabledPlugins')}, sort_keys=True)+'\n')
PYPROJECTION
```

Launch is usable when Doctor passes, then the fresh drive's initialization and
Skill event resolve `personal:delivery-slice` from this candidate. A successful
manifest validation alone is not agent readiness.

## Doctor

```sh
claude auth status > "$run_dir/auth-status.json" 2> "$run_dir/auth-stderr.log"
claude plugin validate "$candidate_root/config/agents/plugins/personal"   --strict --json > "$run_dir/plugin-validation.json"
test -r "$HOME/.agents/skills/to-spec/SKILL.md"
test -r "$HOME/.agents/skills/to-tickets/SKILL.md"
test -r "$HOME/.agents/skills/wayfinder/SKILL.md"
cmp .agents/skills/verify-delivery-slice/SKILL.md   .claude/skills/verify-delivery-slice/SKILL.md
```

Require authenticated status, successful manifest validation, readable composition owners
and matching verifier paths. A missing owner or login is a failed prerequisite;
report the owner repair and clean up the attempt. Never read credential files.
Record dependency skill hashes too, because installed upstream content can move.
Separate directory-listing advice/findings from manifest success. The inspected
base has a pre-existing missing-license directory finding; it does not establish
a skill regression or a production publication qualification.

## Drive

Select a feature's prompt and write it to `$run_dir/prompt.txt`. Use absolute
fixture paths resolved from `candidate_root`. Use the source records as inputs,
not expected output text. This is the actual supported native CLI workflow:

```sh
caffeinate -dimsu claude -p --plugin-dir "$candidate_root/config/agents/plugins/personal"   --setting-sources '' --settings '{"disableAllHooks":true}'   --strict-mcp-config --mcp-config '{"mcpServers":{}}' --no-chrome   --tools Read,Skill --allowedTools Read,Skill --permission-mode dontAsk   --no-session-persistence --output-format stream-json --verbose   < "$run_dir/prompt.txt" > "$run_dir/events.jsonl" 2> "$run_dir/stderr.log" &
run_pid=$!
wait "$run_pid"
run_exit=$?
printf '%s\n' "$run_exit" > "$run_dir/exit.txt"
```

Keep the PID in the foreground session. The permission/tool boundary permits
reading source and loading skills, with no shell, file writes, browser or tracker
MCP tools in the child. The parent records stdout as evidence. Native auth still
contacts the model service. Do not claim this offline journey proves behavior
with writable Linear tools present. Inspect initialization and every tool event;
expected tools are Skill and Read only. Inspect denied attempts as failures too.

A complete run has a successful final `result` event and exit 0, not merely an
empty stderr. Require a successful candidate Skill invocation and actual reads
of the installed `to-spec` and `to-tickets` owners. Missing selection, permission
denials or dependency reads are incomplete workflow proof. For separate project
verifier discovery, use a fresh read-only session in this worktree asking it to
load `verify-delivery-slice` and name its feature map, without recursively launching.

## Evidence

Retain commands, working directory, CLI version, start/end time, candidate and
upstream hashes, prompt, complete events, stderr, exit and final response. Extract
the final `result` text to `final.md` with a JSON parser. Judge meaning against
the feature's observable outcomes, not wording or headings. Record pass, fail,
partial or unrun for each mapped ID and link exact evidence files.

Verify the draft spec precedes tickets, links its source and separates acceptance
from proposals. Independently inspect criterion coverage, duplicates and graph
cycles. A coherent table alone is not evidence if the tickets disagree with it.
For the flawed-proposal journey, the deliberately bad input is the negative
control: retain its cycle, duplicate, bad reference and missing coverage, then
compare the repaired result against those independent faults.

Inspect the actual tools offered and used to support the no-live-effects claim.
Retain the native launch configuration, candidate manifests, initialization/tool
inventory where supported, and observed events separately. A session's capability
self-report supports inspection but is not an independent tool-definition dump.
If the native event format omits offered tools, mark F5.3 inventory partial;
command silence and read-only shell mode alone do not prove remote tools absent.
Compare before/after Git status and protected selections. This proves the
observed run's bounded effects, not a remote audit or a general enforcement
property of prose. Offline records qualify draft reasoning, not live source
resolution, workspace identity, deduplication, publication/readback, native
blocker mutation, credentials or dispatch. Keep those paths explicitly unqualified
until separately authorized isolated infrastructure supports them. Default runs
authorize no live Linear records. When Nathan separately approves an isolated
synthetic project and exact bounded effects, use the
[publication and recovery journey](features/publication.md). Keep that exception
out of production delivery and preserve its approval receipt.

For the accepted small-Markdown handoff information, read
[the handoff checks](references/handoff-checks.md). Keep its C1 through C6
semantic checks separate from unimplemented format/schema enforcement.
Use the combined candidate after both product sources settle; preserve the exact
sibling SHA and bytes. These checks do not modify intake or select the open format/storage decisions.

## Cleanup

After every attempt, wait for the owned process and record its exit. On interruption,
inspect the PID and its children, then terminate only those owned processes.
Never kill by process name. Confirm no process from this run remains. Session-only
loading needs no plugin uninstall; never remove production Personal.

```sh
git status --short > "$run_dir/worktree-after.txt"
cmp "$run_dir/worktree-before.txt" "$run_dir/worktree-after.txt"
python3 - <<'PYPROJECTION'
import json, os
from pathlib import Path
p = Path.home()/'.claude/settings.json'
d = json.loads(p.read_text()) if p.exists() else {}
r = Path(os.environ['run_dir'])
s = json.dumps({'enabledPlugins': d.get('enabledPlugins')}, sort_keys=True)+'\n'
(r/'claude-selection-after.json').write_text(s)
assert s == (r/'claude-selection-before.json').read_text()
PYPROJECTION
python3 - <<'PYEVIDENCE'
import hashlib, json, os
from pathlib import Path
r = Path(os.environ['run_dir'])
rows = []
for name in ('prompt.txt', 'events.jsonl', 'final.md'):
    p = r/name
    if p.is_file():
        rows.append({'path': name, 'state': 'present',
                     'sha256': hashlib.sha256(p.read_bytes()).hexdigest()})
    else:
        state = 'incomplete' if (r/'events.jsonl').exists() else 'unrun'
        rows.append({'path': name, 'state': state})
(r/'evidence-hashes.json').write_text(json.dumps(rows, indent=2)+'\n')
PYEVIDENCE
```

Keep the worktree for PR review and the entire private run directory after
cleanup. Confirm every produced proof file remains readable. Record absent
expected outputs as unrun or incomplete, and retain every failed iteration;
cleanup never removes proof.

## Helpers and maintenance

No custom client, executable helper or fake harness is needed. Use native CLI
help for interface drift and pstack's `maintain-verification-skill` to update
this map as behavior changes. Schedule maintenance only on request.
