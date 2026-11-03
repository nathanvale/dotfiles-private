// Closeout packet completeness check: the packet and a separately supplied expected context in, recorded-structure
// findings out. Reads only the values it is given; it never establishes evidence truth, authority or native PASS.

export type FindingCode =
  | "EXPECTED_CONTEXT_MISSING"
  | "IDENTITY_MISMATCH"
  | "FIELD_MISSING"
  | "INVENTORY_UNBOUND"
  | "OBLIGATION_UNACCOUNTED"
  | "EVIDENCE_BINDING_MISSING"
  | "REUSE_UNQUALIFIED"
  | "DOWNSTREAM_COVERAGE_UNKNOWN"
  | "HOLD_UNOWNED"
  | "GRANT_BINDING_INCOMPLETE"
  | "NATIVE_STATE_UNDECLARED";

export interface Finding {
  code: FindingCode;
  path: string;
  repair: string;
}

export interface Unknown {
  path: string;
  owner: string | null;
  nextSafeStep: string | null;
}

export interface CheckResult {
  reporting: "complete" | "incomplete" | "inconsistent";
  actionability: "supports-requested-action" | "blocked" | "not-assessed";
  findings: Finding[];
  unknowns: Unknown[];
  establishes: "recorded-structure-only";
  doesNotEstablish: string[];
}

export type JsonObject = Record<string, unknown>;

const IDENTITY_FIELDS = ["host", "project", "task", "candidate"] as const;
const PACKET_FIELDS = [
  "identity",
  "outcome",
  "evidence",
  "downstream",
  "unresolved",
  "decision",
] as const;
const EVIDENCE_STATUSES = new Set([
  "fresh",
  "carried",
  "cache",
  "failed",
  "missing",
  "not-applicable",
]);
const BLOCKING_STATUSES = new Set(["failed", "missing"]);

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function texts(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => text(item) !== null)
    ? (value as string[])
    : null;
}

function records(value: unknown): JsonObject[] | null {
  return Array.isArray(value) && value.every(isRecord) ? value : null;
}

class Findings {
  readonly list: Finding[] = [];
  add(code: FindingCode, path: string, repair: string): void {
    this.list.push({ code, path, repair });
  }
  requireText(source: JsonObject, key: string, path: string): string | null {
    const value = text(source[key]);
    if (value === null)
      this.add("FIELD_MISSING", `${path}.${key}`, `Record ${path}.${key}.`);
    return value;
  }
}

function checkExpectedIdentity(
  expected: JsonObject,
  findings: Findings,
): Record<string, string> | null {
  const identity = isRecord(expected.identity) ? expected.identity : {};
  const observation = isRecord(expected.observation)
    ? expected.observation
    : {};
  const resolved: Record<string, string> = {};
  const required: [JsonObject, string, string][] = [
    ...IDENTITY_FIELDS.map(
      (key) => [identity, key, `expected.identity.${key}`] as [JsonObject, string, string],
    ),
    [observation, "source", "expected.observation.source"],
    [observation, "at", "expected.observation.at"],
  ];
  for (const [source, key, path] of required) {
    const value = text(source[key]);
    if (value === null)
      findings.add(
        "EXPECTED_CONTEXT_MISSING",
        path,
        "Supply it from a separately identified owner observation, not from the packet.",
      );
    else resolved[path] = value;
  }
  return Object.keys(resolved).length === required.length ? resolved : null;
}

function checkIdentity(
  packet: JsonObject,
  expected: Record<string, string> | null,
  findings: Findings,
): void {
  const identity = packet.identity as JsonObject;
  for (const key of [...IDENTITY_FIELDS, "observedAt", "executionOwner"]) {
    findings.requireText(identity, key, "identity");
  }
  if (expected === null) return;
  for (const key of IDENTITY_FIELDS) {
    const actual = text(identity[key]);
    if (actual !== null && actual !== expected[`expected.identity.${key}`])
      findings.add(
        "IDENTITY_MISMATCH",
        `identity.${key}`,
        "Reconcile the packet with the independent expected context before relying on it.",
      );
  }
}

