---
model: Claude Opus 5.5
model_id: claude-opus-5-5
harness: claude-code
harness_min_version: 2.1.280
author: herdr-projects-s2-worker
reviewed: 2026-09-25
sources:
  - https://platform.claude.com/docs/en/models/opus-5-5/overview
  - https://platform.claude.com/docs/en/about-claude/models/overview
  - https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5
  - https://code.claude.com/docs/en/model-config
---

# Claude Opus 5.5 in Claude Code

Apply this guide only to a performer whose observed Harness is Claude Code at
`harness_min_version` or later and whose observed model ID is exactly
`claude-opus-5-5`. Each rule below restates a cited source unless it is marked
observed or extrapolated; the Anthropic pages stay authoritative, so re-read
them when this guide and they disagree.

## Boundary

- Covers: Claude Code sessions reporting model ID `claude-opus-5-5`, on the
  Anthropic API or a Claude subscription. Claude Code requires v2.1.280 or
  later for this model (model-config).
- Excludes: provider-prefixed IDs such as Bedrock `anthropic.claude-opus-5-5`,
  Opus 5.5 outside Claude Code (direct API calls), Codex or any other Harness,
  and every other model, including Claude Opus 5. Each needs its own guide.
- The `opus` alias is not an identity. It resolves to Opus 5.5 on the
  Anthropic API but to Opus 4.6 on Microsoft Foundry (model-config). Cast with
  the exact ID: `--agent-arg --model --agent-arg claude-opus-5-5`.

## Observe identity

Read these yourself. Each is Claude Code behavior observed on 2026-09-25 in
v2.1.282, not a documented contract, so mark a missing value `unknown`.

- Model: the system context's statement of the exact model ID, such as "The
  exact model ID is claude-opus-5-5".
- Harness: `CLAUDECODE=1` and `CLAUDE_CODE_ENTRYPOINT` in your environment.
- Version: the version segment of `CLAUDE_CODE_EXECPATH`, such as
  `.../claude/versions/2.1.282`. `claude --version` reports the binary on
  `PATH`, which can differ from the running session after an update.
- Effort: `CLAUDE_EFFORT` when set.
- Human-supplied: `/status` and a configured status line show the model
  (model-config). You cannot run them yourself; use them only when Nathan
  reports what they show.

## Effort

- Record only the effort you observe, such as `CLAUDE_EFFORT`. A documented
  default is not an observation; with no observed value, record `unknown`.
- Thinking is always on and cannot be disabled (model overview). Effort is the
  control: lower effort before writing "be brief" or "think less" prompts
  (prompting guide, Calibrate effort).
- Leave "think carefully" and "don't think" lines out of briefs. The model
  sets its own thinking depth. This extrapolates to worker briefs from a
  source written for chat system prompts (prompting guide, Thinking
  instructions in chat system prompts).
- Ask for results and evidence, never for the worker's internal reasoning in
  the reply. Such requests can be declined under the `reasoning_extraction`
  category (prompting guide, Safeguard refusals).

## Frame a worker brief

- State the completion condition and the stop boundary up front, and keep the
  Task's parts in a checklist the worker updates (prompting guide, Unattended
  agentic runs). In Herdr Projects that is the brief's acceptance list, the
  Bead comment and `report`.
- Mark text Nathan pasted from elsewhere with a matching random ID on both
  tags, `<pasted_content id="…">` … `</pasted_content id="…">`, so the worker
  follows only instructions Nathan wrote (prompting guide, Mark pasted text).
- When a Task has a known duration, give an elapsed-time budget; the model
  paces to it and usually finishes early. The budget is advisory, so keep
  your own timeout (prompting guide, Time signals).

## Read a handback

- Treat a worker turn that ends in text as a report, not completion (prompting
  guide, Unattended agentic runs). Compare its Bead comment with the Task's
  acceptance.
- A worker with a background command or subagent still running is not done.
- For open items with no stated blocker, send one short prompt naming them.
  Stop after two or three such nudges and surface the worker to Nathan.
