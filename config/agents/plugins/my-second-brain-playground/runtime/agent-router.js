// @bun
// packages/agent-router/src/cli.ts
import { homedir as homedir2 } from "os";
import { isAbsolute, join as join2, resolve } from "path";

// packages/agent-router/src/freshness.ts
var FRESHNESS_DAYS = 7;
var DAY_MILLISECONDS = 86400000;
var LIMIT_MILLISECONDS = FRESHNESS_DAYS * DAY_MILLISECONDS;
function freshness(observedAt, now) {
  if (observedAt === null)
    return { state: "not-observed", observedAt: null, ageDays: null };
  const elapsed = now - Date.parse(observedAt);
  if (Number.isNaN(elapsed) || elapsed < 0)
    return { state: "invalid", observedAt, ageDays: null };
  return { state: elapsed > LIMIT_MILLISECONDS ? "stale" : "fresh", observedAt, ageDays: Math.floor(elapsed / DAY_MILLISECONDS) };
}

// packages/agent-router/src/card.ts
var GATE_ORDER = [
  { gate: "G1", name: "model listed" },
  { gate: "G2", name: "available on host" },
  { gate: "G3", name: "account ownership and identity" },
  { gate: "G4", name: "quota and reserve" },
  { gate: "G5", name: "route qualification" }
];
function guideFacts(guide) {
  return { status: guide.status, path: guide.path, revision: guide.status === "reviewed" ? guide.sha256 : null };
}
var UNKNOWN_QUOTA = { state: "unknown", freshness: { state: "not-observed", observedAt: null, ageDays: null } };
function declaredRoute(route, evidence) {
  const harness = evidence.harnesses[route.harness];
  return {
    id: route.id,
    origin: "routes-file",
    harness: route.harness,
    harnessVersion: harness?.version ?? null,
    model: { id: route.model.id, alias: route.model.alias ?? null, listedBy: "routes file declaration" },
    effort: { declared: route.effort, observed: "unknown" },
    account: { alias: route.account.alias, ownership: route.account.ownership, plan: route.account.plan ?? null, proof: "unknown" },
    quota: UNKNOWN_QUOTA,
    hosts: { declared: route.hosts, qualified: [], unmappedEvidenceHosts: 0 },
    availability: null,
    launch: route.launch,
    protocols: [],
    modelGuide: guideFacts(evidence.guide(route.harness, route.model.id))
  };
}
function monashRoute(route, evidence, now) {
  return {
    id: route.id,
    origin: "monash-snapshot",
    harness: route.harness,
    harnessVersion: evidence.harnesses[route.harness]?.version ?? null,
    model: { id: route.modelId, alias: null, listedBy: "Monash snapshot" },
    effort: { declared: null, observed: "unknown" },
    account: { alias: null, ownership: "employer", plan: null, proof: "unknown" },
    quota: UNKNOWN_QUOTA,
    hosts: { declared: [], qualified: route.qualifiedHosts, unmappedEvidenceHosts: route.unmappedEvidenceHosts },
    availability: { state: route.availability, freshness: freshness(evidence.monash.snapshotObservedAt, now) },
    launch: "not-declared",
    protocols: route.protocols,
    modelGuide: guideFacts(evidence.guide(route.harness, route.modelId))
  };
}
function uncertain(route, gate, reason) {
  const personal = route.account.ownership === "personal";
  const article = route.account.ownership === "employer" ? "an" : "a";
  return { gate, verdict: personal ? "confirm" : "refuse", evidence: "unknown", reason: personal ? `${reason}; Nathan must confirm` : `${reason}; ${article} ${route.account.ownership} route never launches on it` };
}
function gateModel(route) {
  const alias = route.model.alias === null ? "" : ` (alias ${route.model.alias})`;
  const evidence = route.origin === "routes-file" ? "declared" : "observed";
  return { gate: "G1", verdict: "pass", evidence, reason: `${route.model.id}${alias} listed by the ${route.model.listedBy}` };
}
function gateDeclaredHost(route, evidence) {
  const harness = evidence.harnesses[route.harness];
  if (harness?.status !== "observed")
    return { gate: "G2", verdict: "refuse", evidence: "unknown", reason: `${route.harness} is ${harness?.status ?? "not-found"} on this host (${harness?.source ?? "--version"})` };
  if (evidence.host.role === null)
    return uncertain(route, "G2", `this host's role is unknown: ${evidence.host.reason}`);
  if (!route.hosts.declared.includes(evidence.host.role)) {
    return { gate: "G2", verdict: "refuse", evidence: "observed", reason: `declared for ${route.hosts.declared.join(", ")}, but this host is ${evidence.host.role}` };
  }
  return { gate: "G2", verdict: "pass", evidence: "observed", reason: `${route.harness} ${harness.version} present; this host is ${evidence.host.role}` };
}
function gateMonashAvailability(route) {
  const availability = route.availability;
  if (availability === null || availability.state !== "available")
    return { gate: "G2", verdict: "refuse", evidence: "observed", reason: `the snapshot reports ${availability?.state ?? "no"} availability` };
  const fresh = availability.freshness;
  if (fresh.state === "invalid")
    return { gate: "G2", verdict: "refuse", evidence: "unknown", reason: `the snapshot timestamp ${fresh.observedAt} is in the future or unreadable, so it is not evidence` };
  if (fresh.state === "stale") {
    return { gate: "G2", verdict: "refuse", evidence: "stale", reason: `available per a snapshot ${fresh.ageDays} days old (older than ${FRESHNESS_DAYS} days); stale evidence blocks launch` };
  }
  return { gate: "G2", verdict: "pass", evidence: "observed", reason: `available per the snapshot of ${fresh.observedAt}` };
}
function gateAccount(route) {
  const label = route.account.alias === null ? `${route.account.ownership} account` : `declared alias ${route.account.alias}`;
  return uncertain(route, "G3", `identity unknown for ${label}; no owner observes identity yet and a login is not proof`);
}
function gateQuota(route) {
  if (route.origin === "monash-snapshot")
    return { gate: "G4", verdict: "refuse", evidence: "unknown", reason: "Monash reserve is refused until a supported usage source exists" };
  return uncertain(route, "G4", "quota unknown: no usage source observed");
}
function versionAtLeast(version, minimum) {
  if (minimum === null)
    return true;
  if (version === null)
    return false;
  const have = version.split(".").map(Number);
  const need = minimum.split(".").map(Number);
  for (let index = 0;index < need.length; index += 1) {
    const difference = (have[index] ?? 0) - (need[index] ?? 0);
    if (difference !== 0)
      return difference > 0;
  }
  return true;
}
function qualificationProblems(route, guide, evidence) {
  const problems = [];
  if (route.origin === "monash-snapshot") {
    if (evidence.host.role === null)
      problems.push(`qualified on ${route.hosts.qualified.join(", ") || "no mapped host"}, but this host's role is unknown`);
    else if (!route.hosts.qualified.includes(evidence.host.role))
      problems.push(`not qualified on this host (${evidence.host.role})`);
    problems.push("not declared for launch in the routes file (D1: dry run only)");
  } else if (route.launch === "dry-run-only")
    problems.push("declared dry-run-only");
  if (guide.status !== "reviewed")
    problems.push(guide.reason);
  else if (!versionAtLeast(route.harnessVersion, guide.harnessMinVersion))
    problems.push(`the guide needs ${route.harness} ${guide.harnessMinVersion} or later`);
  return problems;
}
function gateQualification(route, evidence) {
  const guide = evidence.guide(route.harness, route.model.id);
  const problems = qualificationProblems(route, guide, evidence);
  if (problems.length > 0)
    return { gate: "G5", verdict: "refuse", evidence: guide.status === "reviewed" ? "observed" : "unknown", reason: problems.join("; ") };
  return { gate: "G5", verdict: "pass", evidence: "observed", reason: `launch allowed; reviewed Model Guide ${guide.path}` };
}
function judge(route, evidence) {
  const host = route.origin === "routes-file" ? gateDeclaredHost(route, evidence) : gateMonashAvailability(route);
  const results = [gateModel(route), host, gateAccount(route), gateQuota(route), gateQualification(route, evidence)];
  const refusal = results.find((result) => result.verdict === "refuse") ?? null;
  const confirmations = results.filter((result) => result.verdict === "confirm").map((result) => result.gate);
  return {
    ...route,
    gates: results,
    decision: refusal === null ? "needs-confirmation" : "refused",
    refusal: refusal === null ? null : { gate: refusal.gate, reason: refusal.reason },
    confirmations
  };
}
function routeGaps(route) {
  const monash = route.origin === "monash-snapshot";
  const gaps = [
    monash ? { field: "effort", reason: "the snapshot does not state effort", owner: "Monash CLI owner or Agent Router" } : { field: "effort (observed)", reason: `declared ${route.effort.declared}; no inspect probe observes effort (D7)`, owner: "hpr-f5n.4 launch receipt" }
  ];
  if (!monash)
    gaps.push({ field: "model (native setting)", reason: "declared only; launch must check the native setting (D2)", owner: "hpr-f5n.4 launch receipt" });
  gaps.push({ field: "account proof", reason: "identity unknown; no owner observes identity yet", owner: monash ? "Monash CLI owner" : "a non-secret identity source observed at launch (hpr-f5n.4)" });
  gaps.push({ field: "quota", reason: "no usage source observed", owner: monash ? "Monash CLI owner or Agent Router" : "a supported usage source" });
  if (route.modelGuide.status !== "reviewed") {
    gaps.push({ field: "model guide", reason: `${route.modelGuide.status}: no accepted guide for the exact harness and model`, owner: "Stage Manager skill guides (Code Reviewer acceptance)" });
  }
  if (route.hosts.unmappedEvidenceHosts > 0) {
    gaps.push({ field: "qualification host", reason: "evidence names a host that is neither this host's role nor a declared host", owner: "Monash snapshot owner" });
  }
  return gaps;
}
function snapshotGap(evidence, now) {
  if (evidence.monash.status !== "observed")
    return { routes: ["monash"], field: "Monash snapshot", reason: `snapshot ${evidence.monash.status}`, owner: "Monash CLI owner" };
  const fresh = freshness(evidence.monash.snapshotObservedAt, now);
  if (fresh.state === "stale") {
    return { routes: ["monash"], field: "snapshot freshness", reason: `observed ${fresh.observedAt}, older than ${FRESHNESS_DAYS} days`, owner: "Nathan (monash models --refresh is outside this command)" };
  }
  if (fresh.state === "invalid")
    return { routes: ["monash"], field: "snapshot freshness", reason: `observed_at ${fresh.observedAt} is in the future or unreadable`, owner: "Monash CLI owner" };
  return null;
}
function sharedGaps(evidence, now) {
  const gaps = [];
  if (evidence.host.role === null)
    gaps.push({ routes: ["all"], field: "this host's role", reason: evidence.host.reason, owner: "Monash Foundry installation manifest" });
  const snapshot = snapshotGap(evidence, now);
  if (snapshot !== null)
    gaps.push(snapshot);
  if (evidence.target.status !== "present")
    gaps.push({ routes: ["all"], field: "Herdr Projects target", reason: `target ${evidence.target.status}`, owner: "Stage Manager (--project and --herdr-projects-root)" });
  return gaps;
}
function mergeGaps(routes, shared) {
  const merged = new Map;
  for (const route of routes) {
    for (const gap of routeGaps(route)) {
      const key = `${gap.field}|${gap.reason}|${gap.owner}`;
      const existing = merged.get(key);
      if (existing === undefined)
        merged.set(key, { ...gap, routes: [route.id] });
      else
        existing.routes.push(route.id);
    }
  }
  return [...merged.values(), ...shared].map((gap, index) => ({ id: `GAP-${String(index + 1).padStart(2, "0")}`, ...gap }));
}
function pick(routes) {
  const candidates = routes.filter((route) => route.decision !== "refused");
  const base = { provisional: true, typeSafe: "not-consulted", order: "routes file order, then Monash snapshot order" };
  const [only] = candidates;
  if (only === undefined)
    return { ...base, status: "none-eligible", route: null, candidates: [], confirmations: [], modelGuideRevision: null };
  if (candidates.length > 1)
    return { ...base, status: "ask", route: null, candidates: candidates.map((route) => route.id), confirmations: [], modelGuideRevision: null };
  return { ...base, status: "needs-confirmation", route: only.id, candidates: [only.id], confirmations: only.confirmations, modelGuideRevision: only.modelGuide.revision };
}
function routesOf(inputs) {
  const { evidence, now } = inputs;
  return [...inputs.routesFile.routes.map((route) => declaredRoute(route, evidence)), ...evidence.monash.routes.map((route) => monashRoute(route, evidence, now))];
}
function sources(inputs) {
  const { evidence, now } = inputs;
  return {
    routesFile: { path: inputs.routesFile.path, status: inputs.routesFile.status },
    monash: {
      status: evidence.monash.status,
      source: evidence.monash.source,
      readAt: evidence.monash.readAt,
      snapshot: freshness(evidence.monash.snapshotObservedAt, now),
      unqualifiedCombinations: evidence.monash.unqualifiedCombinations
    },
    host: evidence.host,
    harnesses: evidence.harnesses
  };
}
function inventory(inputs) {
  const routes = routesOf(inputs);
  return { generatedAt: new Date(inputs.now).toISOString(), freshnessDays: FRESHNESS_DAYS, sources: sources(inputs), routes, gaps: mergeGaps(routes, sharedGaps(inputs.evidence, inputs.now)) };
}
function decisionCard(task, inputs) {
  const routes = routesOf(inputs);
  const judged = routes.map((route) => judge(route, inputs.evidence));
  return {
    task,
    generatedAt: new Date(inputs.now).toISOString(),
    mode: "dry-run",
    freshnessDays: FRESHNESS_DAYS,
    gateOrder: GATE_ORDER,
    target: inputs.evidence.target,
    sources: sources(inputs),
    routes: judged,
    pick: pick(judged),
    gaps: mergeGaps(routes, sharedGaps(inputs.evidence, inputs.now))
  };
}

