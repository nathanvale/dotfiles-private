---
name: imazing-archive
description: Append iMazing iMessage CSV exports and their attachment folders into a private, deduplicated message archive, then record image review and album decisions. Use for importing a new iMazing export, checking what an export would add, finding missing or ambiguous attachments, recording image classification from the recommended classifier lane, or recovering an interrupted import.
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
   The helper refuses a non-empty folder that lacks `archive.json`. One archive
   holds one chat: the first apply records the export's Sender IDs, and an
   export with different Sender IDs is refused. The first apply also fixes the
   archive start date: `--start-date YYYY-MM-DD`, default `2023-10-15`. Every
   later import passes the same date (an omitted flag means the default); a
   different date is refused. Rows dated before it, compared on the date part
   of the local Message Date, are left out and counted as `beforeStart`.
2. Name the attachments root with `--attachments DIR`: the folder holding the
   export's exported files (files at depth one or two). For a new-style export
   it is the CSV's own folder; for the 2025 archive export it is
   `Text Message History/Attachments`.
3. Preview:
   `import --archive DIR --csv FILE --attachments DIR --preview`.
   Preview writes only a private receipt; the archive stays untouched.
4. Read the receipt it names. Report its counts to Nathan, including
   `beforeStart`, `attachmentRowResolution`, `planned`, and the `ambiguous*`,
   `missing*`, and `unreferencedFiles` lists.
5. Apply the reviewed plan: rerun the same command with `--plan DIGEST` in place
   of `--preview`. A changed archive or source refuses as stale; preview again.

Done when the apply result is `SUCCESS_COMPLETED`, or `SUCCESS_UNCHANGED` for an
export that is already imported, and the receipt's unresolved lists are
reported. Re-importing a seen export retries its missing attachment links, so
add late files to the attachments root and import again.

## Ambiguous and missing

- **Missing**: no file under the attachments root matches the row's attachment
  name at its Message Date.
- **Ambiguous attachment**: candidate files with different bytes, or a
  `Web link.url` file whose second matches more than one message with a URL.
- **Ambiguous message**: an export without Message IDs has a row whose
  fingerprint (date, direction, text, attachment name) matches more than one
  archive item, or repeats inside the export. The row is held, not merged.
- **Ambiguous link**: a Message ID row matches fingerprint-only items, but not
  one-to-one. Both sides are kept and name each other in
  `derived/messages.csv` column `ambiguous_with`.

The helper never picks among candidates. Report these lists; resolve them only
with Nathan.

## Review images

`derived/pending-images.csv` lists resolved images with no `reviewed` decision.
After the recommended classifier lane's visual review, record it against the row's `item_key`:

```bash
decide --archive DIR --item KEY --image-type screenshot --contains-meme true --reviewed
```

`--album selected|rejected|undecided` is a separate keeper decision; review
alone never selects an image. Decisions live in `records/decisions.jsonl` and
survive later imports.

## Receipts and recovery

- An import preview or apply writes a private receipt to
  `${XDG_STATE_HOME:-~/.local/state}/imazing-archive/receipts/`. Only an apply
  that imports something also copies it to the archive's `imports/`; an empty
  or unchanged apply does not. `status`, `recover`, and `decide` write no
  receipt.
- After an apply that imports something, `data.runId` is the receipt's and
  journal's `runId`.
- A `TRANSIENT_NOT_STARTED` result means another writer is active; retry later.
- Run a long apply under `caffeinate -dimsu` so the Mac cannot sleep mid-copy.
- An interrupted apply (Ctrl-C, a closed pane, or sleep) leaves
  `archive.journal.lock` and an open journal intent. Writes refuse with
  `DOMAIN_PRECONDITION_UNMET` while the lock remains. Run
  `recover --archive DIR`; it inspects and never replays. Act on its result:
  - `state: completed`: the receipt proves the write. Once no helper process
    runs, delete the stale lock; the next write records the completion and
    proceeds.
  - `DOMAIN_RECOVERY_UNPROVABLE`, exit 3, transaction state `unchanged`
    because `recover` writes nothing: the interrupted import stays unproven.
    Leave the lock in place and follow the
    [recovery steps](references/archive-format.md#recovery) with Nathan.
    Deleting the lock and retrying hits the same open intent and refuses again.

Read [archive format](references/archive-format.md) before editing archive
files by hand or explaining identity, fingerprints, or exported-name rules.
