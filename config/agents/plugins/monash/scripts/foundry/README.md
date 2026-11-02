# Monash Foundry launcher

`monash-foundry` is the human-first entry point for launching native Codex,
native Claude Code, or native OpenCode through the configured Monash Foundry route. It is
an exec launcher, not a proxy or an agent orchestrator. The current process
working directory, native harness homes, skills, hooks, sessions, and history
remain in place.

This document is part of the plugin's `scripts/foundry/` payload. Run source
commands from the plugin root, the directory containing `scripts/` and
`skills/`; the paths below are relative to that root.

## Usage

```text
monash-foundry
monash-foundry [--config PATH] [--dry-run] codex  [-- NATIVE_ARGS...]
monash-foundry [--config PATH] [--dry-run] claude [-- NATIVE_ARGS...]
monash-foundry [--config PATH] check
monash-foundry [--config PATH] models [--refresh] [--json]
monash-foundry [--config PATH] launch --model STABLE_ID --agent codex|claude|opencode [--qualification] [-- NATIVE_ARGS...]
monash-foundry --help
```

With no command, a TTY offers Codex, Claude Code, or Cancel. OpenCode is
explicit-selection only. A non-TTY prints help and does not launch an agent.
Native arguments must follow `--`; they are passed as an argv list without
shell evaluation, so paths and arguments with spaces retain their meaning.

Examples:

```sh
monash-foundry codex
monash-foundry claude -- --continue
monash-foundry --dry-run codex -- exec --ignore-user-config --ephemeral
monash-foundry check
monash-foundry models --json
monash-foundry models --refresh --json
monash-foundry launch --model claude-sonnet-5 --agent claude --qualification
monash-foundry launch --model gpt-6.1-sol --agent codex -- -c 'model_reasoning_effort="high"'
monash-foundry launch --model gpt-5.4-nano --agent opencode --qualification -- run --prompt "bounded smoke test"
```

`--dry-run` validates and displays a redacted launch plan. It does not invoke
Azure CLI, resolve a 1Password value, or make a provider request. It reports
auth and model health as unknown. `check` performs local diagnostics, an Azure
CLI account check for the Claude route, and (when configured) an OpenCode
version check against the configured minimum; it makes no model request.

## Herdr entry and host profiles

`config.json` `host_profiles` is the sealed placement registry. `--host
PROFILE_ID` accepts an exact profile ID, and each profile declares `transport`
as `local` or `ssh`. The shipped registry currently has `laptop` as local and
`mini` as the initial SSH profile. `--local` and `--mini` are migration aliases
for those profile IDs only; they do not infer a host or transport from the
machine or an installer role.

Outside Herdr, bare `foundry` refuses because no host profile is assumed. Use
`foundry --host PROFILE_ID` to attach the selected dedicated Herdr session.
Inside Herdr, `foundry` without a host, or `foundry --menu`, opens the adjacent
`monash launch` picker with the same config. It does not start a nested Herdr
TUI.

## Monash coordinator and direct attach

`monash launch` selects a host profile, stable model ID, native agent, and
working directory. `monash spawn --host PROFILE_ID --model STABLE_ID --agent
codex|claude|opencode --cwd ABSOLUTE_DIRECTORY [--remote-cwd
REMOTE_ABSOLUTE_DIRECTORY] [--verify] [-- NATIVE_ARGS...]` uses that sealed
profile to create one no-focus sibling in the caller tab.

For a local profile, the sibling is direct and the coordinator starts the
native agent there after checking the per-run canonical-command shim. For an
SSH profile, the coordinator creates one local sibling, asks the internal
remote helper to start the native agent in the configured remote Herdr
session, then runs the exact direct SSH attach in that sibling. It does not
open a nested Herdr TUI. The attach command has no `exec` prefix.

For SSH, `--cwd` is the local requested directory. The registry resolves it
with the most specific component-aware `path_mappings` entry, or the caller
can provide `--remote-cwd`. The helper verifies the remote directory and
reports the actual cwd from `remote.herdr.agent.get`; the expected and
observed values must match. There is no local execution fallback.

Before `herdr agent start`, the coordinator proves the post-login shell
resolves the canonical command to a no-secret per-run shim. After managed
startup, it proves the foreground process is the pinned real native executable
with the requested cwd and model-bearing argv, not the shim or Foundry
launcher.

