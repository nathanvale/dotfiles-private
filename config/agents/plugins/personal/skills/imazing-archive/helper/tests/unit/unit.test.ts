import { expect, test } from "bun:test";
import { ExportFormatError, parseCsv, readExport } from "../../src/csv.ts";
import { parseOptions } from "../../src/engine.ts";
import type { AttachmentFile, ExportRow } from "../../src/model.ts";
import { resolveAttachments } from "../../src/planner.ts";

test("quoted CSV fields keep commas, vertical bars, quotes, and newlines", () => {
  const text = 'a,b\r\n"x, y | z","line one\nline ""two"""\r\n';
  expect(parseCsv(text)).toEqual([
    ["a", "b"],
    ["x, y | z", 'line one\nline "two"'],
  ]);
});

test("an export with a BOM is read as the 15-column variant without IDs", () => {
  const text =
    "﻿Chat Session,Message Date,Delivered Date,Read Date,Edited Date,Service,Type,Sender ID,Sender Name,Status,Replying to,Subject,Text,Attachment,Attachment type\n" +
    'Robin,2023-10-21 09:00:00,,,,iMessage,Outgoing,,,Read,,,hi,"a, b | c.png",Image\n';
  const parsed = readExport(text);
  expect(parsed.variant).toBe("imazing-15");
  expect(parsed.chatSession).toBe("Robin");
  expect(parsed.rows).toEqual([
    expect.objectContaining({
      attachment: "a, b | c.png",
      deletedDate: null,
      direction: "outgoing",
      messageId: null,
      reactions: null,
      row: 1,
    }),
  ]);
});

test.each([
  ["an unknown header", "Chat Session,Text\nRobin,hi\n"],
  [
    "a short row",
    "Chat Session,Message Date,Delivered Date,Read Date,Edited Date,Service,Type,Sender ID,Sender Name,Status,Replying to,Subject,Text,Attachment,Attachment type\nRobin,2023-10-21 09:00:00\n",
  ],
])("%s refuses as an export format error", (_case, text) => {
  expect(() => readExport(text)).toThrow(ExportFormatError);
});

function row(number: number, attachment: string, text = ""): ExportRow {
  return {
    attachment,
    attachmentType: attachment === "" ? "" : "Image",
    deletedDate: null,
    deliveredDate: "",
    direction: "incoming",
    editedDate: "",
    messageDate: "2024-01-02 03:04:05",
    messageId: null,
    reactions: null,
    readDate: "",
    replyingTo: "",
    row: number,
    senderId: "",
    senderName: "",
    service: "iMessage",
    status: "",
    text,
  };
}

function file(name: string, sha: string): AttachmentFile {
  return {
    exportedName: name,
    relativePath: `2024-01-02 03 04 05 - Robin - ${name}`,
    sha256: sha.repeat(64),
    size: 1,
    timestamp: "2024-01-02 03 04 05",
  };
}

test("attachment names resolve exactly, by 40-character truncation, and by suffix", () => {
  const long = `${"n".repeat(45)}.m4a`;
  const resolution = resolveAttachments(
    [row(1, "a.png"), row(2, long), row(3, "same.PNG"), row(4, "gone.png")],
    [
      file("a.png", "a"),
      file(`${"n".repeat(40)}.m4a`, "b"),
      file("same 1.png", "c"),
      file("same 2.PNG", "c"),
      file("unrelated.png", "d"),
    ],
  );
  expect(
    [1, 2, 3, 4].map((number) => {
      const cell = resolution.cells.get(number);
      return [cell?.status, cell?.strategy, cell?.candidates.length];
    }),
  ).toEqual([
    ["resolved", "exact", 1],
    ["resolved", "variant-name", 1],
    ["resolved", "variant-name", 2],
    ["missing", "none", 0],
  ]);
  expect(resolution.unreferenced).toEqual([
    "2024-01-02 03 04 05 - Robin - unrelated.png",
  ]);
});

test("candidates with different bytes are ambiguous, never picked", () => {
  const resolution = resolveAttachments(
    [row(1, "dup.png")],
    [file("dup.png", "a"), file("dup 1.png", "b")],
  );
  expect(resolution.cells.get(1)).toMatchObject({
    file: null,
    status: "ambiguous",
  });
});

test("a web link file needs exactly one same-second row with a URL", () => {
  const link = file("Web link.url", "e");
  const one = resolveAttachments([row(1, "", "see https://x.test")], [link]);
  expect(one.webLinks.resolved.map((entry) => entry.row)).toEqual([1]);
  const two = resolveAttachments(
    [row(1, "", "https://a.test"), row(2, "", "https://b.test")],
    [link],
  );
  expect(two.webLinks.ambiguous).toEqual([
    { file: link.relativePath, rows: [1, 2] },
  ]);
});

test.each([
  [["--archive", "a", "--preview"], { archive: "a", preview: true }],
  [["--preview", "--archive", "a"], { archive: "a", preview: true }],
] as const)("options accept the supported shape %#", (args, expected) => {
  expect(parseOptions(args, ["archive"], ["preview"])).toEqual(expected);
});

test.each([
  [["--archive"]],
  [["--archive", "--preview"]],
  [["--archive", "a", "--archive", "b"]],
  [["--preview", "--preview"]],
  [["--unknown", "x"]],
  [["extra"]],
] as const)("options reject an unsupported shape %#", (args) => {
  expect(parseOptions(args, ["archive"], ["preview"])).toBeNull();
});
