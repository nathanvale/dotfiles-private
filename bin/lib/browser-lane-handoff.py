#!/usr/bin/env python3
"""Private file transport and durable recovery IO for browser-lane.

Only digests and sanitized recovery metadata cross stdout. Tokens never leave
the descriptor that creates or reads the caller's private file.
"""
import hashlib
import json
import os
import re
import secrets
import stat
import sys
import time


def private_parent(path):
    if not os.path.isabs(path) or os.path.basename(path) in ("", ".", ".."):
        raise ValueError("unsafe path")
    parent = os.path.dirname(path)
    # Pin the directory before opening its child. Reject symlinked parents,
    # including intermediate components, rather than following a changed path.
    if os.path.realpath(parent) != parent:
        raise ValueError("symlink parent")
    fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    info = os.fstat(fd)
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        os.close(fd)
        raise ValueError("parent must be private")
    return fd, os.path.basename(path)


def read_private(path, limit):
    parent, name = private_parent(path)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1
                    or info.st_size > limit):
                raise ValueError("unsafe file")
            value = os.read(fd, limit + 1)
            if len(value) > limit:
                raise ValueError("oversize file")
            return value, info
        finally:
            os.close(fd)
    finally:
        os.close(parent)


def write_exclusive(path, value):
    parent, name = private_parent(path)
    try:
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=parent)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "wb", closefd=False) as stream:
                stream.write(value)
                stream.flush()
                os.fsync(fd)
            os.fsync(parent)
        finally:
            os.close(fd)
    finally:
        os.close(parent)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def recover(record, expected, acknowledged, audit_root, run_id):
    raw, info = read_private(record, 8192)
    value = json.loads(raw)
    if (not isinstance(value, dict)
            or not isinstance(value.get("task_ref"), str)
            or not isinstance(value.get("lane"), str)):
        raise ValueError("invalid reservation")
    if digest(raw) != expected or value["task_ref"] != acknowledged:
        raise ValueError("reservation changed")
    try:
        os.mkdir(audit_root, 0o700)
        audit_parent = os.open(os.path.dirname(audit_root), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(audit_parent)
        finally:
            os.close(audit_parent)
    except FileExistsError:
        pass
    receipt_id = secrets.token_hex(16)
    before = os.path.join(audit_root, receipt_id + ".before.json")
    outcome = os.path.join(audit_root, receipt_id + ".outcome.json")
    metadata = dict(command="handoff.recover", lane=value["lane"], task_ref=acknowledged,
                    reservation_sha256=expected, run_id=run_id, operator_acknowledged=True,
                    recorded_at_epoch=int(time.time()), receipt_id=receipt_id)
    write_exclusive(before, (json.dumps(dict(metadata, state="authorized")) + "\n").encode())
    parent = None
    removed = False
    completed = False
    try:
        parent, name = private_parent(record)
        current = os.stat(name, dir_fd=parent, follow_symlinks=False)
        current_raw, _ = read_private(record, 8192)
        if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino) or digest(current_raw) != expected:
            raise ValueError("reservation changed")
        os.unlink(name, dir_fd=parent)
        removed = True
        os.fsync(parent)
        os.rmdir(os.path.dirname(record))
        grandparent = os.open(os.path.dirname(os.path.dirname(record)), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(grandparent)
        finally:
            os.close(grandparent)
        completed = True
    finally:
        if parent is not None:
            os.close(parent)
        state = "recovered" if completed else "incomplete" if removed else "refused"
        write_exclusive(outcome, (json.dumps(dict(metadata, state=state)) + "\n").encode())
    print(json.dumps(dict(metadata, state="recovered")))


def main():
    action, *args = sys.argv[1:]
    if action == "create":
        token = secrets.token_hex(32).encode()
        write_exclusive(args[0], token + b"\n")
        print(digest(token))
    elif action == "hash":
        raw, _ = read_private(args[0], 65)
        if not re.fullmatch(rb"[0-9a-f]{64}\n?", raw):
            raise ValueError("invalid token")
        print(digest(raw.rstrip(b"\n")))
    elif action == "fingerprint":
        raw, _ = read_private(args[0], 8192)
        print(digest(raw))
    elif action == "recover":
        recover(*args)
    else:
        raise ValueError("unknown action")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError):
        # Do not include exception values: filenames and file contents are
        # caller supplied. The shell supplies the actionable typed error.
        sys.exit(1)
