import type { BookContract, BookReadback, Edges, PageRecord, Side, StyleInventory } from "./book-input.ts";
import { sha256File } from "./input.ts";

const differs = (a: number, b: number, tolerance: number) => Math.abs(a - b) > tolerance;

function bindingIssues(book: BookReadback): string[] {
  const files = [
    { file: book.native, label: "native" },
    { file: book.pdf, label: "PDF" },
    ...book.art.map((art) => ({ file: art, label: `art ${art.id}` })),
  ];
  const issues = files.flatMap(({ file, label }) => {
    const actual = sha256File(file.path);
    if (actual === null) return [`${label} ${file.path} is missing.`];
    return actual === file.sha256 ? [] : [`${label} ${file.path} is ${actual}, not the bound ${file.sha256}.`];
  });
  const { repository, commit } = book.sourceRevision;
  const run = (args: string[]) => Bun.spawnSync(["git", "-C", repository, ...args], { stderr: "ignore", stdout: "ignore" }).exitCode;
  if (run(["cat-file", "-e", `${commit}^{commit}`]) !== 0) issues.push(`source revision ${commit} is not a commit in ${repository}.`);
  else if (run(["merge-base", "--is-ancestor", commit, "HEAD"]) !== 0) issues.push(`source revision ${commit} is not on the current HEAD of ${repository}.`);
  return issues;
}

function pageSet(book: BookReadback, contract: BookContract): string[] {
  const issues: string[] = [];
  const numbers = book.pages.map((p) => p.page);
  if (book.pageCount !== contract.pageCount) issues.push(`book reports ${book.pageCount} pages; the contract requires ${contract.pageCount}.`);
  const expected = Array.from({ length: book.pageCount }, (_, i) => i + 1);
  if (numbers.join() !== expected.join()) issues.push(`page readback covers pages ${numbers.join(",") || "none"}, not every page 1-${book.pageCount} once and in order.`);
  return issues;
}

function sideFor(page: number, first: Side): Side {
  const flip = page % 2 === 0;
  if (first === "right") return flip ? "left" : "right";
  return flip ? "right" : "left";
}

function parityIssues(page: PageRecord, contract: BookContract): string[] {
  const issues: string[] = [];
  const side = sideFor(page.page, contract.firstPageSide);
  if (page.side !== side) issues.push(`page ${page.page} is read as a ${page.side} page; page parity makes it ${side}.`);
  const parent = contract.parents.find((p) => p.name === page.parent.name);
  if (parent === undefined) return [...issues, `page ${page.page} uses parent "${page.parent.name}", which the contract does not declare.`];
  if (parent.side !== side) issues.push(`page ${page.page} (${side}) uses ${parent.side} parent "${parent.name}".`);
  const moved = parent.transform.some((v, i) => differs(v, page.parent.transform[i] ?? Number.NaN, contract.tolerance));
  if (moved) issues.push(`page ${page.page} parent "${parent.name}" transform [${page.parent.transform}] differs from [${parent.transform}].`);
  return issues;
}

function edgeNames(): (keyof Edges)[] {
  return ["top", "bottom", "outside", "inside"];
}

function bleedIssues(page: PageRecord, contract: BookContract): string[] {
  return edgeNames()
    .filter((edge) => differs(page.bleed[edge], contract.bleed[edge], contract.tolerance))
    .map((edge) => `page ${page.page} ${edge} bleed is ${page.bleed[edge]}, not ${contract.bleed[edge]}.`);
}

function fieldIssues(page: PageRecord, contract: BookContract): string[] {
  if (contract.fieldExemptPages.includes(page.page)) return [];
  return contract.requiredFields
    .filter((name) => !page.fields[name]?.trim())
    .map((name) => `page ${page.page} has no value for field "${name}".`);
}

function unknown(kind: keyof StyleInventory, used: string[], allowed: string[]): string[] {
  return used.filter((name) => !allowed.includes(name)).map((name) => `${kind} style "${name}" is in the document but not in the contract.`);
}

function styleIssues(book: BookReadback, contract: BookContract): string[] {
  const kinds: (keyof StyleInventory)[] = ["paragraph", "character", "object", "parent"];
  const inventory = kinds.flatMap((kind) => unknown(kind, book.styles[kind], contract.styles[kind]));
  const itemStyles = book.pages.flatMap((page) =>
    page.items.flatMap((item) =>
      contract.styles.paragraph.includes(item.style) || contract.styles.object.includes(item.style) || contract.styles.character.includes(item.style)
        ? []
        : [`page ${page.page} "${item.label}" uses style "${item.style}", which the contract does not declare.`],
    ),
  );
  return [...inventory, ...itemStyles];
}

