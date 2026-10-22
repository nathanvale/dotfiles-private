import { type CheckResult, verdict } from "./check-result.ts";
import {
  InputError,
  integer,
  list,
  oneOf,
  optional,
  readJson,
  readText,
  record,
  sha256Text,
  text,
} from "./input.ts";

const BASE_ROLES = ["introduction", "teaser", "ending"] as const;
const ROLES = [...BASE_ROLES, "transition"] as const;
const STANDINGS = ["accepted", "selected", "proposed"] as const;
const SCOPES = ["block", "pair", "chapter"] as const;

export type Role = (typeof ROLES)[number];

/** A paragraph range under one exact heading of a named copy owner. */
export type BlockAddress = {
  owner: string;
  section?: string;
  heading: string;
  paragraphs: [number, number];
};

export type CopyBlock = BlockAddress & {
  role: Role;
  standing: (typeof STANDINGS)[number];
  acceptance: { scope: (typeof SCOPES)[number]; evidence: string };
  sha256: string;
  supersedes: BlockAddress[];
};

export type Resolution = { chapter: string; blocks: CopyBlock[] };

export type PlacementUnit = {
  role: Role;
  text: string;
  sha256: string;
  words: number;
  sources: string[];
};

function address(value: unknown, where: string): BlockAddress {
  const item = record(value, where);
  const range = list(item.paragraphs, `${where}.paragraphs`);
  const first = integer(range[0], `${where}.paragraphs[0]`);
  const last = integer(range[1], `${where}.paragraphs[1]`);
  if (range.length !== 2 || first < 1 || last < first) {
    throw new InputError(`${where}.paragraphs must be [first, last], 1-based.`);
  }
  return {
    heading: text(item.heading, `${where}.heading`),
    owner: text(item.owner, `${where}.owner`),
    ...(item.section === undefined
      ? {}
      : { section: text(item.section, `${where}.section`) }),
    paragraphs: [first, last],
  };
}

function block(value: unknown, where: string): CopyBlock {
  const item = record(value, where);
  const acceptance = record(item.acceptance, `${where}.acceptance`);
  const supersedes =
    optional(item.supersedes, (v) => list(v, `${where}.supersedes`)) ?? [];
  return {
    ...address(item, where),
    acceptance: {
      evidence: text(acceptance.evidence, `${where}.acceptance.evidence`),
      scope: oneOf(acceptance.scope, SCOPES, `${where}.acceptance.scope`),
    },
    role: oneOf(item.role, ROLES, `${where}.role`),
    sha256: text(item.sha256, `${where}.sha256`),
    standing: oneOf(item.standing, STANDINGS, `${where}.standing`),
    supersedes: supersedes.map((entry, index) =>
      address(entry, `${where}.supersedes[${index}]`),
    ),
  };
}

export function readResolution(path: string): Resolution {
  const root = record(readJson(path), path);
  return {
    blocks: list(root.blocks, `${path}.blocks`).map((entry, index) =>
      block(entry, `${path}.blocks[${index}]`),
    ),
    chapter: text(root.chapter, `${path}.chapter`),
  };
}

function blockKey(item: BlockAddress): string {
  const [first, last] = item.paragraphs;
  return `${item.owner}#${item.section === undefined ? "" : `${item.section}/`}${item.heading}¶${first}-${last}`;
}

/** Paragraphs under an exact heading, optionally scoped to its parent section. */
function sectionParagraphs(owner: string, heading: string, section?: string): string[] {
  const lines = readText(owner).split("\n");
  const headings = lines.flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    return match === null
      ? []
      : [{ index, level: (match[1] ?? "").length, name: match[2] ?? "" }];
  });
  const parents = section === undefined
    ? []
    : headings.filter((item) => item.name === section);
  if (section !== undefined && parents.length !== 1) {
    throw new InputError(
      `${owner} has ${parents.length} sections named "${section}"; expected exactly 1.`,
    );
  }
  const parent = parents[0];
  const scopeStart = parent === undefined ? 0 : parent.index + 1;
  const scopeEnd = parent === undefined
    ? lines.length
    : (headings.find((item) => item.index > parent.index && item.level <= parent.level)?.index ??
      lines.length);
  const starts = headings
    .filter((item) =>
      item.index >= scopeStart &&
      item.index < scopeEnd &&
      item.name === heading &&
      (parent === undefined || item.level > parent.level),
    )
    .map((item) => item.index);
  if (starts.length !== 1) {
    throw new InputError(
      `${owner} has ${starts.length} headings named "${heading}"${section === undefined ? "" : ` under "${section}"`}; expected exactly 1.`,
    );
  }
  const body: string[] = [];
  for (const line of lines.slice((starts[0] ?? 0) + 1, scopeEnd)) {
    if (/^#{1,6}\s/.test(line)) break;
    body.push(line.trimEnd());
  }
  return copyParagraphs(body.join("\n"));
}

/** Copy placement normalization: preserve continuation indentation, discard line-end whitespace. */
export function copyParagraphs(text: string): string[] {
  return text.split("\n").map(line => line.trimEnd()).join("\n")
    .split(/\n\s*\n/)
    .map(paragraph => paragraph.trim().split("\n").join(" "))
    .filter(paragraph => paragraph.length > 0);
}

