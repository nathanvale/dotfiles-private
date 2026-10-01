---
model: Claude Sonnet 5.5
model_id: claude-sonnet-5-5
harness: claude-code
harness_min_version: 2.1.284
author:
  role: Code Implementer
  native_session: 1bc0ebb5-c1aa-4d24-b0a2-c3ee4cf3cf1f
  herdr_projects_thread: bestie-skill/t-0012
  herdr_pane: w2B:pD
reviewed: 2026-10-02
sources:
  - https://platform.claude.com/docs/en/models/sonnet-5-5/overview
  - https://platform.claude.com/docs/en/models/overview
  - https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5
  - https://code.claude.com/docs/en/model-config
---

# Claude Sonnet 5.5 in Claude Code

Apply this guide only to a performer whose observed Harness is Claude Code at
`harness_min_version` or later and whose observed model ID is exactly
`claude-sonnet-5-5`. Each rule below restates a cited source unless it is
marked observed or extrapolated. The Anthropic pages are authoritative; re-read
them when this guide and they disagree.

## Boundary

- Covers: Claude Code sessions reporting model ID `claude-sonnet-5-5`. Claude
  Code requires v2.1.284 or later for this model (model-config, Model
  aliases). The Claude API, Google Cloud, Microsoft Foundry and Claude
  Platform on AWS all use that ID (Sonnet 5.5 overview, Model IDs).
- Excludes: the Bedrock ID `anthropic.claude-sonnet-5-5`, Claude Sonnet 5
  (`claude-sonnet-5`), Sonnet 5.5 outside Claude Code (direct API calls),
  Codex or any other Harness, and every other model. Each needs its own guide.
- The `sonnet` alias is not an identity. It resolves to Sonnet 5.5 on the
  Anthropic API from v2.1.284, to Sonnet 4.6 on Claude Platform on AWS, and to
  Sonnet 4.5 on Amazon Bedrock, Google Cloud's Agent Platform and Microsoft
  Foundry (model-config, Model aliases and Version history). Cast with the
  exact ID, in the local cast form (`SKILL.md`, Cast a worker):
  `--agent-arg --model --agent-arg claude-sonnet-5-5`.
- Content fallback changes the identity. Sonnet 5.5 runs safety classifiers.
  A cybersecurity-flagged request re-runs on Sonnet 5 with a notice in the
  transcript, and the session continues on the fallback model. A
  biology-flagged request ends with a refusal (model-config, Automatic model
  fallback). After that notice the serving model is `claude-sonnet-5`, so
  this guide stops applying (extrapolated from `SKILL.md` startup step 2).

## Effort

- Record only the effort observed in startup step 2, otherwise `unknown`.
  Documented defaults are not observations, and they differ: `medium` in
  Claude Code (model-config, Adjust effort level), `high` on the Claude API
  (Sonnet 5.5 overview).
- Levels are recalibrated from Sonnet 5; do not carry a Sonnet 5 setting over
  (prompting guide, Calibrate effort).
- Thinking cannot be turned off in Claude Code; the model decides per step how
  much to think from the effort level (model-config, Extended thinking).
  Asking the model to think less "doesn't reliably reduce its thinking", so
  lower effort instead (prompting guide, Calibrate effort).
- For agentic coding and multistep tool use, start at `medium` for
  well-specified tasks and `high` for harder or longer ones. Reserve `xhigh`
  and `max` for work with a measured quality gain (prompting guide, Calibrate
  effort).
- At `low` the model can skip verifying a change. At `low` and `medium`, on
  long agentic tasks, it is more likely to stop and check in before it
  finishes (prompting guide, Calibrate effort).
- Ask for results and evidence, not the worker's internal reasoning, which
  invites `reasoning_extraction` declines. A short explanation or a summary of
  actions is fine (prompting guide, Safeguard refusals).

## Frame a worker brief

The prompting guide gives these as system-prompt lines. Putting them in a
Herdr Projects brief is an adaptation (extrapolated).

- For an unattended worker at `low` or `medium`, include: "Keep working until
  everything the user asked for is done, and only stop to ask when you can't
  go on without the user or before a risky step." It does not replace rules
  about risky or irreversible actions, so keep the brief's stop boundary
  (prompting guide, Steer initiative and scope).
- The model adds tests, docs and small supporting files it was not asked for,
  at every effort level and more at higher effort. When the brief limits the
  files a worker may touch, include the paragraph that starts "When the work
  the user asked for is done and checked, stop and report." (prompting guide,
  Steer initiative and scope).
- At `xhigh` and `max` the model can start its own review rounds, sometimes
  with subagents. When an independent reviewer owns review, include the
  paragraph that starts "When the work the user asked for is done and its
  checks pass, stop and report." (prompting guide, Steer initiative and scope).
- For a research or planning Task, include: "When the user asks for ideas,
  options or a plan, give them that and stop. Don't start building or
  changing anything until they say to go ahead." (prompting guide, Steer
  initiative and scope).
- Name the exact checks a code Task must run. At `low` the model sometimes
  reports a change done without running one; the paragraph starting "When you
  change code that can be run, built, or type-checked, run a real check" makes
  that rare (prompting guide, Verification on coding tasks).

## Read a handback

- A check-in from a `low` or `medium` worker with acceptance items still open
  is not a handback (prompting guide, Steer initiative and scope). Compare its
  Bead comment with the Task's acceptance.
- A code change reported done without test or build output is incomplete.
  Request Repair naming the missing check (prompting guide, Verification on
  coding tasks).
- Compare the diff with the brief's file list. Unrequested tests or docs are
  documented behavior (prompting guide, Steer initiative and scope); keeping
  them is a scope decision, not a silent acceptance (extrapolated).
- A fallback notice in the transcript means later work came from Sonnet 5
  (see Boundary). Record it on the Bead.
- The model can read a genuine mid-task user message as possible prompt
  injection (prompting guide, Mid-turn user messages). If a worker treats a
  nudge that way, resend it after the turn ends (extrapolated).
- For open items with no stated blocker, send one short prompt naming them.
  Stop after two or three and surface the worker to Nathan. This adapts the
  source's limit on harness reminders (prompting guide, User-facing progress
  updates).
