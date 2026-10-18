import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { InputError } from "./input.ts";

export type Box = [number, number, number, number];
export type PdfPage = {
  page: number;
  boxes: Partial<Record<"MediaBox" | "TrimBox" | "BleedBox" | "CropBox", Box>>;
  fonts: { name: string; type: string; embedded: boolean }[];
  images: { colour: string; xPpi: number; yPpi: number }[];
  text: string;
};
export type ContentColours = { rgb: number; cmyk: number; gray: number };
export type PdfFacts = { pages: number; version: string; tagged: boolean; producer: string; contentColours: ContentColours; readback: PdfPage[] };

function tool(name: string, args: string[]): string {
  if (Bun.which(name) === null) throw new InputError(`${name} (poppler) is not installed; PDF facts cannot be read.`);
  const run = Bun.spawnSync([name, ...args], { stderr: "pipe", stdin: "ignore", stdout: "pipe" });
  if (run.exitCode !== 0) throw new InputError(`${name} could not read the PDF: ${run.stderr.toString().trim()}`);
  return run.stdout.toString();
}

function parseBoxes(info: string): Map<number, PdfPage["boxes"]> {
  const out = new Map<number, PdfPage["boxes"]>();
  for (const match of info.matchAll(/^Page\s+(\d+)\s+(MediaBox|TrimBox|BleedBox|CropBox):\s+(.+)$/gm)) {
    const values = (match[3] ?? "").trim().split(/\s+/).map(Number);
    if (values.length !== 4 || values.some((v) => !Number.isFinite(v))) continue;
    const page = Number(match[1]);
    out.set(page, { ...out.get(page), [match[2] as "MediaBox"]: values as Box });
  }
  return out;
}

function parseFonts(listing: string): PdfPage["fonts"] {
  return listing
    .split("\n")
    .slice(2)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const cells = line.trim().split(/\s+/);
      const emb = cells.findIndex((c, i) => i >= 2 && (c === "yes" || c === "no"));
      return { embedded: cells[emb] === "yes", name: cells[0] ?? "", type: cells.slice(1, Math.max(emb - 1, 2)).join(" ") };
    });
}

function parseImages(listing: string): Map<number, PdfPage["images"]> {
  const out = new Map<number, PdfPage["images"]>();
  for (const line of listing.split("\n").slice(2)) {
    const cells = line.trim().split(/\s+/);
    if (cells.length < 14 || cells[2] !== "image") continue;
    const page = Number(cells[0]);
    out.set(page, [...(out.get(page) ?? []), { colour: cells[5] ?? "", xPpi: Number(cells[12]), yPpi: Number(cells[13]) }]);
  }
  return out;
}

function header(info: string, name: string): string {
  return new RegExp(`^${name}:\\s*(.*)$`, "m").exec(info)?.[1]?.trim() ?? "";
}

const DELIMITERS = "()<>[]{}/%";
const isSpace = (c: string) => c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f" || c === "\0";
const isNumber = (token: string) => /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token);

/** Index after a literal string that opens at `from`, honouring nesting and escapes. */
function skipLiteral(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return text.length;
}

function endOfWord(text: string, from: number): number {
  let j = from;
  while (j < text.length && !isSpace(text[j] ?? "") && !DELIMITERS.includes(text[j] ?? "")) j++;
  return j;
}

function endOfLine(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\r" && text[i + 1] === "\n") return i + 2;
    if (text[i] === "\n" || text[i] === "\r") return i + 1;
  }
  return text.length;
}

function endOfAngle(text: string, from: number): number {
  if (text[from + 1] === "<") return from + 2;
  const at = text.indexOf(">", from);
  return at < 0 ? text.length : at + 1;
}

/** Index after a non-token construct that opens at `from` (comment, string, name, whitespace), or -1 when it is a token. */
function skipNonToken(text: string, from: number): number {
  const c = text[from] ?? "";
  if (isSpace(c)) return from + 1;
  if (c === "%") return endOfLine(text, from);
  if (c === "(") return skipLiteral(text, from);
  if (c === "<") return endOfAngle(text, from);
  if (c === "/") return endOfWord(text, from + 1);
  return -1;
}

