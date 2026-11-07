#!/usr/bin/env python3
"""Inspect account and Keychain metadata without reading credential items."""

import argparse
import json
import os
from pathlib import Path
import platform
import pwd
import re
import selectors
import shlex
import socket
import stat
import subprocess
import sys
import time


class Blocked(Exception):
    def __init__(self, cause):
        self.cause = cause


class QuietParser(argparse.ArgumentParser):
    def error(self, message):
        raise Blocked("invalid-arguments")


def arguments(argv):
    """Parse required target expectations, converting argument errors to Blocked."""
    parser = QuietParser(description=__doc__)
    parser.add_argument("--expect-host", required=True, help="Known target hostname, not an SSH alias")
    parser.add_argument("--expect-user", required=True, help="Known target account name")
    parser.add_argument("--expect-home", required=True, help="Known absolute account home")
    parser.add_argument("--context", required=True, choices=("local", "ssh"), help="Expected transport hints")
    return parser.parse_args(argv)


def admit_context(args):
    """Validate the expected macOS host, non-root account, home and transport hints.

    Return the admitted UID and canonical home before metadata probes start.
    """
    if platform.system() != "Darwin":
        raise Blocked("unsupported-platform")
    uid = os.getuid()
    if uid == 0 or uid != os.geteuid():
        raise Blocked("unsupported-user-context")
    account = pwd.getpwuid(uid)
    if socket.gethostname() != args.expect_host:
        raise Blocked("host-mismatch")
    if account.pw_name != args.expect_user:
        raise Blocked("user-mismatch")
    home = Path(account.pw_dir)
    if home.resolve() != home:
        raise Blocked("account-home-not-canonical")
    if not Path(args.expect_home).is_absolute() or args.expect_home != str(home):
        raise Blocked("expected-home-mismatch")
    if os.environ.get("HOME") != str(home):
        raise Blocked("environment-home-mismatch")
    ssh = bool(os.environ.get("SSH_CONNECTION") or os.environ.get("SSH_TTY"))
    if ssh != (args.context == "ssh"):
        raise Blocked("transport-hint-mismatch")
    return uid, home


def read_bounded(process):
    """Return at most 64 KiB, reading and waiting with one five-second deadline.

    Reject excess output or expired reads; the caller owns process cleanup.
    """
    deadline = time.monotonic() + 5
    output = bytearray()
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                raise Blocked("metadata-query-timeout")
            chunk = os.read(process.stdout.fileno(), 65537 - len(output))
            if not chunk:
                selector.unregister(process.stdout)
                break
            output.extend(chunk)
            if len(output) > 65536:
                raise Blocked("unexpected-keychain-metadata")
    process.wait(timeout=max(0, deadline - time.monotonic()))
    return bytes(output)


def query(arguments, home, capture=True):
    """Run with closed input and a minimal environment, returning code and bytes.

    Bound capture and waiting, then kill any surviving child and reap it.
    """
    try:
        with subprocess.Popen(
            arguments,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env={"HOME": str(home), "PATH": "/usr/bin:/bin", "LANG": "C"},
        ) as process:
            try:
                if capture:
                    output = read_bounded(process)
                else:
                    process.wait(timeout=5)
                    output = b""
                return process.returncode, output
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait()
    except subprocess.TimeoutExpired:
        raise Blocked("metadata-query-timeout") from None
    except OSError:
        raise Blocked("metadata-command-unavailable") from None


def keychain_paths(option, home):
    """Accept only UTF-8, quoted absolute paths from security metadata output.

    Each nonblank line must contain one path, escaping only quotes or backslashes.
    """
    code, output = query(["/usr/bin/security", option, "-d", "user"], home)
    if code != 0:
        raise Blocked("keychain-metadata-query-failed")
    try:
        lines = [line.strip() for line in output.decode("utf-8").splitlines() if line.strip()]
        if any(re.fullmatch(r'"(?:[^"\\\x00\r\n]|\\["\\])*"', line) is None for line in lines):
            raise Blocked("unexpected-keychain-metadata")
        rows = [shlex.split(line) for line in lines]
        if any(len(row) != 1 or "\x00" in row[0] for row in rows):
            raise Blocked("unexpected-keychain-metadata")
        paths = [row[0] for row in rows]
    except (UnicodeError, ValueError):
        raise Blocked("unexpected-keychain-metadata") from None
    if any(not Path(path).is_absolute() for path in paths):
        raise Blocked("unexpected-keychain-metadata")
    return paths


def inspect_keychain(uid, home):
    """Check login file ownership and collect selection and GUI-domain metadata.

    These probes inspect file and account metadata without reading credential items.
    """
    login = home / "Library/Keychains/login.keychain-db"
    if login.parent.resolve() != login.parent:
        raise Blocked("login-keychain-file-context")
    try:
        info = login.lstat()
    except FileNotFoundError:
        raise Blocked("login-keychain-missing") from None
    if not stat.S_ISREG(info.st_mode) or info.st_uid != uid:
        raise Blocked("login-keychain-file-context")
    default = keychain_paths("default-keychain", home)
    search = keychain_paths("list-keychains", home)
    if len(default) != 1:
        raise Blocked("unexpected-keychain-metadata")
    metadata = {
        "login_regular_owned_file": True,
        "default_is_login": Path(default[0]).resolve() == login.resolve(),
        "login_in_search_list": any(Path(path).resolve() == login.resolve() for path in search),
        "search_list_count": len(search),
        "gui_domain_present": query(["/bin/launchctl", "print", f"gui/{uid}"], home, False)[0] == 0,
    }
    return metadata


def report(argv):
    """Build a versioned report, admitting context before metadata probes start.

    Metadata success leaves custody, authentication and unlock state unchecked.
    """
    result = {
        "schema_version": 1,
        "status": "blocked",
        "cause": "not-started",
        "scope": "metadata-only",
        "metadata_probes_started": False,
        "custody": "not_checked",
        "authentication": "not_checked",
        "unlock_state": "not_checked",
        "requesting_client": "not_checked",
        "security_session": "not_checked",
        "next_owner": "credential-custody",
    }
    try:
        args = arguments(argv)
        uid, home = admit_context(args)
        result["metadata_probes_started"] = True
        metadata = inspect_keychain(uid, home)
        result["metadata"] = metadata
        if not metadata["default_is_login"] or not metadata["login_in_search_list"]:
            raise Blocked("keychain-selection-differs")
        result.update(status="metadata-ok", cause="metadata-observed")
    except Blocked as error:
        result["cause"] = error.cause
    except (OSError, KeyError, RuntimeError):
        result["cause"] = "metadata-inspection-unavailable"
    return result


def main():
    """Emit a JSON report and return 0 for metadata-ok or 2 for a blocked report."""
    result = report(sys.argv[1:])
    print(json.dumps(result, sort_keys=True))
    return 0 if result["status"] == "metadata-ok" else 2


if __name__ == "__main__":
    sys.exit(main())
