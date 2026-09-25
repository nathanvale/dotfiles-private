---
model: Claude Sonnet 5
model_id: claude-sonnet-5
harness: claude-code
harness_min_version: 2.1.197
author:
  role: Code Implementer
  native_session: 5015e709-d483-44dc-ab53-780a6c89baa3
  herdr_pane: w3:p19W
reviewed: 2026-09-25
sources:
  - https://platform.claude.com/docs/en/models/sonnet-5/overview
  - https://platform.claude.com/docs/en/models/overview
  - https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5
  - https://code.claude.com/docs/en/model-config
---

# Claude Sonnet 5 in Claude Code

Apply this guide only to a performer whose observed Harness is Claude Code at
`harness_min_version` or later and whose observed model ID is exactly
`claude-sonnet-5`. Each rule below restates a cited source unless it is marked
observed or extrapolated; the Anthropic pages stay authoritative, so re-read
them when this guide and they disagree.

## Boundary

- Covers: Claude Code sessions reporting model ID `claude-sonnet-5`, on the
  Anthropic API, a Claude subscription, or a qualified Microsoft Foundry
  deployment. Claude Code requires v2.1.197 or later for this model
  (model-config).
- The Monash Foundry route: a session on this route carries
  `CLAUDE_CODE_USE_FOUNDRY=1` and
  `ANTHROPIC_FOUNDRY_RESOURCE=monash-edu-smst-ai-claude-code` in its own
  environment (observed, this session; host `laptop`), and `herdr pane get`
  reports `billing_identity: monash-foundry`. Confirm the route is qualified
  with `monash models --json` — snapshot only, do not pass `--refresh` for
  this check — before applying this guide there: as of its
  `observed_at: 2026-09-09`, `claude-sonnet-5` binds to that same resource
  (Azure resource group `monash-edu-smst-smstai-degreeworks-scribe`) with
  `protocol: azure-anthropic-messages`, and the `claude`-agent route is
  `compatibility: compatible`, `status: qualified`: "Native inference and
  harmless file-read tool passed on laptop, 2026-09-09; other hosts require
  their own qualification."
- Excludes a personal Claude account: a personal-account session authenticates
  without the `ANTHROPIC_FOUNDRY_*` variables above and reports a different
  `billing_identity` (not `monash-foundry`), even when its Harness, model ID
  and observed effort match exactly. Treat it as a separate, unqualified route
  under this snapshot — recheck `monash models --json` (still snapshot only)
  or ask Nathan before carrying the "qualified" claim above over to it.
- Excludes: provider-prefixed IDs such as Bedrock `anthropic.claude-sonnet-5`,
  Sonnet 5 outside Claude Code (direct API calls), Codex or any other Harness,
  and every other model, including Claude Sonnet 4.6. Each needs its own
  guide.
- The `sonnet` alias is not an identity. It resolves to Sonnet 5 on the
  Anthropic API, to Sonnet 4.6 on Claude Platform on AWS, and to Sonnet 4.5 on
  Amazon Bedrock, Google Cloud's Agent Platform, and Microsoft Foundry — the
  Monash Foundry route included (model-config). Cast with the exact ID:
  `--agent-arg --model --agent-arg claude-sonnet-5`.

## Effort

- Record only the effort observed in startup step 2, for example
  `CLAUDE_EFFORT` (`references/harnesses/claude-code.md`). A documented
  default is not an observation; with no observed value, record `unknown`.
- Effort defaults to `high` on the Claude API and Claude Code (sonnet-5
  overview; models overview). Adaptive thinking is on by default and is
  steered by effort (sonnet-5 overview). `xhigh` is Anthropic's recommended
  setting "for the hardest coding and agentic use cases"; at `low` and
  `medium` the model "scopes its work to what was asked rather than going
  above and beyond," which risks under-thinking on moderately complex `low`
  effort tasks (prompting guide, Calibrating effort and thinking depth).
- Manual extended thinking (`thinking: {type: "enabled", budget_tokens: N}`)
  is not supported on Sonnet 5 and returns a 400 error; effort is the only
  depth control (prompting guide, Calibrating effort and thinking depth).
  This is an API-level detail, extrapolated to Claude Code, where effort is
  set at launch (`--effort`) or with `/effort`, not a per-request `thinking`
  field.
- Unlike the Opus 5.5 guide's "leave it out" rule, Sonnet 5's own guidance
  keeps "think carefully" lines as a fallback, not a first move: "If you
  observe shallow reasoning on complex problems, raise effort to `high` or
  `xhigh` rather than prompting around it. If you need to keep effort at
  `low` for latency, add targeted guidance" naming the task as multistep
  reasoning (prompting guide, Calibrating effort and thinking depth). Raise
  effort first; use the prompt line only when effort must stay `low`.

## Frame a worker brief

- Sonnet 5 "interprets prompts literally and explicitly, particularly at
  lower effort levels. It does not silently generalize an instruction from
  one item to another, and it does not infer requests you didn't make." State
  the brief's scope explicitly — name every file, module, or Task part a rule
  covers — rather than relying on the model to generalize from one example
  (prompting guide, More literal instruction following).
- Specify the goal, intent, and constraints fully in the brief's first turn:
  well-specified, accurate task descriptions upfront help autonomy and token
  efficiency, while instructions delivered progressively over several turns
  reduce both (prompting guide, Interactive coding products). A Herdr
  Projects brief, written once for an agent that has not seen the
  conversation, already fits this pattern.
- Sonnet 5 "is more agentic than Claude Sonnet 4.6 by default and will reach
  for tools and run self-verification loops more readily," and `high` or
  `xhigh` effort "show substantially more tool usage in agentic search and
  coding" (prompting guide, Tool use triggering). For the hardest coding and
  agentic Tasks, `xhigh` is the recommended effort (prompting guide,
  Calibrating effort and thinking depth).
- Response length calibrates to task complexity by default, "usually meaning
  shorter answers on simple lookups and longer ones on open-ended analysis."
  Add an explicit line such as "Provide concise, focused responses. Skip
  non-essential context, and keep examples minimal." only if a worker's
  replies run longer than the brief needs (prompting guide, Response length
  and verbosity).

## Read a handback

- Sonnet 5 "provides regular, higher-quality updates to the user throughout
  long agentic traces." Scaffolding built to force interim status messages
  for an earlier model ("After every 3 tool calls, summarize progress") is
  likely no longer needed; if the update format or frequency does not fit,
  describe what the updates should look like explicitly (prompting guide,
  User-facing progress updates). Unverified: whether Claude Code's own
  transcript renders these updates the same way the cited API-level behavior
  does.
- If the brief asked for a bounded review ("only report high-severity
  issues," "be conservative," "don't nitpick"), read a short findings list
  with care: Sonnet 5 "may follow that instruction more faithfully than
  earlier models did... and then not report findings it judges to be below
  your stated bar," so "measured recall can fall even though the model's
  underlying bug-finding ability has improved." When thoroughness matters
  more than a short list, ask instead for full coverage with a confidence and
  severity label per finding, and filter afterward (prompting guide, Code
  review harnesses).
