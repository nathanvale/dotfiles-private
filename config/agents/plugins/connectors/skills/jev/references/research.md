# JEV connector research

Assessed 1 November 2026. The implementation uses the TypeSafe OpenAPI 3.1
specification, API version 0.2.0. These are vendor facts, not evidence of
accuracy on a caller's data.

- [OpenAPI](https://api.typesafe.ai/openapi.json) defines Bearer authentication,
  GET `/v1/models`, POST `/v1/systemone`, named choice/noul questions and typed
  answers, probabilities, confidence and usage.
- [System One](https://docs.typesafe.ai/api/system-one.md) defines shared state
  for independently answered questions. [Model discovery](https://docs.typesafe.ai/api/list-models.md)
  returns names and aliases. This connector requires a versioned name.
- [Request rules and errors](https://docs.typesafe.ai/api/errors.md) define
  finite numbers, 64 nesting levels, the vendor body-size limit and HTTP
  errors. The connector's 256 KiB input bound is deliberately smaller.
- [Models](https://docs.typesafe.ai/models.md) defines context limits. Byte
  validation does not prove token admissibility. Long context requires an
  opt-in header that this connector does not send.
- [Choice](https://docs.typesafe.ai/primitives/choice.md) explains full
  distributions; a caller may pair choice with a companion noul. No
  application thresholds or effects belong in the generic connector.
- [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript.md) and
  [retry policy](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy.md)
  describe automatic retries. Direct fetch keeps this route's one-attempt
  behavior explicit without adding a dependency.

The vendor recommends retrying 429 and 529, but documentation here establishes
neither billing on errors nor a request-id lookup or idempotency key. The route
therefore never retries HTTP automatically. Any dispatched inference lacking a
validated complete reply and durable completion receipt remains unknown,
including HTTP rejections, timeouts, malformed replies and model mismatches.
A private digest ledger blocks repeats across processes and crashes. Completed
receipts retain token counts and request IDs, not state, questions or answers.
Receipt inspection cannot resolve the provider's unknown outcome.

The hosted origin is fixed in the packaged Provider. Credentials come from
existing 1Password custody below MCPorter. Ambient SDK environment settings
cannot redirect a credential or turn on body logging. Tests substitute the
endpoint leaf only in a verified private plugin copy under a loopback-only
sandbox. Fixture answers establish connector behavior, not hosted accuracy.


## Private input and qualification boundary

MCPorter 0.14.0's pinned `call --help` documents `key=@path` UTF-8 file input
and `--no-coerce`. Reuse this transport instead of adding a second HTTP or
credential client to calling skills. The public route continues to refuse
local file arguments. Only a dispatcher-owned route can admit the exact,
validated temporary file created under Connectors' private staging directory.

The public CLI accepts `--input-file <path>` and `--input-file -`. It bounds
reads to 256 KiB and stdin to five seconds, decodes strict UTF-8 and requires a
JSON object before capability selection. File reads share the existing
no-follow, owner-only regular-file admission. The Provider also caps response
bodies at 2 MiB and projects only validated answer fields.

Synthetic loopback tests cover file/stdin delivery, process arguments,
streams and state, refusal before custody, response projection, concurrent
claims and unknown-outcome replay blocking. NotebookLM remains a separate
adapter and its read-only restrictions remain unchanged. Real custody, hosted
model discovery, paid inference, provider billing and provider-side privacy
remain distinct, unproved claims. No fixture result proves any of them.

The caller owns redaction, source permissions, question packs, independent
support/contradiction questions, thresholds, application field mapping,
approvals and private answer caching. The connector returns typed answers,
distributions, usage and safe request IDs; it withholds raw HTTP error bodies.
Local payload-free logs do not prove processing-only provider retention or
no-training. Verify the applicable account and route terms in the consuming
workflow before submitting private data; record any exception decision there.
