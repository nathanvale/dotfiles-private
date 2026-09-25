---
status: accepted
supersedes:
  - 0004-browser-use-entry-ownership.md
  - 0006-private-handoff-token-and-explicit-recovery.md
---

# Use native Harness browsers; retire Browser Lanes and Browser Use

## Context and Problem

Browser Lanes (`bin/browser-lane`, six helpers, the `browser-lanes` plugin
with its `browser-use` entry skill and four adapters) routed every agent
browser task through declared Chrome profile lanes: admission through an
OpenClaw extension relay, a MCPorter `chrome-relay` fork, private handoff
tokens for attended login, lease custody, and explicit recovery. ADR-0004
made that plugin the one `browser-use` entry; ADR-0006 hardened its handoff
tokens and recovery. A separate `browser-use` plugin later added a direct,
attended Agent Browser read in a dedicated quiet profile.

Both Harnesses now ship a native browser: Codex `@Chrome` drives Nathan's
real Chrome with its sessions, `@Browser` drives an in-app browser, and Claude
Code drives Chrome through Claude in Chrome. The Harness owns attachment and
the visible tab, and Nathan completes sign-in in that tab. Nathan uses these
surfaces for his browser work. At retirement neither `browser-lanes` nor
`browser-use` was installed or enabled in either Harness, so the lane
infrastructure was 3,322 lines of router, a 5,525-line suite, two root npm
dependencies, and about fifteen routing lines that named an entry no longer
in use. Decide which browser entry the repository routes agents through.

Nathan decided this on 25 September 2026 (Decision 4 of the shell test audit,
relayed through the coordinator) and authorized implementation the same day.

## Decision Drivers

- One browser entry per Harness, with no source-only route an installed
  Harness cannot reach.
- Sign-in, 1Password, CAPTCHA, passkey, and device trust stay with Nathan in
  the visible tab.
- Signed-in portal work uses Nathan's real Chrome sessions.
- No custom relay, lease, token, or recovery infrastructure to qualify and
  maintain.
- Generic browser tooling with other consumers keeps working.
- Retired products stay recoverable from Git history.

## Considered Options

- Option A: keep Browser Lanes as the entry and reinstall it in both
  Harnesses.
- Option B: retire Browser Lanes and keep the standalone `browser-use` quiet
  profile read.
- Option C: retire both and route every browser task through the native
  Harness browser.

## Decision

Choose Option C. Route browser work through the native Harness browser as
`docs/agents/browser-automation.md` states: Codex `@Chrome` for signed-in
Chrome work, Codex `@Browser` for local and public pages, Claude in Chrome in
Claude Code, and attended sign-in by Nathan. Delete `bin/browser-lane`, its
helpers, its suite, both plugins, their marketplace and preparation rows, the
Fallow entries, and the `puppeteer` and `tldts` root dependencies. Keep Agent
Browser, Playwright, MCPorter, and the `chrome-devtools` MCPorter entry for
their other consumers.

This supersedes ADR-0004 and ADR-0006. ADR-0005 stays superseded by ADR-0006;
its body is history. Machine state outside the repository (lane registry,
config, Codex marketplace and agent entries, plugin caches, Agent Browser
namespaces) is a separate deletion scope for Nathan.

## Consequences

- Positive: the browser entry is whatever the Harness installs, so source and
  installed state agree without a plugin release.
- Positive: signed-in work uses Nathan's real sessions instead of a relay
  admission click.
- Positive: net removal of the router, the suite, two dependencies, and the
  lane and token vocabulary.
- Negative: no unattended or headless agent browser route remains in the
  repository; a task that needs one reopens this decision.
- Negative: profile isolation, lease custody, and same-site guards are now the
  Harness's guarantees, not the repository's.
- Neutral: the retired code, ADR bodies, and research stay in Git history.

## Options and Tradeoffs

### Option A

- Good: keeps profile lanes, leases, and same-site guards under repository
  control.
- Bad: reinstalls a product Nathan stopped using; keeps relay, token, and
  recovery code plus a 5,525-line suite qualified against a fake relay.
- Bad: gives Claude Code no entry until the plugin is installed there.

### Option B

- Good: one small attended read survives for a public URL.
- Bad: a one-URL read is what native `@Browser` already does; keeping a
  second `browser-use` name beside the Codex `@browser-use` alias invites the
  wrong route.

### Option C

- Good: meets every driver; the Harness owns attachment and Nathan owns
  sign-in.
- Bad: loses the unattended route and the repository-owned guards named
  above.

## Confirmation

- `git grep -n -E 'browser-lane|browser-lanes|browser-use'` returns only
  history (ADR 0002 to 0006 bodies, research, `.wayfinder` notes,
  coding-standards examples, retired-skill lists, fixture strings) and the
  retirement pointers in `docs/agents/browser-automation.md`,
  `docs/agents/skills.md`, and this ADR.
- `bun run check` and `bun run lint:scripts` pass with the deletions.
- `claude plugin list --json` and `codex plugin list --json` show neither
  plugin.
- Revisit when a task needs an unattended or headless browser run, or when a
  Harness drops its native browser.

## References

- [ADR-0004](0004-browser-use-entry-ownership.md) and
  [ADR-0006](0006-private-handoff-token-and-explicit-recovery.md), superseded.
- `docs/agents/browser-automation.md`.
- Precedent: `config/agents/plugins/personal/skills/timesheets/SKILL.md`.