For local transport, a `ready` receipt states `session.state:
pending_first_turn`; it deliberately does not invent a native session ID. Run
`monash verify NAME_OR_PANE` or use `spawn --verify` to submit one harmless
first turn and receive `verified` only after Herdr reports the complete native
session tuple and `session_id`. For SSH, a helper `started` result means the
remote native session tuple is not complete. A helper `ready` result requires
remote interactive readiness and a complete native session tuple. Without
`--verify`, a sessionless SSH start returns a recoverable refusal before
attach; with `--verify`, it sends the helper's harmless first-turn prompt,
revalidates the same remote identity, and attaches only after verification.

Any failure after a local or remote pane exists preserves its identity and
repair action. Do not rerun `spawn`, answer a blocked prompt, or silently kill
the native agent while recovering.

## Model inventory and native selection

`models` is a read-only catalogue command. Without `--refresh` it reports the
pinned inventory snapshot and does not invoke Azure CLI. `--refresh` performs
bounded, read-only Azure deployment-list queries for the two explicit resources;
it never writes a snapshot, reads credentials, or makes an inference request.
Refresh failures are reported as `stale` or `unavailable`, never as a guessed
availability. Human output is the default. `--json` writes one JSON document to
stdout and diagnostics only to stderr. The process exits `0` for a complete
snapshot, `2` for usage/configuration errors, and `3` when refresh cannot
truthfully produce a complete snapshot; a `3` response still contains parseable
JSON when `--json` was requested.

The machine-readable shape is stable at schema version `1`:

```json
{
  "schema_version": 1,
  "command": "models",
  "mode": "snapshot|refresh",
  "state": "snapshot|fresh|stale|unavailable",
  "observed_at": "2026-09-09T00:00:00Z|null",
  "resources": [
    {
      "id": "gpt|claude",
      "resource": "resource-name",
      "resource_group": "resource-group-name",
      "availability": "available|stale|unavailable",
      "observed": true,
      "error": null
    }
  ],
  "models": [
    {
      "id": "stable-catalog-id",
      "display_name": "Human name",
      "availability": "available|stale|unavailable",
      "bindings": [
        {
          "resource_id": "gpt|claude",
          "resource": "resource-name",
          "resource_group": "resource-group-name",
          "deployment": "exact-deployment-name",
          "protocol": "azure-openai-responses|azure-anthropic-messages|azure-openai-chat-completions|unverified",
          "model_format": "OpenAI|Anthropic|DeepSeek|MoonshotAI",
          "availability": "available|stale|unavailable",
          "provisioning_state": "Succeeded|null",
          "observed": true,
          "reason": null
        }
      ],
      "routes": [
        {
          "agent": "codex|claude|opencode",
          "status": "qualified|untested|failed",
          "implemented": true,
          "compatibility": "compatible|candidate|incompatible",
          "binding_resource_id": "gpt|claude|null",
          "reason": "string|null",
          "evidence": []
        }
      ]
    }
  ]
}
```

`availability` describes management-plane observation of the exact binding;
it is not an inference or qualification claim. `status` is evidence-backed
route state: `qualified` requires complete foreground qualification of both
inference and tool use, `untested` means that complete qualification is absent
whether or not the route is implemented, and `failed` is reserved for a real
failed observation. `implemented` and `compatibility` are separate so an
unimplemented or protocol-unknown pairing cannot be mistaken for an available
trial. `evidence` contains references to observations only; the launcher does
not manufacture or append evidence.

The stable IDs and exact management-plane bindings in the current snapshot are:

| Stable ID | GPT resource deployment | Claude resource deployment |
| --- | --- | --- |
| `gpt-5.5` | `gpt-5.5` | `gpt-5.5` |
| `gpt-5.4-nano` | `gpt-5.4-nano` | `gpt-5-4-nano` |
| `claude-sonnet-5` | `claude-sonnet-5` | `claude-sonnet-5` |
| `claude-sonnet-4.6` | `claude-sonnet-4-6` | `claude-sonnet-4-6` |
| `claude-haiku-4.5` | `claude-haiku-4-5` | `claude-haiku-4-5` |
| `deepseek-v4-pro` | `DeepSeek-V4-Pro` | `DeepSeek-V4-Pro` |
| `deepseek-v4-flash` | `DeepSeek-V4-Flash` | `DeepSeek-V4-Flash` |
| `kimi-k2.7-code` | `Kimi-K2.7-Code` | `Kimi-K2.7-Code` |
| `kimi-k2.6` | not deployed in the GPT resource | `Kimi-K2.6` |
| `gpt-6.1-sol` | `gpt-6.1-sol` | not deployed in the Claude resource |

