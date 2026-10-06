---
status: proposed
---

# Add the complete Notion MCP route

## Context and Problem

Nathan requested a new Notion connector in Connectors, including editing,
the complete MCP tool set, and meeting transcripts. The supplied laptop
handoff demonstrated hosted Notion through MCPorter; its credentials, corporate
IDs, and project workflows belong to their original machine and private owners.
Live schema discovery on 6 October 2026 advertised 45 tools through the new
account route, including `notion-restore-pages`. Tool availability remains
workspace- and permission-dependent.

## Decision Drivers

- Expose the complete observed tool set without a read-only reduction.
- Preserve native MCPorter transport, account isolation, and attended login.
- Keep writes previewed, one-use, journaled, and recoverable without replay.
- Retrieve raw transcripts and preserve their distinction from AI summaries.
- Keep credentials and employer configuration outside personal source.

## Considered Options

- Directly use the home MCPorter Notion registration.
- Add an account-scoped adapter and a complete qualified catalogue.
- Add a read-only Notion connector first.

## Decision

The candidate adds `skills/notion` behind the existing Front Door, following
Canva's account-isolated native OAuth route and Figma's explicit verification
approach for opaque writes. It admits the 45 exact live-discovered tool names,
classifies 26 reads and 19 writes, and declares `imports: []`. Registry identity,
endpoint, OAuth client, and the exact catalogue are checked before transport.

Notion's evolving write schemas make service-specific field translation costly.
The candidate forwards actual MCP arguments and requires `_verify` beside a
write: one before read, one after read, and literal `contains` and/or `absent`
criteria, with at least one nonempty value. The adapter removes this declaration before sending. Verification calls must be catalogue
reads. Preview requires `contains` values to be absent before and `absent`
values to be present before. It also reads a fixed after target, refusing a
desired state already present there. Preview binds the exact input and every
declared baseline digest, and expires after 15 minutes. Apply rechecks those
baselines,
consumes the preview once, records durable intent, then sends at most once.
The after read must contain every `contains` value and omit every `absent`
value. A caller chooses evidence for
the intended object and every member of a batch; an unrelated read is not valid
workflow evidence, even if it contains the same words.

After arguments can reference returned IDs with whole-value `$reply.path`
strings. Notion JSON text and structured results are decoded without executing
provider instructions. Async task handles are retained; one status read runs,
and pending work remains unknown until adjudication observes the requested
read-back. Explicit terminal tool rejection or a failed task can settle
`unchanged` only when all declared target baselines match and the desired
criteria remain unsatisfied. Lost replies and transport failures retain an
unknown outcome even if current targets match, because work may still finish.
Terminal unchanged settlement returns `failed-after-record` and permits later
writes without replaying the rejected request. Receipt corruption fails closed.
One account-wide
write lock serializes mutations and unresolved receipts block that account.
Read-back tools in persisted receipts are validated as reads during recovery.
Private receipts store digests, IDs and resolved read arguments, which may
include private queries; they omit mutation inputs and raw provider replies.
Stable Notion entity URLs, including session/thread/agent and document/data
source/view schemes plus admitted `notion.so` HTTPS entity URLs, can bind
read-back arguments. Signed upload/download URLs and credential/header/token
values refuse before those values enter persisted read arguments.

A terminal tool rejection requires positive evidence: exit 1 with the decoded
observed hosted Notion `status:400`, `code:validation_error`, nonempty message
shape. Generic MCP `isError:true` results, other nonzero JSON replies, and
transport diagnostics remain indeterminate. Thus a nonzero exit alone cannot
authorize unchanged settlement. Real asynchronous task and handle shapes remain
unqualified.

For `notion-create-file-upload`, `notion-create-attachment`, and
`notion-upload-skill` with `action:prepare`, a controlled
`_verify:{before:{tool,args},reply:"prepared-handle"}` declaration verifies
handle creation from the reply. Validated preparation receipts complete so a
follow-on attachment or final upload is not blocked. This outcome covers only
handle preparation; final mutations still require ordinary read-back. Signed
upload URLs, headers, and tokens are returned privately and not journaled.

