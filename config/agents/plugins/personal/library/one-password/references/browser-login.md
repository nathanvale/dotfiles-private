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

Use this skill's `scripts/browser-login.mjs` in the native computer-use
JavaScript session. Its Interface accepts the trusted native `cua` runtime,
browser and tab IDs, login name and one or both CSS field selectors. It fills through native locator
methods and returns only status, cause and effect. It does not click Login.

1. Observe the actual login page and identify its unique visible username and
   password input selectors in the top-level document. The helper obtains the
   profile from fresh `cua.listBrowsers({emit: false})` inventory and rejects a
   mismatch. Its DOM observation verifies distinct inputs and a masked password
   input before custody. Embedded login frames require their own approved route.
2. Import `fillBrowserLogin` from the skill's absolute module path in the native
   REPL. Pass `login` (the approved name), `cua` (the native runtime),
   `browserId`, `tabId`, and
   `fields: [{id: "username", selector: "#username"}, {id: "password", selector: "#password"}]`,
   using the observed selectors. The helper obtains the Tab through
   `cua.getBrowser({id: browserId})` and `browser.tabs.get(tabId)` and derives
   every locator from that Tab. Pass the native runtime itself; caller-created
   runtime objects are outside this trust contract.
   Use only the username field for a staged login's username and Next screen.
3. Inspect the returned status only. On `filled`, click the observed Login or
   Next control once and re-observe. For a staged login, fill the newly observed
   password field with another call, then click its login control once.
4. Verify the signed-in identity on the workflow's canonical page before work.

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
