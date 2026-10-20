import { afterEach, describe, expect, test } from "bun:test";
import { utimesSync } from "node:fs";
import { cleanup, production, put, run, scratch, sha256 } from "./fixtures.ts";

afterEach(cleanup);

type Gate = "review-pdf" | "accessible-digital-pdf" | "printer-pdf";
/** A handback record the tests edit freely; JSON.parse is the repository's untyped JSON. */
type Loose = ReturnType<typeof JSON.parse>;

const PDF =
  "%PDF-1.4\n1 0 obj << /Type /Pages >> endobj\n" +
  [2, 3, 4, 5].map((n) => `${n} 0 obj << /Type /Page >> endobj\n`).join("");

function handback(gate: Gate, change: (record: Loose, dir: string) => void = () => {}) {
  const dir = scratch();
  const native = { path: put(dir, "book.indd", "indd bytes"), sha256: sha256("indd bytes") };
  const pdf = { path: put(dir, "book.pdf", PDF), sha256: sha256(PDF) };
  const record: Loose = {
    chapter: "Bestie",
    copy: [],
    copyResolution: put(dir, "resolution.json", { blocks: [], chapter: "Bestie" }),
    native,
    nativeStories: put(dir, "stories.json", { stories: [] }),
    nextAction: "Nathan reviews the exact files.",
    pageCount: 4,
    pdf,
    revision: "r27",
    sourceExtents: [],
    ui: { owner: "foreground Desktop", released: true },
    writingBeats: { open: [], selected: [] },
    ...production(dir, gate, native, pdf, 4),
  };
  change(record, dir);
  return run("handback", "--record", put(dir, "handback.json", record));
}

function refusal(result: ReturnType<typeof run>): string {
  expect(result.exitCode).toBe(3);
  expect(result.envelope.result.causeCode).toBe("DOMAIN_CHECK_FAILED");
  return result.envelope.message;
}

describe("handback gates: review PDF, accessible digital PDF and printer PDF are distinct", () => {
  test.each(["review-pdf", "accessible-digital-pdf", "printer-pdf"] as const)(
    "passes a complete %s record without claiming print acceptance",
    (gate) => {
      const result = handback(gate);
      expect(result.exitCode).toBe(0);
      const data = result.envelope.result.data as { gate: string; printAccepted: boolean };
      expect(data.gate).toBe(gate);
      expect(data.printAccepted).toBe(false);
    },
  );

  test("refuses an unknown or missing gate", () => {
    expect(handback("review-pdf", (r) => delete r.gate).exitCode).toBe(4);
    expect(handback("review-pdf", (r) => (r.gate = "print")).exitCode).toBe(4);
  });

  test("a review may leave acceptance pending, but not claim acceptance without evidence", () => {
    expect(handback("review-pdf").exitCode).toBe(0);
    const message = refusal(handback("review-pdf", (r) => (r.acceptance.visual = { state: "accepted" })));
    expect(message).toContain("visual acceptance is recorded without evidence");
  });

  test("accessible gate needs tags, reading order, alt text and a checker report that matches disk", () => {
    const message = refusal(
      handback("accessible-digital-pdf", (r) => {
        r.accessibility.tagged = false;
        r.accessibility.checker.reportSha256 = sha256("other");
      }),
    );
    expect(message).toContain("accessibility tagged is not confirmed");
    expect(message).toContain("checker report on disk differs");
    expect(handback("accessible-digital-pdf", (r) => delete r.accessibility).exitCode).toBe(4);
  });
});

