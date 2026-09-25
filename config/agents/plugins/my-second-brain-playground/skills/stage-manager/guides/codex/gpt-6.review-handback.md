Reviewer: Codex independent reviewer; native session 01a0d63b-d8ac-7c13-b08b-71b3c4e5ef02; thread herdr-projects/t-0006; pane w3:p190. Launch request gpt-6-astra; exact current serving model and effort unknown.

# Codex guides review

Reviewed committed bytes at 529f076793f13d430bd412b85bc38f56e95268c9 and diff 2f72661b..529f0767. Standards: Stage Manager SKILL.md and Opus guide at the reviewed commit; accepted Sonnet format at a83b11296ba5ecb1dcc1d6db7843cd9e86e80460 (Sonnet is absent from the reviewed tree). Repository files were not changed.

## Identity and format

All three guides have the correct exact model_id, harness `codex`, minimum version `0.156.1`, review date, sources, applicability boundary, briefing guidance, effort treatment and handback guidance. The version floor is explicitly a local observation, not a vendor compatibility guarantee. Their structure preserves the accepted guides' substance without requiring identical headings.

Each author is Code Implementer, native session `01a0d65c-ba94-7703-b6bc-f4f6d4472c53`, thread `herdr-projects/t-0007`, pane `w3:p1AB`. All three identity coordinates differ from mine. Acceptance here binds to the committed-byte hashes below.

## Source checks

Fetched both unique cited URLs on 2026-09-25, including the harness reference's citations.

- [Prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering), Prompt engineering and Message roles sections: supports evaluation suites, snapshot pinning, and API instruction/role guidance. It does not establish immutable CLI aliases or CLI self-observation contracts.
- [Latest model](https://developers.openai.com/api/docs/guides/latest-model), model selection, reasoning and prompting sections: supports Luna's repeatable-work positioning, Sol's demanding-reasoning positioning and Astra's highest-capability positioning. It supports Astra's clarification, file sensitivity, verbosity, delegation and testing tendencies and its lack of `none` API effort. The page frames the prompting guidance around observations with Astra and calls for evaluation on the selected model.

The guides distinguish source claims from project practice and tentative application. API-only controls are explicitly labelled as potentially not mapping to native Codex CLI. No invented claim or unlabelled, unsupported per-model CLI claim found. Live documentation supports the claims as fetched; this is not a historical snapshot of the pages.

## Findings per file

- `guides/codex/gpt-6-luna.md`: no actionable findings. Boundary marks Luna-specific CLI prompting, tools, delegation, effort and account claims unverified. Bounded-task selection is a cautious adaptation, not a measured CLI performance claim. Accept.
- `guides/codex/gpt-6-sol.md`: no actionable findings. Capability positioning is supported; implementation/review selection remains tentative. Defaults, tools, quotas and serving identity are not inferred from API documentation. Accept.
- `guides/codex/gpt-6-astra.md`: no actionable findings. Boundary distinguishes API tendencies from native CLI behavior; briefing adaptations require verification, and API effort support is not presented as observed CLI effort. Accept.
- `references/harnesses/codex.md`: no actionable findings. Lines 3-17 distinguish undocumented observations from session claims. Lines 19-28 require process corroboration and preserve startup refusal when serving identity or review evidence is missing. Accept within these stated limits.

## Independent harness evidence

These were all CODEX_* variables exposed in my tool environment:

```text
CODEX_CI=1
CODEX_SESSION_ID=01a0d63b-d8ac-7c13-b08b-71b3c4e5ef02
CODEX_THREAD_ID=01a0d63b-d8ac-7c13-b08b-71b3c4e5ef02
CODEX_VERSION=0.156.1
```

The parent-chain inspection found PID 81628, parent 79883, command `codex --model gpt-6-astra`. Independently, `herdr pane process-info --pane w3:p190` returned foreground PID 81628 with argv `["codex", "--model", "gpt-6-astra"]` and this thread's cwd. `codex --version` returned `codex-cli 0.156.1`.

This corroborates the reference's observable mechanism and version in a separate session. It does not independently reproduce the author's historical Sol launch. My context identifies generic GPT-6 without an exact serving variant or effort, so both remain unknown. Guide acceptance does not qualify this session to pass Stage Manager startup step 2, nor grant a coordinator role.

Final guide verdicts below are ordered Luna, Sol, Astra.

GUIDE_VERDICT: accept guide_sha256=3de5033d9276fc402416d8c2fe3c556a258f992ee7881029baa48be7c9783c72
GUIDE_VERDICT: accept guide_sha256=aad2ee0e33d6c933a08c1e9d053100261a34eac9d1e2bdac6f17bdb50c4b9edc
GUIDE_VERDICT: accept guide_sha256=b1bbe36c008936ef90c3a1874d5073647100482d950ae9a5555761a6d38350ef
