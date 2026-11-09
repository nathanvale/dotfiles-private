# LogTape diagnostics

Pin `@logtape/logtape`, and any selected `@logtape/redaction` or `@logtape/file`
package, to `2.4.2` for new diagnostic integrations. Preserve existing application
pins until their own scoped upgrade passes. Keep machine output and recovery
journals under [Contract Core](contract-core.md); diagnostics explain execution
without deciding domain truth.

## Select and bound the sink

- For `fromAsyncSink()`, set a finite `maxQueueSize`; its default is unbounded.
  The limit counts waiting records, excluding the active operation. Prefer
  `overflow: "drop-newest"` when a stalled operation must also bound retained
  promise bookkeeping; `"drop-oldest"` can retain that bookkeeping until the
  active operation settles. Bound the operation's duration separately.
- For non-blocking console or stream sinks, use the `nonBlocking` object's
  `bufferSize`, `flushInterval`, `onDrop`, and `onError`. Console output is
  unsuitable for the complex profile's private machine-mode diagnostics.
- Bound serialized record bytes, total retained bytes, and per-run output in
  the application. Queue counts and flush thresholds alone do not establish
  those limits. Keep the exemplar's owned byte queue when those guarantees apply.

API owner: [2.4.2 sink source](https://github.com/dahlia/logtape/blob/2.4.2/packages/logtape/src/sink.ts).

## Report loss

Count `onDrop({ count, reason })` overflow events through a separate path.
`fromAsyncSink()` reports drops synchronously; console and stream sinks aggregate
them over the flush interval and report the remainder on disposal. Their
`onError` reports formatting, encoding, writing, or closing failures; a close
failure is a resource failure, not another failed record. Async-sink operation
failures go to `['logtape', 'meta']`. Keep notification handlers bounded and
payload-free; route them away from the failing sink. Retain application counters
for truncation, admission refusal, timeout, and unflushed records; overflow
notifications do not count every kind of loss.

Behavior owner: [2.4.2 sink manual](https://github.com/dahlia/logtape/blob/2.4.2/docs/manual/sinks.md#loss-notifications).

## Drain and finish

Use a drainable sink's `drain()` for a job boundary that keeps the sink open.
Global `drain()` visits only drainable configured sinks. It waits for earlier
accepted records to settle, including failures and drops; it does not certify
successful delivery or durable storage. `fromAsyncSink()` drain resolves even
after operation failures. A fingers-crossed wrapper's drain leaves its buffered
records withheld; explicitly choose `flush()` or `discard()` at the job boundary.

Await `dispose()` or the owned outer wrapper's asynchronous disposal before
normal exit. Apply the accepted shutdown deadline and report incomplete cleanup;
a timeout race does not cancel pending I/O. Keep first-signal bounded cleanup and
repeated-signal immediate termination. Exit hooks cannot promise asynchronous
completion after forced exit. Process configuration and resource cleanup belong
to the process owner; a library must preserve a foreign configuration.

Lifecycle owners: [2.4.2 configuration source](https://github.com/dahlia/logtape/blob/2.4.2/packages/logtape/src/config.ts)
and [drain semantics](https://github.com/dahlia/logtape/blob/2.4.2/docs/manual/sinks.md#draining-sinks).

## Redact before retention

Project safe fields before buffering. Use `redactByField()` for structured
secrets and `redactByPattern()` around the formatter for free text. Bound
traversal with `maxDepth` and `maxProperties`; defaults are 20 levels and 1,000
entries per object. Test nested fields, interpolated messages, and truncation.

Field wrappers preserve disposal hooks, but do not forward `Drainable` in this
tag. Retain the underlying drainable sink for synchronous field redaction;
dispose the outer `redactByFieldAsync()` wrapper to await pending redaction and
wrapped cleanup. Qualify the composed chain rather than assuming global drain
covers it.

Owners: [redaction manual](https://github.com/dahlia/logtape/blob/2.4.2/docs/manual/redaction.md)
and [field wrapper source](https://github.com/dahlia/logtape/blob/2.4.2/packages/redaction/src/field.ts).

## Own files and retention

Keep private diagnostics in the CLI's XDG state directory with verified `0700`
directories, `0600` files, trusted ancestry, exclusive creation, and descriptor
identity checks. Preserve the exemplar's custody allocator and closure evidence.
The standard Node file driver opens paths in append mode; it does not establish
that custody contract. File `nonBlocking` is a boolean with separate flush
thresholds; it does not expose the console/stream notification object.

Treat rotation limits as sink-local. Enforce the accepted age, aggregate bytes,
file count, active-file reservations, and deletion policy across runs under the
application's custody owner. Prune only files proven closed and owned.

Owners: [Node file driver](https://github.com/dahlia/logtape/blob/2.4.2/packages/file/src/filesink.factory.node.ts)
and [file buffering and rotation](https://github.com/dahlia/logtape/blob/2.4.2/packages/file/src/filesink.base.ts).

## Version evidence and qualification

The [2.4.2 changelog](https://github.com/dahlia/logtape/blob/2.4.2/CHANGES.md)
dates the release to 19 October 2026. JSON Lines formatters serialize bigint
properties and message values as decimal strings. The included 2.4.1 fixes
preserve cleanup hooks when native disposal symbols are absent.

Use exact-tag sources for these claims. Context7's adjacent 2.4.0 index can help
discovery but does not prove 2.4.2 behavior. Documentation establishes capability;
executed checks establish only their named boundary. The local complex exemplar
uses an owned byte queue and custody allocator, not every upstream sink API.
Qualify any replacement with public-process overflow, redaction, write-failure,
shutdown, permissions, concurrent allocation, and retention checks.