/** Content-stream tokens that matter here: numbers and bare operators; strings, names, comments and inline image data are skipped. */
function* operatorTokens(text: string): Generator<string> {
  let i = 0;
  while (i < text.length) {
    const skipped = skipNonToken(text, i);
    if (skipped >= 0) {
      i = skipped;
      continue;
    }
    const c = text[i] ?? "";
    const end = DELIMITERS.includes(c) ? i + 1 : endOfWord(text, i);
    const token = text.slice(i, end);
    i = end;
    yield token;
    if (token === "ID") i = skipInlineImage(text, i);
  }
}

function skipInlineImage(text: string, from: number): number {
  const end = text.indexOf("EI", from);
  return end < 0 ? text.length : end + 2;
}

const COLOUR_ARITY: Record<string, { space: keyof ContentColours; operands: number }> = {
  G: { operands: 1, space: "gray" },
  K: { operands: 4, space: "cmyk" },
  RG: { operands: 3, space: "rgb" },
  g: { operands: 1, space: "gray" },
  k: { operands: 4, space: "cmyk" },
  rg: { operands: 3, space: "rgb" },
};

function colourOperators(content: string): ContentColours {
  const found: ContentColours = { cmyk: 0, gray: 0, rgb: 0 };
  let numbers = 0;
  for (const token of operatorTokens(content)) {
    if (isNumber(token)) {
      numbers++;
      continue;
    }
    const colour = COLOUR_ARITY[token];
    if (colour !== undefined && numbers >= colour.operands) found[colour.space]++;
    numbers = 0;
  }
  return found;
}

const IMAGE_FILTERS = new Set(["DCTDecode", "DCT", "JPXDecode", "CCITTFaxDecode", "CCF", "JBIG2Decode"]);
const FILTER_NAMES: Record<string, string> = { A85: "ASCII85Decode", AHx: "ASCIIHexDecode", Fl: "FlateDecode", LZW: "LZWDecode", RL: "RunLengthDecode" };

/** The text with PDF comments removed, so a name inside a comment is never read as part of a dictionary or array. */
function withoutComments(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    const end = c === "%" ? endOfLine(text, i) : c === "(" ? skipLiteral(text, i) : i + 1;
    out += c === "%" ? " " : text.slice(i, end);
    i = end;
  }
  return out;
}

