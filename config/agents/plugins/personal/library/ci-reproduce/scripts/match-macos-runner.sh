#!/usr/bin/env bash
# Run a public GitHub repository's command on an Apple silicon Mac, or in a Tart
# macOS VM on it, with the git, Bun and Node versions of GitHub's hosted macOS
# runner. Toolchains and run logs stay under
# ${XDG_STATE_HOME:-$HOME/.local/state}/ci-reproduce; Homebrew, mise and the
# default PATH are left alone.
#
# From another Mac:
#   ssh mac-mini bash -s -- --repo OWNER/NAME --ref REF -- 'COMMAND' < match-macos-runner.sh
set -euo pipefail

# Checksums: git from kernel.org sha256sums.asc (Homebrew's formula agrees);
# Bun and Node from their releases' SHASUMS256.txt. Other versions use those
# lists live.
readonly default_git=2.56.1
readonly default_git_sha256=f0b0bf89264b9bd2e1c640363e7529643989da76281600473c50745cd34a607f
readonly default_bun=1.4.4
readonly default_bun_sha256=c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510
readonly default_node=24.22.2
readonly default_node_sha256=aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a

state=${XDG_STATE_HOME:-$HOME/.local/state}/ci-reproduce
vm_name=""
vm_pid=""
vm_disposable=false
transport_pid=""

say() { printf 'match-macos-runner: %s\n' "$*" >&2; }
die() {
	say "$*"
	exit 2
}

usage() {
	cat >&2 <<EOF
Usage: match-macos-runner.sh --repo OWNER/NAME --ref REF [options] -- COMMAND
       match-macos-runner.sh --prepare [--vm BASE] [versions]

  --repo OWNER/NAME  public GitHub repository, cloned over HTTPS
  --ref REF          branch, tag or commit to check out
  --git VERSION      git built from kernel.org (default $default_git)
  --bun VERSION      Bun from its GitHub release (default $default_bun)
  --node VERSION     Node from nodejs.org (default $default_node)
  --vm BASE          run in a disposable clone of the Tart VM BASE;
                     with --prepare, install the toolchains into BASE itself
  --prepare          install the toolchains only
  --keep             keep the checkout (and, with --vm, the stopped clone)
  COMMAND            shell command run in the checkout by bash -e, as one
                     argument; it is printed and logged, so keep secrets out

Exit status is COMMAND's; 2 means the run could not start.
EOF
	exit 2
}

# Waits on a kernel lock (lockf) held through file descriptor FD. The kernel
# drops it when every process holding FD exits, so a killed run or a VM that
# powered off never leaves a stale lock behind.
wait_lock() {
	local fd=$1 what=$2
	lockf -s -t 0 "$fd" && return
	say "waiting for $what"
	lockf -s -t 900 "$fd" || die "gave up waiting for $what after 900 s"
}

check_sha256() {
	local file=$1 expected=$2 actual
	actual=$(shasum -a 256 "$file" | awk '{print $1}')
	[[ $actual == "$expected" ]] || die "checksum mismatch for $file: $actual, expected $expected"
}

# Prints the expected SHA-256 for FILE: the pinned value for the default
# version, otherwise the line naming FILE in the published list at SUMS_URL.
expected_sha256() {
	local version=$1 default_version=$2 default_sha=$3 sums_url=$4 file=$5 sha
	if [[ $version == "$default_version" ]]; then
		printf '%s\n' "$default_sha"
		return
	fi
	sha=$(curl -fsSL "$sums_url" | awk -v f="$file" '$2 == f {print $1}') || die "cannot read $sums_url"
	[[ -n $sha ]] || die "$sums_url lists no checksum for $file"
	printf '%s\n' "$sha"
}

fetch() { curl -fsSL -o "$1" "$2" || die "download failed: $2"; }

