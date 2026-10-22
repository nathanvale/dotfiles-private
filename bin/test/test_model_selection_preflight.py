"""Public-process regressions. Provider executables are test-owned protocol doubles."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


CLI = Path(__file__).resolve().parents[1] / "model-selection-preflight"


class ModelSelectionPreflight(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = dict(os.environ, PATH=str(self.root) + os.pathsep + os.environ["PATH"],
                        PROBE_LOG=str(self.root / "calls"),
                        ANTHROPIC_API_KEY="SECRET_MARKER",
                        OPENAI_API_KEY="SECRET_MARKER", CLAUDE_CODE_USE_FOUNDRY="1")
        self.auth = {"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty", "email": "fixture@example.invalid"}
        self.fake("claude", """
if os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('CLAUDE_CODE_USE_FOUNDRY'):
    raise SystemExit('SECRET_MARKER: inherited provider')
if sys.argv[1:3] == ['auth','status']:
    print(os.environ['AUTH_RESPONSE'])
else:
    print(os.environ.get('TURN_RESPONSE', '{}'))
""")
        self.env["AUTH_RESPONSE"] = json.dumps(self.auth)
        self.fake("monash", "print(os.environ.get('MONASH_RESPONSE', '{\"state\":\"fresh\",\"models\":[]}'))")
        self.fake("codex", """
if sys.argv[-2:] == ['login','status']:
    print('Logged in using ChatGPT')
else:
    print('{"models":[{"slug":"gpt-6.1-sol"}]}')