The GPT resource is `monash-edu-esol-smst-ai-dev-gpt` in resource group
`monash-edu-esol-smst-ai-dev`. The Claude resource is
`monash-edu-smst-ai-claude-code` in resource group
`monash-edu-smst-smstai-degreeworks-scribe`. Azure reports `OpenAI` for GPT,
`Anthropic` for Claude, `DeepSeek` for DeepSeek, and `MoonshotAI` for Kimi.
The documented protocol is `azure-openai-responses` for the Codex GPT route,
`azure-anthropic-messages` for the native Claude route, and
`azure-openai-chat-completions` for the five explicit OpenCode routes below.
Other cross-family rows remain `unverified` until a protocol is documented;
they are named incompatibilities, not substitutions. A refresh requires both
the exact deployment name and the Azure-reported `properties.model.format` to
match the binding; a same-name format mismatch is `unavailable`.

The Codex GPT-5.5 and Claude Sonnet 4.6, Sonnet 5, and Haiku 4.5
selector routes are qualified by foreground laptop trials of native inference
and harmless file-read tools on 9 September 2026. Their evidence references
identify the recorded observation and host. This does not establish Mini or
interactive pane-spawn qualification. The five OpenCode routes are implemented
and compatible. `gpt-5.4-nano`, `deepseek-v4-pro`, `deepseek-v4-flash`,
`kimi-k2.7-code`, and `kimi-k2.6` are qualified on both laptop and Mini by
native inference and a README file-read tool through the integrated Monash
launcher. Laptop Kimi K2.7 passed on 9 September 2026; the other four laptop
routes passed on 10 September 2026. All laptop routes used OpenCode 1.18.29.
On Mini, Kimi K2.7 used OpenCode 1.18.27 and the other four routes used 1.18.30.
Other pairings remain unimplemented or incompatible until separately proved.
The candidate Codex GPT-5.4 Nano route remains
unimplemented while the pinned Codex catalogue lacks its model metadata; it
cannot borrow GPT-5.5 metadata.

`gpt-6.1-sol` is a Codex-only route on the GPT resource. `az cognitiveservices
account deployment list` showed deployment `gpt-6.1-sol` (OpenAI format, version
2026-09-29, `Succeeded`) on 1 November 2026, and the pinned Codex catalogue holds
its own metadata. Its Codex route is `qualified` from FLS-32's native trials on
2 November 2026: interactive High inference, harmless file-read tools and
same-session resume on Mini and Laptop, with `--no-daemon`, a read-only sandbox
and never-approve. The five receipts are in its `evidence`. That covers
completed turns only, not normal-exit proof; shared daemon, SSH and
workspace-write use remain unqualified. The snapshot date above predates this
entry; only this binding was observed on 1 November 2026.

`launch` selects exactly one stable ID and native agent. Selection and all
compatibility, implementation, and availability checks happen before Azure
account checks, credential wrappers, or native process startup. A production
launch requires an `available`, `implemented`, `compatible`, `qualified`
route. `--qualification` is an explicit foreground trial gate for an
`available`, `implemented`, `compatible`, `untested` route only; it does not
qualify the route, write evidence, or change the catalogue. Unknown IDs,
failed/stale/unavailable bindings, unimplemented routes, incompatible routes,
and missing native catalogue support refuse without substitution. The concrete
Codex endpoint host must match the selected inventory resource's
`<resource>.openai.azure.com` host, the Claude resource name must match its
selected inventory resource, and the OpenCode `.services.ai.azure.com` endpoint
must match its selected resource. The selected resource and binding must both
be `available` and observed. The binding protocol is checked independently for
the selected agent: Codex requires Responses/OpenAI, Claude requires
Anthropic Messages/Anthropic, and OpenCode requires chat completions with an
OpenAI, DeepSeek, or MoonshotAI binding plus one of the five documented recipes.
Mutable route flags therefore cannot make an `unverified` protocol or
incompatible model format launchable. Arguments after `--` are forwarded
unchanged after the launcher-owned OpenCode model selection. OpenCode native
model, config, pure, and remote attachment overrides are reserved by the
launcher.

## Config contract

The coordinator provides `config.json` beside this executable. `--config PATH`
selects another file. The accepted shape is deliberately small:

