import { join } from "node:path";
import { put, sha256, sourceRepository } from "./fixtures.ts";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

export const TRIM = { height: 400, width: 300 };
export const BLEED = 9;
/** Independent oracle: the bleed and trim the fixture book is built to. */
export const CONTRACT_BLEED = { bottom: BLEED, inside: BLEED, outside: BLEED, top: BLEED };
const LEFT_TRANSFORM = [1, 0, 0, 1, 0, 0];
const RIGHT_TRANSFORM = [1, 0, 0, 1, 318, 0];

export type PdfPageSpec = { text: string; image: boolean; colour?: string; deflate?: boolean; encode?: "hex" | "ascii85"; trimBox?: number[]; bleedBox?: number[] };

function pdfObjects(pages: PdfPageSpec[]): string[] {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) && objects.length;
  const catalog = add("");
  const tree = add("");
  const font = add(
    "<< /Type /Font /Subtype /Type3 /FontBBox [0 0 600 700] /FontMatrix [0.001 0 0 0.001 0 0] " +
      "/CharProcs << /H 0 0 R >> /Encoding << /Type /Encoding /Differences [72 /H] >> /FirstChar 72 /LastChar 72 /Widths [600] >>",
  );
  const proc = add("");
  const imageData = deflateSync(new Uint8Array(30 * 30 * 3).fill(120));
  const image = add("");
  const kids: number[] = [];
  const pageBodies: string[] = [];
  const streams: Buffer[] = [];
  const filtered = new Map<number, string[]>();
  for (const spec of pages) {
    const content = `q 7.2 0 0 7.2 50 50 cm /Im1 Do Q ${spec.colour ?? ""} BT /F1 12 Tf 20 200 Td (${spec.text}) Tj ET`;
    const contentId = add("");
    const pageId = add("");
    kids.push(pageId);
    const trim = spec.trimBox ?? [BLEED, BLEED, BLEED + TRIM.width, BLEED + TRIM.height];
    const bleed = spec.bleedBox ?? [0, 0, TRIM.width + 2 * BLEED, TRIM.height + 2 * BLEED];
    pageBodies[pageId - 1] =
      `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${TRIM.width + 2 * BLEED} ${TRIM.height + 2 * BLEED}] /TrimBox [${trim.join(" ")}] /BleedBox [${bleed.join(" ")}] ` +
      `/Resources << /Font << /F1 ${font} 0 R >> /XObject << /Im1 ${image} 0 R >> >> /Contents ${contentId} 0 R >>`;
    const filters = specFilters(spec);
    streams[contentId - 1] = encodeContent(content, filters);
    if (filters.length > 0) filtered.set(contentId - 1, filters);
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  for (const [index, body] of pageBodies.entries()) if (body) objects[index] = body;
  objects[proc - 1] = "";
  streams[proc - 1] = Buffer.from("600 0 0 0 600 700 d1 0 0 600 700 re f", "latin1");
  streams[image - 1] = Buffer.from(imageData);
  objects[image - 1] = `<< /Type /XObject /Subtype /Image /Width 30 /Height 30 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${imageData.length} >>`;
  objects[font - 1] = objects[font - 1]?.replace("/H 0 0 R", `/H ${proc} 0 R`) ?? "";
  return objects.map((body, index) => {
    const stream = streams[index];
    if (stream === undefined) return body;
    const dict = body === "" ? `<< ${filterEntry(filtered.get(index))}/Length ${stream.length} >>` : body;
    return `${dict}\nstream\n${stream.toString("latin1")}\nendstream`;
  });
}

function ascii85(bytes: Buffer): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 4) {
    const chunk = bytes.subarray(i, i + 4);
    let value = 0;
    for (let j = 0; j < 4; j++) value = value * 256 + (chunk[j] ?? 0);
    const digits: string[] = [];
    for (let j = 0; j < 5; j++, value = Math.floor(value / 85)) digits.unshift(String.fromCharCode((value % 85) + 33));
    out += digits.slice(0, chunk.length + 1).join("");
  }
  return `${out}~>`;
}

/** Applies the filters in order, as a PDF writer would; the dictionary lists them in decode order. */
function encodeContent(content: string, filters: string[]): Buffer {
  let data = Buffer.from(content, "latin1");
  for (const name of filters) {
    if (name === "FlateDecode") data = deflateSync(data);
    else if (name === "ASCIIHexDecode") data = Buffer.from(`${data.toString("hex")}>`, "latin1");
    else data = Buffer.from(ascii85(data), "latin1");
  }
  return data;
}

function specFilters(spec: PdfPageSpec): string[] {
  const names = spec.deflate ? ["FlateDecode"] : [];
  if (spec.encode === "hex") names.push("ASCIIHexDecode");
  if (spec.encode === "ascii85") names.push("ASCII85Decode");
  return names;
}

function filterEntry(filters: string[] | undefined): string {
  return filters === undefined ? "" : `/Filter [${[...filters].reverse().map((name) => `/${name}`).join(" ")}] `;
}

/** Writes a small valid PDF whose fonts are Type 3 (always embedded). */
export function writePdf(path: string, pages: PdfPageSpec[]): void {
  const objects = pdfObjects(pages);
  let out = "%PDF-1.6\n";
  const offsets: number[] = [];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  writeFileSync(path, Buffer.from(out, "latin1"));
}

