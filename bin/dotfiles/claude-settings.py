#!/usr/bin/env python3
"""Install or check the Claude Code user-settings policy.

config/agents/claude/settings.json is the versioned policy. Claude Code
rewrites ~/.claude/settings.json on every supported settings operation
(plugin install, /model, /effort, its own migrations), so that file is a real
machine-owned copy: a symlink would carry those writes into the checkout.

Merge, policy over machine:
- MACHINE_CHOICES: the policy seeds them only into a new file; afterwards the
  machine owns them, including their absence (Claude deletes `model` for the
  default model).
- MERGED_MAPS: policy entries win; entries only the machine declares stay.
- SECURITY_KEYS: three-way merge against the last-applied policy record.
  Policy edits and retirements since that record apply; the host's own hooks,
  rules and values (such as `defaultMode`) stay; a policy hook or rule the
  host lacks is restored. Without a record, existing host values stay; a
  legacy-link conversion writes no record, because the tracked file may then
  hold the host's own writes.
  `--check --strict` also fails while the host keeps a differing value.
- Every other policy key: the policy value wins.
- Keys the policy does not declare stay as the machine wrote them.

Setup never deletes a machine key outside SECURITY_KEYS. Retire a policy entry
there with an explicit value, such as false for a plugin.
"""

import json
import os
from pathlib import Path
import sys
import tempfile

MACHINE_CHOICES = ("model", "effortLevel", "modelSettings", "theme")
MERGED_MAPS = ("enabledPlugins", "extraKnownMarketplaces")
SECURITY_KEYS = ("hooks", "permissions")
RECORD_NAME = "settings.dotfiles-policy.json"
REPAIR = "run ./setup.sh symlinks"
MISSING = object()


def reject_constant(value):
    raise ValueError(f"Non-standard JSON constant: {value}")


def load_object(data, label):
    value = json.loads(data, parse_constant=reject_constant)
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object")
    return value


def merge_object(base, machine, policy):
    policy_map = {} if policy is MISSING else policy
    base_map = base if isinstance(base, dict) else {}
    merged = {}
    for key in [*machine, *(key for key in policy_map if key not in machine)]:
        value = three_way(base_map.get(key, MISSING), machine.get(key, MISSING), policy_map.get(key, MISSING))
        if value is not MISSING:
            merged[key] = value
    return MISSING if policy is MISSING and not merged else merged


def merge_list(base, machine, policy):
    policy_list = [] if policy is MISSING else policy
    base_list = base if isinstance(base, list) else []
    kept = [entry for entry in machine if entry in policy_list or entry not in base_list]
    merged = kept + [entry for entry in policy_list if entry not in machine]
    return MISSING if policy is MISSING and not merged else merged


def three_way(base, machine, policy):
    """Apply policy changes since `base` to `machine`; keep the host's own changes."""
    if machine is MISSING:
        return policy
    shape = type(machine) if policy is MISSING else type(policy)
    if isinstance(machine, dict) and shape is dict:
        return merge_object(base, machine, policy)
    if isinstance(machine, list) and shape is list:
        return merge_list(base, machine, policy)
    if policy is MISSING:
        return MISSING if machine == base else machine
    if isinstance(policy, (dict, list)) or isinstance(machine, (dict, list)):
        return policy
    return policy if machine == base else machine


def merge(machine, policy, record):
    merged = dict(machine)
    for key, value in policy.items():
        current = machine.get(key)
        if key in MACHINE_CHOICES:
            continue
        if key not in machine:
            merged[key] = value
        elif key in SECURITY_KEYS:
            merged[key] = three_way(record.get(key, MISSING), current, value)
        elif key in MERGED_MAPS and isinstance(current, dict) and isinstance(value, dict):
            merged[key] = {**current, **value}
        else:
            merged[key] = value
    for key in SECURITY_KEYS:
        if key in record and key in machine and key not in policy:
            value = three_way(record[key], machine[key], MISSING)
            if value is MISSING:
                del merged[key]
            else:
                merged[key] = value
    return merged


