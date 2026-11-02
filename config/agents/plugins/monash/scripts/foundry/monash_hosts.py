"""Validated host-profile registry for Monash Foundry transports."""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path, PurePosixPath
import posixpath
import re
from typing import Any, Literal, Mapping


PROFILE_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
SSH_ALIAS_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
HERDR_SESSION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class HostProfileError(ValueError):
    """A stable refusal raised while reading or resolving host profiles."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class PathMapping:
    """One component-aware mapping from a local cwd to a remote cwd."""

    local_prefix: PurePosixPath
    remote_prefix: PurePosixPath


@dataclass(frozen=True)
class HostProfile:
    """A sealed local or SSH execution profile."""

    profile_id: str
    transport: Literal["local", "ssh"]
    ssh_alias: str | None = None
    herdr_session: str | None = None
    remote_install_root: PurePosixPath | None = None
    herdr_executable: PurePosixPath | None = None
    path_mappings: tuple[PathMapping, ...] = ()

    @property
    def foundry_executable(self) -> PurePosixPath | None:
        """Return the installed Foundry launcher, never a Herdr path."""
        if self.remote_install_root is None:
            return None
        return self.remote_install_root / "monash-foundry"


@dataclass(frozen=True)
class RemoteCwdRequest:
    """A normalized requested remote cwd; the adapter verifies its existence."""

    remote_cwd: PurePosixPath
    source: Literal["explicit_remote_cwd", "path_mapping"]


def _normalized_absolute_posix(value: object, field: str) -> PurePosixPath:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise HostProfileError("invalid_host_profile", f"{field} must be a non-empty absolute POSIX path")
    path = PurePosixPath(value)
    if not path.is_absolute():
        raise HostProfileError("invalid_host_profile", f"{field} must be an absolute POSIX path")
    return PurePosixPath(posixpath.normpath(str(path)))


def _normalised_local_path(value: Path) -> PurePosixPath:
    if not value.is_absolute():
        raise HostProfileError("invalid_cwd", "local cwd must be absolute")
    return PurePosixPath(posixpath.normpath(value.as_posix()))


def _as_mapping(value: object, field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise HostProfileError("invalid_host_profile", f"{field} must be an object")
    return value


class HostProfileRegistry:
    """Loads named profiles and performs policy-only remote cwd resolution."""

    def __init__(self, profiles: Mapping[str, HostProfile]):
        self._profiles = dict(profiles)

    @classmethod
    def load(cls, config_path: Path) -> "HostProfileRegistry":
        try:
            value = json.loads(config_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError) as error:
            raise HostProfileError("host_profiles_unreadable", "host profile configuration could not be read") from error
        except json.JSONDecodeError as error:
            raise HostProfileError("host_profiles_invalid_json", "host profile configuration is not valid JSON") from error
        if not isinstance(value, Mapping):
            raise HostProfileError("invalid_host_profiles", "configuration root must be an object")
        raw_profiles = value.get("host_profiles", {})
        if not isinstance(raw_profiles, Mapping):
            raise HostProfileError("invalid_host_profiles", "host_profiles must be an object when configured")
        return cls({profile_id: cls._parse_profile(profile_id, raw) for profile_id, raw in raw_profiles.items()})

    @staticmethod
    def _parse_profile(profile_id: object, raw: object) -> HostProfile:
        if not isinstance(profile_id, str) or not PROFILE_ID_PATTERN.fullmatch(profile_id):
            raise HostProfileError("invalid_host_profile", "host profile IDs must be lowercase identifiers")
        profile = _as_mapping(raw, f"host_profiles.{profile_id}")
        transport = profile.get("transport")
        if not isinstance(transport, str) or transport not in {"local", "ssh"}:
            raise HostProfileError("invalid_host_profile", f"host profile {profile_id} must declare transport local or ssh")
        if transport == "local":
            unexpected = set(profile) - {"transport"}
            if unexpected:
                raise HostProfileError("invalid_host_profile", f"local host profile {profile_id} has remote-only fields")
            return HostProfile(profile_id=profile_id, transport="local")

        allowed = {
            "transport", "ssh_alias", "herdr_session", "remote_install_root", "herdr_executable", "path_mappings",
        }
        unexpected = set(profile) - allowed
        if unexpected:
            raise HostProfileError("invalid_host_profile", f"SSH host profile {profile_id} has unsupported fields")
        ssh_alias = profile.get("ssh_alias")
        herdr_session = profile.get("herdr_session")
        if not isinstance(ssh_alias, str) or not SSH_ALIAS_PATTERN.fullmatch(ssh_alias):
            raise HostProfileError("invalid_host_profile", f"SSH host profile {profile_id} has an invalid ssh_alias")
        if not isinstance(herdr_session, str) or not HERDR_SESSION_PATTERN.fullmatch(herdr_session):
            raise HostProfileError("invalid_host_profile", f"SSH host profile {profile_id} has an invalid herdr_session")
        raw_mappings = profile.get("path_mappings")
        if not isinstance(raw_mappings, list):
            raise HostProfileError("invalid_host_profile", f"SSH host profile {profile_id} requires path_mappings")
        mappings: list[PathMapping] = []
        for index, raw_mapping in enumerate(raw_mappings):
            mapping = _as_mapping(raw_mapping, f"path_mappings[{index}]")
            if set(mapping) != {"local_prefix", "remote_prefix"}:
                raise HostProfileError("invalid_host_profile", f"path_mappings[{index}] must contain local_prefix and remote_prefix")
            mappings.append(PathMapping(
                local_prefix=_normalized_absolute_posix(mapping["local_prefix"], f"path_mappings[{index}].local_prefix"),
                remote_prefix=_normalized_absolute_posix(mapping["remote_prefix"], f"path_mappings[{index}].remote_prefix"),
            ))
        return HostProfile(
            profile_id=profile_id,
            transport="ssh",
            ssh_alias=ssh_alias,
            herdr_session=herdr_session,
            remote_install_root=_normalized_absolute_posix(profile.get("remote_install_root"), "remote_install_root"),
            herdr_executable=_normalized_absolute_posix(profile.get("herdr_executable"), "herdr_executable"),
            path_mappings=tuple(mappings),
        )

    def list_profiles(self) -> tuple[HostProfile, ...]:
        return tuple(self._profiles[profile_id] for profile_id in sorted(self._profiles))

    def get(self, profile_id: str) -> HostProfile:
        try:
            return self._profiles[profile_id]
        except KeyError as error:
            raise HostProfileError("unknown_host_profile", f"host profile {profile_id!r} is not configured") from error

    def resolve_remote_cwd(
        self, profile_id: str, local_cwd: Path, explicit_remote_cwd: str | None = None,
    ) -> RemoteCwdRequest:
        profile = self.get(profile_id)
        if profile.transport != "ssh":
            raise HostProfileError("remote_cwd_not_applicable", f"host profile {profile_id} does not use SSH")
        if explicit_remote_cwd is not None:
            return RemoteCwdRequest(
                remote_cwd=_normalized_absolute_posix(explicit_remote_cwd, "explicit_remote_cwd"),
                source="explicit_remote_cwd",
            )
        requested = _normalised_local_path(local_cwd)
        candidates = [
            mapping for mapping in profile.path_mappings
            if requested == mapping.local_prefix or mapping.local_prefix in requested.parents
        ]
        if not candidates:
            raise HostProfileError("remote_cwd_unavailable", f"host profile {profile_id} has no mapping for {requested}")
        greatest_depth = max(len(candidate.local_prefix.parts) for candidate in candidates)
        deepest = [candidate for candidate in candidates if len(candidate.local_prefix.parts) == greatest_depth]
        if len(deepest) != 1:
            raise HostProfileError(
                "remote_cwd_ambiguous",
                f"host profile {profile_id} has multiple equally specific mappings for {requested}",
            )
        mapping = deepest[0]
        relative = requested.relative_to(mapping.local_prefix)
        return RemoteCwdRequest(remote_cwd=mapping.remote_prefix / relative, source="path_mapping")
