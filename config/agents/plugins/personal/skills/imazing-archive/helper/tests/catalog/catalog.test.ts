import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stationsFor } from "../../src/branch-station-catalog.ts";

const ROOT = resolve(import.meta.dir, "../..");
const COMMANDS = [
  "imazing-archive.command-discovery",
  "imazing-archive.decide",
  "imazing-archive.discovery",
  "imazing-archive.dispatch",
  "imazing-archive.help",
  "imazing-archive.import",
  "imazing-archive.recover",
  "imazing-archive.status",
];

test("the catalogue declares the exact routed tuple vocabulary", () => {
  const identities = COMMANDS.flatMap(stationsFor).map((station) =>
    [station.commandIdentity, station.outcome, station.causeCode].join("|"),
  );
  // Independent literal oracle for the sealed routed tuple vocabulary.
  expect(identities.sort()).toEqual([
    "imazing-archive.command-discovery|success|SUCCESS_UNCHANGED",
    "imazing-archive.decide|failed|INTERNAL_RESULT_UNCHANGED",
    "imazing-archive.decide|failed|INTERNAL_RESULT_UNKNOWN",
    "imazing-archive.decide|refused|DOMAIN_PRECONDITION_UNMET",
    "imazing-archive.decide|refused|DOMAIN_RECOVERY_UNPROVABLE",
    "imazing-archive.decide|refused|SCHEMA_INVALID_INPUT",
    "imazing-archive.decide|refused|TRANSIENT_NOT_STARTED",
    "imazing-archive.decide|refused|USAGE_INVALID_INVOCATION",
    "imazing-archive.decide|success|SUCCESS_COMPLETED",
    "imazing-archive.discovery|success|SUCCESS_UNCHANGED",
    "imazing-archive.dispatch|refused|USAGE_INVALID_INVOCATION",
    "imazing-archive.help|success|SUCCESS_UNCHANGED",
    "imazing-archive.import|failed|INTERNAL_RESULT_UNCHANGED",
    "imazing-archive.import|failed|INTERNAL_RESULT_UNKNOWN",
    "imazing-archive.import|refused|DOMAIN_ARCHIVE_CONFLICT",
    "imazing-archive.import|refused|DOMAIN_PRECONDITION_UNMET",
    "imazing-archive.import|refused|DOMAIN_PREVIEW_STALE",
    "imazing-archive.import|refused|DOMAIN_RECOVERY_UNPROVABLE",
    "imazing-archive.import|refused|SCHEMA_INVALID_INPUT",
    "imazing-archive.import|refused|TRANSIENT_NOT_STARTED",
    "imazing-archive.import|refused|USAGE_INVALID_INVOCATION",
    "imazing-archive.import|success|SUCCESS_COMPLETED",
    "imazing-archive.import|success|SUCCESS_UNCHANGED",
    "imazing-archive.recover|refused|DOMAIN_PRECONDITION_UNMET",
    "imazing-archive.recover|refused|DOMAIN_RECOVERY_UNPROVABLE",
    "imazing-archive.recover|refused|USAGE_INVALID_INVOCATION",
    "imazing-archive.recover|success|SUCCESS_UNCHANGED",
    "imazing-archive.status|failed|INTERNAL_RESULT_UNCHANGED",
    "imazing-archive.status|refused|DOMAIN_PRECONDITION_UNMET",
    "imazing-archive.status|refused|USAGE_INVALID_INVOCATION",
    "imazing-archive.status|success|SUCCESS_UNCHANGED",
  ]);
});

test("the transient import station is the only retryable shape and is bounded", () => {
  expect(
    stationsFor("imazing-archive.import").find(
      (station) => station.causeCode === "TRANSIENT_NOT_STARTED",
    ),
  ).toMatchObject({
    exitCode: 75,
    failureClass: "transient",
    retryDelayPolicy: { kind: "fixed", milliseconds: 1000 },
    retryable: true,
    transactionState: "unchanged",
  }); // Independent literal oracle for the transient station contract.
  const retryable = COMMANDS.flatMap(stationsFor).filter(
    (station) => station.retryable,
  );
  expect(retryable.map((station) => station.commandIdentity).sort()).toEqual([
    "imazing-archive.decide",
    "imazing-archive.import",
  ]);
});

test("an unknown import effect hands off and never retries", () => {
  expect(
    stationsFor("imazing-archive.import").find(
      (station) => station.transactionState === "unknown",
    ),
  ).toMatchObject({
    causeCode: "INTERNAL_RESULT_UNKNOWN",
    exitCode: 1,
    guidance: { handoff: { owner: "operator" } },
    retryable: false,
  });
});

test("selected-command discovery returns the same catalogue the tests use", () => {
  const result = Bun.spawnSync(
    [process.execPath, "run", "src/cli.ts", "--discover-command", "imazing-archive.import", "--json"],
    { cwd: ROOT, stderr: "pipe", stdout: "pipe" },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  const data = JSON.parse(result.stdout.toString()).result.data;
  expect(data.semantics).toBe("possible-outcomes");
  expect(data.stations).toEqual(
    JSON.parse(JSON.stringify(stationsFor("imazing-archive.import"))),
  );
  expect(data.stations).toHaveLength(11);
});

test("the committed imazing-archive bundle matches its source", async () => {
  const output = join(await mkdtemp(join(tmpdir(), "imazing-archive-bundle-")), "imazing-archive.js");
  try {
    const built = Bun.spawnSync(
      [process.execPath, "build", "--target", "bun", "--minify-whitespace", "src/cli.ts", "--outfile", output],
      { cwd: ROOT, env: { ...process.env, NODE_ENV: "production" }, stderr: "pipe", stdin: "ignore", stdout: "pipe" },
    );
    expect(built.exitCode).toBe(0);
    const working = await readFile(join(ROOT, "dist", "imazing-archive.js")).catch(() => null);
    if (working === null || !(await readFile(output)).equals(working)) {
      throw new Error("The imazing-archive bundle is stale or missing. From helper/, run bun run build:bundle.");
    }
  } finally {
    await rm(join(output, ".."), { force: true, recursive: true });
  }
});
