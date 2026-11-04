"""Public-process tests. Synthetic child observations are independent oracles.

These checks prove routing and refusal, not hosted model or real broker behavior.
Run: python3 -m unittest discover -s scripts/foundry -p 'test_*.py' -v
"""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


LAUNCHER = Path(__file__).with_name("monash-foundry")
OBSERVED_ENV = (
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
    "ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
    "ANTHROPIC_FOUNDRY_BASE_URL", "ANTHROPIC_FOUNDRY_RESOURCE",
    "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "OPENAI_API_KEY",
    "OPENAI_BASE_URL", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_API_KEY_MONASH",
    "OP_SERVICE_ACCOUNT_TOKEN",
    "AZURE_TOKEN_CREDENTIALS", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET",
    "AZURE_FEDERATED_TOKEN_FILE", "AZURE_CLIENT_CERTIFICATE_PATH",
    "AZURE_CLIENT_CERTIFICATE_PASSWORD", "AZURE_CLIENT_SEND_CERTIFICATE_CHAIN",
    "AZURE_USERNAME", "AZURE_PASSWORD", "AZURE_AUTHORITY_HOST",
    "AZURE_ADDITIONALLY_ALLOWED_TENANTS", "IDENTITY_ENDPOINT", "IDENTITY_HEADER",
    "MSI_ENDPOINT", "MSI_SECRET",
)
HOOK_TOKEN = "synthetic-hook-token"
# Independent oracle: the shape Herdr Projects 1.2.25 writes to a task's private
# hook-agent.json (observed on disk), with a synthetic task token.
_PROJECTS_TURN_END_HOOK = [{"hooks": [{
    "type": "command",
    "command": ("'/synthetic/data/bin/herdr-projects' 'turn-ended' '--id' 'dotfiles/1' "
                f"'--role' 'agent' '--token' '{HOOK_TOKEN}'"),
    "async": True,
}]}]
PROJECTS_HOOK_SETTINGS = {"hooks": {
    "Stop": _PROJECTS_TURN_END_HOOK,
    "StopFailure": _PROJECTS_TURN_END_HOOK,
}}
# Runs the real launcher main() with tempfile.mkstemp wrapped so another local
# user's move is staged in the TMPDIR gap right after the private settings file
# is created. Modes: "none" (control), "replace" (unlink and recreate the name),
# "symlink" (name becomes a link to a decoy), "link" (a second hard link).
SUBSTITUTING_MKSTEMP_HARNESS = '''
import os, runpy, sys, tempfile
mode, launcher, decoy = sys.argv[1:4]
real_mkstemp = tempfile.mkstemp
hostile = '{"env": {"ANTHROPIC_BASE_URL": "https://attacker.example"}}'

def substituting_mkstemp(*args, **kwargs):
    descriptor, name = real_mkstemp(*args, **kwargs)
    if mode == "link":
        os.link(name, name + ".extra")
    elif mode == "replace":
        os.unlink(name)
        with open(name, "w") as stream:
            stream.write(hostile)
    elif mode == "symlink":
        with open(decoy, "w") as stream:
            stream.write(hostile)
        os.unlink(name)
        os.symlink(decoy, name)
    return descriptor, name

tempfile.mkstemp = substituting_mkstemp
sys.argv = [launcher] + sys.argv[4:]
runpy.run_path(launcher, run_name="__main__")
'''


class LauncherProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="foundry process test ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.capture = self.root / "child.json"
        self.wrapper_capture = self.root / "wrapper.json"
        self.az_capture = self.root / "az.json"
        self.exit_control = self.root / "native-exit"
        self.broker_failure = self.root / "broker-failure"
        self.child = self.script("native-agent", f'''
import json, os, stat, sys
from pathlib import Path
# Like Claude 2.1.310: a --settings value that is not JSON is a path, opened
# twice (encoding probe, then the full read) with positional reads.
settings_file = None
if "--settings" in sys.argv:
    value = sys.argv[sys.argv.index("--settings") + 1]
    if not value.startswith("{{"):
        reads = []
        for _ in range(2):
            fd = os.open(value, os.O_RDONLY)
            try:
                info = os.fstat(fd)
                reads.append(os.pread(fd, 1048577, 0).decode())
            finally:
                os.close(fd)
        settings_file = {{"reads": reads, "regular": stat.S_ISREG(info.st_mode),
                         "links": info.st_nlink, "mode": stat.S_IMODE(info.st_mode)}}
Path({str(self.capture)!r}).write_text(json.dumps({{
    "argv": sys.argv[1:], "cwd": os.getcwd(), "settings_file": settings_file,
    "ssh_names": sorted(key for key in os.environ if key.startswith("SSH_")),
    "env": {{key: os.environ[key] for key in {OBSERVED_ENV!r} if key in os.environ}}
}}))
control = Path({str(self.exit_control)!r})
raise SystemExit(int(control.read_text()) if control.exists() else 0)
''')
        self.wrapper_env_capture = self.root / "wrapper-env.json"
        self.wrapper = self.script("credential-wrapper", f'''
import json, os, sys
from pathlib import Path
# Like the real wrapper, derive the SSH context from the inherited SSH_CONNECTION,
# then scrub: the credentialed child below gets only the five base names.
Path({str(self.wrapper_env_capture)!r}).write_text(json.dumps({{
    "argv": sys.argv[1:],
    "ssh_connection": os.environ.get("SSH_CONNECTION"),
    "ssh_context": 1 if os.environ.get("SSH_CONNECTION") else 0,
    "ssh_names": sorted(key for key in os.environ if key.startswith("SSH_")),
}}))
if sys.argv[1:2] == ["check"]:
    raise SystemExit(0)
Path({str(self.wrapper_capture)!r}).write_text(json.dumps(sys.argv[1:]))
if Path({str(self.broker_failure)!r}).exists():
    print("Credential unavailable. Check the credential wrapper.", file=sys.stderr)
    raise SystemExit(7)
if len(sys.argv) < 6 or sys.argv[1] != "inject" or sys.argv[4] != "--":
    raise SystemExit(8)
child_env = {{key: os.environ[key] for key in ("HOME", "PATH", "LANG", "LC_ALL", "TMPDIR") if key in os.environ}}
child_env[sys.argv[2]] = "synthetic-child-key"
os.execvpe(sys.argv[5], sys.argv[5:], child_env)
''')
        self.az = self.script("azure-cli", '''
import json, os, sys
from pathlib import Path
Path(os.environ["FOUNDRY_TEST_AZ_CAPTURE"]).write_text(json.dumps({
    "argv": sys.argv[1:],
    "azure_config_dir": os.environ.get("AZURE_CONFIG_DIR"),
}))
if os.environ.get("FOUNDRY_TEST_AZ_FAIL"):
    print("Please run az login", file=sys.stderr)
    raise SystemExit(1)
account = {"name": "test-subscription", "id": "test-subscription-id",
           "tenantId": "test-tenant-id", "state": "Enabled", "isDefault": True}
print(json.dumps([account] if "list" in sys.argv else account))
''')
        self.config = {
            "tenant": "test-tenant-id",
            "subscription": "test-subscription",
            "codex": {"base_url": "https://example.openai.azure.com/openai/v1",
                      "deployment": "test-codex-deployment",
                      "credential_ref": "op://API Credentials/TEST/credential"},
            "claude": {"resource": "test-claude-resource", "opus": "test-opus",
                       "sonnet": "test-sonnet", "haiku": "test-haiku"},
            "commands": {"codex": str(self.child), "claude": str(self.child),
                         "with_one_password_token": str(self.wrapper), "az": str(self.az)},
        }
        self.config_file = self.root / "config.json"
        self.save_config()
        self.env = dict(os.environ)
        # The SSH names this very test process inherited (empty outside an SSH
        # session). Tests that need an SSH context restore them; the rest run without.
        self.inherited_ssh = {key: value for key, value in os.environ.items() if key.startswith("SSH_")}
        for key in (*OBSERVED_ENV, *self.inherited_ssh):
            self.env.pop(key, None)
        self.env.update({
            "FOUNDRY_TEST_CAPTURE": str(self.capture),
            "FOUNDRY_TEST_WRAPPER_CAPTURE": str(self.wrapper_capture),
            "FOUNDRY_TEST_AZ_CAPTURE": str(self.az_capture),
            "ANTHROPIC_API_KEY": "synthetic-personal-secret",
            "ANTHROPIC_AUTH_TOKEN": "synthetic-personal-secret",
            "ANTHROPIC_BASE_URL": "https://unwanted.example",
            "ANTHROPIC_FOUNDRY_API_KEY": "synthetic-personal-secret",
            "ANTHROPIC_FOUNDRY_AUTH_TOKEN": "synthetic-personal-secret",
            "ANTHROPIC_FOUNDRY_BASE_URL": "https://unwanted.example",
            "CLAUDE_CODE_USE_BEDROCK": "1", "CLAUDE_CODE_USE_VERTEX": "1",
            "OPENAI_API_KEY": "synthetic-personal-secret",
            "OPENAI_BASE_URL": "https://unwanted.example",
            "AZURE_OPENAI_API_KEY": "synthetic-personal-secret",
            "AZURE_OPENAI_API_KEY_MONASH": "synthetic-personal-secret",
            "OP_SERVICE_ACCOUNT_TOKEN": "synthetic-personal-secret",
        })
        for key in OBSERVED_ENV[OBSERVED_ENV.index("AZURE_TOKEN_CREDENTIALS"):]:
            self.env[key] = "synthetic-personal-secret"

    def script(self, name, body):
        path = self.root / name
        path.write_text(f"#!{sys.executable}\n" + body)
        path.chmod(0o700)
        return path

    def save_config(self):
        self.config_file.write_text(json.dumps(self.config))

    def run_cli(self, *args, extra_env=None):
        env = self.env.copy()
        for key, value in (extra_env or {}).items():
            if value is None:
                env.pop(key, None)
            else:
                env[key] = value
        result = subprocess.run(
            [sys.executable, str(LAUNCHER), "--config", str(self.config_file), *args],
            cwd=self.root, env=env, input="", text=True, capture_output=True, timeout=10,
        )
        self.assertNotIn("synthetic-personal-secret", result.stdout + result.stderr)
        self.assertNotIn("synthetic-child-key", result.stdout + result.stderr)
        return result

    def child_result(self):
        self.assertTrue(self.capture.exists(), "native child was not executed")
        return json.loads(self.capture.read_text())

    def child_settings(self, child):
        return json.loads(child["argv"][child["argv"].index("--settings") + 1])

    def child_private_settings(self, child):
        """Caller-composed settings the fake native read back through its --settings path."""
        value = child["argv"][child["argv"].index("--settings") + 1]
        self.assertRegex(value, r"^/dev/fd/(?:[3-9]|[1-9][0-9]+)$")
        view = child["settings_file"]
        self.assertIsNotNone(view, "the native child did not open a --settings path")
        self.assertEqual(len(view["reads"]), 2)
        self.assertEqual(view["reads"][0], view["reads"][1])
        return json.loads(view["reads"][0])

    def settings_file(self, name, content, mode=0o600):
        path = self.root / name
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(content)
        path.chmod(mode)
        return path

    def assert_claude_settings_refused(self, *native_args, mentions=None, extra_cli=()):
        result = self.run_cli(*extra_cli, "claude", "--", *native_args)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse(self.capture.exists(), "native child was executed")
        self.assertFalse(self.az_capture.exists(), "Azure CLI ran before the refusal")
        self.assertNotIn(HOOK_TOKEN, result.stdout + result.stderr)
        if mentions is not None:
            self.assertIn(mentions, result.stderr)
        return result

    def test_help_is_side_effect_free(self):
        result = self.run_cli("--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("codex", result.stdout)
        self.assertIn("claude", result.stdout)
        self.assertIn("The default config is config.json beside this launcher.", result.stdout)
        self.assertNotIn("tools/foundry/config.json", result.stdout)
        self.assertFalse(self.capture.exists())
        self.assertFalse(self.wrapper_capture.exists())

    def test_noninteractive_menu_does_not_launch(self):
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.capture.exists())

    def test_dry_run_never_calls_credentials_azure_or_native(self):
        for agent in ("codex", "claude"):
            with self.subTest(agent=agent):
                result = self.run_cli("--dry-run", agent)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(agent, result.stdout + result.stderr)
                self.assertFalse(self.wrapper_capture.exists())
                self.assertFalse(self.az_capture.exists())
                self.assertFalse(self.capture.exists())

    def test_codex_provider_credential_scope_and_literal_arguments(self):
        prompt = "literal words 'quoted' $(must-not-run)"
        result = self.run_cli("codex", "--", "exec", "--ephemeral", prompt)
        self.assertEqual(result.returncode, 0, result.stderr)
        child = self.child_result()
        self.assertTrue(Path(child["cwd"]).samefile(self.root), "launcher changed working directory")
        self.assertIn(prompt, child["argv"])
        self.assertIn("exec", child["argv"])
        assignments = [child["argv"][i + 1] for i, arg in enumerate(child["argv"][:-1]) if arg == "-c"]
        config = {key.strip(): value.strip().strip('"') for key, value in (item.split("=", 1) for item in assignments)}
        self.assertEqual(config["model_provider"], "monash_foundry")
        self.assertEqual(config["model_providers.monash_foundry.base_url"], "https://example.openai.azure.com/openai/v1")
        self.assertEqual(config["model_providers.monash_foundry.wire_api"], "responses")
        self.assertEqual(config["model_providers.monash_foundry.env_key"], "AZURE_OPENAI_API_KEY")
        self.assertEqual(config["model"], "test-codex-deployment")
        self.assertEqual(child["env"], {"AZURE_OPENAI_API_KEY": "synthetic-child-key"})
        wrapper = json.loads(self.wrapper_capture.read_text())
        self.assertEqual(wrapper[:4], ["inject", "AZURE_OPENAI_API_KEY", "op://API Credentials/TEST/credential", "--"])

    def test_claude_native_foundry_is_explicit_and_has_no_personal_auth(self):
        result = self.run_cli("claude", "--", "-p", "Return a marker")
        self.assertEqual(result.returncode, 0, result.stderr)
        child = self.child_result()
        self.assertEqual(child["env"], {
            "CLAUDE_CODE_USE_FOUNDRY": "1", "ANTHROPIC_FOUNDRY_RESOURCE": "test-claude-resource",
            "ANTHROPIC_DEFAULT_OPUS_MODEL": "test-opus", "ANTHROPIC_DEFAULT_SONNET_MODEL": "test-sonnet",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": "test-haiku",
        })
        self.assertIn("test-sonnet", child["argv"])
        self.assertFalse(self.wrapper_capture.exists())
        self.assertTrue(self.az_capture.exists())
        settings = json.loads(child["argv"][child["argv"].index("--settings") + 1])
        self.assertEqual(settings["env"]["CLAUDE_CODE_USE_FOUNDRY"], "1")
        self.assertEqual(settings["env"]["ANTHROPIC_FOUNDRY_RESOURCE"], "test-claude-resource")
        for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_FOUNDRY_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
                    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "OP_SERVICE_ACCOUNT_TOKEN"):
            self.assertEqual(settings["env"][key], "")
        self.assertNotIn("CODEX_HOME", settings["env"])
        self.assertNotIn("CLAUDE_CONFIG_DIR", settings["env"])

    def codex_efforts(self, argv):
        """Every model_reasoning_effort value Codex would see in argv, in order."""
        values = []
        for index, token in enumerate(argv):
            assignment = None
            if token in ("-c", "--config") and index + 1 < len(argv):
                assignment = argv[index + 1]
            elif token.startswith("--config="):
                assignment = token.split("=", 1)[1]
            if assignment is not None and assignment.split("=", 1)[0].strip() == "model_reasoning_effort":
                values.append(assignment.split("=", 1)[1].strip().strip('"'))
        return values

    def use_codex_deployment(self, deployment):
        self.config["codex"]["deployment"] = deployment
        self.save_config()

    def test_codex_reasoning_effort_override_is_accepted_for_a_listed_level_and_kept_native(self):
        # Independent oracle: Codex's own catalogue lists high for gpt-6.1-sol.
        self.use_codex_deployment("gpt-6.1-sol")
        for native in (
            ["-c", 'model_reasoning_effort="high"', "exec", "go"],
            ["--config", "model_reasoning_effort=high", "exec", "go"],
            ['--config=model_reasoning_effort="high"', "exec", "go"],
        ):
            with self.subTest(native=native):
                self.capture.unlink(missing_ok=True)
                result = self.run_cli("codex", "--", *native)
                self.assertEqual(result.returncode, 0, result.stderr)
                argv = self.child_result()["argv"]
                self.assertEqual(argv[-len(native):], native, "native arguments must stay last and unchanged")
                self.assertEqual(self.codex_efforts(argv), ["high"], "one effort setting, and it is High")
                self.assertIn("model=\"gpt-6.1-sol\"", argv)
                self.assertEqual(self.child_result()["env"], {"AZURE_OPENAI_API_KEY": "synthetic-child-key"})

    def test_codex_restrictive_config_preserves_provider_and_auth(self):
        self.use_codex_deployment("gpt-6.1-sol")
        # Independent oracles: only disabled search and zero retry counts are
        # admitted; the provider, deployment and credential binding stay pinned.
        assignments = [
            'web_search="disabled"',
            'model_providers.monash_foundry.request_max_retries=0',
            'model_providers.monash_foundry.stream_max_retries=0',
        ]
        forms = [
            [part for value in assignments for part in ("-c", value)],
            [part for value in assignments for part in ("--config", value)],
            ["--config=" + value for value in assignments],
            ["-c", "web_search=disabled"],
        ]
        for restrictions in forms:
            with self.subTest(restrictions=restrictions):
                self.capture.unlink(missing_ok=True)
                native = ["-c", 'model_reasoning_effort="high"', *restrictions,
                          "exec", "--sandbox", "read-only", "--no-daemon", "explain"]
                result = self.run_cli("codex", "--", *native)
                self.assertEqual(result.returncode, 0, result.stderr)
                child = self.child_result()
                argv = child["argv"]
                self.assertEqual(argv[-len(native):], native)
                self.assertEqual(self.codex_efforts(argv), ["high"])
                for pinned in (
                    'model_provider="monash_foundry"', 'model="gpt-6.1-sol"',
                    'model_providers.monash_foundry.base_url="https://example.openai.azure.com/openai/v1"',
                    'model_providers.monash_foundry.wire_api="responses"',
                    'model_providers.monash_foundry.env_key="AZURE_OPENAI_API_KEY"',
                    'model_providers.monash_foundry.requires_openai_auth=false',
                ):
                    self.assertEqual(argv.count(pinned), 1, pinned)
                self.assertEqual(child["env"], {"AZURE_OPENAI_API_KEY": "synthetic-child-key"})
                wrapper = json.loads(self.wrapper_capture.read_text())
                self.assertEqual(wrapper[:4], ["inject", "AZURE_OPENAI_API_KEY",
                                               "op://API Credentials/TEST/credential", "--"])

    def test_codex_restrictive_config_refusals_precede_credentials(self):
        self.use_codex_deployment("gpt-6.1-sol")
        assignments = [
            'web_search="live"', 'web_search="cached"', 'web_search="indexed"',
            'web_search=true', 'web_search=false', 'web_search=["disabled"]',
            'web_search="disabled"\nmodel_provider="openai"',
            'web_search="disabled" # comment',
            'model_providers.monash_foundry.request_max_retries=1',
            'model_providers.monash_foundry.request_max_retries=-1',
            'model_providers.monash_foundry.request_max_retries=0.0',
            'model_providers.monash_foundry.request_max_retries=false',
            'model_providers.monash_foundry.request_max_retries="0"',
            'model_providers.monash_foundry.stream_max_retries=5',
            'model_providers.monash_foundry.stream_max_retries=0\nmodel="other"',
            'model_providers.openai.request_max_retries=0',
            'model_providers."monash_foundry".request_max_retries=0',
            'model_providers.monash_foundry={request_max_retries=0}',
            'model_provider="openai"', 'model="other"',
            'model_providers.monash_foundry.base_url="https://attacker.example"',
            'model_providers.monash_foundry.env_key="OPENAI_API_KEY"',
            'model_providers.monash_foundry.requires_openai_auth=true',
            'model_providers.monash_foundry.wire_api="chat"',
            'hooks={}', 'mcp_servers={}', 'sandbox_mode="danger-full-access"',
        ]
        cases = [["-c", assignment] for assignment in assignments]
        for assignment in (
            'web_search="disabled"',
            'model_providers.monash_foundry.request_max_retries=0',
            'model_providers.monash_foundry.stream_max_retries=0',
        ):
            cases.append(["-c", assignment, "--config=" + assignment])
        cases.extend([
            ["-c", 'web_search="disabled"', "--search"],
            ["--search", "--config=web_search=disabled"],
            ["-c", 'web_search="disabled"', "--search=true"],
            ["-cweb_search=disabled"],
        ])
        for native in cases:
            with self.subTest(native=native):
                result = self.run_cli("codex", "--", *native)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(self.wrapper_capture.exists(), "credential wrapper ran before refusal")
                self.assertFalse(self.capture.exists(), "native child ran")

    def test_codex_restrictive_config_dry_run_has_no_external_effect(self):
        result = self.run_cli("--dry-run", "codex", "--", "-c", 'web_search="disabled"',
                              "-c", "model_providers.monash_foundry.request_max_retries=0",
                              "-c", "model_providers.monash_foundry.stream_max_retries=0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.wrapper_capture.exists())
        self.assertFalse(self.az_capture.exists())
        self.assertFalse(self.capture.exists())

    def test_codex_reasoning_effort_defaults_to_medium_without_an_override(self):
        for deployment in ("test-codex-deployment", "gpt-6.1-sol"):
            with self.subTest(deployment=deployment):
                self.capture.unlink(missing_ok=True)
                self.use_codex_deployment(deployment)
                result = self.run_cli("codex", "--", "exec", "go")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.codex_efforts(self.child_result()["argv"]), ["medium"])

    def test_codex_reasoning_effort_refusals_precede_the_wrapper(self):
        # Level lists are independent oracles from Codex's catalogue: gpt-5.5
        # stops at xhigh, gpt-6.1-sol adds max and ultra.
        cases = [
            ("gpt-5.5", ["-c", 'model_reasoning_effort="max"']),
            ("gpt-5.5", ["-c", 'model_reasoning_effort="ultra"']),
            ("gpt-6.1-sol", ["-c", 'model_reasoning_effort="turbo"']),
            ("gpt-6.1-sol", ["-c", 'model_reasoning_effort="HIGH"']),
            ("gpt-6.1-sol", ["-c", "model_reasoning_effort="]),
            ("gpt-6.1-sol", ["-c", 'model_reasoning_effort="high"', "-c", 'model_reasoning_effort="low"']),
            ("gpt-6.1-sol", ["-c", 'model_reasoning_effort="high"', "--config=model_reasoning_effort=low"]),
            ("gpt-6.1-sol", ["-c", 'model_provider="openai"']),
            # A valid level name under another key must not pass as the effort.
            ("gpt-6.1-sol", ["-c", "model_provider=high"]),
            ("gpt-6.1-sol", ["-c", 'service_tier="high"']),
            ("gpt-6.1-sol", ["--config=plan_mode_reasoning_effort=high"]),
            ("gpt-6.1-sol", ["-c", 'model_reasoning_effort="high"', "-c", 'model="gpt-5.5"']),
            ("gpt-6.1-sol", ["-c", 'model_reasoning_effort="high"', "--profile", "personal"]),
            ("gpt-6.1-sol", ["-cmodel_reasoning_effort=high"]),
            ("gpt-6.1-sol", ["-c"]),
            ("gpt-6.1-sol", ["--config"]),
            # No catalogue entry means no known levels: refuse, never guess.
            ("test-codex-deployment", ["-c", 'model_reasoning_effort="high"']),
        ]
        for deployment, native in cases:
            with self.subTest(deployment=deployment, native=native):
                self.use_codex_deployment(deployment)
                result = self.run_cli("codex", "--", *native)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(self.wrapper_capture.exists(), "credential wrapper ran before the refusal")
                self.assertFalse(self.capture.exists(), "native child ran")

    def ssh_session_environment(self):
        """A full SSH session environment: the genuine one when this process runs under SSH."""
        if self.inherited_ssh.get("SSH_CONNECTION"):
            return dict(self.inherited_ssh)
        # Documentation-range addresses (RFC 5737) and a placeholder agent socket.
        return {"SSH_CONNECTION": "198.51.100.7 51234 198.51.100.9 22", "SSH_CLIENT": "198.51.100.7 51234 22",
                "SSH_TTY": "/dev/ttys999", "SSH_AUTH_SOCK": "/tmp/synthetic-agent.sock"}

    def wrapper_observation(self):
        self.assertTrue(self.wrapper_env_capture.exists(), "the credential wrapper was not run")
        return json.loads(self.wrapper_env_capture.read_text())

    def test_wrapper_boundary_receives_the_inherited_ssh_context_like_a_direct_check(self):
        ssh = self.ssh_session_environment()
        direct = subprocess.run([str(self.wrapper), "check"], env={**self.env, **ssh}, input="", text=True,
                                capture_output=True, timeout=10)
        self.assertEqual(direct.returncode, 0, direct.stderr)
        direct_seen = self.wrapper_observation()
        self.wrapper_env_capture.unlink()
        self.assertEqual(direct_seen["ssh_context"], 1)

        launched = self.run_cli("codex", "--", "exec", "go", extra_env=ssh)
        self.assertEqual(launched.returncode, 0, launched.stderr)
        launch_seen = self.wrapper_observation()
        self.assertEqual(launch_seen["ssh_context"], direct_seen["ssh_context"],
                         "the launcher must not hide the SSH context a direct check sees")
        self.assertEqual(launch_seen["ssh_connection"], ssh["SSH_CONNECTION"], "the inherited value, unchanged")
        self.assertEqual(launch_seen["ssh_names"], ["SSH_CONNECTION"],
                         "only SSH_CONNECTION is forwarded: not the agent socket, client or tty")

    def test_ssh_context_stops_at_the_wrapper_and_is_never_fabricated(self):
        ssh = self.ssh_session_environment()
        launched = self.run_cli("codex", "--", "exec", "go", extra_env=ssh)
        self.assertEqual(launched.returncode, 0, launched.stderr)
        child = self.child_result()
        self.assertEqual(child["ssh_names"], [], "the Codex process must not inherit any SSH name")
        self.assertNotIn("SSH_", " ".join(json.loads(self.wrapper_capture.read_text())),
                         "the Codex environment hop must not carry SSH names")
        self.assertEqual(child["env"], {"AZURE_OPENAI_API_KEY": "synthetic-child-key"})

        cases = {
            "no SSH session": None,
            "empty value": "",
            "control character in the value": "198.51.100.7\n51234 198.51.100.9 22",
        }
        for label, value in cases.items():
            with self.subTest(label):
                self.wrapper_env_capture.unlink(missing_ok=True)
                result = self.run_cli("codex", "--", "exec", "go", extra_env={"SSH_CONNECTION": value})
                self.assertEqual(result.returncode, 0, result.stderr)
                seen = self.wrapper_observation()
                self.assertIsNone(seen["ssh_connection"], "an SSH context must never be created")
                self.assertEqual((seen["ssh_context"], seen["ssh_names"]), (0, []))

    def test_missing_azure_login_stops_before_claude(self):
        result = self.run_cli("claude", extra_env={"FOUNDRY_TEST_AZ_FAIL": "1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("az login", result.stderr)
        self.assertFalse(self.capture.exists())

    def test_check_uses_the_normalized_claude_azure_config_directory(self):
        isolated_home = self.root / "isolated home"
        isolated_home.mkdir()
        result = self.run_cli(
            "check",
            extra_env={"HOME": str(isolated_home), "AZURE_CONFIG_DIR": "~/azure-cache"},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        observed = json.loads(self.az_capture.read_text())
        self.assertEqual(
            observed["azure_config_dir"],
            str((isolated_home / "azure-cache").resolve()),
        )

    def test_broker_failure_never_falls_back(self):
        self.broker_failure.write_text("fail")
        result = self.run_cli("codex")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.capture.exists())

    def test_provider_overrides_are_refused_before_broker(self):
        for override in (("-c", 'model_provider="openai"'), ("--profile", "personal"), ("--oss",),
                         ("--remote", "https://unwanted.example"), ("--remote-auth-token-env=OTHER",)):
            with self.subTest(override=override):
                result = self.run_cli("codex", "--", *override)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.wrapper_capture.exists())
                self.assertFalse(self.capture.exists())

    def test_claude_settings_override_is_refused(self):
        result = self.run_cli("claude", "--", "--settings", "untrusted.json")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.capture.exists())

    def test_claude_without_caller_settings_passes_only_the_pinned_env(self):
        result = self.run_cli("claude", "--", "-p", "Return a marker")
        self.assertEqual(result.returncode, 0, result.stderr)
        argv = self.child_result()["argv"]
        self.assertEqual(argv[0], "--settings")
        self.assertEqual(argv[2:], ["--model", "test-sonnet", "-p", "Return a marker"])
        self.assertEqual(list(json.loads(argv[1])), ["env"])

    def test_claude_projects_hook_file_survives_beside_pinned_provider_env(self):
        for mode in (0o600, 0o644):
            with self.subTest(mode=oct(mode)):
                self.capture.unlink(missing_ok=True)
                hook_file = self.settings_file("hook-agent.json", json.dumps(PROJECTS_HOOK_SETTINGS), mode)
                result = self.run_cli("claude", "--", "--settings", str(hook_file), "-p", "Return a marker")
                self.assertEqual(result.returncode, 0, result.stderr)
                child = self.child_result()
                argv = child["argv"]
                self.assertEqual(argv.count("--settings"), 1)
                self.assertNotIn(str(hook_file), argv)
                self.assertNotIn(HOOK_TOKEN, "\n".join(argv))
                self.assertEqual(argv[-2:], ["-p", "Return a marker"])
                self.assertEqual(argv[argv.index("--model") + 1], "test-sonnet")
                settings = self.child_private_settings(child)
                self.assertEqual(sorted(settings), ["env", "hooks"])
                self.assertEqual(settings["hooks"], PROJECTS_HOOK_SETTINGS["hooks"])
                self.assertEqual(settings["env"]["CLAUDE_CODE_USE_FOUNDRY"], "1")
                self.assertEqual(settings["env"]["ANTHROPIC_FOUNDRY_RESOURCE"], "test-claude-resource")
                for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK"):
                    self.assertEqual(settings["env"][key], "")
                self.assertNotIn(HOOK_TOKEN, result.stdout + result.stderr)
                self.assertTrue(self.az_capture.exists())

    def test_claude_caller_settings_reach_native_only_through_an_unlinked_private_descriptor(self):
        private_tmp = self.root / "private-tmp"
        private_tmp.mkdir(mode=0o700)
        hook_file = self.settings_file("hook-agent.json", json.dumps(PROJECTS_HOOK_SETTINGS))
        result = self.run_cli(
            "claude", "--", "--settings", str(hook_file), "-p", "Return a marker",
            extra_env={"TMPDIR": str(private_tmp)},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        child = self.child_result()
        self.assertNotIn(HOOK_TOKEN, "\n".join(child["argv"]))
        self.assertNotIn(HOOK_TOKEN, result.stdout + result.stderr)
        view = child["settings_file"]
        self.assertTrue(view["regular"])
        self.assertEqual(view["links"], 0, "the settings file still has a name")
        self.assertEqual(view["mode"], 0o600)
        settings = self.child_private_settings(child)
        self.assertEqual(settings["hooks"], PROJECTS_HOOK_SETTINGS["hooks"])
        self.assertEqual(settings["env"]["CLAUDE_CODE_USE_FOUNDRY"], "1")
        self.assertEqual(settings["env"]["ANTHROPIC_FOUNDRY_RESOURCE"], "test-claude-resource")
        self.assertEqual(settings["env"]["ANTHROPIC_BASE_URL"], "")
        self.assertEqual(list(private_tmp.iterdir()), [], "a settings file was left in TMPDIR")
        self.assertEqual(list(self.root.glob("monash-foundry-claude-settings-*")), [])

    def test_claude_private_settings_are_made_only_at_launch_and_fail_closed(self):
        hook_file = self.settings_file("hook-agent.json", json.dumps(PROJECTS_HOOK_SETTINGS))
        missing_tmp = self.root / "missing-tmp"
        broken_tmp = {"TMPDIR": str(missing_tmp)}
        dry_run = self.run_cli(
            "--dry-run", "claude", "--", "--settings", str(hook_file), extra_env=broken_tmp)
        self.assertEqual(dry_run.returncode, 0, dry_run.stderr)
        self.assertFalse(missing_tmp.exists(), "dry-run touched the temporary directory")
        self.assertFalse(self.capture.exists())
        for tmpdir in (str(missing_tmp), "relative-tmp"):
            with self.subTest(tmpdir=tmpdir):
                result = self.run_cli(
                    "claude", "--", "--settings", str(hook_file), extra_env={"TMPDIR": tmpdir})
                self.assertEqual(result.returncode, 3, result.stderr)
                self.assertIn("private Claude settings", result.stderr)
                self.assertNotIn(HOOK_TOKEN, result.stdout + result.stderr)
                self.assertFalse(self.capture.exists(), "native child ran without its settings")
                self.assertFalse((self.root / "relative-tmp").exists())
                self.assertEqual(list(self.root.glob("monash-foundry-claude-settings-*")), [])

    def run_with_substituting_mkstemp(self, mode, hook_file, tmpdir):
        harness = self.root / "substituting-mkstemp.py"
        harness.write_text(SUBSTITUTING_MKSTEMP_HARNESS)
        env = self.env.copy()
        env["TMPDIR"] = str(tmpdir)
        result = subprocess.run(
            [sys.executable, str(harness), mode, str(LAUNCHER), str(self.root / "decoy.json"),
             "--config", str(self.config_file), "claude", "--", "--settings", str(hook_file),
             "-p", "Return a marker"],
            cwd=self.root, env=env, input="", text=True, capture_output=True, timeout=10,
        )
        self.assertNotIn("synthetic-personal-secret", result.stdout + result.stderr)
        return result

    def test_claude_private_settings_swapped_in_tmpdir_never_reach_native(self):
        hook_file = self.settings_file("hook-agent.json", json.dumps(PROJECTS_HOOK_SETTINGS))
        control_tmp = self.root / "control-tmp"
        control_tmp.mkdir(mode=0o700)
        control = self.run_with_substituting_mkstemp("none", hook_file, control_tmp)
        self.assertEqual(control.returncode, 0, control.stderr)
        settings = self.child_private_settings(self.child_result())
        self.assertEqual(settings["hooks"], PROJECTS_HOOK_SETTINGS["hooks"])
        self.assertEqual(settings["env"]["CLAUDE_CODE_USE_FOUNDRY"], "1")

        for mode in ("replace", "symlink", "link"):
            with self.subTest(mode=mode):
                self.capture.unlink(missing_ok=True)
                shared_tmp = self.root / f"shared-tmp-{mode}"
                shared_tmp.mkdir(mode=0o700)
                result = self.run_with_substituting_mkstemp(mode, hook_file, shared_tmp)
                self.assertEqual(result.returncode, 3, result.stderr)
                self.assertIn("private Claude settings", result.stderr)
                self.assertNotIn(HOOK_TOKEN, result.stdout + result.stderr)
                self.assertNotIn("attacker.example", result.stdout + result.stderr)
                self.assertFalse(self.capture.exists(), "native child ran on a substituted settings file")
                leftovers = list(shared_tmp.iterdir())
                if mode == "link":
                    # The attacker's extra name survives, but the payload must
                    # never have been written to a file that still has a name.
                    self.assertEqual([item.read_bytes() for item in leftovers], [b""])
                else:
                    self.assertEqual(leftovers, [], "a settings file was left in TMPDIR")

    def test_claude_inline_settings_keep_other_settings_and_harmless_env(self):
        caller = {
            "permissions": {"deny": ["Read(./.env)"]},
            "statusLine": {"type": "command", "command": "echo ready"},
            "env": {"PROJECT_MARKER": "kept"},
            **PROJECTS_HOOK_SETTINGS,
        }
        inline = json.dumps(caller)
        for form in (("--settings", inline), (f"--settings={inline}",)):
            with self.subTest(form=form[0][:12]):
                self.capture.unlink(missing_ok=True)
                result = self.run_cli("claude", "--", *form, "--continue")
                self.assertEqual(result.returncode, 0, result.stderr)
                child = self.child_result()
                self.assertEqual(child["argv"].count("--settings"), 1)
                self.assertIn("--continue", child["argv"])
                argv_text = "\n".join(child["argv"])
                for caller_value in ("Read(./.env)", "echo ready", "kept", HOOK_TOKEN):
                    self.assertNotIn(caller_value, argv_text)
                settings = self.child_private_settings(child)
                self.assertEqual(settings["permissions"], {"deny": ["Read(./.env)"]})
                self.assertEqual(settings["statusLine"], {"type": "command", "command": "echo ready"})
                self.assertEqual(settings["hooks"], PROJECTS_HOOK_SETTINGS["hooks"])
                self.assertEqual(settings["env"]["PROJECT_MARKER"], "kept")
                self.assertEqual(settings["env"]["CLAUDE_CODE_USE_FOUNDRY"], "1")
                self.assertEqual(settings["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"], "test-sonnet")

    def test_claude_settings_env_that_would_replace_the_route_is_refused(self):
        names = ("ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
                 "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_FOUNDRY_RESOURCE",
                 "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "AZURE_CONFIG_DIR",
                 "CLAUDE_CONFIG_DIR", "CODEX_HOME", "HOME", "OPENAI_API_KEY", "HERDR_AGENT")
        for name in names:
            with self.subTest(name=name):
                caller = {**PROJECTS_HOOK_SETTINGS, "env": {name: "https://unwanted.example"}}
                result = self.assert_claude_settings_refused(
                    "--settings", json.dumps(caller), mentions=f"cannot set {name};")
                self.assertNotIn("unwanted.example", result.stderr)
        conflicting_file = self.settings_file("conflict.json", json.dumps(
            {**PROJECTS_HOOK_SETTINGS, "env": {"ANTHROPIC_BASE_URL": "https://unwanted.example"}}))
        self.assert_claude_settings_refused(
            "--settings", str(conflicting_file), mentions="cannot set ANTHROPIC_BASE_URL;")

    def test_claude_settings_that_select_credentials_or_model_are_refused(self):
        for key, value in (("apiKeyHelper", "/synthetic/helper"), ("awsAuthRefresh", "synthetic refresh"),
                           ("awsCredentialExport", "/synthetic/export"), ("forceLoginMethod", "console"),
                           ("forceLoginOrgUUID", "synthetic-org"), ("model", "synthetic-model")):
            with self.subTest(key=key):
                caller = {**PROJECTS_HOOK_SETTINGS, key: value}
                self.assert_claude_settings_refused(
                    "--settings", json.dumps(caller), mentions=f"cannot set {key};")

    def test_claude_malformed_duplicate_or_ambiguous_settings_are_refused(self):
        cases = {
            "not json": ("--settings", "{not json"),
            "trailing text": ("--settings", '{"hooks": {}} extra'),
            "non-standard constant": ("--settings", '{"hooks": {}, "marker": NaN}'),
            "array": ("--settings", "[]"),
            "hooks not an object": ("--settings", '{"hooks": []}'),
            "env not an object": ("--settings", '{"env": []}'),
            "env value not a string": ("--settings", '{"env": {"PROJECT_MARKER": 1}}'),
            "duplicate top-level key": ("--settings", '{"hooks": {}, "hooks": {}}'),
            "duplicate nested key": ("--settings", '{"env": {"PROJECT_MARKER": "1", "PROJECT_MARKER": "2"}}'),
            "repeated flag": ("--settings", "{}", "--settings", "{}"),
            "repeated mixed forms": ("--settings={}", "--settings", "{}"),
            "missing value": ("--settings",),
            "empty equals value": ("--settings=",),
            "blank value": ("--settings", "   "),
            "flag as value": ("--settings", "--continue"),
            "delimiter as value": ("--settings", "--", "{}"),
        }
        for label, native_args in cases.items():
            with self.subTest(case=label):
                self.assert_claude_settings_refused(*native_args)

    def test_claude_settings_file_that_is_unsafe_or_unreadable_is_refused(self):
        valid = json.dumps(PROJECTS_HOOK_SETTINGS)
        target = self.settings_file("target.json", valid)
        link = self.root / "link.json"
        link.symlink_to(target)
        directory = self.root / "settings-dir"
        directory.mkdir()
        cases = {
            "relative path": "target.json",
            "missing file": str(self.root / "missing.json"),
            "symbolic link": str(link),
            "world writable": str(self.settings_file("world-writable.json", valid, 0o666)),
            "group writable": str(self.settings_file("group-writable.json", valid, 0o620)),
            "directory": str(directory),
            "oversized": str(self.settings_file("oversized.json", " " * (1024 * 1024) + valid)),
            "not utf-8": str(self.settings_file("binary.json", b"\xff\xfe{")),
            "empty": str(self.settings_file("empty.json", "")),
        }
        for label, value in cases.items():
            with self.subTest(case=label):
                self.assert_claude_settings_refused("--settings", value)

    def test_claude_dry_run_validates_settings_without_leaking_them(self):
        hook_file = self.settings_file("hook-agent.json", json.dumps(PROJECTS_HOOK_SETTINGS))
        result = self.run_cli("--dry-run", "claude", "--", "--settings", str(hook_file))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("forwarded_native_args=2 preserved; values hidden", result.stdout)
        self.assertNotIn(HOOK_TOKEN, result.stdout + result.stderr)
        self.assertFalse(self.capture.exists())
        self.assertFalse(self.az_capture.exists())
        self.assert_claude_settings_refused(
            "--settings", json.dumps({"env": {"ANTHROPIC_BASE_URL": "https://unwanted.example"}}),
            mentions="cannot set ANTHROPIC_BASE_URL;", extra_cli=("--dry-run",),
        )

    def test_claude_settings_text_after_the_native_delimiter_is_a_literal_argument(self):
        result = self.run_cli("claude", "--", "-p", "--", "--settings")
        self.assertEqual(result.returncode, 0, result.stderr)
        child = self.child_result()
        self.assertEqual(child["argv"][-3:], ["-p", "--", "--settings"])
        self.assertEqual(list(self.child_settings(child)), ["env"])

    def test_claude_cloud_and_fallback_flags_are_refused(self):
        for option in ("--cloud", "--environment=personal", "--fallback-model=unknown"):
            with self.subTest(option=option):
                result = self.run_cli("claude", "--", option)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.capture.exists())
                self.assertFalse(self.az_capture.exists())

    def test_wrong_tenant_stops_before_claude(self):
        self.config["tenant"] = "wrong-tenant-id"
        self.save_config()
        result = self.run_cli("claude")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("tenant", result.stderr)
        self.assertFalse(self.capture.exists())

    def test_unavailable_opus_is_not_mapped_to_another_model(self):
        self.config["claude"]["opus"] = None
        self.save_config()
        result = self.run_cli("claude", "--", "--model", "opus")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.capture.exists())
        result = self.run_cli("claude")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("ANTHROPIC_DEFAULT_OPUS_MODEL", self.child_result()["env"])

    def test_native_exit_status_is_preserved(self):
        self.exit_control.write_text("19")
        result = self.run_cli("codex")
        self.assertEqual(result.returncode, 19, result.stderr)

    def test_missing_config_value_is_not_silently_defaulted(self):
        del self.config["codex"]["deployment"]
        self.save_config()
        result = self.run_cli("codex")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.wrapper_capture.exists())

    def test_non_azure_or_unsafe_endpoint_is_refused_before_credentials(self):
        for endpoint in ("https://attacker.example/openai/v1", "http://example.openai.azure.com/openai/v1",
                         "https://example.openai.azure.com/openai/v1?key=wrong",
                         "https://user@example.openai.azure.com/openai/v1", "https://example.openai.azure.com/other"):
            with self.subTest(endpoint=endpoint):
                self.config["codex"]["base_url"] = endpoint
                self.save_config()
                result = self.run_cli("codex")
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.wrapper_capture.exists())
                self.assertFalse(self.capture.exists())

    def test_unknown_cli_option_is_refused(self):
        result = self.run_cli("--not-an-option")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.capture.exists())


if __name__ == "__main__":
    unittest.main()
