#!/usr/bin/env python3
"""Generic SSH remote-helper backend for Monash native-agent panes.

Owns remote workspace/tab/pane/agent creation and control in a named,
already-running Herdr session on a configured SSH host profile. Every remote
invocation is a fixed helper-owned command parameterized only by
registry-derived or run_id-derived values; it never accepts an arbitrary SSH
target, SSH option, or caller-supplied remote command. Credentials stay
inside the remote ``monash-foundry`` launcher; this helper never reads or
serializes them.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import subprocess
import sys
import tempfile
import time
from typing import Any, Sequence
from uuid import uuid4

from monash_hosts import HostProfile, HostProfileError, HostProfileRegistry


SCHEMA_VERSION = 1
SSH_BASE_OPTIONS = ("-o", "BatchMode=yes", "-o", "ConnectTimeout=10")
SSH_COMMAND_TIMEOUT_SECONDS = 20.0
MANAGED_START_TIMEOUT_MS = 60_000
SHIM_RESOLUTION_TIMEOUT_MS = 5_000
DEFAULT_WAIT_TIMEOUT_MS = 600_000
FIRST_PROMPT_SETTLE_SECONDS = 5.0
PROMPT_RECONCILE_INTERVAL_SECONDS = 0.25
REMOTE_SPAWN_STATE_ROOT = ".local/state/monash/spawns"
RUN_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")


class RemoteHelperError(Exception):
    """A safe, structured refusal from the SSH remote-helper backend.

    ``run_id``/``remote_identity``/``observation`` are attached only once a
    real remote pane exists (never fabricated for a pre-pane refusal), so a
    caller can recover the exact remote target instead of blindly retrying
    ``start``."""

    def __init__(self, code: str, message: str, repair: str, exit_code: int = 3,
                 herdr_error_code: str | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.repair = repair
        self.exit_code = exit_code
        self.herdr_error_code = herdr_error_code
        self.run_id: str | None = None
        self.remote_identity: dict[str, object] | None = None
        self.observation: dict[str, object] | None = None


def _wrap_profile_error(error: HostProfileError, repair: str) -> RemoteHelperError:
    return RemoteHelperError(error.code, str(error), repair)


def config_path(args: argparse.Namespace) -> Path:
    return Path(args.config).expanduser().resolve()


def load_registry(path: Path) -> HostProfileRegistry:
    try:
        return HostProfileRegistry.load(path)
    except HostProfileError as error:
        raise _wrap_profile_error(error, "repair config.json host_profiles and retry") from error


def ssh_profile(registry: HostProfileRegistry, profile_id: str) -> HostProfile:
    try:
        profile = registry.get(profile_id)
    except HostProfileError as error:
        raise _wrap_profile_error(error, "select a configured host profile") from error
    if profile.transport != "ssh":
        raise RemoteHelperError(
            "host_profile_not_ssh", f"host profile {profile_id!r} is not an SSH profile",
            "select an SSH host profile for the remote helper",
        )
    return profile


def require_local_directory(value: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute() or not path.is_dir():
        raise RemoteHelperError("invalid_cwd", "--cwd must name an existing absolute directory",
                                "pass an existing absolute working directory", exit_code=2)
    return path.resolve()


def native_args(args: argparse.Namespace) -> list[str]:
    values = args.native_args
    if values and values[0] == "--":
        values = values[1:]
    return list(values)


def validated_or_generated_run_id(candidate: str | None) -> str:
    """A caller-supplied run_id becomes the caller's own identity for this
    run instead of a freshly generated one; omitting it keeps the existing
    safe direct-helper behavior existing public tests rely on."""
    if candidate is None:
        return uuid4().hex
    if not RUN_ID_PATTERN.fullmatch(candidate):
        raise RemoteHelperError(
            "invalid_run_id", "--run-id must be exactly 32 lowercase hexadecimal characters",
            "pass a valid 32-character lowercase hex run_id, or omit --run-id to generate one", exit_code=2)
    return candidate


# --- SSH execution primitives -------------------------------------------------

def _ssh_argv(profile: HostProfile, remote_command: Sequence[str]) -> list[str]:
    """Build a fixed ssh argv. The whole remote command is one shell-quoted
    string, so multi-argument commands are never split by ssh's own naive
    space-join of trailing arguments."""
    return ["ssh", *SSH_BASE_OPTIONS, profile.ssh_alias, shlex.join(remote_command)]


def _run_ssh(profile: HostProfile, remote_command: Sequence[str], *,
             timeout: float = SSH_COMMAND_TIMEOUT_SECONDS) -> subprocess.CompletedProcess:
    argv = _ssh_argv(profile, remote_command)
    try:
        return subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True, check=False, timeout=timeout)
    except FileNotFoundError as error:
        raise RemoteHelperError("ssh_binary_missing", "The ssh executable is unavailable",
                                "install or repair ssh and retry") from error
    except subprocess.TimeoutExpired as error:
        raise RemoteHelperError("remote_command_timed_out", "Timed out while running a remote command",
                                "inspect the remote host and retry") from error


def _herdr_error_code(text: str) -> str | None:
    candidates = [text.strip(), *(line.strip() for line in reversed(text.splitlines()))]
    for candidate in candidates:
        if not candidate:
            continue
        try:
            payload = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        error = payload.get("error") if isinstance(payload, dict) else None
        if isinstance(error, dict) and isinstance(error.get("code"), str):
            return error["code"]
        if isinstance(error, str):
            return error
    return None


def _raise_for_ssh_failure(result: subprocess.CompletedProcess) -> None:
    if result.returncode == 255:
        raise RemoteHelperError("ssh_transport_failed", "SSH could not reach the selected host profile",
                                "verify network access and SSH configuration for this host profile, then retry")
    if result.returncode != 0:
        code = _herdr_error_code(result.stderr) or _herdr_error_code(result.stdout)
        if code is not None:
            raise RemoteHelperError("remote_session_unavailable",
                                    f"The remote Herdr session refused the operation ({code})",
                                    "verify the named remote Herdr session is running and retry",
                                    herdr_error_code=code)
        raise RemoteHelperError("remote_herdr_command_failed", "The remote Herdr command failed",
                                "inspect the remote Herdr session and retry")


def remote_herdr(profile: HostProfile, *args: str, timeout: float = SSH_COMMAND_TIMEOUT_SECONDS) -> dict[str, Any]:
    command = (str(profile.herdr_executable), "--session", profile.herdr_session, *args)
    result = _run_ssh(profile, command, timeout=timeout)
    _raise_for_ssh_failure(result)
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RemoteHelperError("remote_herdr_protocol_invalid", "The remote Herdr response was unreadable",
                                "verify the installed remote Herdr client and server are compatible") from error
    if not isinstance(value, dict) or not isinstance(value.get("result"), dict):
        raise RemoteHelperError("remote_herdr_protocol_invalid", "The remote Herdr response has no result object",
                                "verify the installed remote Herdr client and server are compatible")
    return value["result"]


def remote_herdr_run(profile: HostProfile, *args: str, timeout: float = SSH_COMMAND_TIMEOUT_SECONDS) -> None:
    """Call a remote Herdr command whose successful response is empty (``pane run``)."""
    command = (str(profile.herdr_executable), "--session", profile.herdr_session, *args)
    result = _run_ssh(profile, command, timeout=timeout)
    _raise_for_ssh_failure(result)


def remote_herdr_text(profile: HostProfile, *args: str,
                      timeout: float = SSH_COMMAND_TIMEOUT_SECONDS) -> str:
    """Call a remote Herdr command whose successful response is raw text."""
    command = (str(profile.herdr_executable), "--session", profile.herdr_session, *args)
    result = _run_ssh(profile, command, timeout=timeout)
    _raise_for_ssh_failure(result)
    return result.stdout


# --- Remote cwd and host identity ---------------------------------------------

def resolve_and_verify_remote_cwd(profile: HostProfile, registry: HostProfileRegistry, profile_id: str,
                                  local_cwd: Path, explicit_remote_cwd: str | None):
    try:
        request = registry.resolve_remote_cwd(profile_id, local_cwd, explicit_remote_cwd)
    except HostProfileError as error:
        raise _wrap_profile_error(error, "repair the requested cwd or config.json path_mappings") from error
    result = _run_ssh(profile, ("test", "-d", str(request.remote_cwd)))
    if result.returncode == 255:
        raise RemoteHelperError("ssh_transport_failed", "SSH could not reach the selected host profile",
                                "verify network access and SSH configuration for this host profile, then retry")
    if result.returncode != 0:
        raise RemoteHelperError("remote_cwd_missing",
                                f"The resolved remote directory does not exist: {request.remote_cwd}",
                                "create the remote directory or repair the requested cwd, then retry")
    return request


def require_remote_executable(profile: HostProfile, path: object, code: str, description: str) -> None:
    """Fixed, path-parameterized preflight; never resolved through PATH."""
    result = _run_ssh(profile, ("test", "-x", str(path)))
    if result.returncode == 255:
        raise RemoteHelperError("ssh_transport_failed", "SSH could not reach the selected host profile",
                                "verify network access and SSH configuration for this host profile, then retry")
    if result.returncode != 0:
        raise RemoteHelperError(code, f"The {description} is not executable on the remote host: {path}",
                                f"repair or reinstall {path} on the remote host and retry")


PREFLIGHT_OUTPUT_BOUND = 2000


def _bounded_output(text: str) -> str:
    text = text.strip()
    if len(text) > PREFLIGHT_OUTPUT_BOUND:
        return text[:PREFLIGHT_OUTPUT_BOUND] + "...(truncated)"
    return text


@dataclass(frozen=True)
class RemoteLaunchExpectation:
    """The dry-run plan facts a later process-info observation must match."""

    native_executable: str
    deployment: str
    model_id: str
    agent: str
    native_args: tuple[str, ...]


def require_remote_foundry_preflight(profile: HostProfile, foundry_executable: PurePosixPath, model: str,
                                     agent: str, args_after: Sequence[str],
                                     qualification: bool = False) -> RemoteLaunchExpectation:
    """Prove the exact selected model/agent/native-argv combination against
    the real remote launcher before any Herdr workspace/tab/pane mutation.
    Creation is not readiness: a pane that comes up cleanly proves nothing
    about the installed launcher accepting this route.

    Argv stays structured through the same ``_run_ssh``/``_ssh_argv`` quoting
    owner as every other remote call; only registry-derived and
    caller-selected model/agent/native-argv values are interpolated, never an
    arbitrary remote command. Dry-run must never read or serialize
    credentials; SSH forwards no local environment by default, so this fixed
    command cannot leak any."""
    remote_config = foundry_executable.parent / "config.json"
    command = (str(foundry_executable), "--config", str(remote_config), "--dry-run", "launch",
              "--model", model, "--agent", agent, *(("--qualification",) if qualification else ()),
              "--", *args_after)
    result = _run_ssh(profile, command)
    if result.returncode == 255:
        raise RemoteHelperError("ssh_transport_failed", "SSH could not reach the selected host profile",
                                "verify network access and SSH configuration for this host profile, then retry")
    if result.returncode != 0:
        stderr = _bounded_output(result.stderr)
        stdout = _bounded_output(result.stdout)
        detail = stderr or stdout or f"exit code {result.returncode}"
        raise RemoteHelperError(
            "remote_foundry_preflight_failed",
            f"The remote Monash Foundry launcher rejected the selected dry-run: {detail}",
            "repair the installed remote Monash Foundry launcher, or the selected model/agent/native arguments, "
            "then retry")
    native_match = re.search(r"^native_cli=(.+?) source=\S+\s*$", result.stdout, re.MULTILINE)
    status_match = re.search(r"\bagent=(\S+)\b.*\bdeployment=(\S+)\b.*\bmodel=(\S+)", result.stdout)
    if native_match is None or status_match is None:
        raise RemoteHelperError(
            "remote_foundry_preflight_protocol_invalid",
            "The remote Monash Foundry launcher did not disclose the native launch identity",
            "install the matching remote Monash Foundry snapshot and retry")
    selected_agent, deployment, model_id = status_match.groups()
    if selected_agent != agent or model_id != model:
        raise RemoteHelperError(
            "remote_foundry_preflight_protocol_invalid",
            "The remote Monash Foundry dry-run identity disagrees with the requested route",
            "repair the installed remote Monash Foundry snapshot and retry")
    return RemoteLaunchExpectation(native_executable=native_match.group(1), deployment=deployment,
                                   model_id=model_id, agent=selected_agent, native_args=tuple(args_after))


def observed_remote_home(profile: HostProfile) -> str:
    """Resolve the remote $HOME once so shim paths are absolute, never ``~``.

    A literal ``~`` would be tilde-expanded by the shell only when it is the
    unquoted start of the exported PATH, but stays literal inside the
    single-quoted comparison the shim-resolution probe builds; the two sides
    could never match."""
    result = _run_ssh(profile, ("printenv", "HOME"))
    if result.returncode == 255:
        raise RemoteHelperError("ssh_transport_failed", "SSH could not reach the selected host profile",
                                "verify network access and SSH configuration for this host profile, then retry")
    value = result.stdout.strip()
    if result.returncode != 0 or not value.startswith("/"):
        raise RemoteHelperError("remote_home_unavailable", "The remote $HOME could not be observed",
                                "repair the remote login shell environment and retry")
    return value


def observed_execution_host(profile: HostProfile) -> dict[str, str]:
    result = _run_ssh(profile, ("/bin/hostname",))
    if result.returncode == 255:
        raise RemoteHelperError("ssh_transport_failed", "SSH could not reach the selected host profile",
                                "verify network access and SSH configuration for this host profile, then retry")
    value = result.stdout.strip()
    if result.returncode != 0 or not value:
        raise RemoteHelperError("remote_execution_host_unavailable", "The remote execution host could not be observed",
                                "repair /bin/hostname on the remote host and retry")
    return {
        "value": value,
        "source": "ssh+/bin/hostname",
        "observed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


# --- Remote shim: reroute the canonical native command through monash-foundry -

def remote_shim_directory(remote_home: str, run_id: str) -> PurePosixPath:
    return PurePosixPath(remote_home) / REMOTE_SPAWN_STATE_ROOT / run_id / "bin"


def build_shim_script(agent: str, foundry_executable: PurePosixPath, model: str, qualification: bool,
                      shim_directory: PurePosixPath) -> str:
    """Fix launcher/model/agent/qualification only; native args forward
    exactly once, via ``"$@"`` supplied by Herdr's own ``agent start --
    <args>``. Never bake native args into this script too, or ``agent
    start``'s forwarded argv and this fixed command line would both
    contribute the same literal args.

    Recursion prevention: strip the exact generated shim directory prefix
    from PATH before exec'ing the real launcher, so a PATH lookup performed
    by the launcher or the real native binary can never resolve back to this
    shim. An unexpected PATH shape (the prefix not being exactly where it
    must be) is refused outright rather than rediscovered or re-scanned for."""
    launcher = [str(foundry_executable), "launch", "--model", model, "--agent", agent]
    if qualification:
        launcher.append("--qualification")
    prefix = shlex.quote(str(shim_directory) + ":")
    return "\n".join((
        "#!/bin/sh",
        f'case "$PATH" in',
        f"  {prefix}*) PATH=${{PATH#{prefix}}} ;;",
        '  *) printf \'%s\\n\' \'Monash shim PATH shape unexpected\' >&2; exit 126 ;;',
        "esac",
        "export PATH",
        "exec env " + shlex.join((f"HERDR_AGENT={agent}", *launcher)) + ' -- "$@"',
        "",
    ))


def write_remote_shim_command(directory: PurePosixPath, agent: str, script: str) -> str:
    path = directory / agent
    return " && ".join((
        shlex.join(("mkdir", "-p", str(directory))),
        "printf '%s\\n' " + shlex.quote(script) + " > " + shlex.quote(str(path)),
        shlex.join(("chmod", "700", str(path))),
    ))


def verify_remote_shim(profile: HostProfile, pane_id: str, agent: str, shim_path: PurePosixPath) -> None:
    expected = str(shim_path)
    command = (
        f"resolved=$(command -v {shlex.quote(agent)} 2>/dev/null); "
        f"if [ \"$resolved\" = {shlex.quote(expected)} ]; then "
        f"printf '%s\\n' {shlex.quote('__MONASH_SHIM_OK__=' + expected)}; "
        "else printf '__MONASH_SHIM_MISMATCH__=%s\\n' \"$resolved\"; fi"
    )
    remote_herdr_run(profile, "pane", "run", pane_id, command)
    sentinel_pattern = rf"^__MONASH_SHIM_(?:OK__={re.escape(expected)}|MISMATCH__=.*)$"
    result = remote_herdr(profile, "pane", "wait-output", pane_id, "--regex", sentinel_pattern,
                          "--timeout", str(SHIM_RESOLUTION_TIMEOUT_MS))
    matched = result.get("matched_line")
    if matched != f"__MONASH_SHIM_OK__={expected}":
        raise RemoteHelperError(
            "remote_shim_resolution_failed",
            "The remote pane did not resolve the canonical native command to its per-run shim",
            "inspect the remote pane login-shell PATH, aliases, and functions; do not retry start",
        )


def _native_argv_has_model(argv: list[Any], deployment: str, model_id: str, agent: str) -> bool:
    """The model-bearing argv pattern monash-foundry itself bakes into the
    real native invocation at exec time, distinct per agent kind. Each
    pattern matches ``validate_*_native_args``'s actual foreground argv, not
    an incidental env value that could belong to a different default."""
    values = [value for value in argv if isinstance(value, str)]
    if len(values) != len(argv):
        return False
    if agent == "codex":
        return any(values[index:index + 2] == ["-c", f"model={json.dumps(deployment)}"]
                   for index in range(len(values) - 1))
    if agent == "opencode":
        return any(values[index:index + 2] == ["--model", f"azure/{model_id}"]
                   for index in range(len(values) - 1))
    if agent == "claude":
        # `validate_claude_native_args` places the exact selected deployment
        # as `--model DEPLOYMENT` in the foreground argv. A `--settings` env
        # value is not proof: Sonnet 4.6 and other non-default selections may
        # not equal whatever default value happens to sit in that JSON.
        return any(values[index:index + 2] == ["--model", deployment]
                   for index in range(len(values) - 1))
    return False


def _argv_ends_with(argv: list[Any], expected_native_args: Sequence[str]) -> bool:
    """Exact ordered-suffix comparison by value only; never re-parsed or
    shell-evaluated, so a spaced value, a leading dash, or a shell-looking
    literal travels as the same literal string it started as."""
    if not expected_native_args:
        return True
    if len(expected_native_args) > len(argv):
        return False
    return list(argv[-len(expected_native_args):]) == list(expected_native_args)


def verify_remote_native_process(profile: HostProfile, pane_id: str, expected_cwd: str, native_executable: str,
                                 deployment: str, model_id: str, agent: str,
                                 expected_native_args: Sequence[str] = (),
                                 timeout: float = SSH_COMMAND_TIMEOUT_SECONDS) -> None:
    """A label or agent-kind metadata alone is insufficient: prove the exact
    foreground OS process is the pinned native executable, running in the
    expected cwd, with the expected model-bearing argv and, when native args
    were requested, the exact ordered literal suffix. Never treat pane
    creation, Herdr's own agent-kind detection, or a name match as proof."""
    result = remote_herdr(profile, "pane", "process-info", "--pane", pane_id, timeout=timeout)
    info = result.get("process_info")
    processes = info.get("foreground_processes") if isinstance(info, dict) else None
    if not isinstance(processes, list):
        raise RemoteHelperError(
            "remote_native_process_unverified", "The remote Herdr session did not report the native foreground process",
            "inspect the remote pane; do not treat agent metadata alone as proof of readiness")
    for process in processes:
        if not isinstance(process, dict):
            continue
        argv = process.get("argv")
        argv0 = process.get("argv0")
        matches_argv = isinstance(argv, list) and bool(argv) and argv[0] == native_executable
        matches_argv0 = isinstance(argv0, str) and argv0 == native_executable
        if not (matches_argv or matches_argv0):
            continue
        if process.get("cwd") != expected_cwd:
            raise RemoteHelperError(
                "remote_native_process_cwd_mismatch",
                "The remote native process is not running in the expected working directory",
                "inspect the remote pane; do not reuse this run_id")
        if not (isinstance(argv, list) and _native_argv_has_model(argv, deployment, model_id, agent)):
            raise RemoteHelperError(
                "remote_native_process_model_mismatch",
                "The remote foreground process does not carry the expected model-bearing argv",
                "inspect the remote pane; do not treat agent metadata alone as proof of readiness")
        if not _argv_ends_with(argv, expected_native_args):
            raise RemoteHelperError(
                "remote_native_process_argv_mismatch",
                "The remote foreground process's native argv does not end with the expected literal arguments",
                "inspect the remote pane; do not treat agent metadata alone as proof of readiness")
        return
    raise RemoteHelperError(
        "remote_native_process_unverified",
        "Herdr did not observe the pinned native executable as the remote foreground process",
        "inspect the remote pane; do not treat agent metadata alone as proof of readiness")