Schema uses the selected native MCPorter with the same account vault and a
private temporary copy of the fully validated registry. Only its fixed `list`
command omits `allowedTools`, because MCPorter filters discovery by that list.
The copy retains disabled imports, the fixed endpoint and client identity, and
is removed after listing. Calls retain the shipped exact-name allow-list. The
result compares live tool names and top-level required keys with the frozen
catalogue and reports missing, extra, and changed rows. This comparison does
not inspect plan or permission access; `notion-get-tool-access` owns that read.
Schema execution reports observed account directory and native vault-file
effects alongside dependency selection effects without reading grants.

The OAuth vault is `<state root>/connectors/notion-mcporter/<account>/{data,cache}`.
Only MCPorter reads or writes grants; ordinary transport uses `--no-oauth`.
Home caches for `notion-connectors` refuse rather than migrating silently.
The handoff's existing `notion` registration and grants are untouched.

Transcript reads forward `include_transcript: true` to `notion-fetch`. The
skill teaches scope classification, raw evidence, deduplication, and private
placement without copying corporate selectors or exclusions.

## Consequences

- Positive: every discovered tool is admitted through the existing command core.
- Positive: transport, envelopes, dependency selection, and auth stay with their
  existing owners; a new dependency or command parser is unnecessary.
- Negative: callers must declare meaningful verification for every write.
  Declared text matching is operator-selected evidence, not a semantic proof
  of arbitrary Notion content or a substitute for a live qualification.
- Negative: controlled handle verification relies on explicit reply shapes;
  malformed replies remain unknown. Handle creation does not prove a completed
  upload or page attachment. MCP tool admission does not implement HTTP byte
  transfer or install skills.
- Negative: an unconfirmed write blocks all writes for that account, deliberately
  avoiding unsafe partial-object or multi-object lock inference.
- Neutral: installation, fresh Harness activation, and this account's attended
  login remain separate from source and fixture proof.

## Options and Tradeoffs

### Home registration

Provides the observed tool set but misses account isolation and guarded writes.

### Account adapter and qualified catalogue

Meets every driver. Adds one service-owned adapter and explicit verification
rather than maintaining translations for the provider's complete write schemas.

### Read-only connector

Preserves the simple route but fails Nathan's explicit complete-tool requirement.

## Confirmation and Authority

Nathan owns acceptance. This proposed record accompanies a reviewable candidate;
it does not claim approval of a release or promotion through the personal
marketplace. Packaged-process tests cover catalogue admission, transcript args,
write refusal before effects, one-use previews, verified read-back, unknown
outcome blocking, terminal unchanged settlement, removals, handle preparation,
schema drift and local refusal boundaries, and async recovery. These fixtures
qualify local routing and verification behavior; they do not establish real
Notion output shapes or complete semantic proof for all 45 operations.
Production endpoint tests and source-substituted loopback tests remain distinct
from authenticated hosted effects.

Nathan requires live qualification before this candidate PR merges: fresh
attended login on the new account route, live schema comparison, a scoped
read/transcript retrieval, and controlled scratch create/edit/read-back trials.
Fresh attended account-route OAuth, search, document fetch, and nonempty raw
meeting transcript retrieval passed on the rebuilt candidate on 6 October 2026.
The fresh live schema comparison matched all 45 admitted tools with no missing
tools, extra tools, or required-key drift. `notion-restore-pages` is admitted as a
write with required `page_ids` through the existing verification contract. Two
intermittent provider-call failures preceded the successful schema comparison;
no replacement login was needed. Controlled scratch create/edit/read-back
trials remain pending; source and fixture checks do not mark them done.
Revisit typed operation verifiers when recurring workflows expose ambiguous
text evidence.

## References

- [Canva native OAuth](0004-move-canva-custody-into-mcporter-native-vault.md)
- [Figma effect catalogue](0005-admit-figma-catalog-by-effect-class.md)
- [Notion tools](https://developers.notion.com/guides/mcp/mcp-supported-tools)
- [Notion setup](https://developers.notion.com/guides/mcp/get-started-with-mcp)
