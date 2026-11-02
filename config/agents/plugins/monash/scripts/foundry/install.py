#!/usr/bin/env python3
"""Install a reviewable, user-scoped Monash Foundry launcher snapshot."""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import stat
import sys
import tempfile
from typing import Iterable

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.9 and 3.10 use the restricted fallback.
    tomllib = None


TOOL_NAME = "monash-foundry"
MANIFEST_NAME = "installation-manifest.json"
SOURCE_FILES = (
    "foundry",
    "monash-foundry",
    "monash",
    "monash_hosts.py",
    "monash_remote.py",
    "config.json",
    "codex-models.json",
    "CODEX-CATALOG-LICENSE",
    "CODEX-CATALOG-NOTICE",
)
COMMANDS = ("foundry", "monash-foundry", "monash")
SOURCE_INSTALL_MODES = {
    name: 0o500 if name in COMMANDS or name == "monash_remote.py" else 0o600
    for name in SOURCE_FILES
}
HOST_ROLES = ("laptop", "mini")
# The one config.json drift this installer will migrate instead of refusing: the
# Claude aliases (installed value, now-live value). Nothing else is exempt.
CLAUDE_ALIAS_MIGRATION = {
    "sonnet": ("claude-sonnet-4-6", "claude-sonnet-5-5"),
    "sonnet5": ("claude-sonnet-5", "claude-sonnet-5-5"),
    "haiku": ("claude-haiku-4-5", "claude-haiku-5-5"),
}


class InstallRefusal(RuntimeError):
    """A source or destination is not safely owned by this installer."""


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_manifest(source: Path, host_role: str) -> dict[str, object]:
    if source.is_symlink() or not source.is_dir():
        raise InstallRefusal(f"invalid source directory: {source}")
    missing = [source / name for name in SOURCE_FILES if not (source / name).is_file()]
    symlinks = [source / name for name in SOURCE_FILES if (source / name).is_symlink()]
    if missing or symlinks:
        details = [f"missing source: {path}" for path in missing]
        details.extend(f"refusing symlinked source: {path}" for path in symlinks)
        raise InstallRefusal("; ".join(details))
    files = {name: sha256(source / name) for name in SOURCE_FILES}
    revision = hashlib.sha256(
        "".join(f"{name}:{files[name]}\n" for name in SOURCE_FILES).encode()
    ).hexdigest()
    return {
        "format": 1,
        "tool": TOOL_NAME,
        "host_role": host_role,
        "revision": revision,
        "files": files,
    }


def read_manifest(target: Path) -> dict[str, object] | None:
    manifest_path = target / MANIFEST_NAME
    if manifest_path.is_symlink():
        raise InstallRefusal(f"refusing symlinked installation manifest: {manifest_path}")
    if not manifest_path.exists():
        return None
    if not manifest_path.is_file():
        raise InstallRefusal(f"invalid installation manifest: {manifest_path}")
    try:
        content = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise InstallRefusal(f"unreadable installation manifest: {manifest_path}: {error}") from error
    if not isinstance(content, dict):
        raise InstallRefusal(f"unrecognized installation manifest: {manifest_path}")
    if content.get("tool") != TOOL_NAME or content.get("format") != 1:
        raise InstallRefusal(f"unrecognized installation manifest: {manifest_path}")
    files = content.get("files")
    if content.get("host_role") not in HOST_ROLES or not isinstance(files, dict):
        raise InstallRefusal(f"incomplete installation manifest: {manifest_path}")
    validate_manifest_files(files, manifest_path)
    return content


def validate_manifest_files(files: dict[object, object], manifest_path: Path) -> None:
    if not files:
        raise InstallRefusal(f"empty files in installation manifest: {manifest_path}")
    known = set(SOURCE_FILES)
    for name, expected in files.items():
        if (
            not isinstance(name, str)
            or not name
            or name != Path(name).name
            or name in {".", ".."}
            or "\\" in name
            or "\x00" in name
        ):
            raise InstallRefusal(f"unsafe installation manifest file key: {manifest_path}: {name!r}")
        if name not in known:
            raise InstallRefusal(f"unknown installation manifest file key: {manifest_path}: {name}")
        if not isinstance(expected, str):
            raise InstallRefusal(f"non-string hash for installation manifest file: {manifest_path}: {name}")
        if len(expected) != hashlib.sha256().digest_size * 2 or any(
            character not in "0123456789abcdef" for character in expected
        ):
            raise InstallRefusal(f"invalid hash for installation manifest file: {manifest_path}: {name}")