function pdfName(name: string): string {
  return name.replace(/#([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** End of one PDF value, including nested containers and indirect references. */
function valueEnd(text: string, from: number): number {
  if (text[from] === "(") return skipLiteral(text, from);
  if (text[from] === "<" && text[from + 1] !== "<") return endOfAngle(text, from);
  const close = text.startsWith("<<", from) ? ">>" : text[from] === "[" ? "]" : undefined;
  if (close === undefined) {
    const reference = /^\d+\s+\d+\s+R\b/.exec(text.slice(from));
    return reference === null ? endOfWord(text, from + (text[from] === "/" ? 1 : 0)) : from + reference[0].length;
  }
  return containerEnd(text, from, close);
}

function containerEnd(text: string, from: number, close: string): number {
  let at = from + (close === ">>" ? 2 : 1);
  while (at < text.length && !text.startsWith(close, at)) {
    if (isSpace(text[at] ?? "")) at++;
    else if (text[at] === "%") at = endOfLine(text, at);
    else {
      const next = valueEnd(text, at);
      at = Math.max(next, at + 1);
    }
  }
  return at + close.length;
}

/** Only actual stream keys classify it; resource values and strings are never keys. */
function streamKeys(dictionary: string): Map<string, string> {
  const out = new Map<string, string>();
  dictionary = dictionary.trim();
  if (!dictionary.startsWith("<<")) throw new InputError("PDF stream dictionary cannot be located; colour cannot be checked.");
  let at = 2;
  while (at < dictionary.length && !dictionary.startsWith(">>", at)) {
    if (isSpace(dictionary[at] ?? "")) { at++; continue; }
    if (dictionary[at] !== "/") throw new InputError("PDF stream dictionary has an unreadable key; colour cannot be checked.");
    const end = endOfWord(dictionary, at + 1);
    const key = pdfName(dictionary.slice(at + 1, end));
    at = end;
    while (isSpace(dictionary[at] ?? "")) at++;
    const next = valueEnd(dictionary, at);
    const value = dictionary.slice(at, next);
    out.set(key, value);
    at = Math.max(next, at + 1);
  }
  if (!dictionary.startsWith(">>", at) || dictionary.slice(at + 2).trim() !== "") throw new InputError("PDF stream dictionary was not read to its end; colour cannot be checked.");
  return out;
}

type XrefEntry = { generation: number; position: number | null };
type XrefIndex = { entries: Map<number, XrefEntry>; next: number | undefined; seen: Set<number> };
type PdfFile = { bytes: Buffer; text: string; xref?: XrefIndex };

/** Index each xref row once. Newer entries, including free entries, mask older revisions. */
function xrefRows(text: string, from: number, first: number, count: number, entries: Map<number, XrefEntry>): number {
  if (!Number.isSafeInteger(count) || count > text.length) throw new InputError("PDF cross-reference count is unreadable; colour cannot be checked.");
  for (let index = 0; index < count; index++) {
    const row = /^(\d+)[ \t]+(\d+)[ \t]+([nf])[ \t]*(?:\r\n|\n|\r)/.exec(text.slice(from, endOfLine(text, from)));
    if (row === null) throw new InputError("PDF cross-reference row is unreadable; colour cannot be checked.");
    if (!entries.has(first + index)) entries.set(first + index, { generation: Number(row[2]), position: row[3] === "n" ? Number(row[1]) : null });
    from += row[0].length;
  }
  return from;
}

function xrefTable(text: string, from: number, entries: Map<number, XrefEntry>): number | undefined {
  if (!Number.isSafeInteger(from) || !text.startsWith("xref", from)) throw new InputError("PDF indirect Length needs a readable classic cross-reference table; colour cannot be checked.");
  from += 4;
  for (;;) {
    from = afterTrivia(text, from);
    if (text.startsWith("trailer", from)) {
      const start = afterTrivia(text, from + 7);
      const trailer = streamKeys(withoutComments(text.slice(start, valueEnd(text, start))));
      const previous = trailer.get("Prev");
      return previous !== undefined && /^\d+$/.test(previous) ? Number(previous) : undefined;
    }
    const section = /^(\d+)\s+(\d+)\s+/.exec(text.slice(from));
    if (section === null) throw new InputError("PDF cross-reference subsection is unreadable; colour cannot be checked.");
    from = xrefRows(text, from + section[0].length, Number(section[1]), Number(section[2]), entries);
  }
}

/** Cache complete tables on demand; a current entry never needs an older Prev table. */
function xrefEntry(file: PdfFile, id: number): XrefEntry | undefined {
  if (file.xref === undefined) {
    const start = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(file.text);
    file.xref = { entries: new Map(), next: start === null ? undefined : Number(start[1]), seen: new Set() };
  }
  const index = file.xref;
  while (!index.entries.has(id) && index.next !== undefined && !index.seen.has(index.next)) {
    index.seen.add(index.next);
    index.next = xrefTable(file.text, index.next, index.entries);
  }
  return index.entries.get(id);
}

/** Resolve indirect Length using one per-document xref index and the shared file text. */
function objectBody(file: PdfFile, id: string, generation: string): string | undefined {
  const text = file.text;
  const entry = xrefEntry(file, Number(id));
  if (entry === undefined || entry.position === null || entry.generation !== Number(generation)) return undefined;
  const header = new RegExp(`^${id}\\s+${generation}\\s+obj\\b`).exec(text.slice(entry.position));
  if (header === null) return undefined;
  const from = afterTrivia(text, entry.position + header[0].length);
  const end = valueEnd(text, from);
  return /^endobj\b/.test(text.slice(afterTrivia(text, end))) ? withoutComments(text.slice(from, end)) : undefined;
}

/** Replaces each indirect reference in `value` by the body of the object it names; one that cannot be read fails closed. */
function resolveReferences(value: string, bodies: Map<string, string>, depth = 0): string {
  return value.replace(/(\d+)\s+(\d+)\s+R\b/g, (_, id: string, generation: string) => {
    const body = depth > 4 ? undefined : bodies.get(`${id} ${generation}`);
    if (body === undefined) throw new InputError(`PDF object ${id} ${generation} R names a stream filter but is not readable, so the stream's colour operators cannot be checked.`);
    return resolveReferences(body, bodies, depth + 1);
  });
}

/** Filter names of a stream dictionary, in application order, with abbreviations expanded and indirect values followed. */
function filtersOf(dictionary: Map<string, string>, bodies: Map<string, string>): string[] {
  const raw = dictionary.get("Filter") ?? dictionary.get("F");
  if (raw === undefined) return [];
  const value = resolveReferences(raw, bodies).trim();
  const names = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (!/^(?:\s*\/[^\s/<>[\]()%]+\s*)*$/.test(names)) throw new InputError("PDF stream has a /Filter this reader cannot parse, so its colour operators cannot be checked.");
  return [...names.matchAll(/\/([^\s/<>[\]()%]+)/g)].map((m) => FILTER_NAMES[pdfName(m[1] ?? "")] ?? pdfName(m[1] ?? ""));
}

function ascii85(text: string): Buffer {
  const body = text.replace(/\s+/g, "").replace(/^<~/, "").replace(/~>.*$/s, "");
  const out: number[] = [];
  let group: number[] = [];
  const flush = (count: number) => {
    const padded = [...group, ...Array(5 - group.length).fill(84)];
    let value = 0;
    for (const digit of padded) value = value * 85 + digit;
    for (let i = 0; i < count; i++) out.push(Math.floor(value / 256 ** (3 - i)) % 256);
  };
  for (const char of body) {
    if (char === "z" && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    group.push(char.charCodeAt(0) - 33);
    if (group.length === 5) {
      flush(4);
      group = [];
    }
  }
  if (group.length > 1) flush(group.length - 1);
  return Buffer.from(out);
}

function runLength(bytes: Buffer): Buffer {
  const out: Buffer[] = [];
  for (let i = 0; i < bytes.length; ) {
    const length = bytes[i] ?? 128;
    if (length === 128) break;
    if (length < 128) {
      out.push(bytes.subarray(i + 1, i + 2 + length));
      i += length + 2;
    } else {
      out.push(Buffer.alloc(257 - length, bytes[i + 1] ?? 0));
      i += 2;
    }
  }
  return Buffer.concat(out);
}

function inflate(bytes: Buffer): Buffer {
  try {
    return inflateSync(bytes);
  } catch {
    return Buffer.from(Bun.inflateSync(new Uint8Array(bytes)));
  }
}

function applyFilter(name: string, bytes: Buffer): Buffer {
  if (name === "FlateDecode") return inflate(bytes);
  if (name === "ASCIIHexDecode") return Buffer.from(bytes.toString("latin1").replace(/>.*$/s, "").replace(/\s+/g, "").padEnd(2 * Math.ceil(bytes.length / 2), "0"), "hex");
  if (name === "ASCII85Decode") return ascii85(bytes.toString("latin1"));
  if (name === "RunLengthDecode") return runLength(bytes);
  throw new InputError(`PDF stream filter ${name} cannot be decoded, so its colour operators cannot be checked.`);
}

/** Decoded stream text, or undefined for image data the colour operators do not live in. A filter that cannot be read fails closed. */
function decoded(dictionary: Map<string, string>, bytes: Buffer, bodies: Map<string, string>, content: boolean): string | undefined {
  const filters = filtersOf(dictionary, bodies);
  if (!content && filters.some((name) => IMAGE_FILTERS.has(name))) return undefined;
  if (!content && pdfName(dictionary.get("Subtype") ?? "") === "/Image") return undefined;
  try {
    return filters.reduce((data, name) => applyFilter(name, data), bytes).toString("latin1");
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(`PDF stream (${filters.join(", ")}) could not be decoded, so its colour operators cannot be checked.`);
  }
}

/** Finds object headers as tokens, never inside names, strings or comments. Stream bytes are skipped by the caller. */
function nextObject(text: string, from: number): { key: string; start: number } | undefined {
  const previous: string[] = [];
  for (let at = from; at < text.length; ) {
    const skipped = skipNonToken(text, at);
    if (skipped >= 0) { at = skipped; continue; }
    const end = DELIMITERS.includes(text[at] ?? "") ? at + 1 : endOfWord(text, at);
    const token = text.slice(at, end);
    if (token === "obj" && previous.length === 2 && previous.every((value) => /^\d+$/.test(value))) return { key: previous.join(" "), start: end };
    previous.push(token);
    if (previous.length > 2) previous.shift();
    at = end;
  }
  return undefined;
}

type DictionaryObject = { key: string; dictionary: Map<string, string>; body: string; bytes?: Buffer };

function afterTrivia(text: string, from: number): number {
  while (from < text.length) {
    if (isSpace(text[from] ?? "")) from++;
    else if (text[from] === "%") from = endOfLine(text, from);
    else break;
  }
  return from;
}

/** Walks plain dictionary objects in file order, cutting streams before tokenizing the next object. */
function dictionaryObjects(file: PdfFile): DictionaryObject[] {
  const text = file.text;
  const objects: DictionaryObject[] = [];
  let from = 0;
  for (;;) {
    const object = nextObject(text, from);
    if (object === undefined) return objects;
    from = afterTrivia(text, object.start);
    const rawEnd = valueEnd(text, from);
    const body = withoutComments(text.slice(from, rawEnd));
    if (!text.startsWith("<<", from)) {
      objects.push({ body, dictionary: new Map(), key: object.key });
      from = Math.max(rawEnd, from + 1);
      continue;
    }
    const dictionary = streamKeys(body);
    from = afterTrivia(text, rawEnd);
    const marker = /^stream(?:\r\n|\n|\r)/.exec(text.slice(from));
    if (marker === null) { objects.push({ body, dictionary, key: object.key }); continue; }
    const start = from + marker[0].length;
    const end = streamEnd(file, dictionary, start);
    if (end < 0) throw new InputError("PDF stream has no readable end; colour cannot be checked.");
    objects.push({ body, bytes: file.bytes.subarray(start, end), dictionary, key: object.key });
    from = text.indexOf("endstream", end) + "endstream".length;
  }
}

/** Page Contents can name a stream directly or an indirect array of stream references. */
function contentReferences(value: string, bodies: Map<string, string>, depth = 0): string[] {
  if (depth > 4) throw new InputError("PDF page Contents reference nesting cannot be read; colour cannot be checked.");
  return [...value.matchAll(/(\d+)\s+(\d+)\s+R\b/g)].flatMap((match) => {
    const id = match[1] ?? "";
    const generation = match[2] ?? "";
    const body = bodies.get(`${id} ${generation}`)?.trim();
    return body?.startsWith("[") ? contentReferences(body, bodies, depth + 1) : [`${id} ${generation}`];
  });
}

/** Streams that carry fonts, images, profiles, tables or structure, never page content, told by their dictionary. */
function nonContent(dictionary: Map<string, string>): boolean {
  const type = pdfName(dictionary.get("Type") ?? "");
  const subtype = pdfName(dictionary.get("Subtype") ?? "");
  return ["/XRef", "/ObjStm", "/Metadata", "/EmbeddedFile", "/CMap"].includes(type)
    || ["/Image", "/Type1C", "/CIDFontType0C", "/OpenType", "/XML"].includes(subtype)
    || ["Length1", "Length2", "Length3", "FunctionType", "ShadingType", "N"].some((key) => /^\d/.test(dictionary.get(key) ?? ""));
}

/** Declared /Length of a stream, direct or through an indirect object, or undefined when it cannot be read. */
function declaredLength(dictionary: Map<string, string>, file: PdfFile): number {
  const raw = dictionary.get("Length") ?? "";
  const indirect = /^(\d+)\s+(\d+)\s+R$/.exec(raw);
  const value = indirect === null ? raw : objectBody(file, indirect[1] ?? "", indirect[2] ?? "")?.trim();
  if (value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InputError("PDF stream Length is unreadable; colour cannot be checked.");
  return Number(value);
}

/** Stream boundaries require the declared length; unreadable boundaries are never treated as absent colour. */
function streamEnd(file: PdfFile, dictionary: Map<string, string>, start: number): number {
  const length = declaredLength(dictionary, file);
  const text = file.text;
  const marker = afterTrivia(text, start + length);
  if (/^endstream\b/.test(text.slice(marker)) && /^endobj\b/.test(text.slice(afterTrivia(text, marker + 9)))) return start + length;
  throw new InputError("PDF stream Length does not end at endstream and endobj; colour cannot be checked.");
}

/**
 * Counts device colour operators in every content stream of the file.
 * Poppler lists only images, so text and vector ink would otherwise go unread.
 * Streams are cut at their declared length, so `endstream` inside a string or compressed bytes does not end one early.
 * The count is document-wide, not per page; ICC-based operators (sc, scn) are not resolved.
 */
function readContentColours(path: string): ContentColours {
  const bytes = readFileSync(path);
  const file: PdfFile = { bytes, text: bytes.toString("latin1") };
  const total: ContentColours = { cmyk: 0, gray: 0, rgb: 0 };
  const objects = dictionaryObjects(file);
  const bodies = new Map(objects.map(object => [object.key, object.body]));
  if (objects.some((object) => pdfName(object.dictionary.get("Type") ?? "") === "/ObjStm")) throw new InputError("PDF object streams hide page Contents membership from this reader; colour cannot be checked.");
  const contentIds = new Set(objects.filter((object) => pdfName(object.dictionary.get("Type") ?? "") === "/Page").flatMap((object) => contentReferences(object.dictionary.get("Contents") ?? "", bodies)));
  const streamIds = new Set(objects.filter(object => object.bytes !== undefined).map(object => object.key));
  for (const key of contentIds) if (!streamIds.has(key)) throw new InputError(`PDF page Contents ${key} R is unreadable; colour cannot be checked.`);
  for (const object of objects) {
    if (object.bytes === undefined) continue;
    const content = contentIds.has(object.key) || pdfName(object.dictionary.get("Subtype") ?? "") === "/Form";
    if (!content && nonContent(object.dictionary)) continue;
    const decodedContent = decoded(object.dictionary, object.bytes, bodies, content);
    if (decodedContent === undefined) continue;
    const found = colourOperators(decodedContent);
    total.cmyk += found.cmyk;
    total.gray += found.gray;
    total.rgb += found.rgb;
  }
  return total;
}

/** Reads page count, boxes, fonts, image colour/PPI and text via poppler. */
export function readPdf(path: string): PdfFacts {
  const first = tool("pdfinfo", [path]);
  const pages = Number(header(first, "Pages"));
  if (!Number.isInteger(pages) || pages < 1) throw new InputError(`${path} has no readable page count.`);
  const boxes = parseBoxes(tool("pdfinfo", ["-box", "-f", "1", "-l", String(pages), path]));
  const images = parseImages(tool("pdfimages", ["-list", "-f", "1", "-l", String(pages), path]));
  const readback = Array.from({ length: pages }, (_, i) => {
    const page = i + 1;
    const range = ["-f", String(page), "-l", String(page)];
    return {
      boxes: boxes.get(page) ?? {},
      fonts: parseFonts(tool("pdffonts", [...range, path])),
      images: images.get(page) ?? [],
      page,
      text: tool("pdftotext", [...range, "-layout", path, "-"]),
    };
  });
  return { contentColours: readContentColours(path), pages, producer: header(first, "Producer"), readback, tagged: header(first, "Tagged") === "yes", version: header(first, "PDF version") };
}
