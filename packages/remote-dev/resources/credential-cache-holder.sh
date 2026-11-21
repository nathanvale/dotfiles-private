#!/bin/sh
# The launchd cache job's program: one process, one PID, for as long as the
# native Git credential cache daemon in the container lives.
#
#   credential-cache-holder.sh SSH ALIAS EXEC DAEMON PYTHON SOCKET
#
# EXEC, DAEMON, PYTHON and SOCKET are already quoted words for the far shell
# (credential_jobs.py validates the exact values). It never reads a credential.
#
# 1. It starts the daemon exactly as the direct ssh job did: EXEC DAEMON.
# 2. When ssh itself fails (255) without naming a refusal, the route went away.
#    The daemon keeps running in the container while its lease is refreshed, so
#    the holder waits (1 second, doubling to 30) and reattaches: it watches the
#    daemon that holds SOCKET until that daemon ends. It never runs DAEMON a
#    second time: a second daemon on the same socket replaces the leased cache.
# 3. It ends with the daemon's or watcher's own status: 0 when the daemon
#    ended, 3 when no daemon was listening on reattaching (its lease ran out
#    while the route was away). A refusal ssh names (authentication, host key,
#    negotiation, configuration) ends it with 255. A stop signal ends it and
#    its connection with 143.
set -u
if [ "$#" != 6 ]; then
  echo "credential cache holder: expected SSH ALIAS EXEC DAEMON PYTHON SOCKET" >&2
  exit 64
fi
ssh=$1 alias=$2 exec_words=$3 daemon=$4 python=$5 socket=$6

# The refusals the deployment sender's precedence rule names (ROUTE_REFUSED in
# agent-deployment packages/credential-delivery/remote.ts): these stop.
REFUSED='Permission denied \(|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|Too many authentication failures|Connection closed by authenticating user|Unable to negotiate with |banner line contains invalid characters|Bad configuration option|Bad owner or permissions|bad configuration options|Unsupported option'

# Run in the container on reattaching. It finds the one listener on SOCKET in
# /proc/net/unix and the one process of this user holding it, as the sender's
# cache inspector does, without connecting to it. It says "held" and stays
# until two readings a second apart no longer show that same listener and
# process; with none at the start it says "absent" (3). No quote characters:
# it travels as one word.
WATCH='import os, sys, time
path = sys.argv[1]
def holder():
    try:
        with open("/proc/net/unix") as rows:
            found = [row.split() for row in rows if row.split()[-1:] == [path]]
    except OSError:
        return None
    if len(found) != 1 or found[0][3:6] != ["00010000", "0001", "01"]:
        return None
    link, owners = "socket:[" + found[0][6] + "]", []
    for name in os.listdir("/proc"):
        if not name.isdecimal():
            continue
        try:
            if os.stat("/proc/" + name).st_uid != os.getuid():
                continue
            fds = "/proc/" + name + "/fd"
            if any(os.readlink(fds + "/" + fd) == link for fd in os.listdir(fds)):
                owners.append(name)
        except OSError:
            continue
    return (found[0][6], owners[0]) if len(owners) == 1 else None
first = holder()
if first is None:
    print("absent", flush=True)
    sys.exit(3)
print("held", flush=True)
missed = 0
while missed < 2:
    time.sleep(1 if missed else 2)
    missed = 0 if holder() == first else missed + 1
'

said=$(mktemp "${TMPDIR:-/tmp}/credential-cache-holder.XXXXXX") || exit 70
stopped() {
  # Every background job: the connection or the pause, even one just started.
  for job in $(jobs -p); do kill "$job" 2>/dev/null; done
  wait 2>/dev/null
  rm -f "$said"
  exit 143
}
trap stopped TERM INT HUP

# One connection, in the background so a stop signal is handled at once. What
# ssh says is kept only to tell a refusal from a lost route, then passed on.
connect() {
  : > "$said"
  "$ssh" -o ForwardAgent=no -o BatchMode=yes -T "$alias" "$1" < /dev/null 2> "$said" &
  wait "$!"
  code=$?
  cat "$said" >&2
}

connect "$exec_words $daemon"
pause=1
while [ "$code" = 255 ] && ! grep -E -q "$REFUSED" "$said"; do
  echo "credential cache holder: route lost; reattaching in $pause s" >&2
  sleep "$pause" &
  wait "$!"
  began=$(date +%s)
  connect "$exec_words $python -I -c '$WATCH' $socket"
  # A connection that held for a minute starts the next loss from one second.
  if [ $(($(date +%s) - began)) -ge 60 ]; then
    pause=1
  else
    pause=$((pause * 2))
    [ "$pause" -gt 30 ] && pause=30
  fi
done
rm -f "$said"
exit "$code"
