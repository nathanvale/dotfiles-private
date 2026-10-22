# Talk to Stage Manager prototype

## Outcome

The 18 October 2026 revision below supersedes the original transport and
monitoring behavior. Earlier qualification remains evidence of the original
prototype only.

## Native project routing revision, 18 October 2026

Nathan authorized updating the existing Desktop routing skill and testing it
with the Bestie Book coordinator. Keep Desktop as a conversational proxy bound
to one host, Herdr session socket and exact native project key. Use installed
`herdr-projects coordinator --project <repo> tell` for submission, `where --json`
for request receipt and native status JSON for fresh replies. Preserve raw
Herdr agent messaging as an explicit legacy fallback.

Acceptance for this revision:

- Resolve the existing native project coordinator without starting another.
- Submit one tagged, read-only Bestie route probe through its native queue.
- Verify the request receipt, matching fresh reply and stable coordinator
  identity; do not count an old reply or terminal echo as success.
- Document bounded polling for one reply, authorized same-chat or explicitly
  requested standalone scheduled checks, and an explicitly requested Goal for
  active outcomes.
- Preserve route, authorization and receipt correlation across voice and typed
  requests, including interruption recovery without duplicate submission.
- Configure a separate watcher's requested model and effort in scheduler fields
  and verify the first run's actual native metadata separately from configuration.
- Keep the reviewed third-party Herdr skill and existing discovery script
  unchanged. Source qualification does not establish installation or fresh-chat
  activation.

The shared [Herdr route](../../../../../docs/agents/herdr-control.md) reaches the
updated skill without adding always-loaded startup instructions.

### Native route qualification, 18 October 2026

An explicit source-skill trial on the Mac Mini resolved the existing Bestie Book
coordinator and submitted one tagged, read-only request through native `tell`.
The native queue recorded one request. A fresh answer was correlated with the
same coordinator's session trace. Later coordinator updates replaced the
latest status answer before polling observed it, so queue acceptance alone was
insufficient. The skill documents the bounded trace fallback and uses native
task records for durable progress checks. The trial created no worker, schedule
or Goal. Skill validation, link checks and whitespace checks passed.

