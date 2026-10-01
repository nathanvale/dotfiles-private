import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Synthetic exports only: invented names, texts, and bytes.
const NEW_HEADER =
  "Chat Session,Message ID,Message Date,Delivered Date,Read Date,Edited Date,Deleted Date,Service,Type,Sender ID,Sender Name,Status,Replying to,Subject,Text,Reactions,Attachment,Attachment type";
const OLD_HEADER =
  "Chat Session,Message Date,Delivered Date,Read Date,Edited Date,Service,Type,Sender ID,Sender Name,Status,Replying to,Subject,Text,Attachment,Attachment type";

interface Message {
  attachment?: string;
  attachmentType?: string;
  date: string;
  deleted?: string;
  id: string;
  reactions?: string;
  text?: string;
  type: "Incoming" | "Outgoing";
}

export const MEME = "meme, final | v2.png";
export const LONG_AUDIO =
  "a_very_long_voice_note_name_that_iMazing_truncates.m4a";

// Message rows shared by both variants; the old variant drops `id`.
const MESSAGES: Message[] = [
  { date: "2023-10-21 09:00:00", id: "ID-A", text: "Hello there", type: "Outgoing" },
  { attachment: MEME, attachmentType: "Image", date: "2023-10-21 09:05:00", id: "ID-B", type: "Incoming" },
  { date: "2023-10-21 09:05:00", id: "ID-B", text: "Look, a meme", type: "Incoming" },
  { attachment: "photo.jpeg", attachmentType: "Image", date: "2023-10-22 10:00:00", id: "ID-C", type: "Outgoing" },
  { date: "2023-10-23 11:00:00", id: "ID-D", text: "see https://example.com/x", type: "Incoming" },
  { attachment: "IMG_0001.PNG", attachmentType: "Image", date: "2023-10-24 12:00:00", id: "ID-E", type: "Outgoing" },
  { attachment: "IMG_0001.PNG", attachmentType: "Image", date: "2023-10-24 12:00:00", id: "ID-E", type: "Outgoing" },
  { date: "2023-10-26 08:00:00", id: "ID-L", text: "ha", type: "Incoming" },
  { attachment: "lost.heic", attachmentType: "Image", date: "2023-10-27 07:00:00", id: "ID-I", type: "Incoming" },
  { date: "2023-10-28 06:00:00", id: "ID-M", text: "line one\nline two", type: "Outgoing" },
];

const NEW_ONLY: Message[] = [
  { attachment: "again.png", attachmentType: "Image", date: "2024-02-01 08:00:00", id: "ID-F", type: "Outgoing" },
  { date: "2024-02-02 09:00:00", deleted: "2024-02-02 10:00:00", id: "ID-G", text: "oops", type: "Outgoing" },
  { date: "2024-02-03 09:00:00", id: "ID-H", reactions: "Robin reacted with a heart", text: "lol", type: "Outgoing" },
  { attachment: LONG_AUDIO, attachmentType: "Audio", date: "2024-02-04 09:00:00", id: "ID-J", type: "Incoming" },
  { attachment: "dup.png", attachmentType: "Image", date: "2024-02-05 09:00:00", id: "ID-K", type: "Incoming" },
];

// One day before the archive start date of 2023-10-15, with its file.
const BEFORE_START: Message = { attachment: "early.png", attachmentType: "Image", date: "2023-10-14 23:59:59", id: "ID-Z", type: "Incoming" };

const OLD_ONLY: Message[] = [
  { date: "2023-10-25 18:00:00", id: "", text: "only in the old export", type: "Outgoing" },
  { date: "2023-10-26 08:00:00", id: "", text: "ha", type: "Incoming" },
];

function quote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

const ROBIN = "robin@example.test";

function senderOf(message: Message, senderId: string): string {
  return message.type === "Incoming" ? senderId : "";
}

// The new exporter writes CRLF inside texts and keeps trailing spaces.
function newText(text: string | undefined): string {
  return text?.includes("\n") ? `${text.replaceAll("\n", "\r\n")}  ` : (text ?? "");
}

function newRow(chat: string, message: Message): string {
  const sender = message.type === "Incoming" ? chat : "";
  return [chat, message.id, message.date, "", "", "", message.deleted ?? "", "iMessage", message.type, senderOf(message, ROBIN), sender, "Read", "", "", newText(message.text), message.reactions ?? "", message.attachment ?? "", message.attachmentType ?? ""]
    .map(quote)
    .join(",");
}

