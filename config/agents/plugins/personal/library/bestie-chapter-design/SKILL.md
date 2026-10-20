---
name: bestie-chapter-design
description: Build, revise or check a Bestie book chapter in InDesign. Use for story sequencing, spread design, artwork integration, production checks and native/PDF handback.
---

# Bestie Chapter Design

Turn Nathan's selected chapter into an editable, reviewable book chapter. Use the bound r20 library (below) as the operational layout library. Keep The Big Bad Phone r9 as the accepted artwork and drawing reference; inspect its export before composing.
Retain chapter-one process lessons while letting each chapter’s stories
determine its rhythm.

## Bound layout library

As of 18 October 2026, Nathan's operational nine-family layout library is
`Recovered-Library-r20.indt`, SHA256
`fcb90f8d4567f20f263bcad00b0ed0cbfd923a99c343680498cdbdba647311aa`, in
`Bestie-Style-Kit-r20`. It owns layout card geometry, typography and colours
wherever its contract supersedes Phone r9. Mini custody path (evidence of where
it was qualified, not a path every machine has):
`/Users/server/.local/state/my-second-brain-playground/bstie-12-layout-review-20261018-r1/Delivery/Bestie-Style-Kit-r20/Recovered-Library-r20.indt`.
Its report is `/Users/server/.herdr-projects/reports/bestie-book/12/style-library-r20/report.md`.

- Use a local copy only after recomputing its hash with `shasum -a 256` and matching it. On a machine without a verified same-hash copy (for example a fresh MacBook session), report the library as unavailable; do not substitute r9, r3 or another file.
- r20 is a technically qualified, editable REVIEW library. It is not the final book, exact-file acceptance, art acceptance or print acceptance.
- Phone r9 and the r3 template are historical receipts and accepted artwork or drawing references, never the operational template. Ignore an older operational r9 or r3 template direction.
- The canonical design system carries this same hash binding (BSTIE-28 Vault Steward route). A dated snapshot from before that update may still show the older Phone r9 or r3 direction; treat it as history. If the canonical hash differs from this one, surface it before a new layout decision. Never edit those notes or an installed cache from a skill session.
- Page-level family choices, source-specific exclusions and shared typography still come from the resolved design contract.

## Resolve the chapter

Resolve the design contract through [design contract resolution](references/design-contract.md): the packet's current canonical design owner, or a verified hash-bound dated snapshot with an owning receipt. Read the packet's `README.md` and `GOAL.md` with it. The contract owns current appearance, the chapter-one retrospective and template proof. If neither source resolves, or the source is uncertain, surface that before any new layout decision. Use `kate-berry-creative-director` for visual direction when needed; this skill owns the chapter workflow.

Resolve Nathan's named chapter from the current packet, not a historical queue number. Read its current selected copy in `chapter-copy-proposals.md`, decisions in `artwork-selection.md`, and linked source/art bindings. Preserve the existing copy owner. Separate accepted choices, reversible layout proposals and remaining production qualifications.

## Map before layout

Make a short ordered story map with the opener, introduction, story spreads and ending. Bind every proposed beat to its exact copy/source and accepted artwork version. Explain overlap with other chapters and the page cost of complete messages or continuations. Keep the order aligned with the introduction's progression and put recipient reactions beside the work they describe.

Bring an unresolved consequential selection or ending to Nathan as one grounded choice. Carry settled choices forward. Prepare unselected content as visible review alternatives with recoverable originals; assembling a candidate does not silently accept cuts. Finish this step with an explicit map and a selected ending or clearly labelled ending proposal.

## Brief and design

For every meme brief, redraw or artwork review, read the
[Bestie visual guide](../bestie/references/visual-style.md) and view its primary
Phone comic references. Check dog identities there when a dog appears.

Reuse accepted art unless Nathan authorizes a specific redraw. For a requested new image, use `bestie` and the active image-generation workflow. Record people, scene, clothes, action, punchline, exact caption and style anchor in a compact brief. Inspect whether the action actually communicates the joke. Keep original and revised artwork separately; style references supply drawing treatment, not event facts.

Apply the resolved design contract and actual approved native proof. Give each content type its suitable treatment: a quiet exact reply, a poem, a compact chart or a newspaper review can differ while sharing the book's typography, palette and spacing. Place whole proportional artwork with readable lettering. Fit full selected text with honest continuations before proposing a copy change.

Reuse r20 through ordinary Parent and style import or reuse inside the document being built; for the existing one-INDD book, never create a new document from the `.indt`. Exercise ordinary text and image changes on the imported items before relying on them for the chapter. Keep current print geometry and technical mechanics in the packet's InDesign research owners.

## Shared typography and message headers

Before every chapter build, revision or consistency review, use the contract
resolved above, including its **Shared typography and metadata contract**. That
owner defines the named styles, fonts, measurements, colours, metadata fields
and spacing.

