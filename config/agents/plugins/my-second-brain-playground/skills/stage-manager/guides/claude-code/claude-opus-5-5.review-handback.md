# Independent Code Reviewer re-review

Commit: `5d92e4d07b216a6442309d3ff245080939f72e99`; compared with `d2ebf15f`. Committed bytes only. Applied the same writing-for-agents review criteria and accepted brief.

Reviewer: Code Reviewer, Codex. Native session `01a0d5dd-896a-77c3-a071-1f4aaaa1ca2f`, observed in both `CODEX_SESSION_ID` and `CODEX_THREAD_ID`. Herdr Projects thread `herdr-projects/t-0004` (brief); pane `w3:p19D` (observed `HERDR_PANE_ID`). Observed `CODEX_VERSION=0.156.1`. Independent of the guide's recorded author.

**Standards: pass with findings. Spec: fail. Guide: accept.**

Paths below are relative to `config/agents/plugins/my-second-brain-playground/skills/stage-manager/`.

## Previous findings

- **P1 Codex portability: partly resolved.** `SKILL.md:49`, `SKILL.md:92`, and `references/harnesses/codex.md:3` separate Harness discovery from model-guide lookup and distinguish unavailable identity from a missing guide. However, Codex self-evidence and guides remain explicitly unqualified and deferred to hpr-f5n.7. Even with an exact launch ID, no qualified version observation supports the minimum-version check at `SKILL.md:70`. This session exposes a version, but the new reference expressly leaves it unqualified; exact model and effort remain unproven through its admitted self-evidence. Qualify those observations and the refusal paths before declaring the brief's Codex requirement complete.

- **P2 independence: resolved.** `SKILL.md:119` and `SKILL.md:127` now require reviewer identity, a retrievable Handback with its hash, an acceptance line bound to the guide hash, and author/reviewer separation by native session and thread or pane. The guide records comparable author identity at `guides/claude-code/claude-opus-5-5.md:6`.

- **P2 pasted text: resolved.** `guides/claude-code/claude-opus-5-5.md:60` preserves Nathan's explicit authorization and identifies the brief adaptation versus the vendor's system-prompt setup.

## New defect

- **P1 launch identity can be stale.** `SKILL.md:52` admits argv model selection as identity without requiring current-model corroboration or resolving conflicting observations. Launching Opus 5.5 and later switching models, including documented automatic fallback, leaves the original argv available. Startup after compaction can therefore select the old guide. [Claude Code documents persistent fallback](https://code.claude.com/docs/en/model-config#automatic-model-fallback). Keep launch selection distinct from the currently serving model; require current evidence and refuse unresolved contradictions.

## Guide acceptance

Re-fetched all four cited URLs. The [overview](https://platform.claude.com/docs/en/models/opus-5-5/overview), [model table](https://platform.claude.com/docs/en/about-claude/models/overview), [configuration](https://code.claude.com/docs/en/model-config), and [prompting guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5) support its identity, Harness boundary, effort and handback guidance. Adaptations are sufficiently distinguished; the prior pasted-text defect is repaired. Acceptance covers these guide bytes, not the role's observation procedure or runtime qualification. Independently computed SHA-256 using committed bytes; expected hash matches.

GUIDE_VERDICT: accept guide_sha256=db4edad95d8f58e1bb6404f156bc50852bbcdcdfe78d996dd5258846a23dd644
