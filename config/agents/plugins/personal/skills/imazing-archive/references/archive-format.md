# Archive format

Records are append-only JSONL and the durable truth. Everything under
`derived/` is regenerated from them after each apply or decision.

## Layout

```text
ARCHIVE/
  archive.json                  marker; required before any write
  archive.journal.jsonl         import intent and completion records
  archive.journal.lock          present only while a writer runs, or as crash residue
  originals/<sha256>-<name>.csv byte-identical copy of each imported CSV
  blobs/<aa>/<sha256>.<ext>     content-addressed attachment bytes
  records/items.jsonl           one record per message row identity
  records/observations.jsonl    one record per imported CSV row: export, row, strategy
  records/associations.jsonl    message-to-attachment links
  records/blobs.jsonl           blob path, size, and source file
  records/decisions.jsonl       image type, meme, review, and album decisions
  derived/messages.csv          one row per item, latest decisions applied
  derived/attachments.csv       one row per association
  derived/pending-images.csv    resolved images without a reviewed decision
  imports/<time>-apply-<run>.json  receipt copy per applied import
```

## Variants

| Variant | Columns | Identity |
| --- | --- | --- |
| `imazing-18` | Adds Message ID, Deleted Date, Reactions | Message ID plus part |
| `imazing-15` | No Message ID | Fingerprint |

The header must match a variant exactly. A leading BOM is ignored. One CSV
holds one Chat Session.

## Item identity

- One Message ID can span several rows: a text row and one row per attachment.
  Each row is an item. Its part is `text#N` or `att:<name>#N`, where `N` counts
  repeats of that part inside the message.
- The fingerprint is SHA-256 of Message Date, direction, Text, and Attachment.
- An ID row links to an earlier fingerprint-only item only when exactly one
  unlinked candidate exists and no other row in the export shares the
  fingerprint. Otherwise it becomes its own item and the receipt lists the
  candidates under `ambiguousMessageLinks`.
- A fingerprint row matches only one candidate with a unique fingerprint in its
  export. Zero candidates create a new item; anything else is held as an
  ambiguous message.
- `nearMatches` lists new items sharing a Message Date and direction with an
  existing item. They may be edited duplicates; nothing merges them.

## Exported names

iMazing names each exported file `<Message Date, colons as spaces> - <Chat
Session> - <name>`. Resolution checks, at the same second:

1. The exact attachment cell, which may contain commas or vertical bars.
2. A variant: the stem cut to 40 characters, a ` N` suffix before the
   extension, or an extension in another case.

Candidates sharing one SHA-256 resolve to that blob; differing bytes are
ambiguous. Leftover `.url` files link to the one row at that second whose text
holds a URL. Files with the chat prefix that nothing claims are
`unreferencedFiles`; files for other chats are ignored.

Same bytes sent in two messages make two associations and one blob. A later
export may resolve an association an earlier export left missing; the
resolved record supersedes it.

## Decisions

Each `decide` appends one record keyed by `itemKey`. Later fields override
earlier ones. `image_type` is one of photo, screenshot, gif, sticker, url,
other, unknown. `contains_meme` is true, false, or unknown and is independent
of `image_type`. Until reviewed, the derived image type is the helper's
detection: `url`, `gif`, `other` for non-images, else `unknown`.

## Recovery

An apply writes a journal intent, then originals, blobs, records, derived files,
and the receipt, then the completion record. `recover` reports a pending intent
as complete when a receipt in `imports/` carries its plan digest; later imports
proceed. Without that receipt the import is unproven: later writes refuse.

To reconcile an unproven import, with Nathan's approval:

1. Copy the archive aside.
2. Remove record lines after the last line that belonged to a completed import
   (observations name their export SHA-256).
3. Delete the stale `archive.journal.lock` when no helper process runs.
4. Append a `completed` journal line with the intent's `runId`, `effectId`, and
   `expectedValueHash`, then preview the import again.