def host_values(machine, policy, path):
    """Yield security values the host keeps that differ from the policy."""
    if isinstance(machine, dict) and isinstance(policy, dict):
        for key, value in policy.items():
            if key in machine:
                yield from host_values(machine[key], value, f"{path}.{key}")
        for key in machine:
            if key not in policy:
                yield f"{path}.{key} (host only)"
    elif isinstance(machine, list) and isinstance(policy, list):
        for entry in machine:
            if entry not in policy:
                yield f"{path} entry {json.dumps(entry)[:120]} (host only)"
    elif not isinstance(policy, (dict, list)) and machine != policy:
        yield f"{path}={json.dumps(machine)} (policy {json.dumps(policy)})"


def render(settings):
    return (json.dumps(settings, indent=2, ensure_ascii=False, allow_nan=False) + "\n").encode()


def settings_path():
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR")
    return (Path(config_dir) if config_dir else Path.home() / ".claude").absolute() / "settings.json"


def write_atomic(target, data, original, mode):
    descriptor, staged = tempfile.mkstemp(prefix=".settings-policy-", dir=target.parent)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
        os.chmod(staged, mode)
        if (target.read_bytes() if target.exists() else None) != original:
            raise ValueError("Claude settings changed during setup; retry when Claude is idle")
        # os.replace swaps a legacy symlink itself, never the tracked file it names.
        os.replace(staged, target)
    finally:
        if os.path.exists(staged):
            os.unlink(staged)


def resolve_target(source, check):
    target = settings_path()
    for path in target.parents:
        if path.is_symlink():
            raise ValueError(f"{path} must not redirect through a symlink")
    legacy = target.is_symlink()
    if legacy and Path(os.path.realpath(target)) != source.resolve():
        raise ValueError(f"{target} is a symlink to a file other than the policy; move it aside first")
    if legacy and check:
        raise ValueError(f"{target} is a legacy symlink into the checkout; {REPAIR}")
    return target, legacy


def main():
    if sys.argv[1:] not in ([], ["--check"], ["--check", "--strict"]):
        raise ValueError("Usage: claude-settings.py [--check [--strict]]")
    check = sys.argv[1:2] == ["--check"]
    strict = sys.argv[2:] == ["--strict"]
    source = Path(__file__).resolve().parents[2] / "config/agents/claude/settings.json"
    policy = load_object(source.read_bytes(), "Claude settings policy")
    target, legacy = resolve_target(source, check)
    record_path = target.parent / RECORD_NAME
    record_bytes = record_path.read_bytes() if record_path.exists() else None
    record = load_object(record_bytes, f"{record_path}") if record_bytes is not None else {}

    original = target.read_bytes() if target.exists() else None
    if original is None:
        machine, merged = {}, policy
    else:
        machine = load_object(original, f"{target}")
        merged = merge(machine, policy, record)
    notes = [note for key in SECURITY_KEYS if key in policy for note in host_values(merged.get(key), policy[key], key)]
    for note in notes:
        print(f"Host keeps {note}")
    if check:
        drifted = sorted(key for key in {*merged, *machine} if merged.get(key, MISSING) != machine.get(key, MISSING))
        if drifted:
            raise ValueError(f"policy differs at {', '.join(drifted)}; {REPAIR}")
        if strict and notes:
            raise ValueError("host security values differ from policy; port them to the tracked settings or change them on this host")
        print("Claude settings policy already applied")
        return

    target.parent.mkdir(parents=True, exist_ok=True)
    if merged != machine or legacy:
        mode = target.stat().st_mode & 0o777 if original is not None else 0o600
        write_atomic(target, render(merged), original, mode)
        print(f"Installed Claude settings policy into {target}; machine choices preserved")
    else:
        print("Claude settings policy already applied")
    applied = render({key: policy[key] for key in SECURITY_KEYS if key in policy})
    if applied != record_bytes and not legacy:
        write_atomic(record_path, applied, record_bytes, 0o600)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(f"Claude settings policy: {error}", file=sys.stderr)
        sys.exit(1)
