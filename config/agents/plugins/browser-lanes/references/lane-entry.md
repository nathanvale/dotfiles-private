# Lane entry

Read `$HOME/code/dotfiles/docs/agents/browser-automation.md` for the declared
lane identities, security boundaries, and recovery ownership. Read
`browser-lane --help` for current syntax, plan schemas, action allowlists, exit
codes, and cleanup. Those owners take precedence over this reference.

## Global mode

Read `${XDG_CONFIG_HOME:-$HOME/.config}/browser-lanes/config.json` before browser
work. A missing file means secured mode. Require a JSON boolean `free_mode`;
report invalid configuration instead of guessing. Re-read it before each run.

When `free_mode` is `true`, use the free workflow below instead of the secured
admission and adapter restrictions in this plugin and the machine guide.
Nathan explicitly enabled this temporary policy on 14 September 2026.

1. Resolve the declared lane and account role with `browser-lane list --json`.
2. Use OpenClaw's All tabs mode in that exact profile. If it is still Selected
   tabs, use visible UI to set All tabs in the extension's options. This config
   authorizes that change; proceed without a tab grant or another confirmation.
   Honor disabled access and an explicit Stop.
3. Run `browser-lane run --lane NAME --account-role ROLE --run-id ID -- mcporter
   call chrome-devtools.TOOL ...`. Read `mcporter list chrome-devtools --schema`
   for actual tool inputs. Start with `list_pages`, use its current page IDs,
   and navigate, create, select, read, or operate tabs as the task requires.
   Omit `--page-url`; free mode passes tool inputs through without target injection.
4. Keep actions within the user's task and declared profile. Serialize work in
   each lane. Verify uncertain effects before retrying. Keep credentials in the
   browser. Free mode removes lane admission restrictions, not task authority.

The plan adapters retain their existing schemas. For work beyond those schemas,
use the free Chrome DevTools route above, including page scripts. Do not stop
for the secured adapter's action allowlist or human tab-admission handoff.

When `free_mode` is `false`, follow the secured workflow below. If OpenClaw is
still in All tabs mode, use visible UI to restore Selected tabs before health.
The wrapper immediately rejects All tabs in secured mode; the config does not
change extension storage by itself. Existing individual tab grants remain.

## Gate every adapter (secured mode)

Serialize commands for the same lane, including read-only inspections. On a
retry-safe busy refusal, wait for the competing command to finish and retry
once using the same inputs. Persistent or non-retry-safe failures follow the
CLI's recovery text; do not interpret ordinary contention as a sharing failure.

1. Run `browser-lane list --json`; select the declared lane and matching
   account role. Derive lane metadata from the machine guide and CLI, not this
   reference. Keep Xero serial with other daily-driver work.
2. Run `browser-lane health --lane NAME --json`. Continue to exact-page
   inspection when the command exits zero with `status: ok`, `route: pass`, and
   `baseline: pass` or `baseline: warning`; retain every warning in the
   evidence. `effective_policy_check_unavailable` is a non-blocking proof gap
   on provisioned lanes. It does not prove effective policy or task-page
   access. Stop when health exits nonzero, route is not `pass`, or baseline is
   `fail`. Unavailable, All tabs, disabled, or transitioning access stops the
   route.
