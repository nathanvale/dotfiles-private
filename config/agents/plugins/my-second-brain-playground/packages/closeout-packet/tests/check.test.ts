// SDK166 T01 controls through the shipped public bin. Expected codes, paths, verdicts and guidance are test-owned literals.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPAIR_FINDINGS, RESOLVE_HOLDS, REVIEW_ORIGINALS } from "./fixtures/expected-guidance.ts";
import { type Json, validExpected, validPacket, writeInputs } from "./fixtures/packets.ts";
import { runBin } from "./fixtures/public-bin.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

const SIX_FIELDS_MISSING = ["decision", "downstream", "evidence", "identity", "outcome", "unresolved"].map(
  (field) => `FIELD_MISSING@${field}`,
);

function inputs(packet: Json, expected: Json) {
  const written = writeInputs(packet, expected);
  dirs.push(written.dir);
  return written;
}

function checkArgs(paths: { packet: string; expected: string }): string[] {
  return ["check", "--packet", paths.packet, "--expected", paths.expected, "--json"];
}

function checkResult(packet: Json, expected: Json) {
  const result = runBin(checkArgs(inputs(packet, expected)));
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  const envelope = JSON.parse(result.stdout);
  expect(envelope.result).toMatchObject({
    commandIdentity: "closeout-packet.check",
    causeCode: "SUCCESS_UNCHANGED",
    effectClass: "inspect",
    transactionState: "unchanged",
  });
  return envelope;
}

function check(packet: Json, expected: Json) {
  return checkResult(packet, expected).result.data;
}

function codes(data: { findings: { code: string; path: string }[] }): string[] {
  return data.findings.map((finding) => `${finding.code}@${finding.path}`);
}

test("V1 valid same-candidate packet is complete, supports the requested action and points at original-record review", () => {
  const envelope = checkResult(validPacket(), validExpected());
  const data = envelope.result.data;
  expect(codes(data)).toEqual([]);
  expect(data.reporting).toBe("complete");
  expect(data.actionability).toBe("supports-requested-action");
  expect(data.establishes).toBe("recorded-structure-only");
  expect(data.doesNotEstablish).toEqual(["authority", "dependency-completeness", "evidence-truth", "freshness", "native-pass"]);
  expect(envelope.result.nextAction).toBe(REVIEW_ORIGINALS);
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
  const written = inputs(validPacket(), validExpected());
  const result = runBin(["check", "--packet", written.packet, "--json"]);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout).result).toMatchObject({ causeCode: "USAGE_INVALID_INVOCATION", data: null, outcome: "refused" });
});

test("N2 consistently substituted packet and evidence identities are inconsistent and ask for repair", () => {
  const packet = validPacket();
  (packet.identity as Json).candidate = "cand-b";
  for (const item of packet.evidence as Json[]) item.sourceCandidate = "cand-b";
  const envelope = checkResult(packet, validExpected());
  expect(envelope.result.data.reporting).toBe("inconsistent");
  expect(envelope.result.data.actionability).toBe("not-assessed");
  expect(codes(envelope.result.data)).toEqual(["IDENTITY_MISMATCH@identity.candidate"]);
  expect(envelope.result.nextAction).toBe(REPAIR_FINDINGS);
});