// packages/agent-router/src/contract.ts
import { randomUUID } from "crypto";
var CONTRACT_VERSION = "2.0.0";
var COMMANDS = [
  { commandIdentity: "agent-router.dispatch", effectClass: "inspect", route: [], summary: "Refuse a missing, unknown or malformed command selection." },
  { commandIdentity: "agent-router.help", effectClass: "inspect", route: ["--help"], summary: "Show usage, commands and options." },
  { commandIdentity: "agent-router.discovery", effectClass: "inspect", route: ["--discover"], summary: "Describe the contract, commands and effect exclusions." },
  { commandIdentity: "agent-router.command-discovery", effectClass: "inspect", route: ["--discover-command"], summary: "Describe the possible stations of one command." },
  {
    commandIdentity: "agent-router.routes",
    effectClass: "inspect",
    route: ["routes"],
    summary: "Inventory declared and Monash Foundry routes with their evidence, freshness and owned gaps."
  },
  {
    commandIdentity: "agent-router.run",
    effectClass: "inspect",
    route: ["run"],
    summary: "Show the dry-run decision card for one Beads Task; launch is refused in this build."
  }
];
var AVAILABLE_PATHS = [
  "agent-router.command-discovery",
  "agent-router.discovery",
  "agent-router.help",
  "agent-router.routes",
  "agent-router.run"
];
var PROBE_RETRY_DELAY_MILLISECONDS = 5000;
var STATIONS = {
  usage: {
    causeCode: "USAGE_INVALID_INVOCATION",
    outcome: "refused",
    failureClass: "usage",
    exitCode: 2,
    trigger: "The arguments do not name one supported command with its required operands.",
    repairAction: "Choose one listed command with its required operands and retry.",
    guidance: { nextAction: "Run agent-router --help and choose a listed command." }
  },
  malformedInput: {
    causeCode: "SCHEMA_INVALID_INPUT",
    outcome: "refused",
    failureClass: "schema",
    exitCode: 4,
    trigger: "An operand or option value does not match its declared format.",
    repairAction: "Pass a Beads Task identifier (never Task text) and well-formed option values.",
    guidance: { nextAction: "Read agent-router --help --json for each value format, then retry." }
  },
  routesInvalid: {
    causeCode: "SCHEMA_CONFIG_INVALID",
    outcome: "refused",
    failureClass: "schema",
    exitCode: 4,
    trigger: "The routes file is not valid JSON or does not match the version 1 routes schema.",
    repairAction: "Repair the routes file against the schema in the agent-router README, then retry.",
    guidance: { nextAction: "Fix the reported routes-file field and rerun the command." }
  },
  routesMissing: {
    causeCode: "DOMAIN_CONFIG_MISSING",
    outcome: "refused",
    failureClass: "domain",
    exitCode: 3,
    trigger: "The dry run has no routes file to read, so no declared route can be judged.",
    repairAction: "Declare routes in the routes file (default $XDG_CONFIG_HOME/agent-router/routes.json) or pass --routes-file.",
    guidance: { nextAction: "Ask Nathan to declare permitted routes, then rerun the dry run." }
  },
  launchRefused: {
    causeCode: "DOMAIN_AUTHORITY_REQUIRED",
    outcome: "refused",
    failureClass: "domain",
    exitCode: 3,
    trigger: "run was invoked without --dry-run; this build never launches an agent.",
    repairAction: "Add --dry-run to inspect the decision card; launch belongs to the approved Herdr Projects launch path.",
    guidance: {
      handoff: {
        owner: "human",
        reason: "Launching a worker needs the approved launch slice and Nathan's decision.",
        inspect: ["agent-router run TASK --dry-run"]
      }
    }
  },
  probeTimeout: {
    causeCode: "TRANSIENT_NOT_STARTED",
    outcome: "refused",
    failureClass: "transient",
    exitCode: 75,
    retryDelayMilliseconds: PROBE_RETRY_DELAY_MILLISECONDS,
    trigger: "A read-only evidence probe did not answer within the probe time budget; no card was produced.",
    repairAction: "Retry after the delay, or raise --probe-timeout-ms when the probe is known to be slow.",
    guidance: { nextAction: "Retry the same command after the stated delay." }
  },
  inputUnreadable: {
    causeCode: "INTERNAL_UNEXPECTED",
    outcome: "failed",
    failureClass: "internal",
    exitCode: 1,
    trigger: "An input file exists but cannot be read, or the command fails unexpectedly.",
    repairAction: "Inspect the path named in the message; it must be a readable regular file.",
    guidance: {
      handoff: {
        owner: "human",
        reason: "An input file is present but unreadable, which the router cannot repair.",
        inspect: ["ls -l on the path named in the message"]
      }
    }
  },
  serialization: {
    causeCode: "INTERNAL_RESULT_SERIALIZATION",
    outcome: "failed",
    failureClass: "internal",
    exitCode: 1,
    trigger: "The result cannot be serialized, or the serialized value fails envelope validation.",
    repairAction: "Inspect the serialization failure before retrying.",
    guidance: { nextAction: "Inspect the runtime and retry the command." }
  },
  emission: {
    causeCode: "INTERNAL_RESULT_EMISSION",
    outcome: "failed",
    failureClass: "internal",
    exitCode: 1,
    trigger: "stdout cannot be written. Machine mode then emits no envelope and nothing on stderr; human mode prints this repair on stderr.",
    repairAction: "Inspect the output stream before retrying.",
    guidance: { nextAction: "Inspect the output stream and retry the command." }
  }
};
var COMMAND_STATIONS = {
  "agent-router.routes": ["usage", "malformedInput", "routesInvalid", "probeTimeout", "inputUnreadable", "serialization", "emission"],
  "agent-router.run": ["usage", "malformedInput", "routesInvalid", "routesMissing", "launchRefused", "probeTimeout", "inputUnreadable", "serialization", "emission"]
};
var SUCCESS_TRIGGERS = {
  "agent-router.routes": "The route inventory completes; unknown or stale evidence is reported, never hidden.",
  "agent-router.run": "The dry-run card completes; its pick is needs-confirmation, ask or none-eligible."
};
function effects() {
  return { completed: [], inventoryComplete: true, remaining: [], uncertain: [] };
}
function success(commandIdentity, data, message, nextAction) {
  return {
    envelopeVersion: 2,
    contractVersion: CONTRACT_VERSION,
    message,
    availablePaths: AVAILABLE_PATHS,
    result: {
      runId: randomUUID(),
      commandIdentity,
      outcome: "success",
      effectClass: "inspect",
      transactionState: "unchanged",
      causeCode: "SUCCESS_UNCHANGED",
      failureClass: null,
      exitCode: 0,
      data,
      retryable: false,
      repairAction: null,
      effects: effects(),
      nextAction
    }
  };
}
function stationResult(commandIdentity, key, message) {
  const station = STATIONS[key];
  const retry = station.retryDelayMilliseconds === undefined ? { retryable: false } : { retryable: true, retryDelayMilliseconds: station.retryDelayMilliseconds };
  return {
    envelopeVersion: 2,
    contractVersion: CONTRACT_VERSION,
    message,
    availablePaths: AVAILABLE_PATHS,
    result: {
      runId: randomUUID(),
      commandIdentity,
      outcome: station.outcome,
      effectClass: "inspect",
      transactionState: "unchanged",
      causeCode: station.causeCode,
      failureClass: station.failureClass,
      exitCode: station.exitCode,
      data: null,
      ...retry,
      repairAction: station.repairAction,
      effects: effects(),
      ...station.guidance
    }
  };
}
var IDENTITIES = COMMANDS.map((command) => command.commandIdentity);
var ENVELOPE_KEYS = ["availablePaths", "contractVersion", "envelopeVersion", "message", "result"];
var BASE_RESULT_KEYS = ["causeCode", "commandIdentity", "data", "effectClass", "effects", "exitCode", "failureClass", "outcome", "repairAction", "retryable", "runId", "transactionState"];
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonblank(value) {
  return typeof value === "string" && value.trim() !== "";
}
function sameKeys(value, keys) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function envelopeHolds(value) {
  const paths = value.availablePaths;
  if (!sameKeys(value, ENVELOPE_KEYS) || value.envelopeVersion !== 2 || value.contractVersion !== CONTRACT_VERSION || !nonblank(value.message))
    return false;
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string" && IDENTITIES.includes(path)))
    return false;
  return JSON.stringify(paths) === JSON.stringify([...new Set(paths)].sort());
}
function baseHolds(result) {
  const effects2 = result.effects;
  if (!nonblank(result.runId) || !IDENTITIES.includes(String(result.commandIdentity)))
    return false;
  if (result.effectClass !== "inspect" || result.transactionState !== "unchanged" || !isRecord(effects2))
    return false;
  return JSON.stringify(effects2) === JSON.stringify({ completed: [], inventoryComplete: true, remaining: [], uncertain: [] });
}
function successHolds(result) {
  if (!sameKeys(result, [...BASE_RESULT_KEYS, "nextAction"]) || !nonblank(result.nextAction))
    return false;
  return result.causeCode === "SUCCESS_UNCHANGED" && result.failureClass === null && result.exitCode === 0 && result.retryable === false && result.repairAction === null;
}
function handoffHolds(value) {
  if (!isRecord(value) || !sameKeys(value, ["inspect", "owner", "reason"]) || value.owner !== "human" || !nonblank(value.reason))
    return false;
  return Array.isArray(value.inspect) && value.inspect.length > 0 && value.inspect.every(nonblank);
}
function stationHolds(result) {
  const station = Object.values(STATIONS).find((entry) => entry.causeCode === result.causeCode);
  if (station === undefined || result.data !== null || result.repairAction !== station.repairAction)
    return false;
  if (result.outcome !== station.outcome || result.failureClass !== station.failureClass || result.exitCode !== station.exitCode)
    return false;
  const retryKeys = station.retryDelayMilliseconds === undefined ? [] : ["retryDelayMilliseconds"];
  if (result.retryable !== (station.retryDelayMilliseconds !== undefined) || result.retryDelayMilliseconds !== station.retryDelayMilliseconds)
    return false;
  const guidance = "handoff" in station.guidance ? "handoff" : "nextAction";
  if (!sameKeys(result, [...BASE_RESULT_KEYS, ...retryKeys, guidance]))
    return false;
  return guidance === "handoff" ? handoffHolds(result.handoff) : nonblank(result.nextAction);
}
function envelopeValid(value) {
  if (!isRecord(value) || !envelopeHolds(value) || !isRecord(value.result) || !baseHolds(value.result))
    return false;
  return value.result.outcome === "success" ? successHolds(value.result) : stationHolds(value.result);
}
function serializeEnvelope(envelope) {
  try {
    const text = JSON.stringify(envelope);
    return typeof text === "string" && envelopeValid(JSON.parse(text)) ? `${text}
` : null;
  } catch {
    return null;
  }
}
function discoveryData() {
  return {
    contractVersion: CONTRACT_VERSION,
    generationConventionVersion: CONTRACT_VERSION,
    profile: "simple",
    commands: COMMANDS,
    exitMeanings: { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "transient" },
    signalExits: { "130": "SIGINT", "143": "SIGTERM" },
    effectExclusions: [
      "Never launches an agent, creates a pane or starts a Herdr Projects thread.",
      "Never consults TypeSafe or sends Task text anywhere.",
      "Never reads credentials or runs harness authentication commands.",
      "Never writes the routes file, Beads, Herdr Projects state or any configuration.",
      "Never refreshes the Monash snapshot (no monash models --refresh)."
    ]
  };
}
function stationEntry(commandIdentity, station) {
  return {
    commandIdentity,
    causeCode: station.causeCode,
    outcome: station.outcome,
    effectClass: "inspect",
    transactionState: "unchanged",
    failureClass: station.failureClass,
    exitCode: station.exitCode,
    retryable: station.retryDelayMilliseconds !== undefined,
    retryDelayPolicy: station.retryDelayMilliseconds === undefined ? { kind: "none" } : { kind: "fixed", milliseconds: station.retryDelayMilliseconds },
    repairAction: station.repairAction,
    guidance: station.guidance,
    trigger: station.trigger,
    reachability: "required",
    unreachableRationale: null
  };
}
function commandDiscovery(commandIdentity) {
  const command = COMMANDS.find((entry) => entry.commandIdentity === commandIdentity);
  return {
    command,
    semantics: "possible-outcomes",
    stations: [
      {
        commandIdentity,
        causeCode: "SUCCESS_UNCHANGED",
        outcome: "success",
        effectClass: "inspect",
        transactionState: "unchanged",
        failureClass: null,
        exitCode: 0,
        retryable: false,
        retryDelayPolicy: { kind: "none" },
        repairAction: null,
        guidance: { nextAction: "Read the card or inventory; no follow-up effect is implied." },
        trigger: SUCCESS_TRIGGERS[commandIdentity],
        reachability: "required",
        unreachableRationale: null
      },
      ...COMMAND_STATIONS[commandIdentity].map((key) => stationEntry(commandIdentity, STATIONS[key]))
    ]
  };
}
function isCommandIdentity(value) {
  return value === "agent-router.routes" || value === "agent-router.run";
}

