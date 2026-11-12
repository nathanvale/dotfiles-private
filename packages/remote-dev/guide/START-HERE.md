# Start here

**You are connected to the remote pilot. Choose one thing to work on.**

Where you are: **mac-mini > OrbStack > shepherdr-consolidated-20261112-01-agent-1 > /workspace**.

- Your Mac only displays this editor.
- Files and terminals in this window run inside the remote container.
- A plain SSH window runs on the Mini host instead, not in this container.

## What to open

- **Files:** use Explorer on the left. The dotfiles checkout is in
  `/workspace/dotfiles`. Having it here does not mean its checks pass or that
  any task in it is ready.
- **Terminal:** choose View > Terminal. It runs inside the container.
- **Service log:** [open the native service log](../home/agent/.local/state/pilot-runtime/consolidated-20261112-01/service.log).
  It is a saved file; reopen it to refresh. From the Mac, `remote-dev logs pilot`
  shows its tail with secrets redacted.
- **Connection log:** choose View > Output, then Dev Containers or Remote - SSH.
  That log covers the editor connection, not the pilot service.
- **Docker output:** `docker logs` shows container stdout only. It is not the
  pilot's service log.
- **Task status:** from the Mac, `remote-dev board pilot` opens the configured
  board. Use it to look at status only: a running page does not prove an agent
  is running.
- **Pilot details:** [open the existing README](README.md).

Connecting does not mean an engineering repository or a coding agent is ready.

## When you leave or come back

- **Closing VS Code** leaves this container and its services running. The pilot
  is managed outside the editor.
- **Coming back:** use the same Remote Development desktop item (or
  `remote-dev open pilot`). It checks that this exact container is still
  running, then connects the editor and opens this guide. It does not start a
  container, a service or an agent.
- **A stopped or replaced container** is refused by that check. Starting the
  container, and then its services, are two separate decisions.
- **If the connection drops,** let VS Code try to reconnect. If it cannot, use
  the desktop item again. Terminals and processes may not survive a disconnect.
- **If a start, rebuild, install or sign-in prompt appears,** stop there. Do
  not accept it as part of reconnecting.

The entry check is a point-in-time check. If the container stops afterwards,
stop at any lifecycle prompt.

Not yet proven: leaving and returning on the Mac, and the stopped or
disconnected paths, still need a separately approved check before this entry
can be called qualified.
