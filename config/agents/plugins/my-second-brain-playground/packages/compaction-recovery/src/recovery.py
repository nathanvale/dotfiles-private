#!/usr/bin/python3
"""Validate and deliver one bounded playground recovery checkpoint."""

from __future__ import annotations

import fcntl
import json
import os
import re
import secrets
import shlex
import sqlite3
import stat
import sys
import time
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Dict, Iterable, Mapping, NoReturn, Optional, Tuple
from urllib.parse import quote


INPUT_LIMIT_BYTES = 128 * 1024
CONFIG_LIMIT_BYTES = 4 * 1024
CHECKPOINT_LIMIT_BYTES = 16 * 1024
MARKDOWN_LIMIT_BYTES = 256 * 1024
FRESH_FOR_SECONDS = 60 * 60
FUTURE_SKEW_SECONDS = 5 * 60
CHECKPOINT_KEYS = (
    "schemaVersion",
    "vaultRoot",
    "projectMap",
    "goalPath",
    "evidencePath",
    "recoveryPath",
    "agentLedgerExecutable",
    "sessionIdentity",
    "registerPath",
    "taskIdentity",
    "programIdentity",
    "scope",
    "observedAt",
)
CHECKPOINT_SCHEMA_VERSION = 2
IDENTITY_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,127}$")
SESSION_IDENTITY_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
OBSERVED_AT_PATTERN = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$"
)
NEXT_SAFE_ACTION = (
    "Control panel ready. Read the goal owner for the next action; open other owners only as needed. "
    "Accepted Task identity was checked now, not lifecycle status. Inspect any uncertain operation before retrying."
)

COMMAND_SCHEMA_VERSION = 1
COMMAND_IDENTITY = "my-second-brain-playground.recovery-checkpoint"
RUN_IDENTITY_PREFIX = "recovery-checkpoint-run-"
USAGE_REPAIR_ACTION = "Run recovery-checkpoint --help and select one advertised command."
CHECKPOINT_REPAIR_ACTION = (
    "Run recovery-checkpoint schema, correct the checkpoint input, then run recovery-checkpoint write again."
)
WRITE_REPAIR_ACTION = "Repair the private checkpoint state path, then retry the same write input."
UNCERTAIN_REPAIR_ACTION = (
    "Inspect the supplied session's checkpoint for its Task identity; if the committed state remains uncertain, "
    "retry the same write input."
)


# This is a best-effort, write-only seam supplied by the Bun supervisor on fd 3.
# Recovery must retain its existing result even when it is absent, full, or closed.
_OBSERVATION_FD: Optional[int] = None
_OBSERVATION_SEQUENCE = 0
_OBSERVATION_PRODUCER = ""
# Cross-language mirrors of the serialized-values.ts observation contract.
_OBSERVATION_IDENTITY_PATTERN = r"[A-Za-z0-9][A-Za-z0-9._:-]{0,511}"
_OBSERVATION_MAX_RECORD_BYTES = 4 * 1024


def _observation_identity(value: Optional[str]) -> Optional[str]:
    if not isinstance(value, str) or len(value) > 512:
        return None
    if re.fullmatch(_OBSERVATION_IDENTITY_PATTERN, value) is None:
        return None
    return value


def _observation_fd() -> Optional[int]:
    global _OBSERVATION_FD
    if _OBSERVATION_FD is not None:
        return _OBSERVATION_FD
    try:
        descriptor = int(os.environ.get("MSB_RECOVERY_OBSERVABILITY_FD", ""))
        if descriptor < 3:
            return None
        os.set_blocking(descriptor, False)
        _OBSERVATION_FD = descriptor
        return descriptor
    except (OSError, ValueError):
        return None