class StationError extends Error {
  station;
  constructor(station, message) {
    super(message);
    this.station = station;
  }
}

// packages/agent-router/src/declarations.ts
import { readFileSync, statSync } from "fs";
var HARNESSES = ["claude-code", "codex", "opencode"];
var EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];
var OWNERSHIPS = ["personal", "employer", "shared"];
var LAUNCH = ["allowed", "dry-run-only"];
var IDENTIFIER = /^[a-z0-9][a-z0-9.-]{0,62}$/;
var PLAN = /^[A-Za-z0-9 .()+-]{1,40}$/;

class Invalid extends Error {
}
function record(value, path, keys) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Invalid(`${path} must be an object`);
  const allowed = new Set([...keys.required, ...keys.optional ?? []]);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra !== undefined)
    throw new Invalid(`${path}.${extra} is not a declared field`);
  const missing = keys.required.find((key) => !(key in value));
  if (missing !== undefined)
    throw new Invalid(`${path}.${missing} is required`);
  return value;
}
function text(value, path, pattern) {
  if (typeof value !== "string" || !pattern.test(value))
    throw new Invalid(`${path} must match ${pattern.source}`);
  return value;
}
function choice(value, path, options) {
  if (typeof value !== "string" || !options.includes(value))
    throw new Invalid(`${path} must be one of ${options.join(", ")}`);
  return value;
}
function model(value, path) {
  const raw = record(value, path, { required: ["id"], optional: ["alias"] });
  const id = text(raw.id, `${path}.id`, IDENTIFIER);
  return raw.alias === undefined ? { id } : { id, alias: text(raw.alias, `${path}.alias`, IDENTIFIER) };
}
function account(value, path) {
  const raw = record(value, path, { required: ["alias", "ownership"], optional: ["plan"] });
  const declared = { alias: text(raw.alias, `${path}.alias`, IDENTIFIER), ownership: choice(raw.ownership, `${path}.ownership`, OWNERSHIPS) };
  return raw.plan === undefined ? declared : { ...declared, plan: text(raw.plan, `${path}.plan`, PLAN) };
}
function hosts(value, path) {
  if (!Array.isArray(value) || value.length === 0)
    throw new Invalid(`${path} must be a non-empty array`);
  const ids = value.map((entry, index) => text(entry, `${path}[${index}]`, IDENTIFIER));
  if (new Set(ids).size !== ids.length)
    throw new Invalid(`${path} must not repeat a host`);
  return ids;
}
function route(value, path) {
  const raw = record(value, path, { required: ["id", "harness", "model", "effort", "account", "hosts", "launch"] });
  return {
    id: text(raw.id, `${path}.id`, IDENTIFIER),
    harness: choice(raw.harness, `${path}.harness`, HARNESSES),
    model: model(raw.model, `${path}.model`),
    effort: choice(raw.effort, `${path}.effort`, EFFORTS),
    account: account(raw.account, `${path}.account`),
    hosts: hosts(raw.hosts, `${path}.hosts`),
    launch: choice(raw.launch, `${path}.launch`, LAUNCH)
  };
}
function parseRoutes(value) {
  const raw = record(value, "routes file", { required: ["schemaVersion", "routes"] });
  if (raw.schemaVersion !== 1)
    throw new Invalid("routes file.schemaVersion must be 1");
  if (!Array.isArray(raw.routes))
    throw new Invalid("routes file.routes must be an array");
  const routes = raw.routes.map((entry, index) => route(entry, `routes[${index}]`));
  const ids = routes.map((entry) => entry.id);
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
  if (repeated !== undefined)
    throw new Invalid(`route id ${repeated} is declared twice`);
  return routes;
}
function readOptionalFile(path) {
  try {
    if (!statSync(path).isFile())
      throw new StationError("inputUnreadable", `${path} is not a regular file.`);
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof StationError)
      throw error;
    if (error.code === "ENOENT")
      return null;
    throw new StationError("inputUnreadable", `${path} could not be read.`);
  }
}
function decode(path, contents) {
  try {
    return parseRoutes(JSON.parse(contents));
  } catch (error) {
    const reason = error instanceof Invalid ? error.message : "the file is not valid JSON";
    throw new StationError("routesInvalid", `${path}: ${reason}.`);
  }
}
function loadRoutes(path) {
  const contents = readOptionalFile(path);
  if (contents === null)
    return { path, status: "missing", routes: [] };
  return { path, status: "present", routes: decode(path, contents) };
}

