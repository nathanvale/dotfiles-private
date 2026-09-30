# vault-notes

`bin/vault-notes` is the inspect-only front door for the vault's `check`, `list`
and `inventory` commands, ported unchanged from the playground vault's
`scripts/vault-{files,check,list,inventory}.ts`, and for `resources`, which
proposes each project's Resources Index. `--help` owns the syntax.

## Command map

| Command | Users | Effect class | Output contract |
| --- | --- | --- | --- |
| `vault-notes check` | humans, agents, Vault Steward's candidate check (exit code only) | inspect | legacy, frozen byte-for-byte |
| `vault-notes list` | agents before note creation, humans | inspect | legacy, frozen byte-for-byte |
| `vault-notes inventory` | humans | inspect | legacy, frozen byte-for-byte |
| `vault-notes resources` | agents inside a Vault Steward candidate, humans previewing | inspect | Contract Core 2.0, simple profile |
| `vault-notes --help`, `--discover`, `--discover-command ID` | agents | inspect | Contract Core 2.0, simple profile |

Each legacy command receives its remaining arguments unchanged, so its stdout,
stderr and exit code match the vault script it replaces. They emit no 2.0
envelope; `--discover-command` declares their outcomes instead of 2.0 stations.
Unifying the three legacy JSON shapes is a later, versioned decision.

## Resources Index

Each project keeps `projects/<slug>/resources.md`, linked from its README. The
index has a human-curated shared block and a generated block that lists every
note the project owns: every note the contract routes to `reference` or
`decision` at any depth, except packet files, governed `specs/`, `tickets/` and
`proofs/` notes, notes the contract routes to any other type (a routed
project directory, a packet file name below the project root, or a repository
file or prefix route), folder READMEs and the index itself. The generated block also
links each folder map (nested READMEs and governed-folder READMEs).
`src/resources-index.ts` owns the rules; ownership and roles come from the
Vault Catalogue placement, never from `related`, topics or links.

- **Activation.** The vault contract key
  `"projectResources": { "indexFile": "resources.md" }` in
  `schemas/frontmatter-contract.json` switches the rules on. Absent, `check`
  output is unchanged and `resources` still proposes with `resources.md`. Any
  other value, including an unknown key, is a `resources-contract-invalid`
  finding, never a silent no-op. Owned types and governed folders are not
  repeated in the key: the contract's routing and the Catalogue own them.
- **Markers.** `<!-- project-resources:shared:start -->` / `:end -->` bound
  the shared block, which regeneration never touches.
  `<!-- project-resources:generated:start -->` / `:end -->` bound the
  generated block, which regeneration replaces completely. Every byte outside
  the generated block, frontmatter and label lines included, is preserved.
- **Entries.** `- [<title>](<path>)`, then `_(archived)_` or `_(superseded)_`
  for historical notes, then `: <summary>`, all from the note's frontmatter.
  A Markdown link inside a title or summary is reduced to its label, so the
  copied text never forms a link that would resolve from the index.
  Folder maps come first, then the project root, then folders in path order.
- **Findings.** `check` reports `resources-route-missing`,
  `resources-index-missing`, `resources-block-invalid`, and, per generated
  entry, `resources-entry-missing`, `-stale`, `-foreign` and `-duplicate`.
  Entry text may drift from frontmatter without a finding; only the entry set
  is checked, so a summary edit does not force an index edit. Broken links stay
  with `link-missing-target`.
- **Route.** Any visible local link to the index anywhere in the project README
  counts; links inside HTML comments or fenced code blocks do not.
- **Writes.** `vault-notes resources --json` returns each proposal's complete
  `content` and `state` (`create`, `update`, `current`, or `blocked` when block
  markers need a hand repair). Write it inside a Vault Steward candidate;
  `--updated` dates only a newly created index.

`vault-notes --discover-command vault-notes.resources --json` names the
stations, finding identifiers and the contract key shape.

## Vault Catalogue

`src/vault-catalogue.ts` is the one owner of which Markdown files are vault
notes and where each note sits. `openCatalogue(root)` reads the contract.
`notes(include?)` returns governed notes with their placement (family, owning
project, artifact folder, path and folder inside the project, project role,
index role, routed types); it selects before any note
is read and reads one note at a time in path order (list, inventory).
`notesWithFilenamePolicy()` also returns the files the uppercase-filename rule
governs, under its own exclusion list; both walks finish before any note is
read (check). The project role (`packet`, `folder-map`, `artifact`, `routed` or `note`), the index role
and routed types read `contract.routing` only when accessed, so list and
inventory keep working with an incomplete routing block.

## Fixture contract

`tests/fixtures/frontmatter-contract.json` is a snapshot of the vault's
`schemas/frontmatter-contract.json` at vault commit `2f88629` (SHA-256
`c4aacdf0d31557eaef3f0f242d330795c8a3d649e6295180309146dd57563f11`). Tests read
the snapshot, never a live vault. Refresh it deliberately when the vault
contract changes.

## Known inherited defects

These are preserved deliberately: fixing each one changes today's output, so
each needs its own finding identifier and an explicit decision.

- A local link containing a malformed `%` escape throws `URIError` and aborts
  the whole check (`validateLinks`, unguarded `decodeURIComponent`).
- An in-root target under a directory whose name starts with `..` (for example
  `..notes/`) is classified as escaping the root, so a canonical copy hides a
  missing link (`escapesRoot`).
- The `proofs` folder is routed only in code (`ARTIFACT_FOLDERS` in the Vault
  Catalogue); the vault contract's `projectDirectories` lists only `specs` and
  `tickets`.
