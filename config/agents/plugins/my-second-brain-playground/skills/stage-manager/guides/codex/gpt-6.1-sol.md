---
model: GPT-6.1 Sol
model_id: gpt-6.1-sol
harness: codex
harness_min_version: 0.159.3
author:
  role: Code Implementer
  native_session: 5797aeeb-aadf-43e9-bf35-f2254861e70a
  herdr_projects_thread: bestie-skill/t-0005
  herdr_pane: w2B:p6
reviewed: 2026-10-01
sources:
  - https://developers.openai.com/api/docs/models/gpt-6.1-sol
  - https://developers.openai.com/api/docs/guides/latest-model
  - https://developers.openai.com/api/docs/guides/prompt-engineering
---

# GPT-6.1 Sol in Codex CLI

Apply this guide only when Stage Manager startup observes Codex CLI version
`0.159.3` or later and the exact current model ID `gpt-6.1-sol`. This
version floor is the locally observed CLI, not an OpenAI compatibility
guarantee. Use [Codex self-evidence](../../references/harnesses/codex.md) to
separate observations from claims. Each rule below restates a cited source
unless it is marked observed or extrapolated. An unreviewed guide still
refuses startup step 4.

## Boundary

- Covers: Codex CLI sessions whose serving model is exactly `gpt-6.1-sol`.
- Excludes: `gpt-6-sol` (its own guide), `gpt-5.6-sol`, Sol 6.1 through the
  API directly, and every other Harness. The `gpt-6-sol` guide does not
  apply to this model: the [GPT-6 model guide](https://developers.openai.com/api/docs/guides/latest-model)
  asks `gpt-6-sol` users to "review the migration guidance before switching
  to GPT-6.1 Sol", so the two differ.
- The [Sol 6.1 model page](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
  describes an **API** model. Quoted:

  > GPT-6.1 Sol delivers near-Astra performance at a lower cost for complex
  > coding, computer use, and professional work. Compare it with Astra on
  > your tasks to assess the tradeoff between quality and cost.

  It gives no Codex CLI benchmark, quota, account or serving guarantee.
- The [prompt engineering guide](https://developers.openai.com/api/docs/guides/prompt-engineering)
  recommends pinning snapshots and building evaluation suites. The model
  page says "Use `gpt-6.1-sol` to select this model" and lists no dated
  snapshot. Recheck this guide after a model or Harness update.
- API-only advice (Responses tool calling, async tool calls,
  `configuration_update`, Fast mode, data residency) may not map to native
  Codex CLI. Treat it as **unverified** for this route.

## Effort

- The model page, quoted: "`reasoning.effort` supports `low`, `medium`
  (default), `high`, `xhigh`, and `max`. The `none` and `minimal` reasoning
  efforts are not supported." The GPT-6 model guide states the same. That is
  the API contract.
- **Observed, undocumented:** on 2026-10-01 the Codex CLI 0.159.3 model
  catalog (`codex debug models`, live and `--bundled`) listed `low`,
  `medium`, `high`, `xhigh`, `max` and `ultra` for `gpt-6.1-sol`, with
  catalog default `low`, which differs from the API default `medium`. It
  described `ultra` as "Maximum reasoning with automatic task delegation".
  The catalog is not an OpenAI contract and can change with a release.
- Record only the effort observed in startup step 2. Neither the API
  default nor the catalog default is an observation; with no observed
  value, record `unknown`.
- Prefer `high` or lower for a bounded single-agent Task. `ultra` enables
  delegation in the catalog's own description. Extrapolated.

## Coordinate and brief a Sol 6.1 worker

- Consider Sol 6.1 for complex coding or review when its route qualifies,
  and compare it with an Astra or current route on the same Task before
  making it a default. This restates the model page's comparison advice;
  it is not evidence that Sol 6.1 is the best Codex CLI route.
- The GPT-6 guide's prompting best practices "address behavior observed
  with GPT-6 Astra; evaluate them with your chosen model and workload."
  Treat its initiative, file-sensitivity, writing and testing advice as a
  starting point for Sol 6.1, **unverified** until a Codex CLI canary on
  this model confirms it.
- Keep instructions in accessible files current and scoped. The GPT-6
  guide reports Astra "can be more sensitive to instructions contained in
  skills and other files, such as `AGENTS.md`". Extrapolated to Sol 6.1.
- State the Bead ID and store, worker role, exact files or owner,
  acceptance, smallest covering check, report location and stop boundary.
  Name which routine choices the worker may make and which return to the
  Stage Manager. Project practice, shaped by the GPT-6 guide's initiative
  advice; unverified for this model in Codex CLI.
- Pass the exact model ID at launch. Verify the worker's own launch and
  serving evidence; an argv request alone does not prove current service.

## Read a handback

- Require the Handback to distinguish implemented, checked and unknown
  items. Compare it with acceptance and route a material finding to review
  or repair through the Bead owner. Project practice.
- For an evaluation Task, require results per case against fixed expected
  output, so a later comparison with Astra or Luna uses the same cases.
  Extrapolated from the model page's comparison advice and the prompt
  engineering guide's evaluation-suite recommendation.
- A worker that stopped to ask a question has handed back a report, not a
  result. Answer it or narrow the Task. The GPT-6 guide says Astra is "more
  likely to ask for clarification where earlier models would make
  assumptions"; whether Sol 6.1 shares this is unverified.
