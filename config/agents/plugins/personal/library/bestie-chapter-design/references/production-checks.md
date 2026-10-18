# Production checks

Use this checklist before page copy, move or import, native save/reopen, PDF
export or production review.
The canonical packet owns selected content, paragraph-style values and printer
requirements. Resolve the design contract through [design contract resolution](design-contract.md), then read the chapter's exact source
and approval record, and the applicable production specification. Record their
revisions in the handback. For a managed Herdr unit, also read the project's
current native custody and InDesign gotchas through its memory index.

Declare the output purpose: chapter review, accessible digital PDF or printer
delivery. An unknown production setting remains an explicit qualification gap.
A review may proceed with that gap disclosed. Printer delivery requires the
selected product's verified settings and final-file acceptance.

## Native content and styles

- Compare actual paragraph and character ranges with the canonical style
  contract, including local overrides, supported metadata, spacing and exact
  emoji formatting. Apply the existing typography workflow; keep measurements
  in its named owner.
- Record the active Preflight profile, enabled checks and scope. Inspect every
  relevant story and frame for overset, including threaded continuations,
  table cells and placed content as applicable. Compare complete story text
  against the selected source, including any text beyond a frame.
- Inspect the exported ink for complete text, glyphs, headings, credits and
  folios. Whole source text and zero overset can coexist with text hidden by an
  opaque field. Check visibility, paint order, clipping and backgrounds where
  content is missing. A geometry or protected-page PASS does not prove body
  text is visible.
- Complete save and disk reopen with exact native/readback identities. Recheck
  links, sources, geometry and fit on that reopened candidate. Preserve an
  uncertain or failed candidate and its receipts for diagnosis.

Adobe's [Preflight limits](https://helpx.adobe.com/indesign/desktop/print/preflight/view-and-resolve-preflight-errors.html)
explain why the error list is insufficient. It can omit issues inside overset
text, hidden conditions and notes; repeated parent-item errors appear once.
Expand checks to each affected page and disclose excluded content.

## Links and artwork

Bind each used artwork instance to its selected file, SHA256, placement,
effective resolution and profile. Check the actual resolved target and link
status after reopening. Report missing, modified or substituted links and
measure resolution against the selected product's requirement. A Normal link
alone establishes neither accepted bytes nor colour parity.

For transparent artwork, inspect the effective carrier fill, object-style
inheritance and exported transparent regions against the page field on every
affected page. Preserve intentional interior whites and original art. Compare
the resulting whole image and readable lettering at useful scale.

Before page copy, page moves or IDML import, capture the source fields needed
for comparison. After the operation, compare the immediate readback with that
bound source before saving. Check parent identities and transforms, image
profiles, page origins, item geometry, story/link bindings and paint order.
Recompute outside bleed from each actual page side. Repair only proved deltas
in a separately versioned candidate, then repeat the affected checks.

For an InDesign Book route, qualify the exact Book panel, numbering and
synchronization controls before adding chapter copies. Use the project's
demonstrated route or stop with the saved checkpoint and unmet control named.

## PDF export and readback

Before dispatch, capture the actual export destination and settings. Read back
the following values against the output purpose and current production owner:

| Setting group | Evidence to record |
| --- | --- |
| Output | Exact path, format, page range, pages or spreads, preset and overrides. |
| Standard | PDF version, selected PDF/X standard if required, and validation route. |
| Geometry | Trim, bleed by side, marks and slug inclusion. |
| Images | Compression, downsampling and transparency handling. |
| Colour | Conversion, destination profile, profile-inclusion policy and PDF/X output intent when applicable. |
| Text and structure | Font embedding, tagging, bookmarks and hyperlinks as required by the output purpose. |

Use fresh observed controls. If a required value cannot be read back, stop that
export and name the missing setting. A timeout requires inspection of actual
app state, receipts and files before another dispatch.

After export, bind the PDF path and digest and inspect the actual file for
page count/range, page boxes, fonts, colour spaces, profiles and output intent.
Render every page; inspect difficult text, emoji, transparent art and changed
pages at useful scale. Use independent renderers for known glyph or colour
discrepancies. Matching source colour operands do not establish rendered colour
parity across export profiles.

