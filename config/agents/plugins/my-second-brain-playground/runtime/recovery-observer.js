#!/usr/bin/env bun
// @bun

// packages/recovery-observability/src/recovery-observer.ts
import { randomUUID as randomUUID2 } from "crypto";
import { closeSync as closeSync2 } from "fs";
import { join as join2, resolve as resolve2 } from "path";

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
function configuredStateHome(explicit) {
  const value = explicit ?? process.env.XDG_STATE_HOME ?? (process.env.HOME ? join(process.env.HOME, ".local", "state") : "");
  return value && isAbsolute(value) ? resolve(value) : null;
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

// packages/recovery-observability/src/recovery-observer.ts
var MAX_OBSERVER_DEADLINE_MS = 60000;
var CHILD_REAP_GRACE_MS = 250;
function identity(prefix) {
  return `${prefix}-${randomUUID2()}`;
}
function optionalIdentity(value) {
  return isRecoveryIdentity(value) ? value : undefined;
}
function monotonicMilliseconds(start) {
  return Number(process.hrtime.bigint() - start) / 1e6;
}
function observerDeadlineMilliseconds(value) {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value))
    return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_OBSERVER_DEADLINE_MS ? parsed : null;
}
function observerRoot() {
  const sourceRoot = resolve2(import.meta.dir, "../../..");
  return join2(sourceRoot, "packages/recovery-observability/src") === import.meta.dir ? sourceRoot : resolve2(import.meta.dir, "..");
}
function observerOperation(arguments_) {
  const command = arguments_[1];
  if (command === undefined || command === "--help" || command === "-h")
    return "help";
  if (command === "bind" || command === "recover" || command === "write" || command === "schema")
    return command;
  return "usage";
}
function childOutcome(exitCode, signalCode) {
  if (signalCode !== null)
    return "signalled";
  return exitCode === 0 ? "succeeded" : "failed";
}
function retainObserverFailureDiagnostic(store) {
  try {
    const record = {
      schema_version: 1,
      record_type: "diagnostic",
      category: "my-second-brain-playground/recovery",
      level: "error",
      event: "observer-failure",
      occurred_at: new Date().toISOString(),
      properties: {}
    };
    store.writeDiagnostic(`${JSON.stringify(record)}
`);
  } catch {}
}
function scheduleCleanup(journeyIdentity, parentRecordIdentity) {
  try {
    const root = observerRoot();
    const cleanupCommand = import.meta.dir === join2(root, "packages/recovery-observability/src") ? join2(import.meta.dir, "trace-command.ts") : join2(root, "runtime/recovery-traces.js");
    const cleanup = Bun.spawn([process.execPath, cleanupCommand, "cleanup"], {
      cwd: process.cwd(),
      env: { ...process.env, MSB_RECOVERY_CLEANUP_JOURNEY: journeyIdentity, MSB_RECOVERY_CLEANUP_PARENT: parentRecordIdentity },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true
    });
    cleanup.unref();
  } catch {}
}
async function forward(stream, output, onFirstWrite) {
  for await (const chunk of stream) {
    onFirstWrite();
    try {
      output.write(chunk);
    } catch {}
  }
}
function consumeLifecycleSegment(state, segment, terminated, decoder, accept, reportFailure) {
  if (!state.discarding) {
    if (state.pendingBytes + segment.length > MAX_SERIALIZED_RECORD_BYTES) {
      state.discarding = true;
      state.pendingBytes = 0;
      reportFailure();
    } else {
      state.pending.set(segment, state.pendingBytes);
      state.pendingBytes += segment.length;
    }
  }
  if (!terminated || state.discarding)
    return;
  try {
    accept(JSON.parse(decoder.decode(state.pending.subarray(0, state.pendingBytes))));
  } catch {
    reportFailure();
  }
}
function consumeLifecycleChunk(chunk, state, decoder, accept, reportFailure) {
  let offset = 0;
  while (offset < chunk.length) {
    const newline = chunk.indexOf(10, offset);
    const end = newline < 0 ? chunk.length : newline;
    consumeLifecycleSegment(state, chunk.subarray(offset, end), newline >= 0, decoder, accept, reportFailure);
    if (newline < 0)
      return;
    state.pendingBytes = 0;
    state.discarding = false;
    offset = newline + 1;
  }
}
async function consumeLifecycle(fd, accept, reportFailure) {
  const decoder = new TextDecoder;
  const state = {
    pending: new Uint8Array(MAX_SERIALIZED_RECORD_BYTES),
    pendingBytes: 0,
    discarding: false
  };
  try {
    for await (const chunk of Bun.file(fd).stream()) {
      consumeLifecycleChunk(chunk, state, decoder, accept, reportFailure);
    }
    if (state.pendingBytes > 0 || state.discarding)
      reportFailure();
  } catch {
    reportFailure();
  }
}
async function closePrimaryResponseDescriptors() {
  await Promise.all([process.stdout, process.stderr].map((output) => new Promise((done) => {
    const close = () => {
      try {
        closeSync2(output.fd);
      } catch {}
      done();
    };
    try {
      output.end(close);
    } catch {
      close();
    }
  })));
}
async function runRecoveryObserver(arguments_, dependencies = {}) {
  if (arguments_[0] !== "checkpoint")
    return 2;
  const operation = observerOperation(arguments_);
  const started = process.hrtime.bigint();
  const invocationIdentity = identity("recovery-invocation");
  let journeyIdentity = invocationIdentity;
  const observerIdentity = identity("recovery-observer");
  const inheritedParentIdentity = optionalIdentity(process.env.CODEX_SESSION_ID);
  const traceStore = (dependencies.createTraceStore ?? createInvocationTraceStore)({ invocationIdentity });
  let diagnosticReported = false;
  const reportObserverFailure = () => {
    if (diagnosticReported)
      return;
    diagnosticReported = true;
    retainObserverFailureDiagnostic(traceStore);
  };
  let observerSequence = 0;
  let responseObserved = false;
  const acceptObserverRecord = (phase, outcome, parentRecordIdentity) => {
    const recordIdentity = `${observerIdentity}-${observerSequence}`;
    try {
      const result = traceStore.accept({
        schema_version: 1,
        record_type: "lifecycle",
        record_identity: recordIdentity,
        journey_identity: journeyIdentity,
        invocation_identity: invocationIdentity,
        producer_identity: observerIdentity,
        producer_sequence: observerSequence++,
        ...parentRecordIdentity === undefined ? {} : { parent_record_identity: parentRecordIdentity },
        ...inheritedParentIdentity === undefined ? {} : { inherited_parent_identity: inheritedParentIdentity },
        harness_kind: "unknown",
        operation,
        phase,
        occurred_at: new Date().toISOString(),
        duration_ms: monotonicMilliseconds(started),
        outcome
      });
      if (!result.accepted)
        reportObserverFailure();
    } catch {
      reportObserverFailure();
    }
    return recordIdentity;
  };
  const invocationRecordIdentity = acceptObserverRecord("invocation", "started");
  let child;
  try {
    child = Bun.spawn([
      "/usr/bin/python3",
      "-B",
      join2(observerRoot(), "packages/compaction-recovery/src/recovery.py"),
      "checkpoint",
      ...arguments_.slice(1)
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MSB_RECOVERY_OBSERVABILITY_FD: "3",
        MSB_RECOVERY_OBSERVATION_INVOCATION_IDENTITY: invocationIdentity,
        MSB_RECOVERY_OBSERVATION_JOURNEY_IDENTITY: journeyIdentity,
        MSB_RECOVERY_OBSERVATION_PARENT_RECORD_IDENTITY: invocationRecordIdentity
      },
      stdio: [process.stdin, "pipe", "pipe", "pipe"]
    });
  } catch {
    acceptObserverRecord("terminal", "failed", invocationRecordIdentity);
    reportObserverFailure();
    traceStore.dispose();
    return 2;
  }
  let terminalOutcome;
  let reapTimer;
  const stopChild = (signal, outcome) => {
    terminalOutcome ??= outcome;
    try {
      process.stdin.destroy();
    } catch {}
    try {
      child.kill(signal);
    } catch {}
    if (reapTimer === undefined) {
      reapTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, CHILD_REAP_GRACE_MS);
      reapTimer.unref();
    }
  };
  const deadlineMilliseconds = observerDeadlineMilliseconds(process.env.MSB_RECOVERY_OBSERVER_DEADLINE_MS);
  const deadlineTimer = deadlineMilliseconds === null ? undefined : setTimeout(() => stopChild("SIGTERM", "deadline-exceeded"), deadlineMilliseconds);
  deadlineTimer?.unref();
  const onSigterm = () => stopChild("SIGTERM", "signalled");
  const onSigint = () => stopChild("SIGINT", "signalled");
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  const observeFirstPrimaryWrite = () => {
    if (responseObserved)
      return;
    responseObserved = true;
    acceptObserverRecord("response-available", "succeeded", invocationRecordIdentity);
  };
  const lifecycle = consumeLifecycle(child.stdio[3], (record) => {
    const result = traceStore.accept(record);
    if (!result.accepted) {
      reportObserverFailure();
      return;
    }
    if (typeof record === "object" && record !== null && "journey_identity" in record) {
      const observed = optionalIdentity(typeof record.journey_identity === "string" ? record.journey_identity : undefined);
      if (observed !== undefined && observed !== invocationIdentity)
        journeyIdentity = observed;
    }
  }, reportObserverFailure);
  const stdout = forward(child.stdout, process.stdout, observeFirstPrimaryWrite);
  const stderr = forward(child.stderr, process.stderr, observeFirstPrimaryWrite);
  const exitCode = await child.exited;
  if (deadlineTimer !== undefined)
    clearTimeout(deadlineTimer);
  if (reapTimer !== undefined)
    clearTimeout(reapTimer);
  process.off("SIGTERM", onSigterm);
  process.off("SIGINT", onSigint);
  await Promise.all([stdout, stderr]);
  await closePrimaryResponseDescriptors();
  await lifecycle;
  if (exitCode !== 0 || terminalOutcome !== undefined)
    reportObserverFailure();
  acceptObserverRecord("terminal", terminalOutcome ?? childOutcome(exitCode, child.signalCode), invocationRecordIdentity);
  traceStore.dispose();
  scheduleCleanup(journeyIdentity, invocationRecordIdentity);
  return exitCode;
}
if (import.meta.main) {
  process.exitCode = await runRecoveryObserver(process.argv.slice(2));
}
export {
  runRecoveryObserver
};
