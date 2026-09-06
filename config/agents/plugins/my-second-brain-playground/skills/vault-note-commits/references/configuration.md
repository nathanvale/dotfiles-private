# Playground vault configuration

The user-local config owner is
`~/.config/my-second-brain-playground/vault.json`, or the equivalent under an
absolute `XDG_CONFIG_HOME`.

```json
{
  "schemaVersion": 1,
  "vault": "/absolute/path/to/my-second-brain-playground"
}
```

Use a private directory and file. The configured path must resolve to the root
of a Git checkout with `main` checked out. Keep production vault configuration
under its separate owner.
