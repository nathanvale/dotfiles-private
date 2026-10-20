import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, run, scratch, sha256, sourceRepository } from "./fixtures.ts";
import { placementUnits } from "../src/copy.ts";
import { pdfFindings } from "../src/book-pdf-checks.ts";
import { BLEED, book, type Fixture, fileSha, rewritePdf, TRIM, writePdfObjects } from "./book-fixtures.ts";

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
    g.native.stories.push({ expected: "H", hidden: [], key: "p9:extra", oversetText: "", pages: [1], text: "H" });
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

  test("accepts the copy helper's exact continuation whitespace in bound source text", () => {
    const f = book(scratch());
    f.native.sourceRevision = sourceRepository(f.dir, "# Note\n\nH  \n  H\n");
    const units = placementUnits({ chapter: "test", blocks: [{ owner: `${f.native.sourceRevision.repository}/note.md`, heading: "Note", paragraphs: [1, 1], role: "introduction", standing: "accepted", acceptance: { scope: "chapter", evidence: "test-owned" }, sha256: sha256("H   H"), supersedes: [] }] });
    expect(units.map(unit => unit.text)).toEqual(["H   H"]);
    Object.assign(f.native.stories[0], { expected: "H   H", text: "H   H" });
    f.contract.stories[0].sha256 = sha256("H   H");
    rewritePdf(f, f.pdfPages.map((p, i) => i === 0 ? { ...p, text: "H   H" } : p));
    expect(runBook(f).exitCode).toBe(0);
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

  test("tracks selected device colour spaces, stroke state and graphics save/restore", () => {
    const f = book(scratch());
    f.contract.pdf.colourSpaces = ["rgb"];
    const render = () => {
      const out = Bun.spawnSync(["pdftoppm", "-f", "1", "-singlefile", "-scale-to", "300", "-png", f.pdfPath], { stdout: "pipe", stderr: "pipe" });
      expect(out.exitCode).toBe(0);
      expect(out.stderr.toString()).toBe("");
      expect(out.stdout.length).toBeGreaterThan(100);
      return out.stdout;
    };
    for (const [direct, selected, count] of [
      ["1 0 0 0 k 40 40 30 30 re f", "/DeviceCMYK cs 1 0 0 0 sc 40 40 30 30 re f", 1],
      ["1 0 0 0 K 40 40 30 30 re S", "/DeviceCMYK CS 1 0 0 0 SC 40 40 30 30 re S", 1],
      ["1 0 0 0 k 40 40 30 30 re f", "/DeviceCM#59K cs q /DeviceRGB cs Q 1 0 0 0 scn 40 40 30 30 re f", 1],
      ["1 0 0 0 K 40 40 30 30 re S", "1 0 0 0 K 1 0 0 0 SCN 40 40 30 30 re S", 2],
    ] as const) {
      rewritePdf(f, f.pdfPages.map((p, i) => i === 0 ? { ...p, colour: direct } : p));
      const control = render();
      rewritePdf(f, f.pdfPages.map((p, i) => i === 0 ? { ...p, colour: selected } : p));
      expect(render().equals(control)).toBe(true);
      refused(runBook(f), `paint ${count} cmyk colour operator(s)`);
    }
    rewritePdf(f, f.pdfPages.map((p, i) => i === 0 ? { ...p, colour: "/DeviceRGB cs /DeviceCMYK CS 1 0 0 sc 40 40 30 30 re f" } : p));
    expect(runBook(f).exitCode).toBe(0);
    rewritePdf(f, f.pdfPages.map((p, i) => i === 0 ? { ...p, colour: "0.5 sc 40 40 30 30 re f" } : p));
    refused(runBook(f), "paint 1 gray colour operator(s)");
  });

  test("reads page Contents as an ordered program across stream boundaries", () => {
    const f = book(scratch());
    f.contract.pdf.colourSpaces = ["rgb"];
    for (const [first, second, space] of [["q 0.5 ", "g 20 20 80 80 re f Q", "gray"], ["q /DeviceCMYK cs ", "1 0 0 0 sc 20 20 80 80 re f Q", "cmyk"]] as const) {
      rewritePdf(f, f.pdfPages.map((p, i) => i === 0 ? { ...p, colour: `${first}${second}` } : p));
      const render = () => Bun.spawnSync(["pdftoppm", "-f", "1", "-singlefile", "-scale-to", "300", "-png", f.pdfPath], { stdout: "pipe", stderr: "pipe" });
      const control = render();
      expect(control.exitCode).toBe(0);
      expect(control.stderr.toString()).toBe("");
      const objects = [...readFileSync(f.pdfPath, "latin1").matchAll(/\d+ 0 obj\n([\s\S]*?)\nendobj\n/g)].map(m => m[1] ?? "");
      const stream = (value: string) => `<< /Length ${value.length} >>\nstream\n${value}\nendstream`;
      const ids = [objects.length + 1, objects.length + 2];
      let changed = false;
      const output = objects.map(body => {
        if (changed || !body.startsWith("<< /Type /Page ")) return body;
        changed = true;
        return body.replace(/\/Contents (\d+ 0 R)/, `/Contents [$1 ${ids[0]} 0 R ${ids[1]} 0 R]`);
      });
      // Remove the original painting, preserving the page's text and image program.
      const target = output.findIndex(body => body.includes(`${first}${second} BT`));
      const body = (output[target] ?? "").replace(`${first}${second}`, "");
      const data = /stream\n([\s\S]*)\nendstream/.exec(body)?.[1] ?? "";
      output[target] = stream(data);
      output.push(stream(first), stream(second));
      writePdfObjects(f.pdfPath, output);
      f.native.pdf.sha256 = fileSha(f.pdfPath);
      const result = render();
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
      expect(result.stdout.equals(control.stdout)).toBe(true);
      refused(runBook(f), `paint 1 ${space} colour operator(s)`);
    }
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

  test("follows an indirect Filter value, and refuses one it cannot find", () => {
    const f = book(scratch());
    f.contract.pdf.colourSpaces = ["rgb"];
    rewritePdf(f, f.pdfPages.map((p, i) => (i === 0 ? { ...p, colour: "0.5 g", deflate: true } : p)));
    const direct = readFileSync(f.pdfPath, "latin1");
    expect(direct).toContain("/Filter [/FlateDecode]");
    const cases: [string, string][] = [
      ["99", "paint 1 gray colour operator(s)"],
      ["98", "99 0 R names a stream filter"],
    ];
    for (const [id, expected] of cases) {
      const text = direct.replace("/Filter [/FlateDecode]", "/Filter 99 0 R").replace("\ntrailer", `\n${id} 0 obj\n[/FlateDecode]\nendobj\ntrailer`);
      writeFileSync(f.pdfPath, Buffer.from(text, "latin1"));
      f.native.pdf.sha256 = fileSha(f.pdfPath);
      refused(runBook(f), expected);
    }
  });

  test("does not read names in PDF comments as filters or image markers", () => {
    const f = book(scratch());
    f.contract.pdf.colourSpaces = ["rgb"];
    rewritePdf(f, f.pdfPages.map((p, i) => (i === 0 ? { ...p, colour: "0.5 g", deflate: true } : p)));
    const direct = readFileSync(f.pdfPath, "latin1");
    const variants = [
      direct.replace("/Filter [/FlateDecode]", "/Filter [/FlateDecode % /DCTDecode\n]"),
      direct.replace("/Filter [/FlateDecode]", "/Filter 99 0 R").replace("\ntrailer", "\n99 0 obj\n[ /FlateDecode % /DCTDecode\n]\nendobj\ntrailer"),
      direct.replace("/Filter [/FlateDecode]", "% /Subtype /Image\n/Filter [/FlateDecode]"),
    ];
    for (const text of variants) {
      expect(text).not.toBe(direct);
      writeFileSync(f.pdfPath, Buffer.from(text, "latin1"));
      f.native.pdf.sha256 = fileSha(f.pdfPath);
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

  test("refuses readback values that would be coerced into text, and an omitted overset observation", () => {
    const nullField = book(scratch());
    (nullField.native.pages[0].fields as Record<string, unknown>).folio = null;
    expect(runBook(nullField).exitCode).toBe(4);
    expect(runBook(nullField).envelope.message).toContain("fields.folio must be a string or number");
    const objectSetting = book(scratch());
    (objectSetting.native.exportSettings as Record<string, unknown>)["Include Bleed"] = {};
    expect(runBook(objectSetting).envelope.message).toContain("must be a string or number");
    const omitted = book(scratch());
    delete (omitted.native.stories[0] as { oversetText?: string }).oversetText;
    const result = runBook(omitted);
    expect(result.exitCode).toBe(4);
    expect(result.envelope.message).toContain("oversetText");
  });

  test("refuses a source commit that is not a hexadecimal id before git sees it", () => {
    const f = book(scratch());
    f.native.sourceRevision.commit = "--output=/tmp/bestie-should-not-exist";
    const result = runBook(f);
    expect(result.exitCode).toBe(4);
    expect(result.envelope.message).toContain("commit must be a hexadecimal commit id");
  });

  test("reads prose straight after a heading as its own paragraph", () => {
    const f = book(scratch());
    f.native.sourceRevision = sourceRepository(f.dir, "# Note\nH\n\n## Next\nsecond\n");
    const message = runBook(f).envelope.message;
    expect(message).not.toContain("[source]");
  });

  test("leaves soft-mask rows out of the image colour check", () => {
    const f = book(scratch());
    const listing = Bun.spawnSync(["pdfimages", "-list", f.pdfPath], { stdout: "pipe" }).stdout.toString();
    expect(listing).toContain("smask");
    f.contract.pdf.colourSpaces = ["rgb"];
    expect(runBook(f).exitCode).toBe(0);
  });

  test("cuts streams at their declared length and counts colour split across streams", () => {
    const f = book(scratch());
    f.contract.pdf.colourSpaces = ["cmyk"];
    f.contract.pdf.minImagePpi = undefined;
    rewritePdf(f, f.pdfPages.map((p, i) => (i === 0 ? { ...p, colour: "BT /F1 12 Tf (endstream) Tj ET 1 0 0 rg" } : p)));
    refused(runBook(f), "paint 1 rgb colour operator(s)");
    f.contract.pdf.colourSpaces = ["rgb"];
    rewritePdf(f, f.pdfPages.map((p, i) => (i === 0 ? { ...p, extra: { content: "0 0 0 1 k" } } : p)));
    refused(runBook(f), "paint 1 cmyk colour operator(s)");
  });

  test("does not lose compressed page ink after obj inside a dictionary string", () => {
    const f = book(scratch());
    f.contract.pdf.colourSpaces = ["rgb"];
    rewritePdf(f, f.pdfPages.map((p, i) => i === 0 ? { ...p, colour: "0.5 g", deflate: true } : p));
    const render = () => Bun.spawnSync(["pdftoppm", "-f", "1", "-singlefile", "-scale-to", "300", "-png", f.pdfPath], { stdout: "pipe", stderr: "pipe" });
    const control = render();
    expect(control.exitCode).toBe(0);
    expect(control.stderr.toString()).toBe("");
    expect(control.stdout.length).toBeGreaterThan(100);
    for (const dictionary of ["/Name (xobj) /Resources << >>", "/Name /xobj /Resources << >>", "/Name (9 0 obj) /Resources << >>"]) {
      rewritePdf(f, f.pdfPages.map((p, i) => i === 0 ? { ...p, colour: "0.5 g", deflate: true, dictionary } : p));
      const changed = render();
      expect(changed.exitCode).toBe(0);
      expect(changed.stderr.toString()).toBe("");
      expect(changed.stdout.equals(control.stdout)).toBe(true);
      refused(runBook(f), "paint 1 gray colour operator(s)");
    }
  });

  test("checks referenced page ink despite renderer-ignored metadata", () => {
    const f = book(scratch());
    f.contract.pdf.colourSpaces = ["rgb"];
    rewritePdf(f, f.pdfPages.map((p, i) => i === 0 ? { ...p, colour: "0.5 g" } : p));
    const render = () => Bun.spawnSync(["pdftoppm", "-f", "1", "-singlefile", "-scale-to", "300", "-png", f.pdfPath], { stdout: "pipe", stderr: "pipe" });
    const control = render();
    expect(control.exitCode).toBe(0);
    expect(control.stderr.toString()).toBe("");
    expect(control.stdout.length).toBeGreaterThan(100);
    for (const dictionary of ["/N 1", "/Length1 20", "/FunctionType 2", "/ShadingType 2", "/Type /Metadata", "/Subtype /Image"]) {
      rewritePdf(f, f.pdfPages.map((p, i) => i === 0 ? { ...p, colour: "0.5 g", dictionary } : p));
      const changed = render();
      expect(changed.exitCode).toBe(0);
      expect(changed.stderr.toString()).toBe("");
      expect(changed.stdout.equals(control.stdout)).toBe(true);
      refused(runBook(f), "paint 1 gray colour operator(s)");
    }
  });

  test("checks rendered Form ink despite renderer-ignored metadata", () => {
    const f = book(scratch());
    f.contract.pdf.colourSpaces = ["rgb"];
    const pages = f.pdfPages.map((p, i) => i === 0 ? { ...p, colour: "0.5 g", form: true, deflate: true } : p);
    rewritePdf(f, pages);
    const render = () => Bun.spawnSync(["pdftoppm", "-f", "1", "-singlefile", "-scale-to", "300", "-png", f.pdfPath], { stdout: "pipe", stderr: "pipe" });
    const control = render();
    expect(control.exitCode).toBe(0);
    expect(control.stderr.toString()).toBe("");
    expect(control.stdout.length).toBeGreaterThan(100);
    for (const dictionary of ["/N 1", "/Length1 20", "/FunctionType 2", "/ShadingType 2"]) {
      rewritePdf(f, pages.map((p, i) => i === 0 ? { ...p, dictionary } : p));
      const changed = render();
      expect(changed.exitCode).toBe(0);
      expect(changed.stderr.toString()).toBe("");
      expect(changed.stdout.equals(control.stdout)).toBe(true);
      refused(runBook(f), "paint 1 gray colour operator(s)");
    }
  });

  test("refuses object streams when page Contents membership is unavailable", () => {
    const f = book(scratch());
    rewritePdf(f, f.pdfPages.map((p, i) => i === 0 ? { ...p, extra: { dict: "/Type /ObjStm", content: "opaque" } } : p));
    refused(runBook(f), "object streams hide page Contents membership");
  });

  test("resolves Contents arrays from actual objects, not headers inside strings", () => {
    const f = book(scratch());
    f.contract.pdf.colourSpaces = ["rgb"];
    rewritePdf(f, f.pdfPages.map((p, i) => i === 0 ? { ...p, colour: "0.5 g", dictionary: "/N 1" } : p));
    const objects = [...readFileSync(f.pdfPath, "latin1").matchAll(/\d+ 0 obj\n([\s\S]*?)\nendobj\n/g)].map(match => match[1] ?? "");
    const content = objects.findIndex(body => body.includes("0.5 g BT"));
    expect(content).toBeGreaterThanOrEqual(0);
    const arrayId = objects.length + 1;
    const render = () => Bun.spawnSync(["pdftoppm", "-f", "1", "-singlefile", "-scale-to", "300", "-png", f.pdfPath], { stdout: "pipe", stderr: "pipe" });
    const control = render();
    expect(control.exitCode).toBe(0);
    expect(control.stderr.toString()).toBe("");
    expect(control.stdout.length).toBeGreaterThan(100);
    for (const comment of [" ", "% legal reference separator\n"]) {
      const changed = objects.map(body => body.replace(`/Contents ${content + 1} 0 R`, `/Contents ${arrayId}${comment}0 R`));
      changed[content] = (changed[content] ?? "").replace("<< ", `<< /Foo (\n${arrayId} 0 obj\n[]\nendobj\n) `);
      changed.push(`[${content + 1} 0 R]`);
      writePdfObjects(f.pdfPath, changed);
      f.native.pdf.sha256 = fileSha(f.pdfPath);
      const rendered = render();
      expect(rendered.exitCode).toBe(0);
      expect(rendered.stderr.toString()).toBe("");
      expect(rendered.stdout.equals(control.stdout)).toBe(true);
      refused(runBook(f), "paint 1 gray colour operator(s)");
    }
  });

  test("uses the cross-reference entry for indirect stream Length", () => {
    const f = book(scratch());
    f.contract.pdf.colourSpaces = ["rgb"];
    rewritePdf(f, f.pdfPages.map((p, i) => i === 0 ? { ...p, colour: "/Span << /ActualText (endstream) >> BDC EMC 0.5 g" } : p));
    const objects = [...readFileSync(f.pdfPath, "latin1").matchAll(/\d+ 0 obj\n([\s\S]*?)\nendobj\n/g)].map(match => match[1] ?? "");
    const index = objects.findIndex(body => body.includes("0.5 g BT"));
    expect(index).toBeGreaterThanOrEqual(0);
    const original = objects[index] ?? "";
    const start = original.indexOf("stream\n") + 7;
    const length = original.lastIndexOf("\nendstream") - start;
    const shorter = original.indexOf("endstream)", start) - start;
    expect(shorter).toBeGreaterThan(0);
    const lengthId = objects.length + 1;
    const render = () => Bun.spawnSync(["pdftoppm", "-f", "1", "-singlefile", "-scale-to", "300", "-png", f.pdfPath], { stdout: "pipe", stderr: "pipe" });
    const control = render();
    expect(control.exitCode).toBe(0);
    expect(control.stderr.toString()).toBe("");
    expect(control.stdout.length).toBeGreaterThan(100);
    for (const mode of ["control", "string", "incremental", "crlf"]) {
      const changed = [...objects];
      changed[index] = original.replace(/\/Length \d+/, `/Length ${lengthId} 0 R`);
      if (mode !== "control") changed[index] = (changed[index] ?? "").replace("<< ", `<< /Foo (\n${lengthId} 0 obj\n${shorter}\nendobj\n) `);
      changed.push(String(length));
      writePdfObjects(f.pdfPath, changed);
      if (mode === "incremental") {
        const pdf = readFileSync(f.pdfPath, "latin1");
        const previous = /startxref\s+(\d+)/.exec(pdf)?.[1];
        const update = `xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size ${changed.length + 1} /Root 1 0 R /Prev ${previous} >>\nstartxref\n${Buffer.byteLength(pdf, "latin1")}\n%%EOF\n`;
        writeFileSync(f.pdfPath, pdf + update, "latin1");
      }
      if (mode === "crlf") {
        const pdf = readFileSync(f.pdfPath, "latin1");
        const xref = Number(/startxref\s+(\d+)/.exec(pdf)?.[1]);
        writeFileSync(f.pdfPath, pdf.slice(0, xref) + pdf.slice(xref).replaceAll("\n", "\r\n"), "latin1");
      }
      f.native.pdf.sha256 = fileSha(f.pdfPath);
      const rendered = render();
      expect(rendered.exitCode).toBe(0);
      expect(rendered.stderr.toString()).toBe("");
      expect(rendered.stdout.equals(control.stdout)).toBe(true);
      refused(runBook(f), "paint 1 gray colour operator(s)");
    }
  });

  test("refuses unreadable stream lengths instead of accepting a partial scan", () => {
    const f = book(scratch());
    const objects = [...readFileSync(f.pdfPath, "latin1").matchAll(/\d+ 0 obj\n([\s\S]*?)\nendobj\n/g)].map(match => match[1] ?? "");
    const target = objects.findIndex(body => /\/Length \d+/.test(body));
    expect(target).toBeGreaterThanOrEqual(0);
    for (const [replacement, message] of [["/Length 0", "Length does not end at endstream"], ["/Length 999 0 R", "stream Length is unreadable"], ["/OtherLength 0", "stream Length is unreadable"]]) {
      const changed = [...objects];
      changed[target] = (changed[target] ?? "").replace(/\/Length \d+/, replacement ?? "");
      writePdfObjects(f.pdfPath, changed);
      f.native.pdf.sha256 = fileSha(f.pdfPath);
      refused(runBook(f), message ?? "");
    }
  });

  test("counts every page-content stream with direct and indirect lengths", () => {
    for (const indirect of [false, true]) {
      const f = book(scratch());
      f.contract.pdf.colourSpaces = ["rgb"];
      const objects = [...readFileSync(f.pdfPath, "latin1").matchAll(/\d+ 0 obj\n([\s\S]*?)\nendobj\n/g)].map(match => match[1] ?? "");
      const page = objects.findIndex(body => /\/Type \/Page\b/.test(body));
      expect(page).toBeGreaterThanOrEqual(0);
      const original = /\/Contents (\d+) 0 R/.exec(objects[page] ?? "")?.[1];
      expect(original).toBeDefined();
      const refs: string[] = [];
      const text = "q 0.5 g 0 0 1 1 re f Q";
      for (let n = 0; n < 128; n++) {
        const id = objects.length + 1;
        refs.push(`${id} 0 R`);
        objects.push(`<< /Length ${indirect ? `${id + 1} 0 R` : text.length} >>\nstream\n${text}\nendstream`);
        if (indirect) objects.push(String(text.length));
      }
      objects[page] = (objects[page] ?? "").replace(`/Contents ${original} 0 R`, `/Contents [${original} 0 R ${refs.join(" ")}]`);
      writePdfObjects(f.pdfPath, objects);
      f.native.pdf.sha256 = fileSha(f.pdfPath);
      // Independent oracle: all 128 test-owned streams paint gray once.
      refused(runBook(f), "paint 128 gray colour operator(s)");
    }
  });

  test("does not revive an older Length object masked by a newer xref entry", () => {
    const f = book(scratch());
    const objects = [...readFileSync(f.pdfPath, "latin1").matchAll(/\d+ 0 obj\n([\s\S]*?)\nendobj\n/g)].map(match => match[1] ?? "");
    const target = objects.findIndex(body => /\/Length \d+/.test(body));
    expect(target).toBeGreaterThanOrEqual(0);
    const length = /\/Length (\d+)/.exec(objects[target] ?? "")?.[1];
    expect(length).toBeDefined();
    const id = objects.length + 1;
    objects[target] = (objects[target] ?? "").replace(/\/Length \d+/, `/Length ${id} 0 R`);
    objects.push(length ?? "");
    writePdfObjects(f.pdfPath, objects);
    const pdf = readFileSync(f.pdfPath, "latin1");
    const previous = /startxref\s+(\d+)/.exec(pdf)?.[1];
    const offset = pdf.indexOf(`${id} 0 obj`);
    expect(offset).toBeGreaterThan(0);
    for (const row of ["0000000000 00001 f", `${String(offset).padStart(10, "0")} 00001 n`]) {
      const update = `xref\n${id} 1\n${row} \ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Prev ${previous} >>\nstartxref\n${Buffer.byteLength(pdf, "latin1")}\n%%EOF\n`;
      writeFileSync(f.pdfPath, pdf + update, "latin1");
      f.native.pdf.sha256 = fileSha(f.pdfPath);
      refused(runBook(f), "stream Length is unreadable");
    }
  });

  test("reads escaped PDF filter names and keys", () => {
    const f = book(scratch());
    f.contract.pdf.colourSpaces = ["rgb"];
    rewritePdf(f, f.pdfPages.map((p, i) => (i === 0 ? { ...p, colour: "0.5 g", deflate: true } : p)));
    const direct = readFileSync(f.pdfPath, "latin1");
    for (const filter of ["/F#69lter [/FlateDecode]", "/Filter [/Fl#61teDecode]"]) {
      writeFileSync(f.pdfPath, direct.replace("/Filter [/FlateDecode]", filter), "latin1");
      f.native.pdf.sha256 = fileSha(f.pdfPath);
      refused(runBook(f), "paint 1 gray colour operator(s)");
    }
  });

  test("counts content despite nested resource metadata and literal strings", () => {
    const f = book(scratch());
    f.contract.pdf.colourSpaces = ["rgb"];
    const dictionaries = [
      "/Type /XObject /Subtype /Form /Resources << /Shading << /Sh0 << /ShadingType 2 /Function << /FunctionType 2 /N 1 >> >> >> >>",
      "/Type /XObject /Subtype /Form /Resources << /XObject << /Im << /Subtype /Image /Filter /DCTDecode >> >> >>",
      "/Foo (/Type /XRef /Subtype /Image /Filter /DCTDecode)",
      "/Foo <2f54797065202f58526566>",
      "/Foo [/Subtype /Image]",
      "/Foo [/Filter /DCTDecode]",
      "/Subtype /ImageForm",
      "/Subtype /Image-Foo",
      "/Type /Metadata-Foo",
      "/Subtype /Type1C-Foo",
      "/Subtype /Image#20Form",
      "/Type /Metadata#20Foo",
    ];
    for (const dict of dictionaries) {
      rewritePdf(f, f.pdfPages.map((p, i) => (i === 0 ? { ...p, extra: { content: "0.5 g", dict } } : p)));
      refused(runBook(f), "paint 1 gray colour operator(s)");
    }
  });

  test("does not read font, profile or table streams as page content", () => {
    const f = book(scratch());
    f.contract.pdf.colourSpaces = ["rgb"];
    for (const dict of ["/Length1 20", "/N 3", "/Type /XRef", "/Subtype /Type1C"]) {
      rewritePdf(f, f.pdfPages.map((p, i) => (i === 0 ? { ...p, extra: { content: "1 f 0.5 g 0 0 0 1 k", dict } } : p)));
      expect(runBook(f).exitCode).toBe(0);
    }
  });

  test("finds a story across pages although folios and running heads sit between its fragments", () => {
    const page = (text: string) => ({ boxes: {}, fonts: [], images: [], page: 1, text });
    const pdf = { contentColours: { cmyk: 0, gray: 0, rgb: 0 }, pages: 2, producer: "", readback: [page("Head\nfirst\n1\n"), page("Head\nsecond\n2\n")], tagged: false, version: "1.6" };
    const story = (expected: string) => ({ expected, hidden: [], key: "s", oversetText: "", pages: [1, 2], text: expected });
    const contract = { bleed: {}, pdf: { colourSpaces: [], exportSettings: {}, trim: [1, 1] }, requiredFonts: [], tolerance: 0 };
    const findings = (expected: string) => pdfFindings(pdf as never, { exportSettings: {}, pageCount: 2, pages: [], stories: [story(expected)] } as never, contract as never).pdfText;
    expect(findings("first\rsecond")).toEqual([]);
    expect(findings("first\rsecond\rthird")).toHaveLength(1);
    expect(findings("first\rmissing\rsecond")).toHaveLength(1);
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
