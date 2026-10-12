# Check inputs

Shapes for `bestie-chapter-check` input files. The helper's tests
(`helper/tests/checks.test.ts`) hold a runnable example of each. Paths are
absolute. Bounds are native `geometricBounds`: `[top, left, bottom, right]`
in points, page-relative.

## Native readbacks

Native readbacks keep the existing receipt spelling.

- Live state (`baseline --live`): `{ path, modified, page_count }` for the
  active document, read immediately before effects.
- Format readback (`protected`, `geometry --snapshot`): an array of
  `{ page, label, bounds, ranges }`, where each range is a text style range
  with `text`, `font`, `style` and other formatting. Read every labelled page
  item, whatever its class, and add `kind` (its object class), `fill`,
  `visible`, `z` (stacking order), `ink` (measured text bounds) and
  `inkMethod` when known.
- Story readback (`story`, handback `nativeStories`):
  `{ stories: [{ page, label, text, ranges }] }`. `page` is the page of the
  story's first frame; `text` is the whole story, overset included, with `\r`
  paragraph ends; ranges reproduce it exactly.

### Ink provenance

Only glyph-tight ink decides a reply collision. Set `inkMethod` on every frame
with `ink`:

- `raster-glyph`: painted rows of the exported page rendered at 4 px/pt or
  finer.
- `glyph-outline`: vector glyph outline bounds.

Name any other measurement honestly, for example `pdf-word-box` for poppler
`pdftotext -bbox` or `line-metrics` for native ascent and descent. These font
boxes include empty space: the Phone r16 and r17 page 7 trophy-emoji line
measures a −5 pt word-box overlap but 18 pt of clear raster gap. Font-box
ink, unnamed ink and missing ink never fail geometry. A header/body frame
pair closer than `minGap` is then listed in `containerReview` for useful-scale
review. `inkProvenance` records each measured frame's method.

When another geometry check fails, the envelope `data` is null; the review
flags follow the issues in the message as `Also review N flag(s)`.

### Story keys

A story's key is `p<page>:<label>`, or the bare label when the readback has no
`page`. Name the target (`story --target`, handback `storyLabel`) by key; a bare
label works only when exactly one story carries it. Labels such as `heading`,
`folio` and `running-footer` repeat on every page, so a readback with repeated
keys or an ambiguous target fails closed. Keep pages identical between the
before and after readbacks; check page moves with `protected --pages`.

## Authored records

- Build binding (`baseline --binding`): `chapter`; `baseline` with `path`,
  `sha256`, `pageCount`, `modified` and, for unsaved edits, `capture` with
  `path` and `sha256`; `sourceRevision` with `repository` and `commit`; `art`
  as `[{ id, path, sha256 }]`; `copyResolution` with `path` and `sha256`.
- Copy resolution (`copy`, handback `copyResolution`): `chapter` and `blocks`.
  Each block has `role` (`introduction`, `teaser`, `ending` or `transition`),
  `owner`, exact `heading`, optional `section` naming its unique parent chapter
  heading, and 1-based `paragraphs: [first, last]` under that heading.
  Use `section` when the heading repeats elsewhere in the owner file.
  Also record `standing` (`accepted`, `selected` or `proposed`), `acceptance`
  with `scope` (`block`, `pair` or `chapter`) and `evidence`, and the
  `sha256` of the paragraphs joined by one blank line, each unwrapped to one
  line. A transition with `supersedes: [{ owner, section?, heading, paragraphs }]`
  replaces those paragraphs of its base block.
- Geometry contract (`geometry --contract`): `trim`, `bleed` (`top`,
  `bottom`, `outside`, `inside`), `firstPageSide`, `tolerance`, `footer`
  bounds by `left`/`right` side and label, `footerExemptPages`, `folio`
  (`label`, `marker`), `backgroundLabels`, `requiredBackgrounds` as
  `[{ page, label }]` for every page whose background should exist, including
  text-frame backgrounds, optional `unpaintedFills`,
  `styleFonts` (paragraph style to declared font), optional `emojiFont`, and
  `replyHeader` (`headerStyles`, `bodyStyles`, `minGap`, optional `pattern`).
  Derive values from the packet's production contract and typography owner.
- Accessibility target (`dispatch --target`): `{ capturedAt }` as ISO time.
  Required to clear a new dispatch; without it `dispatch` only inspects
  existing receipts and refuses.
- Handback (`handback --record`): `chapter`, `revision`, `native` and `pdf`
  (`path`, `sha256`), `pageCount`, `copyResolution`, `nativeStories`, `copy`
  as `[{ role, storyLabel, standing }]` with standing `placed` or
  `pending-placement`, `sourceExtents` as `[{ key, extent, page }]` with
  extent `whole-message` or `excerpt`, `writingBeats` with `selected`
  (`question`, `answer`, `evidence`) and `open` (`question`), `ui`
  (`owner`, `released`), optional `preview` (`state` plus the `queuedAt`,
  `openedAt` or `viewedEvidence` that proves it) and `nextAction`.
