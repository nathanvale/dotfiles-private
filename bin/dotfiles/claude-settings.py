#!/usr/bin/env python3
"""Install or check the Claude Code user-settings policy.

config/agents/claude/settings.json is the versioned policy. Claude Code
rewrites ~/.claude/settings.json on every supported settings operation
(plugin install, /model, /effort, its own migrations), so that file is a real
machine-owned copy: a symlink would carry those writes into the checkout.

Merge, policy over machine:
- MACHINE_CHOICES: the policy seeds a missing value; the machine value wins.
- MERGED_MAPS: policy entries win; entries only the machine declares stay.
- Every other policy key: the policy value wins.
- Keys the policy does not declare stay as the machine wrote them.

Setup never deletes a machine key. Retire a policy entry with an explicit
value, such as false for a plugin.
"""

import json
import os
from pathlib import Path
import sys
import tempfile

MACHINE_CHOICES = ("model", "effortLevel", "modelSettings", "theme")
MERGED_MAPS = ("enabledPlugins", "extraKnownMarketplaces")
REPAIR = "run ./setup.sh symlinks"


def reject_constant(value):
    raise ValueError(f"Non-standard JSON constant: {value}")


def load_object(data, label):
    value = json.loads(data, parse_constant=reject_constant)
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object")
    return value


def seed(machine, policy):
    if not isinstance(machine, dict) or not isinstance(policy, dict):
        return machine
    merged = dict(machine)
    for key, value in policy.items():
        merged[key] = seed(machine[key], value) if key in machine else value
    return merged


def merge(machine, policy):
    merged = dict(machine)
    for key, value in policy.items():
        current = machine.get(key)
        if key not in machine:
            merged[key] = value
        elif key in MACHINE_CHOICES:
            merged[key] = seed(current, value)
        elif key in MERGED_MAPS and isinstance(current, dict) and isinstance(value, dict):
            merged[key] = {**current, **value}
        else:
            merged[key] = value
    return merged


def render(settings):
    return (json.dumps(settings, indent=2, ensure_ascii=False, allow_nan=False) + "\n").encode()


def settings_path():
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR")
    return (Path(config_dir) if config_dir else Path.home() / ".claude").absolute() / "settings.json"


def main():
    if sys.argv[1:] not in ([], ["--check"]):
        raise ValueError("Usage: claude-settings.py [--check]")
    check = sys.argv[1:] == ["--check"]
    source = Path(__file__).resolve().parents[2] / "config/agents/claude/settings.json"
    policy = load_object(source.read_bytes(), "Claude settings policy")
    target = settings_path()
    if target.parent.is_symlink():
        raise ValueError(f"{target.parent} must not redirect through a symlink")
    legacy = target.is_symlink()
    if legacy and Path(os.path.realpath(target)) != source.resolve():
        raise ValueError(f"{target} is a symlink to a file other than the policy; move it aside first")
    if legacy and check:
        raise ValueError(f"{target} is a legacy symlink into the checkout; {REPAIR}")

    original = target.read_bytes() if target.exists() else None
    machine = load_object(original, f"{target}") if original is not None else {}
    merged = merge(machine, policy)
    if merged == machine and not legacy:
        print("Claude settings policy already applied")
        return
    if check:
        drifted = sorted(key for key in merged if merged[key] != machine.get(key, object()))
        raise ValueError(f"policy differs at {', '.join(drifted)}; {REPAIR}")

    target.parent.mkdir(parents=True, exist_ok=True)
    mode = target.stat().st_mode & 0o777 if original is not None else 0o600
    descriptor, staged = tempfile.mkstemp(prefix=".settings-policy-", dir=target.parent)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(render(merged))
        os.chmod(staged, mode)
        if (target.read_bytes() if target.exists() else None) != original:
            raise ValueError("Claude settings changed during setup; retry when Claude is idle")
        # os.replace swaps a legacy symlink itself, never the tracked file it names.
        os.replace(staged, target)
    finally:
        if os.path.exists(staged):
            os.unlink(staged)
    print(f"Installed Claude settings policy into {target}; machine choices preserved")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(f"Claude settings policy: {error}", file=sys.stderr)
        sys.exit(1)