ensure_git() {
	local version=$1 prefix=$state/git-$1 expected tmp
	[[ -f $prefix/.complete ]] && return
	local base=https://mirrors.edge.kernel.org/pub/software/scm/git
	expected=$(expected_sha256 "$version" "$default_git" "$default_git_sha256" \
		"$base/sha256sums.asc" "git-$version.tar.xz")
	tmp=$(mktemp -d "${TMPDIR:-/tmp}/ci-reproduce-git.XXXXXX") || die "cannot make a build folder"
	say "building git $version into $prefix (two to five minutes)"
	fetch "$tmp/git.tar.xz" "$base/git-$version.tar.xz"
	check_sha256 "$tmp/git.tar.xz" "$expected"
	tar -xf "$tmp/git.tar.xz" -C "$tmp" || die "cannot unpack git $version"
	# An unfinished install of ours has no .complete marker; start it afresh.
	rm -rf "$prefix"
	# Homebrew builds git with no Rust toolchain, so NO_RUST matches the runner.
	if ! make -C "$tmp/git-$version" -j"$(sysctl -n hw.ncpu)" prefix="$prefix" \
		NO_RUST=1 NO_GETTEXT=1 NO_TCLTK=1 NO_PYTHON=1 install >"$tmp/build.log" 2>&1; then
		tail -n 30 "$tmp/build.log" >&2
		die "git $version build failed; log kept at $tmp/build.log"
	fi
	touch "$prefix/.complete"
	rm -rf "$tmp"
}

ensure_bun() {
	local version=$1 dir=$state/bun-$1 expected tmp
	[[ -f $dir/.complete ]] && return
	local base=https://github.com/oven-sh/bun/releases/download/bun-v$version
	expected=$(expected_sha256 "$version" "$default_bun" "$default_bun_sha256" \
		"$base/SHASUMS256.txt" bun-darwin-aarch64.zip)
	tmp=$(mktemp -d "${TMPDIR:-/tmp}/ci-reproduce-bun.XXXXXX") || die "cannot make a download folder"
	say "fetching Bun $version into $dir"
	fetch "$tmp/bun.zip" "$base/bun-darwin-aarch64.zip"
	check_sha256 "$tmp/bun.zip" "$expected"
	unzip -q "$tmp/bun.zip" -d "$tmp" || die "cannot unpack Bun $version"
	rm -rf "$dir"
	mkdir -p "$dir" || die "cannot create $dir"
	mv "$tmp/bun-darwin-aarch64/bun" "$dir/bun" || die "cannot install Bun $version"
	touch "$dir/.complete"
	rm -rf "$tmp"
}

ensure_node() {
	local version=$1 dir=$state/node-$1 expected tmp
	[[ -f $dir/.complete ]] && return
	local base=https://nodejs.org/dist/v$version file=node-v$version-darwin-arm64.tar.gz
	expected=$(expected_sha256 "$version" "$default_node" "$default_node_sha256" \
		"$base/SHASUMS256.txt" "$file")
	tmp=$(mktemp -d "${TMPDIR:-/tmp}/ci-reproduce-node.XXXXXX") || die "cannot make a download folder"
	say "fetching Node $version into $dir"
	fetch "$tmp/$file" "$base/$file"
	check_sha256 "$tmp/$file" "$expected"
	rm -rf "$dir"
	mkdir -p "$dir" || die "cannot create $dir"
	tar -xzf "$tmp/$file" -C "$dir" --strip-components 1 || die "cannot install Node $version"
	touch "$dir/.complete"
	rm -rf "$tmp"
}

ensure_toolchains() {
	[[ $(uname -sm) == "Darwin arm64" ]] || die "needs an Apple silicon Mac, found $(uname -sm)"
	mkdir -p "$state/runs" || die "cannot create $state"
	exec 9>>"$state/.install.lock" || die "cannot open $state/.install.lock"
	wait_lock 9 "another toolchain install"
	ensure_git "$1"
	ensure_bun "$2"
	ensure_node "$3"
	exec 9>&-
}

