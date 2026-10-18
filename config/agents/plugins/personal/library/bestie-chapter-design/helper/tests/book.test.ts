import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, run, scratch } from "./fixtures.ts";
import { BLEED, book, type Fixture, rewritePdf, TRIM } from "./book-fixtures.ts";

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

  test("refuses an overset, hidden or changed story", () => {
    const f = book(scratch());
    Object.assign(f.native.stories[0], { hidden: ["covered by an opaque field"], oversetText: "tail", text: "H changed" });
    refused(runBook(f), "differs from its selected source text", "is overset", "hidden text: covered by an opaque field");
  });

  test("refuses missing, modified, low-resolution and off-profile links", () => {
    const f = book(scratch());
    Object.assign(f.native.links[0], { effectivePpi: 120, profile: "Adobe RGB", sha256: "f".repeat(64), status: "Modified" });
    refused(runBook(f), "link art-1 on page 2 is Modified", "not the selected", "under 300", 'profile "Adobe RGB"');
    const g = book(scratch());
    g.native.links[0].sha256 = "";
    refused(runBook(g), "target", "is missing");
  });

  test("refuses missing required fields and wrong native bleed", () => {
    const f = book(scratch());
    f.native.pages[1].fields.folio = " ";
    f.native.pages[2].bleed.outside = 3;
    refused(runBook(f), 'page 2 has no value for field "folio"', "page 3 outside bleed is 3, not 9");
  });

  test("refuses Unicode with no rendered-glyph evidence and flags font-box evidence for review", () => {
    const f = book(scratch());
    f.native.stories[0].text = "H \u{1F600}";
    f.native.stories[0].expected = "H \u{1F600}";
    refused(runBook(f), "U+1F600 appears in a story with no rendered-glyph evidence");
    f.native.unicode = [{ codepoints: "1F600", font: "Apple Color Emoji", method: "pdf-word-box", rendered: true }];
    // text is no longer in the PDF, so only the evidence rows change; the review flag is on the failure list.
    expect(runBook(f).envelope.message).not.toContain("U+1F600 appears in a story");
    expect(runBook(f).envelope.message).toContain("pdf-word-box, not glyph-tight ink");
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

  test("refuses image colour space and resolution outside the contract", () => {
    const f = book(scratch());
    f.contract.pdf.colourSpaces = ["cmyk"];
    f.contract.pdf.minImagePpi = 400;
    refused(runBook(f), "image colour space rgb is not one of cmyk", "under 400");
  });
});
