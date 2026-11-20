"""Public-process proof for `monash-worker`.

Each case runs the real script as a process with a fake `codex` first on an
isolated PATH and HOME pointing at a temporary directory, so no case can reach
the real Codex or the real worker home. It reads the exit code, stdout receipt,
and files. Expected values are literals owned by this file.

Run:
    python3 -m unittest discover -s scripts/foundry -p 'test_monash_worker.py' -v
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import signal
import tempfile
import time
import unittest


SOURCE_DIR = Path(__file__).resolve().parent
WORKERS_DOC = SOURCE_DIR.parent.parent / "skills" / "monash-foundry" / "workers.md"

# The fake codex's behaviour comes from FAKE_MODE; it records argv, stdin and
# CODEX_HOME, and writes the session record real Codex keeps in that home.
FAKE_CODEX = """#!{python}
import json, os, subprocess, sys, time
from pathlib import Path
cfg = json.loads(Path(__file__).with_name('fake.json').read_text())
Path(cfg['WORKER_TEST_LOG']).write_text(json.dumps(
    {'argv': sys.argv[1:], 'stdin': sys.stdin.read(), 'codex_home': os.environ.get('CODEX_HOME'),
     'env_names': sorted(os.environ), 'herdr_pane': os.environ.get('HERDR_PANE_ID')}))
mode = cfg['FAKE_MODE']
argv = sys.argv[1:]
out = Path(argv[argv.index('-o') + 1])
thread = 'thread-fixture-1'
print(json.dumps({'type': 'thread.started', 'thread_id': thread}))
print(f'session id: {thread}', file=sys.stderr, flush=True)  # the human header a pane shows
if cfg.get('FAKE_SESSION', '1') == '1':
    sessions = Path(os.environ['CODEX_HOME']) / 'sessions' / '2026' / '11' / '20'
    sessions.mkdir(parents=True, exist_ok=True)
    settings = {'model': cfg.get('FAKE_ROUTE_MODEL', 'gpt-6.1-sol'),
                'model_provider_id': cfg.get('FAKE_PROVIDER', 'monash_foundry'),
                'service_tier': cfg.get('FAKE_TIER', 'priority'), 'reasoning_effort': 'high',
                'permission_profile': {'type': 'managed', 'network': cfg.get('FAKE_NETWORK', 'enabled')}}
    events = [{'type': 'event_msg', 'payload': {'type': 'thread_settings_applied', 'thread_settings': settings}}]
    if cfg.get('FAKE_REROUTE'):
        events.append({'type': 'event_msg', 'payload': {'type': 'model_reroute', 'from_model': settings['model'],
                                                         'to_model': cfg['FAKE_REROUTE']}})
    # Write then rename, so a parallel worker reading the shared fixture thread never sees a partial file.
    record = sessions / f'rollout-2026-11-20T13-56-00-{thread}.jsonl'
    partial = record.with_name(f'{record.name}.{os.getpid()}.tmp')
    partial.write_text(''.join(json.dumps(event) + '\\n' for event in events))
    os.replace(partial, record)
if mode == 'hang':
    # The child ignores SIGTERM, so only a group SIGKILL ends it.
    child = subprocess.Popen(['sh', '-c', 'trap "" TERM; sleep 600 & wait'])
    Path(cfg['WORKER_TEST_CHILD']).write_text(str(child.pid))
    time.sleep(600)
if mode == 'refuse':
    print('Error: unknown profile', file=sys.stderr)
    raise SystemExit(2)
print(json.dumps({'type': 'turn.completed', 'usage': {'output_tokens': 7}}))
out.write_text(cfg['FAKE_MESSAGE'])
"""


# The fake herdr records each call, answers status and tab create, and runs `pane run`
# commands as their own process group with a pane-shell environment, as a real pane's
# job-control shell does.
FAKE_HERDR = """#!{python}
import json, os, subprocess, sys, time
from pathlib import Path
cfg = json.loads(Path(__file__).with_name('fake.json').read_text())
argv = sys.argv[1:]
call = {'argv': argv}
if 'tab' in argv and 'create' in argv and cfg.get('FAKE_HERDR_HANG_ON_CREATE'):
    time.sleep(60)
if 'tab' in argv and 'close' in argv and cfg.get('FAKE_HERDR_WATCH'):
    out = Path(cfg['FAKE_HERDR_WATCH'])
    call['handback_present'] = (out / 'last-message.md').exists()
