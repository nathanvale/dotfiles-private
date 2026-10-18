import {
  type ArtBinding,
  anyText,
  artBindings,
  type Bounds,
  bounds,
  type FileIdentity,
  fileIdentity,
  type SourceRevision,
  sourceRevision,
  flag,
  InputError,
  integer,
  list,
  numeric,
  oneOf,
  optional,
  readJson,
  record,
  text,
} from "./input.ts";

export type Transform = [number, number, number, number, number, number];
export type Side = "left" | "right";
export type Edges = { top: number; bottom: number; outside: number; inside: number };

export type StyleInventory = Record<"paragraph" | "character" | "object" | "parent", string[]>;
export type Override = { scope: string; property: string; value: string; style: string };
export type Columns = { count: number; gutter: number };
export type PageItem = { label: string; kind: string; style: string; bounds: Bounds; overrides: Override[] };
export type PageRecord = {
  page: number;
  side: Side;
  parent: { name: string; transform: Transform };
  /** Nine-family name the page uses, or "exception" for a declared special page. */
  family: string;
  margins: Edges;
  columns: Columns;
  fields: Record<string, string>;
  bleed: Edges;
  items: PageItem[];
};
export type Family = { name: string; margins: Edges; columns: Columns; frames: { label: string; bounds: Bounds }[] };
export type Template = { path: string; sha256: string };
export type StoryRecord = {
  key: string;
  pages: number[];
  text: string;
  expected: string;
  oversetText: string;
  hidden: string[];
};
export type LinkRecord = {
  id: string;
  page: number;
  path: string;
  sha256: string;
  expectedSha256: string;
  status: string;
  effectivePpi: number;
  profile: string;
};
export type UnicodeEvidence = { codepoints: string; font: string; method: string; rendered: boolean };

export type BookReadback = {
  book: string;
  revision: string;
  native: FileIdentity;
  pdf: FileIdentity;
  pageCount: number;
  sourceRevision: SourceRevision;
  art: ArtBinding[];
  preflight: { profile: string; enabled: string[]; scope: string };
  styles: StyleInventory;
  exportSettings: Record<string, string>;
  template: Template;
  pages: PageRecord[];
  stories: StoryRecord[];
  links: LinkRecord[];
  fonts: { name: string; installed: boolean }[];
  unicode: UnicodeEvidence[];
};

export type BookContract = {
  stories: { key: string; pages: number[]; owner: string; sha256: string }[];
  template: Template;
  families: Family[];
  pageFamilies: { page: number; family: string }[];
  exceptions: { page: number; reason: string }[];
  pageCount: number;
  firstPageSide: Side;
  tolerance: number;
  styles: StyleInventory;
  allowedOverrides: { scope: string; property: string; value?: string | undefined }[];
  parents: { name: string; side: Side; transform: Transform }[];
  requiredFields: string[];
  fieldExemptPages: number[];
  bleed: Edges;
  links: { minPpi: number; profiles: string[]; status: string };
  requiredFonts: string[];
  preflightProfile: string;
  pdf: {
    trim: [number, number];
    colourSpaces: string[];
    minImagePpi: number | undefined;
    exportSettings: Record<string, string>;
  };
};

const SIDES = ["left", "right"] as const;

function strings(value: unknown, where: string): string[] {
  return list(value, where).map((entry, i) => text(entry, `${where}[${i}]`));
}

function transform(value: unknown, where: string): Transform {
  const items = list(value, where);
  if (items.length !== 6) throw new InputError(`${where} must have 6 numbers.`);
  return items.map((item, i) => numeric(item, `${where}[${i}]`)) as Transform;
}

function edges(value: unknown, where: string): Edges {
  const item = record(value, where);
  return {
    bottom: numeric(item.bottom, `${where}.bottom`),
    inside: numeric(item.inside, `${where}.inside`),
    outside: numeric(item.outside, `${where}.outside`),
    top: numeric(item.top, `${where}.top`),
  };
}

function inventory(value: unknown, where: string): StyleInventory {
  const item = record(value, where);
  return {
    character: strings(item.character, `${where}.character`),
    object: strings(item.object, `${where}.object`),
    paragraph: strings(item.paragraph, `${where}.paragraph`),
    parent: strings(item.parent, `${where}.parent`),
  };
}

function stringMap(value: unknown, where: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record(value, where)).map(([key, entry]) => {
      if (typeof entry === "string") return [key, entry];
      if (typeof entry === "number" && Number.isFinite(entry)) return [key, String(entry)];
      throw new InputError(`${where}.${key} must be a string or number.`);
    }),
  );
}

