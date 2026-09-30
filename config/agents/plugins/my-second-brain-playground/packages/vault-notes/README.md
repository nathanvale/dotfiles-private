# vault-notes

`bin/vault-notes` is the inspect-only front door for the vault's `check`, `list`
and `inventory` commands. It was ported unchanged from the playground vault's
`scripts/vault-{files,check,list,inventory}.ts`; `--help` owns the syntax.

## Command map

| Command | Users | Effect class | Output contract |
| --- | --- | --- | --- |
| `vault-notes check` | humans, agents, Vault Steward's candidate check (exit code only) | inspect | legacy, frozen byte-for-byte |
| `vault-notes list` | agents before note creation, humans | inspect | legacy, frozen byte-for-byte |
| `vault-notes inventory` | humans | inspect | legacy, frozen byte-for-byte |
| `vault-notes --help`, `--discover`, `--discover-command ID` | agents | inspect | Contract Core 2.0, simple profile |

Each legacy command receives its remaining arguments unchanged, so its stdout,
stderr and exit code match the vault script it replaces. They emit no 2.0
envelope; `--discover-command` declares their outcomes instead of 2.0 stations.
Unifying the three legacy JSON shapes is a later, versioned decision.

## Vault Catalogue

`src/vault-catalogue.ts` is the one owner of which Markdown files are vault
notes and where each note sits. `openCatalogue(root)` reads the contract.
`notes(include?)` returns governed notes with their placement (family, owning
project, artifact folder, index role, routed types); it selects before any note
is read and reads one note at a time in path order (list, inventory).
`notesWithFilenamePolicy()` also returns the files the uppercase-filename rule
governs, under its own exclusion list; both walks finish before any note is
read (check). The index role and routed types read `contract.routing` only when
accessed, so list and inventory keep working with an incomplete routing block.

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
