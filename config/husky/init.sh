# shellcheck shell=sh
# Shared Husky init. Sourced by Husky before repo hooks.
# A checkout may opt into the direct, already-installed tool route. This must
# run before any Mise bootstrap, configuration, trust or shim evaluation.
dotfiles_husky_root=$(/usr/bin/git rev-parse --show-toplevel 2>/dev/null) || dotfiles_husky_root=
dotfiles_husky_marker="$dotfiles_husky_root/.husky/direct-pins"
if [ -n "$dotfiles_husky_root" ] &&
  { [ -e "$dotfiles_husky_marker" ] || [ -L "$dotfiles_husky_marker" ]; }; then
  if [ ! -f "$dotfiles_husky_marker" ] || [ -L "$dotfiles_husky_marker" ]; then
    printf 'husky direct pins: marker must be a regular file: %s\n' "$dotfiles_husky_marker" >&2
    printf 'husky direct pins: repair: replace it with a regular file yourself, or remove it to use the guarded Mise route\n' >&2
    exit 1
  fi
  dotfiles_husky_selector="$HOME/.config/husky/direct-pins.sh"
  if [ ! -f "$dotfiles_husky_selector" ] || [ -L "$dotfiles_husky_selector" ]; then
    printf 'husky direct pins: missing installed selector %s\n' "$dotfiles_husky_selector" >&2
    printf 'husky direct pins: repair: install config/husky/direct-pins.sh with the rest of the shared Husky files\n' >&2
    exit 1
  fi
  # The exact installed selector is checked above and sourced at runtime.
  # shellcheck source=/dev/null
  . "$dotfiles_husky_selector"
  return 0
fi
#
# VS Code Source Control does not always inherit an interactive zsh environment,
# so Git hooks select the applied Mise toolchain themselves.
#
# Hooks can inherit the launchd PATH, which has no Homebrew prefix; Mise
# selection needs its executable, so restore the package prefixes first.
# Contract: bin/test/toolchain-bootstrap-test.sh, bin/test/husky-toolchain-guard-test.sh
case ":$PATH:" in
  *":/opt/homebrew/bin:"*) ;;
  *) [ -d /opt/homebrew/bin ] && PATH="/opt/homebrew/bin:$PATH" ;;
esac
case ":$PATH:" in
  *":/usr/local/bin:"*) ;;
  *) [ -d /usr/local/bin ] && PATH="/usr/local/bin:$PATH" ;;
esac
export PATH

# A missing or linked bootstrap or guard is a partial installation: in a
# checkout that can pin tools it must refuse, not let the hook run with
# whatever is on PATH or inherited Mise state.
dotfiles_husky_pinned=
[ -n "$dotfiles_husky_root" ] &&
  { [ -e "$dotfiles_husky_root/package.json" ] || [ -e "$dotfiles_husky_root/.nvmrc" ] ||
    [ -e "$dotfiles_husky_root/.node-version" ]; } && dotfiles_husky_pinned=1
dotfiles_husky_partial() {
  printf 'husky toolchain guard: %s is missing or not a regular file, so the pinned tools cannot be checked in %s\n' "$1" "$dotfiles_husky_root" >&2
  printf 'husky toolchain guard: repair: install %s with the rest of the shared Husky files\n' "$2" >&2
  exit 1
}

dotfiles_husky_bootstrap="$HOME/.config/mise/bootstrap.sh"
if [ -f "$dotfiles_husky_bootstrap" ] && [ ! -L "$dotfiles_husky_bootstrap" ]; then
  # shellcheck source=/dev/null
  . "$dotfiles_husky_bootstrap"
elif [ -n "$dotfiles_husky_pinned" ]; then
  dotfiles_husky_partial "$dotfiles_husky_bootstrap" config/mise/bootstrap.sh
fi

# Refuse before any hook effect unless the pinned Node and pnpm are what runs.
dotfiles_husky_guard="$HOME/.config/husky/toolchain-guard.sh"
if [ -f "$dotfiles_husky_guard" ] && [ ! -L "$dotfiles_husky_guard" ]; then
  # shellcheck source=/dev/null
  . "$dotfiles_husky_guard"
elif [ -n "$dotfiles_husky_pinned" ]; then
  dotfiles_husky_partial "$dotfiles_husky_guard" config/husky/toolchain-guard.sh
fi
