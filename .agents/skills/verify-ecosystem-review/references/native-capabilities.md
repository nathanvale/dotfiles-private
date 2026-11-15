# Capture native capability proof

Use this with Doctor and the selected journey's evidence checks. Keep evidence
scoped to the Harness and session that received the tools. Capability discovery
and trace inspection require no setup, sign-in, permission change or new
client. Artifact writes remain governed by the printable journey.

## Retain native tool records

Run Codex without `--ephemeral` when qualifying tool use. On codex-cli 0.169.0,
`--json` retains shell executions and final prose but can omit `functions.exec`
calls, runtime tool-discovery results and image payloads. Missing stdout events
therefore establish neither an absent call nor its success. Keep the stdout
stream and stderr, then copy only this completed run's native rollout:

```sh
python3 - <<'PYTRACE'
import json, os, pathlib, subprocess, hashlib
root = pathlib.Path(os.environ['run_dir'])
events = [json.loads(line) for line in (root/'events.jsonl').read_text().splitlines()]
assert any(e['type'] == 'turn.completed' for e in events)
thread_id = next(e['thread_id'] for e in events if e['type'] == 'thread.started')
home = pathlib.Path(os.environ.get('CODEX_HOME', pathlib.Path.home()/'.codex'))
paths = subprocess.check_output([
    'rg', '--files', '--hidden', str(home/'sessions'),
    '-g', '*'+thread_id+'*.jsonl',
], text=True).splitlines()
assert len(paths) == 1, paths
source = pathlib.Path(paths[0])
meta = json.loads(source.open().readline())
assert meta['type'] == 'session_meta' and meta['payload']['id'] == thread_id
raw = source.read_bytes()
with (root/'rollout.jsonl').open('xb') as stream:
    stream.write(raw)
(root/'rollout-receipt.json').write_text(json.dumps({
    'thread_id': thread_id, 'source': str(source),
    'sha256': hashlib.sha256(raw).hexdigest(),
}, indent=2)+'\n')
PYTRACE
```

Wait for process exit before copying. If the native location or format differs,
resolve it through current CLI diagnostics and the session owner; preserve the
gap instead of selecting another chat. Retain native originals. Cleanup removes
only owned candidate registration, not session history.

Judge tool-call/result pairs and offered definitions, not private reasoning.
Match each `custom_tool_call` or `function_call` to its result by `call_id`.
For code-mode discovery, inspect the executed code and runtime `ALL_TOOLS`
result. Its scope covers that router, not separately offered namespaces or
undiscovered integration operations. Preserve relevant runtime declarations;
never replace them with a schema quoted in final prose. Require image-return
payloads for visual-read proof and compare them with the intended input hashes.
Keep raw traces private; publish only sanitized conclusions and pointers.

## Codex capability evidence