# --- Persisted remote identity -------------------------------------------------

def remote_state_root() -> Path:
    root = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))
    return root / "monash" / "remote"


def remote_state_path(run_id: str) -> Path:
    return remote_state_root() / f"{run_id}.json"


def persist_remote_identity(identity: dict[str, object]) -> None:
    destination = remote_state_path(str(identity["run_id"]))
    try:
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    except OSError as error:
        raise RemoteHelperError(
            "remote_identity_persistence_failed", "The remote agent identity could not be saved",
            "repair XDG_STATE_HOME permissions; the remote agent remains running") from error
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile("w", dir=destination.parent, encoding="utf-8", delete=False) as handle:
            json.dump(identity, handle, sort_keys=True)
            handle.write("\n")
            temporary = Path(handle.name)
        os.chmod(temporary, 0o600)
        os.replace(temporary, destination)
    except OSError as error:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
        raise RemoteHelperError(
            "remote_identity_persistence_failed", "The remote agent identity could not be saved",
            "repair XDG_STATE_HOME permissions; the remote agent remains running") from error


def _persist_or_annotate(identity: dict[str, object], run_id: str, detail: dict[str, Any] | None = None) -> None:
    """Every persistence call after a real remote pane exists routes through
    here, so any failure, including the initial partial write, final ready write,
    or a later session/host-refresh write, returns the same structured
    envelope with run_id and the best known remote_identity, never a bare
    unannotated refusal."""
    try:
        persist_remote_identity(identity)
    except RemoteHelperError as error:
        error.run_id = run_id
        error.remote_identity = dict(identity)
        if detail is not None:
            error.observation = _agent_observation(detail)
        raise