function checkOutcome(packet: JsonObject, findings: Findings): void {
  const outcome = packet.outcome as JsonObject;
  findings.requireText(outcome, "scopedResult", "outcome");
  findings.requireText(outcome, "proposedDisposition", "outcome");
  if (texts(outcome.limits) === null)
    findings.add("FIELD_MISSING", "outcome.limits", "List the disposition's limits.");
  if (text(outcome.nativeState) === null)
    findings.add(
      "NATIVE_STATE_UNDECLARED",
      "outcome.nativeState",
      "State the actual native state beside the proposed disposition.",
    );
}

function inventoryOf(expected: JsonObject, findings: Findings): string[] {
  const inventory = isRecord(expected.inventory) ? expected.inventory : {};
  const obligations = texts(inventory.obligations);
  if (
    text(inventory.source) === null ||
    text(inventory.revision) === null ||
    inventory.complete !== true ||
    obligations === null
  )
    findings.add(
      "INVENTORY_UNBOUND",
      "expected.inventory",
      "Bind a complete obligation inventory to its source and revision; a partial inventory remains a coverage gap.",
    );
  return obligations ?? [];
}

function checkEvidenceItem(
  item: JsonObject,
  path: string,
  candidate: string | null,
  findings: Findings,
): void {
  const status = text(item.status);
  const keys =
    status === "not-applicable"
      ? ["obligation", "justification"]
      : ["subject", "sourceCandidate", "obligation", "reportPointer"];
  const unbound =
    status === null ||
    !EVIDENCE_STATUSES.has(status) ||
    keys.some((key) => text(item[key]) === null);
  if (unbound)
    findings.add(
      "EVIDENCE_BINDING_MISSING",
      path,
      "Name the subject, source candidate, supported obligation, original report pointer and execution status.",
    );
  const source = text(item.sourceCandidate);
  if (status !== "not-applicable" && source !== null && candidate !== null && source !== candidate)
    findings.add(
      "REUSE_UNQUALIFIED",
      path,
      "Cross-candidate reuse stays incomplete until its applicability assessment is qualified (T02).",
    );
}

function checkEvidence(
  packet: JsonObject,
  obligations: string[],
  candidate: string | null,
  findings: Findings,
): JsonObject[] {
  const items = records(packet.evidence);
  if (items === null || (items.length === 0 && obligations.length > 0)) {
    findings.add("FIELD_MISSING", "evidence", "Account for every obligation.");
    return [];
  }
  for (const [index, item] of items.entries()) {
    checkEvidenceItem(item, `evidence[${index}]`, candidate, findings);
  }
  const accounted = new Set<string>();
  for (const [index, item] of items.entries()) {
    const obligation = text(item.obligation);
    if (obligation === null) continue;
    if (accounted.has(obligation))
      findings.add(
        "EVIDENCE_BINDING_MISSING",
        `evidence[${index}].obligation`,
        "Record exactly one evidence outcome per obligation; reconcile duplicate entries.",
      );
    accounted.add(obligation);
  }
  for (const obligation of obligations) {
    if (!accounted.has(obligation))
      findings.add(
        "OBLIGATION_UNACCOUNTED",
        `evidence:${obligation}`,
        "Record its evidence outcome, explicit missing proof or justified non-applicability.",
      );
  }
  return items;
}

function checkDownstream(
  packet: JsonObject,
  findings: Findings,
  unknowns: Unknown[],
): boolean {
  const downstream = packet.downstream as JsonObject;
  const coverage = text(downstream.coverage);
  if (coverage === "complete") {
    if (records(downstream.effects) === null && texts(downstream.effects) === null)
      findings.add("FIELD_MISSING", "downstream.effects", "List the observed effects, or an empty list for none.");
    return true;
  }
  const owner = text(downstream.owner);
  const nextSafeStep = text(downstream.nextSafeStep);
  if (coverage === "partial" || coverage === "unknown")
    unknowns.push({ path: "downstream.coverage", owner, nextSafeStep });
  if (
    (coverage !== "partial" && coverage !== "unknown") ||
    downstream.claim === "no-effects" ||
    owner === null ||
    nextSafeStep === null
  )
    findings.add(
      "DOWNSTREAM_COVERAGE_UNKNOWN",
      "downstream.coverage",
      "Keep unknown coverage explicit with an owner and next safe step; it cannot support a no-effects claim.",
    );
  return false;
}