function overrideIssues(book: BookReadback, contract: BookContract): string[] {
  return book.pages.flatMap((page) =>
    page.items.flatMap((item) =>
      item.overrides
        .filter((o) => !contract.allowedOverrides.some((a) => a.scope === o.scope && a.property === o.property && (a.value === undefined || a.value === o.value)))
        .map((o) => `page ${page.page} "${item.label}" carries a local ${o.scope} override ${o.property}=${o.value} on "${o.style}".`),
    ),
  );
}

function firstDifference(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) return i;
  return length;
}

function storyIssues(book: BookReadback): string[] {
  return book.stories.flatMap((story) => {
    const issues: string[] = [];
    if (story.text !== story.expected) {
      const at = firstDifference(story.text, story.expected);
      issues.push(`story ${story.key} differs from its selected source text at character ${at} (exact comparison, whitespace included): native ${JSON.stringify(story.text.slice(at, at + 20))}, source ${JSON.stringify(story.expected.slice(at, at + 20))}.`);
    }
    if (story.oversetText.trim()) issues.push(`story ${story.key} is overset: "${story.oversetText.trim().slice(0, 40)}" does not fit.`);
    for (const reason of story.hidden) issues.push(`story ${story.key} has hidden text: ${reason}.`);
    return issues;
  });
}

function linkIssues(book: BookReadback, contract: BookContract): string[] {
  const { minPpi, profiles, status } = contract.links;
  return book.links.flatMap((link) => {
    const where = `link ${link.id} on page ${link.page}`;
    const issues: string[] = [];
    if (link.status !== status) issues.push(`${where} is ${link.status}, not ${status}.`);
    if (link.sha256 === "") issues.push(`${where} target ${link.path} is missing.`);
    else if (link.sha256 !== link.expectedSha256) issues.push(`${where} target ${link.path} is ${link.sha256}, not the selected ${link.expectedSha256}.`);
    if (link.effectivePpi < minPpi) issues.push(`${where} is ${link.effectivePpi} effective ppi, under ${minPpi}.`);
    if (!profiles.includes(link.profile)) issues.push(`${where} profile "${link.profile}" is not one of ${profiles.join(", ")}.`);
    return issues;
  });
}

const GLYPH_TIGHT = ["raster-glyph", "glyph-outline"];

function needsEvidence(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0;
  if (cp === 0x200d || cp === 0xfe0f) return true;
  return cp > 0x24f && !(cp >= 0x2000 && cp <= 0x206f);
}

function unicodeIssues(book: BookReadback): { issues: string[]; review: string[] } {
  const covered = new Set(book.unicode.filter((u) => u.rendered).flatMap((u) => u.codepoints.split(/\s+/).map((c) => c.toUpperCase())));
  const used = new Set(book.stories.flatMap((s) => [...s.text].filter(needsEvidence).map((c) => (c.codePointAt(0) ?? 0).toString(16).toUpperCase())));
  const issues = [...used].filter((cp) => !covered.has(cp)).map((cp) => `U+${cp} appears in a story with no rendered-glyph evidence.`);
  const review = book.unicode.filter((u) => u.rendered && !GLYPH_TIGHT.includes(u.method)).map((u) => `Unicode evidence for ${u.codepoints} used ${u.method}, not glyph-tight ink.`);
  return { issues, review };
}

function fontIssues(book: BookReadback, contract: BookContract): string[] {
  return contract.requiredFonts.flatMap((name) => {
    const font = book.fonts.find((f) => f.name === name);
    if (font === undefined) return [`required font ${name} is not in the font readback.`];
    return font.installed ? [] : [`required font ${name} is not installed.`];
  });
}

function preflightIssues(book: BookReadback, contract: BookContract): string[] {
  const issues: string[] = [];
  if (book.preflight.profile !== contract.preflightProfile) issues.push(`Preflight profile is "${book.preflight.profile}", not "${contract.preflightProfile}".`);
  if (book.preflight.enabled.length === 0) issues.push("Preflight records no enabled checks.");
  return issues;
}

/** Deterministic native-side findings, grouped by concern. */
export function nativeFindings(book: BookReadback, contract: BookContract) {
  const unicode = unicodeIssues(book);
  return {
    review: unicode.review,
    sections: {
      binding: bindingIssues(book),
      bleed: book.pages.flatMap((p) => bleedIssues(p, contract)),
      fields: book.pages.flatMap((p) => fieldIssues(p, contract)),
      fonts: fontIssues(book, contract),
      links: linkIssues(book, contract),
      overrides: overrideIssues(book, contract),
      pages: pageSet(book, contract),
      parity: book.pages.flatMap((p) => parityIssues(p, contract)),
      preflight: preflightIssues(book, contract),
      stories: storyIssues(book),
      styles: styleIssues(book, contract),
      unicode: unicode.issues,
    } satisfies Record<string, string[]>,
  };
}
