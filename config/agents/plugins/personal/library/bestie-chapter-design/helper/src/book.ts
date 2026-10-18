import { type CheckResult, verdict } from "./check-result.ts";
import { type BookContract, type BookReadback, readBookContract, readBookReadback } from "./book-input.ts";
import { nativeFindings } from "./book-native.ts";
import { type PdfFacts, readPdf } from "./book-pdf.ts";
import { pdfFindings } from "./book-pdf-checks.ts";
import { InputError, sha256File } from "./input.ts";

/** Reviews no helper can pass; always open on a deterministic pass. */
const HUMAN_REVIEW = [
  { id: "full-size-visual", scope: "Every exported page at full size: rhythm, clipping, difficult text, emoji and art at useful scale." },
  { id: "privacy", scope: "Names, messages, faces and metadata in the PDF and native file against the selected privacy limits." },
  { id: "accessibility", scope: "Tagged structure, reading order, alternate text, contrast and a PDF accessibility checker report; not assessed unless an accessible PDF was requested." },
] as const;

/** Qualifications this helper never grants. */
const NOT_QUALIFIED = ["native-execution", "visual-acceptance", "print-qualification", "pdf-x-conformance", "output-intent-and-profile-embedding"] as const;

function manifest(book: BookReadback, pdf: PdfFacts) {
  return {
    art: book.art,
    book: book.book,
    exportSettings: book.exportSettings,
    native: book.native,
    pageCount: book.pageCount,
    pages: book.pages.map((page) => {
      const facts = pdf.readback[page.page - 1];
      return {
        bleed: page.bleed,
        fields: page.fields,
        items: page.items.map((item) => ({ kind: item.kind, label: item.label, overrides: item.overrides.length, style: item.style })),
        links: book.links.filter((l) => l.page === page.page).map((l) => ({ effectivePpi: l.effectivePpi, id: l.id, profile: l.profile, status: l.status })),
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
    pdf: { ...book.pdf, pages: pdf.pages, producer: pdf.producer, tagged: pdf.tagged, version: pdf.version },
    preflight: book.preflight,
    revision: book.revision,
    sourceRevision: book.sourceRevision,
    stories: book.stories.map((s) => ({ key: s.key, pages: s.pages })),
    styles: book.styles,
  };
}

function sections(book: BookReadback, contract: BookContract, pdf: PdfFacts) {
  const native = nativeFindings(book, contract);
  return { review: native.review, sections: { ...native.sections, ...pdfFindings(pdf, book, contract) } };
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
      manifest: manifest(book, pdf),
      notQualified: NOT_QUALIFIED,
      reviewFlags: found.review,
    },
    "Whole-book deterministic evidence passes; full-size visual, privacy and accessibility review remain open and nothing is qualified.",
    "Whole-book evidence has deterministic failures.",
    "Repair the listed findings in a separately versioned candidate, re-export, rebind the readback and rerun book.",
    found.review,
  );
}
