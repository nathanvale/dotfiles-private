#!/bin/bash
# Deprecated: this helper uninstalls nothing automatically. Homebrew removal
# is destructive and stays a deliberate, manual, unforwarded step. No
# repository-relative dependency: it must print its notice even copied
# outside this repository.

set -e

printf 'brew_uninstall.sh is retired; it uninstalls nothing automatically.\n' >&2
printf 'Run the official Homebrew uninstall script yourself when you intend that destructive action:\n' >&2
printf '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/uninstall.sh)"\n' >&2

exit 1