def safe_existing_parents(paths: Iterable[Path]) -> None:
    """Reject the private destination tree if any existing path component is a link."""
    seen: set[Path] = set()
    for path in paths:
        for parent in (path, *path.parents):
            if parent in seen:
                continue
            seen.add(parent)
            if parent.is_symlink():
                raise InstallRefusal(f"refusing symlinked destination parent: {parent}")
            if parent == parent.parent:
                break


def ensure_owned_target(target: Path) -> dict[str, object] | None:
    if target.is_symlink():
        raise InstallRefusal(f"refusing symlinked installation directory: {target}")
    if not target.exists():
        return None
    if not target.is_dir():
        raise InstallRefusal(f"refusing unmanaged installation directory: {target}")
    manifest = read_manifest(target)
    if manifest is None:
        raise InstallRefusal(f"refusing unmanaged installation directory: {target}")
    return manifest


def expected_link_target(target: Path, command: str) -> Path:
    return target / command


def resolved_link(path: Path) -> Path:
    return path.parent.joinpath(os.readlink(path)).resolve(strict=False)


def command_target_problems(bin_dir: Path, target: Path, required: bool) -> list[str]:
    problems: list[str] = []
    for command in COMMANDS:
        link = bin_dir / command
        if not link.exists() and not link.is_symlink():
            if required:
                problems.append(f"missing managed command link: {link}")
            continue
        if not link.is_symlink() or resolved_link(link) != expected_link_target(target, command):
            problems.append(f"refusing to replace unrelated existing target: {link}")
    return problems


def verify_command_targets(bin_dir: Path, target: Path, required: bool) -> None:
    problems = command_target_problems(bin_dir, target, required)
    if problems:
        raise InstallRefusal(problems[0])


def fallback_command_bindings(text: str) -> list[dict[str, str]]:
    """Read the only TOML shape this installer writes, ignoring comments."""
    bindings: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line == "[[keys.command]]":
            if current is not None:
                bindings.append(current)
            current = {}
            continue
        if line.startswith("["):
            if current is not None:
                bindings.append(current)
            current = None
            continue
        if current is None or "=" not in line:
            continue
        name, value = (part.strip() for part in line.split("=", 1))
        if name not in {"key", "type", "command", "description"}:
            continue
        if name in current:
            raise ValueError(f"duplicate field in keys.command: {name}")
        current[name] = fallback_toml_string(value, name)
    if current is not None:
        bindings.append(current)
    return bindings


def fallback_toml_string(value: str, field: str) -> str:
    """Parse one conservative TOML string token followed by an optional comment."""
    stripped = value.strip()
    if stripped.startswith('"'):
        try:
            parsed, end = json.JSONDecoder().raw_decode(stripped)
        except ValueError as error:
            raise ValueError(f"invalid TOML string field in keys.command: {field}") from error
        token = stripped[:end]
        index = 1
        while index < len(token) - 1:
            if token[index] != "\\":
                index += 1
                continue
            escape = token[index + 1] if index + 1 < len(token) - 1 else ""
            if escape in {'"', "\\", "b", "f", "n", "r", "t"}:
                index += 2
                continue
            if (
                escape == "u"
                and index + 6 <= len(token)
                and all(character in "0123456789abcdefABCDEF" for character in token[index + 2:index + 6])
            ):
                index += 6
                continue
            raise ValueError(f"invalid TOML string field in keys.command: {field}")
    elif stripped.startswith("'"):
        end = stripped.find("'", 1)
        if end < 0:
            raise ValueError(f"invalid TOML string field in keys.command: {field}")
        end += 1
        parsed = stripped[1:end - 1]
    else:
        raise ValueError(f"invalid TOML string field in keys.command: {field}")
    remainder = stripped[end:].lstrip()
    if remainder and not remainder.startswith("#"):
        raise ValueError(f"invalid TOML string field in keys.command: {field}")
    if not isinstance(parsed, str):
        raise ValueError(f"non-string field in keys.command: {field}")
    return parsed


