#!/bin/sh
# Remote Development: the one desktop entry for the remote pilot.
#
# Side effect: macOS opens .command files in a Terminal window. That window
# shows the entry check; it closes on its own success path only if Terminal is
# set to close on clean exit, and it waits for Return after any failure.
#
# It runs `remote-dev open pilot`, which rechecks the configured container's
# identity and running state, then opens the isolated VS Code environment and
# the Start here guide. It never starts, rebuilds, or replaces a container.
set -u
cli=${REMOTE_DEV_CLI:-"$HOME/code/dotfiles/packages/remote-dev/bin/remote-dev"}
if "$cli" open pilot; then
  exit 0
fi
printf '\nNothing was started. Press Return to close this window. '
read -r _reply || true
exit 1
