# shellcheck shell=sh
# Shared Husky init. Sourced by Husky before repo hooks.
#
# VS Code Source Control does not always inherit an interactive zsh environment,
# so Git hooks select the applied Mise toolchain themselves.
#
# Hooks can inherit the launchd PATH, which has no Homebrew prefix; Mise
# selection needs its executable, so restore the package prefixes first.
# Contract: bin/test/toolchain-bootstrap-test.sh
case ":$PATH:" in
  *":/opt/homebrew/bin:"*) ;;
  *) [ -d /opt/homebrew/bin ] && PATH="/opt/homebrew/bin:$PATH" ;;
esac
case ":$PATH:" in
  *":/usr/local/bin:"*) ;;
  *) [ -d /usr/local/bin ] && PATH="/usr/local/bin:$PATH" ;;
esac
export PATH

[ -f "$HOME/.config/mise/bootstrap.sh" ] && . "$HOME/.config/mise/bootstrap.sh"