function checkUnresolved(packet: JsonObject, findings: Findings): number {
  const unresolved = packet.unresolved as JsonObject;
  const holds = records(unresolved.holds);
  if (holds === null) {
    findings.add("FIELD_MISSING", "unresolved.holds", "List engineering holds, or an empty list for none.");
    return 0;
  }
  holds.forEach((hold, index) => {
    if (text(hold.owner) === null || text(hold.releaseCondition) === null)
      findings.add(
        "HOLD_UNOWNED",
        `unresolved.holds[${index}]`,
        "Name the hold's owner and release condition.",
      );
  });
  return holds.length;
}

function checkDecision(packet: JsonObject, findings: Findings): void {
  const decision = packet.decision as JsonObject;
  findings.requireText(decision, "action", "decision");
  findings.requireText(decision, "readback", "decision");
  const grants = records(decision.grants);
  if (grants === null) {
    findings.add("FIELD_MISSING", "decision.grants", "List relied-on grants, or an empty list for none.");
    return;
  }
  grants.forEach((grant, index) => {
    const bound =
      ["originalRecord", "action", "scope"].every((key) => text(grant[key]) !== null) &&
      texts(grant.conditions) !== null &&
      texts(grant.exclusions) !== null;
    if (!bound)
      findings.add(
        "GRANT_BINDING_INCOMPLETE",
        `decision.grants[${index}]`,
        "Point to the original authorization record with its action, scope, conditions and exclusions.",
      );
  });
}

function presentFields(packet: JsonObject, findings: Findings): boolean {
  let present = true;
  for (const field of PACKET_FIELDS) {
    const value = packet[field];
    const ok = field === "evidence" ? Array.isArray(value) : isRecord(value);
    if (!ok) {
      findings.add("FIELD_MISSING", field, `Populate the ${field} field.`);
      present = false;
    }
  }
  return present;
}

function verdictOf(findings: Finding[]): CheckResult["reporting"] {
  if (findings.some((finding) => finding.code === "IDENTITY_MISMATCH")) return "inconsistent";
  return findings.length === 0 ? "complete" : "incomplete";
}

/** Compare one closeout packet with its separately supplied expected context. */
export function checkPacket(packet: JsonObject, expected: JsonObject): CheckResult {
  const findings = new Findings();
  const unknowns: Unknown[] = [];
  const expectedIdentity = checkExpectedIdentity(expected, findings);
  const obligations = inventoryOf(expected, findings);
  let blocked = true;
  if (presentFields(packet, findings)) {
    checkIdentity(packet, expectedIdentity, findings);
    checkOutcome(packet, findings);
    const candidate = text((packet.identity as JsonObject).candidate);
    const items = checkEvidence(packet, obligations, candidate, findings);
    const covered = checkDownstream(packet, findings, unknowns);
    const holds = checkUnresolved(packet, findings);
    checkDecision(packet, findings);
    const failedProof = items.some((item) => typeof item.status === "string" && BLOCKING_STATUSES.has(item.status));
    blocked = !covered || holds > 0 || failedProof;
  }
  const sorted = [...findings.list].sort((a, b) =>
    `${a.code}|${a.path}`.localeCompare(`${b.code}|${b.path}`),
  );
  const reporting = verdictOf(sorted);
  return {
    reporting,
    actionability:
      reporting !== "complete" ? "not-assessed" : blocked ? "blocked" : "supports-requested-action",
    findings: sorted,
    unknowns,
    establishes: "recorded-structure-only",
    doesNotEstablish: [
      "authority",
      "dependency-completeness",
      "evidence-truth",
      "freshness",
      "native-pass",
    ],
  };
}

export function isPacketRecord(value: unknown): value is JsonObject {
  return isRecord(value);
}
