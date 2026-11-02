"""Public-process tests for the Terra Monash Foundry installer.

These tests exercise install.py as a real process. Their expected values are
test-owned literals and filesystem observations; they do not import the
installer implementation.

Run:
    python3 -m unittest discover -s scripts/foundry -p 'test_install.py' -v
"""

from __future__ import annotations

import ast
import copy
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest


INSTALLER = Path(__file__).resolve().with_name("install.py")
SOURCE_DIR = INSTALLER.parent
REPO_ROOT = SOURCE_DIR.parent.parent

# Independent oracle. Do not import these vocabularies from install.py.
EXPECTED_SOURCE_FILES = (
    "foundry",
    "monash-foundry",
    "monash",
    "monash_hosts.py",
    "monash_remote.py",
    "monash-codex-token",
    "monash-codex-desktop",
    "config.json",
    "codex-models.json",
    "CODEX-CATALOG-LICENSE",
    "CODEX-CATALOG-NOTICE",
)
EXPECTED_COMMANDS = ("foundry", "monash-foundry", "monash")

# Independent oracle for the one historical config drift the installer migrates:
# the Claude aliases, from the deployments they named when the snapshot was
# installed to the 5.5 deployments live Azure lists on the Claude resource.
OLD_CLAUDE_ALIASES = {"sonnet": "claude-sonnet-4-6", "sonnet5": "claude-sonnet-5", "haiku": "claude-haiku-4-5"}
NEW_CLAUDE_ALIASES = {"sonnet": "claude-sonnet-5-5", "sonnet5": "claude-sonnet-5-5", "haiku": "claude-haiku-5-5"}


# Runs the real installer with os.symlink failing on its Nth call, like a full
# disk or a permission change at the moment a command link is written.
FAILING_SYMLINK_HARNESS = '''
import os, runpy, sys
fail_on, installer = int(sys.argv[1]), sys.argv[2]
calls = 0
real_symlink = os.symlink

def failing_symlink(*args, **kwargs):
    global calls
    calls += 1
    if calls == fail_on:
        raise OSError(28, "injected symlink failure")
    return real_symlink(*args, **kwargs)

os.symlink = failing_symlink
sys.argv = [installer] + sys.argv[3:]
runpy.run_path(installer, run_name="__main__")
'''


# Runs the real installer with the first command-link write failing (which starts
# the rollback) and, once rollback has begun, one verification read failing with
# EIO: "config" fails the byte read of the installed config.json, "link" fails
# the lstat of the foundry command link, "herdr" fails the lstat of the private
# Herdr config (the check that it is absent again).
FAILING_RECOVERY_HARNESS = '''
import errno, io, os, runpy, sys
read_target, installer = sys.argv[1], sys.argv[2]
armed = False
real_lstat, real_open = os.lstat, io.open

def failing_symlink(*args, **kwargs):
    global armed
    armed = True
    raise OSError(errno.ENOSPC, "injected symlink failure")

def failing_lstat(path, *args, **kwargs):
    if armed and read_target == "link" and str(path).endswith("/bin/foundry"):
        raise OSError(errno.EIO, "injected verification read failure")
    if armed and read_target == "herdr" and str(path).endswith("/share/monash-foundry/herdr.toml"):
        raise OSError(errno.EIO, "injected verification read failure")
    return real_lstat(path, *args, **kwargs)

def failing_open(file, mode="r", *args, **kwargs):
    if armed and read_target == "config" and str(file).endswith("/share/monash-foundry/config.json") and "b" in mode:
        raise OSError(errno.EIO, "injected verification read failure")
    return io_open(file, mode, *args, **kwargs)

io_open = real_open
os.symlink, os.lstat, io.open = failing_symlink, failing_lstat, failing_open
sys.argv = [installer] + sys.argv[3:]
runpy.run_path(installer, run_name="__main__")
'''


