import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, run, scratch, sha256, sourceRepository } from "./fixtures.ts";
import { BLEED, book, type Fixture, fileSha, rewritePdf, TRIM } from "./book-fixtures.ts";

afterEach(cleanup);

function runBook(fixture: Fixture) {
  const files = fixture.write();
  return run("book", "--native", files.native, "--contract", files.contract);
}

function refused(result: ReturnType<typeof run>, ...fragments: string[]) {
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(3);
  expect(result.envelope.result.data).toBeNull();
  for (const fragment of fragments) expect(result.envelope.message).toContain(fragment);
}

// The PDF is read with poppler, which the helper refuses to run without.
const poppler = ["pdfinfo", "pdffonts", "pdfimages", "pdftotext"].every((name) => Bun.which(name) !== null);

describe.skipIf(!poppler)("book: whole-book evidence", () => {
  test("passes a consistent book, indexes every page and keeps human review open", () => {
    const result = runBook(book(scratch()));
    expect(result.envelope.message).not.toContain("issue(s)");
    expect(result.exitCode).toBe(0);
    const data = result.envelope.result.data as {
      humanReview: { id: string; status: string }[];
      notQualified: string[];
      manifest: { pageCount: number; pdf: { pages: number }; pages: { page: number; pdf: { boxes: Record<string, number[]>; fonts: unknown[]; images: { xPpi: number }[] } }[] };
    };
    expect(data.manifest.pages.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(data.manifest.pdf.pages).toBe(3);
    expect(data.manifest.pages[0]?.pdf.boxes.TrimBox).toEqual([BLEED, BLEED, BLEED + TRIM.width, BLEED + TRIM.height]);
    expect(Math.round(data.manifest.pages[0]?.pdf.images[0]?.xPpi ?? 0)).toBe(300);
    expect(data.humanReview.map((h) => h.id)).toEqual(["full-size-visual", "privacy", "accessibility"]);
    expect(data.humanReview.every((h) => h.status === "open")).toBe(true);
    expect(data.notQualified).toContain("print-qualification");
    expect(data.notQualified).toContain("native-execution");
  });

  test("refuses an art file that changed after the binding", () => {
    const f = book(scratch());
    (f.native.art[0] as { sha256: string }).sha256 = "0".repeat(64);
    refused(runBook(f), "[binding] art art-1");
  });

  test("refuses a source revision that is not in the repository", () => {
    const f = book(scratch());
    f.native.sourceRevision.commit = "1".repeat(40);
    refused(runBook(f), "[binding] source revision");
  });

  test("refuses a PDF that no longer matches its bound digest", () => {
    const f = book(scratch());
    f.native.pdf.sha256 = "0".repeat(64);
    refused(runBook(f), "does not match its bound digest");
  });

  test("refuses a missing page, wrong page count and wrong parity", () => {
    const f = book(scratch());
    f.native.pages.splice(1, 1);
    refused(runBook(f), "[pages] page readback covers pages 1,3");
    const g = book(scratch());
    g.native.pages[1].side = "right";
    refused(runBook(g), "page 2 is read as a right page; page parity makes it left");
  });

  test("refuses the wrong-side parent and a moved parent transform", () => {
    const f = book(scratch());
    f.native.pages[0].parent = { name: "A-Left", transform: [1, 0, 0, 1, 0, 0] };
    refused(runBook(f), "page 1 (right) uses left parent");
    const g = book(scratch());
    g.native.pages[2].parent.transform = [1, 0, 0, 1, 300, 0];
    refused(runBook(g), "page 3 parent \"B-Right\" transform");
  });

  test("refuses undeclared styles and unallowed local overrides, but allows the emoji font", () => {
    const f = book(scratch());
    f.native.styles.paragraph.push("Stray Style");
    f.native.pages[0].items[0].overrides = [
      { property: "appliedFont", scope: "character", style: "Emoji", value: "Apple Color Emoji" },
      { property: "pointSize", scope: "paragraph", style: "Bestie Body", value: "13" },
    ];
    const result = runBook(f);
    refused(result, 'paragraph style "Stray Style"', "local paragraph override pointSize=13");
    expect(result.envelope.message).not.toContain("appliedFont=Apple Color Emoji");
  });

  test("refuses a whitespace-only change to a story, since source text is compared exactly", () => {
    const f = book(scratch());
    f.native.stories[0].expected = "H  H";
    f.native.stories[0].text = "H H";
    refused(runBook(f), "differs from its selected source text at character 2");
  });

  test("refuses a template that is not the pinned file, in the binding or on disk", () => {
    const f = book(scratch());
    f.native.template.sha256 = "0".repeat(64);
    refused(runBook(f), "bound at 000");
    const g = book(scratch());
    g.contract.template.sha256 = "1".repeat(64);
    g.native.template.sha256 = "1".repeat(64);
    refused(runBook(g), "template file", "not the pinned 111");
    const h = book(scratch());
    h.native.template.path = `${h.dir}/absent.indt`;
    refused(runBook(h), "is missing; its pin is unverified");
  });

  test("refuses pages in no family, double assignments and wrong family reads", () => {
    const f = book(scratch());
    f.contract.exceptions = [];
    refused(runBook(f), "page 3 is in neither a family nor a declared exception");
    const g = book(scratch());
    g.contract.exceptions.push({ page: 1, reason: "dup" });
    refused(runBook(g), "page 1 is assigned twice");
    const h = book(scratch());
    h.native.pages[1].family = "Card-A";
    refused(runBook(h), 'page 2 is read as "Card-A"; the contract assigns "Card-B"');
    const i = book(scratch());
    i.contract.pageFamilies[0].family = "Card-Z";
    refused(runBook(i), 'family "Card-Z", which the contract does not declare');
  });

  test("refuses page-local margins, columns and card placement that differ from the family", () => {
    const f = book(scratch());
    f.native.pages[0].margins.outside = 12;
    f.native.pages[0].columns = { count: 2, gutter: 14 };
    f.native.pages[1].items[0].bounds = [60, 40, 340, 300];
    f.native.pages[0].items = [];
    refused(runBook(f), "page 1 margin outside is 12, not 30", "page 1 has 2 columns", 'page 1 has no "body" frame', 'page 2 "body" is at [60,40,340,300]');
  });

  test("does not hold a declared exception page to a family's geometry", () => {
    const f = book(scratch());
    f.native.pages[2].margins.top = 5;
    f.native.pages[2].items[0].bounds = [0, 0, 10, 10];
    expect(runBook(f).exitCode).toBe(0);
  });

  test("manifest lists family coverage and exceptions from the contract", () => {
    const data = runBook(book(scratch())).envelope.result.data as { manifest: { coverage: { exceptions: { page: number }[]; families: { name: string; pages: number[] }[] } } };
    expect(data.manifest.coverage.families).toEqual([{ name: "Card-A", pages: [1] }, { name: "Card-B", pages: [2] }]);
    expect(data.manifest.coverage.exceptions.map((e) => e.page)).toEqual([3]);
  });

  test("refuses an overset, hidden or changed story", () => {
    const f = book(scratch());
    Object.assign(f.native.stories[0], { hidden: ["covered by an opaque field"], oversetText: "tail", text: "H changed" });
    refused(runBook(f), "differs from its selected source text", "is overset", "hidden text: covered by an opaque field");
  });

  test("refuses missing, modified, low-resolution and off-profile links", () => {
    const f = book(scratch());
    Object.assign(f.native.links[0], { effectivePpi: 120, profile: "Adobe RGB", sha256: "f".repeat(64), status: "Modified" });
    refused(runBook(f), "link art-1 on page 2 is Modified", "reports target digest fff", "under 300", 'profile "Adobe RGB"');
  });

  test("refuses a link whose target is missing or substituted on disk, even when the JSON digests agree", () => {
    const f = book(scratch());
    f.native.links[0].path = `${f.dir}/nonexistent-image.png`;
    refused(runBook(f), "target", "is missing on disk");
    const g = book(scratch());
    writeFileSync(g.native.links[0].path, "substituted bytes");
    refused(runBook(g), "on disk, not the selected");
  });

  test("refuses a link that selects bytes the bound art does not carry", () => {
    const f = book(scratch());
    f.native.links[0].id = "other-art";
    refused(runBook(f), "has no bound art entry with id other-art");
    const g = book(scratch());
    const other = "9".repeat(64);
    Object.assign(g.native.links[0], { expectedSha256: other, sha256: other });
    refused(runBook(g), "but bound art art-1 is");
  });

  test("refuses an omitted, extra or relocated story against the contract inventory", () => {
    const f = book(scratch());
    f.native.stories = [];
    refused(runBook(f), "story p1:body is in the contract's story inventory but missing from the readback");
    const g = book(scratch());
    g.native.stories.push({ expected: "H", hidden: [], key: "p9:extra", pages: [1], text: "H" });
    refused(runBook(g), "story p9:extra is in the document but not in the contract's story inventory");
    const h = book(scratch());
    h.native.stories[0].pages = [2];
    refused(runBook(h), "story p1:body is on pages 2; the contract lists 1");
  });

  test("binds expected story text to the contract digest and the bound source revision", () => {
    const f = book(scratch());
    Object.assign(f.native.stories[0], { expected: "HH", text: "HH" });
    refused(runBook(f), "expected text is", "not the contract's selected", "is not paragraph-for-paragraph in note.md");
    const g = book(scratch());
    g.contract.stories[0].owner = "absent.md";
    refused(runBook(g), "owner absent.md is not in source revision");
  });

  test("accepts a story that is a contiguous run of source paragraphs, unwrapped", () => {
    const f = book(scratch());
    f.native.sourceRevision = sourceRepository(f.dir, "# T\n\nfirst\nline\n\nsecond\n\nthird\n");
    Object.assign(f.native.stories[0], { expected: "first line\rsecond", text: "first line\rsecond" });
    f.contract.stories[0].sha256 = sha256("first line\rsecond");
    const message = runBook(f).envelope.message;
    expect(message).not.toContain("[source]");
    expect(message).not.toContain("[stories]");
  });

  test("refuses a link on a page outside the book, and keeps every link in the manifest", () => {
    const f = book(scratch());
    f.native.links[0].page = 999;
    refused(runBook(f), "is outside pages 1-3");
    const g = book(scratch());
    const data = runBook(g).envelope.result.data as { manifest: { links: { id: string }[] } };
    expect(data.manifest.links.map((l) => l.id)).toEqual(["art-1"]);
  });

  test("refuses whitespace-only overset", () => {
    const f = book(scratch());
    f.native.stories[0].oversetText = "\r\r";
    refused(runBook(f), "story p1:body is overset");
  });

  test("refuses lost paragraph breaks, since the source is compared exactly", () => {
    const f = book(scratch());
    f.native.stories[0].expected = "H\rH";
    f.native.stories[0].text = "H H";
    refused(runBook(f), "differs from its selected source text at character 1");
  });

  test("refuses missing required fields and wrong native bleed", () => {
    const f = book(scratch());
    f.native.pages[1].fields.folio = " ";
    f.native.pages[2].bleed.outside = 3;
    refused(runBook(f), 'page 2 has no value for field "folio"', "page 3 outside bleed is 3, not 9");
  });

  test("refuses Unicode with no rendered-glyph evidence, and evidence that is not glyph-tight or not in an installed font", () => {
    const f = book(scratch());
    f.native.stories[0].text = "H \u{1F600}";
    f.native.stories[0].expected = "H \u{1F600}";
    refused(runBook(f), "U+1F600 appears in a story with no rendered-glyph evidence");
    f.native.fonts.push({ installed: true, name: "Apple Color Emoji" });
    f.native.unicode = [{ codepoints: "1F600", font: "Apple Color Emoji", method: "pdf-word-box", rendered: true }];
    refused(runBook(f), "used pdf-word-box, which is not glyph-tight ink", "U+1F600 appears in a story with no rendered-glyph evidence");
    f.native.unicode = [{ codepoints: "1F600", font: "Wrong Font", method: "raster-glyph", rendered: true }];
    refused(runBook(f), "names font Wrong Font, which is not an installed inventoried font");
    f.native.unicode = [{ codepoints: "1F600", font: "Apple Color Emoji", method: "raster-glyph", rendered: true }];
    expect(runBook(f).envelope.message).not.toContain("[unicode]");
  });

  test("refuses an inventoried document font that is not installed, though the contract does not require it", () => {
    const f = book(scratch());
    f.native.fonts.push({ installed: false, name: "Missing Font" });
    refused(runBook(f), "document font Missing Font is not installed");
  });

  test("refuses missing required fonts and a different export setting", () => {
    const f = book(scratch());
    f.contract.requiredFonts = ["Avenir Next", "Noto Emoji"];
    f.native.fonts[0].installed = false;
    f.native.exportSettings.Compatibility = "Acrobat 4";
    refused(runBook(f), "required font Avenir Next is not installed", "required font Noto Emoji is not in the font readback", 'export setting Compatibility is "Acrobat 4"');
  });

  test("refuses a missing preflight profile", () => {
    const f = book(scratch());
    f.native.preflight.profile = "[High Quality Print]";
    refused(runBook(f), "Preflight profile");
  });
});

describe.skipIf(!poppler)("book: exported PDF evidence", () => {
  test("refuses a PDF with fewer pages than the native book", () => {
    const f = book(scratch());
    rewritePdf(f, f.pdfPages.slice(0, 2));
    refused(runBook(f), "PDF has 2 pages; the native book has 3");
  });

  test("refuses wrong trim and bleed boxes, read from the PDF itself", () => {
    const f = book(scratch());
    const pages = f.pdfPages.map((p, i) => (i === 1 ? { ...p, bleedBox: [3, 0, 321, 418] } : p));
    rewritePdf(f, pages);
    refused(runBook(f), "PDF page 2");
  });

  test("refuses text that is in native but missing from the exported page", () => {
    const f = book(scratch());
    f.native.stories[0].expected = "HH";
    f.native.stories[0].text = "HH";
    refused(runBook(f), "is not all present in the exported PDF pages 1");
  });

  test("refuses RGB text or vector ink under a CMYK-only contract, and allows it once the contract does", () => {
    const f = book(scratch());
    rewritePdf(f, f.pdfPages.map((p, i) => (i === 0 ? { ...p, colour: "1 0 0 rg" } : p)));
    f.contract.pdf.colourSpaces = ["rgb"];
    expect(runBook(f).exitCode).toBe(0);
    f.contract.pdf.colourSpaces = ["cmyk"];
    refused(runBook(f), "[pdfContentColour] PDF content streams paint 1 rgb colour operator(s)", "image colour space rgb");
    rewritePdf(f, f.pdfPages.map((p, i) => (i === 0 ? { ...p, colour: "0 0 0 1 k" } : p)));
    f.contract.pdf.colourSpaces = ["rgb"];
    refused(runBook(f), "1 cmyk colour operator(s)");
  });

  test("reads colour operators as PDF tokens: not inside text strings, and before comments", () => {
    const f = book(scratch());
    f.contract.pdf.colourSpaces = ["rgb"];
    rewritePdf(f, f.pdfPages.map((p, i) => (i === 0 ? { ...p, colour: "(H 0 0 0 1 k H) Tj" } : p)));
    expect(runBook(f).exitCode).toBe(0);
    rewritePdf(f, f.pdfPages.map((p, i) => (i === 0 ? { ...p, colour: "0 0 0 1 k% black\n" } : p)));
    refused(runBook(f), "paint 1 cmyk colour operator(s)");
    rewritePdf(f, f.pdfPages.map((p, i) => (i === 0 ? { ...p, colour: "% 0 0 0 1 k in a comment\n<0000> Tj" } : p)));
    expect(runBook(f).exitCode).toBe(0);
    for (const end of ["\r", "\r\n"]) {
      rewritePdf(f, f.pdfPages.map((p, i) => (i === 0 ? { ...p, colour: `% comment${end}0 0 0 1 k\n` } : p)));
      refused(runBook(f), "paint 1 cmyk colour operator(s)");
    }
  });

  test("reads colour operators from Flate-compressed content streams too", () => {
    const f = book(scratch());
    rewritePdf(f, f.pdfPages.map((p, i) => (i === 2 ? { ...p, colour: "1 0 0 rg", deflate: true } : p)));
    f.contract.pdf.colourSpaces = ["cmyk"];
    refused(runBook(f), "paint 1 rgb colour operator(s)");
  });

  test("reads colour operators through zlib-wrapped Flate, ASCIIHex, ASCII85 and chained filters", () => {
    const f = book(scratch());
    f.contract.pdf.colourSpaces = ["rgb", "cmyk"];
    const variants: { deflate?: boolean; encode?: "hex" | "ascii85" }[] = [{ deflate: true }, { encode: "hex" }, { encode: "ascii85" }, { deflate: true, encode: "hex" }, { deflate: true, encode: "ascii85" }];
    for (const variant of variants) {
      rewritePdf(f, f.pdfPages.map((p, i) => (i === 0 ? { ...p, colour: "0.5 g", ...variant } : p)));
      refused(runBook(f), "paint 1 gray colour operator(s)");
    }
  });

  test("refuses a content filter it cannot decode instead of passing its colour unread", () => {
    const f = book(scratch());
    rewritePdf(f, f.pdfPages);
    const text = readFileSync(f.pdfPath, "latin1").replace("/Length", "/Filter /LZWDecode /Length");
    writeFileSync(f.pdfPath, Buffer.from(text, "latin1"));
    f.native.pdf.sha256 = fileSha(f.pdfPath);
    const result = runBook(f);
    expect(result.exitCode).not.toBe(0);
    expect(JSON.stringify(result.envelope)).toContain("LZWDecode");
  });

  test("keeps overrides, fonts, Unicode evidence, links and story digests in the manifest, with input digests", () => {
    const f = book(scratch());
    f.native.pages[0].items[0].overrides = [{ property: "appliedFont", scope: "character", style: "Emoji", value: "Apple Color Emoji" }];
    const data = runBook(f).envelope.result.data as {
      manifest: {
        fonts: unknown[];
        inputs: { native: { sha256: string } };
        links: unknown;
        pages: { items: { overrides: unknown[] }[]; links: { diskSha256: string }[] }[];
        stories: { sourceSha256: string }[];
      };
    };
    expect(data.manifest.pages[0]?.items[0]?.overrides).toEqual([{ property: "appliedFont", scope: "character", style: "Emoji", value: "Apple Color Emoji" }]);
    expect(data.manifest.fonts).toEqual([{ installed: true, name: "Avenir Next" }]);
    expect(data.manifest.pages[1]?.links[0]?.diskSha256).toBe(f.native.links[0].sha256);
    expect(data.manifest.stories[0]?.sourceSha256).toHaveLength(64);
    expect(data.manifest.inputs.native.sha256).toHaveLength(64);
  });

  test("refuses image colour space and resolution outside the contract", () => {
    const f = book(scratch());
    f.contract.pdf.colourSpaces = ["cmyk"];
    f.contract.pdf.minImagePpi = 400;
    refused(runBook(f), "image colour space rgb is not one of cmyk", "under 400");
  });
});
