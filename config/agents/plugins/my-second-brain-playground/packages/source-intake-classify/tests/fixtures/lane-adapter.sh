#!/bin/sh
# Test-only adapter for cli-design-check, which passes argv only and gives every row /dev/null as standard input.
# Usage: lane-adapter.sh BUN RUNTIME [lane=DIR] [stdin=FILE | stdin-busy=FILE] ARGS...
# lane=DIR replaces PATH with DIR and the system directories, so one row can run a different fake codex, or none.
# stdin=FILE redirects FILE onto standard input; stdin-busy=FILE also exhausts descriptors first through the shared
# descriptor-limit preload. Without selectors the arguments pass through unchanged.
set -eu
bun=$1
runtime=$2
shift 2
case "${1:-}" in
lane=*)
	PATH="${1#lane=}:/usr/bin:/bin"
	export PATH
	shift
	;;
esac
case "${1:-}" in
stdin-busy=*)
	file=${1#stdin-busy=}
	shift
	SOURCE_INTAKE_TEST_EXHAUST_DESCRIPTORS=1
	export SOURCE_INTAKE_TEST_EXHAUST_DESCRIPTORS
	exec "$bun" --preload "$(dirname "$0")/../../../source-intake-dispatch/tests/fixtures/descriptor-limit.ts" "$runtime" "$@" < "$file"
	;;
stdin=*)
	file=${1#stdin=}
	shift
	exec "$bun" "$runtime" "$@" < "$file"
	;;
*)
	exec "$bun" "$runtime" "$@"
	;;
esac
