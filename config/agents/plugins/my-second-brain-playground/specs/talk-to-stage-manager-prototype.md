# Talk to Stage Manager prototype

## Outcome

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
| Fresh Terra Low Desktop, ambiguous `1` selector | Returned five routes across the local machine and both saved remote profiles, then asked one clarification question. No message was sent. | Task `01a08a3d-c7d6-7ee3-92c8-6b60acc42646`; three model tool calls; discovery 0.50 seconds wall time and 1 second reported; 40.25 seconds total. |
| Repeated request in one Desktop task | Revalidated the remembered coordinator directly, sent once, and returned a fresh answer without rerunning global discovery. | One shell block; about 30.3 seconds; zero duplicate submissions. |
| Busy coordinator | Observed working state, waited for the earlier turn to settle, sent once, and correlated the new answer. | Discovery 1.24 seconds; coordinator wait 10.74 seconds; prompt to answer 25.03 seconds; 102.83 seconds end to end. |
| Coordinator replacement in the same pane | Detected `replacement-coordinator-a` had become `replacement-coordinator-b` before any effect, reran discovery and retained the replacement. | Task `01a08a2e-487f-7b51-befe-2c8dc9c4558c`; one completed read-only shell block after one rejected attempt; recovery 4.366 seconds; no message sent. |
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

## Delivery state

- Implemented, tested, committed and pushed on `codex/coordinator-discovery`.
- Draft pull request: `#134`.
- Not installed or activated in the live Codex plugin cache.
- Fresh `$` selector discovery and a post-install voice interruption test remain
  unqualified.
- Remote discovery is exercised. Remote messaging is not exercised because no
  remote coordinator was available during this qualification.

The playground package intentionally does not own a separate `bun run dev`
lifecycle. My Second Brain development mode is the intended canonical plugin
development path, and a user-scope production installation is valid input to
that lifecycle. The current command is checkout-local: it reads its own
`plugin.config.json`, runs its own build and stages its own `plugin/` payload. It
has no external plugin-source argument, so it cannot yet target this dotfiles
payload directly. This is a workbench portability gap, not plugin
incompatibility. Do not bypass that direction with a playground-specific
installer or direct Harness-cache edit. Live Codex plugin listing is also
currently blocked by the separate stale `my-second-brain-dev` marketplace.

## Recommended next slice

Keep the prototype source-qualified while the canonical workbench gains an
external-plugin seam through the Agent Plugin Kit. Then target this payload,
preview one candidate hash and request approval for the live profile transition.
After installation, prove direct `$talk-to-stage-manager` discovery in a fresh
Terra Low Desktop task and repeat the voice interruption case. This is plugin
delivery work; it does not require more startup text.
