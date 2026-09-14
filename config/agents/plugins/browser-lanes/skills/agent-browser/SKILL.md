---
name: agent-browser
description: "Use the secured Agent Browser lane for bounded snapshots, observed semantic or CSS targets, and ordinary in-page actions."
---

# Agent Browser

Read [Global mode](../../references/lane-entry.md#global-mode) first. When
`free_mode` is true, use that free workflow; the secured instructions below
apply only when it is false.

Read [`lane-entry.md`](../../references/lane-entry.md), then run only
`browser-lane agent-browser` with its required lane, role, run ID, exact page
URL, and a bounded batch. The public command owns the pinned session, fresh URL
guard, custody, and cleanup.

Use an initial recipe limited to a scoped or interactive `snapshot`, an observed
semantic or CSS target, and ordinary in-page read or interaction. For article or
prose work, use a full or scoped snapshot, or targeted text, because an
interactive-only snapshot can omit content. For example, derive a `find role
button click --name "Observed label"` command only from the current admitted
page's observed accessible name. An observed in-page link or ordinary control
may activate navigation. When its exact same-origin destination is observed,
use `--next-page-url` with one action; the lane verifies the destination on the
same tab and retires the session. Inspect and snapshot that destination before
another action. For dynamic destinations, inspect the actual outcome before
continuing; never replay a write after an attachment error. Do not predict `eN`
or carry `@eN` between fresh invocations.

The command's denylist is not a general admission policy. Do not request raw
navigation or new-page helpers, tabs, connection, session, authentication,
storage, plugin, profile, dashboard, install, arbitrary URL-taking helpers, or
repair through this adapter. The observed same-origin `--next-page-url` flow
above is the only URL-taking exception. Return an unsupported operation as a
limitation. Do not invoke the router.

For authored DOM/framework scripts, read [scripts.md](../../references/scripts.md).
Use page `eval` within the assigned task; it does not authorize host execution
or broader browser access.

Read [`upstream.md`](references/upstream.md) for provenance and compatible
mechanics.
