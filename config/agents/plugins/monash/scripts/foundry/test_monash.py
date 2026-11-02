"""Public-process proof for the Monash local sibling-pane coordinator.

The fixture owns every expected Herdr response and launcher argument. It does
not import the frontend implementation or derive expected results from it.

Run:
    python3 -m unittest discover -s scripts/foundry -p 'test_monash.py' -v
"""

from __future__ import annotations

import errno
import json
import os
import pty
from pathlib import Path
import re
import select
import shlex
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest


SOURCE_DIR = Path(__file__).resolve().parent


FAKE_FOUNDRY = """#!/usr/bin/env python3
import json
import os
from pathlib import Path
import re
import sys

Path(os.environ['MONASH_TEST_LOG']).open('a', encoding='utf-8').write(
    json.dumps({'program': 'monash-foundry', 'argv': sys.argv[1:]}) + '\\n')
if os.environ.get('MONASH_TEST_REFUSE_SELECTION') == '1' and ('--dry-run' in sys.argv or 'models' in sys.argv):
    raise SystemExit(3)
if 'models' in sys.argv and '--json' in sys.argv:
    print(json.dumps({
        'schema_version': 1,
        'command': 'models',
        'resources': [
            {'id': 'gpt', 'availability': 'available', 'observed': True},
            {'id': 'claude', 'availability': 'available', 'observed': True},
        ],
        'models': [{
            'id': 'gpt-5.5',
            'display_name': 'GPT-5.5',
            'availability': 'available',
            'bindings': [
                {'resource_id': 'gpt', 'availability': 'available', 'observed': True,
                 'protocol': 'azure-openai-responses', 'model_format': 'OpenAI'},
                {'resource_id': 'claude', 'availability': 'available', 'observed': True,
                 'protocol': 'azure-anthropic-messages', 'model_format': 'Anthropic'},
            ],
            'routes': [
                {'agent': 'codex', 'status': 'qualified', 'implemented': True,
                 'compatibility': 'compatible', 'binding_resource_id': 'gpt'},
                {'agent': 'claude', 'status': 'untested', 'implemented': False,
                 'compatibility': 'incompatible', 'binding_resource_id': 'claude'},
                {'agent': 'opencode', 'status': 'untested', 'implemented': False,
                 'compatibility': 'incompatible', 'binding_resource_id': None},
            ],
        }],
    }))
    raise SystemExit(0)
if '--dry-run' in sys.argv:
    agent = os.environ.get('MONASH_TEST_ROUTE_AGENT', 'codex')
    model = os.environ.get('MONASH_TEST_ROUTE_MODEL', 'gpt-5.5')
    print(f'host=test agent={agent} provider=test deployment={model} model={model}')
    print('native_cli=' + os.environ['MONASH_TEST_REAL_NATIVE'] + ' source=test')
raise SystemExit(0)
"""


FAKE_REMOTE_HELPER = """#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys

argv = sys.argv[1:]
Path(os.environ['MONASH_TEST_LOG']).open('a', encoding='utf-8').write(
    json.dumps({'program': 'monash_remote', 'argv': argv}) + '\\n')

def option(name, default=None):
    if name not in argv:
        return default
    return argv[argv.index(name) + 1]

host = option('--host')
command = argv[argv.index('--host') + 2]
agent = option('--agent', 'codex')
model = option('--model', 'gpt-5.5')
requested_cwd = option('--cwd', os.environ['MONASH_TEST_EXPECTED_LOCAL_CWD'])
remote_cwd = option('--remote-cwd', '/Users/server/code/project')
run_id = option('--run-id', 'remote-run-1')

if os.environ.get('MONASH_TEST_REMOTE_MALFORMED') == '1':
    print('not-json')
    raise SystemExit(0)
if os.environ.get('MONASH_TEST_REMOTE_REFUSAL') == '1':
    print(json.dumps({'schema_version': 1, 'status': 'refused', 'error': {
        'code': 'remote_test_refused',
        'message': 'test-owned remote refusal',
        'repair': 'repair the remote fixture',
    }}))
    raise SystemExit(3)
if os.environ.get('MONASH_TEST_REMOTE_START_TIMEOUT') == '1' and command == 'start':
    print(json.dumps({
        'schema_version': 1,
        'status': 'refused',
        'run_id': run_id,
        'remote_identity': {
            'workspace_id': 'remote-workspace',
            'tab_id': 'remote-tab',
            'pane_id': 'remote-pane',
            'terminal_id': 'remote-terminal',
            'intended_agent_name': 'remote-agent-intended',
        },
        'error': {
            'code': 'remote_native_not_ready',
            'message': 'test-owned remote managed start timeout',
            'repair': 'inspect the remote pane and do not retry start',
        },
    }))
    raise SystemExit(3)
if os.environ.get('MONASH_TEST_REMOTE_POST_PANE_REFUSAL') == '1' and command == 'start':
    print(json.dumps({
        'schema_version': 1,
        'status': 'refused',
        'run_id': run_id,
        'remote_identity': {
            'workspace_id': 'remote-workspace',
            'tab_id': 'remote-tab',
            'pane_id': 'remote-pane',
            'terminal_id': 'remote-terminal',
            'intended_agent_name': 'remote-agent-intended',
        },
        'error': {
            'code': 'remote_shim_resolution_failed',
            'message': 'test-owned post-pane shim refusal',
            'repair': 'inspect the remote pane and reconnect; do not rerun spawn',
        },
    }))
    raise SystemExit(3)
if os.environ.get('MONASH_TEST_REMOTE_VERIFY_TIMEOUT') == '1' and command == 'prompt':
    print(json.dumps({
        'schema_version': 1,
        'status': 'refused',
        'run_id': run_id,
        'remote_identity': {
            'workspace_id': 'remote-workspace',
            'tab_id': 'remote-tab',
            'pane_id': 'remote-pane',
            'terminal_id': 'remote-terminal',
            'agent_name': 'remote-agent-1',
        },
        'observation': {
            'source': 'remote.herdr.agent.get',
            'agent': agent,
            'agent_status': 'idle',
            'interactive_ready': True,
        },
        'error': {
            'code': 'remote_verify_timed_out',
            'message': 'test-owned remote verification timeout',
            'repair': 'inspect the remote session and do not retry prompt',
        },
    }))
    raise SystemExit(3)
if os.environ.get('MONASH_TEST_REMOTE_VERIFY_REFUSAL') == '1' and command == 'prompt':
    print(json.dumps({'schema_version': 1, 'status': 'refused', 'error': {
        'code': 'remote_verify_refused',
        'message': 'test-owned verification refusal',
        'repair': 'inspect the remote identity and reconnect; do not rerun spawn',
    }}))
    raise SystemExit(3)
if os.environ.get('MONASH_TEST_REMOTE_POST_START_REFUSAL') == '1' and command == 'start':
    print(json.dumps({
        'schema_version': 1,
        'status': 'refused',
        'run_id': run_id,
        'remote_identity': {
            'workspace_id': 'remote-workspace',
            'tab_id': 'remote-tab',
            'pane_id': 'remote-pane',
            'terminal_id': 'remote-terminal',
            'agent_name': 'remote-agent-1',
        },
        'observation': {
            'source': 'remote.herdr.agent.get',
            'workspace_id': 'remote-workspace',
            'tab_id': 'remote-tab',
            'pane_id': 'remote-pane',
            'terminal_id': 'remote-terminal',
            'agent': agent,
            'agent_status': 'blocked',
            'cwd': remote_cwd,
            'interactive_ready': False,
        },
        'error': {
            'code': 'remote_agent_blocked',
            'message': 'test-owned post-start blocked refusal',
            'repair': 'inspect the remote pane and reconnect; do not rerun spawn',
        },
    }))
    raise SystemExit(3)

session = {'source': 'herdr:' + agent, 'agent': agent, 'kind': 'id', 'value': 'remote-session-1'}
observation = {
    'workspace_id': 'remote-workspace',
    'tab_id': 'remote-tab',
    'pane_id': 'remote-pane',
    'terminal_id': 'remote-terminal',
    'agent': agent,
    'agent_status': 'idle',
    'cwd': remote_cwd,
    'interactive_ready': True,
    'agent_session': session,
    'source': 'remote.herdr.agent.get',
}
payload = {
    'schema_version': 1,
    'command': command,
    'status': 'ready',
    'run_id': run_id,
    'profile_id': host,
    'transport': 'ssh',
    'execution_host': {
        'value': 'mini-test-host',
        'source': 'ssh+/bin/hostname',
        'observed_at': '2026-09-09T00:00:00Z',
    },
    'agent': agent,
    'agent_name': 'remote-agent-1',
    'requested_cwd': requested_cwd,
    'expected_cwd': remote_cwd,
    'expected_cwd_source': 'explicit_remote_cwd' if '--remote-cwd' in argv else 'path_mapping',
    'observed_cwd': remote_cwd,
    'workspace_id': 'remote-workspace',
    'tab_id': 'remote-tab',
    'pane_id': 'remote-pane',
    'terminal_id': 'remote-terminal',
    'native_identity': {
        'agent': agent,
        'agent_status': 'idle',
        'interactive_ready': True,
    },
    'observation': observation,
    'session_id': session['value'],
    'attach_argv': [
        'ssh', '-tt', 'mac-mini', '/opt/homebrew/bin/herdr', '--session', 'monash-foundry',
        'agent', 'attach', 'remote-agent-1',
    ],
}
if os.environ.get('MONASH_TEST_REMOTE_STARTED') == '1' and command == 'start':
    payload['status'] = 'started'
    payload['observation'].pop('agent_session')
    payload.pop('session_id')
if os.environ.get('MONASH_TEST_REMOTE_SESSION_MISSING') == '1':
    payload['observation'].pop('agent_session')
    payload.pop('session_id')
if os.environ.get('MONASH_TEST_REMOTE_NOT_READY') == '1':
    payload['observation']['interactive_ready'] = False
if os.environ.get('MONASH_TEST_REMOTE_ATTACH_MISMATCH') == '1':
    payload['attach_argv'][2] = 'wrong-host'
if os.environ.get('MONASH_TEST_REMOTE_IDENTITY_MISMATCH') == '1':
    payload['observation']['pane_id'] = 'different-remote-pane'
if os.environ.get('MONASH_TEST_REMOTE_VERIFY_IDENTITY_MISMATCH') == '1' and command == 'prompt':
    payload['observation']['pane_id'] = 'different-remote-pane'
print(json.dumps(payload))
"""


