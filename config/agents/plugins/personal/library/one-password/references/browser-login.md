# Allowlisted native browser login

Use this route when Nathan authorises a named browser automation and its login
binding. The local whitelist is
`~/.local/state/browser-automation/logins.json`. Keep this private file outside
Git and tracking links, owned by Nathan with mode `0600`. It contains exact vault name, item
name, immutable item ID, HTTPS origin and Chrome profile, not passwords or
tokens. Each `logins` entry has `name`, `enabled`, `vault`, `item`, `itemId`,
`origin` and `profile`. A vault grant is not blanket login authority: use only
the selected approved entry. Editing a mapping does not expand the token's
1Password grants.

Reuse the approved profile's signed-in session before filling anything. Verify
the signed-in identity on a protected page; a successful navigation alone is
not proof of the right account.

## Shared unattended route

Use [Agent Browser setup and login](agent-browser.md) for Pi, Claude Code and
Codex on either Mac. It uses Agent Browser's supported credential-provider
protocol and the same scoped Keychain custody as API credential delivery.
The provider reads only approved Agent Browsing Login items. Connectors keeps
its own API Credentials route.

## Native Codex filling

In Codex Desktop, use this skill's `scripts/browser-login.mjs` in the native
browser JavaScript session. Its Interface accepts the actual browser `agent`
runtime, browser and tab IDs, login name and one or both CSS field selectors.
It returns only status, cause and effect. It does not click Login.

1. Observe the actual login page and identify its unique visible username and
   password input selectors in the top-level document. The helper obtains the
   profile from fresh `agent.browsers.list()` inventory and rejects a
   mismatch. Its DOM observation verifies distinct inputs and a masked password
   input before custody. Embedded login frames require their own approved route.
2. Import `fillBrowserLogin` from the skill's absolute module path in the native
   session. Pass `login` (the approved name), `agent` (the native runtime),
   `browserId`, `tabId`, and
   `fields: [{id: "username", selector: "#username"}, {id: "password", selector: "#password"}]`,
   using the observed selectors. The helper obtains the Tab through
   `agent.browsers.get(browserId)` and `browser.tabs.get(tabId)` and derives
   every locator from that Tab. Pass the native runtime itself; caller-created
   runtime objects are outside this trust contract.
   Use only the username field for a staged login's username and Next screen.
3. Inspect the returned status only. On `filled`, click the observed Login or
   Next control once and re-observe. For a staged login, fill the newly observed
   password field with another call, then click its login control once.
4. Verify the signed-in identity on the workflow's canonical page before work.

This alternative needs Codex's actual native browser runtime. Pi and Claude
Code use the shared unattended route above. Pass credentials only through the
provider's private transport; keep model-visible fill arguments secret-free.

The helper owns the exact `with-one-password-token op item get` subprocess and
captures its output in memory. Keep raw item JSON, field values and subprocess
errors inside that helper. Do not print them, save them, use clipboard transfer,
or expose them to model output. Never add an in-memory secret to a snapshot or
screenshot. Inspect page state only after the password is masked or submitted.

Stop on a rejected login, changed origin/profile, missing or duplicate fields,
or unknown fill effect. Do not loop password attempts. MFA, CAPTCHA, passkey,
device-trust and password recovery are human handoffs. Adding a new item or
origin requires Nathan's explicit approval; no wildcard hosts or vault-wide
authority. The helper needs no browser relay or copied Chrome profile.

The consuming skill owns navigation, identity checks, login buttons and business
effects. This module owns only whitelist validation, process custody and filling.
Future approved logins add a config entry, not another credential helper. Keep
the two timesheet names in their skill, not in this module's implementation.

When Nathan moves an approved item to another vault, revalidate its exact
title, Login category, origin and field shape through a private consumer. Moving
can change its item ID. Update only that approved binding after verification;
an empty new vault or a missing old ID does not authorise a broader search.

## User-present fallback

Use the native 1Password browser extension when Nathan authorises that fallback
and the app is unlocked. In Codex, use Chrome tools for page navigation and
identity checks, then Computer Use for the extension toolbar popup. Select the
approved item and vault before clicking Autofill. Autofill may submit the login
form; observe its result before deciding whether another click is needed.

Keep password fields masked. Nathan handles app unlock, MFA, passkeys, CAPTCHA,
device trust and recovery. An unlocked desktop app is not evidence that an
unattended SSH credential path works.

## Verification

Prove correct-account protected access, a later visit that reuses the session,
and recovery after an explicit logout. Label the logout test as controlled
sign-out, not natural session expiry. Keep login authority separate from any
timesheet, payment or other business action.
