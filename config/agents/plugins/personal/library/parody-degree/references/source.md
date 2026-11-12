# Source and verification

The approved reference is the white A3 certificate from 12 November 2026,
SHA-256 `078d372c03c74bff3859266fdc8bf89daceb47c019366c3288b1009a9c00d103`.
The reference itself contains personal inputs and stays outside the plugin.

Five unchanged artwork images were extracted from the user-supplied original
HTML, SHA-256 `81acf598dded9a51b4044c9ffc8586a1c05918c06e9b9377e490fccc6f9e94fa`.
Their hashes and measured bounds are in `../assets/layout.json`. Text baselines
and font sizes preserve the approved generator's layout. Runtime generation
reads only the packaged layout/artwork and installed font faces.

The user later replaced the two-input, fixed-honours interface with the seven
testamur Handlebars bindings. Name and title fields are bold italic; the other
fields are italic. Empty optional award lines collapse. Dynamic wording and
these field styles intentionally differ from the earlier parody reference.

For a layout change, render the reference and candidate at the same resolution,
compare their pixels, inspect the full page, and retain differences. An exact
comparison uses identical field values; keep personal reference values private.

Run the public-process checks with a Python containing ReportLab and pdfplumber:
`python3 -m unittest discover -s tests -v` from the skill directory. These copy
the payload outside the checkout, inspect actual PDFs and exercise failures.
PDF rendering still requires the host's available renderer, such as Poppler.
