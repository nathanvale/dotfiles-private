import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PACKAGE = resolve(import.meta.dir, "../..");
const roots: string[] = [];
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "xero-history-synthetic-")));
  roots.push(root);
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true }); });
function call(root: string, ...args: string[]) {
  const child = Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...args, "--json"], {
    cwd: PACKAGE, env: { ...process.env, HOME: root, XDG_STATE_HOME: root },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  return { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString(), envelope: JSON.parse(child.stdout.toString()) };
}
const ids = ["--organisation-id", "org-123", "--account-id", "account-456"];
function observation(id: string, amountMinor = -1250) {
  return {
    organisation: { id: "org-123", name: "Synthetic Organisation" },
    bankAccount: { id: "account-456", name: "Synthetic Account" },
    coverage: [{ from: "2026-04-01", to: "2026-04-30", query: "Synthetic", observedAt: "2026-09-28T00:00:00.000Z", complete: true }],
    transactions: [{
      id, date: "2026-04-02", direction: "out", currency: "AUD", amountMinor,
      payee: "Synthetic Merchant", description: "Office costs",
      contact: { id: "contact-7", name: "Synthetic Merchant Pty Ltd" },
      reconciled: true, observedAt: "2026-09-28T00:00:00.000Z",
      lines: [
        { accountCode: "401", accountName: "Office costs", taxType: "GST on Expenses", amountMinor: -800, amountBasis: "tax-inclusive", tracking: { team: "A" } },
        { accountCode: "402", accountName: "Supplies", taxType: "GST Free Expenses", amountMinor: -450, amountBasis: "no-tax" },
      ],
    }],
  };
}
async function preview(root: string, data: unknown) {
  const input = join(root, `observation-${crypto.randomUUID()}.json`);
  await writeFile(input, JSON.stringify(data));
  const result = call(root, "preview", "--input", input);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  return result.envelope.result.data.previewId as string;
}
function apply(root: string, previewId: string) { return call(root, "apply", ...ids, "--preview-id", previewId, "--approve"); }
function key(id: string) { return `id-${Buffer.from(id, "utf8").toString("hex")}`; }
function cachePath(root: string, account = "account-456") { return join(root, "xero-cash-coding", key("org-123"), key(account), "history.json"); }

test("split observation persists and reloads equal with owner-only custody", async () => {
  const root = await fixture();
  const discovery = call(root, "--discover-command", "xero-history.apply");
  expect(discovery.exitCode).toBe(0);
  expect(discovery.envelope.result.data).toMatchObject({ command: { commandIdentity: "xero-history.apply" }, semantics: "possible-outcomes" });
  const observed = observation("transaction-1");
  const id = await preview(root, observed);
  expect((await lstat(cachePath(root).replace("/history.json", "/history.json.preview.json"))).mode & 0o777).toBe(0o600);
  const applied = apply(root, id);
  expect(applied.exitCode).toBe(0);
  expect(applied.envelope.result.transactionState).toBe("completed");
  const file = JSON.parse(await readFile(cachePath(root), "utf8"));
  expect(file.schemaVersion).toBe(1);
  expect(file.transactions["transaction-1"]).toEqual(observed.transactions[0]);
  expect(file.transactions["transaction-1"].lines).toHaveLength(2);
  expect(file.transactions["transaction-1"].lines.map((line: { amountBasis: string }) => line.amountBasis)).toEqual(["tax-inclusive", "no-tax"]);
  expect((await lstat(join(root, "xero-cash-coding"))).mode & 0o777).toBe(0o700);
  expect((await lstat(join(root, "xero-cash-coding", key("org-123")))).mode & 0o777).toBe(0o700);
  expect((await lstat(join(root, "xero-cash-coding", key("org-123"), key("account-456")))).mode & 0o777).toBe(0o700);
  expect((await lstat(cachePath(root))).mode & 0o777).toBe(0o600);
  expect((await lstat(`${cachePath(root)}.journal.jsonl`)).mode & 0o777).toBe(0o600);
  const status = call(root, "status", ...ids);
  expect(status.envelope.result.data).toMatchObject({ available: true, count: 1 });
  const lookup = call(root, "lookup", ...ids, "--query", "  SYNTHETIC   MERCHANT ");
  expect(lookup.envelope.result.data.matches).toHaveLength(1);
  expect(lookup.envelope.result.data.matches[0]).toEqual(observed.transactions[0]);
  expect(apply(root, id).exitCode).toBe(3);
  expect(call(root, "recover", ...ids).envelope.result.data.state).toBe("none");
});

