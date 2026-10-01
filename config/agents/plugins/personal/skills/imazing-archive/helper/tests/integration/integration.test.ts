import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseCsv, toCsv } from "../../src/csv.ts";
import { appendJournal } from "../../src/journal.ts";
import { BYTES, MEME, writeNewExport, writeOldExport } from "../fixtures/exports.ts";

const ROOT = resolve(import.meta.dir, "../..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function workspace(label: string) {
  const root = await mkdtemp(join(tmpdir(), `imazing-archive-${label}-`));
  roots.push(root);
  return {
    archive: join(root, "archive"),
    env: { IMAZING_ARCHIVE_STATE_DIR: join(root, "state") },
    root,
  };
}

function invoke(env: Record<string, string>, ...args: string[]) {
  const result = Bun.spawnSync(
    [process.execPath, "run", "src/cli.ts", ...args],
    { cwd: ROOT, env: { ...process.env, ...env }, stderr: "pipe", stdout: "pipe" },
  );
  const stdout = result.stdout.toString();
  return {
    exitCode: result.exitCode,
    json: () => JSON.parse(stdout),
    stderr: result.stderr.toString(),
    stdout,
  };
}

/** Preview, then apply with the previewed digest; returns both results. */
function importExport(
  env: Record<string, string>,
  archive: string,
  csv: string,
  attachments: string,
  ...extra: string[]
) {
  const source = ["--archive", archive, "--csv", csv, "--attachments", attachments, ...extra];
  const preview = invoke(env, "import", ...source, "--preview", "--json");
  expect(preview.exitCode).toBe(0);
  const digest = preview.json().result.data.planDigest;
  const apply = invoke(env, "import", ...source, "--plan", digest, "--json");
  expect(apply.stderr).toBe("");
  return { apply: apply.json().result, preview: preview.json().result };
}

async function csvRows(path: string): Promise<Record<string, string>[]> {
  const [header = [], ...rows] = parseCsv(await readFile(path, "utf8"));
  return rows.map((row) =>
    Object.fromEntries(header.map((name, index) => [name, row[index] ?? ""])),
  );
}

async function snapshot(archive: string, paths: string[]) {
  return Promise.all(paths.map((path) => readFile(join(archive, path), "utf8")));
}

const RECORD_FILES = [
  "records/items.jsonl",
  "records/observations.jsonl",
  "records/associations.jsonl",
  "records/blobs.jsonl",
  "records/decisions.jsonl",
];

test("help and discovery expose the supported routes", async () => {
  const { env } = await workspace("help");
  const help = invoke(env, "--help");
  expect(help.exitCode).toBe(0);
  expect(help.stderr).toBe("");
  expect(help.stdout).toContain("imazing-archive import --archive DIR --csv FILE --attachments DIR (--preview | --plan DIGEST)");
  const discovery = invoke(env, "--discover", "--json");
  expect(discovery.json().result.data.commands.map((command: { commandIdentity: string }) => command.commandIdentity)).toContain("imazing-archive.import");
});

test("preview writes nothing to the archive and its private receipt counts the new export", async () => {
  const { archive, env, root } = await workspace("preview");
  const exportRoot = join(root, "new");
  const csv = await writeNewExport(exportRoot);
  const before = await readFile(csv);
  const preview = invoke(env, "import", "--archive", archive, "--csv", csv, "--attachments", exportRoot, "--preview", "--json");

  expect(preview.exitCode).toBe(0);
  expect(preview.stderr).toBe("");
  expect(await Bun.file(join(archive, "archive.json")).exists()).toBe(false);
  expect(await readdir(archive).catch(() => null)).toBeNull();
  expect(await readFile(csv)).toEqual(before);
  const data = preview.json().result.data;
  expect(data).toMatchObject({
    attachmentRowResolution: { ambiguous: 1, missing: 1, resolved: 6 },
    attachmentRows: 8,
    chatFiles: 10,
    messageRows: 15,
    planned: {
      associations: { ambiguous: 1, missing: 1, resolved: 7 },
      blobs: 5,
      copyOriginal: true,
      items: 15,
    },
    variant: "imazing-18",
    webLinks: { ambiguous: 0, resolved: 1 },
  });
  const receipt = JSON.parse(await readFile(data.receiptPath, "utf8"));
  expect(data.receiptPath.startsWith(join(root, "state", "receipts"))).toBe(true);
  expect((await stat(data.receiptPath)).mode & 0o777).toBe(0o600);
  expect(receipt.attachmentsRoot).toMatchObject({ chatFiles: 10, totalFiles: 11 });
  expect(receipt.summary.lists.unreferencedFiles).toEqual(["2024-03-01 00 00 00 - Robin Example - stray.png"]);
  expect(receipt.summary.lists.missingAttachments).toEqual([{ cell: "lost.heic", row: 9, sameTimestampFiles: [] }]);
  expect(receipt.summary.lists.ambiguousAttachments).toEqual([
    { candidates: ["2024-02-05 09 00 00 - Robin Example - dup 1.png", "2024-02-05 09 00 00 - Robin Example - dup.png"], row: 15 },
  ]);
});