describe("handback custody, reopen, render and bindings", () => {
  test("refuses shared custody, a dirty document and a check older than the files", () => {
    const message = refusal(
      handback("review-pdf", (r) => {
        r.custody.soleWriter = false;
        r.custody.dirty = true;
        r.custody.checkedAt = "2000-01-01T00:00:00Z";
      }),
    );
    expect(message).toContain("not held by a sole writer");
    expect(message).toContain("unsaved edits");
    expect(message).toContain("custody check predates the native file");
  });

  test("refuses custody of a different document and a reopen of a different file", () => {
    const message = refusal(
      handback("review-pdf", (r) => {
        r.custody.documentPath = "/other.indd";
        r.reopen.nativeSha256 = sha256("elsewhere");
        r.reopen.overset = 2;
        r.reopen.linksNormal = false;
      }),
    );
    expect(message).toContain("custody checked /other.indd");
    expect(message).toContain("different native file");
    expect(message).toContain("overset");
    expect(message).toContain("not Normal");
  });

  test("needs two independent renderers over the exact PDF and every page", () => {
    const message = refusal(
      handback("review-pdf", (r) => {
        r.render = [{ pagesViewed: 2, pdfSha256: sha256("older"), renderer: "poppler" }];
      }),
    );
    expect(message).toContain("poppler rendered a different PDF");
    expect(message).toContain("poppler viewed 2 of 4 pages");
    expect(message).toContain("two independent renderers");
  });

  test("rehashes bound artwork and requires a source binding", () => {
    const message = refusal(
      handback("review-pdf", (r) => {
        r.art[0].sha256 = sha256("substituted");
        r.sources = [];
      }),
    );
    expect(message).toContain("artwork art-1");
    expect(message).toContain("no source binding");
  });

  test("refuses a custody check dated in the future", () => {
    const result = handback("review-pdf", (r) => (r.custody.checkedAt = "2099-01-01T00:00:00Z"));
    expect(refusal(result)).toContain("custody check is dated in the future");
  });

  test("a file saved after the custody check invalidates it", () => {
    const result = handback("review-pdf", (r) => {
      r.custody.checkedAt = "2026-10-20T00:00:00Z";
      const future = new Date("2026-10-21T00:00:00Z");
      utimesSync(r.native.path, future, future);
    });
    expect(refusal(result)).toContain("custody check predates the native file");
  });
});

describe("handback cases G01 to G08", () => {
  test("every case must be present once", () => {
    const message = refusal(
      handback("review-pdf", (r) => {
        r.cases = r.cases.filter((c: { id: string }) => c.id !== "G03");
        r.cases.push({ ...r.cases[0] });
      }),
    );
    expect(message).toContain("case G03 is missing");
    expect(message).toContain("case G01 is recorded twice");
  });

  test("failed and open cases stay visible on a review; a qualified case needs evidence", () => {
    const result = handback("review-pdf", (r) => {
      r.cases[0] = { evidence: "colour parity differs", id: "G01", state: "failed" };
      r.cases[2] = { evidence: "", id: "G03", state: "open" };
    });
    expect(result.exitCode).toBe(0);
    expect((result.envelope.result.data as { cases: object }).cases).toMatchObject({ G01: "failed", G03: "open" });
    const message = refusal(handback("review-pdf", (r) => (r.cases[1] = { evidence: "", id: "G02", state: "qualified" })));
    expect(message).toContain("case G02 is qualified without evidence");
  });

  test("printer-pdf refuses a failed or open case", () => {
    const message = refusal(
      handback("printer-pdf", (r) => {
        r.cases[0].state = "failed";
        r.cases[3].state = "open";
      }),
    );
    expect(message).toContain("case G01 failed");
    expect(message).toContain("case G04 is open");
  });
});