test("symlinked cache ancestry is refused without reading its target", async () => {
  const root = await fixture();
  const foreign = join(root, "foreign");
  await mkdir(foreign, { mode: 0o700 });
  await symlink(foreign, join(root, "xero-cash-coding"));
  const status = call(root, "status", ...ids);
  const lookup = call(root, "lookup", ...ids, "--query", "Synthetic");
  expect(status.exitCode).toBe(3);
  expect(lookup.exitCode).toBe(3);
  expect(status.envelope.result.causeCode).toBe("DOMAIN_PRECONDITION_UNMET");
  expect(await Bun.file(join(foreign, key("org-123"), key("account-456"), "history.json")).exists()).toBe(false);
});

test("refresh replaces one ID while preserving unrelated records in both partitions", async () => {
  const root = await fixture();
  apply(root, await preview(root, observation("transaction-1")));
  apply(root, await preview(root, observation("transaction-2")));
  const other = { ...observation("other-account"), bankAccount: { id: "ACCOUNT-456", name: "Other Synthetic Account" } };
  const otherId = await preview(root, other);
  const otherApply = call(root, "apply", "--organisation-id", "org-123", "--account-id", "ACCOUNT-456", "--preview-id", otherId, "--approve");
  expect(otherApply.exitCode).toBe(0);
  apply(root, await preview(root, observation("transaction-1", -1300)));
  const first = JSON.parse(await readFile(cachePath(root), "utf8"));
  const second = JSON.parse(await readFile(cachePath(root, "ACCOUNT-456"), "utf8"));
  expect(Object.keys(first.transactions).sort()).toEqual(["transaction-1", "transaction-2"]);
  expect(first.transactions["transaction-1"].amountMinor).toBe(-1300);
  expect(first.transactions["transaction-2"].amountMinor).toBe(-1250);
  expect(Object.keys(second.transactions)).toEqual(["other-account"]);
});

test("lookup ranks the bank movement and surfaces line basis differences", async () => {
  const root = await fixture();
  apply(root, await preview(root, observation("older-match")));
  const newer = observation("newer-different");
  const transaction = newer.transactions.at(0);
  const firstLine = transaction?.lines.at(0);
  if (!transaction || !firstLine) throw new Error("Synthetic fixture lost its transaction or line.");
  transaction.date = "2026-04-03";
  transaction.direction = "in";
  transaction.currency = "USD";
  transaction.amountMinor = 1250;
  firstLine.amountBasis = "tax-exclusive";
  apply(root, await preview(root, newer));
  const lookup = call(root, "lookup", ...ids, "--query", "Synthetic Merchant", "--direction", "out", "--currency", "AUD", "--amount-minor", "-1250", "--amount-basis", "tax-inclusive");
  expect(lookup.exitCode).toBe(0);
  expect(lookup.envelope.result.data.matches.map((item: { id: string }) => item.id)).toEqual(["older-match", "newer-different"]);
  expect(lookup.envelope.result.data.basisExceptions).toContainEqual({ transactionId: "older-match", lineIndex: 1, observedBasis: "no-tax", pendingBasis: "tax-inclusive" });
  expect(lookup.envelope.result.data.basisExceptions).toContainEqual({ transactionId: "newer-different", lineIndex: 0, observedBasis: "tax-exclusive", pendingBasis: "tax-inclusive" });
  expect(lookup.envelope.result.data.conflicts).toMatchObject({ accounts: ["401", "402"], taxTypes: ["GST on Expenses", "GST Free Expenses"] });
});

test("lookup prefers bank movement over a newer line-amount decoy and excludes equal bases", async () => {
  const root = await fixture();
  apply(root, await preview(root, observation("bank-amount-match")));
  const decoy = observation("line-amount-decoy", -999);
  decoy.transactions[0]!.date = "2026-04-03";
  decoy.transactions[0]!.lines[0]!.amountMinor = -1250;
  decoy.transactions[0]!.lines[1]!.amountMinor = 251;
  apply(root, await preview(root, decoy));
  const lookup = call(root, "lookup", ...ids, "--query", "Synthetic Merchant", "--amount-minor", "-1250", "--amount-basis", "tax-inclusive");
  expect(lookup.exitCode).toBe(0);
  expect(lookup.envelope.result.data.matches.map((item: { id: string }) => item.id)).toEqual(["bank-amount-match", "line-amount-decoy"]);
  expect(lookup.envelope.result.data.basisExceptions).toEqual([
    { transactionId: "bank-amount-match", lineIndex: 1, observedBasis: "no-tax", pendingBasis: "tax-inclusive" },
    { transactionId: "line-amount-decoy", lineIndex: 1, observedBasis: "no-tax", pendingBasis: "tax-inclusive" },
  ]);
});

