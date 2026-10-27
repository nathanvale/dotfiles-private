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

## Native capture density

- For genuine DPR 2 proof, use qualified native window sizing and default
  density. On 20 October 2026, the supported viewport override changed observed
  DPR from 2 to 1 on both laptop and Mini. Keep that override unqualified for
  this proof until revalidated after tool updates.
- Measure CSS viewport, `devicePixelRatio` and `visualViewport.scale` before and
  after any viewport change.
- Accept a capture only when the required CSS size, DPR, visual scale and
  original encoded image pixel-to-CSS correspondence all match.
- On mismatch, restore owned prior state and report the gap. Keep originals;
  do not upscale, emulate density or relabel a 1x capture as genuine 2x.

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

### Nathan's home route

For Ovis and Home Assistant, start at the canonical vault's
[Home web access](../../../my-second-brain-playground/systems/home-web-access.md)
note. It owns the approved hostnames, private/public login behavior, runtime
configuration locations and verification boundaries. Resolve the vault through
`$HOME/.config/context/vault.md` if the adjacent checkout is unavailable.
Read that setup before changing DNS, proxies, certificates or login protection;
inspect the named runtime owners before treating recorded state as current.

Nathan already uses WireGuard on his UniFi home router. Its
[VPN server settings](https://192.168.1.1/network/default/settings/vpn/server)
are the existing configuration owner.

- Home-LAN access may not need a VPN. For remote access, use an existing
  authorized client route on the device making the connection, including the
  execution host when needed. Verify routing, DNS and firewall access to the
  actual Mini/app; do not infer addresses or client configuration. VPN access
  does not expose loopback listeners.
- Inspect router settings read-only through native Chrome in the current
  personal profile. Hand login to Nathan.
- Keep network effects in the foreground session. Obtain appropriate
  authority before creating or importing peers, changing router rules or
  certificate trust, replacing a VPN, or starting sharing. Preserve other Mini
  apps. Keep keys, configuration files, QR codes and credentials out of source
  and receipts.

## Generic tooling

Agent Browser, Playwright, MCPorter, and the `chrome-devtools` MCPorter entry
stay for their own consumers (OpenCode agents, Connectors, VS Code). They are
not entry points for the tasks above.