test("import, decide, and repeat imports of both variants preserve decisions and links", async () => {
  const { archive, env, root } = await workspace("repeat");
  const newRoot = join(root, "new");
  const newCsv = await writeNewExport(newRoot);
  const old = await writeOldExport(join(root, "old"));

  const first = importExport(env, archive, newCsv, newRoot);
  expect(first.apply).toMatchObject({ causeCode: "SUCCESS_COMPLETED", transactionState: "completed" });
  const sha = createHash("sha256").update(await readFile(newCsv)).digest("hex");
  expect(await readFile(join(archive, "originals", `${sha}-Messages - Robin Example.csv`))).toEqual(await readFile(newCsv));
  expect((await readdir(join(archive, "imports"))).length).toBe(1);
  const blobs = (await readFile(join(archive, "records/blobs.jsonl"), "utf8")).trim().split("\n");
  expect(blobs).toHaveLength(5);

  const messages = await csvRows(join(archive, "derived/messages.csv"));
  const meme = messages.find((row) => row.attachment_name === MEME);
  const again = messages.find((row) => row.attachment_name === "again.png");
  expect(meme?.blob_path).toBe(again?.blob_path);
  expect(meme?.attachment_status).toBe("resolved");
  expect(messages.find((row) => row.text === "oops")?.deleted_date).toBe("2024-02-02 10:00:00");
  expect(messages.find((row) => row.text === "lol")?.reactions).toBe("Robin reacted with a heart");
  expect(messages.filter((row) => row.attachment_name === "IMG_0001.PNG").map((row) => row.attachment_status)).toEqual(["resolved", "resolved"]);
  const pending = await csvRows(join(archive, "derived/pending-images.csv"));
  expect(pending).toHaveLength(5);

  const decided = invoke(env, "decide", "--archive", archive, "--item", meme?.item_key ?? "", "--image-type", "screenshot", "--contains-meme", "true", "--reviewed", "--album", "selected", "--json");
  expect(decided.exitCode).toBe(0);
  expect(await csvRows(join(archive, "derived/pending-images.csv"))).toHaveLength(4);
  const afterDecision = await snapshot(archive, RECORD_FILES);

  const repeat = importExport(env, archive, newCsv, newRoot);
  expect(repeat.preview.data.planned.observations).toBe(0);
  expect(repeat.apply).toMatchObject({ causeCode: "SUCCESS_UNCHANGED", transactionState: "unchanged" });
  expect(await snapshot(archive, RECORD_FILES)).toEqual(afterDecision);
  expect((await readdir(join(archive, "imports"))).length).toBe(1);

  const cross = importExport(env, archive, old.csv, old.attachments);
  expect(cross.preview.data.observations).toMatchObject({
    "ambiguous-fingerprint": 3,
    "fingerprint-match": 7,
    "fingerprint-new": 1,
  });
  expect(cross.apply.data.planned).toMatchObject({
    associations: { ambiguous: 0, missing: 0, resolved: 1 },
    blobs: 1,
    items: 1,
  });
  const afterCross = await snapshot(archive, RECORD_FILES);
  afterDecision.forEach((text, index) => {
    expect(afterCross[index]?.startsWith(text)).toBe(true);
  });
  const finalMessages = await csvRows(join(archive, "derived/messages.csv"));
  expect(finalMessages.find((row) => row.item_key === meme?.item_key)).toMatchObject({
    album_selection: "selected",
    contains_meme: "true",
    image_type: "screenshot",
    visual_review: "reviewed",
  });
  expect(finalMessages.find((row) => row.attachment_name === "lost.heic")?.attachment_status).toBe("resolved");
  expect(finalMessages).toHaveLength(16);
});

test("an old export imported first links later Message IDs by unique fingerprint only", async () => {
  const { archive, env, root } = await workspace("reverse");
  const newRoot = join(root, "new");
  const newCsv = await writeNewExport(newRoot);
  const old = await writeOldExport(join(root, "old"));

  const first = importExport(env, archive, old.csv, old.attachments);
  // The old export's two identical "ha" rows are held, not minted.
  expect(first.apply.data.observations).toMatchObject({ "ambiguous-fingerprint": 2, "fingerprint-new": 9 });
  expect(first.apply.data.listSizes.ambiguousMessages).toBe(2);
  expect(first.apply.data.planned.items).toBe(9);
  const second = importExport(env, archive, newCsv, newRoot);
  expect(second.apply.data.observations).toMatchObject({
    "message-id-linked-fingerprint": 7,
    "message-id-new": 8,
  });
  expect(second.apply.data.listSizes.ambiguousMessageLinks).toBe(2);
  expect(second.apply.data.planned.associations).toEqual({ ambiguous: 1, missing: 0, resolved: 5 });
  // Both sides of each unresolved link name each other; nothing merges.
  const messages = await csvRows(join(archive, "derived/messages.csv"));
  const flagged = messages.filter((row) => row.ambiguous_with !== "[]");
  expect(flagged.filter((row) => row.attachment_name === "IMG_0001.PNG")).toHaveLength(3);
  expect(flagged).toHaveLength(3);
});

