---
name: chrome-devtools
description: "Use Chrome DevTools MCP through the secured lane for one page-scoped debugging, diagnostic, or authorized page-script call."
---

# Chrome DevTools

Read [Global mode](../../references/lane-entry.md#global-mode) first. When
`free_mode` is true, use that free workflow; the secured instructions below
apply only when it is false.

Read [`lane-entry.md`](../../references/lane-entry.md), then run only
`browser-lane run ... -- mcporter call chrome-devtools.TOOL ...`. Use the exact
lane, role, run ID, and page URL required by current CLI help. The lane owns a
fresh page resolution and injects its page ID. Do not supply `pageId`, `pageIdx`,
or select a page.

Use one page-scoped call for a compatible console, network-summary, or
page-debugging question. Bound requested results and treat URLs and diagnostics
as potentially sensitive. Do not use raw network detail, page creation,
navigation, selection, closing, extension or PWA lifecycle, out-of-band tools,
or vendor `chrome-devtools` CLI commands. Do not promise screenshots, custom
JSON extraction, tracing, or multi-call continuity until the local schema and
one-use lane behavior are independently qualified. Tracing is unqualified; the
inspected upstream default can reload.

Upstream-documented MCPorter call mechanics, unqualified through the lane:
`--args` accepts inline JSON only; pass a multi-line evaluation as
`function=@/absolute/private/file.js` from a mode-600 file; pass
`--timeout 30000` for a call that waits on the page; read
`mcporter list chrome-devtools --schema` for signatures instead of guessing.

For an authorized page script, read [scripts.md](../../references/scripts.md),
then qualify the installed `evaluate_script` schema and one-use behavior.

Read [`upstream.md`](references/upstream.md) for provenance and compatibility.
