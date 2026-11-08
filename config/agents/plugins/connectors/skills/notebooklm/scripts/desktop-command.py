"""Run one bounded MCPorter request in the same user's macOS GUI session.

The vendor alone opens its protected profile. Only nonsecret command coordinates
enter launchd; provider output travels through a private FIFO, never a file.
"""

import json
import os
from pathlib import Path
import plistlib
import re
import select
import signal
import subprocess
import sys
import tempfile
import time
import uuid

LAUNCHCTL = "/bin/launchctl"
TIMEOUT = 65
MAX_BYTES = 8_000_000


def control(*arguments):
    return subprocess.run(
        [LAUNCHCTL, *arguments], stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5,
        check=False,
    ).returncode


def interrupted(_number, _frame):
    raise InterruptedError("desktop request interrupted")


def check_owner(owner):
    if owner <= 1:
        raise InterruptedError("request owner exited")
    try:
        os.kill(owner, 0)
    except ProcessLookupError:
        raise InterruptedError("request owner exited") from None


def group_header(output, label):
    prefix = (label + ":pid:").encode()
    header = bytes(output).split(b"\n", 1)[0]
    if header.startswith(prefix) and header[len(prefix):].isdigit():
        group = int(header[len(prefix):])
        if group > 1 and group != os.getpgrp():
            return group
    return None


def receive(descriptor, label, owner, deadline, output):
    marker = ("\n" + label + ":").encode()
    while time.monotonic() < deadline:
        check_owner(owner)
        ready, _, _ = select.select([descriptor], [], [], 0.1)
        if not ready:
            continue
        output.extend(os.read(descriptor, 65536))
        if len(output) > MAX_BYTES:
            return {"status": 1, "cause": "desktop-result-too-large"}
        if marker in output and output.endswith(b"\n"):
            payload, status = output.rsplit(marker, 1)
            if status.strip().isdigit() and 0 <= int(status.strip()) <= 255:
                if group_header(payload, label) is None:
                    return {"status": 1, "cause": "desktop-route-failed"}
                return {"status": int(status.strip()), "stdout": payload.split(b"\n", 1)[1].decode("utf8")}
    return {"status": 1, "cause": "desktop-request-timeout"}


def live_group(target):
    probe = subprocess.run([LAUNCHCTL, "print", target], stdin=subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           timeout=5, check=False)
    match = re.search(rb"\n\s*pid = (\d+)", probe.stdout)
    if match:
        pid = int(match.group(1))
        if pid > 1 and pid != os.getpgrp():
            return pid
    return None


def stop_group(group):
    if group is None:
        return True
    try:
        os.killpg(group, signal.SIGKILL)
    except ProcessLookupError:
        return True
    except PermissionError:
        pass
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        try:
            os.killpg(group, 0)
        except ProcessLookupError:
            return True
        except PermissionError:
            # macOS can report EPERM while a killed group is disappearing.
            # It proves neither presence nor absence. Require ESRCH within the
            # same bound; persistent permission failure still withholds output.
            pass
        time.sleep(0.05)
    return False


def remove_job(target, descriptor, output, label):
    # A failed bootstrap can still have loaded the job. Always inspect the exact
    # owned identity after bootout, including an interrupted/unknown bootstrap.
    # Read the protected launcher's header even after caller death or an unknown
    # bootstrap acknowledgement. An already-exited leader can still have live
    # descendants in its group; launchctl no longer reports that leader's PID.
    if not output:
        try:
            output.extend(os.read(descriptor, 65536))
        except BlockingIOError:
            pass
    group = group_header(output, label)
    healthy = True
    if group is None:
        try:
            group = live_group(target)
        except (OSError, subprocess.TimeoutExpired):
            healthy = False
    # Cleanup steps are independent: a failed launchctl probe must not skip the
    # known process group, and a failed group stop must not skip job removal.
    try:
        removed = control("bootout", target) in (0, 3, 113)
    except (OSError, subprocess.TimeoutExpired):
        removed = False
    if group is None:
        try:
            output.extend(os.read(descriptor, 65536))
        except BlockingIOError:
            pass
        group = group_header(output, label)
    try:
        stopped = stop_group(group)
    except OSError:
        stopped = False
    try:
        absent = control("print", target) == 113
    except (OSError, subprocess.TimeoutExpired):
        absent = False
    return healthy and stopped and absent and removed