Use Adobe's [export option reference](https://helpx.adobe.com/indesign/desktop/save-export-and-publish/save-and-export/adobe-pdf-export-options.html)
to resolve setting meanings. Use the selected printer specification for values.
A preset name, HQP export or PDF/X marker is insufficient proof of conformance.
Record the exact validator, report and remaining failures for a PDF/X claim.
An unavailable validator leaves that qualification open.

## Accessible digital PDF

Run this branch when an accessible digital PDF is requested. Otherwise record
accessibility as not assessed for this candidate. Native accessibility controls
used for computer input do not establish PDF accessibility.

- Map semantic paragraph styles to appropriate PDF tags and define logical
  reading order. Check narration, exchanges, poems, captions and continuations.
- Supply source-grounded alternate text for meaningful artwork and exact text
  alternatives for essential lettering. Mark decorative elements as artifacts.
  Carry selected wording and privacy limits into these alternatives.
- Set supported document title and language, then export with tagged PDF
  enabled. Verify the exported tag tree, reading order and text alternatives,
  including emoji and any no-ink variation-selector treatment.
- Check meaningful links, bookmarks and tables when present. Inspect contrast
  and reading order manually and use the available PDF accessibility checker.
  Record its report, manual findings and unavailable checks. Missing tooling
  leaves the corresponding qualification open. Tagging alone is not conformance.

Adobe documents [tags and text alternatives](https://helpx.adobe.com/indesign/desktop/interactive-elements-and-forms/forms-and-pdfs/use-tags-for-accessible-pdfs.html)
and [Articles-panel reading order](https://helpx.adobe.com/indesign/desktop/interactive-elements-and-forms/forms-and-pdfs/set-reading-order.html).
Verify the resulting PDF rather than inferring its structure from native styles.

## Handback evidence

Link this checklist's evidence from the existing chapter handback report.
Record native/PDF identities, source and style-owner revisions, Preflight and
overset findings, link/profile standing, observed export settings and PDF
readback, pages/renderers inspected, applicable accessibility findings, and
unresolved qualifications. Keep creative acceptance, exact-source proof,
accessible-PDF findings and print qualification distinct.

The existing helper owns `baseline`, `copy`, `story`, `protected`, `dispatch`,
`geometry`, `book` and `handback`. Reuse those commands with their documented
inputs. This checklist adds evidence requirements; it adds no automated
production or accessibility PASS.

## Whole-book evidence

Run `book --native FILE --contract FILE` on the saved and reopened editable
native and the exported PDF it names. Inputs are in
[check inputs](check-inputs.md#whole-book-readback-and-contract). The helper
reads the PDF itself with poppler (`pdfinfo`, `pdffonts`, `pdfimages`,
`pdftotext`); native facts come from the readback, which must be taken from the
reopened file, not remembered.

Deterministic, failing the command:

- source commit on HEAD, art and native/PDF digests as bound;
- every page once and in order, page parity, parent per side and its transform;
- paragraph, character, object and parent styles against the contract, and
  every local override not allowed by the contract;
- the template file and binding against the contract's pinned SHA256 (for r20,
  the digest `SKILL.md` names), each page assigned to exactly one declared
  family or declared exception, and for family pages the page-local margins,
  columns and required frame bounds (card placement) of that family;
- each story against its selected text, compared exactly (whitespace
  included), plus overset text and declared hidden text;
- links: status, target digest, effective ppi and profile;
- required fonts installed, and rendered-glyph evidence for every non-Latin
  character, emoji joiner and variation selector in a story;
- required folio and metadata fields, native bleed per page;
- PDF pages equal native pages; TrimBox and BleedBox per side; fonts embedded;
  image colour space and ppi; story text present in the exported page text;
  export settings read back against the contract.

The contract, not the helper, owns which pages belong to which family and which
are exceptions. Derive both from the latest book and its coverage record each
run; a stale page list fails rather than being assumed. Style-name inventory
alone does not prove the template pattern; the family geometry above is what
the helper compares. Template pinning is not r20 acceptance: r20 stays an
editable REVIEW library, and Phone r9 stays the artwork reference.

Not decided by the helper, and always reported open: full-size visual review of
every page, privacy review and accessibility review. A pass is also never
native execution, visual acceptance, PDF/X conformance, output-intent or
profile-embedding proof, or print qualification; poppler cannot read those.
`pdf-word-box` Unicode evidence is listed for review, never as proof.
