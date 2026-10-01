import { expect, test } from "bun:test";
import { ExportFormatError, parseCsv, readExport } from "../../src/csv.ts";
import { parseOptions } from "../../src/engine.ts";
import type { AttachmentFile, ExportRow, ParsedExport } from "../../src/model.ts";
import {
  emptyState,
  foldRecords,
  planImport,
  resolveAttachments,
} from "../../src/planner.ts";

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

test.each([
  ["a quote after unquoted text", 'a,b\nfoo"bar",x\n', "Row 1 column 1"],
  ["text after a closing quote", 'a,b\nx,"foo"bar\n', "Row 1 column 2"],
  ["a space after a closing quote", 'a,b\r\n"x" ,y\r\n', "Row 1 column 1"],
])("%s refuses with its row and column instead of altering the text", (_case, text, where) => {
  expect(() => parseCsv(text)).toThrow(ExportFormatError);
  expect(() => parseCsv(text)).toThrow(where);
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

// Independent oracle: the archive start date the original brief names.
const START = "2023-10-15";

function oldExport(rows: ExportRow[]): ParsedExport {
  return { chatSession: "Robin", rows, variant: "imazing-15" };
}

test("a fingerprint repeated within one old-variant export is held, not minted", () => {
  const planned = planImport(
    emptyState(),
    oldExport([row(1, "", "ha"), row(2, "", "ha")]),
    "a".repeat(64),
    [],
    START,
  );
  expect(planned.plan.items).toEqual([]);
  expect(planned.summary.observations).toMatchObject({
    "ambiguous-fingerprint": 2,
    "fingerprint-new": 0,
  });
  expect(planned.summary.lists.ambiguousMessages).toEqual([
    { candidates: [], row: 1 },
    { candidates: [], row: 2 },
  ]);
});

test("text differing only in line endings, Unicode form, or surrounding whitespace keeps one identity", () => {
  const first = planImport(
    emptyState(),
    oldExport([row(1, "", "caf\u00e9\nok")]),
    "a".repeat(64),
    [],
    START,
  );
  expect(first.plan.items).toHaveLength(1);
  const state = foldRecords(emptyState(), {
    ambiguities: [],
    associations: [],
    blobs: [],
    decisions: [],
    items: first.plan.items,
    observations: first.plan.observations,
  });
  const later = planImport(
    state,
    oldExport([row(1, "", " \tcafe\u0301 \r\nok\t\n")]),
    "b".repeat(64),
    [],
    START,
  );
  expect(later.summary.observations).toMatchObject({
    "fingerprint-match": 1,
    "fingerprint-new": 0,
  });
  expect(later.plan.items).toEqual([]);
});

test("rows and files dated before the start date are left out and counted, never planned", () => {
  const early = { ...row(1, "early.png"), messageDate: "2023-10-14 23:59:59" };
  const first = { ...row(2, "", "first day"), messageDate: "2023-10-15 00:00:00" };
  const earlyFile = {
    ...file("early.png", "e"),
    relativePath: "2023-10-14 23 59 59 - Robin - early.png",
    timestamp: "2023-10-14 23 59 59",
  };
  const planned = planImport(emptyState(), oldExport([early, first]), "a".repeat(64), [earlyFile], START);
  expect(planned.summary.beforeStart).toBe(1);
  expect(planned.plan.items.map((item) => item.text)).toEqual(["first day"]);
  expect(planned.plan.observations.map((observation) => observation.row)).toEqual([2]);
  expect(planned.plan.blobs).toEqual([]);
  expect(planned.summary.lists.unreferencedFiles).toEqual([]);
});
