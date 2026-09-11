#!/usr/bin/env bun
// @bun
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// packages/recovery-observability/src/trace-command.ts
import { createHash, randomUUID as randomUUID2 } from "crypto";
import { readFileSync as readFileSync2 } from "fs";
import { resolve as resolve2 } from "path";

// packages/recovery-observability/src/invocation-trace-store.ts
import { randomUUID } from "crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync
} from "fs";
import { isAbsolute, join, resolve } from "path";

// packages/recovery-observability/src/serialized-values.ts
var MAX_SERIALIZED_RECORD_BYTES = 4 * 1024;
var TRACE_SCHEMA_VERSION = 1;
var identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
var pluginVersionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
var sha256Pattern = /^[a-f0-9]{64}$/;
var encoder = new TextEncoder;
var harnessKinds = ["codex", "claude-code", "command", "unknown"];
var operations = ["hook", "bind", "recover", "write", "schema", "help", "usage", "cleanup"];
var phases = [
  "invocation",
  "validation",
  "checkpoint-read",
  "checkpoint-write",
  "lock",
  "response-available",
  "cleanup",
  "terminal"
];
var outcomes = [
  "started",
  "accepted",
  "succeeded",
  "refused",
  "busy",
  "conflict",
  "unavailable",
  "uncertain",
  "failed",
  "cancelled",
  "signalled",
  "deadline-exceeded"
];
var refusalCodes = [
  "CHECKPOINT_BUSY",
  "CHECKPOINT_OWNERSHIP_CONFLICT",
  "CHECKPOINT_WRITE_FAILED",
  "CHECKPOINT_WRITE_UNCERTAIN",
  "INVALID_CHECKPOINT",
  "INVALID_USAGE",
  "RECOVERY_CONTEXT_UNAVAILABLE",
  "STORAGE_UNAVAILABLE",
  "TRACE_RECORD_INVALID",
  "TRACE_RECORD_OVERSIZED"
];
var diagnosticEvents = ["buffer-truncated", "cleanup-failure", "observer-failure", "storage-unavailable"];
var diagnosticLevels = ["trace", "debug", "info", "warning", "error", "fatal"];
var workerIdentitySources = ["hook-payload", "supervisor"];
var recordKeys = new Set([
  "schema_version",
  "record_type",
  "record_identity",
  "journey_identity",
  "invocation_identity",
  "producer_identity",
  "producer_sequence",
  "parent_record_identity",
  "observed_worker_identity",
  "observed_worker_identity_source",
  "inherited_parent_identity",
  "ledger_task_identity",
  "harness_kind",
  "operation",
  "phase",
  "occurred_at",
  "duration_ms",
  "outcome",
  "refusal_code",
  "source_evidence",
  "install_evidence"
]);
var sourceEvidenceKeys = new Set(["recovery_source_sha256", "observer_source_sha256"]);
var installEvidenceKeys = new Set(["plugin_version", "runtime_sha256"]);
var diagnosticPropertyKeys = new Set(["dropped_records"]);
var diagnosticKeys = new Set(["schema_version", "record_type", "category", "level", "event", "occurred_at", "properties"]);
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value, keys) {
  return Object.keys(value).every((key) => keys.has(key));
}
function isMember(values, value) {
  return typeof value === "string" && values.includes(value);
}
function isRecoveryIdentity(value) {
  return typeof value === "string" && identityPattern.test(value);
}
function isPluginVersion(value) {
  return typeof value === "string" && value.length <= 128 && pluginVersionPattern.exec(value)?.[0] === value;
}
function validIsoTimestamp(value) {
  if (typeof value !== "string")
    return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
function validSourceEvidence(value) {
  if (!isObject(value) || !hasOnlyKeys(value, sourceEvidenceKeys) || Object.keys(value).length === 0)
    return false;
  return [value.recovery_source_sha256, value.observer_source_sha256].every((item) => item === undefined || typeof item === "string" && sha256Pattern.test(item));
}
function validInstallEvidence(value) {
  if (!isObject(value) || !hasOnlyKeys(value, installEvidenceKeys) || Object.keys(value).length === 0)
    return false;
  if (value.runtime_sha256 !== undefined && (typeof value.runtime_sha256 !== "string" || !sha256Pattern.test(value.runtime_sha256))) {
    return false;
  }
  return value.plugin_version === undefined || isPluginVersion(value.plugin_version);
}
function containsKnownSecret(value, secrets) {
  if (typeof value === "string")
    return secrets.some((secret) => secret.length > 0 && value.includes(secret));
  if (!isObject(value))
    return false;
  return Object.values(value).some((nested) => containsKnownSecret(nested, secrets));
}
function freezeRecord(record) {
  if (record.source_evidence)
    Object.freeze(record.source_evidence);
  if (record.install_evidence)
    Object.freeze(record.install_evidence);
  return Object.freeze(record);
}
function projectRecord(input) {
  return {
    schema_version: 1,
    record_type: "lifecycle",
    record_identity: input.record_identity,
    journey_identity: input.journey_identity,
    invocation_identity: input.invocation_identity,
    producer_identity: input.producer_identity,
    producer_sequence: input.producer_sequence,
    ...input.parent_record_identity === undefined ? {} : { parent_record_identity: input.parent_record_identity },
    ...input.observed_worker_identity === undefined ? {} : { observed_worker_identity: input.observed_worker_identity },
    ...input.observed_worker_identity_source === undefined ? {} : { observed_worker_identity_source: input.observed_worker_identity_source },
    ...input.inherited_parent_identity === undefined ? {} : { inherited_parent_identity: input.inherited_parent_identity },
    ...input.ledger_task_identity === undefined ? {} : { ledger_task_identity: input.ledger_task_identity },
    harness_kind: input.harness_kind,
    operation: input.operation,
    phase: input.phase,
    occurred_at: input.occurred_at,
    ...input.duration_ms === undefined ? {} : { duration_ms: input.duration_ms },
    outcome: input.outcome,
    ...input.refusal_code === undefined ? {} : { refusal_code: input.refusal_code },
    ...input.source_evidence === undefined ? {} : { source_evidence: { ...input.source_evidence } },
    ...input.install_evidence === undefined ? {} : { install_evidence: { ...input.install_evidence } }
  };
}
function validLifecycleIdentities(input) {
  const required = [input.record_identity, input.journey_identity, input.invocation_identity, input.producer_identity];
  if (!required.every(isRecoveryIdentity))
    return false;
  const optional = [input.parent_record_identity, input.observed_worker_identity, input.inherited_parent_identity, input.ledger_task_identity];
  if (optional.some((value) => value !== undefined && !isRecoveryIdentity(value)))
    return false;
  const workerIdentityPair = input.observed_worker_identity === undefined === (input.observed_worker_identity_source === undefined);
  return workerIdentityPair && (input.observed_worker_identity_source === undefined || isMember(workerIdentitySources, input.observed_worker_identity_source));
}
function validLifecycleNumbers(input) {
  if (!Number.isSafeInteger(input.producer_sequence) || input.producer_sequence < 0)
    return false;
  return input.duration_ms === undefined || typeof input.duration_ms === "number" && Number.isFinite(input.duration_ms) && input.duration_ms >= 0;
}
function validLifecycleKinds(input) {
  return isMember(harnessKinds, input.harness_kind) && isMember(operations, input.operation) && isMember(phases, input.phase) && validIsoTimestamp(input.occurred_at) && isMember(outcomes, input.outcome);
}
function validLifecycleOutcome(input) {
  const refusalPair = input.outcome === "refused" ? input.refusal_code !== undefined : input.refusal_code === undefined;
  return refusalPair && (input.refusal_code === undefined || isMember(refusalCodes, input.refusal_code));
}
function validLifecycleEvidence(input) {
  return (input.source_evidence === undefined || validSourceEvidence(input.source_evidence)) && (input.install_evidence === undefined || validInstallEvidence(input.install_evidence));
}
function validLifecycleValues(input) {
  return input.schema_version === TRACE_SCHEMA_VERSION && input.record_type === "lifecycle" && validLifecycleIdentities(input) && validLifecycleNumbers(input) && validLifecycleKinds(input) && validLifecycleOutcome(input) && validLifecycleEvidence(input);
}
function validateLifecycleRecord(input, options = {}) {
  if (!isObject(input))
    return { accepted: false, refusal: "invalid-record" };
  if (!hasOnlyKeys(input, recordKeys))
    return { accepted: false, refusal: "unknown-field" };
  if (!validLifecycleValues(input)) {
    return { accepted: false, refusal: "invalid-value" };
  }
  if (containsKnownSecret(input, options.knownSecretValues ?? [])) {
    return { accepted: false, refusal: "known-secret" };
  }
  const projected = projectRecord(input);
  let serialized;
  try {
    serialized = JSON.stringify(projected);
  } catch {
    return { accepted: false, refusal: "invalid-record" };
  }
  if (encoder.encode(`${serialized}
`).byteLength > MAX_SERIALIZED_RECORD_BYTES) {
    return { accepted: false, refusal: "oversized-record" };
  }
  return { accepted: true, record: freezeRecord(projected), serialized };
}
function validDiagnosticCounter(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function projectDiagnosticProperties(input) {
  return validDiagnosticCounter(input.dropped_records) ? { dropped_records: input.dropped_records } : {};
}
function validateDiagnosticTraceRecord(input, options = {}) {
  if (!isObject(input) || !hasOnlyKeys(input, diagnosticKeys))
    return false;
  if (input.schema_version !== 1 || input.record_type !== "diagnostic" || input.category !== "my-second-brain-playground/recovery" || !isMember(diagnosticLevels, input.level) || !isMember(diagnosticEvents, input.event) || !validIsoTimestamp(input.occurred_at) || !isObject(input.properties) || !hasOnlyKeys(input.properties, diagnosticPropertyKeys) || !Object.values(input.properties).every(validDiagnosticCounter)) {
    return false;
  }
  try {
    const serialized = `${JSON.stringify(input)}
`;
    if ((options.knownSecretValues ?? []).some((secret) => secret.length > 0 && serialized.includes(secret)))
      return false;
    return encoder.encode(serialized).byteLength <= MAX_SERIALIZED_RECORD_BYTES;
  } catch {
    return false;
  }
}

// packages/recovery-observability/src/invocation-trace-store.ts
var DEFAULT_TRACE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
var DEFAULT_TRACE_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
var MAX_QUERY_TRACE_ENTRIES = 1e4;
function configuredStateHome(explicit) {
  const value = explicit ?? process.env.XDG_STATE_HOME ?? (process.env.HOME ? join(process.env.HOME, ".local", "state") : "");
  return value && isAbsolute(value) ? resolve(value) : null;
}
function traceRoot(stateHome) {
  const root = configuredStateHome(stateHome);
  return root === null ? null : join(root, "my-second-brain-playground", "recovery-traces");
}
function ensurePrivateDirectory(path) {
  if (!existsSync(path)) {
    try {
      mkdirSync(path, { mode: 448 });
    } catch {
      if (!existsSync(path))
        throw new Error("trace directory unavailable");
    }
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("unsafe trace directory");
  chmodSync(path, 448);
}
function prepareTraceRoot(stateHome) {
  const stateRoot = configuredStateHome(stateHome);
  if (stateRoot === null)
    throw new Error("state home is unavailable");
  if (!existsSync(stateRoot))
    mkdirSync(stateRoot, { recursive: true, mode: 448 });
  const ownerRoot = join(stateRoot, "my-second-brain-playground");
  ensurePrivateDirectory(ownerRoot);
  const root = join(ownerRoot, "recovery-traces");
  ensurePrivateDirectory(root);
  return root;
}
function safeFileName(invocationIdentity) {
  const stem = invocationIdentity.replaceAll(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
  return `${Date.now()}-${stem}-${randomUUID()}.jsonl`;
}
function createInvocationTraceStore(options) {
  let descriptor = null;
  let filePath = null;
  let disposed = false;
  try {
    const root = prepareTraceRoot(options.stateHome);
    filePath = join(root, safeFileName(options.invocationIdentity));
    descriptor = openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 384);
    chmodSync(filePath, 384);
  } catch {
    if (descriptor !== null)
      closeSync(descriptor);
    descriptor = null;
    filePath = null;
  }
  return {
    get path() {
      return filePath;
    },
    accept(input) {
      if (disposed || descriptor === null)
        return { accepted: false, refusal: "storage-unavailable" };
      const validated = validateLifecycleRecord(input, { knownSecretValues: options.knownSecretValues });
      if (!validated.accepted)
        return validated;
      if (validated.record.invocation_identity !== options.invocationIdentity) {
        return { accepted: false, refusal: "invocation-mismatch" };
      }
      try {
        if (fstatSync(descriptor).size + Buffer.byteLength(validated.serialized) + 1 > DEFAULT_TRACE_MAX_TOTAL_BYTES) {
          return { accepted: false, refusal: "storage-unavailable" };
        }
        appendFileSync(descriptor, `${validated.serialized}
`, { encoding: "utf8" });
        return { accepted: true, record: validated.record };
      } catch {
        return { accepted: false, refusal: "storage-unavailable" };
      }
    },
    writeDiagnostic(line) {
      if (disposed || descriptor === null || !line.endsWith(`
`) || Buffer.byteLength(line) > MAX_SERIALIZED_RECORD_BYTES)
        return false;
      try {
        const parsed = JSON.parse(line);
        if (!validateDiagnosticTraceRecord(parsed, { knownSecretValues: options.knownSecretValues }))
          return false;
        const serialized = `${JSON.stringify(parsed)}
`;
        if (fstatSync(descriptor).size + Buffer.byteLength(serialized) > DEFAULT_TRACE_MAX_TOTAL_BYTES)
          return false;
        appendFileSync(descriptor, serialized, { encoding: "utf8" });
        return true;
      } catch {
        return false;
      }
    },
    dispose() {
      if (disposed)
        return;
      disposed = true;
      if (descriptor !== null) {
        try {
          closeSync(descriptor);
        } catch {}
        descriptor = null;
      }
    }
  };
}
function admittedTraceFiles(root, maxEntries = Infinity) {
  const files = [];
  for (const name of readdirSync(root).sort().slice(0, maxEntries)) {
    if (!name.endsWith(".jsonl"))
      continue;
    const path = join(root, name);
    try {
      const stat = lstatSync(path);
      if (stat.isFile() && !stat.isSymbolicLink())
        files.push({ name, path, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {}
  }
  return files;
}
function matches(record, filter) {
  return (filter.journey_identity === undefined || record.journey_identity === filter.journey_identity) && (filter.invocation_identity === undefined || record.invocation_identity === filter.invocation_identity) && (filter.observed_worker_identity === undefined || record.observed_worker_identity === filter.observed_worker_identity) && (filter.ledger_task_identity === undefined || record.ledger_task_identity === filter.ledger_task_identity);
}
function stableRecord(value) {
  if (Array.isArray(value))
    return `[${value.map(stableRecord).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableRecord(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function unavailableTraceResult(root) {
  return { available: false, trace_root: root, records: [], anomalies: [] };
}
function traceRootIsAvailable(root) {
  if (root === null || !existsSync(root))
    return false;
  try {
    const stat = lstatSync(root);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}
function readTraceLine(file, line, lineNumber, partial, state) {
  if (partial) {
    state.anomalies.push({ file, line: lineNumber, code: "partial-final-line" });
    return;
  }
  if (Buffer.byteLength(`${line}
`) > MAX_SERIALIZED_RECORD_BYTES) {
    state.anomalies.push({ file, line: lineNumber, code: "oversized-record" });
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    state.anomalies.push({ file, line: lineNumber, code: "invalid-record" });
    return;
  }
  if (typeof parsed === "object" && parsed !== null && parsed.schema_version !== 1) {
    state.anomalies.push({ file, line: lineNumber, code: "unknown-schema" });
    return;
  }
  return parsed;
}
function addSequenceAnomaly(file, line, record, sequences, anomalies) {
  const previous = sequences.get(record.producer_identity);
  if (previous === undefined) {
    if (record.producer_sequence !== 0) {
      anomalies.push({
        file,
        line,
        code: "sequence-gap",
        producer_identity: record.producer_identity,
        expected_sequence: 0,
        observed_sequence: record.producer_sequence
      });
    }
  } else if (record.producer_sequence === previous) {
    anomalies.push({
      file,
      line,
      code: "duplicate-sequence",
      producer_identity: record.producer_identity,
      observed_sequence: record.producer_sequence
    });
  } else if (record.producer_sequence !== previous + 1) {
    anomalies.push({
      file,
      line,
      code: "sequence-gap",
      producer_identity: record.producer_identity,
      expected_sequence: previous + 1,
      observed_sequence: record.producer_sequence
    });
  }
  sequences.set(record.producer_identity, record.producer_sequence);
}
function acceptLifecycleRecord(file, line, record, state, sequences) {
  const fingerprint = stableRecord(record);
  const delivered = state.deliveries.get(record.record_identity);
  if (delivered !== undefined) {
    state.anomalies.push({
      file,
      line,
      code: delivered === fingerprint ? "duplicate-delivery" : "record-identity-conflict"
    });
    if (delivered === fingerprint)
      return;
  } else {
    state.deliveries.set(record.record_identity, fingerprint);
  }
  addSequenceAnomaly(file, line, record, sequences, state.anomalies);
  state.records.push(record);
}
function acceptTraceValue(file, line, value, state, sequences) {
  if (validateDiagnosticTraceRecord(value)) {
    if (state.includeDiagnostics)
      state.records.push(value);
    return;
  }
  const validated = validateLifecycleRecord(value);
  if (!validated.accepted) {
    state.anomalies.push({ file, line, code: "invalid-record" });
    return;
  }
  acceptLifecycleRecord(file, line, validated.record, state, sequences);
}
function readTraceFile(file, state) {
  let content;
  try {
    if (file.size > DEFAULT_TRACE_MAX_TOTAL_BYTES) {
      state.anomalies.push({ file: file.name, code: "oversized-record" });
      return;
    }
    content = readFileSync(file.path);
  } catch {
    state.anomalies.push({ file: file.name, code: "unreadable-file" });
    return;
  }
  const complete = content.length === 0 || content[content.length - 1] === 10;
  const lines = content.toString("utf8").split(`
`);
  if (complete)
    lines.pop();
  const sequences = new Map;
  for (let index = 0;index < lines.length; index += 1) {
    const value = readTraceLine(file.name, lines[index] ?? "", index + 1, !complete && index === lines.length - 1, state);
    if (value !== undefined)
      acceptTraceValue(file.name, index + 1, value, state, sequences);
  }
}
function selectTraceRecords(records, filter) {
  if (Object.keys(filter).length === 0)
    return records;
  const selected = new Set(records.filter((record) => record.record_type === "lifecycle" && matches(record, filter)));
  const ancestors = new Map;
  for (const record of records) {
    if (record.record_type === "lifecycle" && !ancestors.has(record.record_identity))
      ancestors.set(record.record_identity, record);
  }
  for (const record of selected) {
    const parent = record.parent_record_identity === undefined ? undefined : ancestors.get(record.parent_record_identity);
    if (parent !== undefined)
      selected.add(parent);
  }
  return records.filter((record) => selected.has(record));
}
function queryTraces(options = {}) {
  const root = traceRoot(options.stateHome);
  if (!traceRootIsAvailable(root))
    return unavailableTraceResult(root);
  const filter = options.filter ?? {};
  const state = {
    records: [],
    anomalies: [],
    deliveries: new Map,
    includeDiagnostics: Object.keys(filter).length === 0
  };
  for (const file of admittedTraceFiles(root, MAX_QUERY_TRACE_ENTRIES))
    readTraceFile(file, state);
  return { available: true, trace_root: root, records: selectTraceRecords(state.records, filter), anomalies: state.anomalies };
}
function cleanupTraces(options = {}) {
  const root = traceRoot(options.stateHome);
  const unavailable = { available: false, trace_root: root, scanned_files: 0, removed_files: 0, removed_bytes: 0, retained_bytes: 0, scan_truncated: false };
  if (root === null || !existsSync(root))
    return unavailable;
  try {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      return unavailable;
  } catch {
    return unavailable;
  }
  const files = admittedTraceFiles(root);
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_TRACE_MAX_AGE_MS;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_TRACE_MAX_TOTAL_BYTES;
  let removedFiles = 0;
  let removedBytes = 0;
  const retained = files.filter((file) => {
    if (nowMs - file.mtimeMs <= maxAgeMs)
      return true;
    try {
      unlinkSync(file.path);
      removedFiles += 1;
      removedBytes += file.size;
    } catch {
      return true;
    }
    return false;
  }).sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
  let retainedBytes = retained.reduce((total, file) => total + file.size, 0);
  while (retainedBytes > maxTotalBytes && retained.length > 0) {
    const file = retained.shift();
    if (!file)
      break;
    try {
      unlinkSync(file.path);
      removedFiles += 1;
      removedBytes += file.size;
      retainedBytes -= file.size;
    } catch {}
  }
  return {
    available: true,
    trace_root: root,
    scanned_files: files.length,
    removed_files: removedFiles,
    removed_bytes: removedBytes,
    retained_bytes: retainedBytes,
    scan_truncated: false
  };
}

// packages/recovery-observability/src/logtape-diagnostic-adapter.ts
import { AsyncLocalStorage } from "async_hooks";
// node_modules/.bun/@logtape+logtape@2.3.1/node_modules/@logtape/logtape/dist/context.js
var categoryPrefixSymbol = Symbol.for("logtape.categoryPrefix");
function getCategoryPrefix() {
  const rootLogger = LoggerImpl.getLogger();
  const store = rootLogger.contextLocalStorage?.getStore();
  if (store == null)
    return [];
  const prefix = store[categoryPrefixSymbol];
  return Array.isArray(prefix) ? prefix : [];
}
function getImplicitContextIfAny() {
  const rootLogger = LoggerImpl.getLogger();
  const store = rootLogger.contextLocalStorage?.getStore();
  if (store == null)
    return;
  const keys = Object.keys(store);
  if (keys.length < 1)
    return;
  const result = {};
  for (const key of keys)
    result[key] = store[key];
  return result;
}

// node_modules/.bun/@logtape+logtape@2.3.1/node_modules/@logtape/logtape/dist/level.js
var logLevels = [
  "trace",
  "debug",
  "info",
  "warning",
  "error",
  "fatal"
];
function isLogLevel(level) {
  switch (level) {
    case "trace":
    case "debug":
    case "info":
    case "warning":
    case "error":
    case "fatal":
      return true;
    default:
      return false;
  }
}
function compareLogLevel(a, b) {
  const aIndex = logLevels.indexOf(a);
  if (aIndex < 0)
    throw new TypeError(`Invalid log level: ${JSON.stringify(a)}.`);
  const bIndex = logLevels.indexOf(b);
  if (bIndex < 0)
    throw new TypeError(`Invalid log level: ${JSON.stringify(b)}.`);
  return aIndex - bIndex;
}

// node_modules/.bun/@logtape+logtape@2.3.1/node_modules/@logtape/logtape/dist/filter.js
function toFilter(filter) {
  if (typeof filter === "function")
    return filter;
  return getLevelFilter(filter);
}
function getLevelFilter(level) {
  if (level == null)
    return () => false;
  if (level === "fatal")
    return (record) => record.level === "fatal";
  else if (level === "error")
    return (record) => record.level === "fatal" || record.level === "error";
  else if (level === "warning")
    return (record) => record.level === "fatal" || record.level === "error" || record.level === "warning";
  else if (level === "info")
    return (record) => record.level === "fatal" || record.level === "error" || record.level === "warning" || record.level === "info";
  else if (level === "debug")
    return (record) => record.level === "fatal" || record.level === "error" || record.level === "warning" || record.level === "info" || record.level === "debug";
  else if (level === "trace")
    return () => true;
  throw new TypeError(`Invalid log level: ${level}.`);
}

// node_modules/.bun/@logtape+logtape@2.3.1/node_modules/@logtape/logtape/dist/scoped-config.js
var scopedConfigSymbol = Symbol.for("logtape.scopedConfig");
var defaultScopedLogger = {
  filters: [],
  lowestLevel: "trace",
  parentSinks: "inherit",
  sinks: []
};
var noFilters = [];
function compileScopedConfig(config, allowAsync, createError) {
  if (!isObjectLike(config))
    throw createError("Configuration must be an object.");
  if (!isObjectLike(config.sinks))
    throw createError("Configuration must include a sinks object.");
  if (!Array.isArray(config.loggers))
    throw createError("Configuration must include a loggers array.");
  if (config.filters !== undefined && !isObjectLike(config.filters))
    throw createError("Configuration filters must be an object.");
  const nodes = /* @__PURE__ */ new Map;
  const configuredCategories = /* @__PURE__ */ new Set;
  for (const logger of config.loggers) {
    if (!isObjectLike(logger))
      throw createError("Logger configuration must be an object.");
    const loggerConfig = logger;
    const category = normalizeCategory(loggerConfig.category, createError);
    if (loggerConfig.sinks !== undefined && !Array.isArray(loggerConfig.sinks))
      throw createError("Logger sinks must be an array.");
    if (loggerConfig.filters !== undefined && !Array.isArray(loggerConfig.filters))
      throw createError("Logger filters must be an array.");
    if (loggerConfig.parentSinks !== undefined && loggerConfig.parentSinks !== "inherit" && loggerConfig.parentSinks !== "override")
      throw createError('Logger parentSinks must be "inherit" or "override".');
    if (loggerConfig.lowestLevel !== undefined && loggerConfig.lowestLevel !== null && !isLogLevel(loggerConfig.lowestLevel))
      throw createError("Logger lowestLevel must be a log level or null.");
    const key = categoryKey(category);
    if (configuredCategories.has(key))
      throw createError(`Duplicate logger configuration for category: ${key}. Each category can only be configured once.`);
    configuredCategories.add(key);
    const sinks = [];
    const sinkIds = loggerConfig.sinks ?? [];
    for (const sinkId of sinkIds) {
      const sink = config.sinks[sinkId];
      if (!sink)
        throw createError(`Sink not found: ${sinkId}.`);
      if (typeof sink !== "function")
        throw createError(`Sink must be a function: ${sinkId}.`);
      sinks.push(sink);
    }
    const filters = [];
    const filterIds = loggerConfig.filters ?? [];
    for (const filterId of filterIds) {
      const filter = config.filters?.[filterId];
      if (filter === undefined)
        throw createError(`Filter not found: ${filterId}.`);
      if (!isFilterLike(filter))
        throw createError(`Filter must be a function, log level, or null: ${filterId}.`);
      filters.push(toFilter(filter));
    }
    nodes.set(key, {
      filters,
      lowestLevel: loggerConfig.lowestLevel === undefined ? "trace" : loggerConfig.lowestLevel,
      parentSinks: loggerConfig.parentSinks ?? "inherit",
      sinks
    });
  }
  const syncFilters = /* @__PURE__ */ new Set;
  const asyncFilters = /* @__PURE__ */ new Set;
  const syncSinks = /* @__PURE__ */ new Set;
  const asyncSinks = /* @__PURE__ */ new Set;
  for (const sink of Object.values(config.sinks)) {
    if (!isObjectLike(sink))
      continue;
    if (Symbol.asyncDispose in sink) {
      if (!allowAsync)
        throw createError("Async disposables cannot be used with withConfigSync().");
      asyncSinks.add(sink);
    } else if (Symbol.dispose in sink)
      syncSinks.add(sink);
  }
  for (const filter of Object.values(config.filters ?? {})) {
    if (!isObjectLike(filter))
      continue;
    if (Symbol.asyncDispose in filter) {
      if (!allowAsync)
        throw createError("Async disposables cannot be used with withConfigSync().");
      asyncFilters.add(filter);
      asyncSinks.delete(filter);
    } else if (Symbol.dispose in filter) {
      syncFilters.add(filter);
      syncSinks.delete(filter);
    }
  }
  return {
    asyncFilters,
    asyncSinks,
    dispatchCache: /* @__PURE__ */ new Map,
    disposed: false,
    filterCache: /* @__PURE__ */ new Map,
    nodes,
    parent: undefined,
    syncFilters,
    syncSinks
  };
}
function getCurrentScopedConfig(contextLocalStorage) {
  const store = contextLocalStorage?.getStore();
  const scopedConfig = store?.[scopedConfigSymbol];
  return isCompiledScopedConfig(scopedConfig) ? getActiveScopedConfig(scopedConfig) : undefined;
}
function runWithScopedConfig(contextLocalStorage, scopedConfig, callback) {
  const parentStore = contextLocalStorage.getStore() ?? {};
  scopedConfig.parent = getCurrentScopedConfig(contextLocalStorage);
  return contextLocalStorage.run({
    ...parentStore,
    [scopedConfigSymbol]: scopedConfig
  }, callback);
}
function scopedConfigHasSink(scopedConfig, category, level) {
  return getScopedSinkDispatchPlan(scopedConfig, category, level).kind !== "none";
}
function emitWithScopedConfig(scopedConfig, record, bypassSinks, emitToSink) {
  const plan = getScopedSinkDispatchPlan(scopedConfig, record.category, record.level);
  if (plan.kind === "none")
    return;
  if (!filterScopedRecord(scopedConfig, record.category, record))
    return;
  if (plan.kind === "one") {
    if (!bypassSinks?.has(plan.sink))
      emitToSink(plan.sink, bypassSinks);
    return;
  }
  for (const sink of plan.sinks) {
    if (bypassSinks?.has(sink))
      continue;
    emitToSink(sink, bypassSinks);
  }
}
function disposeScopedConfigSync(scopedConfig, retainedDisposables) {
  const parentDisposables = getParentScopedDisposables(scopedConfig, retainedDisposables);
  scopedConfig.disposed = true;
  const errors = [];
  try {
    disposeSyncDisposables(scopedConfig.syncFilters, parentDisposables);
  } catch (error) {
    errors.push(error);
  }
  try {
    disposeSyncDisposables(scopedConfig.syncSinks, parentDisposables);
  } catch (error) {
    errors.push(error);
  }
  throwDisposeErrors(errors);
}
function throwCombinedErrors(primary, secondary) {
  throw new AggregateError(flattenErrors(primary, secondary), "Multiple errors occurred while running LogTape scoped configuration.");
}
function isCompiledScopedConfig(value) {
  return value != null && typeof value === "object" && "nodes" in value;
}
function isObjectLike(value) {
  return value != null && (typeof value === "object" || typeof value === "function");
}
function isFilterLike(value) {
  return value == null || typeof value === "function" || typeof value === "string" && isLogLevel(value);
}
function getActiveScopedConfig(scopedConfig) {
  let activeConfig = scopedConfig;
  while (activeConfig?.disposed)
    activeConfig = activeConfig.parent;
  return activeConfig;
}
function getParentScopedDisposables(scopedConfig, extraRetained) {
  const disposables = new Set(extraRetained);
  let parent = scopedConfig.parent;
  while (parent != null) {
    const activeParent = getActiveScopedConfig(parent);
    if (activeParent == null)
      break;
    addScopedDisposables(disposables, activeParent);
    parent = activeParent.parent;
  }
  return disposables;
}
function addScopedDisposables(disposables, scopedConfig) {
  for (const disposable of scopedConfig.syncFilters)
    disposables.add(disposable);
  for (const disposable of scopedConfig.asyncFilters)
    disposables.add(disposable);
  for (const disposable of scopedConfig.syncSinks)
    disposables.add(disposable);
  for (const disposable of scopedConfig.asyncSinks)
    disposables.add(disposable);
}
function normalizeCategory(category, createError) {
  if (typeof category === "string")
    return [category];
  if (!Array.isArray(category))
    throw createError("Logger category must be a string or array of strings.");
  if (category.some((part) => typeof part !== "string"))
    throw createError("Logger category must only contain strings.");
  return [...category];
}
function categoryKey(category) {
  return JSON.stringify(category);
}
function getScopedSinkDispatchPlan(scopedConfig, category, level) {
  const cacheKey = `${categoryKey(category)}:${level}`;
  let plan = scopedConfig.dispatchCache.get(cacheKey);
  if (plan == null) {
    plan = getScopedSinkDispatchPlanForPrefix(scopedConfig, category, category.length, level);
    scopedConfig.dispatchCache.set(cacheKey, plan);
  }
  return plan;
}
function getScopedSinkDispatchPlanForPrefix(scopedConfig, category, length, level) {
  const prefix = category.slice(0, length);
  const logger = scopedConfig.nodes.get(categoryKey(prefix)) ?? defaultScopedLogger;
  if (logger.lowestLevel === null || compareLogLevel(level, logger.lowestLevel) < 0)
    return { kind: "none" };
  const parentPlan = length > 0 && logger.parentSinks === "inherit" ? getScopedSinkDispatchPlanForPrefix(scopedConfig, category, length - 1, level) : { kind: "none" };
  let firstSink;
  let sinks;
  const appendSink = (sink) => {
    if (sinks != null)
      sinks.push(sink);
    else if (firstSink == null)
      firstSink = sink;
    else
      sinks = [firstSink, sink];
  };
  if (parentPlan.kind === "one")
    appendSink(parentPlan.sink);
  else if (parentPlan.kind === "many")
    for (const sink of parentPlan.sinks)
      appendSink(sink);
  for (const sink of logger.sinks)
    appendSink(sink);
  if (sinks != null)
    return {
      kind: "many",
      sinks
    };
  if (firstSink != null)
    return {
      kind: "one",
      sink: firstSink
    };
  return { kind: "none" };
}
function filterScopedRecord(scopedConfig, category, record) {
  const key = categoryKey(category);
  let filters = scopedConfig.filterCache.get(key);
  if (filters == null) {
    filters = getScopedFilters(scopedConfig, category);
    scopedConfig.filterCache.set(key, filters);
  }
  return filters.every((filter) => filter(record));
}
function getScopedFilters(scopedConfig, category) {
  for (let length = category.length;length >= 0; length--) {
    const logger = scopedConfig.nodes.get(categoryKey(category.slice(0, length)));
    if (logger == null || logger.filters.length < 1)
      continue;
    return logger.filters;
  }
  return noFilters;
}
function disposeSyncDisposables(disposables, retainedDisposables) {
  const disposableList = filterRetainedDisposables(disposables, retainedDisposables);
  const errors = [];
  try {
    for (const disposable of disposableList)
      try {
        disposable[Symbol.dispose]();
      } catch (error) {
        errors.push(error);
      }
  } finally {
    disposables.clear();
  }
  throwDisposeErrors(errors);
}
function filterRetainedDisposables(disposables, retainedDisposables) {
  return Array.from(disposables).filter((disposable) => !retainedDisposables.has(disposable));
}
function throwDisposeErrors(errors) {
  if (errors.length < 1)
    return;
  if (errors.length === 1)
    throw errors[0];
  throw new AggregateError(errors, "Multiple errors occurred while disposing LogTape scoped resources.");
}
function flattenErrors(...errors) {
  const flattened = [];
  for (const error of errors)
    if (error instanceof AggregateError)
      flattened.push(...error.errors);
    else
      flattened.push(error);
  return flattened;
}

// node_modules/.bun/@logtape+logtape@2.3.1/node_modules/@logtape/logtape/dist/logger.js
var lazySymbol = Symbol.for("logtape.lazy");
var throttlingSummaryRecordSymbol = Symbol.for("LogTape.throttlingSummaryRecord");
var immediateSinkSymbol = Symbol.for("LogTape.sinkSnapshotPolicy.immediate");
var internalStringLogRecords = /* @__PURE__ */ new WeakSet;
var resolvedStringLogRecords = /* @__PURE__ */ new WeakSet;
function isLazy(value) {
  return value != null && typeof value === "object" && lazySymbol in value && value[lazySymbol] === true;
}
function resolveProperties(properties) {
  const resolved = {};
  for (const key in properties) {
    const value = properties[key];
    resolved[key] = isLazy(value) ? value.getter() : value;
  }
  const symbolProperties = properties;
  const symbolResolved = resolved;
  if (Object.prototype.propertyIsEnumerable.call(properties, throttlingSummaryRecordSymbol)) {
    const value = symbolProperties[throttlingSummaryRecordSymbol];
    symbolResolved[throttlingSummaryRecordSymbol] = isLazy(value) ? value.getter() : value;
  }
  return resolved;
}
function isPromiseObject(value) {
  if (value instanceof Promise)
    return true;
  return Object.prototype.toString.call(value) === "[object Promise]" && typeof value.then === "function";
}
function logStringMessage(logger, level, message, props) {
  if (typeof props !== "function") {
    const properties = props ?? {};
    logger.log(level, message, properties);
    return;
  }
  if (!logger.isEnabledFor(level))
    return Promise.resolve();
  const result = props();
  if (isPromiseObject(result))
    return Promise.resolve(result).then((resolvedProps) => {
      logger.log(level, message, resolvedProps);
    });
  logger.log(level, message, result);
}
function snapshotLogRecordProperties(record) {
  if (resolvedStringLogRecords.has(record))
    return record;
  const properties = resolveProperties(record.properties);
  if (internalStringLogRecords.has(record))
    return {
      category: record.category,
      level: record.level,
      get message() {
        return record.message;
      },
      rawMessage: record.rawMessage,
      timestamp: record.timestamp,
      properties
    };
  const descriptors = Object.getOwnPropertyDescriptors(record);
  descriptors.properties = {
    value: properties,
    enumerable: true,
    configurable: true
  };
  return Object.defineProperties({}, descriptors);
}
function hasEnumerableProperties(properties) {
  if (properties == null || typeof properties !== "object")
    return false;
  return Object.keys(properties).length > 0 || Object.prototype.propertyIsEnumerable.call(properties, throttlingSummaryRecordSymbol);
}
function shouldSnapshotForSink(sink) {
  return sink[immediateSinkSymbol] !== true;
}
function getLogger(category = []) {
  return LoggerImpl.getLogger(category);
}
var globalRootLoggerSymbol = Symbol.for("logtape.rootLogger");
function isMetaLoggerCategory(category) {
  return category.length >= 2 && category[0] === "logtape" && category[1] === "meta";
}
var LoggerImpl = class LoggerImpl2 {
  parent;
  children;
  category;
  sinks;
  filters;
  contextLocalStorage;
  #parentSinks = "inherit";
  #lowestLevel = "trace";
  #sinkPlanCache = {};
  static getLogger(category = []) {
    let rootLogger = globalRootLoggerSymbol in globalThis ? globalThis[globalRootLoggerSymbol] ?? null : null;
    if (rootLogger == null) {
      rootLogger = new LoggerImpl2(null, []);
      globalThis[globalRootLoggerSymbol] = rootLogger;
    }
    if (typeof category === "string")
      return rootLogger.getChild(category);
    if (category.length === 0)
      return rootLogger;
    return rootLogger.getChild(category);
  }
  static getNearestExistingLogger(category) {
    let logger = LoggerImpl2.getLogger();
    for (const name of category) {
      const childRef = logger.children[name];
      const child = childRef instanceof LoggerImpl2 ? childRef : childRef?.deref();
      if (child == null)
        break;
      logger = child;
    }
    return logger;
  }
  constructor(parent, category) {
    this.parent = parent;
    this.children = {};
    this.category = category;
    this.sinks = [];
    this.filters = [];
  }
  get parentSinks() {
    return this.#parentSinks;
  }
  set parentSinks(value) {
    if (this.#parentSinks === value)
      return;
    this.#parentSinks = value;
  }
  get lowestLevel() {
    return this.#lowestLevel;
  }
  set lowestLevel(value) {
    if (this.#lowestLevel === value)
      return;
    this.#lowestLevel = value;
  }
  getChild(subcategory) {
    const name = typeof subcategory === "string" ? subcategory : subcategory[0];
    const childRef = this.children[name];
    let child = childRef instanceof LoggerImpl2 ? childRef : childRef?.deref();
    if (child == null) {
      child = new LoggerImpl2(this, [...this.category, name]);
      this.children[name] = "WeakRef" in globalThis ? new WeakRef(child) : child;
    }
    if (typeof subcategory === "string" || subcategory.length === 1)
      return child;
    return child.getChild(subcategory.slice(1));
  }
  reset() {
    while (this.sinks.length > 0)
      this.sinks.shift();
    this.parentSinks = "inherit";
    while (this.filters.length > 0)
      this.filters.shift();
    this.lowestLevel = "trace";
  }
  resetDescendants() {
    for (const child of Object.values(this.children)) {
      const logger = child instanceof LoggerImpl2 ? child : child.deref();
      if (logger != null)
        logger.resetDescendants();
    }
    this.reset();
  }
  with(properties) {
    return new LoggerCtx(this, { ...properties });
  }
  filter(record) {
    for (const filter of this.filters)
      if (!filter(record))
        return false;
    if (this.filters.length < 1)
      return this.parent?.filter(record) ?? true;
    return true;
  }
  *getSinks(level) {
    const plan = this.getSinkDispatchPlan(level);
    switch (plan.kind) {
      case "none":
        return;
      case "one":
        yield plan.sink;
        return;
      case "many":
        yield* plan.sinks;
        return;
    }
  }
  getSinkDispatchPlan(level) {
    const cached = this.#sinkPlanCache[level];
    if (cached != null && this.isSinkDispatchPlanFresh(level, cached))
      return cached;
    const parentPlan = this.parent != null && this.parentSinks === "inherit" ? this.parent.getSinkDispatchPlan(level) : undefined;
    const plan = this.createSinkDispatchPlan(level, parentPlan);
    this.#sinkPlanCache[level] = plan;
    return plan;
  }
  isSinkDispatchPlanFresh(level, plan) {
    if (plan.lowestLevel !== this.lowestLevel || plan.parentSinks !== this.parentSinks || plan.localSinks.length !== this.sinks.length)
      return false;
    for (let i = 0;i < plan.localSinks.length; i++)
      if (plan.localSinks[i] !== this.sinks[i])
        return false;
    const parentPlan = this.parent != null && this.parentSinks === "inherit" ? this.parent.getSinkDispatchPlan(level) : undefined;
    return plan.parentPlan === parentPlan;
  }
  createSinkDispatchPlan(level, parentPlan) {
    const state = {
      localSinks: [...this.sinks],
      parentSinks: this.parentSinks,
      lowestLevel: this.lowestLevel,
      parentPlan
    };
    if (state.lowestLevel === null)
      return {
        ...state,
        kind: "none"
      };
    if (compareLogLevel(level, state.lowestLevel) < 0)
      return {
        ...state,
        kind: "none"
      };
    let firstSink;
    let sinks;
    const appendSink = (sink) => {
      if (sinks != null)
        sinks.push(sink);
      else if (firstSink == null)
        firstSink = sink;
      else
        sinks = [firstSink, sink];
    };
    if (parentPlan != null) {
      if (parentPlan.kind === "one")
        firstSink = parentPlan.sink;
      else if (parentPlan.kind === "many")
        sinks = [...parentPlan.sinks];
    }
    for (const sink of state.localSinks)
      appendSink(sink);
    if (sinks != null)
      return {
        ...state,
        kind: "many",
        sinks
      };
    if (firstSink != null)
      return {
        ...state,
        kind: "one",
        sink: firstSink
      };
    return {
      ...state,
      kind: "none"
    };
  }
  isEnabledFor(level) {
    const categoryPrefix = isMetaLoggerCategory(this.category) ? [] : getCategoryPrefix();
    const dispatcher = categoryPrefix.length > 0 ? LoggerImpl2.getNearestExistingLogger([...categoryPrefix, ...this.category]) : this;
    const scopedConfig = getCurrentScopedConfig(LoggerImpl2.getLogger().contextLocalStorage);
    if (scopedConfig != null)
      return scopedConfigHasSink(scopedConfig, categoryPrefix.length > 0 ? [...categoryPrefix, ...this.category] : this.category, level);
    return dispatcher.isEnabledForResolved(level);
  }
  isEnabledForResolved(level) {
    return this.getSinkDispatchPlan(level).kind !== "none";
  }
  emit(record, bypassSinks) {
    const hasCategory = "category" in record;
    const baseCategory = hasCategory ? record.category : this.category;
    const categoryPrefix = isMetaLoggerCategory(baseCategory) ? [] : getCategoryPrefix();
    const fullCategory = categoryPrefix.length > 0 ? [...categoryPrefix, ...baseCategory] : baseCategory;
    if (categoryPrefix.length < 1 && Object.prototype.hasOwnProperty.call(record, "category")) {
      this.emitResolved(record, bypassSinks);
      return;
    }
    const descriptors = Object.getOwnPropertyDescriptors(record);
    descriptors.category = {
      value: fullCategory,
      enumerable: true,
      configurable: true
    };
    const fullRecord = Object.defineProperties({}, descriptors);
    const dispatcher = categoryPrefix.length > 0 ? LoggerImpl2.getNearestExistingLogger(fullCategory) : this;
    dispatcher.emitResolved(fullRecord, bypassSinks);
  }
  emitResolved(record, bypassSinks) {
    const scopedConfig = getCurrentScopedConfig(LoggerImpl2.getLogger().contextLocalStorage);
    if (scopedConfig != null) {
      let snapshot$1;
      let snapshotFailed$1 = false;
      emitWithScopedConfig(scopedConfig, record, bypassSinks, (sink, activeBypassSinks) => {
        try {
          if (shouldSnapshotForSink(sink))
            try {
              snapshot$1 ??= snapshotLogRecordProperties(record);
            } catch {
              snapshotFailed$1 = true;
              snapshot$1 = record;
            }
          sink(snapshot$1 ?? record);
        } catch (error) {
          const bypassSinks2 = new Set(activeBypassSinks);
          bypassSinks2.add(sink);
          metaLogger.log("fatal", "Failed to emit a log record to sink {sink}: {error}", {
            sink,
            error,
            record
          }, bypassSinks2);
        }
        if (snapshotFailed$1)
          snapshot$1 = record;
      });
      return;
    }
    if (this.lowestLevel === null || compareLogLevel(record.level, this.lowestLevel) < 0 || !this.filter(record))
      return;
    const plan = this.getSinkDispatchPlan(record.level);
    if (plan.kind === "none")
      return;
    let snapshot;
    let snapshotFailed = false;
    if (plan.kind === "one") {
      const sink = plan.sink;
      if (bypassSinks?.has(sink))
        return;
      try {
        if (shouldSnapshotForSink(sink))
          try {
            snapshot = snapshotLogRecordProperties(record);
          } catch {
            snapshotFailed = true;
            snapshot = record;
          }
        sink(snapshot ?? record);
      } catch (error) {
        const bypassSinks2 = new Set(bypassSinks);
        bypassSinks2.add(sink);
        metaLogger.log("fatal", "Failed to emit a log record to sink {sink}: {error}", {
          sink,
          error,
          record
        }, bypassSinks2);
      }
      return;
    }
    for (const sink of plan.sinks) {
      if (bypassSinks?.has(sink))
        continue;
      try {
        if (snapshot == null && !snapshotFailed && shouldSnapshotForSink(sink))
          try {
            snapshot = snapshotLogRecordProperties(record);
          } catch {
            snapshotFailed = true;
            snapshot = record;
          }
        sink(snapshot ?? record);
      } catch (error) {
        const bypassSinks2 = new Set(bypassSinks);
        bypassSinks2.add(sink);
        metaLogger.log("fatal", "Failed to emit a log record to sink {sink}: {error}", {
          sink,
          error,
          record
        }, bypassSinks2);
      }
    }
  }
  log(level, rawMessage, properties, bypassSinks) {
    const implicitContext = getImplicitContextIfAny();
    if (typeof properties !== "function" && implicitContext == null && !rawMessage.includes("{") && !hasEnumerableProperties(properties)) {
      const record$1 = {
        category: this.category,
        level,
        message: [rawMessage],
        rawMessage,
        timestamp: Date.now(),
        properties: {}
      };
      resolvedStringLogRecords.add(record$1);
      this.emit(record$1, bypassSinks);
      return;
    }
    let cachedProps = undefined;
    let cachedMessage = undefined;
    const record = typeof properties === "function" ? {
      category: this.category,
      level,
      timestamp: Date.now(),
      get message() {
        if (cachedMessage == null)
          cachedMessage = parseMessageTemplate(rawMessage, this.properties);
        return cachedMessage;
      },
      rawMessage,
      get properties() {
        if (cachedProps == null)
          cachedProps = resolveProperties({
            ...implicitContext ?? {},
            ...properties()
          });
        return cachedProps;
      }
    } : {
      category: this.category,
      level,
      timestamp: Date.now(),
      get message() {
        if (cachedMessage == null)
          cachedMessage = parseMessageTemplate(rawMessage, this.properties);
        return cachedMessage;
      },
      rawMessage,
      get properties() {
        if (cachedProps == null)
          cachedProps = resolveProperties({
            ...implicitContext ?? {},
            ...properties
          });
        return cachedProps;
      }
    };
    internalStringLogRecords.add(record);
    this.emit(record, bypassSinks);
  }
  logLazily(level, callback, properties = {}) {
    const implicitContext = getImplicitContextIfAny();
    let rawMessage = undefined;
    let msg = undefined;
    function realizeMessage() {
      if (msg == null || rawMessage == null) {
        msg = callback((tpl, ...values) => {
          rawMessage = tpl;
          return renderMessage(tpl, values);
        });
        if (rawMessage == null)
          throw new TypeError("No log record was made.");
      }
      return [msg, rawMessage];
    }
    this.emit({
      category: this.category,
      level,
      get message() {
        return realizeMessage()[0];
      },
      get rawMessage() {
        return realizeMessage()[1];
      },
      timestamp: Date.now(),
      properties: {
        ...implicitContext ?? {},
        ...properties
      }
    });
  }
  logTemplate(level, messageTemplate, values, properties = {}) {
    const implicitContext = getImplicitContextIfAny();
    this.emit({
      category: this.category,
      level,
      message: renderMessage(messageTemplate, values),
      rawMessage: messageTemplate,
      timestamp: Date.now(),
      properties: {
        ...implicitContext ?? {},
        ...properties
      }
    });
  }
  trace(message, ...values) {
    if (typeof message === "string")
      return logStringMessage(this, "trace", message, values[0]);
    else if (typeof message === "function")
      this.logLazily("trace", message);
    else if (!Array.isArray(message))
      this.log("trace", "{*}", message);
    else
      this.logTemplate("trace", message, values);
  }
  debug(message, ...values) {
    if (typeof message === "string")
      return logStringMessage(this, "debug", message, values[0]);
    else if (typeof message === "function")
      this.logLazily("debug", message);
    else if (!Array.isArray(message))
      this.log("debug", "{*}", message);
    else
      this.logTemplate("debug", message, values);
  }
  info(message, ...values) {
    if (typeof message === "string")
      return logStringMessage(this, "info", message, values[0]);
    else if (typeof message === "function")
      this.logLazily("info", message);
    else if (!Array.isArray(message))
      this.log("info", "{*}", message);
    else
      this.logTemplate("info", message, values);
  }
  logError(level, error, props) {
    if (typeof props !== "function") {
      this.log(level, "{error.message}", {
        ...props,
        error
      });
      return;
    }
    if (!this.isEnabledFor(level))
      return Promise.resolve();
    const result = props();
    if (result instanceof Promise)
      return result.then((resolved) => {
        this.log(level, "{error.message}", {
          ...resolved,
          error
        });
      });
    this.log(level, "{error.message}", {
      ...result,
      error
    });
  }
  warn(message, ...values) {
    if (message instanceof Error)
      return this.logError("warning", message, values[0]);
    else if (typeof message === "string" && values[0] instanceof Error)
      this.log("warning", message, { error: values[0] });
    else if (typeof message === "string")
      return logStringMessage(this, "warning", message, values[0]);
    else if (typeof message === "function")
      this.logLazily("warning", message);
    else if (!Array.isArray(message))
      this.log("warning", "{*}", message);
    else
      this.logTemplate("warning", message, values);
  }
  warning(message, ...values) {
    if (message instanceof Error)
      return this.logError("warning", message, values[0]);
    else if (typeof message === "string" && values[0] instanceof Error)
      this.log("warning", message, { error: values[0] });
    else if (typeof message === "string")
      return logStringMessage(this, "warning", message, values[0]);
    else if (typeof message === "function")
      this.logLazily("warning", message);
    else if (!Array.isArray(message))
      this.log("warning", "{*}", message);
    else
      this.logTemplate("warning", message, values);
  }
  error(message, ...values) {
    if (message instanceof Error)
      return this.logError("error", message, values[0]);
    else if (typeof message === "string" && values[0] instanceof Error)
      this.log("error", message, { error: values[0] });
    else if (typeof message === "string")
      return logStringMessage(this, "error", message, values[0]);
    else if (typeof message === "function")
      this.logLazily("error", message);
    else if (!Array.isArray(message))
      this.log("error", "{*}", message);
    else
      this.logTemplate("error", message, values);
  }
  fatal(message, ...values) {
    if (message instanceof Error)
      return this.logError("fatal", message, values[0]);
    else if (typeof message === "string" && values[0] instanceof Error)
      this.log("fatal", message, { error: values[0] });
    else if (typeof message === "string")
      return logStringMessage(this, "fatal", message, values[0]);
    else if (typeof message === "function")
      this.logLazily("fatal", message);
    else if (!Array.isArray(message))
      this.log("fatal", "{*}", message);
    else
      this.logTemplate("fatal", message, values);
  }
};
var LoggerCtx = class LoggerCtx2 {
  logger;
  properties;
  constructor(logger, properties) {
    this.logger = logger;
    this.properties = properties;
  }
  get category() {
    return this.logger.category;
  }
  get parent() {
    return this.logger.parent;
  }
  getChild(subcategory) {
    return this.logger.getChild(subcategory).with(this.properties);
  }
  with(properties) {
    return new LoggerCtx2(this.logger, {
      ...this.properties,
      ...properties
    });
  }
  log(level, message, properties, bypassSinks) {
    const contextProps = this.properties;
    this.logger.log(level, message, typeof properties === "function" ? () => resolveProperties({
      ...contextProps,
      ...properties()
    }) : () => resolveProperties({
      ...contextProps,
      ...properties
    }), bypassSinks);
  }
  logLazily(level, callback) {
    this.logger.logLazily(level, callback, resolveProperties(this.properties));
  }
  logTemplate(level, messageTemplate, values) {
    this.logger.logTemplate(level, messageTemplate, values, resolveProperties(this.properties));
  }
  emit(record) {
    const recordWithContext = {
      ...record,
      properties: resolveProperties({
        ...this.properties,
        ...record.properties
      })
    };
    this.logger.emit(recordWithContext);
  }
  isEnabledFor(level) {
    return this.logger.isEnabledFor(level);
  }
  trace(message, ...values) {
    if (typeof message === "string")
      return logStringMessage(this, "trace", message, values[0]);
    else if (typeof message === "function")
      this.logLazily("trace", message);
    else if (!Array.isArray(message))
      this.log("trace", "{*}", message);
    else
      this.logTemplate("trace", message, values);
  }
  debug(message, ...values) {
    if (typeof message === "string")
      return logStringMessage(this, "debug", message, values[0]);
    else if (typeof message === "function")
      this.logLazily("debug", message);
    else if (!Array.isArray(message))
      this.log("debug", "{*}", message);
    else
      this.logTemplate("debug", message, values);
  }
  info(message, ...values) {
    if (typeof message === "string")
      return logStringMessage(this, "info", message, values[0]);
    else if (typeof message === "function")
      this.logLazily("info", message);
    else if (!Array.isArray(message))
      this.log("info", "{*}", message);
    else
      this.logTemplate("info", message, values);
  }
  logError(level, error, props) {
    if (typeof props !== "function") {
      this.log(level, "{error.message}", {
        ...props,
        error
      });
      return;
    }
    if (!this.isEnabledFor(level))
      return Promise.resolve();
    const result = props();
    if (result instanceof Promise)
      return result.then((resolved) => {
        this.log(level, "{error.message}", {
          ...resolved,
          error
        });
      });
    this.log(level, "{error.message}", {
      ...result,
      error
    });
  }
  warn(message, ...values) {
    if (message instanceof Error)
      return this.logError("warning", message, values[0]);
    else if (typeof message === "string" && values[0] instanceof Error)
      this.log("warning", message, { error: values[0] });
    else if (typeof message === "string")
      return logStringMessage(this, "warning", message, values[0]);
    else if (typeof message === "function")
      this.logLazily("warning", message);
    else if (!Array.isArray(message))
      this.log("warning", "{*}", message);
    else
      this.logTemplate("warning", message, values);
  }
  warning(message, ...values) {
    if (message instanceof Error)
      return this.logError("warning", message, values[0]);
    else if (typeof message === "string" && values[0] instanceof Error)
      this.log("warning", message, { error: values[0] });
    else if (typeof message === "string")
      return logStringMessage(this, "warning", message, values[0]);
    else if (typeof message === "function")
      this.logLazily("warning", message);
    else if (!Array.isArray(message))
      this.log("warning", "{*}", message);
    else
      this.logTemplate("warning", message, values);
  }
  error(message, ...values) {
    if (message instanceof Error)
      return this.logError("error", message, values[0]);
    else if (typeof message === "string" && values[0] instanceof Error)
      this.log("error", message, { error: values[0] });
    else if (typeof message === "string")
      return logStringMessage(this, "error", message, values[0]);
    else if (typeof message === "function")
      this.logLazily("error", message);
    else if (!Array.isArray(message))
      this.log("error", "{*}", message);
    else
      this.logTemplate("error", message, values);
  }
  fatal(message, ...values) {
    if (message instanceof Error)
      return this.logError("fatal", message, values[0]);
    else if (typeof message === "string" && values[0] instanceof Error)
      this.log("fatal", message, { error: values[0] });
    else if (typeof message === "string")
      return logStringMessage(this, "fatal", message, values[0]);
    else if (typeof message === "function")
      this.logLazily("fatal", message);
    else if (!Array.isArray(message))
      this.log("fatal", "{*}", message);
    else
      this.logTemplate("fatal", message, values);
  }
};
var metaLogger = LoggerImpl.getLogger(["logtape", "meta"]);
function isNestedAccess(key) {
  return key.includes(".") || key.includes("[") || key.includes("?.");
}
function getOwnProperty(obj, key) {
  if (key === "__proto__" || key === "prototype" || key === "constructor")
    return;
  if ((typeof obj === "object" || typeof obj === "function") && obj !== null)
    return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
  return;
}
function parseNextSegment(path, fromIndex) {
  const len = path.length;
  let i = fromIndex;
  if (i >= len)
    return null;
  let segment;
  if (path[i] === "[") {
    i++;
    if (i >= len)
      return null;
    if (path[i] === '"' || path[i] === "'") {
      const quote = path[i];
      i++;
      let segmentStr = "";
      while (i < len && path[i] !== quote)
        if (path[i] === "\\") {
          i++;
          if (i < len) {
            const escapeChar = path[i];
            switch (escapeChar) {
              case "n":
                segmentStr += `
`;
                break;
              case "t":
                segmentStr += "\t";
                break;
              case "r":
                segmentStr += "\r";
                break;
              case "b":
                segmentStr += "\b";
                break;
              case "f":
                segmentStr += "\f";
                break;
              case "v":
                segmentStr += "\v";
                break;
              case "0":
                segmentStr += "\x00";
                break;
              case "\\":
                segmentStr += "\\";
                break;
              case '"':
                segmentStr += '"';
                break;
              case "'":
                segmentStr += "'";
                break;
              case "u":
                if (i + 4 < len) {
                  const hex = path.slice(i + 1, i + 5);
                  const codePoint = Number.parseInt(hex, 16);
                  if (!Number.isNaN(codePoint)) {
                    segmentStr += String.fromCharCode(codePoint);
                    i += 4;
                  } else
                    segmentStr += escapeChar;
                } else
                  segmentStr += escapeChar;
                break;
              default:
                segmentStr += escapeChar;
            }
            i++;
          }
        } else {
          segmentStr += path[i];
          i++;
        }
      if (i >= len)
        return null;
      segment = segmentStr;
      i++;
    } else {
      const startIndex = i;
      while (i < len && path[i] !== "]" && path[i] !== "'" && path[i] !== '"')
        i++;
      if (i >= len)
        return null;
      const indexStr = path.slice(startIndex, i);
      if (indexStr.length === 0)
        return null;
      const indexNum = Number(indexStr);
      segment = Number.isNaN(indexNum) ? indexStr : indexNum;
    }
    while (i < len && path[i] !== "]")
      i++;
    if (i < len)
      i++;
  } else {
    const startIndex = i;
    while (i < len && path[i] !== "." && path[i] !== "[" && path[i] !== "?" && path[i] !== "]")
      i++;
    segment = path.slice(startIndex, i);
    if (segment.length === 0)
      return null;
  }
  if (i < len && path[i] === ".")
    i++;
  return {
    segment,
    nextIndex: i
  };
}
function accessProperty(obj, segment) {
  if (typeof segment === "string")
    return getOwnProperty(obj, segment);
  if (Array.isArray(obj) && segment >= 0 && segment < obj.length)
    return obj[segment];
  return;
}
function resolvePropertyPath(obj, path) {
  if (obj == null)
    return;
  if (path.length === 0 || path.endsWith("."))
    return;
  let current = obj;
  let i = 0;
  const len = path.length;
  while (i < len) {
    const isOptional = path.slice(i, i + 2) === "?.";
    if (isOptional) {
      i += 2;
      if (current == null)
        return;
    } else if (current == null)
      return;
    const result = parseNextSegment(path, i);
    if (result === null)
      return;
    const { segment, nextIndex } = result;
    i = nextIndex;
    current = accessProperty(current, segment);
    if (current === undefined)
      return;
  }
  return current;
}
function parseMessageTemplate(template, properties) {
  const length = template.length;
  if (length === 0)
    return [""];
  if (!template.includes("{"))
    return [template];
  const message = [];
  let startIndex = 0;
  for (let i = 0;i < length; i++) {
    const char = template[i];
    if (char === "{") {
      const nextChar = i + 1 < length ? template[i + 1] : "";
      if (nextChar === "{") {
        i++;
        continue;
      }
      const closeIndex = template.indexOf("}", i + 1);
      if (closeIndex === -1)
        continue;
      const beforeText = template.slice(startIndex, i);
      message.push(beforeText.replace(/{{/g, "{").replace(/}}/g, "}"));
      const key = template.slice(i + 1, closeIndex);
      let prop;
      const trimmedKey = key.trim();
      if (trimmedKey === "*")
        prop = key in properties ? properties[key] : ("*" in properties) ? properties["*"] : properties;
      else {
        if (key !== trimmedKey)
          prop = key in properties ? properties[key] : properties[trimmedKey];
        else
          prop = properties[key];
        if (prop === undefined && isNestedAccess(trimmedKey))
          prop = resolvePropertyPath(properties, trimmedKey);
      }
      message.push(prop);
      i = closeIndex;
      startIndex = i + 1;
    } else if (char === "}" && i + 1 < length && template[i + 1] === "}")
      i++;
  }
  const remainingText = template.slice(startIndex);
  message.push(remainingText.replace(/{{/g, "{").replace(/}}/g, "}"));
  return message;
}
function renderMessage(template, values) {
  const args = [];
  for (let i = 0;i < template.length; i++) {
    args.push(template[i]);
    if (i < values.length)
      args.push(values[i]);
  }
  return args;
}
// node_modules/.bun/@logtape+logtape@2.3.1/node_modules/@logtape/logtape/dist/util.node.js
var exports_util_node = {};
__export(exports_util_node, {
  inspect: () => inspect
});
import util from "util";
function inspect(obj, options) {
  return util.inspect(obj, options);
}

// node_modules/.bun/@logtape+logtape@2.3.1/node_modules/@logtape/logtape/dist/formatter.js
var levelAbbreviations = {
  trace: "TRC",
  debug: "DBG",
  info: "INF",
  warning: "WRN",
  error: "ERR",
  fatal: "FTL"
};
var platformInspect = typeof document !== "undefined" || typeof navigator !== "undefined" && navigator.product === "ReactNative" ? (v) => JSON.stringify(v) : ("Deno" in globalThis) && ("inspect" in globalThis.Deno) && typeof globalThis.Deno.inspect === "function" ? (v, opts) => globalThis.Deno.inspect(v, {
  strAbbreviateSize: Infinity,
  iterableLimit: Infinity,
  ...opts
}) : exports_util_node != null && ("inspect" in exports_util_node) && typeof inspect === "function" ? (v, opts) => inspect(v, {
  maxArrayLength: Infinity,
  maxStringLength: Infinity,
  ...opts
}) : (v) => JSON.stringify(v);
var inspect2 = (value, options) => String(platformInspect(value, options));
var utf8Encoder = new TextEncoder;
function renderMessageParts(msgParts, valueRenderer) {
  const msgLen = msgParts.length;
  if (msgLen === 1)
    return msgParts[0];
  if (msgLen <= 6) {
    let message = "";
    for (let i = 0;i < msgLen; i++)
      message += i % 2 === 0 ? msgParts[i] : valueRenderer(msgParts[i]);
    return message;
  }
  const parts = new Array(msgLen);
  for (let i = 0;i < msgLen; i++)
    parts[i] = i % 2 === 0 ? msgParts[i] : valueRenderer(msgParts[i]);
  return parts.join("");
}
function padZero(num) {
  return num < 10 ? `0${num}` : `${num}`;
}
function padThree(num) {
  return num < 10 ? `00${num}` : num < 100 ? `0${num}` : `${num}`;
}
var fixedOffsetPattern = /^([+-])(0\d|1\d|2[0-3]):([0-5]\d)$/;
function formatOffset(minutes, full) {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  const hour = padZero(Math.floor(absolute / 60));
  const minute = padZero(absolute % 60);
  if (!full && minute === "00")
    return `${sign}${hour}`;
  return `${sign}${hour}:${minute}`;
}
function readPartsFromFormatter(formatter, ts) {
  const parts = formatter.formatToParts(new Date(ts));
  let year = "";
  let month = "";
  let day = "";
  let hour = "";
  let minute = "";
  let second = "";
  for (const part of parts)
    if (part.type === "year")
      year = part.value;
    else if (part.type === "month")
      month = part.value;
    else if (part.type === "day")
      day = part.value;
    else if (part.type === "hour")
      hour = part.value;
    else if (part.type === "minute")
      minute = part.value;
    else if (part.type === "second")
      second = part.value;
  return {
    year,
    month,
    day,
    hour,
    minute,
    second
  };
}
function getDateParts(ts, config) {
  const d = new Date(ts);
  const ms = padThree(d.getUTCMilliseconds());
  if (config.kind === "utc")
    return {
      year: `${d.getUTCFullYear()}`,
      month: padZero(d.getUTCMonth() + 1),
      day: padZero(d.getUTCDate()),
      hour: padZero(d.getUTCHours()),
      minute: padZero(d.getUTCMinutes()),
      second: padZero(d.getUTCSeconds()),
      ms,
      offsetMinutes: 0
    };
  if (config.kind === "local")
    return {
      year: `${d.getFullYear()}`,
      month: padZero(d.getMonth() + 1),
      day: padZero(d.getDate()),
      hour: padZero(d.getHours()),
      minute: padZero(d.getMinutes()),
      second: padZero(d.getSeconds()),
      ms,
      offsetMinutes: -d.getTimezoneOffset()
    };
  if (config.kind === "offset") {
    const shifted = new Date(ts + config.minutes * 60000);
    return {
      year: `${shifted.getUTCFullYear()}`,
      month: padZero(shifted.getUTCMonth() + 1),
      day: padZero(shifted.getUTCDate()),
      hour: padZero(shifted.getUTCHours()),
      minute: padZero(shifted.getUTCMinutes()),
      second: padZero(shifted.getUTCSeconds()),
      ms,
      offsetMinutes: config.minutes
    };
  }
  const parts = readPartsFromFormatter(config.formatter, ts);
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second), d.getUTCMilliseconds());
  const offsetMinutes = Math.round((asUtc - ts) / 60000);
  return {
    ...parts,
    ms,
    offsetMinutes
  };
}
function resolveTimeZone(timeZone) {
  if (typeof timeZone === "undefined")
    return { kind: "utc" };
  if (timeZone === null)
    return { kind: "local" };
  const offsetMatch = fixedOffsetPattern.exec(timeZone);
  if (offsetMatch != null) {
    const sign = offsetMatch[1] === "-" ? -1 : 1;
    const hours = Number(offsetMatch[2]);
    const minutes = Number(offsetMatch[3]);
    return {
      kind: "offset",
      minutes: sign * (hours * 60 + minutes)
    };
  }
  if (typeof Intl === "undefined" || typeof Intl.DateTimeFormat !== "function")
    throw new TypeError(`Invalid timeZone option: ${JSON.stringify(timeZone)}. This environment does not support IANA time zones.`);
  try {
    return {
      kind: "iana",
      formatter: new Intl.DateTimeFormat("en-CA", {
        timeZone,
        hour12: false,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      })
    };
  } catch {
    throw new TypeError(`Invalid timeZone option: ${JSON.stringify(timeZone)}. Expected an IANA time zone name (e.g., "Asia/Seoul") or a fixed UTC offset string (e.g., "+09:00").`);
  }
}
function createTimestampFormatter(pattern, timeZone) {
  if (pattern === "none")
    return () => null;
  if (pattern === "rfc3339" && timeZone.kind === "utc")
    return (ts) => new Date(ts).toISOString();
  return (ts) => {
    const parts = getDateParts(ts, timeZone);
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    const time = `${parts.hour}:${parts.minute}:${parts.second}.${parts.ms}`;
    const tzLong = formatOffset(parts.offsetMinutes, true);
    const tzShort = formatOffset(parts.offsetMinutes, false);
    if (pattern === "date-time-timezone")
      return `${date} ${time} ${tzLong}`;
    if (pattern === "date-time-tz")
      return `${date} ${time} ${tzShort}`;
    if (pattern === "date-time")
      return `${date} ${time}`;
    if (pattern === "time-timezone")
      return `${time} ${tzLong}`;
    if (pattern === "time-tz")
      return `${time} ${tzShort}`;
    if (pattern === "time")
      return time;
    if (pattern === "date")
      return date;
    return `${date}T${time}${tzLong}`;
  };
}
var levelRenderersCache = {
  ABBR: levelAbbreviations,
  abbr: {
    trace: "trc",
    debug: "dbg",
    info: "inf",
    warning: "wrn",
    error: "err",
    fatal: "ftl"
  },
  FULL: {
    trace: "TRACE",
    debug: "DEBUG",
    info: "INFO",
    warning: "WARNING",
    error: "ERROR",
    fatal: "FATAL"
  },
  full: {
    trace: "trace",
    debug: "debug",
    info: "info",
    warning: "warning",
    error: "error",
    fatal: "fatal"
  },
  L: {
    trace: "T",
    debug: "D",
    info: "I",
    warning: "W",
    error: "E",
    fatal: "F"
  },
  l: {
    trace: "t",
    debug: "d",
    info: "i",
    warning: "w",
    error: "e",
    fatal: "f"
  }
};
function getLineEndingValue(lineEnding) {
  return lineEnding === "crlf" ? `\r
` : `
`;
}
function jsonReplacer(_key, value) {
  if (!(value instanceof Error))
    return value;
  const serialized = {
    name: value.name,
    message: value.message
  };
  if (typeof value.stack === "string")
    serialized.stack = value.stack;
  const cause = value.cause;
  if (cause !== undefined)
    serialized.cause = cause;
  if (typeof AggregateError !== "undefined" && value instanceof AggregateError)
    serialized.errors = value.errors;
  for (const key of Object.keys(value))
    if (!(key in serialized))
      serialized[key] = value[key];
  return serialized;
}
function renderDefaultJsonLinesMessage(message) {
  const messageLength = message.length;
  if (messageLength === 1)
    return message[0];
  if (messageLength === 3)
    return message[0] + JSON.stringify(message[1]) + message[2];
  let rendered = message[0];
  for (let i = 1;i < messageLength; i++)
    rendered += i & 1 ? JSON.stringify(message[i]) : message[i];
  return rendered;
}
function stringifyJsonLinesField(key, value) {
  if (value != null && (typeof value === "object" || typeof value === "function" || typeof value === "bigint")) {
    const toJSON = value.toJSON;
    if (typeof toJSON === "function")
      value = toJSON.call(value, key);
  }
  return JSON.stringify(jsonReplacer(key, value), jsonReplacer);
}
function formatDefaultJsonLinesRecord(record, lineEnding) {
  const level = record.level === "warning" ? "WARN" : record.level.toUpperCase();
  const messageJson = stringifyJsonLinesField("message", renderDefaultJsonLinesMessage(record.message));
  const propertiesJson = stringifyJsonLinesField("properties", record.properties);
  let line = `{"@timestamp":${JSON.stringify(new Date(record.timestamp).toISOString())},"level":${JSON.stringify(level)}`;
  if (messageJson !== undefined)
    line += `,"message":${messageJson}`;
  line += `,"logger":${JSON.stringify(record.category.join("."))}`;
  if (propertiesJson !== undefined)
    line += `,"properties":${propertiesJson}`;
  return `${line}}${lineEnding}`;
}
function getTextFormatter(options = {}) {
  const timestampRenderer = (() => {
    const tsOption = options.timestamp;
    const timeZone = resolveTimeZone(options.timeZone);
    if (tsOption == null)
      return createTimestampFormatter("date-time-timezone", timeZone);
    else if (tsOption === "disabled")
      return createTimestampFormatter("none", timeZone);
    else if (typeof tsOption === "string" && (tsOption === "date-time-timezone" || tsOption === "date-time-tz" || tsOption === "date-time" || tsOption === "time-timezone" || tsOption === "time-tz" || tsOption === "time" || tsOption === "date" || tsOption === "rfc3339" || tsOption === "none"))
      return createTimestampFormatter(tsOption, timeZone);
    else
      return tsOption;
  })();
  const categorySeparator = options.category ?? "\xB7";
  const valueRenderer = options.value ? (v) => options.value(v, inspect2) : inspect2;
  const levelRenderer = (() => {
    const levelOption = options.level;
    if (levelOption == null || levelOption === "ABBR")
      return (level) => levelRenderersCache.ABBR[level];
    else if (levelOption === "abbr")
      return (level) => levelRenderersCache.abbr[level];
    else if (levelOption === "FULL")
      return (level) => levelRenderersCache.FULL[level];
    else if (levelOption === "full")
      return (level) => levelRenderersCache.full[level];
    else if (levelOption === "L")
      return (level) => levelRenderersCache.L[level];
    else if (levelOption === "l")
      return (level) => levelRenderersCache.l[level];
    else
      return levelOption;
  })();
  const lineEnding = getLineEndingValue(options.lineEnding);
  const formatter = options.format ?? (({ timestamp, level, category, message }) => `${timestamp ? `${timestamp} ` : ""}[${level}] ${category}: ${message}`);
  return (record) => {
    const message = renderMessageParts(record.message, valueRenderer);
    const timestamp = timestampRenderer(record.timestamp);
    const level = levelRenderer(record.level);
    const category = typeof categorySeparator === "function" ? categorySeparator(record.category) : record.category.join(categorySeparator);
    const values = {
      timestamp,
      level,
      category,
      message,
      record
    };
    return `${formatter(values)}${lineEnding}`;
  };
}
var defaultTextFormatter = getTextFormatter();
var RESET = "\x1B[0m";
var ansiColors = {
  black: "\x1B[30m",
  red: "\x1B[31m",
  green: "\x1B[32m",
  yellow: "\x1B[33m",
  blue: "\x1B[34m",
  magenta: "\x1B[35m",
  cyan: "\x1B[36m",
  white: "\x1B[37m"
};
var ansiStyles = {
  bold: "\x1B[1m",
  dim: "\x1B[2m",
  italic: "\x1B[3m",
  underline: "\x1B[4m",
  strikethrough: "\x1B[9m"
};
var defaultLevelColors = {
  trace: null,
  debug: "blue",
  info: "green",
  warning: "yellow",
  error: "red",
  fatal: "magenta"
};
function getAnsiColorFormatter(options = {}) {
  const format = options.format;
  const timestampStyle = typeof options.timestampStyle === "undefined" ? "dim" : options.timestampStyle;
  const timestampColor = options.timestampColor ?? null;
  const timestampPrefix = `${timestampStyle == null ? "" : ansiStyles[timestampStyle]}${timestampColor == null ? "" : ansiColors[timestampColor]}`;
  const timestampSuffix = timestampStyle == null && timestampColor == null ? "" : RESET;
  const levelStyle = typeof options.levelStyle === "undefined" ? "bold" : options.levelStyle;
  const levelColors = options.levelColors ?? defaultLevelColors;
  const categoryStyle = typeof options.categoryStyle === "undefined" ? "dim" : options.categoryStyle;
  const categoryColor = options.categoryColor ?? null;
  const categoryPrefix = `${categoryStyle == null ? "" : ansiStyles[categoryStyle]}${categoryColor == null ? "" : ansiColors[categoryColor]}`;
  const categorySuffix = categoryStyle == null && categoryColor == null ? "" : RESET;
  return getTextFormatter({
    timestamp: "date-time-tz",
    value(value, fallbackInspect) {
      return fallbackInspect(value, { colors: true });
    },
    ...options,
    format({ timestamp, level, category, message, record }) {
      const levelColor = levelColors[record.level];
      timestamp = timestamp == null ? null : `${timestampPrefix}${timestamp}${timestampSuffix}`;
      level = `${levelStyle == null ? "" : ansiStyles[levelStyle]}${levelColor == null ? "" : ansiColors[levelColor]}${level}${levelStyle == null && levelColor == null ? "" : RESET}`;
      return format == null ? `${timestamp == null ? "" : `${timestamp} `}${level} ${categoryPrefix}${category}:${categorySuffix} ${message}` : format({
        timestamp,
        level,
        category: `${categoryPrefix}${category}${categorySuffix}`,
        message,
        record
      });
    }
  });
}
var ansiColorFormatter = getAnsiColorFormatter();
function getJsonLinesFormatter(options = {}) {
  const lineEnding = getLineEndingValue(options.lineEnding);
  if (!options.categorySeparator && !options.message && !options.properties)
    return (record) => formatDefaultJsonLinesRecord(record, lineEnding);
  const isTemplateMessage = options.message === "template";
  const propertiesOption = options.properties ?? "nest:properties";
  let joinCategory;
  if (typeof options.categorySeparator === "function")
    joinCategory = options.categorySeparator;
  else {
    const separator = options.categorySeparator ?? ".";
    joinCategory = (category) => category.join(separator);
  }
  let getProperties;
  if (propertiesOption === "flatten")
    getProperties = (properties) => properties;
  else if (propertiesOption.startsWith("prepend:")) {
    const prefix = propertiesOption.substring(8);
    if (prefix === "")
      throw new TypeError(`Invalid properties option: ${JSON.stringify(propertiesOption)}. It must be of the form "prepend:<prefix>" where <prefix> is a non-empty string.`);
    getProperties = (properties) => {
      const result = {};
      for (const key in properties)
        result[`${prefix}${key}`] = properties[key];
      return result;
    };
  } else if (propertiesOption.startsWith("nest:")) {
    const key = propertiesOption.substring(5);
    getProperties = (properties) => ({ [key]: properties });
  } else
    throw new TypeError(`Invalid properties option: ${JSON.stringify(propertiesOption)}. It must be "flatten", "prepend:<prefix>", or "nest:<key>".`);
  let getMessage;
  if (isTemplateMessage)
    getMessage = (record) => {
      if (typeof record.rawMessage === "string")
        return record.rawMessage;
      let msg = "";
      for (let i = 0;i < record.rawMessage.length; i++) {
        if (i > 0)
          msg += "{}";
        msg += record.rawMessage[i];
      }
      return msg;
    };
  else
    getMessage = (record) => {
      const msgLen = record.message.length;
      if (msgLen === 1)
        return record.message[0];
      let msg = "";
      for (let i = 0;i < msgLen; i++)
        msg += i % 2 < 1 ? record.message[i] : JSON.stringify(record.message[i]);
      return msg;
    };
  return (record) => {
    return JSON.stringify({
      "@timestamp": new Date(record.timestamp).toISOString(),
      level: record.level === "warning" ? "WARN" : record.level.toUpperCase(),
      message: getMessage(record),
      logger: joinCategory(record.category),
      ...getProperties(record.properties)
    }, jsonReplacer) + lineEnding;
  };
}
var jsonLinesFormatter = getJsonLinesFormatter();
function renderStructuredMessage(record, template) {
  if (template) {
    if (typeof record.rawMessage === "string")
      return record.rawMessage;
    return record.rawMessage.join("{}");
  }
  return renderMessageParts(record.message, stringifyLogfmtValue);
}
function filterLogfmtKey(key) {
  if (key === "")
    return null;
  let needsEscape = false;
  for (const char of key) {
    const code = char.codePointAt(0);
    if (shouldEscapeLogfmtKeyChar(char, code)) {
      needsEscape = true;
      break;
    }
  }
  if (!needsEscape)
    return key;
  let result = "";
  for (const char of key) {
    const code = char.codePointAt(0);
    if (shouldEscapeLogfmtKeyChar(char, code))
      result += encodeLogfmtKeyChar(char);
    else
      result += char;
  }
  return result;
}
function shouldEscapeLogfmtKeyChar(char, code) {
  return code <= 32 || code === 127 || code === 65533 || char === "=" || char === '"' || char === "%";
}
function encodeLogfmtKeyChar(char) {
  let result = "";
  for (const byte of utf8Encoder.encode(char))
    result += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  return result;
}
function stringifyLogfmtValue(value) {
  if (typeof value === "string")
    return value;
  if (value === null)
    return "null";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" || typeof value === "undefined" || typeof value === "symbol" || typeof value === "function")
    return String(value);
  try {
    const json = JSON.stringify(value, jsonReplacer);
    if (typeof json === "string")
      return unwrapJsonStringLiteral(json);
  } catch {}
  return inspect2(value, { colors: false });
}
function unwrapJsonStringLiteral(json) {
  if (json.startsWith('"') && json.endsWith('"'))
    return JSON.parse(json);
  return json;
}
function quoteLogfmtValue(value, isString) {
  let needsQuote = value === "" || isString && shouldQuoteStringLiteral(value);
  for (const char of value) {
    const code = char.codePointAt(0);
    if (shouldQuoteLogfmtValueChar(char, code)) {
      needsQuote = true;
      break;
    }
  }
  if (!needsQuote)
    return value;
  let quoted = "";
  for (const char of value) {
    const code = char.codePointAt(0);
    quoted += escapeLogfmtValueChar(char, code);
  }
  return `"${quoted}"`;
}
function shouldQuoteStringLiteral(value) {
  return value === "null" || value === "undefined" || value === "true" || value === "false";
}
function shouldQuoteLogfmtValueChar(char, code) {
  return code <= 32 || code === 127 || code === 65533 || char === "=" || char === '"' || char === "\\";
}
function escapeLogfmtValueChar(char, code) {
  switch (char) {
    case "\t":
      return "\\t";
    case `
`:
      return "\\n";
    case "\r":
      return "\\r";
    case '"':
      return "\\\"";
    case "\\":
      return "\\\\";
    default:
      return code <= 31 || code === 127 ? `\\u${code.toString(16).padStart(4, "0")}` : char;
  }
}
function formatLogfmtValue(value) {
  const stringified = stringifyLogfmtValue(value);
  return quoteLogfmtValue(stringified, typeof value === "string");
}
function pushLogfmtPair(pairs, key, value) {
  const filteredKey = filterLogfmtKey(key);
  if (filteredKey == null)
    return;
  pairs.push(`${filteredKey}=${formatLogfmtValue(value)}`);
}
function getLogfmtFormatter(options = {}) {
  const prependPrefix = "prepend:";
  const lineEnding = getLineEndingValue(options.lineEnding);
  const timestampRenderer = createTimestampFormatter("rfc3339", resolveTimeZone(options.timeZone));
  const isTemplateMessage = options.message === "template";
  const propertiesOption = options.properties ?? "flatten";
  let joinCategory;
  if (typeof options.categorySeparator === "function")
    joinCategory = options.categorySeparator;
  else {
    const separator = options.categorySeparator ?? ".";
    joinCategory = (category) => category.join(separator);
  }
  let propertyPrefix = "";
  if (propertiesOption === "flatten")
    propertyPrefix = "";
  else if (propertiesOption.startsWith(prependPrefix)) {
    propertyPrefix = propertiesOption.substring(prependPrefix.length);
    if (propertyPrefix === "")
      throw new TypeError("Invalid properties option: " + JSON.stringify(propertiesOption) + '. It must be of the form "prepend:<prefix>" where <prefix> is a non-empty string.');
  } else
    throw new TypeError(`Invalid properties option: ${JSON.stringify(propertiesOption)}. It must be "flatten" or "prepend:<prefix>".`);
  return (record) => {
    const pairs = [];
    pushLogfmtPair(pairs, "time", timestampRenderer(record.timestamp));
    pushLogfmtPair(pairs, "level", record.level);
    pushLogfmtPair(pairs, "logger", joinCategory(record.category));
    pushLogfmtPair(pairs, "msg", renderStructuredMessage(record, isTemplateMessage));
    for (const key in record.properties)
      if (Object.prototype.hasOwnProperty.call(record.properties, key))
        pushLogfmtPair(pairs, `${propertyPrefix}${key}`, record.properties[key]);
    return `${pairs.join(" ")}${lineEnding}`;
  };
}
var logfmtFormatter = getLogfmtFormatter();
var logLevelStyles = {
  trace: "background-color: gray; color: white;",
  debug: "background-color: gray; color: white;",
  info: "background-color: white; color: black;",
  warning: "background-color: orange; color: black;",
  error: "background-color: red; color: white;",
  fatal: "background-color: maroon; color: white;"
};
function defaultConsoleFormatter(record) {
  let msg = "";
  const values = [];
  for (let i = 0;i < record.message.length; i++)
    if (i % 2 === 0)
      msg += record.message[i];
    else {
      msg += "%o";
      values.push(record.message[i]);
    }
  const date = new Date(record.timestamp);
  const time = `${date.getUTCHours().toString().padStart(2, "0")}:${date.getUTCMinutes().toString().padStart(2, "0")}:${date.getUTCSeconds().toString().padStart(2, "0")}.${date.getUTCMilliseconds().toString().padStart(3, "0")}`;
  return [
    `%c${time} %c${levelAbbreviations[record.level]}%c %c${record.category.join("\xB7")} %c${msg}`,
    "color: gray;",
    logLevelStyles[record.level],
    "background-color: default;",
    "color: gray;",
    "color: default;",
    ...values
  ];
}

// node_modules/.bun/@logtape+logtape@2.3.1/node_modules/@logtape/logtape/dist/sink.js
var immediateSinkSymbol2 = Symbol.for("LogTape.sinkSnapshotPolicy.immediate");
function getConsoleSink(options = {}) {
  const formatter = options.formatter ?? defaultConsoleFormatter;
  const levelMap = {
    trace: "debug",
    debug: "debug",
    info: "info",
    warning: "warn",
    error: "error",
    fatal: "error",
    ...options.levelMap ?? {}
  };
  const console = options.console ?? globalThis.console;
  const baseSink = (record) => {
    const args = formatter(record);
    const method = levelMap[record.level];
    if (method === undefined)
      throw new TypeError(`Invalid log level: ${record.level}.`);
    if (typeof args === "string") {
      const msg = args.replace(/\r?\n$/, "");
      console[method](msg);
    } else
      console[method](...args);
  };
  if (!options.nonBlocking)
    return baseSink;
  const nonBlockingConfig = options.nonBlocking === true ? {} : options.nonBlocking;
  const bufferSize = nonBlockingConfig.bufferSize ?? 100;
  const flushInterval = nonBlockingConfig.flushInterval ?? 100;
  const buffer = [];
  let flushTimer = null;
  let scheduledFlushTimer = null;
  let disposed = false;
  let flushScheduled = false;
  const maxBufferSize = bufferSize * 2;
  function flush() {
    if (buffer.length === 0)
      return;
    const records = buffer.splice(0);
    for (const record of records)
      try {
        baseSink(record);
      } catch {}
  }
  function scheduleFlush() {
    if (flushScheduled)
      return;
    flushScheduled = true;
    scheduledFlushTimer = setTimeout(() => {
      scheduledFlushTimer = null;
      flushScheduled = false;
      flush();
    }, 0);
  }
  function startFlushTimer() {
    if (flushTimer !== null || disposed)
      return;
    flushTimer = setInterval(() => {
      flush();
    }, flushInterval);
  }
  const nonBlockingSink = (record) => {
    if (disposed)
      return;
    if (buffer.length >= maxBufferSize)
      buffer.shift();
    buffer.push(record);
    if (buffer.length >= bufferSize)
      scheduleFlush();
    else if (flushTimer === null)
      startFlushTimer();
  };
  nonBlockingSink[Symbol.dispose] = () => {
    disposed = true;
    if (flushTimer !== null) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    if (scheduledFlushTimer !== null) {
      clearTimeout(scheduledFlushTimer);
      scheduledFlushTimer = null;
      flushScheduled = false;
    }
    flush();
  };
  return nonBlockingSink;
}
var _asyncSinkError = Symbol.for("logtape.asyncSinkError");

// node_modules/.bun/@logtape+logtape@2.3.1/node_modules/@logtape/logtape/dist/config.js
var currentConfig = null;
var activeScopedConfigCount = 0;
var activeScopedConfigs = /* @__PURE__ */ new Set;
var globalConfigMutationInProgress = false;
var strongRefs = /* @__PURE__ */ new Set;
var filterDisposables = /* @__PURE__ */ new Set;
var sinkDisposables = /* @__PURE__ */ new Set;
var asyncFilterDisposables = /* @__PURE__ */ new Set;
var asyncSinkDisposables = /* @__PURE__ */ new Set;
var unregisterDisposeHook;
function isLoggerConfigMeta(cfg) {
  const category = Array.isArray(cfg.category) ? cfg.category : [cfg.category];
  return category.length === 0 || category.length === 1 && category[0] === "logtape" || category.length === 2 && category[0] === "logtape" && category[1] === "meta";
}
function registerDisposeHook(allowAsync) {
  unregisterDisposeHook?.();
  unregisterDisposeHook = undefined;
  const handler = allowAsync ? disposeInternal : disposeSyncInternal;
  if (typeof globalThis.EdgeRuntime !== "string" && "process" in globalThis && !("Deno" in globalThis)) {
    const proc = globalThis.process;
    const onMethod = proc?.["on"];
    if (typeof onMethod === "function") {
      onMethod.call(proc, "exit", handler);
      unregisterDisposeHook = () => {
        const offMethod = proc?.["off"] ?? proc?.["removeListener"];
        if (typeof offMethod === "function")
          offMethod.call(proc, "exit", handler);
      };
      return;
    }
  }
  const addEventListenerMethod = globalThis.addEventListener;
  if (typeof addEventListenerMethod !== "function")
    return;
  const removeEventListenerMethod = globalThis.removeEventListener;
  if ("Deno" in globalThis) {
    addEventListenerMethod.call(globalThis, "unload", handler);
    if (typeof removeEventListenerMethod === "function")
      unregisterDisposeHook = () => {
        removeEventListenerMethod.call(globalThis, "unload", handler);
      };
  } else {
    addEventListenerMethod.call(globalThis, "pagehide", handler);
    if (typeof removeEventListenerMethod === "function")
      unregisterDisposeHook = () => {
        removeEventListenerMethod.call(globalThis, "pagehide", handler);
      };
  }
}
function configureSync(config) {
  runGlobalConfigMutationSync("configureSync()", () => {
    if (currentConfig != null && !config.reset)
      throw new ConfigError("Already configured; if you want to reset, turn on the reset flag.");
    if (asyncFilterDisposables.size > 0 || asyncSinkDisposables.size > 0)
      throw new ConfigError("Previously configured async disposables are still active. Use configure() instead or explicitly dispose them using dispose().");
    disposeSyncInternal();
    resetInternal();
    try {
      configureInternal(config, false);
    } catch (e) {
      if (e instanceof ConfigError) {
        disposeSyncInternal();
        resetInternal();
      }
      throw e;
    }
  });
}
function withConfigSync(config, callback) {
  const contextLocalStorage = getConfiguredContextLocalStorage("withConfigSync()");
  const scopedConfig = compileScopedConfig(config, false, (message) => new ConfigError(message));
  let result;
  let callbackError;
  let callbackFailed = false;
  activeScopedConfigCount++;
  activeScopedConfigs.add(scopedConfig);
  try {
    result = runWithScopedConfig(contextLocalStorage, scopedConfig, callback);
    if (isThenable(result)) {
      Promise.resolve(result).catch(() => {});
      callbackFailed = true;
      callbackError = new ConfigError("withConfigSync() callback must not return a promise. Use withConfig() for async callbacks.");
    }
  } catch (error) {
    callbackFailed = true;
    callbackError = error;
  }
  try {
    disposeScopedConfigSync(scopedConfig, getRetainedDisposables(scopedConfig));
  } catch (disposeError) {
    if (callbackFailed)
      throwCombinedErrors(callbackError, disposeError);
    throw disposeError;
  } finally {
    activeScopedConfigs.delete(scopedConfig);
    activeScopedConfigCount--;
  }
  if (callbackFailed)
    throw callbackError;
  return result;
}
function isThenable(value) {
  return value != null && (typeof value === "object" || typeof value === "function") && "then" in value && typeof value.then === "function";
}
function getGlobalDisposables() {
  return new Set([
    ...filterDisposables,
    ...asyncFilterDisposables,
    ...sinkDisposables,
    ...asyncSinkDisposables
  ]);
}
function getRetainedDisposables(scopedConfig) {
  const disposables = new Set(getGlobalDisposables());
  for (const activeScopedConfig of activeScopedConfigs) {
    if (activeScopedConfig === scopedConfig || activeScopedConfig.disposed)
      continue;
    addScopedConfigDisposables(disposables, activeScopedConfig);
  }
  return disposables;
}
function addScopedConfigDisposables(disposables, scopedConfig) {
  for (const disposable of scopedConfig.syncFilters)
    disposables.add(disposable);
  for (const disposable of scopedConfig.asyncFilters)
    disposables.add(disposable);
  for (const disposable of scopedConfig.syncSinks)
    disposables.add(disposable);
  for (const disposable of scopedConfig.asyncSinks)
    disposables.add(disposable);
}
function configureInternal(config, allowAsync) {
  currentConfig = config;
  let metaConfigured = false;
  const configuredCategories = /* @__PURE__ */ new Set;
  for (const cfg of config.loggers) {
    if (isLoggerConfigMeta(cfg))
      metaConfigured = true;
    const categoryKey2 = Array.isArray(cfg.category) ? JSON.stringify(cfg.category) : JSON.stringify([cfg.category]);
    if (configuredCategories.has(categoryKey2))
      throw new ConfigError(`Duplicate logger configuration for category: ${categoryKey2}. Each category can only be configured once.`);
    configuredCategories.add(categoryKey2);
    const logger = LoggerImpl.getLogger(cfg.category);
    for (const sinkId of cfg.sinks ?? []) {
      const sink = config.sinks[sinkId];
      if (!sink)
        throw new ConfigError(`Sink not found: ${sinkId}.`);
      logger.sinks.push(sink);
    }
    logger.parentSinks = cfg.parentSinks ?? "inherit";
    if (cfg.lowestLevel !== undefined)
      logger.lowestLevel = cfg.lowestLevel;
    for (const filterId of cfg.filters ?? []) {
      const filter = config.filters?.[filterId];
      if (filter === undefined)
        throw new ConfigError(`Filter not found: ${filterId}.`);
      logger.filters.push(toFilter(filter));
    }
    strongRefs.add(logger);
  }
  LoggerImpl.getLogger().contextLocalStorage = config.contextLocalStorage;
  for (const sink of Object.values(config.sinks)) {
    if (Symbol.asyncDispose in sink)
      if (allowAsync)
        asyncSinkDisposables.add(sink);
      else
        throw new ConfigError("Async disposables cannot be used with configureSync().");
    if (Symbol.dispose in sink)
      sinkDisposables.add(sink);
  }
  for (const filter of Object.values(config.filters ?? {})) {
    if (filter == null || typeof filter === "string")
      continue;
    if (Symbol.asyncDispose in filter) {
      if (allowAsync)
        asyncFilterDisposables.add(filter);
      else
        throw new ConfigError("Async disposables cannot be used with configureSync().");
      asyncSinkDisposables.delete(filter);
    }
    if (Symbol.dispose in filter) {
      filterDisposables.add(filter);
      sinkDisposables.delete(filter);
    }
  }
  registerDisposeHook(allowAsync);
  const meta = LoggerImpl.getLogger(["logtape", "meta"]);
  if (!metaConfigured)
    meta.sinks.push(getConsoleSink());
  meta.info("LogTape loggers are configured.  Note that LogTape itself uses the meta logger, which has category {metaLoggerCategory}.  The meta logger is used to log internal diagnostics such as sink exceptions.  It's recommended to configure the meta logger with a separate sink so that you can easily notice if logging itself fails or is misconfigured.  To turn off this message, configure the meta logger with higher log levels than {dismissLevel}.  See also <https://logtape.org/manual/categories#meta-logger>.", {
    metaLoggerCategory: ["logtape", "meta"],
    dismissLevel: "info"
  });
}
function getConfig() {
  return currentConfig;
}
function resetInternal() {
  unregisterDisposeHook?.();
  unregisterDisposeHook = undefined;
  const rootLogger = LoggerImpl.getLogger([]);
  rootLogger.resetDescendants();
  delete rootLogger.contextLocalStorage;
  strongRefs.clear();
  currentConfig = null;
}
async function disposeInternal() {
  const errors = [];
  try {
    disposeSyncFilters();
  } catch (error) {
    errors.push(error);
  }
  try {
    await disposeAsyncFilters();
  } catch (error) {
    errors.push(error);
  }
  try {
    disposeSyncSinks();
  } catch (error) {
    errors.push(error);
  }
  try {
    await disposeAsyncSinks();
  } catch (error) {
    errors.push(error);
  }
  throwDisposeErrors2(errors);
}
function disposeSyncInternal() {
  const errors = [];
  try {
    disposeSyncFilters();
  } catch (error) {
    errors.push(error);
  }
  try {
    disposeSyncSinks();
  } catch (error) {
    errors.push(error);
  }
  throwDisposeErrors2(errors);
}
function getConfiguredContextLocalStorage(functionName) {
  if (globalConfigMutationInProgress)
    throw new ConfigError(`${functionName} cannot be called while LogTape is being reconfigured.`);
  if (currentConfig == null)
    throw new ConfigError(`${functionName} requires LogTape to be configured first.`);
  const contextLocalStorage = LoggerImpl.getLogger().contextLocalStorage;
  if (contextLocalStorage == null)
    throw new ConfigError(`${functionName} requires Config.contextLocalStorage to be configured.`);
  return contextLocalStorage;
}
function runGlobalConfigMutationSync(functionName, callback) {
  assertCanMutateGlobalConfig(functionName);
  globalConfigMutationInProgress = true;
  try {
    return callback();
  } finally {
    globalConfigMutationInProgress = false;
  }
}
function assertCanMutateGlobalConfig(functionName) {
  if (globalConfigMutationInProgress)
    throw new ConfigError(`${functionName} cannot be called while LogTape is being reconfigured.`);
  assertNoScopedConfig(functionName);
}
function assertNoScopedConfig(functionName) {
  if (activeScopedConfigCount > 0)
    throw new ConfigError(`${functionName} cannot be called while a scoped configuration is active. Use nested withConfig() instead.`);
}
function disposeSyncFilters() {
  disposeSyncDisposables2(filterDisposables);
}
function disposeSyncSinks() {
  disposeSyncDisposables2(sinkDisposables);
}
function disposeSyncDisposables2(disposables) {
  const errors = [];
  try {
    for (const disposable of disposables)
      try {
        disposable[Symbol.dispose]();
      } catch (error) {
        errors.push(error);
      } finally {
        disposables.delete(disposable);
      }
  } finally {
    disposables.clear();
  }
  throwDisposeErrors2(errors);
}
async function disposeAsyncFilters() {
  await disposeAsyncDisposables(asyncFilterDisposables);
}
async function disposeAsyncSinks() {
  await disposeAsyncDisposables(asyncSinkDisposables);
}
async function disposeAsyncDisposables(disposables) {
  const promises = [];
  try {
    for (const disposable of disposables)
      try {
        promises.push(Promise.resolve(disposable[Symbol.asyncDispose]()));
      } catch (error) {
        promises.push(Promise.reject(error));
      } finally {
        disposables.delete(disposable);
      }
  } finally {
    disposables.clear();
  }
  await settleDisposePromises(promises);
}
async function settleDisposePromises(promises) {
  const results = await Promise.allSettled(promises);
  throwDisposeErrors2(results.filter((result) => result.status === "rejected").map((result) => result.reason));
}
function throwDisposeErrors2(errors) {
  if (errors.length < 1)
    return;
  if (errors.length === 1)
    throw errors[0];
  throw new AggregateError(errors, "Multiple errors occurred while disposing LogTape resources.");
}
var ConfigError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
};

// node_modules/.bun/@logtape+redaction@2.3.1+455acf1e86969edf/node_modules/@logtape/redaction/dist/traversal.js
var redactionTruncatedValue = "[truncated]";
var defaultMaxDepth = 20;
var defaultMaxProperties = 1000;
function createRedactionTraversalContext(options, reportLimitExceeded, visited = /* @__PURE__ */ new Map) {
  const limits = {
    maxDepth: normalizeLimit(options.maxDepth, defaultMaxDepth),
    maxProperties: normalizeLimit(options.maxProperties, defaultMaxProperties)
  };
  const exceededLimits = /* @__PURE__ */ new Set;
  return {
    limits,
    visited,
    exceededLimits,
    reportLimitExceeded(limit) {
      exceededLimits.add(limit);
      reportLimitExceeded(limit, limits);
    }
  };
}
function normalizeLimit(value, defaultValue) {
  if (value == null)
    return defaultValue;
  if (!Number.isFinite(value) || value < 0)
    return defaultValue;
  return Math.floor(value);
}

// node_modules/.bun/@logtape+redaction@2.3.1+455acf1e86969edf/node_modules/@logtape/redaction/dist/field.js
var metaLogger2 = getLogger(["logtape", "meta"]);
var reportingRedactionLimit = false;
var DEFAULT_REDACT_FIELDS = [
  /pass(?:code|phrase|word)/i,
  /secret/i,
  /token/i,
  /key/i,
  /credential/i,
  /auth/i,
  /signature/i,
  /sensitive/i,
  /private/i,
  /ssn/i,
  /email/i,
  /phone/i,
  /address/i
];
function redactByField(sink, options = DEFAULT_REDACT_FIELDS) {
  const opts = Array.isArray(options) ? { fieldPatterns: options } : options;
  const wrapped = (record) => {
    const context = createFieldRedactionContext(opts);
    const redactedProperties = redactProperties(record.properties, opts, context.visited, 0, context);
    let redactedMessage = record.message;
    if (typeof record.rawMessage === "string") {
      const placeholders = extractPlaceholderNames(record.rawMessage);
      const { redactedIndices, wildcardIndices } = getRedactedPlaceholderIndices(placeholders, opts.fieldPatterns);
      redactedMessage = redactMessageArray(record.message, placeholders, redactedIndices, wildcardIndices, redactedProperties, opts.action, context.exceededLimits.size > 0);
    } else {
      const redactedValues = getRedactedValues(record.properties, redactedProperties);
      if (redactedValues.size > 0 || context.exceededLimits.size > 0)
        redactedMessage = redactMessageByValues(record.message, redactedValues, context.exceededLimits.size > 0);
    }
    sink({
      ...record,
      message: redactedMessage,
      properties: redactedProperties
    });
  };
  if (Symbol.dispose in sink)
    wrapped[Symbol.dispose] = sink[Symbol.dispose];
  if (Symbol.asyncDispose in sink)
    wrapped[Symbol.asyncDispose] = sink[Symbol.asyncDispose];
  return wrapped;
}
function reportRedactionLimitExceeded(limit, limits) {
  if (reportingRedactionLimit || typeof metaLogger2.warn !== "function")
    return;
  try {
    reportingRedactionLimit = true;
    metaLogger2.warn("Redaction traversal exceeded {limit}; replacing or omitting remaining data to keep logging bounded.", {
      limit,
      ...limits
    });
  } catch {} finally {
    reportingRedactionLimit = false;
  }
}
function createFieldRedactionContext(options, visited = /* @__PURE__ */ new Map) {
  return createRedactionTraversalContext(options, reportRedactionLimitExceeded, visited);
}
function reportLimitOnce(context, limit) {
  if (context.exceededLimits.has(limit))
    return;
  context.reportLimitExceeded(limit);
}
function redactProperties(properties, options, visited = /* @__PURE__ */ new Map, depth = 0, context = createFieldRedactionContext(options, visited)) {
  if (visited.has(properties))
    return visited.get(properties);
  const copy = {};
  visited.set(properties, copy);
  const fields = Object.keys(properties);
  if (fields.length > context.limits.maxProperties)
    reportLimitOnce(context, "maxProperties");
  for (const field of fields.slice(0, context.limits.maxProperties)) {
    if (shouldFieldRedacted(field, options.fieldPatterns)) {
      if (typeof options.action === "function")
        setProperty(copy, field, options.action(properties[field]));
      continue;
    }
    const value = properties[field];
    if (Array.isArray(value))
      if (depth + 1 > context.limits.maxDepth) {
        reportLimitOnce(context, "maxDepth");
        setProperty(copy, field, redactionTruncatedValue);
      } else
        setProperty(copy, field, redactArray(value, options, visited, depth + 1, context));
    else if (typeof value === "object" && value !== null)
      if (isBuiltInObject(value))
        setProperty(copy, field, value);
      else if (depth + 1 > context.limits.maxDepth) {
        reportLimitOnce(context, "maxDepth");
        setProperty(copy, field, redactionTruncatedValue);
      } else
        setProperty(copy, field, redactProperties(value, options, visited, depth + 1, context));
    else
      setProperty(copy, field, value);
  }
  return copy;
}
function setProperty(object, field, value) {
  if (field === "__proto__")
    Object.defineProperty(object, field, {
      value,
      enumerable: true,
      configurable: true,
      writable: true
    });
  else
    object[field] = value;
}
function redactArray(array, options, visited, depth, context) {
  if (visited.has(array))
    return visited.get(array);
  const copy = [];
  const length = Math.min(array.length, context.limits.maxProperties);
  copy.length = length;
  visited.set(array, copy);
  if (array.length > context.limits.maxProperties)
    reportLimitOnce(context, "maxProperties");
  for (let i = 0;i < length; i++) {
    if (!(i in array))
      continue;
    const item = array[i];
    if (Array.isArray(item))
      if (depth + 1 > context.limits.maxDepth) {
        reportLimitOnce(context, "maxDepth");
        copy[i] = redactionTruncatedValue;
      } else
        copy[i] = redactArray(item, options, visited, depth + 1, context);
    else if (typeof item === "object" && item !== null)
      if (isBuiltInObject(item))
        copy[i] = item;
      else if (depth + 1 > context.limits.maxDepth) {
        reportLimitOnce(context, "maxDepth");
        copy[i] = redactionTruncatedValue;
      } else
        copy[i] = redactProperties(item, options, visited, depth + 1, context);
    else
      copy[i] = item;
  }
  return copy;
}
function isBuiltInObject(value) {
  return value instanceof Error || value instanceof Date || value instanceof RegExp || value instanceof Map || value instanceof Set || value instanceof WeakMap || value instanceof WeakSet || value instanceof Promise || value instanceof ArrayBuffer || typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer || ArrayBuffer.isView(value);
}
function shouldFieldRedacted(field, fieldPatterns) {
  for (const fieldPattern of fieldPatterns)
    if (typeof fieldPattern === "string") {
      if (fieldPattern === field)
        return true;
    } else {
      const matched = testFieldPattern(field, fieldPattern);
      if (matched)
        return true;
    }
  return false;
}
function testFieldPattern(field, fieldPattern) {
  if (!fieldPattern.global && !fieldPattern.sticky)
    return fieldPattern.test(field);
  const descriptor = Object.getOwnPropertyDescriptor(fieldPattern, "lastIndex");
  if (descriptor?.writable === false)
    return new RegExp(fieldPattern).test(field);
  return RegExp.prototype[Symbol.search].call(fieldPattern, field) !== -1;
}
function extractPlaceholderNames(template) {
  const placeholders = [];
  for (let i = 0;i < template.length; i++)
    if (template[i] === "{") {
      if (i + 1 < template.length && template[i + 1] === "{") {
        i++;
        continue;
      }
      const closeIndex = template.indexOf("}", i + 1);
      if (closeIndex === -1)
        continue;
      const key = template.slice(i + 1, closeIndex).trim();
      placeholders.push(key);
      i = closeIndex;
    }
  return placeholders;
}
function parsePathSegments(path) {
  const segments = [];
  let current = "";
  let inBracket = false;
  let quotedBracketSegment = false;
  let quote;
  let escaped = false;
  const pushCurrent = (trim = false) => {
    const segment = trim ? current.trimEnd() : current;
    if (segment)
      segments.push(segment);
    current = "";
  };
  for (const char of path) {
    if (quote != null) {
      if (escaped) {
        current += char;
        escaped = false;
      } else if (char === "\\")
        escaped = true;
      else if (char === quote)
        quote = undefined;
      else
        current += char;
      continue;
    }
    if (inBracket && current === "" && /\s/.test(char))
      continue;
    if (inBracket && (char === '"' || char === "'") && current === "") {
      quote = char;
      quotedBracketSegment = true;
      continue;
    }
    if (inBracket && quotedBracketSegment && /\s/.test(char))
      continue;
    if (char === "." && !inBracket) {
      pushCurrent();
      continue;
    }
    if (char === "[") {
      pushCurrent();
      inBracket = true;
      continue;
    }
    if (char === "]") {
      pushCurrent(!quotedBracketSegment);
      inBracket = false;
      quotedBracketSegment = false;
      continue;
    }
    if (char === "?")
      continue;
    current += char;
  }
  pushCurrent();
  return segments;
}
function getRedactedPlaceholderIndices(placeholders, fieldPatterns) {
  const redactedIndices = /* @__PURE__ */ new Set;
  const wildcardIndices = /* @__PURE__ */ new Set;
  for (let i = 0;i < placeholders.length; i++) {
    const placeholder = placeholders[i];
    if (placeholder === "*") {
      wildcardIndices.add(i);
      continue;
    }
    if (shouldFieldRedacted(placeholder, fieldPatterns)) {
      redactedIndices.add(i);
      continue;
    }
    const segments = parsePathSegments(placeholder);
    for (const segment of segments)
      if (shouldFieldRedacted(segment, fieldPatterns)) {
        redactedIndices.add(i);
        break;
      }
  }
  return {
    redactedIndices,
    wildcardIndices
  };
}
function redactMessageArray(message, placeholders, redactedIndices, wildcardIndices, redactedProperties, action, truncateUnmappedValues = false) {
  const result = [];
  let placeholderIndex = 0;
  for (let i = 0;i < message.length; i++)
    if (i % 2 === 0)
      result.push(message[i]);
    else {
      if (wildcardIndices.has(placeholderIndex))
        result.push(redactedProperties);
      else if (redactedIndices.has(placeholderIndex))
        if (action == null || action === "delete")
          result.push("");
        else
          result.push(action(message[i]));
      else {
        const placeholderName = placeholders[placeholderIndex];
        const redactedValue = getPathValue(redactedProperties, placeholderName);
        if (redactedValue.found)
          result.push(redactedValue.value);
        else if (truncateUnmappedValues)
          result.push(redactionTruncatedValue);
        else
          result.push(message[i]);
      }
      placeholderIndex++;
    }
  return result;
}
function getPathValue(properties, path) {
  const segments = parsePathSegments(path);
  if (segments.length < 1)
    return { found: false };
  let value = properties;
  for (const segment of segments) {
    if (typeof value !== "object" && typeof value !== "function" || value == null || !Object.hasOwn(value, segment))
      return { found: false };
    value = value[segment];
  }
  return {
    found: true,
    value
  };
}
function collectRedactedValues(original, redacted, map) {
  for (const key of Object.keys(redacted)) {
    const origVal = original[key];
    const redVal = redacted[key];
    if (origVal !== redVal)
      map.set(origVal, redVal);
    if (typeof origVal === "object" && origVal !== null && typeof redVal === "object" && redVal !== null && !Array.isArray(origVal))
      collectRedactedValues(origVal, redVal, map);
  }
}
function getRedactedValues(original, redacted) {
  const map = /* @__PURE__ */ new Map;
  collectRedactedValues(original, redacted, map);
  return map;
}
function redactMessageByValues(message, redactedValues, truncateUnmappedValues = false) {
  if (redactedValues.size === 0 && !truncateUnmappedValues)
    return message;
  const result = [];
  for (let i = 0;i < message.length; i++)
    if (i % 2 === 0)
      result.push(message[i]);
    else {
      const val = message[i];
      if (redactedValues.has(val))
        result.push(redactedValues.get(val));
      else if (truncateUnmappedValues)
        result.push(redactionTruncatedValue);
      else
        result.push(val);
    }
  return result;
}
// packages/recovery-observability/src/logtape-diagnostic-adapter.ts
var RECOVERY_LOG_CATEGORY = ["my-second-brain-playground", "recovery"];
var DIAGNOSTIC_BUFFER_LIMIT = 250;
var sensitiveFieldPatterns = [
  /api[-_]?key/i,
  /authorization/i,
  /cookie/i,
  /credential/i,
  /passcode|passphrase|password/i,
  /private[-_]?key/i,
  /secret/i,
  /token/i
];
function diagnosticRecord(input) {
  return {
    category: RECOVERY_LOG_CATEGORY,
    level: input.level,
    message: [input.event],
    rawMessage: input.event,
    timestamp: input.timestamp ?? Date.now(),
    properties: { ...projectDiagnosticProperties(input.properties ?? {}) }
  };
}
function severity(level) {
  return diagnosticLevels.indexOf(level);
}
function createRecoveryDiagnosticAdapter(options) {
  const mode = options.mode ?? "default";
  const secrets = options.knownSecretValues ?? [];
  let disposed = false;
  let triggered = false;
  let dropped = 0;
  let buffer = [];
  let lifecycleResult = { accepted: false, refusal: "storage-unavailable" };
  const rawDiagnosticSink = (record) => {
    try {
      const diagnostic = {
        schema_version: 1,
        record_type: "diagnostic",
        category: record.category.join("/"),
        level: record.level,
        event: record.rawMessage,
        occurred_at: new Date(record.timestamp).toISOString(),
        properties: record.properties
      };
      if (!validateDiagnosticTraceRecord(diagnostic, { knownSecretValues: secrets }))
        return;
      options.writeDiagnostic(`${JSON.stringify(diagnostic)}
`);
    } catch {}
  };
  const diagnosticSink = redactByField(rawDiagnosticSink, {
    fieldPatterns: sensitiveFieldPatterns,
    action: () => "[REDACTED]"
  });
  const rawLifecycleSink = (record) => {
    try {
      lifecycleResult = options.retainLifecycle(record.properties.lifecycle_record);
    } catch {
      lifecycleResult = { accepted: false, refusal: "storage-unavailable" };
    }
  };
  const lifecycleSink = redactByField(rawLifecycleSink, {
    fieldPatterns: sensitiveFieldPatterns,
    action: () => "[REDACTED]"
  });
  function emit(record) {
    if (disposed)
      return;
    try {
      diagnosticSink(record);
    } catch {}
  }
  function truncationRecord(timestamp) {
    return diagnosticRecord({ level: "warning", event: "buffer-truncated", timestamp, properties: { dropped_records: dropped } });
  }
  function emitBuffer(timestamp = Date.now()) {
    if (dropped > 0)
      emit(truncationRecord(timestamp));
    for (const record of buffer)
      emit(record);
    buffer = [];
    dropped = 0;
  }
  const bufferingSink = (record) => {
    if (mode === "quiet")
      return;
    if (mode === "debug" || mode === "verbose" && severity(record.level) >= severity("info") || triggered) {
      emit(record);
      return;
    }
    if (severity(record.level) >= severity("error")) {
      triggered = true;
      emitBuffer(record.timestamp);
      emit(record);
      return;
    }
    buffer.push(record);
    if (buffer.length > DIAGNOSTIC_BUFFER_LIMIT) {
      buffer.shift();
      dropped += 1;
    }
  };
  function logDiagnostic(record) {
    try {
      if (getConfig() === null) {
        configureSync({
          sinks: {},
          loggers: [{ category: ["logtape", "meta"], lowestLevel: null }],
          contextLocalStorage: new AsyncLocalStorage
        });
      }
      withConfigSync({
        sinks: { recovery: bufferingSink },
        loggers: [{ category: [...RECOVERY_LOG_CATEGORY], sinks: ["recovery"], lowestLevel: "trace", parentSinks: "override" }]
      }, () => getLogger(RECOVERY_LOG_CATEGORY).emit(record));
    } catch {}
  }
  return {
    accept(input) {
      if (disposed)
        return { accepted: false, refusal: "storage-unavailable" };
      const validated = validateLifecycleRecord(input, { knownSecretValues: secrets });
      if (!validated.accepted)
        return validated;
      try {
        lifecycleResult = { accepted: false, refusal: "storage-unavailable" };
        lifecycleSink({
          category: RECOVERY_LOG_CATEGORY,
          level: validated.record.outcome === "failed" ? "error" : "info",
          message: [validated.record.phase],
          rawMessage: validated.record.phase,
          timestamp: Date.parse(validated.record.occurred_at),
          properties: { lifecycle_record: validated.record }
        });
        return lifecycleResult;
      } catch {
        return { accepted: false, refusal: "storage-unavailable" };
      }
    },
    diagnostic(input) {
      if (disposed || !diagnosticEvents.includes(input.event) || !diagnosticLevels.includes(input.level))
        return;
      logDiagnostic(diagnosticRecord(input));
    },
    flush() {
      if (disposed)
        return;
      emitBuffer();
    },
    dispose() {
      if (disposed)
        return;
      disposed = true;
      buffer = [];
      dropped = 0;
      try {
        options.disposeOutput?.();
      } catch {}
    }
  };
}

// packages/recovery-observability/src/interface.ts
function openRecoveryObservability(options) {
  const store = createInvocationTraceStore({
    invocationIdentity: options.invocationIdentity,
    stateHome: options.stateHome,
    knownSecretValues: options.knownSecretValues
  });
  const adapter = createRecoveryDiagnosticAdapter({
    mode: options.mode,
    knownSecretValues: options.knownSecretValues,
    writeDiagnostic: (line) => {
      store.writeDiagnostic(line);
    },
    retainLifecycle: (record) => store.accept(record),
    disposeOutput: () => store.dispose()
  });
  return {
    get tracePath() {
      return store.path;
    },
    accept: (record) => adapter.accept(record),
    diagnostic: (record) => adapter.diagnostic(record),
    cleanup: () => cleanupTraces({ stateHome: options.stateHome }),
    dispose: () => adapter.dispose()
  };
}
function viewRecoveryTraces(options = {}) {
  return queryTraces(options);
}
function cleanupRecoveryTraces(options = {}) {
  return cleanupTraces(options);
}

// packages/recovery-observability/src/trace-command.ts
var usage = `Usage:
  recovery-traces view [--journey ID] [--invocation ID] [--worker ID] [--task ID] [--state-home PATH]
  recovery-traces cleanup [--state-home PATH]
  recovery-traces identity
`;
var VIEW_FILTERS = new Map([
  ["--journey", "journey_identity"],
  ["--invocation", "invocation_identity"],
  ["--worker", "observed_worker_identity"],
  ["--task", "ledger_task_identity"]
]);
function parse(args) {
  const command = args[0];
  if (command !== "view" && command !== "cleanup" && command !== "identity")
    return null;
  const filter = {};
  let stateHome;
  for (let index = 1;index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key || !value || value.startsWith("--"))
      return null;
    if (key === "--state-home") {
      stateHome = value;
      continue;
    }
    const filterKey = VIEW_FILTERS.get(key);
    if (command !== "view" || filterKey === undefined)
      return null;
    filter[filterKey] = value;
  }
  return { command, stateHome, filter };
}
function pluginRoot() {
  const sourceRoot = resolve2(import.meta.dir, "../../..");
  return resolve2(sourceRoot, "packages/recovery-observability/src") === import.meta.dir ? sourceRoot : resolve2(import.meta.dir, "..");
}
function sha256(path) {
  return createHash("sha256").update(readFileSync2(path)).digest("hex");
}
function writeIdentityFailure() {
  process.stdout.write(`${JSON.stringify({ schema_version: 1, command: "identity", ok: false, error: "identity-unavailable", next_action: "Restore the plugin package metadata, recovery sources, and observer runtime, then retry identity." })}
`);
  return 1;
}
function runIdentityCommand(args) {
  if (args.length !== 1) {
    process.stderr.write(usage);
    return 64;
  }
  try {
    const root = pluginRoot();
    const plugin = JSON.parse(readFileSync2(resolve2(root, "package.json"), "utf8"));
    if (typeof plugin !== "object" || plugin === null || !("version" in plugin) || !isPluginVersion(plugin.version)) {
      throw new Error("invalid-plugin-metadata");
    }
    process.stdout.write(`${JSON.stringify({
      schema_version: 1,
      command: "identity",
      ok: true,
      plugin_version: plugin.version,
      recovery_source_sha256: sha256(resolve2(root, "packages/compaction-recovery/src/recovery.py")),
      observer_source_sha256: sha256(resolve2(root, "packages/recovery-observability/src/recovery-observer.ts")),
      runtime_sha256: sha256(resolve2(root, "runtime/recovery-observer.js"))
    })}
`);
    return 0;
  } catch {
    return writeIdentityFailure();
  }
}
function recordCleanupObservation(observer, invocation, journey, parent, started, sequence, outcome) {
  try {
    observer?.accept({
      schema_version: 1,
      record_type: "lifecycle",
      record_identity: `${invocation}-${sequence}`,
      journey_identity: journey,
      invocation_identity: invocation,
      producer_identity: invocation,
      producer_sequence: sequence,
      parent_record_identity: parent,
      harness_kind: "command",
      operation: "cleanup",
      phase: "cleanup",
      occurred_at: new Date().toISOString(),
      duration_ms: Number(process.hrtime.bigint() - started) / 1e6,
      outcome
    });
  } catch {}
}
function createCleanupObserver(parsed, invocation) {
  const journey = process.env.MSB_RECOVERY_CLEANUP_JOURNEY;
  const parent = process.env.MSB_RECOVERY_CLEANUP_PARENT;
  if (parsed.command !== "cleanup" || !isRecoveryIdentity(journey) || !isRecoveryIdentity(parent)) {
    return { observer: undefined, journey, parent };
  }
  return {
    observer: openRecoveryObservability({ invocationIdentity: invocation, stateHome: parsed.stateHome }),
    journey,
    parent
  };
}
function runTraceAction(parsed) {
  const invocation = `cleanup-${randomUUID2()}`;
  const lifecycle = createCleanupObserver(parsed, invocation);
  const started = process.hrtime.bigint();
  recordCleanupObservation(lifecycle.observer, invocation, lifecycle.journey, lifecycle.parent, started, 0, "started");
  const result = parsed.command === "view" ? viewRecoveryTraces({ stateHome: parsed.stateHome, filter: parsed.filter }) : cleanupRecoveryTraces({ stateHome: parsed.stateHome });
  recordCleanupObservation(lifecycle.observer, invocation, lifecycle.journey, lifecycle.parent, started, 1, result.available ? "succeeded" : "unavailable");
  lifecycle.observer?.dispose();
  process.stdout.write(`${JSON.stringify({ schema_version: 1, command: parsed.command, ok: true, ...result })}
`);
  return 0;
}
async function runTraceCommand(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h" || args[0] === "help")) {
    process.stdout.write(usage);
    return 0;
  }
  const parsed = parse(args);
  if (parsed === null) {
    process.stderr.write(usage);
    return 64;
  }
  if (parsed.command === "identity") {
    return runIdentityCommand(args);
  }
  return runTraceAction(parsed);
}
if (import.meta.main)
  process.exitCode = await runTraceCommand(process.argv.slice(2));
export {
  runTraceCommand
};