```json
{
  "tenant": "azure-tenant-uuid",
  "subscription": "subscription-name-or-id",
  "codex": {
    "base_url": "https://RESOURCE.openai.azure.com/openai/v1",
    "deployment": "codex-deployment",
    "credential_ref": "<one-password-reference>"
  },
  "claude": {
    "resource": "foundry-resource",
    "opus": "claude-opus-deployment",
    "sonnet": "claude-sonnet-deployment",
    "haiku": "claude-haiku-deployment",
    "sonnet5": "claude-sonnet-5-deployment"
  },
  "opencode": {
    "resources": {
      "gpt": {
        "resource": "resource-name",
        "base_url": "https://RESOURCE.services.ai.azure.com/openai/v1"
      },
      "claude": {
        "resource": "resource-name",
        "base_url": "https://RESOURCE.services.ai.azure.com/openai/v1"
      }
    },
    "minimum_version": "1.18.27"
  },
  "inventory": {
    "schema_version": 1,
    "snapshot_observed_at": "2026-09-09",
    "snapshot_source": "proof-reference",
    "resources": [
      {
        "id": "gpt",
        "resource": "resource-name",
        "resource_group": "resource-group-name",
        "availability": "available",
        "observed": true,
        "error": null
      }
    ],
    "models": [
      {
        "id": "stable-catalog-id",
        "display_name": "Human name",
        "availability": "available",
        "bindings": [
          {
            "resource_id": "gpt",
            "deployment": "exact-deployment-name",
            "protocol": "azure-openai-responses",
            "model_format": "OpenAI",
            "availability": "available",
            "provisioning_state": "Succeeded",
            "observed": true,
            "reason": null
          }
        ],
        "routes": [
          {
            "agent": "codex",
            "status": "untested",
            "implemented": true,
            "compatibility": "compatible",
            "binding_resource_id": "gpt",
            "reason": "qualification pending",
            "evidence": []
          }
        ]
      }
    ]
  },
  "commands": {
    "codex": "/optional/test/codex",
    "claude": "/optional/test/claude",
    "with_one_password_token": "/optional/test/with-one-password-token",
    "az": "/optional/test/az",
    "opencode": "/optional/test/opencode"
  }
}
```

`inventory` is the input form for the output catalogue. It is optional for
legacy `codex`, `claude`, and `check` configurations, but explicit `models`
and `launch` commands require it. Its `resources` and `models` members use the
same IDs and enum values shown in the output shape. Binding `resource` and
`resource_group` fields are derived from `resources` and are output-only;
`command`, `mode`, `state`, and top-level `observed_at` are also output-only.
Each model must have one or more exact `bindings` and one route for each native
agent. A route's `evidence` list is caller-owned historical observation
references and must not be used to mark a route `qualified` without complete
inference and tool-use proof.

`commands` is optional and exists to support process tests with fake
executables. Relative command paths are resolved from the current working
directory. Without an explicit path, the launcher checks `~/.local/bin` first,
then noninteractive `PATH`; it does not source shell profiles. The `opencode`
entry selects the native OpenCode executable used for version preflight and
launch.

Unknown config keys are rejected. The launcher never reads a credential value
from JSON or from a credential environment override.
The Codex endpoint must use HTTPS on `*.openai.azure.com` with the `/openai/v1`
path and no user information, query or fragment. Rejected endpoints never reach
the credential wrapper.

The tenant must be the verified Azure tenant UUID. Set `claude.opus` to `null`
when no Opus deployment exists; the launcher then rejects `--model opus` rather
than mapping it to Sonnet. Current defaults are the verified GPT-5.5 deployment and
the Claude resource's Sonnet 5.5 (`sonnet` and `sonnet5`) and Haiku 5.5 (`haiku`)
deployments, as listed by Azure on 1 November 2026. An interactive switch to an undeployed model still fails at
Foundry; this tool never provisions a deployment.

## Codex route

The launcher removes inherited personal and conflicting provider settings,
including `CODEX_HOME`, then invokes the existing wrapper:

```text
with-one-password-token inject AZURE_OPENAI_API_KEY <credential_ref> -- \
  /usr/bin/env TERM=<original-or-xterm-256color> [present-public-HERDR-vars] codex ...
```

The credential reference is passed to the wrapper; the secret is injected only
into the child process. Codex receives explicit `-c` overrides for:

- the `monash_foundry` custom provider;
- the configured Azure base URL and deployment;
- `wire_api="responses"`;
- `env_key="AZURE_OPENAI_API_KEY"`;
- `requires_openai_auth=false`;
- `model_reasoning_effort="medium"`; and
- `service_tier="default"`.

The bundled `codex-models.json` supplies the upstream Codex `ModelInfo` for
`gpt-5.5` (from `rust-v0.153.4`) and `gpt-6.1-sol` (from `rust-v0.165.0`), each
unchanged, preventing an incompatible Azure `/models` discovery request. It
does not change the inference endpoint or provider. Regenerate from the pinned
official sources with `python3 scripts/foundry/refresh_codex_catalog.py >
scripts/foundry/codex-models.json`. Requalify the catalogue when upgrading
Codex.

