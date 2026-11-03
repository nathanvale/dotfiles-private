// One owner for the valid same-candidate packet and expected context. Tests mutate copies per case.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Json = Record<string, unknown>;

export function validExpected(): Json {
  return {
    identity: { host: "laptop", project: "experience-sdk", task: "experience-sdk/166", candidate: "cand-a" },
    observation: { source: "native task readback receipt", at: "2026-11-03T02:00:00Z" },
    inventory: { source: "native166 description", revision: "a3ba6911", complete: true, obligations: ["O1", "O2", "O3"] },
  };
}

export function validPacket(): Json {
  const evidence = (obligation: string) => ({
    subject: "closeout-packet source",
    sourceCandidate: "cand-a",
    obligation,
    reportPointer: `reports/166/${obligation}.log`,
    status: "fresh",
  });
  return {
    identity: {
      host: "laptop",
      project: "experience-sdk",
      task: "experience-sdk/166",
      candidate: "cand-a",
      observedAt: "2026-11-03T02:00:00Z",
      executionOwner: "experience-sdk coordinator",
    },
    outcome: { scopedResult: "checker built", nativeState: "todo", proposedDisposition: "accept T01", limits: ["no native PASS"] },
    evidence: [evidence("O1"), evidence("O2"), evidence("O3")],
    downstream: { coverage: "complete", claim: "effects", effects: ["releases experience-sdk/167"] },
    unresolved: { holds: [], humanChoices: [] },
    decision: {
      action: "accept T01 outcome",
      readback: "native task details",
      grants: [
        {
          originalRecord: "reports/166/grant.json",
          action: "author T01",
          scope: "experience-sdk/166",
          conditions: ["independent review"],
          exclusions: ["publication"],
        },
      ],
    },
  };
}

export function writeInputs(packet: Json, expected: Json): { dir: string; packet: string; expected: string } {
  const dir = mkdtempSync(join(tmpdir(), "closeout-packet-test-"));
  const packetPath = join(dir, "packet.json");
  const expectedPath = join(dir, "expected.json");
  writeFileSync(packetPath, JSON.stringify(packet));
  writeFileSync(expectedPath, JSON.stringify(expected));
  return { dir, packet: packetPath, expected: expectedPath };
}