FAKE_HERDR = """#!/usr/bin/env python3
import json
import os
from pathlib import Path
import re
import shlex
import sys
import time

argv = sys.argv[1:]
log = Path(os.environ['MONASH_TEST_LOG'])
state_path = Path(os.environ['MONASH_TEST_STATE'])
try:
    state = json.loads(state_path.read_text(encoding='utf-8'))
except FileNotFoundError:
    state = {'process_info_calls': 0, 'agent_started': False, 'first_turn': False}
log.open('a', encoding='utf-8').write(json.dumps({'program': 'herdr', 'argv': argv}) + '\\n')

def respond(result):
    print(json.dumps({'result': result}))

if argv == ['pane', 'current', '--current']:
    respond({'pane': {'pane_id': 'caller-pane', 'tab_id': 'tab-main'}})
elif argv[:2] == ['pane', 'get']:
    respond({'pane': {'pane_id': argv[2], 'tab_id': 'tab-main'}})
elif argv[:2] == ['pane', 'split']:
    respond({'pane': {'pane_id': 'new-pane', 'tab_id': 'tab-main', 'terminal_id': 'local-terminal'}})
elif argv[:2] == ['pane', 'process-info']:
    state['process_info_calls'] += 1
    if state.get('attach_dispatched'):
        attach = list(state['attach_argv'])
        observed = list(attach)
        if os.environ.get('MONASH_TEST_ATTACH_PROCESS_MISMATCH') == '1':
            observed[2] = 'wrong-host'
        respond({'process_info': {'shell_pid': 17, 'foreground_processes': [{
            'pid': 55, 'name': Path(observed[0]).name, 'argv0': observed[0], 'argv': observed,
            'cwd': os.environ['MONASH_TEST_NATIVE_CWD'],
        }]}})
        state_path.write_text(json.dumps(state), encoding='utf-8')
        raise SystemExit(0)
    if state['agent_started']:
        real = os.environ['MONASH_TEST_REAL_NATIVE']
        if os.environ.get('MONASH_TEST_WRONG_EXECUTABLE') == '1':
            real = os.environ['MONASH_TEST_OTHER_NATIVE']
        if os.environ.get('MONASH_TEST_HINTED_LAUNCHER') == '1' or os.environ.get('MONASH_TEST_SHIM_RECURSION') == '1':
            real = os.environ['MONASH_TEST_LAUNCHER']
        agent = os.environ.get('MONASH_TEST_ROUTE_AGENT', 'codex')
        model = os.environ.get('MONASH_TEST_OBSERVED_MODEL', os.environ.get('MONASH_TEST_ROUTE_MODEL', 'gpt-5.5'))
        if agent == 'claude':
            args = [real, '--settings', '{"env":{}}', '--model', model]
        else:
            args = [real, '-c', f'model="{model}"', '--resume', 'literal space', '$(never-expand)']
        respond({'process_info': {'shell_pid': 17, 'foreground_processes': [{
            'pid': 42, 'name': Path(real).name, 'argv0': real, 'argv': args,
            'cwd': os.environ['MONASH_TEST_NATIVE_CWD'],
        }]}})
        state_path.write_text(json.dumps(state), encoding='utf-8')
        raise SystemExit(0)
    state_path.write_text(json.dumps(state), encoding='utf-8')
    foreground = 17 if state['process_info_calls'] > 1 else 99
    respond({'process_info': {'shell_pid': 17, 'foreground_processes': [{'pid': foreground}]}})
elif argv[:2] == ['agent', 'get']:
    if os.environ.get('MONASH_TEST_START_AGENT_NOT_READY_ONCE') == '1' and not state['agent_started']:
        print(json.dumps({'error': {'code': 'agent_not_found'}}), file=sys.stderr)
        raise SystemExit(1)
    agent_kind = os.environ.get('MONASH_TEST_ROUTE_AGENT', 'codex')
    agent = {
        'pane_id': 'new-pane',
        'agent': agent_kind,
        'cwd': os.environ['MONASH_TEST_NATIVE_CWD'],
        'agent_status': os.environ.get('MONASH_TEST_AGENT_STATUS', 'idle'),
    }
    delayed_session = os.environ.get('MONASH_TEST_VERIFY_PROMPT_STALLED') == '1' and state['first_turn']
    after_deadline = os.environ.get('MONASH_TEST_VERIFY_SESSION_AFTER_DEADLINE') == '1' and state['first_turn']
    if after_deadline:
        time.sleep(0.05)
    if delayed_session:
        state['verification_gets'] = state.get('verification_gets', 0) + 1
    if state['first_turn'] and (after_deadline or not delayed_session or state['verification_gets'] >= 2):
        source = 'external:fake' if os.environ.get('MONASH_TEST_SESSION_SOURCE_MISMATCH') == '1' else f'herdr:{agent_kind}'
        agent['agent_session'] = {
            'source': source, 'agent': agent_kind, 'kind': 'id', 'value': 'native-gpt55-session'
        }
    state_path.write_text(json.dumps(state), encoding='utf-8')
    respond({'agent': agent})
elif argv[:2] == ['pane', 'run']:
    if os.environ.get('MONASH_TEST_ATTACH_FAILURE') == '1' and argv[3].startswith('ssh '):
        raise SystemExit(65)
    if argv[3].startswith('ssh '):
        state['attach_dispatched'] = True
        state['attach_argv'] = shlex.split(argv[3])
        state_path.write_text(json.dumps(state), encoding='utf-8')
        raise SystemExit(0)
    # Herdr 0.9.0 accepts the terminal write with no stdout JSON response.
    match = re.search(r'__MONASH_SHIM_OK__=([^ ]+)', argv[3])
    if match:
        state['expected_shim'] = match.group(1).rstrip(';')
        state_path.write_text(json.dumps(state), encoding='utf-8')
    raise SystemExit(0)
elif argv[:2] == ['pane', 'wait-output']:
    shim = state.get('expected_shim', '')
    expected_pattern = r'^__MONASH_SHIM_(?:OK__=' + re.escape(shim) + r'|MISMATCH__=.*)$'
    if os.environ.get('MONASH_TEST_ECHOED_PROBE_COMMAND') == '1' and argv[4] != expected_pattern:
        line = 'printf __MONASH_SHIM_OK__=' + shim + '; echo command'
    elif os.environ.get('MONASH_TEST_LOGIN_PATH_REWRITE') == '1':
        line = '__MONASH_SHIM_MISMATCH__=/opt/homebrew/bin/codex'
    else:
        line = '__MONASH_SHIM_OK__=' + shim
    respond({'pane_id': 'new-pane', 'matched_line': line, 'read': {'text': line}})
elif argv[:2] == ['agent', 'start']:
    state['agent_start_calls'] = state.get('agent_start_calls', 0) + 1
    if os.environ.get('MONASH_TEST_START_AGENT_NOT_READY_ONCE') == '1' and state['agent_start_calls'] == 1:
        state_path.write_text(json.dumps(state), encoding='utf-8')
        print(json.dumps({'error': {'code': 'agent_not_ready'}}), file=sys.stderr)
        raise SystemExit(1)
    if os.environ.get('MONASH_TEST_START_TIMEOUT') == '1':
        state_path.write_text(json.dumps(state), encoding='utf-8')
        print(json.dumps({'error': {'code': 'timeout'}}), file=sys.stderr)
        raise SystemExit(1)
    state['agent_started'] = True
    state_path.write_text(json.dumps(state), encoding='utf-8')
    if os.environ.get('MONASH_TEST_AGENT_STATUS') == 'blocked':
        print(json.dumps({'error': {'code': 'agent_not_ready'}}), file=sys.stderr)
        raise SystemExit(1)
    respond({'agent': {'pane_id': 'new-pane', 'agent': 'codex'}})
elif argv[:2] == ['agent', 'prompt']:
    state['first_turn'] = True
    state['verification_gets'] = 0
    state_path.write_text(json.dumps(state), encoding='utf-8')
    if os.environ.get('MONASH_TEST_VERIFY_PROMPT_STALLED') == '1':
        print(json.dumps({'error': {'code': 'agent_prompt_stalled'}}), file=sys.stderr)
        raise SystemExit(1)
    respond({'agent': {'pane_id': 'new-pane', 'agent': 'codex'}})
elif argv[:2] == ['pane', 'report-metadata']:
    if os.environ.get('MONASH_TEST_METADATA_FAILURE') == '1':
        raise SystemExit(65)
    # Herdr 0.9.0 applies display metadata and emits no JSON body on success.
    raise SystemExit(0)
elif argv[:2] == ['pane', 'close']:
    respond({})
elif argv == ['status']:
    respond({})
else:
    print(json.dumps({'error': 'unexpected fake Herdr argv', 'argv': argv}), file=sys.stderr)
    raise SystemExit(70)
"""