def command_bindings(config: Path) -> list[dict[str, str]]:
    if config.is_symlink() or not config.is_file():
        raise InstallRefusal(f"refusing non-file private Herdr config: {config}")
    try:
        text = config.read_text(encoding="utf-8")
        if tomllib is None:
            return fallback_command_bindings(text)
        parsed = tomllib.loads(text)
    except (OSError, ValueError) as error:
        raise InstallRefusal(f"cannot parse private Herdr config: {config}: {error}") from error
    keys = parsed.get("keys", {})
    if not isinstance(keys, dict):
        raise InstallRefusal(f"invalid keys.command configuration: {config}")
    commands = keys.get("command", [])
    if not isinstance(commands, list) or not all(isinstance(item, dict) for item in commands):
        raise InstallRefusal(f"invalid keys.command configuration: {config}")
    return [
        {name: value for name, value in item.items() if isinstance(value, str)}
        for item in commands
    ]


def binding_command(target: Path) -> str:
    return f"exec {shlex.quote(str(target / 'monash'))} launch"


def legacy_binding_command(target: Path) -> str:
    return f"exec {shlex.quote(str(target / 'foundry'))} --menu"


def binding_block(target: Path) -> str:
    command = binding_command(target)
    return "\n".join(
        (
            "",
            "# Monash Foundry private picker. Managed by scripts/foundry/install.py.",
            "[[keys.command]]",
            'key = "prefix+f"',
            'type = "pane"',
            f"command = {json.dumps(command)}",
            'description = "Monash Foundry picker"',
            "",
        )
    )


def binding_state(config: Path, target: Path) -> str:
    bindings = [item for item in command_bindings(config) if item.get("key") == "prefix+f"]
    if not bindings:
        return "missing"
    if len(bindings) != 1:
        return "duplicate"
    binding = bindings[0]
    expected = {
        "key": "prefix+f",
        "type": "pane",
        "command": binding_command(target),
        "description": "Monash Foundry picker",
    }
    if all(binding.get(key) == value for key, value in expected.items()):
        return "owned"
    legacy = {
        "key": "prefix+f",
        "type": "pane",
        "command": legacy_binding_command(target),
        "description": "Monash Foundry (Codex or Claude)",
    }
    return "legacy" if all(binding.get(key) == value for key, value in legacy.items()) else "foreign"


def assert_prior_files_match(
    target: Path, manifest: dict[str, object], migrated: frozenset[str] = frozenset()
) -> None:
    files = manifest["files"]
    if not isinstance(files, dict):
        raise InstallRefusal(f"incomplete installation manifest: {target / MANIFEST_NAME}")
    for name, expected in files.items():
        installed = target / name
        if not isinstance(expected, str) or installed.is_symlink() or not installed.is_file():
            raise InstallRefusal(f"managed installed file is missing or invalid: {installed}")
        if name not in migrated and sha256(installed) != expected:
            raise InstallRefusal(f"refusing to overwrite edited managed file: {installed}")


def canonical_json_bytes(value: object) -> bytes:
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def read_json_object(path: Path) -> tuple[dict[str, object], bytes] | None:
    """The parsed object and the exact bytes read, or None for anything ambiguous."""
    try:
        raw = path.read_bytes()
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=reject_duplicate_keys)
    except (OSError, ValueError, RecursionError):
        return None
    return (value, raw) if isinstance(value, dict) else None


