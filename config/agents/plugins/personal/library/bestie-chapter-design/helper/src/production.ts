import { statSync } from "node:fs";
import {
  anyText,
  flag,
  InputError,
  integer,
  type JsonRecord,
  list,
  numeric,
  oneOf,
  optional,
  record,
  sha256File,
  text,
} from "./input.ts";

const GATES = ["review-pdf", "accessible-digital-pdf", "printer-pdf"] as const;
type Gate = (typeof GATES)[number];

/** The eight qualification cases every handback carries; see production-checks.md. */
const CASES = ["G01", "G02", "G03", "G04", "G05", "G06", "G07", "G08"] as const;
const CASE_STATES = ["failed", "open", "qualified"] as const;
const ACCEPTANCE_STATES = ["pending", "accepted"] as const;
const ROUTES = ["uxp", "existing-scripting", "book-panel", "third-party-mcp"] as const;
const QUALIFIABLE_ROUTES: readonly string[] = ["uxp", "existing-scripting"];

export type Identity = { path: string; sha256: string };

function instant(value: unknown, where: string): number {
  const stamp = Date.parse(text(value, where));
  if (Number.isNaN(stamp)) throw new InputError(`${where} must be an ISO time.`);
  return stamp;
}

function mtime(path: string): number {
  return statSync(path).mtimeMs;
}

function exists(file: Identity): boolean {
  return sha256File(file.path) !== null;
}

/** Sole native-writer custody, with document and dirty-state checks no older than the files. */
function custodyIssues(root: JsonRecord, native: Identity, pdf: Identity, where: string): string[] {
  const custody = record(root.custody, `${where}.custody`);
  const issues: string[] = [];
  if (!flag(custody.soleWriter, `${where}.custody.soleWriter`)) {
    issues.push("native custody is not held by a sole writer.");
  }
  text(custody.writer, `${where}.custody.writer`);
  if (text(custody.documentPath, `${where}.custody.documentPath`) !== native.path) {
    issues.push(`custody checked ${custody.documentPath}, not the handback native ${native.path}.`);
  }
  if (flag(custody.dirty, `${where}.custody.dirty`)) issues.push("the native document has unsaved edits (dirty).");
  const checked = instant(custody.checkedAt, `${where}.custody.checkedAt`);
  for (const [label, file] of [["native", native], ["PDF", pdf]] as const) {
    if (exists(file) && mtime(file.path) > checked) {
      issues.push(`custody check predates the ${label} file; recheck the document and dirty state.`);
    }
  }
  return issues;
}

/** Saved and reopened readback must describe the very native file handed back. */
function reopenIssues(root: JsonRecord, native: Identity, pageCount: number, where: string): string[] {
  const reopen = record(root.reopen, `${where}.reopen`);
  const issues: string[] = [];
  if (text(reopen.nativeSha256, `${where}.reopen.nativeSha256`) !== native.sha256) {
    issues.push("reopened readback is of a different native file than the handback.");
  }
  if (integer(reopen.pageCount, `${where}.reopen.pageCount`) !== pageCount) {
    issues.push(`reopened readback has ${reopen.pageCount} pages; the handback reports ${pageCount}.`);
  }
  if (integer(reopen.overset, `${where}.reopen.overset`) !== 0) issues.push("reopened candidate has overset text.");
  if (!flag(reopen.linksNormal, `${where}.reopen.linksNormal`)) issues.push("reopened candidate has links that are not Normal.");
  return issues;
}

/** Two independent renderers, each viewing every page of the handback PDF. */
function renderIssues(root: JsonRecord, pdf: Identity, pageCount: number, where: string): string[] {
  const rows = list(root.render, `${where}.render`).map((entry, i) => {
    const item = record(entry, `${where}.render[${i}]`);
    return {
      pages: integer(item.pagesViewed, `${where}.render[${i}].pagesViewed`),
      pdf: text(item.pdfSha256, `${where}.render[${i}].pdfSha256`),
      renderer: text(item.renderer, `${where}.render[${i}].renderer`),
    };
  });
  const issues = rows.flatMap((row) => [
    ...(row.pdf === pdf.sha256 ? [] : [`${row.renderer} rendered a different PDF than the handback.`]),
    ...(row.pages === pageCount ? [] : [`${row.renderer} viewed ${row.pages} of ${pageCount} pages.`]),
  ]);
  if (new Set(rows.map((row) => row.renderer)).size < 2) issues.push("rendered evidence needs two independent renderers.");
  return issues;
}

