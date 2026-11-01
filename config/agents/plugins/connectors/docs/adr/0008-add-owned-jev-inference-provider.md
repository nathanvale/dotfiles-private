---
status: proposed
---

# Add an owned JEV inference Provider below MCPorter

## Context

Calling skills need one generic TypeSafe connection with existing 1Password
custody. TypeSafe supplies HTTP APIs, without an official MCP server in the
reviewed research. A paid inference can be billed even when its reply is lost;
the existing provider-write recovery vocabulary does not describe that fact.

## Decision drivers

Keep custody below MCPorter, retain the packaged CLI seam, preserve typed
choice/noul responses and prevent automatic replay of uncertain paid requests.
Keep caller-specific policy outside the connector.

## Proposed decision

Use one dispatcher-owned registry with `imports: []`, precisely `list_models`
and `system_one`, and an owned internal stdio Provider. Use fixed-origin fetch
with redirect refusal, a bounded timeout and no HTTP retries. Persist a private
request-key digest reservation before transport and an atomic one-use send
claim before fetch. Completed repeats return a no-call receipt. Unknown repeats
refuse; recovery inspects local receipts without adjudication or unlock.

Accept bounded private JSON through the front door's ordinary run file/stdin
input. Stage a `0600` file in a `0700` Connectors directory and use pinned
MCPorter's `requestJson=@path --no-coerce` to carry it into stdio. Keep public
file injection refused. Admit only the exact private dispatcher argument for
an owned, bounded staging file. Remove it on normal completion; forced
termination may leave a private orphan, which never authorizes replay.

Add inference-completed and inference-unknown executions and matching public
stations. They name `inference-receipt` and `paid-inference`, preserving the
existing write stations. The user's bounded implementation request authorizes
this candidate; this record remains proposed pending architecture acceptance.

## Alternatives and consequences

The vendor SDK reduces HTTP work but its default retries and environment host
and debug settings conflict with this route's custody and replay drivers.
A third-party MCP server adds an unqualified credential and retry owner.
Direct HTTP keeps two endpoint contracts local with no new runtime dependency,
but requires owned schema validation and hosted qualification. Conservative
unknown handling can block requests that were never processed; it prevents a
silent second paid attempt and does not claim billing reconciliation.

## Confirmation

Packaged-process fixtures must prove exact tools, refusal before capability,
custody isolation, bounded private input without payload argv/logs, typed
answers and usage, preservation of NotebookLM reads, and one HTTP call for an unknown
attempt followed by replay refusal. Foreground live model discovery and a
separately authorized synthetic inference remain distinct qualification steps.
See [research and limits](../../skills/jev/references/research.md).