def test_config() -> dict[str, object]:
    """Independent host-profile oracle. `mini` is intentionally SSH-only."""
    return {
        "host_profiles": {
            "laptop": {"transport": "local"},
            "mini": {
                "transport": "ssh",
                "ssh_alias": "mac-mini",
                "herdr_session": "monash-foundry",
                "remote_install_root": "/Users/server/.local/share/monash-foundry",
                "herdr_executable": "/opt/homebrew/bin/herdr",
                "path_mappings": [],
            },
        },
    }


class MonashProcessTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        self.bin_dir = self.root / "bin"
        self.bin_dir.mkdir()
        self.real_bin = self.root / "real-native-bin"
        self.real_bin.mkdir()
        self.real_native = self.real_bin / "codex"
        self.real_native_link = self.real_bin / "native-link"
        self.other_native = self.real_bin / "other-codex"
        self.workdir = self.root / "requested cwd"
        self.workdir.mkdir()
        self.state_home = self.root / "state-home"
        self.log_path = self.root / "calls.jsonl"
        self.fake_state = self.root / "fake-state.json"
        self.config = self.root / "config.json"
        self.config.write_text(json.dumps(test_config()), encoding="utf-8")

        self.monash = self.runtime / "monash"
        shutil.copyfile(SOURCE_DIR / "monash", self.monash)
        shutil.copyfile(SOURCE_DIR / "monash_hosts.py", self.runtime / "monash_hosts.py")
        (self.runtime / "monash-foundry").write_text(FAKE_FOUNDRY, encoding="utf-8")
        (self.bin_dir / "herdr").write_text(FAKE_HERDR, encoding="utf-8")
        for command in (self.monash, self.runtime / "monash-foundry", self.bin_dir / "herdr", self.real_native, self.other_native):
            if command in (self.real_native, self.other_native):
                command.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            command.chmod(0o700)
        self.real_native_link.symlink_to(self.real_native)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def install_remote_helper(self) -> Path:
        helper = self.runtime / "monash_remote.py"
        helper.write_text(FAKE_REMOTE_HELPER, encoding="utf-8")
        helper.chmod(0o700)
        return helper

    def environment(self, *, native_cwd: Path | None = None, selection_refused: bool = False,
                    metadata_failure: bool = False, agent_status: str = 'idle',
                    route_agent: str = 'codex', route_model: str = 'gpt-5.5',
                    observed_model: str | None = None, real_native: Path | None = None,
                    **flags: bool) -> dict[str, str]:
        env = os.environ.copy()
        env.update({
            "PATH": f"{self.bin_dir}{os.pathsep}{env['PATH']}",
            "XDG_STATE_HOME": str(self.state_home),
            "MONASH_TEST_LOG": str(self.log_path),
            "MONASH_TEST_STATE": str(self.fake_state),
            "MONASH_TEST_NATIVE_CWD": str(native_cwd or self.workdir),
            "MONASH_TEST_AGENT_STATUS": agent_status,
            "MONASH_TEST_ROUTE_AGENT": route_agent,
            "MONASH_TEST_ROUTE_MODEL": route_model,
            "MONASH_TEST_REAL_NATIVE": str(real_native or self.real_native),
            "MONASH_TEST_OTHER_NATIVE": str(self.other_native),
            "MONASH_TEST_LAUNCHER": str(self.runtime / "monash-foundry"),
            "MONASH_TEST_EXPECTED_LOCAL_CWD": str(self.workdir.resolve()),
        })
        if observed_model is not None:
            env["MONASH_TEST_OBSERVED_MODEL"] = observed_model
        if selection_refused:
            env["MONASH_TEST_REFUSE_SELECTION"] = "1"
        if metadata_failure:
            env["MONASH_TEST_METADATA_FAILURE"] = "1"
        for name, enabled in flags.items():
            if enabled:
                env[f"MONASH_TEST_{name.upper()}"] = "1"
        return env

    def run_monash(self, *arguments: str, native_cwd: Path | None = None,
                   selection_refused: bool = False, metadata_failure: bool = False,
                   config_argument: str | None = None, agent_status: str = 'idle',
                   route_agent: str = 'codex', route_model: str = 'gpt-5.5',
                   observed_model: str | None = None, real_native: Path | None = None,
                   **flags: bool) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(self.monash), "--config", config_argument or str(self.config), *arguments],
            text=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            env=self.environment(native_cwd=native_cwd, selection_refused=selection_refused,
                                 metadata_failure=metadata_failure, agent_status=agent_status,
                                 route_agent=route_agent, route_model=route_model,
                                 observed_model=observed_model, real_native=real_native, **flags),
            cwd=self.root,
        )

    def run_picker(self, *arguments: str, input_text: str = "\n\n", **flags: bool) -> subprocess.CompletedProcess[str]:
        master, slave = pty.openpty()
        process = subprocess.Popen(
            [sys.executable, str(self.monash), "--config", str(self.config), *arguments],
            text=False,
            stdin=slave,
            stdout=slave,
            stderr=subprocess.PIPE,
            env=self.environment(**flags),
            cwd=self.root,
        )
        os.close(slave)
        output = bytearray()
        deadline = time.monotonic() + 15
        try:
            os.write(master, input_text.encode())
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    process.kill()
                    process.wait()
                    raise AssertionError(
                        "picker process timed out; captured output: " + output.decode(errors="replace")
                    )
                ready, _, _ = select.select([master], [], [], min(5, remaining))
                if ready:
                    try:
                        chunk = os.read(master, 4096)
                    except OSError as error:
                        if error.errno == errno.EIO:
                            break
                        raise
                    if chunk:
                        output.extend(chunk)
                if process.poll() is not None:
                    break
            returncode = process.wait(timeout=5)
            stderr = process.stderr.read().decode() if process.stderr is not None else ""
            if process.stderr is not None:
                process.stderr.close()
        finally:
            os.close(master)
            if process.poll() is None:
                process.kill()
                process.wait()
        return subprocess.CompletedProcess(
            process.args, returncode, output.decode(errors="replace"), stderr,
        )

    def calls(self) -> list[dict[str, object]]:
        if not self.log_path.exists():
            return []
        return [json.loads(line) for line in self.log_path.read_text(encoding="utf-8").splitlines()]

    def assert_run_id(self, value: object) -> str:
        self.assertIsInstance(value, str)
        assert isinstance(value, str)
        self.assertRegex(value, r"^[0-9a-f]{32}$")
        return value

    def success_arguments(self, *, pane: str | None = None) -> list[str]:
        arguments = [
            "spawn", "--host", "laptop", "--model", "gpt-5.5", "--agent", "codex",
            "--cwd", str(self.workdir), "--qualification",
        ]
        if pane is not None:
            arguments.extend(("--pane", pane))
        arguments.extend(("--", "--resume", "literal space", "$(never-expand)"))
        return arguments

    def remote_arguments(self, *, verify: bool = False, qualification: bool = False,
                         remote_cwd: str | None = "/Users/server/code/project") -> list[str]:
        arguments = [
            "spawn", "--host", "mini", "--model", "gpt-5.5", "--agent", "codex",
            "--cwd", str(self.workdir),
        ]
        if remote_cwd is not None:
            arguments.extend(("--remote-cwd", remote_cwd))
        if qualification:
            arguments.append("--qualification")
        if verify:
            arguments.append("--verify")
        arguments.extend(("--", "--resume", "literal space", "$(never-expand)"))
        return arguments

    def test_local_gpt55_selection_creates_one_same_tab_ready_sibling(self) -> None:
        result = self.run_monash(*self.success_arguments())
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)

        self.assertEqual(receipt["status"], "ready")
        self.assertEqual(receipt["host"], "laptop")
        self.assertEqual(receipt["model"], "gpt-5.5")
        self.assertEqual(receipt["agent"], "codex")
        self.assertEqual(receipt["pane_id"], "new-pane")
        self.assertEqual(receipt["tab_id"], "tab-main")
        self.assertEqual(receipt["cwd"], str(self.workdir.resolve()))
        self.assertEqual(receipt["requested_cwd"], str(self.workdir.resolve()))
        self.assertEqual(receipt["execution_cwd"], str(self.workdir.resolve()))
        self.assertEqual(receipt["session"], {"state": "pending_first_turn"})
        self.assertNotIn("session_id", receipt)
        self.assertEqual(receipt["native_identity"]["native_executable"], str(self.real_native))
        self.assertNotIn("process_argv", receipt["native_identity"])
        self.assertEqual(receipt["lifecycle"], {"state": "idle", "source": "herdr.agent.get"})
        self.assertEqual(receipt["execution_host"]["source"], "/bin/hostname")
        self.assertTrue(receipt["execution_host"]["value"])

        calls = self.calls()
        foundry_calls = [call["argv"] for call in calls if call["program"] == "monash-foundry"]
        self.assertEqual(foundry_calls, [[
            "--config", str(self.config.resolve()), "--dry-run", "launch", "--model", "gpt-5.5", "--agent", "codex",
            "--qualification", "--", "--resume", "literal space", "$(never-expand)",
        ]])
        herdr_calls = [call["argv"] for call in calls if call["program"] == "herdr"]
        split_calls = [argv for argv in herdr_calls if argv[0:2] == ["pane", "split"]]
        self.assertEqual(split_calls, [[
            "pane", "split", "caller-pane", "--direction", "right", "--cwd", str(self.workdir.resolve()), "--no-focus",
        ]])
        self.assertGreaterEqual(sum(argv[0:2] == ["pane", "process-info"] for argv in herdr_calls), 4)
        self.assertNotIn(["pane", "get", "caller-pane"], herdr_calls)
        self.assertFalse(any("HERDR_AGENT" in argv[3] for argv in herdr_calls if argv[0:2] == ["pane", "run"]))
        start_call = next(argv for argv in herdr_calls if argv[0:2] == ["agent", "start"])
        self.assertEqual(start_call[0:2] + start_call[3:], [
            "agent", "start", "--kind", "codex", "--pane", "new-pane", "--timeout", "60000", "--",
            "--resume", "literal space", "$(never-expand)",
        ])
        shim_path = Path(json.loads(self.fake_state.read_text(encoding="utf-8"))["expected_shim"])
        shim_text = shim_path.read_text(encoding="utf-8")
        self.assertIn("HERDR_AGENT=codex", shim_text)
        self.assertIn("HERDR_MONASH_SHIM_ACTIVE", shim_text)
        self.assertIn("PATH=", shim_text)
        self.assertNotIn(str(shim_path.parent), shim_text.split("PATH=", 1)[1])
        self.assertNotIn("test-secret", shim_text)
        self.assertFalse(any(argv[0:2] == ["pane", "close"] for argv in herdr_calls))

        saved = json.loads((self.state_home / "monash" / "last-success.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["host"], "laptop")
        self.assertEqual(saved["model"], "gpt-5.5")
        self.assertEqual(saved["cwd"], str(self.workdir.resolve()))

    def test_local_selection_still_requires_a_laptop_native_executable(self) -> None:
        missing_native = self.root / "missing local native executable"
        result = self.run_monash(*self.success_arguments(), real_native=missing_native)
        self.assertEqual(result.returncode, 3)
        self.assertEqual(json.loads(result.stdout)["error"]["code"], "native_executable_unavailable")
        self.assertEqual([call["program"] for call in self.calls()], ["monash-foundry"])

    def test_relative_config_is_normalized_before_the_spawned_shell_changes_directory(self) -> None:
        result = self.run_monash(*self.success_arguments(), config_argument="config.json")
        self.assertEqual(result.returncode, 0, result.stderr)
        foundry_calls = [call["argv"] for call in self.calls() if call["program"] == "monash-foundry"]
        self.assertEqual(foundry_calls[0][0:2], ["--config", str(self.config.resolve())])
        herdr_calls = [call["argv"] for call in self.calls() if call["program"] == "herdr"]
        shim_path = Path(json.loads(self.fake_state.read_text(encoding="utf-8"))["expected_shim"])
        self.assertIn("--config " + shlex.quote(str(self.config.resolve())), shim_path.read_text(encoding="utf-8"))

    def test_claude_requires_the_exact_observed_model_argument(self) -> None:
        arguments = [
            "spawn", "--host", "laptop", "--model", "claude-sonnet-5", "--agent", "claude",
            "--cwd", str(self.workdir),
        ]
        accepted = self.run_monash(*arguments, route_agent="claude", route_model="claude-sonnet-5")
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        self.assertEqual(json.loads(accepted.stdout)["status"], "ready")

        self.log_path.unlink(missing_ok=True)
        self.fake_state.unlink(missing_ok=True)
        refused = self.run_monash(
            *arguments, route_agent="claude", route_model="claude-sonnet-5",
            observed_model="claude-sonnet-4-6",
        )
        self.assertEqual(refused.returncode, 3)
        self.assertEqual(json.loads(refused.stdout)["error"]["code"], "native_process_unverified")

    def test_symlinked_native_path_matches_its_pinned_executable_identity(self) -> None:
        result = self.run_monash(
            "spawn", "--host", "laptop", "--model", "claude-sonnet-5", "--agent", "claude",
            "--cwd", str(self.workdir), route_agent="claude", route_model="claude-sonnet-5",
            real_native=self.real_native_link,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["status"], "ready")
        self.assertEqual(receipt["native_identity"]["native_executable"], str(self.real_native.resolve()))

    def test_explicit_caller_pane_is_fetched_not_derived_from_focus(self) -> None:
        result = self.run_monash(*self.success_arguments(pane="inherited-pane"))
        self.assertEqual(result.returncode, 0, result.stderr)
        herdr_calls = [call["argv"] for call in self.calls() if call["program"] == "herdr"]
        self.assertIn(["pane", "get", "inherited-pane"], herdr_calls)
        self.assertNotIn(["pane", "current", "--current"], herdr_calls)
        self.assertIn([
            "pane", "split", "inherited-pane", "--direction", "right", "--cwd", str(self.workdir.resolve()), "--no-focus",
        ], herdr_calls)

    def test_selection_refusal_happens_before_any_pane_effect(self) -> None:
        result = self.run_monash(*self.success_arguments(), selection_refused=True)
        self.assertEqual(result.returncode, 3)
        self.assertEqual(json.loads(result.stdout)["error"]["code"], "selection_refused")
        self.assertEqual([call["program"] for call in self.calls()], ["monash-foundry"])
        self.assertFalse((self.state_home / "monash" / "last-success.json").exists())

    def test_mismatched_observed_cwd_preserves_pane_and_refuses_without_state(self) -> None:
        wrong_cwd = self.root / "wrong cwd"
        wrong_cwd.mkdir()
        result = self.run_monash(*self.success_arguments(), native_cwd=wrong_cwd)
        self.assertEqual(result.returncode, 3)
        response = json.loads(result.stdout)
        self.assertEqual(response["error"]["code"], "observed_cwd_mismatch")
        self.assertEqual(response["pane_id"], "new-pane")
        herdr_calls = [call["argv"] for call in self.calls() if call["program"] == "herdr"]
        self.assertFalse(any(argv[0:2] == ["pane", "close"] for argv in herdr_calls))
        self.assertFalse((self.state_home / "monash" / "last-success.json").exists())

    def test_spawn_verify_reports_session_only_after_the_first_turn(self) -> None:
        result = self.run_monash(*self.success_arguments()[:-4], "--verify", "--", "--resume", "literal space", "$(never-expand)")
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["status"], "verified")
        self.assertEqual(receipt["session_id"], "native-gpt55-session")
        self.assertEqual(receipt["host"], "laptop")
        self.assertEqual(receipt["model"], "gpt-5.5")
        self.assertEqual(receipt["agent"], "codex")
        self.assertEqual(receipt["billing_identity"], "monash-foundry")
        self.assertEqual(receipt["requested_cwd"], str(self.workdir.resolve()))
        self.assertEqual(receipt["execution_cwd"], str(self.workdir.resolve()))
        self.assertEqual(receipt["native_identity"]["agent_session"], {
            "source": "herdr:codex", "agent": "codex", "kind": "id", "value": "native-gpt55-session",
        })
        calls = [call["argv"] for call in self.calls() if call["program"] == "herdr"]
        self.assertEqual(sum(argv[0:2] == ["agent", "prompt"] for argv in calls), 1)
        self.assertTrue((self.state_home / "monash" / "last-success.json").exists())

    def test_spawn_verify_reconciles_stalled_prompt_without_resubmission(self) -> None:
        result = self.run_monash(
            *self.success_arguments()[:-4],
            "--verify", "--", "--resume", "literal space", "$(never-expand)",
            verify_prompt_stalled=True,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["status"], "verified")
        self.assertEqual(receipt["session_id"], "native-gpt55-session")
        calls = [call["argv"] for call in self.calls() if call["program"] == "herdr"]
        self.assertEqual(sum(argv[0:2] == ["agent", "prompt"] for argv in calls), 1)
        self.assertGreaterEqual(sum(argv[0:2] == ["agent", "get"] for argv in calls), 3)
        state = json.loads(self.fake_state.read_text(encoding="utf-8"))
        self.assertEqual(state["verification_gets"], 2)
        self.assertTrue((self.state_home / "monash" / "last-success.json").exists())

    def test_spawn_verify_rejects_session_observed_after_original_deadline(self) -> None:
        source = self.monash.read_text(encoding="utf-8")
        shortened = source.replace("VERIFY_TIMEOUT_MS = 120_000", "VERIFY_TIMEOUT_MS = 20", 1)
        self.assertNotEqual(shortened, source)
        self.monash.write_text(shortened, encoding="utf-8")
        result = self.run_monash(
            *self.success_arguments()[:-4],
            "--verify", "--", "--resume", "literal space", "$(never-expand)",
            verify_prompt_stalled=True,
            verify_session_after_deadline=True,
        )

        self.assertEqual(result.returncode, 3)
        response = json.loads(result.stdout)
        self.assertEqual(response["error"]["code"], "verification_not_settled")
        calls = [call["argv"] for call in self.calls() if call["program"] == "herdr"]
        self.assertEqual(sum(argv[0:2] == ["agent", "prompt"] for argv in calls), 1)
        saved = json.loads((self.state_home / "monash" / "last-success.json").read_text(encoding="utf-8"))
        self.assertNotIn("session_id", saved)

    def test_verify_command_uses_the_ready_receipt_agent_name(self) -> None:
        ready = self.run_monash(*self.success_arguments())
        self.assertEqual(ready.returncode, 0, ready.stderr)
        name = json.loads(ready.stdout)["agent_name"]
        result = self.run_monash("verify", name)
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["command"], "verify")
        self.assertEqual(receipt["status"], "verified")
        self.assertEqual(receipt["session_id"], "native-gpt55-session")

    def test_verify_refuses_a_session_reported_by_the_wrong_authority(self) -> None:
        ready = self.run_monash(*self.success_arguments())
        self.assertEqual(ready.returncode, 0, ready.stderr)
        name = json.loads(ready.stdout)["agent_name"]
        result = self.run_monash("verify", name, session_source_mismatch=True)
        self.assertEqual(result.returncode, 3)
        self.assertEqual(json.loads(result.stdout)["error"]["code"], "agent_session_unavailable")

    def test_timeout_preserves_pane_without_retry_or_persistence(self) -> None:
        result = self.run_monash(*self.success_arguments(), start_timeout=True)
        self.assertEqual(result.returncode, 3)
        response = json.loads(result.stdout)
        self.assertEqual(response["error"]["code"], "native_not_ready")
        self.assertEqual(response["pane_id"], "new-pane")
        calls = [call["argv"] for call in self.calls() if call["program"] == "herdr"]
        self.assertEqual(sum(argv[0:2] == ["agent", "start"] for argv in calls), 1)
        self.assertFalse(any(argv[0:2] == ["agent", "prompt"] for argv in calls))
        self.assertFalse((self.state_home / "monash" / "last-success.json").exists())

    def test_spawn_retries_one_side_effect_free_agent_not_ready(self) -> None:
        result = self.run_monash(*self.success_arguments(), start_agent_not_ready_once=True)

        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["status"], "ready")
        self.assertEqual(receipt["pane_id"], "new-pane")
        calls = [call["argv"] for call in self.calls() if call["program"] == "herdr"]
        starts = [argv for argv in calls if argv[0:2] == ["agent", "start"]]
        self.assertEqual(len(starts), 2)
        self.assertEqual(starts[0], starts[1])
        self.assertEqual(sum(argv[0:2] == ["pane", "split"] for argv in calls), 1)
        self.assertEqual(sum(argv[0:2] == ["agent", "prompt"] for argv in calls), 0)
        spawn_root = self.state_home / "monash" / "spawns"
        self.assertEqual(len(list(spawn_root.iterdir())), 1)
        self.assertTrue((self.state_home / "monash" / "last-success.json").exists())

    def test_login_shell_path_rewrite_refuses_before_agent_start(self) -> None:
        result = self.run_monash(*self.success_arguments(), login_path_rewrite=True)
        self.assertEqual(result.returncode, 3)
        self.assertEqual(json.loads(result.stdout)["error"]["code"], "shim_resolution_failed")
        calls = [call["argv"] for call in self.calls() if call["program"] == "herdr"]
        self.assertFalse(any(argv[0:2] == ["agent", "start"] for argv in calls))
        self.assertFalse((self.state_home / "monash" / "last-success.json").exists())

    def test_echoed_shim_probe_command_cannot_satisfy_the_sentinel_wait(self) -> None:
        result = self.run_monash(*self.success_arguments(), echoed_probe_command=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = [call["argv"] for call in self.calls() if call["program"] == "herdr"]
        wait = next(argv for argv in calls if argv[0:2] == ["pane", "wait-output"])
        shim = json.loads(self.fake_state.read_text(encoding="utf-8"))["expected_shim"]
        self.assertEqual(wait[4], r"^__MONASH_SHIM_(?:OK__=" + re.escape(shim) + r"|MISMATCH__=.*)$")

    def test_wrong_real_executable_and_hinted_launcher_are_not_ready(self) -> None:
        for flag in ("wrong_executable", "hinted_launcher", "shim_recursion"):
            with self.subTest(flag=flag):
                result = self.run_monash(*self.success_arguments(), **{flag: True})
                self.assertEqual(result.returncode, 3)
                self.assertEqual(json.loads(result.stdout)["error"]["code"], "native_process_unverified")
                self.assertFalse((self.state_home / "monash" / "last-success.json").exists())
                self.log_path.unlink(missing_ok=True)
                self.fake_state.unlink(missing_ok=True)

    def test_ssh_start_preserves_helper_argv_and_attaches_one_local_sibling(self) -> None:
        self.install_remote_helper()
        result = self.run_monash(*self.remote_arguments())
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)

        self.assertEqual(receipt["status"], "ready")
        self.assertEqual(receipt["host"], "mini")
        self.assertEqual(receipt["transport"], "ssh")
        self.assertEqual(receipt["model"], "gpt-5.5")
        self.assertEqual(receipt["agent"], "codex")
        self.assertEqual(receipt["requested_cwd"], str(self.workdir.resolve()))
        self.assertEqual(receipt["execution_cwd"], "/Users/server/code/project")
        self.assertEqual(receipt["expected_cwd"], "/Users/server/code/project")
        self.assertEqual(receipt["expected_cwd_source"], "explicit_remote_cwd")
        self.assertEqual(receipt["observed_cwd"], "/Users/server/code/project")
        self.assertEqual(receipt["actual_cwd"], "/Users/server/code/project")
        self.assertEqual(receipt["execution_cwd_source"], "remote.herdr.agent.get")
        self.assertEqual(receipt["actual_cwd_source"], "remote.herdr.agent.get")
        self.assertEqual(receipt["execution_host"], {
            "value": "mini-test-host",
            "source": "ssh+/bin/hostname",
            "observed_at": "2026-09-09T00:00:00Z",
        })
        self.assertEqual(receipt["local_identity"], {
            "pane_id": "new-pane", "tab_id": "tab-main", "terminal_id": "local-terminal",
        })
        self.assertEqual(receipt["pane_id"], "new-pane")
        self.assertEqual(receipt["terminal_id"], "local-terminal")
        self.assertEqual(receipt["remote_identity"], {
            "workspace_id": "remote-workspace",
            "tab_id": "remote-tab",
            "pane_id": "remote-pane",
            "terminal_id": "remote-terminal",
            "agent_name": "remote-agent-1",
            "agent_session": {
                "source": "herdr:codex", "agent": "codex", "kind": "id", "value": "remote-session-1",
            },
            "session_id": "remote-session-1",
        })
        self.assertEqual(receipt["session_id"], "remote-session-1")
        self.assertEqual(receipt["lifecycle"], {"state": "idle", "source": "remote.herdr.agent.get"})

        calls = self.calls()
        helper_calls = [call["argv"] for call in calls if call["program"] == "monash_remote"]
        run_id_index = helper_calls[0].index("--run-id")
        run_id = self.assert_run_id(helper_calls[0][run_id_index + 1])
        self.assertEqual(helper_calls, [[
            "--config", str(self.config.resolve()), "--host", "mini", "start", "--run-id", run_id,
            "--agent", "codex", "--model", "gpt-5.5", "--cwd", str(self.workdir.resolve()),
            "--remote-cwd", "/Users/server/code/project", "--", "--resume", "literal space",
            "$(never-expand)",
        ]])
        self.assertEqual(receipt["run_id"], run_id)
        herdr_calls = [call["argv"] for call in calls if call["program"] == "herdr"]
        self.assertEqual([argv for argv in herdr_calls if argv[0:2] == ["pane", "split"]], [[
            "pane", "split", "caller-pane", "--direction", "right", "--cwd", str(self.workdir.resolve()), "--no-focus",
        ]])
        attach = [argv for argv in herdr_calls if argv[0:2] == ["pane", "run"]]
        self.assertEqual(attach, [[
            "pane", "run", "new-pane", shlex.join([
                "ssh", "-tt", "mac-mini", "/opt/homebrew/bin/herdr", "--session", "monash-foundry",
                "agent", "attach", "remote-agent-1",
            ]),
        ]])
        self.assertEqual(receipt["local_attach"], {
            "status": "observed",
            "pid": 55,
            "argv0": "ssh",
            "argv": [
                "ssh", "-tt", "mac-mini", "/opt/homebrew/bin/herdr", "--session", "monash-foundry",
                "agent", "attach", "remote-agent-1",
            ],
            "cwd": str(self.workdir.resolve()),
        })
        attach_index = next(index for index, call in enumerate(calls)
                            if call["program"] == "herdr" and call["argv"] == attach[0])
        attach_observation_index = next(index for index, call in enumerate(calls[attach_index + 1:], attach_index + 1)
                                        if call["program"] == "herdr"
                                        and call["argv"][0:2] == ["pane", "process-info"])
        metadata_index = next(index for index, call in enumerate(calls)
                              if call["program"] == "herdr"
                              and call["argv"][0:2] == ["pane", "report-metadata"])
        self.assertLess(attach_index, attach_observation_index)
        self.assertLess(attach_observation_index, metadata_index)
        metadata = calls[metadata_index]["argv"]
        tokens = [metadata[index + 1] for index, value in enumerate(metadata) if value == "--token"]
        self.assertIn("host=mini", tokens)
        self.assertIn("model=gpt-5.5", tokens)
        self.assertIn("agent=codex", tokens)
        self.assertFalse(any(argv[0:2] == ["agent", "start"] for argv in herdr_calls))
        self.assertFalse(any(argv[0:2] == ["agent", "prompt"] for argv in herdr_calls))
        saved = json.loads((self.state_home / "monash" / "last-success.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["host"], "mini")
        self.assertEqual(saved["run_id"], run_id)

    def test_ssh_start_without_explicit_remote_cwd_preserves_literal_native_argv(self) -> None:
        self.install_remote_helper()
        result = self.run_monash(*self.remote_arguments(remote_cwd=None))
        self.assertEqual(result.returncode, 0, result.stderr)
        helper_call = next(call["argv"] for call in self.calls() if call["program"] == "monash_remote")
        self.assertNotIn("--remote-cwd", helper_call)
        self.assertEqual(helper_call[-4:], ["--", "--resume", "literal space", "$(never-expand)"])

    def test_ssh_start_forwards_qualification_exactly(self) -> None:
        self.install_remote_helper()
        result = self.run_monash(*self.remote_arguments(qualification=True))
        self.assertEqual(result.returncode, 0, result.stderr)
        helper_call = next(call["argv"] for call in self.calls() if call["program"] == "monash_remote")
        self.assertEqual(helper_call.count("--qualification"), 1)
        qualification_index = helper_call.index("--qualification")
        self.assertEqual(helper_call[qualification_index - 1], "gpt-5.5")

    def test_ssh_catalogue_validation_does_not_require_a_laptop_native_executable(self) -> None:
        self.install_remote_helper()
        missing_native = self.root / "native executable only on Mini"
        result = self.run_monash(*self.remote_arguments(), real_native=missing_native)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["status"], "ready")
        self.assertEqual(sum(call["program"] == "monash_remote" for call in self.calls()), 1)
        herdr_calls = [call["argv"] for call in self.calls() if call["program"] == "herdr"]
        self.assertEqual(sum(argv[0:2] == ["pane", "split"] for argv in herdr_calls), 1)

    def test_ssh_catalogue_selection_refusal_happens_before_pane_effect(self) -> None:
        self.install_remote_helper()
        result = self.run_monash(*self.remote_arguments(), selection_refused=True)
        self.assertEqual(result.returncode, 3)
        self.assertEqual(json.loads(result.stdout)["error"]["code"], "selection_refused")
        self.assertEqual([call["program"] for call in self.calls()], ["monash-foundry"])

    def assert_remote_refusal(self, result: subprocess.CompletedProcess[str], code: str,
                              expected_helper_calls: int = 1) -> dict[str, object]:
        self.assertEqual(result.returncode, 3, result.stderr)
        response = json.loads(result.stdout)
        self.assertEqual(response["status"], "refused")
        self.assertEqual(response["error"]["code"], code)
        self.assertFalse((self.state_home / "monash" / "last-success.json").exists())
        helper_calls = [call for call in self.calls() if call["program"] == "monash_remote"]
        self.assertEqual(len(helper_calls), expected_helper_calls)
        herdr_calls = [call["argv"] for call in self.calls() if call["program"] == "herdr"]
        self.assertFalse(any(argv[0:2] == ["agent", "start"] for argv in herdr_calls))
        self.assertFalse(any(argv[0:2] == ["agent", "prompt"] for argv in herdr_calls))
        return response

    def test_ssh_malformed_helper_json_refuses_without_attach_or_state(self) -> None:
        self.install_remote_helper()
        result = self.run_monash(*self.remote_arguments(), remote_malformed=True)
        self.assert_remote_refusal(result, "remote_helper_protocol_invalid")
        self.assertFalse(any(call["argv"][0:2] == ["pane", "run"] for call in self.calls()
                             if call["program"] == "herdr"))

    def test_ssh_structured_helper_refusal_has_no_local_fallback_or_state(self) -> None:
        self.install_remote_helper()
        result = self.run_monash(*self.remote_arguments(), remote_refusal=True)
        response = self.assert_remote_refusal(result, "remote_test_refused")
        self.assertEqual(response["error"]["message"], "test-owned remote refusal")
        self.assertNotIn("running_agent", response)

    def test_ssh_post_pane_refusal_preserves_intended_remote_identity_without_proof(self) -> None:
        self.install_remote_helper()
        result = self.run_monash(*self.remote_arguments(), remote_post_pane_refusal=True)
        response = self.assert_remote_refusal(result, "remote_shim_resolution_failed")
        running = response["running_agent"]
        run_id = self.assert_run_id(running["run_id"])
        helper_call = next(call["argv"] for call in self.calls() if call["program"] == "monash_remote")
        self.assertEqual(helper_call[helper_call.index("--run-id") + 1], run_id)
        self.assertEqual(running["local_identity"], {
            "pane_id": "new-pane", "tab_id": "tab-main", "terminal_id": "local-terminal",
        })
        self.assertEqual(running["remote_identity"], {
            "workspace_id": "remote-workspace",
            "tab_id": "remote-tab",
            "pane_id": "remote-pane",
            "terminal_id": "remote-terminal",
            "intended_agent_name": "remote-agent-intended",
        })
        self.assertNotIn("agent_name", running)
        self.assertNotIn("session_id", running)
        self.assertNotIn("status", running)
        herdr_calls = [call["argv"] for call in self.calls() if call["program"] == "herdr"]
        self.assertFalse(any(argv[0:2] == ["pane", "run"] for argv in herdr_calls))

    def test_ssh_post_start_refusal_preserves_proven_remote_identity_and_observation(self) -> None:
        self.install_remote_helper()
        result = self.run_monash(*self.remote_arguments(), remote_post_start_refusal=True)
        response = self.assert_remote_refusal(result, "remote_agent_blocked")
        running = response["running_agent"]
        run_id = self.assert_run_id(running["run_id"])
        helper_call = next(call["argv"] for call in self.calls() if call["program"] == "monash_remote")
        self.assertEqual(helper_call[helper_call.index("--run-id") + 1], run_id)
        self.assertEqual(running["local_identity"], {
            "pane_id": "new-pane", "tab_id": "tab-main", "terminal_id": "local-terminal",
        })
        self.assertEqual(running["remote_identity"], {
            "workspace_id": "remote-workspace",
            "tab_id": "remote-tab",
            "pane_id": "remote-pane",
            "terminal_id": "remote-terminal",
            "agent_name": "remote-agent-1",
        })
        self.assertEqual(running["observation"], {
            "source": "remote.herdr.agent.get",
            "workspace_id": "remote-workspace",
            "tab_id": "remote-tab",
            "pane_id": "remote-pane",
            "terminal_id": "remote-terminal",
            "agent": "codex",
            "agent_status": "blocked",
            "cwd": "/Users/server/code/project",
            "interactive_ready": False,
        })
        self.assertNotIn("agent_name", running)
        self.assertNotIn("session_id", running)
        self.assertNotIn("status", running)
        herdr_calls = [call["argv"] for call in self.calls() if call["program"] == "herdr"]
        self.assertFalse(any(argv[0:2] == ["pane", "run"] for argv in herdr_calls))

    def test_ssh_started_without_session_refuses_before_attach(self) -> None:
        self.install_remote_helper()
        result = self.run_monash(*self.remote_arguments(), remote_started=True)
        response = self.assert_remote_refusal(result, "remote_not_ready")
        run_id = self.assert_run_id(response["running_agent"]["run_id"])
        helper_call = next(call["argv"] for call in self.calls() if call["program"] == "monash_remote")
        self.assertEqual(helper_call[helper_call.index("--run-id") + 1], run_id)
        self.assertEqual(response["running_agent"]["local_identity"], {
            "pane_id": "new-pane", "tab_id": "tab-main", "terminal_id": "local-terminal",
        })
        self.assertEqual(response["running_agent"]["remote_identity"]["agent_name"], "remote-agent-1")
        self.assertFalse(any(call["argv"][0:2] == ["pane", "run"] for call in self.calls()
                             if call["program"] == "herdr"))

    def test_ssh_start_timeout_returns_frontend_run_id_and_recovery_identity(self) -> None:
        self.install_remote_helper()
        result = self.run_monash(*self.remote_arguments(), remote_start_timeout=True)
        response = self.assert_remote_refusal(result, "remote_native_not_ready")
        run_id = self.assert_run_id(response["running_agent"]["run_id"])
        helper_call = next(call["argv"] for call in self.calls() if call["program"] == "monash_remote")
        self.assertEqual(helper_call[helper_call.index("--run-id") + 1], run_id)
        self.assertEqual(response["running_agent"]["local_identity"]["pane_id"], "new-pane")
        self.assertEqual(response["running_agent"]["remote_identity"]["intended_agent_name"],
                         "remote-agent-intended")
        self.assertIn("inspect recovery state", response["error"]["repair"])
        self.assertIn("do not blindly retry spawn", response["error"]["repair"])
        self.assertFalse(any(call["argv"][0:2] == ["pane", "run"] for call in self.calls()
                             if call["program"] == "herdr"))

    def test_ssh_missing_session_refuses_before_attach(self) -> None:
        self.install_remote_helper()
        result = self.run_monash(*self.remote_arguments(), remote_session_missing=True)
        self.assert_remote_refusal(result, "remote_not_ready")

    def test_ssh_started_with_verify_uses_one_helper_prompt_before_attach(self) -> None:
        self.install_remote_helper()
        result = self.run_monash(*self.remote_arguments(verify=True), remote_started=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["status"], "verified")
        self.assertEqual(receipt["session_id"], "remote-session-1")
        helper_calls = [call["argv"] for call in self.calls() if call["program"] == "monash_remote"]
        self.assertEqual(sum(call[4] == "start" for call in helper_calls), 1)
        self.assertEqual(sum(call[4] == "prompt" for call in helper_calls), 1)
        self.assertEqual(len(helper_calls), 2)
        prompt_timeout_index = helper_calls[1].index("--timeout")
        self.assertEqual(helper_calls[1][prompt_timeout_index + 1], "120000")
        calls = self.calls()
        prompt_index = next(index for index, call in enumerate(calls)
                            if call["program"] == "monash_remote" and call["argv"][4] == "prompt")
        attach_index = next(index for index, call in enumerate(calls)
                            if call["program"] == "herdr" and call["argv"][0:2] == ["pane", "run"])
        self.assertLess(prompt_index, attach_index)
        self.assertEqual(sum(call["program"] == "monash_remote" and call["argv"][4] == "prompt"
                              for call in calls), 1)
        self.assertEqual(sum(call["program"] == "herdr" and call["argv"][0:2] == ["pane", "run"]
                              for call in calls), 1)
        herdr_calls = [call["argv"] for call in calls if call["program"] == "herdr"]
        self.assertFalse(any(argv[0:2] == ["agent", "prompt"] for argv in herdr_calls))

    def test_ssh_verify_timeout_returns_the_start_run_id_without_attach_or_state(self) -> None:
        self.install_remote_helper()
        result = self.run_monash(*self.remote_arguments(verify=True), remote_verify_timeout=True)
        response = self.assert_remote_refusal(result, "remote_verify_timed_out", expected_helper_calls=2)
        helper_calls = [call["argv"] for call in self.calls() if call["program"] == "monash_remote"]
        run_id = self.assert_run_id(helper_calls[0][helper_calls[0].index("--run-id") + 1])
        self.assertEqual(helper_calls[1][helper_calls[1].index("--run-id") + 1], run_id)
        self.assertEqual(response["running_agent"]["run_id"], run_id)
        self.assertEqual(response["running_agent"]["observation"], {
            "source": "remote.herdr.agent.get",
            "agent": "codex",
            "agent_status": "idle",
            "interactive_ready": True,
        })
        self.assertIn("inspect recovery state", response["error"]["repair"])
        self.assertIn("do not blindly retry spawn", response["error"]["repair"])
        herdr_calls = [call["argv"] for call in self.calls() if call["program"] == "herdr"]
        self.assertFalse(any(argv[0:2] == ["pane", "run"] for argv in herdr_calls))
        self.assertFalse(any(argv[0:2] == ["pane", "report-metadata"] for argv in herdr_calls))

    def test_ssh_nonready_observation_refuses_before_attach(self) -> None:
        self.install_remote_helper()
        result = self.run_monash(*self.remote_arguments(), remote_not_ready=True)
        self.assert_remote_refusal(result, "remote_not_ready")

    def test_ssh_mismatched_attach_argv_refuses_before_attach(self) -> None:
        self.install_remote_helper()
        result = self.run_monash(*self.remote_arguments(), remote_attach_mismatch=True)
        self.assert_remote_refusal(result, "remote_attach_mismatch")
        self.assertFalse(any(call["argv"][0:2] == ["pane", "run"] for call in self.calls()
                             if call["program"] == "herdr"))

    def test_ssh_mismatched_remote_identity_refuses_before_attach(self) -> None:
        self.install_remote_helper()
        result = self.run_monash(*self.remote_arguments(), remote_identity_mismatch=True)
        self.assert_remote_refusal(result, "remote_identity_mismatch")
        self.assertFalse(any(call["argv"][0:2] == ["pane", "run"] for call in self.calls()
                             if call["program"] == "herdr"))

    def test_ssh_local_attach_failure_preserves_remote_identity_without_state(self) -> None:
        self.install_remote_helper()
        result = self.run_monash(*self.remote_arguments(), attach_failure=True)
        response = self.assert_remote_refusal(result, "herdr_command_failed")
        self.assertEqual(response["pane_id"], "new-pane")
        self.assertEqual(response["running_agent"]["agent_name"], "remote-agent-1")
        self.assertEqual(sum(call["program"] == "monash_remote" for call in self.calls()), 1)

    def test_ssh_attach_process_mismatch_refuses_without_metadata_or_state(self) -> None:
        self.install_remote_helper()
        result = self.run_monash(*self.remote_arguments(), attach_process_mismatch=True)
        response = self.assert_remote_refusal(result, "local_attach_unverified")
        self.assertEqual(response["running_agent"]["local_identity"]["pane_id"], "new-pane")
        self.assertEqual(response["running_agent"]["remote_identity"]["pane_id"], "remote-pane")
        herdr_calls = [call["argv"] for call in self.calls() if call["program"] == "herdr"]
        self.assertEqual(sum(argv[0:2] == ["pane", "run"] for argv in herdr_calls), 1)
        self.assertFalse(any(argv[0:2] == ["pane", "report-metadata"] for argv in herdr_calls))

    def test_ssh_metadata_failure_preserves_both_recovery_identities(self) -> None:
        self.install_remote_helper()
        result = self.run_monash(*self.remote_arguments(), metadata_failure=True)
        response = self.assert_remote_refusal(result, "metadata_report_failed")
        running = response["running_agent"]
        self.assertEqual(running["local_identity"], {
            "pane_id": "new-pane", "tab_id": "tab-main", "terminal_id": "local-terminal",
        })
        self.assertEqual(running["remote_identity"]["agent_name"], "remote-agent-1")
        self.assertEqual(running["remote_identity"]["session_id"], "remote-session-1")
        self.assertEqual(sum(call["program"] == "monash_remote" for call in self.calls()), 1)
        herdr_calls = [call["argv"] for call in self.calls() if call["program"] == "herdr"]
        self.assertEqual(sum(argv[0:2] == ["pane", "report-metadata"] for argv in herdr_calls), 1)

    def test_ssh_verify_uses_remote_helper_and_never_local_herdr_prompt(self) -> None:
        self.install_remote_helper()
        result = self.run_monash(*self.remote_arguments(verify=True))
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["status"], "verified")
        self.assertEqual(receipt["session_id"], "remote-session-1")
        helper_calls = [call["argv"] for call in self.calls() if call["program"] == "monash_remote"]
        self.assertEqual([call[4] for call in helper_calls], ["start", "prompt"])
        self.assertEqual(sum(call[4] == "prompt" for call in helper_calls), 1)
        prompt_timeout_index = helper_calls[1].index("--timeout")
        self.assertEqual(helper_calls[1][prompt_timeout_index + 1], "120000")
        self.assertIn("--run-id", helper_calls[1])
        start_run_id = self.assert_run_id(helper_calls[0][helper_calls[0].index("--run-id") + 1])
        self.assertEqual(helper_calls[1][helper_calls[1].index("--run-id") + 1], start_run_id)
        self.assertEqual(receipt["run_id"], start_run_id)
        self.assertIn("--wait", helper_calls[1])
        calls = self.calls()
        prompt_index = next(index for index, call in enumerate(calls)
                            if call["program"] == "monash_remote" and call["argv"][4] == "prompt")
        attach_index = next(index for index, call in enumerate(calls)
                            if call["program"] == "herdr" and call["argv"][0:2] == ["pane", "run"])
        self.assertLess(prompt_index, attach_index)
        self.assertEqual(sum(call["program"] == "monash_remote" and call["argv"][4] == "prompt"
                              for call in calls), 1)
        self.assertEqual(sum(call["program"] == "herdr" and call["argv"][0:2] == ["pane", "run"]
                              for call in calls), 1)
        herdr_calls = [call["argv"] for call in calls if call["program"] == "herdr"]
        self.assertFalse(any(argv[0:2] == ["agent", "prompt"] for argv in herdr_calls))
        self.assertTrue((self.state_home / "monash" / "last-success.json").exists())

    def test_ssh_verify_prompt_refusal_preserves_identity_without_attach_or_state(self) -> None:
        self.install_remote_helper()
        result = self.run_monash(*self.remote_arguments(verify=True), remote_verify_refusal=True)
        response = self.assert_remote_refusal(result, "remote_verify_refused", expected_helper_calls=2)
        self.assertEqual(response["running_agent"]["local_identity"]["pane_id"], "new-pane")
        self.assertEqual(response["running_agent"]["remote_identity"]["agent_name"], "remote-agent-1")
        herdr_calls = [call["argv"] for call in self.calls() if call["program"] == "herdr"]
        self.assertFalse(any(argv[0:2] == ["pane", "run"] for argv in herdr_calls))
        self.assertFalse(any(argv[0:2] == ["pane", "report-metadata"] for argv in herdr_calls))

    def test_ssh_verify_prompt_identity_mismatch_refuses_without_attach_or_state(self) -> None:
        self.install_remote_helper()
        result = self.run_monash(*self.remote_arguments(verify=True), remote_verify_identity_mismatch=True)
        response = self.assert_remote_refusal(result, "remote_identity_mismatch", expected_helper_calls=2)
        self.assertEqual(response["running_agent"]["local_identity"]["pane_id"], "new-pane")
        self.assertEqual(response["running_agent"]["remote_identity"]["pane_id"], "remote-pane")
        herdr_calls = [call["argv"] for call in self.calls() if call["program"] == "herdr"]
        self.assertFalse(any(argv[0:2] == ["pane", "run"] for argv in herdr_calls))
        self.assertFalse(any(argv[0:2] == ["pane", "report-metadata"] for argv in herdr_calls))

    def test_ssh_profile_refuses_without_helper_or_local_pane_fallback(self) -> None:
        result = self.run_monash(
            "spawn", "--host", "mini", "--model", "gpt-5.5", "--agent", "codex", "--cwd", str(self.workdir),
        )
        self.assertEqual(result.returncode, 3)
        self.assertEqual(json.loads(result.stdout)["error"]["code"], "remote_helper_unavailable")
        self.assertEqual([call["program"] for call in self.calls()], ["monash-foundry"])

    def test_picker_filters_incompatible_remembered_agent_to_a_valid_default(self) -> None:
        state_directory = self.state_home / "monash"
        state_directory.mkdir(parents=True)
        (state_directory / "last-success.json").write_text(json.dumps({
            "schema_version": 1,
            "host": "laptop",
            "model": "gpt-5.5",
            "agent": "claude",
            "cwd": str(self.workdir),
            "run_id": "old-run",
        }), encoding="utf-8")
        result = self.run_picker("launch", "--host", "laptop", "--model", "gpt-5.5", input_text="\n\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        start_call = next(call["argv"] for call in self.calls()
                          if call["program"] == "herdr" and call["argv"][0:2] == ["agent", "start"])
        self.assertEqual(start_call[start_call.index("--kind") + 1], "codex")

    def test_explicit_blocked_observation_preserves_pane_and_session_without_answering(self) -> None:
        result = self.run_monash(*self.success_arguments(), agent_status="blocked")
        self.assertEqual(result.returncode, 3)
        response = json.loads(result.stdout)
        self.assertEqual(response["error"]["code"], "startup_blocked")
        self.assertEqual(response["pane_id"], "new-pane")
        self.assertEqual(response["running_agent"]["pane_id"], "new-pane")
        self.assertTrue(response["running_agent"]["agent_name"].startswith("monash-"))
        self.assertEqual(response["agent_observation"], {
            "pane_id": "new-pane",
            "agent": "codex",
            "agent_status": "blocked",
            "cwd": str(self.workdir),
            "source": "herdr.agent.get",
        })
        herdr_calls = [call["argv"] for call in self.calls() if call["program"] == "herdr"]
        self.assertFalse(any(argv[0:2] == ["pane", "close"] for argv in herdr_calls))
        self.assertFalse((self.state_home / "monash" / "last-success.json").exists())

    def test_metadata_failure_keeps_native_identity_and_does_not_persist_or_retry(self) -> None:
        result = self.run_monash(*self.success_arguments(), metadata_failure=True)
        self.assertEqual(result.returncode, 3)
        response = json.loads(result.stdout)
        self.assertEqual(response["error"]["code"], "metadata_report_failed")
        self.assertEqual(response["pane_id"], "new-pane")
        self.assertEqual(response["running_agent"]["agent_name"][:7], "monash-")
        self.assertEqual(response["running_agent"]["native_identity"]["native_executable"], str(self.real_native))
        self.assertFalse((self.state_home / "monash" / "last-success.json").exists())
        foundry_calls = [call for call in self.calls() if call["program"] == "monash-foundry"]
        self.assertEqual(len(foundry_calls), 1)

    def test_shim_state_directory_failure_stops_before_native_start(self) -> None:
        self.state_home.write_text("not a directory", encoding="utf-8")
        result = self.run_monash(*self.success_arguments())
        self.assertEqual(result.returncode, 3)
        response = json.loads(result.stdout)
        self.assertEqual(response["error"]["code"], "shim_creation_failed")
        self.assertEqual(response["pane_id"], "new-pane")
        self.assertFalse((self.state_home / "monash" / "last-success.json").exists())
        foundry_calls = [call for call in self.calls() if call["program"] == "monash-foundry"]
        self.assertEqual(len(foundry_calls), 1)


if __name__ == "__main__":
    unittest.main()