test("a rerun retries unresolved attachments for rows it has already seen", async () => {
  const { archive, env, root } = await workspace("retry");
  const newRoot = join(root, "new");
  const csv = await writeNewExport(newRoot);
  importExport(env, archive, csv, newRoot);
  await writeFile(join(newRoot, "2023-10-27 07 00 00 - Robin Example - lost.heic"), "late-bytes");
  const retry = importExport(env, archive, csv, newRoot);
  expect(retry.preview.data.planned).toMatchObject({
    associations: { ambiguous: 0, missing: 0, resolved: 1 },
    blobs: 1,
    items: 0,
    observations: 0,
  });
  expect(retry.apply.causeCode).toBe("SUCCESS_COMPLETED");
  const messages = await csvRows(join(archive, "derived/messages.csv"));
  expect(messages.find((row) => row.attachment_name === "lost.heic")?.attachment_status).toBe("resolved");
  expect(importExport(env, archive, csv, newRoot).apply.causeCode).toBe("SUCCESS_UNCHANGED");
});

test("a reordered later export with a renamed attachment keeps the same items", async () => {
  const { archive, env, root } = await workspace("reorder");
  const newRoot = join(root, "new");
  const csv = await writeNewExport(newRoot);
  importExport(env, archive, csv, newRoot);
  const [header = [], ...rows] = parseCsv((await readFile(csv, "utf8")).slice(1));
  const reordered = toCsv(header, rows.reverse()).replace("again.png", "again renamed.png");
  const laterRoot = join(root, "later");
  await mkdir(laterRoot);
  for (const name of await readdir(newRoot, { recursive: true })) {
    if (name.endsWith(".csv") || !name.includes(" - ")) continue;
    const target = join(laterRoot, name.replace("again.png", "again renamed.png"));
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, await readFile(join(newRoot, name)));
  }
  const laterCsv = join(laterRoot, "Messages - Robin Example.csv");
  await writeFile(laterCsv, reordered);
  const later = importExport(env, archive, laterCsv, laterRoot);
  expect(later.apply.data.observations).toMatchObject({ "message-id-match": 15, "message-id-new": 0 });
  expect(later.apply.data.planned.items).toBe(0);
});

test("an export from a different chat identity is refused", async () => {
  const { archive, env, root } = await workspace("identity");
  const newRoot = join(root, "new");
  importExport(env, archive, await writeNewExport(newRoot), newRoot);
  const other = await writeOldExport(join(root, "old"), "someone@example.test");
  const result = invoke(env, "import", "--archive", archive, "--csv", other.csv, "--attachments", other.attachments, "--preview", "--json");
  expect(result.exitCode).toBe(3);
  expect(result.json()).toMatchObject({
    message: "The export's Sender IDs differ from the archive's chat identity.",
    result: { causeCode: "DOMAIN_PRECONDITION_UNMET" },
  });
});

test("a stale plan digest refuses and writes nothing", async () => {
  const { archive, env, root } = await workspace("stale");
  const csv = await writeNewExport(join(root, "new"));
  const result = invoke(env, "import", "--archive", archive, "--csv", csv, "--attachments", join(root, "new"), "--plan", "0".repeat(64), "--json");
  expect(result.exitCode).toBe(3);
  expect(result.json().result).toMatchObject({ causeCode: "DOMAIN_PREVIEW_STALE", outcome: "refused" });
  expect(await Bun.file(join(archive, "archive.json")).exists()).toBe(false);
});

test("a non-empty folder without the archive marker is refused", async () => {
  const { archive, env, root } = await workspace("foreign");
  await mkdir(archive, { recursive: true });
  await writeFile(join(archive, "someone-elses.png"), "x");
  const csv = await writeNewExport(join(root, "new"));
  const result = invoke(env, "import", "--archive", archive, "--csv", csv, "--attachments", join(root, "new"), "--preview", "--json");
  expect(result.exitCode).toBe(3);
  expect(result.json().result.causeCode).toBe("DOMAIN_PRECONDITION_UNMET");
  expect(await readdir(archive)).toEqual(["someone-elses.png"]);
});

test("status reports invalid records as a deterministic internal failure", async () => {
  const { archive, env } = await workspace("invalid");
  await mkdir(join(archive, "records"), { recursive: true });
  await writeFile(join(archive, "archive.json"), "{}\n");
  await writeFile(join(archive, "records/items.jsonl"), "{broken\n");
  const result = invoke(env, "status", "--archive", archive, "--json");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe("");
  expect(result.json().result).toMatchObject({ causeCode: "INTERNAL_RESULT_UNCHANGED", outcome: "failed", transactionState: "unchanged" });
});

async function markerArchive(archive: string): Promise<void> {
  await mkdir(archive, { recursive: true });
  await writeFile(join(archive, "archive.json"), '{"archiveVersion":1}\n');
}

