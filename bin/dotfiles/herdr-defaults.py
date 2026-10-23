#!/usr/bin/env python3
"""Install or check the additive user-level Herdr coordinator default."""

import json
import os
from pathlib import Path
import sys
import tempfile


def reject_constant(value):
    raise ValueError(f"Non-standard JSON constant: {value}")


def main():
    if sys.argv[1:] not in ([], ["--check"]):
        raise ValueError("Usage: herdr-defaults.py [--check]")
    check = sys.argv[1:] == ["--check"]
    root = Path(__file__).resolve().parents[2]
    default = (root / "config/herdr/coordinator-instructions.txt").read_text().strip()
    home = Path(os.environ.get("HERDR_PROJECTS_HOME") or Path.home() / ".herdr-projects")
    config = Path(os.environ.get("HERDR_PROJECTS_CONFIG_DIR") or home / "settings")
    target = (config / "config.json").absolute()
    for path in (target, *target.parents):
        if path.is_symlink():
            raise ValueError("Herdr settings must not redirect through a symlink")
    original = target.read_bytes() if target.exists() else None
    settings = json.loads(original, parse_constant=reject_constant) if original is not None else {}
    if not isinstance(settings, dict):
        raise ValueError("Herdr settings must be a JSON object")
    coordinator = settings.setdefault("coordinator", {})
    if not isinstance(coordinator, dict):
        raise ValueError("Herdr coordinator settings must be an object")
    instructions = coordinator.get("instructions", "")
    if not isinstance(instructions, str):
        raise ValueError("Herdr coordinator instructions must be text")
    if default in instructions:
        print("Herdr coordinator default is installed")
        return
    if check:
        raise ValueError("Herdr coordinator default is missing; run ./setup.sh symlinks")
    coordinator["instructions"] = (instructions + "\n\n" if instructions else "") + default
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, staged = tempfile.mkstemp(prefix=".coordinator-default-", dir=target.parent)
    try:
        with os.fdopen(descriptor, "w") as output:
            json.dump(settings, output, indent=2, allow_nan=False)
            output.write("\n")
        if (target.read_bytes() if target.exists() else None) != original:
            raise ValueError("Herdr settings changed during setup; retry when settings are idle")
        os.replace(staged, target)
    finally:
        if os.path.exists(staged):
            os.unlink(staged)
    print("Installed Herdr coordinator default; existing settings preserved")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(f"Herdr coordinator default: {error}", file=sys.stderr)
        sys.exit(1)