def execute(request):
    owner = request["owner"]
    check_owner(owner)
    deadline = time.monotonic() + TIMEOUT
    domain = "gui/" + str(os.getuid())
    if control("print", domain) != 0:
        return {"status": 1, "cause": "desktop-session-unavailable"}
    check_owner(owner)
    label = "local.connectors.notebooklm-" + uuid.uuid4().hex
    target = domain + "/" + label
    with tempfile.TemporaryDirectory(prefix="connectors-notebooklm-") as directory:
        root = Path(directory)
        os.chmod(root, 0o700)
        fifo = root / "result"
        os.mkfifo(fifo, 0o600)
        descriptor = os.open(fifo, os.O_RDWR | os.O_NONBLOCK)
        attempted = False
        output = bytearray()
        result = {"status": 1, "cause": "desktop-route-failed"}
        try:
            # Positional arguments keep command values out of shell evaluation.
            # MCPorter sees an ordinary anonymous pipe. cat drains it into the
            # blocking FIFO, whose smaller kernel buffer otherwise truncates
            # the compiled CLI's large replies at process exit.
            wrapper = 'printf "%s:pid:%s\\n" "$0" "$$"; "$@" | /bin/cat; status=${PIPESTATUS[0]}; printf "\\n%s:%s\\n" "$0" "$status"'
            job = {
                "Label": label,
                "ProgramArguments": ["/usr/bin/env", "-i", *[
                    key + "=" + value for key, value in request["env"].items()
                ], "/usr/bin/python3", "-c",
                    # launchd opens StandardOutPath nonblocking. Bun's compiled
                    # MCPorter can truncate a large reply on that descriptor.
                    # Preserve ordinary blocking-pipe semantics before exec.
                    "import os,sys; os.set_blocking(1, True); "
                    "os.execv('/bin/bash', ['/bin/bash', *sys.argv[1:]])",
                    "-c", wrapper, label, *request["argv"]],
                "RunAtLoad": True, "StandardOutPath": str(fifo),
                "StandardErrorPath": "/dev/null", "Umask": 0o077,
                "ExitTimeOut": 1, "AbandonProcessGroup": False,
            }
            plist = root / "job.plist"
            with plist.open("xb") as stream:
                os.chmod(plist, 0o600)
                plistlib.dump(job, stream)
            attempted = True
            if control("bootstrap", domain, str(plist)) == 0:
                result = receive(descriptor, label, owner, deadline, output)
        except InterruptedError:
            result = {"status": 143, "cause": "desktop-request-interrupted"}
        except (OSError, ValueError, subprocess.TimeoutExpired):
            result = {"status": 1, "cause": "desktop-route-failed"}
        finally:
            previous = {number: signal.signal(number, signal.SIG_IGN) for number in (signal.SIGINT, signal.SIGTERM)}
            try:
                if attempted and not remove_job(target, descriptor, output, label):
                    result = {"status": 1, "cause": "desktop-cleanup-failed"}
            except (OSError, subprocess.TimeoutExpired):
                result = {"status": 1, "cause": "desktop-cleanup-failed"}
            finally:
                for number, handler in previous.items():
                    signal.signal(number, handler)
                os.close(descriptor)
        return result


def main():
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        request = json.load(sys.stdin)
        result = execute(request)
    except InterruptedError:
        result = {"status": 143, "cause": "desktop-request-interrupted"}
    except (ValueError, KeyError, TypeError, OSError, subprocess.TimeoutExpired):
        result = {"status": 1, "cause": "desktop-route-failed"}
    # No result is released until the owned GUI job has been removed.
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