/** Source and artwork bindings: every artwork file is rehashed on disk. */
function bindingIssues(root: JsonRecord, where: string): string[] {
  const sources = list(root.sources, `${where}.sources`);
  const art = list(root.art, `${where}.art`);
  for (const [i, entry] of sources.entries()) {
    const item = record(entry, `${where}.sources[${i}]`);
    text(item.owner, `${where}.sources[${i}].owner`);
    text(item.commit, `${where}.sources[${i}].commit`);
    text(item.sha256, `${where}.sources[${i}].sha256`);
  }
  const missing = sources.length === 0 ? ["no source binding is recorded."] : [];
  return art.flatMap((entry, i) => {
    const item = record(entry, `${where}.art[${i}]`);
    const id = text(item.id, `${where}.art[${i}].id`);
    const file = { path: text(item.path, `${where}.art[${i}].path`), sha256: text(item.sha256, `${where}.art[${i}].sha256`) };
    const actual = sha256File(file.path);
    if (actual === null) return [`artwork ${id} ${file.path} is missing.`];
    return actual === file.sha256 ? [] : [`artwork ${id} is ${actual}, not the bound ${file.sha256}.`];
  }).concat(missing);
}

/** Human visual and privacy acceptance, and Nathan's acceptance of the exact final files. */
function acceptanceIssues(root: JsonRecord, gate: Gate, native: Identity, pdf: Identity, where: string): string[] {
  const acceptance = record(root.acceptance, `${where}.acceptance`);
  const issues: string[] = [];
  const final = gate === "printer-pdf";
  for (const kind of ["visual", "privacy", "nathan"] as const) {
    const item = record(acceptance[kind], `${where}.acceptance.${kind}`);
    const state = oneOf(item.state, ACCEPTANCE_STATES, `${where}.acceptance.${kind}.state`);
    const evidence = optional(item.evidence, (v) => anyText(v, `${where}.acceptance.${kind}.evidence`)) ?? "";
    if (state === "accepted" && !evidence.trim()) issues.push(`${kind} acceptance is recorded without evidence.`);
    if (state === "pending" && final) issues.push(`printer-pdf needs ${kind} acceptance; it is pending.`);
    if (kind === "nathan" && state === "accepted") {
      if (item.nativeSha256 !== native.sha256 || item.pdfSha256 !== pdf.sha256) {
        issues.push("Nathan's acceptance names different files than the handback native and PDF.");
      }
    }
  }
  return issues;
}

function caseRow(entry: unknown, gate: Gate, where: string): { id: string; state: string; issues: string[] } {
  const item = record(entry, where);
  const id = oneOf(item.id, CASES, `${where}.id`);
  const state = oneOf(item.state, CASE_STATES, `${where}.state`);
  const evidence = optional(item.evidence, (v) => anyText(v, `${where}.evidence`)) ?? "";
  const issues: string[] = [];
  if (state === "qualified" && !evidence.trim()) issues.push(`case ${id} is qualified without evidence.`);
  if (gate === "printer-pdf" && state !== "qualified") {
    issues.push(state === "failed" ? `case ${id} failed; printer-pdf cannot proceed.` : `case ${id} is open; printer-pdf needs it qualified.`);
  }
  return { id, issues, state };
}

/** G01 to G08: every case present once; printer-pdf needs each one qualified with evidence. */
function caseIssues(root: JsonRecord, gate: Gate, where: string): { issues: string[]; cases: Record<string, string> } {
  const seen: Record<string, string> = {};
  const issues: string[] = [];
  for (const [i, entry] of list(root.cases, `${where}.cases`).entries()) {
    const row = caseRow(entry, gate, `${where}.cases[${i}]`);
    if (row.id in seen) issues.push(`case ${row.id} is recorded twice.`);
    seen[row.id] = row.state;
    issues.push(...row.issues);
  }
  for (const id of CASES) if (!(id in seen)) issues.push(`case ${id} is missing from the handback.`);
  return { cases: seen, issues };
}

type Box = [number, number, number, number];

function box(value: unknown, where: string): Box {
  const items = list(value, where);
  if (items.length !== 4) throw new InputError(`${where} must have 4 numbers.`);
  return items.map((item, i) => numeric(item, `${where}[${i}]`)) as Box;
}

const EDGE = 0.01;
const same = (a: Box, b: Box) => a.every((v, i) => Math.abs(v - (b[i] as number)) <= EDGE);

