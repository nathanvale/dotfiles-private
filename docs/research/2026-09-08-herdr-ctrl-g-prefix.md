# Herdr `Ctrl+G` prefix research

Date: 2026-09-08 (Australia/Melbourne)

## Finding

Set the Herdr prefix in the macOS configuration file to `ctrl+g`:

```toml
[keys]
prefix = "ctrl+g"
```

Herdr reads that file from `~/.config/herdr/config.toml` on macOS. `keys.prefix`
is the canonical prefix setting, whose default is `ctrl+b`; the documented
accepted key-string syntax includes modified keys such as `ctrl+a`, so
`ctrl+g` is the equivalent supported value. Existing action bindings written
as `prefix+…` automatically use the configured prefix, so no separate action
rebinding is required. [Herdr configuration](https://herdr.dev/docs/configuration/), [Herdr config reference](https://herdr.dev/docs/config-reference/)

After the file is changed, reload the running server with
`herdr server reload-config`, or use the global menu's `reload config` action.
Herdr documents this as applying most UI settings without restarting panes.
[Herdr configuration](https://herdr.dev/docs/configuration/)

## Local observation

The current `~/.config/herdr/config.toml` has no `[keys]` section, so the
snippet is an additive TOML table. This research task made no configuration
change and did not reload Herdr.