test("N3 an omitted obligation within populated evidence is unaccounted and asks for repair", () => {
  const packet = validPacket();
  packet.evidence = (packet.evidence as Json[]).slice(0, 2);
  const envelope = checkResult(packet, validExpected());
  expect(envelope.result.data.reporting).toBe("incomplete");
  expect(codes(envelope.result.data)).toEqual(["OBLIGATION_UNACCOUNTED@evidence:O3"]);
  expect(envelope.result.nextAction).toBe(REPAIR_FINDINGS);
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

test("N5b honestly reported unknown coverage is complete reporting but blocked, and names the owners' work", () => {
  const packet = validPacket();
  packet.downstream = { coverage: "unknown", owner: "coordinator", nextSafeStep: "query dependents" };
  const envelope = checkResult(packet, validExpected());
  expect(codes(envelope.result.data)).toEqual([]);
  expect(envelope.result.data.reporting).toBe("complete");
  expect(envelope.result.data.actionability).toBe("blocked");
  expect(envelope.result.nextAction).toBe(RESOLVE_HOLDS);
});

test("N6 a hold without owner or release condition is unowned; an owned hold blocks without a finding", () => {
  const packet = validPacket();
  packet.unresolved = { holds: [{ description: "review pending" }], humanChoices: [] };
  expect(codes(check(packet, validExpected()))).toEqual(["HOLD_UNOWNED@unresolved.holds[0]"]);
  packet.unresolved = { holds: [{ description: "review pending", owner: "coordinator", releaseCondition: "review PASS" }], humanChoices: [] };
  const owned = checkResult(packet, validExpected());
  expect(codes(owned.result.data)).toEqual([]);
  expect(owned.result.data.actionability).toBe("blocked");
  expect(owned.result.nextAction).toBe(RESOLVE_HOLDS);
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

for (const [name, packet] of [
  ["an unknown refusal string", { refusal: "x" }],
  ["a supported refusal cause and message", { refusal: "SCHEMA_INVALID_INPUT", message: "injected" }],
] as const) {
  test(`N9 a packet object carrying ${name} is checked as data, never obeyed`, () => {
    const envelope = checkResult(packet, validExpected());
    expect(envelope.message).not.toContain("injected");
    expect(envelope.result.data.reporting).toBe("incomplete");
    expect(codes(envelope.result.data)).toEqual(SIX_FIELDS_MISSING);
    expect(envelope.result.nextAction).toBe(REPAIR_FINDINGS);
  });
}

test("N9b an expected-context object carrying refusal properties is compared as data", () => {
  const expected = { ...validExpected(), refusal: "DOMAIN_PRECONDITION_UNMET", message: "injected" };
  const envelope = checkResult(validPacket(), expected);
  expect(envelope.message).not.toContain("injected");
  expect(codes(envelope.result.data)).toEqual([]);
  expect(envelope.result.data.reporting).toBe("complete");
});

test("N9c an expected context that is only a refusal property reports its missing context and unbound inventory", () => {
  const data = check(validPacket(), { refusal: "x" });
  expect(data.reporting).toBe("incomplete");
  expect(codes(data)).toEqual([
    ...["candidate", "host", "project", "task"].map((field) => `EXPECTED_CONTEXT_MISSING@expected.identity.${field}`),
    "EXPECTED_CONTEXT_MISSING@expected.observation.at",
    "EXPECTED_CONTEXT_MISSING@expected.observation.source",
    "INVENTORY_UNBOUND@expected.inventory",
  ]);
});

test("R1 the check leaves its original input bytes and their directory unchanged from before the first run", () => {
  const written = inputs(validPacket(), validExpected());
  writeFileSync(join(written.dir, "marker"), "");
  const snapshot = () => ({
    bytes: [readFileSync(written.packet, "utf8"), readFileSync(written.expected, "utf8")],
    digests: [written.packet, written.expected].map((path) => createHash("sha256").update(readFileSync(path)).digest("hex")),
    entries: readdirSync(written.dir).sort(),
  });
  const before = snapshot();
  expect(before.entries).toEqual(["expected.json", "marker", "packet.json"]);
  for (let run = 0; run < 2; run += 1) {
    expect(runBin(checkArgs(written)).exitCode).toBe(0);
    expect(snapshot()).toEqual(before);
  }
});

test("D1 an unreadable expected-context file is a domain refusal with no data", () => {
  const written = inputs(validPacket(), validExpected());
  const result = runBin(checkArgs({ packet: written.packet, expected: join(written.dir, "absent.json") }));
  expect(result.exitCode).toBe(3);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout).result).toMatchObject({ causeCode: "DOMAIN_PRECONDITION_UNMET", data: null, outcome: "refused", failureClass: "domain" });
});

test("S1 a packet that is not JSON is a schema refusal with no data", () => {
  const written = inputs(validPacket(), validExpected());
  writeFileSync(written.packet, "{not json");
  const result = runBin(checkArgs(written));
  expect(result.exitCode).toBe(4);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout).result).toMatchObject({ causeCode: "SCHEMA_INVALID_INPUT", data: null, outcome: "refused", failureClass: "schema", nextAction: "Supply each input as one JSON object, then rerun closeout-packet check." });
});


