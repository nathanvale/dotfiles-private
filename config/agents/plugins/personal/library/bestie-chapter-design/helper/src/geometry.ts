import { type CheckResult, verdict } from "./check-result.ts";
import { type Frame, frameStyles, frameText, readFrames } from "./frames.ts";
import {
  type Bounds,
  bounds,
  InputError,
  integer,
  type JsonRecord,
  list,
  numeric,
  oneOf,
  optional,
  readJson,
  record,
  text,
} from "./input.ts";

type Side = "left" | "right";

type Contract = {
  trim: { width: number; height: number };
  bleed: { top: number; bottom: number; outside: number; inside: number };
  firstPageSide: Side;
  tolerance: number;
  footer: Record<Side, Map<string, Bounds>>;
  footerExemptPages: number[];
  folio: { label: string; marker: string };
  backgroundLabels: string[];
  unpaintedFills: string[];
  reply: {
    headerStyles: string[];
    bodyStyles: string[];
    minGap: number;
    pattern: RegExp | undefined;
  };
  styleFonts: Map<string, string>;
  emojiFont: string | undefined;
};

function strings(value: unknown, where: string): string[] {
  return list(value, where).map((item, i) => text(item, `${where}[${i}]`));
}

function footerSide(value: unknown, where: string): Map<string, Bounds> {
  const side = record(value, where);
  return new Map(
    Object.entries(side).map(([label, b]) => [label, bounds(b, `${where}.${label}`)]),
  );
}

function pattern(value: unknown, where: string): RegExp {
  try {
    return new RegExp(text(value, where), "u");
  } catch {
    throw new InputError(`${where} is not a valid regular expression.`);
  }
}

function readContract(path: string): Contract {
  const root = record(readJson(path), path);
  const trim = record(root.trim, `${path}.trim`);
  const bleed = record(root.bleed, `${path}.bleed`);
  const footer = record(root.footer, `${path}.footer`);
  const folio = record(root.folio, `${path}.folio`);
  const reply = record(root.replyHeader, `${path}.replyHeader`);
  const n = (value: unknown, where: string) => numeric(value, `${path}.${where}`);
  return {
    backgroundLabels: strings(root.backgroundLabels, `${path}.backgroundLabels`),
    bleed: {
      bottom: n(bleed.bottom, "bleed.bottom"),
      inside: n(bleed.inside, "bleed.inside"),
      outside: n(bleed.outside, "bleed.outside"),
      top: n(bleed.top, "bleed.top"),
    },
    firstPageSide: oneOf(root.firstPageSide, ["left", "right"], `${path}.firstPageSide`),
    folio: {
      label: text(folio.label, `${path}.folio.label`),
      marker: text(folio.marker, `${path}.folio.marker`),
    },
    footer: {
      left: footerSide(footer.left, `${path}.footer.left`),
      right: footerSide(footer.right, `${path}.footer.right`),
    },
    footerExemptPages: list(root.footerExemptPages, `${path}.footerExemptPages`).map(
      (p, i) => integer(p, `${path}.footerExemptPages[${i}]`),
    ),
    reply: {
      bodyStyles: strings(reply.bodyStyles, `${path}.replyHeader.bodyStyles`),
      headerStyles: strings(reply.headerStyles, `${path}.replyHeader.headerStyles`),
      minGap: n(reply.minGap, "replyHeader.minGap"),
      pattern: optional(reply.pattern, (v) => pattern(v, `${path}.replyHeader.pattern`)),
    },
    emojiFont: optional(root.emojiFont, (v) => text(v, `${path}.emojiFont`)),
    styleFonts: new Map(
      Object.entries(record(root.styleFonts, `${path}.styleFonts`)).map(([style, font]) => [
        style,
        text(font, `${path}.styleFonts.${style}`),
      ]),
    ),
    tolerance: n(root.tolerance, "tolerance"),
    trim: { height: n(trim.height, "trim.height"), width: n(trim.width, "trim.width") },
    unpaintedFills:
      optional(root.unpaintedFills, (v) => strings(v, `${path}.unpaintedFills`)) ??
      ["None", "Paper"],
  };
}