function override(value: unknown, where: string): Override {
  const item = record(value, where);
  return {
    property: text(item.property, `${where}.property`),
    scope: oneOf(item.scope, ["paragraph", "character", "object"], `${where}.scope`),
    style: text(item.style, `${where}.style`),
    value: String(item.value),
  };
}

function columns(value: unknown, where: string): Columns {
  const item = record(value, where);
  return { count: integer(item.count, `${where}.count`), gutter: numeric(item.gutter, `${where}.gutter`) };
}

function templateOf(value: unknown, where: string): Template {
  const item = record(value, where);
  return { path: text(item.path, `${where}.path`), sha256: text(item.sha256, `${where}.sha256`) };
}

function family(value: unknown, where: string): Family {
  const item = record(value, where);
  return {
    columns: columns(item.columns, `${where}.columns`),
    frames: list(item.frames, `${where}.frames`).map((f, i) => {
      const frame = record(f, `${where}.frames[${i}]`);
      return { bounds: bounds(frame.bounds, `${where}.frames[${i}].bounds`), label: text(frame.label, `${where}.frames[${i}].label`) };
    }),
    margins: edges(item.margins, `${where}.margins`),
    name: text(item.name, `${where}.name`),
  };
}

function pageItem(value: unknown, where: string): PageItem {
  const item = record(value, where);
  return {
    bounds: bounds(item.bounds, `${where}.bounds`),
    kind: text(item.kind, `${where}.kind`),
    label: text(item.label, `${where}.label`),
    overrides: list(item.overrides, `${where}.overrides`).map((entry, i) => override(entry, `${where}.overrides[${i}]`)),
    style: text(item.style, `${where}.style`),
  };
}

function pageRecord(value: unknown, where: string): PageRecord {
  const item = record(value, where);
  const parent = record(item.parent, `${where}.parent`);
  return {
    bleed: edges(item.bleed, `${where}.bleed`),
    columns: columns(item.columns, `${where}.columns`),
    family: text(item.family, `${where}.family`),
    fields: stringMap(item.fields, `${where}.fields`),
    margins: edges(item.margins, `${where}.margins`),
    items: list(item.items, `${where}.items`).map((entry, i) => pageItem(entry, `${where}.items[${i}]`)),
    page: integer(item.page, `${where}.page`),
    parent: { name: text(parent.name, `${where}.parent.name`), transform: transform(parent.transform, `${where}.parent.transform`) },
    side: oneOf(item.side, SIDES, `${where}.side`),
  };
}

function storyRecord(value: unknown, where: string): StoryRecord {
  const item = record(value, where);
  return {
    expected: text(item.expected, `${where}.expected`),
    hidden: strings(item.hidden, `${where}.hidden`),
    key: text(item.key, `${where}.key`),
    oversetText: anyText(item.oversetText, `${where}.oversetText`),
    pages: list(item.pages, `${where}.pages`).map((p, i) => integer(p, `${where}.pages[${i}]`)),
    text: anyText(item.text, `${where}.text`),
  };
}

function linkRecord(value: unknown, where: string): LinkRecord {
  const item = record(value, where);
  return {
    effectivePpi: numeric(item.effectivePpi, `${where}.effectivePpi`),
    expectedSha256: text(item.expectedSha256, `${where}.expectedSha256`),
    id: text(item.id, `${where}.id`),
    page: integer(item.page, `${where}.page`),
    path: text(item.path, `${where}.path`),
    profile: text(item.profile, `${where}.profile`),
    sha256: optional(item.sha256, (v) => anyText(v, `${where}.sha256`)) ?? "",
    status: text(item.status, `${where}.status`),
  };
}

function unicodeEvidence(value: unknown, where: string): UnicodeEvidence {
  const item = record(value, where);
  return {
    codepoints: text(item.codepoints, `${where}.codepoints`),
    font: text(item.font, `${where}.font`),
    method: text(item.method, `${where}.method`),
    rendered: flag(item.rendered, `${where}.rendered`),
  };
}

function mapList<T>(value: unknown, where: string, read: (v: unknown, w: string) => T): T[] {
  return list(value, where).map((entry, i) => read(entry, `${where}[${i}]`));
}

