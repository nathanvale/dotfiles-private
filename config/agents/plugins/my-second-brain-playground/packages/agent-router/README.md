# Agent Router

Inspect-only Agent Router for the Herdr Projects goal
(`projects/herdr-projects/GOAL.md` in the playground vault, decisions D1 to D7
and D10). It inventories routes and prints a dry-run decision card for one
Beads Task. It never launches an agent, consults TypeSafe, reads credentials,
refreshes the Monash snapshot, or writes any file. Public help owns the exact
syntax:

```sh
"${PLUGIN_ROOT}/bin/agent-router" --help
"${PLUGIN_ROOT}/bin/agent-router" --discover --json
```

CLI Design Contract Core 2.0, simple profile: every command is `inspect`.

## Commands

- `routes`: the route inventory. Declared routes come from the routes file;
  Monash Foundry routes come from `monash models --json` (installed snapshot,
  status `qualified` only). A missing routes file is reported, not refused.
- `run TASK --dry-run`: the decision card. `TASK` must be a Beads Task
  identifier; Task text is refused and never echoed. Without `--dry-run` the
  command refuses with `DOMAIN_AUTHORITY_REQUIRED`. A missing routes file
  refuses with `DOMAIN_CONFIG_MISSING`.

## Routes file (version 1)

Default `$XDG_CONFIG_HOME/agent-router/routes.json` (else
`~/.config/agent-router/routes.json`); override with `--routes-file`. Nathan
declares it; the router only reads it. Every object is closed: an undeclared
field is a `SCHEMA_CONFIG_INVALID` refusal, so no secret-bearing field can be
carried. Route order is the fixed local order used for the pick.

```json
{
	"schemaVersion": 1,
	"routes": [
		{
			"id": "personal-claude-code",
			"harness": "claude-code",
			"model": { "id": "claude-opus-5-5", "alias": "opus" },
			"effort": "high",
			"account": { "alias": "personal", "ownership": "personal", "plan": "Claude Max" },
			"hosts": ["laptop"],
			"launch": "allowed"
		}
	]
}
```

- `harness`: `claude-code`, `codex` or `opencode`.
- `model.id`: the exact model identity; Model Guides are matched on it.
  `model.alias` is the optional launch argument (`opus` is an alias, not an
  identity).
- `effort`: `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. The card
  shows it as declared; observed effort stays `unknown` (D7).
- `account.ownership`: `personal`, `employer` or `shared`; `account.plan` is
  an optional non-secret label.
- `hosts`: host-profile ids, such as the `host_role` recorded by the Monash installation.
- `launch`: `allowed` or `dry-run-only`.

## Evidence and gates

| Evidence | Owner and source |
| --- | --- |
| This host's role | `host_role` in `~/.local/share/monash-foundry/installation-manifest.json` only. Missing or unreadable means unknown. The Monash `config.json` holds credential fields and is never opened. |
| Monash routes | `monash models --json`; an evidence host counts when it is this host's role or a host declared in the routes file, and this machine's hostname maps to its recorded role; any other name stays unmapped. |
| Harness presence | `claude`, `codex` or `opencode` `--version`. |
| Model Guide | `skills/stage-manager/guides/<harness>/<model id>.md`, reviewed only when its `.review.md` records `verdict: accepted` and the guide's current sha256. The card's guide revision is that sha256. |
| Herdr Projects target | `<--herdr-projects-root or $HERDR_PROJECTS_ROOT>/<--project>/PROJECT.md`. |

Gates run in order for every route; the first `refuse` is the route's refusal.

| Gate | Declared route | Monash route |
| --- | --- | --- |
| G1 model listed | exact model declared | model in the snapshot |
| G2 available on host | harness present; this host in `hosts` | available in a snapshot no older than 7 days |
| G3 account ownership and identity | unknown: no owner observes identity yet | unknown, as an employer route |
| G4 quota and reserve | unknown: no usage source yet | refused until a supported usage source exists (D5) |
| G5 route qualification | `launch: allowed`, reviewed guide, harness at the guide's minimum version | qualified on this host's role; never declared for launch (D1); reviewed guide |

Evidence whose age exceeds exactly 7 days (compared in milliseconds) is
`stale`; a timestamp in the future is invalid evidence, shown as `unknown`;
absent evidence is `unknown`. Unknown identity, quota or host role on a
personal route becomes `confirm` (Nathan must confirm, D4 and D5); on an
employer or shared route it refuses. Because G3 and G4 have no observing owner
yet, a personal route reaches at most `needs-confirmation`; the hpr-f5n.4
launch slice adds evidence only from an owner it can observe.

The pick is always provisional with TypeSafe not consulted (D10):
`needs-confirmation`, `ask` (more than one route qualifies) or `none-eligible`.
Each is a successful dry run; the pick status carries the meaning because
Contract Core refusals carry no data.

## Output

Machine output is serialized, then the complete serialized value is validated
against the correlated result arms before it is written; an invalid value is
replaced by the validated `INTERNAL_RESULT_SERIALIZATION` fallback. A stdout
transport failure (including a consumer closing the pipe) is not a
serialization failure: machine mode exits 1 with empty stderr and no
replacement envelope; human mode prints one repair line on stderr.

## Tests

`bun test packages/agent-router/tests` from the plugin root. Fixtures give each
process its own HOME, XDG directories and shim executables; no test reads the
user's routes file or runs the installed `monash`. Credential-bearing fixture
files are mode 000, so any attempt to open one fails the run.
