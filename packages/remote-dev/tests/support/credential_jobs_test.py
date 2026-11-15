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


class RestoreTests(unittest.TestCase):
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
