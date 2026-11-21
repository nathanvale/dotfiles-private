"""The cache job's holder, run as launchd runs it: the real script under /bin/sh.

ssh is a fixture executable. Each call takes the next scripted answer, so the
holder's own process, signals and exit status are what is observed.
"""
import importlib.util
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import tempfile
import time
import unittest

sys.dont_write_bytecode = True
HOLDER = Path(__file__).parents[2] / 'resources/credential-cache-holder.sh'
spec = importlib.util.spec_from_file_location('jobs', Path(__file__).parents[2] / 'resources/credential_jobs.py')
jobs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jobs)

# Each call appends its remote command to calls/N, then runs answers/N.
FAKE_SSH = '''#!/bin/sh
n=$(($(ls "$FIXTURE/calls" | wc -l) + 1))
for last; do :; done
printf '%s' "$last" > "$FIXTURE/calls/$n"
printf '%s\\n' "$*" >> "$FIXTURE/argv"
. "$FIXTURE/answers/$n"
'''
# Independent oracles: OpenSSH's own words for a reset, a connect failure while
# an interface returns after sleep, and an authentication refusal.
RESET = 'echo "Read from remote host 192.168.1.100: Connection reset by peer" >&2; exit 255'
WAKING = 'echo "ssh: connect to host 192.168.1.100 port 22: Can\'t assign requested address" >&2; exit 255'
DENIED = 'echo "server@192.168.1.100: Permission denied (publickey)." >&2; exit 255'
EXEC = "/fixture/docker --host unix:///fixture/docker.sock exec -i --user 1000 --env HOME=/home/agent " + 'c' * 64
DAEMON = '/usr/bin/git credential-cache--daemon /home/agent/.cache/fixture/socket'
SOCKET = '/home/agent/.cache/fixture/socket'


class HolderFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        for name in ['calls', 'answers']:
            (self.root / name).mkdir()
        self.ssh = self.root / 'ssh'
        self.ssh.write_text(FAKE_SSH)
        self.ssh.chmod(0o700)

    def answers(self, *scripts):
        for number, script in enumerate(scripts, 1):
            (self.root / 'answers' / str(number)).write_text(script + '\n')

    def start(self, exec_words=EXEC, python='/usr/bin/python3', socket=SOCKET):
        child = subprocess.Popen(
            ['/bin/sh', str(HOLDER), str(self.ssh), 'mac-mini-credentials', exec_words, DAEMON, python, socket],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env={'PATH': '/usr/bin:/bin', 'FIXTURE': str(self.root), 'TMPDIR': str(self.root)})
        self.addCleanup(lambda: child.poll() is None and child.kill())
        return child

    def calls(self):
        return [path.read_text() for path in sorted((self.root / 'calls').iterdir(), key=lambda p: int(p.name))]

    def finish(self, child, seconds=30):
        out, err = child.communicate(timeout=seconds)
        return child.returncode, out.decode(), err.decode()


