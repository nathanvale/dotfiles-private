"""Public-process proof for the Monash SSH remote-helper backend.

The fixture owns every expected remote response and command shape. It does
not import the module under test or derive expected results from it. Only
``ssh`` is faked: the real ssh client concatenates its trailing arguments
into one remote shell command, so the fake below shlex-splits that one
string back into the argv the module built and dispatches like the real
Herdr session and remote shell would.

Run:
    python3 -m unittest discover -s scripts/foundry -p 'test_monash_remote.py' -v
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest


SOURCE_DIR = Path(__file__).resolve().parent


FAKE_SSH = """#!/usr/bin/env python3
import json
import os
import re
import shlex
import sys
import time
from pathlib import Path

log = Path(os.environ['MONASH_TEST_LOG'])
state_path = Path(os.environ['MONASH_TEST_STATE'])
try:
    state = json.loads(state_path.read_text(encoding='utf-8'))
except FileNotFoundError:
    state = {'agent_started': False, 'prompted': False, 'expected_shim': ''}


def save_state():
    state_path.write_text(json.dumps(state), encoding='utf-8')


def respond(result):
    print(json.dumps({'result': result}))


alias = sys.argv[-2]
command_string = sys.argv[-1]
parts = shlex.split(command_string)
log.open('a', encoding='utf-8').write(json.dumps({'program': 'ssh', 'alias': alias, 'parts': parts}) + '\\n')

if os.environ.get('MONASH_TEST_TRANSPORT_FAIL') == '1':
    raise SystemExit(255)

if parts[:2] == ['test', '-x']:
    path = parts[2]
    if path == os.environ.get('MONASH_TEST_HERDR_EXECUTABLE') and os.environ.get('MONASH_TEST_HERDR_NOT_EXECUTABLE') == '1':
        raise SystemExit(1)
    if path == os.environ.get('MONASH_TEST_FOUNDRY_EXECUTABLE') and os.environ.get('MONASH_TEST_FOUNDRY_NOT_EXECUTABLE') == '1':
        raise SystemExit(1)
    raise SystemExit(0)

if parts[:2] == ['test', '-d']:
    raise SystemExit(1 if os.environ.get('MONASH_TEST_CWD_MISSING') == '1' else 0)

if parts == ['/bin/hostname']:
    print(os.environ.get('MONASH_TEST_HOSTNAME', 'mini-test-host'))
    raise SystemExit(0)

if parts == ['printenv', 'HOME']:
    print(os.environ.get('MONASH_TEST_REMOTE_HOME', '/Users/server'))
    raise SystemExit(0)

if parts and parts[0] == os.environ.get('MONASH_TEST_FOUNDRY_EXECUTABLE') and '--dry-run' in parts:
    if os.environ.get('MONASH_TEST_FOUNDRY_PREFLIGHT_FAIL') == '1':
        sys.stderr.write('unrecognized launcher argument\\n')
        raise SystemExit(3)
    agent = os.environ.get('MONASH_TEST_AGENT_KIND', 'codex')
    model = os.environ.get('MONASH_TEST_MODEL', 'gpt-5.5')
    deployment = os.environ.get('MONASH_TEST_DEPLOYMENT', model)
    native = os.environ.get('MONASH_TEST_NATIVE_EXECUTABLE', '/usr/local/bin/codex')
    print(f'host=mini agent={agent} provider=test deployment={deployment} model={model}')
    print(f'native_cli={native} source=test')
    raise SystemExit(0)

herdr_exec = os.environ['MONASH_TEST_HERDR_EXECUTABLE']
herdr_session = os.environ['MONASH_TEST_HERDR_SESSION']
if not (parts[0] == herdr_exec and parts[1:3] == ['--session', herdr_session]):
    print(json.dumps({'error': 'unexpected fake ssh command', 'parts': parts}), file=sys.stderr)
    raise SystemExit(70)

herdr_args = parts[3:]


def agent_info():
    kind = os.environ.get('MONASH_TEST_KIND_OVERRIDE') or os.environ.get('MONASH_TEST_AGENT_KIND', 'codex')
    info = {
        'pane_id': os.environ.get('MONASH_TEST_PANE_OVERRIDE', 'remote-pane'),
        'tab_id': os.environ.get('MONASH_TEST_TAB_OVERRIDE', 'remote-tab'),
        'workspace_id': os.environ.get('MONASH_TEST_WORKSPACE_OVERRIDE', 'remote-ws'),
        'terminal_id': os.environ.get('MONASH_TEST_TERMINAL_OVERRIDE', 'remote-term'),
        'agent': kind,
        'agent_status': os.environ.get('MONASH_TEST_AGENT_STATUS', 'idle'),
        'cwd': os.environ.get('MONASH_TEST_CWD_OVERRIDE') or os.environ['MONASH_TEST_EXPECTED_CWD'],
        'interactive_ready': os.environ.get('MONASH_TEST_INTERACTIVE_READY', '1') == '1',
        'focused': False,
        'revision': 1,
    }
    if os.environ.get('MONASH_TEST_PROMPT_STALLED') == '1':
        try:
            prompt_session_after_gets = int(os.environ.get('MONASH_TEST_PROMPT_SESSION_AFTER_GETS', '2'))
        except ValueError:
            prompt_session_after_gets = 2
        session_ready = (state.get('prompt_stalled_returned') is True
                         and state.get('prompt_observations', 0) >= prompt_session_after_gets)
    else:
        session_ready = os.environ.get('MONASH_TEST_SESSION_READY') == '1' or state.get('prompted')
    if session_ready:
        info['agent_session'] = {
            'source': os.environ.get('MONASH_TEST_SESSION_SOURCE_OVERRIDE', 'herdr:' + kind),
            'agent': os.environ.get('MONASH_TEST_SESSION_AGENT_OVERRIDE', kind),
            'kind': 'id',
            'value': os.environ.get('MONASH_TEST_SESSION_VALUE', 'native-remote-session-1'),
        }
    return info


if herdr_args[:2] == ['workspace', 'create']:
    respond({'root_pane': {
        'pane_id': os.environ.get('MONASH_TEST_PANE_OVERRIDE', 'remote-pane'),
        'tab_id': os.environ.get('MONASH_TEST_TAB_OVERRIDE', 'remote-tab'),
        'workspace_id': os.environ.get('MONASH_TEST_WORKSPACE_OVERRIDE', 'remote-ws'),
        'terminal_id': os.environ.get('MONASH_TEST_TERMINAL_OVERRIDE', 'remote-term'),
        'agent_status': 'idle', 'focused': False, 'revision': 1,
    }})
elif herdr_args[:2] == ['pane', 'run']:
    match = re.search(r'__MONASH_SHIM_OK__=(\\S+)', herdr_args[3])
    if match:
        state['expected_shim'] = match.group(1).rstrip(';')
        save_state()
    raise SystemExit(0)