3. Run `browser-lane inspect --lane NAME --account-role ROLE --page-url URL
   --json` before an adapter action. Proceed only when exact-target
   `readiness` is `ready`. Any nonzero inspect result stops adapter work,
   including `page_list_unreadable`. Exit 16 can also identify an absent,
   mismatched, unselected, or ambiguous target; use its reported counts and
   readiness. A zero-match result with visible pages proves only that the
   requested URL did not match.
   Resolve the intended tab through [Navigation recovery](#navigation-recovery);
   never guess URL variants or automate a different admitted page. With no
   visible task tab, follow the admission handoff below. Missing role or URL
   requires clarification. Never use credentials or authentication-bearing
   URLs in commands.
4. Invoke only the adapter's stated public `browser-lane` command. It acquires
   custody and resolves the page afresh. Earlier readiness is not continuing
   authorization. Keep one owner and operate only the selected exact task page;
   preserve unrelated admitted pages and their grants.

`access_mode.observed` is a fresh point-in-time preflight result. Stored grants
remain `unknown`; an empty inventory proves neither zero grants nor the wrong
profile. Never retain page IDs, endpoints, or stale snapshot references.

## Navigation recovery

Before a planned navigation, observe its ordinary destination URL through the
admitted page when available. After navigation ends the old attachment, inspect
that exact observed destination and verify the action's effect before another
write. A predicted URL or an earlier run's draft ID is not an observation.

If the current URL remains unknown, use visible Chrome UI only after selecting
the exact declared profile window through metadata-only targeting. A tool that
automatically captures foreground content before window selection cannot serve
this recovery: it may expose another profile. Read only the intended tab's
ordinary address, then resume exact lane inspection. If scoped observation is
unavailable, request one handoff for the current non-secret task URL; preserve
the uncertain effect and existing admission. Never replay the mutation to
recover a URL. Stop or revoked access still ends browser work.

## Admission handoff

The human click is the permission boundary; an agent prepares the visible tab
but never grants itself access.

When the user has requested a specific site and the ordinary, non-secret URL
is known, run `browser-lane open --lane NAME --account-role ROLE --page-url URL
--json`. Follow the executable's native tab-reuse result: it prepares the task
tab in the exact declared Chrome profile without relay health, tab admission,
an adapter, or page-content access. A successful result still reports visible verification,
authentication, and automation readiness separately. After an uncertain
result, inspect the visible profile before retrying. Stop if the profile is
ambiguous or the requested URL contains authentication material.

When later automation needs admission, run health and name the profile from the lane table in
`$HOME/code/dotfiles/docs/agents/browser-automation.md`. The executable checks
that this declared display name still matches Chrome. Keep the profile
directory internal for route verification and troubleshooting; do not expose
it in an ordinary admission prompt. Reduce the requested page to its expected
scheme, host, and port. Then send one short prompt with these values
substituted:

> I opened `TASK` in the `DISPLAY_NAME` Chrome profile and left the tab
> focused.
>
> 1. Verify the address bar shows `ORIGIN`.
> 2. Open the OpenClaw extension in this same Chrome window.
> 3. Confirm it says `Connected` and `Selected tabs`.
> 4. Click `Allow on this tab`.
>
> Chrome may move the tab into the orange `OpenClaw` group; that means the tab
> is shared with the agent. Reply `done` when it is ready.

Wait after sending the prompt. An unexpected OpenClaw state stops the handoff;
ask the human to report it instead of changing it. OpenClaw moves an admitted
tab into its managed `OpenClaw` group; that group represents the grant.
Internal Chrome pages, incognito tabs, and tabs in another profile cannot be
admitted. Keep exact URLs, account identifiers, credentials, and page content
out of the prompt and diagnostics. A grant is not a lease.

After the human reports completion, run exactly one content-free
`browser-lane inspect --lane NAME --account-role ROLE --page-url URL --json`.
Continue only on `readiness` `ready`: one exact match, selected. Unrelated
admitted pages remain untouched. Absent, ambiguous, unreadable, unselected,
wrong-profile, or busy results stop with the executable's reported error and
recovery text. Do not repeat the handoff, retry, pair, restart, or switch
engines to route around the result.

## Attended login handoff

When resuming interrupted browser work, check `browser-lane handoff status
--lane NAME --json` first. An existing reservation belongs to its originating
task. Continue that task's pending human step and resume with its retained
private token file; another task should route the result back to that owner.
A missing token follows [Lost-token recovery](#lost-token-recovery).

A login wall is a different ceremony from ordinary tab admission. Reserve the
lane across the human interval; keep browser credentials in the visible
1Password extension and keep the profile unavailable to another compliant
agent.

For a requested sign-in at a known application, use the pre-admission path:

1. Choose an ordinary application URL with the intended scheme, host, and port.
   Use neither an identity-provider URL nor an authentication callback. Run
   `browser-lane handoff open --lane NAME --account-role ROLE --run-id ID
   --task-ref REF --page-url URL --nonce-output PATH --json`. Choose a new token
   absolute path inside a task-owned mode-700 runtime directory, with no symlink
   ancestors. The command creates the
   token file privately and writes the reservation before opening the declared
   profile. It contacts no relay and requests no
   tab grant. Retain the token file path in the current task. Pass that path to
   continuation commands; never read or copy the token into chat, command text,
   environment, logs, or messages to the human.
2. Tell the human that the lane is reserved and the application is open in the
   named profile. Ask them to sign in visibly with the 1Password browser
   extension and finish CAPTCHA, passkey, device-trust, recovery, Google, or
   Microsoft prompts. Provider redirects are human work outside router
   observation; they do not prove completion, and the reservation retains only
   the application origin supplied at start. Request no tab-sharing action
   before or during authentication.
3. Wait. Run neither targeted inspection nor an adapter while the handoff is
   `open` or `stale`. Expiry marks the reservation stale and preserves it.
4. When the human confirms they are back at the intended application, observe
   the exact ordinary task URL using the scoped visible-UI procedure in
   [Navigation recovery](#navigation-recovery). Keep targeted lane inspection
   held while the reservation is active; `handoff resume` owns that check.
   If no automation is needed, use `handoff release` with the token file and
   retire that file after confirmed release. Otherwise run
   `browser-lane handoff resume --lane NAME --account-role ROLE
   --run-id ID --nonce-file PATH --page-url URL --json`. Resume checks the declared
   profile, current Selected-tabs mode, reserved application origin, and one
   selected exact URL while the reservation remains active. It reuses valid
   exact-page permission.
5. On `handoff_grant_required`, give the CLI's single human instruction: select
   the intended task tab in the declared Chrome profile and click OpenClaw's
   `Allow on this tab` once. Wait, then retry the same resume command. An
   ambiguous, unselected, wrong-profile, wrong-origin, busy, or interrupted
   result preserves the reservation and follows its typed repair. The agent
   neither pins nor grants the tab.
6. After resume succeeds, retire the task's exact private token file and invoke
   the selected adapter with the same exact URL.
   The adapter re-proves custody before its first operation. Report opening, waiting for
   human sign-in, waiting for tab access, and automation readiness as distinct
   observed states.

For an already admitted and selected page that unexpectedly presents a login
wall, omit `--page-url` from `handoff open`. This compatible path derives the
origin from that page before reserving. The remaining human, resume, and
release rules are identical.

If pre-admission opening returns `browser_opening_uncertain`, the reservation
remains active and the private token file remains available. Inspect the visible
profile before replaying any opening. Continue the same task with the retained
token file, or release it deliberately. A signal, stale state, or lost recovery
evidence never releases a reservation automatically.

Use `browser-lane handoff status --lane NAME --json` for a content-free state
check. Use `browser-lane handoff release --lane NAME --nonce-file PATH --json`
only to abort the ceremony; release performs no page inspection. After confirmed
release, retire the task's exact token file. A second open is
refused. The reservation coordinates callers that obey `browser-lane`; it does
not exclude arbitrary same-user clients that bypass the executable.

## Lost-token recovery

Use `browser-lane handoff recover --lane NAME --json` to preview the exact
reservation without changing it. Present its task owner and the effect of
aborting that reservation to the human. Existing approval applies only to the
exact reservation and recovery action it covers.

After explicit operator approval, run `browser-lane handoff recover --lane NAME
--reservation HASH --acknowledge TASKREF --execute --json` with the preview's
reservation fingerprint and task reference. The command holds the lane lease,
rechecks the reservation, and records an audit receipt before removal. Follow
its typed result on failure; a changed reservation needs a fresh preview and
authority. Recovery does not authenticate or grant access. Run normal lane
readiness checks before later browser work. Never use recovery to bypass a
different task's live ownership.

## Human work and recovery

Route visible human or 1Password browser entry, CAPTCHA, recovery, or device
trust through the attended login handoff above. A permission failure authorizes no automatic tab sharing,
selection, pairing, restart, installation, profile repair, or engine bypass.
Report the failed layer and request exact repair authority. A Chrome `Allow
remote debugging?` prompt means something attached outside the lane: decline it
and stop. Current automatic
OpenClaw "Use local OpenClaw" targets Gateway, outside this setup. An approved
standalone repair uses manual pairing for the exact existing lane, confirms
Selected tabs, keeps credentials out of outputs, and rechecks health and
inspect before task access.

Do not use raw or full-profile CDP, a third profile, copied authentication
state, or an unrelated exposed page. Return the observed result and remaining
proof gap to the caller. Keep secrets out of every returned snapshot, input,
network, console, and screenshot output; report a credential only as present,
absent, length, or status code. Adapters do not invoke the router.
