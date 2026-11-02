# Agent Browser credential delivery

Use this route for an explicitly approved username/password website login in
Pi, Claude Code or Codex. The dedicated browser is separate from personal
Chrome. Native harness browsers still own ordinary user-browser work.

## Installed route

The pinned Agent Browser CLI is on PATH. Its dedicated configuration is
`~/.config/agent-browser/one-password.json`; its `one-password` plugin points
to `~/.local/libexec/agent-browser-one-password`. The plugin is built and
shipped with this personal skill. Use native `auth login` for a complete form,
or the plugin's `credential.fill` request for one staged field. Agents do not
invoke the private `credential.resolve` protocol directly.

Generate a fresh UUID-based session name for each task; retain it only for
that task's owned lifecycle. Verify that the dedicated config has its approved
domains and `ignoreHttpsErrors` absent or false, with no extra launch arguments
or browser attachment. Use the environment allowlist on every invocation so
ambient `OP_*` and `AGENT_BROWSER_*` variables cannot override the launch:

```sh
task_session="login-$(uuidgen | tr '[:upper:]' '[:lower:]')"
env -i HOME="$HOME" USER="$USER" LOGNAME="${LOGNAME:-$USER}" \
  PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  agent-browser --config "$HOME/.config/agent-browser/one-password.json" --session "$task_session" session info --json
```

Shell variables do not survive independent tool calls. Carry the returned
`data.session` identifier in the active task context and use that exact value
for `<task-session-from-startup>` in every later block. A missing task identity
blocks continuation; follow the fresh-start and saved-draft recovery below.

Before the first `open`, require `success: true`, `data.session` equal to
`task_session`, `data.namespace: agent-credentials`, `data.active: false`, and
null values for `data.pid`, `data.runtime` and `data.runtimeError`. This checks
for a live daemon collision; it does not prove ownership, past use or TLS
state. For any active or unconfirmed result, generate another fresh name and
preserve existing browsers and unsaved work. Then open the approved origin
with the same allowlisted environment:

```sh
task_session="<task-session-from-startup>"
env -i HOME="$HOME" USER="$USER" LOGNAME="${LOGNAME:-$USER}" \
  PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  agent-browser --config "$HOME/.config/agent-browser/one-password.json" --session "$task_session" open <approved-origin>
```

Retain this owned session across login stages, account verification, work and
review. Reuse only a session whose safe creation through this flow is known.
For an unknown or pre-existing session, start a new owned session and reopen
the saved server-side draft; preserve the other browser and any unsaved work.

Agent Browser 0.41.0 can retain disabled certificate verification in an already
running browser after the config file is restored. Its `session info` output
does not expose effective TLS verification. The provider validates the current
config file; it cannot attest the TLS state of an existing browser. This route
establishes TLS verification when creating its task-owned browser under the
trusted same-user model.

1. Verify the protected page's account before work. If already signed in as
   the approved account, reuse only this safely created owned session.
2. On a login page, observe the visible username/password/submit controls.
   Verify the password input is masked and that selectors match the approved
   binding. Check `stream status`; if enabled, run `stream disable` before
   credential entry. Keep recording and tracing off during login.
3. Invoke the native login command once, with the approved binding name for
   both `<login>` arguments and its exact HTTPS origin:

   ```sh
   task_session="<task-session-from-startup>"
   env -i HOME="$HOME" USER="$USER" LOGNAME="${LOGNAME:-$USER}" \
     PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
     agent-browser --config "$HOME/.config/agent-browser/one-password.json" --session "$task_session" auth login <login> --credential-provider one-password --item <login> --url <approved-origin> --no-navigate --json
   ```

4. Wait for the protected page's expected account marker, then verify its URL
   and account. A filled form or successful command is insufficient.
5. On logout or expiry, observe the new login page and repeat the same approved
   route. Stop after a rejected login or unknown effect; inspect before any
   retry. MFA, CAPTCHA, passkeys and recovery remain Nathan's handoffs.
6. Close the owned browser with `close` when the task ends. Use the same config
   and session. Keep cookies and state exports out of logs, chat and source.

## Staged login

For a username-first form, observe the current origin and input, then fill its
approved binding through the same dedicated session:

```sh
task_session="<task-session-from-startup>"
env -i HOME="$HOME" USER="$USER" LOGNAME="${LOGNAME:-$USER}" \
  PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  agent-browser --config "$HOME/.config/agent-browser/one-password.json" --session "$task_session" plugin run one-password credential.fill \
  --payload "{\"login\":\"<approved binding>\",\"field\":\"username\",\"session\":\"$task_session\"}" --json
```

