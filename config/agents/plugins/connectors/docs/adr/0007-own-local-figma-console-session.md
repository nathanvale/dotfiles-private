---
status: proposed
---

# Own a local Figma Console session through the Desktop Bridge

## Context and Problem

Nathan's Root evaluation on 28 October 2026 drove the Figma Console server
(1.42.1, upstream commit 03ccdfac5e4554e0f07e7b0a7cf26a38f4f13978) and its
local Desktop Bridge plugin (1.41.5) under manual guards. It proved fresh
Plugin API variables, CSS and DTCG export, text, variant, variable, alias and
fill edits, and reconnect refusal. It also found that an ordinary cached
variable read returned a stale value after a successful update, and that
token setup defaults to every scope. Code Connect is unsupported by Console,
and documentation generation and parity comparison timed out.

Console differs from every existing Connector Skill: a stdio server that
needs a Figma PAT, a long-lived process holding a WebSocket to a plugin
running inside Figma Desktop, a generic `figma_execute` tool that runs
arbitrary Plugin API code, and a Desktop that may have any file and account
open. The decision is how Connectors admits it without giving agents the
generic tool, an unguarded file, or an unjournaled long-lived process.

## Decision Drivers

- Bind every effect to one registered account and file, checked in Desktop.
- Never expose arbitrary code, a caller config path or an endpoint.
- Keep the PAT below MCPorter, as every static-credential Provider does.
- Prove freshness instead of trusting upstream caches.
- Journal every effect, including the long-lived session, with no replay.
- Leave the hosted Figma route (ADRs 0003 and 0005) unchanged.

## Considered Options

- Admit the upstream tool catalogue directly through the public route.
- A semantic adapter with source-owned scripts and an owned MCPorter daemon.
- No local route; keep the hosted Figma route only.

## Decision

We propose a separate `figma-console` Connector Skill whose packaged adapter
owns Route Selection (`account`, `file`), a closed catalogue, and an owned
MCPorter daemon session, because it alone satisfies every driver.

- **Closed operations.** Thirteen named reads and eight named writes. The
  registry allow-lists twelve exact upstream tools, but `figma_execute` is
  reachable only with scripts generated in `scripts/canvas.ts` from validated
  serialized input. Every script first asserts `figma.fileKey`; write scripts
  also assert `figma.currentUser.id` equals the registered PAT user id, and
  compare the complete baseline inside the same invocation before the effect.
- **Owned daemon.** `route.json` opts in with `ownedDaemon: true`. The shared
  route then admits `daemon start|status|stop --json` only on a
  dispatcher-owned route through `planDispatcherRoute`, and omits
  `MCPORTER_NO_KEEPALIVE`; every other route keeps it. Each call uses one
  canonical environment, the profile root as cwd, and a short private
  namespace `/tmp/connectors-fc-<uid>-<hash>` because macOS UNIX socket paths
  cannot hold the state-root path. `session_start` and `session_stop` are
  journaled writes; stop requires every server drained and not marked with an
  unknown outcome.
- **Custody.** The Provider is an internal role of the compiled front door. It
  reads the registered item's single concealed `credential` field through the
  shared 1Password custody helper, qualifies the PAT through `/v1/me` against
  the registered id and email, then replaces itself with the pinned Node and
  server holding the token only in its own environment.
- **Pins.** Registration is immutable. It binds a measured Node binary; every
  transport call and every Provider start recheck the complete runtime
  dependency closure digest and the vendored bridge payload digests.
- **Freshness.** Snapshots come from the Plugin API, never upstream caches.
  Export force-refreshes variables, refuses any cache, stale, fallback or
  warning mark at any depth (an object under such a key passes only as a DTCG
  token group, so a group named `warning` is data), and refuses when variables
  changed during export.
- **Journal.** Previews hold an object lock. One atomic one-use marker decides
  each preview once: the apply that wins it is the only sender, and an unlock
  must win it to end the preview unsent. A degraded journal refuses before the
  send. From the marker on, every apply path reports `effect-unknown` unless
  read-back proves the effect and the receipt records it, including when the
  journal itself cannot record the outcome. Locks are released through a
  tombstone rename, so a settler only ever removes a lock naming its own
  receipt; a lock whose receipt never published is listed and releasable.
