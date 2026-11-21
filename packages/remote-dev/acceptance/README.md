# remote-dev doctor acceptance cases

These files hold `remote-dev doctor` causes and faults as plain data. They do not
depend on the package's source layout, so a rewrite can replay them unchanged.

- `causes.json` lists each named cause: its name, what it detects, how to detect
  it, its repair, and the faults that prove it.
- `faults/*.json` holds one fault each. `origin` is `recorded` when the facts
  came from a real incident and `derived` when they were built from one.

## Fault format

`observed` holds what each probe returns:

| Field | Probe | Meaning |
| --- | --- | --- |
| `sshConfig.alias`, `sshConfig.hostname` | `ssh -G ALIAS` | The host's SSH alias and address |
| `route.host`, `route.default` | `route -n get HOST`, `route -n get default` | Interface for each route. A `null` host means only the default route matches (macOS answers `destination: default`) |
| `sharedLink` | `ssh -O check`, `ps -o etime=`, a session with `ControlMaster=no` | `null` when no shared link is open. `responds: false` when a session through it prints nothing |
| `sharedLink.clientAddress`, `directConnection.clientAddress` | `echo "remote-dev-sample $SSH_CONNECTION"` | The client address sshd sees |
| `mibPerSecond` | 8 MiB of `/dev/zero`, timed after the header line | Transfer rate |
| `sharedLink.transfer` | the same sample | Present when the sample did not complete: the `bytes` that arrived and the ssh `exitCode` |
| `container` | `docker ps` on the host | `running` or `stopped` |
| `editor` | `code --version`; `ls ~/.vscode-server/bin` in the container | Local VS Code release and commit; server folders as `ready NAME` or `partial NAME` |
| `install` | `realpath ~/.local/bin/remote-dev` | `absent`, `main-checkout`, `worktree` (main tracks the command) or `worktree-unlanded` (main does not) |

`expect` holds the result: the cause, the exit code, the exact `repairAction`,
and fragments the message must include. `{main}` and `{home}` in an expected
repair stand for the test's main checkout and home directory.
