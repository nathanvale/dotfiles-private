"""Public-process tests for the Codex desktop provider candidate.

monash-codex-token and monash-codex-desktop run as real processes from a
synthetic installed layout (the launcher, both tools, a synthetic config.json
and a fake 1Password wrapper). Nothing reads or writes the real ~/.codex,
auth.json, 1Password or Azure.

The engine class drives the bundled Codex app-server, the desktop app's own
engine, against loopback fakes. It is skipped when that engine is absent.
Run: python3.11 -B -m unittest discover -s scripts/foundry -p 'test_codex_desktop.py' -v
"""

from __future__ import annotations

import http.server
import json
import os
import pty
import queue
import select
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
import types
import unittest
from pathlib import Path


SOURCE_DIR = Path(__file__).resolve().parent
ENGINE = Path(
    os.environ.get(
        "MONASH_TEST_CODEX_ENGINE",
        "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    )
)
SYSTEM_PYTHON = Path("/usr/bin/python3")

# Independent oracles: synthetic values and the exact managed text, written
# out here rather than derived from the tool under test.
TOKEN = "synthetic-token-0123456789"
DECOY = "decoy-personal-secret-zz"
CREDENTIAL_REF = "op://Synthetic Vault/synthetic-item/credential"
BASE_URL = "https://synthetic-resource.openai.azure.com/openai/v1"
BEGIN = "# >>> monash-foundry codex-desktop provider v1: managed by monash-codex-desktop; remove with its rollback >>>"
END = "# <<< monash-foundry codex-desktop provider v1 <<<"
DEFAULT_BLOCK = (
    "# >>> monash-foundry codex-desktop default v1: managed by monash-codex-desktop; remove with its rollback >>>\n"
    'model_provider = "monash_foundry"\n'
    "# <<< monash-foundry codex-desktop default v1 <<<\n"
)
PERSONAL_CONFIG = (
    "# personal Codex config (synthetic)\n"
    'model = "gpt-6.1-sol"\n'
    'model_reasoning_effort = "high"\n'
    "\n"
    "[mcp_servers.synthetic]\n"
    'command = "synthetic-mcp"\n'
    'env = { SYNTHETIC_PERSONAL_SECRET = "do-not-print-me" }\n'
    "\n"
    '[projects."/synthetic/project"]\n'
    'trust_level = "trusted"\n'
)

FAKE_WRAPPER = """#!/bin/sh
printf '%s\\n' "$@" > "$0.argv"
/usr/bin/env | /usr/bin/cut -d= -f1 | /usr/bin/sort > "$0.envnames"
echo run >> "$0.count"
mode=$(/bin/cat "$0.mode" 2>/dev/null || echo ok)
case "$mode" in
  fail) exit 7 ;;
  empty) exit 0 ;;
  spaces) printf 'two words\\n'; exit 0 ;;
esac
[ "$1" = inject ] && [ "$4" = -- ] || exit 64
key=$2
shift 4
exec /usr/bin/env "$key=@TOKEN@" "$@"
""".replace("@TOKEN@", TOKEN)


def managed_block(helper: Path, base_url: str = BASE_URL) -> str:
    return (
        f"{BEGIN}\n"
        "[model_providers.monash_foundry]\n"
        'name = "Monash Foundry Azure Responses"\n'
        f'base_url = "{base_url}"\n'
        'wire_api = "responses"\n'
        "requires_openai_auth = false\n"
        "\n"
        "[model_providers.monash_foundry.auth]\n"
        f'command = "{helper}"\n'
        "args = []\n"
        "timeout_ms = 30000\n"
        "refresh_interval_ms = 300000\n"
        f"{END}\n"
    )


class InstalledLayout:
    """A private copy of the installed snapshot pieces these tools load."""

    def __init__(self, root: Path):
        self.dir = root.resolve() / "share" / "monash-foundry"
        self.dir.mkdir(parents=True)
        for name in ("monash-foundry", "monash-codex-token", "monash-codex-desktop"):
            shutil.copy2(SOURCE_DIR / name, self.dir / name)
            os.chmod(self.dir / name, 0o500)
        self.wrapper = root.resolve() / "fake-with-one-password-token"
        self.wrapper.write_text(FAKE_WRAPPER)
        os.chmod(self.wrapper, 0o700)
        config = json.loads((SOURCE_DIR / "config.json").read_text())
        config["codex"]["base_url"] = BASE_URL
        config["codex"]["credential_ref"] = CREDENTIAL_REF
        config.setdefault("commands", {})["with_one_password_token"] = str(self.wrapper)
        (self.dir / "config.json").write_text(json.dumps(config, indent=2) + "\n")
        os.chmod(self.dir / "config.json", 0o600)
        self.helper = self.dir / "monash-codex-token"
        self.desktop = self.dir / "monash-codex-desktop"

    def plant_launcher_marker(self) -> Path:
        """Make the launcher record any execution of its code, to prove refusal happens first."""
        marker = self.dir.parent / "launcher-code-ran"
        launcher = self.dir / "monash-foundry"
        os.chmod(launcher, 0o700)
        source = launcher.read_text()
        launcher.write_text(source.replace(
            "import monash_projects as projects\n" if "import monash_projects" in source else "\nimport fcntl\n",
            f"\nimport fcntl\nopen({str(marker)!r}, 'w').close()\n", 1,
        ))
        os.chmod(launcher, 0o500)
        return marker

    def set_wrapper(self, value: str) -> None:
        path = self.dir / "config.json"
        os.chmod(path, 0o600)
        config = json.loads(path.read_text())
        config["commands"]["with_one_password_token"] = value
        path.write_text(json.dumps(config, indent=2) + "\n")

    def wrapper_mode(self, mode: str) -> None:
        Path(f"{self.wrapper}.mode").write_text(mode)

    def wrapper_runs(self) -> int:
        count = Path(f"{self.wrapper}.count")
        return len(count.read_text().splitlines()) if count.exists() else 0


class fake_codex_writer:
    """A real process named codex whose CODEX_HOME is `home`, as the app's engine would be."""

    def __init__(self, root: Path, home: Path):
        self.binary = root / "fake-codex-bin" / "codex"
        self.home = home

    def __enter__(self):
        self.binary.parent.mkdir(exist_ok=True)
        if not self.binary.is_symlink():
            self.binary.symlink_to(sys.executable)  # ps reports the codex path that was executed
        environment = {**os.environ, "CODEX_HOME": str(self.home)}
        self.process = subprocess.Popen([str(self.binary), "-c", "import time; time.sleep(120)"], env=environment)
        time.sleep(0.3)
        return self

    def __exit__(self, *exc):
        self.process.kill()
        self.process.wait(10)


def run_desktop(layout: InstalledLayout, home: Path, command: str, *flags: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-B", str(layout.desktop), "--codex-home", str(home), command, *flags],
        capture_output=True, text=True, timeout=30, check=False,
    )


class TokenHelperTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.layout = InstalledLayout(Path(self.temp.name))

    def tearDown(self):
        self.temp.cleanup()

    def run_helper(self, python: str = sys.executable, args=(), env_extra=None):
        env = {"HOME": os.environ["HOME"], "PATH": "/usr/bin:/bin", "OPENAI_API_KEY": DECOY,
               "AZURE_OPENAI_API_KEY": DECOY, "CODEX_HOME": "/synthetic/codex-home"}
        env.update(env_extra or {})
        return subprocess.run([python, "-B", str(self.layout.helper), *args], stdin=subprocess.DEVNULL,
                              capture_output=True, env=env, timeout=30, check=False)

    def test_prints_only_the_resolved_token_through_the_exact_wrapper_call(self):
        # Wrong behavior caught: a different reference, extra output, or a caller key reaching the wrapper.
        result = self.run_helper()
        self.assertEqual((result.returncode, result.stdout), (0, (TOKEN + "\n").encode()))
        argv = Path(f"{self.layout.wrapper}.argv").read_text().splitlines()
        self.assertEqual(argv, ["inject", "AZURE_OPENAI_API_KEY", CREDENTIAL_REF, "--",
                                "/usr/bin/printenv", "AZURE_OPENAI_API_KEY"])
        names = set(Path(f"{self.layout.wrapper}.envnames").read_text().split())
        self.assertTrue({"OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "CODEX_HOME"}.isdisjoint(names), names)
        self.assertNotIn(TOKEN.encode(), result.stderr)

    @unittest.skipUnless(SYSTEM_PYTHON.is_file(), "macOS system Python 3.9 is absent")
    def test_runs_under_the_macos_system_python(self):
        # A GUI-launched Codex may resolve /usr/bin/python3 (3.9) first on PATH.
        result = self.run_helper(python=str(SYSTEM_PYTHON))
        self.assertEqual((result.returncode, result.stdout), (0, (TOKEN + "\n").encode()), result.stderr)

    def test_every_wrapper_failure_prints_nothing_and_exits_non_zero(self):
        for mode in ("fail", "empty", "spaces"):
            with self.subTest(mode=mode):
                self.layout.wrapper_mode(mode)
                result = self.run_helper()
                self.assertEqual((result.returncode, result.stdout), (3, b""))
                self.assertIn(b"monash-codex-token:", result.stderr)

    def test_missing_wrapper_refuses_without_a_path_search(self):
        self.layout.wrapper.unlink()
        shutil.copy2(SOURCE_DIR / "monash-codex-token", Path(self.temp.name) / "with-one-password-token")
        result = self.run_helper(env_extra={"PATH": f"{self.temp.name}:/usr/bin:/bin"})
        self.assertEqual((result.returncode, result.stdout), (3, b""))
        self.assertIn(b"wrapper is unavailable", result.stderr)

    def test_unsafe_or_relative_wrappers_are_refused(self):
        # Review finding: a writable, linked or cwd-relative wrapper ran with the credential reference.
        os.chmod(self.layout.wrapper, 0o720)
        result = self.run_helper()
        self.assertEqual((result.returncode, result.stdout), (3, b""))
        os.chmod(self.layout.wrapper, 0o700)
        link = self.layout.wrapper.with_name("linked-wrapper")
        link.symlink_to(self.layout.wrapper)
        self.layout.set_wrapper(str(link))
        self.assertEqual(self.run_helper().returncode, 3)
        self.layout.set_wrapper("fake-with-one-password-token")
        result = self.run_helper()
        self.assertEqual((result.returncode, result.stdout), (3, b""))
        self.assertIn(b"must be an absolute path", result.stderr)
        self.assertEqual(self.layout.wrapper_runs(), 0)

    def test_untrusted_launcher_or_config_is_refused_before_any_credential_lookup(self):
        # Review finding: the launcher and config.json were trusted without admission.
        marker = self.layout.plant_launcher_marker()
        config = self.layout.dir / "config.json"
        # (label, break, repair, launcher untrusted so its code must not run)
        cases = [
            ("writable launcher", lambda: os.chmod(self.layout.dir / "monash-foundry", 0o766),
             lambda: os.chmod(self.layout.dir / "monash-foundry", 0o500), True),
            ("writable directory", lambda: os.chmod(self.layout.dir, 0o777),
             lambda: os.chmod(self.layout.dir, 0o755), True),
            ("writable config", lambda: os.chmod(config, 0o666), lambda: os.chmod(config, 0o600), False),
        ]
        for label, break_it, repair, launcher_untrusted in cases:
            with self.subTest(label):
                break_it()
                try:
                    result = self.run_helper()
                finally:
                    repair()
                self.assertEqual((result.returncode, result.stdout), (3, b""))
                self.assertIn(b"not a private file in trusted directories", result.stderr)
                self.assertEqual(marker.exists(), not launcher_untrusted)
        real = config.with_name("real-config.json")
        config.rename(real)
        config.symlink_to(real)
        result = self.run_helper()
        self.assertEqual((result.returncode, result.stdout), (3, b""))
        self.assertIn(b"config.json is not a private file", result.stderr)
        self.assertEqual(self.layout.wrapper_runs(), 0)

    def test_shipped_invocation_never_imports_modules_planted_beside_it(self):
        # Review finding: a planted subprocess.py ran before any admission check.
        marker = self.layout.dir.parent / "shadow-module-ran"
        for module in ("subprocess", "types", "stat", "argparse", "json"):
            (self.layout.dir / f"{module}.py").write_text(
                f"open({str(marker)!r}, 'w').close()\nprint({TOKEN!r})\n"
            )
        os.chmod(self.layout.dir, 0o777)
        try:
            env = {"HOME": os.environ["HOME"], "PATH": os.environ["PATH"]}
            helper = subprocess.run([str(self.layout.helper)], stdin=subprocess.DEVNULL, capture_output=True,
                                    env=env, timeout=30, check=False)
            desktop = subprocess.run([str(self.layout.desktop), "--codex-home", self.temp.name, "plan"],
                                     stdin=subprocess.DEVNULL, capture_output=True, env=env, timeout=30, check=False)
        finally:
            os.chmod(self.layout.dir, 0o755)
        self.assertEqual((helper.returncode, helper.stdout), (3, b""))
        self.assertEqual(desktop.returncode, 3)
        self.assertNotIn(TOKEN.encode(), helper.stdout + desktop.stdout)
        self.assertFalse(marker.exists())

    def test_arguments_are_refused_before_any_credential_lookup(self):
        result = self.run_helper(args=("--print",))
        self.assertEqual((result.returncode, result.stdout), (2, b""))
        self.assertEqual(self.layout.wrapper_runs(), 0)

    def test_a_terminal_is_refused_before_any_credential_lookup(self):
        controller, terminal = pty.openpty()
        try:
            result = subprocess.run([sys.executable, "-B", str(self.layout.helper)], stdin=subprocess.DEVNULL,
                                    stdout=terminal, stderr=subprocess.PIPE, timeout=30, check=False)
            os.close(terminal)
            terminal = -1
            echoed = b""
            while select.select([controller], [], [], 0.2)[0]:
                try:
                    chunk = os.read(controller, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                echoed += chunk
        finally:
            if terminal >= 0:
                os.close(terminal)
            os.close(controller)
        self.assertEqual((result.returncode, echoed), (2, b""))
        self.assertIn(b"refusing to resolve a credential for a terminal", result.stderr)
        self.assertEqual(self.layout.wrapper_runs(), 0)


class DesktopConfigTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.layout = InstalledLayout(root)
        self.home = root / "codex-home"
        self.home.mkdir()
        self.config = self.home / "config.toml"

    def tearDown(self):
        self.temp.cleanup()

    def write(self, text: str) -> None:
        self.config.write_text(text)
        os.chmod(self.config, 0o600)

    def test_apply_appends_exactly_the_managed_block_and_rollback_restores_every_byte(self):
        originals = {
            "personal": PERSONAL_CONFIG,
            "empty": "",
            "keys-only": 'model = "gpt-6.1-sol"\n',
            "trailing-blank-lines": PERSONAL_CONFIG + "\n\n",
        }
        for label, original in originals.items():
            with self.subTest(original=label):
                self.write(original)
                applied = run_desktop(self.layout, self.home, "apply")
                self.assertEqual(applied.returncode, 0, applied.stderr)
                expected = original + managed_block(self.layout.helper)
                self.assertEqual(self.config.read_text(), expected)
                self.assertEqual(self.config.stat().st_mode & 0o777, 0o600)
                self.assertNotIn("model_provider", tomllib.loads(self.config.read_text()))
                again = run_desktop(self.layout, self.home, "apply")
                self.assertEqual((again.returncode, self.config.read_text()), (0, expected))
                self.assertIn("already applied", again.stdout)
                status = run_desktop(self.layout, self.home, "status")
                self.assertEqual(status.returncode, 0)
                self.assertIn("state=applied new_chat_default=absent default_provider=unset", status.stdout)
                rolled = run_desktop(self.layout, self.home, "rollback")
                self.assertEqual(rolled.returncode, 0, rolled.stderr)
                self.assertEqual(self.config.read_bytes(), original.encode())
                self.assertIn("state=absent", run_desktop(self.layout, self.home, "status").stdout)

    def test_new_chat_default_adds_one_top_block_and_rollback_restores_every_byte(self):
        originals = {"personal": PERSONAL_CONFIG, "keys-only": 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n'}
        for label, original in originals.items():
            with self.subTest(original=label):
                self.write(original)
                plan = run_desktop(self.layout, self.home, "plan", "--new-chat-default")
                self.assertEqual((plan.returncode, self.config.read_text()), (0, original), plan.stderr)
                added = [line[1:] for line in plan.stdout.splitlines() if line.startswith("+") and not line.startswith("+++")]
                self.assertEqual(added, (DEFAULT_BLOCK + managed_block(self.layout.helper)).splitlines())
                self.assertIn("default provider for new chats: monash_foundry", plan.stdout)
                applied = run_desktop(self.layout, self.home, "apply", "--new-chat-default")
                self.assertEqual(applied.returncode, 0, applied.stderr)
                expected = DEFAULT_BLOCK + original + managed_block(self.layout.helper)
                self.assertEqual(self.config.read_text(), expected)
                parsed = tomllib.loads(expected)
                self.assertEqual((parsed["model_provider"], parsed["model"]), ("monash_foundry", "gpt-6.1-sol"))
                for flags in (("--new-chat-default",), ()):
                    again = run_desktop(self.layout, self.home, "apply", *flags)
                    self.assertEqual((again.returncode, self.config.read_text()), (0, expected), again.stderr)
                status = run_desktop(self.layout, self.home, "status")
                self.assertEqual(status.returncode, 0, status.stdout)
                self.assertIn("state=applied new_chat_default=applied default_provider=monash_foundry", status.stdout)
                rolled = run_desktop(self.layout, self.home, "rollback")
                self.assertEqual(rolled.returncode, 0, rolled.stderr)
                self.assertEqual(self.config.read_bytes(), original.encode())
                self.assertIn("state=absent new_chat_default=absent default_provider=unset",
                              run_desktop(self.layout, self.home, "status").stdout)

    def test_new_chat_default_after_a_provider_only_apply_adds_only_the_default(self):
        self.write(PERSONAL_CONFIG)
        self.assertEqual(run_desktop(self.layout, self.home, "apply").returncode, 0)
        applied = run_desktop(self.layout, self.home, "apply", "--new-chat-default")
        self.assertEqual(applied.returncode, 0, applied.stderr)
        self.assertEqual(self.config.read_text(), DEFAULT_BLOCK + PERSONAL_CONFIG + managed_block(self.layout.helper))
        self.assertEqual(run_desktop(self.layout, self.home, "rollback").returncode, 0)
        self.assertEqual(self.config.read_text(), PERSONAL_CONFIG)

    def test_new_chat_default_refuses_any_other_route_or_existing_default(self):
        cases = {
            "other model": (PERSONAL_CONFIG.replace('"gpt-6.1-sol"', '"gpt-5.5"'), "are not gpt-6.1-sol and high"),
            "other effort": (PERSONAL_CONFIG.replace('"high"', '"xhigh"'), "are not gpt-6.1-sol and high"),
            "no model": ('model_reasoning_effort = "high"\n', "are not gpt-6.1-sol and high"),
            "existing default": ('model_provider = "synthetic-private-provider"\n' + PERSONAL_CONFIG,
                                 "already sets a top-level model_provider"),
            "profile": ('profile = "work"\n' + PERSONAL_CONFIG, "sets a top-level profile"),
        }
        for label, (original, fragment) in cases.items():
            with self.subTest(case=label):
                self.write(original)
                for command in ("plan", "apply"):
                    result = run_desktop(self.layout, self.home, command, "--new-chat-default")
                    self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
                    self.assertIn(fragment, result.stderr)
                    self.assertEqual(self.config.read_text(), original)
                    self.assertNotIn("synthetic-private-provider", result.stdout + result.stderr)

    def test_new_chat_default_flag_is_refused_for_status_and_rollback(self):
        self.write(PERSONAL_CONFIG)
        for command in ("status", "rollback"):
            result = run_desktop(self.layout, self.home, command, "--new-chat-default")
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn("applies only to plan and apply", result.stderr)
        self.assertEqual(self.config.read_text(), PERSONAL_CONFIG)

    def test_rollback_with_a_default_keeps_edits_the_app_made_after_apply(self):
        self.write(PERSONAL_CONFIG)
        self.assertEqual(run_desktop(self.layout, self.home, "apply", "--new-chat-default").returncode, 0)
        app_key = 'model_reasoning_effort = "high"\nhide_agent_reasoning = true\n'
        trust = '\n[projects."/synthetic/other"]\ntrust_level = "trusted"\n'
        self.write(self.config.read_text().replace('model_reasoning_effort = "high"\n', app_key) + trust)
        rolled = run_desktop(self.layout, self.home, "rollback")
        self.assertEqual(rolled.returncode, 0, rolled.stderr)
        self.assertEqual(self.config.read_text(), PERSONAL_CONFIG.replace('model_reasoning_effort = "high"\n', app_key) + trust)

    def test_a_changed_route_is_reported_and_still_rolls_back(self):
        self.write(PERSONAL_CONFIG)
        self.assertEqual(run_desktop(self.layout, self.home, "apply", "--new-chat-default").returncode, 0)
        self.write(self.config.read_text().replace('"gpt-6.1-sol"', '"gpt-5.5"'))
        status = run_desktop(self.layout, self.home, "status")
        self.assertEqual(status.returncode, 3)
        self.assertIn("new_chat_default=applied-route-changed", status.stdout)
        self.assertEqual(run_desktop(self.layout, self.home, "rollback").returncode, 0)
        self.assertEqual(self.config.read_text(), PERSONAL_CONFIG.replace('"gpt-6.1-sol"', '"gpt-5.5"'))

    def test_default_markers_that_do_not_delimit_the_real_default_are_refused(self):
        begin, line, end = DEFAULT_BLOCK.splitlines(keepends=True)
        provider = managed_block(self.layout.helper)
        cases = {
            "inside a string": PERSONAL_CONFIG + "notes = '''\n" + DEFAULT_BLOCK + "'''\n" + provider,
            "extra key": begin + line + 'model = "gpt-6.1-sol"\n' + end + 'model_reasoning_effort = "high"\n' + provider,
            "below a table": PERSONAL_CONFIG + DEFAULT_BLOCK + provider,
            "repeated": DEFAULT_BLOCK + begin + end + PERSONAL_CONFIG + provider,
            "half": begin + PERSONAL_CONFIG + provider,
        }
        for label, text in cases.items():
            with self.subTest(case=label):
                self.write(text)
                self.assert_refused("rollback", "default markers are incomplete")
                self.assert_refused("apply", "default markers are incomplete")
                self.assertEqual(run_desktop(self.layout, self.home, "status").returncode, 3)

    def test_rollback_refuses_an_unmarked_monash_default_that_would_dangle(self):
        self.write(PERSONAL_CONFIG)
        self.assertEqual(run_desktop(self.layout, self.home, "apply").returncode, 0)
        self.write('model_provider = "monash_foundry"\n' + self.config.read_text())
        self.assert_refused("rollback", "is set outside this tool's markers")

    def test_plan_never_echoes_personal_content_from_a_repetitive_config(self):
        # Review finding: difflib's junk heuristic printed the whole personal file as removals and additions.
        line = "personal-secret-line = do-not-print-me\n"
        repetitive = (PERSONAL_CONFIG.replace("[mcp_servers.synthetic]", 'notes = """\n' + line * 150 + '"""\n'
                                              "other = '''\n" + line * 150 + "'''\n\n[mcp_servers.synthetic]"))
        self.write(repetitive)
        for flags in (("--new-chat-default",), ()):
            plan = run_desktop(self.layout, self.home, "plan", *flags)
            self.assertEqual(plan.returncode, 0, plan.stderr)
            self.assertNotIn("do-not-print-me", plan.stdout + plan.stderr)
            self.assertFalse([out for out in plan.stdout.splitlines() if out.startswith("-") and not out.startswith("---")])
            added = [out[1:] for out in plan.stdout.splitlines() if out.startswith("+") and not out.startswith("+++")]
            expected = (DEFAULT_BLOCK if flags else "") + managed_block(self.layout.helper)
            self.assertEqual(added, expected.splitlines())
        self.assertEqual(self.config.read_text(), repetitive)

    def test_a_managed_default_off_the_qualified_route_blocks_every_apply(self):
        # Review finding: re-apply skipped route and profile admission and could restore the provider.
        variants = {
            "model changed": lambda text: text.replace('"gpt-6.1-sol"', '"gpt-5.5"'),
            "effort changed": lambda text: text.replace('model_reasoning_effort = "high"', 'model_reasoning_effort = "low"'),
            "profile added": lambda text: text.replace(
                'model = "gpt-6.1-sol"\n', 'model = "gpt-6.1-sol"\nprofile = "work"\n'),
        }
        for label, change in variants.items():
            for provider_present in (True, False):
                with self.subTest(change=label, provider_present=provider_present):
                    self.write(PERSONAL_CONFIG)
                    self.assertEqual(run_desktop(self.layout, self.home, "apply", "--new-chat-default").returncode, 0)
                    text = change(self.config.read_text())
                    if not provider_present:
                        text = text.replace(managed_block(self.layout.helper), "")
                    self.write(text)
                    for flags in (("--new-chat-default",), ()):
                        self.assert_refused("apply", "are not gpt-6.1-sol and high" if label != "profile added" else "top-level profile", *flags)
                    status = run_desktop(self.layout, self.home, "status")
                    self.assertEqual(status.returncode, 3, status.stdout)
                    self.assertIn("new_chat_default=applied-route-changed", status.stdout)
                    self.assertEqual(run_desktop(self.layout, self.home, "rollback").returncode, 0)
                    self.assertNotIn("monash_foundry", self.config.read_text())

    def test_an_unmarked_monash_default_is_never_built_on(self):
        # Review finding: a provider-only apply activated an unmarked Monash default.
        unmarked = 'model_provider = "monash_foundry"\n' + PERSONAL_CONFIG
        self.write(unmarked)
        for command in ("plan", "apply"):
            for flags in (("--new-chat-default",), ()):
                self.assert_refused(command, "is set outside this tool's markers", *flags)
        status = run_desktop(self.layout, self.home, "status")
        self.assertEqual(status.returncode, 3, status.stdout)
        self.assertIn("new_chat_default=unmanaged", status.stdout)
        self.assertEqual(self.config.read_text(), unmarked)

    def test_rollback_refuses_to_leave_a_profile_naming_the_removed_provider(self):
        # Review finding: a later profile kept selecting the provider rollback removed.
        self.write(PERSONAL_CONFIG)
        self.assertEqual(run_desktop(self.layout, self.home, "apply", "--new-chat-default").returncode, 0)
        self.write(self.config.read_text() + '\n[profiles.private-profile-name]\nmodel_provider = "monash_foundry"\n')
        result = self.assert_refused("rollback", "1 Codex profile(s) select")
        self.assertNotIn("private-profile-name", result.stdout + result.stderr)

    def test_default_marker_repair_advice_keeps_a_personal_setting(self):
        # Review finding: the advice told the user to delete a personal value the app wrote between the markers.
        self.write(PERSONAL_CONFIG)
        self.assertEqual(run_desktop(self.layout, self.home, "apply", "--new-chat-default").returncode, 0)
        self.write(self.config.read_text().replace('model_provider = "monash_foundry"', 'model_provider = "synthetic-private-provider"'))
        result = self.assert_refused("rollback", "default markers are incomplete")
        self.assertIn("move any setting of yours out from between the default markers and keep it", result.stderr)
        self.assertNotIn("synthetic-private-provider", result.stdout + result.stderr)

    def test_unicode_line_separators_never_make_marker_text_a_marker_line(self):
        # Review finding: str.splitlines broke a TOML comment at U+2028 and admitted the marker inside it.
        begin, line, end = DEFAULT_BLOCK.splitlines(keepends=True)
        route = 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n'
        for separator in (" ", " ", "\u0085"):
            cases = {
                "default": route + "# note" + separator + begin + line + end,
                "provider": PERSONAL_CONFIG + "# note" + separator + managed_block(self.layout.helper),
            }
            for label, text in cases.items():
                with self.subTest(separator=hex(ord(separator)), block=label):
                    self.write(text)
                    for command, flags in (("plan", ()), ("apply", ()), ("plan", ("--new-chat-default",)),
                                           ("apply", ("--new-chat-default",)), ("rollback", ())):
                        result = run_desktop(self.layout, self.home, command, *flags)
                        self.assertEqual(result.returncode, 3, f"{command} {flags}: {result.stdout}{result.stderr}")
                        self.assertTrue(any(fragment in result.stderr for fragment in
                                            ("incomplete, repeated", "is set outside this tool's markers")), result.stderr)
                        self.assertEqual(self.config.read_bytes(), text.encode())
                    self.assertEqual(run_desktop(self.layout, self.home, "status").returncode, 3)

    def test_plan_shows_only_managed_lines_and_changes_nothing(self):
        self.write(PERSONAL_CONFIG)
        plan = run_desktop(self.layout, self.home, "plan")
        self.assertEqual(plan.returncode, 0, plan.stderr)
        self.assertEqual(self.config.read_text(), PERSONAL_CONFIG)
        added = [line[1:] for line in plan.stdout.splitlines() if line.startswith("+") and not line.startswith("+++")]
        self.assertEqual(added, managed_block(self.layout.helper).splitlines())
        self.assertNotIn("do-not-print-me", plan.stdout)
        self.assertNotIn("SYNTHETIC_PERSONAL_SECRET", plan.stdout)

    def test_rollback_keeps_edits_the_app_made_after_apply(self):
        self.write(PERSONAL_CONFIG)
        self.assertEqual(run_desktop(self.layout, self.home, "apply").returncode, 0)
        edited = self.config.read_text().replace('model_reasoning_effort = "high"', 'model_reasoning_effort = "xhigh"')
        edited += '\n[projects."/synthetic/other"]\ntrust_level = "trusted"\n'
        self.write(edited)
        rolled = run_desktop(self.layout, self.home, "rollback")
        self.assertEqual(rolled.returncode, 0, rolled.stderr)
        self.assertEqual(
            self.config.read_text(),
            PERSONAL_CONFIG.replace('"high"', '"xhigh"') + '\n[projects."/synthetic/other"]\ntrust_level = "trusted"\n',
        )

    def test_rollback_keeps_a_blank_line_the_app_added_before_the_block(self):
        # Review finding: a guessed separator deleted a later app edit.
        self.write("")
        self.assertEqual(run_desktop(self.layout, self.home, "apply").returncode, 0)
        self.write("\n" + self.config.read_text())
        self.assertEqual(run_desktop(self.layout, self.home, "rollback").returncode, 0)
        self.assertEqual(self.config.read_bytes(), b"\n")

    def test_valid_toml_dates_and_nan_survive_apply_and_rollback(self):
        original = 'started = 2026-11-02T05:00:00Z\nratio = nan\n'
        self.write(original)
        applied = run_desktop(self.layout, self.home, "apply")
        self.assertEqual(applied.returncode, 0, applied.stderr)
        self.assertEqual(run_desktop(self.layout, self.home, "rollback").returncode, 0)
        self.assertEqual(self.config.read_text(), original)

    def test_plan_and_status_never_echo_the_personal_default_provider(self):
        self.write('model_provider = "synthetic-private-provider"\n' + PERSONAL_CONFIG)
        plan = run_desktop(self.layout, self.home, "plan")
        status = run_desktop(self.layout, self.home, "status")
        self.assertEqual((plan.returncode, status.returncode), (0, 0), plan.stderr + status.stderr)
        self.assertNotIn("synthetic-private-provider", plan.stdout + status.stdout)
        self.assertIn("default_provider=another provider", status.stdout)

    def test_markers_inside_a_string_are_never_treated_as_the_block(self):
        # Review finding: lexical markers inside a multiline literal string.
        lookalike = PERSONAL_CONFIG + "notes = '''\n" + managed_block(self.layout.helper) + "'''\n"
        self.write(lookalike)
        self.assert_refused("apply", "incomplete, repeated or imitated")
        self.assert_refused("rollback", "incomplete, repeated or imitated")
        self.assertIn("imitated", run_desktop(self.layout, self.home, "status").stdout)

    def test_rollback_refuses_to_reparent_a_setting_moved_past_the_block(self):
        # Review finding: a moved auth key would land in the preceding personal table.
        self.write(PERSONAL_CONFIG)
        self.assertEqual(run_desktop(self.layout, self.home, "apply").returncode, 0)
        moved = self.config.read_text().replace("args = []\n", "").replace(END + "\n", END + "\nargs = []\n")
        self.write(moved)
        self.assert_refused("rollback", "would change settings other than the Monash provider")

    def test_a_concurrent_run_is_refused(self):
        self.write(PERSONAL_CONFIG)
        holder = os.open(self.home, os.O_RDONLY)
        try:
            import fcntl
            fcntl.flock(holder, fcntl.LOCK_EX)
            self.assert_refused("apply", "another monash-codex-desktop run")
        finally:
            os.close(holder)

    def test_writable_config_or_home_is_refused(self):
        self.write(PERSONAL_CONFIG)
        os.chmod(self.config, 0o666)
        self.assert_refused("apply", "not owned and writable only by you")
        os.chmod(self.config, 0o600)
        os.chmod(self.home, 0o777)
        try:
            self.assert_refused("apply", "not a real directory owned and writable only by you")
        finally:
            os.chmod(self.home, 0o700
        )

    def assert_refused(self, command: str, fragment: str, *flags: str) -> subprocess.CompletedProcess:
        before = self.config.read_bytes() if self.config.exists() else None
        result = run_desktop(self.layout, self.home, command, *flags)
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        self.assertIn(fragment, result.stderr)
        self.assertEqual(self.config.read_bytes() if self.config.exists() else None, before)
        return result

    def test_unsafe_or_unexpected_states_are_refused_without_writing(self):
        unmanaged = PERSONAL_CONFIG + '\n[model_providers.monash_foundry]\nname = "hand"\nbase_url = "https://x"\n'
        self.write(unmanaged)
        self.assert_refused("apply", "outside this tool's markers")
        self.assert_refused("rollback", "present without this tool's markers")
        self.assertIn("state=unmanaged-provider", run_desktop(self.layout, self.home, "status").stdout)

        self.write(PERSONAL_CONFIG.rstrip("\n"))
        self.assert_refused("apply", "does not end with a newline")

        self.write("model = \n")
        self.assert_refused("apply", "is not valid TOML")

        self.write(PERSONAL_CONFIG + managed_block(self.layout.helper) + BEGIN + "\n")
        self.assert_refused("rollback", "incomplete, repeated or imitated")

        foreign = managed_block(self.layout.helper).replace("args = []\n", 'args = []\nenv_key = "OPENAI_API_KEY"\n')
        self.write(PERSONAL_CONFIG + foreign)
        self.assert_refused("rollback", "settings this tool did not write")

    def test_a_linked_config_is_refused(self):
        real = self.home / "elsewhere.toml"
        real.write_text(PERSONAL_CONFIG)
        self.config.symlink_to(real)
        self.assert_refused("apply", "is a link or unreadable")
        self.assertEqual(real.read_text(), PERSONAL_CONFIG)

    def test_apply_refuses_an_unsafe_or_missing_helper(self):
        self.write(PERSONAL_CONFIG)
        os.chmod(self.layout.helper, 0o520)
        self.assert_refused("apply", "not a private executable in trusted directories")
        self.layout.helper.unlink()
        self.assert_refused("apply", "not a private executable in trusted directories")

    def test_an_untrusted_launcher_is_refused_before_its_code_runs(self):
        # Review finding: code was imported before its file and directory were admitted.
        self.write(PERSONAL_CONFIG)
        marker = self.layout.plant_launcher_marker()
        os.chmod(self.layout.dir, 0o777)
        try:
            self.assert_refused("apply", "launcher or config.json is not a private file")
        finally:
            os.chmod(self.layout.dir, 0o755)
        os.chmod(self.layout.dir / "monash-foundry", 0o766)
        self.assert_refused("apply", "launcher or config.json is not a private file")
        self.assertFalse(marker.exists())

    def test_a_running_codex_on_this_home_blocks_apply_and_rollback(self):
        # Review finding: an app write between the final read and replace was lost.
        self.write(PERSONAL_CONFIG)
        with fake_codex_writer(Path(self.temp.name), self.home):
            self.assert_refused("apply", "Codex is running on")
        self.assertEqual(run_desktop(self.layout, self.home, "apply").returncode, 0)
        applied = self.config.read_bytes()
        with fake_codex_writer(Path(self.temp.name), self.home):
            self.assert_refused("rollback", "Codex is running on")
        self.assertEqual(self.config.read_bytes(), applied)
        with fake_codex_writer(Path(self.temp.name), Path(self.temp.name) / "another-home"):
            self.assertEqual(run_desktop(self.layout, self.home, "rollback").returncode, 0)
        self.assertEqual(self.config.read_text(), PERSONAL_CONFIG)

    def test_a_codex_process_with_an_unreadable_environment_blocks_any_home(self):
        # Review finding: an unreadable environment was taken as the default home.
        # The kernel read is replaced in-process because no same-user process can
        # be made unreadable on demand; the process listing and decision are real.
        module = types.ModuleType("desktop_under_test")
        module.__file__ = str(self.layout.desktop)
        sys.modules[module.__name__] = module
        exec(compile(self.layout.desktop.read_text(), str(self.layout.desktop), "exec"), module.__dict__)
        with fake_codex_writer(Path(self.temp.name), Path(self.temp.name) / "another-home") as writer:
            self.assertNotIn(writer.process.pid, [pid for pid, _ in module.codex_writers(self.home)])
            module._process_environment = lambda libc, argmax, pid: None
            self.assertIn(writer.process.pid, [pid for pid, _ in module.codex_writers(self.home)])

    def test_a_refused_plan_never_prints_parser_identifiers(self):
        # Review finding: the TOML parser's message named a personal table.
        self.write('[projects."/private/synthetic-project"]\ntrust_level = "trusted"\n'
                   '[projects."/private/synthetic-project"]\ntrust_level = "trusted"\n')
        result = run_desktop(self.layout, self.home, "plan")
        self.assertEqual(result.returncode, 3)
        self.assertNotIn("synthetic-project", result.stdout + result.stderr)
        self.assertIn("is not valid TOML", result.stderr)

    def test_both_tools_carry_identical_trust_rules(self):
        def shared(name):
            text = (SOURCE_DIR / name).read_text()
            start = text.index("# --- shared trust rules")
            return text[start : text.index("# --- end shared trust rules ---")]
        self.assertEqual(shared("monash-codex-token"), shared("monash-codex-desktop"))
        self.assertIn("def admit(", shared("monash-codex-token"))


def sse(events) -> bytes:
    return "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events).encode()


class FakeResponses:
    """A loopback Responses endpoint that records each request's auth facts.

    With `require` set it answers 401 to any other Authorization, like Azure.
    """

    def __init__(self, require: str | None):
        self.requests: list[dict[str, object]] = []
        fake = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                self.send_response(404)
                self.end_headers()

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                auth = self.headers.get("Authorization")
                fake.requests.append({
                    "path": self.path,
                    "auth": "helper" if auth == f"Bearer {TOKEN}" else ("absent" if auth is None else "other"),
                    "decoy": DECOY in str(self.headers) or DECOY.encode() in body,
                })
                if not self.path.endswith("/responses"):
                    self.send_response(404)
                    self.end_headers()
                    return
                if require is not None and auth != require:
                    self.send_response(401)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"error":{"code":"401","message":"synthetic unauthorized"}}')
                    return
                payload = sse([
                    {"type": "response.created", "response": {"id": "resp_synthetic"}},
                    {"type": "response.output_item.done", "item": {"type": "message", "role": "assistant",
                     "id": "msg_1", "content": [{"type": "output_text", "text": "synthetic ok"}]}},
                    {"type": "response.completed", "response": {"id": "resp_synthetic", "usage": {
                        "input_tokens": 1, "input_tokens_details": None, "output_tokens": 1,
                        "output_tokens_details": None, "total_tokens": 2}}},
                ])
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class AppServer:
    """One bundled app-server process speaking the desktop app's JSON-RPC."""

    def __init__(self, home: Path):
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith(("OPENAI", "AZURE", "CODEX", "ANTHROPIC"))}
        environment.update(CODEX_HOME=str(home), RUST_LOG="error")
        self.process = subprocess.Popen(
            [str(ENGINE), "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, env=environment, cwd=str(home),
        )
        self.messages: list[dict[str, object]] = []
        self.inbox: "queue.Queue[dict | None]" = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()
        self.next_id = 1
        self.request("initialize", {"clientInfo": {"name": "monash-test", "version": "0"}})
        self.notify("initialized")

    def notify(self, method: str) -> None:
        self.process.stdin.write((json.dumps({"method": method}) + "\n").encode())
        self.process.stdin.flush()

    def _read(self) -> None:
        # One reader owns stdout's buffer, so no buffered reply is ever missed.
        for line in self.process.stdout:
            self.inbox.put(json.loads(line))
        self.inbox.put(None)

    def wait_for(self, predicate, timeout: float):
        deadline = time.monotonic() + timeout
        while (remaining := deadline - time.monotonic()) > 0:
            try:
                message = self.inbox.get(timeout=remaining)
            except queue.Empty:
                return None
            if message is None:
                return None
            self.messages.append(message)
            if predicate(message):
                return message
        return None

    def request(self, method: str, params: dict) -> dict:
        request_id = self.next_id
        self.next_id += 1
        self.process.stdin.write((json.dumps({"id": request_id, "method": method, "params": params}) + "\n").encode())
        self.process.stdin.flush()
        reply = self.wait_for(lambda message: message.get("id") == request_id, 60)
        if reply is None:
            raise AssertionError(f"{method} had no reply within the bound")
        return reply

    def turn(self, thread_id: str, text: str, timeout: float = 90) -> str | None:
        seen = len(self.messages)
        reply = self.request("turn/start", {"threadId": thread_id, "input": [{"type": "text", "text": text}]})
        if "error" in reply:
            return f"error: {reply['error'].get('message')}"

        def completed(message):
            return message.get("method") == "turn/completed"

        # The completion can arrive before the turn/start reply.
        early = [message for message in self.messages[seen:] if completed(message)]
        done = early[0] if early else self.wait_for(completed, timeout)
        return done["params"]["turn"]["status"] if done else None

    def close(self) -> None:
        self.process.terminate()
        try:
            self.process.wait(10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(10)
        self.process.stdin.close()
        self.process.stdout.close()


@unittest.skipUnless(os.access(ENGINE, os.X_OK), f"bundled Codex engine is absent: {ENGINE}")
class BundledEngineTest(unittest.TestCase):
    """The applied provider table, driven through the desktop app's own engine.

    The test swaps the managed block's Azure base_url for a loopback fake after
    apply: everything else in the block, the helper and the wrapper call are the
    real candidate bytes.
    """

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.layout = InstalledLayout(root)
        self.home = root / "codex-home"
        self.home.mkdir()
        self.monash = FakeResponses(require=f"Bearer {TOKEN}")
        self.personal = FakeResponses(require=None)
        (self.home / "auth.json").write_text(json.dumps({"auth_mode": "apikey", "OPENAI_API_KEY": DECOY}))
        personal_top = (
            f'openai_base_url = "{self.personal.url}"\n'
            f'chatgpt_base_url = "{self.personal.url}"\n'
        )
        self.original = personal_top + PERSONAL_CONFIG.replace("[mcp_servers.synthetic]\ncommand = \"synthetic-mcp\"\n"
                                                               "env = { SYNTHETIC_PERSONAL_SECRET = \"do-not-print-me\" }\n\n", "")
        (self.home / "config.toml").write_text(self.original)
        os.chmod(self.home / "config.toml", 0o600)
        applied = run_desktop(self.layout, self.home, "apply")
        self.assertEqual(applied.returncode, 0, applied.stderr)
        config = self.home / "config.toml"
        config.write_text(config.read_text().replace(BASE_URL, self.monash.url))

    def tearDown(self):
        self.monash.close()
        self.personal.close()
        self.temp.cleanup()

    def personal_responses(self) -> list:
        return [request for request in self.personal.requests if request["path"].endswith("/responses")]

    def start_monash_thread(self) -> str:
        server = AppServer(self.home)
        try:
            started = server.request("thread/start", {"cwd": str(self.home), "modelProvider": "monash_foundry"})
            result = started["result"]
            self.assertEqual((result["modelProvider"], result["model"], result.get("reasoningEffort")),
                             ("monash_foundry", "gpt-6.1-sol", "high"))
            self.assertEqual(server.turn(result["thread"]["id"], "first"), "completed")
            return result["thread"]["id"]
        finally:
            server.close()

    def test_new_chat_stays_personal_and_a_monash_thread_resumes_until_rollback(self):
        thread_id = self.start_monash_thread()
        self.assertEqual([request["auth"] for request in self.monash.requests], ["helper"])
        runs_after_first = self.layout.wrapper_runs()

        server = AppServer(self.home)
        try:
            fresh = server.request("thread/start", {"cwd": str(self.home)})["result"]
            self.assertEqual(fresh["modelProvider"], "openai")
            # Routing is the claim: the personal turn's own completion is the
            # personal route's business and is not awaited.
            started = server.request("turn/start", {"threadId": fresh["thread"]["id"],
                                                    "input": [{"type": "text", "text": "personal"}]})
            self.assertIn("result", started, started)
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline and not self.personal_responses():
                time.sleep(0.2)
        finally:
            server.close()
        self.assertGreaterEqual(len(self.personal_responses()), 1)
        self.assertEqual(len(self.monash.requests), 1)
        self.assertEqual(self.layout.wrapper_runs(), runs_after_first)

        server = AppServer(self.home)
        try:
            resumed = server.request("thread/resume", {"threadId": thread_id})["result"]
            self.assertEqual((resumed["modelProvider"], resumed["model"], resumed.get("reasoningEffort")),
                             ("monash_foundry", "gpt-6.1-sol", "high"))
            self.assertEqual(server.turn(thread_id, "second"), "completed")
            written = server.request("config/value/write", {"keyPath": "hide_agent_reasoning", "value": True,
                                                            "mergeStrategy": "replace"})
            self.assertIn("result", written, written)
        finally:
            server.close()
        self.assertEqual([request["auth"] for request in self.monash.requests], ["helper", "helper"])
        self.assertFalse(any(request["decoy"] for request in self.monash.requests))

        rolled = run_desktop(self.layout, self.home, "rollback")
        self.assertEqual(rolled.returncode, 0, rolled.stderr)
        final = (self.home / "config.toml").read_text()
        self.assertNotIn(BEGIN, final)
        self.assertNotIn(END, final)
        self.assertEqual(tomllib.loads(final), {**tomllib.loads(self.original), "hide_agent_reasoning": True})

        server = AppServer(self.home)
        try:
            refused = server.request("thread/resume", {"threadId": thread_id})
        finally:
            server.close()
        self.assertIn("Model provider `monash_foundry` not found", refused["error"]["message"])
        self.assertEqual(len(self.monash.requests), 2)

    def test_new_chat_default_routes_new_chats_to_monash_and_keeps_existing_chats_personal(self):
        server = AppServer(self.home)
        try:
            before = server.request("thread/start", {"cwd": str(self.home)})["result"]
            self.assertEqual(before["modelProvider"], "openai")
            personal_id = before["thread"]["id"]
            server.turn(personal_id, "personal before")  # routing is the claim, not the personal completion
        finally:
            server.close()
        personal_before = len(self.personal_responses())
        self.assertGreaterEqual(personal_before, 1)

        # setUp's provider-only block carries the loopback URL, so re-apply from scratch with the default.
        self.assertEqual(run_desktop(self.layout, self.home, "rollback").returncode, 0)
        applied = run_desktop(self.layout, self.home, "apply", "--new-chat-default")
        self.assertEqual(applied.returncode, 0, applied.stderr)
        config = self.home / "config.toml"
        config.write_text(config.read_text().replace(BASE_URL, self.monash.url))

        server = AppServer(self.home)
        try:
            fresh = server.request("thread/start", {"cwd": str(self.home)})["result"]  # the app sends no provider
            self.assertEqual((fresh["modelProvider"], fresh["model"], fresh.get("reasoningEffort")),
                             ("monash_foundry", "gpt-6.1-sol", "high"))
            self.assertEqual(server.turn(fresh["thread"]["id"], "monash new chat"), "completed")
            self.assertEqual([request["auth"] for request in self.monash.requests], ["helper"])
            resumed = server.request("thread/resume", {"threadId": personal_id})["result"]
            self.assertEqual(resumed["modelProvider"], "openai")
            server.turn(personal_id, "personal after")
            written = server.request("config/value/write", {"keyPath": "hide_agent_reasoning", "value": True,
                                                            "mergeStrategy": "replace"})
            self.assertIn("result", written, written)
        finally:
            server.close()
        self.assertGreater(len(self.personal_responses()), personal_before)
        self.assertEqual(len(self.monash.requests), 1)
        self.assertFalse(any(request["decoy"] for request in self.monash.requests))

        rolled = run_desktop(self.layout, self.home, "rollback")
        self.assertEqual(rolled.returncode, 0, rolled.stderr)
        self.assertEqual(tomllib.loads(config.read_text()), {**tomllib.loads(self.original), "hide_agent_reasoning": True})
        server = AppServer(self.home)
        try:
            after = server.request("thread/start", {"cwd": str(self.home)})["result"]
        finally:
            server.close()
        self.assertEqual(after["modelProvider"], "openai")
        self.assertEqual(len(self.monash.requests), 1)

    def test_a_live_app_server_on_this_home_blocks_rollback(self):
        before = (self.home / "config.toml").read_bytes()
        server = AppServer(self.home)
        try:
            refused = run_desktop(self.layout, self.home, "rollback")
        finally:
            server.close()
        self.assertEqual(refused.returncode, 3, refused.stdout + refused.stderr)
        self.assertIn("Codex is running on", refused.stderr)
        self.assertEqual((self.home / "config.toml").read_bytes(), before)
        self.assertEqual(run_desktop(self.layout, self.home, "rollback").returncode, 0)

    def test_helper_failure_sends_no_credential_and_the_turn_fails(self):
        # Records the engine limitation honestly: Codex retries the prompt
        # without Authorization until the endpoint refuses. It is not a
        # zero-request gate, and no personal or decoy credential is substituted.
        self.layout.wrapper_mode("fail")
        server = AppServer(self.home)
        try:
            started = server.request("thread/start", {"cwd": str(self.home), "modelProvider": "monash_foundry"})
            status = server.turn(started["result"]["thread"]["id"], "should fail", timeout=180)
        finally:
            server.close()
        self.assertEqual(status, "failed")
        self.assertGreaterEqual(len(self.monash.requests), 1)
        self.assertEqual({request["auth"] for request in self.monash.requests}, {"absent"})
        self.assertFalse(any(request["decoy"] for request in self.monash.requests + self.personal.requests))
        self.assertEqual(self.personal_responses(), [])


if __name__ == "__main__":
    unittest.main()