// packages/agent-router/src/evidence.ts
import { createHash } from "crypto";
import { existsSync } from "fs";
import { homedir, hostname } from "os";
import { dirname, join } from "path";
async function probe(executable, args, timeoutMs) {
  const child = Bun.spawn([executable, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  clearTimeout(timer);
  if (timedOut)
    throw new StationError("probeTimeout", `${basename(executable)} ${args.join(" ")} did not answer within ${timeoutMs} ms.`);
  return { exitCode, stdout };
}
function basename(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
var MANIFEST = join(".local", "share", "monash-foundry", "installation-manifest.json");
var HOST_ID = /^[a-z0-9][a-z0-9.-]{0,62}$/;
function hostEvidence() {
  const source = `~/${MANIFEST} host_role`;
  const manifest = readOptionalFile(join(homedir(), MANIFEST));
  if (manifest === null)
    return { status: "unknown", role: null, reason: "the Monash installation manifest is absent", source };
  let role = null;
  try {
    role = asRecord(JSON.parse(manifest))?.host_role;
  } catch {
    role = null;
  }
  if (typeof role !== "string" || !HOST_ID.test(role))
    return { status: "unknown", role: null, reason: "the installation manifest records no readable host_role", source };
  return { status: "observed", role, reason: "recorded host_role in the Monash installation manifest", source };
}
var MONASH_AGENTS = { claude: "claude-code", codex: "codex", opencode: "opencode" };
function normaliseHost(value, host, known) {
  if (typeof value !== "string")
    return null;
  if (known.includes(value))
    return value;
  const local = hostname().replace(/\.local$/i, "").toLowerCase();
  if (host.role !== null && value.replace(/\.local$/i, "").toLowerCase() === local)
    return host.role;
  return null;
}
function evidenceHosts(evidence, host, known) {
  const rows = Array.isArray(evidence) ? evidence.map(asRecord).filter((row) => row !== null && row.observed === true) : [];
  const mapped = rows.map((row) => normaliseHost(row?.host, host, known));
  const hosts2 = [...new Set(mapped.filter((value) => value !== null))].sort();
  return { hosts: hosts2, unmapped: mapped.filter((value) => value === null).length };
}
function protocolsFor(bindings, resourceId) {
  const rows = Array.isArray(bindings) ? bindings.map(asRecord) : [];
  const matches = rows.filter((row) => row !== null && row.resource_id === resourceId && row.availability === "available");
  return [...new Set(matches.map((row) => String(row?.protocol)))].sort();
}
function monashRoute2(model2, raw, host, known) {
  const harness = MONASH_AGENTS[String(raw.agent)];
  if (harness === undefined || raw.status !== "qualified" || raw.implemented !== true)
    return null;
  const { hosts: hosts2, unmapped } = evidenceHosts(raw.evidence, host, known);
  return {
    id: `monash-foundry-${String(raw.agent)}-${String(model2.id)}`,
    harness,
    modelId: String(model2.id),
    displayName: String(model2.display_name ?? model2.id),
    availability: String(model2.availability),
    protocols: protocolsFor(model2.bindings, raw.binding_resource_id),
    qualifiedHosts: hosts2,
    unmappedEvidenceHosts: unmapped
  };
}
function monashRoutes(snapshot, host, known) {
  if (!Array.isArray(snapshot.models))
    return null;
  const routes = [];
  let unqualified = 0;
  for (const model2 of snapshot.models.map(asRecord)) {
    if (model2 === null || typeof model2.id !== "string" || !Array.isArray(model2.routes))
      return null;
    for (const raw of model2.routes.map(asRecord)) {
      const route2 = raw === null ? null : monashRoute2(model2, raw, host, known);
      if (route2 === null)
        unqualified += 1;
      else
        routes.push(route2);
    }
  }
  return { routes, unqualified };
}
async function monashEvidence(executable, host, known, timeoutMs) {
  const readAt = new Date().toISOString();
  const source = "monash models --json (installed snapshot; never --refresh)";
  const empty = { snapshotObservedAt: null, readAt, source, routes: [], unqualifiedCombinations: 0 };
  if (executable === null)
    return { status: "not-installed", ...empty };
  const output = await probe(executable, ["models", "--json"], timeoutMs);
  if (output.exitCode !== 0)
    return { status: "failed", ...empty };
  let snapshot = null;
  try {
    snapshot = asRecord(JSON.parse(output.stdout));
  } catch {
    snapshot = null;
  }
  const parsed = snapshot === null ? null : monashRoutes(snapshot, host, known);
  const observedAt = snapshot?.observed_at;
  if (parsed === null || typeof observedAt !== "string" || Number.isNaN(Date.parse(observedAt)))
    return { status: "invalid", ...empty };
  return { status: "observed", snapshotObservedAt: observedAt, readAt, source, routes: parsed.routes, unqualifiedCombinations: parsed.unqualified };
}
var HARNESS_EXECUTABLES = { "claude-code": "claude", codex: "codex", opencode: "opencode" };
async function harnessEvidence(harness, timeoutMs) {
  const name = HARNESS_EXECUTABLES[harness];
  const source = `${name} --version`;
  const observedAt = new Date().toISOString();
  const executable = Bun.which(name);
  if (executable === null)
    return { status: "not-found", version: null, observedAt, source };
  const output = await probe(executable, ["--version"], timeoutMs);
  const version = /\d+\.\d+\.\d+/.exec(output.stdout)?.[0] ?? null;
  if (output.exitCode !== 0 || version === null)
    return { status: "failed", version: null, observedAt, source };
  return { status: "observed", version, observedAt, source };
}
function pluginRoot() {
  let directory = import.meta.dir;
  for (;; ) {
    if (existsSync(join(directory, "skills", "stage-manager", "guides")))
      return directory;
    const parent = dirname(directory);
    if (parent === directory)
      return null;
    directory = parent;
  }
}
function frontmatter(contents) {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(contents)?.[1] ?? "";
  const fields = {};
  for (const line of block.split(`
`)) {
    const match = /^([a-z_0-9]+):\s*(\S.*)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined)
      fields[match[1]] = match[2].trim();
  }
  return fields;
}
function guideEvidence(root, harness, modelId) {
  const path = join("skills", "stage-manager", "guides", harness, `${modelId}.md`);
  const absent = { path, sha256: null, harnessMinVersion: null };
  if (root === null)
    return { status: "missing", ...absent, reason: "the Playground plugin's Stage Manager guides were not found" };
  const guide = readOptionalFile(join(root, path));
  if (guide === null)
    return { status: "missing", ...absent, reason: `no Model Guide exists for ${harness} and ${modelId}` };
  const sha256 = createHash("sha256").update(guide).digest("hex");
  const fields = frontmatter(guide);
  const minimum = fields.harness_min_version ?? null;
  if (fields.model_id !== modelId || fields.harness !== harness) {
    return { status: "unreviewed", path, sha256, harnessMinVersion: minimum, reason: "the guide's model_id or harness does not match the route" };
  }
  const review = readOptionalFile(join(root, path.replace(/\.md$/, ".review.md")));
  const verdict = review === null ? {} : frontmatter(review);
  if (verdict.verdict !== "accepted" || verdict.guide_sha256 !== sha256) {
    return { status: "unreviewed", path, sha256, harnessMinVersion: minimum, reason: "no accepted review records this guide's current sha256" };
  }
  return { status: "reviewed", path, sha256, harnessMinVersion: minimum, reason: "an accepted review records this guide's sha256" };
}
function targetEvidence(root, project) {
  if (project === null || root === null)
    return { status: "not-given", project, root };
  return { status: existsSync(join(root, project, "PROJECT.md")) ? "present" : "missing", project, root };
}
async function collectEvidence(request) {
  const monash = Bun.which("monash");
  const host = hostEvidence();
  const known = [...new Set([...host.role === null ? [] : [host.role], ...request.declaredHosts])];
  const snapshot = await monashEvidence(monash, host, known, request.timeoutMs);
  const harnesses = {};
  const probed = new Set([...request.harnesses, ...snapshot.routes.map((route2) => route2.harness)]);
  for (const harness of HARNESSES.filter((entry) => probed.has(entry)))
    harnesses[harness] = await harnessEvidence(harness, request.timeoutMs);
  const root = pluginRoot();
  return {
    host,
    monash: snapshot,
    harnesses,
    guide: (harness, modelId) => guideEvidence(root, harness, modelId),
    target: targetEvidence(request.herdrProjectsRoot, request.project)
  };
}

// packages/agent-router/src/render.ts
function freshnessText(value) {
  if (value.state === "not-observed")
    return "not observed";
  if (value.state === "invalid")
    return `invalid timestamp ${value.observedAt}`;
  return `${value.state}, ${value.ageDays} days, observed ${value.observedAt}`;
}
function sourceLines(sources2) {
  const host = sources2.host.role === null ? `unknown (${sources2.host.reason})` : sources2.host.role;
  const monash = sources2.monash.status === "observed" ? `snapshot ${freshnessText(sources2.monash.snapshot)}; ${sources2.monash.unqualifiedCombinations} unqualified combinations not listed` : sources2.monash.status;
  const harnesses = Object.entries(sources2.harnesses).map(([name, value]) => `${name} ${value?.version ?? value?.status}`);
  return [
    `Routes file: ${sources2.routesFile.path} (${sources2.routesFile.status})`,
    `This host: ${host}`,
    `Monash: ${monash}`,
    `Harnesses: ${harnesses.length === 0 ? "none probed" : harnesses.join(", ")}`
  ];
}
function routeLines(route2) {
  const alias = route2.model.alias === null ? "" : ` (alias ${route2.model.alias})`;
  const hosts2 = route2.origin === "routes-file" ? `declared ${route2.hosts.declared.join(", ")}` : `qualified ${route2.hosts.qualified.join(", ") || "none mapped"}`;
  const account2 = `${route2.account.alias ?? "no alias"}, ${route2.account.ownership}${route2.account.plan === null ? "" : ` (${route2.account.plan})`}, proof ${route2.account.proof}`;
  return [
    `${route2.id} [${route2.origin}]`,
    `  harness ${route2.harness} ${route2.harnessVersion ?? "(version not observed)"}; model ${route2.model.id}${alias}`,
    `  effort declared ${route2.effort.declared ?? "unknown"}, observed ${route2.effort.observed}; hosts ${hosts2}; launch ${route2.launch}`,
    `  account ${account2}`,
    `  quota ${route2.quota.state} (${freshnessText(route2.quota.freshness)})${route2.availability === null ? "" : `; availability ${route2.availability.state} (${freshnessText(route2.availability.freshness)})`}`,
    `  model guide ${route2.modelGuide.status}${route2.modelGuide.revision === null ? "" : ` sha256 ${route2.modelGuide.revision}`}`
  ];
}
function gapLines(gaps) {
  return [`Gaps (${gaps.length}):`, ...gaps.map((gap) => `  ${gap.id} ${gap.routes.join(", ")}: ${gap.field}: ${gap.reason} (owner: ${gap.owner})`)];
}
function renderInventory(value) {
  return [
    "Agent Router route inventory (inspect only)",
    ...sourceLines(value.sources),
    `Freshness: evidence older than ${value.freshnessDays} days is stale.`,
    "",
    ...value.routes.flatMap((route2) => [...routeLines(route2), ""]),
    ...gapLines(value.gaps)
  ].join(`
`);
}
function pickLines(pick2) {
  const head = "Provisional pick (TypeSafe not consulted):";
  if (pick2.status === "none-eligible")
    return [head, "  none: no route passes every gate."];
  if (pick2.status === "ask")
    return [head, `  ask Nathan: ${pick2.candidates.length} routes qualify (${pick2.candidates.join(", ")}).`];
  const confirm = pick2.confirmations.length === 0 ? "" : `; Nathan must confirm ${pick2.confirmations.join(", ")}`;
  return [head, `  ${pick2.status}: ${pick2.route}${confirm}.`, `  Model Guide revision: ${pick2.modelGuideRevision ?? "none"}`];
}
function renderCard(card) {
  const target = card.target.status === "not-given" ? "not given" : `project ${card.target.project} under ${card.target.root} (${card.target.status})`;
  return [
    `Agent Router decision card (dry run) for Task ${card.task}`,
    `Herdr Projects target: ${target}`,
    ...sourceLines(card.sources),
    `Gates, in order: ${card.gateOrder.map((gate) => `${gate.gate} ${gate.name}`).join("; ")}.`,
    "",
    ...card.routes.flatMap((route2) => [
      `${route2.id}: ${route2.decision}${route2.refusal === null ? "" : ` at ${route2.refusal.gate}: ${route2.refusal.reason}`}`,
      ...route2.gates.map((gate) => `  ${gate.gate} ${gate.verdict} [${gate.evidence}] ${gate.reason}`),
      ""
    ]),
    ...pickLines(card.pick),
    "",
    ...gapLines(card.gaps)
  ].join(`
`);
}

// packages/agent-router/src/cli.ts
var USAGE = [
  "Usage:",
  "  agent-router routes [--routes-file PATH] [--probe-timeout-ms N] [--json]",
  "  agent-router run TASK --dry-run [--project NAME] [--herdr-projects-root DIR] [--routes-file PATH] [--probe-timeout-ms N] [--json]",
  "  agent-router --discover [--json] | --discover-command COMMAND_IDENTITY [--json] | --help [--json]"
];
var OPTIONS = [
  { name: "--json", valueName: null, summary: "Emit one Contract Core 2.0 envelope on stdout." },
  { name: "--dry-run", valueName: null, summary: "Required by run: show the decision card; nothing is launched." },
  { name: "--routes-file", valueName: "PATH", summary: "Routes file; default $XDG_CONFIG_HOME/agent-router/routes.json." },
  { name: "--probe-timeout-ms", valueName: "N", summary: "Time budget per read-only probe, 1 to 600000; default 10000." },
  { name: "--project", valueName: "NAME", summary: "Herdr Projects project the worker would join." },
  { name: "--herdr-projects-root", valueName: "DIR", summary: "Herdr Projects root; default $HERDR_PROJECTS_ROOT." },
  { name: "--discover", valueName: null, summary: "Describe the contract, commands and effect exclusions." },
  { name: "--discover-command", valueName: "COMMAND_IDENTITY", summary: "Describe one command's possible stations." },
  { name: "--help", valueName: null, summary: "Show this help." }
];
var VALUE_OPTIONS = new Set(OPTIONS.filter((option) => option.valueName !== null).map((option) => option.name));
var FLAG_OPTIONS = new Set(["--dry-run", "--discover", "--help", "-h"]);
var TASK_IDENTIFIER = /^[a-z][a-z0-9]*-[a-z0-9]+(\.[0-9]+)*$/;
var PROJECT_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
var DEFAULT_TIMEOUT_MS = 1e4;

class UsageError extends Error {
}
function parse(args) {
  const parsed = { words: [], flags: new Set, values: new Map };
  for (let index = 0;index < args.length; index += 1) {
    const arg = args[index];
    if (VALUE_OPTIONS.has(arg)) {
      const value = args[index + 1];
      if (value === undefined || parsed.values.has(arg))
        throw new UsageError(`${arg} needs exactly one value.`);
      parsed.values.set(arg, value);
      index += 1;
    } else if (FLAG_OPTIONS.has(arg))
      parsed.flags.add(arg === "-h" ? "--help" : arg);
    else if (arg.startsWith("-"))
      throw new UsageError("An option is not recognised.");
    else
      parsed.words.push(arg);
  }
  return parsed;
}
function allowOnly(parsed, allowed) {
  const names = [...parsed.flags, ...parsed.values.keys()];
  if (names.some((name) => !allowed.includes(name)))
    throw new UsageError("An option does not apply to this command.");
}
function timeout(parsed) {
  const raw = parsed.values.get("--probe-timeout-ms");
  if (raw === undefined)
    return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < 1 || value > 600000)
    throw new StationError("malformedInput", "--probe-timeout-ms must be an integer from 1 to 600000.");
  return value;
}
function xdg(variable, fallback) {
  const value = process.env[variable];
  return value !== undefined && isAbsolute(value) ? value : join2(homedir2(), fallback);
}
async function inputs(parsed, requireRoutes, target) {
  const routesFile = loadRoutes(resolve(parsed.values.get("--routes-file") ?? join2(xdg("XDG_CONFIG_HOME", ".config"), "agent-router", "routes.json")));
  if (routesFile.status === "missing" && requireRoutes)
    throw new StationError("routesMissing", `No routes file exists at ${routesFile.path}.`);
  const evidence = await collectEvidence({
    harnesses: routesFile.routes.map((route2) => route2.harness),
    declaredHosts: routesFile.routes.flatMap((route2) => route2.hosts),
    timeoutMs: timeout(parsed),
    herdrProjectsRoot: target.root,
    project: target.project
  });
  return { routesFile, evidence, now: Date.now() };
}
var COMMON = ["--routes-file", "--probe-timeout-ms"];
async function routesCommand(parsed) {
  allowOnly(parsed, COMMON);
  if (parsed.words.length !== 1)
    throw new UsageError("routes takes no operands.");
  timeout(parsed);
  const value = inventory(await inputs(parsed, false, { root: null, project: null }));
  const message = `Inventoried ${value.routes.length} routes with ${value.gaps.length} owned gaps.`;
  return { envelope: success("agent-router.routes", value, message, "Read the inventory; run a dry run to judge the gates."), human: renderInventory(value) };
}
function targetOf(parsed) {
  const project = parsed.values.get("--project") ?? null;
  if (project !== null && !PROJECT_NAME.test(project))
    throw new StationError("malformedInput", "--project must be a Herdr Projects project name.");
  const root = parsed.values.get("--herdr-projects-root") ?? process.env.HERDR_PROJECTS_ROOT ?? null;
  if (root !== null && !isAbsolute(root))
    throw new StationError("malformedInput", "--herdr-projects-root must be an absolute path.");
  return { root, project };
}
var PICK_ACTIONS = {
  "needs-confirmation": (route2, _candidates, confirm) => `Ask Nathan to confirm ${confirm.join(", ")} for ${route2} before any launch.`,
  ask: (_route, candidates) => `Ask Nathan to choose one route: ${candidates.join(", ")}.`,
  "none-eligible": () => "Resolve the listed refusals and gaps, then rerun the dry run."
};
async function runCommand(parsed) {
  allowOnly(parsed, [...COMMON, "--dry-run", "--project", "--herdr-projects-root"]);
  if (parsed.words.length !== 2)
    throw new UsageError("run takes exactly one TASK operand.");
  const task = parsed.words[1];
  if (!TASK_IDENTIFIER.test(task))
    throw new StationError("malformedInput", "TASK must be a Beads Task identifier such as hpr-f5n.3; Task text is never accepted.");
  if (!parsed.flags.has("--dry-run"))
    throw new StationError("launchRefused", "Launch is refused: this build only shows the dry-run card.");
  timeout(parsed);
  const card = decisionCard(task, await inputs(parsed, true, targetOf(parsed)));
  const action = PICK_ACTIONS[card.pick.status]?.(card.pick.route, card.pick.candidates, card.pick.confirmations) ?? "Read the card.";
  return { envelope: success("agent-router.run", card, `Dry-run pick: ${card.pick.status}.`, action), human: renderCard(card) };
}
function helpOutput() {
  const data = { summary: "Inspect-only Agent Router: route inventory and dry-run decision card.", usage: USAGE.slice(1).map((line) => line.trim()), commands: COMMANDS, options: OPTIONS };
  return { envelope: success("agent-router.help", data, "Show help.", "Choose a command from the usage lines."), human: [...USAGE, "", "Options:", ...OPTIONS.map((option) => `  ${option.name}${option.valueName === null ? "" : ` ${option.valueName}`}  ${option.summary}`)].join(`
`) };
}
function discoverOutput() {
  const human = "Commands: routes (inspect), run TASK --dry-run (inspect)";
  return { envelope: success("agent-router.discovery", discoveryData(), "Describe commands.", "Choose a command to run."), human };
}
function discoverCommandOutput(parsed) {
  const selector = parsed.values.get("--discover-command");
  if (!isCommandIdentity(selector))
    throw new UsageError("--discover-command needs a listed command identity.");
  const data = commandDiscovery(selector);
  const human = `${selector}: ${data.stations.map((station) => `${station.causeCode}/${station.outcome}`).join(", ")}`;
  return { envelope: success("agent-router.command-discovery", data, `Describe ${selector}.`, "Read the stations; discovery reports no live state."), human };
}
function commandOf(parsed) {
  if (parsed.words[0] === "routes")
    return "agent-router.routes";
  if (parsed.words[0] === "run")
    return "agent-router.run";
  return "agent-router.dispatch";
}
async function dispatch(parsed) {
  if (parsed.flags.has("--help") && parsed.words.length === 0 && parsed.values.size === 0 && parsed.flags.size === 1)
    return helpOutput();
  if (parsed.flags.has("--discover") && parsed.words.length === 0 && parsed.values.size === 0 && parsed.flags.size === 1)
    return discoverOutput();
  if (parsed.values.has("--discover-command") && parsed.words.length === 0 && parsed.values.size === 1 && parsed.flags.size === 0)
    return discoverCommandOutput(parsed);
  if (parsed.words[0] === "routes")
    return routesCommand(parsed);
  if (parsed.words[0] === "run")
    return runCommand(parsed);
  throw new UsageError("Choose a supported command.");
}
function refusal(identity, error) {
  if (error instanceof StationError)
    return { envelope: stationResult(identity, error.station, error.message), human: "" };
  if (error instanceof UsageError)
    return { envelope: stationResult(identity, "usage", error.message), human: "" };
  return { envelope: stationResult(identity, "inputUnreadable", "The command failed unexpectedly before producing a result."), human: "" };
}
var humanFailureReported = false;
var transportFailed = false;
function reportToStderr(envelope) {
  if (humanFailureReported)
    return;
  humanFailureReported = true;
  process.stderr.write(`${envelope.message} Repair: ${String(envelope.result.repairAction)}
`);
}
function transportFailure(json) {
  transportFailed = true;
  if (!json)
    reportToStderr(stationResult("agent-router.dispatch", "emission", STATIONS.emission.trigger));
  return 1;
}
function write(text2, json) {
  try {
    process.stdout.write(text2);
    return null;
  } catch {
    return transportFailure(json);
  }
}
function emitMachine(identity, envelope) {
  const text2 = serializeEnvelope(envelope);
  if (text2 !== null)
    return write(text2, true) ?? envelope.result.exitCode;
  const fallback = serializeEnvelope(stationResult(identity, "serialization", STATIONS.serialization.trigger));
  if (fallback === null)
    return 1;
  return write(fallback, true) ?? 1;
}
function emit(identity, output, json) {
  if (json)
    return emitMachine(identity, output.envelope);
  const exitCode = output.envelope.result.exitCode;
  if (exitCode !== 0) {
    reportToStderr(output.envelope);
    return exitCode;
  }
  return write(`${output.human}
`, false) ?? exitCode;
}
async function main(argv) {
  const separator = argv.indexOf("--");
  const json = (separator === -1 ? argv : argv.slice(0, separator)).includes("--json");
  const args = argv.filter((value) => value !== "--json");
  process.stdout.on("error", () => transportFailure(json));
  let parsed = null;
  let output;
  try {
    parsed = parse(args);
    output = await dispatch(parsed);
  } catch (error) {
    output = refusal(parsed === null ? "agent-router.dispatch" : commandOf(parsed), error);
  }
  return emit(parsed === null ? "agent-router.dispatch" : commandOf(parsed), output, json);
}
var exitCode = await main(process.argv.slice(2));
process.exitCode = transportFailed ? 1 : exitCode;