class HolderTests(HolderFixture):
    def test_first_connection_starts_the_native_daemon_exactly_as_the_direct_job_did(self):
        self.answers('exit 0')
        code, _, _ = self.finish(self.start())
        self.assertEqual(code, 0)
        self.assertEqual(self.calls(), [EXEC + ' ' + DAEMON])
        self.assertEqual((self.root / 'argv').read_text(),
                         '-o ForwardAgent=no -o BatchMode=yes -T mac-mini-credentials ' + EXEC + ' ' + DAEMON + '\n')

    def test_a_reset_reattaches_to_the_surviving_daemon_and_never_starts_a_second(self):
        self.answers(RESET, 'echo held; exit 0')
        child = self.start()
        pid = child.pid
        code, out, err = self.finish(child)
        # Plausible wrong behaviour: exiting 255 at the reset (today's job), or
        # running the daemon command again, which replaces the leased cache.
        self.assertEqual(code, 0)
        calls = self.calls()
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], EXEC + ' ' + DAEMON)
        self.assertNotIn('credential-cache--daemon', calls[1])
        self.assertTrue(calls[1].startswith(EXEC + ' /usr/bin/python3 -I -c '))
        self.assertTrue(calls[1].endswith(' ' + SOCKET))
        self.assertIn('Connection reset by peer', err)
        self.assertEqual(out, 'held\n')
        self.assertEqual(child.pid, pid)

    def test_a_route_still_returning_is_tried_again_until_it_answers(self):
        self.answers(RESET, WAKING, WAKING, 'exit 0')
        code, _, _ = self.finish(self.start())
        self.assertEqual(code, 0)
        self.assertEqual(len(self.calls()), 4)

    def test_a_refusal_stops_at_once(self):
        for name, answers, expected in [('at the start', [DENIED], 1), ('on reattaching', [RESET, DENIED], 2)]:
            with self.subTest(name):
                for path in (self.root / 'calls').iterdir():
                    path.unlink()
                self.answers(*answers)
                code, _, err = self.finish(self.start())
                self.assertEqual(code, 255)
                self.assertEqual(len(self.calls()), expected)
                self.assertIn('Permission denied (publickey)', err)

    def test_a_cache_that_ended_while_the_route_was_away_ends_the_job(self):
        self.answers(RESET, 'echo absent; exit 3')
        code, _, _ = self.finish(self.start())
        self.assertEqual(code, 3)
        self.assertEqual(len(self.calls()), 2)

    def test_the_daemons_own_ending_is_the_jobs_ending(self):
        for status in [0, 1, 128]:
            with self.subTest(status=status):
                for path in (self.root / 'calls').iterdir():
                    path.unlink()
                self.answers('exit %d' % status)
                self.assertEqual(self.finish(self.start())[0], status)
                self.assertEqual(len(self.calls()), 1)

    def test_a_stop_signal_ends_the_holder_and_its_connection(self):
        self.answers('echo $$ > "$FIXTURE/ssh.pid"; exec sleep 60')
        child = self.start()
        deadline = time.monotonic() + 10
        while not (self.root / 'ssh.pid').exists():
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.05)
        time.sleep(0.1)
        connection = int((self.root / 'ssh.pid').read_text())
        child.send_signal(signal.SIGTERM)
        code, _, _ = self.finish(child, 10)
        self.assertEqual(code, 143)
        with self.assertRaises(ProcessLookupError):
            os.kill(connection, 0)
        self.assertEqual([p.name for p in self.root.iterdir() if p.name.startswith('credential-cache-holder.')], [])

    def test_a_stop_signal_during_backoff_ends_the_holder_at_once(self):
        self.answers(RESET, WAKING, WAKING, WAKING, WAKING, WAKING, WAKING, 'exit 0')
        child = self.start()
        deadline = time.monotonic() + 20
        while len(self.calls()) < 3:
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.05)
        asked = time.monotonic()
        child.send_signal(signal.SIGTERM)
        code, _, _ = self.finish(child, 10)
        self.assertEqual(code, 143)
        self.assertLess(time.monotonic() - asked, 2)

    def test_the_recorded_pid_stays_the_exact_owner_across_a_lost_route(self):
        # The restore contract's own identity check, against the real process.
        self.answers('while [ ! -e "$FIXTURE/lose" ]; do sleep 0.05; done; ' + RESET,
                     'echo held; while [ ! -e "$FIXTURE/end" ]; do sleep 0.05; done; exit 0')
        child = self.start()
        argv = ['/bin/sh', str(HOLDER), str(self.ssh), 'mac-mini-credentials', EXEC, DAEMON, '/usr/bin/python3', SOCKET]
        deadline = time.monotonic() + 10
        while not jobs.same_process(child.pid, argv):
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.05)
        (self.root / 'lose').touch()
        self.assertEqual(child.stdout.readline(), b'held\n')
        self.assertTrue(jobs.same_process(child.pid, argv))
        self.assertFalse(jobs.same_process(child.pid, argv[:-1] + ['/another/socket']))
        (self.root / 'end').touch()
        self.assertEqual(self.finish(child)[0], 0)
        self.assertFalse(jobs.same_process(child.pid, argv))

    def test_wrong_argument_count_refuses_without_connecting(self):
        child = subprocess.Popen(['/bin/sh', str(HOLDER), str(self.ssh), 'alias'], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 env={'PATH': '/usr/bin:/bin', 'FIXTURE': str(self.root), 'TMPDIR': str(self.root)})
        self.assertEqual(self.finish(child)[0], 64)
        self.assertEqual(self.calls(), [])


class WatcherTests(HolderFixture):
    """The reattach command, run as the far shell would run it, over a
    stand-in /proc: the fixture ssh swaps the path and executes the words."""
    INODE = '424242'

    def proc(self, listening=True):
        proc = self.root / 'proc'
        (proc / 'net').mkdir(parents=True, exist_ok=True)
        (proc / 'net/unix').write_text(
            'Num       RefCount Protocol Flags    Type St Inode Path\n'
            + '0000000000000000: 00000002 00000000 00010000 0001 01 777 /run/other.sock\n'
            + ('0000000000000000: 00000002 00000000 00010000 0001 01 ' + self.INODE + ' ' + SOCKET + '\n' if listening else ''))
        fds = proc / '4242/fd'
        if listening:
            fds.mkdir(parents=True, exist_ok=True)
            if not (fds / '3').is_symlink():
                (fds / '3').symlink_to('socket:[' + self.INODE + ']')
        elif fds.exists():
            (fds / '3').unlink()
            fds.rmdir()
            fds.parent.rmdir()
        return proc

    def reattach(self):
        # The second call runs the holder's own words locally in place of
        # docker exec, with /proc swapped for the stand-in tree.
        local = 'eval "$(printf \'%s\' "$last" | sed "s|/proc|$FIXTURE/proc|g")"'
        self.answers(RESET, local)
        return self.start(exec_words='/usr/bin/env', python=shlex.quote(sys.executable))

    def test_reattaching_holds_while_the_daemon_listens_and_ends_when_it_ends(self):
        self.proc()
        child = self.reattach()
        self.assertEqual(child.stdout.readline(), b'held\n')
        time.sleep(3)
        # Plausible wrong behaviour: ending while the daemon still listens.
        self.assertIsNone(child.poll())
        self.proc(listening=False)
        code, _, _ = self.finish(child, 20)
        self.assertEqual(code, 0)

    def test_reattaching_finds_no_daemon_and_says_so(self):
        self.proc(listening=False)
        code, out, _ = self.finish(self.reattach())
        self.assertEqual((code, out), (3, 'absent\n'))

    def test_a_socket_another_process_also_holds_is_not_this_daemon(self):
        proc = self.proc()
        (proc / '4343/fd').mkdir(parents=True)
        (proc / '4343/fd/5').symlink_to('socket:[' + self.INODE + ']')
        code, out, _ = self.finish(self.reattach())
        self.assertEqual((code, out), (3, 'absent\n'))


if __name__ == '__main__':
    unittest.main()