def known_claude_alias_drift(source: Path, target: Path, manifest: dict[str, object]) -> bool:
    """True only for the exact known historical drift in the installed config.json.

    The installed file must be exactly the manifest-recorded content with the
    three Claude aliases moved from their installed to their live values, byte
    for byte: put the old values back and serialize canonically, and the
    recorded hash must result (so those bytes are the recorded original); then
    the installed bytes must equal the canonical serialization of the live
    object. Duplicate keys, other formatting, any other byte edit, any other
    alias value, or an unreadable file returns False so the ordinary refusal
    applies. When the drift is exactly this one but the source would install
    the old aliases again, refuse rather than silently revert the live aliases.
    """
    files = manifest.get("files")
    recorded = files.get("config.json") if isinstance(files, dict) else None
    installed = target / "config.json"
    if not isinstance(recorded, str) or installed.is_symlink() or not installed.is_file():
        return False
    if sha256(installed) == recorded:
        return False
    read = read_json_object(installed)
    if read is None:
        return False
    live, live_bytes = read
    live_claude = live.get("claude")
    if not isinstance(live_claude, dict):
        return False
    if any(live_claude.get(key) != new for key, (_old, new) in CLAUDE_ALIAS_MIGRATION.items()):
        return False
    recorded_content = copy.deepcopy(live)
    for key, (old, _new) in CLAUDE_ALIAS_MIGRATION.items():
        recorded_content["claude"][key] = old  # type: ignore[index]
    if hashlib.sha256(canonical_json_bytes(recorded_content)).hexdigest() != recorded:
        return False
    if live_bytes != canonical_json_bytes(live):
        return False
    shipped_read = read_json_object(source / "config.json")
    shipped_claude = shipped_read[0].get("claude") if shipped_read is not None else None
    if not isinstance(shipped_claude, dict) or any(
        shipped_claude.get(key) != new for key, (_old, new) in CLAUDE_ALIAS_MIGRATION.items()
    ):
        raise InstallRefusal(
            "the selected source config.json would revert the live Claude aliases; "
            f"reconcile them into the source first: {source / 'config.json'}"
        )
    return True


def assert_new_files_absent(target: Path, manifest: dict[str, object]) -> None:
    files = manifest["files"]
    if not isinstance(files, dict):
        raise InstallRefusal(f"incomplete installation manifest: {target / MANIFEST_NAME}")
    managed = set(files)
    for name in SOURCE_FILES:
        if name in managed:
            continue
        destination = target / name
        if destination.exists() or destination.is_symlink():
            raise InstallRefusal(f"refusing unmanaged destination for new source file: {destination}")


def atomic_copy(source: Path, destination: Path, mode: int) -> None:
    with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as handle:
        temporary = Path(handle.name)
    try:
        shutil.copyfile(source, temporary)
        os.chmod(temporary, mode)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_text(destination: Path, text: str, mode: int) -> None:
    with tempfile.NamedTemporaryFile("w", dir=destination.parent, encoding="utf-8", delete=False) as handle:
        handle.write(text)
        temporary = Path(handle.name)
    try:
        os.chmod(temporary, mode)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def backup(target: Path, config: Path) -> Path:
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup_dir = target / "backups" / stamp
    backup_dir.mkdir(parents=True, exist_ok=False)
    os.chmod(backup_dir, 0o700)
    for name in (*SOURCE_FILES, MANIFEST_NAME):
        path = target / name
        if path.is_file() and not path.is_symlink():
            shutil.copy2(path, backup_dir / name)
    if config.is_file() and not config.is_symlink():
        shutil.copy2(config, backup_dir / "herdr.toml")
    return backup_dir


def link_identity(path: Path) -> tuple[object, ...] | None:
    """Absent, or the link text, device and inode: what makes a link this link."""
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return None
    return (os.readlink(path) if stat.S_ISLNK(info.st_mode) else None, info.st_dev, info.st_ino)


def path_is_present(path: Path) -> bool:
    """False only for a missing path; any other lstat error propagates to the caller."""
    try:
        os.lstat(path)
    except FileNotFoundError:
        return False
    return True


def restore_backup(backup_dir: Path, target: Path, config: Path) -> None:
    """Put every file saved by backup() back with its managed mode."""
    for name in (*SOURCE_FILES, MANIFEST_NAME):
        saved = backup_dir / name
        if saved.is_file():
            atomic_copy(saved, target / name, SOURCE_INSTALL_MODES.get(name, 0o600))
        else:
            (target / name).unlink(missing_ok=True)  # installed by this run, absent before
    saved_config = backup_dir / "herdr.toml"
    if saved_config.is_file():
        atomic_copy(saved_config, config, 0o600)
    else:
        config.unlink(missing_ok=True)  # created by this run, absent before


