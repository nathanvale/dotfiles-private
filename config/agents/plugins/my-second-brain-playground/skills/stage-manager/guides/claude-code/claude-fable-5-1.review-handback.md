# Independent Stage Manager guide re-review

Reviewer: Code Reviewer; harness `codex`; native session `01a0e45e-8c56-7023-95f3-655b3958568f` from `CODEX_SESSION_ID` and `CODEX_THREAD_ID`; Herdr Projects thread `design-system-feedback-uplift/t-0011`; pane `wA:pB` from `HERDR_PANE_ID`. The guide author records native session `199db31f-11e7-4871-a998-935d2dc43929`, thread `design-system-feedback-uplift/t-0012`, and pane `wE:p1`, so the identities are independent.

Reviewed commit `eab47b2c7d6ce5f246f2341264003f3d5742a507` and `git diff 0a705983..eab47b2c`. I computed SHA-256 from the guide file and independently from `git show eab47b2c:<guide path>`: both are `722220b9da3f533171e3f739863da4d75468da5ef4eab349f1bfc1f5482fa4f1`. This matches the supplied expected hash. Review date: 28 September 2026 (Australia/Melbourne).

## Ranked findings

No actionable guide findings remain. The three prior rejection findings are resolved:

1. **P1 authority boundary, resolved (lines 99 to 110).** The verbatim system-prompt paste is gone. The new worker-brief example names its Cast Role and stop boundary, leaves pushes, PRs and other external writes to the coordinator, and preserves Nathan's merge, release, deletion and spending approvals. It expressly labels the brief adaptation as extrapolated from the [Fable prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1) and the local `SKILL.md` Authority rule.
2. **P2 fallback overstatement, resolved (lines 151 to 164).** The guide now makes category fallback conditional on automatic switching, the allowed target and provider model identification. It describes pause or refusal without model change, as [model configuration](https://code.claude.com/docs/en/model-config#automatic-model-fallback) does. Its operational rule waits for an observed serving-model change before applying another guide. When automatic switching is off, the documented pause offers a manual choice; the guide's next sentence covers that branch.
3. **P2 source-status labels, resolved (lines 34 to 37, 46 to 48, 81 to 85, 136 to 150).** Route qualification, Herdr cast arguments, lookup-heavy Task selection and handback handling now identify the local Stage Manager rule or the extrapolation. The source behavior and local decision are separated.

## Whole-guide source audit

I fetched all four cited Anthropic pages afresh on 28 September 2026: [Fable 5.1 overview](https://platform.claude.com/docs/en/models/fable-5-1/overview), [models overview](https://platform.claude.com/docs/en/models/overview), [Fable 5.1 prompting](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1), and [Claude Code model configuration](https://code.claude.com/docs/en/model-config). I checked the whole guide, including unchanged rules, against startup step 4, the Review record, and the accepted Opus, Sonnet and Codex guide handbacks.

| Guide lines | Re-review result |
| --- | --- |
| 1 to 25 | Required model, exact ID, harness, minimum version, author identity, reviewed date and four sources are present. The local step 4 file and hash checks can bind these bytes. |
| 29 to 41 | `claude-fable-5-1`, Bedrock's distinct ID, Mythos separation and the v2.1.257 Claude Code floor match the model overview and model-config. Provider model IDs do not establish a qualified Monash account; the guide says so. |
| 42 to 58 | `fable` and `best` alias exceptions, explicit model selection, Fable credit consent and non-interactive billing match model-config. Herdr casting and API-harness exclusions are labelled local or extrapolated. |
| 62 to 88 | Effort levels, high default, adaptive always-on mode, per-model calibration, high-effort latency, low-effort retrieval and prompt steering match the cited pages. `CLAUDE_EFFORT` is sourced to the local observed harness reference, and unknown effort remains unknown. The Task choice is labelled extrapolated. |
| 92 to 110 | Outcome framing and verification tendency match model-config. Required acceptance evidence and the repaired unattended-worker brief are labelled local adaptations. |
| 111 to 132 | Scope restraint, targeted edits, prose density, quotation marking and safeguard phrasing match the prompting guide; the brief adaptation for quotations is labelled extrapolated. |
| 136 to 150 | Premature stopping, sparse final summaries and extra-change risk match the prompting guide. Report checks, Repair disposition and quiet-pane interpretation are labelled Stage Manager handling or extrapolation. |
| 151 to 168 | Conditional classifier fallback, provider identity requirements, credit-prompt behavior and consent handling match model-config. The Herdr-pane response and guide-switch rule are labelled local. |

Acceptance here concerns the exact guide bytes. It does not prove a live Fable route, account, billing identity, current serving model or a startup receipt. I changed no guide, review record, repository, credential, pane or remote state. The Stage Manager or implementer can copy this Handback beside the guide, hash those copied bytes and write the separate review record under `SKILL.md`.

GUIDE_VERDICT: accept guide_sha256=722220b9da3f533171e3f739863da4d75468da5ef4eab349f1bfc1f5482fa4f1