Apply its message-header and artwork-credit contract to every chapter. Use its
distinct styles for narration, transcripts, featured messages, poems and folios.
Preserve supported source metadata and exact emoji overrides. Resolve a necessary
deviation through that owner and Nathan's direction before reusing it.

Before handback, compare actual native text ranges with the contract and inspect
every exported header, credit and folio. Check field order, supported metadata,
font, size, leading, colour, alignment and spacing. Record deviations explicitly;
named styles and installed fonts alone do not prove consistency.

## Run the checks

Resolve `skill_dir` from the directory containing this loaded `SKILL.md`, then
run `bun --no-install "$skill_dir/helper/dist/bestie-chapter-check.js" <command> --json`.
For repository development, run `bun run --silent src/cli.ts` from `helper/`.
Every command only reads files. `--help` lists commands and options;
[check inputs](references/check-inputs.md) gives each file's shape. Exit 0 is
a pass, 3 means a failed check or missing input (read `causeCode`), and 75 means wait and rerun. A
pass is never native execution, visual acceptance or Print PASS.

## Build and inspect

Hold one native app owner. Capture the active document and unsaved edits before cloning it. Hand back the captured baseline and changed candidate identities, protected-page comparison and explicit app release.

Before any native effect, write the build binding (actual baseline or capture, source revision, selected art and copy resolution) and pass `baseline`. A refusal means the build started from the wrong document; capture and rebind instead of repairing forward. Work in a separately versioned chapter file with retained linked assets.

Resolve the current selected copy blocks and transition decisions through their named owners. Record exact block identities before placement. Refresh them immediately before native effects and compare them with the build inputs through `copy`. Finish with native and exported-text checks against those same blocks. Place only accepted or selected blocks; an accepted beat never accepts its whole proposed pair.

When the declared edit replaces a story, replace the whole native story, keep only specified formatting and exact emoji overrides, then pass `story` against the `copy` placement text, naming the target by its page key (`p2:locked-introduction`). Clear inherited local overrides when applying chapter styles. After the build, pass `protected` for every untouched page.

Drive native controls from fresh accessibility state. Name each operation folder; the script writes `started.txt` then `completed.txt`, or `error.txt` on failure. `dispatch` refuses any started, completed or error receipt for the operation. Pass `dispatch` with a fresh `--target` before every new dispatch, including retries. A shared folder with named receipts needs the exact `--operation`. After an uncertain result, inspect receipts, document state and outputs before acting; then use the already demonstrated alternative route, such as Quick Apply opening Scripts. Record an unresolved control failure separately from chapter defects.

Before page copy, move or import, native save/reopen, PDF export or production review, follow the
[production checks](references/production-checks.md). Read its page-copy/import,
transparent-art and accessible-PDF branches when those operations are in scope.
Record the actual export settings and resulting PDF evidence in the handback.

Save, reopen and export the candidate. Read back every labelled page item regardless of object class, then pass `geometry` with a contract derived from the packet's production contract and typography owner. List every expected page background in `requiredBackgrounds` so an omitted object class fails. It checks footer alignment, page-number visibility, background bleed, declared role fonts, header text and reply spacing. A frame-only overlap prompts review; only glyph-tight ink (`raster-glyph` or `glyph-outline`, see [check inputs](references/check-inputs.md#ink-provenance)) proves a collision, never PDF word or font boxes. Installed fonts alone do not prove glyphs render. Diagnose a white band from asset pixels and frame fitting before changing accepted art.

Compare native readbacks with source extents and art hashes. Check title roles, captions, links, overset, facing relationships and the ending. Inspect all exported pages for rhythm and clipping, plus difficult text, glyphs and art at useful scale; geometry passes never replace that review.

Show Nathan the actual candidate and make focused revisions within his feedback. Record his creative verdict separately from source, image, Unicode and print qualifications. A chapter accepted as a design reference does not establish whole-book acceptance or a default chapter length.

## Hand back

Write one current handback record per output file and pass `handback`: its `gate` (`review-pdf`, `accessible-digital-pdf` or `printer-pdf`, see [production checks](references/production-checks.md)), custody, reopen, render, acceptance and G01 to G08 evidence, native/PDF paths and digests, actual page count, manuscript-versus-native copy standing, source extents, UI owner and release, preview state and the next ready action. Carry selected Writing Beats answers with their evidence so settled choices are never asked again. Replace stale counts and pending-question snapshots rather than appending to them. Name the template actually exercised and the design-contract source (canonical revision, or snapshot hash and receipt). Keep raw receipts in the configured private runtime owner and record durable decisions through the vault's existing note-write route.

When Nathan names a retro or review procedure, follow that procedure and deliver evidence-based patches when he asks for improvements.

Stop at the authorized chapter review boundary. Final integrated interiors, cover/spine, print qualification and Nathan's final acceptance follow the current Goal. Sending, ordering and spending retain their separate authority.
