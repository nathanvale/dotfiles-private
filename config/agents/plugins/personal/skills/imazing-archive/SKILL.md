---
name: imazing-archive
description: Append iMazing iMessage CSV exports and their attachment folders into a private, deduplicated message archive, then record image review and album decisions. Use for importing a new iMazing export, checking what an export would add, finding missing or ambiguous attachments, recording Luna's image classification, or recovering an interrupted import.
---

# iMazing Archive

The archive is append-only private history. Source CSVs and attachment folders
are read only; the helper copies what it keeps.

## Run the helper

Resolve `skill_dir` from the directory containing this loaded `SKILL.md`, then
run `bun --no-install "$skill_dir/helper/dist/imazing-archive.js" <command>`.
For repository development only, run `bun run --silent src/cli.ts <command>`
from the repository skill's `helper/` directory. Add `--json` for the machine
envelope. `--help` prints the exact usage.

## Import one export

1. Name the archive with `--archive DIR`: a new or existing archive folder,
   never the existing meme corpus or a folder inside the attachments root.
   The helper refuses a non-empty folder that lacks `archive.json`.
2. Name the attachments root with `--attachments DIR`: the folder holding the
   export's exported files (files at depth one or two). For a new-style export
   it is the CSV's own folder; for the 2025 archive export it is
   `Text Message History/Attachments`.
3. Preview:
   `import --archive DIR --csv FILE --attachments DIR --preview`.
   Preview writes only a private receipt; the archive stays untouched.
4. Read the receipt it names. Report its counts to Nathan, including
   `attachmentRowResolution`, `planned`, and the `ambiguous*`, `missing*`, and
   `unreferencedFiles` lists.
5. Apply the reviewed plan: rerun the same command with `--plan DIGEST` in place
   of `--preview`. A changed archive or source refuses as stale; preview again.

Done when the apply result is `SUCCESS_COMPLETED`, or `SUCCESS_UNCHANGED` for an
export that is already imported, and the receipt's unresolved lists are
reported.

## Ambiguous and missing

- **Missing**: no file under the attachments root matches the row's attachment
  name at its Message Date.
- **Ambiguous attachment**: candidate files with different bytes, or a
  `Web link.url` file whose second matches more than one message with a URL.
- **Ambiguous message**: an export without Message IDs has a row whose
  fingerprint (date, direction, text, attachment name) matches more than one
  archive item, or repeats inside the export. The row is held, not merged.

The helper never picks among candidates. Report these lists; resolve them only
with Nathan.

## Review images

`derived/pending-images.csv` lists resolved images with no `reviewed` decision.
After Luna's visual review, record it against the row's `item_key`:

```bash
decide --archive DIR --item KEY --image-type screenshot --contains-meme true --reviewed
```

`--album selected|rejected|undecided` is a separate keeper decision; review
alone never selects an image. Decisions live in `records/decisions.jsonl` and
survive later imports.

## Receipts and recovery

- Every run writes a private receipt to
  `${XDG_STATE_HOME:-~/.local/state}/imazing-archive/receipts/`; an apply also
  copies it to the archive's `imports/`.
- A `TRANSIENT_NOT_STARTED` result means another writer is active; retry later.
- After an interrupted apply, run `recover --archive DIR`. It inspects and
  never replays; follow [archive format](references/archive-format.md#recovery)
  for an unproven import.

Read [archive format](references/archive-format.md) before editing archive
files by hand or explaining identity, fingerprints, or exported-name rules.