def rollback_problems(
    backup_dir: Path,
    target: Path,
    config: Path,
    bin_dir: Path,
    created_links: list[Path],
    links_before: dict[str, tuple[object, ...] | None],
) -> list[str]:
    """Undo a failed install, then check the whole managed state; empty means verified."""
    problems: list[str] = []
    for link in reversed(created_links):
        try:
            link.unlink()
        except OSError as error:
            problems.append(f"could not remove the link created by this run: {link}: {error}")
    try:
        restore_backup(backup_dir, target, config)
    except OSError as error:
        problems.append(f"restoring the saved files failed: {error}")
    saved = [(name, target / name, SOURCE_INSTALL_MODES.get(name, 0o600)) for name in (*SOURCE_FILES, MANIFEST_NAME)]
    saved.append(("herdr.toml", config, 0o600))
    # A read that fails here is a failure to verify, never evidence of restoration.
    for name, installed, mode in saved:
        kept = backup_dir / name
        try:
            if not kept.is_file():
                if path_is_present(installed):
                    problems.append(f"{name} was not present before this run but still is")
            elif installed.is_symlink() or not installed.is_file() or sha256(installed) != sha256(kept):
                problems.append(f"{name} does not match its saved copy")
            elif installed.stat().st_mode & 0o777 != mode:
                problems.append(f"{name} has the wrong mode")
        except OSError as error:
            problems.append(f"could not check {name}: {error}")
    for command in COMMANDS:
        try:
            if link_identity(bin_dir / command) != links_before[command]:
                problems.append(f"the command link {bin_dir / command} is not as it was")
        except OSError as error:
            problems.append(f"could not check the command link {bin_dir / command}: {error}")
    return problems


def install(source: Path, target: Path, bin_dir: Path, baseline: Path, host_role: str, dry_run: bool) -> int:
    manifest = source_manifest(source, host_role)
    config = target / "herdr.toml"
    safe_existing_parents((target, target / "backups", config, target / MANIFEST_NAME, bin_dir))
    prior = ensure_owned_target(target)
    verify_command_targets(bin_dir, target, required=False)
    if config.is_symlink():
        raise InstallRefusal(f"refusing symlinked private Herdr config: {config}")
    create_config = not config.exists()
    if create_config:
        if not baseline.is_file() or baseline.is_symlink():
            raise InstallRefusal(f"invalid Herdr baseline config: {baseline}")
        if any(item.get("key") == "prefix+f" for item in command_bindings(baseline)):
            raise InstallRefusal(f"Ctrl+G F already exists in Herdr baseline: {baseline}")
        binding_update = True
    else:
        state = binding_state(config, target)
        if state == "duplicate":
            raise InstallRefusal(f"duplicate Ctrl+G F bindings in private Herdr config: {config}")
        if state == "foreign":
            raise InstallRefusal(f"Ctrl+G F is owned by another command in: {config}")
        binding_update = state == "missing"
    migrated: frozenset[str] = frozenset()
    if prior is not None:
        if known_claude_alias_drift(source, target, prior):
            migrated = frozenset({"config.json"})
        assert_prior_files_match(target, prior, migrated)
        assert_new_files_absent(target, prior)

    update_snapshot = prior is not None and (prior != manifest or binding_update or bool(migrated))
    changes = [f"copy {name} to {target / name}" for name in SOURCE_FILES]
    if migrated:
        changes.append(f"migrate known Claude alias drift in config.json (previous bytes kept in {target / 'backups'})")
    changes.extend(
        f"link {bin_dir / command} to {target / command}"
        for command in COMMANDS
        if not os.path.lexists(bin_dir / command)
    )
    if create_config:
        changes.append(f"copy baseline and add Ctrl+G F binding to {config}")
    elif binding_update:
        changes.append(f"add missing managed Ctrl+G F binding to {config}")
    changes.append(f"write revision manifest to {target / MANIFEST_NAME}")
    if dry_run:
        print("Dry run. No files changed:")
        print("\n".join(f"  {change}" for change in changes))
        return 0

    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    if prior is None:
        os.chmod(target, 0o700)
    bin_dir.mkdir(parents=True, exist_ok=True)
    backup_dir = backup(target, config) if update_snapshot else None
    if migrated and backup_dir is not None and sha256(backup_dir / "config.json") != sha256(target / "config.json"):
        raise InstallRefusal(f"the private backup of the edited config.json is not exact: {backup_dir}")
    links_before = {command: link_identity(bin_dir / command) for command in COMMANDS}
    created_links: list[Path] = []
    try:
        for name in SOURCE_FILES:
            atomic_copy(source / name, target / name, SOURCE_INSTALL_MODES[name])
        if create_config:
            baseline_text = baseline.read_text(encoding="utf-8")
            atomic_text(config, baseline_text.rstrip() + "\n" + binding_block(target), 0o600)
        elif binding_update:
            existing = config.read_text(encoding="utf-8")
            atomic_text(config, existing.rstrip() + "\n" + binding_block(target), 0o600)
        atomic_text(target / MANIFEST_NAME, json.dumps(manifest, indent=2, sort_keys=True) + "\n", 0o600)
        for command in COMMANDS:
            link = bin_dir / command
            if os.path.lexists(link):
                continue  # verified above as the expected managed link: never unlinked or rewritten
            os.symlink(expected_link_target(target, command), link)
            created_links.append(link)
    except OSError as error:
        if not migrated or backup_dir is None:
            raise
        problems = rollback_problems(backup_dir, target, config, bin_dir, created_links, links_before)
        if problems:
            raise InstallRefusal(
                f"install failed ({error}) and the previous state could not be verified as restored "
                f"({'; '.join(problems)}); restore the files from {backup_dir} by hand"
            ) from error
        raise InstallRefusal(
            f"install failed ({error}); the previous snapshot was restored from {backup_dir} and verified, "
            "and the command links are as they were"
        ) from error
    print(f"Installed {TOOL_NAME} revision {manifest['revision']} at {target}")
    if migrated:
        print("Known Claude alias drift migrated: the live Claude aliases are kept in the installed config.json")
    if backup_dir:
        print(f"Previous managed snapshot backed up at {backup_dir}")
    return 0


