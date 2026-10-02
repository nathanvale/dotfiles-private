---
reviewer_role: Code Reviewer
reviewer:
  harness: codex
  native_session: 01a0f743-fa25-7792-b673-98ed7f6f7327
  herdr_projects_thread: bestie-skill/t-0007
  herdr_pane: w2B:p8
date: 2026-10-01
reviewed_commit: ff6fd2de
---

# GPT-5.6 Terra guide review

Reviewed the committed guide bytes at `ff6fd2de` against the worktree bytes and the official pages fetched on 2026-10-01. Both copies have SHA-256 `2fd47bf3349084a2d84ae40d9ac318464e65c86a2924960a5184de69539c1f56`. The guide author has a different native session, thread and pane from this reviewer.

## Identity and boundary

- Lines 2-14: all required front matter is present, including exact model ID, Harness, minimum version, complete author identity, review date and sources.
- Lines 19-25 and 27-31: application requires the exact serving ID and observed Codex version. Other models, direct API use and other Harnesses are excluded. The minimum version is labeled a local observation, not an API promise.
- Lines 32-50: the quoted model description matches the [Terra model page](https://developers.openai.com/api/docs/models/gpt-5.6-terra). API features are explicitly unverified in Codex CLI. The [prompt engineering guide](https://developers.openai.com/api/docs/guides/prompt-engineering) supports snapshot pinning and evaluations. At lines 45-46, "The page" has an ambiguous referent; the cited Terra model page, not the prompt engineering page, lists the single undated snapshot. This is a wording finding, with no factual mismatch.

## Effort

- Lines 54-55: the marked quotation matches the Terra model page: `none`, `low`, `medium` (default), `high`, `xhigh`, `max`.
- Lines 56-66: `codex debug models` in CLI 0.159.3, both live and bundled, lists `low` through `max` plus `ultra`, with no `none`; its `ultra` description mentions automatic task delegation. The guide labels this undocumented local observation and labels its bounded-task preference extrapolated. It does not present `ultra` as API support.

## Worker guidance and handback

- Lines 70-79: cost and mini-tier positioning match the model page and the prompt engineering guide. The task-selection and briefing advice is labeled extrapolated.
- Lines 80-84 and 88-97: Bead, acceptance, exact cast ID, evidence and escalation instructions are identified as project practice or extrapolation. They align with the local Stage Manager skill and Codex self-evidence reference. No Codex serving or capability guarantee is asserted.
- Lines 35-37, 44-45, 54-55, 74-76 and 92-94: source wording used verbatim is marked as quotation. No U+2013 or U+2014 occurs in the guide.

## Profile check

Commit `8b55804c` appends only `[profiles.codex-terra]` and `[profiles.codex-sol61]` to `config/herdr-projects/config.toml`. Python `tomllib` parses the file. Terra's `model = "gpt-5.6-terra"` and `effort = "high"` are supported by the Terra model page.

The wording finding at lines 45-46 does not change the source-supported claim. No blocking finding.

GUIDE_VERDICT: accept guide_sha256=2fd47bf3349084a2d84ae40d9ac318464e65c86a2924960a5184de69539c1f56