- **Adjudication.** It reads only the file, after setting a per-receipt fence
  in the bridge's device-local `figma.clientStorage`. Every mutation checks
  that fence after its last asynchronous read and then makes its effects
  synchronously, so code the bridge timed out on but still runs cannot land
  after a verdict. `unchanged` compares only the receipt's own object (for new
  tokens, also that no collection id was added), and read-back compares at
  Figma's float32 precision with RGBA colours. Settlement is a per-receipt
  compare-and-set under a cross-process settle lock, and each verdict is its
  own one-use record, so the first verdict stands even if that lock were
  breached and no late apply reopens it. A session has no fence: it cannot
  settle unchanged inside MCPorter's start window or while its attempting
  process lives, and a late session effect beside a verdict stays unknown.

## Consequences

- Positive: agents get fresh variables, export and guarded edits without any
  generic code path; wrong file or account refuses inside Desktop.
- Positive: the shared route change is opt-in; existing routes are unchanged.
- Negative: the source manifest and pin now include Figma's `currentuser`
  permission, but writes still refuse until Root re-imports the bridge and
  verifies the Desktop account. The permission exposes the current user's
  profile fields to plugin code; the connector reads only the id.
- Negative: MCPorter's client starts a daemon for a call on a stopped
  namespace. The transport checks status before every call, so only a stop
  racing a call could start an unjournaled session in the same namespace.
- Negative: one bridge port per host means one Console session at a time.
- Negative: tools without a file argument (lint, accessibility, variant
  analysis, screenshot, changes) read the bridge's active file; their results
  say so and carry no file binding beyond the guards around them.
- Negative, trust limits: the pins bind the repository bridge copy, not the
  bridge Desktop actually runs; Node may resolve modules above the runtime
  root; any local process can listen as the bridge on the loopback port. The
  guards, fence and adjudication trust that bridge. The fence assumes the
  plugin host answers client-storage requests in order.
- Neutral: Code Connect, documentation generation and parity remain refused.
- Neutral: one fence key per adjudicated receipt stays in the bridge's client
  storage; pruning one could let a late mutation land, so they are kept.

## Options and Tradeoffs

### Upstream catalogue through the public route

- Good: smallest change, every upstream capability.
- Bad: exposes arbitrary code and unguarded file selection, and keeps the PAT
  above MCPorter; fails the binding, closure and custody drivers.

### Semantic adapter with an owned daemon (chosen)

- Good: meets every driver with process-tested guards and journal.
- Bad: more source, a shared route opt-in, and a permission decision before
  any write.

### Hosted route only

- Good: no new process or credential.
- Bad: no fresh Plugin API variables or local edits; the evaluated needs stay
  unmet.

## Confirmation

- Process proof (substituted, not live): `skills/figma-console/tests/` drive
  the compiled front door of a verified private copy that replaces only the
  MCPorter process leaf, identity origin, Keychain reader, op digest and
  runtime pin. They cover the guards, one send under concurrent applies,
  storage failure and crash after the send, lifecycle and its adjudication,
  freshness refusals, custody and immutable registration.
- Shared route regression tests in `tests/provider-route.test.ts`.
- Live canaries are Root-owned and outside this candidate: schema, session
  start, fresh reads and export, and one disposable write each after attended
  bridge re-import and account verification.
- Revisit when MCPorter offers a call that refuses to start a daemon, or when
  upstream Console publishes a freshness contract.

## Authority

Nathan approved the `currentuser` source permission on 28 October 2026. Root
owns attended bridge re-import and every live effect.

## References

- ADR 0001 (journaled writes), ADR 0003 and ADR 0005 (hosted Figma route).
- https://developers.figma.com/docs/plugins/api/figma/ (`currentUser` needs `currentuser`).
- https://developers.figma.com/docs/plugins/manifest/
