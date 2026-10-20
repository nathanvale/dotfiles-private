# Production checks

Use this checklist before page copy, move or import, native save/reopen, PDF
export or production review.
The canonical packet owns selected content, paragraph-style values and printer
requirements. Resolve the design contract through [design contract resolution](design-contract.md), then read the chapter's exact source
and approval record, and the applicable production specification. Record their
revisions in the handback. For a managed Herdr unit, also read the project's
current native custody and InDesign gotchas through its memory index.

Declare the output gate. The three are distinct and one file never satisfies
another:

| Gate | Purpose | Passing it does not mean |
| --- | --- | --- |
| `review-pdf` | Chapter or book review; gaps may stay open and are disclosed | Accessibility, print or acceptance |
| `accessible-digital-pdf` | Tagged PDF read on screen | Print or visual acceptance |
| `printer-pdf` | File for the selected Blurb product | Upload, order or Nathan's acceptance unless recorded |

An unknown production setting remains an explicit qualification gap. A review
may proceed with that gap disclosed. Printer delivery requires the selected
product's verified settings, every case below qualified, and acceptance of the
exact final files. Passing `handback` is a structural check of the record; it
never says Print PASS.

## Evidence every gate needs

- **Identities.** Exact native and PDF paths and SHA256, recomputed from disk.
- **Bindings.** Source revision and owner for each source, and every used
  artwork file by id, path and SHA256, rehashed from disk.
- **Custody.** One sole native writer. Read the active document and its dirty
  state fresh, after the last save or export; any later write voids the check.
- **Saved and reopened readback.** Reopen the saved native from disk. Its
  digest and page count equal the handback; overset is zero; links are Normal.
- **Independent rendering.** At least two different renderers, each viewing
  every page of the exact PDF.
- **Human acceptance.** Visual and privacy acceptance, then Nathan's acceptance
  naming the exact native and PDF SHA256. Record `pending` honestly. A
  `printer-pdf` record needs all three accepted.

## Printer PDF

- Selected Blurb product and paper specification: name, paper, page minimum and
  maximum, trim, per-side bleed, and the specification source. The paper's own
  maximum governs. The old 140-page ceiling is superseded (Nathan, 16 October
  2026); never apply it.
- Page parity: an even count within the paper's range.
- Full-size boxes on every page: TrimBox is the full trim placed at the product's bleed offsets inside the MediaBox, MediaBox and
  BleedBox are the product's full bleed size. Equal Trim, Bleed and Media boxes
  mean a trim-only export and fail.
- Colour: destination profile, PDF output intent present, and a real PDF/X
  validator report (name, PDF/X standard, report path and digest, the validated
  PDF digest, zero errors). The helper fails closed and reads the report as `key: value` lines: exactly one
  `Result:` and one `Error count:` line; every key that counts problems (errors,
  failures, violations) is zero; every verdict key (result, status, validation,
  outcome, conformance, success) is a plain positive; free text has no count of
  problems and no negating or rejecting word; this PDF's SHA256 appears and no
  other. A report in another format leaves the case open; read the report
  yourself. A preset or marker is not a report.
- Link PPI against the product requirement. Each link below it needs Nathan's
  recorded acceptance. Every font embedded.

## Cases G01 to G08

These are the project's operational failure cases, owned by the Bestie
project memory `reference/indesign-gotchas.md`; keep its identities. Carry all
eight in every handback as `failed`, `open` or `qualified` (a qualified case
needs evidence). A review may leave them `open` or `failed`, disclosed.
`printer-pdf` needs every one `qualified`. G09 (Scripts-panel input) is outside
the eight; dispatch receipts cover it.

| Case | Failure to rule out |
| --- | --- |
| G01 | Preflight says No errors while authored text is invisible (paint order, opaque field) or hidden in overset, conditions or notes. Inspect rendered ink on every changed page. |
| G02 | Copying pages shifts parent transforms or image Profile values. Compare the immediate readback with the source before saving. |
| G03 | Colour parity: a joined or exported PDF renders differently though operands match (ICCBased with output intent versus DeviceCMYK without). Compare output intent, image profiles and colour-managed renders. |
| G04 | Background bleed: a moved field keeps the other side's bounds and misses outside bleed. Check bounds against each page's actual side. |
| G05 | Transparent PNGs show white rectangles because the carrier inherits a Paper fill. Check the effective carrier fill and sampled transparent regions. |
| G06 | A successful Open followed by a timeout invites an unsafe replay. Require a unique receipt and fresh app and document identity before any retry. |
| G07 | Book panel control: the Book options and automatic-numbering controls are unqualified. Bind them before adding chapter copies; keep synchronization unused. |
| G08 | Export-profile control: the profile-policy popup cannot be set or read back. Require a fresh selected-value readback before export. |

Page parity, link PPI, PDF/X validation and font embedding are not G cases;
the printer gate checks them directly.

## Automation qualification

Automate an operation only when it needs it; by hand is the default. A route is
`uxp` or `existing-scripting`, qualified in this order, and nothing else:

1. Save a checkpoint copy of the native and record its path and SHA256.
2. Probe on a duplicate document; record what ran and what it changed.
3. Record the rollback (reopen the checkpoint).

Record each qualified operation under `automation`. Book panel and third-party
MCP routes stay unqualified here; using one fails the handback. Qualify nothing
by reputation or by a tool's own claim.

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
`geometry`, `book` and `handback`. `handback` also checks the gate evidence above; its
record shape is in [check inputs](check-inputs.md#authored-records). It adds no
command and never declares Print PASS or accessibility conformance.

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
  included), plus any overset text (blank paragraphs included) and declared hidden text;
- the contract's story inventory (an omitted, extra or relocated story fails),
  each story's expected text bound to the contract's digest and found
  paragraph-for-paragraph in its owner file at the bound source commit;
- links: page inside the book, status, the target hashed on disk, reconciled with the bound art
  entry of the same id, effective ppi and profile;
- every inventoried document font installed, the contract's required fonts
  present, and rendered-glyph evidence for every non-Latin character, emoji
  joiner and variation selector in a story, accepted only when glyph-tight
  (`raster-glyph` or `glyph-outline`) and drawn in an installed inventoried
  font;
- required folio and metadata fields, native bleed per page;
- PDF pages equal native pages; TrimBox and BleedBox per side; fonts embedded;
  image colour space and ppi; device colour operators in text and vector
  content (document-wide; ICC-based operators are not resolved); story text present in the exported page text;
  export settings read back against the contract.

Page `/Contents` references and Form streams take precedence over metadata
exclusions when counting device colour operators. The helper refuses object
streams because it cannot establish their page-content membership; use a PDF
with plain objects or a qualified independent inspection path. A refusal is
missing evidence, never a colour pass.
Indirect stream lengths require a readable classic cross-reference entry;
unreadable or inconsistent lengths refuse the check instead of truncating it.

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
`pdf-word-box` Unicode evidence is refused, never accepted as proof. The
manifest keeps the observed overrides, fonts, Unicode evidence, links (with
disk digests), story digests and the digests of both input files.
