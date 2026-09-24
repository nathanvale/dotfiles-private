---
name: browser-use
description: "Route browser automation through a declared profile lane, hand tab admission to the human, and choose Agent Browser, Playwright, Puppeteer, or Chrome DevTools. Use before browser interaction, tab-access diagnosis, or CDP-engine selection on Nathan's machine. Not for the standalone attended quiet-profile read (browser-use plugin)."
---

# Browser Use

Classify the request first. An ordinary read-only request at one supplied
public URL takes the [quiet dedicated surface](#quiet-dedicated-surface) and
skips Global mode and Dispatch. Otherwise read [Global
mode](../../references/lane-entry.md#global-mode) first. When `free_mode` is
true, use that free workflow and route directly to any of the four adapters by
capability; no universal Chrome DevTools inventory step precedes the chosen
adapter. The secured instructions below apply only when it is false.

`browser-lanes` is the plugin; `browser-use` is its entry skill. Choose
identity and custody before the engine. Read
[`lane-entry.md`](../../references/lane-entry.md) for the shared gates, the
admission handoff, recovery, and the executable owner. For an engine choice,
read [`adapter-selection.md`](../../references/adapter-selection.md).

## Quiet dedicated surface

For one supplied public URL and an ordinary read without sign-in, follow the
"Quiet dedicated Agent Browser surface" section of
`$HOME/code/dotfiles/docs/agents/browser-automation.md`. It fixes the upstream
Agent Browser candidate, the dedicated profile, the flag prefix, the journey,
and the refusal recovery; Nathan supplies only the URL and the read. State the
exact URL, the requested read, and the dedicated profile as the task surface
before the first browser command.

This exception runs outside Browser Lanes: no `browser-lane` command, declared
daily lane, tab admission, or adapter skill. Return the observed read, the
retained inspection output, any refusal, and the next safe action. A request
that needs sign-in, credentials, a write, profile or tab management, an
extension, or a daily Chrome identity continues to Global mode and Dispatch
instead.

## Dispatch

1. Record the declared lane, account role, intent, page on the declared
   site when known, task scope, required output, and any explicit eligible
   engine choice. Do not infer identity from a URL or page content.
2. For a request to open an ordinary known URL, run `browser-lane list --json`
   and resolve the declared lane and account role. If the task includes human
   sign-in, start the pre-admission attended handoff in `lane-entry.md`; it
   reserves before opening. Otherwise run `browser-lane open --lane NAME
   --account-role ROLE --page-url URL --json`. Neither path requires relay
   health or a tab grant. Return after opening when no browser automation is
   requested. Report visible verification, authentication, and automation
   readiness exactly as observed; after an uncertain dispatch, follow its
   retained reservation or visible-inspection recovery instead of replaying.
3. A content-free diagnostic may finish here: run `browser-lane list --json`,
   then `browser-lane health --lane NAME --json`; use
   `browser-lane inspect --lane NAME --account-role ROLE --json` without a
   target for inventory-only diagnosis, or include `--page-url URL` when known.
   Inventory success does not grant action readiness. An unadmitted page on
   the declared site follows the admission handoff in `lane-entry.md`: open
   the requested tab through `browser-lane open` when it is not already
   prepared, then leave the OpenClaw grant to the human. Do not invoke an
   engine just to diagnose or prepare the tab.
4. When sign-in is requested or an admitted page presents a login wall, follow
   the attended login handoff in `lane-entry.md`. Keep the lane reserved while
   the human signs in visibly
   through the 1Password extension. Do not retrieve or fill browser credentials
   through a CLI, an adapter plan, page script, clipboard, or agent message.
5. Apply the selection reference. Hand off lane, role, intent, page on the
   declared site when known, task scope, and required output to one adapter:
   [`agent-browser`](../agent-browser/SKILL.md),
   [`playwright`](../playwright/SKILL.md),
   [`chrome-devtools`](../chrome-devtools/SKILL.md), or
   [`puppeteer`](../puppeteer/SKILL.md).
6. The adapter reads the shared entry itself, including on direct invocation,
   then runs its one existing public lane command. Do not pass a page ID,
   endpoint, cached grant, prior-run element reference, or browser session.

Return the selected adapter, reason, supported operation, material limitation,
and next safe action. An adapter capability gap can return for a different
eligible choice before any action, or after outcome verification. Permission or
custody failure stops. Do not replay an action with uncertain effects through a
different engine.

For an adapter comparison, runbook selection/execution, or recipe repair, use
[bake-off](../bake-off/SKILL.md). Its contender and evidence contract supplements
these lane gates; it does not replace them.