describe("handback printer-pdf gate", () => {
  test("refuses odd parity and a count outside the selected paper", () => {
    expect(refusal(handback("printer-pdf", (r) => (r.pageCount = 5)))).toContain("page count 5 is odd");
    expect(refusal(handback("printer-pdf", (r) => (r.printer.product.pageMax = 2)))).toContain("page count 4 is outside the paper's 2 to 2");
    expect(refusal(handback("printer-pdf", (r) => (r.printer.product.pageMin = 20)))).toContain("outside the paper's 20 to 240");
  });

  test("the superseded 140-page ceiling is not applied: only the paper maximum governs", () => {
    const message = refusal(
      handback("printer-pdf", (r) => {
        r.pageCount = 196;
        r.printer.boxes.pagesVerified = 196;
        r.reopen.pageCount = 196;
        for (const row of r.render) row.pagesViewed = 196;
      }),
    );
    // The fixture PDF still has four pages, so that is the only page-count issue.
    expect(message).toContain("handback reports 196 pages; the PDF has 4");
    expect(message).not.toContain("outside the paper");
    expect(message).not.toContain("odd");
  });

  test("refuses trim-only boxes and a partial box check", () => {
    const message = refusal(
      handback("printer-pdf", (r) => {
        r.printer.boxes = { bleedBox: [0, 0, 900, 765], mediaBox: [0, 0, 900, 765], pagesVerified: 3, trimBox: [0, 0, 900, 765] };
      }),
    );
    expect(message).toContain("MediaBox 0 0 900 765 is not the full bleed size 0 0 909 783");
    expect(message).toContain("page boxes were verified on 3 of 4 pages");
    const noBleed = refusal(handback("printer-pdf", (r) => (r.printer.boxes.bleedBox = [0, 9, 900, 774])));
    expect(noBleed).toContain("BleedBox equals TrimBox");
  });

  test("refuses a short trim box", () => {
    const message = refusal(handback("printer-pdf", (r) => (r.printer.boxes.trimBox = [0, 9, 880, 774])));
    expect(message).toContain("is not the full 900 x 765 trim");
  });

  test("refuses a non-Blurb product and missing selected product detail", () => {
    expect(refusal(handback("printer-pdf", (r) => (r.printer.product.vendor = "Lulu")))).toContain("selected Blurb product");
    expect(handback("printer-pdf", (r) => delete r.printer.product.paper).exitCode).toBe(4);
  });

  test("needs an output intent and a real PDF/X report run on this PDF, with no errors", () => {
    const message = refusal(
      handback("printer-pdf", (r) => {
        r.printer.colour.outputIntent = false;
        r.printer.colour.validator.errors = 3;
        r.printer.colour.validator.pdfSha256 = sha256("other pdf");
        r.printer.colour.validator.reportSha256 = sha256("forged");
      }),
    );
    expect(message).toContain("no output intent");
    expect(message).toContain("validator reports errors");
    expect(message).toContain("validated a different PDF");
    expect(message).toContain("report on disk differs");
    const missing = refusal(handback("printer-pdf", (r) => (r.printer.colour.validator.reportPath = "/missing/report.txt")));
    expect(missing).toContain("report /missing/report.txt is missing");
  });

  test("refuses a TrimBox outside the MediaBox or off the product bleed offsets", () => {
    const off = refusal(handback("printer-pdf", (r) => (r.printer.boxes.trimBox = [1000, 1000, 1900, 1765])));
    expect(off).toContain("not at the product's bleed offsets");
    const high = refusal(handback("printer-pdf", (r) => (r.printer.boxes.trimBox = [0, 0, 900, 765])));
    expect(high).toContain("not at the product's bleed offsets");
  });

  test("refuses a hash-matched PDF/X report whose text contradicts a pass of this PDF", () => {
    const sha = (r: Loose) => r.pdf.sha256;
    const bad = (body: (r: Loose) => string) => (r: Loose, dir: string) => {
      const text = body(r);
      r.printer.colour.validator.reportPath = put(dir, "bad.txt", text);
      r.printer.colour.validator.reportSha256 = sha256(text);
    };
    const failed = refusal(handback("printer-pdf", bad((r) => `book.pdf ${sha(r)}\nResult: FAIL\nError count: 17`)));
    expect(failed).toContain("plain pass");
    expect(failed).toContain("Error count: 0");
    const other = refusal(handback("printer-pdf", bad(() => `/old/export/book.pdf ${sha256("old")}\nResult: PASS\nError count: 0`)));
    expect(other).toContain("does not carry the handback PDF's SHA256");
    expect(other).toContain("names a different PDF digest");
    const mixed = refusal(handback("printer-pdf", bad((r) => `${sha(r)} ${sha256("old")}\nResult: PASS\nError count: 0`)));
    expect(mixed).toContain("names a different PDF digest");
    for (const line of ["Result: not compliant", "Result: PASS\nValidation successful: false", "Result: PASS\nResult: FAIL", "Result: PASS but not valid"]) {
      expect(refusal(handback("printer-pdf", bad((r) => `${sha(r)}\n${line}\nError count: 0`)))).toContain("PDF/X report");
    }
    expect(refusal(handback("printer-pdf", bad((r) => `${sha(r)}\nResult: PASS`)))).toContain("Error count: 0");
    expect(refusal(handback("printer-pdf", bad((r) => `${sha(r)}\nError count: 0`)))).toContain("plain pass");
    expect(refusal(handback("printer-pdf", (r) => (r.printer.colour.validator.standard = "none")))).toContain("not a PDF/X standard");
  });

  test("refuses low link PPI without accepted exceptions, and unembedded fonts", () => {
    const low = refusal(
      handback("printer-pdf", (r) => {
        r.printer.linkPpi = { belowRequired: [], minimumObserved: 145.5, required: 250 };
        r.printer.fonts.notEmbedded = ["Apple Color Emoji"];
      }),
    );
    expect(low).toContain("link PPI 145.5 is below the required 250");
    expect(low).toContain("fonts not embedded: Apple Color Emoji");
    const link = { id: "p34", ppi: 145.5 };
    const ppi = (belowRequired: object[]) => ({ belowRequired, minimumObserved: 145.5, required: 250 });
    const unaccepted = refusal(handback("printer-pdf", (r) => (r.printer.linkPpi = ppi([link]))));
    expect(unaccepted).toContain("lack Nathan's acceptance");
    const accepted = handback("printer-pdf", (r) => (r.printer.linkPpi = ppi([{ ...link, acceptance: "Nathan, 2026-10-20" }])));
    expect(accepted.exitCode).toBe(0);
  });

  test("needs visual, privacy and Nathan acceptance of these exact files", () => {
    const pending = refusal(
      handback("printer-pdf", (r) => {
        r.acceptance.visual = { state: "pending" };
        r.acceptance.privacy = { state: "pending" };
      }),
    );
    expect(pending).toContain("printer-pdf needs visual acceptance");
    expect(pending).toContain("printer-pdf needs privacy acceptance");
    const wrong = refusal(handback("printer-pdf", (r) => (r.acceptance.nathan.pdfSha256 = sha256("older pdf"))));
    expect(wrong).toContain("Nathan's acceptance names different files");
  });
});