test("whitespace-only lookup query is refused before a cache search", async () => {
  const root = await fixture();
  const lookup = call(root, "lookup", ...ids, "--query", "   \t  ");
  expect(lookup.exitCode).toBe(2);
  expect(lookup.envelope.result.causeCode).toBe("USAGE_INVALID_INVOCATION");
});

test("preview lists added and replaced IDs and rejects a changed cache at apply", async () => {
  const root = await fixture();
  apply(root, await preview(root, observation("existing-id")));
  const observed = observation("existing-id", -1300);
  observed.transactions.push({ ...observation("added-id").transactions[0]! });
  const input = join(root, "refresh.json");
  await writeFile(input, JSON.stringify(observed));
  const prepared = call(root, "preview", "--input", input);
  expect(prepared.exitCode).toBe(0);
  expect(prepared.envelope.result.data).toMatchObject({ addedTransactionIds: ["added-id"], replacedTransactionIds: ["existing-id"] });
  const previewId = prepared.envelope.result.data.previewId as string;
  const path = cachePath(root);
  const changed = JSON.parse(await readFile(path, "utf8"));
  changed.transactions["external-change"] = { ...observation("external-change").transactions[0] };
  await writeFile(path, `${JSON.stringify(changed)}\n`);
  const before = await readFile(path);
  const stale = apply(root, previewId);
  expect(stale.exitCode).toBe(3);
  expect(stale.envelope.result).toMatchObject({ causeCode: "DOMAIN_PRECONDITION_UNMET", transactionState: "unchanged" });
  expect(stale.envelope.message).toContain("Cache changed since preview");
  expect(await readFile(path)).toEqual(before);
});

test("malformed cache is a named cache miss and remains byte-for-byte untouched", async () => {
  const root = await fixture();
  const path = cachePath(root);
  await mkdir(join(root, "xero-cash-coding"), { mode: 0o700 });
  await mkdir(join(root, "xero-cash-coding", key("org-123")), { mode: 0o700 });
  await mkdir(join(root, "xero-cash-coding", key("org-123"), key("account-456")), { mode: 0o700 });
  await writeFile(path, "{broken", { mode: 0o600 });
  const status = call(root, "status", ...ids);
  expect(status.exitCode).toBe(0);
  expect(status.envelope.result.data).toMatchObject({ available: false, repair: expect.stringContaining("Repair") });
  const lookup = call(root, "lookup", ...ids, "--query", "Synthetic");
  expect(lookup.envelope.result.data.matches).toEqual([]);
  const input = join(root, "observation.json");
  await writeFile(input, JSON.stringify(observation("transaction-1")));
  const rejected = call(root, "preview", "--input", input);
  expect(rejected.exitCode).toBe(4);
  expect(await readFile(path, "utf8")).toBe("{broken");
});

