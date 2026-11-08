#!/usr/bin/python3
"""Synthetic launchd; process proof only, no keychain or GUI job is opened."""
import json
import os
from pathlib import Path
import plistlib
import signal
import subprocess
import sys
import time

root = Path(os.environ["DESKTOP_FIXTURE"])


def launch(job):
    with open(job["StandardOutPath"], "wb", buffering=0) as stream:
        # Native launchd opens StandardOutPath nonblocking, which matters for
        # large replies from the compiled MCPorter executable.
        os.set_blocking(stream.fileno(), False)
        child = subprocess.Popen(
            job["ProgramArguments"], stdin=subprocess.DEVNULL,
            stdout=stream, stderr=subprocess.DEVNULL, start_new_session=True,
        )
    # A native launchd service record is observed atomically. SIGTERM can
    # interrupt bootstrap here; expose either the complete record or none.
    pending = root / "job.pid.pending"
    pending.write_text(str(child.pid))
    pending.replace(root / "job.pid")


command = sys.argv[1]
if command == "print":
    if len(sys.argv[2].split("/")) > 2:
        if (root / "pending.json").exists():
            launch(json.loads((root / "pending.json").read_text()))
            (root / "pending.json").unlink()
            for _ in range(100):
                if (root / "grandchild").exists():
                    break
                time.sleep(0.01)
            sys.exit(0)  # Simulate a launchctl observation without a PID.
        sys.exit(0 if (root / "job.pid").exists() else 113)
    (root / "checking-gui").touch()
    if (root / "slow-gui").exists():
        time.sleep(0.3)
    sys.exit(1 if (root / "no-gui").exists() else 0)
if command == "bootstrap":
    job = plistlib.loads(Path(sys.argv[3]).read_bytes())
    (root / "job.json").write_text(json.dumps(job))
    (root / "permissions.json").write_text(json.dumps([
        Path(sys.argv[3]).parent.stat().st_mode & 0o777,
        Path(sys.argv[3]).stat().st_mode & 0o777,
        Path(job["StandardOutPath"]).stat().st_mode & 0o777,
    ]))
    if (root / "late-start").exists():
        (root / "pending.json").write_text(json.dumps(job))
        sys.exit(1)
    launch(job)
    if any((root / marker).exists() for marker in ["bootstrap-failure", "bootstrap-timeout", "wait-tree"]):
        for _ in range(400):
            if (root / "grandchild").exists():
                break
            time.sleep(0.01)
    if (root / "bootstrap-timeout").exists():
        time.sleep(10)
    sys.exit(1 if (root / "bootstrap-failure").exists() else 0)
if command == "bootout":
    if (root / "bootout-timeout").exists():
        time.sleep(10)
    if (root / "cleanup-failure").exists():
        sys.exit(1)
    f = root / "job.pid"
    if f.exists():
        try:
            os.killpg(int(f.read_text()), signal.SIGTERM)
        except ProcessLookupError:
            pass
        f.unlink()
    (root / "removed").touch()
    sys.exit(0)
sys.exit(2)
