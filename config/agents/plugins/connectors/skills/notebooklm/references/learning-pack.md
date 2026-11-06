# Learning packs

A learning pack is one source-bound NotebookLM notebook per requested codebase
or review, opened from a short Start Here view. This release admits two reads,
`pack_check` and `pack_status`. Pack creation, source upload, generation and
every other effect are unadmitted and refuse before dispatch.

## Register the pack root

The pack root is the pack folder in the vault project packet. Register its
real path by label once on each host, in the NotebookLM pack-roots file under
the Connectors state root:

```text
$XDG_STATE_HOME/connectors/notebooklm/pack-roots.json   (else ~/.local/state/...)
directories 0700, file exactly 0600, owned by this user
{"schemaVersion":1,"roots":{"learning":"/real/path/to/packs"}}
```

- Write the real path. A root reached through a symlink refuses
  `pack-root-invalid`.
- A manifest outside every registered root refuses `pack-root-unregistered`
  before the manifest or any source is opened.
- Write pack sources through the vault's own write route; Connectors only reads
  them.

## Layout

```text
ROOT/PACKID/manifest.json      Learning Pack Manifest
ROOT/PACKID/sources/FILE       one plain file per selected source
```

Only files the manifest names are opened. Each must be a plain, single-link
UTF-8 regular file of at most 256 KiB directly inside `sources`; the manifest
must also be single-link. A symlink anywhere below the root, a hard-linked
file, a nested or `..` name, or a special file refuses
`pack-source-not-contained` before any source is read. Each read must open the
same inode its path check saw, or it refuses the same way.

## Manifest

```json
{
  "schemaVersion": 1,
  "pack": {
    "id": "connectors-pr-230",
    "title": "Connectors at PR 230",
    "request": "Make a learning pack for Connectors at PR 230.",
    "provenance": { "repo": "nathanvale/dotfiles", "commit": "e3b1ab08", "subtree": "config/agents/plugins/connectors", "plugin": "connectors 0.8.5", "vendor": "notebooklm-mcp-cli 0.15.8" }
  },
  "notebook": { "mode": "bind", "id": "NOTEBOOK-UUID" },
  "sourceRoot": "learning",
  "sources": [{ "key": "overview", "file": "overview.md", "title": "Exact existing title" }],
  "artifacts": { "mission": { "id": "QUIZ-UUID" }, "audio": { "id": "AUDIO-UUID" }, "map": { "id": "MAP-UUID" } },
  "preferences": { "audioLength": "short", "deeper": false }
}
```

- `pack.id` equals the `PACKID` folder; `sourceRoot` equals the registered label.
- `notebook.mode` defaults to `create-if-needed`, which takes no `id`. `bind`
  requires `id`. `adopt` defaults to false, is allowed only in bind mode, and
  the trial notebook `19ae491d-ea63-4da0-be29-aefcdbf8964e` refuses it.
- `sources[].title` names an existing notebook source title to match exactly.
  Without it the expected title is the digest title `KEY [sha256:FIRST12]`.
- `artifacts` defaults: mission `quiz`, 5 questions (proposed, gate G6 open),
  `easy`; audio `audio`, `deep_dive`, length from `preferences.audioLength`
  (default `short`); map `mind_map`. An artifact `id` binds an existing Studio
  item and is allowed only in bind mode.
- Unknown fields refuse `pack-manifest-invalid`.

## Source format

Copy [the reference template](templates/reference.md). A source opens with a
front-matter block whose `pack`, `repo`, `commit`, `subtree`, `plugin` and
`vendor` equal the manifest. Each list-item claim starts with `[verified]`
(observed behaviour), `[proposal]` or `[decision]` (accepted by Nathan).

The provenance verdict is `verified`, `missing`, `mismatch` (names the fields)
or `refused`. It refuses session ids, account emails, home paths, host names
(including this host's) and these five known-false trial claims, each stated
here as its true form:

- Preview may read but never dispatches a mutating write.
- Credential headers are provider-specific.
- A configured key that fails has no fallback.
- Unknown-effect recovery is connector-specific.
- Unlock is neither adjudication nor retry permission.

Reasons carry a code and a line number, never the matched text. The claim
checks are pattern heuristics; a `verified` verdict is not a review.

## Reads

```sh
../../bin/connectors run notebooklm --select profile=default pack_check --input '{"manifest":"/real/path/to/packs/PACKID/manifest.json"}'
../../bin/connectors run notebooklm --select profile=default pack_status --input '{"manifest":"/real/path/to/packs/PACKID/manifest.json"}'
```

- `pack_check` starts no child. It returns each source's digest, byte count,
  provenance and claim-label verdicts, the resolved manifest defaults and
  `ready`.
- `pack_status` checks the pack the same way, then requires profile readiness.
  In bind mode it reads `notebook_get` for the bound id and pages Studio with
  details, at most four vendor calls. A failed or mismatched notebook read
  refuses `pack-notebook-unverified`; nothing is created. In create-if-needed
  mode it binds nothing and reports only an advisory scan of up to 20 notebooks:
  `seen`, the vendor `total`, `complete`, and pack-marked ids. A scan never
  proves absence.

## Item states

`present`, `missing`, `duplicate`, `pending`, `failed`,
`completed-unconfirmed`, `confirmed`, `superseded`, `stale`, `stale-sources`,
`unknown`, `unmarked`. This release derives each from the current read only:

- Notebook: `present` when its title carries `[lp:PACKID]` or
  `[lp:PACKID:NONCE]`, or it holds a source titled `Start Here [lp:PACKID]`;
  otherwise `unmarked`, which stays read-only. Unbound: `missing` only when a
  complete advisory scan saw no pack-marked notebook; otherwise `unknown`.
- Source: one exact title is `present`; several are `duplicate`; a digest title
  for the same key with another digest is `stale`.
- Mission, audio and map: a bound id, or the role marker as a whole token,
  `lp:PACKID:ROLE` or `lp:PACKID:ROLE:NONCE`, in the title or custom
  instructions (`lp:PACKID:missionary` is not a mission). Vendor `completed`
  reads `completed-unconfirmed` until Nathan confirms the full view, or
  `stale-sources` when any pack source is `stale` or `missing`, or when the
  artifact's exposed source ids differ from the present pack sources. More than
  one match is `duplicate`; none is `missing` after a complete scan and
  `unknown` after an incomplete one. One artifact id seen on two overlapping
  Studio pages counts once.

Role evidence records the type, status, whether custom instructions exist or
carry the marker, the exposed source-id count and whether it equals the
present pack sources, and `durationSeconds`.

## Start Here

`pack_status` returns `startHere`: one primary action, the 5-minute mission,
two links, the Short Deep Dive audio and the map, a one-line next action and
text rendered from [the Start Here template](templates/start-here.md). Links
retain exact read-back artifact ids. Navigation requires one UUID artifact id
whose read-back type matches its role, plus a vendor notebook URL for the bound
id on `https://notebooklm.google.com/notebook/ID` or
`https://notebook.google.com/notebook/ID`, with no userinfo, query, fragment or
extra path. Mission and map links open `/artifact/ARTIFACT_ID` below that
notebook URL. Audio opens the notebook; select the matching audio item in
Studio using its read-back id. No standalone audio route is qualified. Missing
or unsafe notebook URLs, missing or duplicate artifacts, non-UUID artifact ids
and wrong-role types carry no navigation URL.

## Not yet admitted

The mission, audio and map templates describe proposed generation
instructions; nothing sends them in this release. Notebook creation, source
add, Studio generation, writer claims, scratch qualification and recovery stay
refused until their own slices are qualified.
