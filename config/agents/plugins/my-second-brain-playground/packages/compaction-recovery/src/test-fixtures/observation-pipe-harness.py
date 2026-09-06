#!/usr/bin/env python3
"""Run the real recovery process with a caller-owned hostile observation pipe."""

import fcntl
import os
import subprocess
import sys


def main() -> int:
    if len(sys.argv) < 4 or sys.argv[2] not in ("closed", "full", "non-reading"):
        return 64
    recovery = sys.argv[1]
    mode = sys.argv[2]
    read_descriptor, write_descriptor = os.pipe()
    flags = fcntl.fcntl(write_descriptor, fcntl.F_GETFL)
    fcntl.fcntl(write_descriptor, fcntl.F_SETFL, flags | os.O_NONBLOCK)
    if mode == "closed":
        os.close(read_descriptor)
        read_descriptor = -1
    elif mode == "full":
        while True:
            try:
                os.write(write_descriptor, b"x" * 4096)
            except BlockingIOError:
                break

    environment = dict(os.environ)
    environment["MSB_RECOVERY_OBSERVABILITY_FD"] = str(write_descriptor)
    environment["MSB_RECOVERY_OBSERVATION_INVOCATION_IDENTITY"] = "hostile-pipe-invocation"
    try:
        child = subprocess.run(
            ["/usr/bin/python3", "-B", recovery, *sys.argv[3:]],
            input=sys.stdin.buffer.read(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
            pass_fds=(write_descriptor,),
            check=False,
        )
    finally:
        os.close(write_descriptor)
        if read_descriptor >= 0:
            os.close(read_descriptor)
    sys.stdout.buffer.write(child.stdout)
    sys.stderr.buffer.write(child.stderr)
    return child.returncode


if __name__ == "__main__":
    raise SystemExit(main())
