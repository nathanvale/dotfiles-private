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
envelope. `status` prints its counts in human output; `--json` carries the same
counts in `data`. `--help` prints the exact usage.

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
2. Name the attachments root with `--attachments DIR`: the folder that holds
   the exported files, the ones named `<date> - <chat> - <name>`. They must sit
   at most two folders below it. An iMazing attachment re-export can nest them
   deeper than its CSV; pass the deepest folder that contains them. For the
   2025 archive export it is `Text Message History/Attachments`. After the
   preview, check that `chatFiles` is not 0 and is near the number of
   attachment rows. A large `missing` count with a small `chatFiles` means the
   root is wrong. The preview warns when `chatFiles` is 0 or when
   `deeperFiles` counts files more than two folders down.
3. Preview:
   `import --archive DIR --csv FILE --attachments DIR --preview`.
   Preview writes only a private receipt; the archive stays untouched.
4. Read the receipt it names. Report its counts to Nathan, including
   `beforeStart`, `attachmentRowResolution`, `planned`, and the `ambiguous*`,
   `missing*`, `nearMatches`, and `unreferencedFiles` lists. Receipt counts
   describe this export against this attachments root. `status` counts the
   archive after every import. They differ once a later export resolves an
   earlier gap.
5. Apply the reviewed plan: rerun the same command with `--plan DIGEST` in place
   of `--preview`. A changed archive or source refuses as stale; preview again.
   Skip the apply when the preview says nothing would change; its next action
   then says there is nothing to apply.

A preview and a no-op apply both return `SUCCESS_UNCHANGED`. Done when an apply
returns `Export imported.` (`SUCCESS_COMPLETED`) or `Export already imported;
nothing changed.` (`SUCCESS_UNCHANGED`), and the receipt's unresolved lists are
reported. Re-importing a seen export retries its missing message-to-attachment
associations, so add late files to the attachments root and import again.

## Ambiguous and missing

Terms:

- **Held**: the row is listed in the receipt and creates no item. Only
  ambiguous messages are held.
- **Web link**: an iMazing `Web link.url` file.
- **Message-to-attachment association**: the record joining an item to an
  exported file, with status `resolved`, `missing`, or `ambiguous`.
- **Message ID link**: a Message ID row joined to an earlier item that has no
  Message ID.
- **Near match**: a new item sharing a Message Date and direction with an
  existing item; it may be an edited duplicate, and nothing merges it.

Never write "link" alone; name which of the three it is.

- **Missing**: no file under the attachments root matches the row's attachment
  name at its Message Date.
- **Ambiguous attachment**: candidate files with different bytes, or a web
  link whose timestamp, to the second, matches more than one message with a
  URL.
- **Ambiguous message**: an export without Message IDs has a row whose
  fingerprint (date, direction, text, attachment name) matches more than one
  archive item, or repeats inside the export. The row is held, not merged.
- **Ambiguous message ID link**: a Message ID row matches items without a
  Message ID, but not one-to-one. Both sides are kept and name each other in
  `derived/messages.csv` column `ambiguous_with`.

A held row creates no item. `status` counts held rows as `heldMessages`; a
preview of the same export lists them again. The helper has no command to
resolve a held row. Report the list and leave it.

The helper never picks among candidates. Report these lists; resolve them only
with Nathan.

## Review images

`derived/pending-images.csv` lists resolved images whose `visual_review` is not
`reviewed`. The recommended classifier lane is gpt-6-sol at high effort, with
the class definitions in the prompt and a confidence threshold that routes
uncertain images to review. The vault note
`projects/melanie-fourth-anniversary-meme-album/classifier-evaluation.md` owns
that recommendation and the checks it still needs. Record each result against
the row's `item_key`:

```bash
decide --archive DIR --item KEY --image-type screenshot --contains-meme true --reviewed
```

`--image-type` takes photo, screenshot, screenshot_with_meme, meme, document,
gif, sticker, url, other, or unknown. `--contains-meme true|false|unknown` is a
separate flag: a screenshot can contain a meme, and a photo can be a photo of
one. `--reviewed` sets `visual_review` to `reviewed`. `--album
selected|rejected|undecided` sets `album_selection`, a separate keeper decision;
review alone never selects an image. Decisions live in
`records/decisions.jsonl` and survive later imports.

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
- An interrupted apply or decision (Ctrl-C, a closed pane, or sleep) leaves
  `archive.journal.lock`, usually with an open journal intent. Writes refuse
  with `DOMAIN_PRECONDITION_UNMET` while the lock remains. Run
  `recover --archive DIR --json`; it inspects and never replays. Act on its
  result:
  - `data.state` `none` with a lock present: the writer stopped before it
    wrote an intent, so nothing was written. Once no helper process runs,
    delete the lock.
  - `data.state` `completed` (human output: "The interrupted write's durable
    effects read back complete; it was not replayed."): the receipt or the
    decision line proves the write. `data.runId` and `data.expectedValueHash`
    name the intent. Once no helper process runs, delete the stale lock; the
    next write records the completion and proceeds.
  - `DOMAIN_RECOVERY_UNPROVABLE`, exit 3, transaction state `unchanged`
    because `recover` writes nothing: the interrupted write stays unproven.
    The handoff reason names the intent's `runId` and `expectedValueHash`.
    Leave the lock in place and follow the
    [recovery steps](references/archive-format.md#recovery) with Nathan.
    Deleting the lock and retrying hits the same open intent and refuses again.
- `INTERNAL_RESULT_UNKNOWN`, exit 1, transaction state `unknown`: an import or
  decision failed after writing its journal intent, so archive effects may be
  partial. The helper released its lock. Do not rerun the command; run
  `recover` and act on its result as above.

Read [archive format](references/archive-format.md) before editing archive
files by hand or explaining identity, fingerprints, or exported-name rules.