function addressedParagraphs(item: BlockAddress): string[] {
  const all = sectionParagraphs(item.owner, item.heading, item.section);
  const [first, last] = item.paragraphs;
  if (last > all.length) {
    throw new InputError(
      `${blockKey(item)} exceeds the ${all.length} paragraphs under that heading.`,
    );
  }
  return all.slice(first - 1, last);
}

/** Exact block text: addressed paragraphs joined by one blank line. */
function ownerText(item: BlockAddress): string {
  return addressedParagraphs(item).join("\n\n");
}

export function wordCount(value: string): number {
  return value.split(/\s+/).filter((word) => word.length > 0).length;
}

function ownerIssues(resolution: Resolution, label: string): string[] {
  return resolution.blocks.flatMap((item) => {
    const actual = sha256Text(ownerText(item));
    return actual === item.sha256
      ? []
      : [
          `${label} ${item.role} block ${blockKey(item)} records ${item.sha256} but its owner text is now ${actual}.`,
        ];
  });
}

function roleIssues(resolution: Resolution): string[] {
  const issues = BASE_ROLES.flatMap((role) => {
    const count = resolution.blocks.filter((b) => b.role === role).length;
    return count === 1
      ? []
      : [`current resolution has ${count} ${role} blocks; expected exactly 1.`];
  });
  for (const item of resolution.blocks) {
    if (item.standing === "proposed") {
      issues.push(
        `${item.role} block ${blockKey(item)} is proposed; only accepted or selected blocks can be placed.`,
      );
    }
  }
  return issues;
}

function contains(outer: BlockAddress, inner: BlockAddress): boolean {
  return (
    outer.owner === inner.owner &&
    outer.section === inner.section &&
    outer.heading === inner.heading &&
    outer.paragraphs[0] <= inner.paragraphs[0] &&
    inner.paragraphs[1] <= outer.paragraphs[1]
  );
}

function supersedeIssues(resolution: Resolution): string[] {
  const bases = resolution.blocks.filter((b) => b.role !== "transition");
  return resolution.blocks.flatMap((item) =>
    item.supersedes.flatMap((target) =>
      bases.some((base) => contains(base, target))
        ? []
        : [
            `${item.role} block ${blockKey(item)} supersedes ${blockKey(target)}, which no selected base block contains.`,
          ],
    ),
  );
}

function freshnessIssues(input: Resolution, current: Resolution): string[] {
  const identity = (b: CopyBlock) => `${blockKey(b)}@${b.sha256}`;
  const inputIds = new Set(input.blocks.map(identity));
  const currentIds = new Set(current.blocks.map(identity));
  const missing = current.blocks
    .filter((b) => !inputIds.has(identity(b)))
    .map(
      (b) =>
        `stale build input: current ${b.standing} ${b.role} block ${blockKey(b)} is absent from the build input.`,
    );
  const extra = input.blocks
    .filter((b) => !currentIds.has(identity(b)))
    .map(
      (b) =>
        `stale build input: ${b.role} block ${blockKey(b)} is no longer in the current resolution.`,
    );
  return [...missing, ...extra];
}

function composeBase(base: CopyBlock, resolution: Resolution): PlacementUnit {
  const paragraphs = addressedParagraphs(base);
  const sources = [blockKey(base)];
  const patches = resolution.blocks.flatMap((item) =>
    item.supersedes
      .filter((target) => contains(base, target))
      .map((target) => ({ item, target })),
  );
  patches.sort((a, b) => b.target.paragraphs[0] - a.target.paragraphs[0]);
  for (const { item, target } of patches) {
    const start = target.paragraphs[0] - base.paragraphs[0];
    const length = target.paragraphs[1] - target.paragraphs[0] + 1;
    paragraphs.splice(start, length, ...addressedParagraphs(item));
    sources.push(blockKey(item));
  }
  const value = paragraphs.join("\n\n");
  return {
    role: base.role,
    sha256: sha256Text(value),
    sources,
    text: value,
    words: wordCount(value),
  };
}

/** Placement text per role: base blocks with superseding transitions applied. */
export function placementUnits(resolution: Resolution): PlacementUnit[] {
  return resolution.blocks
    .filter((item) => item.role !== "transition" || item.supersedes.length === 0)
    .map((item) => composeBase(item, resolution));
}

export function checkCopy(inputPath: string, currentPath: string): CheckResult {
  const input = readResolution(inputPath);
  const current = readResolution(currentPath);
  const issues = [
    ...ownerIssues(current, "current"),
    ...ownerIssues(input, "build input"),
    ...roleIssues(current),
    ...supersedeIssues(current),
    ...freshnessIssues(input, current),
  ];
  if (input.chapter !== current.chapter) {
    issues.push(
      `build input is for "${input.chapter}" but the current resolution is for "${current.chapter}".`,
    );
  }
  const data =
    issues.length === 0
      ? {
          blocks: current.blocks.map((b) => ({
            acceptance: b.acceptance,
            identity: blockKey(b),
            role: b.role,
            sha256: b.sha256,
            standing: b.standing,
          })),
          chapter: current.chapter,
          placement: placementUnits(current),
        }
      : null;
  return verdict(
    issues,
    data,
    "Build copy input matches the current selected blocks.",
    "Build copy input does not match the current selected blocks.",
    "Re-resolve the selected blocks through their owners, rebuild the input, then rerun copy before any placement.",
  );
}
