#!/bin/sh
# Test-only stand-in for macOS osascript, found first on PATH. It never shows a dialog. It records its arguments
# (one per line) and its pid, then acts on FAKE_CHOOSER_MODE: reply prints FAKE_CHOOSER_REPLY exactly, cancel and
# fail exit 1 with an AppleScript-shaped error, hang waits until it is killed.
set -eu
printf '%s\n' "$@" > "$FAKE_CHOOSER_LOG"
printf '%s\n' "$$" > "$FAKE_CHOOSER_LOG.pid"
case "$FAKE_CHOOSER_MODE" in
reply)
	printf '%s' "$FAKE_CHOOSER_REPLY"
	;;
cancel)
	echo "execution error: User canceled. (-128)" >&2
	exit 1
	;;
fail)
	echo "execution error: No user interaction allowed. (-1713)" >&2
	exit 1
	;;
hang)
	exec sleep 30
	;;
esac
