---
name: agent-browser
description: "Use the secured Agent Browser lane for bounded snapshots, observed semantic or CSS targets, and ordinary in-page actions."
---

# Agent Browser

Read [`lane-entry.md`](../../references/lane-entry.md), then run only
`browser-lane agent-browser` with its required lane, role, run ID, exact page
URL, and a bounded batch. The public command owns the pinned session, fresh URL
guard, custody, and cleanup.

Use an initial recipe limited to a scoped or interactive `snapshot`, an observed
semantic or CSS target, and ordinary in-page read or interaction. For article or
prose work, use a full or scoped snapshot, or targeted text, because an
interactive-only snapshot can omit content. For example, derive a `find role
button click --name "Observed label"` command only from the current admitted
page's observed accessible name. Reobserve after a page change. Do not predict
`eN` or carry `@eN` between fresh invocations.

The command's denylist is not a general admission policy. Do not request
navigation, tabs, connection, session, authentication, storage, plugin, profile,
dashboard, install, URL-taking helpers, or repair through
this adapter. Return an unsupported operation as a limitation. Do not invoke the
router.

For authored DOM/framework scripts, read [scripts.md](../../references/scripts.md).
Use page `eval` within the assigned task; it does not authorize host execution
or broader browser access.

Read [`upstream.md`](references/upstream.md) for provenance and compatible
mechanics.