Check [current Browser availability](https://learn.chatgpt.com/docs/browser)
before selecting a live route. The documentation checked on 15 November 2026
excludes Browser from Codex CLI and directs local browser work to the desktop
app. Offered CUA tools and inherited desktop configuration alone do not make a
fresh CLI chat eligible. Full CLI live coverage needs an operational connected
read route; qualify native-browser coverage in an eligible desktop chat.

Ask the fresh session to discover its available Linear read route and supported
native browser. Capture stdout in `events.jsonl` and discovery/read results
in the retained native trace.
A configured plugin, successful install, or model-written tool list establishes
neither offered operations nor successful reads. When operational discovery or
offered definitions are not independently recorded, classify callable exposure
as unknown. Record observed route failures
separately, with their supporting results.
Keep startup failure diagnostics and the missing prerequisite.

Permit both routes in the live prompt. A connector-only prompt proves behavior
under that restriction, not absence of Chrome. If read-only discovery offers a
plugin install or connection rather than an operational read, stop that route
and record it; do not accept new access to manufacture coverage.

For a native pipe failure, compare the documented shell launch with the failing
launcher using the same executable, prompt, cwd, sandbox and session overrides.
Retain actual native calls/results for both. A changed response is diagnostic
evidence, not proof of browser access. The direct CLI probes on 15 November 2026
returned `Local browser access is unavailable for this chat`. The installed
browser service authenticates its access response before checking the expected
allowed assertion; that refusal is distinct from a closed pipe and website
sign-in. It does not establish why another launcher lost its connection.

Stop browser retries after a concrete chat-access refusal. Mark that route
verified-unreachable with the eligible desktop-chat prerequisite, while keeping
full CLI live coverage unqualified. Preserve inherited endpoint and identity
values, native authorization checks and production configuration. A desktop
read remains separate proof under the candidate-source/hash boundary below.

For the desktop's already available native browser, follow the runtime's current
entry documentation and use `cua.getState()` for surface inventory. Choose the
personal profile from that observation; numeric IDs are session-local. Use the
documented `cua.getTab()` for an unowned tab, or `cua.createBrowserTab()` with a
short session name when another chat owns the existing tab. Keep one driver per
browser session. Follow the browser owner and keep unrelated surfaces untouched.

The exercised Linear handles are `Document content` and `Issue description`
textboxes, `Activity`, `Blocking`, `Blocked by`, and the actual document/issue
links. `getAXState()` supplies navigation confirmation. Textbox `textContent()`
and read-only DOM `innerText` can capture the source. Activity may finish
loading after the description; observe it before relying on missing comments.
Keep browser identifiers, credentials, and screenshots out of receipts.

Record source URL, observation time, what was actually read, and unread scope.
For contradictions, preserve the competing excerpts and accepted-answer link.
Refresh through the canonical owner rather than making the capture a new store
of decisions. Keep observer-collected excerpts private in the run directory.
A fresh CLI interpreting them proves that interpretation only; qualify desktop
live access and receiving-session live access separately.

## Selection and capability-present behavior

Test implicit selection in fresh native sessions with ordinary user requests,
without naming the target skill or supplying its source path. Supply only the
bounded input records. Require an actual read of the expected installed skill
and a complete result. Use a separate unrelated one-sentence rewrite as a
negative control; neither ecosystem-review nor delivery-slice should load.
One positive and one negative qualify those cases, not general selection rates.

An explicit-source desktop run can prove source behavior and live reads when
the native catalogue lacks the candidate. Record that absence and the loaded
source hash. It cannot pass installed-catalogue discovery or fresh-CLI access.

For a separate no-write journey with native mutation-capable controls available,
retain actual tool discovery and runtime-returned API documentation, plus all
observed calls. Authorize only reads or conversation drafts. Require no mutation,
publication, readiness or dispatch attempt. This proves observed behavior with
those controls present, not successful publication or a complete remote audit.
Do not replace the bounded absent-tools journey with this distinct check.

A model-written tool list does not establish absent tools. Without independently
recorded discovery or offered definitions, mark that inventory unknown. Distinguish
the observed transport failure from authentication failure and from tool absence.

## Fresh Claude behavior

Inspect `claude --help` and `claude --version` first. The exercised candidate
route is session-only `--plugin-dir`. Use a trusted task worktree, a separate
run directory, and the same bounded records as the evidence feature. Replace
the Codex-only catalogue/cache prompt with Claude's session-only source route:

```sh
cat > "$run_dir/claude-prompt.txt" <<'PROMPT'
Where are we with the agent ecosystem, and what needs me next?
Use /personal:ecosystem-review from the session-only --plugin-dir candidate.
Review only .agents/skills/verify-ecosystem-review/fixtures/records.md as supplied
offline records. Return a compact read-only briefing with Markdown source links
and no baseline. Identify the loaded skill path. The source path is expected for
this native development route; it is not a production installation claim.
PROMPT
```

Then run:

```sh
claude --version > "$run_dir/claude-version.txt"
caffeinate -dimsu claude -p \
  --plugin-dir "$candidate_root/config/agents/plugins/personal" \
  --no-session-persistence --permission-mode plan --permission-prompts none \
  --tools 'Read,Glob,Grep,Skill' --allowedTools 'Read,Glob,Grep,Skill' \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' --no-chrome \
  --output-format stream-json --verbose < "$run_dir/claude-prompt.txt" \
  > "$run_dir/claude-events.jsonl" 2> "$run_dir/claude-stderr.log"
printf '%s\n' "$?" > "$run_dir/claude-exit.txt"
```

This intentionally bounded offline route tests candidate behavior and catalogue
exposure. It does not test live Linear or Claude browser access. Inspect the
init event's actual tools, skills, and candidate plugin entry. Require actual
skill/input reads and a complete final result before claiming behavior.

If quota, authentication, tool exposure, or permissions block the run, retain
the exact refusal and repair owner. A quota response after init proves no
briefing behavior. Add no credential, account, model substitution, connection,
or permission to get a pass. Follow the verifier's process cleanup and protected
selection comparison, and retain the evidence after teardown.

## Image and PDF capability evidence

For printable journeys, retain the actually offered image tool schema and the
current imagegen/pdf skill reads. Record whether native size controls exist,
which route ran, returned original paths, pixel dimensions and PDF inspection
commands/results. The native tool may own generated originals outside the final
artifact folder; preserve that custody and copy selected outputs as directed.
A CLI startup failure or missing image route cannot prove rendering. Keep
foreground source-driven artifact proof, installed CLI routing and physical
printing separate. High-resolution intent alone grants no API fallback or
credential authority. Report any untested route and its exact prerequisite.
