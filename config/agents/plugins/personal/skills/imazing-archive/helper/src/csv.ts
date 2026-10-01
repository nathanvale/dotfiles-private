import type { Direction, ExportRow, ParsedExport, Variant } from "./model.ts";

const SHARED_HEAD = [
  "Chat Session",
  "Message ID",
  "Message Date",
  "Delivered Date",
  "Read Date",
  "Edited Date",
  "Deleted Date",
  "Service",
  "Type",
  "Sender ID",
  "Sender Name",
  "Status",
  "Replying to",
  "Subject",
  "Text",
  "Reactions",
  "Attachment",
  "Attachment type",
];
const OPTIONAL_IN_OLD = new Set(["Message ID", "Deleted Date", "Reactions"]);
const HEADERS: Record<Variant, string[]> = {
  "imazing-15": SHARED_HEAD.filter((name) => !OPTIONAL_IN_OLD.has(name)),
  "imazing-18": SHARED_HEAD,
};
const DIRECTIONS: Record<string, Direction> = {
  Incoming: "incoming",
  Notification: "notification",
  Outgoing: "outgoing",
};

export class ExportFormatError extends Error {}

class CsvReader {
  readonly records: string[][] = [];
  private record: string[] = [];
  private field = "";
  private quoted = false;
  /** A quoted field has closed; only a delimiter may follow. */
  private closed = false;

  /** Consumes one character; returns how many extra characters it used. */
  read(character: string, next: string): number {
    if (this.quoted) return this.readQuoted(character, next);
    if (character === ",") this.endField();
    else if (character === "\n" || character === "\r") {
      this.endRecord();
      return character === "\r" && next === "\n" ? 1 : 0;
    } else this.readUnquoted(character);
    return 0;
  }

  private readUnquoted(character: string): void {
    if (this.closed) this.malformed("text follows a closing quote");
    if (character !== '"') this.field += character;
    else if (this.field === "") this.quoted = true;
    else this.malformed("a quote follows unquoted text");
  }

  private readQuoted(character: string, next: string): number {
    if (character !== '"') {
      this.field += character;
      return 0;
    }
    if (next === '"') {
      this.field += '"';
      return 1;
    }
    this.quoted = false;
    this.closed = true;
    return 0;
  }

  /** Rows count from 0 for the header, matching data-row numbering. */
  private malformed(detail: string): never {
    throw new ExportFormatError(
      `Row ${this.records.length} column ${this.record.length + 1} has malformed quoting: ${detail}.`,
    );
  }

  private endField(): void {
    this.record.push(this.field);
    this.field = "";
    this.closed = false;
  }

  private endRecord(): void {
    this.endField();
    this.records.push(this.record);
    this.record = [];
  }

  finish(): string[][] {
    if (this.quoted) {
      throw new ExportFormatError("The CSV ends inside a quoted field.");
    }
    if (this.field !== "" || this.record.length > 0) this.endRecord();
    return this.records;
  }
}

/** RFC 4180 records; quoted fields keep commas, bars, and newlines. */
export function parseCsv(text: string): string[][] {
  const reader = new CsvReader();
  for (let index = 0; index < text.length; index += 1) {
    index += reader.read(text.charAt(index), text.charAt(index + 1));
  }
  return reader.finish();
}

function detectVariant(header: string[]): Variant {
  const joined = header.join("\u001f");
  for (const variant of Object.keys(HEADERS) as Variant[]) {
    if (HEADERS[variant].join("\u001f") === joined) return variant;
  }
  throw new ExportFormatError(
    "The CSV header matches neither supported iMazing variant.",
  );
}

function normalise(
  cells: string[],
  header: string[],
  row: number,
  hasIds: boolean,
): ExportRow {
  const cell = (name: string) => cells[header.indexOf(name)] ?? "";
  const direction = DIRECTIONS[cell("Type")];
  if (direction === undefined) {
    throw new ExportFormatError(`Row ${row} has an unknown message Type.`);
  }
  const messageId = hasIds ? cell("Message ID") : null;
  if (messageId === "") {
    throw new ExportFormatError(`Row ${row} has an empty Message ID.`);
  }
  return {
    attachment: cell("Attachment"),
    attachmentType: cell("Attachment type"),
    deletedDate: hasIds ? cell("Deleted Date") || null : null,
    deliveredDate: cell("Delivered Date"),
    direction,
    editedDate: cell("Edited Date"),
    messageDate: cell("Message Date"),
    messageId,
    reactions: hasIds ? cell("Reactions") || null : null,
    readDate: cell("Read Date"),
    replyingTo: cell("Replying to"),
    row,
    senderId: cell("Sender ID"),
    senderName: cell("Sender Name"),
    service: cell("Service"),
    status: cell("Status"),
    text: cell("Text"),
  };
}

const MESSAGE_DATE = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;

export function readExport(text: string): ParsedExport {
  const records = parseCsv(text.replace(/^\uFEFF/, ""));
  const header = records[0];
  if (header === undefined) throw new ExportFormatError("The CSV is empty.");
  const variant = detectVariant(header);
  const chats = new Set<string>();
  const rows = records.slice(1).map((cells, index) => {
    const row = index + 1;
    if (cells.length !== header.length) {
      throw new ExportFormatError(`Row ${row} has ${cells.length} fields.`);
    }
    chats.add(cells[0] ?? "");
    const normalised = normalise(cells, header, row, variant === "imazing-18");
    if (!MESSAGE_DATE.test(normalised.messageDate)) {
      throw new ExportFormatError(`Row ${row} has an invalid Message Date.`);
    }
    return normalised;
  });
  const [chatSession, ...others] = [...chats];
  if (chatSession === undefined || chatSession === "" || others.length > 0) {
    throw new ExportFormatError("The CSV must hold exactly one Chat Session.");
  }
  return { chatSession, rows, variant };
}

function quote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function toCsv(header: string[], rows: string[][]): string {
  return [header, ...rows]
    .map((row) => `${row.map(quote).join(",")}\n`)
    .join("");
}
