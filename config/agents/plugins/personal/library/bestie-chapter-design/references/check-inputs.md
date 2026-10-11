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
  `visible`, `z` (stacking order) and `ink` (rendered text bounds) when known.
- Story readback (`story`, handback `nativeStories`):
  `{ stories: [{ label, text, ranges }] }`. `text` is the whole story,
  overset included, with `\r` paragraph ends; ranges reproduce it exactly.

Measure `ink` from PDF word bounds or native line metrics. Without it, a
header/body frame overlap is listed in `containerReview` for useful-scale
review instead of failing.

## Authored records

- Build binding (`baseline --binding`): `chapter`; `baseline` with `path`,
  `sha256`, `pageCount`, `modified` and, for unsaved edits, `capture` with
  `path` and `sha256`; `sourceRevision` with `repository` and `commit`; `art`
  as `[{ id, path, sha256 }]`; `copyResolution` with `path` and `sha256`.
- Copy resolution (`copy`, handback `copyResolution`): `chapter` and `blocks`.
  Each block has `role` (`introduction`, `teaser`, `ending` or `transition`),
  `owner`, exact `heading`, 1-based `paragraphs: [first, last]` under that
  heading, `standing` (`accepted`, `selected` or `proposed`), `acceptance`
  with `scope` (`block`, `pair` or `chapter`) and `evidence`, and the
  `sha256` of the paragraphs joined by one blank line, each unwrapped to one
  line. A transition with `supersedes: [{ owner, heading, paragraphs }]`
  replaces those paragraphs of its base block.
- Geometry contract (`geometry --contract`): `trim`, `bleed` (`top`,
  `bottom`, `outside`, `inside`), `firstPageSide`, `tolerance`, `footer`
  bounds by `left`/`right` side and label, `footerExemptPages`, `folio`
  (`label`, `marker`), `backgroundLabels`, optional `unpaintedFills`,
  `styleFonts` (paragraph style to declared font), optional `emojiFont`, and
  `replyHeader` (`headerStyles`, `bodyStyles`, `minGap`, optional `pattern`).
  Derive values from the packet's production contract and typography owner.
- Accessibility target (`dispatch --target`): `{ capturedAt }` as ISO time.
- Handback (`handback --record`): `chapter`, `revision`, `native` and `pdf`
  (`path`, `sha256`), `pageCount`, `copyResolution`, `nativeStories`, `copy`
  as `[{ role, storyLabel, standing }]` with standing `placed` or
  `pending-placement`, `sourceExtents` as `[{ key, extent, page }]` with
  extent `whole-message` or `excerpt`, `writingBeats` with `selected`
  (`question`, `answer`, `evidence`) and `open` (`question`), `ui`
  (`owner`, `released`), optional `preview` (`state` plus the `queuedAt`,
  `openedAt` or `viewedEvidence` that proves it) and `nextAction`.
