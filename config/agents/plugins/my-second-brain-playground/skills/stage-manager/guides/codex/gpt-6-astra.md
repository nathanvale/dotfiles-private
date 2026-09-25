---
model: GPT-6 Astra
model_id: gpt-6-astra
harness: codex
harness_min_version: 0.156.1
author:
  role: Code Implementer
  native_session: 01a0d65c-ba94-7703-b6bc-f4f6d4472c53
  herdr_projects_thread: herdr-projects/t-0007
  herdr_pane: w3:p1AB
reviewed: 2026-09-25
sources:
  - https://developers.openai.com/api/docs/guides/prompt-engineering
  - https://developers.openai.com/api/docs/guides/latest-model
---

# GPT-6 Astra in Codex CLI

Apply this guide only when Stage Manager startup observes Codex CLI version
`0.156.1` or later and the exact current model ID `gpt-6-astra`. This version
floor is the locally observed CLI, not an OpenAI compatibility guarantee.
Use [Codex self-evidence](../../references/harnesses/codex.md) to separate
observations from claims. An unreviewed guide still refuses startup step 4.

## Boundary and sources

- The [GPT-6 model guide](https://developers.openai.com/api/docs/guides/latest-model)
  identifies Astra as the highest-capability GPT-6 API model. Its prompt
  examples describe Astra's greater tendency to stop for clarifications,
  sensitivity to instructions in files, detailed answers, lower delegation,
  and broad testing. These are API guidance and observed model-family prompts,
  not verified native Codex CLI behavior.
- That guide says Astra does not support `none` API reasoning effort. It does
  not document Codex CLI's effort setting or what this session currently uses.
  The [prompt engineering guide](https://developers.openai.com/api/docs/guides/prompt-engineering)
  recommends evaluating prompts and pinning API snapshots; this CLI ID is not
  documented there as an immutable snapshot.
- The sources do not establish Astra's Codex CLI quota, account, current
  serving model, default effort, or tool availability. Treat these as
  **unverified**. API-only advice about `reasoning.effort`, Responses tools,
  async calls and role parameters may not map to native Codex CLI.

## Coordinate and brief an Astra worker

- Consider Astra for a bounded Task with high ambiguity or several interacting
  steps when its route qualifies. The API capability description motivates
  this choice; verify Task fit in the actual Handback.
- Give the worker the goal, Bead, owner paths, acceptance, authority, report
  location, and stop boundary. State which routine choices it may make and
  which material choice returns to the Stage Manager. This adapts the API
  guide's initiative guidance to a project brief; it is unverified in CLI.
- Keep instructions in accessible files current and scoped. State the wanted
  output length and verification boundary. These adapt the API guide's
  Astra-specific file sensitivity, writing and testing advice; verify their
  effect with a Codex CLI canary before treating them as model behavior here.
- Pass the exact model ID at launch. Verify the worker's own launch and
  serving evidence; an argv request alone does not prove current service.
  Keep effort `unknown` unless the worker can observe it. Compare the
  Handback with acceptance and request focused repair for any gap.
