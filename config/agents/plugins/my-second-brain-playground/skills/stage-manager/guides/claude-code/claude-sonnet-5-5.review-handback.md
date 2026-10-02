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

## Re-review, 2026-10-02

Reviewed the entire guide at commit `ea81ee7e51e21e684e101c1a64bfe436dd6593e9` against the four cited official pages. The committed bytes and worktree bytes both hash to `6ef49dd63c969a55c32afd1d2a986fb6c2854a489e13a485987d70030adc4838`. The reviewer session and pane remain those in the front matter.

### Front matter and boundary

- Lines 2 to 16 and 29 to 41: Pass. The required fields, v2.1.284 minimum, provider IDs, alias boundary and exact-ID cast form remain supported. The omitted route-qualification bullet still does not claim a qualified serving route.
- Lines 42 to 51: The previous unconditional fallback claim is repaired by the allowlist, switch-setting and provider conditions in [model configuration](https://code.claude.com/docs/en/model-config#automatic-model-fallback). **Finding:** The content-fallback rule no longer carries the `extrapolated` marking required by this review's acceptance brief. Mark the identity application as extrapolated from `SKILL.md` startup step 2.

### Effort and worker brief

- Lines 55 to 69: Pass. Claude Code's documented `medium` effort default remains distinct from the Claude API's `high` default and from observed effort. The advice follows the [prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5#calibrate-effort).
- Lines 73 to 94: Pass. Brief instructions are marked as adaptations of system-prompt guidance, and verbatim passages are quoted.

### Read a handback

- Lines 98 to 105: The earlier local-adaptation and verification findings are repaired. The local rule is labelled, and the check list now includes a type-checker, build, tests, the changed command, or an explained inability to run one.
- Lines 109 to 113: The distinction between one-turn availability fallback and persistent content fallback repairs the old generic-notice claim. **Finding:** The statement that only an observed serving-model change changes the applied guide omits the unknown state. `SKILL.md` lines 116 to 121 require casting to be refused when serving evidence is missing after a fallback notice; `references/harnesses/claude-code.md` lines 12 to 18 say the prior identity statement may be stale. Require fresh exact serving evidence after the notice and leave the guide unapplied if it is unavailable or conflicting.
- Lines 106 to 108 and 114 to 119: No further finding. The source-based claims and local extrapolations remain distinguished.

The full guide has no U+2013 or U+2014. These two findings prevent acceptance of the new bytes. This verdict does not qualify a serving route, invocation, or `.review.md` record.

GUIDE_VERDICT: reject guide_sha256=6ef49dd63c969a55c32afd1d2a986fb6c2854a489e13a485987d70030adc4838 reason=missing fallback marking and unknown-state rule

## Re-review, round 3, 2026-10-02

Reviewed the complete guide at commit `15b8c67696a2bb0f473cb6958c1b00963431b9c4` against the same four official sources. The committed bytes and worktree bytes both hash to `255b0c7d163cb581fb1f116881a98a27315d27841a77745c6f8ef794b3371e19`. The reviewer session and pane remain those in the front matter.

### Prior findings

- Lines 41 to 50: Resolved. The guide now marks its content-fallback identity application as extrapolated from `SKILL.md` startup step 2. The fallback conditions agree with [Claude Code model configuration](https://code.claude.com/docs/en/model-config#automatic-model-fallback).
- Lines 106 to 113: Resolved. A notice requires fresh exact serving evidence. Unknown or conflicting evidence leaves this guide unapplied and refuses casting, as `SKILL.md` requires. The guide distinguishes one-turn availability fallback from persistent content fallback.

### Complete guide check

- Lines 2 to 16 and 21 to 40: Required front matter, independent author identity, exact model and Harness boundary, v2.1.284 minimum, provider IDs, alias distinctions and exact-ID cast form pass against the [Sonnet 5.5 overview](https://platform.claude.com/docs/en/models/sonnet-5-5/overview), [models overview](https://platform.claude.com/docs/en/models/overview) and [model configuration](https://code.claude.com/docs/en/model-config#model-aliases). The omitted route-qualification bullet is not a defect because the guide claims no qualified serving route.
- Lines 54 to 68: The documented `medium` Claude Code default and `high` Claude API default remain separate from observed effort. The remaining effort advice matches the [Sonnet 5.5 prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5#calibrate-effort). No Opus-only rule was carried over.
- Lines 72 to 92: The brief rules are marked as adaptations of system-prompt guidance. Verbatim passages are quoted and match the prompting source.
- Lines 96 to 119: Local Handback rules are labelled or cite `SKILL.md`; the real-check list matches the prompting source; fallback, mid-task message and reminder guidance retain their source or extrapolation labels. No further finding.

The guide has no U+2013 or U+2014. Acceptance covers this guide hash only. It does not establish a current serving route, invocation, installed plugin or `.review.md` record.

GUIDE_VERDICT: accept guide_sha256=255b0c7d163cb581fb1f116881a98a27315d27841a77745c6f8ef794b3371e19
