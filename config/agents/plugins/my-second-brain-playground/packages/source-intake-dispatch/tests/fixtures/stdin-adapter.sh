#!/bin/sh
# Test-only adapter for cli-design-check, which passes argv only and gives every row /dev/null as standard input.
# Usage: stdin-adapter.sh BUN RUNTIME [stdin=FILE | stdin-busy=FILE] ARGS...
# stdin=FILE redirects FILE onto the command's standard input. stdin-busy=FILE also exhausts file descriptors first
# through the descriptor-limit test preload. Without a selector the arguments pass through unchanged.
set -eu
bun=$1
runtime=$2
shift 2
case "${1:-}" in
stdin-busy=*)
	file=${1#stdin-busy=}
	shift
	SOURCE_INTAKE_TEST_EXHAUST_DESCRIPTORS=1
	export SOURCE_INTAKE_TEST_EXHAUST_DESCRIPTORS
	exec "$bun" --preload "$(dirname "$0")/descriptor-limit.ts" "$runtime" "$@" < "$file"
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
