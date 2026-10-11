import { readFileSync } from "node:fs";
import { type CheckResult, verdict } from "./check-result.ts";
import { placementUnits, readResolution, wordCount } from "./copy.ts";
import {
  flag,
  integer,
  type JsonRecord,
  list,
  oneOf,
  optional,
  readJson,
  record,
  sha256File,
  sha256Text,
  text,
} from "./input.ts";
import { nativeParagraphs, readStories } from "./story.ts";

const PREVIEW_STATES = ["none", "queued", "opened", "viewed"] as const;
const COPY_STANDINGS = ["placed", "pending-placement"] as const;
const EXTENTS = ["whole-message", "excerpt"] as const;

type PreviewState = (typeof PREVIEW_STATES)[number];

function fileIdentity(value: unknown, where: string) {
  const item = record(value, where);
  return { path: text(item.path, `${where}.path`), sha256: text(item.sha256, `${where}.sha256`) };
}

function hashIssues(label: string, file: { path: string; sha256: string }): string[] {
  const actual = sha256File(file.path);
  if (actual === null) return [`${label} ${file.path} is missing.`];
  return actual === file.sha256 ? [] : [`${label} ${file.path} is ${actual}, not ${file.sha256}.`];
}

/** Counts page objects; zero means the PDF page tree could not be read. */
function pdfPages(path: string): number {
  const raw = readFileSync(path).toString("latin1");
  return raw.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
}

function pageIssues(pdf: string, declared: number): string[] {
  if (sha256File(pdf) === null) return [];
  const counted = pdfPages(pdf);
  if (counted === 0) return [`PDF page count could not be read from ${pdf}.`];
  return counted === declared ? [] : [`handback reports ${declared} pages; the PDF has ${counted}.`];
}

function copyStandings(root: JsonRecord, where: string) {
  const units = placementUnits(readResolution(text(root.copyResolution, `${where}.copyResolution`)));
  const stories = readStories(text(root.nativeStories, `${where}.nativeStories`));
  return list(root.copy, `${where}.copy`).map((entry, index) => {
    const item = record(entry, `${where}.copy[${index}]`);
    const role = text(item.role, `${where}.copy[${index}].role`);
    const label = text(item.storyLabel, `${where}.copy[${index}].storyLabel`);
    const declared = oneOf(item.standing, COPY_STANDINGS, `${where}.copy[${index}].standing`);
    const unit = units.find((u) => u.role === role);
    const native = stories.find((s) => s.label === label);
    const nativeText = native ? nativeParagraphs(native.text).join("\n\n") : null;
    return { declared, label, nativeText, role, unit };
  });
}

type Standing = ReturnType<typeof copyStandings>[number];

function copyIssues(rows: Standing[]): string[] {
  return rows.flatMap((row) => {
    if (row.unit === undefined) return [`copy role ${row.role} is not in the copy resolution.`];
    if (row.nativeText === null) return [`native story "${row.label}" is not in the story readback.`];
    const placed = row.nativeText === row.unit.text;
    if (row.declared === "placed" && !placed) {
      return [
        `${row.role} is reported placed, but native "${row.label}" (${wordCount(row.nativeText)} words) differs from the selected manuscript (${row.unit.words} words).`,
      ];
    }
    if (row.declared === "pending-placement" && placed) {
      return [`${row.role} is reported pending, but native "${row.label}" already equals the selected manuscript.`];
    }
    return [];
  });
}

function provenPreview(preview: JsonRecord): PreviewState {
  if (typeof preview.viewedEvidence === "string" && preview.viewedEvidence.trim()) return "viewed";
  if (typeof preview.openedAt === "string" && preview.openedAt.trim()) return "opened";
  if (typeof preview.queuedAt === "string" && preview.queuedAt.trim()) return "queued";
  return "none";
}

function previewIssues(preview: JsonRecord, where: string): string[] {
  const declared = oneOf(preview.state, PREVIEW_STATES, `${where}.preview.state`);
  const proven = provenPreview(preview);
  return declared === proven
    ? []
    : [`preview is reported ${declared}, but its evidence proves only ${proven}.`];
}

function beatIssues(beats: JsonRecord, where: string): string[] {
  const selected = list(beats.selected, `${where}.writingBeats.selected`).map((entry, i) => {
    const item = record(entry, `${where}.writingBeats.selected[${i}]`);
    text(item.answer, `${where}.writingBeats.selected[${i}].answer`);
    text(item.evidence, `${where}.writingBeats.selected[${i}].evidence`);
    return text(item.question, `${where}.writingBeats.selected[${i}].question`);
  });
  const open = list(beats.open, `${where}.writingBeats.open`).map((entry, i) =>
    text(record(entry, `${where}.writingBeats.open[${i}]`).question, `${where}.writingBeats.open[${i}].question`),
  );
  return open
    .filter((question) => selected.includes(question))
    .map((question) => `Writing Beats question "${question}" is both selected and open; carry the selected answer forward.`);
}

function extentIssues(root: JsonRecord, where: string, pageCount: number): string[] {
  return list(root.sourceExtents, `${where}.sourceExtents`).flatMap((entry, i) => {
    const item = record(entry, `${where}.sourceExtents[${i}]`);
    const key = text(item.key, `${where}.sourceExtents[${i}].key`);
    oneOf(item.extent, EXTENTS, `${where}.sourceExtents[${i}].extent`);
    const page = integer(item.page, `${where}.sourceExtents[${i}].page`);
    return page >= 1 && page <= pageCount ? [] : [`source ${key} is on page ${page}, outside 1-${pageCount}.`];
  });
}

function summary(root: JsonRecord, rows: Standing[], ui: JsonRecord, pageCount: number) {
  return {
    chapter: root.chapter,
    copy: rows.map((row) => ({
      manuscriptSha256: row.unit?.sha256 ?? null,
      manuscriptWords: row.unit?.words ?? null,
      nativeSha256: row.nativeText === null ? null : sha256Text(row.nativeText),
      nativeWords: row.nativeText === null ? null : wordCount(row.nativeText),
      role: row.role,
      standing: row.declared,
    })),
    native: root.native,
    nextAction: root.nextAction,
    pageCount,
    pdf: root.pdf,
    revision: root.revision,
    ui,
  };
}

export function checkHandback(path: string): CheckResult {
  const root = record(readJson(path), path);
  text(root.chapter, `${path}.chapter`);
  text(root.revision, `${path}.revision`);
  text(root.nextAction, `${path}.nextAction`);
  const native = fileIdentity(root.native, `${path}.native`);
  const pdf = fileIdentity(root.pdf, `${path}.pdf`);
  const pageCount = integer(root.pageCount, `${path}.pageCount`);
  const ui = record(root.ui, `${path}.ui`);
  text(ui.owner, `${path}.ui.owner`);
  flag(ui.released, `${path}.ui.released`);
  const rows = copyStandings(root, path);
  const preview = optional(root.preview, (v) => record(v, `${path}.preview`)) ?? { state: "none" };
  const issues = [
    ...hashIssues("native", native),
    ...hashIssues("PDF", pdf),
    ...pageIssues(pdf.path, pageCount),
    ...copyIssues(rows),
    ...previewIssues(preview, path),
    ...beatIssues(record(root.writingBeats, `${path}.writingBeats`), path),
    ...extentIssues(root, path, pageCount),
  ];
  return verdict(
    issues,
    summary(root, rows, ui, pageCount),
    "Handback identities, page count and standings match the evidence.",
    "Handback claims exceed or contradict the evidence.",
    "Correct the handback to the standing the evidence proves, then rerun handback before reporting.",
  );
}