run_here() {
	local repo=$1 ref=$2 git_version=$3 bun_version=$4 node_version=$5 keep=$6 command=$7
	ensure_toolchains "$git_version" "$bun_version" "$node_version"

	local name=${repo##*/} run_dir work sha status started var
	run_dir=$state/runs/$(date +%Y%m%dT%H%M%S)-$name-$$
	# Outside TMPDIR, like the runner's /Users/runner/work: tests that make
	# relative paths into TMPDIR break when the checkout also sits there.
	work=$run_dir/work
	mkdir -p "$work" || die "cannot create $work"

	# The caller's git and shell overrides stay out; the hosted image's only
	# global git setting goes in.
	for var in $(compgen -e); do
		case $var in GIT_* | BASH_ENV | ENV) unset "$var" ;; esac
	done
	printf '[safe]\n\tdirectory = *\n' >"$run_dir/gitconfig"
	export GIT_CONFIG_GLOBAL=$run_dir/gitconfig
	export PATH=$state/git-$git_version/bin:$state/bun-$bun_version:$state/node-$node_version/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
	export CI=true

	git clone --quiet "https://github.com/$repo.git" "$work/$name" || die "cannot clone $repo"
	if git -C "$work/$name" rev-parse --verify --quiet "refs/remotes/origin/$ref^{commit}" >/dev/null; then
		git -C "$work/$name" checkout --quiet -B "$ref" "origin/$ref" || die "cannot check out $ref"
	else
		# A commit no branch holds any more still fetches by its full hash.
		local target=$ref
		if ! git -C "$work/$name" rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then
			git -C "$work/$name" fetch --quiet origin "$ref" || die "$repo has no ref or commit $ref"
			target=FETCH_HEAD
		fi
		git -C "$work/$name" checkout --quiet --detach "$target" || die "cannot check out $ref"
	fi
	sha=$(git -C "$work/$name" rev-parse HEAD)

	{
		printf 'repo: %s\nref: %s\ncommit: %s\ncommand: %s\n' "$repo" "$ref" "$sha" "$command"
		printf 'macOS: %s (%s)\n' "$(sw_vers -productVersion)" "$(sw_vers -buildVersion)"
		printf 'cpus: %s\nmemory bytes: %s\n' "$(sysctl -n hw.ncpu)" "$(sysctl -n hw.memsize)"
		printf 'git: %s\nbun: %s\n' "$(command -v git) $(git --version)" "$(command -v bun) $(bun --version)"
		printf 'node: %s\nbash: %s\n' "$(command -v node) $(node --version)" "$(command -v bash)"
	} | tee "$run_dir/environment.txt" >&2

	# A GitHub run step with no shell set runs as bash -e, from the bash on PATH.
	started=$SECONDS
	set +e
	(cd "$work/$name" && exec bash -e -c "$command") 2>&1 | tee "$run_dir/output.log"
	status=${PIPESTATUS[0]}
	set -e
	echo "$status" >"$run_dir/exit-code"

	if [[ $keep == true ]]; then
		say "checkout kept at $work/$name"
	else
		rm -rf "$work"
	fi
	say "exit $status after $((SECONDS - started)) s; log $run_dir/output.log"
	return "$status"
}

# Prints a script that redefines this one inside a guest and calls main there.
guest_script() {
	printf 'set -euo pipefail\n'
	declare -p default_git default_git_sha256 default_bun default_bun_sha256 \
		default_node default_node_sha256
	# shellcheck disable=SC2016 # The guest expands these, with its own HOME.
	printf '%s\n' 'state=${XDG_STATE_HOME:-$HOME/.local/state}/ci-reproduce' \
		'vm_name=""' 'vm_pid=""' 'vm_disposable=false' 'transport_pid=""'
	declare -f say die usage wait_lock check_sha256 expected_sha256 fetch \
		ensure_git ensure_bun ensure_node ensure_toolchains run_here stop_vm on_signal main
	printf 'main'
	printf ' %q' "$@"
	printf ' </dev/null\n'
}

# Syncs, stops and (for a clone) deletes the VM this run started. Runs on
# every exit, including a dropped ssh connection or an interrupt.
stop_vm() {
	[[ -n $vm_name ]] || return 0
	local name=$vm_name
	vm_name=""
	# tart stop can end in a forced power-off; flush the guest's writes first.
	tart exec "$name" /bin/sync >/dev/null 2>&1 || true
	if [[ -n $transport_pid ]]; then
		kill "$transport_pid" 2>/dev/null || true
		wait "$transport_pid" 2>/dev/null || true
		transport_pid=""
	fi
	tart stop --timeout 60 "$name" >/dev/null 2>&1 || true
	if [[ -n $vm_pid ]]; then
		kill -0 "$vm_pid" 2>/dev/null && kill "$vm_pid" 2>/dev/null
		wait "$vm_pid" 2>/dev/null || true
	fi
	if [[ $vm_disposable == true ]] && ! tart delete "$name" >/dev/null 2>&1; then
		say "could not delete clone $name; remove it with: tart delete $name"
	fi
}

on_signal() {
	say "stopped by signal; cleaning up"
	stop_vm
	exit "$1"
}