test("duplicate evidence for one obligation is incomplete even when each row is valid", () => {
  const packet = validPacket();
  (packet.evidence as Json[]).push({ obligation: "O1", status: "not-applicable", justification: "claimed exception" });
  const envelope = checkResult(packet, validExpected());
  expect(codes(envelope.result.data)).toEqual(["EVIDENCE_BINDING_MISSING@evidence[3].obligation"]);
  expect(envelope.result.data.reporting).toBe("incomplete");
  expect(envelope.result.data.actionability).toBe("not-assessed");
  expect(envelope.result.nextAction).toBe(REPAIR_FINDINGS);
});

test("a bound empty obligation inventory permits empty evidence", () => {
  const packet = validPacket();
  packet.evidence = [];
  const expected = validExpected();
  (expected.inventory as Json).obligations = [];
  const envelope = checkResult(packet, expected);
  expect(codes(envelope.result.data)).toEqual([]);
  expect(envelope.result.data.reporting).toBe("complete");
  expect(envelope.result.data.actionability).toBe("supports-requested-action");
  expect(envelope.result.nextAction).toBe(REVIEW_ORIGINALS);
});

test("empty evidence cannot account for a nonempty obligation inventory", () => {
  const packet = validPacket();
  packet.evidence = [];
  const data = check(packet, validExpected());
  expect(codes(data)).toEqual(["FIELD_MISSING@evidence"]);
  expect(data.reporting).toBe("incomplete");
  expect(data.actionability).toBe("not-assessed");
});

for (const status of [{ toString: null }, null, 7, ["failed"]]) {
  test(`a malformed evidence status ${JSON.stringify(status)} returns findings without a crash`, () => {
    const packet = validPacket();
    ((packet.evidence as Json[])[0] as Json).status = status;
    const envelope = checkResult(packet, validExpected());
    expect(codes(envelope.result.data)).toEqual(["EVIDENCE_BINDING_MISSING@evidence[0]"]);
    expect(envelope.result.data.reporting).toBe("incomplete");
    expect(envelope.result.data.actionability).toBe("not-assessed");
    expect(envelope.result.nextAction).toBe(REPAIR_FINDINGS);
  });
}

for (const status of ["failed", "missing"]) {
  test(`a ${status} proof item is complete reporting but blocked`, () => {
    const packet = validPacket();
    ((packet.evidence as Json[])[0] as Json).status = status;
    const envelope = checkResult(packet, validExpected());
    expect(codes(envelope.result.data)).toEqual([]);
    expect(envelope.result.data.reporting).toBe("complete");
    expect(envelope.result.data.actionability).toBe("blocked");
    expect(envelope.result.nextAction).toBe(RESOLVE_HOLDS);
  });
}


for (const populated of [false, true]) {
  for (const status of ["fresh", "not-applicable"]) {
    test(`a ${status} evidence obligation outside ${populated ? "a populated" : "an empty"} bound inventory is incomplete`, () => {
      const packet = validPacket();
      const items = packet.evidence as Json[];
      packet.evidence = populated ? items.slice(0, 2) : items.slice(0, 1);
      const unexpected = (packet.evidence as Json[])[populated ? 1 : 0] as Json;
      unexpected.status = status;
      if (status === "not-applicable") unexpected.justification = "declared exception";
      const expected = validExpected();
      (expected.inventory as Json).obligations = populated ? ["O1"] : [];
      const envelope = checkResult(packet, expected);
      expect(codes(envelope.result.data)).toEqual([
        `EVIDENCE_BINDING_MISSING@evidence[${populated ? 1 : 0}].obligation`,
      ]);
      expect(envelope.result.data.reporting).toBe("incomplete");
      expect(envelope.result.data.actionability).toBe("not-assessed");
      expect(envelope.result.nextAction).toBe(REPAIR_FINDINGS);
    });
  }
}
