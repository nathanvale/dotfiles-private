# shellcheck shell=sh
# Assert the checkout's pinned Node and pnpm before any hook effect.
#
# Sourced by init.sh after the Mise bootstrap, so a refusal (exit 1) stops the
# hook before pnpm installs or commits anything. It never trusts config, sets
# CI, or disables checks: Mise 2026.9.10 can fall back to the ambient PATH even
# with auto-install off, and pnpm's packageManagerStrict checks the name only,
# so the executables that will actually run are asked for their versions.
# pnpm is bound to the Mise-provisioned binary for the exact pin, never to PATH.
# Pins: package.json `engines.node` (or .nvmrc) and `packageManager`.
# Contract: bin/test/husky-toolchain-guard-test.sh

dotfiles_guard_refuse() {
  printf 'husky toolchain guard: %s\n' "$1" >&2
  printf 'husky toolchain guard: repair: %s\n' "$2" >&2
  exit 1
}

dotfiles_guard_exact() {
  case "$1" in
    ''|*[!0-9.]*|.*|*.|*..*) return 1 ;;
  esac
  [ "$(printf '%s' "$1" | tr -cd '.' | wc -c | tr -d ' ')" -eq 2 ]
}

dotfiles_guard_orig_path=$PATH
PATH="/usr/bin:/bin:$PATH"
dotfiles_guard_root=$(git rev-parse --show-toplevel 2>/dev/null) || dotfiles_guard_root=
dotfiles_guard_node_pin=
dotfiles_guard_pnpm_pin=
dotfiles_guard_engine=
dotfiles_guard_pm=
dotfiles_guard_nvm=
if [ -n "$dotfiles_guard_root" ]; then
  dotfiles_guard_pkg="$dotfiles_guard_root/package.json"
  if [ -f "$dotfiles_guard_pkg" ]; then
  # A string-aware scan keeps only the manifest's top-level engines.node and
  # packageManager; a nested `engines` object (for example under `config`)
  # cannot stand in for them. The last duplicate wins, as in JSON.parse.
    dotfiles_guard_keys=$(awk '
      BEGIN { RS = "\001"; depth = 0; instr = 0; esc = 0; pending = "" }
      {
        n = length($0)
        for (i = 1; i <= n; i++) {
          c = substr($0, i, 1)
          if (instr) {
            if (esc) { buf = buf c; esc = 0 }
            else if (c == "\\") { buf = buf c; esc = 1 }
            else if (c == "\"") {
              instr = 0
              if (pending != "") {
                path = ""
                for (d = 1; d <= depth; d++) path = path stack[d]
                if (path pending == "engines" SUBSEP "node") { node = buf; if (index(buf, "\\") > 0) escaped = 1 }
                if (path pending == "packageManager") { pm = buf; if (index(buf, "\\") > 0) escaped = 1 }
                pending = ""
              } else if (stack[depth] != "[]" SUBSEP) {
                if (index(buf, "\\") > 0) escaped = 1
                last = buf
              }
            } else buf = buf c
          } else if (c == "\"") { instr = 1; buf = "" }
          else if (c == ":") pending = last
          else if (c == "{") {
            depth++; stack[depth] = (depth == 1) ? "" : pending SUBSEP; pending = ""
          } else if (c == "[") { depth++; stack[depth] = "[]" SUBSEP; pending = "" }
          else if (c == "}" || c == "]") { depth--; pending = "" }
          else if (c == ",") pending = ""
        }
      }
      END { print "node=" node; print "pm=" pm; print "escaped=" escaped + 0 }
    ' "$dotfiles_guard_pkg")
    dotfiles_guard_engine=$(printf '%s\n' "$dotfiles_guard_keys" | sed -n 's/^node=//p')
    dotfiles_guard_pm=$(printf '%s\n' "$dotfiles_guard_keys" | sed -n 's/^pm=pnpm@\([^+]*\).*/\1/p')
    if [ "$(printf '%s\n' "$dotfiles_guard_keys" | sed -n 's/^escaped=//p')" != 0 ]; then
      dotfiles_guard_refuse "$dotfiles_guard_pkg has an escape sequence in an object key or pin value, which the guard cannot read as a pin" \
        "write package.json keys, engines.node and packageManager without escape sequences"
    fi
  fi
  # Node version files pin Node with or without a package.json.
  for dotfiles_guard_file in .nvmrc .node-version; do
    if [ -f "$dotfiles_guard_root/$dotfiles_guard_file" ]; then
      dotfiles_guard_nvm=$(tr -d ' \r\n' <"$dotfiles_guard_root/$dotfiles_guard_file")
      dotfiles_guard_nvm=${dotfiles_guard_nvm#v}
      break
    fi
  done
  if dotfiles_guard_exact "$dotfiles_guard_engine"; then
    dotfiles_guard_node_pin=$dotfiles_guard_engine
  elif dotfiles_guard_exact "$dotfiles_guard_nvm"; then
    dotfiles_guard_node_pin=$dotfiles_guard_nvm
  fi
  if [ -n "$dotfiles_guard_node_pin" ] && dotfiles_guard_exact "$dotfiles_guard_nvm" &&
    [ "$dotfiles_guard_nvm" != "$dotfiles_guard_node_pin" ]; then
    dotfiles_guard_refuse "package.json engines.node ($dotfiles_guard_node_pin) and the Node version file ($dotfiles_guard_nvm) disagree in $dotfiles_guard_root" \
      "make the checkout's two Node pins agree, then retry"
  fi
  if dotfiles_guard_exact "$dotfiles_guard_pm"; then
    dotfiles_guard_pnpm_pin=$dotfiles_guard_pm
  elif [ -n "$dotfiles_guard_pm" ]; then
    dotfiles_guard_refuse "packageManager pnpm@$dotfiles_guard_pm in $dotfiles_guard_root is not an exact version" \
      "pin packageManager to an exact pnpm x.y.z"
  fi
fi

# Phase A: every external helper (readlink, git, sed, awk, tr, wc) runs with
# the system directories ahead of the inherited PATH, which can carry a
# checkout-local entry, relative or absolute. Path arithmetic uses shell
# parameter expansion, not dirname or basename.
# Phase B (below) adds Husky's own `node_modules/.bin` prefix and runs only
# shell builtins plus the node and pnpm being judged.
if [ -n "$dotfiles_guard_node_pin" ]; then
  [ "${DOTFILES_MISE_ACTIVE:-}" = 1 ] ||
    dotfiles_guard_refuse "node $dotfiles_guard_node_pin is required but no applied Mise state is active, so no Node executable can be verified as Mise-owned" \
      "apply the toolchain with bin/dotfiles/toolchain update --apply; do not rely on ambient Node"
  # The shim only fails for untrusted config that needs trust (settings, env),
  # so a tools-only mise.toml would otherwise be read without its owner's
  # review. Mise is the executable the shim chain itself ends at, never one
  # found on PATH. Every hop and the final file must be absolute and outside
  # the checkout. Ask it from the checkout root; this never trusts anything.
  dotfiles_guard_root_phys=$(CDPATH='' cd -P "$dotfiles_guard_root" 2>/dev/null && pwd) || dotfiles_guard_root_phys=$dotfiles_guard_root
  dotfiles_guard_mise=$MISE_SHIMS_DIR/node
  dotfiles_guard_hops=0
  while [ -L "$dotfiles_guard_mise" ]; do
    dotfiles_guard_hops=$((dotfiles_guard_hops + 1))
    [ "$dotfiles_guard_hops" -le 16 ] ||
      dotfiles_guard_refuse "the Mise shim $MISE_SHIMS_DIR/node has a link chain longer than 16" \
        "reapply the toolchain with bin/dotfiles/toolchain update --apply"
    dotfiles_guard_link=$(readlink "$dotfiles_guard_mise" 2>/dev/null) || dotfiles_guard_link=
    case "$dotfiles_guard_link" in
      /*) dotfiles_guard_mise=$dotfiles_guard_link ;;
      '') dotfiles_guard_refuse "the Mise shim chain at $dotfiles_guard_mise cannot be read" \
            "reapply the toolchain with bin/dotfiles/toolchain update --apply" ;;
      *) dotfiles_guard_mise=${dotfiles_guard_mise%/*}/$dotfiles_guard_link ;;
    esac
    dotfiles_guard_mise_dir=$(CDPATH='' cd -P "${dotfiles_guard_mise%/*}" 2>/dev/null && pwd) ||
      dotfiles_guard_refuse "the Mise shim chain reaches $dotfiles_guard_mise, whose directory does not exist" \
        "reapply the toolchain with bin/dotfiles/toolchain update --apply"
    dotfiles_guard_mise=$dotfiles_guard_mise_dir/${dotfiles_guard_mise##*/}
    case "$dotfiles_guard_mise" in
      "$dotfiles_guard_root"/*|"$dotfiles_guard_root_phys"/*)
        dotfiles_guard_refuse "the Mise shim chain reaches $dotfiles_guard_mise, inside the checkout" \
          "reapply the toolchain so the shim links to the installed Mise" ;;
    esac
  done
  if [ "$dotfiles_guard_hops" -eq 0 ] || [ ! -x "$dotfiles_guard_mise" ] || [ ! -f "$dotfiles_guard_mise" ]; then
    dotfiles_guard_refuse "the Mise shim $MISE_SHIMS_DIR/node does not end at a runnable Mise executable (reached $dotfiles_guard_mise)" \
      "reapply the toolchain with bin/dotfiles/toolchain update --apply"
  fi
  # Mise's path trust does not follow edits: a trusted file that changes keeps
  # running. So every TOML config Mise could load for this checkout must have
  # its exact content digest recorded by bin/dotfiles/mise-config-review, and a
  # changed file has a new digest and is refused. Mise itself must not be asked
  # to list its configs first: `mise config ls` evaluates templates (`exec`) in
  # a changed [env], which would run unreviewed code before this refusal. So
  # the candidates come from Mise's documented file discovery, walked here over
  # the checkout and every ancestor directory, without parsing any of them.
  # Paths found missing in review: .config/mise.local.toml, .config/mise/mise.toml.
  # The selected global config is the applied revision's, and it is bound to
  # that revision's content identity (the directory name) before any Mise
  # command: the toolchain's apply names a revision by the digests of its four
  # files, so a changed config.toml or mise.lock no longer matches its name.
  dotfiles_guard_rev_dir=${MISE_GLOBAL_CONFIG_FILE%/*}
  dotfiles_guard_rev_id=${dotfiles_guard_rev_dir##*/}
  [ "${MISE_GLOBAL_CONFIG_FILE##*/}" = config.toml ] ||
    dotfiles_guard_refuse "the selected Mise global config $MISE_GLOBAL_CONFIG_FILE is not an applied revision's config.toml" \
      "reapply the toolchain with bin/dotfiles/toolchain update --apply"
  for dotfiles_guard_file in contract.txt manifest.tsv config.toml mise.lock; do
    [ -f "$dotfiles_guard_rev_dir/$dotfiles_guard_file" ] && [ ! -L "$dotfiles_guard_rev_dir/$dotfiles_guard_file" ] ||
      dotfiles_guard_refuse "the applied revision is missing $dotfiles_guard_rev_dir/$dotfiles_guard_file" \
        "reapply the toolchain with bin/dotfiles/toolchain update --apply"
  done
  dotfiles_guard_rev_calc=$(for dotfiles_guard_file in contract.txt manifest.tsv config.toml mise.lock; do
    printf '%s_sha256=%s\n' "$dotfiles_guard_file" "$(shasum -a 256 "$dotfiles_guard_rev_dir/$dotfiles_guard_file" | cut -d' ' -f1)"
  done | shasum -a 256 | cut -d' ' -f1)
  [ "$dotfiles_guard_rev_calc" = "$dotfiles_guard_rev_id" ] ||
    dotfiles_guard_refuse "the applied Mise revision $dotfiles_guard_rev_dir no longer matches its content identity (computed $dotfiles_guard_rev_calc)" \
      "do not edit an applied revision; reapply the toolchain with bin/dotfiles/toolchain update --apply"
  # Only the applied-state bootstrap variables and harmless shell/output
  # markers may be set. Any other inherited MISE_* name can add configs (a
  # system config file, extra search roots, trust lists, environments), turn on
  # automatic installation, or otherwise change what Mise does before any
  # review, so it refuses.
  for dotfiles_guard_var in $(env | sed -n 's/^\(MISE_[A-Za-z0-9_]*\)=.*/\1/p'); do
    case "$dotfiles_guard_var" in
      MISE_GLOBAL_CONFIG_FILE|MISE_DATA_DIR|MISE_INSTALLS_DIR|MISE_SHIMS_DIR) continue ;;
      MISE_SHELL|MISE_VERBOSE|MISE_QUIET|MISE_DEBUG|MISE_TRACE|MISE_COLOR) continue ;;
      # The guard exports these safe values itself (below), so a nested hook
      # inherits them; only exactly those values are accepted.
      MISE_NOT_FOUND_AUTO_INSTALL|MISE_AUTO_INSTALL|MISE_EXEC_AUTO_INSTALL)
        eval "dotfiles_guard_val=\${$dotfiles_guard_var:-}"
        [ "$dotfiles_guard_val" = false ] && continue ;;
      MISE_OFFLINE)
        [ "${MISE_OFFLINE:-}" = true ] && continue ;;
    esac
    dotfiles_guard_refuse "$dotfiles_guard_var is set, which is not part of the supported applied-state environment and can change what Mise loads, trusts or installs" \
      "unset $dotfiles_guard_var before running the hook"
  done
  # A reviewed project config may itself set not_found_auto_install,
  # auto_install or exec_auto_install (and a mirror), and the shim would then
  # start installing a missing tool during the check. Environment settings
  # outrank config files, so force installation off and Mise offline for the
  # check and for the hook that follows.
  MISE_NOT_FOUND_AUTO_INSTALL=false
  MISE_AUTO_INSTALL=false
  MISE_EXEC_AUTO_INSTALL=false
  MISE_OFFLINE=true
  export MISE_NOT_FOUND_AUTO_INSTALL MISE_AUTO_INSTALL MISE_EXEC_AUTO_INSTALL MISE_OFFLINE
  # Mise also derives its user config and trust-state locations from XDG
  # variables; only the default locations (or unset) are accepted.
  dotfiles_guard_home_phys=$(CDPATH='' cd -P "$HOME" 2>/dev/null && pwd) || dotfiles_guard_home_phys=$HOME
  for dotfiles_guard_var in XDG_CONFIG_HOME:.config XDG_STATE_HOME:.local/state XDG_DATA_HOME:.local/share XDG_CACHE_HOME:.cache; do
    eval "dotfiles_guard_val=\${${dotfiles_guard_var%%:*}:-}"
    [ -z "$dotfiles_guard_val" ] || [ "$dotfiles_guard_val" = "$HOME/${dotfiles_guard_var#*:}" ] || [ "$dotfiles_guard_val" = "$dotfiles_guard_home_phys/${dotfiles_guard_var#*:}" ] ||
      dotfiles_guard_refuse "${dotfiles_guard_var%%:*} is set to $dotfiles_guard_val, which moves Mise's config and trust locations" \
        "unset ${dotfiles_guard_var%%:*} before running the hook"
  done
  dotfiles_guard_ledger=$dotfiles_guard_home_phys/.dotfiles_state/toolchain/reviewed-configs
  # Mise's early settings files (.miserc.toml and miserc.toml, a rendered
  # template) can redirect which configs load (override_config_filenames,
  # ceilings, trust), and are read before any config. Rather than parse them,
  # any such file in a place Mise looks refuses the hook.
  dotfiles_guard_miserc_check() {
    for dotfiles_guard_early in "$1"/*miserc* "$1"/.*miserc*; do
      [ -e "$dotfiles_guard_early" ] || [ -L "$dotfiles_guard_early" ] || continue
      dotfiles_guard_refuse "Mise early settings file $dotfiles_guard_early can redirect which configs load before they are reviewed" \
        "remove it (or move it out of every Mise search path); the guard does not parse or review early settings files"
    done
  }
  dotfiles_guard_review_check() {
    case "$1" in
      "$MISE_GLOBAL_CONFIG_FILE") return 0 ;;
      *\\*) dotfiles_guard_refuse "a Mise config path has a backslash: $1" \
                "rename the file so its path has no escape sequences" ;;
    esac
    [ -f "$1" ] && [ ! -L "$1" ] ||
      dotfiles_guard_refuse "Mise config $1 is not a regular file" \
        "replace it with a regular file, review it, then run bin/dotfiles/mise-config-review"
    dotfiles_guard_digest=$(shasum -a 256 "$1" | cut -d' ' -f1) ||
      dotfiles_guard_refuse "could not digest Mise config $1" "repair shasum"
    if [ -L "$dotfiles_guard_home_phys/.dotfiles_state" ] || [ -L "$dotfiles_guard_home_phys/.dotfiles_state/toolchain" ] ||
      [ -L "$dotfiles_guard_ledger" ] || [ -L "$dotfiles_guard_ledger/$dotfiles_guard_digest" ] ||
      [ ! -f "$dotfiles_guard_ledger/$dotfiles_guard_digest" ]; then
      dotfiles_guard_refuse "Mise config $1 (sha256 $dotfiles_guard_digest) has not been reviewed in its current content" \
        "read it, then run bin/dotfiles/mise-config-review $1; the guard never trusts or reviews it for you"
    fi
  }
  for dotfiles_guard_early_dir in /etc/mise "$dotfiles_guard_home_phys" "$dotfiles_guard_home_phys/.config" "$dotfiles_guard_home_phys/.config/mise"; do
    dotfiles_guard_miserc_check "$dotfiles_guard_early_dir"
  done
  # System and user config locations load whether or not they are ancestors.
  for dotfiles_guard_cfg in /etc/mise/config.toml /etc/mise/config.local.toml /etc/mise/conf.d/*.toml \
    "$dotfiles_guard_home_phys"/.config/mise/config.toml "$dotfiles_guard_home_phys"/.config/mise/config.local.toml \
    "$dotfiles_guard_home_phys"/.config/mise/conf.d/*.toml "$dotfiles_guard_home_phys"/.config/mise.toml; do
    [ -e "$dotfiles_guard_cfg" ] || [ -L "$dotfiles_guard_cfg" ] || continue
    dotfiles_guard_review_check "$dotfiles_guard_cfg"
  done
  dotfiles_guard_dir=$dotfiles_guard_root_phys
  while :; do
    for dotfiles_guard_early_dir in "$dotfiles_guard_dir" "$dotfiles_guard_dir/.config" "$dotfiles_guard_dir/.config/mise" "$dotfiles_guard_dir/.mise" "$dotfiles_guard_dir/mise"; do
      dotfiles_guard_miserc_check "$dotfiles_guard_early_dir"
    done
    # Files named for Mise directly in a directory or its .config, then the
    # config files inside mise, .mise and .config/mise directories.
    for dotfiles_guard_base in "$dotfiles_guard_dir" "$dotfiles_guard_dir/.config"; do
      for dotfiles_guard_cfg in \
        "$dotfiles_guard_base"/mise.toml "$dotfiles_guard_base"/.mise.toml \
        "$dotfiles_guard_base"/mise.local.toml "$dotfiles_guard_base"/.mise.local.toml \
        "$dotfiles_guard_base"/mise.*.toml "$dotfiles_guard_base"/.mise.*.toml; do
        [ -e "$dotfiles_guard_cfg" ] || [ -L "$dotfiles_guard_cfg" ] || continue
        dotfiles_guard_review_check "$dotfiles_guard_cfg"
      done
    done
    for dotfiles_guard_base in "$dotfiles_guard_dir/mise" "$dotfiles_guard_dir/.mise" "$dotfiles_guard_dir/.config/mise"; do
      for dotfiles_guard_cfg in \
        "$dotfiles_guard_base"/config.toml "$dotfiles_guard_base"/config.local.toml \
        "$dotfiles_guard_base"/mise.toml "$dotfiles_guard_base"/mise.local.toml \
        "$dotfiles_guard_base"/config.*.toml "$dotfiles_guard_base"/mise.*.toml \
        "$dotfiles_guard_base"/conf.d/*.toml; do
        [ -e "$dotfiles_guard_cfg" ] || [ -L "$dotfiles_guard_cfg" ] || continue
        dotfiles_guard_review_check "$dotfiles_guard_cfg"
      done
    done
    [ "$dotfiles_guard_dir" = / ] && break
    dotfiles_guard_dir=${dotfiles_guard_dir%/*}
    [ -n "$dotfiles_guard_dir" ] || dotfiles_guard_dir=/
  done
  # Only now, with every selector clear and every candidate reviewed, is Mise
  # asked anything: even `mise trust --show` can evaluate an inherited or
  # unreviewed config on a cold HOME.
  dotfiles_guard_trust=$(CDPATH='' cd "$dotfiles_guard_root" && "$dotfiles_guard_mise" trust --show 2>/dev/null) ||
    dotfiles_guard_refuse "mise trust --show failed in $dotfiles_guard_root" \
      "repair Mise so config trust can be read"
  case "$dotfiles_guard_trust" in
    *": untrusted"*)
      dotfiles_guard_refuse "Mise reports untrusted config for $dotfiles_guard_root: $dotfiles_guard_trust" \
        "review the config, then run \`mise trust <exact reviewed config file>\`; the guard never trusts it" ;;
  esac
  # Every discovered file is reviewed, so Mise may now list what it loads. A
  # TOML it loads that the walk missed (a discovery rule this guard does not
  # know) still refuses the hook here.
  dotfiles_guard_cfgs=$(CDPATH='' cd "$dotfiles_guard_root" && "$dotfiles_guard_mise" config ls --json 2>/dev/null) ||
    dotfiles_guard_refuse "mise config ls failed in $dotfiles_guard_root" \
      "repair Mise so the loaded config files can be listed"
  dotfiles_guard_old_ifs=$IFS
  IFS='
'
  set -f
  for dotfiles_guard_cfg in $(printf '%s\n' "$dotfiles_guard_cfgs" | sed -n 's/^[[:space:]]*"path": "\(.*\)",\{0,1\}$/\1/p'); do
    case "$dotfiles_guard_cfg" in
      *.toml) dotfiles_guard_review_check "$dotfiles_guard_cfg" ;;
    esac
  done
  set +f
  IFS=$dotfiles_guard_old_ifs
  # An empty answer is not evidence of trust: when the checkout carries a
  # trust-gated Mise config, Mise must positively name this checkout trusted.
  dotfiles_guard_has_config=false
  for dotfiles_guard_file in mise.toml .mise.toml mise.local.toml .mise.local.toml \
    mise/config.toml .mise/config.toml .config/mise.toml .config/mise/config.toml; do
    [ -e "$dotfiles_guard_root/$dotfiles_guard_file" ] && dotfiles_guard_has_config=true
  done
  if [ "$dotfiles_guard_has_config" = true ]; then
    # Mise prints paths under HOME with a leading ~, so match that spelling too.
    dotfiles_guard_home_phys=$(CDPATH='' cd -P "$HOME" 2>/dev/null && pwd) || dotfiles_guard_home_phys=$HOME
    dotfiles_guard_named=false
    for dotfiles_guard_candidate in "$dotfiles_guard_root" "$dotfiles_guard_root_phys"; do
      dotfiles_guard_spellings="$dotfiles_guard_candidate"
      case "$dotfiles_guard_candidate" in
        "$HOME"/*) dotfiles_guard_tilde="~${dotfiles_guard_candidate#"$HOME"}" ;;
        "$dotfiles_guard_home_phys"/*) dotfiles_guard_tilde="~${dotfiles_guard_candidate#"$dotfiles_guard_home_phys"}" ;;
        *) dotfiles_guard_tilde= ;;
      esac
      for dotfiles_guard_spelling in "$dotfiles_guard_spellings" "$dotfiles_guard_tilde"; do
        [ -n "$dotfiles_guard_spelling" ] || continue
        case "
$dotfiles_guard_trust
" in
          *"
$dotfiles_guard_spelling: trusted
"*) dotfiles_guard_named=true ;;
        esac
      done
    done
    [ "$dotfiles_guard_named" = true ] ||
      dotfiles_guard_refuse "checkout $dotfiles_guard_root has a Mise config but Mise did not report it trusted (got [$dotfiles_guard_trust])" \
        "review the config, then run \`mise trust <exact reviewed config file>\`; the guard never trusts it"
  fi
fi

# The pnpm that runs is the Mise-provisioned binary for this checkout's exact
# pin, not whatever pnpm is on PATH: an ambient pnpm (for example Homebrew's)
# may report its own version yet forward to the pin inside a project, so its
# version proves nothing about the executable. Provisioning is explicit
# (bin/dotfiles/pnpm-provision); the hook only checks the installed file and
# never downloads. The binary must be a regular file under the Mise installs
# directory and outside the checkout, and asked for its version with manager
# switching off so it cannot forward.
dotfiles_guard_pnpm_dir=
if [ -n "$dotfiles_guard_pnpm_pin" ]; then
  [ "${DOTFILES_MISE_ACTIVE:-}" = 1 ] ||
    dotfiles_guard_refuse "pnpm $dotfiles_guard_pnpm_pin is required but no applied Mise state is active, so no pnpm executable can be bound to the pin" \
      "apply the toolchain with bin/dotfiles/toolchain update --apply"
  dotfiles_guard_pnpm_dir=$MISE_INSTALLS_DIR/pnpm/$dotfiles_guard_pnpm_pin
  dotfiles_guard_pnpm_bin=$dotfiles_guard_pnpm_dir/pnpm
  if [ -L "$dotfiles_guard_pnpm_bin" ] || [ -L "$dotfiles_guard_pnpm_dir" ] || [ ! -f "$dotfiles_guard_pnpm_bin" ] || [ ! -x "$dotfiles_guard_pnpm_bin" ]; then
    dotfiles_guard_refuse "pnpm $dotfiles_guard_pnpm_pin is required but $dotfiles_guard_pnpm_bin is not an installed regular executable" \
      "provision it once with bin/dotfiles/pnpm-provision $dotfiles_guard_pnpm_pin; the hook never downloads"
  fi
  dotfiles_guard_pnpm_phys=$(CDPATH='' cd -P "$dotfiles_guard_pnpm_dir" 2>/dev/null && pwd) || dotfiles_guard_pnpm_phys=
  dotfiles_guard_root_phys=$(CDPATH='' cd -P "$dotfiles_guard_root" 2>/dev/null && pwd) || dotfiles_guard_root_phys=$dotfiles_guard_root
  case "$dotfiles_guard_pnpm_phys/" in
    "$dotfiles_guard_root"/*|"$dotfiles_guard_root_phys"/*|/)
      dotfiles_guard_refuse "pnpm $dotfiles_guard_pnpm_pin resolves to $dotfiles_guard_pnpm_phys, inside the checkout or nowhere" \
        "inspect $dotfiles_guard_pnpm_dir and move it aside yourself if it is wrong, then run bin/dotfiles/pnpm-provision $dotfiles_guard_pnpm_pin" ;;
  esac
  COREPACK_ENABLE_NETWORK=0
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  export COREPACK_ENABLE_NETWORK COREPACK_ENABLE_DOWNLOAD_PROMPT
  dotfiles_guard_got=$(CDPATH='' cd "$dotfiles_guard_root" && npm_config_manage_package_manager_versions=false "$dotfiles_guard_pnpm_bin" --version 2>&1) ||
    dotfiles_guard_refuse "pnpm $dotfiles_guard_pnpm_pin is required but $dotfiles_guard_pnpm_bin failed: $dotfiles_guard_got" \
      "inspect $dotfiles_guard_pnpm_bin; if it is wrong, move $dotfiles_guard_pnpm_dir aside yourself and run bin/dotfiles/pnpm-provision $dotfiles_guard_pnpm_pin (it never overwrites an installed tool)"
  [ "$dotfiles_guard_got" = "$dotfiles_guard_pnpm_pin" ] ||
    dotfiles_guard_refuse "pnpm $dotfiles_guard_pnpm_pin is required but $dotfiles_guard_pnpm_bin reported [$dotfiles_guard_got]" \
      "inspect $dotfiles_guard_pnpm_bin; if it is wrong, move $dotfiles_guard_pnpm_dir aside yourself and run bin/dotfiles/pnpm-provision $dotfiles_guard_pnpm_pin (it never overwrites an installed tool)"
  # The hook's pnpm, and any pnpm it starts, must not forward to another manager.
  npm_config_manage_package_manager_versions=false
  export npm_config_manage_package_manager_versions
fi

# Husky's wrapper runs `export PATH="node_modules/.bin:$PATH"` after this init,
# before the hook body. Apply the same prefix now, so every check below sees
# the executables the hook will actually resolve, and a repo-local shadow of
# node or pnpm is judged rather than skipped.
PATH=$dotfiles_guard_orig_path
if [ -n "$dotfiles_guard_pnpm_dir" ]; then
  PATH="$dotfiles_guard_pnpm_dir:$PATH"
fi
if [ -n "$dotfiles_guard_node_pin" ] || [ -n "$dotfiles_guard_pnpm_pin" ]; then
  PATH="node_modules/.bin:$PATH"
fi
export PATH

if [ -n "$dotfiles_guard_node_pin" ]; then
  # Only the Mise shim evaluates the checkout's config trust on every launch;
  # a node found elsewhere (even a link into the Mise install) would skip it.
  [ "$(command -v node 2>/dev/null)" = "$MISE_SHIMS_DIR/node" ] ||
    dotfiles_guard_refuse "node resolves to $(command -v node 2>/dev/null), not the Mise shim $MISE_SHIMS_DIR/node" \
      "remove the shadowing node from node_modules/.bin or PATH so the Mise shim runs"
  dotfiles_guard_got=$(node -p 'process.version + " " + process.execPath' 2>&1) ||
    dotfiles_guard_refuse "node $dotfiles_guard_node_pin is required but node failed: $dotfiles_guard_got" \
      "run \`mise trust <exact reviewed config file>\` for this checkout if Mise reports an untrusted config, or install node $dotfiles_guard_node_pin with \`mise install node@$dotfiles_guard_node_pin\`"
  dotfiles_guard_version=${dotfiles_guard_got%% *}
  dotfiles_guard_exec=${dotfiles_guard_got#* }
  [ "$dotfiles_guard_version" = "v$dotfiles_guard_node_pin" ] ||
    dotfiles_guard_refuse "node $dotfiles_guard_node_pin is required but $dotfiles_guard_exec is $dotfiles_guard_version" \
      "install node $dotfiles_guard_node_pin with Mise and trust the exact reviewed config; do not rely on PATH fallback"
  dotfiles_guard_installs=$(CDPATH='' cd -P "$MISE_INSTALLS_DIR/node/$dotfiles_guard_node_pin/bin" 2>/dev/null && pwd) || dotfiles_guard_installs=$MISE_INSTALLS_DIR/node/$dotfiles_guard_node_pin/bin
  [ "$dotfiles_guard_exec" = "$dotfiles_guard_installs/node" ] ||
    dotfiles_guard_refuse "node $dotfiles_guard_node_pin ran from $dotfiles_guard_exec, not the Mise install" \
      "install node $dotfiles_guard_node_pin with Mise so the shim selects it"
fi

if [ -n "$dotfiles_guard_pnpm_pin" ]; then
  # After Husky's own PATH change the name pnpm must still resolve to the bound
  # binary: a node_modules/.bin/pnpm (or anything else ahead of it) is refused.
  [ "$(command -v pnpm 2>/dev/null)" = "$dotfiles_guard_pnpm_bin" ] ||
    dotfiles_guard_refuse "pnpm resolves to $(command -v pnpm 2>/dev/null), not the bound pnpm $dotfiles_guard_pnpm_bin" \
      "remove the shadowing pnpm from node_modules/.bin or PATH"
  dotfiles_guard_got=$(pnpm --version 2>&1) ||
    dotfiles_guard_refuse "pnpm $dotfiles_guard_pnpm_pin is required but the bound pnpm failed: $dotfiles_guard_got" \
      "inspect $dotfiles_guard_pnpm_bin; if it is wrong, move $dotfiles_guard_pnpm_dir aside yourself and run bin/dotfiles/pnpm-provision $dotfiles_guard_pnpm_pin (it never overwrites an installed tool)"
  [ "$dotfiles_guard_got" = "$dotfiles_guard_pnpm_pin" ] ||
    dotfiles_guard_refuse "pnpm $dotfiles_guard_pnpm_pin is required but the bound pnpm reported [$dotfiles_guard_got]" \
      "inspect $dotfiles_guard_pnpm_bin; if it is wrong, move $dotfiles_guard_pnpm_dir aside yourself and run bin/dotfiles/pnpm-provision $dotfiles_guard_pnpm_pin (it never overwrites an installed tool)"
fi

# The root resolving correctly is not enough: lint-staged runs each workspace
# package's tasks from that package with the node_modules/.bin of that
# directory and of every ancestor up to / ahead of PATH, and pnpm's generated
# bin wrappers run a sibling node, or else the first node on PATH. So a node or
# package manager in any of those directories, inside the checkout or above
# it, would run instead of the pins. Packages are listed by Git (tracked or
# untracked, not ignored) with no fsmonitor hook.
if [ -n "$dotfiles_guard_node_pin" ] || [ -n "$dotfiles_guard_pnpm_pin" ]; then
  dotfiles_guard_packages=$(/usr/bin/git -C "$dotfiles_guard_root" -c core.fsmonitor=false -c core.quotePath=false \
    ls-files --cached --others --exclude-standard -- package.json '*/package.json' 2>/dev/null) ||
    dotfiles_guard_refuse "cannot list the package directories of $dotfiles_guard_root" \
      "check that git ls-files works in this checkout"
  dotfiles_guard_seen='
'
  # Checks a directory's node_modules/.bin and every ancestor's, once each.
  dotfiles_guard_shadow_walk() {
    dotfiles_guard_walk=$1
    while :; do
      case "$dotfiles_guard_seen" in *"
$dotfiles_guard_walk
"*) return 0 ;; esac
      dotfiles_guard_seen="$dotfiles_guard_seen$dotfiles_guard_walk
"
      dotfiles_guard_bin="${dotfiles_guard_walk%/}/node_modules/.bin"
      for dotfiles_guard_name in node pnpm pnpx npm npx corepack; do
        if [ -e "$dotfiles_guard_bin/$dotfiles_guard_name" ] || [ -L "$dotfiles_guard_bin/$dotfiles_guard_name" ]; then
          dotfiles_guard_refuse "shadowing $dotfiles_guard_bin/$dotfiles_guard_name would run instead of the pinned tools" \
            "remove the dependency that provides that $dotfiles_guard_name bin, or that stray node_modules directory, yourself; lint-staged puts each package's node_modules/.bin and every ancestor's on PATH"
        fi
      done
      [ "$dotfiles_guard_walk" != / ] || return 0
      dotfiles_guard_walk=${dotfiles_guard_walk%/*}
      [ -n "$dotfiles_guard_walk" ] || dotfiles_guard_walk=/
    done
  }
  while IFS= read -r dotfiles_guard_package; do
    case "$dotfiles_guard_package" in
      '') continue ;;
      \"*) dotfiles_guard_refuse "cannot check the package path $dotfiles_guard_package, which Git quotes" \
             "rename that package directory without control characters, quotes or backslashes" ;;
    esac
    dotfiles_guard_dir="$dotfiles_guard_root/$dotfiles_guard_package"
    dotfiles_guard_shadow_walk "${dotfiles_guard_dir%/package.json}"
  done <<EOF
package.json
$dotfiles_guard_packages
EOF
fi

unset dotfiles_guard_early dotfiles_guard_early_dir dotfiles_guard_base dotfiles_guard_var dotfiles_guard_val dotfiles_guard_dir dotfiles_guard_cfgs dotfiles_guard_ledger dotfiles_guard_old_ifs dotfiles_guard_cfg dotfiles_guard_digest dotfiles_guard_pnpm_dir dotfiles_guard_pnpm_bin dotfiles_guard_pnpm_phys dotfiles_guard_home_phys dotfiles_guard_named dotfiles_guard_candidate dotfiles_guard_spellings dotfiles_guard_tilde dotfiles_guard_spelling dotfiles_guard_orig_path dotfiles_guard_has_config dotfiles_guard_hops dotfiles_guard_link dotfiles_guard_mise_dir dotfiles_guard_root_phys dotfiles_guard_mise dotfiles_guard_trust dotfiles_guard_major dotfiles_guard_last dotfiles_guard_keys dotfiles_guard_root dotfiles_guard_pkg dotfiles_guard_engine dotfiles_guard_pm
unset dotfiles_guard_nvm dotfiles_guard_file dotfiles_guard_node_pin dotfiles_guard_pnpm_pin
unset dotfiles_guard_installs dotfiles_guard_got dotfiles_guard_version dotfiles_guard_exec
unset dotfiles_guard_packages dotfiles_guard_package dotfiles_guard_bin dotfiles_guard_name dotfiles_guard_seen dotfiles_guard_walk dotfiles_guard_dir
unset -f dotfiles_guard_miserc_check dotfiles_guard_review_check dotfiles_guard_refuse dotfiles_guard_exact dotfiles_guard_shadow_walk
