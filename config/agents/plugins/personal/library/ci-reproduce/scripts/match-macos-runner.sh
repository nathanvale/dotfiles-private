#!/usr/bin/env bash
# Run a public GitHub repository's command on an Apple silicon Mac with the git
# and Bun versions of GitHub's hosted macOS runner. Toolchains and run logs stay
# under ${XDG_STATE_HOME:-$HOME/.local/state}/ci-reproduce; Homebrew, mise and
# the default PATH are left alone.
#
# From another Mac:
#   ssh mac-mini bash -s -- --repo OWNER/NAME --ref REF -- 'COMMAND' < match-macos-runner.sh
set -euo pipefail

# Checksums: git from kernel.org sha256sums.asc (Homebrew's formula agrees);
# Bun from its release's SHASUMS256.txt. Other versions use those lists live.
readonly default_git=2.56.1
readonly default_git_sha256=f0b0bf89264b9bd2e1c640363e7529643989da76281600473c50745cd34a607f
readonly default_bun=1.4.4
readonly default_bun_sha256=c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510

state=${XDG_STATE_HOME:-$HOME/.local/state}/ci-reproduce
lock=""

say() { printf 'match-macos-runner: %s\n' "$*" >&2; }
die() {
	say "$*"
	exit 2
}

usage() {
	cat >&2 <<'EOF'
Usage: match-macos-runner.sh --repo OWNER/NAME --ref REF [options] -- COMMAND

  --repo OWNER/NAME  public GitHub repository, cloned over HTTPS
  --ref REF          branch, tag or commit to check out
  --git VERSION      git built from kernel.org (default 2.56.1)
  --bun VERSION      Bun from its GitHub release (default 1.4.4)
  --keep             keep the checkout after the run
  COMMAND            shell command run in the checkout, as one argument

Exit status is COMMAND's; 2 means the run could not start.
EOF
	exit 2
}

release_lock() { [[ -n $lock ]] && rmdir "$lock" 2>/dev/null || true; }

take_lock() {
	lock=$state/.install-lock
	local waited=0
	until mkdir "$lock" 2>/dev/null; do
		((waited % 60 == 0)) && say "waiting for $lock (remove it if no install is running)"
		((waited >= 900)) && die "gave up waiting for $lock"
		sleep 5
		waited=$((waited + 5))
	done
	trap release_lock EXIT
}

check_sha256() {
	local file=$1 expected=$2 actual
	actual=$(shasum -a 256 "$file" | awk '{print $1}')
	[[ $actual == "$expected" ]] || die "checksum mismatch for $file: $actual, expected $expected"
}

ensure_git() {
	local version=$1 prefix=$state/git-$1 expected="" tmp
	[[ -f $prefix/.complete ]] && return
	[[ $version == "$default_git" ]] && expected=$default_git_sha256
	local base=https://mirrors.edge.kernel.org/pub/software/scm/git
	if [[ -z $expected ]]; then
		expected=$(curl -fsSL "$base/sha256sums.asc" | awk -v f="git-$version.tar.xz" '$2 == f {print $1}')
		[[ -n $expected ]] || die "kernel.org lists no checksum for git $version"
	fi
	tmp=$(mktemp -d "${TMPDIR:-/tmp}/ci-reproduce-git.XXXXXX")
	say "building git $version into $prefix (about two minutes)"
	curl -fsSL -o "$tmp/git.tar.xz" "$base/git-$version.tar.xz"
	check_sha256 "$tmp/git.tar.xz" "$expected"
	tar -xf "$tmp/git.tar.xz" -C "$tmp"
	# An unfinished install of ours has no .complete marker; start it afresh.
	rm -rf "$prefix"
	# Homebrew builds git with no Rust toolchain, so NO_RUST matches the runner.
	if ! make -C "$tmp/git-$version" -j"$(($(sysctl -n hw.ncpu) / 2))" prefix="$prefix" \
		NO_RUST=1 NO_GETTEXT=1 NO_TCLTK=1 NO_PYTHON=1 install >"$tmp/build.log" 2>&1; then
		tail -n 30 "$tmp/build.log" >&2
		die "git $version build failed; log kept at $tmp/build.log"
	fi
	touch "$prefix/.complete"
	rm -rf "$tmp"
}

ensure_bun() {
	local version=$1 dir=$state/bun-$1 expected="" tmp
	[[ -f $dir/.complete ]] && return
	[[ $version == "$default_bun" ]] && expected=$default_bun_sha256
	local base=https://github.com/oven-sh/bun/releases/download/bun-v$version
	if [[ -z $expected ]]; then
		expected=$(curl -fsSL "$base/SHASUMS256.txt" | awk '$2 == "bun-darwin-aarch64.zip" {print $1}')
		[[ -n $expected ]] || die "Bun $version lists no checksum for bun-darwin-aarch64.zip"
	fi
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

main() {
	local repo="" ref="" git_version=$default_git bun_version=$default_bun keep=false
	while (($#)); do
		case $1 in
		--repo) repo=${2:-} && shift 2 ;;
		--ref) ref=${2:-} && shift 2 ;;
		--git) git_version=${2:-} && shift 2 ;;
		--bun) bun_version=${2:-} && shift 2 ;;
		--keep) keep=true && shift ;;
		--) shift && break ;;
		*) usage ;;
		esac
	done
	local command="$*"
	[[ -n $repo && -n $ref && -n $command ]] || usage
	[[ $(uname -sm) == "Darwin arm64" ]] || die "needs an Apple silicon Mac, found $(uname -sm)"

	mkdir -p "$state/runs"
	take_lock
	ensure_git "$git_version"
	ensure_bun "$bun_version"
	release_lock
	lock=""

	local name=${repo##*/} run_dir work sha status
	run_dir=$state/runs/$(date +%Y%m%dT%H%M%S)-$name-$$
	# Outside TMPDIR, like the runner's /Users/runner/work: tests that make
	# relative paths into TMPDIR break when the checkout also sits there.
	work=$run_dir/work
	mkdir -p "$work"

	# The hosted image's only global git setting; this host's own config stays out.
	printf '[safe]\n\tdirectory = *\n' >"$run_dir/gitconfig"
	export GIT_CONFIG_GLOBAL=$run_dir/gitconfig
	export PATH=$state/git-$git_version/bin:$state/bun-$bun_version:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
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
		printf 'node: %s\n' "$(command -v node || echo none) $(node --version 2>/dev/null || true)"
	} | tee "$run_dir/environment.txt" >&2

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
	say "exit $status; log $run_dir/output.log"
	return "$status"
}

# Children read /dev/null, not the rest of a script piped through `bash -s`.
main "$@" </dev/null