run_in_vm() {
	local base=$1 prepare=$2 keep=$3
	shift 3
	command -v tart >/dev/null || die "tart is not installed; see the ci-reproduce environment reference"
	local config cpus memory listing
	config=$(tart get "$base" --format json 2>/dev/null) || die "no Tart VM named $base"
	cpus=$(printf '%s\n' "$config" | awk -F': *' '/"CPU"/ {gsub(/[ ,]/, "", $2); print $2}')
	memory=$(printf '%s\n' "$config" | awk -F': *' '/"Memory"/ {gsub(/[ ,]/, "", $2); print $2}')
	if [[ $cpus != 3 || $memory != 7168 ]]; then
		say "warning: $base has $cpus CPUs and $memory MB; macos-latest has 3 and 7168 (tart set $base --cpu 3 --memory 7168)"
	fi

	# Apple's licence and Virtualization.framework allow two macOS guests per
	# Mac; this script runs one at a time, held by a lock its VM inherits.
	mkdir -p "$state/runs" || die "cannot create $state"
	exec 8>>"$state/.vm.lock" || die "cannot open $state/.vm.lock"
	wait_lock 8 "another VM run on this Mac"
	listing=$(tart list) || die "tart list failed"
	if printf '%s\n' "$listing" | awk 'NR > 1 && $NF == "running"' | grep -q .; then
		die "a Tart VM is already running; stop it first (tart list)"
	fi

	local run_dir status started=$SECONDS name
	run_dir=$state/runs/$(date +%Y%m%dT%H%M%S)-vm-$base-$$
	mkdir -p "$run_dir" || die "cannot create $run_dir"
	if [[ $prepare == true ]]; then
		name=$base
	else
		name=$base-run-$$
		tart clone "$base" "$name" || die "cannot clone $base"
		[[ $keep == true ]] || vm_disposable=true
	fi
	vm_name=$name

	tart run --no-graphics --no-audio --no-clipboard "$name" >"$run_dir/tart-run.log" 2>&1 &
	vm_pid=$!
	local waited=0
	until tart exec "$name" /usr/bin/true >/dev/null 2>&1; do
		kill -0 "$vm_pid" 2>/dev/null || die "VM $name stopped while booting; see $run_dir/tart-run.log"
		((waited >= 180)) && die "VM $name was not ready within 180 s"
		sleep 3
		waited=$((waited + 3))
	done
	say "VM $name ready after $((SECONDS - started)) s ($cpus CPUs, $memory MB)"

	# The guest runs in the background and this shell waits on it: bash runs a
	# TERM or INT trap only between commands, so a foreground pipeline holding a
	# hung guest command would keep the VM and its lock up until it ended.
	tart exec -i "$name" /bin/bash -s < <(guest_script "$@") > >(tee "$run_dir/output.log") 2>&1 &
	transport_pid=$!
	status=0
	wait "$transport_pid" || status=$?
	transport_pid=""
	echo "$status" >"$run_dir/exit-code"
	stop_vm
	[[ $keep == true && $prepare == false ]] && say "clone $name kept, stopped"
	say "VM run exit $status after $((SECONDS - started)) s in all; log $run_dir/output.log"
	return "$status"
}

main() {
	local repo="" ref="" git_version=$default_git bun_version=$default_bun node_version=$default_node
	local keep=false prepare=false vm="" pass=()
	while (($#)); do
		case $1 in
		--repo | --ref | --git | --bun | --node | --vm)
			[[ $# -ge 2 && -n $2 ]] || usage
			case $1 in
			--repo) repo=$2 ;;
			--ref) ref=$2 ;;
			--git) git_version=$2 ;;
			--bun) bun_version=$2 ;;
			--node) node_version=$2 ;;
			--vm) vm=$2 ;;
			esac
			[[ $1 == --vm ]] || pass+=("$1" "$2")
			shift 2
			;;
		--keep) keep=true && pass+=(--keep) && shift ;;
		--prepare) prepare=true && pass+=(--prepare) && shift ;;
		--) shift && break ;;
		*) usage ;;
		esac
	done
	local command="$*"

	trap stop_vm EXIT
	trap 'on_signal 129' HUP
	trap 'on_signal 130' INT
	trap 'on_signal 143' TERM
	if [[ -n $vm ]]; then
		[[ $prepare == true || (-n $repo && -n $ref && -n $command) ]] || usage
		run_in_vm "$vm" "$prepare" "$keep" "${pass[@]}" -- "$command"
	elif [[ $prepare == true ]]; then
		ensure_toolchains "$git_version" "$bun_version" "$node_version"
		say "git $git_version, Bun $bun_version and Node $node_version ready under $state"
	else
		[[ -n $repo && -n $ref && -n $command ]] || usage
		run_here "$repo" "$ref" "$git_version" "$bun_version" "$node_version" "$keep" "$command"
	fi
}

# Children read /dev/null, not the rest of a script piped through `bash -s`.
main "$@" </dev/null
