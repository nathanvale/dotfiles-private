---
name: playwright
description: "Use the secured Playwright lane for private JSON plans containing supported locator and accessibility interactions."
---

# Playwright

Read [`lane-entry.md`](../../references/lane-entry.md), then write an absolute,
regular, non-symlink mode-600 JSON plan that matches current `browser-lane
--help`. Run only `browser-lane playwright` with the required lane, role, run
ID, exact page URL, and plan path. The command snapshots and revalidates the
plan, owns fresh attachment, and detaches its run-scoped session.

Use only allowlisted in-page actions and documented accepted argument forms.
Use observed role, name, test-ID, or CSS targets. A snapshot reference is fresh
only for its current invocation; reobserve after a page change. Do not add
vendor flags, screenshots, PDF, uploads, request interception, storage,
navigation, tab lifecycle, host `run-code`, tracing, or test runner controls.
For authored DOM/framework scripts, read [scripts.md](../../references/scripts.md)
and use the opt-in schema-2 `evaluate` action. Direct vendor `eval` remains
outside the public plan interface. Return a limitation rather than using
another engine to evade the plan contract.

Read [`upstream.md`](references/upstream.md) for provenance and compatible
mechanics.