def check(source: Path, target: Path, bin_dir: Path, host_role: str) -> int:
    expected = source_manifest(source, host_role)
    problems: list[str] = []
    try:
        config = target / "herdr.toml"
        safe_existing_parents((target, target / "backups", config, target / MANIFEST_NAME, bin_dir))
        actual = ensure_owned_target(target)
        if actual is None:
            problems.append(f"missing installation manifest: {target / MANIFEST_NAME}")
        else:
            assert_prior_files_match(target, actual)
            if actual != expected:
                problems.append("installed manifest differs from selected source or host role")
        problems.extend(command_target_problems(bin_dir, target, required=True))
        if binding_state(config, target) not in {"owned", "legacy"}:
            problems.append(f"private Herdr config lacks exactly one owned Ctrl+G F binding: {config}")
    except InstallRefusal as error:
        problems.append(str(error))
    if problems:
        print("Installation check failed:", file=sys.stderr)
        print("\n".join(f"  {problem}" for problem in problems), file=sys.stderr)
        return 1
    print(f"Installation check passed: {target}")
    return 0


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="report installation actions only")
    parser.add_argument("--check", action="store_true", help="verify the installed snapshot")
    parser.add_argument("--host-role", choices=HOST_ROLES, default="laptop", help="record host launch default")
    parser.add_argument("--prefix", type=Path, default=Path.home() / ".local", help="installation prefix")
    parser.add_argument(
        "--herdr-config",
        type=Path,
        default=Path.home() / ".config/herdr/config.toml",
        help="baseline Herdr config used only on first install",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    source = Path(__file__).resolve().parent
    prefix = args.prefix.expanduser()
    if not prefix.is_absolute():
        prefix = Path.cwd() / prefix
    target = prefix / "share/monash-foundry"
    bin_dir = prefix / "bin"
    baseline = args.herdr_config.expanduser()
    if not baseline.is_absolute():
        baseline = Path.cwd() / baseline
    try:
        if args.check:
            return check(source, target, bin_dir, args.host_role)
        return install(source, target, bin_dir, baseline, args.host_role, args.dry_run)
    except InstallRefusal as error:
        print(f"Installation refused: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