function oldRow(chat: string, message: Message, senderId: string): string {
  const sender = message.type === "Incoming" ? chat : "";
  return [chat, message.date, "", "", "", "iMessage", message.type, senderOf(message, senderId), sender, "Read", "", "", message.text ?? "", message.attachment ?? "", message.attachmentType ?? ""]
    .map(quote)
    .join(",");
}

function exported(chat: string, date: string, name: string): string {
  return `${date.replaceAll(":", " ")} - ${chat} - ${name}`;
}

export const BYTES = {
  dupA: "dup-bytes-one",
  dupB: "dup-bytes-two",
  early: "early-bytes",
  img: "same-bytes-sent-twice",
  link: "[InternetShortcut]\nURL=https://example.com/x\n",
  lost: "lost-photo-bytes",
  meme: "meme-bytes",
  photo: "photo-bytes",
  stray: "stray-bytes",
  voice: "voice-bytes",
};

async function put(root: string, path: string, text: string): Promise<void> {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), text);
}

/** New 18-column export: BOM, CRLF, Message IDs, attachments beside it. */
export async function writeNewExport(
  root: string,
  options: { beforeStart?: boolean } = {},
): Promise<string> {
  const chat = "Robin Example";
  const early = options.beforeStart === true ? [BEFORE_START] : [];
  const rows = [...MESSAGES, ...NEW_ONLY, ...early].map((message) => newRow(chat, message));
  const csv = join(root, "Messages - Robin Example.csv");
  await mkdir(root, { recursive: true });
  await writeFile(csv, `﻿${[NEW_HEADER, ...rows].join("\r\n")}\r\n`);
  await put(root, exported(chat, "2023-10-21 09:05:00", MEME), BYTES.meme);
  await put(root, join("sub", exported(chat, "2023-10-22 10:00:00", "photo.jpeg")), BYTES.photo);
  await put(root, exported(chat, "2023-10-23 11:00:00", "Web link.url"), BYTES.link);
  await put(root, exported(chat, "2023-10-24 12:00:00", "IMG_0001.PNG"), BYTES.img);
  await put(root, exported(chat, "2023-10-24 12:00:00", "IMG_0001 1.PNG"), BYTES.img);
  await put(root, exported(chat, "2024-02-01 08:00:00", "again.png"), BYTES.meme);
  await put(root, exported(chat, "2024-02-04 09:00:00", `${LONG_AUDIO.slice(0, 40)}.m4a`), BYTES.voice);
  await put(root, exported(chat, "2024-02-05 09:00:00", "dup.png"), BYTES.dupA);
  await put(root, exported(chat, "2024-02-05 09:00:00", "dup 1.png"), BYTES.dupB);
  await put(root, exported(chat, "2024-03-01 00:00:00", "stray.png"), BYTES.stray);
  await put(root, exported("Someone Else", "2024-03-01 00:00:00", "other.png"), BYTES.stray);
  if (options.beforeStart === true) {
    await put(root, exported(chat, BEFORE_START.date, "early.png"), BYTES.early);
  }
  return csv;
}

/** Old 15-column export: BOM, LF, no Message ID, separate attachments root. */
export async function writeOldExport(
  root: string,
  senderId = ROBIN,
): Promise<{ attachments: string; csv: string }> {
  const chat = "Robin";
  // One IMG_0001.PNG row against the new export's two: a fingerprint with two
  // archive candidates must stay ambiguous.
  const shared = MESSAGES.filter((_message, index) => index !== 6);
  const rows = [...shared, ...OLD_ONLY].map((message) => oldRow(chat, message, senderId));
  const csv = join(root, "csv", "Messages - Robin.csv");
  const attachments = join(root, "Attachments");
  await mkdir(join(root, "csv"), { recursive: true });
  await writeFile(csv, `﻿${[OLD_HEADER, ...rows].join("\n")}\n`);
  await put(attachments, exported(chat, "2023-10-21 09:05:00", MEME), BYTES.meme);
  await put(attachments, exported(chat, "2023-10-22 10:00:00", "photo.jpeg"), BYTES.photo);
  await put(attachments, exported(chat, "2023-10-27 07:00:00", "lost.heic"), BYTES.lost);
  return { attachments, csv };
}
