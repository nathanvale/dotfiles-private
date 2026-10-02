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

# GPT-6.1 Sol guide review

Reviewed the committed guide bytes at `ff6fd2de` against the worktree bytes and the official pages fetched on 2026-10-01. Both copies have SHA-256 `243dc52e3db91897854cd373e0892c9a97c0e43f7b4eefc8a9bed077e7a29608`. The guide author has a different native session, thread and pane from this reviewer.

## Identity and boundary

- Lines 2-16: all required front matter is present, including exact model ID, Harness, minimum version, complete author identity, review date and sources.
- Lines 20-26 and 28-35: application requires the exact serving ID and observed Codex version. Other Sol IDs, direct API use and other Harnesses are excluded. The [GPT-6 guide](https://developers.openai.com/api/docs/guides/latest-model) does advise `gpt-6-sol` users to review migration guidance before switching. The minimum version is labeled a local observation.
- Lines 36-50: the marked quotation and snapshot statement match the [Sol 6.1 model page](https://developers.openai.com/api/docs/models/gpt-6.1-sol). The [prompt engineering guide](https://developers.openai.com/api/docs/guides/prompt-engineering) supports snapshot pinning and evaluations. API features are explicitly unverified in Codex CLI.

## Effort

- Lines 54-57: the marked quotation matches the Sol 6.1 model page and GPT-6 guide: `low`, `medium` (default), `high`, `xhigh`, `max`; neither `none` nor `minimal` is supported.
- Lines 58-68: `codex debug models` in CLI 0.159.3, both live and bundled, lists those five values plus `ultra` and has a catalog default of `low`. Its `ultra` description mentions automatic task delegation. The guide labels this undocumented local observation, distinguishes the API default, and labels its bounded-task preference extrapolated. It does not present `ultra` as API support.

## Worker guidance and handback

- Lines 72-80: the model page supports the comparison with Astra. The GPT-6 guide says its prompting advice reflects Astra observations and should be evaluated on the selected model. The Sol 6.1 application is explicitly unverified.
- Lines 81-90 and 94-104: file sensitivity and clarification are attributed to Astra and marked extrapolated or unverified for Sol 6.1. Bead, cast, acceptance and Handback instructions are identified as project practice and align with the local Stage Manager skill and Codex self-evidence reference. No Sol 6.1 Codex serving or capability guarantee is asserted.
- Lines 34-35, 39-41, 46, 54-56, 62, 76-77, 82-83 and 102-104: source wording used verbatim is marked as quotation. No U+2013 or U+2014 occurs in the guide.

## Profile check

Commit `8b55804c` appends only `[profiles.codex-terra]` and `[profiles.codex-sol61]` to `config/herdr-projects/config.toml`. Python `tomllib` parses the file. Sol 6.1's `model = "gpt-6.1-sol"` and `effort = "high"` are supported by the Sol 6.1 model page.

No actionable finding.

GUIDE_VERDICT: accept guide_sha256=243dc52e3db91897854cd373e0892c9a97c0e43f7b4eefc8a9bed077e7a29608
