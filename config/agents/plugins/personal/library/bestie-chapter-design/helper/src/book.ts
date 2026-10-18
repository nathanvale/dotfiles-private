import { type CheckResult, verdict } from "./check-result.ts";
import { type BookContract, type BookReadback, readBookContract, readBookReadback } from "./book-input.ts";
import { nativeFindings } from "./book-native.ts";
import { familyCoverage, templateFindings } from "./book-template.ts";
import { type PdfFacts, readPdf } from "./book-pdf.ts";
import { pdfFindings } from "./book-pdf-checks.ts";
import { InputError, sha256File, sha256Text } from "./input.ts";

/** Reviews no helper can pass; always open on a deterministic pass. */
const HUMAN_REVIEW = [
  { id: "full-size-visual", scope: "Every exported page at full size: rhythm, clipping, difficult text, emoji and art at useful scale." },
  { id: "privacy", scope: "Names, messages, faces and metadata in the PDF and native file against the selected privacy limits." },
  { id: "accessibility", scope: "Tagged structure, reading order, alternate text, contrast and a PDF accessibility checker report; not assessed unless an accessible PDF was requested." },
] as const;

/** Qualifications this helper never grants. */
const NOT_QUALIFIED = ["native-execution", "visual-acceptance", "print-qualification", "pdf-x-conformance", "output-intent-and-profile-embedding"] as const;

function manifest(book: BookReadback, contract: BookContract, pdf: PdfFacts, inputs: Record<string, { path: string; sha256: string | null }>) {
  return {
    inputs,
    art: book.art,
    book: book.book,
    coverage: familyCoverage(contract),
    exportSettings: book.exportSettings,
    native: book.native,
    pageCount: book.pageCount,
    pages: book.pages.map((page) => {
      const facts = pdf.readback[page.page - 1];
      return {
        bleed: page.bleed,
        columns: page.columns,
        family: page.family,
        margins: page.margins,
        fields: page.fields,
        items: page.items.map((item) => ({ bounds: item.bounds, kind: item.kind, label: item.label, overrides: item.overrides, style: item.style })),
        links: book.links.filter((l) => l.page === page.page).map((l) => ({ ...l, diskSha256: sha256File(l.path) })),
        page: page.page,
        parent: page.parent,
        pdf: facts && {
          boxes: facts.boxes,
          fonts: facts.fonts,
          images: facts.images,
        },
        side: page.side,
      };
    }),
    pdf: { ...book.pdf, contentColours: pdf.contentColours, pages: pdf.pages, producer: pdf.producer, tagged: pdf.tagged, version: pdf.version },
    preflight: book.preflight,
    revision: book.revision,
    sourceRevision: book.sourceRevision,
    template: book.template,
    fonts: book.fonts,
    unicode: book.unicode,
    stories: book.stories.map((s) => ({ hidden: s.hidden, key: s.key, oversetSha256: sha256Text(s.oversetText), pages: s.pages, sourceSha256: sha256Text(s.expected), textSha256: sha256Text(s.text) })),
    styles: book.styles,
  };
}

function sections(book: BookReadback, contract: BookContract, pdf: PdfFacts) {
  const native = nativeFindings(book, contract);
  return { sections: { ...native.sections, ...templateFindings(book, contract), ...pdfFindings(pdf, book, contract) } };
}

function pdfOrRefusal(book: BookReadback): PdfFacts | string {
  const actual = sha256File(book.pdf.path);
  if (actual === null || actual !== book.pdf.sha256) return `PDF ${book.pdf.path} does not match its bound digest; PDF facts were not read.`;
  try {
    return readPdf(book.pdf.path);
  } catch (error) {
    if (error instanceof InputError) return error.message;
    throw error;
  }
}

export function checkBook(nativePath: string, contractPath: string): CheckResult {
  const book = readBookReadback(nativePath);
  const contract = readBookContract(contractPath);
  const pdf = pdfOrRefusal(book);
  if (typeof pdf === "string") {
    return verdict([pdf], null, "", "Whole-book evidence could not be completed.", "Bind the exported PDF by its digest and install poppler, then rerun book.");
  }
  const found = sections(book, contract, pdf);
  const issues = Object.entries(found.sections).flatMap(([name, list]) => list.map((issue) => `[${name}] ${issue}`));
  return verdict(
    issues,
    {
      deterministic: Object.fromEntries(Object.entries(found.sections).map(([name, list]) => [name, { issues: list.length, status: "pass" }])),
      humanReview: HUMAN_REVIEW.map((item) => ({ ...item, status: "open" })),
      manifest: manifest(book, contract, pdf, { contract: { path: contractPath, sha256: sha256File(contractPath) }, native: { path: nativePath, sha256: sha256File(nativePath) } }),
      notQualified: NOT_QUALIFIED,
    },
    "Whole-book deterministic evidence passes; full-size visual, privacy and accessibility review remain open and nothing is qualified.",
    "Whole-book evidence has deterministic failures.",
    "Repair the listed findings in a separately versioned candidate, re-export, rebind the readback and rerun book.",
  );
}
