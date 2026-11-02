"""Public-process proof for the Monash model inventory and selection contract.

The catalogue below is test-owned.  Do not import production inventory values
into this file: the subprocess output is the observed result.

Run:
    python3 -m unittest discover -s scripts/foundry -p 'test_model_selection.py' -v
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


LAUNCHER = Path(__file__).with_name("monash-foundry")

GPT_RESOURCE = "monash-edu-esol-smst-ai-dev-gpt"
GPT_RESOURCE_GROUP = "monash-edu-esol-smst-ai-dev"
CLAUDE_RESOURCE = "monash-edu-smst-ai-claude-code"
CLAUDE_RESOURCE_GROUP = "monash-edu-smst-smstai-degreeworks-scribe"

# Independent oracle from scripts/foundry/README.md and MM-2.  The two Nano
# deployment spellings are deliberately separate literal values.
EXPECTED_MODELS = {
    "gpt-5.5": {
        "format": "OpenAI",
        "bindings": (("gpt", "gpt-5.5", "azure-openai-responses"),
                     ("claude", "gpt-5.5", "unverified")),
    },
    "gpt-5.4-nano": {
        "format": "OpenAI",
        "bindings": (("gpt", "gpt-5.4-nano", "azure-openai-responses"),
                     ("claude", "gpt-5-4-nano", "unverified")),
    },
    "claude-sonnet-5": {
        "format": "Anthropic",
        "bindings": (("gpt", "claude-sonnet-5", "unverified"),
                     ("claude", "claude-sonnet-5", "azure-anthropic-messages")),
    },
    "claude-sonnet-4.6": {
        "format": "Anthropic",
        "bindings": (("gpt", "claude-sonnet-4-6", "unverified"),
                     ("claude", "claude-sonnet-4-6", "azure-anthropic-messages")),
    },
    "claude-haiku-4.5": {
        "format": "Anthropic",
        "bindings": (("gpt", "claude-haiku-4-5", "unverified"),
                     ("claude", "claude-haiku-4-5", "azure-anthropic-messages")),
    },
    "deepseek-v4-pro": {
        "format": "DeepSeek",
        "bindings": (("gpt", "DeepSeek-V4-Pro", "unverified"),
                     ("claude", "DeepSeek-V4-Pro", "unverified")),
    },
    "deepseek-v4-flash": {
        "format": "DeepSeek",
        "bindings": (("gpt", "DeepSeek-V4-Flash", "unverified"),
                     ("claude", "DeepSeek-V4-Flash", "unverified")),
    },
    "kimi-k2.7-code": {
        "format": "MoonshotAI",
        "bindings": (("gpt", "Kimi-K2.7-Code", "unverified"),
                     ("claude", "Kimi-K2.7-Code", "unverified")),
    },
    "kimi-k2.6": {
        "format": "MoonshotAI",
        "bindings": (("claude", "Kimi-K2.6", "unverified"),),
    },
    # Independent oracle: `az cognitiveservices account deployment list` on the
    # GPT resource, 2026-11-01: name gpt-6.1-sol, format OpenAI, version
    # 2026-09-29, Succeeded. It is not deployed on the Claude resource.
    "gpt-6.1-sol": {
        "format": "OpenAI",
        "bindings": (("gpt", "gpt-6.1-sol", "azure-openai-responses"),),
    },
}

# Independent oracle: supported_reasoning_levels in Codex's own model catalogue
# (`codex debug models --bundled`, Codex 0.165.0, and upstream rust-v0.165.0).
SOL_REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"]

# Independent oracle for the pinned Codex metadata. Each hash is SHA-256 of one
# upstream ModelInfo entry as UTF-8 JSON with sorted keys, compact separators and
# ensure_ascii=False. Sol is the entry in openai/codex rust-v0.165.0 models.json,
# fetched and hashed independently by the FLS1 reviewer; GPT-5.5 is the entry in
# rust-v0.153.4. Do not recompute these from codex-models.json in this file.
SOL_ENTRY_SHA256 = "9507d348e208b173517aef415de72be5ba1077645c77a38ab1e3f2892313eade"
GPT55_ENTRY_SHA256 = "a5a8e5f89244af1af6ea3385ab1e62d625f7e155d31286a86451e309d508d04a"
# Literal fields that differ between Sol's real entry and a GPT-5.5 clone with
# only the slug and effort list replaced.
SOL_DISTINGUISHING_FIELDS = {
    "display_name": "GPT-6.1-Sol",
    "tool_mode": "code_mode_only",
    "use_responses_lite": True,
    "multi_agent_reasoning_effort": "xhigh",
    "default_reasoning_level": "low",
    "base_instructions": None,
    "max_context_window": 872000,
}

EXPECTED_RESOURCES = {
    "gpt": (GPT_RESOURCE, GPT_RESOURCE_GROUP),
    "claude": (CLAUDE_RESOURCE, CLAUDE_RESOURCE_GROUP),
}


def inventory_input() -> dict[str, object]:
    """Fixture-only config input, distinct from subprocess result assertions."""

    implemented = {
        ("gpt-5.5", "codex"): "gpt",
        ("gpt-6.1-sol", "codex"): "gpt",
        ("claude-sonnet-5", "claude"): "claude",
        ("claude-sonnet-4.6", "claude"): "claude",
        ("claude-haiku-4.5", "claude"): "claude",
    }
    models = []
    for model_id, expected in EXPECTED_MODELS.items():
        bindings = [
            {
                "resource_id": resource_id,
                "deployment": deployment,
                "protocol": protocol,
                "model_format": expected["format"],
                "availability": "available",
                "provisioning_state": "Succeeded",
                "observed": True,
                "reason": None,
            }
            for resource_id, deployment, protocol in expected["bindings"]
        ]
        routes = []
        for agent in ("codex", "claude"):
            binding_resource_id = implemented.get((model_id, agent))
            routes.append({
                "agent": agent,
                "status": "untested",
                "implemented": binding_resource_id is not None,
                "compatibility": "compatible" if binding_resource_id else "incompatible",
                "binding_resource_id": binding_resource_id,
                "reason": "synthetic selection fixture",
                "evidence": [],
            })
        models.append({
            "id": model_id,
            "display_name": f"Synthetic {model_id}",
            "availability": "available",
            "bindings": bindings,
            "routes": routes,
        })
    return {
        "schema_version": 1,
        "snapshot_observed_at": "2026-09-09T00:00:00Z",
        "snapshot_source": "synthetic-public-process-fixture",
        "resources": [
            {
                "id": resource_id,
                "resource": resource,
                "resource_group": group,
                "availability": "available",
                "observed": True,
                "error": None,
            }
            for resource_id, (resource, group) in EXPECTED_RESOURCES.items()
        ],
        "models": models,
    }


OBSERVED_ENV = (
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
    "ANTHROPIC_FOUNDRY_RESOURCE", "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "CLAUDE_CODE_USE_FOUNDRY", "OPENAI_API_KEY", "OPENAI_BASE_URL",
    "AZURE_OPENAI_API_KEY", "CODEX_HOME", "OP_SERVICE_ACCOUNT_TOKEN",
)


class ModelSelectionProcessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="foundry selection test ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.child_capture = self.root / "native-child.json"
        self.wrapper_capture = self.root / "credential-wrapper.json"
        self.az_capture = self.root / "azure-cli.jsonl"
        self.az_environment_capture = self.root / "azure-cli-env.jsonl"
        self.exit_control = self.root / "native-exit"
        self.az_failure = self.root / "azure-failure"
        self.az_format_mismatch = self.root / "azure-format-mismatch"

        self.native = self.script("native-agent", f'''\
import json, os, sys
from pathlib import Path
# Like Claude: a --settings value that is not JSON is a path read by position.
settings_text = None
if "--settings" in sys.argv:
    value = sys.argv[sys.argv.index("--settings") + 1]
    if not value.startswith("{{"):
        fd = os.open(value, os.O_RDONLY)
        try:
            settings_text = os.pread(fd, 1048577, 0).decode()
        finally:
            os.close(fd)
Path({str(self.child_capture)!r}).write_text(json.dumps({{
    "argv": sys.argv[1:],
    "settings_text": settings_text,
    "cwd": os.getcwd(),
    "home": os.environ.get("HOME"),
    "env": {{key: os.environ[key] for key in {OBSERVED_ENV!r} if key in os.environ}},
}}))
control = Path({str(self.exit_control)!r})
raise SystemExit(int(control.read_text()) if control.exists() else 0)
''')
        self.wrapper = self.script("credential-wrapper", f'''\
import json, os, sys
from pathlib import Path
Path({str(self.wrapper_capture)!r}).write_text(json.dumps(sys.argv[1:]))
if len(sys.argv) < 6 or sys.argv[1] != "inject" or sys.argv[4] != "--":
    raise SystemExit(8)
child_env = {{key: os.environ[key] for key in ("HOME", "PATH", "LANG", "LC_ALL", "TMPDIR") if key in os.environ}}
child_env[sys.argv[2]] = "synthetic-child-key"
os.execvpe(sys.argv[5], sys.argv[5:], child_env)
''')
        self.az = self.script("azure-cli", f'''\
import json, os, sys
from pathlib import Path
capture = Path(os.environ["FOUNDRY_SELECTION_AZ_CAPTURE"])
with capture.open("a") as stream:
    stream.write(json.dumps(sys.argv[1:]) + "\\n")
environment_capture = Path(os.environ["FOUNDRY_SELECTION_AZ_ENV_CAPTURE"])
with environment_capture.open("a") as stream:
    stream.write(json.dumps({{"AZURE_CONFIG_DIR": os.environ.get("AZURE_CONFIG_DIR")}}) + "\\n")
if Path({str(self.az_failure)!r}).exists() and "deployment" in sys.argv:
    print("synthetic deployment listing failure", file=sys.stderr)
    raise SystemExit(1)
if "account" in sys.argv and "show" in sys.argv:
    print(json.dumps({{
        "name": "test-subscription", "id": "test-subscription-id",
        "tenantId": "test-tenant-id", "state": "Enabled", "isDefault": True,
    }}))
    raise SystemExit(0)
resource = "{GPT_RESOURCE}" if "{GPT_RESOURCE}" in sys.argv else "{CLAUDE_RESOURCE}"
deployments = {{
    "{GPT_RESOURCE}": [
        ("gpt-5.5", "OpenAI"), ("gpt-5.4-nano", "OpenAI"),
        ("claude-sonnet-5", "Anthropic"), ("claude-sonnet-4-6", "Anthropic"),
        ("claude-haiku-4-5", "Anthropic"), ("DeepSeek-V4-Pro", "DeepSeek"),
        ("DeepSeek-V4-Flash", "DeepSeek"), ("Kimi-K2.7-Code", "MoonshotAI"),
        ("gpt-6.1-sol", "OpenAI"),
    ],
    "{CLAUDE_RESOURCE}": [
        ("gpt-5.5", "OpenAI"), ("gpt-5-4-nano", "OpenAI"),
        ("claude-sonnet-5", "Anthropic"), ("claude-sonnet-4-6", "Anthropic"),
        ("claude-haiku-4-5", "Anthropic"), ("DeepSeek-V4-Pro", "DeepSeek"),
        ("DeepSeek-V4-Flash", "DeepSeek"), ("Kimi-K2.7-Code", "MoonshotAI"),
        ("Kimi-K2.6", "MoonshotAI"),
    ],
}}
print(json.dumps([{{"name": name, "properties": {{"provisioningState": "Succeeded", "model": {{
    "format": "Anthropic" if Path({str(self.az_format_mismatch)!r}).exists() and name == "gpt-5.5" else fmt
}}}}}}
                  for name, fmt in deployments[resource]]))
''')

        # This is fixture setup only.  Expected results above do not derive
        # from this input config.
        self.config_file = self.root / "config.json"
        self.config_file.write_text(json.dumps({
            "tenant": "test-tenant-id",
            "subscription": "test-subscription",
            "codex": {
                "base_url": f"https://{GPT_RESOURCE}.openai.azure.com/openai/v1",
                "deployment": "gpt-5.5",
                "credential_ref": "op://synthetic/credential",
            },
            "claude": {
                "resource": CLAUDE_RESOURCE,
                "opus": None,
                "sonnet": "claude-sonnet-4-6",
                "haiku": "claude-haiku-4-5",
                "sonnet5": "claude-sonnet-5",
            },
            "inventory": inventory_input(),
            "commands": {
                "codex": str(self.native), "claude": str(self.native),
                "with_one_password_token": str(self.wrapper), "az": str(self.az),
            },
        }), encoding="utf-8")
        self.env = dict(os.environ)
        for name in OBSERVED_ENV:
            self.env.pop(name, None)
        self.env.update({
            "FOUNDRY_SELECTION_AZ_CAPTURE": str(self.az_capture),
            "FOUNDRY_SELECTION_AZ_ENV_CAPTURE": str(self.az_environment_capture),
            "ANTHROPIC_API_KEY": "synthetic-personal-secret",
            "OPENAI_API_KEY": "synthetic-personal-secret",
            "AZURE_OPENAI_API_KEY": "synthetic-personal-secret",
            "CODEX_HOME": "synthetic-personal-home",
        })

    def script(self, name: str, body: str) -> Path:
        path = self.root / name
        path.write_text(f"#!{sys.executable}\n" + body, encoding="utf-8")
        path.chmod(0o700)
        return path

    def run_cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            [sys.executable, str(LAUNCHER), "--config", str(self.config_file), *args],
            cwd=self.root, env=self.env, input="", text=True, capture_output=True, timeout=10,
        )
        self.assertNotIn("synthetic-personal-secret", result.stdout + result.stderr)
        self.assertNotIn("synthetic-child-key", result.stdout + result.stderr)
        return result

    def json_result(self, result: subprocess.CompletedProcess[str]) -> dict[str, object]:
        try:
            parsed = json.loads(result.stdout)
        except json.JSONDecodeError as error:
            self.fail(f"models --json did not emit one JSON document: {error}; stdout={result.stdout!r}")
        self.assertIsInstance(parsed, dict)
        return parsed

    def azure_calls(self) -> list[list[str]]:
        if not self.az_capture.exists():
            return []
        return [json.loads(line) for line in self.az_capture.read_text(encoding="utf-8").splitlines() if line]

    def azure_environments(self) -> list[dict[str, str | None]]:
        if not self.az_environment_capture.exists():
            return []
        return [
            json.loads(line)
            for line in self.az_environment_capture.read_text(encoding="utf-8").splitlines()
            if line
        ]

    def child_result(self) -> dict[str, object]:
        self.assertTrue(self.child_capture.exists(), "native child was not executed")
        return json.loads(self.child_capture.read_text(encoding="utf-8"))

    def assert_no_external_launch(self) -> None:
        self.assertFalse(self.wrapper_capture.exists(), "credential wrapper was invoked")
        self.assertFalse(self.child_capture.exists(), "native executable was invoked")

    def assert_catalogue(self, payload: dict[str, object], mode: str, state: str) -> None:
        self.assertEqual(payload.get("schema_version"), 1)
        self.assertEqual(payload.get("command"), "models")
        self.assertEqual(payload.get("mode"), mode)
        self.assertEqual(payload.get("state"), state)
        resources = {item["id"]: item for item in payload["resources"]}
        self.assertEqual(set(resources), set(EXPECTED_RESOURCES))
        for resource_id, (resource, group) in EXPECTED_RESOURCES.items():
            item = resources[resource_id]
            self.assertEqual(item["resource"], resource)
            self.assertEqual(item["resource_group"], group)

        models = {item["id"]: item for item in payload["models"]}
        self.assertEqual(set(models), set(EXPECTED_MODELS))
        for model_id, expected in EXPECTED_MODELS.items():
            item = models[model_id]
            bindings = {(binding["resource_id"], binding["deployment"], binding["protocol"], binding["model_format"])
                        for binding in item["bindings"]}
            self.assertEqual(
                bindings,
                {(*binding, expected["format"]) for binding in expected["bindings"]},
            )
            self.assertTrue(all(route["status"] != "qualified" for route in item["routes"]))

    def test_snapshot_reports_literal_ten_model_inventory_without_azure(self) -> None:
        result = self.run_cli("models", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assert_catalogue(self.json_result(result), "snapshot", "snapshot")
        self.assertEqual(self.azure_calls(), [])
        self.assert_no_external_launch()

    def test_refresh_reconciles_both_resources_without_native_or_credential_processes(self) -> None:
        result = self.run_cli("models", "--refresh", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assert_catalogue(self.json_result(result), "refresh", "fresh")
        calls = self.azure_calls()
        self.assertEqual(len(calls), 2)
        self.assertTrue(all("deployment" in call and "list" in call for call in calls))
        self.assert_no_external_launch()

    def test_refresh_normalizes_azure_config_dir_before_queries(self) -> None:
        isolated_home = self.root / "isolated-home"
        self.env.update({"HOME": str(isolated_home), "AZURE_CONFIG_DIR": "~/azure-cache"})
        result = self.run_cli("models", "--refresh", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        expected = str((isolated_home / "azure-cache").resolve())
        self.assertEqual(self.azure_environments(), [{"AZURE_CONFIG_DIR": expected}] * 2)
        self.assert_no_external_launch()

    def test_models_native_argument_error_names_models(self) -> None:
        result = self.run_cli("models", "--", "literal")
        self.assertEqual(result.returncode, 2)
        self.assertIn("models does not accept native arguments", result.stderr)
        self.assertNotIn("check does not accept native arguments", result.stderr)
        self.assertEqual(self.azure_calls(), [])
        self.assert_no_external_launch()

    def test_failed_refresh_reports_parseable_non_fresh_state_and_never_launches(self) -> None:
        self.az_failure.write_text("fail", encoding="utf-8")
        result = self.run_cli("models", "--refresh", "--json")
        self.assertEqual(result.returncode, 3, result.stderr)
        payload = self.json_result(result)
        self.assertEqual(payload.get("mode"), "refresh")
        self.assertIn(payload.get("state"), {"stale", "unavailable"})
        self.assertNotEqual(payload.get("state"), "fresh")
        self.assertTrue(self.azure_calls())
        self.assert_no_external_launch()

    def test_refresh_rejects_same_named_deployment_with_wrong_model_format(self) -> None:
        self.az_format_mismatch.write_text("mismatch", encoding="utf-8")
        result = self.run_cli("models", "--refresh", "--json")
        self.assertEqual(result.returncode, 3, result.stderr)
        payload = self.json_result(result)
        self.assertEqual(payload.get("state"), "unavailable")
        gpt = next(model for model in payload["models"] if model["id"] == "gpt-5.5")
        binding = next(binding for binding in gpt["bindings"] if binding["resource_id"] == "gpt")
        self.assertEqual(binding["availability"], "unavailable")
        self.assertIn("model format", binding["reason"])
        self.assert_no_external_launch()

    def test_unknown_and_incompatible_selection_refuse_before_credentials_or_native(self) -> None:
        for args, expected_exit in (
            (("launch", "--model", "unknown-model", "--agent", "codex"), 2),
            (("launch", "--model", "deepseek-v4-pro", "--agent", "codex", "--qualification"), 2),
        ):
            with self.subTest(args=args):
                result = self.run_cli(*args)
                self.assertEqual(result.returncode, expected_exit, result.stderr)
                self.assert_no_external_launch()

    def test_stale_exact_binding_refuses_before_credential_or_native_invocation(self) -> None:
        config = json.loads(self.config_file.read_text(encoding="utf-8"))
        gpt = next(model for model in config["inventory"]["models"] if model["id"] == "gpt-5.5")
        gpt["availability"] = "stale"
        next(binding for binding in gpt["bindings"] if binding["resource_id"] == "gpt")["availability"] = "stale"
        self.config_file.write_text(json.dumps(config), encoding="utf-8")

        result = self.run_cli("launch", "--model", "gpt-5.5", "--agent", "codex", "--qualification")
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertEqual(self.azure_calls(), [])
        self.assert_no_external_launch()

    def test_stale_selected_resource_refuses_before_credential_or_native_invocation(self) -> None:
        config = json.loads(self.config_file.read_text(encoding="utf-8"))
        resource = next(resource for resource in config["inventory"]["resources"] if resource["id"] == "gpt")
        resource.update({"availability": "stale", "observed": False, "error": "synthetic stale resource"})
        self.config_file.write_text(json.dumps(config), encoding="utf-8")

        result = self.run_cli("launch", "--model", "gpt-5.5", "--agent", "codex", "--qualification")
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertEqual(self.azure_calls(), [])
        self.assert_no_external_launch()

    def test_unverified_protocol_refuses_even_when_mutable_route_claims_compatibility(self) -> None:
        config = json.loads(self.config_file.read_text(encoding="utf-8"))
        model = next(model for model in config["inventory"]["models"] if model["id"] == "deepseek-v4-pro")
        route = next(route for route in model["routes"] if route["agent"] == "codex")
        route.update({
            "implemented": True,
            "compatibility": "compatible",
            "binding_resource_id": "gpt",
            "reason": None,
        })
        self.config_file.write_text(json.dumps(config), encoding="utf-8")

        result = self.run_cli("launch", "--model", "deepseek-v4-pro", "--agent", "codex", "--qualification")
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertEqual(self.azure_calls(), [])
        self.assert_no_external_launch()

    def test_incompatible_model_format_refuses_even_when_mutable_route_claims_codex_protocol(self) -> None:
        config = json.loads(self.config_file.read_text(encoding="utf-8"))
        model = next(model for model in config["inventory"]["models"] if model["id"] == "deepseek-v4-pro")
        binding = next(binding for binding in model["bindings"] if binding["resource_id"] == "gpt")
        binding["protocol"] = "azure-openai-responses"
        route = next(route for route in model["routes"] if route["agent"] == "codex")
        route.update({
            "implemented": True,
            "compatibility": "compatible",
            "binding_resource_id": "gpt",
            "reason": None,
        })
        self.config_file.write_text(json.dumps(config), encoding="utf-8")

        result = self.run_cli("launch", "--model", "deepseek-v4-pro", "--agent", "codex", "--qualification")
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertEqual(self.azure_calls(), [])
        self.assert_no_external_launch()

    def test_selected_codex_resource_must_match_inventory_binding_before_wrapper(self) -> None:
        config = json.loads(self.config_file.read_text(encoding="utf-8"))
        config["codex"]["base_url"] = "https://another-valid-resource.openai.azure.com/openai/v1"
        self.config_file.write_text(json.dumps(config), encoding="utf-8")

        result = self.run_cli("launch", "--model", "gpt-5.5", "--agent", "codex", "--qualification")
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertEqual(self.azure_calls(), [])
        self.assert_no_external_launch()

    def test_selected_claude_resource_must_match_inventory_binding_before_account_or_native(self) -> None:
        config = json.loads(self.config_file.read_text(encoding="utf-8"))
        config["claude"]["resource"] = "another-valid-resource"
        self.config_file.write_text(json.dumps(config), encoding="utf-8")

        result = self.run_cli(
            "launch", "--model", "claude-sonnet-4.6", "--agent", "claude", "--qualification"
        )
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertEqual(self.azure_calls(), [])
        self.assert_no_external_launch()

    def test_gpt5_5_selection_requires_qualification_pins_provider_and_preserves_catalogue(self) -> None:
        refused = self.run_cli("launch", "--model", "gpt-5.5", "--agent", "codex")
        self.assertEqual(refused.returncode, 3, refused.stderr)
        self.assert_no_external_launch()

        before = self.run_cli("models", "--json")
        self.assertEqual(before.returncode, 0, before.stderr)
        trial = self.run_cli(
            "launch", "--model", "gpt-5.5", "--agent", "codex", "--qualification", "--",
            "exec", "literal words 'quoted' $(must-not-run)",
        )
        self.assertEqual(trial.returncode, 0, trial.stderr)
        child = self.child_result()
        self.assertIn("literal words 'quoted' $(must-not-run)", child["argv"])
        assignments = [child["argv"][index + 1] for index, value in enumerate(child["argv"][:-1]) if value == "-c"]
        values = {key.strip(): value.strip().strip('"') for key, value in
                  (assignment.split("=", 1) for assignment in assignments)}
        self.assertEqual(values["model_provider"], "monash_foundry")
        self.assertEqual(values["model"], "gpt-5.5")
        self.assertEqual(
            values["model_providers.monash_foundry.base_url"],
            f"https://{GPT_RESOURCE}.openai.azure.com/openai/v1",
        )
        self.assertEqual(values["model_providers.monash_foundry.wire_api"], "responses")
        self.assertEqual(values["model_providers.monash_foundry.env_key"], "AZURE_OPENAI_API_KEY")
        self.assertEqual(child["env"], {"AZURE_OPENAI_API_KEY": "synthetic-child-key"})
        wrapper = json.loads(self.wrapper_capture.read_text(encoding="utf-8"))
        self.assertEqual(wrapper[:4], ["inject", "AZURE_OPENAI_API_KEY", "op://synthetic/credential", "--"])

        after = self.run_cli("models", "--json")
        self.assertEqual(after.returncode, 0, after.stderr)
        self.assert_catalogue(self.json_result(after), "snapshot", "snapshot")

    def test_selected_native_model_must_match_exact_deployment_before_wrapper(self) -> None:
        result = self.run_cli(
            "launch", "--model", "gpt-5.5", "--agent", "codex", "--qualification", "--",
            "--model", "gpt-5-4-nano",
        )
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assert_no_external_launch()

    def test_selected_claude_route_uses_exact_deployment_and_preserves_native_exit(self) -> None:
        self.exit_control.write_text("19", encoding="utf-8")
        result = self.run_cli(
            "launch", "--model", "claude-sonnet-4.6", "--agent", "claude", "--qualification", "--",
            "--continue",
        )
        self.assertEqual(result.returncode, 19, result.stderr)
        child = self.child_result()
        self.assertIn("--model", child["argv"])
        self.assertEqual(child["argv"][child["argv"].index("--model") + 1], "claude-sonnet-4-6")
        self.assertEqual(child["env"], {
            "CLAUDE_CODE_USE_FOUNDRY": "1",
            "ANTHROPIC_FOUNDRY_RESOURCE": CLAUDE_RESOURCE,
            "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6",
        })
        self.assertFalse(self.wrapper_capture.exists())

    def test_selected_claude_route_composes_caller_hook_settings_with_pinned_env(self) -> None:
        hooks = {"Stop": [{"hooks": [{
            "type": "command",
            "command": "'/synthetic/herdr-projects' 'turn-ended' '--id' 'dotfiles/1'",
            "async": True,
        }]}]}
        hook_file = self.root / "hook-agent.json"
        hook_file.write_text(json.dumps({"hooks": hooks}), encoding="utf-8")
        hook_file.chmod(0o600)
        result = self.run_cli(
            "launch", "--model", "claude-sonnet-4.6", "--agent", "claude", "--qualification", "--",
            "--settings", str(hook_file), "--continue",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        child = self.child_result()
        argv = child["argv"]
        self.assertEqual(argv.count("--settings"), 1)
        self.assertRegex(argv[argv.index("--settings") + 1], r"^/dev/fd/(?:[3-9]|[1-9][0-9]+)$")
        self.assertNotIn("turn-ended", "\n".join(argv))
        self.assertEqual(argv[argv.index("--model") + 1], "claude-sonnet-4-6")
        self.assertIn("--continue", argv)
        self.assertIsNotNone(child["settings_text"], "the native child did not read a --settings path")
        settings = json.loads(child["settings_text"])
        self.assertEqual(settings["hooks"], hooks)
        self.assertEqual(settings["env"]["CLAUDE_CODE_USE_FOUNDRY"], "1")
        self.assertEqual(settings["env"]["ANTHROPIC_FOUNDRY_RESOURCE"], CLAUDE_RESOURCE)
        self.assertEqual(settings["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"], "claude-sonnet-4-6")

    def test_selected_claude_route_refuses_caller_settings_that_replace_the_model(self) -> None:
        result = self.run_cli(
            "launch", "--model", "claude-sonnet-4.6", "--agent", "claude", "--qualification", "--",
            "--settings", json.dumps({"env": {"ANTHROPIC_MODEL": "claude-haiku-4-5"}}),
        )
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("cannot set ANTHROPIC_MODEL;", result.stderr)
        self.assert_no_external_launch()
        self.assertEqual(self.azure_calls(), [])

    def codex_argv_assignments(self, argv: list[str]) -> list[str]:
        """Every Codex -c/--config value in argv, in order."""
        found = []
        for index, value in enumerate(argv):
            if value in ("-c", "--config") and index + 1 < len(argv):
                found.append(argv[index + 1])
            elif value.startswith("--config="):
                found.append(value.split("=", 1)[1])
        return found

    def effort_values(self, argv: list[str]) -> list[str]:
        return [assignment.split("=", 1)[1].strip().strip('"') for assignment in self.codex_argv_assignments(argv)
                if assignment.split("=", 1)[0].strip() == "model_reasoning_effort"]

    def assert_pinned_codex_catalogue(self, path: Path) -> None:
        """The catalogue the launcher hands Codex carries real Sol metadata, not a clone."""
        catalogue = json.loads(path.read_text(encoding="utf-8"))
        entries = {entry["slug"]: entry for entry in catalogue["models"]}
        self.assertEqual(set(entries), {"gpt-5.5", "gpt-6.1-sol"})
        digest = lambda entry: hashlib.sha256(
            json.dumps(entry, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        ).hexdigest()
        sol = entries["gpt-6.1-sol"]
        self.assertEqual([level["effort"] for level in sol["supported_reasoning_levels"]], SOL_REASONING_LEVELS)
        for field, expected in SOL_DISTINGUISHING_FIELDS.items():
            self.assertEqual(sol.get(field), expected, f"Sol entry field {field} is not Sol's own metadata")
        self.assertEqual(digest(sol), SOL_ENTRY_SHA256, "Sol entry does not match pinned upstream Sol metadata")
        self.assertEqual(digest(entries["gpt-5.5"]), GPT55_ENTRY_SHA256, "gpt-5.5 entry changed from its pin")

    def run_with_config(self, config_path: Path, *args: str) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            [sys.executable, str(LAUNCHER), "--config", str(config_path), *args],
            cwd=self.root, env=self.env, input="", text=True, capture_output=True, timeout=10,
        )
        self.assertNotIn("synthetic-personal-secret", result.stdout + result.stderr)
        self.assertNotIn("synthetic-child-key", result.stdout + result.stderr)
        return result

    def test_gpt_6_1_sol_selects_exact_deployment_and_high_effort_through_native_config(self) -> None:
        refused = self.run_cli("launch", "--model", "gpt-6.1-sol", "--agent", "codex")
        self.assertEqual(refused.returncode, 3, refused.stderr)
        self.assert_no_external_launch()

        native = ["-c", 'model_reasoning_effort="high"', "exec", "literal $(must-not-run)"]
        trial = self.run_cli(
            "launch", "--model", "gpt-6.1-sol", "--agent", "codex", "--qualification", "--", *native)
        self.assertEqual(trial.returncode, 0, trial.stderr)
        argv = self.child_result()["argv"]
        self.assertEqual(argv[-len(native):], native, "native arguments must stay last and unchanged")
        values = {key.strip(): value.strip().strip('"') for key, value in
                  (item.split("=", 1) for item in self.codex_argv_assignments(argv))}
        self.assertEqual(values["model"], "gpt-6.1-sol")
        self.assertEqual(values["model_provider"], "monash_foundry")
        self.assertEqual(
            values["model_providers.monash_foundry.base_url"],
            f"https://{GPT_RESOURCE}.openai.azure.com/openai/v1",
        )
        self.assertEqual(self.effort_values(argv), ["high"], "exactly one effort, and it is High")
        self.assert_pinned_codex_catalogue(Path(values["model_catalog_json"]))
        self.assertEqual(self.child_result()["env"], {"AZURE_OPENAI_API_KEY": "synthetic-child-key"})
        wrapper = json.loads(self.wrapper_capture.read_text(encoding="utf-8"))
        self.assertEqual(wrapper[:4], ["inject", "AZURE_OPENAI_API_KEY", "op://synthetic/credential", "--"])

    def test_codex_effort_defaults_and_other_routes_are_unchanged(self) -> None:
        sol = self.run_cli("launch", "--model", "gpt-6.1-sol", "--agent", "codex", "--qualification")
        self.assertEqual(sol.returncode, 0, sol.stderr)
        self.assertEqual(self.effort_values(self.child_result()["argv"]), ["medium"])
        self.child_capture.unlink()
        legacy = self.run_cli("launch", "--model", "gpt-5.5", "--agent", "codex", "--qualification")
        self.assertEqual(legacy.returncode, 0, legacy.stderr)
        argv = self.child_result()["argv"]
        self.assertEqual(self.effort_values(argv), ["medium"])
        values = {key.strip(): value.strip().strip('"') for key, value in
                  (item.split("=", 1) for item in self.codex_argv_assignments(argv))}
        self.assertEqual(values["model"], "gpt-5.5", "no fallback or substitution to or from Sol")

    def test_codex_effort_refusals_never_reach_wrapper_or_native(self) -> None:
        cases = {
            ("gpt-5.5", ("-c", 'model_reasoning_effort="max"')): "level the pinned catalogue does not list for GPT-5.5",
            ("gpt-6.1-sol", ("-c", 'model_reasoning_effort="turbo"')): "unknown level",
            ("gpt-6.1-sol", ("-c", 'model_reasoning_effort="HIGH"')): "wrong case",
            ("gpt-6.1-sol", ("-c", 'model_reasoning_effort="high"', "-c", 'model_reasoning_effort="low"')): "duplicate",
            ("gpt-6.1-sol", ("-c", 'model_provider="openai"')): "other key",
            ("gpt-6.1-sol", ("-c", "model_provider=high")): "level name under another key",
            ("gpt-6.1-sol", ("-c", 'service_tier="high"')): "level name under another key",
            ("gpt-6.1-sol", ("-c", 'model_reasoning_effort="high"', "-c", 'model="gpt-5.5"')): "model swap beside effort",
            ("gpt-6.1-sol", ("-c", 'model_reasoning_effort="high"', "--profile", "personal")): "profile beside effort",
            ("gpt-6.1-sol", ("-cmodel_reasoning_effort=high",)): "attached short form",
            ("gpt-6.1-sol", ("-c",)): "missing value",
            ("gpt-6.1-sol", ("-c", "model_reasoning_effort=high,xhigh")): "list value",
        }
        for (model, native), why in cases.items():
            with self.subTest(model=model, native=native, why=why):
                result = self.run_cli("launch", "--model", model, "--agent", "codex", "--qualification", "--", *native)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assert_no_external_launch()

    def test_shipped_inventory_lists_sol_truthfully_and_launches_it_through_the_public_route(self) -> None:
        shipped = json.loads(LAUNCHER.with_name("config.json").read_text(encoding="utf-8"))
        shipped["commands"] = {
            "codex": str(self.native), "claude": str(self.native),
            "with_one_password_token": str(self.wrapper), "az": str(self.az),
        }
        config_path = self.root / "shipped-config.json"
        config_path.write_text(json.dumps(shipped), encoding="utf-8")

        listing = self.run_with_config(config_path, "models", "--json")
        self.assertEqual(listing.returncode, 0, listing.stderr)
        models = {item["id"]: item for item in self.json_result(listing)["models"]}
        self.assertIn("gpt-6.1-sol", models)
        sol = models["gpt-6.1-sol"]
        self.assertEqual([(b["resource_id"], b["deployment"], b["protocol"], b["model_format"])
                          for b in sol["bindings"]],
                         [("gpt", "gpt-6.1-sol", "azure-openai-responses", "OpenAI")])
        codex_route = next(route for route in sol["routes"] if route["agent"] == "codex")
        self.assertEqual((codex_route["implemented"], codex_route["compatibility"], codex_route["binding_resource_id"]),
                         (True, "compatible", "gpt"))
        # Independent oracle: the exact LOCAL command justified by CLI-DAILY's
        # both-host typed TUI/read/resume receipts. Do not drop --no-daemon or
        # turn this into shared-daemon, SSH, write-sandbox or live-auth proof.
        native = ["-c", 'model_reasoning_effort="high"', "--no-daemon", "--no-alt-screen",
                  "--sandbox", "read-only", "--ask-for-approval", "never"]
        home = self.root / "canonical-home"
        canonical = home / ".codex"
        canonical.mkdir(parents=True)
        protected = {
            "auth.json": b'{"synthetic_personal_login":"untouched"}\n',
            "config.toml": b'model = "synthetic-personal-default"\n',
            "history.jsonl": b'{"synthetic_previous_session":"untouched"}\n',
        }
        for name, content in protected.items():
            (canonical / name).write_bytes(content)
            (canonical / name).chmod(0o600)
        self.env["HOME"] = str(home)
        config_before = config_path.read_bytes()
        trial = self.run_with_config(
            config_path, "launch", "--model", "gpt-6.1-sol", "--agent", "codex", "--", *native)
        self.assertEqual(trial.returncode, 0, trial.stderr)  # RED: untested refuses before custody.
        self.assertEqual(codex_route["status"], "qualified")
        # Independent historical receipt identities, not values derived from config.
        self.assertEqual([(e["observed"], e["kind"], e["host"], e["reference"])
                          for e in codex_route["evidence"]], [
            (True, "native-inference-and-file-read-tool", "mini",
             "receipt:dotfiles/32/evidence/mini-tui-first.json"),
            (True, "native-inference-and-file-read-tool", "mini",
             "receipt:dotfiles/32/evidence/mini-tui-resume.json"),
            (True, "native-inference-and-file-read-tool", "mini",
             "receipt:dotfiles/32/evidence/mini-tui-typed.json"),
            (True, "native-inference-and-file-read-tool", "laptop",
             "receipt:dotfiles/32/evidence/continued-mini-20261102/laptop-local-tui-root.json"),
            (True, "native-inference-and-file-read-tool", "laptop",
             "receipt:dotfiles/32/evidence/continued-mini-20261102/laptop-local-resume-root.json"),
        ])
        self.assertEqual([(r["agent"], r["status"], r["implemented"], r["compatibility"], r["evidence"])
                          for r in sol["routes"] if r["agent"] != "codex"],
                         [("claude", "untested", False, "incompatible", []),
                          ("opencode", "untested", False, "incompatible", [])])

        for suffix, expected_exit in (([], 0), (["resume", "00000000-0000-7000-8000-000000000032"], 19)):
            if suffix:
                self.exit_control.write_text("19", encoding="utf-8")
                resumed = self.run_with_config(
                    config_path, "launch", "--model", "gpt-6.1-sol", "--agent", "codex", "--", *native, *suffix)
                self.assertEqual(resumed.returncode, expected_exit, resumed.stderr)
            child = self.child_result()
            argv = child["argv"]
            values = {key.strip(): value.strip().strip('"') for key, value in
                      (item.split("=", 1) for item in self.codex_argv_assignments(argv))}
            self.assertEqual(values["model"], "gpt-6.1-sol")
            self.assertEqual(values["model_provider"], "monash_foundry")
            self.assertEqual(values["model_providers.monash_foundry.base_url"],
                             f"https://{GPT_RESOURCE}.openai.azure.com/openai/v1")
            self.assertEqual(values["model_providers.monash_foundry.wire_api"], "responses")
            self.assertEqual(values["model_providers.monash_foundry.env_key"], "AZURE_OPENAI_API_KEY")
            self.assertEqual(values["model_providers.monash_foundry.requires_openai_auth"], "false")
            self.assertEqual(values["service_tier"], "default")
            self.assertEqual(self.effort_values(argv), ["high"])
            self.assertEqual(argv[-len(native + suffix):], native + suffix)
            self.assertEqual(argv.count("--no-daemon"), 1)
            self.assertEqual(child["cwd"], str(self.root))
            self.assertEqual(child["home"], str(home))
            self.assert_pinned_codex_catalogue(Path(values["model_catalog_json"]))
            self.assertEqual(child["env"], {"AZURE_OPENAI_API_KEY": "synthetic-child-key"},
                             "personal credentials and CODEX_HOME must not be forwarded")
            wrapper = json.loads(self.wrapper_capture.read_text(encoding="utf-8"))
            self.assertEqual(wrapper[:4], ["inject", "AZURE_OPENAI_API_KEY",
                                          "op://API Credentials/AZURE_OPENAI_API_KEY_MONASH/credential", "--"])
            self.assertEqual(config_path.read_bytes(), config_before)
            for name, content in protected.items():
                self.assertEqual((canonical / name).read_bytes(), content)
            self.assertEqual(self.azure_calls(), [])

        # Bare codex still uses the existing default, not Sol/High.
        self.exit_control.unlink()
        legacy = self.run_with_config(config_path, "codex")
        self.assertEqual(legacy.returncode, 0, legacy.stderr)
        legacy_argv = self.child_result()["argv"]
        legacy_values = {key.strip(): value.strip().strip('"') for key, value in
                         (item.split("=", 1) for item in self.codex_argv_assignments(legacy_argv))}
        self.assertEqual(legacy_values["model"], "gpt-5.5")
        self.assertEqual(self.effort_values(legacy_argv), ["medium"])

    def test_sol_rollback_and_failed_states_refuse_ordinary_launch_before_custody(self) -> None:
        shipped = json.loads(LAUNCHER.with_name("config.json").read_text(encoding="utf-8"))
        shipped["commands"] = {
            "codex": str(self.native), "with_one_password_token": str(self.wrapper), "az": str(self.az),
        }
        sol = next(m for m in shipped["inventory"]["models"] if m["id"] == "gpt-6.1-sol")
        route = next(r for r in sol["routes"] if r["agent"] == "codex")
        config_path = self.root / "rollback-config.json"
        for status in ("untested", "failed"):
            with self.subTest(status=status):
                route.update({"status": status, "reason": "synthetic rollback/refusal", "evidence": []})
                config_path.write_text(json.dumps(shipped), encoding="utf-8")
                refused = self.run_with_config(
                    config_path, "launch", "--model", "gpt-6.1-sol", "--agent", "codex", "--",
                    "-c", 'model_reasoning_effort="high"', "--no-daemon", "--no-alt-screen",
                    "--sandbox", "read-only", "--ask-for-approval", "never")
                self.assertEqual(refused.returncode, 3, refused.stderr)
                self.assertIn("is untested for codex" if status == "untested" else
                              "failed qualification for codex", refused.stderr)
                self.assert_no_external_launch()
                self.assertEqual(self.azure_calls(), [])

    def test_sol_catalogue_oracle_rejects_a_borrowed_gpt_5_5_entry_through_the_public_route(self) -> None:
        shipped = json.loads(LAUNCHER.with_name("codex-models.json").read_text(encoding="utf-8"))
        entries = {entry["slug"]: entry for entry in shipped["models"]}
        # The plausible wrong catalogue: GPT-5.5's metadata with only the slug
        # and the supported effort list changed to Sol's.
        borrowed = json.loads(json.dumps(entries["gpt-5.5"]))
        borrowed["slug"] = "gpt-6.1-sol"
        borrowed["supported_reasoning_levels"] = entries["gpt-6.1-sol"]["supported_reasoning_levels"]
        home = self.root / "borrowed-launcher"
        home.mkdir()
        shutil.copy2(LAUNCHER, home / "monash-foundry")
        (home / "codex-models.json").write_text(
            json.dumps({"models": [entries["gpt-5.5"], borrowed]}), encoding="utf-8")

        result = subprocess.run(
            [sys.executable, str(home / "monash-foundry"), "--config", str(self.config_file),
             "launch", "--model", "gpt-6.1-sol", "--agent", "codex", "--qualification", "--",
             "-c", 'model_reasoning_effort="high"'],
            cwd=self.root, env=self.env, input="", text=True, capture_output=True, timeout=10,
        )
        # The launcher cannot tell: it accepts High from the clone's own level list.
        self.assertEqual(result.returncode, 0, result.stderr)
        values = {key.strip(): value.strip().strip('"') for key, value in
                  (item.split("=", 1) for item in self.codex_argv_assignments(self.child_result()["argv"]))}
        catalogue_path = Path(values["model_catalog_json"])
        self.assertEqual(catalogue_path.parent, home)
        # The pinned oracle is what rejects it.
        with self.assertRaises(AssertionError) as rejected:
            self.assert_pinned_codex_catalogue(catalogue_path)
        self.assertIn("is not Sol's own metadata", str(rejected.exception))

    def test_shipped_claude_aliases_match_live_azure_and_drive_the_claude_route(self) -> None:
        # Independent oracle: `az cognitiveservices account deployment list` on the
        # Claude resource, 2026-11-01, lists claude-sonnet-5-5 and claude-haiku-5-5.
        live_aliases = {"sonnet": "claude-sonnet-5-5", "sonnet5": "claude-sonnet-5-5", "haiku": "claude-haiku-5-5"}
        shipped = json.loads(LAUNCHER.with_name("config.json").read_text(encoding="utf-8"))
        self.assertEqual({key: shipped["claude"][key] for key in live_aliases}, live_aliases)

        shipped["tenant"], shipped["subscription"] = "test-tenant-id", "test-subscription"  # the fake az's account
        shipped["commands"] = {
            "codex": str(self.native), "claude": str(self.native),
            "with_one_password_token": str(self.wrapper), "az": str(self.az),
        }
        config_path = self.root / "shipped-claude-config.json"
        config_path.write_text(json.dumps(shipped), encoding="utf-8")
        result = self.run_with_config(config_path, "claude", "--", "-p", "marker")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("deployment=claude-sonnet-5-5", result.stderr)
        argv = self.child_result()["argv"]
        self.assertEqual(argv[argv.index("--model") + 1], "claude-sonnet-5-5")
        env = json.loads(argv[argv.index("--settings") + 1])["env"]
        self.assertEqual(env["ANTHROPIC_DEFAULT_SONNET_MODEL"], "claude-sonnet-5-5")
        self.assertEqual(env["ANTHROPIC_DEFAULT_HAIKU_MODEL"], "claude-haiku-5-5")
        self.assertEqual(env["ANTHROPIC_FOUNDRY_RESOURCE"], CLAUDE_RESOURCE)

    def test_legacy_codex_entry_point_remains_compatible(self) -> None:
        result = self.run_cli("codex", "--", "exec", "--ephemeral")
        self.assertEqual(result.returncode, 0, result.stderr)
        child = self.child_result()
        self.assertIn("exec", child["argv"])
        self.assertIn("--ephemeral", child["argv"])


if __name__ == "__main__":
    unittest.main()
