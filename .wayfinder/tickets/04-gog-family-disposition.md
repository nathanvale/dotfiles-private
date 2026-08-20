---
title: "Retiring the gog family from the global corpus"
labels: [wayfinder:grilling]
parent: skill-corpus-addressing
blocked_by: []
status: closed
---

## Question

Nathan ruled the `gog-*` skills go. How, given they are lock-managed and will
otherwise reinstall?

Measured: 30 entries, 434t — 26% of global entries for 11% of global cost.
Removing them leaves the listing at 3,646t, still 1,646 over budget. They are
real directories installed from `openclaw/gogcli`, keyed in `.skill-lock.json`,
which is itself a Tracking Link under D13.

Decide:
- Whether removal means deleting the directories, editing the lock file, or
  both. Deleting alone is undone by `npx skills update`.
- Whether the `gog` router survives alone. Nathan's global rules route all
  Google work through `gog`, and `google-connector-dispatch.md` depends on it.
- Whether the 29 leaf skills become reference docs reachable from the router,
  per the "should be startup pointers rather than skills" hypothesis — the
  router does not currently link them.

## Resolution — 2026-08-19

**Hand-pick the gog skills through the third-party route.** Nathan ruled the
`gog-*` family is not removed wholesale; it is re-picked deliberately using the
same `npx skills` method that governs all third-party installs.

This subsumes the lock-file question: selection is expressed by what is
installed, so there is no delete-then-reinstall race. The `gog` router survives
— `google-connector-dispatch.md` and the Google rules route through it.

Which specific leaves are picked is an input to the per-entry disposition spec,
not a separate decision. Measured cost for the full family was 434t across 30
entries; a hand-picked subset is strictly cheaper.