test("two concurrent applies produce one import and one transient refusal", async () => {
  const { archive, env, root } = await workspace("concurrent");
  const newRoot = join(root, "new");
  const csv = await writeNewExport(newRoot);
  const source = ["--archive", archive, "--csv", csv, "--attachments", newRoot];
  const digest = invoke(env, "import", ...source, "--preview", "--json").json().result.data.planDigest;
  const barrier = join(root, "barrier");
  const start = (ownerToken: string) => {
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "import", ...source, "--plan", digest, "--json"], {
      cwd: ROOT,
      env: { ...process.env, ...env, IMAZING_ARCHIVE_TEST_LOCK_BARRIER_PATH: barrier, IMAZING_ARCHIVE_TEST_LOCK_OWNER_TOKEN: ownerToken, NODE_ENV: "test" },
      stdin: "ignore", stderr: "pipe", stdout: "pipe",
    });
    return Promise.all([new Response(child.stdout).text(), child.exited]).then(([stdout, exitCode]) => ({ exitCode, stdout }));
  };
  const first = start("first");
  const second = start("second");
  await waitForCount(barrier, ".ready", 2);
  await writeFile(join(barrier, "start"), "start\n");
  await waitForCount(barrier, ".claimed", 1);
  const refused = await Promise.race([first, second]);
  await writeFile(join(barrier, "finish"), "finish\n");
  const results = await Promise.all([first, second]);
  expect(results.map((result) => result.exitCode).sort()).toEqual([0, 75]);
  expect(JSON.parse(refused.stdout).result).toMatchObject({ causeCode: "TRANSIENT_NOT_STARTED", retryable: true, transactionState: "unchanged" });
  const journal = (await readFile(join(archive, "archive.journal.jsonl"), "utf8")).trim().split("\n");
  expect(journal.map((line) => JSON.parse(line).phase)).toEqual(["intent", "completed"]);
  expect(await Bun.file(join(archive, "archive.journal.lock")).exists()).toBe(false);
});