def load_remote_identity(run_id: str) -> dict[str, object]:
    path = remote_state_path(run_id)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise RemoteHelperError(
            "remote_target_missing", f"No persisted remote agent identity for run_id {run_id!r}",
            "start a new remote agent; a missing run_id is never restarted implicitly") from error
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RemoteHelperError("remote_identity_unreadable", "The persisted remote agent identity could not be read",
                                "inspect XDG_STATE_HOME and retry") from error
    if not isinstance(value, dict):
        raise RemoteHelperError("remote_identity_unreadable", "The persisted remote agent identity is not an object",
                                "inspect XDG_STATE_HOME and retry")
    return value


def _load_and_check(args: argparse.Namespace) -> tuple[HostProfile, dict[str, object]]:
    registry = load_registry(config_path(args))
    profile = ssh_profile(registry, args.host)
    identity = load_remote_identity(args.run_id)
    if identity.get("profile_id") != args.host:
        raise RemoteHelperError(
            "remote_target_replaced", "The run_id was not started against the requested host profile",
            "pass the host profile recorded for this run_id")
    return profile, identity


# --- Agent observation and readiness -------------------------------------------

def _agent_get(profile: HostProfile, target: str,
               timeout: float = SSH_COMMAND_TIMEOUT_SECONDS) -> dict[str, Any]:
    detail = remote_herdr(profile, "agent", "get", target, timeout=timeout).get("agent")
    if not isinstance(detail, dict):
        raise RemoteHelperError("remote_herdr_protocol_invalid", "The remote Herdr session did not return the agent",
                                "verify the installed remote Herdr client and server are compatible")
    return detail