elif herdr_args[:2] == ['pane', 'wait-output']:
    shim = state.get('expected_shim', '')
    if os.environ.get('MONASH_TEST_SHIM_MISMATCH') == '1':
        line = '__MONASH_SHIM_MISMATCH__=/opt/homebrew/bin/other'
    else:
        line = '__MONASH_SHIM_OK__=' + shim
    respond({'pane_id': herdr_args[2], 'matched_line': line})
elif herdr_args[:2] == ['agent', 'start']:
    state['agent_started'] = True
    save_state()
    if os.environ.get('MONASH_TEST_AGENT_STATUS') == 'blocked':
        print(json.dumps({'error': {'code': 'agent_not_ready'}}), file=sys.stderr)
        raise SystemExit(1)
    if os.environ.get('MONASH_TEST_START_TIMEOUT') == '1':
        print(json.dumps({'error': {'code': 'timeout'}}), file=sys.stderr)
        raise SystemExit(1)
    state['agent_start_completed_at'] = time.monotonic()
    save_state()
    respond({'agent': agent_info()})
elif herdr_args[:2] == ['agent', 'get']:
    if os.environ.get('MONASH_TEST_PROMPT_STALLED') == '1' and state.get('prompt_stalled_returned') is True:
        state['prompt_observations'] = state.get('prompt_observations', 0) + 1
        state_path.write_text(json.dumps(state), encoding='utf-8')
        try:
            prompt_get_delay_ms = int(os.environ.get('MONASH_TEST_PROMPT_GET_DELAY_MS', '0'))
        except ValueError:
            prompt_get_delay_ms = 0
        if prompt_get_delay_ms > 0:
            time.sleep(prompt_get_delay_ms / 1000)
    respond({'agent': agent_info()})
elif herdr_args[:2] == ['pane', 'process-info']:
    native = os.environ.get('MONASH_TEST_NATIVE_EXECUTABLE', '/usr/local/bin/codex')
    if os.environ.get('MONASH_TEST_PROCESS_WRONG_EXECUTABLE') == '1':
        native = os.environ.get('MONASH_TEST_OTHER_NATIVE_EXECUTABLE', '/usr/local/bin/other-native')
    deployment = os.environ.get('MONASH_TEST_DEPLOYMENT', os.environ.get('MONASH_TEST_MODEL', 'gpt-5.5'))
    agent_kind = os.environ.get('MONASH_TEST_AGENT_KIND', 'codex')
    argv = [native]
    if os.environ.get('MONASH_TEST_PROCESS_MISSING_MODEL_ARGV') != '1':
        if agent_kind == 'opencode':
            model_id = os.environ.get('MONASH_TEST_MODEL_ID', deployment)
            argv.extend(['--model', 'azure/' + model_id])
        elif agent_kind == 'claude':
            settings_default = os.environ.get('MONASH_TEST_SETTINGS_DEFAULT_DEPLOYMENT')
            if settings_default:
                argv.extend(['--settings', json.dumps({'env': {'ANTHROPIC_MODEL': settings_default}})])
            if os.environ.get('MONASH_TEST_PROCESS_SETTINGS_ONLY') != '1':
                argv.extend(['--model', deployment])
        else:
            argv.extend(['-c', 'model=' + json.dumps(deployment)])
    native_args_json = os.environ.get('MONASH_TEST_NATIVE_ARGS_JSON')
    native_args_list = json.loads(native_args_json) if native_args_json else []
    if os.environ.get('MONASH_TEST_PROCESS_ARGV_MISMATCH') == '1':
        native_args_list = list(reversed(native_args_list)) if native_args_list else ['--unexpected']
    argv.extend(native_args_list)
    process_cwd = os.environ.get('MONASH_TEST_PROCESS_CWD_OVERRIDE') or os.environ['MONASH_TEST_EXPECTED_CWD']
    respond({'process_info': {'foreground_processes': [{
        'pid': 4242, 'argv0': native, 'argv': argv, 'cwd': process_cwd,
    }]}})
elif herdr_args[:2] == ['agent', 'prompt']:
    state['prompt_calls'] = state.get('prompt_calls', 0) + 1
    if os.environ.get('MONASH_TEST_PROMPT_REQUIRES_SETTLE') == '1':
        try:
            settle_threshold_ms = float(os.environ.get('MONASH_TEST_PROMPT_SETTLE_THRESHOLD_MS', '500'))
        except ValueError:
            settle_threshold_ms = 500.0
        start_completed_at = state.get('agent_start_completed_at')
        elapsed = time.monotonic() - float(start_completed_at) if start_completed_at is not None else 0.0
        state['first_prompt_elapsed'] = elapsed
        if elapsed < settle_threshold_ms / 1000:
            state['early_prompt_rejected'] = True
            save_state()
            print(json.dumps({'error': {'code': 'agent_prompt_stalled'}}), file=sys.stderr)
            raise SystemExit(1)
    if os.environ.get('MONASH_TEST_PROMPT_STALLED') == '1':
        if state['prompt_calls'] > 1:
            state_path.write_text(json.dumps(state), encoding='utf-8')
            print(json.dumps({'error': {'code': 'agent_prompt_resubmitted'}}), file=sys.stderr)
            raise SystemExit(1)
        state['prompt_stalled_returned'] = True
        state['prompt_observations'] = 0
        state['prompted'] = True
        save_state()
        if os.environ.get('MONASH_TEST_PROMPT_STALL_WARNING') == '1':
            sys.stderr.write('Warning: multiplexed SSH control socket reused\\n')
        print(json.dumps({'error': {'code': 'agent_prompt_stalled'}}), file=sys.stderr)
        raise SystemExit(1)
    state['prompted'] = True
    save_state()
    respond({'agent': agent_info()})
elif herdr_args[:2] == ['agent', 'wait']:
    respond({'agent': agent_info()})
elif herdr_args[:2] == ['agent', 'read']:
    print('observed remote output')
else:
    print(json.dumps({'error': 'unexpected fake herdr argv', 'herdr_args': herdr_args}), file=sys.stderr)
    raise SystemExit(70)