""")

    def fake(self, name, body):
        path = self.root / name
        path.write_text(f"#!{sys.executable}\nimport os,sys,json\nfrom pathlib import Path\nwith Path(os.environ['PROBE_LOG']).open('a') as log: log.write(json.dumps([Path(sys.argv[0]).name, *sys.argv[1:]])+'\\n')\nwith Path(os.environ['PROBE_LOG']+'.cwd').open('a') as log: log.write(str(Path.cwd())+'\\n')\n" + body)
        path.chmod(0o700)

    def call(self, *extra, agent="claude", model="claude-opus-5-5"):
        result = subprocess.run([sys.executable, str(CLI), "--agent", agent, "--model", model,
                                 "--effort", "high", "--json", *extra], env=self.env,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.stderr, "")
        self.assertNotIn("SECRET_MARKER", result.stdout)
        self.assertNotIn("fixture@example.invalid", result.stdout)
        return result.returncode, json.loads(result.stdout)

    def test_monash_miss_does_not_hide_verified_personal_model(self):
        self.env["TURN_RESPONSE"] = json.dumps({"is_error": False, "modelUsage": {"claude-opus-5-5": {}}})
        code, data = self.call("--verify-personal")
        self.assertEqual((code, data["status"]), (0, "candidate_available"))
        self.assertEqual([(r["provider"], r["state"]) for r in data["routes"]],
                         [("personal", "available"), ("monash", "not_listed")])
        calls = [json.loads(line) for line in (self.root / "calls").read_text().splitlines()]
        turn = next(call for call in calls if "--print" in call)
        self.assertEqual(turn[turn.index("--effort") + 1], "high")
        self.assertEqual(turn[turn.index("--model") + 1], "claude-opus-5-5")
        self.assertEqual(turn[turn.index("--tools") + 1], "")
        self.assertIn("--no-session-persistence", turn)
        self.assertEqual(json.loads(turn[turn.index("--settings") + 1]), {"disableAllHooks": True})
        self.assertEqual(set((self.root / "calls.cwd").read_text().splitlines()), {str(Path.home())})

    def test_monash_miss_and_personal_unchecked_is_incomplete(self):
        code, data = self.call()
        self.assertEqual((code, data["status"], data["unavailability_proven"]),
                         (3, "discovery_incomplete", False))
        self.assertEqual([r["provider"] for r in data["routes"]], ["personal", "monash"])
        self.assertEqual(data["routes"][0]["state"], "unchecked_model")

    def test_explicit_employer_only_request_never_probes_personal(self):
        code, data = self.call("--provider", "monash")
        self.assertEqual(code, 3)
        self.assertEqual([r["provider"] for r in data["routes"]], ["monash"])
        self.assertEqual([json.loads(line)[0] for line in (self.root / "calls").read_text().splitlines()], ["monash"])

    def test_wrong_native_model_is_rejected(self):
        self.env["TURN_RESPONSE"] = json.dumps({"is_error": False, "modelUsage": {"claude-sonnet-5-5": {}}})
        code, data = self.call("--verify-personal")
        self.assertEqual((code, data["status"]), (4, "identity_mismatch"))

    def test_mismatched_account_model_effort_or_provider_receipt_is_rejected(self):
        expected = {"agent": "claude", "provider": "personal", "account": "expected-account",
                    "model": "claude-opus-5-5", "effort": "high", "completed_first_turn": True,
                    "evidence_path": str(self.root / "native-receipt")}
        for key, value in [("account", "another-account"), ("model", "claude-sonnet-5-5"),
                           ("effort", "medium"), ("provider", "unapproved-provider")]:
            with self.subTest(key=key):
                path = self.root / "receipt.json"
                path.write_text(json.dumps(dict(expected, **{key: value})))
                code, data = self.call("--observed", str(path), "--expected-account", "expected-account")
                self.assertEqual((code, data["receipt_check"]["state"]), (4, "mismatch"))

    def test_matching_receipt_does_not_manufacture_live_verification(self):
        path = self.root / "receipt.json"
        path.write_text(json.dumps({"agent": "claude", "provider": "personal", "account": "expected-account",
                                   "model": "claude-opus-5-5", "effort": "high", "completed_first_turn": True,
                                   "evidence_path": "retained/native-proof.json"}))
        code, data = self.call("--observed", str(path), "--expected-account", "expected-account")
        self.assertEqual((code, data["receipt_check"]["state"]), (3, "matches"))
        self.assertEqual(data["status"], "discovery_incomplete")

    def test_provider_failure_and_sensitive_stderr_are_redacted(self):
        self.fake("monash", "print('SECRET_MARKER', file=sys.stderr); raise SystemExit(3)")
        code, data = self.call()
        self.assertEqual(code, 3)
        self.assertEqual(data["routes"][1]["state"], "unknown")

    def test_failed_personal_probe_still_checks_monash(self):
        self.fake("claude", "print('SECRET_MARKER', file=sys.stderr); raise SystemExit(1)")
        code, data = self.call()
        self.assertEqual(code, 3)
        self.assertEqual([r["provider"] for r in data["routes"]], ["personal", "monash"])

    def test_timeout_is_incomplete_not_absent(self):
        self.fake("claude", "import time; time.sleep(10)")
        code, data = self.call("--timeout", "0.1")
        self.assertEqual((code, data["routes"][0]["reason"]), (3, "probe_timeout"))

    def test_codex_catalogue_is_not_native_first_turn_proof(self):
        code, data = self.call(agent="codex", model="gpt-6.1-sol")
        self.assertEqual((code, data["routes"][0]["state"]), (3, "unchecked_model"))

    def test_missing_local_catalogue_model_is_not_global_absence(self):
        code, data = self.call(agent="codex", model="missing-model")
        self.assertEqual((code, data["unavailability_proven"]), (3, False))

    def test_stale_monash_catalogue_is_unknown(self):
        self.env["MONASH_RESPONSE"] = '{"state":"stale","models":[]}'
        code, data = self.call()
        self.assertEqual((code, data["routes"][1]["state"]), (3, "unknown"))

    def test_codex_auth_timeout_terminates_its_process_group(self):
        self.fake("codex", """
import time
pid = os.fork()
if pid == 0:
    time.sleep(0.6)
    Path(os.environ['PROBE_LOG']+'.orphan').touch()
    raise SystemExit(0)
time.sleep(10)
""")
        code, data = self.call("--timeout", "0.1", agent="codex", model="gpt-6.1-sol")
        self.assertEqual((code, data["routes"][0]["reason"]), (3, "probe_timeout"))
        import time
        time.sleep(0.8)
        self.assertFalse((self.root / "calls.orphan").exists())

    def test_authentication_changes_during_first_turn_are_rejected(self):
        self.fake("claude", """
if sys.argv[1:3] == ['auth','status']:
    counter = Path(os.environ['PROBE_LOG'] + '.auth')
    before = not counter.exists()
    counter.touch()
    print(json.dumps({'loggedIn': True, 'authMethod':'claude.ai', 'apiProvider':'firstParty',
                      'email':'before@example.invalid' if before else 'after@example.invalid'}))
else:
    print('{"is_error":false,"modelUsage":{"claude-opus-5-5":{}}}')
""")
        code, data = self.call("--verify-personal")
        self.assertEqual((code, data["routes"][0]["reason"]), (4, "account_identity_not_stable"))


if __name__ == "__main__":
    unittest.main()
