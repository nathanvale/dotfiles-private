---
name: puppeteer
description: "Use the secured Puppeteer lane for private fixed-action JSON plans and per-action JSON result records."
---

# Puppeteer

Read [`lane-entry.md`](../../references/lane-entry.md), then write an absolute,
regular, non-symlink mode-600 JSON plan matching current `browser-lane --help`.
Run only `browser-lane puppeteer` with its required lane, role, run ID, exact
page URL, and plan path. The public command snapshots and revalidates the plan,
rechecks page binding before every action, and disconnects without closing
Chrome.

For fixed-action plans, use: title, snapshot, text, click, hover, type, press,
select, and wait. Each successful action emits one JSON record; stop on the
first failure. Use a selector observed to identify the intended control. `wait`
proves presence only. `click` uses the first match. `text` returns `textContent`,
not guaranteed visible text. The helper has no locator readiness guarantee.

For authored DOM/framework scripts, read [scripts.md](../../references/scripts.md)
and use the opt-in schema-2 `evaluate` action. Keep host execution, launch or
connect, tabs, navigation, cookies or storage, screenshots, PDF, and direct
network APIs outside the task interface.
Return a limitation rather than an engine bypass. Read
[`upstream.md`](references/upstream.md) for provenance and compatible mechanics.