The route sets `model_reasoning_effort="medium"` unless the caller supplies
`-c model_reasoning_effort="LEVEL"` (also
`--config` and `--config=`), once. The launcher then omits its own default and
leaves the caller's argument last and unchanged. `LEVEL` must be one the pinned
catalogue lists for the selected deployment (`gpt-5.5`: low, medium, high,
xhigh; `gpt-6.1-sol`: low, medium, high, xhigh, max, ultra). A deployment with
no catalogue entry has no known levels, so the override is refused.

The same native config forms accept three capability reductions, once per key:

- `web_search="disabled"` (the bare string `disabled` is also accepted).
- `model_providers.monash_foundry.request_max_retries=0`.
- `model_providers.monash_foundry.stream_max_retries=0`.

Values use these exact literals; retry counts accept only the integer literal
`0`. Other providers, duplicate keys, and `--search` combined with disabled
search are refused before credential delivery. Accepted arguments remain last
and unchanged in the native argv. These settings reduce tools or retries;
they leave the provider, endpoint, model, catalogue and authentication pinned.
They do not alone prove read-only isolation, hook/MCP restrictions, or a bounded
process lifetime; the invocation owner still verifies those controls.

All other native Codex `--config` or `-c`, `--profile` or `-p`, `--oss`, and
`--local-provider`, `--remote`, and `--remote-auth-token-env` arguments are rejected because they could change provider,
home, or routing selection. `--model` or `-m` is accepted only when its value
is exactly the configured deployment. Other native arguments are preserved.

The wrapper process receives only its supported base environment: `HOME`,
`PATH`, `LANG`, `LC_ALL`, and `TMPDIR`, plus `SSH_CONNECTION` when the launcher
itself inherited a non-empty value of it. The wrapper derives its SSH-context
Keychain fallback from that variable and then scrubs it. The launcher never
creates the variable, forwards no other `SSH_*` name, and keeps it out of the
`/usr/bin/env` hop, so the Codex process never sees it. The `/usr/bin/env` hop restores
`TERM`, defaulting to `xterm-256color`, plus present `COLORTERM`,
`TERM_PROGRAM`, and the allowlisted `HERDR_ENV`, `HERDR_SOCKET_PATH`,
`HERDR_SESSION`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, and `HERDR_PANE_ID`
values. `CODEX_SESSION_ID` and arbitrary environment variables are never
forwarded through this hop.

If the wrapper cannot resolve the configured credential, launch stops at the
wrapper boundary. Its repair output must remain non-secret.

The installed wrapper and its broker custody are live prerequisites. A broker
sign-in compatibility failure is an installation or custody issue, not a
launcher route that this file attempts to repair.

## Codex desktop provider

The Codex app cannot take `-c` overrides or `--profile`, it starts every new
chat with no provider of its own (`modelProvider` null), and it ignores a
project's provider keys. A new app chat therefore uses the user-level
top-level `model_provider`. `monash-codex-desktop` has two levels:

- `apply` appends one marker block to the user's `~/.codex/config.toml`
  holding only `[model_providers.monash_foundry]` and its `auth` table, so the
  provider resolves in the app while new chats keep the personal default. A
  thread that already records `monash_foundry`, such as one started through
  `monash-foundry codex`, resumes in the app on that provider.
- `apply --new-chat-default` also puts a second marker block at the top of the
  file holding only `model_provider = "monash_foundry"`, so new app chats use
  Monash until `rollback`. It is a temporary qualification setting. Existing
  chats keep the provider they recorded: a personal chat still resumes on the
  personal provider, and no personal history reaches Monash. It refuses an
  existing top-level `model_provider` or `profile`, and it refuses unless the
  top-level `model` and `model_reasoning_effort` are already `gpt-6.1-sol` and
  `high`, the qualified route. It never writes `model`, effort, `profile` or
  `model_catalog_json`, and there is no fallback model. While a managed
  default exists, every `apply`, with or without the flag, refuses again if
  the model or effort has changed or a top-level `profile` appeared, so a
  missing provider is never restored onto another route.
- Either level refuses an unmarked top-level
  `model_provider = "monash_foundry"`; `status` reports it as
  `new_chat_default=unmanaged`.

```text
<install>/monash-codex-desktop [--codex-home DIR] plan|apply [--new-chat-default]
<install>/monash-codex-desktop [--codex-home DIR] status|rollback
```

- `plan` prints only the managed lines it would add and where, never a diff
  of the personal document, and never the current default provider's value.
- `apply` appends the block directly after the file's final newline. It
  refuses: a linked, foreign-owned, group- or world-writable, non-UTF-8 or
  invalid file; a Codex home that is not a private real directory, or one
  below a directory another user can write; a file without a final newline;
  marker text anywhere outside one exact marker pair; an existing
  `monash_foundry` provider outside the markers; and a token helper that is
  missing or not a private executable in trusted directories. It verifies on
  the parsed document that the result is exactly the original plus the
  provider, and that removing the block restores the original bytes.
