#!/usr/bin/env python3
"""Public-process coverage for the explicit native OpenCode routes."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Dict, List, Optional, Tuple


HERE = Path(__file__).resolve().parent
LAUNCHER = HERE / "monash-foundry"
GPT_RESOURCE = "monash-edu-esol-smst-ai-dev-gpt"
CLAUDE_RESOURCE = "monash-edu-smst-ai-claude-code"
GPT_BASE_URL = f"https://{GPT_RESOURCE}.services.ai.azure.com/openai/v1"
CLAUDE_BASE_URL = f"https://{CLAUDE_RESOURCE}.services.ai.azure.com/openai/v1"

TARGETS = {
    "gpt-5.4-nano": ("gpt", "gpt-5.4-nano", "OpenAI", GPT_BASE_URL),
    "deepseek-v4-pro": ("gpt", "DeepSeek-V4-Pro", "DeepSeek", GPT_BASE_URL),
    "deepseek-v4-flash": ("gpt", "DeepSeek-V4-Flash", "DeepSeek", GPT_BASE_URL),
    "kimi-k2.7-code": ("gpt", "Kimi-K2.7-Code", "MoonshotAI", GPT_BASE_URL),
    "kimi-k2.6": ("claude", "Kimi-K2.6", "MoonshotAI", CLAUDE_BASE_URL),
}

# Independent oracle for the repository-shipped inventory. Keep this table
# literal and separate from TARGETS, which feeds the disposable fixture.
SHIPPED_OPENCODE_ROUTES = {
    "gpt-5.4-nano": {
        "status": "qualified",
        "resource_id": "gpt",
        "resource": "monash-edu-esol-smst-ai-dev-gpt",
        "base_url": "https://monash-edu-esol-smst-ai-dev-gpt.services.ai.azure.com/openai/v1",
        "deployment": "gpt-5.4-nano",
        "protocol": "azure-openai-chat-completions",
        "model_format": "OpenAI",
    },
    "deepseek-v4-pro": {
        "status": "qualified",
        "resource_id": "gpt",
        "resource": "monash-edu-esol-smst-ai-dev-gpt",
        "base_url": "https://monash-edu-esol-smst-ai-dev-gpt.services.ai.azure.com/openai/v1",
        "deployment": "DeepSeek-V4-Pro",
        "protocol": "azure-openai-chat-completions",
        "model_format": "DeepSeek",
    },
    "deepseek-v4-flash": {
        "status": "qualified",
        "resource_id": "gpt",
        "resource": "monash-edu-esol-smst-ai-dev-gpt",
        "base_url": "https://monash-edu-esol-smst-ai-dev-gpt.services.ai.azure.com/openai/v1",
        "deployment": "DeepSeek-V4-Flash",
        "protocol": "azure-openai-chat-completions",
        "model_format": "DeepSeek",
    },
    "kimi-k2.7-code": {
        "status": "qualified",
        "resource_id": "gpt",
        "resource": "monash-edu-esol-smst-ai-dev-gpt",
        "base_url": "https://monash-edu-esol-smst-ai-dev-gpt.services.ai.azure.com/openai/v1",
        "deployment": "Kimi-K2.7-Code",
        "protocol": "azure-openai-chat-completions",
        "model_format": "MoonshotAI",
    },
    "kimi-k2.6": {
        "status": "qualified",
        "resource_id": "claude",
        "resource": "monash-edu-smst-ai-claude-code",
        "base_url": "https://monash-edu-smst-ai-claude-code.services.ai.azure.com/openai/v1",
        "deployment": "Kimi-K2.6",
        "protocol": "azure-openai-chat-completions",
        "model_format": "MoonshotAI",
    },
}
SHIPPED_LAPTOP_QUALIFICATION_EVIDENCE = {
    "gpt-5.4-nano": {
        "observed": True, "kind": "native-inference-and-file-read-tool", "host": "laptop",
        "reference": "receipt:my-second-brain-playground/monash-foundry/integrated-opencode-qualification/gpt-5.4-nano-managed-laptop-9c2d50d0/receipt.json",
    },
    "deepseek-v4-pro": {
        "observed": True, "kind": "native-inference-and-file-read-tool", "host": "laptop",
        "reference": "receipt:my-second-brain-playground/monash-foundry/integrated-opencode-qualification/deepseek-v4-pro-managed-laptop-4b555364/receipt.json",
    },
    "deepseek-v4-flash": {
        "observed": True, "kind": "native-inference-and-file-read-tool", "host": "laptop",
        "reference": "receipt:my-second-brain-playground/monash-foundry/integrated-opencode-qualification/deepseek-v4-flash-managed-laptop-896f1286/receipt.json",
    },
    "kimi-k2.7-code": {
        "observed": True, "kind": "native-inference-and-file-read-tool", "host": "laptop",
        "reference": "receipt:my-second-brain-playground/monash-foundry/integrated-opencode-qualification/kimi-k2.7-managed-laptop-6752d771/receipt.json",
    },
    "kimi-k2.6": {
        "observed": True, "kind": "native-inference-and-file-read-tool", "host": "laptop",
        "reference": "receipt:my-second-brain-playground/monash-foundry/integrated-opencode-qualification/kimi-k2.6-managed-laptop-9a3474dc/receipt.json",
    },
}
SHIPPED_MINI_QUALIFICATION_EVIDENCE = {
    "gpt-5.4-nano": {
        "observed": True, "kind": "native-inference-and-file-read-tool", "host": "mini",
        "reference": "receipt:my-second-brain-playground/monash-foundry/integrated-opencode-qualification/gpt-5.4-nano-managed-mini-42f9a0c4/receipt.json",
    },
    "deepseek-v4-pro": {
        "observed": True, "kind": "native-inference-and-file-read-tool", "host": "mini",
        "reference": "receipt:my-second-brain-playground/monash-foundry/integrated-opencode-qualification/deepseek-v4-pro-managed-mini-fae5b24b/receipt.json",
    },
    "deepseek-v4-flash": {
        "observed": True, "kind": "native-inference-and-file-read-tool", "host": "mini",
        "reference": "receipt:my-second-brain-playground/monash-foundry/integrated-opencode-qualification/deepseek-v4-flash-managed-mini-e4433d85/receipt.json",
    },
    "kimi-k2.7-code": {
        "observed": True, "kind": "native-inference-and-file-read-tool", "host": "mini",
        "reference": "receipt:my-second-brain-playground/monash-foundry/integrated-opencode-qualification/kimi-k2.7-code-managed-mini-2631c50d/receipt.json",
    },
    "kimi-k2.6": {
        "observed": True, "kind": "native-inference-and-file-read-tool", "host": "mini",
        "reference": "receipt:my-second-brain-playground/monash-foundry/integrated-opencode-qualification/kimi-k2.6-managed-mini-9a690eb0/receipt.json",
    },
}
SHIPPED_OPENCODE_REFUSALS = (
    "gpt-5.5",
    "gpt-6.1-sol",
    "claude-sonnet-5",
    "claude-sonnet-4.6",
    "claude-haiku-4.5",
)

MODEL_IDS = (
    "gpt-5.5",
    "gpt-5.4-nano",
    "claude-sonnet-5",
    "claude-sonnet-4.6",
    "claude-haiku-4.5",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "kimi-k2.7-code",
    "kimi-k2.6",
    "gpt-6.1-sol",
)

# Independent process-boundary oracle. Keep the complete case-sensitive proxy
# family literal here so the regression catches a partial production list.
PROXY_ENV_NAMES = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
)
SAFE_ENV_NAME = "MONASH_SAFE_TEST_VARIABLE"
SAFE_ENV_VALUE = "must-remain"


def binding(resource_id: str, deployment: str, model_format: str, protocol: str) -> Dict[str, object]:
    return {
        "resource_id": resource_id,
        "deployment": deployment,
        "protocol": protocol,
        "model_format": model_format,
        "availability": "available",
        "provisioning_state": "Succeeded",
        "observed": True,
        "reason": None,
    }


def route(
    agent: str,
    binding_resource_id: Optional[str],
    *,
    implemented: bool,
    compatibility: str,
    reason: str,
) -> Dict[str, object]:
    return {
        "agent": agent,
        "status": "untested",
        "implemented": implemented,
        "compatibility": compatibility,
        "binding_resource_id": binding_resource_id,
        "reason": reason,
        "evidence": [],
    }


def fixture_config(opencode_command: str) -> Dict[str, object]:
    target_models = {
        model_id: (resource_id, deployment, model_format)
        for model_id, (resource_id, deployment, model_format, _base_url) in TARGETS.items()
    }
    conventional_models = {
        "gpt-5.5": ("gpt", "gpt-5.5", "OpenAI"),
        "gpt-6.1-sol": ("gpt", "gpt-6.1-sol", "OpenAI"),
        "claude-sonnet-5": ("claude", "claude-sonnet-5", "Anthropic"),
        "claude-sonnet-4.6": ("claude", "claude-sonnet-4-6", "Anthropic"),
        "claude-haiku-4.5": ("claude", "claude-haiku-4-5", "Anthropic"),
    }
    models: List[Dict[str, object]] = []
    for model_id in MODEL_IDS:
        if model_id in target_models:
            selected_resource, deployment, model_format = target_models[model_id]
            selected_binding = binding(
                selected_resource,
                deployment,
                model_format,
                "azure-openai-chat-completions",
            )
            bindings = [selected_binding]
            if selected_resource == "gpt":
                bindings.append(binding("claude", deployment, model_format, "unverified"))
            else:
                bindings.append(binding("gpt", deployment, model_format, "unverified"))
            open_code_route = route(
                "opencode",
                selected_resource,
                implemented=True,
                compatibility="compatible",
                reason="integrated qualification pending",
            )
        else:
            selected_resource, deployment, model_format = conventional_models[model_id]
            bindings = [binding(selected_resource, deployment, model_format, "unverified")]
            other_resource = "claude" if selected_resource == "gpt" else "gpt"
            bindings.append(binding(other_resource, deployment, model_format, "unverified"))
            open_code_route = route(
                "opencode",
                None,
                implemented=False,
                compatibility="incompatible",
                reason="no documented OpenCode recipe",
            )
        models.append(
            {
                "id": model_id,
                "display_name": model_id,
                "availability": "available",
                "bindings": bindings,
                "routes": [
                    route(
                        "codex",
                        "gpt",
                        implemented=False,
                        compatibility="incompatible",
                        reason="fixture does not qualify Codex",
                    ),
                    route(
                        "claude",
                        "claude",
                        implemented=False,
                        compatibility="incompatible",
                        reason="fixture does not qualify Claude",
                    ),
                    open_code_route,
                ],
            }
        )

    return {
        "tenant": "tenant-fixture",
        "subscription": "subscription-fixture",
        "codex": {
            "base_url": "https://monash-edu-esol-smst-ai-dev-gpt.openai.azure.com/openai/v1",
            "deployment": "gpt-5.5",
            "credential_ref": "fixture/credential",
        },
        "claude": {
            "resource": CLAUDE_RESOURCE,
            "opus": None,
            "sonnet": "claude-sonnet-4-6",
            "haiku": "claude-haiku-4-5",
            "sonnet5": "claude-sonnet-5",
        },
        "opencode": {
            "resources": {
                "gpt": {"resource": GPT_RESOURCE, "base_url": GPT_BASE_URL},
                "claude": {"resource": CLAUDE_RESOURCE, "base_url": CLAUDE_BASE_URL},
            },
            "minimum_version": "1.18.27",
        },
        "commands": {"opencode": opencode_command},
        "inventory": {
            "schema_version": 1,
            "snapshot_observed_at": "2026-09-09T00:00:00Z",
            "snapshot_source": "test-fixture",
            "resources": [
                {
                    "id": "gpt",
                    "resource": GPT_RESOURCE,
                    "resource_group": "gpt-rg",
                    "availability": "available",
                    "observed": True,
                    "error": None,
                },
                {
                    "id": "claude",
                    "resource": CLAUDE_RESOURCE,
                    "resource_group": "claude-rg",
                    "availability": "available",
                    "observed": True,
                    "error": None,
                },
            ],
            "models": models,
        },
    }


FAKE_OPENCODE = r'''#!/usr/bin/env python3
import json
import os
import pathlib
import sys

args = sys.argv[1:]
if "--version" in args:
    pathlib.Path(os.environ["FAKE_VERSION_CAPTURE"]).write_text(
        json.dumps(
            {
                "exec_path": sys.argv[0],
                "argv": args,
                "env": {
                    name: os.environ.get(name)
                    for name in (
                        "HOME",
                        "XDG_CONFIG_HOME",
                        "XDG_DATA_HOME",
                        "XDG_STATE_HOME",
                        "AZURE_CONFIG_DIR",
                        "OPENCODE_CONFIG_DIR",
                        "OPENCODE_TUI_CONFIG",
                        "OPENCODE_DISABLE_PROJECT_CONFIG",
                        "OPENCODE_PURE",
                        "OPENCODE_CONFIG",
                        "OPENCODE_PLUGIN_META_FILE",
                        "OPENCODE_AUTH_CONTENT",
                        "OPENCODE_CONFIG_CONTENT",
                        "HERDR_AGENT",
                        "OPENAI_API_KEY",
                        "ANTHROPIC_API_KEY",
                        "AZURE_OPENAI_API_KEY",
                        "HTTP_PROXY",
                        "HTTPS_PROXY",
                        "ALL_PROXY",
                        "NO_PROXY",
                        "http_proxy",
                        "https_proxy",
                        "all_proxy",
                        "no_proxy",
                        "MONASH_SAFE_TEST_VARIABLE",
                    )
                },
            }
        ),
        encoding="utf-8",
    )
    print(os.environ.get("FAKE_VERSION", "1.18.27"))
    raise SystemExit(0)

def oracle_failure(message):
    pathlib.Path(os.environ["FAKE_ORACLE_FAILURE"]).write_text(message, encoding="utf-8")
    raise SystemExit(71)

def load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        oracle_failure(f"could not load {path}: {error}")

def check_route_custody():
    route_dir = pathlib.Path(os.environ["OPENCODE_CONFIG_DIR"])
    route_home = pathlib.Path(os.environ["XDG_CONFIG_HOME"])
    ambient_dir = pathlib.Path(os.environ["FAKE_AMBIENT_OPENCODE_DIR"])
    project_dir = pathlib.Path(os.environ["FAKE_PROJECT_OPENCODE_DIR"])
    if not route_dir.is_dir() or route_dir in (ambient_dir, project_dir):
        oracle_failure("the child did not receive an isolated OpenCode config directory")
    if route_home != route_dir.parent:
        oracle_failure("the child XDG config root does not own the selected OpenCode config directory")
    if os.environ.get("OPENCODE_DISABLE_PROJECT_CONFIG") != "1":
        oracle_failure("project OpenCode configuration was not disabled")
    if "--pure" in args or os.environ.get("OPENCODE_PURE") is not None:
        oracle_failure("pure mode would suppress Herdr external plugins")
    if os.environ.get("OPENCODE_CONFIG") is not None:
        oracle_failure("ambient OPENCODE_CONFIG crossed the boundary")
    if os.environ.get("OPENCODE_PLUGIN_META_FILE") is not None:
        oracle_failure("ambient plugin metadata crossed the boundary")

    content = json.loads(os.environ["OPENCODE_CONFIG_CONTENT"])
    file_config = load_json(route_dir / "opencode.json")
    tui_config = load_json(pathlib.Path(os.environ["OPENCODE_TUI_CONFIG"]))
    expected_server = (ambient_dir / "plugins" / "herdr-agent-state.js").resolve().as_uri()
    expected_tui = (ambient_dir / "herdr-tui-session.js").resolve().as_uri()
    if args[:2] != ["--model", content.get("model")]:
        oracle_failure("the native model argument is not the selected route")
    if content != file_config:
        oracle_failure("the process content and isolated config file disagree")
    if set(content.get("provider", {})) != {"azure"}:
        oracle_failure("the route config contains a competing provider")
    if content.get("enabled_providers") != ["azure"]:
        oracle_failure("the route does not constrain enabled providers")
    if content.get("plugin") != [expected_server]:
        oracle_failure("the route does not allow exactly the Herdr server plugin")
    if set(tui_config) != {"plugin"} or tui_config.get("plugin") != [expected_tui]:
        oracle_failure("the route does not allow exactly the Herdr TUI plugin")
    if (route_dir / "plugins").exists() and any((route_dir / "plugins").iterdir()):
        oracle_failure("the isolated plugin directory is not empty")
    if "lmstudio" in content.get("provider", {}):
        oracle_failure("ambient LM Studio provider crossed the config boundary")

check_route_custody()
capture = {
    "argv": args,
    "env": {
        name: os.environ.get(name)
        for name in (
            "HOME",
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "XDG_STATE_HOME",
            "AZURE_CONFIG_DIR",
            "OPENCODE_CONFIG_DIR",
            "OPENCODE_TUI_CONFIG",
            "OPENCODE_DISABLE_PROJECT_CONFIG",
            "OPENCODE_PURE",
            "OPENCODE_CONFIG",
            "OPENCODE_PLUGIN_META_FILE",
            "OPENCODE_AUTH_CONTENT",
            "OPENCODE_CONFIG_CONTENT",
            "HERDR_AGENT",
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "AZURE_OPENAI_API_KEY",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
            "no_proxy",
            "MONASH_SAFE_TEST_VARIABLE",
            "OPENCODE_MODEL",
        )
    },
    "exec_path": sys.argv[0],
}
pathlib.Path(os.environ["FAKE_CAPTURE"]).write_text(json.dumps(capture), encoding="utf-8")
print(os.environ.get("FAKE_STDOUT", "native-stdout"))
print(os.environ.get("FAKE_STDERR", "native-stderr"), file=sys.stderr)
raise SystemExit(int(os.environ.get("FAKE_EXIT", "0")))
'''


class OpenCodeProcessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.fake = self.root / "opencode"
        self.fake.write_text(FAKE_OPENCODE, encoding="utf-8")
        self.fake.chmod(self.fake.stat().st_mode | stat.S_IXUSR)
        self.ambient_config_home = self.root / "ambient-xdg-config"
        self.ambient_opencode = self.ambient_config_home / "opencode"
        (self.ambient_opencode / "plugins").mkdir(parents=True)
        self.herdr_server = self.ambient_opencode / "plugins" / "herdr-agent-state.js"
        self.herdr_tui = self.ambient_opencode / "herdr-tui-session.js"
        self.herdr_server.write_text(
            "// HERDR_INTEGRATION_ID=opencode\n// HERDR_INTEGRATION_VERSION=11\n",
            encoding="utf-8",
        )
        self.herdr_tui.write_text(
            "// HERDR_INTEGRATION_ID=opencode-tui\n// HERDR_INTEGRATION_VERSION=11\n",
            encoding="utf-8",
        )
        (self.ambient_opencode / "plugins" / "competing.js").write_text(
            "// competing plugin\n",
            encoding="utf-8",
        )
        (self.ambient_opencode / "config.json").write_text(
            json.dumps(
                {
                    "model": "lmstudio/qwen3-coder-30b-a3b-instruct-mlx",
                    "provider": {"lmstudio": {"models": {"qwen3-coder-30b-a3b-instruct-mlx": {}}}},
                    "plugin": ["file:///ambient/competing.js"],
                }
            ),
            encoding="utf-8",
        )
        (self.ambient_opencode / "tui.jsonc").write_text(
            json.dumps({"plugin": ["./herdr-tui-session.js", "./competing-tui.js"]}),
            encoding="utf-8",
        )
        self.project = self.root / "project"
        self.project_opencode = self.project / ".opencode"
        self.project_opencode.mkdir(parents=True)
        (self.project_opencode / "opencode.json").write_text(
            json.dumps(
                {
                    "model": "rogue/project-model",
                    "provider": {"rogue": {"models": {"project-model": {}}}},
                    "plugin": ["file:///project/competing.js"],
                }
            ),
            encoding="utf-8",
        )
        self.native_data_home = self.root / "native-xdg-data"
        self.native_state_home = self.root / "native-xdg-state"
        (self.native_data_home / "opencode").mkdir(parents=True)
        (self.native_state_home / "opencode").mkdir(parents=True)
        (self.native_data_home / "opencode" / "auth.json").write_text(
            json.dumps({"lmstudio": {"type": "api", "key": "native-credential"}}),
            encoding="utf-8",
        )
        (self.native_state_home / "opencode" / "model.json").write_text(
            json.dumps(
                {
                    "recent": [
                        {
                            "providerID": "lmstudio",
                            "modelID": "qwen3-coder-30b-a3b-instruct-mlx",
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )
        self.wrapper_capture = self.root / "wrapper-capture.json"
        self.codex_capture = self.root / "codex-capture.json"
        self.claude_capture = self.root / "claude-capture.json"
        self.claude = self.root / "claude"
        self.claude.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, pathlib, sys\n"
            "settings_index = sys.argv.index('--settings') + 1\n"
            "capture = {'argv': sys.argv[1:], 'settings': json.loads(sys.argv[settings_index]), 'env': os.environ.get('HERDR_AGENT')}\n"
            "pathlib.Path(os.environ['FAKE_CLAUDE_CAPTURE']).write_text(json.dumps(capture), encoding='utf-8')\n"
            "raise SystemExit(0)\n",
            encoding="utf-8",
        )
        self.claude.chmod(self.claude.stat().st_mode | stat.S_IXUSR)
        self.az = self.root / "az"
        self.az.write_text(
            "#!/usr/bin/env python3\n"
            "import json\n"
            "print(json.dumps({'id': 'subscription-fixture', 'name': 'subscription-fixture', 'state': 'Enabled', 'isDefault': True, 'tenantId': 'tenant-fixture'}))\n",
            encoding="utf-8",
        )
        self.az.chmod(self.az.stat().st_mode | stat.S_IXUSR)
        self.wrapper = self.root / "with-one-password-token"
        self.wrapper.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, pathlib, sys\n"
            f"pathlib.Path({str(self.wrapper_capture)!r}).write_text(json.dumps({{'argv': sys.argv[1:], 'env': {{name: os.environ.get(name) for name in ('HOME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'HERDR_AGENT', 'OPENAI_API_KEY')}}}}), encoding='utf-8')\n"
            "separator = sys.argv.index('--')\n"
            "os.execve(sys.argv[separator + 1], sys.argv[separator + 2:], os.environ.copy())\n",
            encoding="utf-8",
        )
        self.wrapper.chmod(self.wrapper.stat().st_mode | stat.S_IXUSR)
        self.codex = self.root / "codex"
        self.codex.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, pathlib, sys\n"
            f"pathlib.Path({str(self.codex_capture)!r}).write_text(json.dumps({{'exec_path': sys.argv[0], 'argv': sys.argv[1:], 'env': {{name: os.environ.get(name) for name in ('HERDR_AGENT', 'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY')}}}}), encoding='utf-8')\n"
            "raise SystemExit(0)\n",
            encoding="utf-8",
        )
        self.codex.chmod(self.codex.stat().st_mode | stat.S_IXUSR)
        self.noop = self.root / "noop"
        self.noop.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        self.noop.chmod(self.noop.stat().st_mode | stat.S_IXUSR)
        self.fail_script = self.root / "fail"
        self.fail_script.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
        self.fail_script.chmod(self.fail_script.stat().st_mode | stat.S_IXUSR)
        self.config = self.root / "config.json"
        self.capture = self.root / "capture.json"
        self.version_capture = self.root / "version-called"
        self.oracle_failure = self.root / "oracle-failure"
        self.config.write_text(
            json.dumps(fixture_config(str(self.fake)), indent=2) + "\n",
            encoding="utf-8",
        )
        self.environment = os.environ.copy()
        self.environment.update(
            {
                "FAKE_CAPTURE": str(self.capture),
                "FAKE_VERSION_CAPTURE": str(self.version_capture),
                "FAKE_VERSION": "1.18.27",
                "FAKE_EXIT": "0",
                "FAKE_STDOUT": "native-stdout",
                "FAKE_STDERR": "native-stderr",
                "FAKE_ORACLE_FAILURE": str(self.oracle_failure),
                "FAKE_CLAUDE_CAPTURE": str(self.claude_capture),
                "FAKE_AMBIENT_OPENCODE_DIR": str(self.ambient_opencode),
                "FAKE_PROJECT_OPENCODE_DIR": str(self.project_opencode),
                "XDG_CONFIG_HOME": str(self.ambient_config_home),
                "XDG_DATA_HOME": str(self.native_data_home),
                "XDG_STATE_HOME": str(self.native_state_home),
                "OPENAI_API_KEY": "must-not-cross-boundary",
                "ANTHROPIC_API_KEY": "must-not-cross-boundary",
                "AZURE_OPENAI_API_KEY": "must-not-cross-boundary",
                "HERDR_AGENT": "opencode",
                "OPENCODE_MODEL": "must-not-cross-boundary",
                "OPENCODE_CONFIG": "must-not-cross-boundary",
                "OPENCODE_CONFIG_DIR": "must-not-cross-boundary",
                "OPENCODE_TUI_CONFIG": "must-not-cross-boundary",
                "OPENCODE_DISABLE_PROJECT_CONFIG": "must-not-cross-boundary",
                "OPENCODE_PURE": "1",
                "OPENCODE_PLUGIN_META_FILE": "must-not-cross-boundary",
                "OPENCODE_AUTH_CONTENT": "must-not-cross-boundary",
                "OPENCODE_CONFIG_CONTENT": "must-not-cross-boundary",
                "AZURE_CONFIG_DIR": str(self.root / "azure-cache"),
            }
        )
        self.shipped_home = self.root / "shipped-home"
        shipped_bin = self.shipped_home / ".local" / "bin"
        shipped_bin.mkdir(parents=True)
        (shipped_bin / "opencode").symlink_to(self.fake)
        self.shipped_environment = self.environment.copy()
        self.shipped_environment["HOME"] = str(self.shipped_home)

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def run_launcher(self, *args: str) -> subprocess.CompletedProcess[str]:
        for path in (self.capture, self.version_capture):
            path.unlink(missing_ok=True)
        return subprocess.run(
            [sys.executable, str(LAUNCHER), "--config", str(self.config), *args],
            cwd=self.project,
            env=self.environment,
            text=True,
            capture_output=True,
            check=False,
        )

    def run_shipped_launcher(self, *args: str) -> subprocess.CompletedProcess[str]:
        for path in (self.capture, self.version_capture):
            path.unlink(missing_ok=True)
        return subprocess.run(
            [sys.executable, str(LAUNCHER), "--config", str(HERE / "config.json"), *args],
            cwd=self.project,
            env=self.shipped_environment,
            text=True,
            capture_output=True,
            check=False,
        )

    def load_capture(self) -> Dict[str, object]:
        return json.loads(self.capture.read_text(encoding="utf-8"))

    def load_version_capture(self) -> Dict[str, object]:
        return json.loads(self.version_capture.read_text(encoding="utf-8"))

    def load_wrapper_capture(self) -> Dict[str, object]:
        return json.loads(self.wrapper_capture.read_text(encoding="utf-8"))

    def load_codex_capture(self) -> Dict[str, object]:
        return json.loads(self.codex_capture.read_text(encoding="utf-8"))

    def load_config(self) -> Dict[str, object]:
        return json.loads(self.config.read_text(encoding="utf-8"))

    def set_ambient_proxy_environment(self) -> None:
        self.environment.update({name: f"ambient-{name}" for name in PROXY_ENV_NAMES})
        self.environment[SAFE_ENV_NAME] = SAFE_ENV_VALUE

    def assert_proxy_boundary(self, environment: Dict[str, object]) -> None:
        for name in PROXY_ENV_NAMES:
            with self.subTest(environment_name=name):
                self.assertIsNone(environment[name])
        self.assertEqual(environment[SAFE_ENV_NAME], SAFE_ENV_VALUE)

    def save_config(self, value: Dict[str, object]) -> None:
        self.config.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")

    def configure_codex_commands(self) -> None:
        config = self.load_config()
        config["commands"].update(
            {
                "codex": str(self.codex),
                "with_one_password_token": str(self.wrapper),
            }
        )
        self.save_config(config)

    def configure_claude_commands(self) -> None:
        config = self.load_config()
        config["commands"].update({"claude": str(self.claude), "az": str(self.az)})
        self.save_config(config)

    def clear_codex_captures(self) -> None:
        self.wrapper_capture.unlink(missing_ok=True)
        self.codex_capture.unlink(missing_ok=True)

    def test_all_five_routes_use_exact_recipe_and_literal_native_suffix(self) -> None:
        self.environment["FAKE_EXIT"] = "17"
        for model_id, (resource_id, deployment, model_format, base_url) in TARGETS.items():
            with self.subTest(model_id=model_id):
                result = self.run_launcher(
                    "launch",
                    "--model",
                    model_id,
                    "--agent",
                    "opencode",
                    "--qualification",
                    "--",
                    "run",
                    "--prompt",
                    "literal arg with spaces",
                )
                self.assertEqual(result.returncode, 17, result.stderr)
                capture = self.load_capture()
                self.assertEqual(
                    capture["argv"],
                    [
                        "--model",
                        f"azure/{model_id}",
                        "run",
                        "--prompt",
                        "literal arg with spaces",
                    ],
                )
                self.assertEqual(capture["exec_path"], str(self.fake.resolve()))
                environment = capture["env"]
                self.assertEqual(environment["HOME"], str(Path.home()))
                self.assertEqual(environment["XDG_DATA_HOME"], str(self.native_data_home))
                self.assertEqual(environment["XDG_STATE_HOME"], str(self.native_state_home))
                self.assertEqual(environment["AZURE_CONFIG_DIR"], str((self.root / "azure-cache").resolve()))
                self.assertEqual(json.loads(environment["OPENCODE_AUTH_CONTENT"]), {"azure": {"type": "oauth"}})
                self.assertEqual(environment["OPENCODE_DISABLE_PROJECT_CONFIG"], "1")
                self.assertEqual(environment["HERDR_AGENT"], "opencode")
                self.assertIsNone(environment["OPENAI_API_KEY"])
                self.assertIsNone(environment["ANTHROPIC_API_KEY"])
                self.assertIsNone(environment["AZURE_OPENAI_API_KEY"])
                self.assertIsNone(environment["OPENCODE_MODEL"])
                self.assertNotEqual(environment["OPENCODE_CONFIG_DIR"], str(self.ambient_opencode))
                self.assertNotEqual(environment["XDG_CONFIG_HOME"], str(self.ambient_config_home))

                route_config = json.loads(environment["OPENCODE_CONFIG_CONTENT"])
                self.assertEqual(route_config["enabled_providers"], ["azure"])
                self.assertEqual(route_config["model"], f"azure/{model_id}")
                self.assertEqual(set(route_config["provider"]), {"azure"})
                self.assertEqual(route_config["plugin"], [self.herdr_server.resolve().as_uri()])
                self.assertEqual(route_config["permission"], "deny")
                self.assertEqual(route_config["agent"]["build"]["permission"]["read"], "allow")
                provider = route_config["provider"]["azure"]
                self.assertEqual(
                    provider["options"],
                    {"baseURL": base_url, "useCompletionUrls": True, "setCacheKey": False},
                )
                model_config = provider["models"][model_id]
                self.assertEqual(model_config["id"], deployment)
                if model_id == "kimi-k2.6":
                    self.assertEqual(model_config["options"], {"systemMessageMode": "system"})
                else:
                    self.assertNotIn("options", model_config)
                if model_id == "kimi-k2.7-code":
                    self.assertEqual(model_config["provider"], {"npm": "@ai-sdk/openai-compatible"})
                    self.assertTrue(model_config["reasoning"])
                    self.assertTrue(model_config["tool_call"])
                    self.assertEqual(model_config["interleaved"], {"field": "reasoning_content"})
                    self.assertNotIn("thinking", model_config)
                    self.assertNotIn("reasoningEffort", model_config)
                self.assertIn("native-stdout", result.stdout)
                self.assertIn("native-stderr", result.stderr)
                self.assertIn(f"agent=opencode", result.stderr)
                self.assertIn(f"deployment={deployment}", result.stderr)
                self.assertIn(f"resource={resource_id and (GPT_RESOURCE if resource_id == 'gpt' else CLAUDE_RESOURCE)}", result.stderr)

    def test_non_pure_route_keeps_herdr_custody_when_not_supplied(self) -> None:
        result = self.run_launcher(
            "launch",
            "--model",
            "gpt-5.4-nano",
            "--agent",
            "opencode",
            "--qualification",
            "--",
            "run",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.load_capture()["argv"], ["--model", "azure/gpt-5.4-nano", "run"])

    def test_frontend_identity_contract_exposes_the_exact_configured_opencode_path(self) -> None:
        result = self.run_launcher(
            "--dry-run",
            "launch",
            "--model",
            "gpt-5.4-nano",
            "--agent",
            "opencode",
            "--qualification",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"native_cli={self.fake.resolve()}", result.stdout)
        self.assertNotIn("--pure", result.stdout)

    def test_missing_herdr_integration_is_refused_before_native_child(self) -> None:
        self.herdr_server.unlink()
        result = self.run_launcher(
            "launch",
            "--model",
            "kimi-k2.7-code",
            "--agent",
            "opencode",
            "--qualification",
        )
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn("Herdr OpenCode integration", result.stderr)
        self.assertFalse(self.capture.exists())

    def test_pure_overrides_are_refused_before_version_or_native_child(self) -> None:
        for native_args in (
            ("run", "--pure"),
            ("run", "--pure=true"),
            ("run", "--pure=false"),
            ("run", "--no-pure"),
        ):
            with self.subTest(native_args=native_args):
                result = self.run_launcher(
                    "launch",
                    "--model",
                    "gpt-5.4-nano",
                    "--agent",
                    "opencode",
                    "--qualification",
                    "--",
                    *native_args,
                )
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("pure", result.stderr)
                self.assertFalse(self.capture.exists())
                self.assertFalse(self.version_capture.exists())

    def test_native_session_and_agent_selectors_are_refused_before_version_or_child(self) -> None:
        for native_args in (
            ("run", "--agent", "build"),
            ("run", "--session", "ses_ambient"),
            ("run", "-s", "ses_ambient"),
            ("run", "--continue"),
            ("run", "-c"),
            ("run", "--fork"),
        ):
            with self.subTest(native_args=native_args):
                result = self.run_launcher(
                    "launch",
                    "--model",
                    "gpt-5.4-nano",
                    "--agent",
                    "opencode",
                    "--qualification",
                    "--",
                    *native_args,
                )
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertRegex(result.stderr, "agent|session|continue|fork")
                self.assertFalse(self.capture.exists())
                self.assertFalse(self.version_capture.exists())

    def test_mismatched_or_arbitrary_herdr_agent_hint_is_not_forwarded_to_opencode(self) -> None:
        for hint in ("codex", "not-an-agent", ""):
            with self.subTest(hint=hint):
                self.environment["HERDR_AGENT"] = hint
                result = self.run_launcher(
                    "launch",
                    "--model",
                    "gpt-5.4-nano",
                    "--agent",
                    "opencode",
                    "--qualification",
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIsNone(self.load_capture()["env"]["HERDR_AGENT"])

    def test_herdr_agent_hint_survives_claude_settings_only_when_exact(self) -> None:
        self.configure_claude_commands()
        for hint, expected in (
            ("claude", "claude"),
            ("codex", ""),
            ("not-an-agent", ""),
            ("", ""),
        ):
            with self.subTest(hint=hint):
                self.claude_capture.unlink(missing_ok=True)
                self.environment["HERDR_AGENT"] = hint
                result = self.run_launcher("claude")
                self.assertEqual(result.returncode, 0, result.stderr)
                capture = json.loads(self.claude_capture.read_text(encoding="utf-8"))
                self.assertEqual(capture["settings"]["env"]["HERDR_AGENT"], expected)
                self.assertEqual(capture["env"], expected or None)

    def test_matching_herdr_agent_hint_survives_codex_wrapper_and_env_hop(self) -> None:
        self.configure_codex_commands()
        self.clear_codex_captures()
        self.environment["HERDR_AGENT"] = "codex"
        result = self.run_launcher("codex", "--", "--resume")
        self.assertEqual(result.returncode, 0, result.stderr)

        wrapper = self.load_wrapper_capture()
        self.assertEqual(wrapper["env"]["HERDR_AGENT"], "codex")
        self.assertIn("HERDR_AGENT=codex", wrapper["argv"])
        self.assertIsNone(wrapper["env"]["OPENAI_API_KEY"])

        native = self.load_codex_capture()
        self.assertEqual(native["env"]["HERDR_AGENT"], "codex")
        self.assertIsNone(native["env"]["OPENAI_API_KEY"])
        self.assertIsNone(native["env"]["AZURE_OPENAI_API_KEY"])

    def test_mismatched_or_arbitrary_herdr_agent_hint_dies_at_codex_wrapper_boundary(self) -> None:
        self.configure_codex_commands()
        for hint in ("opencode", "not-an-agent", ""):
            with self.subTest(hint=hint):
                self.clear_codex_captures()
                self.environment["HERDR_AGENT"] = hint
                result = self.run_launcher("codex", "--", "--resume")
                self.assertEqual(result.returncode, 0, result.stderr)
                wrapper = self.load_wrapper_capture()
                native = self.load_codex_capture()
                self.assertIsNone(wrapper["env"]["HERDR_AGENT"])
                self.assertFalse(any(argument == "HERDR_AGENT=codex" for argument in wrapper["argv"]))
                self.assertIsNone(native["env"]["HERDR_AGENT"])

    def test_attach_and_direct_remote_server_overrides_refuse_before_version_or_child(self) -> None:
        for native_args in (
            ("run", "--attach", "https://remote.example"),
            ("run", "--attach=https://remote.example"),
            ("attach", "https://remote.example"),
        ):
            with self.subTest(native_args=native_args):
                result = self.run_launcher(
                    "launch",
                    "--model",
                    "gpt-5.4-nano",
                    "--agent",
                    "opencode",
                    "--qualification",
                    "--",
                    *native_args,
                )
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("attach", result.stderr)
                self.assertFalse(self.capture.exists())
                self.assertFalse(self.version_capture.exists())

    def test_launch_version_probe_uses_sanitized_environment(self) -> None:
        result = self.run_launcher(
            "launch",
            "--model",
            "gpt-5.4-nano",
            "--agent",
            "opencode",
            "--qualification",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        version_capture = self.load_version_capture()
        self.assertEqual(version_capture["exec_path"], str(self.fake.resolve()))
        self.assertEqual(version_capture["argv"], ["--version"])
        environment = version_capture["env"]
        self.assertEqual(environment["HOME"], str(Path.home()))
        self.assertEqual(environment["AZURE_CONFIG_DIR"], str((self.root / "azure-cache").resolve()))
        self.assertEqual(json.loads(environment["OPENCODE_AUTH_CONTENT"]), {"azure": {"type": "oauth"}})
        self.assertEqual(json.loads(environment["OPENCODE_CONFIG_CONTENT"])["model"], "azure/gpt-5.4-nano")
        self.assertNotEqual(environment["OPENCODE_CONFIG_DIR"], str(self.ambient_opencode))
        self.assertEqual(environment["OPENCODE_DISABLE_PROJECT_CONFIG"], "1")
        self.assertEqual(environment["HERDR_AGENT"], "opencode")
        self.assertIsNone(environment["OPENAI_API_KEY"])
        self.assertIsNone(environment["ANTHROPIC_API_KEY"])
        self.assertIsNone(environment["AZURE_OPENAI_API_KEY"])

    def test_proxy_routing_variables_are_absent_from_probe_and_native_child(self) -> None:
        self.set_ambient_proxy_environment()
        result = self.run_launcher(
            "launch",
            "--model",
            "gpt-5.4-nano",
            "--agent",
            "opencode",
            "--qualification",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_proxy_boundary(self.load_version_capture()["env"])
        self.assert_proxy_boundary(self.load_capture()["env"])

    def test_check_version_probe_uses_sanitized_environment(self) -> None:
        config = self.load_config()
        config["commands"].update(
            {
                "codex": str(self.noop),
                "with_one_password_token": str(self.noop),
                "claude": str(self.noop),
                "az": str(self.fail_script),
            }
        )
        self.save_config(config)
        result = self.run_launcher("check")
        self.assertEqual(result.returncode, 3)
        self.assertIn("opencode=ready", result.stdout)
        version_capture = self.load_version_capture()
        self.assertEqual(version_capture["argv"], ["--version"])
        environment = version_capture["env"]
        self.assertEqual(environment["HOME"], str(Path.home()))
        self.assertEqual(environment["AZURE_CONFIG_DIR"], str(self.root / "azure-cache"))
        self.assertIsNone(environment["OPENCODE_CONFIG_DIR"])
        self.assertIsNone(environment["OPENCODE_AUTH_CONTENT"])
        self.assertIsNone(environment["OPENCODE_CONFIG_CONTENT"])
        self.assertIsNone(environment["OPENAI_API_KEY"])
        self.assertIsNone(environment["ANTHROPIC_API_KEY"])
        self.assertIsNone(environment["AZURE_OPENAI_API_KEY"])

    def test_version_below_minimum_refuses_before_native_child(self) -> None:
        self.environment["FAKE_VERSION"] = "1.18.23"
        result = self.run_launcher(
            "launch",
            "--model",
            "gpt-5.4-nano",
            "--agent",
            "opencode",
            "--qualification",
        )
        self.assertEqual(result.returncode, 3)
        self.assertIn("lacks the native Azure OAuth route", result.stderr)
        self.assertIn("1.18.27", result.stderr)
        self.assertFalse(self.capture.exists())
        self.assertTrue(self.version_capture.exists())

    def test_native_model_override_refuses_before_version_or_child(self) -> None:
        result = self.run_launcher(
            "launch",
            "--model",
            "gpt-5.4-nano",
            "--agent",
            "opencode",
            "--qualification",
            "--",
            "run",
            "--model",
            "azure/other",
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("native --model", result.stderr)
        self.assertFalse(self.capture.exists())
        self.assertFalse(self.version_capture.exists())

    def test_endpoint_mismatch_refuses_before_native_child(self) -> None:
        config = self.load_config()
        config["opencode"]["resources"]["gpt"]["resource"] = "different-resource"
        self.save_config(config)
        result = self.run_launcher(
            "launch",
            "--model",
            "gpt-5.4-nano",
            "--agent",
            "opencode",
            "--qualification",
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("OpenCode endpoint for gpt", result.stderr)
        self.assertFalse(self.capture.exists())
        self.assertFalse(self.version_capture.exists())

    def test_stale_selected_resource_refuses_before_native_child(self) -> None:
        config = self.load_config()
        config["inventory"]["resources"][0]["availability"] = "stale"
        config["inventory"]["resources"][0]["observed"] = False
        self.save_config(config)
        result = self.run_launcher(
            "launch",
            "--model",
            "gpt-5.4-nano",
            "--agent",
            "opencode",
            "--qualification",
        )
        self.assertEqual(result.returncode, 3)
        self.assertIn("not available", result.stderr)
        self.assertFalse(self.capture.exists())
        self.assertFalse(self.version_capture.exists())

    def test_untested_route_requires_explicit_qualification(self) -> None:
        result = self.run_launcher(
            "launch",
            "--model",
            "gpt-5.4-nano",
            "--agent",
            "opencode",
        )
        self.assertEqual(result.returncode, 3)
        self.assertIn("pass --qualification", result.stderr)
        self.assertFalse(self.capture.exists())
        self.assertFalse(self.version_capture.exists())

    def test_qualified_production_route_omits_qualification_fixture_permissions(self) -> None:
        config = self.load_config()
        model = next(model for model in config["inventory"]["models"] if model["id"] == "gpt-5.4-nano")
        route = next(route for route in model["routes"] if route["agent"] == "opencode")
        route["status"] = "qualified"
        self.save_config(config)
        result = self.run_launcher(
            "launch",
            "--model",
            "gpt-5.4-nano",
            "--agent",
            "opencode",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        route_config = json.loads(self.load_capture()["env"]["OPENCODE_CONFIG_CONTENT"])
        self.assertNotIn("permission", route_config)
        self.assertNotIn("agent", route_config)

    def test_models_json_is_pure_and_lists_five_untested_opencode_routes(self) -> None:
        result = self.run_launcher("models", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["schema_version"], 1)
        self.assertEqual([model["id"] for model in payload["models"]], list(MODEL_IDS))
        opencode_routes = {
            model["id"]: next(route for route in model["routes"] if route["agent"] == "opencode")
            for model in payload["models"]
        }
        for model_id in TARGETS:
            self.assertEqual(opencode_routes[model_id]["status"], "untested")
            self.assertTrue(opencode_routes[model_id]["implemented"])
            self.assertEqual(opencode_routes[model_id]["compatibility"], "compatible")
        self.assertFalse(self.capture.exists())

    def test_shipped_config_pins_opencode_routes_and_refuses_other_models(self) -> None:
        models_result = self.run_shipped_launcher("models", "--json")
        self.assertEqual(models_result.returncode, 0, models_result.stderr)
        payload = json.loads(models_result.stdout)
        self.assertEqual(payload["schema_version"], 1)
        self.assertEqual([model["id"] for model in payload["models"]], list(MODEL_IDS))
        models = {model["id"]: model for model in payload["models"]}
        self.assertEqual(set(models), set(SHIPPED_OPENCODE_ROUTES) | set(SHIPPED_OPENCODE_REFUSALS))

        for model_id, expected in SHIPPED_OPENCODE_ROUTES.items():
            with self.subTest(model_id=model_id):
                model = models[model_id]
                route = next(route for route in model["routes"] if route["agent"] == "opencode")
                self.assertEqual(
                    {
                        "status": route["status"],
                        "implemented": route["implemented"],
                        "compatibility": route["compatibility"],
                        "binding_resource_id": route["binding_resource_id"],
                    },
                    {
                        "status": expected["status"],
                        "implemented": True,
                        "compatibility": "compatible",
                        "binding_resource_id": expected["resource_id"],
                    },
                )
                expected_evidence = [
                    SHIPPED_LAPTOP_QUALIFICATION_EVIDENCE[model_id],
                    SHIPPED_MINI_QUALIFICATION_EVIDENCE[model_id],
                ]
                self.assertEqual(route["evidence"], expected_evidence)
                binding = next(
                    binding
                    for binding in model["bindings"]
                    if binding["resource_id"] == expected["resource_id"]
                    and binding["protocol"] == expected["protocol"]
                )
                self.assertEqual(binding["resource"], expected["resource"])
                self.assertEqual(binding["deployment"], expected["deployment"])
                self.assertEqual(binding["model_format"], expected["model_format"])

        qualified_model_ids = tuple(
            model_id
            for model_id, expected in SHIPPED_OPENCODE_ROUTES.items()
            if expected["status"] == "qualified"
        )
        self.assertEqual(
            qualified_model_ids,
            ("gpt-5.4-nano", "deepseek-v4-pro", "deepseek-v4-flash", "kimi-k2.7-code", "kimi-k2.6"),
        )
        untested_model_ids = tuple(
            model_id
            for model_id, expected in SHIPPED_OPENCODE_ROUTES.items()
            if expected["status"] == "untested"
        )
        self.assertEqual(untested_model_ids, ())

        production = self.run_shipped_launcher(
            "launch",
            "--model",
            "kimi-k2.7-code",
            "--agent",
            "opencode",
        )
        self.assertEqual(production.returncode, 0, production.stderr)
        self.assertIn("agent=opencode", production.stderr)
        self.assertIn("deployment=Kimi-K2.7-Code", production.stderr)
        self.assertNotIn("qualification=explicit", production.stderr)
        self.assertEqual(self.load_capture()["argv"], ["--model", "azure/kimi-k2.7-code"])
        production_config = json.loads(self.load_capture()["env"]["OPENCODE_CONFIG_CONTENT"])
        self.assertNotIn("permission", production_config)
        self.assertNotIn("agent", production_config)

        for model_id in untested_model_ids:
            with self.subTest(model_id=model_id, qualification="required"):
                refused = self.run_shipped_launcher(
                    "launch",
                    "--model",
                    model_id,
                    "--agent",
                    "opencode",
                )
                self.assertEqual(refused.returncode, 3, refused.stderr)
                self.assertIn("pass --qualification", refused.stderr)
                self.assertFalse(self.capture.exists())
                self.assertFalse(self.version_capture.exists())

                qualified = self.run_shipped_launcher(
                    "launch",
                    "--model",
                    model_id,
                    "--agent",
                    "opencode",
                    "--qualification",
                )
                self.assertEqual(qualified.returncode, 0, qualified.stderr)
                qualification_config = json.loads(self.load_capture()["env"]["OPENCODE_CONFIG_CONTENT"])
                self.assertEqual(qualification_config["permission"], "deny")
                self.assertEqual(qualification_config["agent"]["build"]["permission"]["read"], "allow")

        for model_id in SHIPPED_OPENCODE_REFUSALS:
            with self.subTest(model_id=model_id):
                result = self.run_shipped_launcher(
                    "launch",
                    "--model",
                    model_id,
                    "--agent",
                    "opencode",
                )
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("incompatible with opencode", result.stderr)
                self.assertNotIn("native_cli=", result.stdout)
                self.assertNotIn("version", result.stderr.casefold())

    def test_unsupported_model_recipe_refuses_even_when_route_flags_are_mutable(self) -> None:
        config = self.load_config()
        gpt55 = next(model for model in config["inventory"]["models"] if model["id"] == "gpt-5.5")
        gpt55["bindings"].append(binding("gpt", "gpt-5.5", "OpenAI", "azure-openai-chat-completions"))
        unsupported_route = next(route for route in gpt55["routes"] if route["agent"] == "opencode")
        unsupported_route.update(
            {
                "implemented": True,
                "compatibility": "compatible",
                "binding_resource_id": "gpt",
            }
        )
        self.save_config(config)
        result = self.run_launcher(
            "launch",
            "--model",
            "gpt-5.5",
            "--agent",
            "opencode",
            "--qualification",
        )
        self.assertEqual(result.returncode, 3)
        self.assertIn("no documented OpenCode native recipe", result.stderr)
        self.assertFalse(self.capture.exists())
        self.assertFalse(self.version_capture.exists())


if __name__ == "__main__":
    unittest.main()
