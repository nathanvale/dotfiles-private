import type { BookContract, BookReadback, Edges } from "./book-input.ts";
import type { Box, PdfFacts } from "./book-pdf.ts";

const differs = (a: number, b: number, tolerance: number) => Math.abs(a - b) > tolerance;
const size = (box: Box): [number, number] => [box[2] - box[0], box[3] - box[1]];

function pageBoxIssues(pdf: PdfFacts, book: BookReadback, contract: BookContract): string[] {
  const [trimW, trimH] = contract.pdf.trim;
  return pdf.readback.flatMap((page) => {
    const { TrimBox, BleedBox } = page.boxes;
    if (TrimBox === undefined || BleedBox === undefined) return [`PDF page ${page.page} lacks a ${TrimBox === undefined ? "TrimBox" : "BleedBox"}.`];
    const issues: string[] = [];
    const [w, h] = size(TrimBox);
    if (differs(w, trimW, contract.tolerance) || differs(h, trimH, contract.tolerance)) issues.push(`PDF page ${page.page} trim is ${w}x${h}, not ${trimW}x${trimH}.`);
    const side = book.pages.find((p) => p.page === page.page)?.side ?? "right";
    const actual: Edges = {
      bottom: TrimBox[1] - BleedBox[1],
      inside: side === "right" ? TrimBox[0] - BleedBox[0] : BleedBox[2] - TrimBox[2],
      outside: side === "right" ? BleedBox[2] - TrimBox[2] : TrimBox[0] - BleedBox[0],
      top: BleedBox[3] - TrimBox[3],
    };
    for (const edge of ["top", "bottom", "outside", "inside"] as const) {
      if (differs(actual[edge], contract.bleed[edge], contract.tolerance)) issues.push(`PDF page ${page.page} ${edge} bleed is ${actual[edge]}, not ${contract.bleed[edge]}.`);
    }
    return issues;
  });
}

function fontIssues(pdf: PdfFacts, contract: BookContract): string[] {
  const unembedded = pdf.readback.flatMap((page) => page.fonts.filter((f) => !f.embedded).map((f) => `PDF page ${page.page} font ${f.name} is not embedded.`));
  const present = new Set(pdf.readback.flatMap((page) => page.fonts.map((f) => f.name.replace(/^[A-Z]{6}\+/, ""))));
  const missing = contract.requiredFonts.filter((name) => ![...present].some((p) => p.replace(/[\s-]/g, "") === name.replace(/[\s-]/g, ""))).map((name) => `required font ${name} is not in the PDF.`);
  return [...unembedded, ...missing];
}

function imageIssues(pdf: PdfFacts, contract: BookContract): string[] {
  const { colourSpaces, minImagePpi } = contract.pdf;
  return pdf.readback.flatMap((page) =>
    page.images.flatMap((image) => {
      const issues: string[] = [];
      if (!colourSpaces.includes(image.colour)) issues.push(`PDF page ${page.page} image colour space ${image.colour} is not one of ${colourSpaces.join(", ")}.`);
      if (minImagePpi !== undefined && Math.min(image.xPpi, image.yPpi) < minImagePpi) issues.push(`PDF page ${page.page} image is ${Math.min(image.xPpi, image.yPpi)} ppi, under ${minImagePpi}.`);
      return issues;
    }),
  );
}

function exportIssues(book: BookReadback, contract: BookContract): string[] {
  return Object.entries(contract.pdf.exportSettings).flatMap(([key, expected]) => {
    const actual = book.exportSettings[key];
    if (actual === undefined) return [`export setting ${key} was not read back.`];
    return actual === expected ? [] : [`export setting ${key} is "${actual}", not "${expected}".`];
  });
}

function squash(value: string): string {
  return value.replace(/\s+/g, "");
}

function textIssues(pdf: PdfFacts, book: BookReadback): string[] {
  return book.stories.flatMap((story) => {
    const rendered = squash(story.pages.map((p) => pdf.readback[p - 1]?.text ?? "").join(""));
    const missing = squash(story.expected).length > 0 && !rendered.includes(squash(story.expected));
    return missing ? [`story ${story.key} text is not all present in the exported PDF pages ${story.pages.join(",")}; text may be hidden or clipped.`] : [];
  });
}

/** Deterministic PDF-side findings; the PDF is bound by the caller's digest check. */
export function pdfFindings(pdf: PdfFacts, book: BookReadback, contract: BookContract): Record<string, string[]> {
  const pageParity = pdf.pages === book.pageCount ? [] : [`PDF has ${pdf.pages} pages; the native book has ${book.pageCount}.`];
  return {
    pdfBoxes: pageBoxIssues(pdf, book, contract),
    pdfExport: exportIssues(book, contract),
    pdfFonts: fontIssues(pdf, contract),
    pdfImages: imageIssues(pdf, contract),
    pdfPages: pageParity,
    pdfText: textIssues(pdf, book),
  };
}
