---
model: GPT-5.6 Terra
model_id: gpt-5.6-terra
harness: codex
harness_min_version: 0.159.3
author:
  role: Code Implementer
  native_session: 5797aeeb-aadf-43e9-bf35-f2254861e70a
  herdr_projects_thread: bestie-skill/t-0005
  herdr_pane: w2B:p6
reviewed: 2026-10-01
sources:
  - https://developers.openai.com/api/docs/models/gpt-5.6-terra
  - https://developers.openai.com/api/docs/guides/prompt-engineering
---

# GPT-5.6 Terra in Codex CLI

Apply this guide only when Stage Manager startup observes Codex CLI version
`0.159.3` or later and the exact current model ID `gpt-5.6-terra`. This
version floor is the locally observed CLI, not an OpenAI compatibility
guarantee. Use [Codex self-evidence](../../references/harnesses/codex.md) to
separate observations from claims. Each rule below restates a cited source
unless it is marked observed or extrapolated. An unreviewed guide still
refuses startup step 4.

## Boundary

- Covers: Codex CLI sessions whose serving model is exactly `gpt-5.6-terra`.
- Excludes: `gpt-5.6-sol`, `gpt-5.6-luna`, every GPT-6 model, Terra through
  the API directly, and every other Harness. Each needs its own guide.
- The [Terra model page](https://developers.openai.com/api/docs/models/gpt-5.6-terra)
  describes an **API** model. Quoted:

  > GPT-5.6 Terra is designed for workloads that balance intelligence and
  > cost. It roughly corresponds to the mini model tier used in earlier GPT-5
  > families.

  It gives no Codex CLI benchmark, quota, account or serving guarantee.
- Terra is a GPT-5.6 model. The GPT-6 prompting guide's best practices
  address GPT-6 Astra; do not apply them to Terra as source-backed advice.
- The [prompt engineering guide](https://developers.openai.com/api/docs/guides/prompt-engineering)
  recommends pinning snapshots and building evaluation suites, because
  "different snapshots of models within the same family could produce
  different results". The page lists `gpt-5.6-terra` as both the default
  snapshot and its only snapshot; it is not a dated snapshot. Recheck this
  guide after a model or Harness update.
- API-only features on the model page (Responses tools, Batch, Chat
  Completions, pricing and rate limits) may not map to native Codex CLI.
  Treat them as **unverified** for this route.

## Effort

- The model page, quoted: "Reasoning.effort supports: none, low, medium
  (default), high, xhigh, and max." That is the API contract.
- **Observed, undocumented:** on 2026-10-01 the Codex CLI 0.159.3 model
  catalog (`codex debug models`, live and `--bundled`) listed `low`,
  `medium`, `high`, `xhigh`, `max` and `ultra` for `gpt-5.6-terra`, with no
  `none`. It described `ultra` as "Maximum reasoning with automatic task
  delegation". The catalog is not an OpenAI contract and can change with a
  release.
- Record only the effort observed in startup step 2. A documented or catalog
  default is not an observation; with no observed value, record `unknown`.
- Prefer `high` or lower for a bounded single-agent Task. `ultra` enables
  delegation in the catalog's own description, which widens a bounded
  Task's footprint. Extrapolated from the catalog text above.

## Coordinate and brief a Terra worker

- Consider Terra for a bounded Task where cost matters and the expected
  output is explicit, such as a classifier evaluation run against fixed
  cases. Extrapolated from the model page's cost and intelligence balance;
  prove fit against the actual Task, not the page.
- The prompt engineering guide says small (mini) models "are generally
  faster and cheaper to use", while large models "are more effective at
  understanding prompts and solving problems across domains". Give a Terra
  worker explicit inputs, the expected output shape and the completion check
  rather than a high-level goal alone. Extrapolated from that tier
  description and the page's "mini model tier" statement.
- State the Bead ID and store, worker role, exact files or owner,
  acceptance, smallest covering check, report location and stop boundary.
  This is project practice, not a vendor claim about Terra.
- Pass the exact model ID at launch. Verify the worker's own launch and
  serving evidence; an argv request alone does not prove current service.

## Read a handback

- Require the Handback to distinguish implemented, checked and unknown
  items. Compare it with acceptance and route a material finding to review
  or repair through the Bead owner. Project practice.
- For an evaluation Task, require results per case against the fixed
  expected output, not a summary verdict alone. The prompt engineering guide
  recommends evaluation suites that "measure prompt behavior"; this applies
  it to worker output. Extrapolated.
- Escalate ambiguous architecture, privacy or cross-owner decisions to the
  Stage Manager; the sources do not establish how Terra handles them in
  Codex CLI.