def observe_lifecycle(
    operation: str,
    phase: str,
    outcome: str,
    started_ns: Optional[int] = None,
    journey_identity: Optional[str] = None,
    observed_worker_identity: Optional[str] = None,
    observed_worker_identity_source: Optional[str] = None,
    inherited_parent_identity: Optional[str] = None,
    ledger_task_identity: Optional[str] = None,
    refusal_code: Optional[str] = None,
) -> None:
    """Offer one closed lifecycle record without taking recovery ownership."""
    global _OBSERVATION_PRODUCER, _OBSERVATION_SEQUENCE
    try:
        descriptor = _observation_fd()
        invocation = _observation_identity(os.environ.get("MSB_RECOVERY_OBSERVATION_INVOCATION_IDENTITY"))
        if descriptor is None or invocation is None:
            return
        if not _OBSERVATION_PRODUCER:
            _OBSERVATION_PRODUCER = "recovery-python-" + secrets.token_hex(12)
        sequence = _OBSERVATION_SEQUENCE
        _OBSERVATION_SEQUENCE += 1
        worker = _observation_identity(observed_worker_identity)
        source = observed_worker_identity_source if worker is not None else None
        parent = _observation_identity(inherited_parent_identity)
        parent_record = _observation_identity(os.environ.get("MSB_RECOVERY_OBSERVATION_PARENT_RECORD_IDENTITY"))
        task = _observation_identity(ledger_task_identity)
        record: Dict[str, Any] = {
            "schema_version": 1,
            "record_type": "lifecycle",
            "record_identity": _OBSERVATION_PRODUCER + "-" + str(sequence),
            "journey_identity": _observation_identity(journey_identity) or _observation_identity(os.environ.get("MSB_RECOVERY_OBSERVATION_JOURNEY_IDENTITY")) or invocation,
            "invocation_identity": invocation,
            "producer_identity": _OBSERVATION_PRODUCER,
            "producer_sequence": sequence,
            "harness_kind": "unknown",
            "operation": operation,
            "phase": phase,
            "occurred_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "outcome": outcome,
        }
        if parent_record is not None:
            record["parent_record_identity"] = parent_record
        if started_ns is not None:
            record["duration_ms"] = (time.monotonic_ns() - started_ns) / 1_000_000
        if worker is not None and source in ("hook-payload", "supervisor"):
            record["observed_worker_identity"] = worker
            record["observed_worker_identity_source"] = source
        if parent is not None:
            record["inherited_parent_identity"] = parent
        if task is not None:
            record["ledger_task_identity"] = task
        if outcome == "refused" and refusal_code is not None:
            record["refusal_code"] = refusal_code
        payload = (json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n").encode("utf-8")
        if len(payload) <= _OBSERVATION_MAX_RECORD_BYTES:
            os.write(descriptor, payload)
    except BaseException:
        # This producer never changes recovery's existing fail-open or command outcomes.
        return


class Rejected(Exception):
    """The supplied state cannot authorize recovery context."""


def reject() -> NoReturn:
    raise Rejected()


def _unique_object(pairs: Iterable[Tuple[str, Any]]) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            reject()
        result[key] = value
    return result


def parse_json_bytes(data: bytes, limit: int) -> Any:
    if not data or len(data) > limit:
        reject()
    try:
        text = data.decode("utf-8", errors="strict")
        return json.loads(
            text,
            object_pairs_hook=_unique_object,
            parse_constant=lambda _value: reject(),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
        reject()


def read_bounded_stdin(limit: int) -> bytes:
    data = sys.stdin.buffer.read(limit + 1)
    if len(data) > limit:
        reject()
    return data


def read_bounded_file(path: Path, limit: int) -> bytes:
    try:
        with path.open("rb") as source:
            data = source.read(limit + 1)
    except OSError:
        reject()
    if len(data) > limit:
        reject()
    return data


def read_private_file(path: Path, limit: int) -> bytes:
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError:
        reject()
    try:
        information = os.fstat(descriptor)
        if (
            not stat.S_ISREG(information.st_mode)
            or information.st_uid != os.getuid()
            or information.st_mode & 0o077
        ):
            reject()
        with os.fdopen(descriptor, "rb", closefd=True) as source:
            descriptor = -1
            data = source.read(limit + 1)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if len(data) > limit:
        reject()
    return data


def home_directory() -> Path:
    raw = os.environ.get("HOME", "")
    if not raw or "\x00" in raw:
        reject()
    path = Path(raw)
    if not path.is_absolute():
        reject()
    try:
        return path.resolve(strict=True)
    except OSError:
        reject()


def configured_vault(home: Path) -> Path:
    config_path = home / ".config" / "my-second-brain-playground" / "vault.json"
    config = parse_json_bytes(read_bounded_file(config_path, CONFIG_LIMIT_BYTES), CONFIG_LIMIT_BYTES)
    if not isinstance(config, dict) or set(config) != {"schemaVersion", "vault"}:
        reject()
    if type(config["schemaVersion"]) is not int or config["schemaVersion"] != 1:
        reject()
    raw_vault = config["vault"]
    if not isinstance(raw_vault, str) or len(raw_vault) > 2048 or any(c in raw_vault for c in "\x00\r\n"):
        reject()
    candidate = Path(raw_vault)
    if not candidate.is_absolute():
        reject()
    try:
        vault = candidate.resolve(strict=True)
    except OSError:
        reject()
    if not vault.is_dir():
        reject()
    return vault


def is_within(candidate: Path, owner: Path) -> bool:
    try:
        return os.path.commonpath((str(candidate), str(owner))) == str(owner)
    except ValueError:
        return False


def contained_file(vault: Path, raw_relative: Any, required_name: str | None = None) -> Path:
    if not isinstance(raw_relative, str):
        reject()
    if (
        not raw_relative
        or len(raw_relative) > 512
        or raw_relative.startswith("/")
        or raw_relative.endswith("/")
        or "//" in raw_relative
        or "\\" in raw_relative
        or any(c in raw_relative for c in "\x00\r\n")
    ):
        reject()
    relative = PurePosixPath(raw_relative)
    if any(part in ("", ".", "..") for part in relative.parts):
        reject()
    if required_name is not None and relative.name != required_name:
        reject()
    try:
        resolved = (vault / Path(*relative.parts)).resolve(strict=True)
    except OSError:
        reject()
    if not is_within(resolved, vault) or not resolved.is_file():
        reject()
    return resolved


def exact_identity(value: Any) -> str:
    if not isinstance(value, str) or IDENTITY_PATTERN.fullmatch(value) is None:
        reject()
    return value


def exact_session_identity(value: Any) -> str:
    if not isinstance(value, str) or SESSION_IDENTITY_PATTERN.fullmatch(value) is None:
        reject()
    return value


def validate_owned_executable(raw_path: Any) -> Path:
    if not isinstance(raw_path, str) or len(raw_path) > 2048 or any(c in raw_path for c in "\x00\r\n"):
        reject()
    candidate = Path(raw_path)
    if not candidate.is_absolute():
        reject()
    try:
        executable = candidate.resolve(strict=True)
        information = executable.stat()
    except OSError:
        reject()
    if (
        str(executable) != raw_path
        or not stat.S_ISREG(information.st_mode)
        or information.st_uid != os.getuid()
        or not os.access(executable, os.X_OK)
    ):
        reject()
    return executable


def state_root(home: Path) -> Path:
    raw = os.environ.get("XDG_STATE_HOME")
    path = Path(raw) if raw else home / ".local" / "state"
    if not path.is_absolute() or any(c in str(path) for c in "\x00\r\n"):
        reject()
    return path


def data_register_root(home: Path) -> Path:
    raw = os.environ.get("XDG_DATA_HOME")
    path = Path(raw) if raw else home / ".local" / "share"
    if not path.is_absolute() or any(c in str(path) for c in "\x00\r\n"):
        reject()
    try:
        return (path / "my-second-brain-playground" / "registers").resolve(strict=True)
    except OSError:
        reject()


def validate_register(home: Path, raw_path: Any, task_identity: str, program_identity: str) -> Path:
    if not isinstance(raw_path, str) or len(raw_path) > 2048 or any(c in raw_path for c in "\x00\r\n"):
        reject()
    candidate = Path(raw_path)
    if not candidate.is_absolute():
        reject()
    try:
        register = candidate.resolve(strict=True)
        register_root = data_register_root(home)
    except OSError:
        reject()
    if str(register) != raw_path or not is_within(register, register_root) or not register.is_file():
        reject()
    # The live Register can have committed events in its WAL; immutable reads ignore them.
    uri = "file:" + quote(str(register), safe="/") + "?mode=ro"
    connection: Optional[sqlite3.Connection] = None
    try:
        connection = sqlite3.connect(uri, uri=True)
        connection.execute("PRAGMA query_only = ON")
        metadata = connection.execute(
            "SELECT format_identity, program_identity, schema_version FROM register_metadata"
        ).fetchall()
        accepted = connection.execute(
            "SELECT COUNT(*) FROM register_events "
            "WHERE stream = 'task' AND kind = 'task-accepted' AND entity_identity = ?",
            (task_identity,),
        ).fetchone()
    except (sqlite3.Error, OSError):
        reject()
    finally:
        if connection is not None:
            connection.close()
    # Schema 2 preserves the metadata and accepted-Task identity seam used here.
    if metadata not in (
        [("agent-ledger.orchestration-register", program_identity, 1)],
        [("agent-ledger.orchestration-register", program_identity, 2)],
    ):
        reject()
    if accepted is None or accepted[0] != 1:
        reject()
    return register


def parse_observation(value: Any) -> Tuple[str, str]:
    if not isinstance(value, str) or len(value) > 40 or OBSERVED_AT_PATTERN.fullmatch(value) is None:
        reject()
    try:
        observed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        reject()
    now = datetime.now(timezone.utc)
    age = (now - observed).total_seconds()
    if age < -FUTURE_SKEW_SECONDS:
        reject()
    return value, "fresh" if age <= FRESH_FOR_SECONDS else "stale"


def has_goal_line(goal: str, label: str, literal: str) -> bool:
    pattern = re.compile(r"^\s*-\s*" + re.escape(label) + r":\s*`" + re.escape(literal) + r"`\.?\s*$", re.MULTILINE)
    return pattern.search(goal) is not None


def validate_checkpoint(
    raw: Any,
    home: Path,
    vault: Path,
    expected_session_identity: Optional[str] = None,
) -> Mapping[str, Any]:
    if not isinstance(raw, dict) or set(raw) != set(CHECKPOINT_KEYS):
        reject()
    if type(raw["schemaVersion"]) is not int or raw["schemaVersion"] != CHECKPOINT_SCHEMA_VERSION:
        reject()
    raw_vault = raw["vaultRoot"]
    if not isinstance(raw_vault, str) or raw_vault != str(vault):
        reject()
    task_identity = exact_identity(raw["taskIdentity"])
    program_identity = exact_identity(raw["programIdentity"])
    scope = exact_identity(raw["scope"])
    session_identity = exact_session_identity(raw["sessionIdentity"])
    if expected_session_identity is not None and session_identity != expected_session_identity:
        reject()
    project_map = contained_file(vault, raw["projectMap"], "README.md")
    goal = contained_file(vault, raw["goalPath"], "GOAL.md")
    evidence = contained_file(vault, raw["evidencePath"])
    recovery = contained_file(vault, raw["recoveryPath"])
    entry = contained_file(vault, "README.md", "README.md")
    agent_ledger = validate_owned_executable(raw["agentLedgerExecutable"])
    if project_map.parent != goal.parent or project_map.parent != evidence.parent:
        reject()
    register = validate_register(home, raw["registerPath"], task_identity, program_identity)
    goal_text = read_bounded_file(goal, MARKDOWN_LIMIT_BYTES).decode("utf-8", errors="strict")
    if not has_goal_line(goal_text, "Task", task_identity):
        reject()
    if not has_goal_line(goal_text, "Register", str(register)):
        reject()
    if not has_goal_line(goal_text, "Program", program_identity):
        reject()
    observed_at, freshness = parse_observation(raw["observedAt"])
    return {
        "entry": str(entry),
        "projectMap": str(project_map),
        "goal": str(goal),
        "evidence": str(evidence),
        "recovery": str(recovery),
        "agentLedger": str(agent_ledger),
        "register": str(register),
        "taskIdentity": task_identity,
        "programIdentity": program_identity,
        "scope": scope,
        "sessionIdentity": session_identity,
        "observedAt": observed_at,
        "freshness": freshness,
        "vault": str(vault),
        "checkpoint": dict(raw),
    }


def checkpoint_path(home: Path, session_identity: str) -> Path:
    return (
        state_root(home)
        / "my-second-brain-playground"
        / "recovery"
        / "sessions"
        / f"{session_identity}.json"
    )


def require_private_directory(path: Path) -> None:
    flags = os.O_RDONLY
    if hasattr(os, "O_DIRECTORY"):
        flags |= os.O_DIRECTORY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError:
        reject()
    try:
        information = os.fstat(descriptor)
        if (
            not stat.S_ISDIR(information.st_mode)
            or information.st_uid != os.getuid()
            or information.st_mode & 0o077
        ):
            reject()
    finally:
        os.close(descriptor)


def read_checkpoint(home: Path, vault: Path, session_identity: str, operation: str = "recover") -> Mapping[str, Any]:
    started_ns = time.monotonic_ns()
    observe_lifecycle(operation, "checkpoint-read", "started", journey_identity=session_identity)
    try:
        path = checkpoint_path(home, session_identity)
        require_private_directory(path.parent.parent.parent)
        require_private_directory(path.parent.parent)
        require_private_directory(path.parent)
        raw = parse_json_bytes(read_private_file(path, CHECKPOINT_LIMIT_BYTES), CHECKPOINT_LIMIT_BYTES)
        checkpoint = validate_checkpoint(raw, home, vault, session_identity)
    except BaseException:
        observe_lifecycle(operation, "checkpoint-read", "failed", started_ns, journey_identity=session_identity)
        raise
    observe_lifecycle(
        operation, "checkpoint-read", "succeeded", started_ns,
        journey_identity=checkpoint["sessionIdentity"], ledger_task_identity=checkpoint["taskIdentity"],
    )
    return checkpoint


def validate_hook_event(raw: Any, vault: Path) -> Tuple[str, str]:
    if not isinstance(raw, dict):
        reject()
    if raw.get("hook_event_name") != "SessionStart" or raw.get("source") not in (
        "startup",
        "resume",
        "compact",
    ):
        reject()
    source = raw["source"]
    session_identity = exact_session_identity(raw.get("session_id"))
    raw_cwd = raw.get("cwd")
    if not isinstance(raw_cwd, str) or len(raw_cwd) > 2048 or any(c in raw_cwd for c in "\x00\r\n"):
        reject()
    candidate = Path(raw_cwd)
    if not candidate.is_absolute():
        reject()
    try:
        cwd = candidate.resolve(strict=True)
    except OSError:
        reject()
    if not cwd.is_dir() or not is_within(cwd, vault):
        reject()
    return source, session_identity


def session_context(session_identity: str) -> str:
    return "\n".join(
        (
            "My Second Brain recovery session.",
            f"Session identity: {session_identity}",
            "Use this exact sessionIdentity when writing this session's recovery checkpoint.",
        )
    )


def shell_command(*arguments: str) -> str:
    return shlex.join(arguments)


def control_panel_entries(checkpoint: Mapping[str, Any]) -> Tuple[Tuple[str, str], ...]:
    task_query = (
        "SELECT register_sequence, event_identity, kind, entity_identity "
        "FROM register_events WHERE stream = 'task' AND kind = 'task-accepted' "
        f"AND entity_identity = '{checkpoint['taskIdentity']}' ORDER BY register_sequence;"
    )
    stored = checkpoint["checkpoint"]
    return (
        ("Read playground entry", shell_command("/bin/cat", checkpoint["entry"])),
        ("Read project map", shell_command("/bin/cat", checkpoint["projectMap"])),
        ("Read goal owner", shell_command("/bin/cat", checkpoint["goal"])),
        ("Read evidence owner", shell_command("/bin/cat", checkpoint["evidence"])),
        ("Read recovery guide", shell_command("/bin/cat", checkpoint["recovery"])),
        (
            "Discover Agent Ledger commands",
            shell_command(checkpoint["agentLedger"], "register", "discover"),
        ),
        (
            "Read live Task lifecycle (public Agent Ledger status projection; accepted Task appears in activeTasks while active)",
            shell_command(checkpoint["agentLedger"], "register", "status", "--db", checkpoint["register"]),
        ),
        (
            "Verify accepted Task (diagnostic fallback, read-only; use only while discovery has no public Task read)",
            shell_command("/usr/bin/sqlite3", "-readonly", checkpoint["register"], task_query),
        ),
        (
            "Inspect goal and evidence Git history",
            shell_command(
                "/usr/bin/git",
                "-C",
                checkpoint["vault"],
                "log",
                "--format=%h%x09%ad%x09%s",
                "--date=short",
                "--",
                stored["goalPath"],
                stored["evidencePath"],
            ),
        ),
    )


def additional_context(checkpoint: Mapping[str, Any]) -> str:
    panel = [
        "My Second Brain recovery control panel.",
        "Continue the existing bound work from the goal and current artifact. Reopen workflow skills only when scope changes or workflow guidance is missing.",
        "Run these exact read-only commands as needed. Treat recovered facts as hints; current owners are authoritative.",
    ]
    panel.extend(f"{label}: {command}" for label, command in control_panel_entries(checkpoint))
    panel.extend(
        (
            f"Next safe action: {NEXT_SAFE_ACTION}",
            "Recovered hints:",
            f"Observation: {checkpoint['freshness']} ({checkpoint['observedAt']})",
            f"Session identity: {checkpoint['sessionIdentity']}",
            f"Scope: {checkpoint['scope']}",
            f"Agent Ledger Register: {checkpoint['register']}",
            f"Task identity: {checkpoint['taskIdentity']}",
            f"Program identity: {checkpoint['programIdentity']}",
        )
    )
    return "\n".join(panel)


def emit_json(value: Mapping[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=True, separators=(",", ":")) + "\n")


def run_hook() -> int:
    started_ns = time.monotonic_ns()
    observe_lifecycle("hook", "invocation", "started")
    try:
        event = parse_json_bytes(read_bounded_stdin(INPUT_LIMIT_BYTES), INPUT_LIMIT_BYTES)
        home = home_directory()
        vault = configured_vault(home)
        source, session_identity = validate_hook_event(event, vault)
        observe_lifecycle(
            "hook", "validation", "accepted", started_ns,
            journey_identity=session_identity, observed_worker_identity=session_identity,
            observed_worker_identity_source="hook-payload",
        )
        if source == "compact":
            context = additional_context(read_checkpoint(home, vault, session_identity, "hook"))
        else:
            context = session_context(session_identity)
        emit_json(
            {
                "hookSpecificOutput": {
                    "hookEventName": "SessionStart",
                    "additionalContext": context,
                }
            }
        )
    except (Rejected, OSError, ValueError, TypeError, UnicodeError):
        observe_lifecycle("hook", "terminal", "failed", started_ns)
        return 0
    observe_lifecycle(
        "hook", "terminal", "succeeded", started_ns,
        journey_identity=session_identity, observed_worker_identity=session_identity,
        observed_worker_identity_source="hook-payload",
    )
    return 0


def schema_document() -> Mapping[str, Any]:
    return {
        "schemaVersion": CHECKPOINT_SCHEMA_VERSION,
        "required": list(CHECKPOINT_KEYS),
        "additionalProperties": False,
        "freshForSeconds": FRESH_FOR_SECONDS,
        "futureSkewSeconds": FUTURE_SKEW_SECONDS,
        "identityPattern": IDENTITY_PATTERN.pattern,
        "sessionIdentityPattern": SESSION_IDENTITY_PATTERN.pattern,
        "pathRules": {
            "vaultRoot": "configured canonical absolute playground path",
            "projectMap": "contained project README.md",
            "goalPath": "contained GOAL.md beside the project map",
            "evidencePath": "contained file beside the project map",
            "recoveryPath": "contained recovery guide",
            "agentLedgerExecutable": "canonical absolute regular executable owned by the current user",
            "sessionIdentity": "hook-supplied safe session token for one session-scoped checkpoint",
            "registerPath": "canonical file under the playground XDG Register directory",
        },
        "observedAt": "UTC RFC 3339 timestamp ending in Z",
    }


def run_identity() -> str:
    return RUN_IDENTITY_PREFIX + secrets.token_hex(12)


def command_envelope(
    run_id: str,
    operation: str,
    status: str,
    **members: Any,
) -> Mapping[str, Any]:
    return {
        "schemaVersion": COMMAND_SCHEMA_VERSION,
        "commandIdentity": COMMAND_IDENTITY,
        "runIdentity": run_id,
        "operation": operation,
        "status": status,
        **members,
    }


def failure_envelope(
    run_id: str,
    operation: str,
    code: str,
    transaction_state: str,
    action: str,
    error_family: str,
    repair_action: str,
    safe_to_retry_same_input: bool,
) -> Mapping[str, Any]:
    return command_envelope(
        run_id,
        operation,
        "error",
        transactionState=transaction_state,
        error={
            "code": code,
            "action": action,
            "errorFamily": error_family,
            "repairAction": repair_action,
            "safeToRetrySameInput": safe_to_retry_same_input,
        },
    )


def help_document() -> Mapping[str, Any]:
    return {
        "usage": "recovery-checkpoint [--help|-h|schema|write|bind|recover]",
        "session": "Use CODEX_SESSION_ID, or --session with the Claude startup hook identity. Conflicting values are refused.",
        "commands": [
            {
                "name": "bind",
                "description": "Bind an unbound session or refresh its same work owner from GOAL.md; refuse a different saved owner.",
                "usage": "bind <vault-relative-GOAL.md> --agent-ledger <absolute-executable> [--session <id>] [--evidence <vault-relative-file>]",
            },
            {
                "name": "recover",
                "description": "Return this session's verified control panel without writes or command execution.",
                "usage": "recover [--session <id>]",
            },
            {
                "name": "schema",
                "description": "Print the accepted checkpoint field contract.",
            },
            {
                "name": "write",
                "description": "Validate one checkpoint JSON object from stdin and atomically write its session file.",
            },
        ],
    }


def secure_directory(path: Path) -> None:
    path.mkdir(mode=0o700, exist_ok=True)
    os.chmod(path, 0o700)
    flags = os.O_RDONLY
    if hasattr(os, "O_DIRECTORY"):
        flags |= os.O_DIRECTORY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        information = os.fstat(descriptor)
        if (
            not stat.S_ISDIR(information.st_mode)
            or information.st_uid != os.getuid()
            or information.st_mode & 0o077
        ):
            raise OSError("checkpoint state directory is not private")
    finally:
        os.close(descriptor)


class CheckpointOwnershipConflict(Exception):
    """An implicit bind cannot replace the saved work owner."""


def write_checkpoint(run_id: str, raw_input: Optional[Mapping[str, Any]] = None, operation: str = "write") -> int:
    replaced = False
    lock_descriptor = -1
    started_ns = time.monotonic_ns()
    inherited_parent_identity = os.environ.get("CODEX_SESSION_ID")
    observe_lifecycle(operation, "checkpoint-write", "started", inherited_parent_identity=inherited_parent_identity)
    try:
        raw = raw_input
        if raw is None:
            raw = parse_json_bytes(read_bounded_stdin(CHECKPOINT_LIMIT_BYTES), CHECKPOINT_LIMIT_BYTES)
        home = home_directory()
        vault = configured_vault(home)
        validated = validate_checkpoint(raw, home, vault)
        target = checkpoint_path(home, validated["sessionIdentity"])
        observe_lifecycle(
            operation, "validation", "accepted", started_ns,
            journey_identity=validated["sessionIdentity"], inherited_parent_identity=inherited_parent_identity,
            ledger_task_identity=validated["taskIdentity"],
        )
        target.parent.parent.parent.parent.mkdir(parents=True, exist_ok=True)
        secure_directory(target.parent.parent.parent)
        secure_directory(target.parent.parent)
        secure_directory(target.parent)
        lock_flags = os.O_RDWR | os.O_CREAT
        if hasattr(os, "O_NOFOLLOW"):
            lock_flags |= os.O_NOFOLLOW
        lock_descriptor = os.open(target.with_suffix(".lock"), lock_flags, 0o600)
        lock_info = os.fstat(lock_descriptor)
        if (not stat.S_ISREG(lock_info.st_mode) or lock_info.st_uid != os.getuid()
                or lock_info.st_mode & 0o077 or lock_info.st_nlink != 1):
            raise OSError("checkpoint lock is not private")
        fcntl.flock(lock_descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        observe_lifecycle(
            operation, "lock", "accepted", started_ns,
            journey_identity=validated["sessionIdentity"], inherited_parent_identity=inherited_parent_identity,
            ledger_task_identity=validated["taskIdentity"],
        )
        if operation == "bind":
            try:
                target.lstat()
                previous_bytes = read_private_file(target, CHECKPOINT_LIMIT_BYTES)
            except FileNotFoundError:
                previous_bytes = None
            except (Rejected, OSError):
                raise CheckpointOwnershipConflict()
            if previous_bytes is not None:
                try:
                    previous = validate_checkpoint(
                        parse_json_bytes(previous_bytes, CHECKPOINT_LIMIT_BYTES), home, vault
                    )["checkpoint"]
                    owner_fields = ("vaultRoot", "registerPath", "programIdentity", "taskIdentity", "sessionIdentity")
                    if any(previous[field] != validated["checkpoint"][field] for field in owner_fields):
                        raise CheckpointOwnershipConflict()
                except (Rejected, OSError, ValueError, TypeError, UnicodeError):
                    raise CheckpointOwnershipConflict()
        temporary = target.parent / (".current." + secrets.token_hex(12) + ".tmp")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(temporary, flags, 0o600)
        try:
            contents = json.dumps(validated["checkpoint"], ensure_ascii=True, separators=(",", ":")) + "\n"
            with os.fdopen(descriptor, "w", encoding="utf-8", closefd=True) as output:
                descriptor = -1
                output.write(contents)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, target)
            replaced = True
            os.chmod(target, 0o600)
            directory_fd = os.open(target.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
        emit_json(
            command_envelope(
                run_id,
                operation,
                "success",
                transactionState="committed",
                data={
                    "code": "CHECKPOINT_WRITTEN",
                    "checkpointPath": str(target),
                    "sessionIdentity": validated["sessionIdentity"],
                    "taskIdentity": validated["taskIdentity"],
                    "controlPanel": additional_context(validated),
                },
            )
        )
        observe_lifecycle(
            operation, "checkpoint-write", "succeeded", started_ns,
            journey_identity=validated["sessionIdentity"], inherited_parent_identity=inherited_parent_identity,
            ledger_task_identity=validated["taskIdentity"],
        )
        return 0
    except CheckpointOwnershipConflict:
        observe_lifecycle(operation, "lock", "conflict", started_ns, inherited_parent_identity=inherited_parent_identity)
        emit_json(failure_envelope(
            run_id, operation, "CHECKPOINT_OWNERSHIP_CONFLICT", "not-started",
            "VERIFY_SESSION_OWNER", "ownership",
            "Preserve the saved checkpoint and verify your actual harness session identity. "
            "An inherited session identity is not worker ownership. For a deliberate same-session "
            "work change, verify ownership and use the explicit write contract from --help.", False))
        return 1
    except BlockingIOError:
        observe_lifecycle(operation, "lock", "busy", started_ns, inherited_parent_identity=inherited_parent_identity)
        emit_json(failure_envelope(
            run_id, operation, "CHECKPOINT_BUSY", "not-started", "WAIT_FOR_WRITER", "ownership",
            "Another checkpoint writer owns this session. Wait for it to finish, inspect the saved owner, "
            "then retry only within your session and Task scope.", operation == "bind"))
        return 1
    except Rejected:
        observe_lifecycle(operation, "validation", "refused", started_ns, inherited_parent_identity=inherited_parent_identity, refusal_code="INVALID_CHECKPOINT")
        emit_json(
            failure_envelope(
                run_id,
                operation,
                "INVALID_CHECKPOINT",
                "not-started",
                "CORRECT_INPUT",
                "validation",
                CHECKPOINT_REPAIR_ACTION,
                False,
            )
        )
        return 1
    except (OSError, ValueError, TypeError, UnicodeError):
        observe_lifecycle(operation, "checkpoint-write", "uncertain" if replaced else "failed", started_ns, inherited_parent_identity=inherited_parent_identity)
        if replaced:
            envelope = failure_envelope(
                run_id,
                operation,
                "CHECKPOINT_WRITE_UNCERTAIN",
                "unknown",
                "VERIFY_AND_RETRY",
                "uncertain-write",
                UNCERTAIN_REPAIR_ACTION,
                True,
            )
        else:
            envelope = failure_envelope(
                run_id,
                operation,
                "CHECKPOINT_WRITE_FAILED",
                "not-started",
                "REPAIR_STATE_PATH",
                "filesystem",
                WRITE_REPAIR_ACTION,
                True,
            )
        emit_json(envelope)
        return 1
    finally:
        if lock_descriptor >= 0:
            os.close(lock_descriptor)


def selected_session(options: Mapping[str, str]) -> str:
    supplied = options.get("--session")
    harness = os.environ.get("CODEX_SESSION_ID")
    if supplied and harness and supplied != harness:
        reject()
    return exact_session_identity(supplied or harness)


def parse_options(arguments: list[str], permitted: Tuple[str, ...]) -> Mapping[str, str]:
    if len(arguments) % 2:
        reject()
    options: Dict[str, str] = {}
    for index in range(0, len(arguments), 2):
        key, value = arguments[index:index + 2]
        if key not in permitted or key in options or not value:
            reject()
        options[key] = value
    return options


def goal_value(text: str, label: str) -> str:
    matches = re.findall(r"^\s*-\s*" + re.escape(label) + r":\s*`([^`]+)`\.?\s*$", text, re.MULTILINE)
    if len(matches) != 1:
        reject()
    return matches[0]


def run_session_command(run_id: str, operation: str, arguments: list[str]) -> int:
    try:
        home = home_directory()
        vault = configured_vault(home)
        if operation == "recover":
            options = parse_options(arguments, ("--session",))
            checkpoint = read_checkpoint(home, vault, selected_session(options))
            emit_json(command_envelope(run_id, operation, "success", transactionState="not-applicable", data={
                "sessionIdentity": checkpoint["sessionIdentity"],
                "taskIdentity": checkpoint["taskIdentity"],
                "controlPanel": additional_context(checkpoint),
            }))
            return 0
        if not arguments:
            reject()
        options = parse_options(arguments[1:], ("--agent-ledger", "--session", "--evidence"))
        goal = contained_file(vault, arguments[0], "GOAL.md")
        text = read_bounded_file(goal, MARKDOWN_LIMIT_BYTES).decode("utf-8", errors="strict")
        project = goal.parent.relative_to(vault).as_posix()
        checkpoint = {
            "schemaVersion": CHECKPOINT_SCHEMA_VERSION,
            "vaultRoot": str(vault),
            "projectMap": project + "/README.md",
            "goalPath": goal.relative_to(vault).as_posix(),
            "evidencePath": options.get("--evidence", project + "/proof.md"),
            "recoveryPath": "docs/agents/recovery.md",
            "agentLedgerExecutable": options.get("--agent-ledger"),
            "sessionIdentity": selected_session(options),
            "registerPath": goal_value(text, "Register"),
            "taskIdentity": goal_value(text, "Task"),
            "programIdentity": goal_value(text, "Program"),
            "scope": goal.parent.name,
            "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        return write_checkpoint(run_id, checkpoint, operation)
    except (Rejected, OSError, ValueError, TypeError, UnicodeError):
        emit_json(failure_envelope(run_id, operation, "RECOVERY_CONTEXT_UNAVAILABLE", "not-started",
            "CHECK_OWNERS", "validation",
            "Check the configured vault, one Task/Register/Program binding in GOAL.md, and this harness session identity. "
            "Use bind with --agent-ledger to save this session; recover reads only its existing checkpoint. See --help.", False))
        return 1


def run_checkpoint(arguments: list[str]) -> int:
    run_id = run_identity()
    if arguments in ([], ["--help"], ["-h"]):
        emit_json(command_envelope(run_id, "help", "success", data=help_document()))
        return 0
    if arguments == ["schema"]:
        emit_json(command_envelope(run_id, "schema", "success", data=schema_document()))
        return 0
    if arguments == ["write"]:
        return write_checkpoint(run_id)
    if arguments and arguments[0] in ("bind", "recover"):
        return run_session_command(run_id, arguments[0], arguments[1:])
    emit_json(
        failure_envelope(
            run_id,
            "usage",
            "USAGE",
            "not-started",
            "READ_HELP",
            "usage",
            USAGE_REPAIR_ACTION,
            False,
        )
    )
    return 2


def main(arguments: list[str]) -> int:
    if arguments == ["hook"]:
        return run_hook()
    if arguments and arguments[0] == "checkpoint":
        return run_checkpoint(arguments[1:])
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
