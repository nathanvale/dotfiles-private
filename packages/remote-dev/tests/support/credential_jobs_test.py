"""Offline restore contract regressions. Native commands and time are fakes."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('jobs', Path(__file__).parents[2] / 'resources/credential_jobs.py')
jobs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jobs)


class RestoreFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.root.chmod(0o700)
        self.roles = {role: ({'sha256': role, 'path': role + '.plist'}, {
            'Label': role, 'ProgramArguments': [role, '--fixture', '/unused/bun'],
            'StandardOutPath': str(self.root / (role + '.out')),
            'StandardErrorPath': str(self.root / (role + '.err'))}) for role in ['cache', 'delivery']}
        self.configs = {}
        for role in ['claude', 'codex', 'bitbucket']:
            path = self.root / role
            path.mkdir(mode=0o700)
            self.configs[role] = {'stateDirectory': str(path)}
        self.now = 0
        self.pids = {}
        self.started = []
        self.admission()
        self.bundle = (self.root, self.roles, self.configs, self.root)
        patches = [patch.object(jobs, 'jobs', side_effect=lambda *a, **k: self.pids.copy()),
                   patch.object(jobs, 'observe', side_effect=self.observe),
                   patch.object(jobs, 'same_process', return_value=True),
                   patch.object(jobs, 'lease_ready', return_value=True),
                   patch.object(jobs, 'command', side_effect=self.command),
                   patch.object(jobs.time, 'monotonic', side_effect=lambda: self.now)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def file(self, path, value):
        path.write_text(json.dumps(value))
        path.chmod(0o600)
        return {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}

    def admission(self, uncertain=False):
        result = self.file(self.root / 'previous-result.json', {'result': {
            'commandIdentity': 'deployment.credential-serve', 'outcome': 'failed',
            'transactionState': 'unknown' if uncertain else 'completed',
            'effects': {'completed': ['effect.credential-frame'], 'uncertain': ['effect.credential-frame'] if uncertain else [],
                        'inventoryComplete': True, 'remaining': []}}})
        logs = [self.root / 'restore-result.json'] + [Path(self.roles['delivery'][1][k]) for k in ['StandardOutPath', 'StandardErrorPath']]
        self.file(self.root / 'manifest.json', {'priorOutcomes': {
            'decision': 'reviewed-new-owner', 'result': result,
            'states': [{'path': c['stateDirectory'], 'files': []} for c in self.configs.values()],
            'logs': [{'path': str(p), 'sha256': None} for p in logs]}})

    def observe(self, *args, **kwargs):
        return {'cachePresent': 'cache' in self.pids, 'eventListeners': [21, 22] if 'delivery' in self.pids else []}

    def command(self, argv, *args, **kwargs):
        if 'bootstrap' in argv:
            role = Path(argv[-1]).stem
            self.started.append('register:' + role)
            return subprocess.CompletedProcess(argv, 0, b'')
        if 'kickstart' in argv:
            role = argv[-1].split('/')[-1]
            self.pids[role] = 10 if role == 'cache' else 11
            self.started.append('start:' + role)
            return subprocess.CompletedProcess(argv, 0, str(self.pids[role]).encode())
        return subprocess.CompletedProcess(argv, 0, b'')

    def restore(self):
        return jobs.restore(type('Args', (), {'credential_manifest': str(self.root / 'manifest.json'), 'credential_manifest_sha256': hashlib.sha256((self.root / 'manifest.json').read_bytes()).hexdigest()})(), self.bundle)


class RestoreTests(RestoreFixture):
    def test_missing_prior_admission_refuses_without_launch(self):
        self.file(self.root / 'manifest.json', {})
        result = self.restore()
        self.assertFalse(result['credentials'])
        self.assertEqual(self.started, [])

    def test_uncertain_prior_result_refuses_without_launch(self):
        self.admission(uncertain=True)
        self.assertFalse(self.restore()['credentials'])
        self.assertEqual(self.started, [])

    def test_changed_journal_refuses_without_launch(self):
        self.file(self.root / 'claude/request-new.journal.jsonl', {'phase': 'intent'})
        self.assertFalse(self.restore()['credentials'])
        self.assertEqual(self.started, [])

    def test_reviewed_settled_failure_can_start_and_reuse_healthy_jobs(self):
        self.assertTrue(self.restore()['credentials'])
        self.assertEqual(self.started, ['register:cache', 'start:cache', 'register:delivery', 'start:delivery'])
        self.started.clear()
        self.assertTrue(self.restore()['credentials'])
        self.assertEqual(self.started, [])

    def test_failed_readiness_is_not_automatically_retried_even_with_healthy_pids(self):
        self.assertTrue(self.restore()['credentials'])
        self.file(self.root / 'restore-result.json', {'credentials': False})
        self.assertFalse(self.restore()['credentials'])

    def test_native_journal_owner_refusal_prevents_actuation(self):
        with patch.object(jobs, 'command', return_value=subprocess.CompletedProcess([], 1, b'')):
            self.assertFalse(self.restore()['credentials'])
        self.assertEqual(self.started, [])

    def test_healthy_reuse_refuses_a_new_pending_native_journal(self):
        self.assertTrue(self.restore()['credentials'])
        self.started.clear()
        with patch.object(jobs, 'command', return_value=subprocess.CompletedProcess([], 1, b'')):
            self.assertFalse(self.restore()['credentials'])
        self.assertEqual(self.started, [])

    def test_healthy_reuse_refuses_a_new_failed_session_result(self):
        self.assertTrue(self.restore()['credentials'])
        self.file(Path(self.roles['delivery'][1]['StandardOutPath']), {'result': {
            'commandIdentity': 'deployment.credential-serve', 'outcome': 'failed',
            'transactionState': 'completed', 'effects': {'inventoryComplete': True, 'uncertain': []}}})
        self.assertFalse(self.restore()['credentials'])

    def test_late_cache_inspection_cannot_launch_delivery(self):
        original = self.observe
        def slow(*args, **kwargs):
            if 'cache' in self.pids:
                self.now = 31
            return original(*args, **kwargs)
        with patch.object(jobs, 'observe', side_effect=slow):
            self.assertFalse(self.restore()['credentials'])
        self.assertEqual(self.started, ['register:cache', 'start:cache'])

    def test_late_success_is_rejected(self):
        original = self.observe
        def slow(*args, **kwargs):
            if 'delivery' in self.pids:
                self.now = 31
            return original(*args, **kwargs)
        with patch.object(jobs, 'observe', side_effect=slow):
            self.assertFalse(self.restore()['credentials'])

    def test_uncertain_bootstrap_is_durable_and_blocks_automatic_retry(self):
        def failed(argv, *args, **kwargs):
            if 'bootstrap' in argv:
                # Intent must be durable before a possibly effectful native call.
                saved = json.loads((self.root / 'restore-result.json').read_text())
                self.assertEqual(saved['credentialEffects']['uncertain'], ['registered:cache'])
                raise subprocess.TimeoutExpired(argv, 1)
            return self.command(argv)
        with patch.object(jobs, 'command', side_effect=failed):
            result = self.restore()
        self.assertEqual(result['credentialEffects'], {'completed': [], 'uncertain': ['registered:cache']})
        saved = json.loads((self.root / 'restore-result.json').read_text())
        self.assertEqual(saved['credentialEffects'], result['credentialEffects'])
        self.assertFalse(self.restore()['credentials'])
        self.assertEqual(self.started, [])

    def test_partial_start_reports_completed_and_uncertain_separately(self):
        def failed(argv, *args, **kwargs):
            if 'kickstart' in argv and argv[-1].endswith('/delivery'):
                raise subprocess.TimeoutExpired(argv, 1)
            return self.command(argv)
        with patch.object(jobs, 'command', side_effect=failed):
            result = self.restore()
        self.assertEqual(result['credentialEffects'], {
            'completed': ['registered:cache', 'registered:delivery', 'started:cache'],
            'uncertain': ['started:delivery']})


class ProcessReadinessTests(RestoreFixture):
    identity_check = staticmethod(jobs.same_process)

    def setUp(self):
        super().setUp()
        self.ps_reads = {}
        self.responses = []
        p = patch.object(jobs.time, 'sleep', side_effect=self.advance)
        p.start()
        self.addCleanup(p.stop)

    def advance(self, duration):
        self.now += duration

    def with_process(self, response, listing=None):
        def command(argv, *args, **kwargs):
            if argv[0] != '/bin/ps':
                return self.command(argv, *args, **kwargs)
            pid = int(argv[3])
            role = 'cache' if pid == 10 else 'delivery'
            index = self.ps_reads.get(pid, 0)
            self.ps_reads[pid] = index + 1
            uid, program, words = response(role, index)
            # Native ps format selected by the actual implementation. The old
            # two-field command and proposed three-field command are both real.
            line = f'{uid} {program} {words}' if 'ucomm=' in argv else f'{uid} {words}'
            self.responses.append(line)
            return subprocess.CompletedProcess(argv, 0, (line + '\n').encode())
        with patch.object(jobs, 'same_process', self.identity_check), patch.object(jobs, 'command', side_effect=command):
            if listing is None:
                return self.restore()
            with patch.object(jobs, 'jobs', side_effect=listing):
                return self.restore()

    def exact(self, role, index):
        return os.getuid(), role, role + ' --fixture /unused/bun'

    def assert_cache_stopped(self, result):
        self.assertFalse(result['credentials'])
        self.assertEqual(self.started, ['register:cache', 'start:cache'])
        self.assertEqual(result['credentialEffects'], {
            'completed': ['registered:cache'], 'uncertain': ['started:cache']})
        owned = json.loads((self.root / 'owned-jobs.json').read_text())
        self.assertIsNone(owned['cache']['pid'])
        return json.loads((self.root / 'restore-result.json').read_text())

    def test_fresh_proxy_transition_waits_for_exact_owner_without_relaunch(self):
        def transition(role, index):
            if role == 'cache' and index == 0:
                # Synthetic documented launch stage, not reconstructed ps bytes.
                owned = json.loads((self.root / 'owned-jobs.json').read_text())
                self.assertIsNone(owned['cache']['pid'])
                return 0, 'xpcproxy', '/usr/libexec/xpcproxy cache'
            return self.exact(role, index)
        result = self.with_process(transition)
        self.assertTrue(result['credentials'])
        self.assertGreater(self.now, 0)
        self.assertEqual(self.started, ['register:cache', 'start:cache', 'register:delivery', 'start:delivery'])
        observed = result['processObservations']['cache']
        self.assertEqual(observed['firstInspection']['observedUid'], 0)
        self.assertEqual(observed['firstInspection']['programClass'], 'launchd-proxy')
        self.assertTrue(observed['identityMatches'])

    def test_expected_command_under_other_uid_refuses_without_wait(self):
        result = self.with_process(lambda role, index: (os.getuid() + 1, role, role + ' --fixture /unused/bun'))
        self.assert_cache_stopped(result)
        self.assertEqual(self.now, 0)

    def test_expected_uid_wrong_arguments_refuses_and_never_persists_them(self):
        result = self.with_process(lambda role, index: (os.getuid(), role, role + ' --credential=NEVER-PERSIST'))
        saved = self.assert_cache_stopped(result)
        self.assertNotIn('NEVER-PERSIST', json.dumps(saved))
        self.assertEqual(self.now, 0)

    def test_root_unexpected_program_refuses_without_wait(self):
        self.assert_cache_stopped(self.with_process(lambda role, index: (0, 'other', '/fixture/unexpected')))
        self.assertEqual(self.now, 0)

    def test_proxy_under_unrelated_uid_refuses_without_wait(self):
        self.assert_cache_stopped(self.with_process(lambda role, index: (os.getuid() + 1, 'xpcproxy', 'xpcproxy cache')))
        self.assertEqual(self.now, 0)

    def test_same_label_changed_pid_refuses_before_ps(self):
        def listing(*args, **kwargs):
            return {**self.pids, 'cache': 99} if 'cache' in self.pids else {}
        self.assert_cache_stopped(self.with_process(self.exact, listing))
        self.assertEqual(self.ps_reads, {})

    def test_label_changes_during_successful_inspection_refuses(self):
        def listing(*args, **kwargs):
            return {**self.pids, 'cache': 99} if self.ps_reads else self.pids.copy()
        self.assert_cache_stopped(self.with_process(self.exact, listing))
        self.assertEqual(self.now, 0)

    def test_proxy_cannot_extend_original_cache_deadline(self):
        result = self.with_process(lambda role, index: (0, 'xpcproxy', 'xpcproxy cache'))
        self.assert_cache_stopped(result)
        self.assertIn('window expired', result['error'])
        self.assertAlmostEqual(self.now, 30)

    def test_late_exact_identity_still_refuses_delivery(self):
        def late(role, index):
            self.now = 31
            return self.exact(role, index)
        self.assert_cache_stopped(self.with_process(late))

    def test_missing_process_retains_unverified_pid_and_ps_exit(self):
        def command(argv, *args, **kwargs):
            return subprocess.CompletedProcess(argv, 1, b'') if argv[0] == '/bin/ps' else self.command(argv)
        with patch.object(jobs, 'same_process', self.identity_check), patch.object(jobs, 'command', side_effect=command):
            result = self.restore()
        saved = self.assert_cache_stopped(result)
        self.assertEqual(saved['processObservations']['cache']['pid'], 10)
        self.assertEqual(saved['processObservations']['cache']['psExitCode'], 1)
        self.assertIsNone(saved['processObservations']['cache']['observedUid'])

    def test_observation_timeout_retains_pid_without_owned_authority(self):
        def command(argv, *args, **kwargs):
            if argv[0] == '/bin/ps':
                raise subprocess.TimeoutExpired(argv, 1)
            return self.command(argv)
        with patch.object(jobs, 'same_process', self.identity_check), patch.object(jobs, 'command', side_effect=command):
            result = self.restore()
        saved = self.assert_cache_stopped(result)
        self.assertEqual(saved['processObservations']['cache'], {'role': 'cache', 'pid': 10, 'status': 'not-observed'})

    def test_existing_proxy_is_not_adopted_as_healthy_owner(self):
        self.assertTrue(self.restore()['credentials'])
        self.started.clear()
        result = self.with_process(lambda role, index: (0, 'xpcproxy', 'xpcproxy cache'))
        self.assertFalse(result['credentials'])
        self.assertEqual(self.started, [])
        self.assertEqual(self.now, 0)


class CommandTests(unittest.TestCase):
    def test_remaining_deadline_bounds_subprocess_and_rejects_expired_call(self):
        with patch.object(jobs.time, 'monotonic', return_value=13), patch.object(jobs.subprocess, 'run') as run:
            jobs.command(['fixture'], deadline=15)
            self.assertEqual(run.call_args.kwargs['timeout'], 2)
        with patch.object(jobs.time, 'monotonic', return_value=15), patch.object(jobs.subprocess, 'run') as run:
            with self.assertRaises(jobs.Refused):
                jobs.command(['fixture'], deadline=15)
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
