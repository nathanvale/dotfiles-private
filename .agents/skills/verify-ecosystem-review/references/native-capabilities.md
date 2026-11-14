# Capture native capability proof

Use this with Doctor and the snapshot/partial journeys. Keep evidence scoped
to the Harness and session that received the tools. This is a read workflow;
no setup, sign-in, permission change, or new client is part of the check.

## Codex capability evidence

Ask the fresh session to discover its available Linear read route and supported
native browser. Capture actual discovery and read results in `events.jsonl`.
A configured plugin, successful install, or model-written tool list establishes
neither offered operations nor successful reads. Record an unexposed route as
unknown or unavailable in that session, with the supporting discovery result.
Keep startup failure diagnostics and the missing prerequisite.

Permit both routes in the live prompt. A connector-only prompt proves behavior
under that restriction, not absence of Chrome. If read-only discovery offers a
plugin install or connection rather than an operational read, stop that route
and record it; do not accept new access to manufacture coverage.

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