def _session_tuple_complete(session: object, *, expected_agent: str | None = None) -> bool:
    """A complete tuple has nonempty strings for source/agent/kind/value; when
    ``expected_agent`` is given, both session.agent and session.source must
    match the observed native agent's identity (``herdr:<agent>``), matching
    the same authority the local Herdr-session verifier already enforces."""
    if not isinstance(session, dict):
        return False
    for name in ("source", "agent", "kind", "value"):
        value = session.get(name)
        if not isinstance(value, str) or value == "":
            return False
    if expected_agent is not None:
        if session.get("agent") != expected_agent:
            return False
        if session.get("source") != f"herdr:{expected_agent}":
            return False
    return True


def _agent_observation(detail: dict[str, Any]) -> dict[str, object]:
    observation: dict[str, object] = {
        name: detail[name]
        for name in ("pane_id", "tab_id", "workspace_id", "terminal_id", "agent", "agent_status", "cwd",
                     "interactive_ready")
        if name in detail
    }
    session = detail.get("agent_session")
    if isinstance(session, dict):
        observation["agent_session"] = session
        if isinstance(session.get("value"), str):
            observation["session_id"] = session["value"]
    observation["source"] = "remote.herdr.agent.get"
    return observation


def _ready(detail: dict[str, Any], expected_agent: str) -> bool:
    """Cwd is deliberately not part of readiness: a mismatch is a hard refusal
    raised earlier by ``_reconcile``, never a silently downgraded status."""
    return (detail.get("agent") == expected_agent and detail.get("interactive_ready") is True
            and _session_tuple_complete(detail.get("agent_session"), expected_agent=expected_agent))


