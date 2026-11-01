#!/bin/sh
# Sourced by Husky init for explicitly opted-in worktrees. Selection never
# invokes Mise, Corepack, a package-manager shim or an installer.
# Contract: bin/test/husky-direct-pins-test.sh

# Every refusal names its cause and its repair.
direct_pins_fail() {
  printf 'husky direct pins: %s\n' "$1" >&2
  printf 'husky direct pins: repair: %s\n' "$2" >&2
  exit 1
}

direct_pins_exact_version() {
  case "$1" in ''|*[!0-9.]*|.*|*.|*..*) return 1 ;; esac
  direct_pins_tail=${1#*.}
  [ "$direct_pins_tail" != "$1" ] || return 1
  direct_pins_patch=${direct_pins_tail#*.}
  [ "$direct_pins_patch" != "$direct_pins_tail" ] || return 1
  case "$direct_pins_patch" in ''|*.*) return 1 ;; esac
}

direct_pins_opt_out='or remove .husky/direct-pins to use the guarded Mise route'
[ -n "${dotfiles_husky_root-}" ] ||
  direct_pins_fail 'no Git worktree root' 'run the hook from inside a Git worktree'
direct_pins_pkg="$dotfiles_husky_root/package.json"
direct_pins_nvm="$dotfiles_husky_root/.nvmrc"
[ -f "$direct_pins_pkg" ] && [ ! -L "$direct_pins_pkg" ] ||
  direct_pins_fail "missing regular manifest $direct_pins_pkg" \
    "add a regular package.json with exact engines.node and packageManager pins, $direct_pins_opt_out"
[ -f "$direct_pins_nvm" ] && [ ! -L "$direct_pins_nvm" ] ||
  direct_pins_fail "missing regular Node pin $direct_pins_nvm" \
    "add a regular .nvmrc that holds the engines.node version, $direct_pins_opt_out"
direct_pins_node=$(/usr/bin/plutil -extract engines.node raw -o - "$direct_pins_pkg" 2>/dev/null) ||
  direct_pins_fail 'package.json engines.node must be an exact pin' 'set engines.node to an exact x.y.z version'
direct_pins_manager=$(/usr/bin/plutil -extract packageManager raw -o - "$direct_pins_pkg" 2>/dev/null) ||
  direct_pins_fail 'package.json packageManager must be an exact pin' 'set packageManager to pnpm@x.y.z'
# Normalised as the guard does: no spaces or line endings, an optional v.
direct_pins_nvm_version=$(/usr/bin/tr -d ' \r\n' <"$direct_pins_nvm") ||
  direct_pins_fail "cannot read $direct_pins_nvm" "make $direct_pins_nvm readable"
direct_pins_nvm_version=${direct_pins_nvm_version#v}
direct_pins_exact_version "$direct_pins_node" ||
  direct_pins_fail "invalid engines.node pin [$direct_pins_node]" 'set engines.node to an exact x.y.z version'
# Corepack's integrity suffix (pnpm@x.y.z+sha512.<hash>) is allowed, as the
# guard allows it; the version is what is pinned.
case "$direct_pins_manager" in pnpm@*) direct_pins_pnpm=${direct_pins_manager#pnpm@}; direct_pins_pnpm=${direct_pins_pnpm%%+*} ;;
  *) direct_pins_fail "packageManager [$direct_pins_manager] must pin pnpm" \
       "set packageManager to pnpm@x.y.z, $direct_pins_opt_out" ;; esac
direct_pins_exact_version "$direct_pins_pnpm" ||
  direct_pins_fail "invalid pnpm pin [$direct_pins_pnpm]" 'set packageManager to pnpm@x.y.z'
[ "$direct_pins_node" = "$direct_pins_nvm_version" ] ||
  direct_pins_fail "engines.node [$direct_pins_node] and .nvmrc [$direct_pins_nvm_version] disagree" \
    'make engines.node and .nvmrc name the same x.y.z version'

# Husky's wrapper puts node_modules/.bin first on PATH. lint-staged runs each
# workspace package's tasks from that package with the node_modules/.bin of
# that directory and of every ancestor up to / ahead of PATH, and pnpm's
# generated bin wrappers run a sibling node, or else the first node on PATH.
# So a tool of any of these names in any of those directories, inside the
# checkout or above it, would run instead of the pins. Packages are listed by
# Git (tracked or untracked, not ignored) with no fsmonitor hook.
direct_pins_packages=$(/usr/bin/git -C "$dotfiles_husky_root" -c core.fsmonitor=false -c core.quotePath=false \
  ls-files --cached --others --exclude-standard -- package.json '*/package.json' 2>/dev/null) ||
  direct_pins_fail "cannot list the package directories of $dotfiles_husky_root" \
    'check that git ls-files works in this checkout'
