---
model: Claude Haiku 4.5
model_id: claude-haiku-4-5-20251001
harness: claude-code
harness_min_version: 2.0.17
author:
  role: Code Implementer
  native_session: 0179f7b8-1a0d-4148-9264-429d162d0b96
  herdr_projects_thread: herdr-projects/t-0021
  herdr_pane: w1R:p1
reviewed: 2026-09-30
sources:
  - https://platform.claude.com/docs/en/models/haiku-4-5/overview
  - https://platform.claude.com/docs/en/models/haiku-4-5/migration-guide
  - https://platform.claude.com/docs/en/about-claude/models/choosing-a-model
  - https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
  - https://code.claude.com/docs/en/best-practices
  - https://code.claude.com/docs/en/model-config
  - https://code.claude.com/docs/en/changelog
---

# Claude Haiku 4.5 in Claude Code

Apply this guide only to a performer whose observed Harness is Claude Code at
`harness_min_version` or later and whose observed model ID is exactly
`claude-haiku-4-5-20251001`. Each rule below restates a cited source unless it
is marked observed, extrapolated or a local Stage Manager rule. The Anthropic
pages stay authoritative, so re-read them when this guide and they disagree.

Sources fall into three kinds; keep them apart when applying a rule:

- **API guidance:** the Claude Platform pages (model overview, migration
  guide, choosing a model, prompting guide). They describe the model and the
  Messages API, not Claude Code.
- **Claude Code behavior:** model-config, best practices and the changelog.
- **Local practice:** `SKILL.md` and Herdr Projects conventions.

## Boundary

- Covers: Claude Code sessions reporting model ID
  `claude-haiku-4-5-20251001`, the Claude API ID (Haiku 4.5 overview, Model
  IDs). model-config does not specify a minimum Claude Code version for this
  model. `harness_min_version` records v2.0.17, chosen because that changelog
  release "Added Haiku 4.5 to model selector" (changelog, 2.0.17). Whether
  v2.0.17 accepts the exact ID `claude-haiku-4-5-20251001` is unobserved; the
  changelog entry names the selector, not that ID.
- Excludes every other spelling of the same model, because startup step 3
  matches IDs character for character (local Stage Manager rule): the alias
  `claude-haiku-4-5`, which the Claude API resolves to this snapshot and
  Microsoft Foundry and Claude Platform on AWS use as their ID; Bedrock
  `anthropic.claude-haiku-4-5` and `anthropic.claude-haiku-4-5-20251001-v1:0`;
  and Google Cloud `claude-haiku-4-5@20251001` (Haiku 4.5 overview, Model IDs).
  A session reporting one of those needs its own guide. So do Haiku 4.5 outside
  Claude Code, Codex or any other Harness, and every other model.
- Route qualification is a separate claim. No source says which account
  serves this exact ID to Claude Code. Treat each route as unqualified until
  its own evidence or Nathan confirms it (local Stage Manager rule).
- The `haiku` alias is not an identity. model-config describes it only as
  "the fast and efficient Haiku model for simple tasks", and
  `ANTHROPIC_DEFAULT_HAIKU_MODEL` changes what it resolves to (model-config,
  Model aliases; Environment variables). Cast with the exact ID, in the local
  cast form (`SKILL.md`, Cast a worker):
  `--agent-arg --model --agent-arg claude-haiku-4-5-20251001`.
- Plan mode can change the serving model. By default a Haiku session "would
  normally upgrade to Sonnet in plan mode" (model-config, `opusplan` model
  setting; changelog, 2.0.17). model-config documents exceptions. On the
  Anthropic API and Claude Platform on AWS, when `availableModels` excludes
  the newest Sonnet, the session uses the newest permitted Sonnet and "stays
  on Haiku only when every Sonnet is excluded". On Amazon Bedrock, Google
  Cloud's Agent Platform, Microsoft Foundry and Mantle, "plan mode stays on
  the session's model whenever the upgrade model is excluded" (model-config,
  `opusplan` model setting). So a plan-mode turn may
  be served by Sonnet or by Haiku. Attribute a plan to a model only after
  observing its serving model, as startup step 2 observes it (local Stage
  Manager rule). Local rule, extrapolated: keep Haiku workers out of plan
  mode.
- Limits that shape a brief: 200K token context window, 64K max output,
  reliable knowledge cutoff February 2025 (Haiku 4.5 overview, Capabilities).

## Effort and thinking

- Haiku 4.5 has no effort parameter. The overview lists default effort as "Not
  supported", and model-config's effort table omits it: "Models not listed
  here do not support effort" (model-config, Adjust effort level).
- Claude Code's effort controls are the `CLAUDE_CODE_EFFORT_LEVEL`
  environment variable, the `--effort` launch flag, `/effort`, and the
  `modelSettings` or `effortLevel` settings (model-config, Adjust effort
  level; Set the effort level). A value set through one of them is a launch
  or session setting, not evidence that Haiku uses it. Extrapolated: record an
  observed value in the startup receipt as a launch fact, not as a depth
  control, and leave `--effort` out of a Haiku cast.