"""


def test_config(remote_install_root: str, herdr_executable: str) -> dict[str, object]:
    """Independent host-profile oracle. `laptop` is intentionally local-only."""
    return {
        "host_profiles": {
            "laptop": {"transport": "local"},
            "mini": {
                "transport": "ssh",
                "ssh_alias": "mac-mini",
                "herdr_session": "monash-foundry",
                "remote_install_root": remote_install_root,
                "herdr_executable": herdr_executable,
                "path_mappings": [],
            },
        },
    }


class MonashRemoteProcessTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.bin_dir = self.root / "bin"
        self.bin_dir.mkdir()
        self.workdir = self.root / "local cwd"
        self.workdir.mkdir()
        self.state_home = self.root / "state-home"
        self.log_path = self.root / "calls.jsonl"
        self.fake_state = self.root / "fake-state.json"
        self.remote_install_root = "/Users/server/.local/share/monash-foundry"
        self.herdr_executable = "/opt/homebrew/bin/herdr"
        self.foundry_executable = f"{self.remote_install_root}/monash-foundry"
        self.config = self.root / "config.json"
        self.config.write_text(json.dumps(test_config(self.remote_install_root, self.herdr_executable)),
                               encoding="utf-8")
        self.module = self.root / "monash_remote.py"
        shutil.copyfile(SOURCE_DIR / "monash_remote.py", self.module)
        shutil.copyfile(SOURCE_DIR / "monash_hosts.py", self.root / "monash_hosts.py")
        (self.bin_dir / "ssh").write_text(FAKE_SSH, encoding="utf-8")
        for command in (self.module, self.bin_dir / "ssh"):
            command.chmod(0o700)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def environment(self, *, expected_cwd: str, **flags: object) -> dict[str, str]:
        env = os.environ.copy()
        env.update({
            "PATH": f"{self.bin_dir}{os.pathsep}{env['PATH']}",
            "XDG_STATE_HOME": str(self.state_home),
            "MONASH_TEST_LOG": str(self.log_path),
            "MONASH_TEST_STATE": str(self.fake_state),
            "MONASH_TEST_HERDR_EXECUTABLE": self.herdr_executable,
            "MONASH_TEST_FOUNDRY_EXECUTABLE": self.foundry_executable,
            "MONASH_TEST_HERDR_SESSION": "monash-foundry",
            "MONASH_TEST_EXPECTED_CWD": expected_cwd,
            "MONASH_TEST_NATIVE_ARGS_JSON": json.dumps(["--resume", "literal space"]),
        })
        for name, value in flags.items():
            if value is None:
                continue
            env[f"MONASH_TEST_{name.upper()}"] = str(value)
        return env

    def run_helper(self, *arguments: str, expected_cwd: str, **flags: object) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(self.module), "--config", str(self.config), "--host", "mini", *arguments],
            text=True, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            check=False, env=self.environment(expected_cwd=expected_cwd, **flags), cwd=self.root,
        )

    def calls(self) -> list[dict[str, object]]:
        if not self.log_path.exists():
            return []
        return [json.loads(line) for line in self.log_path.read_text(encoding="utf-8").splitlines()]

    def start_arguments(self, *, remote_cwd: str = "/Users/server/code/project", agent: str = "codex",
                        model: str = "gpt-5.5", run_id: str | None = None, qualification: bool = False,
                        native_args: tuple[str, ...] = ("--resume", "literal space")) -> list[str]:
        arguments = ["start", "--agent", agent, "--model", model, "--cwd", str(self.workdir),
                    "--remote-cwd", remote_cwd]
        if run_id is not None:
            arguments.extend(("--run-id", run_id))
        if qualification:
            arguments.append("--qualification")
        if native_args:
            arguments.extend(("--", *native_args))
        return arguments

    def start(self, *, remote_cwd: str = "/Users/server/code/project", agent: str = "codex", model: str = "gpt-5.5",
             run_id: str | None = None, qualification: bool = False,
             native_args: tuple[str, ...] = ("--resume", "literal space"), **flags: object):
        result = self.run_helper(*self.start_arguments(remote_cwd=remote_cwd, agent=agent, model=model,
                                                       run_id=run_id, qualification=qualification,
                                                       native_args=native_args),
                                 expected_cwd=remote_cwd, agent_kind=agent, model=model,
                                 native_args_json=json.dumps(list(native_args)), **flags)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    # --- start -------------------------------------------------------------

    def test_start_reaches_ready_with_session_tuple(self) -> None:
        receipt = self.start(session_ready="1")
        self.assertEqual(receipt["status"], "ready")
        self.assertEqual(receipt["profile_id"], "mini")
        self.assertEqual(receipt["transport"], "ssh")
        self.assertEqual(receipt["expected_cwd"], "/Users/server/code/project")
        self.assertEqual(receipt["expected_cwd_source"], "explicit_remote_cwd")
        self.assertEqual(receipt["observed_cwd"], "/Users/server/code/project")
        self.assertEqual(receipt["execution_host"], {
            "value": "mini-test-host", "source": "ssh+/bin/hostname",
            "observed_at": receipt["execution_host"]["observed_at"],
        })
        self.assertEqual(receipt["session_id"], "native-remote-session-1")
        self.assertEqual(
            receipt["attach_argv"],
            ["ssh", "-tt", "mac-mini", "/opt/homebrew/bin/herdr", "--session", "monash-foundry",
             "agent", "attach", receipt["agent_name"]],
        )
        self.assertNotIn("exec", receipt["attach_argv"])
        state_file = self.state_home / "monash" / "remote" / f"{receipt['run_id']}.json"
        self.assertTrue(state_file.is_file())
        persisted = json.loads(state_file.read_text(encoding="utf-8"))
        self.assertEqual(persisted["pane_id"], "remote-pane")
        self.assertEqual(persisted["agent_session"]["value"], "native-remote-session-1")

    def test_start_without_session_reports_started_not_ready(self) -> None:
        receipt = self.start()
        self.assertEqual(receipt["status"], "started")
        self.assertNotIn("session_id", receipt)

    def test_start_empty_session_value_is_not_a_complete_tuple(self) -> None:
        receipt = self.start(session_ready="1", session_value="")
        self.assertEqual(receipt["status"], "started")
        self.assertNotIn("session_id", receipt)

    def test_start_session_agent_mismatch_is_not_a_complete_tuple(self) -> None:
        receipt = self.start(session_ready="1", session_agent_override="claude")
        self.assertEqual(receipt["status"], "started")
        self.assertNotIn("session_id", receipt)

    def test_start_session_wrong_source_is_not_a_complete_tuple(self) -> None:
        receipt = self.start(session_ready="1", session_source_override="herdr:claude")
        self.assertEqual(receipt["status"], "started")
        self.assertNotIn("session_id", receipt)

    def test_native_args_forward_exactly_once(self) -> None:
        self.start()
        calls = self.calls()
        shim_write_call = next(call for call in calls
                               if tuple(call["parts"][3:5]) == ("pane", "run") and "mkdir -p" in call["parts"][6])
        start_call = next(call for call in calls if tuple(call["parts"][3:5]) == ("agent", "start"))
        literal = "literal space"
        shim_occurrences = shim_write_call["parts"][6].count(literal)
        start_occurrences = start_call["parts"].count(literal)
        self.assertEqual(shim_occurrences, 0, "native args must never be baked into the shim script")
        self.assertEqual(start_occurrences, 1, "agent start owns the sole, exactly-once native argv")
        self.assertEqual(shim_occurrences + start_occurrences, 1)

    def test_start_refuses_local_profile(self) -> None:
        result_laptop = subprocess.run(
            [sys.executable, str(self.module), "--config", str(self.config), "--host", "laptop",
             "start", "--agent", "codex", "--model", "gpt-5.5", "--cwd", str(self.workdir), "--remote-cwd", "/x"],
            text=True, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            check=False, env=self.environment(expected_cwd="/x"), cwd=self.root,
        )
        payload = json.loads(result_laptop.stdout)
        self.assertEqual(payload["status"], "refused")
        self.assertEqual(payload["error"]["code"], "host_profile_not_ssh")
        self.assertEqual(self.calls(), [], "a refused local-transport profile must never reach ssh")

    def test_start_refuses_unknown_profile(self) -> None:
        result = subprocess.run(
            [sys.executable, str(self.module), "--config", str(self.config), "--host", "nope",
             "start", "--agent", "codex", "--model", "gpt-5.5", "--cwd", str(self.workdir), "--remote-cwd", "/x"],
            text=True, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            check=False, env=self.environment(expected_cwd="/x"), cwd=self.root,
        )
        payload = json.loads(result.stdout)
        self.assertEqual(payload["error"]["code"], "unknown_host_profile")
        self.assertEqual(self.calls(), [])

    def test_start_uses_caller_supplied_run_id(self) -> None:
        caller_run_id = "0123456789abcdef0123456789abcdef"
        receipt = self.start(run_id=caller_run_id)
        self.assertEqual(receipt["run_id"], caller_run_id)
        self.assertEqual(receipt["agent_name"], f"monash-{caller_run_id[:8]}")
        state_file = self.state_home / "monash" / "remote" / f"{caller_run_id}.json"
        self.assertTrue(state_file.is_file())

    def test_start_refuses_malformed_run_id_before_any_remote_call(self) -> None:
        for malformed in ("too-short", "0123456789ABCDEF0123456789ABCDEF", "0" * 31, "0" * 33,
                         "not-hex-at-all-0000000000000000"):
            with self.subTest(malformed=malformed):
                result = self.run_helper(*self.start_arguments(run_id=malformed),
                                         expected_cwd="/Users/server/code/project")
                payload = json.loads(result.stdout)
                self.assertEqual(payload["status"], "refused")
                self.assertEqual(payload["error"]["code"], "invalid_run_id")
                self.assertEqual(result.returncode, 2)
                self.assertEqual(self.calls(), [], "a malformed run_id must be refused before any remote call")
                self.assertNotIn("run_id", payload)

    def test_start_forwards_qualification_to_dry_run_and_shim(self) -> None:
        self.start(qualification=True)
        calls = self.calls()
        preflight_call = next(call for call in calls if call["parts"][0] == self.foundry_executable)
        self.assertIn("--qualification", preflight_call["parts"])
        self.assertLess(preflight_call["parts"].index("--qualification"), preflight_call["parts"].index("--"))
        shim_write_call = next(call for call in calls
                               if tuple(call["parts"][3:5]) == ("pane", "run") and "mkdir -p" in call["parts"][6])
        self.assertIn("--qualification", shim_write_call["parts"][6])

    def test_start_omits_qualification_by_default(self) -> None:
        self.start()
        calls = self.calls()
        preflight_call = next(call for call in calls if call["parts"][0] == self.foundry_executable)
        self.assertNotIn("--qualification", preflight_call["parts"])
        shim_write_call = next(call for call in calls
                               if tuple(call["parts"][3:5]) == ("pane", "run") and "mkdir -p" in call["parts"][6])
        self.assertNotIn("--qualification", shim_write_call["parts"][6])

    def test_shim_strips_exact_generated_directory_prefix_from_path(self) -> None:
        """Recursion prevention now happens by removing the exact generated
        shim directory prefix from PATH inside the shim itself, refusing an
        unexpected shape rather than rediscovering the shim; the old
        HERDR_MONASH_SHIM_ACTIVE marker is gone."""
        self.start()
        shim_write_call = next(call for call in self.calls()
                               if tuple(call["parts"][3:5]) == ("pane", "run") and "mkdir -p" in call["parts"][6])
        script = shim_write_call["parts"][6]
        self.assertIn('case "$PATH" in', script)
        self.assertIn(":*)", script)
        self.assertIn("PATH=${PATH#", script)
        self.assertIn("Monash shim PATH shape unexpected", script)
        self.assertNotIn("HERDR_MONASH_SHIM_ACTIVE", script)

    def test_start_refuses_missing_remote_cwd_before_pane_creation(self) -> None:
        result = self.run_helper(*self.start_arguments(), expected_cwd="/Users/server/code/project",
                                 cwd_missing="1")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["status"], "refused")
        self.assertEqual(payload["error"]["code"], "remote_cwd_missing")
        calls = self.calls()
        self.assertEqual(len(calls), 4, "the two executable preflights and the foundry dry-run precede the cwd check")
        self.assertEqual(calls[0]["parts"][:2], ["test", "-x"])
        self.assertEqual(calls[1]["parts"][:2], ["test", "-x"])
        self.assertEqual(calls[2]["parts"][0], self.foundry_executable)
        self.assertIn("--dry-run", calls[2]["parts"])
        self.assertEqual(calls[3]["parts"][:2], ["test", "-d"])
        self.assertNotIn(("workspace", "create"), [tuple(c["parts"][3:5]) for c in calls if len(c["parts"]) > 4])
        self.assertNotIn("run_id", payload, "a pre-pane refusal must never fabricate a remote identity")
        self.assertNotIn("remote_identity", payload)

    def test_start_reports_herdr_executable_not_executable(self) -> None:
        result = self.run_helper(*self.start_arguments(), expected_cwd="/Users/server/code/project",
                                 herdr_not_executable="1")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["error"]["code"], "remote_herdr_executable_not_executable")
        calls = self.calls()
        self.assertEqual(len(calls), 1, "the herdr_executable preflight is the very first remote call")
        self.assertEqual(calls[0]["parts"][:3], ["test", "-x", self.herdr_executable])
        self.assertNotIn("run_id", payload, "a pre-pane refusal must never fabricate a remote identity")
        self.assertNotIn("remote_identity", payload)

    def test_start_reports_foundry_executable_not_executable(self) -> None:
        result = self.run_helper(*self.start_arguments(), expected_cwd="/Users/server/code/project",
                                 foundry_not_executable="1")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["error"]["code"], "remote_foundry_executable_not_executable")
        calls = self.calls()
        self.assertEqual(len(calls), 2, "the foundry preflight follows the herdr preflight, before any cwd check")
        self.assertEqual(calls[0]["parts"][:3], ["test", "-x", self.herdr_executable])
        self.assertEqual(calls[1]["parts"][:3], ["test", "-x", self.foundry_executable])
        self.assertNotIn("run_id", payload, "a pre-pane refusal must never fabricate a remote identity")
        self.assertNotIn("remote_identity", payload)

    def test_start_reports_foundry_preflight_failure(self) -> None:
        """Root's live Mini evidence: an older installed launcher rejects the
        selected route with a real exit code and stderr text. This must be
        caught before any workspace/tab/pane mutation, with zero remote pane
        effects and no fabricated recovery identity."""
        result = self.run_helper(*self.start_arguments(), expected_cwd="/Users/server/code/project",
                                 foundry_preflight_fail="1")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["status"], "refused")
        self.assertEqual(payload["error"]["code"], "remote_foundry_preflight_failed")
        self.assertIn("unrecognized launcher argument", payload["error"]["message"])
        calls = self.calls()
        self.assertEqual(len(calls), 3, "the foundry dry-run runs right after the two executable preflights")
        self.assertEqual(calls[0]["parts"][:2], ["test", "-x"])
        self.assertEqual(calls[1]["parts"][:2], ["test", "-x"])
        self.assertEqual(calls[2]["parts"][0], self.foundry_executable)
        self.assertNotIn(("workspace", "create"), [tuple(c["parts"][3:5]) for c in calls if len(c["parts"]) > 4])
        self.assertNotIn("run_id", payload, "a pre-pane refusal must never fabricate a remote identity")
        self.assertNotIn("remote_identity", payload)

    def test_start_foundry_preflight_argv_exact_with_native_args(self) -> None:
        self.start()
        preflight_call = next(call for call in self.calls() if call["parts"][0] == self.foundry_executable)
        self.assertEqual(preflight_call["parts"], [
            self.foundry_executable, "--config", f"{self.remote_install_root}/config.json",
            "--dry-run", "launch", "--model", "gpt-5.5", "--agent", "codex",
            "--", "--resume", "literal space",
        ])

    def test_start_foundry_preflight_argv_exact_with_zero_native_args(self) -> None:
        self.start(native_args=())
        preflight_call = next(call for call in self.calls() if call["parts"][0] == self.foundry_executable)
        self.assertEqual(preflight_call["parts"], [
            self.foundry_executable, "--config", f"{self.remote_install_root}/config.json",
            "--dry-run", "launch", "--model", "gpt-5.5", "--agent", "codex", "--",
        ])

    def test_start_foundry_preflight_runs_before_pane_creation(self) -> None:
        self.start()
        calls = self.calls()
        preflight_index = next(index for index, call in enumerate(calls) if call["parts"][0] == self.foundry_executable)
        workspace_index = next(index for index, call in enumerate(calls)
                               if len(call["parts"]) > 4 and tuple(call["parts"][3:5]) == ("workspace", "create"))
        self.assertEqual(preflight_index, 2, "the foundry dry-run is the third call, right after both executable checks")
        self.assertLess(preflight_index, workspace_index, "the dry-run must run before any pane-creating call")

    def test_start_reports_ssh_transport_failure(self) -> None:
        result = self.run_helper(*self.start_arguments(), expected_cwd="/Users/server/code/project",
                                 transport_fail="1")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["error"]["code"], "ssh_transport_failed")
        self.assertNotIn("run_id", payload, "a pre-pane refusal must never fabricate a remote identity")
        self.assertNotIn("remote_identity", payload)

    def test_start_reports_shim_resolution_failure(self) -> None:
        result = self.run_helper(*self.start_arguments(), expected_cwd="/Users/server/code/project",
                                 shim_mismatch="1")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["error"]["code"], "remote_shim_resolution_failed")
        self.assertEqual([tuple(call["parts"][3:5]) for call in self.calls()][-1], ("pane", "wait-output"))

    def test_start_shim_failure_persists_recovery_identity_without_agent_name(self) -> None:
        """A real remote pane exists once shim resolution fails, but the
        intended agent was never even attempted; recovery identity must
        expose the pane, never a claimed actual agent or session."""
        result = self.run_helper(*self.start_arguments(), expected_cwd="/Users/server/code/project",
                                 shim_mismatch="1")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["error"]["code"], "remote_shim_resolution_failed")
        self.assertIn("run_id", payload)
        run_id = payload["run_id"]
        label = f"monash-{run_id[:8]}"

        remote_identity = payload["remote_identity"]
        self.assertEqual(remote_identity["intended_agent_name"], label)
        self.assertNotIn("agent_name", remote_identity, "a label is metadata, never claimed lifecycle truth")
        self.assertNotIn("agent_session", remote_identity)
        self.assertEqual(remote_identity["pane_id"], "remote-pane")
        self.assertEqual(remote_identity["tab_id"], "remote-tab")
        self.assertEqual(remote_identity["workspace_id"], "remote-ws")
        self.assertEqual(remote_identity["terminal_id"], "remote-term")
        self.assertEqual(remote_identity["profile_id"], "mini")
        self.assertEqual(remote_identity["expected_cwd"], "/Users/server/code/project")
        self.assertNotIn("observation", payload,
                         "shim failure occurs before any agent get; no fabricated observation")

        state_file = self.state_home / "monash" / "remote" / f"{run_id}.json"
        persisted = json.loads(state_file.read_text(encoding="utf-8"))
        self.assertEqual(persisted["intended_agent_name"], label)
        self.assertNotIn("agent_name", persisted)
        self.assertNotIn("agent_session", persisted)

        calls = self.calls()
        self.assertEqual([tuple(c["parts"][3:5]) for c in calls].count(("agent", "start")), 0,
                         "shim failure occurs before agent start is ever attempted")

    def test_start_reports_blocked_native_agent(self) -> None:
        result = self.run_helper(*self.start_arguments(), expected_cwd="/Users/server/code/project",
                                 agent_status="blocked")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["error"]["code"], "remote_agent_blocked")

    def test_start_blocked_after_pane_creation_persists_promoted_recovery_identity(self) -> None:
        """A blocked startup still proves the intended agent name resolves to
        the expected pane/kind/cwd; the label is promoted to agent_name, and
        the fresh observed kind/cwd/status are recorded, without treating any
        of it as success or inventing a session."""
        result = self.run_helper(*self.start_arguments(), expected_cwd="/Users/server/code/project",
                                 agent_status="blocked")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["error"]["code"], "remote_agent_blocked")
        run_id = payload["run_id"]
        label = f"monash-{run_id[:8]}"

        remote_identity = payload["remote_identity"]
        self.assertEqual(remote_identity["agent_name"], label)
        self.assertNotIn("intended_agent_name", remote_identity)
        self.assertNotIn("agent_session", remote_identity, "blocked startup must never invent a session")

        observation = payload["observation"]
        self.assertEqual(observation["agent"], "codex")
        self.assertEqual(observation["agent_status"], "blocked")
        self.assertEqual(observation["cwd"], "/Users/server/code/project")

        state_file = self.state_home / "monash" / "remote" / f"{run_id}.json"
        persisted = json.loads(state_file.read_text(encoding="utf-8"))
        self.assertEqual(persisted["agent_name"], label)
        self.assertNotIn("agent_session", persisted)

        calls = self.calls()
        self.assertEqual([tuple(c["parts"][3:5]) for c in calls].count(("agent", "start")), 1,
                         "exactly one remote start attempt; a blocked startup must never be retried")

    def test_start_timeout_after_pane_creation_persists_promoted_recovery_identity(self) -> None:
        """A managed-start timeout where the agent nonetheless answers `agent
        get` must promote the recovery identity the same way, reporting
        `remote_native_not_ready` rather than any success."""
        result = self.run_helper(*self.start_arguments(), expected_cwd="/Users/server/code/project",
                                 start_timeout="1")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["error"]["code"], "remote_native_not_ready")
        run_id = payload["run_id"]
        label = f"monash-{run_id[:8]}"

        remote_identity = payload["remote_identity"]
        self.assertEqual(remote_identity["agent_name"], label)
        self.assertNotIn("intended_agent_name", remote_identity)
        self.assertNotIn("agent_session", remote_identity, "an unready startup must never invent a session")

        observation = payload["observation"]
        self.assertEqual(observation["agent"], "codex")
        self.assertEqual(observation["agent_status"], "idle")
        self.assertEqual(observation["cwd"], "/Users/server/code/project")

        calls = self.calls()
        self.assertEqual([tuple(c["parts"][3:5]) for c in calls].count(("agent", "start")), 1,
                         "exactly one remote start attempt; a managed-start timeout must never be retried")

    def test_start_verifies_correct_native_process(self) -> None:
        """The default fake foreground process matches the dry-run's
        disclosed native executable and model-bearing argv; this is the
        control proving the check actually runs and passes on a genuine
        match, not merely that it is skipped."""
        receipt = self.start(session_ready="1")
        self.assertEqual(receipt["status"], "ready")
        calls = self.calls()
        process_info_call = next(call for call in calls if tuple(call["parts"][3:5]) == ("pane", "process-info"))
        self.assertIn("--pane", process_info_call["parts"])

    def test_start_refuses_wrong_foreground_executable(self) -> None:
        """A label or agent-kind metadata alone is insufficient: Herdr may
        report the intended kind while the real OS process is something
        else entirely (e.g. a stale shim or an unrelated binary)."""
        result = self.run_helper(*self.start_arguments(), expected_cwd="/Users/server/code/project",
                                 process_wrong_executable="1")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["error"]["code"], "remote_native_process_unverified")
        self.assertIn("run_id", payload)
        self.assertIn("agent_name", payload["remote_identity"],
                      "Herdr's own metadata still matched, so the name is still promoted")

    def test_start_refuses_missing_model_argv(self) -> None:
        """The correct binary running with no model-bearing argv at all must
        still be refused: proximity to the right executable is not proof of
        the right route."""
        result = self.run_helper(*self.start_arguments(), expected_cwd="/Users/server/code/project",
                                 process_missing_model_argv="1")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["error"]["code"], "remote_native_process_model_mismatch")
        self.assertIn("run_id", payload)

    def test_start_refuses_reordered_native_args(self) -> None:
        """The correct executable with the correct model-bearing argv but a
        reordered or dropped native-args tail must still be refused: the
        suffix must match exactly and in order, not merely contain the same
        values."""
        result = self.run_helper(*self.start_arguments(), expected_cwd="/Users/server/code/project",
                                 process_argv_mismatch="1")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["error"]["code"], "remote_native_process_argv_mismatch")
        self.assertIn("run_id", payload)

    def test_start_verifies_native_args_with_spaces_dashes_and_shell_looking_literals(self) -> None:
        """Every literal travels as the exact same string end to end; never
        re-parsed or shell-evaluated. A real shell would expand `$(id)` or
        split on the embedded space; an exact string comparison does not."""
        exotic_args = ("--resume", "literal space", "-x", "$(id)", "`whoami`", "--flag=value;rm -rf /")
        receipt = self.start(native_args=exotic_args, session_ready="1")
        self.assertEqual(receipt["status"], "ready")
        calls = self.calls()
        start_call = next(call for call in calls if tuple(call["parts"][3:5]) == ("agent", "start"))
        self.assertEqual(tuple(start_call["parts"][-len(exotic_args):]), exotic_args)

    def test_start_verifies_exact_claude_model_when_settings_name_another_default(self) -> None:
        receipt = self.start(
            agent="claude",
            model="claude-sonnet-4-6",
            session_ready="1",
            deployment="claude-sonnet-4-6",
            native_executable="/usr/local/bin/claude",
            settings_default_deployment="claude-sonnet-5",
        )
        self.assertEqual(receipt["status"], "ready")

    def test_start_refuses_claude_settings_without_exact_model_argument(self) -> None:
        result = self.run_helper(
            *self.start_arguments(agent="claude", model="claude-sonnet-4-6"),
            expected_cwd="/Users/server/code/project",
            agent_kind="claude",
            model="claude-sonnet-4-6",
            deployment="claude-sonnet-4-6",
            native_executable="/usr/local/bin/claude",
            settings_default_deployment="claude-sonnet-4-6",
            process_settings_only="1",
        )
        payload = json.loads(result.stdout)
        self.assertEqual(payload["error"]["code"], "remote_native_process_model_mismatch")
        self.assertIn("run_id", payload)

    # --- get / prompt / wait against a stored identity ----------------------

    def test_get_reports_ready_once_session_appears(self) -> None:
        receipt = self.start()
        result = self.run_helper("get", "--run-id", receipt["run_id"],
                                 expected_cwd="/Users/server/code/project", session_ready="1")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["status"], "ready")
        self.assertEqual(payload["session_id"], "native-remote-session-1")
        state_file = self.state_home / "monash" / "remote" / f"{receipt['run_id']}.json"
        persisted = json.loads(state_file.read_text(encoding="utf-8"))
        self.assertEqual(persisted["agent_session"]["value"], "native-remote-session-1",
                         "the first authoritative complete observation must be pinned to disk atomically")

    def test_get_refuses_observed_cwd_mismatch(self) -> None:
        receipt = self.start()
        result = self.run_helper("get", "--run-id", receipt["run_id"],
                                 expected_cwd="/Users/server/code/project",
                                 cwd_override="/Users/server/code/somewhere-else")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["status"], "refused")
        self.assertEqual(payload["error"]["code"], "remote_cwd_mismatch",
                         "a cwd mismatch must never be reported as the expected path")

    def test_get_refuses_replaced_pane(self) -> None:
        receipt = self.start()
        result = self.run_helper("get", "--run-id", receipt["run_id"],
                                 expected_cwd="/Users/server/code/project", pane_override="other-pane")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["error"]["code"], "remote_target_replaced")

    def test_get_refuses_kind_mismatch(self) -> None:
        receipt = self.start()
        result = self.run_helper("get", "--run-id", receipt["run_id"],
                                 expected_cwd="/Users/server/code/project", kind_override="claude")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["error"]["code"], "remote_kind_mismatch")

    def test_get_refuses_missing_run_id(self) -> None:
        result = self.run_helper("get", "--run-id", "does-not-exist", expected_cwd="/x")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["error"]["code"], "remote_target_missing")
        self.assertEqual(self.calls(), [], "a missing run_id must never fall back to any remote call")

    def test_prompt_refuses_when_blocked(self) -> None:
        receipt = self.start()
        result = self.run_helper("prompt", "--run-id", receipt["run_id"], "hello",
                                 expected_cwd="/Users/server/code/project", agent_status="blocked")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["error"]["code"], "remote_agent_blocked")

    def test_prompt_refuses_when_not_interactive(self) -> None:
        receipt = self.start()
        result = self.run_helper("prompt", "--run-id", receipt["run_id"], "hello",
                                 expected_cwd="/Users/server/code/project", interactive_ready="0")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["error"]["code"], "remote_not_interactive")

    def test_prompt_forwards_literal_text_and_timeout(self) -> None:
        receipt = self.start()
        result = self.run_helper("prompt", "--run-id", receipt["run_id"], "literal space $(never-expand)",
                                 "--wait", "--timeout", "5000", expected_cwd="/Users/server/code/project",
                                 session_ready="1")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["status"], "ready")
        prompt_call = next(call for call in self.calls() if tuple(call["parts"][3:5]) == ("agent", "prompt"))
        self.assertEqual(prompt_call["parts"][6], "literal space $(never-expand)")
        self.assertIn("--wait", prompt_call["parts"])
        self.assertEqual(prompt_call["parts"][-1], "5000")

    def test_prompt_waits_for_post_start_settle(self) -> None:
        settle_threshold_ms = 500
        receipt = self.start()
        result = self.run_helper(
            "prompt", "--run-id", receipt["run_id"], "hello", "--wait", "--timeout", "1500",
            expected_cwd="/Users/server/code/project", prompt_requires_settle="1",
            prompt_settle_threshold_ms=str(settle_threshold_ms),
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["status"], "ready")
        self.assertEqual(payload["run_id"], receipt["run_id"])
        self.assertEqual(payload["session_id"], "native-remote-session-1")
        for name in ("workspace_id", "tab_id", "pane_id", "terminal_id", "agent_name"):
            self.assertEqual(payload[name], receipt[name], f"post-start settling changed remote {name}")

        calls = self.calls()
        prompt_calls = [call for call in calls if tuple(call["parts"][3:5]) == ("agent", "prompt")]
        self.assertEqual(len(prompt_calls), 1, "the requested prompt must be submitted exactly once")
        fake_state = json.loads(self.fake_state.read_text(encoding="utf-8"))
        self.assertIsInstance(fake_state.get("agent_start_completed_at"), (int, float))
        self.assertGreaterEqual(fake_state["first_prompt_elapsed"], settle_threshold_ms / 1000)
        self.assertFalse(fake_state.get("early_prompt_rejected", False))
        state_file = self.state_home / "monash" / "remote" / f"{receipt['run_id']}.json"
        persisted = json.loads(state_file.read_text(encoding="utf-8"))
        self.assertEqual(persisted["pane_id"], receipt["pane_id"])
        self.assertEqual(persisted["terminal_id"], receipt["terminal_id"])
        self.assertEqual(persisted["agent_session"]["value"], "native-remote-session-1")

    def test_prompt_reconciles_stalled_prompt_without_resubmission(self) -> None:
        receipt = self.start()
        result = self.run_helper(
            "prompt", "--run-id", receipt["run_id"], "hello", "--wait", "--timeout", "3000",
            expected_cwd="/Users/server/code/project", prompt_stalled="1",
            prompt_session_after_gets="2", prompt_stall_warning="1",
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["status"], "ready")
        self.assertEqual(payload["run_id"], receipt["run_id"])
        self.assertEqual(payload["session_id"], "native-remote-session-1")
        for name in ("workspace_id", "tab_id", "pane_id", "terminal_id", "agent_name"):
            self.assertEqual(payload[name], receipt[name], f"prompt reconciliation changed remote {name}")

        calls = self.calls()
        prompt_calls = [call for call in calls if tuple(call["parts"][3:5]) == ("agent", "prompt")]
        self.assertEqual(len(prompt_calls), 1, "a stalled prompt must never be resubmitted")
        self.assertIn("--wait", prompt_calls[0]["parts"])
        self.assertGreaterEqual(
            sum(tuple(call["parts"][3:5]) == ("agent", "get") for call in calls),
            3,
            "reconciliation must observe the same remote identity after the stall",
        )

        fake_state = json.loads(self.fake_state.read_text(encoding="utf-8"))
        self.assertEqual(fake_state["prompt_calls"], 1)
        self.assertEqual(fake_state["prompt_observations"], 2)
        state_file = self.state_home / "monash" / "remote" / f"{receipt['run_id']}.json"
        persisted = json.loads(state_file.read_text(encoding="utf-8"))
        self.assertEqual(persisted["pane_id"], receipt["pane_id"])
        self.assertEqual(persisted["terminal_id"], receipt["terminal_id"])
        self.assertEqual(persisted["agent_session"]["value"], "native-remote-session-1")

    def test_prompt_refuses_session_after_original_deadline(self) -> None:
        receipt = self.start()
        result = self.run_helper(
            "prompt", "--run-id", receipt["run_id"], "hello", "--wait", "--timeout", "20",
            expected_cwd="/Users/server/code/project", prompt_stalled="1",
            prompt_session_after_gets="1", prompt_get_delay_ms="50",
        )

        self.assertEqual(result.returncode, 3, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["status"], "refused")
        self.assertEqual(payload["error"]["code"], "verification_not_settled")
        self.assertEqual(payload["run_id"], receipt["run_id"])
        self.assertNotIn("session_id", payload)

        calls = self.calls()
        prompt_calls = [call for call in calls if tuple(call["parts"][3:5]) == ("agent", "prompt")]
        self.assertEqual(len(prompt_calls), 1, "deadline reconciliation must never resubmit the prompt")
        fake_state = json.loads(self.fake_state.read_text(encoding="utf-8"))
        self.assertEqual(fake_state["prompt_calls"], 1)
        state_file = self.state_home / "monash" / "remote" / f"{receipt['run_id']}.json"
        persisted = json.loads(state_file.read_text(encoding="utf-8"))
        self.assertEqual(persisted["pane_id"], receipt["pane_id"])
        self.assertEqual(persisted["terminal_id"], receipt["terminal_id"])
        self.assertNotIn("agent_session", persisted,
                         "a session observed after the original deadline must not be pinned as ready")

    def test_prompt_refuses_replaced_session(self) -> None:
        receipt = self.start(session_ready="1")
        result = self.run_helper("prompt", "--run-id", receipt["run_id"], "hello",
                                 expected_cwd="/Users/server/code/project", session_ready="1",
                                 session_value="native-remote-session-2")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["error"]["code"], "remote_session_changed")
        calls = self.calls()
        self.assertNotIn(("agent", "prompt"), [tuple(c["parts"][3:5]) for c in calls],
                         "a prompt must never target a replaced session")

    def test_read_refuses_replaced_session(self) -> None:
        receipt = self.start(session_ready="1")
        result = self.run_helper("read", "--run-id", receipt["run_id"],
                                 expected_cwd="/Users/server/code/project", session_ready="1",
                                 session_value="native-remote-session-2")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["error"]["code"], "remote_session_changed")
        calls = self.calls()
        self.assertNotIn(("agent", "read"), [tuple(c["parts"][3:5]) for c in calls],
                         "a read must never target a replaced session")

    def test_wait_refuses_replaced_session(self) -> None:
        receipt = self.start(session_ready="1")
        result = self.run_helper("wait", "--run-id", receipt["run_id"], "--until", "idle",
                                 expected_cwd="/Users/server/code/project", session_ready="1",
                                 session_value="native-remote-session-2")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["error"]["code"], "remote_session_changed")
        calls = self.calls()
        self.assertNotIn(("agent", "wait"), [tuple(c["parts"][3:5]) for c in calls],
                         "a wait must never target a replaced session")

    def test_read_forwards_source_and_lines(self) -> None:
        receipt = self.start()
        result = self.run_helper("read", "--run-id", receipt["run_id"], "--source", "recent-unwrapped",
                                 "--lines", "50", expected_cwd="/Users/server/code/project")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["read"], {"text": "observed remote output\n"})
        read_call = next(call for call in self.calls() if tuple(call["parts"][3:5]) == ("agent", "read"))
        self.assertIn("--source", read_call["parts"])
        self.assertIn("recent-unwrapped", read_call["parts"])
        self.assertIn("--lines", read_call["parts"])
        self.assertIn("50", read_call["parts"])

    def test_wait_forwards_until_states(self) -> None:
        receipt = self.start()
        result = self.run_helper("wait", "--run-id", receipt["run_id"], "--until", "idle", "--until", "blocked",
                                 expected_cwd="/Users/server/code/project", session_ready="1")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["status"], "ready")
        wait_call = next(call for call in self.calls() if tuple(call["parts"][3:5]) == ("agent", "wait"))
        self.assertEqual(wait_call["parts"].count("--until"), 2)
        self.assertIn("idle", wait_call["parts"])
        self.assertIn("blocked", wait_call["parts"])

    # --- reconnect -----------------------------------------------------------

    def test_reconnect_pins_session_then_rejects_changed_session(self) -> None:
        receipt = self.start()
        first = self.run_helper("reconnect", "--run-id", receipt["run_id"],
                                expected_cwd="/Users/server/code/project", session_ready="1")
        first_payload = json.loads(first.stdout)
        self.assertEqual(first_payload["status"], "ready")
        self.assertEqual(first_payload["session_id"], "native-remote-session-1")

        second = self.run_helper("reconnect", "--run-id", receipt["run_id"],
                                 expected_cwd="/Users/server/code/project", session_ready="1",
                                 session_value="native-remote-session-2")
        second_payload = json.loads(second.stdout)
        self.assertEqual(second_payload["error"]["code"], "remote_session_changed")

    def test_reconnect_rejects_changed_terminal(self) -> None:
        receipt = self.start()
        result = self.run_helper("reconnect", "--run-id", receipt["run_id"],
                                 expected_cwd="/Users/server/code/project", terminal_override="other-terminal")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["error"]["code"], "remote_target_replaced")

    def test_reconnect_rejects_changed_execution_host(self) -> None:
        receipt = self.start()
        result = self.run_helper("reconnect", "--run-id", receipt["run_id"],
                                 expected_cwd="/Users/server/code/project", hostname="other-mini-host")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["error"]["code"], "remote_execution_host_changed")

    def test_reconnect_preserves_confirmed_identity_on_host_mismatch(self) -> None:
        receipt = self.start()
        self.run_helper("reconnect", "--run-id", receipt["run_id"],
                        expected_cwd="/Users/server/code/project", hostname="other-mini-host")
        state_file = self.state_home / "monash" / "remote" / f"{receipt['run_id']}.json"
        persisted = json.loads(state_file.read_text(encoding="utf-8"))
        self.assertEqual(persisted["execution_host"]["value"], "mini-test-host",
                         "a rejected reconnect must preserve the last confirmed identity, not overwrite it")

    def test_reconnect_refreshes_hostname_observation_when_unchanged(self) -> None:
        receipt = self.start()
        result = self.run_helper("reconnect", "--run-id", receipt["run_id"],
                                 expected_cwd="/Users/server/code/project")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["execution_host"]["value"], "mini-test-host")
        self.assertEqual(payload["execution_host"]["source"], "ssh+/bin/hostname")

    def test_reconnect_returns_direct_attach_argv_without_exec(self) -> None:
        receipt = self.start(session_ready="1")
        result = self.run_helper("reconnect", "--run-id", receipt["run_id"],
                                 expected_cwd="/Users/server/code/project", session_ready="1")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["attach_argv"][0], "ssh")
        self.assertEqual(payload["attach_argv"][1], "-tt")
        self.assertNotIn("exec", payload["attach_argv"])

    # --- persistence failure after a real remote pane exists ----------------

    def test_start_initial_partial_persistence_failure_returns_structured_envelope(self) -> None:
        """A broken state directory must not silently swallow the failure or
        proceed past pane creation; the structured envelope must still carry
        run_id and the best-known (unpromoted) recovery identity."""
        remote_state_dir = self.state_home / "monash" / "remote"
        remote_state_dir.parent.mkdir(parents=True, exist_ok=True)
        remote_state_dir.write_text("not a directory", encoding="utf-8")

        result = self.run_helper(*self.start_arguments(), expected_cwd="/Users/server/code/project")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["status"], "refused")
        self.assertEqual(payload["error"]["code"], "remote_identity_persistence_failed")
        self.assertIn("run_id", payload)
        remote_identity = payload["remote_identity"]
        self.assertIn("intended_agent_name", remote_identity)
        self.assertNotIn("agent_name", remote_identity)
        self.assertEqual(remote_identity["pane_id"], "remote-pane")

        calls = self.calls()
        kinds = [tuple(call["parts"][3:5]) for call in calls if len(call["parts"]) > 4]
        self.assertIn(("workspace", "create"), kinds)
        self.assertNotIn(("agent", "start"), kinds,
                         "must never proceed past a persistence failure to start the native agent")

    def test_get_later_persistence_failure_returns_structured_envelope(self) -> None:
        """A persistence failure at any later lifecycle write, including the
        initial partial write, must return the same structured envelope.
        This exercises the identical `_persist_or_annotate` path used by
        cmd_start's own final ready write, via the session-pin write that
        `get` triggers on its first complete observation."""
        receipt = self.start()
        remote_state_dir = self.state_home / "monash" / "remote"
        original_mode = remote_state_dir.stat().st_mode
        remote_state_dir.chmod(0o500)
        try:
            result = self.run_helper("get", "--run-id", receipt["run_id"],
                                     expected_cwd="/Users/server/code/project", session_ready="1")
        finally:
            remote_state_dir.chmod(original_mode)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["status"], "refused")
        self.assertEqual(payload["error"]["code"], "remote_identity_persistence_failed")
        self.assertEqual(payload["run_id"], receipt["run_id"])
        self.assertEqual(payload["remote_identity"]["agent_session"]["value"], "native-remote-session-1",
                         "the best-known identity must include the session tuple that failed to persist")


if __name__ == "__main__":
    unittest.main()
