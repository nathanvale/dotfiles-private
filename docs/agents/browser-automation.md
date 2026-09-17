# Browser Automation

Classify the task first. An ordinary read-only request at one supplied public
URL uses the [quiet dedicated Agent Browser surface](#quiet-dedicated-agent-browser-surface)
directly. All other browser work reads the
[global mode](../../config/agents/plugins/browser-lanes/references/lane-entry.md#global-mode)
first. Nathan's temporary `free_mode` config routes any adapter directly
without admission and authorizes configuring All tabs in the declared profile.
The secured admission restrictions below apply only when free mode is false.

Route browser work through the declared profile lane before choosing an
automation engine. The lane owns identity, trust, extensions, downloads,
admission, and exclusive custody. The engine owns how the admitted page is
observed or operated.

This guide owns machine lane identities and security boundaries. Three
similar names have distinct owners:

| Name | What it is | Owner |
| --- | --- | --- |
| `browser-lane` | The executable: lane list, health, inspect, engine runs, recovery | `bin/browser-lane`; contract in `browser-lane --help` |
| `browser-lanes` | The versioned personal plugin carrying the `browser-use` entry skill and four adapter skills | `config/agents/plugins/browser-lanes`; discover through the Harness, source presence is not installation |
| `browser-use` | The entry skill: task classification, lane routing, admission handoff, engine choice, recovery workflow | [`browser-use/SKILL.md`](../../config/agents/plugins/browser-lanes/skills/browser-use/SKILL.md) |

Enter through `browser-use`. It applies the shared
[lane entry](../../config/agents/plugins/browser-lanes/references/lane-entry.md)
gates, then hands off to exactly one adapter skill:
[`agent-browser`](../../config/agents/plugins/browser-lanes/skills/agent-browser/SKILL.md),
[`playwright`](../../config/agents/plugins/browser-lanes/skills/playwright/SKILL.md),
[`chrome-devtools`](../../config/agents/plugins/browser-lanes/skills/chrome-devtools/SKILL.md),
or [`puppeteer`](../../config/agents/plugins/browser-lanes/skills/puppeteer/SKILL.md).
The [adapter selection](../../config/agents/plugins/browser-lanes/references/adapter-selection.md)
reference owns that choice; each adapter names its one public `browser-lane`
command. Raw MCPorter calls and direct full-profile attachment are not lane
entry points.

## Quiet dedicated Agent Browser surface

Use this surface for an ordinary bounded request that reads one supplied
public URL without sign-in: open a page, report its heading, its text, or
where its links point. The task surface is that exact URL, the requested read,
and the dedicated profile below; state it before the first browser command.
Nathan supplies the URL and the read; everything below is fixed configuration,
not a question for him. Sign-in, credentials, a page write, tab or profile
management, dashboard work, an extension, or a daily Chrome identity returns
the request to `browser-use` for an eligible declared lane or stops. This
surface is never a fallback for a refused or failed lane task.

It is a direct-upstream exception outside Browser Lanes, qualified on
17 September 2026. Proof:
`projects/browser-automation/proofs/quiet-agent-browser-profile.md` at commit
`db9e7eed` on `main` of `$HOME/code/my-second-brain-playground`; read it from
that commit, since a side-branch checkout there can show an older draft.
Every command uses unchanged upstream `agent-browser` 0.34.0 with this
flag-only prefix and one short task-named session:

```sh
agent-browser --namespace qab-quiet-profile --session TASK \
  --profile /Users/nathanvale/.local/share/my-second-brain-playground/browser-automation/profiles/quiet-agent-browser \
  --executable-path '/Users/nathanvale/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' \
  --pin-tab --json COMMAND
```

- `--executable-path` pins Google Chrome for Testing 145.0.7632.6; default
  discovery would substitute the daily Chrome bundle.
- The absolute `--profile` path is passed straight to Chrome as its user data
  directory: nothing is copied and daily Chrome `Local State` is never read.
- `--namespace` keeps sockets and state under
  `~/.agent-browser/namespaces/qab-quiet-profile`, apart from Browser Lanes
  files. `--pin-tab` turns a lost tab into a typed error. Keep the default
  headless launch.
- `agent-browser --help` owns command syntax; it is client-only and launches
  nothing. `--allowed-domains` is rejected with `--profile`, so this surface
  has no upstream network containment.

Journey: record `agent-browser --version` and the executable's `--version`;
a drift from the pinned versions stops before launch. `open` the supplied URL,
read with `get` or `snapshot`, keep `tab list` or `session info` output as
inspection evidence, and end with `close`, including after a refusal or an
abort. `close` ends the daemon and browser; the profile directory and the
namespace sidecars persist by design. Confirm cleanup with `session list` a
moment after `close`; the daemon can outlive `close` by about one second.

Refusal: a failed navigation leaves the pinned tab at
`chrome-error://chromewebdata/`. Recover with one explicit reopen of the last
known target, then verify with `get url` or `tab list`. Never replay a write.

Boundary: the profile is dedicated automation state. Never attach, copy,
inspect, or modify Nathan's daily Chrome profile. A bare `--profile` name,
`agent-browser profiles`, `--auto-connect`, and `--cdp` read or attach daily
Chrome; `install` downloads a browser and `doctor` runs a live launch test, so
both need separate authority.

## Lanes

| Lane | Chrome profile | Relay | Use |
| --- | --- | ---: | --- |
| `daily-driver` | Configured personal profile | Configured loopback relay | Authenticated daily browsing |
| `work` | Configured managed profile | Configured loopback relay | Managed work identity |

Keep profile display names, internal directories, and relay ports in untracked
machine-local configuration. Use them only for diagnostics and route verification.

- Follow [lane entry](../../config/agents/plugins/browser-lanes/references/lane-entry.md)
  for task-tab admission, selected-target checks, and preservation of existing
  sharing state.
- Run work serially within each lane, including unrelated personal tasks in
  `daily-driver`.
- Give concurrent work another declared lane. A Chrome visual pin or Agent
  Browser PinTab does not make simultaneous agents safe inside one profile.
- Add a profile and relay only for a new identity, trust, extension,
  download-owner, recovery, or genuine concurrency boundary.

## Start

Follow the router above. `list`, `health`, and `inspect` reveal no browser
content or account identifier. `inspect` distinguishes authenticated transport,
visible inventory, exact-target match, and selected-page readiness; it never
infers stored grants from page counts. Health requires a fresh authenticated
access-status snapshot: unavailable evidence fails the route; disabled access or
a transition fails the baseline; All tabs fails the baseline only when `free_mode`
is false. `effective_policy_check_unavailable`
remains an unfinished automatic check. See `browser-lane --help` for command,
output, exit, and recovery contracts.

Use `browser-lane open --lane NAME --account-role ROLE --page-url URL --json`
to prepare the task tab in the declared existing Chrome profile. Opening
checks the registry and local profile identity, then uses bounded native
URL-metadata inspection to reuse an exact tab before requesting a new one;
it does not require OpenClaw, relay health, an admitted tab, or an adapter. Its
result reports Chrome dispatch separately from visible verification,
authentication, and automation readiness. The native check briefly switches
tabs inside the unique profile window, then focuses the match or restores the
original selection. Ambiguous profiles, duplicate matches, hidden tabs, and
unavailable metadata refuse opening. Selection restoration after interruption
is best-effort. No page content or grants are accessed. After an uncertain
result, inspect the visible profile before retrying. Use
`BROWSER_LANE_OPEN_BIN` only as a process-scoped explicit opener override.

Use `browser-lane agent-browser --lane NAME --account-role ROLE --run-id ID
--page-url URL -- "COMMAND" ...` for the Agent Browser route. The lane uses the
installed MCPorter only when it advertises both `chrome-relay exec` and
`chrome-relay status`; otherwise it selects the executable built by
`$HOME/code/mcporter`. Use `BROWSER_LANE_MCPORTER_BIN` only as a process-scoped
explicit override.

Use `browser-lane playwright --lane NAME --account-role ROLE --run-id ID
--page-url URL --plan /absolute/private/plan.json` for accessibility snapshots,
locator semantics, and in-page Playwright actions. The plan must be a regular,
non-symlink mode-600 JSON file. Use current CLI help for its schema and
allowlist. Do not put authentication material in a plan. Human and 1Password
entry remain visible computer work.

Use `browser-lane puppeteer --lane NAME --account-role ROLE --run-id ID
--page-url URL --plan /absolute/private/plan.json` when a task needs
Puppeteer's fixed page API. The plan has the same file, schema, and
authentication rules as a Playwright plan. Its own allowlist, per-action JSON
output, timeout, page-binding, and disconnect contracts belong to
`browser-lane --help` and the executable owner.

Follow [lane entry](../../config/agents/plugins/browser-lanes/references/lane-entry.md)
for visible task-tab preparation, attended sign-in, permission repair, and
handoff recovery. That reference owns the procedure. Its exact-page
continuation and adapter paths preserve unrelated admitted tabs and sharing
state. Visible computer control handles human-only work; `browser-lane`
retains automation custody. The human owns the OpenClaw grant.

## Security and lifecycle

- Fail closed unless the profile directory, account role, extension, and relay
  match the lane registry. Relay health requires exactly one current-user
  `node` listener on the declared IPv4 loopback port before the authenticated
  MCPorter probe runs.
- Keep the persistent OpenClaw relay key inside MCPorter. Third-party clients
  receive only a random, one-use loopback handoff credential.
- Never run `openclaw browser extension cdp --json` or print relay process
  arguments as a diagnostic; both can expose the relay credential. Use
  `browser-lane health` and `inspect`.
- Keep passwords, passkeys, one-time codes, CAPTCHA, device trust, account
  recovery, and first login with Nathan at the computer.
- Treat visible tab preparation and tab admission as separate capabilities.
  Computer control may open and focus the user-requested page; only Nathan's
  OpenClaw click admits it to browser automation.
- During attended login, keep the token in its private task-owned file and keep
  every credential inside the visible 1Password extension. Use an ordinary
  application URL for pre-admission start, never an identity-provider callback
  or authentication-bearing URL. Open and stale
  handoffs block targeted inspection, adapter runs, recovery creation/expiry,
  and another open. `handoff resume` owns the post-login exact-page permission
  check and human grant repair. List, health, inventory-only inspection,
  handoff status, and recovery verification remain available.
- A handoff coordinates callers that obey `browser-lane`; current OpenClaw and
  MCPorter interfaces expose no attached-client inventory, so it cannot prove
  continuous exclusion of arbitrary same-user clients that bypass the router.
- A pre-admission opener failure or signal leaves the reservation active and
  preserves the token file with an uncertain-effect result. Inspect the
  visible profile before using that file to resume or release; never replay
  the opening blindly.
- For a lost token, use the lane-entry reference's explicit recovery workflow.
  Preview the exact reservation, obtain operator authority, and execute against
  that fingerprint under the lane lease with audit evidence. Recovery aborts
  the reservation; it does not grant browser access.
- Keep authentication state inside its Chrome profile. Never copy cookies or
  login state between lanes.
- Agent Browser keeps one run-scoped session inside one authenticated MCPorter
  handoff. Secured mode attaches unpinned to the admitted page on the declared
  site. Free mode reads the adapter's own tab inventory and selects the unique
  page on that site. Both modes then enable `--pin-tab`, guard the site before
  and after each batch item, and retire that session before the handoff exits.
  It creates no normal-path `about:blank` target. Ambiguous attachment,
  unreadable or mismatched site, or unprovable retirement remains typed and
  fail-closed; it closes no unrelated tab.
- Read popup and side-panel activity as a profile-wide advisory, never exact-tab
  ownership or lease availability. Retained results separate command outcome
  from session cleanup; cleanup does not undo page edits. Unknown stays unknown
  when the runner supplies no result. Use `browser-lane --help` for scenario grouping.
- Playwright snapshots the private plan before acquiring custody. It requires
  the selected page to remain the unique page on the declared site before and
  after each action; unrelated pages remain untouched. Host-side hashing
  guards the site. Caller scripts run only in page evaluation. The runner
  checks structured vendor errors, bounds work by the requested TTL, and
  retires its command and daemon process groups before the relay handoff
  exits. Cancellation reaches the helper through the public command. Clean
  detach and forced retirement remain distinct outcomes; it never calls
  `close` on the external profile.
- Puppeteer snapshots the private plan before acquiring custody, rechecks the
  unique page identity and site digest before every action, and leaves
  unrelated pages untouched. A changed, gone, duplicated, or closed target
  exits 16. It disconnects before MCPorter's one-use handoff exits and never
  calls Puppeteer `close` on the external Chrome profile. An unprovable
  disconnect after success exits 17. A signal to the public command is
  forwarded to the handoff, and the lease is released only after the helper is
  gone.
- Before destructive profile work, create and verify a bounded recovery
  blueprint with `browser-lane recovery`. The blueprint contains no Chrome
  authentication state.

## Recover

Follow the router's permission-aware recovery. An unadmitted exact page follows
the admission handoff in the plugin's `lane-entry.md`; the human click is the
permission boundary. Verify the exact existing
profile before proposing a tab-sharing change; obtain approval before changing
it. An empty inventory proves neither a wrong profile nor zero stored grants.
No automatic profile, account, extension, download, authentication, or sharing
repair is authorized by a failed diagnostic. Dead-owner recovery remains
subject to lease expiry. Current automatic OpenClaw "Use local OpenClaw"
targets Gateway, so standalone repair requires approved manual pairing with no
credentials in outputs. Re-run health after an approved baseline change.