def _verify_identity_unchanged(identity: dict[str, object], detail: dict[str, Any]) -> None:
    for name in ("pane_id", "tab_id", "workspace_id", "terminal_id"):
        if detail.get(name) != identity.get(name):
            raise RemoteHelperError(
                "remote_target_replaced", f"The remote agent {name} no longer matches the persisted identity",
                "inspect the remote session; do not reuse this run_id")
    if detail.get("agent") != identity.get("agent_kind"):
        raise RemoteHelperError(
            "remote_kind_mismatch", "The remote agent kind no longer matches the requested native agent",
            "inspect the remote session; do not reuse this run_id")


def _target_agent_name(identity: dict[str, object]) -> str:
    """The live Herdr name to address: the proven ``agent_name`` once promoted,
    else the still-unproven ``intended_agent_name`` recorded at pane creation."""
    name = identity.get("agent_name") or identity.get("intended_agent_name")
    if not isinstance(name, str):
        raise RemoteHelperError("remote_identity_unreadable", "The persisted remote identity has no agent name",
                                "inspect XDG_STATE_HOME and retry")
    return name


def _reconcile(identity: dict[str, object], detail: dict[str, Any]) -> tuple[dict[str, object], bool]:
    """Verify a fresh observation against the persisted identity, promote a
    proven ``intended_agent_name`` to ``agent_name``, and pin a
    freshly-complete session tuple exactly once. Returns the (possibly
    updated) identity and whether the caller must persist it. Raises a
    structured refusal on any replaced pane/tab/workspace/terminal, kind
    mismatch, observed-cwd mismatch, or changed session tuple; a caller must
    never let a prompt/read/wait proceed against a replaced target."""
    _verify_identity_unchanged(identity, detail)
    if detail.get("cwd") != identity.get("expected_cwd"):
        raise RemoteHelperError(
            "remote_cwd_mismatch",
            "The remote agent's observed working directory no longer matches the expected remote cwd",
            "inspect the remote pane; do not reuse this run_id")
    changed = False
    if "agent_name" not in identity and "intended_agent_name" in identity:
        proven_name = identity["intended_agent_name"]
        identity = {name: value for name, value in identity.items() if name != "intended_agent_name"}
        identity["agent_name"] = proven_name
        changed = True
    observed_session = detail.get("agent_session")
    persisted_session = identity.get("agent_session")
    if persisted_session is not None:
        if observed_session != persisted_session:
            raise RemoteHelperError(
                "remote_session_changed", "The remote agent session no longer matches the persisted identity",
                "inspect the remote session; do not reuse this run_id")
        return identity, changed
    if _session_tuple_complete(observed_session, expected_agent=detail.get("agent")):
        return {**identity, "agent_session": observed_session}, True
    return identity, changed


def _root_pane(result: dict[str, Any]) -> dict[str, Any]:
    pane = result.get("root_pane")
    if not isinstance(pane, dict) or not all(
        isinstance(pane.get(name), str) for name in ("pane_id", "tab_id", "workspace_id", "terminal_id")
    ):
        raise RemoteHelperError(
            "remote_herdr_protocol_invalid", "The remote Herdr workspace response has no usable root pane",
            "verify the installed remote Herdr client and server are compatible")
    return pane