/** Product trim and per-side bleed (top, bottom, outside, inside) give the expected boxes. */
function boxIssues(printer: JsonRecord, pageCount: number, where: string): string[] {
  const product = record(printer.product, `${where}.printer.product`);
  const trim = list(product.trim, `${where}.printer.product.trim`).map((v, i) => numeric(v, `${where}.printer.product.trim[${i}]`));
  const bleed = record(product.bleed, `${where}.printer.product.bleed`);
  const side = (key: string) => numeric(bleed[key], `${where}.printer.product.bleed.${key}`);
  const [width, height] = trim as [number, number];
  const issues: string[] = [];
  const boxes = record(printer.boxes, `${where}.printer.boxes`);
  const media = box(boxes.mediaBox, `${where}.printer.boxes.mediaBox`);
  const trimBox = box(boxes.trimBox, `${where}.printer.boxes.trimBox`);
  const bleedBox = box(boxes.bleedBox, `${where}.printer.boxes.bleedBox`);
  const spread = side("outside") + side("inside");
  const expectedMedia: Box = [0, 0, width + spread, height + side("top") + side("bottom")];
  if (!same(media, expectedMedia)) issues.push(`MediaBox ${media.join(" ")} is not the full bleed size ${expectedMedia.join(" ")}.`);
  const inside = trimBox[2] - trimBox[0];
  const tall = trimBox[3] - trimBox[1];
  if (Math.abs(inside - width) > EDGE || Math.abs(tall - height) > EDGE) {
    issues.push(`TrimBox ${trimBox.join(" ")} is not the full ${width} x ${height} trim.`);
  }
  if (same(bleedBox, trimBox) && !same(trimBox, media)) {
    issues.push("BleedBox equals TrimBox; the export carries no bleed.");
  } else if (!same(bleedBox, media)) {
    issues.push(`BleedBox ${bleedBox.join(" ")} is not the product bleed ${media.join(" ")}.`);
  }
  const verified = integer(boxes.pagesVerified, `${where}.printer.boxes.pagesVerified`);
  if (verified !== pageCount) issues.push(`page boxes were verified on ${verified} of ${pageCount} pages.`);
  return issues;
}

/** Parity and the selected paper's own limits; there is no fixed project ceiling. */
function productIssues(printer: JsonRecord, pageCount: number, where: string): string[] {
  const product = record(printer.product, `${where}.printer.product`);
  for (const key of ["vendor", "name", "paper", "specSource"]) text(product[key], `${where}.printer.product.${key}`);
  if (text(product.vendor, `${where}.printer.product.vendor`) !== "Blurb") {
    return [`product vendor must be the selected Blurb product, not ${product.vendor}.`];
  }
  const min = integer(product.pageMin, `${where}.printer.product.pageMin`);
  const max = integer(product.pageMax, `${where}.printer.product.pageMax`);
  const issues = pageCount % 2 === 0 ? [] : [`page count ${pageCount} is odd.`];
  if (pageCount < min || pageCount > max) issues.push(`page count ${pageCount} is outside the paper's ${min} to ${max}.`);
  return [...issues, ...boxIssues(printer, pageCount, where)];
}

function validatorIssues(colour: JsonRecord, where: string): string[] {
  const issues: string[] = [];
  text(colour.destinationProfile, `${where}.printer.colour.destinationProfile`);
  if (!flag(colour.outputIntent, `${where}.printer.colour.outputIntent`)) issues.push("the PDF has no output intent.");
  const validator = record(colour.validator, `${where}.printer.colour.validator`);
  text(validator.name, `${where}.printer.colour.validator.name`);
  text(validator.standard, `${where}.printer.colour.validator.standard`);
  const report = text(validator.reportPath, `${where}.printer.colour.validator.reportPath`);
  const actual = sha256File(report);
  if (actual === null) issues.push(`PDF/X validator report ${report} is missing.`);
  else if (actual !== text(validator.reportSha256, `${where}.printer.colour.validator.reportSha256`)) {
    issues.push("PDF/X validator report on disk differs from the recorded digest.");
  }
  if (integer(validator.errors, `${where}.printer.colour.validator.errors`) !== 0) issues.push("PDF/X validator reports errors.");
  if (!flag(validator.exactPdf, `${where}.printer.colour.validator.exactPdf`)) issues.push("the PDF/X report was not run on the handback PDF.");
  return issues;
}

