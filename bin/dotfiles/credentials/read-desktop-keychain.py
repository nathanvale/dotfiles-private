#!/usr/bin/env python3
"""Internal wrapper reader: one same-user GUI job, secret bytes through a FIFO."""

import os
from pathlib import Path
import plistlib
import select
import signal
import subprocess
import sys
import tempfile
import time

LAUNCHCTL = "/bin/launchctl"
TIMEOUT = 5
MAX_RESULT_BYTES = 1024 * 1024


def launchctl(*arguments):
    return subprocess.run(
        [LAUNCHCTL, *arguments],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=TIMEOUT,
        check=False,
    ).returncode


def job_definition(label, fifo, reader_arguments):
    # Only public coordinates enter argv and the plist. The value travels from
    # security through the FIFO; it is never a launchd environment variable.
    script = '"$@"; status=$?; printf "\\n%s:%s\\n" "$0" "$status"'
    return {
        "Label": label,
        "ProgramArguments": ["/bin/bash", "-c", script, label, *reader_arguments],
        "RunAtLoad": True,
        "StandardOutPath": str(fifo),
        "StandardErrorPath": "/dev/null",
        "EnvironmentVariables": {"HOME": os.environ["HOME"], "PATH": "/usr/bin:/bin"},
        "Umask": 0o077,
        "ExitTimeOut": 1,
        "AbandonProcessGroup": False,
    }


def receive_result(descriptor, marker, deadline):
    result = b""
    while time.monotonic() < deadline:
        ready, _, _ = select.select(
            [descriptor], [], [], max(0, deadline - time.monotonic())
        )
        if not ready:
            break
        result += os.read(descriptor, 65536)
        if len(result) > MAX_RESULT_BYTES:
            return 1, b""
        if marker in result and result.endswith(b"\n"):
            payload, raw_status = result.rsplit(marker, 1)
            if raw_status.strip().isdigit() and 0 <= int(raw_status.strip()) <= 255:
                status = int(raw_status.strip())
                return status, payload if status == 0 else b""
            return 1, b""
    return 143, b""


def interrupt_reader(_signal, _frame):
    raise InterruptedError("desktop read interrupted")


def read_desktop(reader_arguments):
    domain = f"gui/{os.getuid()}"
    # A private random directory protects both the plist and the FIFO pathname.
    # Named pipes hold bytes in the kernel, not in a regular credential file.
    with tempfile.TemporaryDirectory(prefix="dotfiles-keychain-") as directory:
        root = Path(directory)
        label = "local.dotfiles.keychain-" + root.name.removeprefix("dotfiles-keychain-")
        target = domain + "/" + label
        fifo = root / "result"
        os.mkfifo(fifo, 0o600)
        descriptor = os.open(fifo, os.O_RDWR | os.O_NONBLOCK)
        try:
            plist = root / "job.plist"
            with plist.open("xb") as stream:
                os.chmod(plist, 0o600)
                plistlib.dump(job_definition(label, fifo, reader_arguments), stream)
            deadline = time.monotonic() + TIMEOUT
            try:
                status, payload = 1, b""
                if launchctl("bootstrap", domain, str(plist)) == 0:
                    marker = ("\n" + label + ":").encode()
                    status, payload = receive_result(descriptor, marker, deadline)
            except (subprocess.TimeoutExpired, InterruptedError):
                status, payload = 143, b""
            finally:
                # No output is released until the owned GUI job has been removed.
                # bootout also kills its process group, including a stalled reader.
                removed = launchctl("bootout", target)
        finally:
            os.close(descriptor)
        if removed != 0:
            return 1
        if status == 0:
            sys.stdout.buffer.write(payload)
        return status


def main():
    signal.signal(signal.SIGTERM, interrupt_reader)
    signal.signal(signal.SIGINT, interrupt_reader)
    # The Bash owner supplies its fixed reader and nonsecret item coordinates.
    if len(sys.argv) != 9:
        return 64
    try:
        return read_desktop(sys.argv[1:])
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return 1


if __name__ == "__main__":
    sys.exit(main())
