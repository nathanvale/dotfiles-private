"""Public dispatcher checks, with process-boundary observations and no SSH."""
import json
import os
from pathlib import Path
import pty
import shutil
import subprocess
import sys
import tempfile
import unittest


class DispatcherProcessTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="foundry dispatcher ")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.capture = self.root / "observed.json"
        self.entry = self.root / "foundry"
        shutil.copyfile(Path(__file__).with_name("foundry"), self.entry)
        shutil.copyfile(Path(__file__).with_name("monash_hosts.py"), self.root / "monash_hosts.py")
        self.config = self.root / "herdr.toml"
        self.config.write_text('theme = "terminal"\n')
        self.config_json = self.root / "config.json"
        self.write_config(
            {
                "laptop": {"transport": "local"},
                "mini": {
                    "transport": "ssh",
                    "ssh_alias": "mac-mini",
                    "herdr_session": "monash-foundry",
                    "remote_install_root": "/Users/server/.local/share/monash-foundry",
                    "herdr_executable": "/opt/homebrew/bin/herdr",
                    "path_mappings": [],
                },
            }
        )
        for name in ("ssh", "herdr", "monash"):
            executable = self.root / name
            executable.write_text(f'''#!{sys.executable}
import json, os, sys
from pathlib import Path
Path({str(self.capture)!r}).write_text(json.dumps({{
    "executable": Path(sys.argv[0]).name, "argv": sys.argv[1:],
    "config": os.environ.get("HERDR_CONFIG_PATH"), "cwd": os.getcwd()
}}))
''')
            executable.chmod(0o700)
        self.env = dict(os.environ, PATH=str(self.root) + os.pathsep + os.environ["PATH"])
        self.env.pop("HERDR_ENV", None)
        self.env.pop("HERDR_CONFIG_PATH", None)

    def write_config(self, host_profiles):
        self.config_json.write_text(json.dumps({"host_profiles": host_profiles}))

    def run_entry(self, *args):
        return subprocess.run([sys.executable, str(self.entry), "--config", str(self.config_json), *args],
                              env=self.env, cwd=self.root, input="", capture_output=True, text=True, timeout=5)

    def run_entry_in_tty(self, *args):
        master, slave = pty.openpty()
        try:
            process = subprocess.Popen(
                [sys.executable, str(self.entry), "--config", str(self.config_json), *args],
                env=self.env,
                cwd=self.root,
                stdin=slave,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        finally:
            os.close(slave)
        try:
            os.write(master, b"\n")
            stdout, stderr = process.communicate(timeout=5)
        finally:
            os.close(master)
        return subprocess.CompletedProcess(
            process.args,
            process.returncode,
            stdout.decode(errors="replace"),
            stderr.decode(errors="replace"),
        )

    def observed(self):
        return json.loads(self.capture.read_text())

    def test_local_profile_attaches_adjacent_private_session(self):
        result = self.run_entry("--host", "laptop")
        self.assertEqual(result.returncode, 0, result.stderr)
        child = self.observed()
        self.assertEqual(child["executable"], "herdr")
        self.assertEqual(child["argv"], ["--session", "monash-foundry"])
        self.assertEqual(child["config"], str(self.config))
        self.assertTrue(Path(child["cwd"]).samefile(self.root))

    def test_ssh_profile_selects_exact_literal_argv(self):
        result = self.run_entry("--host", "mini")
        self.assertEqual(result.returncode, 0, result.stderr)
        child = self.observed()
        self.assertEqual(child["executable"], "ssh")
        self.assertEqual(child["argv"], ["-tt", "mac-mini",
            "env HERDR_CONFIG_PATH=/Users/server/.local/share/monash-foundry/herdr.toml "
            "/opt/homebrew/bin/herdr --session monash-foundry"])

    def test_unknown_profile_refuses_without_launching(self):
        result = self.run_entry("--host", "does-not-exist")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.capture.exists())

    def test_invalid_host_profiles_configuration_refuses_without_launching(self):
        self.config_json.write_text(json.dumps({"host_profiles": {"laptop": {"transport": "carrier-pigeon"}}}))
        result = self.run_entry("--host", "laptop")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.capture.exists())

    def test_no_host_outside_herdr_refuses_without_a_mini_fallback(self):
        result = self.run_entry()
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.capture.exists())
        self.assertIn("no host profile is assumed", result.stderr)

    def test_inside_herdr_with_no_host_delegates_to_monash_launch(self):
        self.env["HERDR_ENV"] = "1"
        result = self.run_entry()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.observed()["executable"], "monash")
        self.assertEqual(self.observed()["argv"], ["--config", str(self.config_json), "launch"])

    def test_explicit_menu_delegates_to_monash_launch(self):
        result = self.run_entry("--menu")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.observed()["executable"], "monash")
        self.assertEqual(self.observed()["argv"], ["--config", str(self.config_json), "launch"])

    def test_menu_delegation_passes_exact_config_path_containing_spaces(self):
        spaced_dir = self.root / "cfg dir with spaces"
        spaced_dir.mkdir()
        spaced_config = spaced_dir / "my config.json"
        spaced_config.write_text(self.config_json.read_text())
        result = subprocess.run(
            [sys.executable, str(self.entry), "--config", str(spaced_config), "--menu"],
            env=self.env, cwd=self.root, input="", capture_output=True, text=True, timeout=5,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        child = self.observed()
        self.assertEqual(child["executable"], "monash")
        self.assertEqual(child["argv"], ["--config", str(spaced_config), "launch"])

    def test_local_alias_selects_laptop_profile(self):
        result = self.run_entry("--local")
        self.assertEqual(result.returncode, 0, result.stderr)
        child = self.observed()
        self.assertEqual(child["executable"], "herdr")
        self.assertEqual(child["argv"], ["--session", "monash-foundry"])
        self.assertEqual(child["config"], str(self.config))

    def test_mini_alias_selects_mini_profile(self):
        result = self.run_entry("--mini")
        self.assertEqual(result.returncode, 0, result.stderr)
        child = self.observed()
        self.assertEqual(child["executable"], "ssh")
        self.assertEqual(child["argv"], ["-tt", "mac-mini",
            "env HERDR_CONFIG_PATH=/Users/server/.local/share/monash-foundry/herdr.toml "
            "/opt/homebrew/bin/herdr --session monash-foundry"])

    def test_local_alias_refuses_when_laptop_profile_absent(self):
        self.write_config({"mini": {
            "transport": "ssh", "ssh_alias": "mac-mini", "herdr_session": "monash-foundry",
            "remote_install_root": "/Users/server/.local/share/monash-foundry",
            "herdr_executable": "/opt/homebrew/bin/herdr", "path_mappings": [],
        }})
        result = self.run_entry("--local")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.capture.exists())

    def test_mini_alias_refuses_when_mini_profile_absent(self):
        self.write_config({"laptop": {"transport": "local"}})
        result = self.run_entry("--mini")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.capture.exists())

    def test_host_and_local_alias_are_mutually_exclusive(self):
        result = self.run_entry("--host", "laptop", "--local")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.capture.exists())

    def test_menu_and_mini_alias_are_mutually_exclusive(self):
        result = self.run_entry("--menu", "--mini")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.capture.exists())

    def test_local_alias_still_refuses_nested_local_session_inside_herdr(self):
        self.env["HERDR_ENV"] = "1"
        result = self.run_entry("--local")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.capture.exists())

    def test_inside_herdr_refuses_nested_local_session(self):
        self.env["HERDR_ENV"] = "1"
        result = self.run_entry("--host", "laptop")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.capture.exists())

    def test_inside_herdr_allows_explicit_ssh_profile(self):
        self.env["HERDR_ENV"] = "1"
        result = self.run_entry("--host", "mini")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.observed()["executable"], "ssh")

    def test_missing_local_config_does_not_fall_back(self):
        self.config.unlink()
        result = self.run_entry("--host", "laptop")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.capture.exists())

    def test_missing_local_config_pauses_before_a_transient_tty_closes(self):
        self.config.unlink()
        result = self.run_entry_in_tty("--host", "laptop")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("Press Enter to close this pane.", result.stdout)
        self.assertFalse(self.capture.exists())

    def test_unknown_profile_pauses_before_a_transient_tty_closes(self):
        result = self.run_entry_in_tty("--host", "does-not-exist")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("Press Enter to close this pane.", result.stdout)
        self.assertFalse(self.capture.exists())

    def test_missing_monash_coordinator_refuses_before_menu(self):
        # The coordinator lookup is a fixed relative path with no absolute
        # fallback, so this cannot fall through to any real binary.
        (self.root / "monash").unlink()
        result = self.run_entry("--menu")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.capture.exists())

    def test_help_never_launches(self):
        self.assertEqual(self.run_entry("--help").returncode, 0)
        self.assertFalse(self.capture.exists())


if __name__ == "__main__":
    unittest.main()
