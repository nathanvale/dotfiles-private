---
name: parody-degree
description: Generate a personalised Monash-style parody degree PDF from a recipient name and complete joke degree title, using the approved A3 certificate layout.
---

# Parody degree

Create one personal parody certificate using the packaged layout and artwork.
Accept the recipient's name and complete parody degree title directly from the
request. Ask only for either missing value. Preserve the supplied title exactly;
add no qualification prefix. Use the generation date in Australia/Melbourne
unless the user requests a different certificate date.

## Generate

1. Set `PARODY_SKILL_DIR` to the directory containing this loaded `SKILL.md`.
   Use an installed Python with ReportLab 4.4.9. The installed PDF skill, when
   available, owns locating bundled dependencies and PDF rendering tools.
   Otherwise use a Python environment satisfying [scripts/requirements.txt](scripts/requirements.txt).
   Keep font files installed locally; this payload contains no font binaries.
2. Choose a new output PDF path in the task's deliverables directory. Run the
   packaged generator relative to the loaded skill directory:

   ```sh
   "$PARODY_PYTHON" "$PARODY_SKILL_DIR/scripts/generate.py" \
     --name "$PARODY_RECIPIENT" \
     --degree "$PARODY_DEGREE" \
     --output "$PARODY_OUTPUT"
   ```

   Set the variables from the supplied values and quote them as shown. Pass
   `--date YYYY-MM-DD` only for a requested date override. Use `--help` for
   the installed-font directory override and the command's error behaviour.
3. Require exit 0 and `status: created`. Width, unsupported-character and
   missing-font errors stop before output creation. Ask for shorter wording
   when the named field overflows; preserve the fixed font size and layout.
   Existing output files are preserved; choose a new filename for a revision.
4. Inspect the actual PDF: one 297 x 420 mm portrait page, white background,
   supplied name/title/date, both embedded Times New Roman italic faces, and
   the complete page without clipped or overlapping content. Render the page
   with the available PDF tools and inspect it before returning the PDF.

The fixed honours wording is `with high distinction` followed by
`and with first class honours`. Only `high distinction` and `first class honours`
are bold italic; their prefixes are regular italic. The remaining wording,
artwork and positions come from [assets/layout.json](assets/layout.json).

This creates a local personal parody with parody metadata. Certificate creation
supplies no authority to issue academic awards, upload to MATest, send a message
or publish the document.

For changes to the artwork or layout, read [source and verification](references/source.md).