/** Reads the whole-book native readback: page-indexed, one object per concern. */
export function readBookReadback(path: string): BookReadback {
  const root = record(readJson(path), path);
  const preflight = record(root.preflight, `${path}.preflight`);
  return {
    art: artBindings(root.art, `${path}.art`),
    book: text(root.book, `${path}.book`),
    exportSettings: stringMap(root.exportSettings, `${path}.exportSettings`),
    fonts: mapList(root.fonts, `${path}.fonts`, (v, w) => {
      const item = record(v, w);
      return { installed: flag(item.installed, `${w}.installed`), name: text(item.name, `${w}.name`) };
    }),
    links: mapList(root.links, `${path}.links`, linkRecord),
    native: fileIdentity(root.native, `${path}.native`),
    pageCount: integer(root.pageCount, `${path}.pageCount`),
    pages: mapList(root.pages, `${path}.pages`, pageRecord),
    pdf: fileIdentity(root.pdf, `${path}.pdf`),
    template: templateOf(root.template, `${path}.template`),
    preflight: {
      enabled: strings(preflight.enabled, `${path}.preflight.enabled`),
      profile: text(preflight.profile, `${path}.preflight.profile`),
      scope: text(preflight.scope, `${path}.preflight.scope`),
    },
    revision: text(root.revision, `${path}.revision`),
    sourceRevision: sourceRevision(root.sourceRevision, `${path}.sourceRevision`),
    stories: mapList(root.stories, `${path}.stories`, storyRecord),
    styles: inventory(root.styles, `${path}.styles`),
    unicode: mapList(root.unicode, `${path}.unicode`, unicodeEvidence),
  };
}

function contractLinks(value: unknown, where: string): BookContract["links"] {
  const item = record(value, where);
  return {
    minPpi: numeric(item.minPpi, `${where}.minPpi`),
    profiles: strings(item.profiles, `${where}.profiles`),
    status: text(item.status, `${where}.status`),
  };
}

function contractPdf(value: unknown, where: string): BookContract["pdf"] {
  const item = record(value, where);
  const trim = list(item.trim, `${where}.trim`);
  if (trim.length !== 2) throw new InputError(`${where}.trim must be [width, height].`);
  return {
    colourSpaces: strings(item.colourSpaces, `${where}.colourSpaces`),
    exportSettings: stringMap(item.exportSettings, `${where}.exportSettings`),
    minImagePpi: optional(item.minImagePpi, (v) => numeric(v, `${where}.minImagePpi`)),
    trim: [numeric(trim[0], `${where}.trim[0]`), numeric(trim[1], `${where}.trim[1]`)],
  };
}

/** Reads the book contract derived from the packet's production contract. */
export function readBookContract(path: string): BookContract {
  const root = record(readJson(path), path);
  return {
    stories: mapList(root.stories, `${path}.stories`, (v, w) => {
      const item = record(v, w);
      return { key: text(item.key, `${w}.key`), owner: text(item.owner, `${w}.owner`), pages: mapList(item.pages, `${w}.pages`, integer), sha256: text(item.sha256, `${w}.sha256`) };
    }),
    exceptions: mapList(root.exceptions, `${path}.exceptions`, (v, w) => {
      const item = record(v, w);
      return { page: integer(item.page, `${w}.page`), reason: text(item.reason, `${w}.reason`) };
    }),
    families: mapList(root.families, `${path}.families`, family),
    pageFamilies: mapList(root.pageFamilies, `${path}.pageFamilies`, (v, w) => {
      const item = record(v, w);
      return { family: text(item.family, `${w}.family`), page: integer(item.page, `${w}.page`) };
    }),
    template: templateOf(root.template, `${path}.template`),
    allowedOverrides: mapList(root.allowedOverrides, `${path}.allowedOverrides`, (v, w) => {
      const item = record(v, w);
      return {
        property: text(item.property, `${w}.property`),
        scope: text(item.scope, `${w}.scope`),
        value: optional(item.value, (x) => text(x, `${w}.value`)),
      };
    }),
    bleed: edges(root.bleed, `${path}.bleed`),
    fieldExemptPages: mapList(root.fieldExemptPages, `${path}.fieldExemptPages`, integer),
    firstPageSide: oneOf(root.firstPageSide, SIDES, `${path}.firstPageSide`),
    links: contractLinks(root.links, `${path}.links`),
    pageCount: integer(root.pageCount, `${path}.pageCount`),
    parents: mapList(root.parents, `${path}.parents`, (v, w) => {
      const item = record(v, w);
      return { name: text(item.name, `${w}.name`), side: oneOf(item.side, SIDES, `${w}.side`), transform: transform(item.transform, `${w}.transform`) };
    }),
    pdf: contractPdf(root.pdf, `${path}.pdf`),
    preflightProfile: text(root.preflightProfile, `${path}.preflightProfile`),
    requiredFields: strings(root.requiredFields, `${path}.requiredFields`),
    requiredFonts: strings(root.requiredFonts, `${path}.requiredFonts`),
    styles: inventory(root.styles, `${path}.styles`),
    tolerance: numeric(root.tolerance, `${path}.tolerance`),
  };
}