def _attach_argv(identity: dict[str, object]) -> list[str]:
    return ["ssh", "-tt", str(identity["ssh_alias"]), str(identity["herdr_executable"]),
            "--session", str(identity["herdr_session"]), "agent", "attach", str(identity["agent_name"])]


def _receipt(command: str, identity: dict[str, object], detail: dict[str, Any]) -> dict[str, object]:
    ready = _ready(detail, str(identity["agent_kind"]))
    session = detail.get("agent_session")
    receipt: dict[str, object] = {
        "schema_version": SCHEMA_VERSION,
        "command": command,
        "status": "ready" if ready else "started",
        "run_id": identity["run_id"],
        "profile_id": identity["profile_id"],
        "transport": "ssh",
        "execution_host": identity["execution_host"],
        "agent": identity["agent_kind"],
        "agent_name": identity["agent_name"],
        "requested_cwd": identity["requested_cwd"],
        "expected_cwd": identity["expected_cwd"],
        "expected_cwd_source": identity["expected_cwd_source"],
        "observed_cwd": detail.get("cwd"),
        "workspace_id": identity["workspace_id"],
        "tab_id": identity["tab_id"],
        "pane_id": identity["pane_id"],
        "terminal_id": identity["terminal_id"],
        "native_identity": {
            "agent": detail.get("agent"),
            "agent_status": detail.get("agent_status"),
            "interactive_ready": detail.get("interactive_ready"),
        },
        "attach_argv": _attach_argv(identity),
        "observation": _agent_observation(detail),
    }
    if _session_tuple_complete(session, expected_agent=str(identity["agent_kind"])):
        receipt["session_id"] = session["value"]
    return receipt


# --- Commands -------------------------------------------------------------------

def cmd_start(args: argparse.Namespace) -> dict[str, object]:
    run_id = validated_or_generated_run_id(getattr(args, "run_id", None))

    registry = load_registry(config_path(args))
    profile = ssh_profile(registry, args.host)

    foundry_executable = profile.foundry_executable
    if foundry_executable is None:
        raise RemoteHelperError(
            "remote_launcher_unavailable", "The selected host profile has no remote Monash Foundry launcher",
            "repair config.json remote_install_root for this host profile")
    require_remote_executable(profile, profile.herdr_executable,
                              "remote_herdr_executable_not_executable", "configured herdr_executable")
    require_remote_executable(profile, foundry_executable,
                              "remote_foundry_executable_not_executable", "derived foundry_executable")
    expectation = require_remote_foundry_preflight(profile, foundry_executable, args.model, args.agent,
                                                   native_args(args), args.qualification)

    local_cwd = require_local_directory(args.cwd)
    remote_request = resolve_and_verify_remote_cwd(profile, registry, args.host, local_cwd, args.remote_cwd)
    execution_host = observed_execution_host(profile)
    remote_home = observed_remote_home(profile)

    label = f"monash-{run_id[:8]}"
    workspace_result = remote_herdr(profile, "workspace", "create", "--cwd", str(remote_request.remote_cwd),
                                    "--label", label, "--no-focus")
    root_pane = _root_pane(workspace_result)
    pane_id = root_pane["pane_id"]

    # A real remote pane now exists. Persist a recoverable identity before any
    # further mutation, so a shim failure, blocked startup, or managed-start
    # timeout below can still be recovered by run_id instead of blindly
    # retrying start. `intended_agent_name` is metadata only, never lifecycle
    # truth, until a fresh `agent get` proves that name resolves to a real
    # agent in this exact pane/kind/cwd (see `_matches_intended_target`).
    partial_identity: dict[str, object] = {
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "profile_id": args.host,
        "ssh_alias": profile.ssh_alias,
        "herdr_session": profile.herdr_session,
        "herdr_executable": str(profile.herdr_executable),
        "requested_cwd": str(local_cwd),
        "expected_cwd": str(remote_request.remote_cwd),
        "expected_cwd_source": remote_request.source,
        "workspace_id": root_pane["workspace_id"],
        "tab_id": root_pane["tab_id"],
        "pane_id": pane_id,
        "terminal_id": root_pane["terminal_id"],
        "intended_agent_name": label,
        "agent_kind": args.agent,
        "model": args.model,
        "native_executable": expectation.native_executable,
        "deployment": expectation.deployment,
        "model_id": expectation.model_id,
        "native_args": list(expectation.native_args),
        "execution_host": execution_host,
    }
    _persist_or_annotate(partial_identity, run_id)

    observed_detail: dict[str, Any] | None = None
    identity: dict[str, object] = partial_identity
    try:
        shim_directory = remote_shim_directory(remote_home, run_id)
        shim_path = shim_directory / args.agent
        script = build_shim_script(args.agent, foundry_executable, args.model, args.qualification, shim_directory)
        remote_herdr_run(profile, "pane", "run", pane_id,
                         write_remote_shim_command(shim_directory, args.agent, script))
        remote_herdr_run(profile, "pane", "run", pane_id,
                         f"export PATH={shlex.quote(str(shim_directory))}:\"$PATH\"")
        verify_remote_shim(profile, pane_id, args.agent, shim_path)

        start_error: RemoteHelperError | None = None
        try:
            remote_herdr(profile, "agent", "start", label, "--kind", args.agent, "--pane", pane_id,
                        "--timeout", str(MANAGED_START_TIMEOUT_MS), "--", *native_args(args),
                        timeout=(MANAGED_START_TIMEOUT_MS / 1000) + 5)
        except RemoteHelperError as error:
            start_error = error
        try:
            observed_detail = _agent_get(profile, label)
        except RemoteHelperError:
            if start_error is not None:
                raise start_error
            raise

        # Reconcile (and promote intended_agent_name -> agent_name) against
        # Herdr's own metadata first, independent of blocked/timeout status,
        # so recovery identity below reflects the proven name whenever Herdr
        # itself resolved it, even if startup did not fully succeed.
        identity, _ = _reconcile(partial_identity, observed_detail)

        if observed_detail.get("agent_status") == "blocked":
            raise RemoteHelperError(
                "remote_agent_blocked", "The remote Herdr session observed the native agent blocked during startup",
                "inspect the remote pane and resolve the native prompt explicitly; do not retry start")
        if start_error is not None:
            raise RemoteHelperError(
                "remote_native_not_ready",
                "The remote Herdr session did not report the native agent ready before the managed start timeout",
                "inspect the remote pane for native startup output; do not retry start") from start_error

        # A label or agent-kind metadata alone is insufficient: prove the real
        # foreground OS process before ever calling this receipt ready.
        verify_remote_native_process(profile, pane_id, str(identity["expected_cwd"]),
                                     str(identity["native_executable"]), str(identity["deployment"]),
                                     str(identity["model_id"]), args.agent, identity["native_args"])
    except RemoteHelperError as error:
        error.run_id = run_id
        if observed_detail is not None:
            error.observation = _agent_observation(observed_detail)
        error.remote_identity = dict(identity)
        if "agent_name" in identity:
            _persist_or_annotate(identity, run_id, observed_detail)
        raise

    _persist_or_annotate(identity, run_id, observed_detail)
    return _receipt("start", identity, observed_detail)