- Thinking is manual extended thinking with a token budget, not adaptive
  thinking (Haiku 4.5 overview, Good to know). The migration guide suggests
  enabling it "for significant performance improvements on coding and
  reasoning tasks" (API guidance).
- In Claude Code the controls are the session toggle (`Option+T` on macOS),
  `alwaysThinkingEnabled` in `/config`, and `MAX_THINKING_TOKENS`, whose
  non-zero values apply only to models with a fixed thinking budget
  (model-config, Extended thinking; Adaptive reasoning and fixed thinking
  budgets). The Claude Code pages do not say whether thinking starts on for
  Haiku, so record the thinking state as observed or `unknown`.
- Effort-level advice and adaptive-thinking prompt steering in sibling guides
  do not transfer. Keep "think carefully" lines out of briefs as a depth
  lever; turn thinking on or cast a larger model instead (extrapolated).

## Frame a worker brief

- Use the general prompting techniques. The prompting guide covers Haiku 4.5
  but gives it no model-specific page, and it asks that a technique measured
  on a named model be re-checked before applying it to another (prompting
  guide, Model-specific guidance; General principles).
- Cast Haiku for bounded, checkable Tasks. Anthropic positions it for the
  lowest latency and price, "sub-agent tasks" and "High-volume,
  straightforward tasks", and suggests upgrading "only if necessary for
  specific capability gaps" (choosing a model). Extrapolated: route
  open-ended design, ambiguous investigation and high-consequence judgement
  to a larger model.
- Be explicit and give the reason beside any constraint whose purpose is not
  obvious. Use numbered steps where order or completeness matters (prompting
  guide, Be clear and direct; Add context to improve performance).
- Say whether the worker edits or only proposes. "Can you suggest some
  changes" can yield suggestions rather than edits; "Change this function"
  yields changes (prompting guide, Tool usage). This is general Claude
  behavior, not a Haiku trait.
- Scope the Task in Claude Code terms: name the files, the scenario and the
  source that answers each question, and point to an existing pattern to
  follow (Claude Code best practices, Provide specific context in your
  prompts). Give the worker a check it can run and ask it to "show evidence
  rather than asserting success" (best practices, Give Claude a way to verify
  its work). In Herdr Projects the acceptance list and Handback carry this.
- Bound reading to the 200K window. Claude Code performance "degrades as
  context fills", and an unscoped "investigate" can read "hundreds of files"
  (best practices, intro; Avoid common failure patterns). Extrapolated: split
  a Task that needs broad codebase reading before casting Haiku.
- Tell the worker its context compacts. Haiku 4.5 tracks its remaining token
  budget, and in a Harness that compacts, "Claude may sometimes naturally try
  to wrap up work as it approaches the context limit" unless the prompt says
  so (prompting guide, Context awareness and multiwindow workflows). A short
  brief line adapts the source's system-prompt sample (extrapolated): "Your
  context compacts automatically. Save progress in your report before it
  fills, and do not stop early for budget."
- Ask for current sources over recall. The reliable knowledge cutoff is
  February 2025 (overview). Extrapolated: tell the worker to read installed
  `--help`, repository files and live documentation for any tool, API or
  version fact.
- Treat examples and XML tags as tools, not requirements. The prompting guide
  calls examples "one of the most reliable ways to steer" format and suggests
  3 to 5 "for best results"; XML tags help "especially when your prompt mixes
  instructions, context, examples, and variable inputs" (prompting guide, Use
  examples effectively; Structure prompts with XML tags). Add one worked
  example where an output shape matters, such as the Bead comment. Keep the
  brief in Markdown and reserve XML for machine-parsed boundaries (local
  practice, `docs/agents/instruction-maintenance.md`).

## Read a handback

- Check each claim against evidence in the report: commands run, their
  output, test results. Plausible work that skips edge cases is a named
  Claude Code failure pattern (best practices, Avoid common failure
  patterns). Compare the Bead comment with every acceptance item (local
  Stage Manager rule, `SKILL.md` Handback).
- A worker that stops near its context limit may be wrapping up for budget,
  not finishing (prompting guide, Context awareness). Extrapolated: read that
  report as unfinished and cast a fresh thread from its saved state.
- After two failed Repair prompts on the same point, stop correcting. The
  source's fix is a fresh session with "a better initial prompt
  incorporating what you learned" (best practices, Avoid common failure
  patterns). In Herdr Projects that is a new brief (local practice).
- Watch for a serving-model change. Plan mode can serve turns on Sonnet or
  stay on Haiku (see Boundary). A configured fallback chain can serve a turn
  on another model and "the switch lasts for the current turn only", with a
  notice (model-config, Fallback model chains). Apply another guide only
  after observing the change as startup step 2 observes it, then record it
  with the Handback (local Stage Manager rule).
