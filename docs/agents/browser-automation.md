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

- Start with the existing authorized private VPN route. Resolve the execution host,
  app command/version, port and process owner. Verify the viewing device's route,
  DNS and firewall access. VPN membership does not authorize employer data on
  personal devices.
- Treat `localhost` as the viewing device itself. Keep app backends on loopback
  behind an existing proxy bound to the intended private interface, or qualify an
  explicitly authorized direct listener and firewall scope. Discover the existing
  owner before proposing setup. Do not widen listeners to all interfaces or add
  web-app WAN port forwarding automatically.
- Choose HTTP or HTTPS for the app's requirements. Use HTTPS for secure-context
  or authentication requirements. Verify its certificate name and device trust.
  A VPN provides neither HTTP proxying nor certificate issuance. Keep certificate
  installation and trust changes under their separate authority.
- Prefer one owned port at `/` per app. Qualify subpaths through the app's
  base-path support. Check assets, deep links, API/auth URLs and live-reload
  WebSocket from the viewing device. Use the installed app version's
  [Vite](https://vite.dev/config/server-options) or
  [Storybook](https://storybook.js.org/docs/api/main-config/main-config-core)
  settings; retain exact host/origin validation.
- Reuse Herdr Projects' native review/board owner and access gate. Resolve its
  host, executable and version. Native local/Tailscale links do not establish
  WireGuard integration. Qualify a VPN/proxy compatibility route, including
  absolute links, before reporting it working.
- Use [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) only
  when that authorized route is selected. Inspect installed help, prerequisites
  and existing mappings; preserve other owners' routes. Stop at consent or
  uncertain outcomes and inspect before retrying. Funnel/public exposure and
  access-policy changes require separate explicit authority.
- Report the verified URL and owned process/proxy custody. Follow the global Mac
  awake rule. Retain the preview only when requested; otherwise stop only owned
  processes and remove only exact owned mappings after readback. Recheck other
  routes. Follow the browser route above to open the link.

## Generic tooling

Agent Browser, Playwright, MCPorter, and the `chrome-devtools` MCPorter entry
stay for their own consumers (OpenCode agents, Connectors, VS Code). They are
not entry points for the tasks above.