- `rollback` removes exactly the marker-delimited lines of both blocks,
  keeping every other byte, including later app edits. The default block must
  delimit the document's real top-level `model_provider` and nothing else; an
  unmarked `model_provider = "monash_foundry"` is refused, because it would
  name a provider that rollback removes, and so is a Codex profile whose
  `model_provider` is `monash_foundry` (only their count is printed). A
  personal setting found between the default markers is refused with advice
  to move it out and keep it. It refuses unless the parsed result is
  exactly the current document minus the provider, so markers inside a string
  or a setting that moved past the block can never delete or reparent personal
  settings. An unmarked `monash_foundry` provider is refused with the manual
  repair.
- `status` reports the provider block as `absent`, `applied`,
  `applied-differs`, `applied-unverifiable` or `unmanaged-provider`; the
  default block as `new_chat_default=absent`, `applied`,
  `applied-route-changed` (the app changed the top-level model or effort) or
  `applied-unverifiable`; and whether the default provider is `unset`,
  `monash_foundry` or another provider. It exits non-zero unless the two
  blocks are consistent and verified.

Writer quiescence is a gate, not advice. `apply` and `rollback` refuse while
any process of yours that looks like Codex (the ChatGPT app and its helpers,
its app-server, or a Codex CLI session) uses that Codex home, judged by its
`CODEX_HOME` or, without one, `~/.codex`; a Codex process whose environment
cannot be read blocks every home. They check once before preparing and
again immediately before replacing the file, and name the blocking processes.
Quit the Codex app and every Codex session on this home first; `plan` and
`status` do not need that. Reads use a no-follow descriptor whose identity is
checked again before replacement, and runs on one home are serialized by a
directory lock. A Codex process started in the instant between the last check
and the replacement is not detected, and the app offers no lock this tool can
honour. Run `apply` and `rollback` from a terminal that is not a Codex
session, with the ChatGPT app and every Codex session quit, and start nothing
Codex until the command returns.

Both tools start Python isolated (`#!/usr/bin/env -S python3 -I -B`), so no
module beside them, `PYTHONPATH` entry or user site code is imported. Before
running any Foundry code or reading `config.json`, both tools admit each
file through a no-follow descriptor: a regular file owned by you, writable only
by you, in directories no other user can write. The launcher is executed from
the admitted bytes, not imported by path, and the desktop tool never imports
the token helper. Both tools carry the same trust rules, which a test keeps
identical. An invalid `config.toml` is reported without the parser's message,
which can name personal tables.

The block's `base_url` is the installed `config.json` `codex.base_url`. Its auth
command is the installed `monash-codex-token`, with `args = []`,
`timeout_ms = 30000` and `refresh_interval_ms = 300000`. The helper resolves
`codex.credential_ref` through `with-one-password-token inject
AZURE_OPENAI_API_KEY <ref> -- /usr/bin/printenv AZURE_OPENAI_API_KEY` within 20
seconds and writes the one printable value to Codex's pipe. It takes no
arguments and refuses a terminal on stdin or stdout. It never searches `PATH`
or the working directory for the wrapper: a `commands.with_one_password_token`
override must be absolute, and the wrapper must be a regular file (not a link)
owned by you, writable only by you, in directories no other user can write. On
any failure it prints nothing to stdout and exits non-zero. It
runs on the macOS system Python 3.9, which a GUI-launched Codex may resolve
first. Never run it by hand.

Helper failure limitation: bundled Codex 0.166.0-alpha.5.1 logs a failed or
empty auth command but still sends the prompt without `Authorization`,
retrying until the endpoint refuses (Azure answers 401). The turn then fails.
No personal or `auth.json` credential is substituted
(`requires_openai_auth = false`). Command-backed auth is therefore not a
zero-request gate, and qualification needs an authenticated Azure completion.

`test_codex_desktop.py` proves the helper and the config edits as processes. With
the bundled app engine present, it drives `codex app-server` through the
app's JSON-RPC against loopback fakes. A new chat stays on the personal
provider without running the helper. With `--new-chat-default`, a new chat
resolves `monash_foundry`, `gpt-6.1-sol` and `high` and completes with the
helper's token, a personal chat started earlier still resumes on the personal
provider, and after rollback new chats are personal again. A completed `monash_foundry` thread
resumes with the helper's token. An app-written config edit survives
rollback, and after rollback resume refuses with ``Model provider
`monash_foundry` not found`` before any request. The test replaces the block's
Azure `base_url` with the loopback fake after `apply`.

