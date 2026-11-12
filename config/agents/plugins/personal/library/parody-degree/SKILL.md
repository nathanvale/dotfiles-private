---
name: parody-degree
description: Generate a personalised Monash-style parody degree PDF from the seven testamur Handlebars field values, using the approved A3 certificate layout.
---

# Parody degree

Create one personal parody certificate using the packaged layout and artwork.
Accept the following Handlebars bindings directly from the request or a JSON
object. JSON keys use the field names without braces. Ask only for missing
required values; preserve supplied wording and use the defaults below.

| Binding | Content | When omitted |
| --- | --- | --- |
| `{{student_name}}` | Recipient name, bold italic | Required |
| `{{conferral_date}}` | Complete date line, italic | Generation date in Melbourne, written as `on the ... day of ...` |
| `{{award_text}}` | Admission wording, italic | `been admitted to the degree of` |
| `{{award_title_line1}}` | Complete first title line, bold italic | Required; add no degree prefix |
| `{{award_title_line2}}` | Second title line, bold italic | Empty |
| `{{specialisation_major_title}}` | Complete major or other optional line, italic | Empty |
| `{{award_with_distinction}}` | Complete distinction wording, italic | Empty |

Supply resolved, single-line plain-text strings. The bindings select fields;
the generator does not evaluate Handlebars helpers or HTML. Empty optional
award lines collapse, with later lines moving up at the fixed line spacing.
The major and distinction fields supply any honours wording; none is fixed.
The contract and defaults are packaged in [assets/input.schema.json](assets/input.schema.json).

## Generate

1. Set `PARODY_SKILL_DIR` to the directory containing this loaded `SKILL.md`.
   Use an installed Python with ReportLab 4.4.9. The installed PDF skill, when
   available, owns locating bundled dependencies and PDF rendering tools.
   Otherwise use a Python environment satisfying [scripts/requirements.txt](scripts/requirements.txt).
   Keep font files installed locally; this payload contains no font binaries.
2. Save the supplied fields as a UTF-8 JSON object. See
   [the complete example](references/example-input.json). Choose a new output
   PDF path in the task's deliverables directory. Run:

   ```sh
   "$PARODY_PYTHON" "$PARODY_SKILL_DIR/scripts/generate.py" \
     --data "$PARODY_FIELDS_JSON" \
     --output "$PARODY_OUTPUT"
   ```

   Set the variables from the chosen paths and quote them as shown. For a date
   override, pass the complete desired text in `conferral_date`; it is printed
   as supplied. Use `--help` for the installed-font directory override.
3. Require exit 0 and `status: created`. Width, unsupported-character and
   missing-font errors stop before output creation. Ask for shorter wording
   when the named field overflows; preserve the fixed font size and layout.
   Existing output files are preserved; choose a new filename for a revision.
4. Inspect the actual PDF: one 297 x 420 mm portrait page, white background,
   supplied field values, both embedded Times New Roman italic faces, and
   the complete page without clipped or overlapping content. Render the page
   with the available PDF tools and inspect it before returning the PDF.

The fixed wording, artwork and positions come from
[assets/layout.json](assets/layout.json). Unknown fields, unresolved placeholder
values, wrong value types and invalid text stop before output creation.

This creates a local personal parody with parody metadata. Certificate creation
supplies no authority to issue academic awards, upload to MATest, send a message
or publish the document.

For changes to the artwork or layout, read [source and verification](references/source.md).
