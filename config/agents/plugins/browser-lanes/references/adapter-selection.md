# Adapter selection

This reference owns proposed task selection, not lane admission. Read
[`lane-entry.md`](lane-entry.md) first. These defaults are not measured speed,
token, cost, or reliability claims.

## Inputs and choice

Record the desired outcome, explicit engine constraint, lane and account role,
page on the declared site, next operation, target evidence, required output,
continuity need, and whether the task reads, changes controls, captures a
visual, extracts DOM data, diagnoses, or needs human work. Ask only when
missing identity, authorization, or target changes the route.

In free mode, apply the capability choice below and invoke the selected
adapter's public `browser-lane` command directly. Agent Browser, Playwright, and
Puppeteer establish their own one-use relay handoff and site guard; they do
not require a Chrome DevTools `list_pages` call first. Use the generic
Chrome DevTools route when its capabilities are the selected fit, and list tabs
only when the task itself needs tab inventory.

| Need | Preferred adapter | Advantage | Limitation |
| --- | --- | --- | --- |
| Read an admitted page, find ordinary controls | Agent Browser | Scoped snapshots and semantic find support bounded observation. | Fresh batches cannot reuse refs. |
| Supported forms or keyboard and drag interaction | Playwright CLI | Structured plans expose the supported interaction set. | Page scripts require schema 2; no host run-code, test runner, or unsupported flags. |
| Fixed JSON records for title or known text | Puppeteer | The helper emits one record per action and rechecks page binding. | Fixed reads plus opt-in page evaluation; text is `textContent`. |
| Console or network diagnostics | Chrome DevTools MCP | Page-scoped tools target debugging questions. | No historical or multi-call continuity promise. |
| Screenshot candidate | Agent Browser, or compatible current DevTools use | Vendor mechanics describe visual capture. | Exact local form and output remain unqualified. |
| Bounded read-only custom DOM JSON | Chrome DevTools MCP | Its documented evaluation can return JSON-serializable values. | Schema and result bounds need qualification. |
| Trace or multi-call request inspection | No qualified route | None. | Do not promise tracing continuity or use default reload behavior. |
| Tabs, credentials, profile or permission changes, host scripts | No adapter | A stop preserves the identity and custody boundary. | Stop for human or separately approved work. |

For authored DOM/framework JavaScript through the assigned adapter, read
[scripts.md](scripts.md).

Honor an explicit eligible engine. Otherwise choose required capability, then
continuity. Retain an eligible current adapter. Prefer Agent Browser for the
initial snapshot, ordinary controls, and observed in-page link activation.
After that activation, re-snapshot the exact destination before further
actions. Route a mixed task in bounded phases with fresh admission between
phases. Raw navigation and new-page helpers remain outside every adapter route.
For one observed no-effect failure with verified authority and custody, use the
step's ordered fallback only; prove its exact success, then return later
ordinary steps to Agent Browser. Unknown Insert, Save, Delete, or Submit
effects stop for inspection.

An upfront capability gap can return to the router for another eligible adapter.
Permission and custody failures stop. After an uncertain action error, inspect
the outcome before retrying or switching; never replay a possibly completed
effect. Missing dependencies need a repair proposal, not installation fallback.

## Limits that change a choice

- Puppeteer `wait SELECTOR` proves presence only. `click SELECTOR` uses the
  first match. `text SELECTOR` returns `textContent`, not guaranteed visible
  text. No locator readiness, visibility, uniqueness, enabled-state, or
  stability guarantee exists.
- DevTools `get_network_request` can expose Cookie or Set-Cookie data, bodies,
  and sensitive URLs. Start with bounded summaries and disclose their sensitivity.
  Do not use caller `pageId`, `pageIdx`, or `select_page`; the lane injects a
  fresh page ID for one page-scoped call.
- Agent Browser and Playwright sessions are fresh. Use an observed semantic or
  CSS target. Never predict or carry an `eN` or `@eN` reference into another
  invocation.
- A click can report success and change nothing. Verify state after every
  activation. When a click no-ops, move focus with a supported keyboard plan
  (`Tab`, `Shift+Tab`, `Enter`) and confirm the focused control before
  `Enter`; consent pages place the intended low-emphasis link beside a
  prominent button. A stale reference that reports the element gone means
  re-observe, never retry the same reference.

## Worked cases

| Request | Proposed result |
| --- | --- |
| Summarise an admitted article | Agent Browser with a bounded content read. |
| Fill title, select Draft, tick Preview | Playwright CLI with observed role, label, or CSS targets. |
| Return title and status as JSON records | Puppeteer fixed reads. |
| Wait for hidden Submit then click | Stop: Puppeteer wait is not readiness proof. |
| Screenshot using Puppeteer | Explain its plan has no screenshot action; preserve an explicit engine choice. |
| Find failed requests | DevTools bounded summaries when available; do not dump authenticated detail. |
| Trace checkout | Stop: continuity and non-reloading form are unqualified. |
| Failed managed-work access, try another engine | Stop at the access layer. |
| Retry Save after timeout with another engine | Inspect outcome before any replay. |
