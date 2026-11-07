import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/doctor.py"
spec = importlib.util.spec_from_file_location("credential_doctor", SCRIPT)
doctor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(doctor)


class DoctorTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.home = Path(self.scratch.name).resolve()
        self.login = self.home / "Library/Keychains/login.keychain-db"
        self.login.parent.mkdir(parents=True)
        self.login.touch()
        self.argv = ["--expect-host", "test-host", "--expect-user", "test-user",
                     "--expect-home", str(self.home), "--context", "local"]
        account = SimpleNamespace(pw_name="test-user", pw_dir=str(self.home))
        for target, value in [
            ("platform.system", "Darwin"), ("socket.gethostname", "test-host"),
            ("os.getuid", os.getuid()), ("os.geteuid", os.getuid()),
            ("pwd.getpwuid", account),
        ]:
            guard = patch.object(doctor.__dict__[target.split('.')[0]], target.split('.')[1], return_value=value)
            guard.start()
            self.addCleanup(guard.stop)
        environment = patch.dict(os.environ, {"HOME": str(self.home)}, clear=True)
        environment.start()
        self.addCleanup(environment.stop)

    def query(self, argv, home, capture=True):
        self.assertEqual(home, self.home)
        if argv == ["/bin/launchctl", "print", f"gui/{os.getuid()}"]:
            self.assertFalse(capture)
            return 0, b""
        self.assertIn(argv, [
            ["/usr/bin/security", "default-keychain", "-d", "user"],
            ["/usr/bin/security", "list-keychains", "-d", "user"],
        ])
        return 0, f'    "{self.login}"\n'.encode()

    def test_matching_metadata_keeps_all_credential_claims_unchecked(self):
        with patch.object(doctor, "query", side_effect=self.query) as probe:
            result = doctor.report(self.argv)
        self.assertEqual(result["status"], "metadata-ok")
        self.assertEqual(result["metadata"], {
            "login_regular_owned_file": True, "default_is_login": True,
            "login_in_search_list": True, "search_list_count": 1,
            "gui_domain_present": True,
        })
        self.assertEqual(probe.call_count, 3)
        for key in ["custody", "authentication", "unlock_state", "requesting_client", "security_session"]:
            self.assertEqual(result[key], "not_checked")

    def test_wrong_contexts_reject_before_any_os_probe(self):
        cases = [
            (self.argv[:1], {}, "invalid-arguments"),
            (["--expect-host", "wrong", *self.argv[2:]], {}, "host-mismatch"),
            ([*self.argv[:3], "wrong", *self.argv[4:]], {}, "user-mismatch"),
            ([*self.argv[:5], "/wrong", *self.argv[6:]], {}, "expected-home-mismatch"),
            (self.argv, {"HOME": "SYNTHETIC_PRIVATE_MARKER"}, "environment-home-mismatch"),
            ([*self.argv[:-1], "ssh"], {}, "transport-hint-mismatch"),
            (self.argv, {"SSH_CONNECTION": "SYNTHETIC_PRIVATE_MARKER"}, "transport-hint-mismatch"),
        ]
        for argv, env, expected in cases:
            with self.subTest(expected=expected), patch.dict(os.environ, env), patch.object(doctor, "query") as probe:
                result = doctor.report(argv)
                self.assertEqual(result["cause"], expected)
                self.assertFalse(result["metadata_probes_started"])
                probe.assert_not_called()
                self.assertNotIn("SYNTHETIC_PRIVATE_MARKER", json.dumps(result))

    def test_missing_or_symlink_database_is_blocked_without_query(self):
        self.login.unlink()
        with patch.object(doctor, "query") as probe:
            self.assertEqual(doctor.report(self.argv)["cause"], "login-keychain-missing")
            self.login.symlink_to(self.home / "elsewhere")
            self.assertEqual(doctor.report(self.argv)["cause"], "login-keychain-file-context")
            probe.assert_not_called()

    def test_noncanonical_account_home_rejects_before_query(self):
        alias = self.home / "alias"
        alias.symlink_to(self.home, target_is_directory=True)
        with patch.object(doctor.pwd, "getpwuid", return_value=SimpleNamespace(pw_name="test-user", pw_dir=str(alias))), patch.object(doctor, "query") as probe:
            self.assertEqual(doctor.report(self.argv)["cause"], "account-home-not-canonical")
            probe.assert_not_called()

    def test_wrong_owner_and_nonregular_database_are_blocked(self):
        for info in [SimpleNamespace(st_uid=os.getuid() + 1, st_mode=0o100644),
                     SimpleNamespace(st_uid=os.getuid(), st_mode=0o040755)]:
            with patch.object(doctor.Path, "lstat", return_value=info), patch.object(doctor, "query") as probe:
                self.assertEqual(doctor.report(self.argv)["cause"], "login-keychain-file-context")
                probe.assert_not_called()

    def test_symlinked_keychain_directory_is_blocked_before_query(self):
        actual = self.home / "actual-keychains"
        self.login.parent.rename(actual)
        self.login.parent.symlink_to(actual, target_is_directory=True)
        with patch.object(doctor, "query") as probe:
            self.assertEqual(doctor.report(self.argv)["cause"], "login-keychain-file-context")
            probe.assert_not_called()

    def test_malformed_metadata_never_releases_raw_bytes(self):
        for output in [b'SYNTHETIC_PRIVATE_MARKER', b'"/unterminated', b'"relative"\n',
                       b'"/one" "/two"\n', b'"/one"x"/two"\n', b'/unquoted\n',
                       b'"""/synthetic/login.keychain-db"""\n', b'"/synthetic/""login.keychain-db"\n',
                       b'"/nul\x00value"\n', b'\xff', b'']:
            with self.subTest(output=output), patch.object(doctor, "query", return_value=(0, output)):
                result = doctor.report(self.argv)
                self.assertEqual(result["status"], "blocked")
                self.assertEqual(result["cause"], "unexpected-keychain-metadata")
                self.assertNotIn("SYNTHETIC_PRIVATE_MARKER", json.dumps(result))

    def test_different_selection_blocks_without_repair(self):
        with patch.object(doctor, "query", return_value=(0, b'"/different.keychain-db"\n')):
            result = doctor.report(self.argv)
        self.assertEqual(result["cause"], "keychain-selection-differs")
        self.assertFalse(result["metadata"]["default_is_login"])

    def test_no_gui_domain_does_not_claim_an_unlock_or_session(self):
        def no_gui(argv, home, capture=True):
            return self.query(argv, home, capture) if capture else (1, b"")
        with patch.object(doctor, "query", side_effect=no_gui):
            result = doctor.report(self.argv)
        self.assertEqual(result["status"], "metadata-ok")
        self.assertFalse(result["metadata"]["gui_domain_present"])
        self.assertEqual(result["security_session"], "not_checked")

    def test_command_failure_is_distinct_from_missing_item(self):
        with patch.object(doctor, "query", return_value=(36, b'SYNTHETIC_PRIVATE_MARKER')):
            result = doctor.report(self.argv)
        self.assertEqual(result["cause"], "keychain-metadata-query-failed")
        self.assertNotIn("SYNTHETIC_PRIVATE_MARKER", json.dumps(result))

    def test_bounded_process_rejects_oversized_output(self):
        with self.assertRaises(doctor.Blocked) as error:
            doctor.query([sys.executable, "-c", "import sys; sys.stdout.write('x'*100000)"], self.home)
        self.assertEqual(error.exception.cause, "unexpected-keychain-metadata")

    def test_bounded_process_reaps_timeout(self):
        pid_file = self.home / "owned-child.pid"
        with self.assertRaises(doctor.Blocked) as error:
            doctor.query([
                sys.executable, "-c",
                "import os,pathlib,sys,time; pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(30)",
                str(pid_file),
            ], self.home)
        self.assertEqual(error.exception.cause, "metadata-query-timeout")
        with self.assertRaises(ProcessLookupError):
            os.kill(int(pid_file.read_text()), 0)


class PublicProcessTests(unittest.TestCase):
    def test_help_has_no_probe_and_invalid_input_does_not_echo_input(self):
        help_result = subprocess.run([sys.executable, str(SCRIPT), "--help"], capture_output=True, check=False)
        self.assertEqual(help_result.returncode, 0)
        self.assertIn(b"--expect-host", help_result.stdout)
        result = subprocess.run([sys.executable, str(SCRIPT), "SYNTHETIC_PRIVATE_MARKER"], capture_output=True, check=False)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stderr, b"")
        self.assertEqual(json.loads(result.stdout)["cause"], "invalid-arguments")
        self.assertNotIn(b"SYNTHETIC_PRIVATE_MARKER", result.stdout)


if __name__ == "__main__":
    unittest.main()
