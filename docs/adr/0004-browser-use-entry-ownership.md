---
status: accepted
---

# Browser Use entry is the browser-lanes plugin skill

## Context and Problem

Account for two browser-use skills on the machine: the locked third-party
`steipete/agent-scripts` `browser-use` payload accepted by ADR-0003 and the
`browser-lanes` plugin router `use-browser`. The third-party payload's
callable Codex Chrome plugin route, raw MCPorter calls, full-profile direct
attachment, and All tabs default contradict the lane gates. A Xero task
followed the stale direct route, and the human had to ask how to admit a tab.
Resolve one owned entry without weakening the lane or security boundary.

This decision revises the ADR-0003 clause that accepted the
`steipete/agent-scripts` `browser-use` payload at both addresses and the
ADR-0002 clause that named it as the replacement for the personal workspace;
both records now point here. Nathan accepted this decision on 4 September 2026
in the foreground session that ran the fenced cutover.

## Decision Drivers

- Use one entry name across both Harnesses.
- Keep an agent from granting its own tab access.
- Preserve lane gates and the two declared profiles.
- Preserve relay configuration and the Selected-tabs policy.
- Preserve command lease behaviour and manual 1Password entry.
- Preserve every security non-claim.
- Align source, installed state, and startup documents.

## Considered Options

- Option A: Keep both names and both skills.
- Option B: Rename the plugin entry to `browser-use`, absorb useful mechanics
  into the plugin's smallest owners, and retire the third-party payload.
- Option C: Keep `use-browser` and retire the third-party payload.

## Decision

Choose Option B. Use one `browser-use` entry, one admission handoff, and the
plugin's lane gates as the owners of browser routing and interaction mechanics.

## Consequences

- Positive: Provide one entry name and one human handoff.
- Negative: Carry a transitional duplicate `browser-use` name until the fenced retirement.
- Negative: Require a plugin reinstall at version 0.2.0.
- Negative: Give Claude Code no browser entry after retirement until the plugin
  is installed there or a separate decision accepts that gap.
- Neutral: Keep the retired payload in Git history.

## Options and Tradeoffs

### Option A

- Keep both names and fail one entry name plus source and startup agreement.
- Retain direct routes that contradict the human tab boundary and lane gates.
- Preserve only the plugin controls, not the full decision-driver set.

### Option B

- Use `browser-use` across both Harnesses and align source, installed state, and
  startup documents at the retirement fence.
- Route admission through the human click and keep the agent from granting it.
- Preserve lanes, profiles, relay, Selected-tabs policy, lease, manual 1Password
  entry, and security non-claims while absorbing interaction mechanics.

### Option C

- Keep `use-browser` and retire the payload, leaving active `browser-use` unresolved
  while consumers are rewritten.
- Keep the controlled handoff and lane controls after broad changes, with no
  third-party direct-route conflict.
- Align source, installed state, and startup documents only after that rewrite.

## Accepted temporary revision: configurable free mode

Nathan explicitly approved a global config flag on 14 September 2026, with
skills following it and a switch back to secured behavior. Preserve this
entry ownership. While `free_mode` is true, replace Selected-tabs admission and
page-action restrictions with All tabs and direct routing to any declared
adapter through the lane. Choose Agent Browser, Playwright, Puppeteer, or Chrome
DevTools by capability. The first three perform their own same-site checks
without a Chrome DevTools `list_pages` preflight; Chrome DevTools calls remain
unrestricted. The skill may set the extension mode. False restores the original
secured routing; the skill restores Selected tabs when needed. Profile
identity, authenticated relay, task authority and serial lane custody remain.
This prioritizes usable automation while Nathan revisits security. Confirm
through public CLI tests for enabled, disabled, missing and malformed
configuration, plus separate live extension-mode and adapter evidence.

Nathan accepted a same-site revision on 14 September 2026, after a live
timesheet proof showed exact-URL matching failing within seconds under portal
redirects and query rewrites: every adapter refused. Each adapter now proves
the same-site page in both secured and free mode; `--next-page-url` remains
exact, since it names one expected destination.

## Confirmation

Confirm with `bin/agent-skills-inventory --json`: show no third-party
`browser-use` row and no undeclared lock key. Run
`bin/test/browser-lane-test.sh`. Pass the direct discovery canaries in
`docs/agents/skills.md` for surviving `browser-use` and retired `use-browser`.
Pass one separately approved live Selected-tabs handoff on a harmless page.
Pass one live free-mode Agent Browser run with an unrelated tab present and
the DevTools inventory failing.

Authority: Nathan.

## References

- ADR-0002, ADR-0003, and `docs/agents/browser-automation.md`.
