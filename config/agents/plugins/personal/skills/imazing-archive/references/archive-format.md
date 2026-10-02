# Archive format

Records are append-only JSONL and the durable truth. Every record line ends in a
newline; a writer refuses to append to a file whose last line does not. Everything
under `derived/` is regenerated from the records after each apply or decision.
`derived/records.sha256` holds the records revision the views were built from
and is written last; an import that finds nothing new regenerates the views
when that revision differs from the current records.

## Layout

```text
ARCHIVE/
  archive.json                  marker, chat identity (Sender IDs), and start date
  archive.journal.jsonl         import and decision intent and completion records
  archive.journal.lock          present only while a writer runs, or as crash residue
  originals/<sha256>-<name>.csv byte-identical copy of each imported CSV
  blobs/<aa>/<sha256>.<ext>     content-addressed attachment bytes
  records/items.jsonl           one record per message row identity
  records/observations.jsonl    one record per imported CSV row: export, row, strategy
  records/associations.jsonl    message-to-attachment associations
  records/blobs.jsonl           blob path, size, and source file
  records/decisions.jsonl       image type, meme, review, and album decisions
  records/ambiguities.jsonl     item sets an unresolved message ID link could join
  derived/messages.csv          one row per item, latest decisions applied
  derived/attachments.csv       one row per association
  derived/pending-images.csv    resolved images without a reviewed decision
  derived/records.sha256        records revision the derived views were built from
  imports/<time>-apply-<run>.json  receipt copy per applied import
```

## Variants

| Variant | Columns | Identity |
| --- | --- | --- |
| `imazing-18` | Adds Message ID, Deleted Date, Reactions | Message ID plus part |
| `imazing-15` | No Message ID | Fingerprint |

The header must match a variant exactly. A leading BOM is ignored. One CSV
holds one Chat Session. Session names differ between exports of one chat
("Robin" and "Robin Example"), so chat identity is the sorted set of
non-empty Sender IDs. It must equal the set in `archive.json`.

## Start date

The first apply records `startDate` in `archive.json` from `--start-date
YYYY-MM-DD` (default `2023-10-15`); the archive begins on that day. Every later
preview or apply compares its `--start-date`, or the default when omitted, with
the stored date and refuses a difference with `DOMAIN_PRECONDITION_UNMET`.

Message Date is a local wall-clock string with no time zone. Only its date part
(`YYYY-MM-DD`) is compared with the start date; no zone conversion happens. A
row dated before the start creates no item, observation, association, or blob.
Exported files whose name timestamp falls before the start are left out of
attachment resolution, so they are not `unreferencedFiles`. The plan, preview,
apply result, and receipt report the left-out rows as `beforeStart`; `status`
sums `beforeStart` once per applied export from the receipts in `imports/`.

## Item identity

- One Message ID can span several rows: a text row and one row per attachment.
  Each row is an item. Its part is `text#N` or `att:<name>#N`; `N` numbers
  same-name parts after sorting by content hash, so row order does not matter.
- A later export row whose part is new but whose resolved bytes match exactly
  one existing cell of the same Message ID is the same item (a renamed file).
- The fingerprint is SHA-256 of Message Date, direction, Text, and Attachment.
  Text is normalised first: LF line endings, Unicode NFC, leading and
  trailing whitespace trimmed from the text, and trailing whitespace trimmed
  from each line.
- An ID row links to an earlier fingerprint-only item only when exactly one
  unlinked candidate exists and no other row in the export shares the
  fingerprint. Otherwise it becomes its own item; `records/ambiguities.jsonl`
  and the receipt's `ambiguousMessageLinks` record both sides for a later
  explicit reconciliation.
- A fingerprint row matches only one candidate with a unique fingerprint in its
  export. A unique fingerprint with zero candidates creates a new item. Anything
  else, including a fingerprint repeated within one export, is held as an
  ambiguous message: no item is created and the receipt lists the row under
  `ambiguousMessages`. Its observation record names no item, and `status`
  counts such rows as `heldMessages`. A rerun of that export lists the held
  row there again without creating an item or writing a record. No command
  resolves a held row.
- `nearMatches` lists new items sharing a Message Date and direction with an
  existing item. They may be edited duplicates; nothing merges them.

## Exported names

iMazing names each exported file `<Message Date, colons as spaces> - <Chat
Session> - <name>`. Resolution searches files at most two folders below the
attachments root. The preview, apply result, and receipt count files deeper
than that as `deeperFiles`; the preview and apply message warn when it is above
0, or when no file for the chat is found (`chatFiles` 0). Resolution checks, at the same second:

