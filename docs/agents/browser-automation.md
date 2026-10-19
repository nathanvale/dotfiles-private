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
- A skill that names its own surface keeps it. `timesheets` uses personal
  `@Chrome` for the Friday workflow.

## Boundary

- Nathan completes sign-in unless he has authorised the workflow's
  exact allowlisted username/password login. That scoped exception is owned by
  [one-password login reference](../../config/agents/plugins/personal/library/one-password/references/browser-login.md).
  CAPTCHA, MFA, passkey, device-trust and recovery remain human handoffs.
- Stay in the visible task tab, plus a child tab the task workflow opens in
  the same native browser.
- Take a fresh page observation after navigation, page replacement, or any
  action that can invalidate earlier references.
- Keep credentials, cookies, authentication-bearing URLs, browser identifiers,
  and screenshots out of checkpoints, receipts, and notes.
- The Harness owns attachment. Never copy, enumerate, or attach to a Chrome
  profile directory yourself.

## Private previews

- Resolve the execution host, app command/version, loopback port and process owner.
  Keep the backend on `127.0.0.1`.
- Use private [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
  HTTPS for an authorized tailnet device. Check device access, MagicDNS, HTTPS
  readiness and the destination port's policy. Tailnet access does not authorize
  employer data on personal devices. Keep Funnel and access-policy changes under
  their separate explicit authority.
- Inspect the selected host's installed `tailscale serve --help` and current
  mappings before effects. Preserve other owners' mappings. Stop at consent or
  uncertain outcomes; inspect before retrying.
- Prefer one owned HTTPS port at `/` per app. Configure only the exact required
  host/origin. Qualify subpaths through the app's base-path support. Check assets,
  deep links, API/auth URLs and live-reload WebSocket from the viewing device.
  Use the installed app version's [Vite](https://vite.dev/config/server-options)
  or [Storybook](https://storybook.js.org/docs/api/main-config/main-config-core)
  settings; retain host validation.
- Reuse Herdr Projects' native review/board link owner. Resolve the actual host,
  executable and version before using its current CLI/docs. Preserve its access
  gate and shared server ownership.
- Report the verified HTTPS URL and task-owned process/mapping custody. Keep the
  host awake under the global Mac rule. At handback, retain the preview only when
  requested; otherwise stop only owned processes and remove only their exact
  mappings after readback. Recheck other mappings. Follow the browser route above
  when opening the link.

## Generic tooling

Agent Browser, Playwright, MCPorter, and the `chrome-devtools` MCPorter entry
stay for their own consumers (OpenCode agents, Connectors, VS Code). They are
not entry points for the tasks above.
