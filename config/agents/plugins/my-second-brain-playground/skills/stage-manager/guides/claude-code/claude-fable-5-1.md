---
model: Claude Fable 5.1
model_id: claude-fable-5-1
harness: claude-code
harness_min_version: 2.1.257
author:
  role: Code Implementer
  native_session: 199db31f-11e7-4871-a998-935d2dc43929
  herdr_projects_thread: design-system-feedback-uplift/t-0012
  herdr_pane: wE:p1
reviewed: 2026-09-28
sources:
  - https://platform.claude.com/docs/en/models/fable-5-1/overview
  - https://platform.claude.com/docs/en/models/overview
  - https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1
  - https://code.claude.com/docs/en/model-config
---

# Claude Fable 5.1 in Claude Code

Apply this guide only to a performer whose observed Harness is Claude Code at
`harness_min_version` or later and whose observed model ID is exactly
`claude-fable-5-1`. Each rule below restates a cited source unless it is marked
observed or extrapolated; the Anthropic pages stay authoritative, so re-read
them when this guide and they disagree.

## Boundary

- Covers: Claude Code sessions reporting model ID `claude-fable-5-1`. Claude
  Code requires v2.1.257 or later for this model (model-config, Work with
  Fable). The Claude API, Google Cloud, Microsoft Foundry and Claude Platform
  on AWS all use that same ID (Fable 5.1 overview, Model IDs), so the advice
  applies wherever the exact ID is observed.
- Route qualification is a separate claim. No source says whether a given
  account, such as the Monash Foundry route, serves Fable 5.1 to Claude Code.
  Local Stage Manager rule, extrapolated rather than cited: treat each route
  as unqualified until its own evidence or Nathan confirms it.
- Excludes: the Bedrock ID `anthropic.claude-fable-5-1`, Claude Fable 5
  (`claude-fable-5`), Claude Mythos 5.1 (same capabilities, separate
  invitation-only model), Fable 5.1 outside Claude Code (direct API calls),
  Codex or any other Harness, and every other model. Each needs its own guide.
- The `fable` and `best` aliases are not identities. `fable` resolves to Fable
  5.1 unless `ANTHROPIC_DEFAULT_FABLE_MODEL` is set, but to Fable 5 in Claude
  apps gateway sessions and on every provider before v2.1.257. `best` follows
  `fable` where Fable is available, otherwise `opus` (model-config, Model
  aliases). Cast with the exact ID, in the local Stage Manager cast form
  (`SKILL.md`, Cast a worker; not from the cited pages):
  `--agent-arg --model --agent-arg claude-fable-5-1`.
- Cost: Fable is never the account-type default (model-config, Work with
  Fable), and on some plans its usage bills to usage credits. Interactive
  sessions ask for consent first, except under Enterprise organization
  billing; `-p` runs bill without asking (model-config, Fable and usage
  credits). Casting a
  Fable worker can therefore be spending; follow the skill's Authority rule.
- The prompting guide's API-harness sections (tool-call batching,
  append-only history, compaction summaries, subagent tools, vision crop
  tools) configure the Harness, not a brief. Claude Code owns them, so this
  guide leaves them out (extrapolated).

## Effort

- Record only the effort observed in startup step 2, for example
  `CLAUDE_EFFORT` (`references/harnesses/claude-code.md`). A documented
  default is not an observation; with no observed value, record `unknown`.
- Levels are `low`, `medium`, `high`, `xhigh` and `max`. The default is `high`
  on the Claude API (models overview) and in Claude Code, but a top-level
  `effortLevel` in user settings still applies to Fable 5.1 (model-config,
  Adjust effort level). Observe rather than assume the default.
- Thinking is adaptive and always on. Claude Code cannot turn it off for Fable
  models; `MAX_THINKING_TOKENS=0` and `alwaysThinkingEnabled` have no effect
  (Fable 5.1 overview; model-config, Extended thinking). Effort is the primary
  control (prompting guide, Consider all effort levels).
- Level names do not mean the same thinking across models, so never carry a
  level over from another model's worker (prompting guide, Consider all effort
  levels; model-config, Choose an effort level).
- Start at `high`. Move to `xhigh` or `max` only where a quality gain was
  measured: at those levels the model can draft a long deliverable in its
  thinking and then write it again, which costs time and tokens (prompting
  guide, Leave room for long outputs at xhigh and max effort). `max` "is prone
  to overthinking" (model-config, Choose an effort level).
- At `low`, the model calls search and retrieval tools less often and answers
  from memory more (prompting guide, Search triggering at low effort). The
  source's fixes are raising effort for the affected turns or adding a search
  nudge. Keeping lookup-heavy Tasks, such as source audits, off `low` is
  extrapolated from that behavior.
