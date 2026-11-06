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