function imageFontIssues(printer: JsonRecord, where: string): string[] {
  const images = record(printer.linkPpi, `${where}.printer.linkPpi`);
  const issues: string[] = [];
  const required = numeric(images.required, `${where}.printer.linkPpi.required`);
  const observed = numeric(images.minimumObserved, `${where}.printer.linkPpi.minimumObserved`);
  if (observed < required) {
    const waived = list(images.belowRequired, `${where}.printer.linkPpi.belowRequired`);
    const unaccepted = waived.filter((w) => !String(record(w, `${where}.printer.linkPpi.belowRequired[]`).acceptance ?? "").trim());
    if (waived.length === 0) issues.push(`link PPI ${observed} is below the required ${required} and no link is listed.`);
    if (unaccepted.length) issues.push(`${unaccepted.length} link(s) below ${required} PPI lack Nathan's acceptance.`);
  }
  const fonts = record(printer.fonts, `${where}.printer.fonts`);
  const missing = list(fonts.notEmbedded, `${where}.printer.fonts.notEmbedded`);
  if (missing.length) issues.push(`fonts not embedded: ${missing.join(", ")}.`);
  return issues;
}

function printerIssues(root: JsonRecord, pageCount: number, where: string): string[] {
  const printer = record(root.printer, `${where}.printer`);
  return [
    ...productIssues(printer, pageCount, where),
    ...validatorIssues(record(printer.colour, `${where}.printer.colour`), where),
    ...imageFontIssues(printer, where),
  ];
}

function accessibleIssues(root: JsonRecord, where: string): string[] {
  const access = record(root.accessibility, `${where}.accessibility`);
  const issues: string[] = [];
  for (const key of ["tagged", "readingOrderChecked", "altTextChecked"]) {
    if (!flag(access[key], `${where}.accessibility.${key}`)) issues.push(`accessibility ${key} is not confirmed.`);
  }
  text(access.title, `${where}.accessibility.title`);
  text(access.language, `${where}.accessibility.language`);
  const checker = record(access.checker, `${where}.accessibility.checker`);
  text(checker.name, `${where}.accessibility.checker.name`);
  const report = text(checker.reportPath, `${where}.accessibility.checker.reportPath`);
  const actual = sha256File(report);
  if (actual === null) issues.push(`accessibility checker report ${report} is missing.`);
  else if (actual !== text(checker.reportSha256, `${where}.accessibility.checker.reportSha256`)) {
    issues.push("accessibility checker report on disk differs from the recorded digest.");
  }
  return issues;
}

/** Automation is a small reversible qualification, only for an operation that needs it. */
function automationIssues(root: JsonRecord, where: string): string[] {
  return list(root.automation ?? [], `${where}.automation`).flatMap((entry, i) => {
    const item = record(entry, `${where}.automation[${i}]`);
    const operation = text(item.operation, `${where}.automation[${i}].operation`);
    const route = oneOf(item.route, ROUTES, `${where}.automation[${i}].route`);
    const state = oneOf(item.state, ["qualified", "unqualified"] as const, `${where}.automation[${i}].state`);
    if (state === "unqualified") return [`${operation} used an unqualified ${route} route; do it by hand or qualify uxp or existing scripting first.`];
    if (!QUALIFIABLE_ROUTES.includes(route)) return [`${operation}: ${route} cannot be qualified by this skill.`];
    const checkpoint = record(item.checkpoint, `${where}.automation[${i}].checkpoint`);
    text(item.rollback, `${where}.automation[${i}].rollback`);
    text(item.probe, `${where}.automation[${i}].probe`);
    const actual = sha256File(text(checkpoint.path, `${where}.automation[${i}].checkpoint.path`));
    if (actual === null) return [`${operation} checkpoint ${checkpoint.path} is missing; it is the rollback.`];
    return actual === checkpoint.sha256 ? [] : [`${operation} checkpoint differs from its recorded digest.`];
  });
}

/** Evidence common to all three gates, then the gate's own branch. */
export function productionIssues(root: JsonRecord, native: Identity, pdf: Identity, pageCount: number, where: string) {
  const gate = oneOf(root.gate, GATES, `${where}.gate`);
  const cases = caseIssues(root, gate, where);
  const branch =
    gate === "printer-pdf" ? printerIssues(root, pageCount, where) : gate === "accessible-digital-pdf" ? accessibleIssues(root, where) : [];
  const issues = [
    ...custodyIssues(root, native, pdf, where),
    ...reopenIssues(root, native, pageCount, where),
    ...renderIssues(root, pdf, pageCount, where),
    ...bindingIssues(root, where),
    ...acceptanceIssues(root, gate, native, pdf, where),
    ...cases.issues,
    ...branch,
    ...automationIssues(root, where),
  ];
  return { cases: cases.cases, gate, issues };
}