1. The exact attachment cell, which may contain commas or vertical bars.
2. A variant: the stem cut to 40 characters, a ` N` suffix before the
   extension, or an extension in another case.

Candidates sharing one SHA-256 resolve to that blob; differing bytes are
ambiguous. A leftover web link (`.url` file) resolves to the one row at that
second whose text holds a URL. Files with the chat prefix that nothing claims are
`unreferencedFiles`; files for other chats are ignored.

Same bytes sent in two messages make two associations and one blob. A later
export, or a rerun of the same export after files arrive, may resolve an
association left missing; the resolved record supersedes it.

## Decisions

Each `decide` appends one record keyed by `itemKey`. Later fields override
earlier ones. `image_type` is one of photo, screenshot, screenshot_with_meme,
meme, document, gif, sticker, url, other, unknown; the classifier trial's
classes are among them. `contains_meme` is true, false, or unknown and is
independent of `image_type`: a screenshot can contain a meme, and a photo can
be a photo of one. Until reviewed, the derived image type is the helper's
detection: `url`, `gif`, `other` for non-images, else `unknown`.

`derived/messages.csv` and `derived/pending-images.csv` show each decision as
`image_type`, `contains_meme`, `visual_review`, and `album_selection`. `decide
--reviewed` sets `visual_review` to `reviewed`; `--album` sets
`album_selection`. Without a decision the defaults are `visual_review`
`pending`, `album_selection` `undecided`, `contains_meme` `unknown`, and
`image_type` the helper's detection. `contains_meme` `unknown` therefore means
either no decision set it or a decision recorded `unknown`; `visual_review`
tells the two apart. `image_type` is blank for a text row with no attachment.
In `derived/messages.csv`, `ambiguous_with` is a JSON array of the item keys an
unresolved message ID link could join, and is empty when there are none.

## Recovery

Before its journal intent, an apply hashes any original or blob it would write
that already exists; different bytes refuse with `DOMAIN_ARCHIVE_CONFLICT`
naming the path. An apply then writes a journal intent, originals, blobs,
records, derived files, and the receipt, then the completion record. The receipt
in `imports/` carries the intent's run ID, effect ID, and plan digest, plus the
SHA-256 of each file written and of each appended record span. `effectId` is a
kind label (`effect.import` or `effect.decision`) shared by every write of that
kind; `runId` is the unique key that joins an apply result, its receipt, and its
journal lines.

A `decide` writes a journal intent holding the SHA-256 of its decision line,
appends the line, regenerates derived files, then writes the completion record.
A failure after the intent returns `INTERNAL_RESULT_UNKNOWN`.

A decision intent is written only after `records/decisions.jsonl` is checked to
end in a newline. The journal follows the same rule: an intent or completion is
appended only when `archive.journal.jsonl` ends in a newline. A journal whose
last entry is unterminated, or that holds an invalid entry, proves nothing.
Writes refuse with `DOMAIN_RECOVERY_UNPROVABLE` and leave its bytes unchanged,
`recover` hands off to the operator, and `status` reports recovery `unknown`. A
completion that cannot be appended after durable effects returns
`INTERNAL_RESULT_UNKNOWN`.

`recover` names the pending intent's `runId` and `expectedValueHash`: in
`data` when it proves the write, and in the handoff reason when it cannot.

`recover` reports a pending import intent as complete only when a receipt with
the same run ID, effect ID, and plan digest exists and every file and record
span it names reads back with matching SHA-256. A pending decision intent is
complete when its exact newline-terminated line is in `records/decisions.jsonl`;
an unterminated last line proves nothing. Derived files may be stale until the
next decision or import, including an import that finds nothing new,
regenerates them. The next write appends the proven intent's completion record
under the lock, then proceeds. Anything else is unproven: later writes refuse.

To reconcile an unproven write, with Nathan's approval:

1. Copy the archive aside.
2. For an import intent, remove record lines after the last line that belonged
   to a completed import (observations name their export SHA-256). For a
   decision intent, remove an unterminated last line from
   `records/decisions.jsonl`, if there is one, so the file ends in a newline;
   no other record changes.
3. Delete the stale `archive.journal.lock` when no helper process runs.
4. Append this line to `archive.journal.jsonl`, ending in a newline, with the
   values copied from the unmatched `intent` line:

   ```json
   {"effectId":"<effectId>","expectedValueHash":"<expectedValueHash>","journalVersion":1,"phase":"completed","runId":"<runId>"}
   ```

5. For an import, preview the import again. For a decision, run `decide` again
   if the decision is still wanted.
