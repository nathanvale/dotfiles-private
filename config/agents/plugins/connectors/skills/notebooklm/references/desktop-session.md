# NotebookLM over macOS SSH

Use the same packaged commands over SSH. In a macOS `Background` launchctl
session, the transport runs each bounded MCPorter request as one temporary
launchd job in that user's existing GUI session. The vendor and its protected
profile remain the credential owner. Desktop and non-macOS callers execute
directly. No remote listener or additional public command is created.

The route needs `/usr/bin/python3`, a same-user GUI login and a vendor profile
that can use its protected storage there. Check `launchctl managername` in the
failing context. A successful desktop check and stale SSH check can indicate a
security-session mismatch; they do not establish expired Google credentials.
Verify the installed plugin version and its automatic route before requesting
another login. A locked keychain can still prevent the vendor from reading its
profile inside the GUI session; follow the vendor's attended repair procedure.
Keep its protected storage and existing credentials in place.

## Failure recovery

- `desktop-context-unavailable`: restore access to the local launchctl manager,
  then check readiness again.
- `desktop-session-unavailable`: resume this user's GUI login, then check
  readiness through the packaged command.
- `desktop-request-timeout` or `desktop-result-too-large`: the request exceeded
  its time or output bound. Inspect vendor health or narrow the admitted read.
- `desktop-route-failed`: inspect Python availability and this user's launchd
  permissions before repeating readiness. A failed route does not prove stale
  authentication.
- `desktop-cleanup-failed`: output was withheld because removal was unconfirmed.
  Inspect `launchctl print gui/UID` for the `local.connectors.notebooklm-` job
  belonging to the failed request. Verify its PID and start time before removing
  that exact job with `launchctl bootout gui/UID/LABEL`. Preserve other requests.
- `desktop-request-interrupted`: the helper observed a signal or caller exit
  and attempted removal before returning its safe interruption result.

Provider output crosses a private FIFO and is projected by the existing
adapter. The private temporary plist contains only command coordinates and
scrubbed environment values. The helper bounds output at 8 MB and the request
at 65 seconds, then allows bounded launchctl cleanup before releasing output.
SIGINT, SIGTERM and caller death are cleanup paths. Killing the helper itself
with SIGKILL or losing the host cannot run its cleanup handler; inspect owned
jobs before retrying after such a failure.

## Qualification

Use this recipe for the desktop transport introduced in [PR 247](https://github.com/nathanvale/dotfiles-private/pull/247).
Require that implementation in the selected candidate before running these
checks. Inspect its route, helper, and tests before each run. The
[transport](https://github.com/nathanvale/dotfiles-private/blob/22ae7466c04bc96c4deb6cb610256ebcdea92615/config/agents/plugins/connectors/skills/notebooklm/scripts/desktop-command.ts),
[helper](https://github.com/nathanvale/dotfiles-private/blob/22ae7466c04bc96c4deb6cb610256ebcdea92615/config/agents/plugins/connectors/skills/notebooklm/scripts/desktop-command.py),
and [process tests](https://github.com/nathanvale/dotfiles-private/blob/22ae7466c04bc96c4deb6cb610256ebcdea92615/config/agents/plugins/connectors/skills/notebooklm/tests/desktop.test.ts)
links pin that baseline, not the revision currently installed. Record the
actual invoked executable or helper path, SHA-256, host, account, harness,
launch context, command, elapsed time, streams, and exit in private runtime
state. Keep evidence outside temporary fixture directories.

1. **Budget the verifier separately.** Read the current request, control,
   cleanup, and outer-watchdog bounds from the selected source. Give each
   probe enough time for its intended result and bounded cleanup, while
   retaining a finite verifier deadline. The original oversized-output test
   [expired under its five-second test watchdog](https://github.com/nathanvale/dotfiles-private/actions/runs/42193855642/job/128281638923);
   its explicit test timeout is not the transport's request deadline. If the
   verifier interrupts first, retain that attempt as verifier failure rather
   than diagnosing a credential refusal.
2. **Check fixtures from source.** From the Connectors checkout, run
   `skills/notebooklm/tests/desktop.test.ts` through `personal:test-runner`.
   Require the test-owned exact large reply, preserved vendor exit, refused
   output on cleanup failure, and interruption/deadline cleanup assertions.
   These tests substitute launchctl; they do not qualify real GUI dispatch or
   credential access.
3. **Qualify the public CLI without credentials.** Stage the exact compiled
   candidate with private fixture state and a controlled PATH selecting a
   synthetic `notebooklm-mcp`. Invoke
   `bin/connectors auth status notebooklm --select profile=default` from that
   candidate's root in a confirmed `Background` manager context. Record
   `launchctl managername` there and observe this request's same-user GUI job,
   exact label, leader, and process group. Have the fixture record its PID and
   a TERM-resistant descendant's PID privately, then wait until both exist
   before signalling the public CLI. Exercise SIGINT, SIGTERM, and public-caller
   SIGKILL separately. Before emergency teardown, require every observed owned PID,
   the exact GUI job, and its temporary directory to be absent. Preserve
   streams and exits even when the caller cannot return an envelope. A killed
   caller is a different case from killing the Python helper itself.
4. **Qualify streams and bounds through real launchd.** Invoke the staged
   helper with synthetic commands and an explicit live owner PID. Require a
   large reply to equal an independently prepared payload byte for byte.
   Separately exceed the helper's current output bound and request deadline;
   require the matching cause, no released payload, and owned-process/job
   absence before verifier teardown. Record this as real-launchd helper proof;
   the compiled binary's hash alone cannot turn it into public-CLI proof.
5. **Prove an authorized provider read separately.** Use the loaded NotebookLM
   skill's readiness command in the named receiver, then `pack_check` and
   `pack_status` for one declared existing manifest under the task's read
   authority. Require the actual Studio response and its completeness result.
   Keep source readiness
   and stale-artifact states as returned; successful access need not make the
   pack ready. Record a direct desktop run separately from GUI-job coverage.
   Record metadata, credential access in this route, provider readback, and
   persistence separately. A read does not qualify refreshed-token
   persistence, new storage, or locked-Keychain recovery. Leave unexercised
   claims unqualified and route any needed login or storage change to its owner.

Keep failed attempts and any observed direct refusal alongside later results.
After the last probe, remove only its owned fixtures and residual resources,
then confirm the retained receipts still exist. This recipe defines acceptance;
it does not assert that any source, installed, or live journey has run.
