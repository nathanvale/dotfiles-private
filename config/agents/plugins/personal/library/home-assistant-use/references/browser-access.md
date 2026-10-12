# Home browser access

Use the native browser surface supplied by Codex with Nathan's personal Chrome
profile. Reuse the existing HA or router tab and authenticated session. Prefer
DOM controls and accessibility labels. Fall back to native computer-use controls
in Chrome after a fresh screenshot when the DOM route cannot operate the page.
Use only the active tool's documented APIs. For another Harness, use its native
Chrome surface.

Resolve HA's endpoint from the configured vault's Home Assistant system note,
the home project or the existing tab. Resolve the router separately from its
saved system record or the active network's default gateway. Verify the page's
identity before signing in. A `192.168` address alone identifies neither HA nor
the router; do not guess an address, port or Chrome profile.

Have Nathan complete sign-in unless the exact workflow already has an
allowlisted credential-provider authorization. Keep CAPTCHA, MFA, passkey,
device-trust and browser security warnings with Nathan. Preserve the current
tab for a sign-in handoff. Keep credentials, tokens and authentication-bearing
URLs out of logs and notes.

For Apple Home, use the native Home app. For a requested Sensibo/iPhone
comparison, use the existing iPhone Mirroring app. Reconnect and inspect the
actual screen before acting; phone use can interrupt mirroring or change its
foreground app. Open accessory details through More Controls rather than a
tile click that may toggle the device. Reading a setting does not authorize
changing it.

Inspect router settings read-only when diagnosing HA or HomeKit connectivity.
Keep any router change within a separately authorized repair. Preserve network
exposure and security protections. Resolve a failed browser connection through
the Harness's troubleshooting route rather than scraping browser credentials
or switching to an unrelated login identity.
