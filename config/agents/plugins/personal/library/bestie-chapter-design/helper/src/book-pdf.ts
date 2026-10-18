import { InputError } from "./input.ts";

export type Box = [number, number, number, number];
export type PdfPage = {
  page: number;
  boxes: Partial<Record<"MediaBox" | "TrimBox" | "BleedBox" | "CropBox", Box>>;
  fonts: { name: string; type: string; embedded: boolean }[];
  images: { colour: string; xPpi: number; yPpi: number }[];
  text: string;
};
export type PdfFacts = { pages: number; version: string; tagged: boolean; producer: string; readback: PdfPage[] };

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
  return { pages, producer: header(first, "Producer"), readback, tagged: header(first, "Tagged") === "yes", version: header(first, "PDF version") };
}
