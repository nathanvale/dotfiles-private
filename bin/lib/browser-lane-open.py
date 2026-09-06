#!/usr/bin/env python3
"""Bounded, sanitized transport for the native profile-local tab opener."""
import json
import os
import signal
import stat
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit


REASONS = {
    "exact_tab_reused", "chrome_not_running", "exact_tab_absent",
    "invalid_request", "native_helper_unavailable", "native_helper_failed",
    "native_helper_timeout", "native_helper_interrupted", "invalid_native_result",
    "chrome_process_ambiguous", "profile_window_unavailable",
    "profile_window_ambiguous", "profile_window_changed", "tab_inventory_unavailable",
    "tab_inventory_changed", "tab_selection_unavailable", "tab_url_unavailable",
    "exact_tab_ambiguous", "native_access_unavailable", "native_deadline",
}


def result(state, reason):
    return {"state": state, "reason": reason}


def interrupted(_number, _frame):
    raise InterruptedError()


def retire(child):
    # The native helper owns no persistent process. Retire its whole process
    # group, including descendants left behind by an explicit test override.
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(child.pid, sig)
        except ProcessLookupError:
            pass
        if sig == signal.SIGTERM:
            try:
                child.wait(timeout=0.2)
            except subprocess.TimeoutExpired:
                pass
    child.wait()


def main():
    child = None
    outcome = result("refused", "native_helper_failed")
    try:
        if len(sys.argv) != 3:
            return result("refused", "invalid_request")
        display, url = sys.argv[1:]
        parsed = urlsplit(url)
        if (not display or len(display) > 200 or any(ord(c) < 32 for c in display)
                or parsed.scheme not in ("http", "https") or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or len(url) > 8192 or any(ord(c) < 32 for c in url)):
            return result("refused", "invalid_request")
        executable = os.environ.get("BROWSER_LANE_OSASCRIPT_BIN", "/usr/bin/osascript")
        if (not os.path.isabs(executable) or os.path.islink(executable)
                or not os.path.isfile(executable) or not os.access(executable, os.X_OK)):
            return result("refused", "native_helper_unavailable")
        helper = os.path.join(os.path.dirname(os.path.realpath(__file__)), "browser-lane-open.js")
        if not stat.S_ISREG(os.lstat(helper).st_mode):
            return result("refused", "native_helper_unavailable")
        with tempfile.TemporaryFile() as output:
            child = subprocess.Popen(
                [executable, "-l", "JavaScript", helper, display, url],
                stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            child.wait(timeout=50)
            output.seek(0)
            raw = output.read(4097)
            try:
                value = json.loads(raw) if len(raw) <= 4096 else None
            except (ValueError, UnicodeError):
                value = None
            valid = (isinstance(value, dict) and set(value) == {"state", "reason"}
                     and value.get("state") in ("reused", "absent", "refused")
                     and value.get("reason") in REASONS)
            if valid and child.returncode == 0:
                allowed = {"reused": {"exact_tab_reused"},
                           "absent": {"chrome_not_running", "exact_tab_absent"}}
                if value["state"] == "refused" or value["reason"] in allowed[value["state"]]:
                    outcome = value
                else:
                    outcome = result("refused", "invalid_native_result")
            else:
                outcome = result("refused", "invalid_native_result")
    except subprocess.TimeoutExpired:
        outcome = result("refused", "native_helper_timeout")
    except InterruptedError:
        outcome = result("refused", "native_helper_interrupted")
    except Exception:
        outcome = result("refused", "native_helper_failed")
    finally:
        if child is not None:
            for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
                signal.signal(sig, signal.SIG_IGN)
            retire(child)
    return outcome


if __name__ == "__main__":
    for signal_number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signal_number, interrupted)
    answer = main()
    print(json.dumps(answer, separators=(",", ":")))
    sys.exit(0 if answer["state"] in ("reused", "absent") else 1)
