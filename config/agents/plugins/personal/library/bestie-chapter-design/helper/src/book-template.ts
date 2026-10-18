import type { BookContract, BookReadback, Bounds, Edges, Family, PageRecord } from "./book-input.ts";
import { sha256File } from "./input.ts";

const differs = (a: number, b: number, tolerance: number) => Math.abs(a - b) > tolerance;
const EDGES = ["top", "bottom", "outside", "inside"] as const;

function templateIssues(book: BookReadback, contract: BookContract): string[] {
  const issues: string[] = [];
  const pinned = contract.template.sha256;
  if (book.template.sha256 !== pinned) issues.push(`template ${book.template.path} is bound at ${book.template.sha256}, not the pinned ${pinned}.`);
  const actual = sha256File(book.template.path);
  if (actual === null) issues.push(`template file ${book.template.path} is missing; its pin is unverified.`);
  else if (actual !== pinned) issues.push(`template file ${book.template.path} is ${actual}, not the pinned ${pinned}.`);
  return issues;
}

/** The family, or "exception", the contract assigns each page; null when unassigned. */
function assignments(contract: BookContract): { map: Map<number, string>; issues: string[] } {
  const map = new Map<number, string>();
  const issues: string[] = [];
  const claim = (page: number, who: string) => {
    if (map.has(page)) issues.push(`page ${page} is assigned twice in the contract (${map.get(page)} and ${who}).`);
    else map.set(page, who);
  };
  for (const entry of contract.pageFamilies) {
    if (!contract.families.some((f) => f.name === entry.family)) issues.push(`page ${entry.page} names family "${entry.family}", which the contract does not declare.`);
    claim(entry.page, entry.family);
  }
  for (const entry of contract.exceptions) claim(entry.page, "exception");
  return { issues, map };
}

function edgeIssues(page: number, what: string, actual: Edges, expected: Edges, tolerance: number): string[] {
  return EDGES.filter((edge) => differs(actual[edge], expected[edge], tolerance)).map((edge) => `page ${page} ${what} ${edge} is ${actual[edge]}, not ${expected[edge]}.`);
}

function boundsDiffer(a: Bounds, b: Bounds, tolerance: number): boolean {
  return a.some((v, i) => differs(v, b[i] ?? Number.NaN, tolerance));
}

function geometryIssues(page: PageRecord, family: Family, tolerance: number): string[] {
  const issues = edgeIssues(page.page, "margin", page.margins, family.margins, tolerance);
  if (page.columns.count !== family.columns.count || differs(page.columns.gutter, family.columns.gutter, tolerance)) {
    issues.push(`page ${page.page} has ${page.columns.count} columns with ${page.columns.gutter} gutter; family ${family.name} has ${family.columns.count} with ${family.columns.gutter}.`);
  }
  for (const frame of family.frames) {
    const found = page.items.filter((item) => item.label === frame.label);
    if (found.length === 0) issues.push(`page ${page.page} has no "${frame.label}" frame required by family ${family.name}.`);
    else if (!found.some((item) => !boundsDiffer(item.bounds, frame.bounds, tolerance))) issues.push(`page ${page.page} "${frame.label}" is at [${found[0]?.bounds}], not [${frame.bounds}] for family ${family.name}.`);
  }
  return issues;
}

function pageIssues(page: PageRecord, contract: BookContract, assigned: Map<number, string>): string[] {
  const expected = assigned.get(page.page);
  if (expected === undefined) return [`page ${page.page} is in neither a family nor a declared exception.`];
  if (page.family !== expected) return [`page ${page.page} is read as "${page.family}"; the contract assigns "${expected}".`];
  const family = contract.families.find((f) => f.name === expected);
  return family === undefined ? [] : geometryIssues(page, family, contract.tolerance);
}

/** Template pin, page-to-family coverage and page-local geometry per family. */
export function templateFindings(book: BookReadback, contract: BookContract): Record<string, string[]> {
  const { map, issues } = assignments(contract);
  const known = new Set(book.pages.map((p) => p.page));
  const stray = [...map.keys()].filter((p) => !known.has(p)).map((p) => `contract assigns page ${p}, which is not in the readback.`);
  return {
    families: [...issues, ...stray, ...book.pages.flatMap((p) => pageIssues(p, contract, map))],
    template: templateIssues(book, contract),
  };
}

/** Page lists per family and the declared exceptions, for the manifest. */
export function familyCoverage(contract: BookContract) {
  return {
    exceptions: contract.exceptions,
    families: contract.families.map((f) => ({ name: f.name, pages: contract.pageFamilies.filter((e) => e.family === f.name).map((e) => e.page) })),
    template: contract.template,
  };
}
