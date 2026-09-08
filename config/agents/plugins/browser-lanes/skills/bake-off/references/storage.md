# Recipe storage and reuse

Apply `context-advisor` when placing, promoting, or reusing recipes. Read its
storage-routing reference; it advises without writing. If the skill is missing,
return the proposed paths and dependency gap rather than inventing its advice.

## Owners

| Content | Canonical owner | Privacy and mutation |
| --- | --- | --- |
| Bake-off workflow and blank templates | Browser Lanes versioned plugin source | Maintainer-controlled source; no learned site data |
| Verified recipe and linked scripts | `${XDG_DATA_HOME:-$HOME/.local/share}/browser-lanes/recipes/<recipe-id>/` | Nathan-owned user-local data; foreground driver promotes checked revisions |
| Attempt notes, candidate scripts, report and raw proof | `${XDG_STATE_HOME:-$HOME/.local/state}/browser-lanes/bake-offs/<challenge-id>/` | Private per-contender state; each contender writes only its assigned directory |
| Sanitized findings and cross-repository context | Configured vault project packet | Foreground driver under vault write rules |
| Credentials and authentication | Existing browser profile and credential owner | References only in recipes |

Use absolute XDG paths; ignore relative overrides and use the defaults. Use
opaque non-sensitive IDs, mode-700 directories, and mode-600 files. Reject
symlinked destinations. Inspect existing paths before writes; preserve unrelated
content. Parameterize account, dates, hours, notes, and other private task data.
Avoid full page dumps when bounded assertions suffice.

## Inspect and refresh

Use ordinary file reads and `rg` to find recipes by workflow and app. Read the
recipe's verification state, tested date, adapter versions, script hashes,
preconditions, and linked report before relying on it. The foreground driver
owns status inspection and refresh; no registry, database, or background service
is required. A report is evidence, never authority to repeat a mutation.

Verify script bytes against their recorded hashes. Check current origin,
identity, task inputs, and relevant page conditions through the lane. Treat
missing evidence, changed scripts, materially different app state, or changed
execution capabilities as needing fresh verification. Update a recipe's evidence
only after observing the new result. The agent may adapt the technique within
the current task's authority.

## Retain and recover

Before the first durable trial write, record Nathan as owner, the exact store,
writer, sensitivity, retention/deletion date, and evidence purpose in the report.
Use 30 days for raw trial evidence by default; the driver reports due deletion
and Nathan owns removal, with no automated deletion service. For reusable
recipes, retain the verified revision and at most one predecessor for recovery;
review retention when replacing it. Confirm a different retention need with
the owner instead of accumulating unlimited history.

Keep verified files together for private backup. Promote from a verified
candidate into a new directory, then read back the files and hashes before
updating the recipe pointer. Resolve every evidence/script link from the new
destination and verify it identifies the accepted revision; copying equal bytes
does not preserve relative-link meaning. Record the raw evidence deletion date
and the verification metadata retained with the recipe. Missing or expired
evidence stays an explicit reuse limit, not a silent verified claim.

If promotion is partial, leave the previous recipe
canonical and inspect the exact incomplete candidate before repair. Deleting a
recipe includes linked scripts and its private backup copies as approved by the
owner. Redact secrets and private payloads before any promotion into repo or
vault; raw receipts and screenshots stay in private state.

The plugin cache, skill source, vendor memory, and vault are not learned-state
stores. Plugin upgrades must not overwrite user recipes.

## Legacy and metadata changes

Markdown-only and single-adapter recipes remain usable. Migrate a legacy record
only with explicit complete step contracts that retain its ordered step IDs and
adapter choices; write a new v2 candidate and leave the legacy recipe unchanged.
An observed repair records its verified no-effect failure and exact fallback
success in a new candidate revision. Record metadata-only provenance separately
from accepted candidate and promoted-path hashes. Any execution change requires
fresh independent acceptance.
