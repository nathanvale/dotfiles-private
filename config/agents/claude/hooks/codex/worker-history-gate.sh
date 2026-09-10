#!/bin/sh

repair='Retry the spawn_agent call with fork_turns: none.'
script_dir=${0%/*}

if ! bun_executable=$(command -v bun 2>/dev/null); then
	printf '%s\n' "Worker history gate refused the launch: Bun is unavailable. $repair" >&2
	exit 2
fi

"$bun_executable" "$script_dir/worker-history-gate.ts"
status=$?

if [ "$status" -eq 0 ] || [ "$status" -eq 2 ]; then
	exit "$status"
fi

printf '%s\n' "Worker history gate refused the launch: the parser runtime failed with exit $status. $repair" >&2
exit 2

