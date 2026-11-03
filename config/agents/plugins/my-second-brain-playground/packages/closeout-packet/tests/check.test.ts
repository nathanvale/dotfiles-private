// SDK166 T01 controls through the public process. Expected codes, paths and verdicts are test-owned literals.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Json, validExpected, validPacket, writeInputs } from "./fixtures/packets.ts";

const ROOT = resolve(import.meta.dir, "..");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function run(packet: Json, expected: Json) {
  const inputs = writeInputs(packet, expected);
  dirs.push(inputs.dir);
  const result = Bun.spawnSync(
    [process.execPath, "run", "src/cli.ts", "check", "--packet", inputs.packet, "--expected", inputs.expected, "--json"],
    { cwd: ROOT, stderr: "pipe", stdout: "pipe", stdin: "ignore" },
  );
  return { exitCode: result.exitCode, stderr: result.stderr.toString(), stdout: result.stdout.toString(), inputs };
}

function check(packet: Json, expected: Json) {
  const result = run(packet, expected);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  const envelope = JSON.parse(result.stdout);
  expect(envelope.result).toMatchObject({
    commandIdentity: "closeout-packet.check",
    causeCode: "SUCCESS_UNCHANGED",
    effectClass: "inspect",
    transactionState: "unchanged",
  });
  return envelope.result.data;
}

function codes(data: { findings: { code: string; path: string }[] }): string[] {
  return data.findings.map((finding) => `${finding.code}@${finding.path}`);
}

test("V1 valid same-candidate packet is complete and supports the requested action", () => {
  const data = check(validPacket(), validExpected());
  expect(codes(data)).toEqual([]);
  expect(data.reporting).toBe("complete");
  expect(data.actionability).toBe("supports-requested-action");
  expect(data.establishes).toBe("recorded-structure-only");
  expect(data.doesNotEstablish).toEqual(["authority", "dependency-completeness", "evidence-truth", "freshness", "native-pass"]);
});

test("N1 expected context without candidate and observation is incomplete, not a passing identity check", () => {
  const expected = validExpected();
  (expected.identity as Json).candidate = undefined;
  expected.observation = {};
  const data = check(validPacket(), expected);
  expect(data.reporting).toBe("incomplete");
  expect(codes(data)).toEqual([
    "EXPECTED_CONTEXT_MISSING@expected.identity.candidate",
    "EXPECTED_CONTEXT_MISSING@expected.observation.at",
    "EXPECTED_CONTEXT_MISSING@expected.observation.source",
  ]);
});

