"""Focused contract tests for the sealed Monash host-profile registry."""

from __future__ import annotations

import json
from pathlib import Path, PurePosixPath
import sys
import tempfile
import unittest


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from monash_hosts import HostProfileError, HostProfileRegistry  # noqa: E402


VALID_PROFILES = {
    "laptop": {"transport": "local"},
    "mini": {
        "transport": "ssh",
        "ssh_alias": "mac-mini",
        "herdr_session": "monash-foundry",
        "remote_install_root": "/Users/server/.local/share/monash-foundry",
        "herdr_executable": "/opt/homebrew/bin/herdr",
        "path_mappings": [
            {"local_prefix": "/Users/nathanvale/code", "remote_prefix": "/Users/server/code"},
            {"local_prefix": "/Users/nathanvale/code/dotfiles", "remote_prefix": "/Users/server/code/dotfiles"},
        ],
    },
}


class HostProfileRegistryTests(unittest.TestCase):
    def write_config(self, profiles: object) -> Path:
        temporary = tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json", delete=False)
        self.addCleanup(lambda: Path(temporary.name).unlink(missing_ok=True))
        with temporary:
            json.dump({"host_profiles": profiles}, temporary)
        return Path(temporary.name)

    def write_raw_config(self, value: object) -> Path:
        temporary = tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json", delete=False)
        self.addCleanup(lambda: Path(temporary.name).unlink(missing_ok=True))
        with temporary:
            json.dump(value, temporary)
        return Path(temporary.name)

    def load(self, profiles: object = VALID_PROFILES) -> HostProfileRegistry:
        return HostProfileRegistry.load(self.write_config(profiles))

    def assert_refusal(self, code: str, action: object) -> None:
        with self.assertRaises(HostProfileError) as caught:
            action()  # type: ignore[operator]
        self.assertEqual(code, caught.exception.code)

    def test_loads_local_profile_without_remote_fields(self) -> None:
        profile = self.load().get("laptop")
        self.assertEqual("local", profile.transport)
        self.assertIsNone(profile.ssh_alias)
        self.assertIsNone(profile.foundry_executable)

    def test_loads_independent_ssh_and_foundry_executables(self) -> None:
        profile = self.load().get("mini")
        self.assertEqual(PurePosixPath("/opt/homebrew/bin/herdr"), profile.herdr_executable)
        self.assertEqual(PurePosixPath("/Users/server/.local/share/monash-foundry/monash-foundry"), profile.foundry_executable)

    def test_lists_profiles_by_stable_profile_id(self) -> None:
        self.assertEqual(("laptop", "mini"), tuple(profile.profile_id for profile in self.load().list_profiles()))

    def test_allows_absent_host_profiles_and_refuses_unknown_profile(self) -> None:
        registry = HostProfileRegistry.load(self.write_raw_config({"tenant": "existing-model-config"}))
        self.assertEqual((), registry.list_profiles())
        self.assert_refusal("unknown_host_profile", lambda: registry.get("unknown"))

    def test_refuses_remote_fields_on_local_transport(self) -> None:
        profiles = {"laptop": {"transport": "local", "ssh_alias": "mac-mini"}}
        self.assert_refusal("invalid_host_profile", lambda: self.load(profiles))

    def test_refuses_ssh_profile_without_herdr_executable(self) -> None:
        profiles = json.loads(json.dumps(VALID_PROFILES))
        del profiles["mini"]["herdr_executable"]
        self.assert_refusal("invalid_host_profile", lambda: self.load(profiles))

    def test_refuses_relative_herdr_executable(self) -> None:
        profiles = json.loads(json.dumps(VALID_PROFILES))
        profiles["mini"]["herdr_executable"] = "bin/herdr"
        self.assert_refusal("invalid_host_profile", lambda: self.load(profiles))

    def test_refuses_unreadable_unicode_configuration(self) -> None:
        temporary = tempfile.NamedTemporaryFile("wb", suffix=".json", delete=False)
        self.addCleanup(lambda: Path(temporary.name).unlink(missing_ok=True))
        with temporary:
            temporary.write(b'\xff')
        self.assert_refusal("host_profiles_unreadable", lambda: HostProfileRegistry.load(Path(temporary.name)))

    def test_refuses_non_string_transport(self) -> None:
        profiles = {"mini": {"transport": ["ssh"]}}
        self.assert_refusal("invalid_host_profile", lambda: self.load(profiles))

    def test_explicit_remote_cwd_normalizes_and_bypasses_mappings(self) -> None:
        result = self.load().resolve_remote_cwd("mini", Path("/unmapped/project"), "/srv/work/../project")
        self.assertEqual(PurePosixPath("/srv/project"), result.remote_cwd)
        self.assertEqual("explicit_remote_cwd", result.source)

    def test_resolves_most_specific_component_aware_mapping(self) -> None:
        result = self.load().resolve_remote_cwd("mini", Path("/Users/nathanvale/code/dotfiles/config"))
        self.assertEqual(PurePosixPath("/Users/server/code/dotfiles/config"), result.remote_cwd)
        self.assertEqual("path_mapping", result.source)

    def test_refuses_equally_specific_duplicate_mappings(self) -> None:
        profiles = json.loads(json.dumps(VALID_PROFILES))
        profiles["mini"]["path_mappings"].append(
            {"local_prefix": "/Users/nathanvale/code", "remote_prefix": "/srv/another-code"}
        )
        registry = self.load(profiles)
        self.assert_refusal(
            "remote_cwd_ambiguous",
            lambda: registry.resolve_remote_cwd("mini", Path("/Users/nathanvale/code/project")),
        )

    def test_allows_empty_mappings_only_for_explicit_remote_cwd(self) -> None:
        profiles = json.loads(json.dumps(VALID_PROFILES))
        profiles["mini"]["path_mappings"] = []
        registry = self.load(profiles)
        explicit = registry.resolve_remote_cwd("mini", Path("/unmapped/project"), "/srv/project")
        self.assertEqual(PurePosixPath("/srv/project"), explicit.remote_cwd)
        self.assert_refusal(
            "remote_cwd_unavailable",
            lambda: registry.resolve_remote_cwd("mini", Path("/unmapped/project")),
        )

    def test_refuses_unmatched_local_cwd(self) -> None:
        registry = self.load()
        self.assert_refusal("remote_cwd_unavailable", lambda: registry.resolve_remote_cwd("mini", Path("/Users/nathanvale/codex")))


if __name__ == "__main__":
    unittest.main()