def canonical_config_bytes(config: object) -> bytes:
    return (json.dumps(config, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


# Independent fixture for the valid manifest written before the Monash facade
# and remote helper were added to the package.
LEGACY_SOURCE_FILES = (
    "foundry",
    "monash-foundry",
    "config.json",
    "codex-models.json",
    "CODEX-CATALOG-LICENSE",
    "CODEX-CATALOG-NOTICE",
)
LEGACY_SOURCE_MODES = {
    "foundry": 0o500,
    "monash-foundry": 0o500,
    "config.json": 0o600,
    "codex-models.json": 0o600,
    "CODEX-CATALOG-LICENSE": 0o600,
    "CODEX-CATALOG-NOTICE": 0o600,
}

# Independent mode oracle. The remote helper and the Codex desktop helper and
# token command are executable data run by installed path, not bin commands.
EXPECTED_SOURCE_MODES = {
    "foundry": 0o500,
    "monash-foundry": 0o500,
    "monash": 0o500,
    "monash_hosts.py": 0o600,
    "monash_remote.py": 0o500,
    "monash-codex-token": 0o500,
    "monash-codex-desktop": 0o500,
    "config.json": 0o600,
    "codex-models.json": 0o600,
    "CODEX-CATALOG-LICENSE": 0o600,
    "CODEX-CATALOG-NOTICE": 0o600,
}

BASELINE_TEXT = textwrap.dedent(
    """
    # Test-owned Herdr baseline.
    theme = "terra-dark"
    prefix = "ctrl+g"

    [[keys.command]]
    key = "prefix+g"
    type = "pane"
    command = "echo existing-pane"
    description = "Existing pane"
    """
).lstrip()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def legacy_manifest() -> dict[str, object]:
    files = {name: sha256(SOURCE_DIR / name) for name in LEGACY_SOURCE_FILES}
    revision = hashlib.sha256(
        "".join(f"{name}:{files[name]}\n" for name in LEGACY_SOURCE_FILES).encode()
    ).hexdigest()
    return {
        "format": 1,
        "tool": "monash-foundry",
        "host_role": "mini",
        "revision": revision,
        "files": files,
    }


def tree_snapshot(root: Path) -> tuple[object, ...]:
    """Read a path tree without following symlink directories."""

    if root.is_symlink():
        return ("symlink", os.readlink(root))
    if not root.exists():
        return ("missing",)
    if not root.is_dir():
        return ("file", root.read_bytes())

    entries: list[tuple[object, ...]] = []
    for current, directories, files in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        for name in sorted(tuple(directories)):
            path = current_path / name
            relative = str(path.relative_to(root))
            if path.is_symlink():
                entries.append((relative, "symlink", os.readlink(path)))
                directories.remove(name)
            else:
                entries.append((relative, "directory"))
        for name in sorted(files):
            path = current_path / name
            relative = str(path.relative_to(root))
            if path.is_symlink():
                entries.append((relative, "symlink", os.readlink(path)))
            else:
                entries.append((relative, "file", path.read_bytes()))
    return ("directory", *entries)


def command_bindings(config: Path) -> list[dict[str, str]]:
    """Read only the command records used by this test-owned fixture."""

    bindings: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    for raw_line in config.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line == "[[keys.command]]":
            current = {}
            bindings.append(current)
            continue
        if line.startswith("["):
            current = None
            continue
        if current is None or "=" not in line:
            continue
        name, value = (part.strip() for part in line.split("=", 1))
        if name not in {"key", "type", "command", "description"}:
            continue
        try:
            parsed = ast.literal_eval(value.split("#", 1)[0].strip())
        except (SyntaxError, ValueError):
            continue
        if isinstance(parsed, str):
            current[name] = parsed
    return bindings


class TerraInstallerProcessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="terra installer test ")
        self.addCleanup(self.temp.cleanup)
        # macOS may expose the temporary root through /var -> /private/var.
        # Pass the canonical path to the installer because it refuses any
        # symlinked destination parent by design.
        self.root = Path(self.temp.name).resolve()
        self.prefix = self.root / "private prefix with spaces"
        self.baseline = self.root / "baseline herdr config with spaces.toml"
        self.baseline.write_text(BASELINE_TEXT, encoding="utf-8")
        self.real_home = os.environ.get("HOME")

    def target(self, prefix: Path | None = None) -> Path:
        return (prefix or self.prefix) / "share" / "monash-foundry"

    def run_installer(
        self,
        *args: str,
        installer: Path = INSTALLER,
        prefix: Path | None = None,
        baseline: Path | None = None,
        env_overrides: dict[str, str] | None = None,
        wrapper: tuple[str, ...] = (),
    ) -> subprocess.CompletedProcess[str]:
        selected_prefix = prefix or self.prefix
        selected_baseline = baseline or self.baseline
        environment = os.environ.copy()
        if env_overrides:
            environment.update(env_overrides)
        self.assertEqual(environment.get("HOME"), self.real_home)
        return subprocess.run(
            [
                sys.executable,
                *wrapper,
                str(installer),
                "--prefix",
                str(selected_prefix),
                "--herdr-config",
                str(selected_baseline),
                *args,
            ],
            cwd=REPO_ROOT,
            env=environment,
            input="",
            text=True,
            capture_output=True,
            timeout=20,
        )

    def assert_success(self, result: subprocess.CompletedProcess[str]) -> None:
        self.assertEqual(
            result.returncode,
            0,
            f"unexpected success failure; stdout={result.stdout!r} stderr={result.stderr!r}",
        )
        self.assertEqual(result.stderr, "")

    def assert_refusal(self, result: subprocess.CompletedProcess[str]) -> None:
        self.assertEqual(
            result.returncode,
            2,
            f"unexpected refusal status; stdout={result.stdout!r} stderr={result.stderr!r}",
        )
        self.assertEqual(result.stdout, "")
        self.assertIn("Installation refused:", result.stderr)

    def assert_check_failure(self, result: subprocess.CompletedProcess[str]) -> None:
        self.assertEqual(
            result.returncode,
            1,
            f"unexpected check status; stdout={result.stdout!r} stderr={result.stderr!r}",
        )
        self.assertEqual(result.stdout, "")
        self.assertIn("Installation check failed:", result.stderr)

    def assert_same_path(self, actual: Path, expected: Path) -> None:
        actual_resolved = actual.resolve(strict=False)
        expected_resolved = expected.resolve(strict=False)
        self.assertEqual(actual_resolved, expected_resolved)
        if actual.exists() and expected.exists():
            self.assertTrue(actual.samefile(expected))

    def assert_managed_binding(self, config: Path, target: Path) -> None:
        managed = [item for item in command_bindings(config) if item.get("key") == "prefix+f"]
        self.assertEqual(len(managed), 1)
        binding = managed[0]
        self.assertEqual(binding.get("type"), "pane")
        self.assertEqual(binding.get("description"), "Monash Foundry picker")
        command = shlex.split(binding.get("command", ""))
        self.assertEqual(command[0:1], ["exec"])
        self.assertEqual(command[2:], ["launch"])
        self.assert_same_path(Path(command[1]), target / "monash")

    def install_initial(self, host_role: str = "mini") -> Path:
        result = self.run_installer("--host-role", host_role)
        self.assert_success(result)
        self.assertIn("Installed monash-foundry revision ", result.stdout)
        return self.target()

    def install_legacy_snapshot(
        self,
        prefix: Path | None = None,
        legacy_binding: bool = False,
    ) -> Path:
        selected_prefix = prefix or self.prefix
        target = self.target(selected_prefix)
        target.mkdir(parents=True, mode=0o700)
        for name in LEGACY_SOURCE_FILES:
            installed = target / name
            shutil.copyfile(SOURCE_DIR / name, installed)
            os.chmod(installed, LEGACY_SOURCE_MODES[name])

        private_config = target / "herdr.toml"
        if legacy_binding:
            binding_command = f"exec {shlex.quote(str(target / 'foundry'))} --menu"
            binding_description = "Monash Foundry (Codex or Claude)"
        else:
            binding_command = f"exec {shlex.quote(str(target / 'monash'))} launch"
            binding_description = "Monash Foundry picker"
        private_config.write_text(
            BASELINE_TEXT.rstrip()
            + "\n\n"
            + "[[keys.command]]\n"
            + 'key = "prefix+f"\n'
            + 'type = "pane"\n'
            + f"command = {json.dumps(binding_command)}\n"
            + f"description = {json.dumps(binding_description)}\n",
            encoding="utf-8",
        )
        os.chmod(private_config, 0o600)

        bin_dir = selected_prefix / "bin"
        bin_dir.mkdir(parents=True)
        for command in ("foundry", "monash-foundry"):
            (bin_dir / command).symlink_to(target / command)

        manifest_path = target / "installation-manifest.json"
        manifest_path.write_text(json.dumps(legacy_manifest(), indent=2) + "\n", encoding="utf-8")
        os.chmod(manifest_path, 0o600)
        return target

    def assert_managed_links(self, target: Path, prefix: Path | None = None) -> None:
        bin_dir = (prefix or self.prefix) / "bin"
        for command in EXPECTED_COMMANDS:
            link = bin_dir / command
            self.assertTrue(link.is_symlink(), f"missing managed link: {link}")
            self.assert_same_path(link, target / command)

    def test_initial_install_check_manifest_baseline_and_binding(self) -> None:
        target = self.install_initial("mini")
        manifest_path = target / "installation-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

        self.assertEqual(manifest["format"], 1)
        self.assertEqual(manifest["tool"], "monash-foundry")
        self.assertEqual(manifest["host_role"], "mini")
        self.assertEqual(set(manifest["files"]), set(EXPECTED_SOURCE_FILES))
        for name in EXPECTED_SOURCE_FILES:
            self.assertEqual(manifest["files"][name], sha256(SOURCE_DIR / name))
            self.assertEqual((target / name).stat().st_mode & 0o777, EXPECTED_SOURCE_MODES[name])
        self.assertRegex(manifest["revision"], r"^[0-9a-f]{64}$")

        self.assert_managed_links(target)
        private_config = target / "herdr.toml"
        installed_text = private_config.read_text(encoding="utf-8")
        self.assertTrue(installed_text.startswith(BASELINE_TEXT.rstrip() + "\n"))
        self.assertIn('theme = "terra-dark"', installed_text)
        baseline_binding = [item for item in command_bindings(private_config) if item.get("key") == "prefix+g"]
        self.assertEqual(baseline_binding, [{
            "key": "prefix+g",
            "type": "pane",
            "command": "echo existing-pane",
            "description": "Existing pane",
        }])
        self.assert_managed_binding(private_config, target)

        checked = self.run_installer("--check", "--host-role", "mini")
        self.assert_success(checked)
        self.assertIn("Installation check passed:", checked.stdout)

    def test_remote_helper_is_a_hashed_executable_data_payload(self) -> None:
        target = self.install_initial()
        manifest = json.loads((target / "installation-manifest.json").read_text(encoding="utf-8"))

        self.assertIn("monash_remote.py", EXPECTED_SOURCE_FILES)
        self.assertEqual(manifest["files"]["monash_remote.py"], sha256(SOURCE_DIR / "monash_remote.py"))
        self.assertEqual((target / "monash_remote.py").stat().st_mode & 0o777, 0o500)

    def test_remote_helper_is_not_a_command_or_user_facing_bin_link(self) -> None:
        target = self.install_initial()

        self.assertNotIn("monash_remote.py", EXPECTED_COMMANDS)
        helper_link = self.prefix / "bin" / "monash_remote.py"
        self.assertFalse(helper_link.exists())
        self.assertFalse(helper_link.is_symlink())
        self.assertTrue((target / "monash_remote.py").is_file())

    def test_legacy_six_file_manifest_upgrades_to_current_snapshot(self) -> None:
        target = self.install_legacy_snapshot()
        before = {
            name: (target / name).read_bytes()
            for name in LEGACY_SOURCE_FILES
        }

        upgraded = self.run_installer("--host-role", "mini")

        self.assert_success(upgraded)
        self.assertIn("Previous managed snapshot backed up at ", upgraded.stdout)
        manifest = json.loads((target / "installation-manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(set(manifest["files"]), set(EXPECTED_SOURCE_FILES))
        for name in EXPECTED_SOURCE_FILES:
            self.assertEqual(manifest["files"][name], sha256(SOURCE_DIR / name))
            self.assertEqual((target / name).stat().st_mode & 0o777, EXPECTED_SOURCE_MODES[name])
        self.assert_managed_links(target)
        self.assert_managed_binding(target / "herdr.toml", target)

        backup_dirs = list((target / "backups").iterdir())
        self.assertEqual(len(backup_dirs), 1)
        backup_dir = backup_dirs[0]
        self.assertEqual(
            {path.name for path in backup_dir.iterdir()},
            {*LEGACY_SOURCE_FILES, "installation-manifest.json", "herdr.toml"},
        )
        for name, content in before.items():
            self.assertEqual((backup_dir / name).read_bytes(), content)
        self.assertEqual(
            set(json.loads((backup_dir / "installation-manifest.json").read_text(encoding="utf-8")).get("files", {})),
            set(LEGACY_SOURCE_FILES),
        )

        checked = self.run_installer("--check", "--host-role", "mini")
        self.assert_success(checked)

    def test_legacy_upgrade_refuses_unmanaged_new_destination(self) -> None:
        for kind in ("file", "directory", "symlink"):
            with self.subTest(kind=kind):
                prefix = self.root / f"legacy collision {kind}"
                target = self.install_legacy_snapshot(prefix)
                collision = target / "monash_remote.py"
                if kind == "file":
                    collision.write_text("unmanaged collision\n", encoding="utf-8")
                elif kind == "directory":
                    collision.mkdir()
                else:
                    outside = self.root / f"legacy collision target {kind}"
                    outside.write_text("unmanaged collision\n", encoding="utf-8")
                    collision.symlink_to(outside)
                before = tree_snapshot(prefix)

                refused = self.run_installer(prefix=prefix)

                self.assert_refusal(refused)
                self.assertIn("unmanaged destination for new source file", refused.stderr)
                self.assertIn("monash_remote.py", refused.stderr)
                self.assertEqual(tree_snapshot(prefix), before)
                self.assertFalse((target / "backups").exists())

    def test_legacy_upgrade_refuses_edited_old_file(self) -> None:
        target = self.install_legacy_snapshot()
        edited = target / "foundry"
        edited.chmod(0o600)
        edited.write_bytes(edited.read_bytes() + b"\n# disposable edit\n")
        before = tree_snapshot(self.prefix)

        refused = self.run_installer()

        self.assert_refusal(refused)
        self.assertIn("edited managed file", refused.stderr)
        self.assertEqual(tree_snapshot(self.prefix), before)
        self.assertFalse((target / "backups").exists())

    def test_legacy_binding_upgrades_and_checks_without_config_rewrite(self) -> None:
        target = self.install_legacy_snapshot(legacy_binding=True)
        private_config = target / "herdr.toml"
        before = private_config.read_bytes()

        upgraded = self.run_installer()

        self.assert_success(upgraded)
        self.assertEqual(private_config.read_bytes(), before)
        bindings = [item for item in command_bindings(private_config) if item.get("key") == "prefix+f"]
        self.assertEqual(len(bindings), 1)
        self.assertEqual(bindings[0].get("command"), f"exec {shlex.quote(str(target / 'foundry'))} --menu")
        self.assertEqual(bindings[0].get("description"), "Monash Foundry (Codex or Claude)")

        checked = self.run_installer("--check")

        self.assert_success(checked)
        self.assertEqual(private_config.read_bytes(), before)

    def test_legacy_binding_upgrades_without_tomllib(self) -> None:
        target = self.install_legacy_snapshot(legacy_binding=True)
        private_config = target / "herdr.toml"
        private_config.write_text(
            private_config.read_text(encoding="utf-8")
            + "\n[[keys.command]]\n"
            + "key = 'prefix+shift+t'\n"
            + "type = 'popup'\n"
            + "command = 'exec \"${SHELL:-sh}\"'\n"
            + "description = 'Scratch terminal'\n",
            encoding="utf-8",
        )
        before = private_config.read_bytes()
        import_shim = self.root / "python 3.9 import shim"
        import_shim.mkdir()
        (import_shim / "tomllib.py").write_text(
            'raise ModuleNotFoundError("No module named tomllib")\n',
            encoding="utf-8",
        )
        env_overrides = {"PYTHONPATH": str(import_shim)}

        upgraded = self.run_installer(env_overrides=env_overrides)

        self.assert_success(upgraded)
        self.assertEqual(private_config.read_bytes(), before)
        manifest = json.loads((target / "installation-manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(set(manifest["files"]), set(EXPECTED_SOURCE_FILES))

        checked = self.run_installer("--check", env_overrides=env_overrides)

        self.assert_success(checked)
        self.assertEqual(private_config.read_bytes(), before)

    def test_fallback_parser_refuses_duplicate_binding_field_without_mutation(self) -> None:
        target = self.install_legacy_snapshot(legacy_binding=True)
        private_config = target / "herdr.toml"
        legacy_command = f"exec {shlex.quote(str(target / 'foundry'))} --menu"
        legacy_line = f"command = {json.dumps(legacy_command)}\n"
        private_config.write_text(
            private_config.read_text(encoding="utf-8").replace(
                legacy_line,
                'command = "foreign-command"\n' + legacy_line,
                1,
            ),
            encoding="utf-8",
        )
        before = tree_snapshot(self.prefix)
        import_shim = self.root / "duplicate field import shim"
        import_shim.mkdir()
        (import_shim / "tomllib.py").write_text(
            'raise ModuleNotFoundError("No module named tomllib")\n',
            encoding="utf-8",
        )

        refused = self.run_installer(env_overrides={"PYTHONPATH": str(import_shim)})

        self.assert_refusal(refused)
        self.assertIn("duplicate field in keys.command: command", refused.stderr)
        self.assertEqual(tree_snapshot(self.prefix), before)

    def test_fallback_parser_refuses_adjacent_python_string_literals_without_mutation(self) -> None:
        target = self.install_legacy_snapshot(legacy_binding=True)
        private_config = target / "herdr.toml"
        private_config.write_text(
            private_config.read_text(encoding="utf-8").replace(
                'key = "prefix+f"\n',
                'key = "prefix+" "f"\n',
                1,
            ),
            encoding="utf-8",
        )
        before = tree_snapshot(self.prefix)
        import_shim = self.root / "adjacent string import shim"
        import_shim.mkdir()
        (import_shim / "tomllib.py").write_text(
            'raise ModuleNotFoundError("No module named tomllib")\n',
            encoding="utf-8",
        )

        refused = self.run_installer(env_overrides={"PYTHONPATH": str(import_shim)})

        self.assert_refusal(refused)
        self.assertIn("invalid TOML string field in keys.command: key", refused.stderr)
        self.assertEqual(tree_snapshot(self.prefix), before)

    def test_near_match_legacy_binding_refuses_without_mutation(self) -> None:
        target = self.install_legacy_snapshot(legacy_binding=True)
        private_config = target / "herdr.toml"
        foreign_target = self.root / "foreign managed target" / "monash-foundry"
        foreign_command = f"exec {shlex.quote(str(foreign_target / 'foundry'))} --menu"
        private_config.write_text(
            private_config.read_text(encoding="utf-8").replace(
                f"exec {shlex.quote(str(target / 'foundry'))} --menu",
                foreign_command,
            ),
            encoding="utf-8",
        )
        before = tree_snapshot(self.prefix)

        refused = self.run_installer()

        self.assert_refusal(refused)
        self.assertIn("Ctrl+G F is owned by another command", refused.stderr)
        self.assertEqual(tree_snapshot(self.prefix), before)

    def test_invalid_legacy_manifest_file_sets_refuse_before_mutation(self) -> None:
        cases = (
            ("unsafe key", {"../escape": sha256(SOURCE_DIR / "foundry")}, "../escape"),
            ("unknown key", {"unmanaged.py": sha256(SOURCE_DIR / "foundry")}, "unmanaged.py"),
            ("non-string hash", {"foundry": 123}, "non-string hash"),
            ("empty subset", {}, "empty files"),
        )
        for label, files, expected_message in cases:
            with self.subTest(label=label):
                prefix = self.root / f"invalid legacy manifest {label}"
                target = self.install_legacy_snapshot(prefix)
                manifest_path = target / "installation-manifest.json"
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                manifest["files"] = files
                manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
                before = tree_snapshot(prefix)

                refused = self.run_installer(prefix=prefix)

                self.assert_refusal(refused)
                self.assertIn(expected_message, refused.stderr)
                self.assertEqual(tree_snapshot(prefix), before)
                self.assertFalse((target / "backups").exists())

    def test_reinstall_is_idempotent_and_preserves_private_customizations(self) -> None:
        target = self.install_initial("laptop")
        private_config = target / "herdr.toml"
        custom_text = textwrap.dedent(
            """

            [[keys.command]]
            key = "prefix+x"
            type = "pane"
            command = "echo private-customization"
            description = "Private customization"
            """
        )
        private_config.write_text(private_config.read_text(encoding="utf-8") + custom_text, encoding="utf-8")
        before = tree_snapshot(self.prefix)

        repeated = self.run_installer("--host-role", "laptop")
        self.assert_success(repeated)
        self.assertNotIn("Previous managed snapshot backed up", repeated.stdout)
        self.assertEqual(tree_snapshot(self.prefix), before)
        self.assertTrue((target / "herdr.toml").read_text(encoding="utf-8").endswith(custom_text))
        self.assertEqual(
            len([item for item in command_bindings(private_config) if item.get("key") == "prefix+f"]),
            1,
        )
        self.assertEqual(
            len([item for item in command_bindings(private_config) if item.get("key") == "prefix+x"]),
            1,
        )
        self.assertFalse((target / "backups").exists())

        checked = self.run_installer("--check", "--host-role", "laptop")
        self.assert_success(checked)

    def test_non_object_installation_manifest_refuses_without_mutation(self) -> None:
        target = self.install_initial()
        manifest = target / "installation-manifest.json"
        manifest.write_text("[]\n", encoding="utf-8")
        before = tree_snapshot(self.prefix)

        refused = self.run_installer()

        self.assert_refusal(refused)
        self.assertIn("unrecognized installation manifest", refused.stderr)
        self.assertEqual(tree_snapshot(self.prefix), before)

    def test_non_utf8_installation_manifest_refuses_without_mutation(self) -> None:
        target = self.install_initial()
        manifest = target / "installation-manifest.json"
        manifest.write_bytes(b"\xff")
        before = tree_snapshot(self.prefix)

        refused = self.run_installer()

        self.assert_refusal(refused)
        self.assertIn("unreadable installation manifest", refused.stderr)
        self.assertEqual(tree_snapshot(self.prefix), before)

    def test_non_table_herdr_keys_refuses_without_mutation(self) -> None:
        self.baseline.write_text('keys = "not-a-table"\n', encoding="utf-8")
        before = tree_snapshot(self.prefix)

        refused = self.run_installer()

        self.assert_refusal(refused)
        self.assertIn("invalid keys.command configuration", refused.stderr)
        self.assertEqual(tree_snapshot(self.prefix), before)

    def test_edited_managed_file_refuses_without_mutation(self) -> None:
        target = self.install_initial()
        edited = target / "monash-foundry"
        edited.chmod(0o600)
        edited.write_bytes(edited.read_bytes() + b"\n# disposable edit\n")
        before = tree_snapshot(self.prefix)
        baseline_before = self.baseline.read_bytes()

        refused = self.run_installer()
        self.assert_refusal(refused)
        self.assertIn("edited managed file", refused.stderr)
        self.assertEqual(tree_snapshot(self.prefix), before)
        self.assertEqual(self.baseline.read_bytes(), baseline_before)
        self.assertFalse((target / "backups").exists())

    def install_with_alias_drift(
        self,
        prefix: Path | None = None,
        aliases: dict[str, str] | None = None,
        edit_live: object = None,
        edit_bytes: object = None,
    ) -> Path:
        """An installed snapshot whose recorded config carries the old aliases and whose live config was edited."""
        selected = prefix or self.prefix
        result = self.run_installer("--host-role", "mini", prefix=selected)
        self.assert_success(result)
        target = self.target(selected)
        recorded = json.loads((SOURCE_DIR / "config.json").read_text(encoding="utf-8"))
        recorded["claude"].update(OLD_CLAUDE_ALIASES)
        (target / "config.json").write_bytes(canonical_config_bytes(recorded))
        os.chmod(target / "config.json", 0o600)
        manifest_path = target / "installation-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["files"]["config.json"] = sha256(target / "config.json")
        manifest["revision"] = hashlib.sha256(
            "".join(f"{name}:{manifest['files'][name]}\n" for name in EXPECTED_SOURCE_FILES).encode()
        ).hexdigest()
        manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        live = copy.deepcopy(recorded)
        live["claude"].update(NEW_CLAUDE_ALIASES if aliases is None else aliases)
        if edit_live is not None:
            edit_live(live)
        live_bytes = canonical_config_bytes(live)
        if edit_bytes is not None:
            live_bytes = edit_bytes(live_bytes)
        (target / "config.json").write_bytes(live_bytes)
        os.chmod(target / "config.json", 0o600)
        return target

    def link_state(self, prefix: Path | None = None) -> dict[str, object]:
        """Test-owned observation of each managed command link: absent, or its text and inode."""
        bin_dir = (prefix or self.prefix) / "bin"
        state: dict[str, object] = {}
        for name in EXPECTED_COMMANDS:
            link = bin_dir / name
            if not os.path.lexists(link):
                state[name] = None
            else:
                info = os.lstat(link)
                state[name] = (os.readlink(link), info.st_dev, info.st_ino)
        return state

    def run_with_failing_symlink(self, fail_on: int) -> subprocess.CompletedProcess[str]:
        harness = self.root / "failing-symlink.py"
        harness.write_text(FAILING_SYMLINK_HARNESS, encoding="utf-8")
        return self.run_installer("--host-role", "mini", wrapper=(str(harness), str(fail_on)))

    def managed_bytes(self, target: Path) -> dict[str, bytes]:
        names = (*EXPECTED_SOURCE_FILES, "installation-manifest.json", "herdr.toml")
        return {name: (target / name).read_bytes() for name in names}

    def test_source_config_carries_the_live_claude_aliases(self) -> None:
        source = json.loads((SOURCE_DIR / "config.json").read_text(encoding="utf-8"))
        self.assertEqual({key: source["claude"][key] for key in NEW_CLAUDE_ALIASES}, NEW_CLAUDE_ALIASES)

    def test_known_claude_alias_only_drift_migrates_with_a_private_backup(self) -> None:
        target = self.install_with_alias_drift()
        before = self.managed_bytes(target)
        links_before = {name: os.readlink(self.prefix / "bin" / name) for name in EXPECTED_COMMANDS}

        migrated = self.run_installer("--host-role", "mini")
        self.assert_success(migrated)
        self.assertIn("Known Claude alias drift migrated", migrated.stdout)
        self.assertIn("Previous managed snapshot backed up at ", migrated.stdout)

        source_config = (SOURCE_DIR / "config.json").read_bytes()
        self.assertEqual((target / "config.json").read_bytes(), source_config)
        self.assertEqual(json.loads(source_config)["claude"]["sonnet"], NEW_CLAUDE_ALIASES["sonnet"])
        for name, mode in EXPECTED_SOURCE_MODES.items():
            self.assertEqual((target / name).stat().st_mode & 0o777, mode, name)
        self.assert_success(self.run_installer("--check", "--host-role", "mini"))
        self.assertEqual(before["herdr.toml"], (target / "herdr.toml").read_bytes())
        self.assertEqual(links_before, {name: os.readlink(self.prefix / "bin" / name) for name in EXPECTED_COMMANDS})

        backups = sorted((target / "backups").iterdir())
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].stat().st_mode & 0o777, 0o700, "the backup directory must be private")
        self.assertEqual((backups[0] / "config.json").read_bytes(), before["config.json"],
                         "the edited live config must be preserved byte for byte")
        self.assertEqual((backups[0] / "installation-manifest.json").read_bytes(),
                         before["installation-manifest.json"])
        self.assertEqual((backups[0] / "config.json").stat().st_mode & 0o777, 0o600)

    def test_alias_drift_dry_run_reports_the_migration_and_changes_nothing(self) -> None:
        target = self.install_with_alias_drift()
        before = tree_snapshot(self.prefix)
        planned = self.run_installer("--dry-run", "--host-role", "mini")
        self.assert_success(planned)
        self.assertIn("migrate known Claude alias drift in config.json", planned.stdout)
        self.assertEqual(tree_snapshot(self.prefix), before)
        self.assertFalse((target / "backups").exists())

    def test_check_still_fails_on_known_alias_drift(self) -> None:
        target = self.install_with_alias_drift()
        before = tree_snapshot(self.prefix)
        checked = self.run_installer("--check", "--host-role", "mini")
        self.assert_check_failure(checked)
        self.assertIn("edited managed file", checked.stderr)
        self.assertEqual(tree_snapshot(self.prefix), before)

    def test_any_other_drift_still_refuses_without_mutation(self) -> None:
        def change(key: str, value: object):
            def edit(live: dict) -> None:
                live[key] = value
            return edit

        def rename_model(live: dict) -> None:
            live["inventory"]["models"][0]["display_name"] = "Edited display name"

        cases = {
            "tenant changed beside the aliases": dict(edit_live=change("tenant", "another-tenant")),
            "inventory changed beside the aliases": dict(edit_live=rename_model),
            "unknown key added beside the aliases": dict(edit_live=change("note", "x")),
            "alias at an unknown value": dict(aliases={**NEW_CLAUDE_ALIASES, "sonnet": "claude-sonnet-9"}),
            "only two of three aliases moved": dict(aliases={**NEW_CLAUDE_ALIASES, "haiku": OLD_CLAUDE_ALIASES["haiku"]}),
            "aliases swapped between keys": dict(aliases={**NEW_CLAUDE_ALIASES, "haiku": "claude-sonnet-5-5"}),
        }
        for index, (label, options) in enumerate(cases.items()):
            with self.subTest(label):
                prefix = self.root / f"refusal case {index}"
                target = self.install_with_alias_drift(prefix, **options)
                before = tree_snapshot(prefix)
                refused = self.run_installer("--host-role", "mini", prefix=prefix)
                self.assert_refusal(refused)
                self.assertIn("edited managed file", refused.stderr)
                self.assertEqual(tree_snapshot(prefix), before)
                self.assertFalse((target / "backups").exists())

    def test_known_alias_drift_requires_the_exact_canonical_bytes(self) -> None:
        def duplicate_line(needle: str):
            def edit(raw: bytes) -> bytes:
                lines = raw.decode("utf-8").split("\n")
                at = next(index for index, line in enumerate(lines) if needle in line)
                lines.insert(at + 1, lines[at])
                return "\n".join(lines).encode("utf-8")
            return edit

        def reformatted(**options):
            return lambda raw: json.dumps(json.loads(raw), ensure_ascii=False, **options).encode("utf-8")

        def reorder_top_level(raw: bytes) -> bytes:
            data = json.loads(raw)
            reordered = {"subscription": data["subscription"], "tenant": data["tenant"]}
            reordered.update({key: value for key, value in data.items() if key not in reordered})
            return canonical_config_bytes(reordered)

        cases = {
            "duplicate top-level key": duplicate_line('"tenant"'),
            "duplicate alias key": duplicate_line('"haiku"'),
            "compact separators": reformatted(separators=(",", ":")),
            "four-space indent": reformatted(indent=4),
            "tab indent": reformatted(indent="\t"),
            "no trailing newline": lambda raw: raw.rstrip(b"\n"),
            "extra blank line": lambda raw: raw + b"\n",
            "trailing space": lambda raw: raw.rstrip(b"\n") + b" \n",
            "CRLF line endings": lambda raw: raw.replace(b"\n", b"\r\n"),
            "UTF-8 byte order mark": lambda raw: b"\xef\xbb\xbf" + raw,
            "top-level keys reordered": reorder_top_level,
        }
        for index, (label, edit_bytes) in enumerate(cases.items()):
            with self.subTest(label):
                prefix = self.root / f"byte case {index}"
                target = self.install_with_alias_drift(prefix, edit_bytes=edit_bytes)
                before = tree_snapshot(prefix)
                refused = self.run_installer("--host-role", "mini", prefix=prefix)
                self.assert_refusal(refused)
                self.assertIn("edited managed file", refused.stderr)
                self.assertEqual(tree_snapshot(prefix), before)
                self.assertFalse((target / "backups").exists())

    def owned_state(self, target: Path, prefix: Path) -> dict[str, object]:
        """Test-owned observation of the whole managed state, absent files included."""
        names = (*EXPECTED_SOURCE_FILES, "installation-manifest.json", "herdr.toml")
        files = {name: ((target / name).read_bytes(), (target / name).stat().st_mode & 0o777)
                 if (target / name).exists() else None for name in names}
        return {"files": files, "links": self.link_state(prefix)}

    def test_alias_migration_recreates_an_absent_private_herdr_config_when_nothing_fails(self) -> None:
        target = self.install_with_alias_drift()
        (target / "herdr.toml").unlink()
        migrated = self.run_installer("--host-role", "mini")
        self.assert_success(migrated)
        self.assert_managed_binding(target / "herdr.toml", target)
        self.assert_success(self.run_installer("--check", "--host-role", "mini"))

    def test_failed_migration_removes_a_private_herdr_config_it_created(self) -> None:
        target = self.install_with_alias_drift()
        (target / "herdr.toml").unlink()
        (self.prefix / "bin" / "monash").unlink()
        before = self.owned_state(target, self.prefix)
        self.assertIsNone(before["files"]["herdr.toml"])

        failed = self.run_with_failing_symlink(1)
        self.assert_refusal(failed)
        self.assertIn("restored from", failed.stderr)
        self.assertIn("verified", failed.stderr)
        self.assertFalse((target / "herdr.toml").exists(), "a Herdr config created by this run must not survive")
        self.assertEqual(self.owned_state(target, self.prefix), before)

    def test_verification_read_failure_is_a_bounded_refusal_with_the_backup_address(self) -> None:
        cases = {"config": "the installed config.json hash read", "link": "the command link identity read"}
        for index, (read_target, label) in enumerate(cases.items()):
            with self.subTest(label):
                prefix = self.root / f"verification fault {index}"
                target = self.install_with_alias_drift(prefix)
                (prefix / "bin" / "monash").unlink()
                before = self.owned_state(target, prefix)

                harness = self.root / f"failing-recovery-{index}.py"
                harness.write_text(FAILING_RECOVERY_HARNESS, encoding="utf-8")
                failed = self.run_installer(
                    "--host-role", "mini", prefix=prefix, wrapper=(str(harness), read_target))
                self.assert_refusal(failed)
                self.assertNotIn("Traceback", failed.stderr)
                self.assertIn("injected symlink failure", failed.stderr)
                self.assertIn("injected verification read failure", failed.stderr)
                self.assertIn("could not be verified", failed.stderr)
                self.assertIn("could not check", failed.stderr, "the failed read is classified, not a blanket stop")
                self.assertNotIn("was restored from", failed.stderr, "no verified-restoration claim")
                backups = list((target / "backups").iterdir())
                self.assertEqual(len(backups), 1)
                self.assertIn(str(backups[0]), failed.stderr, "the backup to restore from must be named")
                self.assertIn("by hand", failed.stderr)
                # The restoration itself did happen; only its verification could not.
                self.assertEqual(self.owned_state(target, prefix), before)

    def test_absence_check_read_failure_is_unverified_not_verified_absence(self) -> None:
        target = self.install_with_alias_drift()
        (target / "herdr.toml").unlink()
        (self.prefix / "bin" / "monash").unlink()
        before = self.owned_state(target, self.prefix)

        harness = self.root / "failing-recovery-herdr.py"
        harness.write_text(FAILING_RECOVERY_HARNESS, encoding="utf-8")
        failed = self.run_installer("--host-role", "mini", wrapper=(str(harness), "herdr"))
        self.assert_refusal(failed)
        self.assertNotIn("Traceback", failed.stderr)
        self.assertIn("injected symlink failure", failed.stderr)
        self.assertIn("injected verification read failure", failed.stderr)
        self.assertIn("could not be verified", failed.stderr)
        self.assertIn("could not check herdr.toml", failed.stderr)
        self.assertNotIn("was restored from", failed.stderr, "an unreadable absence check is not verified absence")
        backups = list((target / "backups").iterdir())
        self.assertEqual(len(backups), 1)
        self.assertIn(str(backups[0]), failed.stderr)
        self.assertIn("by hand", failed.stderr)
        self.assertEqual(self.owned_state(target, self.prefix), before)

    def test_alias_drift_beside_another_edited_managed_file_still_refuses(self) -> None:
        target = self.install_with_alias_drift()
        edited = target / "monash_hosts.py"
        edited.write_bytes(edited.read_bytes() + b"\n# disposable edit\n")
        before = tree_snapshot(self.prefix)
        refused = self.run_installer("--host-role", "mini")
        self.assert_refusal(refused)
        self.assertIn("edited managed file", refused.stderr)
        self.assertIn("monash_hosts.py", refused.stderr)
        self.assertEqual(tree_snapshot(self.prefix), before)

    def test_alias_drift_is_not_migrated_by_a_source_that_would_revert_the_aliases(self) -> None:
        target = self.install_with_alias_drift()
        stale = self.root / "stale alias source"
        stale.mkdir()
        for name in (*EXPECTED_SOURCE_FILES, "install.py"):
            shutil.copy2(SOURCE_DIR / name, stale / name)
        stale_config = json.loads((stale / "config.json").read_text(encoding="utf-8"))
        stale_config["claude"].update(OLD_CLAUDE_ALIASES)
        (stale / "config.json").write_bytes(canonical_config_bytes(stale_config))
        before = tree_snapshot(self.prefix)
        refused = self.run_installer("--host-role", "mini", installer=stale / "install.py")
        self.assert_refusal(refused)
        self.assertIn("would revert the live Claude aliases", refused.stderr)
        self.assertEqual(tree_snapshot(self.prefix), before)
        self.assertFalse((target / "backups").exists())

    def test_alias_migration_leaves_verified_command_links_untouched(self) -> None:
        target = self.install_with_alias_drift()
        links_before = self.link_state()
        self.assertTrue(all(links_before.values()))
        bin_dir = self.prefix / "bin"
        bin_dir.chmod(0o500)  # a verified link never needs to be written
        self.addCleanup(bin_dir.chmod, 0o700)
        migrated = self.run_installer("--host-role", "mini")
        bin_dir.chmod(0o700)
        self.assert_success(migrated)
        self.assertEqual(self.link_state(), links_before, "an existing link must keep its identity")
        self.assertEqual((target / "config.json").read_bytes(), (SOURCE_DIR / "config.json").read_bytes())

    def test_symlink_fault_cannot_remove_a_verified_command_link(self) -> None:
        # The reviewed defect: the old installer unlinked a verified link and
        # then failed to create its replacement, leaving the command missing.
        target = self.install_with_alias_drift()
        links_before = self.link_state()
        failed_write = self.run_with_failing_symlink(1)
        self.assert_success(failed_write)
        self.assertEqual(self.link_state(), links_before)
        self.assert_success(self.run_installer("--check", "--host-role", "mini"))
        self.assertEqual((target / "config.json").read_bytes(), (SOURCE_DIR / "config.json").read_bytes())

    def test_failed_link_creation_restores_files_and_leaves_links_as_they_were(self) -> None:
        cases = {
            "one link missing, first write fails": ((EXPECTED_COMMANDS[2],), 1),
            "all links missing, third write fails after two were created": (EXPECTED_COMMANDS, 3),
        }
        for index, (label, (missing, fail_on)) in enumerate(cases.items()):
            with self.subTest(label):
                prefix = self.root / f"link fault {index}"
                target = self.install_with_alias_drift(prefix)
                for name in missing:
                    (prefix / "bin" / name).unlink()
                files_before = self.managed_bytes(target)
                modes_before = {name: (target / name).stat().st_mode & 0o777 for name in files_before}
                links_before = self.link_state(prefix)

                harness = self.root / f"failing-symlink-{index}.py"
                harness.write_text(FAILING_SYMLINK_HARNESS, encoding="utf-8")
                failed = self.run_installer(
                    "--host-role", "mini", prefix=prefix, wrapper=(str(harness), str(fail_on)))
                self.assert_refusal(failed)
                self.assertIn("injected symlink failure", failed.stderr)
                self.assertIn("restored from", failed.stderr)
                self.assertIn("verified", failed.stderr)
                self.assertEqual(self.managed_bytes(target), files_before)
                self.assertEqual({name: (target / name).stat().st_mode & 0o777 for name in files_before}, modes_before)
                self.assertEqual(self.link_state(prefix), links_before,
                                 "every link must be exactly as before: present links untouched, new links removed")
                self.assertEqual(len(list((target / "backups").iterdir())), 1)

    def test_edited_installed_remote_helper_refuses_reinstall_and_check(self) -> None:
        target = self.install_initial()
        edited = target / "monash_remote.py"
        edited.chmod(0o600)
        edited.write_bytes(edited.read_bytes() + b"\n# disposable edit\n")
        before = tree_snapshot(self.prefix)

        refused = self.run_installer()
        self.assert_refusal(refused)
        self.assertIn("edited managed file", refused.stderr)
        self.assertEqual(tree_snapshot(self.prefix), before)

        failed_check = self.run_installer("--check")
        self.assert_check_failure(failed_check)
        self.assertIn("edited managed file", failed_check.stderr)

    def test_unrelated_bin_link_refuses_before_mutation(self) -> None:
        bin_dir = self.prefix / "bin"
        bin_dir.mkdir(parents=True)
        unrelated = self.root / "unrelated command with spaces"
        unrelated.write_text("unrelated", encoding="utf-8")
        link = bin_dir / "foundry"
        link.symlink_to(unrelated)
        before = tree_snapshot(self.prefix)
        baseline_before = self.baseline.read_bytes()

        refused = self.run_installer()
        self.assert_refusal(refused)
        self.assertIn("unrelated existing target", refused.stderr)
        self.assertEqual(tree_snapshot(self.prefix), before)
        self.assertEqual(self.baseline.read_bytes(), baseline_before)
        self.assertFalse(self.target().exists())
        self.assert_same_path(link, unrelated)

    def test_symlinked_destination_parent_refuses_before_mutation(self) -> None:
        self.prefix.mkdir(parents=True)
        outside = self.root / "outside destination"
        outside.mkdir()
        share = self.prefix / "share"
        share.symlink_to(outside, target_is_directory=True)
        before = tree_snapshot(self.prefix)
        baseline_before = self.baseline.read_bytes()

        refused = self.run_installer()
        self.assert_refusal(refused)
        self.assertIn("symlinked destination parent", refused.stderr)
        self.assertEqual(tree_snapshot(self.prefix), before)
        self.assertEqual(self.baseline.read_bytes(), baseline_before)
        self.assertFalse((outside / "monash-foundry").exists())

    def test_baseline_prefix_f_conflict_refuses_before_mutation(self) -> None:
        conflict = textwrap.dedent(
            """

            [[keys.command]]
            key = "prefix+f"
            type = "pane"
            command = "echo foreign-prefix-f"
            description = "Foreign prefix F"
            """
        )
        self.baseline.write_text(BASELINE_TEXT + conflict, encoding="utf-8")
        before = tree_snapshot(self.prefix)
        baseline_before = self.baseline.read_bytes()

        refused = self.run_installer()
        self.assert_refusal(refused)
        self.assertIn("Ctrl+G F already exists in Herdr baseline", refused.stderr)
        self.assertEqual(tree_snapshot(self.prefix), before)
        self.assertEqual(self.baseline.read_bytes(), baseline_before)

    def test_check_reports_missing_link_and_missing_binding(self) -> None:
        target = self.install_initial()
        missing_link = self.prefix / "bin" / "monash-foundry"
        missing_link.unlink()
        before_link_check = tree_snapshot(self.prefix)

        missing_link_result = self.run_installer("--check")
        self.assert_check_failure(missing_link_result)
        self.assertIn("missing managed command link", missing_link_result.stderr)
        self.assertEqual(tree_snapshot(self.prefix), before_link_check)

        missing_link.symlink_to(target / "monash-foundry")
        private_config = target / "herdr.toml"
        private_config.write_text(BASELINE_TEXT, encoding="utf-8")
        before_binding_check = tree_snapshot(self.prefix)

        missing_binding_result = self.run_installer("--check")
        self.assert_check_failure(missing_binding_result)
        self.assertIn("lacks exactly one owned Ctrl+G F binding", missing_binding_result.stderr)
        self.assertEqual(tree_snapshot(self.prefix), before_binding_check)

    def test_incomplete_disposable_source_snapshot_refuses_before_mutation(self) -> None:
        source_snapshot = self.root / "source snapshot with spaces"
        source_snapshot.mkdir()
        for name in EXPECTED_SOURCE_FILES:
            shutil.copy2(SOURCE_DIR / name, source_snapshot / name)
        shutil.copy2(INSTALLER, source_snapshot / "install.py")
        (source_snapshot / "config.json").unlink()
        isolated_prefix = self.root / "incomplete prefix with spaces"
        before = tree_snapshot(isolated_prefix)
        baseline_before = self.baseline.read_bytes()

        refused = self.run_installer(
            installer=source_snapshot / "install.py",
            prefix=isolated_prefix,
        )
        self.assert_refusal(refused)
        self.assertIn("missing source", refused.stderr)
        self.assertEqual(tree_snapshot(isolated_prefix), before)
        self.assertEqual(self.baseline.read_bytes(), baseline_before)

    def test_missing_remote_helper_source_refuses_before_mutation(self) -> None:
        source_snapshot = self.root / "missing remote helper source snapshot"
        source_snapshot.mkdir()
        for name in EXPECTED_SOURCE_FILES:
            shutil.copy2(SOURCE_DIR / name, source_snapshot / name)
        shutil.copy2(INSTALLER, source_snapshot / "install.py")
        (source_snapshot / "monash_remote.py").unlink()
        isolated_prefix = self.root / "missing remote helper prefix"
        before = tree_snapshot(isolated_prefix)
        baseline_before = self.baseline.read_bytes()

        refused = self.run_installer(
            installer=source_snapshot / "install.py",
            prefix=isolated_prefix,
        )

        self.assert_refusal(refused)
        self.assertIn("missing source", refused.stderr)
        self.assertIn("monash_remote.py", refused.stderr)
        self.assertEqual(tree_snapshot(isolated_prefix), before)
        self.assertEqual(self.baseline.read_bytes(), baseline_before)

    def test_symlinked_remote_helper_source_refuses_before_mutation(self) -> None:
        source_snapshot = self.root / "symlinked remote helper source snapshot"
        source_snapshot.mkdir()
        for name in EXPECTED_SOURCE_FILES:
            shutil.copy2(SOURCE_DIR / name, source_snapshot / name)
        shutil.copy2(INSTALLER, source_snapshot / "install.py")
        helper = source_snapshot / "monash_remote.py"
        helper.unlink()
        helper_target = self.root / "remote helper fixture target"
        helper_target.write_bytes(b"test-owned helper fixture\n")
        helper.symlink_to(helper_target)
        isolated_prefix = self.root / "symlinked remote helper prefix"
        before = tree_snapshot(isolated_prefix)
        baseline_before = self.baseline.read_bytes()

        refused = self.run_installer(
            installer=source_snapshot / "install.py",
            prefix=isolated_prefix,
        )

        self.assert_refusal(refused)
        self.assertIn("refusing symlinked source", refused.stderr)
        self.assertIn("monash_remote.py", refused.stderr)
        self.assertEqual(tree_snapshot(isolated_prefix), before)
        self.assertEqual(self.baseline.read_bytes(), baseline_before)


if __name__ == "__main__":
    unittest.main()
