#!/usr/bin/python3
"""Expire only manifest-listed people-pilot working copies on this host."""

import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile
import time


ROOT = Path.home() / ".local/state/my-second-brain/people-metadata-pilot"
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\Z")


def private_directory(path):
    if path.is_symlink() or path.resolve() != path.absolute():
        raise ValueError("symlink-directory")
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError("unowned-directory")
    if info.st_mode & 0o077:
        raise ValueError("directory-permissions")


def instant(value):
    result = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("missing-timezone")
    return result


def deletion_plan(batch, now):
    private_directory(batch)
    manifest_path = batch / "manifest.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ValueError("unsafe-manifest")
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("schema") != 1 or manifest.get("collection_id") != batch.name:
        raise ValueError("invalid-manifest")
    collected = instant(manifest["collected_at"])
    expires = instant(manifest["expires_at"])
    if expires != collected + dt.timedelta(days=30) or not manifest.get("deletion_operator"):
        raise ValueError("invalid-expiry-contract")
    names = manifest["temporary_entries"]
    if not isinstance(names, list) or len(names) != len(set(names)):
        raise ValueError("invalid-entry-list")
    if any(not isinstance(n, str) or not NAME.fullmatch(n) or n == "manifest.json" for n in names):
        raise ValueError("unsafe-entry")
    if set(p.name for p in batch.iterdir()) - set(names) - {"manifest.json"}:
        raise ValueError("unlisted-entry")
    paths = [batch / n for n in names if (batch / n).exists() or (batch / n).is_symlink()]
    for path in paths:
        for node in [path, *(path.rglob("*") if path.is_dir() else [])]:
            info = node.lstat()
            if node.is_symlink() or info.st_uid != os.getuid():
                raise ValueError("unsafe-entry-owner-or-link")
            if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                raise ValueError("unsafe-entry-type")
    return expires <= now, paths


def receipt(collection_id, status, count, cause=None):
    result = {
        "schema": 1,
        "collection_id": collection_id,
        "observed_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "status": status,
        "removed_entries": count,
    }
    if cause:
        result["cause"] = cause
    with tempfile.NamedTemporaryFile(mode="w", dir=ROOT / "receipts", delete=False) as stream:
        json.dump(result, stream, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
        temporary = stream.name
    destination = ROOT / "receipts" / f"{collection_id}.{time.time_ns()}.json"
    os.replace(temporary, destination)


def sweep(apply):
    if not ROOT.exists():
        return {"status": "absent", "expired": 0, "retained": 0, "failed": 0}
    for path in [ROOT, ROOT / "working", ROOT / "receipts"]:
        private_directory(path)
    counts = {"expired": 0, "retained": 0, "failed": 0}
    now = dt.datetime.now(dt.timezone.utc)
    for batch in sorted((ROOT / "working").iterdir()):
        removed = 0
        try:
            if not NAME.fullmatch(batch.name):
                raise ValueError("unsafe-collection-id")
            due, paths = deletion_plan(batch, now)
            if not due:
                counts["retained"] += 1
                continue
            if apply:
                for path in paths:
                    if path.is_dir():
                        shutil.rmtree(path)
                    else:
                        path.unlink()
                    removed += 1
                receipt(batch.name, "working-copies-deleted", removed)
                (batch / "manifest.json").unlink()
                batch.rmdir()
                receipt(batch.name, "deleted", removed)
            counts["expired"] += 1
        except (OSError, ValueError, KeyError, TypeError):
            counts["failed"] += 1
            if apply and NAME.fullmatch(batch.name):
                receipt(batch.name, "failed", removed, "inspect-manifest-or-filesystem")
    return {"status": "failed" if counts["failed"] else "ok", "applied": apply, **counts}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Delete expired manifest-listed working copies")
    args = parser.parse_args()
    try:
        if ROOT.exists():
            private_directory(ROOT)
            descriptor = os.open(ROOT / "cleanup.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, "w") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result = sweep(args.apply)
        else:
            result = sweep(args.apply)
    except BlockingIOError:
        result = {"status": "busy", "failed": 0}
    except (OSError, ValueError):
        result = {"status": "failed", "cause": "unsafe-or-unavailable-pilot-store", "failed": 1}
    print(json.dumps(result, sort_keys=True))
    return 1 if result.get("failed") else 0


if __name__ == "__main__":
    raise SystemExit(main())
