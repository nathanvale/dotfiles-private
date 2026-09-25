# Browser Automation

Use the browser surface supplied by the active Harness. Browser Lanes and
Browser Use are retired by
[ADR-0011](../adr/0011-native-harness-browsers.md): `browser-use`,
`browser-lanes`, and `browser-lane` are not routes.

## Surface

| Task | Codex | Claude Code |
| --- | --- | --- |
| Signed-in Chrome work: portals such as Xero, bill payment, Codex settings, GitHub UI | `@Chrome`, Nathan's real Chrome with its tabs, sessions, cookies, and extensions | Claude in Chrome (`mcp__claude-in-chrome__*`) |
| Local or public page: a dev server, Storybook, a supplied URL | `@Browser`, the in-app browser | Claude in Chrome |

- Claude Code without browser tools: stop and ask Nathan to relaunch with
  `--chrome`.
- Codex `@Chrome` unavailable for a signed-in task: stop and ask Nathan to
  connect Chrome. `@Browser` has none of his sessions, so it is not a
  substitute for signed-in work.
- A skill that names its own surface keeps it: `timesheets` uses `@Browser`
  unless Nathan asks for `@Chrome`.

## Boundary

- Nathan completes sign-in, 1Password, CAPTCHA, passkey, device-trust, and
  recovery prompts. Resume only after he returns the same visible tab.
- Stay in the visible task tab, plus a child tab the task workflow opens in
  the same native browser.
- Take a fresh page observation after navigation, page replacement, or any
  action that can invalidate earlier references.
- Keep credentials, cookies, authentication-bearing URLs, browser identifiers,
  and screenshots out of checkpoints, receipts, and notes.
- The Harness owns attachment. Never copy, enumerate, or attach to a Chrome
  profile directory yourself.

## Generic tooling

Agent Browser, Playwright, MCPorter, and the `chrome-devtools` MCPorter entry
stay for their own consumers (OpenCode agents, Connectors, VS Code). They are
not entry points for the tasks above.
