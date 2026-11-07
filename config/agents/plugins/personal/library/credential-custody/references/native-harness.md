# Keep native harness authentication separate

Inspect the intended harness's installed help before running an authorized
status check or sign-in. Capture status privately and return only the result
needed by the consumer. The metadata doctor does not run auth commands.

Codex supports its own credential-storage selection. Its official
[authentication documentation](https://learn.chatgpt.com/docs/auth) owns the
current behavior. Preserve the selected mode and `CODEX_HOME` during diagnosis.
File-backed credentials are sensitive. Missing files alone cannot establish
missing sign-in when another storage mode applies.

Claude Code's official
[authentication documentation](https://code.claude.com/docs/en/authentication)
owns its credential behavior. Preserve `CLAUDE_CONFIG_DIR` and account context.
`claude auth --help` exposes the installed status and login commands. A
different config directory may select a different credential context.

For either harness, a status check and a real authorized request are separate
proofs. Keep provider, profile, organization, subscription or API billing, and
storage changes outside an unrelated Keychain repair. An existing scoped
worker's auth arrangement does not authorize copying that arrangement to other
workers or Macs.