with Path(cfg['FAKE_HERDR_CALLS']).open('a') as log:
    log.write(json.dumps(call) + '\\n')
if 'status' in argv:
    print(json.dumps({'server': {'running': cfg.get('FAKE_HERDR_RUNNING', True)}}))
elif 'tab' in argv and 'create' in argv:
    print(json.dumps({'result': {'root_pane': {'pane_id': 'w9:p1'}, 'tab': {'tab_id': 'w9:t1'}}}))
elif 'process-info' in argv:
    foreground = 2 if cfg.get('FAKE_HERDR_SHELL_BUSY') else 1
    print(json.dumps({'result': {'process_info': {'foreground_process_group_id': foreground, 'shell_pid': 1}}}))
elif 'pane' in argv and 'run' in argv:
    command = ' '.join(argv[argv.index('run') + 2:])
    shell_env = dict(os.environ, PANE_SHELL_SECRET='leak', SSH_CONNECTION='192.0.2.1 50000 192.0.2.2 22',
                     HERDR_PANE_ID='w9:p1', HERDR_SESSION='default')
    subprocess.Popen(['sh', '-c', command], env=shell_env, start_new_session=True,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(float(cfg.get('FAKE_HERDR_RUN_RETURNS_AFTER', 0)))
"""


def process_gone(pid: int, deadline_seconds: float = 10) -> bool:
    """Wait, bounded, until `pid` is reaped or a zombie; a delivered SIGKILL ends there."""
    deadline = time.monotonic() + deadline_seconds
    while time.monotonic() < deadline:
        state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], stdout=subprocess.PIPE,
                               text=True, check=False).stdout.strip()
        if not state or state.startswith("Z"):
            return True
        time.sleep(0.05)
    return False


def kill_leftover_group(pid: int) -> None:
    """Cleanup only: a failing run must not leave the fixture's processes behind."""
    try:
        os.killpg(os.getpgid(pid), signal.SIGKILL)
    except ProcessLookupError:
        pass


class MonashWorkerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="monash-worker-test-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        shutil.copy2(SOURCE_DIR / "monash-worker", self.bin / "monash-worker")
        # The real launcher sits beside monash-worker, as installed; only its environment policy is read.
        shutil.copy2(SOURCE_DIR / "monash-foundry", self.bin / "monash-foundry")
        fake = self.bin / "codex"
        fake.write_text(FAKE_CODEX.replace("{python}", sys.executable), encoding="utf-8")
        fake.chmod(0o755)
        herdr = self.bin / "herdr"
        herdr.write_text(FAKE_HERDR.replace("{python}", sys.executable), encoding="utf-8")
        herdr.chmod(0o755)
        self.herdr_log = self.root / "herdr-calls.jsonl"
        self.home = self.root / "home"
        self.codex_home = self.home / ".codex-monash-sol"
        self.codex_home.mkdir(parents=True, mode=0o700)
        os.chmod(self.codex_home, 0o700)
        for name in ("config.toml", "monash-sol.config.toml"):
            (self.codex_home / name).write_text("# fixture\n", encoding="utf-8")
            os.chmod(self.codex_home / name, 0o600)
        self.cwd = self.root / "repo"
        self.cwd.mkdir()
        self.brief = self.root / "brief.md"
        self.brief.write_text("Count the files in this directory.\n", encoding="utf-8")
        self.out = self.root / "out"
        self.log = self.root / "codex-call.json"

    def env(self, mode: str = "ok", message: str = "", route_model: str = "gpt-6.1-sol",
            extra_env: dict[str, str] | None = None, path_first: str = "") -> dict[str, str]:
        """The worker's environment; the fake's settings go in fake.json, since the worker strips extras."""
        fake = {"WORKER_TEST_LOG": str(self.log), "FAKE_MODE": mode, "FAKE_MESSAGE": message,
                "FAKE_ROUTE_MODEL": route_model, "WORKER_TEST_CHILD": str(self.root / "child.pid"),
                "FAKE_HERDR_CALLS": str(self.herdr_log), "FAKE_HERDR_WATCH": str(self.out)}
        env = {"HOME": str(self.home), "PATH": f"{path_first}{self.bin}{os.pathsep}/usr/bin{os.pathsep}/bin"}
        for name, value in (extra_env or {}).items():
            (fake if name.startswith("FAKE_") else env)[name] = value
        (self.bin / "fake.json").write_text(json.dumps(fake), encoding="utf-8")
        return env

    def worker(self, *args: str, **fake: object) -> tuple[int, dict[str, object]]:
        env = self.env(**fake)  # type: ignore[arg-type]
        result = subprocess.run([sys.executable, str(self.bin / "monash-worker"), *args], env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60)
        return result.returncode, json.loads(result.stdout)

    def run_unit(self, *extra_args: str, **fake: object) -> tuple[int, dict[str, object]]:
        return self.worker("run", "--brief", str(self.brief), "--out", str(self.out),
                           "--cwd", str(self.cwd), *extra_args, **fake)  # type: ignore[arg-type]

    def test_done_handback_passes_and_runs_codex_on_the_worker_profile(self) -> None:
        code, receipt = self.run_unit(message="Three files.\nHANDBACK: done\n")
        self.assertEqual(code, 0)
        self.assertEqual(receipt["status"], "done")
        self.assertEqual(receipt["problems"], [])
        self.assertEqual(receipt["thread_id"], "thread-fixture-1")
        self.assertEqual({key: receipt["route"][key] for key in ("model", "provider", "service_tier", "network")},
                         {"model": "gpt-6.1-sol", "provider": "monash_foundry", "service_tier": "priority",
                          "network": "enabled"})
        call = json.loads(self.log.read_text())
        self.assertEqual(call["codex_home"], str(self.codex_home))
        self.assertEqual(call["argv"], [
            "exec", "--profile", "monash-sol", "-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=high",
            "-C", str(self.cwd), "--skip-git-repo-check", "--json",
            "-o", str(self.out / "last-message.md"), "-"])
        self.assertTrue(call["stdin"].startswith("Count the files in this directory.\n"))
        self.assertIn("HANDBACK: blocked: <one-line reason>", call["stdin"])
        self.assertEqual(json.loads((self.out / "receipt.json").read_text()), receipt)

    def test_effort_and_sandbox_reach_codex(self) -> None:
        self.run_unit("--effort", "medium", "--sandbox", "workspace-write", message="HANDBACK: done")
        argv = json.loads(self.log.read_text())["argv"]
        self.assertIn("model_reasoning_effort=medium", argv)
        self.assertEqual(argv[argv.index("-s") + 1], "workspace-write")

    def test_blocked_handback_exits_three_with_its_reason(self) -> None:
        code, receipt = self.run_unit(message="Needs GitHub.\nHANDBACK: blocked: no network in the sandbox\n")
        self.assertEqual(code, 3)
        self.assertEqual(receipt["status"], "blocked")
        self.assertEqual(receipt["handback"], {"status": "blocked", "reason": "no network in the sandbox"})

    def test_handback_marker_must_be_exact(self) -> None:
        # Independent oracle: the marker contract from the handback rules, as literals.
        for message in ("Tests failed.\nHANDBACK: done: but tests failed\n",
                        "HANDBACK: done\nActually the change did not build.\n",
                        "HANDBACK: done.\n",
                        "Stuck.\nHANDBACK: blocked\n",
                        "Stuck.\nHANDBACK: blocked:\n"):
            with self.subTest(message=message):
                shutil.rmtree(self.out, ignore_errors=True)
                code, receipt = self.run_unit(message=message)
                self.assertEqual(code, 5)
                self.assertEqual(receipt["status"], "failed")
                self.assertEqual(receipt["problems"], ["final line is not an exact HANDBACK marker"])

    def test_two_handback_markers_fail(self) -> None:
        code, receipt = self.run_unit(message="HANDBACK: blocked: no network\nHANDBACK: done\n")
        self.assertEqual(code, 5)
        self.assertEqual(receipt["problems"], ["final message has more than one HANDBACK line"])

    def test_message_without_handback_line_fails(self) -> None:
        code, receipt = self.run_unit(message="This content can't be shown.")
        self.assertEqual(code, 5)
        self.assertEqual(receipt["problems"], ["final message has no HANDBACK line"])

    def test_route_on_another_model_fails_even_with_a_done_handback(self) -> None:
        code, receipt = self.run_unit(message="HANDBACK: done", route_model="gpt-5.5")
        self.assertEqual(code, 5)
        self.assertEqual(receipt["problems"], ["route ran gpt-5.5, not the requested gpt-6.1-sol"])

    def test_receipt_records_the_tier_and_network_the_session_applied(self) -> None:
        code, receipt = self.run_unit(message="HANDBACK: done",
                                      extra_env={"FAKE_TIER": "default", "FAKE_NETWORK": "restricted"})
        self.assertEqual(code, 0)
        self.assertEqual((receipt["route"]["service_tier"], receipt["route"]["network"]), ("default", "restricted"))

    def test_check_accepts_a_receipt_written_before_the_worker_home(self) -> None:
        # Independent oracle: a 0.2.x exec receipt's launch record, which has no codex_home.
        self.out.mkdir()
        (self.out / "last-message.md").write_text("HANDBACK: done\n")
        launch = {"agent": "codex", "effort": "high", "sandbox": "read-only", "cwd": str(self.cwd),
                  "exit_code": 0, "start_error": None, "timed_out": False, "timeout_seconds": 1800,
                  "duration_seconds": 12.0}
        route = {"agent": "codex", "provider": "Monash Foundry Azure Responses", "deployment": "gpt-6.1-sol",
                 "model": "gpt-6.1-sol"}
        (self.out / "receipt.json").write_text(json.dumps({"schema_version": 1, "status": "done", "route": route,
                                                            "requested_model": "gpt-6.1-sol", "launch": launch}))
        code, receipt = self.worker("check", "--out", str(self.out))
        self.assertEqual(code, 0, receipt)
        self.assertEqual(receipt["route"]["model"], "gpt-6.1-sol")
        launch["timed_out"] = True
        (self.out / "receipt.json").write_text(json.dumps({"schema_version": 1, "route": route, "launch": launch}))
        code, receipt = self.worker("check", "--out", str(self.out))
        self.assertEqual(code, 4)

    def test_check_keeps_a_wrong_route_recorded_before_the_worker_home(self) -> None:
        # Independent oracle: a 0.2.x receipt whose launcher route line named another model.
        self.out.mkdir()
        (self.out / "last-message.md").write_text("HANDBACK: done\n")
        launch = {"exit_code": 0, "start_error": None, "timed_out": False, "timeout_seconds": 1800}
        route = {"agent": "codex", "provider": "Monash Foundry Azure Responses", "deployment": "gpt-5.5",
                 "model": "gpt-5.5"}
        (self.out / "receipt.json").write_text(json.dumps({"schema_version": 1, "requested_model": "gpt-6.1-sol",
                                                            "route": route, "launch": launch}))
        code, receipt = self.worker("check", "--out", str(self.out))
        self.assertEqual(code, 5)
        self.assertEqual(receipt["problems"], ["route ran gpt-5.5, not the requested gpt-6.1-sol"])

    def test_session_that_reroutes_the_model_fails(self) -> None:
        code, receipt = self.run_unit(message="HANDBACK: done", extra_env={"FAKE_REROUTE": "gpt-5.5"})
        self.assertEqual(code, 5)
        self.assertEqual(receipt["problems"], ["session rerouted the model from gpt-6.1-sol to gpt-5.5"])

    def test_route_on_another_provider_fails(self) -> None:
        code, receipt = self.run_unit(message="HANDBACK: done", extra_env={"FAKE_PROVIDER": "openai"})
        self.assertEqual(code, 5)
        self.assertEqual(receipt["problems"], ["route used provider openai, not monash_foundry"])

    def test_missing_session_record_fails(self) -> None:
        code, receipt = self.run_unit(message="HANDBACK: done", extra_env={"FAKE_SESSION": "0"})
        self.assertEqual(code, 5)
        self.assertEqual(receipt["problems"],
                         [f"no session record for thread thread-fixture-1 in {self.codex_home}"])

    def test_worker_gets_only_the_launcher_allowlisted_environment(self) -> None:
        secrets = {"OPENAI_API_KEY": "x", "CODEX_API_KEY": "x", "AZURE_OPENAI_API_KEY": "x",
                   "AZURE_CLIENT_SECRET": "x", "OP_SERVICE_ACCOUNT_TOKEN": "x", "HTTPS_PROXY": "http://proxy",
                   "GITHUB_TOKEN": "x", "UNRELATED_SETTING": "x"}
        code, _ = self.run_unit(message="HANDBACK: done", extra_env={**secrets, "TERM": "xterm", "LANG": "C"})
        self.assertEqual(code, 0)
        names = set(json.loads(self.log.read_text())["env_names"])
        self.assertEqual(names & set(secrets), set())
        # Independent oracle: what the old launcher route passed to Codex, plus the worker home.
        self.assertTrue({"HOME", "PATH", "LANG", "TERM", "CODEX_HOME"} <= names, names)

    def test_unsafe_worker_home_is_refused_before_launch(self) -> None:
        profile = self.codex_home / "monash-sol.config.toml"
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir(mode=0o700)
        cases = {
            "home is a symlink": lambda: (self.codex_home.rename(elsewhere / "real"),
                                          self.codex_home.symlink_to(elsewhere / "real")),
            "home mode 755": lambda: os.chmod(self.codex_home, 0o755),
            "profile mode 644": lambda: os.chmod(profile, 0o644),
            "profile is a symlink": lambda: (profile.rename(elsewhere / "profile"),
                                             profile.symlink_to(elsewhere / "profile")),
        }
        for label, damage in cases.items():
            with self.subTest(label):
                self.tearDown_case()
                damage()
                code, receipt = self.run_unit(message="HANDBACK: done")
                self.assertEqual(code, 2)
                self.assertIn("is not a private worker home entry", receipt["message"])
                self.assertFalse(self.log.exists())

    def tearDown_case(self) -> None:
        """Rebuild a healthy worker home between subtests."""
        for path in (self.codex_home, self.root / "elsewhere" / "real"):
            if path.is_symlink():
                path.unlink()
            elif path.exists():
                shutil.rmtree(path)
        for path in (self.root / "elsewhere" / "profile", self.out, self.log):
            if path.is_dir():
                shutil.rmtree(path)
            elif os.path.lexists(path):
                path.unlink()
        self.codex_home.mkdir(mode=0o700)
        os.chmod(self.codex_home, 0o700)
        for name in ("config.toml", "monash-sol.config.toml"):
            (self.codex_home / name).write_text("# fixture\n", encoding="utf-8")
            os.chmod(self.codex_home / name, 0o600)

    def test_missing_worker_profile_is_refused_before_launch(self) -> None:
        (self.codex_home / "monash-sol.config.toml").unlink()
        code, receipt = self.run_unit(message="HANDBACK: done")
        self.assertEqual(code, 2)
        self.assertIn("has no monash-sol profile; run scripts/foundry/install.py", receipt["message"])
        self.assertFalse(self.log.exists())

    def test_codex_refusal_fails_with_its_exit_code(self) -> None:
        code, receipt = self.run_unit(mode="refuse")
        self.assertEqual(code, 5)
        self.assertEqual(receipt["launch"]["exit_code"], 2)
        self.assertEqual(receipt["problems"], ["codex exited 2; read codex.log",
                                               "no final message was written"])
        self.assertIn("unknown profile", (self.out / "codex.log").read_text())

    def test_timeout_stops_the_whole_worker_process_group(self) -> None:
        code, receipt = self.run_unit("--timeout-seconds", "2", mode="hang")
        self.assertEqual(code, 4)
        self.assertEqual(receipt["status"], "timed_out")
        self.assertEqual(receipt["problems"][0], "no handback within 2 seconds")
        child_file = self.root / "child.pid"
        self.assertTrue(child_file.is_file(), "fake codex did not start its child within the bound")
        child = int(child_file.read_text())
        self.addCleanup(kill_leftover_group, child)
        self.assertTrue(process_gone(child))

    def test_interrupt_stops_the_worker_group_and_exits_130(self) -> None:
        env = self.env(mode="hang")
        worker = subprocess.Popen([sys.executable, str(self.bin / "monash-worker"), "run", "--brief",
                                   str(self.brief), "--out", str(self.out), "--cwd", str(self.cwd)],
                                  env=env, stdout=subprocess.PIPE, text=True)
        child_file = self.root / "child.pid"
        deadline = time.monotonic() + 30
        while not child_file.is_file() and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertTrue(child_file.is_file(), "fake codex never started its child")
        self.addCleanup(kill_leftover_group, int(child_file.read_text()))
        worker.send_signal(signal.SIGINT)
        stdout, _ = worker.communicate(timeout=60)
        self.assertEqual(worker.returncode, 130)
        self.assertEqual(json.loads(stdout)["status"], "interrupted")
        self.assertTrue(process_gone(int(child_file.read_text())))

    def test_codex_missing_from_path_fails_with_a_receipt(self) -> None:
        (self.bin / "codex").unlink()
        code, receipt = self.run_unit(message="HANDBACK: done")
        self.assertEqual(code, 5)
        self.assertEqual(receipt["problems"][0], "codex did not start: codex is not on PATH")
        self.assertIsNone(receipt["launch"]["exit_code"])

    def test_brief_that_is_not_utf8_is_refused_before_launch(self) -> None:
        self.brief.write_bytes(b"\xff\xfe brief")
        code, receipt = self.run_unit(message="HANDBACK: done")
        self.assertEqual(code, 2)
        self.assertIn("is not UTF-8 text", receipt["message"])
        self.assertFalse(self.log.exists())

    def test_out_directory_with_results_is_refused_before_launch(self) -> None:
        self.out.mkdir()
        (self.out / "last-message.md").write_text("earlier unit\n")
        code, receipt = self.run_unit(message="HANDBACK: done")
        self.assertEqual(code, 2)
        self.assertEqual(receipt["status"], "usage")
        self.assertFalse(self.log.exists())
        self.assertEqual((self.out / "last-message.md").read_text(), "earlier unit\n")

    def test_prepare_writes_a_pane_prompt_that_names_the_handback_file(self) -> None:
        code, result = self.worker("prepare", "--brief", str(self.brief), "--out", str(self.out))
        self.assertEqual(code, 0)
        prompt = (self.out / "prompt.md").read_text()
        self.assertTrue(prompt.startswith("Count the files in this directory.\n"))
        self.assertIn(f"- Also write the complete final message to {self.out / 'last-message.md'}", prompt)
        self.assertEqual(result["send"], f"Read {self.out / 'prompt.md'} and do exactly what it says.")
        self.assertFalse(self.log.exists())

    def test_check_keeps_a_recorded_timeout_after_a_late_handback(self) -> None:
        code, _ = self.run_unit("--timeout-seconds", "2", mode="hang")
        self.assertEqual(code, 4)
        child_file = self.root / "child.pid"
        if child_file.is_file():  # Only cleanup needs the child; the claim is about the receipt.
            self.addCleanup(kill_leftover_group, int(child_file.read_text()))
        (self.out / "last-message.md").write_text("Finished late.\nHANDBACK: done\n")
        code, receipt = self.worker("check", "--out", str(self.out))
        self.assertEqual(code, 4)
        self.assertEqual(receipt["status"], "timed_out")
        self.assertEqual(json.loads((self.out / "receipt.json").read_text())["status"], "timed_out")

    def test_check_reuses_the_recorded_model_when_none_is_given(self) -> None:
        code, _ = self.run_unit("--model", "gpt-5.5", message="HANDBACK: done", route_model="gpt-5.5")
        self.assertEqual(code, 0)
        code, receipt = self.worker("check", "--out", str(self.out))
        self.assertEqual(code, 0)
        self.assertEqual(receipt["requested_model"], "gpt-5.5")

    def test_check_refuses_a_malformed_launch_record(self) -> None:
        self.out.mkdir()
        (self.out / "last-message.md").write_text("HANDBACK: done\n")
        (self.out / "receipt.json").write_text(json.dumps({"launch": {}}))
        code, receipt = self.worker("check", "--out", str(self.out))
        self.assertEqual(code, 2)
        self.assertIn("malformed launch record", receipt["message"])

    def test_check_refuses_a_receipt_path_that_is_a_directory(self) -> None:
        self.out.mkdir()
        (self.out / "last-message.md").write_text("HANDBACK: done\n")
        (self.out / "receipt.json").mkdir()
        code, receipt = self.worker("check", "--out", str(self.out))
        self.assertEqual(code, 2)
        self.assertIn("is not a readable receipt", receipt["message"])

    def fan_out_example(self, out: Path, briefs: tuple[str, ...]) -> subprocess.CompletedProcess[str]:
        """Run the fan-out block from workers.md as written, with `monash-worker` on PATH."""
        text = WORKERS_DOC.read_text(encoding="utf-8")
        start = text.index("monash-worker run --pane --brief a.md")
        block = text[text.rindex("```sh", 0, start) + len("```sh"):text.index("```", start)]
        script = "\n".join(line.strip() for line in block.strip().splitlines())
        for name in briefs:
            (self.root / name).write_text("Count the files.\n", encoding="utf-8")
        # Run the example's `monash-worker` on the suite's qualified interpreter, as other tests do.
        shim_dir = self.root / "shim"
        shim_dir.mkdir()
        shim = shim_dir / "monash-worker"
        shim.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{self.bin / "monash-worker"}" "$@"\n')
        shim.chmod(0o755)
        env = self.env(message="Two files.\nHANDBACK: done\n", path_first=f"{shim_dir}{os.pathsep}",
                       extra_env={"OUT": str(out), "REPO": str(self.cwd)})
        return subprocess.run(["sh", "-c", script], cwd=self.root, env=env, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True, timeout=60)

    def test_documented_fan_out_example_runs_with_a_missing_out_parent(self) -> None:
        out = self.root / "not-yet" / "workers"
        result = self.fan_out_example(out, ("a.md", "b.md"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sum(call["argv"][2:4] == ["tab", "create"] for call in self.herdr_calls()), 2)
        self.assertEqual(result.stderr, "")
        for unit in ("a", "b"):
            self.assertEqual(json.loads((out / unit / "receipt.json").read_text())["status"], "done")

    def test_check_judges_a_pane_worker_handback(self) -> None:
        self.out.mkdir()
        (self.out / "last-message.md").write_text("Read two files.\nHANDBACK: done\n")
        code, receipt = self.worker("check", "--out", str(self.out))
        self.assertEqual(code, 0)
        self.assertEqual(receipt["status"], "done")
        self.assertIsNone(receipt["launch"])
        self.assertTrue((self.out / "receipt.json").is_file())

    def test_check_fails_an_empty_pane_handback(self) -> None:
        self.out.mkdir()
        code, receipt = self.worker("check", "--out", str(self.out))
        self.assertEqual(code, 5)
        self.assertEqual(receipt["problems"], ["no final message was written"])


    def test_documented_fan_out_example_reports_a_failed_unit(self) -> None:
        result = self.fan_out_example(self.root / "workers", ("a.md",))  # b.md is missing
        self.assertIn("unit b exited 2", result.stderr)


    def herdr_calls(self) -> list[list[str]]:
        if not self.herdr_log.exists():
            return []
        return [json.loads(line) for line in self.herdr_log.read_text().splitlines()]

    def test_pane_run_opens_an_unfocused_tab_and_writes_the_exec_receipt(self) -> None:
        code, receipt = self.run_unit("--pane", message="Three files.\nHANDBACK: done\n")
        self.assertEqual(code, 0, receipt)
        self.assertEqual(receipt["status"], "done")
        self.assertEqual({key: receipt["route"][key] for key in ("model", "provider", "service_tier", "effort")},
                         {"model": "gpt-6.1-sol", "provider": "monash_foundry", "service_tier": "priority",
                          "effort": "high"})
        self.assertEqual(receipt["thread_id"], "thread-fixture-1")
        self.assertEqual(receipt["launch"]["shape"], "pane")
        self.assertEqual(receipt["launch"]["herdr"], {"session": "default", "tab": "w9:t1", "pane": "w9:p1"})
        calls = self.herdr_calls()
        # Independent oracle: the Herdr calls a visible, unfocused, closed-after-capture worker needs.
        self.assertEqual([call["argv"][:4] for call in calls], [
            ["--session", "default", "status", "--json"],
            ["--session", "default", "tab", "create"],
            ["--session", "default", "pane", "process-info"],
            ["--session", "default", "pane", "run"],
            ["--session", "default", "tab", "close"]])
        create = calls[1]["argv"]
        self.assertIn("--no-focus", create)
        self.assertEqual(create[create.index("--label") + 1], "sol: out")
        self.assertEqual(calls[2]["argv"][5], "w9:p1")
        self.assertEqual(calls[3]["argv"][4], "w9:p1")
        self.assertEqual(calls[4]["argv"][4], "w9:t1")
        self.assertTrue(calls[4]["handback_present"])
        argv = json.loads(self.log.read_text())["argv"]
        self.assertNotIn("--json", argv)
        self.assertEqual(argv[:3], ["exec", "--profile", "monash-sol"])

    def test_pane_worker_gets_only_the_allowlisted_environment(self) -> None:
        code, _ = self.run_unit("--pane", message="HANDBACK: done")
        self.assertEqual(code, 0)
        names = set(json.loads(self.log.read_text())["env_names"])
        self.assertNotIn("PANE_SHELL_SECRET", names)
        self.assertIn("CODEX_HOME", names)
        # The pane's own SSH_CONNECTION reaches the 1Password wrapper, as the launcher route forwards it.
        self.assertIn("SSH_CONNECTION", names)

    def test_pane_run_with_a_wrong_provider_fails(self) -> None:
        code, receipt = self.run_unit("--pane", message="HANDBACK: done", extra_env={"FAKE_PROVIDER": "openai"})
        self.assertEqual(code, 5)
        self.assertEqual(receipt["problems"], ["route used provider openai, not monash_foundry"])

    def test_pane_run_refuses_without_a_running_herdr_session(self) -> None:
        code, receipt = self.run_unit("--pane", message="HANDBACK: done", extra_env={"FAKE_HERDR_RUNNING": False})
        self.assertEqual(code, 2)
        self.assertIn("no Herdr session 'default' is running", receipt["message"])
        self.assertIn("start Herdr", receipt["message"])
        self.assertEqual([call["argv"][2] for call in self.herdr_calls()], ["status"])
        self.assertFalse(self.out.exists())
        self.assertFalse(self.log.exists())

    def test_pane_run_refuses_without_herdr_on_path(self) -> None:
        (self.bin / "herdr").unlink()
        code, receipt = self.run_unit("--pane", message="HANDBACK: done")
        self.assertEqual(code, 2)
        self.assertIn("herdr is not on PATH", receipt["message"])
        self.assertFalse(self.out.exists())

    def test_pane_timeout_stops_the_worker_group_and_closes_the_tab(self) -> None:
        code, receipt = self.run_unit("--pane", "--timeout-seconds", "3", mode="hang")
        self.assertEqual(code, 4)
        self.assertEqual(receipt["status"], "timed_out")
        child_file = self.root / "child.pid"
        self.assertTrue(child_file.is_file(), "fake codex did not start its child within the bound")
        child = int(child_file.read_text())
        self.addCleanup(kill_leftover_group, child)
        self.assertTrue(process_gone(child))
        self.assertEqual(self.herdr_calls()[-1]["argv"][2:4], ["tab", "close"])


    def test_pane_worker_sees_its_own_pane_not_the_callers(self) -> None:
        code, _ = self.run_unit("--pane", message="HANDBACK: done",
                                extra_env={"HERDR_PANE_ID": "w1:p1", "HERDR_SESSION": "coordinator"})
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(self.log.read_text())["herdr_pane"], "w9:p1")

    def test_pane_out_name_cannot_inject_shell(self) -> None:
        self.out = self.root / "unit\ntouch $HOME/INJECTED\n#"
        code, receipt = self.run_unit("--pane", message="HANDBACK: done")
        self.assertEqual(code, 0, receipt)
        self.assertFalse((self.home / "INJECTED").exists())

    def test_pane_herdr_call_that_hangs_still_writes_a_receipt_within_the_bound(self) -> None:
        started = time.monotonic()
        code, receipt = self.run_unit("--pane", "--timeout-seconds", "2", message="HANDBACK: done",
                                      extra_env={"FAKE_HERDR_HANG_ON_CREATE": True})
        self.assertLess(time.monotonic() - started, 15)
        self.assertEqual(code, 5)
        self.assertEqual(receipt["problems"][0], "codex did not start: herdr tab create timed out")

    def test_pane_run_that_times_out_after_starting_the_worker_stops_it(self) -> None:
        code, receipt = self.run_unit("--pane", "--timeout-seconds", "2", mode="hang",
                                      extra_env={"FAKE_HERDR_RUN_RETURNS_AFTER": 5})
        self.assertEqual(code, 5)
        self.assertEqual(receipt["problems"][0],
                         "codex did not start: herdr pane run timed out; the worker had started and was stopped")
        child_file = self.root / "child.pid"
        self.assertTrue(child_file.is_file(), "fake codex did not start its child")
        child = int(child_file.read_text())
        self.addCleanup(kill_leftover_group, child)
        self.assertTrue(process_gone(child))

    def test_pane_whose_shell_is_not_ready_gets_no_command(self) -> None:
        code, receipt = self.run_unit("--pane", "--timeout-seconds", "2", message="HANDBACK: done",
                                      extra_env={"FAKE_HERDR_SHELL_BUSY": True})
        self.assertEqual(code, 5)
        self.assertEqual(receipt["problems"][0], "codex did not start: the pane's shell was not ready")
        self.assertNotIn("run", [call["argv"][3] for call in self.herdr_calls()])


if __name__ == "__main__":
    unittest.main()