function sideOf(page: number, contract: Contract): Side {
  const first = contract.firstPageSide;
  if (page % 2 === 1) return first;
  return first === "right" ? "left" : "right";
}

function overlaps(a: Bounds, b: Bounds): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

function show(b: Bounds): string {
  return `[${b.join(", ")}]`;
}

function isBackground(item: Frame, contract: Contract): boolean {
  return contract.backgroundLabels.includes(item.label);
}

function pagesOf(frames: Frame[]): number[] {
  return [...new Set(frames.map((f) => f.page))].sort((a, b) => a - b);
}

function footerFrameIssues(
  frames: Frame[],
  page: number,
  contract: Contract,
): string[] {
  const side = sideOf(page, contract);
  const onPage = frames.filter((f) => f.page === page);
  return [...contract.footer[side]].flatMap(([label, expected]) => {
    const found = onPage.filter((f) => f.label === label);
    if (found.length !== 1) {
      return [`p${page} has ${found.length} "${label}" frames; expected 1.`];
    }
    const item = found[0] as Frame;
    const drift = item.bounds.some(
      (value, i) => Math.abs(value - (expected[i] ?? 0)) > contract.tolerance,
    );
    const issues = drift
      ? [`p${page} ${label} at ${show(item.bounds)}; contract ${side} page expects ${show(expected)}.`]
      : [];
    return [...issues, ...visibilityIssues(item, onPage, contract)];
  });
}

function visibilityIssues(item: Frame, onPage: Frame[], contract: Contract): string[] {
  const where = `p${item.page} ${item.label}`;
  const issues: string[] = [];
  if (item.visible === false) issues.push(`${where} is hidden.`);
  if (item.label === contract.folio.label && !frameText(item).includes(contract.folio.marker)) {
    issues.push(`${where} lacks the automatic page-number marker.`);
  }
  for (const other of onPage) {
    if (other === item || isBackground(other, contract)) continue;
    const above = item.z === undefined || other.z === undefined || other.z > item.z;
    if (above && overlaps(item.bounds, other.bounds)) {
      issues.push(`${where} is overlapped by "${other.label}" ${show(other.bounds)}.`);
    }
  }
  return issues;
}

/** Edges a page background must reach; inside bleed is the binding edge. */
function bleedTargets(page: number, contract: Contract) {
  const { width, height } = contract.trim;
  const { top, bottom, outside, inside } = contract.bleed;
  const right = sideOf(page, contract) === "right";
  return {
    bottom: height + bottom,
    left: right ? -inside : -outside,
    right: right ? width + outside : width + inside,
    top: -top,
  };
}

function backgroundIssues(item: Frame, contract: Contract): string[] {
  if (item.fill !== undefined && contract.unpaintedFills.includes(item.fill)) return [];
  const want = bleedTargets(item.page, contract);
  const [top, left, bottom, right] = item.bounds;
  const tol = contract.tolerance;
  const short = [
    top > want.top + tol ? "top" : "",
    bottom < want.bottom - tol ? "bottom" : "",
    left > want.left + tol ? "left" : "",
    right < want.right - tol ? "right" : "",
  ].filter(Boolean);
  const binding = sideOf(item.page, contract) === "right" ? "left" : "right";
  const across = binding === "left" ? left < want.left - tol : right > want.right + tol;
  const kind = item.kind ?? "page item";
  const issues = short.length
    ? [`p${item.page} ${item.label} (${kind}) ${show(item.bounds)} leaves white bleed at ${short.join(", ")}.`]
    : [];
  if (across) {
    issues.push(`p${item.page} ${item.label} (${kind}) extends across the binding edge.`);
  }
  return issues;
}

function gap(a: Bounds, b: Bounds): number {
  return b[0] >= a[0] ? b[0] - a[2] : a[0] - b[2];
}

function hasStyle(item: Frame, styles: string[]): boolean {
  return frameStyles(item).some((style) => styles.includes(style));
}

type ReplyFindings = { issues: string[]; review: string[] };

function sharesColumn(h: Frame, b: Frame): boolean {
  return b.page === h.page && b.bounds[1] < h.bounds[3] && h.bounds[1] < b.bounds[3];
}

