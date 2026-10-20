import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const roots: string[] = [];

export type Run = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  envelope: {
    message: string;
    result: {
      causeCode: string;
      commandIdentity: string;
      outcome: string;
      exitCode: number;
      data: unknown;
      retryable: boolean;
      retryDelayMilliseconds?: number;
    };
  };
};

/** Runs the public entry point; set BESTIE_CHECK_ENTRY to exercise a bundle. */
export function run(...args: string[]): Run {
  const entry = process.env.BESTIE_CHECK_ENTRY ?? join(ROOT, "src/cli.ts");
  const result = Bun.spawnSync([process.execPath, "run", entry, ...args, "--json"], {
    cwd: ROOT,
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  const stdout = result.stdout.toString();
  return {
    envelope: JSON.parse(stdout),
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout,
  };
}

export function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "bestie-chapter-check-"));
  roots.push(dir);
  return dir;
}

export function cleanup(): void {
  for (const dir of roots.splice(0)) rmSync(dir, { force: true, recursive: true });
}

export function put(dir: string, name: string, content: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function git(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stderr: "pipe", stdout: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

/** A one-commit repository standing in for the source vault. */
export function sourceRepository(dir: string): { repository: string; commit: string } {
  const repository = join(dir, "vault");
  Bun.spawnSync(["mkdir", "-p", repository]);
  git(repository, "init", "-q");
  writeFileSync(join(repository, "note.md"), "# Note\n");
  git(repository, "add", "note.md");
  git(repository, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "seed");
  return { commit: git(repository, "rev-parse", "HEAD"), repository };
}

const CASE_IDS = ["G01", "G02", "G03", "G04", "G05", "G06", "G07", "G08"];

/** Production evidence for one gate that satisfies the handback check; tests override one part. */
export function production(
  dir: string,
  gate: "review-pdf" | "accessible-digital-pdf" | "printer-pdf",
  native: { path: string; sha256: string },
  pdf: { sha256: string },
  pageCount: number,
): Record<string, unknown> {
  const state = gate === "printer-pdf" ? "qualified" : "open";
  const accepted = gate === "printer-pdf";
  const decision = (evidence: string) =>
    accepted ? { evidence, nativeSha256: native.sha256, pdfSha256: pdf.sha256, state: "accepted" } : { state: "pending" };
  const art = put(dir, "art.png", "art bytes");
  const report = put(dir, "validator.txt", "PDF/X-4 report: 0 errors");
  const a11y = put(dir, "a11y.txt", "checker report");
  const base: Record<string, unknown> = {
    acceptance: { nathan: decision("exact files, 2026-10-20"), privacy: decision("privacy read"), visual: decision("pages viewed") },
    art: [{ id: "art-1", path: art, sha256: sha256("art bytes") }],
    cases: CASE_IDS.map((id) => ({ evidence: state === "qualified" ? `${id} evidence` : "", id, state })),
    custody: { checkedAt: "2099-01-01T00:00:00Z", documentPath: native.path, dirty: false, soleWriter: true, writer: "foreground Desktop" },
    gate,
    render: [
      { pagesViewed: pageCount, pdfSha256: pdf.sha256, renderer: "poppler" },
      { pagesViewed: pageCount, pdfSha256: pdf.sha256, renderer: "quartz" },
    ],
    reopen: { linksNormal: true, nativeSha256: native.sha256, overset: 0, pageCount },
    sources: [{ commit: "e783b22", owner: "chapter-copy-proposals.md", sha256: sha256("source") }],
  };
  if (gate === "accessible-digital-pdf") {
    base.accessibility = {
      altTextChecked: true,
      checker: { name: "Acrobat", reportPath: a11y, reportSha256: sha256("checker report") },
      language: "en-AU",
      readingOrderChecked: true,
      tagged: true,
      title: "Bestie",
    };
  }
  if (gate === "printer-pdf") {
    base.printer = {
      boxes: { bleedBox: [0, 0, 909, 783], mediaBox: [0, 0, 909, 783], pagesVerified: pageCount, trimBox: [0, 9, 900, 774] },
      colour: {
        destinationProfile: "Blurb ICC",
        outputIntent: true,
        validator: { errors: 0, exactPdf: true, name: "preflight", reportPath: report, reportSha256: sha256("PDF/X-4 report: 0 errors"), standard: "PDF/X-4" },
      },
      fonts: { notEmbedded: [] },
      linkPpi: { belowRequired: [], minimumObserved: 300, required: 250 },
      product: {
        bleed: { bottom: 9, inside: 0, outside: 9, top: 9 },
        name: "Large Landscape Photo Book",
        pageMax: 240,
        pageMin: 2,
        paper: "Premium Matte 148gsm",
        specSource: "https://support.blurb.com/",
        trim: [900, 765],
        vendor: "Blurb",
      },
    };
  }
  return base;
}
