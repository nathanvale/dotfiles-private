Reviewer: Code Reviewer, Codex. Native session: `01a0d63b-d8ac-7c13-b08b-71b3c4e5ef02`. Herdr Projects thread: `herdr-projects/t-0006`. Herdr pane: `w3:p190`.

Review date: 2026-09-25, Australia/Melbourne.

## Scope

Re-reviewed the full committed guide at `a83b11296ba5ecb1dcc1d6db7843cd9e86e80460` and its diff from `c022eb7b` using `git show` and `git diff`, ignoring working-tree bytes. Worktree: `/Users/nathanvale/code/dotfiles/.worktrees/hpr-f5n-6-sonnet-guide`. Guide: `config/agents/plugins/my-second-brain-playground/skills/stage-manager/guides/claude-code/claude-sonnet-5.md`.

Computed SHA-256: `947b044b042c51df888cc782a5a3ab6c1a5196b35fac127e0c493a47508d24d2`, matching the expected hash. The Stage Manager skill, accepted Opus guide and Claude Code self-evidence reference are byte-identical to the standards inspected in the preceding review.

## Prior findings

1. **Personal-account applicability: resolved.** Boundary now separates model-guide applicability from route qualification and account authentication. It applies model advice to the exact observed model/Harness regardless of account, prohibits transferring Monash qualification to personal routes, and explicitly rejects missing Foundry variables or a different billing label as sufficient personal-account evidence. Independent evidence or Nathan's confirmation is required for the separate route.

2. **Exclusive effort-control claim: resolved.** Effort is now described as the primary control. The revision includes the API's thinking-disable control and prompt steering, and separately cites Claude Code's prompt steering within effort. These corrections match the [Sonnet prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5) and [Claude Code model configuration](https://code.claude.com/docs/en/model-config#adaptive-reasoning-and-fixed-thinking-budgets). The obsolete claim that effort is the only control is gone.

## Fresh assessment

No new defects found. Required frontmatter, exact identity (`claude-sonnet-5`, `claude-code`), minimum version `2.1.197`, author identity, source-check date and Opus-style sections pass. Author session `5015e709-d483-44dc-ab53-780a6c89baa3` and pane `w3:p19W` differ from this reviewer's identities. A fresh read of that pane corroborated its native session and `monash-foundry` billing label.

Fetched all four cited vendor sources again:

- [Sonnet overview](https://platform.claude.com/docs/en/models/sonnet-5/overview): confirms model identity, availability and thinking defaults.
- [Models overview](https://platform.claude.com/docs/en/models/overview): confirms IDs and default effort.
- [Sonnet prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5): supports effort guidance, literal scope, upfront briefs, tool use, verbosity, progress updates and review coverage advice.
- [Model configuration](https://code.claude.com/docs/en/model-config): supports minimum version, provider-default aliases, effort controls and the newly added prompt-steering citation.

No invented vendor quotation or unsupported model-behavior claim remains identified. The local self-evidence reference explicitly labels `CLAUDE_EFFORT` as an observed convention rather than a vendor guarantee.

A fresh `monash models --json` read, without refresh, still returns the dated 2026-09-09 snapshot matching the guide's binding, resource/group, protocol, compatible Claude route and laptop qualification statement. This corroborates the historical snapshot, not present launch readiness. The author's historical process environment was not independently reread; its passage remains explicitly labelled as an observation. No credentials were inspected and no route was launched.

## Verdict

Accept the guide's exact reviewed bytes. This is guide acceptance only; it neither qualifies a personal route nor establishes a current serving account. No repository files, configuration, Beads state or adjacent review record were changed. The coordinator can use this handback to create the hash-bound review record under the Stage Manager contract.

GUIDE_VERDICT: accept guide_sha256=947b044b042c51df888cc782a5a3ab6c1a5196b35fac127e0c493a47508d24d2