/**
 * Rendered ink decides a collision. A container-only overlap without ink is a
 * review prompt, never a failed layout: unused frame space is not visible text.
 */
function judgePair(h: Frame, b: Frame, minGap: number, out: ReplyFindings): void {
  const pair = `p${h.page} header "${h.label}" and body "${b.label}"`;
  if (h.ink !== undefined && b.ink !== undefined) {
    const inkGap = gap(h.ink, b.ink);
    if (inkGap < minGap) out.issues.push(`${pair} rendered text is ${inkGap}pt apart; minimum ${minGap}pt.`);
    return;
  }
  const frameGap = gap(h.bounds, b.bounds);
  if (frameGap < minGap) {
    out.review.push(`${pair} frames are ${frameGap}pt apart without measured ink; review at useful scale or supply ink bounds.`);
  }
}

function replyFindings(frames: Frame[], contract: Contract): ReplyFindings {
  const { headerStyles, bodyStyles, minGap } = contract.reply;
  const headers = frames.filter((f) => hasStyle(f, headerStyles));
  const bodies = frames.filter((f) => hasStyle(f, bodyStyles));
  const out: ReplyFindings = { issues: [], review: [] };
  for (const h of headers) {
    for (const b of bodies.filter((body) => sharesColumn(h, body))) judgePair(h, b, minGap, out);
  }
  return out;
}

const EMOJI_ONLY =
  /^(?:\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|[\u{1F3FB}-\u{1F3FF}]|\u200D|\uFE0F|\u20E3)+$/u;

/** A local font that differs from the role's declared font risks missing glyphs. */
function fontIssues(item: Frame, contract: Contract): string[] {
  const wrong = new Set<string>();
  for (const range of item.ranges) {
    const declared = contract.styleFonts.get(String(range.style ?? ""));
    if (declared === undefined || range.font === declared) continue;
    const emoji = contract.emojiFont !== undefined && range.font === contract.emojiFont;
    if (emoji && EMOJI_ONLY.test(String(range.text ?? ""))) continue;
    wrong.add(`${String(range.font)}|${String(range.style)}|${declared}`);
  }
  return [...wrong].map((entry) => {
    const [font, style, declared] = entry.split("|");
    return `p${item.page} ${item.label} uses ${JSON.stringify(font)}; style "${style}" declares ${JSON.stringify(declared)}.`;
  });
}

function headerTextIssues(frames: Frame[], contract: Contract): string[] {
  const { headerStyles, pattern } = contract.reply;
  if (pattern === undefined) return [];
  return frames
    .filter((f) => hasStyle(f, headerStyles) && !pattern.test(frameText(f)))
    .map((f) => `p${f.page} header "${f.label}" text ${JSON.stringify(frameText(f))} does not match the header pattern.`);
}

export function checkGeometry(snapshotPath: string, contractPath: string): CheckResult {
  const frames = readFrames(snapshotPath);
  const contract = readContract(contractPath);
  const pages = pagesOf(frames);
  const backgrounds = frames.filter((f) => isBackground(f, contract));
  const reply = replyFindings(frames, contract);
  const issues = [
    ...pages
      .filter((p) => !contract.footerExemptPages.includes(p))
      .flatMap((p) => footerFrameIssues(frames, p, contract)),
    ...backgrounds.flatMap((f) => backgroundIssues(f, contract)),
    ...reply.issues,
    ...headerTextIssues(frames, contract),
    ...frames.flatMap((f) => fontIssues(f, contract)),
  ];
  const data: JsonRecord = {
    backgroundsChecked: backgrounds.map((f) => ({ kind: f.kind ?? null, label: f.label, page: f.page })),
    containerReview: reply.review,
    pages: pages.length,
    visualReviewStillRequired: true,
  };
  return verdict(
    issues,
    data,
    "Footers, page numbers, backgrounds, role fonts, headers and reply spacing meet the contract. Useful-scale visual review is still required.",
    "Geometry contract failures found.",
    "Repair the listed frames without changing selected text or art, read back again and rerun geometry, then review pages at useful scale.",
  );
}