direct_pins_seen='
'
# Checks a directory's node_modules/.bin and every ancestor's, once each.
direct_pins_shadow_walk() {
  direct_pins_walk=$1
  while :; do
    case "$direct_pins_seen" in *"
$direct_pins_walk
"*) return 0 ;; esac
    direct_pins_seen="$direct_pins_seen$direct_pins_walk
"
    direct_pins_bin="${direct_pins_walk%/}/node_modules/.bin"
    for direct_pins_name in node pnpm pnpx npm npx corepack; do
      if [ -e "$direct_pins_bin/$direct_pins_name" ] || [ -L "$direct_pins_bin/$direct_pins_name" ]; then
        direct_pins_fail "shadowing $direct_pins_bin/$direct_pins_name would run instead of the pinned tools" \
          "remove the dependency that provides that $direct_pins_name bin, or that stray node_modules directory, yourself; lint-staged puts each package's node_modules/.bin and every ancestor's on PATH"
      fi
    done
    [ "$direct_pins_walk" != / ] || return 0
    direct_pins_walk=${direct_pins_walk%/*}
    [ -n "$direct_pins_walk" ] || direct_pins_walk=/
  done
}
while IFS= read -r direct_pins_package; do
  case "$direct_pins_package" in
    '') continue ;;
    \"*) direct_pins_fail "cannot check the package path $direct_pins_package, which Git quotes" \
           'rename that package directory without control characters, quotes or backslashes' ;;
  esac
  direct_pins_dir="$dotfiles_husky_root/$direct_pins_package"
  direct_pins_shadow_walk "${direct_pins_dir%/package.json}"
done <<EOF
package.json
$direct_pins_packages
EOF

HUSKY_PINNED_NODE="$HOME/.local/share/mise/installs/node/$direct_pins_node/bin/node"
HUSKY_PINNED_PNPM="$HOME/.local/share/mise/installs/pnpm/$direct_pins_pnpm/pnpm"
direct_pins_node_repair="install Node $direct_pins_node with Mise outside Git hooks (bin/dotfiles/toolchain update --apply, or mise install node@$direct_pins_node)"
direct_pins_pnpm_repair="run bin/dotfiles/pnpm-provision $direct_pins_pnpm outside Git hooks"
for direct_pins_pair in "$HUSKY_PINNED_NODE|$direct_pins_node_repair" "$HUSKY_PINNED_PNPM|$direct_pins_pnpm_repair"; do
  direct_pins_file=${direct_pins_pair%%|*}
  [ ! -L "$direct_pins_file" ] ||
    direct_pins_fail "linked pinned executable $direct_pins_file" \
      'replace the link with the real install yourself; nothing here removes it'
  [ -f "$direct_pins_file" ] && [ -x "$direct_pins_file" ] ||
    direct_pins_fail "missing pinned executable $direct_pins_file" \
      "provision explicitly: ${direct_pins_pair#*|}"
done
# A link anywhere below the installs root (a version directory, bin) could
# point into the checkout, so each executable must physically live exactly at
# its install path, and the installs root itself outside the checkout.
direct_pins_installs=$(CDPATH='' cd -P "$HOME/.local/share/mise/installs" 2>/dev/null && pwd) ||
  direct_pins_fail "missing Mise installs directory $HOME/.local/share/mise/installs" "$direct_pins_node_repair"
direct_pins_root_phys=$(CDPATH='' cd -P "$dotfiles_husky_root" 2>/dev/null && pwd) ||
  direct_pins_root_phys=$dotfiles_husky_root
case "$direct_pins_installs/" in
  "$dotfiles_husky_root"/*|"$direct_pins_root_phys"/*)
    direct_pins_fail "the Mise installs directory $direct_pins_installs is inside the checkout" \
      "point $HOME/.local/share/mise/installs at a directory outside the checkout yourself" ;;
esac
for direct_pins_pair in "$HUSKY_PINNED_NODE|node/$direct_pins_node/bin" "$HUSKY_PINNED_PNPM|pnpm/$direct_pins_pnpm"; do
  direct_pins_file=${direct_pins_pair%%|*}
  direct_pins_dir=$(CDPATH='' cd -P "${direct_pins_file%/*}" 2>/dev/null && pwd) ||
    direct_pins_fail "cannot resolve the directory of $direct_pins_file" \
      "check that ${direct_pins_file%/*} is a readable directory"
  [ "$direct_pins_dir" = "$direct_pins_installs/${direct_pins_pair#*|}" ] ||
    direct_pins_fail "pinned executable $direct_pins_file resolves to $direct_pins_dir, not its own install directory" \
      'replace the link with the real install yourself; nothing here removes it'
done

# Disable Corepack network and pnpm's automatic package-manager forwarding.
COREPACK_ENABLE_NETWORK=0
COREPACK_ENABLE_AUTO_PIN=0
npm_config_manage_package_manager_versions=false
export COREPACK_ENABLE_NETWORK COREPACK_ENABLE_AUTO_PIN npm_config_manage_package_manager_versions
direct_pins_node_actual=$("$HUSKY_PINNED_NODE" --version 2>/dev/null) ||
  direct_pins_fail "cannot execute pinned Node $HUSKY_PINNED_NODE" \
    "inspect it; if it is broken, move $HOME/.local/share/mise/installs/node/$direct_pins_node aside yourself and $direct_pins_node_repair"
[ "$direct_pins_node_actual" = "v$direct_pins_node" ] ||
  direct_pins_fail "Node executable is $direct_pins_node_actual, expected v$direct_pins_node" \
    "inspect it; if it is wrong, move $HOME/.local/share/mise/installs/node/$direct_pins_node aside yourself and $direct_pins_node_repair"
direct_pins_pnpm_actual=$("$HUSKY_PINNED_PNPM" --version 2>/dev/null) ||
  direct_pins_fail "cannot execute pinned pnpm $HUSKY_PINNED_PNPM" \
    "inspect it; if it is broken, move ${HUSKY_PINNED_PNPM%/*} aside yourself and $direct_pins_pnpm_repair (it never overwrites an installed tool)"
[ "$direct_pins_pnpm_actual" = "$direct_pins_pnpm" ] ||
  direct_pins_fail "pnpm executable is $direct_pins_pnpm_actual, expected $direct_pins_pnpm" \
    "inspect it; if it is wrong, move ${HUSKY_PINNED_PNPM%/*} aside yourself and $direct_pins_pnpm_repair (it never overwrites an installed tool)"
PATH="${HUSKY_PINNED_NODE%/*}:$PATH"
export PATH HUSKY_PINNED_NODE HUSKY_PINNED_PNPM