def _remaining_timeout(deadline: float | None) -> float:
    if deadline is None:
        return SSH_COMMAND_TIMEOUT_SECONDS
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError
    return max(0.001, min(SSH_COMMAND_TIMEOUT_SECONDS, remaining))


def _observe_and_reconcile(profile: HostProfile, identity: dict[str, object], *,
                           deadline: float | None = None) -> tuple[dict[str, object], dict[str, Any]]:
    """The shared pre-flight every control/observation path runs before it is
    allowed to forward a lifecycle operation to the stored remote agent.
    Every observation re-proves the real foreground OS process, not merely
    Herdr's agent-kind metadata."""
    detail = _agent_get(profile, _target_agent_name(identity), timeout=_remaining_timeout(deadline))
    if deadline is not None and time.monotonic() >= deadline:
        raise TimeoutError
    identity, changed = _reconcile(identity, detail)
    if changed:
        _persist_or_annotate(identity, str(identity["run_id"]), detail)
    verify_remote_native_process(profile, str(identity["pane_id"]), str(identity["expected_cwd"]),
                                 str(identity["native_executable"]), str(identity["deployment"]),
                                 str(identity["model_id"]), str(identity["agent_kind"]),
                                 identity.get("native_args", ()), timeout=_remaining_timeout(deadline))
    if deadline is not None and time.monotonic() >= deadline:
        raise TimeoutError
    return identity, detail


def _annotate_control_error(error: RemoteHelperError, identity: dict[str, object],
                            detail: dict[str, Any] | None = None) -> None:
    """Attach the persisted run identity to a post-dispatch refusal."""
    error.run_id = str(identity["run_id"])
    error.remote_identity = dict(identity)
    if detail is not None:
        error.observation = _agent_observation(detail)


def reconcile_stalled_prompt(profile: HostProfile, identity: dict[str, object], detail: dict[str, Any],
                             deadline: float, prompt_error: RemoteHelperError
                             ) -> tuple[dict[str, object], dict[str, Any]]:
    """Observe one uncertain prompt submission without ever sending it again."""
    latest = detail
    while time.monotonic() < deadline:
        try:
            identity, latest = _observe_and_reconcile(profile, identity, deadline=deadline)
        except TimeoutError:
            break
        except RemoteHelperError as error:
            if error.code == "remote_command_timed_out" and time.monotonic() >= deadline:
                break
            _annotate_control_error(error, identity, latest)
            raise
        if latest.get("agent_status") == "blocked":
            error = RemoteHelperError(
                "remote_agent_blocked", "The remote agent became blocked after prompt submission",
                "inspect the remote pane and resolve the native prompt explicitly")
            _annotate_control_error(error, identity, latest)
            raise error from prompt_error
        if _ready(latest, str(identity["agent_kind"])):
            return identity, latest
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        time.sleep(min(PROMPT_RECONCILE_INTERVAL_SECONDS, remaining))
    error = RemoteHelperError(
        "verification_not_settled", "The remote first-turn prompt did not settle before its original timeout",
        "inspect the persisted remote run before deciding whether to retry the prompt")
    _annotate_control_error(error, identity, latest)
    raise error from prompt_error


def cmd_get(args: argparse.Namespace) -> dict[str, object]:
    profile, identity = _load_and_check(args)
    identity, detail = _observe_and_reconcile(profile, identity)
    return _receipt("get", identity, detail)


def cmd_prompt(args: argparse.Namespace) -> dict[str, object]:
    profile, identity = _load_and_check(args)
    identity, detail = _observe_and_reconcile(profile, identity)
    if detail.get("agent_status") == "blocked":
        raise RemoteHelperError("remote_agent_blocked", "The remote agent is blocked and cannot accept a prompt",
                                "inspect the remote pane and resolve the native prompt explicitly")
    if detail.get("interactive_ready") is not True:
        raise RemoteHelperError("remote_not_interactive", "The remote agent is not ready for interactive input",
                                "inspect the remote pane and wait for interactive readiness before prompting")
    if identity.get("agent_session") is None:
        time.sleep(FIRST_PROMPT_SETTLE_SECONDS)
        identity, detail = _observe_and_reconcile(profile, identity)
        if detail.get("agent_status") == "blocked":
            raise RemoteHelperError("remote_agent_blocked", "The remote agent became blocked before its first prompt",
                                    "inspect the remote pane and resolve the native prompt explicitly")
        if detail.get("interactive_ready") is not True:
            raise RemoteHelperError("remote_not_interactive", "The remote agent is not ready for its first prompt",
                                    "inspect the remote pane and wait for interactive readiness before prompting")
    herdr_args = ["agent", "prompt", str(identity["agent_name"]), args.text]
    if args.wait:
        herdr_args.append("--wait")
    timeout_ms = args.timeout if args.timeout is not None else DEFAULT_WAIT_TIMEOUT_MS
    herdr_args.extend(("--timeout", str(timeout_ms)))
    deadline = time.monotonic() + (timeout_ms / 1000)
    try:
        remote_herdr(profile, *herdr_args, timeout=(timeout_ms / 1000) + 5)
    except RemoteHelperError as error:
        if args.wait and error.herdr_error_code == "agent_prompt_stalled":
            identity, detail = reconcile_stalled_prompt(profile, identity, detail, deadline, error)
        else:
            _annotate_control_error(error, identity, detail)
            raise
    else:
        identity, detail = _observe_and_reconcile(profile, identity)
    return _receipt("prompt", identity, detail)


