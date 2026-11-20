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
lock=""
vm_name=""
vm_pid=""
vm_disposable=false

say() { printf 'match-macos-runner: %s\n' "$*" >&2; }
die() {
	say "$*"
	exit 2
}

usage() {
	cat >&2 <<'EOF'
Usage: match-macos-runner.sh --repo OWNER/NAME --ref REF [options] -- COMMAND
       match-macos-runner.sh --prepare [--vm BASE] [versions]

  --repo OWNER/NAME  public GitHub repository, cloned over HTTPS
  --ref REF          branch, tag or commit to check out
  --git VERSION      git built from kernel.org (default 2.56.1)
  --bun VERSION      Bun from its GitHub release (default 1.4.4)
  --node VERSION     Node from nodejs.org (default 24.22.2)
  --vm BASE          run in a disposable clone of the Tart VM BASE;
                     with --prepare, install the toolchains into BASE itself
  --prepare          install the toolchains only
  --keep             keep the checkout (and, with --vm, the stopped clone)
  COMMAND            shell command run in the checkout, as one argument

Exit status is COMMAND's; 2 means the run could not start.
EOF
	exit 2
}

release_lock() { [[ -n $lock ]] && rm -rf "$lock" || true; }

# The lock names its owner's process, so a lock left by a killed run or a VM
# that powered off is taken over instead of waited on.
take_lock() {
	lock=$state/.install-lock
	local waited=0 owner
	until mkdir "$lock" 2>/dev/null; do
		owner=$(cat "$lock/pid" 2>/dev/null || true)
		if [[ -n $owner ]] && ! kill -0 "$owner" 2>/dev/null; then
			say "taking over $lock from process $owner, which is gone"
			rm -rf "$lock"
			continue
		fi
		((waited % 60 == 0)) && say "waiting for $lock (process ${owner:-unknown})"
		((waited >= 900)) && die "gave up waiting for $lock"
		sleep 5
		waited=$((waited + 5))
	done
	echo $$ >"$lock/pid"
	trap release_lock EXIT
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
	sha=$(curl -fsSL "$sums_url" | awk -v f="$file" '$2 == f {print $1}')
	[[ -n $sha ]] || die "$sums_url lists no checksum for $file"
	printf '%s\n' "$sha"
}

ensure_git() {
	local version=$1 prefix=$state/git-$1 expected tmp
	[[ -f $prefix/.complete ]] && return
	local base=https://mirrors.edge.kernel.org/pub/software/scm/git
	expected=$(expected_sha256 "$version" "$default_git" "$default_git_sha256" \
		"$base/sha256sums.asc" "git-$version.tar.xz")
	tmp=$(mktemp -d "${TMPDIR:-/tmp}/ci-reproduce-git.XXXXXX")
	say "building git $version into $prefix (two to five minutes)"
	curl -fsSL -o "$tmp/git.tar.xz" "$base/git-$version.tar.xz"
	check_sha256 "$tmp/git.tar.xz" "$expected"
	tar -xf "$tmp/git.tar.xz" -C "$tmp"
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
	tmp=$(mktemp -d "${TMPDIR:-/tmp}/ci-reproduce-bun.XXXXXX")
	say "fetching Bun $version into $dir"
	curl -fsSL -o "$tmp/bun.zip" "$base/bun-darwin-aarch64.zip"
	check_sha256 "$tmp/bun.zip" "$expected"
	unzip -q "$tmp/bun.zip" -d "$tmp"
	rm -rf "$dir"
	mkdir -p "$dir"
	mv "$tmp/bun-darwin-aarch64/bun" "$dir/bun"
	touch "$dir/.complete"
	rm -rf "$tmp"
}

ensure_node() {
	local version=$1 dir=$state/node-$1 expected tmp
	[[ -f $dir/.complete ]] && return
	local base=https://nodejs.org/dist/v$version file=node-v$version-darwin-arm64.tar.gz
	expected=$(expected_sha256 "$version" "$default_node" "$default_node_sha256" \
		"$base/SHASUMS256.txt" "$file")
	tmp=$(mktemp -d "${TMPDIR:-/tmp}/ci-reproduce-node.XXXXXX")
	say "fetching Node $version into $dir"
	curl -fsSL -o "$tmp/$file" "$base/$file"
	check_sha256 "$tmp/$file" "$expected"
	rm -rf "$dir"
	mkdir -p "$dir"
	tar -xzf "$tmp/$file" -C "$dir" --strip-components 1
	touch "$dir/.complete"
	rm -rf "$tmp"
}

ensure_toolchains() {
	[[ $(uname -sm) == "Darwin arm64" ]] || die "needs an Apple silicon Mac, found $(uname -sm)"
	mkdir -p "$state/runs"
	take_lock
	ensure_git "$1"
	ensure_bun "$2"
	ensure_node "$3"
	release_lock
	lock=""
}

