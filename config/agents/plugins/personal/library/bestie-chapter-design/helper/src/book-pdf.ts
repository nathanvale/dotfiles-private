import { readFileSync } from "node:fs";
import { InputError } from "./input.ts";

export type Box = [number, number, number, number];
export type PdfPage = {
  page: number;
  boxes: Partial<Record<"MediaBox" | "TrimBox" | "BleedBox" | "CropBox", Box>>;
  fonts: { name: string; type: string; embedded: boolean }[];
  images: { colour: string; xPpi: number; yPpi: number }[];
  text: string;
};
export type ContentColours = { rgb: number; cmyk: number; gray: number };
export type PdfFacts = { pages: number; version: string; tagged: boolean; producer: string; contentColours: ContentColours; readback: PdfPage[] };

function tool(name: string, args: string[]): string {
  if (Bun.which(name) === null) throw new InputError(`${name} (poppler) is not installed; PDF facts cannot be read.`);
  const run = Bun.spawnSync([name, ...args], { stderr: "pipe", stdin: "ignore", stdout: "pipe" });
  if (run.exitCode !== 0) throw new InputError(`${name} could not read the PDF: ${run.stderr.toString().trim()}`);
  return run.stdout.toString();
}

function parseBoxes(info: string): Map<number, PdfPage["boxes"]> {
  const out = new Map<number, PdfPage["boxes"]>();
  for (const match of info.matchAll(/^Page\s+(\d+)\s+(MediaBox|TrimBox|BleedBox|CropBox):\s+(.+)$/gm)) {
    const values = (match[3] ?? "").trim().split(/\s+/).map(Number);
    if (values.length !== 4 || values.some((v) => !Number.isFinite(v))) continue;
    const page = Number(match[1]);
    out.set(page, { ...out.get(page), [match[2] as "MediaBox"]: values as Box });
  }
  return out;
}

function parseFonts(listing: string): PdfPage["fonts"] {
  return listing
    .split("\n")
    .slice(2)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const cells = line.trim().split(/\s+/);
      const emb = cells.findIndex((c, i) => i >= 2 && (c === "yes" || c === "no"));
      return { embedded: cells[emb] === "yes", name: cells[0] ?? "", type: cells.slice(1, Math.max(emb - 1, 2)).join(" ") };
    });
}

function parseImages(listing: string): Map<number, PdfPage["images"]> {
  const out = new Map<number, PdfPage["images"]>();
  for (const line of listing.split("\n").slice(2)) {
    const cells = line.trim().split(/\s+/);
    if (cells.length < 14) continue;
    const page = Number(cells[0]);
    out.set(page, [...(out.get(page) ?? []), { colour: cells[5] ?? "", xPpi: Number(cells[12]), yPpi: Number(cells[13]) }]);
  }
  return out;
}

function header(info: string, name: string): string {
  return new RegExp(`^${name}:\\s*(.*)$`, "m").exec(info)?.[1]?.trim() ?? "";
}

const CONTENT_MARK = /(?:^|\s)(?:BT|cm|re|Do|f|S|m)(?:\s|$)/;
const NUMBER = "-?\\d*\\.?\\d+";

function colourOperators(content: string): ContentColours {
  const count = (operands: number, ops: string) => content.match(new RegExp(`(?:^|\\s)(?:${NUMBER}\\s+){${operands}}(?:${ops})(?=\\s|$)`, "g"))?.length ?? 0;
  return { cmyk: count(4, "k|K"), gray: count(1, "g|G"), rgb: count(3, "rg|RG") };
}

function decoded(bytes: Buffer): string {
  try {
    return Buffer.from(Bun.inflateSync(new Uint8Array(bytes))).toString("latin1");
  } catch {
    return bytes.toString("latin1");
  }
}

/**
 * Counts device colour operators in every content-like stream of the file.
 * Poppler lists only images, so text and vector ink would otherwise go unread.
 * The count is document-wide, not per page; ICC-based operators (sc, scn) are not resolved.
 */
function readContentColours(path: string): ContentColours {
  const file = readFileSync(path);
  const total: ContentColours = { cmyk: 0, gray: 0, rgb: 0 };
  let from = 0;
  for (;;) {
    const open = file.indexOf("stream", from, "latin1");
    if (open < 0) return total;
    const close = file.indexOf("endstream", open + 6, "latin1");
    if (close < 0) return total;
    from = close + 9;
    if (file.subarray(open - 3, open).toString("latin1") === "end") continue;
    const start = file.subarray(open + 6, open + 8).toString("latin1").startsWith("\r\n") ? open + 8 : open + 7;
    const content = decoded(file.subarray(start, close));
    if (!CONTENT_MARK.test(content)) continue;
    const found = colourOperators(content);
    total.cmyk += found.cmyk;
    total.gray += found.gray;
    total.rgb += found.rgb;
  }
}

/** Reads page count, boxes, fonts, image colour/PPI and text via poppler. */
export function readPdf(path: string): PdfFacts {
  const first = tool("pdfinfo", [path]);
  const pages = Number(header(first, "Pages"));
  if (!Number.isInteger(pages) || pages < 1) throw new InputError(`${path} has no readable page count.`);
  const boxes = parseBoxes(tool("pdfinfo", ["-box", "-f", "1", "-l", String(pages), path]));
  const images = parseImages(tool("pdfimages", ["-list", "-f", "1", "-l", String(pages), path]));
  const readback = Array.from({ length: pages }, (_, i) => {
    const page = i + 1;
    const range = ["-f", String(page), "-l", String(page)];
    return {
      boxes: boxes.get(page) ?? {},
      fonts: parseFonts(tool("pdffonts", [...range, path])),
      images: images.get(page) ?? [],
      page,
      text: tool("pdftotext", [...range, "-layout", path, "-"]),
    };
  });
  return { contentColours: readContentColours(path), pages, producer: header(first, "Producer"), readback, tagged: header(first, "Tagged") === "yes", version: header(first, "PDF version") };
}