test("intent interrupted before rename is unchanged, read-only recover names repair, and replay is refused", async () => {
  const root = await fixture();
  const id = await preview(root, observation("transaction-1"));
  const marker = join(root, "intent-ready");
  const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "apply", ...ids, "--preview-id", id, "--approve", "--json"], {
    cwd: PACKAGE, env: { ...process.env, HOME: root, XDG_STATE_HOME: root, NODE_ENV: "test", XERO_HISTORY_TEST_AFTER_INTENT: marker },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const deadline = Date.now() + 2000;
  while (!(await Bun.file(marker).exists()) && Date.now() < deadline) await Bun.sleep(5);
  expect(await Bun.file(marker).exists()).toBe(true);
  child.kill("SIGTERM");
  expect(await child.exited).toBe(143);
  const journalBefore = await readFile(`${cachePath(root)}.journal.jsonl`);
  const recovery = call(root, "recover", ...ids);
  expect(recovery.exitCode).toBe(3);
  expect(recovery.envelope.result).toMatchObject({ outcome: "refused", effectClass: "inspect", transactionState: "unchanged", retryable: false,
    data: null, effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true } });
  expect(recovery.envelope.result.repairAction).toContain("Observed state: unchanged.");
  expect(recovery.envelope.result.repairAction).toContain("history.json.journal.jsonl");
  expect(recovery.envelope.result.repairAction).toContain(`${cachePath(root)}.lock`);
  expect(await readFile(`${cachePath(root)}.journal.jsonl`)).toEqual(journalBefore);
  expect(await Bun.file(cachePath(root)).exists()).toBe(false);
  await unlink(`${cachePath(root)}.lock`); // Synthetic dead-writer residue cleared to reach the pending-intent refusal.
  const replay = apply(root, id);
  expect(replay.exitCode).toBe(3);
  expect(replay.envelope.result).toMatchObject({ outcome: "refused", transactionState: "unchanged", data: null,
    effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true },
    handoff: { owner: "operator", reason: expect.stringContaining("Run recover") } });
  const pendingInput = join(root, "pending-observation.json");
  await writeFile(pendingInput, JSON.stringify(observation("transaction-2")));
  const pendingPreview = call(root, "preview", "--input", pendingInput);
  expect(pendingPreview.exitCode).toBe(3);
  expect(pendingPreview.envelope.result).toMatchObject({ outcome: "refused", transactionState: "unchanged", data: null,
    effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true },
    handoff: { owner: "operator", reason: expect.stringContaining("Run recover") } });
  const damaged = JSON.parse(await readFile(`${cachePath(root)}.preview.json`, "utf8")).proposed;
  damaged.updatedAt = "2026-09-29T00:00:00.000Z";
  await writeFile(cachePath(root), `${JSON.stringify(damaged)}\n`, { mode: 0o600 });
  const uncertain = call(root, "recover", ...ids);
  expect(uncertain.exitCode).toBe(3);
  expect(uncertain.envelope.result).toMatchObject({ outcome: "refused", effectClass: "inspect", transactionState: "unchanged", data: null,
    effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true } });
  expect(uncertain.envelope.result.repairAction).toContain("Observed state: unknown.");
});

test.each(["SIGINT", "SIGTERM"] as const)("%s before intent releases its lock and permits a fresh preview", async (signal) => {
  const root = await fixture();
  const id = await preview(root, observation("transaction-1"));
  const marker = join(root, "before-intent");
  const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "apply", ...ids, "--preview-id", id, "--approve", "--json"], {
    cwd: PACKAGE, env: { ...process.env, HOME: root, XDG_STATE_HOME: root, NODE_ENV: "test", XERO_HISTORY_TEST_BEFORE_INTENT: marker },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const deadline = Date.now() + 2000;
  while (!(await Bun.file(marker).exists()) && Date.now() < deadline) await Bun.sleep(5);
  expect(await Bun.file(marker).exists()).toBe(true);
  child.kill(signal);
  expect(await child.exited).toBe(signal === "SIGINT" ? 130 : 143);
  expect(await Bun.file(`${cachePath(root)}.lock`).exists()).toBe(false);
  expect(call(root, "recover", ...ids).envelope.result.data.state).toBe("none");
  await preview(root, observation("transaction-2"));
});

test("intent followed by rename reports observed completion in repair without claiming a recover effect", async () => {
  const root = await fixture();
  const id = await preview(root, observation("transaction-1"));
  const marker = join(root, "after-rename");
  const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "apply", ...ids, "--preview-id", id, "--approve", "--json"], {
    cwd: PACKAGE, env: { ...process.env, HOME: root, XDG_STATE_HOME: root, NODE_ENV: "test", XERO_HISTORY_TEST_AFTER_RENAME: marker },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const deadline = Date.now() + 2000;
  while (!(await Bun.file(marker).exists()) && Date.now() < deadline) await Bun.sleep(5);
  expect(await Bun.file(marker).exists()).toBe(true);
  child.kill("SIGTERM");
  expect(await child.exited).toBe(143);
  const before = await readFile(cachePath(root));
  const recovery = call(root, "recover", ...ids);
  expect(recovery.exitCode).toBe(3);
  expect(recovery.envelope.result).toMatchObject({ outcome: "refused", effectClass: "inspect", transactionState: "unchanged", data: null,
    effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true } });
  expect(recovery.envelope.result.repairAction).toContain("Observed state: completed.");
  expect(recovery.envelope.result.repairAction).toContain("journal");
  expect(await readFile(cachePath(root))).toEqual(before);
  expect(apply(root, id).exitCode).toBe(3);
  await rename(`${cachePath(root)}.journal.jsonl`, `${cachePath(root)}.journal.reviewed`);
  await rename(`${cachePath(root)}.preview.json`, `${cachePath(root)}.preview.reviewed`);
  await unlink(`${cachePath(root)}.lock`);
  expect(call(root, "recover", ...ids).envelope.result.data.state).toBe("none");
  await preview(root, observation("transaction-2"));
});