Require `data.status: filled`. Observe and click the site's Next control once.
After the masked password field appears, repeat that request with
`field: password`. Observe and click Login once, then verify the protected
account. The plugin fills one field; it does not navigate or click a button.
Keep the payload's session equal to the owned task session.

The plugin verifies the exact binding, item, vault, expected account, live
origin, unique visible input, field type, empty input and disabled streaming
before custody. It rechecks the input before and after native batch stdin
delivery. Keep recording and tracing off, as for native auth login. A blocked
result with `effect: none` performed no fill. `partial-or-unknown` requires live
inspection; do not repeat the fill automatically. Raw child output and errors
stay private.

Native `auth login` in 0.41.0 needs both fields together. Generic MCP fill
converts its input to child-process arguments. The staged plugin uses native
`batch --bail --omit-command` stdin and returns a redacted status. These are
trusted same-user checks, not isolation from a compromised agent or a hostile
page that changes between checks.

- [Pinned MCP fill transport](https://github.com/vercel-labs/agent-browser/blob/v0.41.0/cli/src/mcp.rs#L2875).
- [Pinned native batch transport](https://github.com/vercel-labs/agent-browser/blob/v0.41.0/cli/src/main.rs#L2275).

The config allows only approved website and runtime domains and disables state-save
intent. Use the fresh owned lifecycle above; profile attachment and saved-state
imports cannot provide the domain controls. Browser sessions carry account
authority. This is trusted same-user automation, not compromised-agent
isolation. Desktop logout or Keychain lock may still block SSH custody.

## Approved binding

The existing private `~/.local/state/browser-automation/logins.json` remains
the binding owner. An enabled entry needs its exact `vaultId` and:

```json
{
  "agentBrowser": {
    "enabled": true,
    "username": "<approved account>",
    "usernameSelector": "<observed selector>",
    "passwordSelector": "<observed selector>",
    "submitSelector": "<observed selector>"
  }
}
```

For staged filling, require the expected `username` and the selector for the
requested field. Add each selector only after observing that stage. A staged
binding does not need `submitSelector`; native complete-form auth requires all
three selectors. Keep account values and actual website bindings private.

Keep the file mode `0600` and owned by Nathan. The provider validates the
existing item ID/title/vault/origin, Agent Browsing vault ID, unique credential
fields and expected username before returning credentials. The vendor command
owns live origin validation and form submission. A provider profile name is a
binding name, not proof of a personal Chrome profile.

For a missing item, follow the skill's Missing credentials branch. Nathan puts
approved website Logins in Agent Browsing and API tokens/keys in API
Credentials. Adding a website also requires an approved origin, account,
selectors and dedicated-browser use; possession of an item grants no blanket
website authority. Extend the domain list only for explicitly approved hosts.

## First setup or refresh

Use the supported pinned npm package on each Apple Silicon Mac:

```sh
npm install --prefix "$HOME/.local/share/agent-browser/0.41.0" --save-exact --ignore-scripts --omit=dev --no-audit --no-fund agent-browser@0.41.0
node "$HOME/.local/share/agent-browser/0.41.0/node_modules/agent-browser/bin/agent-browser.js" --version
```

The native launcher repairs its executable mode. Link that package's
`bin/agent-browser-darwin-arm64` to `~/.local/bin/agent-browser`, preserving any
unrelated existing executable. Copy this loaded skill's
`dist/agent-browser-one-password` to the stable libexec path with mode `0700`.
Refresh that copy after a personal plugin update and compare its bytes.

Create the dedicated config with the stable provider command, the installed
Chrome executable, approved domains and no restore state. Preserve existing
global Agent Browser configuration:

```json
{
  "executablePath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "namespace": "agent-credentials",
  "allowedDomains": ["<approved host>"],
  "restoreSave": "never",
  "plugins": [{
    "name": "one-password",
    "command": "<absolute home>/.local/libexec/agent-browser-one-password",
    "capabilities": ["credential.read", "credential.fill"]
  }]
}
```

Keep configuration and bindings secret-free. Verify native plugin discovery,
real credential delivery and the correct-account login/reuse/logout-recovery
flow on each machine and harness. Prove Connectors API credential access
independently before replacing or revoking any shared service token.