## Claude Code route

The launcher removes inherited Anthropic API credentials, Foundry API keys and
auth tokens, base URLs, model overrides, Azure OpenAI credentials including
namespaced Monash keys, Bedrock settings, Vertex settings, and both retired
home variables. It sets only the native Foundry route:

```text
CLAUDE_CODE_USE_FOUNDRY=1
ANTHROPIC_FOUNDRY_RESOURCE=<resource>
ANTHROPIC_DEFAULT_OPUS_MODEL=<opus>
ANTHROPIC_DEFAULT_SONNET_MODEL=<sonnet>
ANTHROPIC_DEFAULT_HAIKU_MODEL=<haiku>
```

Authentication uses the native Azure default credential chain after removing
inherited credential-chain selectors and service-account tokens. The launcher checks
the current default account with `az account show`, verifies the configured
subscription name or ID, exact tenant ID, enabled state, and default-account path, and stops
with this repair action when the check fails:

```text
az login --tenant <tenant> && az account set --subscription <subscription>
```

Claude 2.1.266 does not support selecting only AzureCliCredential with
`AZURE_TOKEN_CREDENTIALS`. Account preflight and a successful native request are
separate proof boundaries; do not infer one from the other.

The launcher adds a fixed command-line `--settings` environment block. It pins
the Foundry route and Azure CLI cache path and blanks competing auth/provider
values so user/project/local settings cannot restore them. Other settings,
including hooks and skills, continue to load. Organizational managed settings
outrank these command-line settings and must be checked during host qualification.

A caller may pass one Claude `--settings` value, as Herdr Projects does for its
turn-end hooks. It is either an absolute path to a regular file owned by the
current user and not group or world writable (the Projects private hook file
form), or one inline JSON object. The launcher removes it from the native
arguments, validates it, and passes one effective `--settings` object: every
caller setting (including `hooks`) is kept and the pinned provider `env` is
added last. That object never enters argv, stdout, or stderr. At exec the
launcher writes it to an anonymous private file (mode 0600, unlinked before the
content is written, so no named file ever holds it), then passes `--settings
/dev/fd/N` for a read-only inherited descriptor. The name is never trusted: the
descriptor is opened with `O_NOFOLLOW` and must be the same inode as the created
file, and the content is written only once the file has no name left. A swapped
or linked file fails the launch with exit 3 before the native process starts. `dry-run` and `check` create
nothing, and an unusable `TMPDIR` (it must be an existing absolute directory)
stops the launch before the native process starts. The descriptor stays open for
the native process lifetime and is inherited by its children; nothing outlives
them. The value is refused when it is malformed, has duplicate JSON keys,
repeats the flag, is a relative path, a symbolic link, unreadable, or over 1 MiB,
or when it sets provider, credential, home, or model environment (including
`AZURE_CONFIG_DIR`, `HOME`, and `ANTHROPIC_MODEL`) or `apiKeyHelper`,
`awsAuthRefresh`, `awsCredentialExport`, `forceLoginMethod`,
`forceLoginOrgUUID`, or `model`. Errors name only the reserved setting, never a
value, because a hook file carries a task token. Without `--settings` the
launcher passes only the pinned `env` inline, as before. Cloud/environment and fallback-model flags are rejected.
A legacy caller may choose `--model` or `-m` with the configured
aliases `opus`, `sonnet`, `sonnet5`, or `haiku`, or with one of their configured
deployment values. When no model is selected, the launcher explicitly passes
the configured Sonnet deployment so personal defaults cannot win. The explicit
`launch --model STABLE_ID` path instead requires the selected exact deployment
and never maps an alias to another model.

## OpenCode route

OpenCode is an explicit model-selection route. The `opencode` config block must
contain both resource entries and a minimum semantic version of `1.18.27` or
newer:

```json
"opencode": {
  "resources": {
    "gpt": {
      "resource": "monash-edu-esol-smst-ai-dev-gpt",
      "base_url": "https://monash-edu-esol-smst-ai-dev-gpt.services.ai.azure.com/openai/v1"
    },
    "claude": {
      "resource": "monash-edu-smst-ai-claude-code",
      "base_url": "https://monash-edu-smst-ai-claude-code.services.ai.azure.com/openai/v1"
    }
  },
  "minimum_version": "1.18.27"
}
```

Each OpenCode resource endpoint must be its matching Azure `.services.ai`
chat-completions endpoint. The launcher selects the exact deployment from the
inventory binding and writes a process-scoped route config containing only the
Azure provider, base URL, deployment ID, completion URL mode, cache-key setting,
and the selected model. It also supplies
`OPENCODE_AUTH_CONTENT={"azure":{"type":"oauth"}}`. No API key or OAuth
secret is read from `config.json` or printed by the launcher.

