---
model: GPT-6 Sol
model_id: gpt-6-sol
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

# GPT-6 Sol in Codex CLI

Apply this guide only when Stage Manager startup observes Codex CLI version
`0.156.1` or later and the exact current model ID `gpt-6-sol`. This version
floor is the locally observed CLI, not an OpenAI compatibility guarantee.
Use [Codex self-evidence](../../references/harnesses/codex.md) to separate
observations from claims. An unreviewed guide still refuses startup step 4.

## Boundary and sources

- The [GPT-6 model guide](https://developers.openai.com/api/docs/guides/latest-model)
  positions Sol for strong reasoning on demanding tasks, in the context of
  **Responses API** model selection. It gives no Codex CLI benchmark or
  guarantee for a particular engineering Task.
- The [prompt engineering guide](https://developers.openai.com/api/docs/guides/prompt-engineering)
  recommends evaluating prompts and pinning API snapshots because behavior can
  vary across model types and snapshots. These exact Codex CLI model IDs are
  not documented there as immutable snapshots. Recheck this guide after a
  model or Harness update.
- The sources do not state Sol-specific Codex CLI prompting, tool,
  delegation, effort-default, quota, or account behavior. Treat each as
  **unverified** until independently observed for this route. API-only advice
  about `reasoning.effort`, Responses tools, async calls and role parameters
  may not map to native Codex CLI.

## Coordinate and brief a Sol worker

- Consider Sol for a demanding bounded implementation or review when the
  route card qualifies it. This is a cautious application of the API model
  guide's positioning, not evidence that Sol is the best Codex CLI route.
- State the Bead ID and store, worker role, exact files or owner, acceptance,
  smallest covering check, report location, and stop boundary. Give the
  worker enough source context to resolve the Task without widening its scope.
  This is project practice, not a vendor claim about Sol.
- Pass the exact model ID at launch. Verify the worker's own launch and
  serving evidence; an argv request alone does not prove current service.
  Keep effort `unknown` unless the worker can observe it.
- Require the Handback to distinguish implemented, checked, and unknown
  items. Compare it with acceptance and route a material finding to review or
  repair through the Bead owner.