test("dead writer lock without an intent has an exact read-only repair path", async () => {
  const root = await fixture();
  await preview(root, observation("transaction-1"));
  await writeFile(`${cachePath(root)}.lock`, '{"pid":99999999}\n', { mode: 0o600 });
  const recovery = call(root, "recover", ...ids);
  expect(recovery.exitCode).toBe(3);
  expect(recovery.envelope.result.data).toBeNull();
  expect(recovery.envelope.result.repairAction).toContain("Observed state: lock-residue.");
  expect(recovery.envelope.result.repairAction).toContain(`${cachePath(root)}.lock`);
  expect(await readFile(`${cachePath(root)}.lock`, "utf8")).toBe('{"pid":99999999}\n');
  const input = join(root, "fresh.json");
  await writeFile(input, JSON.stringify(observation("transaction-2")));
  expect(call(root, "preview", "--input", input).exitCode).toBe(3);
});

test("completion before preview consumption is recovered without a second cache write", async () => {
  const root = await fixture();
  const id = await preview(root, observation("transaction-1"));
  const interrupted = Bun.spawnSync([process.execPath, "run", "src/cli.ts", "apply", ...ids, "--preview-id", id, "--approve", "--json"], {
    cwd: PACKAGE, env: { ...process.env, HOME: root, XDG_STATE_HOME: root, NODE_ENV: "test", XERO_HISTORY_TEST_AFTER_COMPLETION: "interrupt" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  expect(interrupted.exitCode).toBe(3);
  expect(JSON.parse(interrupted.stdout.toString()).result).toMatchObject({ outcome: "failed", transactionState: "unknown", data: null,
    effects: { completed: [], remaining: [], uncertain: [`cache:${id}`], inventoryComplete: true } });
  const before = await readFile(cachePath(root));
  const recovery = call(root, "recover", ...ids);
  expect(recovery.envelope.result).toMatchObject({ causeCode: "SUCCESS_COMPLETED", transactionState: "completed" });
  const replay = apply(root, id);
  expect(replay.exitCode).toBe(3);
  expect(await readFile(cachePath(root))).toEqual(before);
});

test("two concurrent applies yield one effect and one bounded busy refusal", async () => {
  const root = await fixture();
  const id = await preview(root, observation("transaction-1"));
  const marker = join(root, "intent-ready");
  const first = Bun.spawn([process.execPath, "run", "src/cli.ts", "apply", ...ids, "--preview-id", id, "--approve", "--json"], {
    cwd: PACKAGE, env: { ...process.env, HOME: root, XDG_STATE_HOME: root, NODE_ENV: "test", XERO_HISTORY_TEST_AFTER_INTENT: marker },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const deadline = Date.now() + 2000;
  while (!(await Bun.file(marker).exists()) && Date.now() < deadline) await Bun.sleep(5);
  expect(await Bun.file(marker).exists()).toBe(true);
  const recovery = call(root, "recover", ...ids);
  expect(recovery.exitCode).toBe(75);
  expect(recovery.envelope.result.data).toBeNull();
  expect(recovery.envelope.result.repairAction).toContain("Observed state: writer-active.");
  const second = apply(root, id);
  expect(second.exitCode).toBe(75);
  expect(second.envelope.result).toMatchObject({ outcome: "refused", failureClass: "transient", retryable: true, retryDelayMilliseconds: 250 });
  const input = join(root, "second-observation.json");
  await writeFile(input, JSON.stringify(observation("transaction-2")));
  const competingPreview = call(root, "preview", "--input", input);
  expect(competingPreview.exitCode).toBe(75);
  expect(competingPreview.envelope.result).toMatchObject({ outcome: "refused", causeCode: "TRANSIENT_NOT_STARTED" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(first.stdout).text(), new Response(first.stderr).text(), first.exited]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout).result.effects.completed).toEqual([`cache:${id}`]);
  expect(JSON.parse(await readFile(cachePath(root), "utf8")).transactions["transaction-1"].id).toBe("transaction-1");
  expect((await readFile(`${cachePath(root)}.journal.jsonl`, "utf8")).trim().split("\n")).toHaveLength(2);
});