test("N1b omitting --expected is a usage refusal with no data", () => {
  const inputs = writeInputs(validPacket(), validExpected());
  dirs.push(inputs.dir);
  const result = Bun.spawnSync([process.execPath, "run", "src/cli.ts", "check", "--packet", inputs.packet, "--json"], {
    cwd: ROOT,
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(result.exitCode).toBe(2);
  expect(JSON.parse(result.stdout.toString()).result).toMatchObject({ causeCode: "USAGE_INVALID_INVOCATION", data: null, outcome: "refused" });
});

test("N2 consistently substituted packet and evidence identities are inconsistent with the independent expectation", () => {
  const packet = validPacket();
  (packet.identity as Json).candidate = "cand-b";
  for (const item of packet.evidence as Json[]) item.sourceCandidate = "cand-b";
  const data = check(packet, validExpected());
  expect(data.reporting).toBe("inconsistent");
  expect(data.actionability).toBe("not-assessed");
  expect(codes(data)).toEqual(["IDENTITY_MISMATCH@identity.candidate"]);
});

test("N3 an omitted obligation within populated evidence is unaccounted", () => {
  const packet = validPacket();
  packet.evidence = (packet.evidence as Json[]).slice(0, 2);
  const data = check(packet, validExpected());
  expect(data.reporting).toBe("incomplete");
  expect(codes(data)).toEqual(["OBLIGATION_UNACCOUNTED@evidence:O3"]);
});

for (const field of ["decision", "downstream", "evidence", "identity", "outcome", "unresolved"]) {
  test(`N4 missing ${field} field is reported`, () => {
    const packet = validPacket();
    delete packet[field];
    const data = check(packet, validExpected());
    expect(data.reporting).toBe("incomplete");
    expect(codes(data)).toEqual([`FIELD_MISSING@${field}`]);
  });
}

test("N5 unknown downstream coverage cannot support a no-effects claim and stays visible", () => {
  const packet = validPacket();
  packet.downstream = { coverage: "unknown", claim: "no-effects", owner: "coordinator", nextSafeStep: "query dependents" };
  const data = check(packet, validExpected());
  expect(codes(data)).toEqual(["DOWNSTREAM_COVERAGE_UNKNOWN@downstream.coverage"]);
  expect(data.unknowns).toEqual([{ path: "downstream.coverage", owner: "coordinator", nextSafeStep: "query dependents" }]);
});

test("N5b honestly reported unknown coverage is complete reporting but blocked", () => {
  const packet = validPacket();
  packet.downstream = { coverage: "unknown", owner: "coordinator", nextSafeStep: "query dependents" };
  const data = check(packet, validExpected());
  expect(codes(data)).toEqual([]);
  expect(data.reporting).toBe("complete");
  expect(data.actionability).toBe("blocked");
});

test("N6 a hold without owner or release condition is unowned; an owned hold blocks without a finding", () => {
  const packet = validPacket();
  packet.unresolved = { holds: [{ description: "review pending" }], humanChoices: [] };
  expect(codes(check(packet, validExpected()))).toEqual(["HOLD_UNOWNED@unresolved.holds[0]"]);
  packet.unresolved = { holds: [{ description: "review pending", owner: "coordinator", releaseCondition: "review PASS" }], humanChoices: [] };
  const owned = check(packet, validExpected());
  expect(codes(owned)).toEqual([]);
  expect(owned.actionability).toBe("blocked");
});

test("N7 evidence from another candidate is unqualified reuse", () => {
  const packet = validPacket();
  ((packet.evidence as Json[])[1] as Json).sourceCandidate = "cand-z";
  expect(codes(check(packet, validExpected()))).toEqual(["REUSE_UNQUALIFIED@evidence[1]"]);
});

test("N8 an attributed approval without its original record and scope is an incomplete grant binding", () => {
  const packet = validPacket();
  (packet.decision as Json).grants = [{ action: "Nathan approved" }];
  expect(codes(check(packet, validExpected()))).toEqual(["GRANT_BINDING_INCOMPLETE@decision.grants[0]"]);
});

test("R1 the check leaves its inputs and their directory unchanged", () => {
  const result = run(validPacket(), validExpected());
  expect(result.exitCode).toBe(0);
  const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const before = [digest(result.inputs.packet), digest(result.inputs.expected)];
  writeFileSync(join(result.inputs.dir, "marker"), "");
  const again = Bun.spawnSync(
    [process.execPath, "run", "src/cli.ts", "check", "--packet", result.inputs.packet, "--expected", result.inputs.expected, "--json"],
    { cwd: ROOT, stderr: "pipe", stdout: "pipe" },
  );
  expect(again.exitCode).toBe(0);
  expect([digest(result.inputs.packet), digest(result.inputs.expected)]).toEqual(before);
  expect(readdirSync(result.inputs.dir).sort()).toEqual(["expected.json", "marker", "packet.json"]);
});

test("D1 an unreadable expected-context file is a domain refusal with no data", () => {
  const inputs = writeInputs(validPacket(), validExpected());
  dirs.push(inputs.dir);
  const result = Bun.spawnSync(
    [process.execPath, "run", "src/cli.ts", "check", "--packet", inputs.packet, "--expected", join(inputs.dir, "absent.json"), "--json"],
    { cwd: ROOT, stderr: "pipe", stdout: "pipe" },
  );
  expect(result.exitCode).toBe(3);
  expect(result.stderr.toString()).toBe("");
  expect(JSON.parse(result.stdout.toString()).result).toMatchObject({ causeCode: "DOMAIN_PRECONDITION_UNMET", data: null, outcome: "refused", failureClass: "domain" });
});

test("S1 a packet that is not JSON is a schema refusal with no data", () => {
  const inputs = writeInputs(validPacket(), validExpected());
  dirs.push(inputs.dir);
  writeFileSync(inputs.packet, "{not json");
  const result = Bun.spawnSync(
    [process.execPath, "run", "src/cli.ts", "check", "--packet", inputs.packet, "--expected", inputs.expected, "--json"],
    { cwd: ROOT, stderr: "pipe", stdout: "pipe" },
  );
  expect(result.exitCode).toBe(4);
  expect(JSON.parse(result.stdout.toString()).result).toMatchObject({ causeCode: "SCHEMA_INVALID_INPUT", data: null, outcome: "refused", failureClass: "schema" });
});