def cmd_read(args: argparse.Namespace) -> dict[str, object]:
    profile, identity = _load_and_check(args)
    identity, _ = _observe_and_reconcile(profile, identity)
    herdr_args = ["agent", "read", str(identity["agent_name"])]
    if args.source:
        herdr_args.extend(("--source", args.source))
    if args.lines is not None:
        herdr_args.extend(("--lines", str(args.lines)))
    result = remote_herdr_text(profile, *herdr_args)
    return {
        "schema_version": SCHEMA_VERSION, "command": "read", "run_id": identity["run_id"],
        "agent_name": identity["agent_name"], "read": {"text": result},
    }


def cmd_wait(args: argparse.Namespace) -> dict[str, object]:
    profile, identity = _load_and_check(args)
    identity, _ = _observe_and_reconcile(profile, identity)
    herdr_args = ["agent", "wait", str(identity["agent_name"])]
    for state in args.until:
        herdr_args.extend(("--until", state))
    timeout_ms = args.timeout if args.timeout is not None else DEFAULT_WAIT_TIMEOUT_MS
    herdr_args.extend(("--timeout", str(timeout_ms)))
    remote_herdr(profile, *herdr_args, timeout=(timeout_ms / 1000) + 5)
    identity, detail = _observe_and_reconcile(profile, identity)
    return _receipt("wait", identity, detail)


def cmd_reconnect(args: argparse.Namespace) -> dict[str, object]:
    profile, identity = _load_and_check(args)
    identity, detail = _observe_and_reconcile(profile, identity)

    fresh_host = observed_execution_host(profile)
    persisted_host = identity.get("execution_host")
    persisted_value = persisted_host.get("value") if isinstance(persisted_host, dict) else None
    if fresh_host["value"] != persisted_value:
        raise RemoteHelperError(
            "remote_execution_host_changed",
            "The remote execution host no longer matches the persisted identity",
            "inspect the remote host; do not reuse this run_id")
    if fresh_host != persisted_host:
        identity = {**identity, "execution_host": fresh_host}
        _persist_or_annotate(identity, str(identity["run_id"]), detail)
    return _receipt("reconnect", identity, detail)


# --- CLI --------------------------------------------------------------------

def emit(value: dict[str, object]) -> None:
    print(json.dumps(value, sort_keys=True))


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("--config", required=True, help="Monash Foundry config path")
    root.add_argument("--host", required=True, metavar="PROFILE_ID")
    commands = root.add_subparsers(dest="command", required=True)

    start = commands.add_parser("start", help="start one native agent in the named remote Herdr session")
    start.add_argument("--agent", choices=("codex", "claude", "opencode"), required=True)
    start.add_argument("--model", required=True)
    start.add_argument("--cwd", required=True)
    start.add_argument("--remote-cwd")
    start.add_argument("--run-id", help="reuse this exact 32-character lowercase hex run_id as the caller identity")
    start.add_argument("--qualification", action="store_true")
    start.add_argument("native_args", nargs=argparse.REMAINDER)

    get_parser = commands.add_parser("get", help="observe the stored remote agent identity")
    get_parser.add_argument("--run-id", required=True)

    prompt_parser = commands.add_parser("prompt", help="submit a prompt to the stored remote agent")
    prompt_parser.add_argument("--run-id", required=True)
    prompt_parser.add_argument("text")
    prompt_parser.add_argument("--wait", action="store_true")
    prompt_parser.add_argument("--timeout", type=int)

    read_parser = commands.add_parser("read", help="read terminal output from the stored remote agent")
    read_parser.add_argument("--run-id", required=True)
    read_parser.add_argument("--source", choices=("visible", "recent", "recent-unwrapped", "detection"))
    read_parser.add_argument("--lines", type=int)

    wait_parser = commands.add_parser("wait", help="wait for the stored remote agent to reach a state")
    wait_parser.add_argument("--run-id", required=True)
    wait_parser.add_argument("--until", action="append", default=[])
    wait_parser.add_argument("--timeout", type=int)

    reconnect_parser = commands.add_parser("reconnect", help="reuse the stored remote agent identity")
    reconnect_parser.add_argument("--run-id", required=True)

    return root


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = parser().parse_args(argv)
        if args.command == "start":
            emit(cmd_start(args))
        elif args.command == "get":
            emit(cmd_get(args))
        elif args.command == "prompt":
            emit(cmd_prompt(args))
        elif args.command == "read":
            emit(cmd_read(args))
        elif args.command == "wait":
            emit(cmd_wait(args))
        elif args.command == "reconnect":
            emit(cmd_reconnect(args))
        else:
            raise AssertionError("unreachable command")
        return 0
    except (KeyboardInterrupt, EOFError):
        emit({"schema_version": SCHEMA_VERSION, "status": "cancelled"})
        return 130
    except RemoteHelperError as error:
        response: dict[str, object] = {"schema_version": SCHEMA_VERSION, "status": "refused",
                                       "error": {"code": error.code, "message": error.message, "repair": error.repair}}
        if error.run_id is not None:
            response["run_id"] = error.run_id
        if error.remote_identity is not None:
            response["remote_identity"] = error.remote_identity
        if error.observation is not None:
            response["observation"] = error.observation
        emit(response)
        return error.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