- To shift how often it thinks within a level, say so in the brief; "the
  model responds to that guidance within its effort setting" (model-config,
  Adaptive reasoning and fixed thinking budgets).

## Frame a worker brief

- Describe the outcome, not the steps, and hand it ambiguous or oversized
  work: root-cause investigations and Tasks you would normally split
  (model-config, Work with Fable).
- Skip reminders to test or check; "it verifies its own work with less
  prompting" (model-config, Work with Fable). Keep required evidence in the
  acceptance and Handback lists, which state what the report must contain
  rather than remind (extrapolated).
- Tell the worker it runs unattended and must finish the work its brief
  already authorizes. Without that, the model can end its turn describing the
  next step ("Next, I'll …") or asking permission already granted ("Shall I
  apply this?") (prompting guide, Finish the whole task). Write a short brief
  line rather than pasting the source's system-prompt block, whose stop rule
  covers only destructive actions and scope changes. For example: "Nobody is
  watching this pane in real time. As the <Cast Role> this brief names,
  finish every step it authorizes without asking. Stop at its stop boundary.
  Leave pushes, PRs and other external writes to the coordinator. Never
  merge, release, delete or spend without Nathan's named approval; report
  what needs it instead." This line is extrapolated from the prompting guide
  plus the local Stage Manager contract (`SKILL.md`, Authority).
- For Code Implementer briefs, bound extras explicitly. The model can fix
  nearby code, extend unmentioned behavior or commit more test files than the
  change warrants, and responds well to instructions about what to leave out.
  Paste the instruction from the section "Keep changes and tests to what the
  task asks for" (prompting guide).
- When small edits matter, add: "The number of tokens used to edit files is
  best minimized, all else being equal. Therefore, when it will not affect the
  end result, try to surgically edit a file rather than rewrite the entire
  thing." (prompting guide, Prefer targeted edits over whole-file rewrites).
- For reports Nathan reads, add "Please remove all mannered prose." to the
  brief. Fable 5.1 prose can run dense, with longer sentences and fewer
  paragraph breaks, and the source prefers the fix in a user message
  (prompting guide, Writing density).
- For research or guide-writing Tasks, ask the worker to mark every verbatim
  passage as a quotation. The model is more likely than Fable 5 to reproduce
  source text unmarked (prompting guide, Quoting retrieved sources). The
  source's fix is a worked example in the system prompt; a brief line is
  extrapolated.
- Phrase checks as "Are there any bugs in this program?", not "Does this
  program compile without errors?", and give context for lesser-known
  languages. Both reduce safety-classifier false positives (prompting guide,
  Reduce safeguard false positives).

## Read a handback

- A turn that ends on a stated next step or a permission question for work
  the brief already covered can mean the model stopped early (prompting
  guide, Finish the whole task). Extrapolated handling: read it as
  unfinished, not as a report or a decision for Nathan, and reply naming that
  step unless it crosses the stop boundary.
- The final message can cover only the last step rather than the whole Task
  (prompting guide, Ask for user-facing progress updates). Extrapolated
  handling: check the report file against every acceptance item. A pane quiet
  for minutes during a long tool chain is expected at higher effort, not a
  stall by itself (extrapolated from an API-level source).
- The model can add unrequested fixes, extensions and extra test files
  (prompting guide, Keep changes and tests to what the task asks for).
  Extrapolated handling under the local Stage Manager Handback rule
  (`SKILL.md`, Handback): check the diff for them and treat them as a Repair
  request or a follow-up, not as accepted scope.
- Watch for a model switch. A safety-classifier flag may re-run the request
  on Opus 5 (biology) or Opus 4.8 (cybersecurity), or on the deployment's
  target on Bedrock, Agent Platform and Foundry; Claude Code then shows a
  notice in the transcript and the session stays on that model. It switches
  only when automatic switching is on, `availableModels` allows the target,
  and on those three providers Claude Code can identify both models.
  Otherwise the session pauses for a choice, or the request ends in a refusal
  and the model is unchanged (model-config, Automatic model fallback).
  Dismissing a mid-session usage-credit prompt continues the turn on the
  default model (model-config, Fable and usage credits).
- Apply another guide only after observing an actual serving-model change,
  as startup step 2 observes it; a flag or refusal alone changes nothing.
  Then record the identity change with the Handback (local Stage Manager
  rule).
- A worker pane stopped on a usage-credit consent prompt is waiting on a
  spending decision. Surface it to Nathan rather than answering it
  (model-config, Fable and usage credits; the Herdr pane case is
  extrapolated).