run_here() {
	local repo=$1 ref=$2 git_version=$3 bun_version=$4 node_version=$5 keep=$6 command=$7
	ensure_toolchains "$git_version" "$bun_version" "$node_version"

	local name=${repo##*/} run_dir work sha status started
	run_dir=$state/runs/$(date +%Y%m%dT%H%M%S)-$name-$$
	# Outside TMPDIR, like the runner's /Users/runner/work: tests that make
	# relative paths into TMPDIR break when the checkout also sits there.
	work=$run_dir/work
	mkdir -p "$work"

	# The hosted image's only global git setting; this host's own config stays out.
	printf '[safe]\n\tdirectory = *\n' >"$run_dir/gitconfig"
	export GIT_CONFIG_GLOBAL=$run_dir/gitconfig
	export PATH=$state/git-$git_version/bin:$state/bun-$bun_version:$state/node-$node_version/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
	export CI=true

	git clone --quiet "https://github.com/$repo.git" "$work/$name"
	if git -C "$work/$name" rev-parse --verify --quiet "refs/remotes/origin/$ref^{commit}" >/dev/null; then
		git -C "$work/$name" checkout --quiet -B "$ref" "origin/$ref"
	else
		# A commit no branch holds any more still fetches by its full hash.
		local target=$ref
		if ! git -C "$work/$name" rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then
			git -C "$work/$name" fetch --quiet origin "$ref" || die "$repo has no ref or commit $ref"
			target=FETCH_HEAD
		fi
		git -C "$work/$name" checkout --quiet --detach "$target"
	fi
	sha=$(git -C "$work/$name" rev-parse HEAD)

	{
		printf 'repo: %s\nref: %s\ncommit: %s\ncommand: %s\n' "$repo" "$ref" "$sha" "$command"
		printf 'macOS: %s (%s)\n' "$(sw_vers -productVersion)" "$(sw_vers -buildVersion)"
		printf 'cpus: %s\nmemory bytes: %s\n' "$(sysctl -n hw.ncpu)" "$(sysctl -n hw.memsize)"
		printf 'git: %s\nbun: %s\n' "$(command -v git) $(git --version)" "$(command -v bun) $(bun --version)"
		printf 'node: %s\n' "$(command -v node) $(node --version)"
	} | tee "$run_dir/environment.txt" >&2

	started=$SECONDS
	set +e
	(cd "$work/$name" && exec bash -c "$command") 2>&1 | tee "$run_dir/output.log"
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
	printf '%s\n' 'state=${XDG_STATE_HOME:-$HOME/.local/state}/ci-reproduce' 'lock=""' \
		'vm_name=""' 'vm_pid=""' 'vm_disposable=false'
	declare -f say die usage release_lock take_lock check_sha256 expected_sha256 \
		ensure_git ensure_bun ensure_node ensure_toolchains run_here main
	printf 'main'
	printf ' %q' "$@"
	printf ' </dev/null\n'
}

stop_vm() {
	[[ -n $vm_name ]] || return 0
	# tart stop can end in a forced power-off; flush the guest's writes first.
	tart exec "$vm_name" /bin/sync >/dev/null 2>&1 || true
	tart stop "$vm_name" >/dev/null 2>&1 || true
	[[ -n $vm_pid ]] && wait "$vm_pid" 2>/dev/null || true
	if [[ $vm_disposable == true ]]; then
		tart delete "$vm_name" >/dev/null 2>&1 || true
	fi
	vm_name=""
}

run_in_vm() {
	local base=$1 prepare=$2 keep=$3
	shift 3
	command -v tart >/dev/null || die "tart is not installed; see the ci-reproduce environment reference"
	tart get "$base" >/dev/null 2>&1 || die "no Tart VM named $base"
	# Apple's licence and Virtualization.framework allow two macOS guests per
	# Mac; this script uses one at a time.
	if tart list | awk 'NR > 1 && $NF == "running"' | grep -q .; then
		die "a Tart VM is already running; stop it first (tart list)"
	fi

	local run_dir status started=$SECONDS
	mkdir -p "$state/runs"
	run_dir=$state/runs/$(date +%Y%m%dT%H%M%S)-vm-$base-$$
	mkdir -p "$run_dir"
	if [[ $prepare == true ]]; then
		vm_name=$base
	else
		vm_name=$base-run-$$
		vm_disposable=$([[ $keep == true ]] && echo false || echo true)
		tart clone "$base" "$vm_name"
	fi
	trap stop_vm EXIT

	tart run --no-graphics --no-audio --no-clipboard "$vm_name" >"$run_dir/tart-run.log" 2>&1 &
	vm_pid=$!
	local waited=0
	until tart exec "$vm_name" /usr/bin/true >/dev/null 2>&1; do
		kill -0 "$vm_pid" 2>/dev/null || die "VM $vm_name stopped while booting; see $run_dir/tart-run.log"
		((waited >= 180)) && die "VM $vm_name was not ready within 180 s"
		sleep 3
		waited=$((waited + 3))
	done
	say "VM $vm_name ready after $((SECONDS - started)) s"

	set +e
	guest_script "$@" | tart exec -i "$vm_name" /bin/bash -s 2>&1 | tee "$run_dir/output.log"
	status=${PIPESTATUS[1]}
	set -e
	echo "$status" >"$run_dir/exit-code"
	stop_vm
	[[ $keep == true && $prepare == false ]] && say "clone $base-run-$$ kept, stopped"
	say "VM run exit $status after $((SECONDS - started)) s in all; log $run_dir/output.log"
	return "$status"
}

main() {
	local repo="" ref="" git_version=$default_git bun_version=$default_bun node_version=$default_node
	local keep=false prepare=false vm="" pass=()
	while (($#)); do
		case $1 in
		--repo | --ref | --git | --bun | --node)
			[[ $# -ge 2 ]] || usage
			pass+=("$1" "$2")
			case $1 in
			--repo) repo=$2 ;;
			--ref) ref=$2 ;;
			--git) git_version=$2 ;;
			--bun) bun_version=$2 ;;
			--node) node_version=$2 ;;
			esac
			shift 2
			;;
		--vm) vm=${2:-} && shift 2 ;;
		--keep) keep=true && pass+=(--keep) && shift ;;
		--prepare) prepare=true && pass+=(--prepare) && shift ;;
		--) shift && break ;;
		*) usage ;;
		esac
	done
	local command="$*"

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
