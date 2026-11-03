# Closeout Packet check

Read-only completeness check for one Closeout Packet. The packet contract is the
canonical vault spec `projects/engineering-workflow/specs/sdk-closeout-proposals.md`
(spec id `sdk-closeout-proposals`); this README owns only the input format and
how to read the result. Public help owns the syntax:

```sh
"${PLUGIN_ROOT}/bin/closeout-packet" --help
"${PLUGIN_ROOT}/bin/closeout-packet" --discover --json
"${PLUGIN_ROOT}/bin/closeout-packet" check --packet PACKET.json --expected EXPECTED.json --json
```

CLI Design Contract Core 2.0, simple profile: `closeout-packet.check` is
`inspect`. It reads exactly the two named files. It never queries a native task,
reads a credential, uses the network, spawns a process or writes a file, and it
never approves, transitions or closes anything.

## Inputs

Both files are one JSON object. Keep them separate. Write `--expected` from an
independent owner observation, never by copying identities out of the packet.

Expected context:

- `identity`: `host`, `project`, `task`, `candidate`.
- `observation`: `source` and `at` of the owner observation the identity came from.
- `inventory`: `source`, `revision`, `complete: true` and `obligations` (the
  applicable obligation ids from their authoritative owners). A partial
  inventory is a coverage gap.

Packet (the six fields):

- `identity`: `host`, `project`, `task`, `candidate`, `observedAt`, `executionOwner`.
- `outcome`: `scopedResult`, `nativeState`, `proposedDisposition`, `limits[]`.
- `evidence[]`: one item per obligation. Each item has `obligation` and `status`.
  - `status` is `fresh`, `carried`, `cache`, `failed`, `missing` or `not-applicable`.
  - An applicable item also has `subject`, `sourceCandidate` and `reportPointer`.
  - A `not-applicable` item has a `justification`.
- `downstream`: `coverage` (`complete`, `partial` or `unknown`).
  - Complete coverage lists `effects[]`; an empty list means none.
  - Partial or unknown coverage names an `owner` and a `nextSafeStep`, and never
    claims `no-effects`.
- `unresolved`: `holds[]`, each with `owner` and `releaseCondition`. Optional `humanChoices[]`.
- `decision`: `action`, `readback` and `grants[]`.
  - Each grant has `originalRecord`, `action`, `scope`, `conditions[]` and `exclusions[]`.

## Result

A check that completes is `SUCCESS_UNCHANGED` even when it finds gaps. Read `data`:

- `reporting` is one of:
  - `complete`;
  - `incomplete` (a finding exists);
  - `inconsistent` (the packet identity differs from the expected context).
- `actionability` is one of:
  - `supports-requested-action`;
  - `blocked`: complete reporting with a hold, failed or missing proof, or
    coverage that is not complete;
  - `not-assessed`: reporting not complete.
- `findings[]`: `code`, `path` and `repair`.
- `unknowns[]`: partial or unknown coverage, kept visible.
- `establishes` is `recorded-structure-only`. `doesNotEstablish` lists authority,
  dependency completeness, evidence truth, freshness and native PASS.

Evidence from another candidate is reported as `REUSE_UNQUALIFIED`. Qualified
reuse belongs to a later slice.

A structural `complete` never replaces original-record review. That review
opens the inventory sources, the evidence pointers and the original grant
records, and judges them.

Unreadable input refuses with `DOMAIN_PRECONDITION_UNMET` (exit 3). Input that is
not a JSON object refuses with `SCHEMA_INVALID_INPUT` (exit 4).

## Tests

`bun test packages/closeout-packet/tests` from the plugin root.
