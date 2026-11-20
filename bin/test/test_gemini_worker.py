"""Public-process proof for `gemini-worker`.

Each case runs the real script as a process with a fake `agy` (and, for pane
cases, the Monash worker tests' fake `herdr`) first on an isolated PATH and a
temporary HOME, so no case can reach the real Antigravity CLI or Herdr. It reads
the exit code, stdout receipt and files. Expected values are literals owned by
this file.

Run:
    python3 -m unittest discover -s bin/test -p test_gemini_worker.py -v
"""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest


REPO = Path(__file__).resolve().parents[2]
WORKER = REPO / "bin" / "gemini-worker"


def load_fake_herdr() -> str:
    """The fake Herdr has one owner, the Monash worker tests; this file imports it."""
    path = REPO / "config/agents/plugins/monash/scripts/foundry/test_monash_worker.py"
    spec = importlib.util.spec_from_file_location("monash_worker_fakes", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module.FAKE_HERDR


# The fake agy's behaviour comes from fake.json beside it. It records argv, stdin,
# cwd and environment names, writes agy's stream-json events, and writes the log
# lines the real agy writes to --log-file.
FAKE_AGY = """#!{python}
import json, os, subprocess, sys, time
from pathlib import Path
cfg = json.loads(Path(__file__).with_name('fake.json').read_text())
argv = sys.argv[1:]
if argv == ['--version']:
    print('1.5.13')
    sys.exit(0)
stdin = sys.stdin.read()
Path(cfg['WORKER_TEST_LOG']).write_text(json.dumps({
    'argv': argv, 'stdin': stdin, 'cwd': os.getcwd(), 'env_names': sorted(os.environ)}))
model = argv[argv.index('--model') + 1]
log = Path(argv[argv.index('--log-file') + 1])
lines = []
if not cfg.get('FAKE_NO_CCPA'):
    lines.append('resolver.go:85] Model ID ' + model + ' not in local config, defaulting to CCPA')
lines.append('model_resolver.go:107] Resolving model ' + cfg.get('FAKE_RESOLVED_MODEL', model))
log.write_text('\\n'.join(lines) + '\\n')
def emit(event):
    print(json.dumps(event), flush=True)
emit({'event': 'init', 'init': {'model': cfg.get('FAKE_INIT_MODEL', model), 'cwd': os.getcwd()}})
if cfg.get('FAKE_MODE') == 'hang':
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])
    Path(cfg['WORKER_TEST_CHILD']).write_text(str(child.pid))
    time.sleep(120)
emit({'event': 'step_update', 'step_update': {'step_index': 1, 'step_type': 'tool', 'state': 'ACTIVE',
                                               'tool_name': 'run_command'}})
emit({'event': 'step_update', 'step_update': {'step_index': 2, 'step_type': 'agent_response',
                                               'state': 'ACTIVE', 'text_delta': 'partial text'}})
result = {'conversation_id': 'c-1', 'status': cfg.get('FAKE_STATUS', 'SUCCESS'),
          'response': cfg['FAKE_MESSAGE'], 'usage': {'total_tokens': 42}}
if cfg.get('FAKE_DENIED'):
    result['denied_actions'] = [{'action': 'command', 'display_name': 'Bash'}]
emit({'event': 'result', 'result': result})
sys.exit(int(cfg.get('FAKE_EXIT', 0)))
"""


def process_gone(pid: int, deadline_seconds: float = 10) -> bool:
    deadline = time.monotonic() + deadline_seconds
    while time.monotonic() < deadline:
        state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], stdout=subprocess.PIPE,
                               text=True, check=False).stdout.strip()
        if not state or state.startswith("Z"):
            return True
        time.sleep(0.05)
    return False


class GeminiWorkerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="gemini-worker-test-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        shutil.copy2(WORKER, self.bin / "gemini-worker")
        for name, source in (("agy", FAKE_AGY), ("herdr", load_fake_herdr())):
            fake = self.bin / name
            fake.write_text(source.replace("{python}", sys.executable), encoding="utf-8")
            fake.chmod(0o755)
        self.home = self.root / "home"
        self.home.mkdir()
        self.cwd = self.root / "repo"
        self.cwd.mkdir()
        self.brief = self.root / "brief.md"
        self.brief.write_text("Count the files in this directory.\n", encoding="utf-8")
        self.out = self.root / "out"
        self.log = self.root / "agy-call.json"
        self.herdr_log = self.root / "herdr-calls.jsonl"

    def env(self, message: str, extra: dict[str, object] | None = None,
            caller_env: dict[str, str] | None = None) -> dict[str, str]:
        fake: dict[str, object] = {
            "WORKER_TEST_LOG": str(self.log), "FAKE_MESSAGE": message,
            "WORKER_TEST_CHILD": str(self.root / "child.pid"),
            "FAKE_HERDR_CALLS": str(self.herdr_log), "FAKE_HERDR_WATCH": str(self.out)}
        fake.update(extra or {})
        (self.bin / "fake.json").write_text(json.dumps(fake), encoding="utf-8")
        return {"HOME": str(self.home), "PATH": f"{self.bin}{os.pathsep}/usr/bin{os.pathsep}/bin",
                **(caller_env or {})}

    def worker(self, *args: str, message: str = "HANDBACK: done", extra: dict[str, object] | None = None,
               caller_env: dict[str, str] | None = None) -> tuple[int, dict[str, object]]:
        result = subprocess.run([sys.executable, str(self.bin / "gemini-worker"), *args],
                                env=self.env(message, extra, caller_env), stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, timeout=90)
        return result.returncode, json.loads(result.stdout)

    def run_unit(self, *extra_args: str, **kwargs: object) -> tuple[int, dict[str, object]]:
        return self.worker("run", "--brief", str(self.brief), "--out", str(self.out),
                           "--cwd", str(self.cwd), *extra_args, **kwargs)  # type: ignore[arg-type]

    def call(self) -> dict[str, object]:
        return json.loads(self.log.read_text())

    def herdr_calls(self) -> list[list[str]]:
        if not self.herdr_log.exists():
            return []
        return [json.loads(line)["argv"] for line in self.herdr_log.read_text().splitlines()]

    # Exec shape

    def test_done_handback_runs_neon_high_in_the_sandbox_on_the_subscription(self) -> None:
        code, receipt = self.run_unit(message="Counted 0 files.\nHANDBACK: done")
        self.assertEqual((code, receipt["status"], receipt["problems"]), (0, "done", []))
        argv = self.call()["argv"]
        self.assertEqual(argv[argv.index("--model") + 1], "gemini-4-neon-high")
        self.assertIn("--sandbox", argv)
        self.assertEqual(json.loads(argv[argv.index("--settings") + 1]),
                         {"useG1Credits": False, "permissions": {"allow": []}})
        self.assertEqual(argv[argv.index("--print-timeout") + 1], "1800s")
        self.assertEqual(Path(self.call()["cwd"]).resolve(), self.cwd.resolve())
        self.assertEqual(receipt["route"], {"init_model": "gemini-4-neon-high",
                                            "resolved_models": ["gemini-4-neon-high"],
                                            "backend": "subscription"})
        self.assertEqual(receipt["launch"]["agy_version"], "1.5.13")
        self.assertEqual((self.out / "last-message.md").read_text(), "Counted 0 files.\nHANDBACK: done")

    def test_brief_and_handback_rules_reach_agy_as_one_stream_json_message(self) -> None:
        self.run_unit()
        message = json.loads(self.call()["stdin"])
        self.assertEqual(message["event"], "user")
        self.assertTrue(message["message"]["content"].startswith("Count the files in this directory.\n"))
        self.assertIn("HANDBACK: blocked: <one-line reason>", message["message"]["content"])

    def test_allowed_domains_reach_the_sandbox_allowlist(self) -> None:
        self.run_unit("--allow-domain", "api.github.com", "--allow-domain", "registry.npmjs.org")
        argv = self.call()["argv"]
        self.assertEqual(json.loads(argv[argv.index("--settings") + 1])["permissions"]["allow"],
                         ["read_url(api.github.com)", "read_url(registry.npmjs.org)"])

    def test_worktree_repository_outside_cwd_is_mounted_read_only(self) -> None:
        main = self.root / "main"
        git = ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid"]
        subprocess.run([*git, "init", "-q", str(main)], check=True)
        subprocess.run([*git, "-C", str(main), "commit", "-q", "--allow-empty", "-m", "base"], check=True)
        worktree = self.root / "wt"
        subprocess.run([*git, "-C", str(main), "worktree", "add", "-q", str(worktree)], check=True)
        self.worker("run", "--brief", str(self.brief), "--out", str(self.out), "--cwd", str(worktree))
        argv = self.call()["argv"]
        self.assertEqual(json.loads(argv[argv.index("--settings") + 1])["permissions"]["allow"],
                         [f"read_file({(main / '.git').resolve()})"])

    def test_domain_that_is_not_a_bare_host_is_refused_before_launch(self) -> None:
        code, receipt = self.run_unit("--allow-domain", "evil.com) command(rm")
        self.assertEqual((code, receipt["status"]), (2, "usage"))
        self.assertFalse(self.out.exists())

    def test_blocked_handback_exits_three_with_its_reason(self) -> None:
        code, receipt = self.run_unit(message="HANDBACK: blocked: no input file")
        self.assertEqual((code, receipt["status"]), (3, "blocked"))
        self.assertEqual(receipt["handback"]["reason"], "no input file")

    def test_denied_action_fails_even_when_agy_exits_zero_with_success(self) -> None:
        code, receipt = self.run_unit(extra={"FAKE_DENIED": True})
        self.assertEqual((code, receipt["status"]), (5, "failed"))
        self.assertIn("agy denied 1 action(s) it could not ask about; read stderr.log", receipt["problems"])

    def test_run_without_the_subscription_route_fails(self) -> None:
        code, receipt = self.run_unit(extra={"FAKE_NO_CCPA": True})
        self.assertEqual((code, receipt["status"]), (5, "failed"))
        self.assertEqual(receipt["problems"], ["agy.log does not show the subscription (CCPA) route"])

    def test_run_that_resolves_another_model_fails(self) -> None:
        code, receipt = self.run_unit(extra={"FAKE_RESOLVED_MODEL": "gemini-3.8-flash-low"})
        self.assertEqual(code, 5)
        self.assertIn("agy resolved gemini-3.8-flash-low, not the requested gemini-4-neon-high",
                      receipt["problems"])

    def test_run_that_starts_on_another_model_fails(self) -> None:
        code, receipt = self.run_unit(extra={"FAKE_INIT_MODEL": "gemini-4-carbon-high"})
        self.assertEqual(code, 5)
        self.assertIn("agy started on gemini-4-carbon-high, not the requested gemini-4-neon-high",
                      receipt["problems"])

    def test_result_that_is_not_success_fails(self) -> None:
        code, receipt = self.run_unit(extra={"FAKE_STATUS": "ERROR"})
        self.assertEqual(code, 5)
        self.assertIn("agy result status is ERROR, not SUCCESS", receipt["problems"])

    def test_agy_exit_code_fails_the_run(self) -> None:
        code, receipt = self.run_unit(extra={"FAKE_EXIT": 1})
        self.assertEqual(code, 5)
        self.assertIn("agy exited 1; read stderr.log", receipt["problems"])

    def test_worker_gets_no_api_keys_or_other_caller_environment(self) -> None:
        self.run_unit(caller_env={"GEMINI_API_KEY": "x", "GOOGLE_API_KEY": "y", "CALLER_SECRET": "z",
                                  "LANG": "en_AU.UTF-8"})
        self.assertEqual(sorted(set(self.call()["env_names"]) - {"__CF_USER_TEXT_ENCODING", "PWD"}),
                         ["HOME", "LANG", "PATH"])

    def test_timeout_stops_the_whole_worker_process_group(self) -> None:
        code, receipt = self.run_unit("--timeout-seconds", "2", extra={"FAKE_MODE": "hang"})
        self.assertEqual((code, receipt["status"]), (4, "timed_out"))
        child = int((self.root / "child.pid").read_text())
        self.assertTrue(process_gone(child))

    def test_agy_missing_from_path_fails_with_a_receipt(self) -> None:
        (self.bin / "agy").unlink()
        code, receipt = self.run_unit()
        self.assertEqual(code, 5)
        self.assertEqual(receipt["launch"]["start_error"], "agy is not on PATH")

    def test_out_directory_with_results_is_refused_before_launch(self) -> None:
        self.out.mkdir()
        (self.out / "receipt.json").write_text("{}")
        code, receipt = self.run_unit()
        self.assertEqual((code, receipt["status"]), (2, "usage"))
        self.assertFalse(self.log.exists())

    def test_check_keeps_a_recorded_timeout_after_a_late_handback(self) -> None:
        self.run_unit("--timeout-seconds", "2", extra={"FAKE_MODE": "hang"})
        (self.out / "last-message.md").write_text("HANDBACK: done")
        code, receipt = self.worker("check", "--out", str(self.out))
        self.assertEqual((code, receipt["status"]), (4, "timed_out"))

    # Pane shape

    def test_pane_run_opens_an_unfocused_neon_tab_and_writes_the_same_receipt(self) -> None:
        code, receipt = self.run_unit("--pane", message="Counted.\nHANDBACK: done")
        self.assertEqual((code, receipt["status"], receipt["problems"]), (0, "done", []))
        self.assertEqual(receipt["launch"]["shape"], "pane")
        calls = self.herdr_calls()
        create = next(call for call in calls if "create" in call)
        self.assertIn("--no-focus", create)
        self.assertEqual(create[create.index("--label") + 1], "neon: out")
        self.assertTrue(any("close" in call for call in calls))
        self.assertIn("partial text", (self.out / "events.jsonl").read_text())

    def test_pane_worker_gets_only_the_allowlisted_environment(self) -> None:
        self.run_unit("--pane")
        # Independent oracle: the allowlist restated here, plus what sh and macOS add on their own.
        allowed = {"HOME", "USER", "LOGNAME", "PATH", "SHELL", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR",
                   "__CF_USER_TEXT_ENCODING", "PWD", "SHLVL", "_"}
        names = set(self.call()["env_names"])
        self.assertEqual(names - allowed, set())
        self.assertTrue({"HOME", "PATH"} <= names)
        # The fake pane shell sets these; none may reach the worker or the script.
        self.assertFalse({"PANE_SHELL_SECRET", "SSH_CONNECTION", "HERDR_PANE_ID", "HERDR_SESSION"} & names)
        self.assertNotIn("leak", (self.out / "run.sh").read_text())

    def test_pane_run_refuses_without_a_running_herdr_session(self) -> None:
        code, receipt = self.run_unit("--pane", extra={"FAKE_HERDR_RUNNING": False})
        self.assertEqual((code, receipt["status"]), (2, "usage"))
        self.assertFalse(self.out.exists())

    def test_pane_timeout_stops_the_worker_group_and_closes_the_tab(self) -> None:
        code, receipt = self.run_unit("--pane", "--timeout-seconds", "3", extra={"FAKE_MODE": "hang"})
        self.assertEqual((code, receipt["status"]), (4, "timed_out"))
        child = int((self.root / "child.pid").read_text())
        self.assertTrue(process_gone(child))
        self.assertTrue(any("close" in call for call in self.herdr_calls()))

    # Pane rendering

    def test_render_prints_model_text_tools_and_denials(self) -> None:
        stream = "\n".join(json.dumps(event) for event in (
            {"event": "init", "init": {"model": "gemini-4-neon-high", "cwd": "/w"}},
            {"event": "step_update", "step_update": {"step_index": 1, "step_type": "tool", "tool_name": "run_command"}},
            {"event": "step_update", "step_update": {"step_index": 1, "step_type": "tool", "tool_name": "run_command"}},
            {"event": "step_update", "step_update": {"step_index": 2, "text_delta": "Hello"}},
            {"event": "result", "result": {"status": "SUCCESS", "duration_seconds": 4.2,
                                           "denied_actions": [{"action": "command"}]}},
        )) + "\nnot json\n"
        result = subprocess.run([sys.executable, str(WORKER), "render"], input=stream, text=True,
                                stdout=subprocess.PIPE, timeout=30)
        self.assertEqual(result.stdout,
                         "[agy] model gemini-4-neon-high in /w\n\n[tool] run_command\nHello\n"
                         "[agy] SUCCESS in 4.2 s\n[agy] denied: {'action': 'command'}\nnot json\n")


if __name__ == "__main__":
    unittest.main()