test("an interrupted apply leaves an unproven intent that recover reports without replay", async () => {
  const { archive, env, root } = await workspace("interrupted");
  const newRoot = join(root, "new");
  const csv = await writeNewExport(newRoot);
  const source = ["--archive", archive, "--csv", csv, "--attachments", newRoot];
  const digest = invoke(env, "import", ...source, "--preview", "--json").json().result.data.planDigest;
  const ready = join(root, "intent-ready");
  const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "import", ...source, "--plan", digest, "--json"], {
    cwd: ROOT,
    env: { ...process.env, ...env, IMAZING_ARCHIVE_TEST_AFTER_INTENT_DELAY_MS: "2000", IMAZING_ARCHIVE_TEST_AFTER_INTENT_READY_PATH: ready, NODE_ENV: "test" },
    stdin: "ignore", stderr: "pipe", stdout: "pipe",
  });
  await waitFor(ready);
  child.kill("SIGTERM");
  expect(await child.exited).toBe(143);
  expect(await Bun.file(join(archive, "records/items.jsonl")).exists()).toBe(false);

  const replay = invoke(env, "import", ...source, "--plan", digest, "--json");
  expect(replay.exitCode).toBe(3);
  expect(replay.json().result.causeCode).toBe("DOMAIN_PRECONDITION_UNMET");
  const recovery = invoke(env, "recover", "--archive", archive, "--json");
  expect(recovery.exitCode).toBe(3);
  expect(recovery.json().result).toMatchObject({ causeCode: "DOMAIN_RECOVERY_UNPROVABLE", handoff: { owner: "operator" } });
  expect((await readFile(join(archive, "archive.journal.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
  expect(await Bun.file(join(archive, "records/items.jsonl")).exists()).toBe(false);
});

test("recover rejects a receipt that only carries the plan digest", async () => {
  const { archive, env } = await workspace("recover-forged");
  await markerArchive(archive);
  const digest = "a".repeat(64);
  await appendJournal(join(archive, "archive"), { effectId: "effect.import", expectedValueHash: digest, journalVersion: 1, phase: "intent", runId: "interrupted" });
  await mkdir(join(archive, "imports"));
  await writeFile(join(archive, "imports", "receipt.json"), JSON.stringify({ planDigest: digest }));
  const recovered = invoke(env, "recover", "--archive", archive, "--json");
  expect(recovered.exitCode).toBe(3);
  expect(recovered.json().result.causeCode).toBe("DOMAIN_RECOVERY_UNPROVABLE");
  expect((await readFile(join(archive, "archive.journal.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
});

/** Removes one appended line so a record span no longer reads back. */
async function dropLastLine(path: string): Promise<void> {
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  await writeFile(path, `${lines.slice(0, -1).join("\n")}\n`);
}

test.each([
  ["every effect reads back", null, 0, "completed"],
  ["a written blob is missing", "blob", 3, "unknown"],
  ["an appended record span changed", "records", 3, "unknown"],
] as const)("recover proves a receipted import whose completion line was lost only when %s", async (_case, tamper, exitCode, state) => {
  const { archive, env, root } = await workspace("recover");
  const newRoot = join(root, "new");
  importExport(env, archive, await writeNewExport(newRoot), newRoot);
  const journal = join(archive, "archive.journal.jsonl");
  const [intent] = (await readFile(journal, "utf8")).trim().split("\n");
  await writeFile(journal, `${intent}\n`);
  if (tamper === "blob") {
    const [blob = ""] = (await readFile(join(archive, "records/blobs.jsonl"), "utf8")).trim().split("\n");
    await rm(join(archive, JSON.parse(blob).path));
  }
  if (tamper === "records") await dropLastLine(join(archive, "records/items.jsonl"));
  const recovered = invoke(env, "recover", "--archive", archive, "--json");
  expect(recovered.exitCode).toBe(exitCode);
  if (state === "completed") {
    expect(recovered.json().result.data).toEqual({ pendingEffect: "effect.import", state: "completed" });
  } else {
    expect(recovered.json().result).toMatchObject({ causeCode: "DOMAIN_RECOVERY_UNPROVABLE", handoff: { owner: "operator" } });
  }
  expect((await readFile(journal, "utf8")).trim().split("\n")).toHaveLength(1);
});

test.each(["blob", "original"] as const)("an existing %s with other bytes refuses the apply before its intent", async (target) => {
  const { archive, env, root } = await workspace("conflict");
  const newRoot = join(root, "new");
  const csv = await writeNewExport(newRoot);
  await mkdir(archive, { recursive: true });
  await writeFile(join(archive, "archive.json"), '{"archiveVersion":1}\n');
  const source = ["--archive", archive, "--csv", csv, "--attachments", newRoot];
  const digest = invoke(env, "import", ...source, "--preview", "--json").json().result.data.planDigest;
  const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
  const meme = sha(BYTES.meme);
  const path =
    target === "blob"
      ? `blobs/${meme.slice(0, 2)}/${meme}.png`
      : `originals/${sha(await readFile(csv))}-Messages - Robin Example.csv`;
  await mkdir(join(archive, path, ".."), { recursive: true });
  await writeFile(join(archive, path), "wrong bytes");
  const apply = invoke(env, "import", ...source, "--plan", digest, "--json");
  expect(apply.exitCode).toBe(3);
  expect(apply.json().message).toContain(path);
  expect(apply.json().result).toMatchObject({ causeCode: "DOMAIN_ARCHIVE_CONFLICT", outcome: "refused", transactionState: "unchanged" });
  expect(await readFile(join(archive, path), "utf8")).toBe("wrong bytes");
  expect(await Bun.file(join(archive, "archive.journal.jsonl")).exists()).toBe(false);
  expect(await Bun.file(join(archive, "records/items.jsonl")).exists()).toBe(false);
});

test("a decision whose derived output is obstructed returns an unknown effect that recover can prove", async () => {
  const { archive, env, root } = await workspace("decide-unknown");
  const newRoot = join(root, "new");
  importExport(env, archive, await writeNewExport(newRoot), newRoot);
  const [item] = await csvRows(join(archive, "derived/messages.csv"));
  await rm(join(archive, "derived"), { recursive: true });
  await writeFile(join(archive, "derived"), "obstruction");
  const decided = invoke(env, "decide", "--archive", archive, "--item", item?.item_key ?? "", "--album", "selected", "--json");
  expect(decided.exitCode).toBe(1);
  expect(decided.stderr).toBe("");
  expect(decided.json().result).toMatchObject({
    causeCode: "INTERNAL_RESULT_UNKNOWN",
    commandIdentity: "imazing-archive.decide",
    effects: { uncertain: ["effect.decision"] },
    handoff: { owner: "operator" },
    transactionState: "unknown",
  });
  expect((await readFile(join(archive, "records/decisions.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
  const proven = invoke(env, "recover", "--archive", archive, "--json");
  expect(proven.exitCode).toBe(0);
  expect(proven.json().result.data).toEqual({ pendingEffect: "effect.decision", state: "completed" });
  await writeFile(join(archive, "records/decisions.jsonl"), "");
  const unproven = invoke(env, "recover", "--archive", archive, "--json");
  expect(unproven.exitCode).toBe(3);
  expect(unproven.json().result.causeCode).toBe("DOMAIN_RECOVERY_UNPROVABLE");
});

/** Removes the final newline so the last record line is unterminated. */
async function tearTail(path: string): Promise<void> {
  const text = await readFile(path, "utf8");
  await writeFile(path, text.slice(0, -1));
}

test("recover refuses a pending decision whose record line is unterminated", async () => {
  const { archive, env, root } = await workspace("decide-torn");
  const newRoot = join(root, "new");
  importExport(env, archive, await writeNewExport(newRoot), newRoot);
  const [item] = await csvRows(join(archive, "derived/messages.csv"));
  await rm(join(archive, "derived"), { recursive: true });
  await writeFile(join(archive, "derived"), "obstruction");
  const decided = invoke(env, "decide", "--archive", archive, "--item", item?.item_key ?? "", "--album", "selected", "--json");
  expect(decided.json().result.transactionState).toBe("unknown");
  await tearTail(join(archive, "records/decisions.jsonl"));
  const recovered = invoke(env, "recover", "--archive", archive, "--json");
  expect(recovered.exitCode).toBe(3);
  expect(recovered.json().result.causeCode).toBe("DOMAIN_RECOVERY_UNPROVABLE");
});

test.each(["decide", "import"] as const)("%s refuses to append onto an unterminated record file before its intent", async (command) => {
  const { archive, env, root } = await workspace("append-torn");
  const newRoot = join(root, "new");
  const csv = await writeNewExport(newRoot);
  importExport(env, archive, csv, newRoot);
  const [item] = await csvRows(join(archive, "derived/messages.csv"));
  const decide = () => invoke(env, "decide", "--archive", archive, "--item", item?.item_key ?? "", "--album", "selected", "--json");
  const tornPath = command === "decide" ? "records/decisions.jsonl" : "records/associations.jsonl";
  const torn = join(archive, tornPath);
  if (command === "decide") expect(decide().exitCode).toBe(0);
  await tearTail(torn);
  const before = await readFile(torn, "utf8");
  const journal = await readFile(join(archive, "archive.journal.jsonl"), "utf8");
  let result: { causeCode: string; exitCode: number; handoff?: { reason: string }; transactionState: string };
  if (command === "decide") {
    result = decide().json().result;
  } else {
    await writeFile(join(newRoot, "2023-10-27 07 00 00 - Robin Example - lost.heic"), "late-bytes");
    result = importExport(env, archive, csv, newRoot).apply;
  }
  expect(result).toMatchObject({ causeCode: "INTERNAL_RESULT_UNCHANGED", exitCode: 1, transactionState: "unchanged" });
  expect(result.handoff?.reason).toContain(tornPath);
  expect(await readFile(torn, "utf8")).toBe(before);
  expect(await readFile(join(archive, "archive.journal.jsonl"), "utf8")).toBe(journal);
});

test("a rerun lists held ambiguous rows again without minting items or writing records", async () => {
  const { archive, env, root } = await workspace("held-rerun");
  const old = await writeOldExport(join(root, "old"));
  const first = importExport(env, archive, old.csv, old.attachments);
  expect(first.apply.data.listSizes.ambiguousMessages).toBe(2);
  const held = ["records/items.jsonl", "records/observations.jsonl", "records/associations.jsonl", "records/blobs.jsonl"];
  const before = await snapshot(archive, held);
  const rerun = importExport(env, archive, old.csv, old.attachments);
  expect(rerun.preview.data.listSizes.ambiguousMessages).toBe(2);
  expect(rerun.apply).toMatchObject({ causeCode: "SUCCESS_UNCHANGED", transactionState: "unchanged" });
  expect(rerun.apply.data.listSizes.ambiguousMessages).toBe(2);
  expect(rerun.apply.data.planned.items).toBe(0);
  const receipt = JSON.parse(await readFile(rerun.apply.data.receiptPath, "utf8"));
  // Independent oracle: the old fixture's two "ha" rows are rows 7 and 11.
  expect(receipt.summary.lists.ambiguousMessages.map((entry: { row: number }) => entry.row)).toEqual([7, 11]);
  expect(await snapshot(archive, held)).toEqual(before);
});

test("an unchanged import regenerates derived views left stale by a recovered decision", async () => {
  const { archive, env, root } = await workspace("derived-stale");
  const newRoot = join(root, "new");
  const csv = await writeNewExport(newRoot);
  importExport(env, archive, csv, newRoot);
  const pending = join(archive, "derived/pending-images.csv");
  const [image] = await csvRows(pending);
  expect(await csvRows(pending)).toHaveLength(5);
  await chmod(join(archive, "derived"), 0o500);
  try {
    const decided = invoke(env, "decide", "--archive", archive, "--item", image?.item_key ?? "", "--reviewed", "--json");
    expect(decided.json().result.transactionState).toBe("unknown");
    expect(invoke(env, "recover", "--archive", archive, "--json").json().result.data.state).toBe("completed");
    const blocked = importExport(env, archive, csv, newRoot).apply;
    expect(blocked).toMatchObject({ causeCode: "INTERNAL_RESULT_UNCHANGED", exitCode: 1, transactionState: "unchanged" });
  } finally {
    await chmod(join(archive, "derived"), 0o700);
  }
  const repeat = importExport(env, archive, csv, newRoot);
  expect(repeat.apply).toMatchObject({ causeCode: "SUCCESS_UNCHANGED", transactionState: "unchanged" });
  const rows = await csvRows(pending);
  expect(rows).toHaveLength(4);
  expect(rows.map((row) => row.item_key)).not.toContain(image?.item_key);
});

test.each([
  ["newline-only tear", (text: string) => text.slice(0, -1)],
  ["invalid entry", (text: string) => `${text}{not json}\n`],
] as const)("a journal %s blocks later writes with its bytes kept, and recover hands off", async (_case, damage) => {
  const { archive, env, root } = await workspace("journal-torn");
  const newRoot = join(root, "new");
  importExport(env, archive, await writeNewExport(newRoot), newRoot);
  const [item] = await csvRows(join(archive, "derived/messages.csv"));
  const journal = join(archive, "archive.journal.jsonl");
  await writeFile(journal, damage(await readFile(journal, "utf8")));
  const before = await readFile(journal, "utf8");
  const decided = invoke(env, "decide", "--archive", archive, "--item", item?.item_key ?? "", "--album", "selected", "--json");
  expect(decided.exitCode).toBe(3);
  expect(decided.stderr).toBe("");
  expect(decided.json().result).toMatchObject({ causeCode: "DOMAIN_RECOVERY_UNPROVABLE", handoff: { owner: "operator" }, transactionState: "unchanged" });
  expect(decided.json().result.handoff.reason).toContain("archive.journal.jsonl");
  expect(await Bun.file(join(archive, "records/decisions.jsonl")).exists()).toBe(false);
  expect(await readFile(journal, "utf8")).toBe(before);
  const recovered = invoke(env, "recover", "--archive", archive, "--json");
  expect(recovered.exitCode).toBe(3);
  expect(recovered.stderr).toBe("");
  expect(recovered.json().result).toMatchObject({ causeCode: "DOMAIN_RECOVERY_UNPROVABLE", data: null, handoff: { owner: "operator" } });
  expect(recovered.json().result.handoff.reason).toContain("archive.journal.jsonl");
  const status = invoke(env, "status", "--archive", archive, "--json");
  expect(status.exitCode).toBe(0);
  expect(status.json().result.data.recovery).toBe("unknown");
  expect(await readFile(journal, "utf8")).toBe(before);
});

test("a journal torn after the intent leaves the apply's effects unknown and its bytes kept", async () => {
  const { archive, env, root } = await workspace("journal-torn-late");
  const newRoot = join(root, "new");
  const csv = await writeNewExport(newRoot);
  const source = ["--archive", archive, "--csv", csv, "--attachments", newRoot];
  const digest = invoke(env, "import", ...source, "--preview", "--json").json().result.data.planDigest;
  const ready = join(root, "intent-ready");
  const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "import", ...source, "--plan", digest, "--json"], {
    cwd: ROOT,
    env: { ...process.env, ...env, IMAZING_ARCHIVE_TEST_AFTER_INTENT_DELAY_MS: "500", IMAZING_ARCHIVE_TEST_AFTER_INTENT_READY_PATH: ready, NODE_ENV: "test" },
    stdin: "ignore", stderr: "pipe", stdout: "pipe",
  });
  await waitFor(ready);
  const journal = join(archive, "archive.journal.jsonl");
  const torn = (await readFile(journal, "utf8")).slice(0, -1);
  await writeFile(journal, torn);
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(exitCode).toBe(1);
  expect(JSON.parse(stdout).result).toMatchObject({ causeCode: "INTERNAL_RESULT_UNKNOWN", effects: { uncertain: ["effect.import"] }, transactionState: "unknown" });
  expect(await readFile(journal, "utf8")).toBe(torn);
  expect(invoke(env, "recover", "--archive", archive, "--json").json().result.causeCode).toBe("DOMAIN_RECOVERY_UNPROVABLE");
});

test("rows dated before the start date are left out and counted in preview, apply, receipt, and status", async () => {
  const { archive, env, root } = await workspace("before-start");
  const newRoot = join(root, "new");
  const imported = importExport(env, archive, await writeNewExport(newRoot, { beforeStart: true }), newRoot);
  expect(imported.preview.data.beforeStart).toBe(1);
  expect(imported.apply.data).toMatchObject({ beforeStart: 1, messageRows: 16, planned: { items: 15 } });
  const receipt = JSON.parse(await readFile(imported.apply.data.receiptPath, "utf8"));
  expect(receipt).toMatchObject({ startDate: "2023-10-15", summary: { beforeStart: 1 } });
  expect(receipt.summary.lists.unreferencedFiles).toEqual(["2024-03-01 00 00 00 - Robin Example - stray.png"]);
  expect(JSON.parse(await readFile(join(archive, "archive.json"), "utf8")).startDate).toBe("2023-10-15");
  const messages = await csvRows(join(archive, "derived/messages.csv"));
  expect(messages.filter((row) => row.attachment_name === "early.png")).toEqual([]);
  expect(messages).toHaveLength(15);
  const status = invoke(env, "status", "--archive", archive, "--json").json().result.data;
  expect(status).toMatchObject({ beforeStart: 1, items: 15, startDate: "2023-10-15" });
});

test("the start date is fixed at creation: a differing later --start-date refuses and a malformed one is invalid", async () => {
  const { archive, env, root } = await workspace("start-date");
  const newRoot = join(root, "new");
  const csv = await writeNewExport(newRoot);
  const created = importExport(env, archive, csv, newRoot, "--start-date", "2023-10-22");
  // Three fixture rows fall on 2023-10-21, before the chosen start.
  expect(created.apply.data).toMatchObject({ beforeStart: 3, planned: { items: 12 } });
  expect(JSON.parse(await readFile(join(archive, "archive.json"), "utf8")).startDate).toBe("2023-10-22");
  const source = ["import", "--archive", archive, "--csv", csv, "--attachments", newRoot, "--preview", "--json"];
  for (const extra of [[], ["--start-date", "2023-10-15"]]) {
    const refused = invoke(env, ...source, ...extra);
    expect(refused.exitCode).toBe(3);
    expect(refused.json()).toMatchObject({ message: "The --start-date 2023-10-15 differs from the archive's start date 2023-10-22.", result: { causeCode: "DOMAIN_PRECONDITION_UNMET" } });
  }
  const malformed = invoke(env, ...source, "--start-date", "2023-02-30");
  expect(malformed.exitCode).toBe(4);
  expect(malformed.json().result.causeCode).toBe("SCHEMA_INVALID_INPUT");
});

async function waitFor(path: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!(await Bun.file(path).exists())) {
    if (performance.now() >= deadline) throw new Error(`process did not reach ${path}`);
    await Bun.sleep(2);
  }
}

async function waitForCount(directory: string, suffix: string, count: number): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (true) {
    const entries = await readdir(directory).catch(() => []);
    if (entries.filter((entry) => entry.endsWith(suffix)).length === count) return;
    if (performance.now() >= deadline) throw new Error(`processes did not produce ${count} ${suffix} markers`);
    await Bun.sleep(2);
  }
}

function spawnStatus(archive: string, env: Record<string, string>) {
  return Bun.spawn([process.execPath, "run", "src/cli.ts", "status", "--archive", archive, "--json"], {
    cwd: ROOT, env: { ...process.env, ...env, NODE_ENV: "test" }, stdin: "ignore", stderr: "pipe", stdout: "pipe",
  });
}

async function finished(child: ReturnType<typeof spawnStatus>) {
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, stderr, stdout };
}

test("public routes ignore held-open stdin and finish after stdout drains", async () => {
  const { archive, env } = await workspace("stdin");
  await markerArchive(archive);
  const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "status", "--archive", archive, "--json"], {
    cwd: ROOT, env: { ...process.env, ...env }, stdin: "pipe", stderr: "pipe", stdout: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout).result.commandIdentity).toBe("imazing-archive.status");
  child.stdin.end();
});

test.each(["SIGINT", "SIGTERM"] as const)("%s after handler readiness stops output at the 500ms flush deadline", async (signal) => {
  const { archive, env, root } = await workspace("signal");
  await markerArchive(archive);
  const ready = join(root, "ready");
  const child = spawnStatus(archive, { ...env, IMAZING_ARCHIVE_TEST_DELAY_MS: "2000", IMAZING_ARCHIVE_TEST_DIAGNOSTIC_FLUSH_MS: "2000", IMAZING_ARCHIVE_TEST_READY_PATH: ready });
  await waitFor(ready);
  const started = performance.now();
  child.kill(signal);
  const result = await finished(child);
  const elapsed = performance.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(400);
  expect(elapsed).toBeLessThan(750);
  expect(result).toEqual({ exitCode: signal === "SIGINT" ? 130 : 143, stderr: "", stdout: "" });
});

test("a repeated termination exits immediately during diagnostic flush", async () => {
  const { archive, env, root } = await workspace("repeat-signal");
  await markerArchive(archive);
  const ready = join(root, "ready");
  const child = spawnStatus(archive, { ...env, IMAZING_ARCHIVE_TEST_DELAY_MS: "2000", IMAZING_ARCHIVE_TEST_DIAGNOSTIC_FLUSH_MS: "2000", IMAZING_ARCHIVE_TEST_READY_PATH: ready });
  await waitFor(ready);
  child.kill("SIGINT");
  await Bun.sleep(30);
  const started = performance.now();
  child.kill("SIGINT");
  const result = await finished(child);
  expect(performance.now() - started).toBeLessThan(250);
  expect(result).toEqual({ exitCode: 130, stderr: "", stdout: "" });
});

test.each(["uncaught", "unhandled"] as const)("%s crash makes one silent emergency exit", async (crash) => {
  const { archive, env, root } = await workspace("crash");
  await markerArchive(archive);
  const ready = join(root, "ready");
  const child = spawnStatus(archive, { ...env, IMAZING_ARCHIVE_TEST_CRASH: crash, IMAZING_ARCHIVE_TEST_READY_PATH: ready });
  await waitFor(ready);
  expect(await finished(child)).toEqual({ exitCode: 1, stderr: "", stdout: "" });
});

test("consumer disappearance before a large stdout drain exits internal", async () => {
  const { archive, env } = await workspace("epipe");
  await markerArchive(archive);
  const child = spawnStatus(archive, { ...env, IMAZING_ARCHIVE_TEST_OUTPUT_BYTES: "4000000" });
  await child.stdout.cancel();
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  expect(exitCode).toBe(1);
  expect(stderr).toBe("");
});

test("a live consumer receives the complete large envelope before normal exit", async () => {
  const { archive, env } = await workspace("drain");
  await markerArchive(archive);
  const result = await finished(spawnStatus(archive, { ...env, IMAZING_ARCHIVE_TEST_OUTPUT_BYTES: "1000000" }));
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout).result.data.padding).toHaveLength(1_000_000);
});