This qualified explicit source use and a native round trip. It did not qualify
installed-skill discovery, automatic monitoring or live voice interruption.
The private trial receipt remains with the routing trial's runtime state;
[PR 196](https://github.com/nathanvale/dotfiles-private/pull/196) records the
source review and integration history.

### Separate watcher and input parity revision

Nathan subsequently requested a separate Bestie Book watcher every five minutes
with GPT-6 Luna and low reasoning, first-run model verification, and this
Desktop chat retained as the voice interface. The same skill now covers typed
and spoken requests, pending-request recovery across mode changes, and explicit
scheduler model selection. This changes branch-level guidance only; there is
no additional always-loaded startup text or invocation-policy change.

The requested watcher was configured with its saved cadence, model and effort.
Its first run connected and saved a private baseline. Foreground inspection of
that run's native thread metadata confirmed `gpt-6-luna` with `low` effort;
the watcher could not verify its own runtime settings. Nathan later paused it,
and the saved state was checked. This is historical first-run proof, not a
guarantee for later runs.

A fresh Desktop chat explicitly loaded the candidate source, verified the
existing native coordinator and sent a status question and Nathan's material
selection through the verified route. Fresh answers matched both requests.
These typed exchanges qualified source behavior in a fresh chat; installed-skill
discovery and live voice interruption remained unqualified. Private receipts
for these trials stay with their runtime owner.

## Original prototype outcome

Let Nathan address an existing Herdr project coordinator by a short tab name
from Codex Desktop, voice, another Herdr pane, or the coordinator pane itself.
Keep work with the coordinator while the caller remains a small conversational
proxy.

## Boundary

- Discover running local Herdr sessions and every enabled saved remote machine
  profile.
- Select by an exact first token or quoted phrase after the skill invocation.
- Accept one unique match; ask one question for multiple matches.
- Retain the selected route and revalidate its agent identity before effects.
- Send one request and correlate it with one fresh answer.
- Recommend Terra Low only to a proxy. Never change the model automatically.
- Do not launch agents, choose workers, route through Foundry, repair machine
  profiles, or persist a global default coordinator.

## Implementation

`talk-to-stage-manager` owns the conversational workflow. Its read-only
`discover-coordinators` command returns one JSON envelope containing matched
machine, session, workspace, tab and pane-bound agent state. The startup
instruction contains only the cross-project route to the owned Herdr guidance.
The reviewed third-party Herdr skill remains byte-identical.

## Live qualification

All tests used the branch source by an explicit skill link. They did not install
or activate a new plugin cache.

| Case | Observed result | Tool and latency evidence |
|---|---|---|
| Fresh Desktop, unique `ADHD` selector | Selected the live ADHD Development Workflow coordinator, acted as a proxy, recommended Terra Low without claiming the current proxy setting, submitted once and returned the fresh answer. | Discovery 1.33 seconds; end to end about 22.8 seconds; one read-only destination shell block; zero duplicate submissions. |
| Herdr coordinator pane | Detected self and did not message itself or recommend Terra Low. | Four model tool calls; discovery 1 second; 21 seconds total. |
| Different pane in the same Herdr tab | Detected proxy, selected the coordinator rather than the helper, and recommended Terra Low. | Four model tool calls; discovery 1 second; 72 seconds total. |
| Fresh Terra Low Desktop, ambiguous `1` selector | Returned five routes across the local machine and both saved remote profiles, then asked one clarification question. No message was sent. | Three model tool calls; discovery 0.50 seconds wall time and 1 second reported; 40.25 seconds total. |
| Repeated request in one Desktop task | Revalidated the remembered coordinator directly, sent once, and returned a fresh answer without rerunning global discovery. | One shell block; about 30.3 seconds; zero duplicate submissions. |
| Busy coordinator | Observed working state, waited for the earlier turn to settle, sent once, and correlated the new answer. | Discovery 1.24 seconds; coordinator wait 10.74 seconds; prompt to answer 25.03 seconds; 102.83 seconds end to end. |
| Coordinator replacement in the same pane | Detected `replacement-coordinator-a` had become `replacement-coordinator-b` before any effect, reran discovery and retained the replacement. | One completed read-only shell block after one rejected attempt; recovery 4.366 seconds; no message sent. |
| Not found | Returned `not_found` with no matches. | Fifteen live tabs searched; retry safe; no side effects. |
| Remote profiles unavailable | Returned `incomplete`, retained the local match and named each unreachable profile. | Two deliberately failed SSH profiles; retry safe; no side effects. |
| Missing dependency | Returned structured `dependency_missing` for `jq` and `herdr`. | Exit 69; no side effects. |

## Defects found during qualification

- Generated Desktop task titles initially overrode the user's selector. The
  skill now binds the first supplied token or quoted phrase and forbids title,
  path or account inference.
- SSH consumed the machine-profile loop input after the first profile. Each SSH
  command now reads from `/dev/null`; both saved remote profiles are searched.
- The missing-`jq` error path initially required `jq`. It now emits its static
  error envelope without that dependency.

## Delivery evidence at original qualification

- The [live qualification table](#live-qualification) records the original
  prototype's observed results.
- That source qualification did not establish installation or activation in a
  fresh Desktop chat.
- Fresh `$` selector discovery and a post-install voice interruption test remain
  unqualified.
- Remote discovery is exercised. Remote messaging is not exercised because no
  remote coordinator was available during this qualification.

The playground package intentionally does not own a separate `bun run dev`
lifecycle. My Second Brain development mode is the intended canonical plugin
development path, and a user-scope production installation is valid input to
that lifecycle. At that qualification, the command was checkout-local: it read
its own `plugin.config.json`, ran its own build and staged its own `plugin/`
payload. It had no external plugin-source argument, so it could not target this
dotfiles payload directly. This was a workbench portability gap, not plugin
incompatibility. Do not bypass that direction with a playground-specific
installer or direct Harness-cache edit.

## Recommended next slice

Keep the prototype source-qualified while the canonical workbench gains an
external-plugin seam through the Agent Plugin Kit. Then target this payload,
preview one candidate hash and request approval for the live profile transition.
After installation, prove direct `$talk-to-stage-manager` discovery in a fresh
Terra Low Desktop task and repeat the voice interruption case. This is plugin
delivery work; it does not require more startup text.