describe("handback automation qualification", () => {
  const qualified = (dir: string, over: Loose = {}) => ({
    checkpoint: { path: put(dir, "checkpoint.indd", "saved"), sha256: sha256("saved") },
    operation: "Book synchronize",
    probe: "ran on a duplicate",
    rollback: "reopen checkpoint.indd",
    route: "existing-scripting",
    state: "qualified",
    ...over,
  });

  test("accepts a small reversible qualification for uxp or existing scripting", () => {
    const result = handback("review-pdf", (r, dir) => (r.automation = [qualified(dir), qualified(dir, { route: "uxp" })]));
    expect(result.exitCode).toBe(0);
  });

  test("refuses unqualified Book panel and third-party MCP use, and cannot qualify them here", () => {
    const used = refusal(
      handback("review-pdf", (r) => {
        r.automation = [
          { operation: "renumber", route: "book-panel", state: "unqualified" },
          { operation: "export", route: "third-party-mcp", state: "unqualified" },
        ];
      }),
    );
    expect(used).toContain("renumber used an unqualified book-panel route");
    expect(used).toContain("export used an unqualified third-party-mcp route");
    const claimed = refusal(handback("review-pdf", (r, dir) => (r.automation = [qualified(dir, { route: "book-panel" })])));
    expect(claimed).toContain("book-panel cannot be qualified");
  });

  test("a qualification needs its checkpoint on disk with the recorded digest, and a rollback", () => {
    const missing = refusal(handback("review-pdf", (r, dir) => (r.automation = [qualified(dir, { checkpoint: { path: "/none.indd", sha256: "x" } })])));
    expect(missing).toContain("checkpoint /none.indd is missing");
    const drift = refusal(
      handback("review-pdf", (r, dir) => (r.automation = [qualified(dir, { checkpoint: { path: put(dir, "c.indd", "a"), sha256: sha256("b") } })])),
    );
    expect(drift).toContain("differs from its recorded digest");
    expect(handback("review-pdf", (r, dir) => (r.automation = [qualified(dir, { rollback: "" })])).exitCode).toBe(4);
  });
});