export function fileSha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// biome-ignore lint/suspicious/noExplicitAny: fixtures are mutated freely to build each refusal.
export type Loose = Record<string, any>;

export type Fixture = {
  native: Loose;
  contract: Loose;
  pdfPath: string;
  pdfPages: PdfPageSpec[];
  dir: string;
  write: () => { native: string; contract: string };
};

const sideOf = (page: number) => (page % 2 === 1 ? "right" : "left");

/** A three-page book whose native readback, art, source and PDF all agree. */
export function book(dir: string): Fixture {
  const art = put(dir, "art-1.png", "art bytes");
  const pdfPath = join(dir, "book.pdf");
  const pdfPages: PdfPageSpec[] = [1, 2, 3].map(() => ({ image: true, text: "H" }));
  writePdf(pdfPath, pdfPages);
  const native = put(dir, "book.indd", "native bytes");
  const template = put(dir, "Recovered-Library.indt", "template bytes");
  const margins = { bottom: 36, inside: 36, outside: 30, top: 36 };
  const columns = { count: 1, gutter: 0 };
  const FRAMES = [[36, 36, 364, 264], [60, 40, 340, 250]];
  const familyOf = (page: number) => (page === 3 ? "exception" : page === 1 ? "Card-A" : "Card-B");
  const pages = [1, 2, 3].map((page) => ({
    bleed: { ...CONTRACT_BLEED },
    columns: { ...columns },
    family: familyOf(page),
    fields: { folio: String(page) },
    margins: { ...margins },
    items: [{ bounds: FRAMES[page === 1 ? 0 : 1], kind: "TextFrame", label: "body", overrides: [], style: "Bestie Body" }],
    page,
    parent: { name: sideOf(page) === "right" ? "B-Right" : "A-Left", transform: sideOf(page) === "right" ? RIGHT_TRANSFORM : LEFT_TRANSFORM },
    side: sideOf(page),
  }));
  const fixture: Fixture = {
    contract: {
      stories: [{ key: "p1:body", owner: "note.md", pages: [1], sha256: sha256("H") }],
      exceptions: [{ page: 3, reason: "source-specific page kept on its own layout" }],
      families: [
        { columns, frames: [{ bounds: FRAMES[0], label: "body" }], margins, name: "Card-A" },
        { columns, frames: [{ bounds: FRAMES[1], label: "body" }], margins, name: "Card-B" },
      ],
      pageFamilies: [{ family: "Card-A", page: 1 }, { family: "Card-B", page: 2 }],
      template: { path: template, sha256: sha256("template bytes") },
      allowedOverrides: [{ property: "appliedFont", scope: "character", value: "Apple Color Emoji" }],
      bleed: { ...CONTRACT_BLEED },
      fieldExemptPages: [],
      firstPageSide: "right",
      links: { minPpi: 300, profiles: ["sRGB IEC61966-2.1"], status: "Normal" },
      pageCount: 3,
      parents: [
        { name: "A-Left", side: "left", transform: LEFT_TRANSFORM },
        { name: "B-Right", side: "right", transform: RIGHT_TRANSFORM },
      ],
      pdf: { colourSpaces: ["rgb"], exportSettings: { "Compatibility": "Acrobat 7", "Include Bleed": "9" }, minImagePpi: 250, trim: [TRIM.width, TRIM.height] },
      preflightProfile: "[Basic]",
      requiredFields: ["folio"],
      requiredFonts: [],
      styles: { character: ["Emoji"], object: ["Art Frame"], paragraph: ["Bestie Body"], parent: ["A-Left", "B-Right"] },
      tolerance: 0.01,
    },
    dir,
    native: {
      art: [{ id: "art-1", path: art, sha256: sha256("art bytes") }],
      book: "Bestie",
      exportSettings: { "Compatibility": "Acrobat 7", "Include Bleed": "9" },
      fonts: [{ installed: true, name: "Avenir Next" }],
      links: [{ effectivePpi: 300, expectedSha256: sha256("art bytes"), id: "art-1", page: 2, path: art, profile: "sRGB IEC61966-2.1", sha256: sha256("art bytes"), status: "Normal" }],
      native: { path: native, sha256: sha256("native bytes") },
      pageCount: 3,
      pages,
      template: { path: template, sha256: sha256("template bytes") },
      pdf: { path: pdfPath, sha256: fileSha(pdfPath) },
      preflight: { enabled: ["Overset text"], profile: "[Basic]", scope: "All pages" },
      revision: "r1",
      sourceRevision: sourceRepository(dir, "# Note\n\nH\n"),
      stories: [{ expected: "H", hidden: [], key: "p1:body", pages: [1], text: "H" }],
      styles: { character: ["Emoji"], object: ["Art Frame"], paragraph: ["Bestie Body"], parent: ["A-Left", "B-Right"] },
      unicode: [],
    },
    pdfPages,
    pdfPath,
    write: () => ({ contract: put(dir, "contract.json", fixture.contract), native: put(dir, "native.json", fixture.native) }),
  };
  return fixture;
}

/** Rewrites the PDF and rebinds its digest in the readback. */
export function rewritePdf(fixture: Fixture, pages: PdfPageSpec[]): void {
  writePdf(fixture.pdfPath, pages);
  fixture.native.pdf.sha256 = fileSha(fixture.pdfPath);
}
