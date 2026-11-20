"""Public-process proof for `monash-worker`.

Each case copies the real script beside a fake `monash-foundry`, runs it as a
process, and reads its exit code, stdout receipt, and files. Expected values
are literals owned by this file.

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
import tempfile
import unittest


SOURCE_DIR = Path(__file__).resolve().parent

# The fake launcher's behaviour comes from FAKE_MODE; it records argv and stdin.
FAKE_FOUNDRY = """#!/usr/bin/env python3
import json, os, subprocess, sys, time
from pathlib import Path
log = Path(os.environ['WORKER_TEST_LOG'])
log.write_text(json.dumps({'argv': sys.argv[1:], 'stdin': sys.stdin.read()}))
mode = os.environ['FAKE_MODE']
argv = sys.argv[1:]
out = Path(argv[argv.index('-o') + 1])
model = os.environ.get('FAKE_ROUTE_MODEL', 'gpt-6.1-sol')
print(os.environ.get('FAKE_ROUTE_LINE') or 'host=Mac agent=codex provider=Monash Foundry Azure Responses '
      f'deployment={model} model={model}', file=sys.stderr)
print(json.dumps({'type': 'thread.started', 'thread_id': 'thread-fixture-1'}))
if mode == 'hang':
    child = subprocess.Popen(['sleep', '600'])
    Path(os.environ['WORKER_TEST_CHILD']).write_text(str(child.pid))
    time.sleep(600)
if mode == 'refuse':
    print('monash-foundry: Codex native --config and -c overrides are reserved', file=sys.stderr)
    raise SystemExit(2)
print(json.dumps({'type': 'turn.completed', 'usage': {'output_tokens': 7}}))
out.write_text(os.environ['FAKE_MESSAGE'])
"""


class MonashWorkerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="monash-worker-test-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        shutil.copy2(SOURCE_DIR / "monash-worker", self.bin / "monash-worker")
        fake = self.bin / "monash-foundry"
        fake.write_text(FAKE_FOUNDRY, encoding="utf-8")
        fake.chmod(0o755)
        self.cwd = self.root / "repo"
        self.cwd.mkdir()
        self.brief = self.root / "brief.md"
        self.brief.write_text("Count the files in this directory.\n", encoding="utf-8")
        self.out = self.root / "out"
        self.log = self.root / "launcher-call.json"

    def worker(self, *args: str, mode: str = "ok", message: str = "", route_model: str = "gpt-6.1-sol",
               extra_env: dict[str, str] | None = None) -> tuple[int, dict[str, object]]:
        env = dict(os.environ, WORKER_TEST_LOG=str(self.log), FAKE_MODE=mode, FAKE_MESSAGE=message,
                   FAKE_ROUTE_MODEL=route_model, WORKER_TEST_CHILD=str(self.root / "child.pid"))
        env.update(extra_env or {})
        result = subprocess.run([sys.executable, str(self.bin / "monash-worker"), *args], env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60)
        return result.returncode, json.loads(result.stdout)

    def run_unit(self, **kwargs: object) -> tuple[int, dict[str, object]]:
        extra = list(kwargs.pop("extra_args", ()))  # type: ignore[arg-type]
        return self.worker("run", "--brief", str(self.brief), "--out", str(self.out),
                           "--cwd", str(self.cwd), *extra, **kwargs)  # type: ignore[arg-type]

    def test_done_handback_passes_and_launch_uses_the_monash_exec_route(self) -> None:
        code, receipt = self.run_unit(message="Three files.\nHANDBACK: done\n")
        self.assertEqual(code, 0)
        self.assertEqual(receipt["status"], "done")
        self.assertEqual(receipt["problems"], [])
        self.assertEqual(receipt["thread_id"], "thread-fixture-1")
        self.assertEqual(receipt["route"]["model"], "gpt-6.1-sol")
        call = json.loads(self.log.read_text())
        self.assertEqual(call["argv"], [
            "launch", "--model", "gpt-6.1-sol", "--agent", "codex", "--",
            "exec", "-c", "model_reasoning_effort=high", "-s", "read-only",
            "-C", str(self.cwd), "--skip-git-repo-check", "--json",
            "-o", str(self.out / "last-message.md"), "-"])
        self.assertTrue(call["stdin"].startswith("Count the files in this directory.\n"))
        self.assertIn("HANDBACK: blocked: <one-line reason>", call["stdin"])
        self.assertEqual(json.loads((self.out / "receipt.json").read_text()), receipt)

    def test_effort_and_sandbox_reach_the_launcher(self) -> None:
        self.run_unit(message="HANDBACK: done", extra_args=("--effort", "medium", "--sandbox", "workspace-write"))
        argv = json.loads(self.log.read_text())["argv"]
        self.assertIn("model_reasoning_effort=medium", argv)
        self.assertEqual(argv[argv.index("-s") + 1], "workspace-write")

    def test_blocked_handback_exits_three_with_its_reason(self) -> None:
        code, receipt = self.run_unit(message="Needs GitHub.\nHANDBACK: blocked: no network in the sandbox\n")
        self.assertEqual(code, 3)
        self.assertEqual(receipt["status"], "blocked")
        self.assertEqual(receipt["handback"], {"status": "blocked", "reason": "no network in the sandbox"})

    def test_message_without_handback_line_fails(self) -> None:
        code, receipt = self.run_unit(message="This content can't be shown.")
        self.assertEqual(code, 5)
        self.assertEqual(receipt["problems"], ["final message has no HANDBACK line"])

    def test_route_on_another_model_fails_even_with_a_done_handback(self) -> None:
        code, receipt = self.run_unit(message="HANDBACK: done", route_model="gpt-5.5")
        self.assertEqual(code, 5)
        self.assertEqual(receipt["problems"], ["route ran gpt-5.5, not the requested gpt-6.1-sol"])

    def test_route_line_with_resource_and_qualification_is_read_by_stable_model(self) -> None:
        line = ("host=Mac agent=codex provider=Monash Foundry Azure Responses deployment=sol-deploy-2 "
                "resource=example-resource model=gpt-6.1-sol qualification=explicit")
        code, receipt = self.run_unit(message="HANDBACK: done", extra_env={"FAKE_ROUTE_LINE": line})
        self.assertEqual(code, 0)
        self.assertEqual(receipt["route"], {"agent": "codex", "provider": "Monash Foundry Azure Responses",
                                            "deployment": "sol-deploy-2", "model": "gpt-6.1-sol"})

    def test_launcher_refusal_fails_with_its_exit_code(self) -> None:
        code, receipt = self.run_unit(mode="refuse")
        self.assertEqual(code, 5)
        self.assertEqual(receipt["launch"]["exit_code"], 2)
        self.assertEqual(receipt["problems"], ["launcher exited 2; read launcher.log",
                                               "no final message was written"])
        self.assertIn("reserved", (self.out / "launcher.log").read_text())

    def test_timeout_stops_the_whole_worker_process_group(self) -> None:
        code, receipt = self.run_unit(mode="hang", extra_args=("--timeout-seconds", "2"))
        self.assertEqual(code, 4)
        self.assertEqual(receipt["status"], "timed_out")
        self.assertEqual(receipt["problems"][0], "no handback within 2 seconds")
        child = int((self.root / "child.pid").read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(child, 0)

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


if __name__ == "__main__":
    unittest.main()
