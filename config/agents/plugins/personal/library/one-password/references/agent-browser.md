# Agent Browser credential delivery

Use this route for an explicitly approved username/password website login in
Pi, Claude Code or Codex. The dedicated browser is separate from personal
Chrome. Native harness browsers still own ordinary user-browser work.

## Installed route

The pinned Agent Browser CLI is on PATH. Its dedicated configuration is
`~/.config/agent-browser/one-password.json`; its `one-password` plugin points
to `~/.local/libexec/agent-browser-one-password`. The plugin is built and
shipped with this personal skill. Its private stdout carries credentials to
Agent Browser, so agents invoke it through `auth login` only.

Use a unique safe session name for each task, and retain that name for session
reuse. Include the dedicated config on every invocation:

```sh
agent-browser --config "$HOME/.config/agent-browser/one-password.json" --session <task-session> open <approved-origin>
agent-browser --config "$HOME/.config/agent-browser/one-password.json" --session <task-session> snapshot -i --json
```

1. Verify the protected page's account before work. If already signed in as
   the approved account, reuse that session.
2. On a login page, observe the visible username/password/submit controls.
   Verify the password input is masked and that selectors match the approved
   binding. Check `stream status`; if enabled, run `stream disable` before
   credential entry. Keep recording and tracing off during login.
3. Invoke the native login command once, with the approved binding name for
   both `<login>` arguments and its exact HTTPS origin:

   ```sh
   agent-browser --config "$HOME/.config/agent-browser/one-password.json" --session <task-session> auth login <login> --credential-provider one-password --item <login> --url <approved-origin> --no-navigate --json
   ```

4. Wait for the protected page's expected account marker, then verify its URL
   and account. A filled form or successful command is insufficient.
5. On logout or expiry, observe the new login page and repeat the same approved
   route. Stop after a rejected login or unknown effect; inspect before any
   retry. MFA, CAPTCHA, passkeys and recovery remain Nathan's handoffs.
6. Close the owned browser with `close` when the task ends. Use the same config
   and session. Keep cookies and state exports out of logs, chat and source.

The config allows only the approved website domains and disables state-save
intent. Use the fresh browser it launches; profile attachment and saved-state
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
    "capabilities": ["credential.read"]
  }]
}
```

Keep configuration and bindings secret-free. Verify native plugin discovery,
real credential delivery and the correct-account login/reuse/logout-recovery
flow on each machine and harness. Prove Connectors API credential access
independently before replacing or revoking any shared service token.