OpenCode v1.18.29 discovers static global config, project config, config
directories, and plugins before applying late `OPENCODE_CONFIG_CONTENT`.
`OPENCODE_CONFIG_DIR` alone is therefore not a custody boundary. For an
OpenCode launch, the launcher validates Herdr integration v11 markers in the
canonical `herdr-agent-state.js` and `herdr-tui-session.js` assets, then creates
a mode-700 process-scoped XDG config root. It sets both `XDG_CONFIG_HOME` and
`OPENCODE_CONFIG_DIR` to that root, disables project config, writes an isolated
`opencode.json`, and points `OPENCODE_TUI_CONFIG` at a file containing only the
absolute Herdr TUI plugin URL. The route config contains only `azure`, and the
server plugin list contains only the absolute Herdr lifecycle/session plugin
URL. Missing or incorrectly marked Herdr assets are refused. A `$HOME/.opencode`
directory is also refused because OpenCode discovers it independently of the
project-config switch. Canonical user config, project config, and competing
plugins are consequently isolated without modifying them. Native persisted
model and session state stays in place, but cannot override the explicit route.

The native OpenCode provider owns OAuth. `AZURE_CONFIG_DIR` points OpenCode at
the existing Azure CLI credential cache, and the native XDG data and state
roots remain unchanged so histories and credentials are preserved. Ambient
provider credentials and OpenCode selection/configuration override variables
are removed before the version preflight and child. The launcher also removes
the uppercase and lowercase HTTP, HTTPS, ALL, and NO proxy-routing variables
before both processes, so ambient proxy state cannot redirect this route.

The launcher passes an explicit `--model azure/<stable-id>` and the isolated
config pins `model` and `enabled_providers: ["azure"]`. OpenCode's persisted
session model, recent model, and agent selection therefore cannot replace the
selected route. Native `--model`, `-m`, `--agent`, session/continue/fork,
attach, config, and pure-mode overrides are refused before version preflight.
The route deliberately does not pass `--pure`, which leaves Herdr's external
lifecycle and session plugins available.

`--dry-run` reports the canonical `native_cli` path used for OpenCode. The
frontend must invoke that launcher path and verify the eventual native
OpenCode argv[0] against the same configured executable; Herdr
`interactive_ready` alone does not prove that the launcher or native child was
used.

Both `check` and `launch` run the configured OpenCode executable with the
sanitized environment and require its reported semantic version to meet the
minimum. The probe runs before the native child. A version below `1.18.27`, a
missing semantic version, or a failed probe stops the route without a provider
request or native child launch.

The five implemented OpenCode routes are `gpt-5.4-nano`, `deepseek-v4-pro`,
`deepseek-v4-flash`, `kimi-k2.7-code`, and `kimi-k2.6`. All five are qualified
for production launch on laptop and Mini. Use `--qualification` for an explicit
foreground trial of an available, implemented, compatible, untested route. This
flag does not change the inventory, qualify the route, or write evidence. A
`qualified` production route launches without the flag and without the
qualification permission fixture.

During an explicit qualification trial only, the launcher adds this temporary
read-only fixture to `OPENCODE_CONFIG_CONTENT`:

```json
{
  "permission": "deny",
  "agent": {"build": {"permission": {"read": "allow"}}}
}
```

The fixture denies other permissions while allowing the harmless build-agent
file-read trial. A qualified production route omits both keys so OpenCode can
operate as the native coding agent.

Caller `--pure`, `--pure=...`, and the supported `--no-pure` form are refused.
`--model`, `-m`, and `--config` are also reserved. OpenCode's `--attach`,
`--attach=URL`, and direct `attach URL` remote-server forms are refused before
version preflight because they could bypass the selected route and its billing
boundary. Other native arguments retain their order and value.

## Output and ownership

Before a real exec, the launcher writes one concise line to stderr:

```text
host=<host> agent=<codex|claude|opencode> provider=<provider> deployment=<deployment>
```

It never prints secret values, credential output, or forwarded native argument
values. `exec` preserves the native process and exit code, allowing Herdr to
observe the intended Codex, Claude Code, or OpenCode process directly.

Exit codes are `0` for success, cancellation, help, or a passing check, `2`
for usage/config errors, `3` for launch prerequisites or diagnostics, and `130`
for Ctrl-C. Native exit codes are inherited after `exec`.

Herdr entry wiring, installation, `config.json`, tests, live provider proof,
and Ledger closeout are coordinator-owned.
