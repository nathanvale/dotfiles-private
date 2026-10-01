---
reviewer_role: Code Reviewer
reviewer:
  harness: codex
  native_session: 01a0f95b-e99c-73c1-8b13-e9d1caa324c4
  herdr_projects_thread: bestie-skill/t-0013
  herdr_pane: w2B:pE
date: 2026-10-02
reviewed_commit: 6726a188
---

# Independent Claude Sonnet 5.5 guide review

Reviewed the guide at commit `6726a188` against all four cited official pages. The committed bytes and worktree bytes both hash to `c3e8e714178738f41441d98bf1f12bfe91683666c0fe69e0ad8d818f758bdf1e`. The worktree was clean before this handback.

## Front matter and boundary

- Lines 2 to 16: Required identity, minimum version, author, date and sources are present. [Claude Code model configuration](https://code.claude.com/docs/en/model-config#model-aliases) supports v2.1.284. The exact-ID cast form at line 41 follows `SKILL.md`.
- Lines 29 to 41: The exact-model and Harness boundary, provider ID table and alias distinctions match the cited [Sonnet overview](https://platform.claude.com/docs/en/models/sonnet-5-5/overview) and [model configuration](https://code.claude.com/docs/en/model-config#model-aliases). The omitted route-qualification bullet is not a defect by itself: this guide claims no authenticated or qualified serving route. Its observed identity check remains necessary.
- **Finding, lines 42 to 47:** The cyber fallback is stated as unconditional, and line 47 names Sonnet 5 as the serving model after any such notice. [Model configuration](https://code.claude.com/docs/en/model-config#automatic-model-fallback) says automatic switching can be disabled, an allowlist can block the target, non-interactive runs can refuse, and third-party deployments need resolvable targets. A configured Sonnet target there can differ from Sonnet 5. Qualify the conditions and identify the actual target from the notice before applying another guide.

## Effort

- Lines 51 to 70: No finding. The guide keeps Claude Code's documented `medium` default distinct from the Claude API's `high` default and from observed effort. The [prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5#calibrate-effort) supports the remaining effort advice.

## Frame a worker brief

- Lines 74 to 98: No finding. The guide identifies the move from the source's system-prompt examples to a Herdr brief as an adaptation. The quoted passages are marked, and the source supports the behavior and verification advice.

## Read a handback

- **Finding, lines 102 to 104:** Treating an unfinished check-in as something other than a Handback and comparing its Bead comment with Task acceptance are local workflow rules, not claims made by the cited prompting page. Mark this rule as an adaptation or cite the local owner.
- **Finding, lines 105 to 107:** The rule calls a code change incomplete whenever it lacks test or build output. The cited [verification guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5#verification-on-coding-tasks) also accepts a type-checker or the changed command itself, and allows an explicit explanation when no real check can run. Check for that broader evidence before requesting Repair.
- **Finding, lines 111 to 112:** A generic fallback notice does not prove that later work came from Sonnet 5. [Availability fallback chains](https://code.claude.com/docs/en/model-config#fallback-model-chains) can choose configured targets and last only for the current turn; [content fallback](https://code.claude.com/docs/en/model-config#automatic-model-fallback) has different persistence. Read the notice and current serving identity.
- Lines 108 to 110 and 113 to 119: No further finding. The scope decision and message-resend advice are marked as extrapolations or adaptations.

## Verdict

The guide has no U+2013 or U+2014. The four findings above prevent acceptance of these exact bytes. This review does not assess route readiness, invocation behavior or a `.review.md` record.

GUIDE_VERDICT: reject guide_sha256=c3e8e714178738f41441d98bf1f12bfe91683666c0fe69e0ad8d818f758bdf1e reason=unqualified fallback and verification rules
