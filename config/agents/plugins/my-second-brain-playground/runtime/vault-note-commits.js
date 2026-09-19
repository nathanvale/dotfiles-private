// @bun
// packages/vault-steward/src/legacy/main.ts
import { isAbsolute as isAbsolute2, join as join4, resolve as resolve2 } from "path";

// packages/vault-steward/src/engine.ts
import { createHash, randomUUID } from "crypto";
import { isAbsolute, join as join2, normalize, relative, resolve, sep } from "path";

// packages/vault-steward/src/integration-lock.ts
import { existsSync, mkdirSync, renameSync, rmdirSync, rmSync } from "fs";
import { join } from "path";

// packages/vault-steward/src/model.ts
var schemaVersion = 1;
var manifestName = "vault-note-commit.json";
var runIdPattern = /^vnc-[a-f0-9]{32}$/;
var commitPattern = /^[a-f0-9]{40,64}$/;
var lockDirectoryName = "vault-note-commits.lock";
var invalidLockOwnerGraceMs = 1000;
var selfTestTimeoutMs = 2000;
var hookName = "reference-transaction";
var guardDeniedCode = "VAULT_GUARD_BRANCH_CREATE_DENIED";
var guardFailOpenCode = "VAULT_GUARD_FAIL_OPEN";

// packages/vault-steward/src/integration-lock.ts
var lockAttempts = 81;
var lockPauseMs = 25;
var reclaimMutexStaleMs = 1e4;
function pause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
function withinGrace(rt, modified) {
  return rt.now() - modified < invalidLockOwnerGraceMs;
}
function pidIsLive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && ("code" in error) && error.code === "ESRCH");
  }
}
function ownerIsLive(rt, lock) {
  const directory = rt.fileFacts(lock);
  if (directory.kind === "missing")
    return directory.errorCode !== "ENOENT";
  const ownerPath = join(lock, "owner.json");
  const owner = rt.fileFacts(ownerPath);
  if (owner.kind === "missing" && owner.errorCode !== "ENOENT")
    return true;
  const modified = Math.max(directory.mtimeMs, owner.mtimeMs);
  if (owner.kind === "missing")
    return withinGrace(rt, modified);
  let contents;
  try {
    contents = rt.readText(ownerPath);
  } catch {
    return true;
  }
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return withinGrace(rt, modified);
  }
  const pid = typeof parsed === "object" && parsed !== null && "pid" in parsed ? parsed.pid : undefined;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
    return withinGrace(rt, modified);
  return pidIsLive(pid);
}
function lockPath(commonGitDirectory) {
  return join(commonGitDirectory, lockDirectoryName);
}
function reclaimMutexPath(lock) {
  return `${lock}.reclaim`;
}
function underReclaimMutex(rt, lock, action) {
  const mutex = reclaimMutexPath(lock);
  try {
    mkdirSync(mutex, { mode: 448 });
  } catch (error) {
    if (!(error instanceof Error && ("code" in error) && error.code === "EEXIST"))
      throw error;
    const facts = rt.fileFacts(mutex);
    if (facts.kind === "directory" && rt.now() - facts.mtimeMs > reclaimMutexStaleMs) {
      try {
        rmdirSync(mutex);
      } catch {}
    }
    return "busy";
  }
  try {
    return action();
  } finally {
    try {
      rmdirSync(mutex);
    } catch {}
  }
}
function tryCreate(rt, lock) {
  try {
    mkdirSync(lock, { mode: 448 });
    return "created";
  } catch (error) {
    if (!(error instanceof Error && ("code" in error) && error.code === "EEXIST"))
      throw error;
  }
  if (!existsSync(lock) || ownerIsLive(rt, lock))
    return "busy";
  rt.faultPoint("lock-judged");
  return underReclaimMutex(rt, lock, () => {
    if (!existsSync(lock))
      return "reclaimed";
    if (ownerIsLive(rt, lock))
      return "busy";
    const reclaimed = `${lock}.reclaim-${rt.pid}-${rt.now()}`;
    try {
      renameSync(lock, reclaimed);
    } catch {
      return "busy";
    }
    rmSync(reclaimed, { recursive: true, force: true });
    return "reclaimed";
  });
}
function publishOwner(rt, lock, runId) {
  try {
    rt.writePrivateText(join(lock, "owner.json"), `${JSON.stringify({ schemaVersion, runId, pid: rt.pid })}
`);
  } catch (error) {
    releaseLock(lock);
    throw error;
  }
}
function acquireLock(rt, commonGitDirectory, runId) {
  const lock = lockPath(commonGitDirectory);
  for (let attempt = 0;attempt < lockAttempts; attempt++) {
    const outcome = tryCreate(rt, lock);
    if (outcome === "created") {
      publishOwner(rt, lock, runId);
      rt.faultPoint("lock-held");
      return lock;
    }
    if (outcome === "busy" && attempt < lockAttempts - 1)
      pause(lockPauseMs);
  }
  return null;
}
function releaseLock(lock) {
  rmSync(lock, { recursive: true, force: true });
}

// packages/vault-steward/src/engine.ts
class Refusal extends Error {
  reason;
  facts;
  transaction;
  constructor(reason, facts = {}, transaction = "unchanged") {
    super(reason);
    this.reason = reason;
    this.facts = facts;
    this.transaction = transaction;
  }
}
function refuse(reason, facts = {}, transaction = "unchanged") {
  throw new Refusal(reason, facts, transaction);
}
function git(rt, cwd, args, context) {
  const result = started(rt.spawn(["git", "--no-optional-locks", ...args], { cwd }));
  if (result.exitCode !== 0) {
    const { transaction, ...facts } = context;
    refuse("git-failed", { ...facts, detail: result.stderr.trim() }, transaction ?? (context.worktreeCreated ? "partially-completed" : "unchanged"));
  }
  return result.stdout.trim();
}
function gitQuiet(rt, cwd, args) {
  return started(rt.spawn(["git", "--no-optional-locks", ...args], { cwd }));
}
function started(result) {
  if (result.spawnError !== null)
    throw new Error(result.spawnError);
  return result;
}
function splitNul(value) {
  return value.split("\x00").filter(Boolean);
}
function samePaths(actual, admitted) {
  return actual.length === admitted.length && actual.every((path, index) => path === admitted[index]);
}
function overlappingPaths(left, right) {
  const rightSet = new Set(right);
  return left.filter((path) => rightSet.has(path));
}
function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}
function vaultIdentity(vault) {
  return sha256Hex(vault).slice(0, 16);
}
function completionRef(runId) {
  return `refs/vault-note-commits/${runId}`;
}
function newRunId() {
  return `vnc-${randomUUID().replaceAll("-", "")}`;
}
function stateRoot(rt) {
  const home = rt.env.HOME;
  const root = rt.env.XDG_STATE_HOME ?? (home ? join2(home, ".local", "state") : "");
  if (!root || !isAbsolute(root))
    refuse("state-home-missing");
  return join2(root, "my-second-brain", "vault-note-commits");
}
function receiptPath(rt, worktree) {
  return join2(stateRoot(rt), "receipts", `${sha256Hex(worktree)}.json`);
}
function configPath(rt) {
  const home = rt.env.HOME;
  const configRoot = rt.env.XDG_CONFIG_HOME ?? (home ? join2(home, ".config") : "");
  if (!configRoot || !isAbsolute(configRoot))
    refuse("config-home-invalid");
  return join2(configRoot, "my-second-brain-playground", "vault.json");
}
function configuredVaultFrom(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    return null;
  const record = payload;
  if (record.schemaVersion !== 1 || typeof record.vault !== "string" || !isAbsolute(record.vault))
    return null;
  if (Object.keys(payload).sort().join(",") !== "schemaVersion,vault")
    return null;
  return record.vault;
}
function configuredVault(rt) {
  const path = configPath(rt);
  let text;
  try {
    text = rt.readText(path);
  } catch {
    refuse("config-absent", { detail: path });
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    refuse("config-unparseable", { detail: path });
  }
  const vault = configuredVaultFrom(payload);
  if (vault === null)
    refuse("config-off-schema", { detail: path });
  return vault;
}
function fencePath(vault, input) {
  if (!input || isAbsolute(input))
    refuse("path-form-invalid");
  const path = relative(vault, resolve(vault, input));
  if (!path || path === ".." || path.startsWith(`..${sep}`))
    refuse("path-escapes-vault");
  return path;
}
function admittedPath(rt, vault, input) {
  const path = fencePath(vault, input);
  let cursor = vault;
  for (const component of path.split(sep)) {
    cursor = join2(cursor, component);
    if (rt.fileFacts(cursor).kind === "symlink")
      refuse("path-symlink-component");
  }
  return path;
}
function admittedPaths(rt, vault, requested) {
  return [...new Set(requested.map((path) => admittedPath(rt, vault, path)))].sort();
}
function validPathList(paths) {
  return Array.isArray(paths) && paths.length > 0 && paths.every((entry) => typeof entry === "string" && entry && !isAbsolute(entry) && !entry.split(sep).includes("..")) && samePaths(paths, [...new Set(paths)].sort());
}
function validateReceiptShape(receipt) {
  const keys = Object.keys(receipt).sort().join(",");
  const expectedKeys = ["schemaVersion", "runId", "vault", "worktree", "commonGitDirectory", "baseCommit", "paths", "code", ...receipt.code === "INTEGRATED" ? ["commit"] : []].sort().join(",");
  if (keys !== expectedKeys || receipt.schemaVersion !== 1 || typeof receipt.runId !== "string" || !runIdPattern.test(receipt.runId) || typeof receipt.worktree !== "string" || typeof receipt.vault !== "string" || !isAbsolute(receipt.vault) || typeof receipt.commonGitDirectory !== "string" || !isAbsolute(receipt.commonGitDirectory) || typeof receipt.baseCommit !== "string" || !commitPattern.test(receipt.baseCommit) || !validPathList(receipt.paths) || receipt.code !== "INTEGRATED" && receipt.code !== "NO_CHANGES") {
    throw new Error("Invalid receipt");
  }
}
function manifestShapeValid(manifest, worktree) {
  return manifest.schemaVersion === schemaVersion && runIdPattern.test(manifest.runId) && manifest.worktree === worktree && validPathList(manifest.paths) && manifest.paths.every((path) => normalize(path) === path && !path.endsWith(sep));
}
function whitespaceFindings(stdout) {
  return stdout.split(`
`).filter((line) => /^.+:\d+: (trailing whitespace|new blank line at EOF|space before tab in indent)\.$/.test(line));
}
function canonicalVault(rt, input) {
  let vault;
  try {
    vault = rt.realpath(input);
  } catch {
    refuse("vault-not-found");
  }
  const context = { runId: null };
  const top = git(rt, vault, ["rev-parse", "--show-toplevel"], context);
  if (rt.realpath(top) !== vault || git(rt, vault, ["branch", "--show-current"], context) !== "main") {
    refuse("not-canonical-main");
  }
  return vault;
}
function planCandidate(rt, vault, requested) {
  const paths = admittedPaths(rt, vault, requested);
  const runId = newRunId();
  const vaultId = vaultIdentity(vault);
  const root = stateRoot(rt);
  return { vault, vaultId, runId, stateRoot: root, requestedWorktree: join2(root, vaultId, runId), paths };
}
function createCandidate(rt, plan) {
  const context = { runId: plan.runId };
  rt.makeDirectory(join2(plan.stateRoot, plan.vaultId), 448);
  rt.chmod(plan.stateRoot, 448);
  rt.chmod(join2(plan.stateRoot, plan.vaultId), 448);
  const baseCommit = git(rt, plan.vault, ["rev-parse", "main"], context);
  git(rt, plan.vault, ["worktree", "add", "--detach", plan.requestedWorktree, baseCommit], context);
  context.worktreeCreated = true;
  context.worktree = plan.requestedWorktree;
  context.completedEffects = ["candidate.worktree"];
  try {
    const worktree = rt.realpath(plan.requestedWorktree);
    context.worktree = worktree;
    const manifest = {
      schemaVersion,
      runId: plan.runId,
      vault: plan.vault,
      worktree,
      commonGitDirectory: git(rt, worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"], context),
      baseCommit,
      paths: plan.paths
    };
    rt.writePrivateText(manifestPath(rt, worktree, context), `${JSON.stringify(manifest)}
`);
    return { manifest };
  } catch (error) {
    if (error instanceof Refusal)
      throw error;
    refuse("unexpected", { runId: plan.runId, worktree: context.worktree, worktreeCreated: true, completedEffects: ["candidate.worktree"], uncertainEffects: ["candidate.manifest"], detail: error instanceof Error ? error.message : String(error) }, "unknown");
  }
}
function manifestPath(rt, worktree, context) {
  return join2(git(rt, worktree, ["rev-parse", "--absolute-git-dir"], context), manifestName);
}
function validateReceiptStorage(rt, path) {
  const file = rt.fileFacts(path);
  const directory = rt.fileFacts(join2(path, ".."));
  if (file.kind !== "file" || file.mode !== 384 || directory.kind !== "directory" || directory.mode !== 448)
    throw new Error("Unsafe receipt");
}
function validateReceiptIdentity(rt, receipt, worktree) {
  if (worktree !== join2(rt.realpath(stateRoot(rt)), vaultIdentity(receipt.vault), receipt.runId))
    throw new Error("Mismatched receipt identity");
  const common = rt.spawn(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: receipt.vault });
  if (common.exitCode !== 0 || common.stdout.trim() !== receipt.commonGitDirectory)
    throw new Error("Changed vault identity");
}
function validateReceiptGitEvidence(rt, receipt) {
  const evidenceCommit = receipt.code === "INTEGRATED" ? receipt.commit : receipt.baseCommit;
  if (typeof evidenceCommit !== "string" || !commitPattern.test(evidenceCommit))
    throw new Error("Invalid completion commit");
  const reference = rt.spawn(["git", "rev-parse", "--verify", completionRef(receipt.runId)], { cwd: receipt.vault });
  if (reference.exitCode !== 0 || reference.stdout.trim() !== evidenceCommit)
    throw new Error("Mismatched completion reference");
  const ancestry = rt.spawn(["git", "merge-base", "--is-ancestor", evidenceCommit, "main"], { cwd: receipt.vault });
  if (ancestry.exitCode !== 0)
    throw new Error("Completion absent from main");
  if (receipt.code === "INTEGRATED") {
    const paths = rt.spawn(["git", "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", evidenceCommit], { cwd: receipt.vault });
    if (paths.exitCode !== 0 || !samePaths(splitNul(paths.stdout).sort(), receipt.paths))
      throw new Error("Completion paths differ");
  }
}
function readReceipt(rt, worktree) {
  const path = receiptPath(rt, worktree);
  if (!rt.exists(path))
    return;
  try {
    validateReceiptStorage(rt, path);
    const receipt = JSON.parse(rt.readText(path));
    validateReceiptShape(receipt);
    if (receipt.worktree !== worktree)
      throw new Error("Mismatched receipt worktree");
    validateReceiptIdentity(rt, receipt, worktree);
    validateReceiptGitEvidence(rt, receipt);
    return { receipt, path };
  } catch {
    refuse("receipt-invalid", { receipt: path, worktree });
  }
}
function readManifest(rt, input) {
  let worktree;
  try {
    worktree = rt.realpath(input);
  } catch {
    refuse("candidate-not-found");
  }
  let manifest;
  try {
    manifest = JSON.parse(rt.readText(manifestPath(rt, worktree, { runId: null })));
  } catch (error) {
    if (error instanceof Refusal)
      throw error;
    refuse("manifest-invalid", { runId: null, worktree });
  }
  if (!manifestShapeValid(manifest, worktree) || git(rt, worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { runId: manifest.runId }) !== manifest.commonGitDirectory) {
    refuse("manifest-invalid", { runId: manifest.runId ?? null, worktree });
  }
  return manifest;
}
function candidateFacts(manifest, commit) {
  return { runId: manifest.runId, worktree: manifest.worktree, paths: manifest.paths, ...commit ? { commit } : {} };
}
function context(manifest) {
  return { runId: manifest.runId, worktree: manifest.worktree };
}
function changedPaths(rt, manifest) {
  const tracked = splitNul(git(rt, manifest.worktree, ["diff", "--name-only", "-z", manifest.baseCommit, "--"], context(manifest)));
  const untracked = splitNul(git(rt, manifest.worktree, ["ls-files", "--others", "--exclude-standard", "-z"], context(manifest)));
  return [...new Set([...tracked, ...untracked])].sort();
}
function canonicalRoot(rt, manifest) {
  try {
    return rt.realpath(manifest.vault);
  } catch {
    return manifest.vault;
  }
}
function runChecker(rt, manifest, afterRebase) {
  const result = started(rt.spawn([rt.execPath, "run", "check"], {
    cwd: manifest.worktree,
    env: { ...rt.env, GIT_TERMINAL_PROMPT: "0", VAULT_CANONICAL_ROOT: canonicalRoot(rt, manifest) }
  }));
  if (result.exitCode !== 0) {
    const diagnosticsPath = join2(stateRoot(rt), "diagnostics", `${manifest.runId}.json`);
    rt.atomicPrivateJson(diagnosticsPath, { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
    refuse(afterRebase ? "rebased-check-failed" : "check-failed", { ...candidateFacts(manifest), diagnosticsPath, afterRebase });
  }
}
function checkWhitespace(rt, manifest, range, facts) {
  const result = started(rt.spawn(["git", "-c", "core.whitespace=blank-at-eol,blank-at-eof,space-before-tab", "diff", "--check", ...range, "--", ...manifest.paths], { cwd: manifest.worktree }));
  if (result.exitCode !== 0)
    refuse("format-failed", { ...facts, diagnostics: whitespaceFindings(result.stdout) });
}
function mainContains(rt, manifest, commit) {
  const vault = canonicalRoot(rt, manifest);
  const ancestry = gitQuiet(rt, vault, ["merge-base", "--is-ancestor", commit, "refs/heads/main"]);
  if (ancestry.exitCode !== 0)
    return false;
  const paths = gitQuiet(rt, vault, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", commit]);
  return paths.exitCode === 0 && samePaths(splitNul(paths.stdout).sort(), manifest.paths);
}
function candidateProducedHead(rt, manifest) {
  const subject = gitQuiet(rt, manifest.worktree, ["reflog", "show", "-1", "--format=%gs", "HEAD"]).stdout.trim();
  if (/^rebase \(pick\)/.test(subject))
    return true;
  if (!/^commit\b/.test(subject))
    return false;
  const parent = gitQuiet(rt, manifest.worktree, ["rev-parse", "HEAD^"]);
  const count = gitQuiet(rt, manifest.worktree, ["rev-list", "--count", `${manifest.baseCommit}..HEAD`]);
  return parent.exitCode === 0 && parent.stdout.trim() === manifest.baseCommit && count.exitCode === 0 && count.stdout.trim() === "1";
}
function validateCommittedCandidate(rt, manifest, head) {
  if (git(rt, manifest.worktree, ["status", "--porcelain"], context(manifest)))
    refuse("candidate-changed-after-commit", candidateFacts(manifest, head));
  if (candidateProducedHead(rt, manifest) && mainContains(rt, manifest, head))
    return { kind: "already-on-main", commit: head };
  const count = git(rt, manifest.worktree, ["rev-list", "--count", `${manifest.baseCommit}..HEAD`], context(manifest));
  const committed = splitNul(git(rt, manifest.worktree, ["diff", "--name-only", "-z", `${manifest.baseCommit}..HEAD`, "--"], context(manifest))).sort();
  if (count !== "1" || !samePaths(committed, manifest.paths))
    refuse("candidate-history-invalid", candidateFacts(manifest, head));
  runChecker(rt, manifest, false);
  if (git(rt, manifest.worktree, ["status", "--porcelain"], context(manifest)))
    refuse("check-changed-candidate", candidateFacts(manifest, head));
  checkWhitespace(rt, manifest, [manifest.baseCommit, "HEAD"], candidateFacts(manifest));
  return { kind: "commit", commit: head };
}
function validateCandidate(rt, manifest, message) {
  const head = git(rt, manifest.worktree, ["rev-parse", "HEAD"], context(manifest));
  if (head !== manifest.baseCommit)
    return validateCommittedCandidate(rt, manifest, head);
  const changed = changedPaths(rt, manifest);
  if (changed.length === 0)
    return { kind: "no-changes" };
  if (!samePaths(changed, manifest.paths))
    refuse("path-set-mismatch", candidateFacts(manifest));
  runChecker(rt, manifest, false);
  if (!samePaths(changedPaths(rt, manifest), manifest.paths))
    refuse("path-set-changed-by-checker", candidateFacts(manifest));
  git(rt, manifest.worktree, ["add", "--", ...manifest.paths], context(manifest));
  checkWhitespace(rt, manifest, ["--cached", manifest.baseCommit], candidateFacts(manifest));
  try {
    git(rt, manifest.worktree, ["commit", "-m", message], { ...context(manifest), transaction: "unknown", uncertainEffects: ["candidate.commit"] });
  } catch (error) {
    if (error instanceof Refusal)
      throw error;
    refuse("unexpected", { ...candidateFacts(manifest), uncertainEffects: ["candidate.commit"], detail: error instanceof Error ? error.message : String(error) }, "unknown");
  }
  return { kind: "commit", commit: git(rt, manifest.worktree, ["rev-parse", "HEAD"], context(manifest)) };
}
function recordCompletion(rt, manifest, commit, completedBefore = []) {
  const code = commit ? "INTEGRATED" : "NO_CHANGES";
  const receipt = receiptPath(rt, manifest.worktree);
  const completed = [...completedBefore];
  try {
    git(rt, manifest.vault, ["update-ref", completionRef(manifest.runId), commit ?? manifest.baseCommit], context(manifest));
    completed.push("completion.ref");
    rt.faultPoint("before-receipt");
    rt.atomicPrivateJson(receipt, { ...manifest, code, ...commit ? { commit } : {} });
  } catch {
    refuse("completion-record-failed", { ...candidateFacts(manifest, commit), afterFastForward: commit !== undefined, completedEffects: completed }, completed.length > 0 ? "partially-completed" : "unchanged");
  }
  const removed = gitQuiet(rt, manifest.vault, ["worktree", "remove", manifest.worktree]);
  return { code, commit, receipt, removed: removed.exitCode === 0 };
}
function withLock(rt, manifest, action) {
  const lock = acquireLock(rt, manifest.commonGitDirectory, manifest.runId);
  if (lock === null)
    refuse("integration-busy", candidateFacts(manifest));
  let result;
  try {
    result = action();
  } catch (error) {
    try {
      releaseLock(lock);
    } catch {}
    throw error;
  }
  releaseLock(lock);
  return result;
}
function observeMainAt(rt, manifest, commit, vault, currentMain) {
  if (currentMain === manifest.baseCommit || commit === undefined)
    return { observedMain: currentMain, rebase: false };
  const ancestry = gitQuiet(rt, vault, ["merge-base", "--is-ancestor", manifest.baseCommit, currentMain]);
  if (ancestry.exitCode !== 0)
    refuse("main-diverged", candidateFacts(manifest, commit));
  const mainChanges = splitNul(git(rt, vault, ["diff", "--name-only", "-z", manifest.baseCommit, currentMain, "--"], context(manifest))).sort();
  const overlap = overlappingPaths(mainChanges, manifest.paths);
  if (overlap.length > 0)
    refuse("semantic-overlap", { ...candidateFacts(manifest, commit), overlap });
  return { observedMain: currentMain, rebase: true };
}
function performRebase(rt, manifest, commit, currentMain) {
  const rebased = gitQuiet(rt, manifest.worktree, ["rebase", "--onto", currentMain, manifest.baseCommit, commit]);
  if (rebased.exitCode !== 0) {
    gitQuiet(rt, manifest.worktree, ["rebase", "--abort"]);
    refuse("rebase-failed", candidateFacts(manifest, commit));
  }
  const integrated = git(rt, manifest.worktree, ["rev-parse", "HEAD"], context(manifest));
  try {
    const rebasedPaths = splitNul(git(rt, manifest.worktree, ["diff", "--name-only", "-z", `${integrated}^`, integrated, "--"], context(manifest))).sort();
    if (!samePaths(rebasedPaths, manifest.paths))
      refuse("rebased-path-set-mismatch", { ...candidateFacts(manifest, integrated), afterRebase: true });
    runChecker(rt, manifest, true);
    checkWhitespace(rt, manifest, [`${integrated}^`, integrated], { ...candidateFacts(manifest, integrated), afterRebase: true });
  } catch (error) {
    gitQuiet(rt, manifest.worktree, ["checkout", "--detach", commit]);
    throw error;
  }
  return integrated;
}
function fastForward(rt, manifest, vault, original, integrated) {
  rt.faultPoint("before-ff-merge");
  const merged = gitQuiet(rt, vault, ["merge", "--ff-only", integrated]);
  rt.faultPoint("after-ff-merge");
  const readBack = { ...context(manifest), transaction: "unknown", uncertainEffects: ["main.fast-forward"] };
  const observed = git(rt, vault, ["rev-parse", "HEAD"], readBack);
  if (merged.exitCode === 0 && observed === integrated)
    return;
  if (merged.exitCode !== 0 && gitQuiet(rt, vault, ["merge-base", "--is-ancestor", integrated, "main"]).exitCode !== 0) {
    if (integrated !== original)
      gitQuiet(rt, manifest.worktree, ["checkout", "--detach", original]);
    refuse("integration-unproved", candidateFacts(manifest, original), "unchanged");
  }
  refuse("integration-unproved", { ...candidateFacts(manifest, integrated), uncertainEffects: ["main.fast-forward"] }, "unknown");
}
function canonicalReady(rt, manifest, commit) {
  const vault = rt.realpath(manifest.vault);
  if (git(rt, vault, ["branch", "--show-current"], context(manifest)) !== "main" || git(rt, vault, ["status", "--porcelain"], context(manifest))) {
    refuse("canonical-not-ready", candidateFacts(manifest, commit));
  }
  return vault;
}
function integrate(rt, manifest, commit) {
  return withLock(rt, manifest, () => {
    const completed = readReceipt(rt, manifest.worktree);
    if (completed)
      return { kind: "receipt", receipt: completed };
    const vault = canonicalReady(rt, manifest, commit);
    const currentMain = git(rt, vault, ["rev-parse", "HEAD"], context(manifest));
    const observation = observeMainAt(rt, manifest, commit, vault, currentMain);
    const integrated = observation.rebase ? performRebase(rt, manifest, commit, currentMain) : commit;
    fastForward(rt, manifest, vault, commit, integrated);
    return { kind: "completion", completion: recordCompletion(rt, manifest, integrated, ["main.fast-forward"]) };
  });
}
function completeWithoutIntegration(rt, manifest, commit) {
  return withLock(rt, manifest, () => {
    const completed = readReceipt(rt, manifest.worktree);
    if (completed)
      return { kind: "receipt", receipt: completed };
    return { kind: "completion", completion: recordCompletion(rt, manifest, commit) };
  });
}

// packages/vault-steward/src/guard.ts
import { join as join3, sep as sep2 } from "path";
var zeroSha = "0".repeat(40);
var hookSourceRelative = join3("scripts", "git-hooks", hookName);
function spawnFailure(outcome) {
  if (outcome.spawnError !== null)
    return `spawn failed: ${outcome.spawnError}`;
  if (outcome.timedOut)
    return `timed out after ${selfTestTimeoutMs} ms`;
  return null;
}
function classifyAllowRun(outcome, refs) {
  const failure = spawnFailure(outcome);
  if (failure !== null)
    return { selfTest: "error", detail: failure };
  if (outcome.exitCode === 0)
    return { selfTest: "continue" };
  if (outcome.exitCode === 1) {
    const denied = refs.find((ref) => outcome.stderr.includes(`${guardDeniedCode} ${ref}`));
    if (denied !== undefined)
      return { selfTest: "incompatible", ref: denied };
  }
  return { selfTest: "error", detail: `unexpected exit ${outcome.exitCode}` };
}
function classifyProbeRun(outcome, probeRef) {
  const failure = spawnFailure(outcome);
  if (failure !== null)
    return { selfTest: "error", detail: failure };
  if (outcome.exitCode === 1 && outcome.stderr.includes(`${guardDeniedCode} ${probeRef}`))
    return { selfTest: "pass" };
  if (outcome.exitCode === 0) {
    const failOpen = outcome.stderr.split(`
`).find((line) => line.startsWith(guardFailOpenCode));
    return { selfTest: "probe-allowed", detail: `${probeRef} was not denied (exit 0)${failOpen ? `; ${failOpen}` : ""}` };
  }
  return { selfTest: "error", detail: `unexpected exit ${outcome.exitCode}` };
}
function sprawlBranches(refNames) {
  return refNames.filter((name) => name && name !== "refs/heads/main");
}
function foreignWorktrees(paths, vault, candidateRoot) {
  return paths.filter((path) => path !== vault && !path.startsWith(`${candidateRoot}${sep2}`));
}
function hookEnvironment(env) {
  const copy = { ...env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"])
    delete copy[key];
  copy.GIT_TERMINAL_PROMPT = "0";
  return copy;
}
function runHook(rt, hookPath, vault, lines) {
  return rt.spawn([hookPath, "prepared"], { cwd: vault, env: hookEnvironment(rt.env), stdin: `${lines.join(`
`)}
`, timeoutMs: selfTestTimeoutMs });
}
function locateHook(rt, vault) {
  const warnings = [];
  const override = gitQuiet(rt, vault, ["config", "--get", "core.hooksPath"]);
  const hooksPathOverride = override.exitCode === 0 && override.stdout.trim() ? override.stdout.trim() : null;
  if (hooksPathOverride !== null)
    warnings.push({ code: "HOOKS_PATH_OVERRIDE", detail: `core.hooksPath=${hooksPathOverride}` });
  const hooksDirectory = gitQuiet(rt, vault, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]).stdout.trim();
  const hookPath = join3(hooksDirectory, hookName);
  const facts = rt.fileFacts(hookPath);
  const installed = facts.kind === "file";
  const executable = installed && (facts.mode & 73) !== 0;
  if (!installed)
    warnings.push({ code: "GUARD_MISSING", detail: `${hookPath} ${facts.kind === "missing" ? "is absent" : "is not a regular file"}` });
  else if (!executable)
    warnings.push({ code: "GUARD_MISSING", detail: `${hookPath} is not executable` });
  let current = null;
  const source = join3(vault, hookSourceRelative);
  if (installed && rt.fileFacts(source).kind === "file") {
    const installedHash = rt.sha256File(hookPath);
    const sourceHash = rt.sha256File(source);
    current = installedHash === sourceHash;
    if (!current)
      warnings.push({ code: "GUARD_STALE", detail: `installed ${installedHash.slice(0, 12)} differs from scripts/git-hooks/${hookName} ${sourceHash.slice(0, 12)}` });
  }
  return { hookPath, installed, executable, current, hooksPathOverride, warnings };
}
function selfTest(rt, location, input, warnings) {
  if (!location.installed || !location.executable)
    return { selfTest: "missing", deniedRef: null };
  const main = gitQuiet(rt, input.vault, ["rev-parse", "refs/heads/main"]);
  if (main.exitCode !== 0)
    return { selfTest: "skipped", deniedRef: null };
  const mainSha = main.stdout.trim();
  const candidate = input.candidateCommit ?? mainSha;
  const completionRef2 = `refs/vault-note-commits/${input.runId}`;
  const probeRef = `refs/heads/probe-${input.runId}`;
  const allow = classifyAllowRun(runHook(rt, location.hookPath, input.vault, [`${zeroSha} ${candidate} ${completionRef2}`, `${mainSha} ${candidate} refs/heads/main`]), [completionRef2, "refs/heads/main"]);
  if (allow.selfTest === "incompatible")
    return { selfTest: "incompatible", deniedRef: allow.ref };
  if (allow.selfTest === "error") {
    warnings.push({ code: "GUARD_SELFTEST_ERROR", detail: allow.detail });
    return { selfTest: "error", deniedRef: null };
  }
  const probe = classifyProbeRun(runHook(rt, location.hookPath, input.vault, [`${zeroSha} ${candidate} ${probeRef}`]), probeRef);
  if (probe.selfTest === "probe-allowed")
    warnings.push({ code: "GUARD_PROBE_ALLOWED", detail: probe.detail });
  if (probe.selfTest === "error")
    warnings.push({ code: "GUARD_SELFTEST_ERROR", detail: probe.detail });
  return { selfTest: probe.selfTest, deniedRef: null };
}
function observeSprawl(rt, input, warnings) {
  const refs = gitQuiet(rt, input.vault, ["for-each-ref", "--format=%(refname)", "refs/heads"]);
  const branches = sprawlBranches(refs.stdout.split(`
`).map((line) => line.trim()));
  if (branches.length > 0)
    warnings.push({ code: "BRANCH_SPRAWL_PRESENT", detail: branches.join(", ") });
  const list = gitQuiet(rt, input.vault, ["worktree", "list", "--porcelain"]);
  const paths = list.stdout.split(`
`).filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length)).map((path) => {
    try {
      return rt.realpath(path);
    } catch {
      return path;
    }
  });
  const worktrees = foreignWorktrees(paths, input.vault, input.candidateRoot);
  if (worktrees.length > 0)
    warnings.push({ code: "FOREIGN_WORKTREE_PRESENT", detail: worktrees.join(", ") });
  return { branches, worktrees };
}
function observeGuard(rt, input, enforce = true) {
  const location = locateHook(rt, input.vault);
  const warnings = [...location.warnings];
  const tested = selfTest(rt, location, input, warnings);
  const sprawl = observeSprawl(rt, input, warnings);
  const guard = {
    installed: location.installed,
    executable: location.executable,
    hookPath: location.hookPath,
    current: location.current,
    selfTest: tested.selfTest,
    hooksPathOverride: location.hooksPathOverride,
    branches: sprawl.branches,
    worktrees: sprawl.worktrees
  };
  const observation = { guard, warnings };
  if (enforce && tested.deniedRef !== null)
    refuse("guard-incompatible", { ...input.facts, ref: tested.deniedRef, runId: input.runId, guard: observation });
  return observation;
}

// packages/vault-steward/src/faults.ts
import { existsSync as existsSync2 } from "fs";
function parseFaults(value) {
  if (value === undefined || value === "")
    return [];
  const faults = [];
  for (const part of value.split(";")) {
    const spawn = /^(git-failure|unexpected)(?:#([1-9][0-9]*))?=(.+)$/.exec(part);
    const halt = /^halt=([a-z-]+)$/.exec(part);
    const pause2 = /^pause=([a-z-]+):([1-9][0-9]*)$/.exec(part);
    const barrier = /^barrier=([a-z-]+):(.+)$/.exec(part);
    if (spawn?.[1] !== undefined && spawn[3] !== undefined)
      faults.push({ kind: spawn[1], occurrence: Number(spawn[2] ?? "1"), fragment: spawn[3] });
    else if (halt?.[1] !== undefined)
      faults.push({ kind: "halt", point: halt[1] });
    else if (pause2?.[1] !== undefined && pause2[2] !== undefined)
      faults.push({ kind: "pause", point: pause2[1], milliseconds: Number(pause2[2]) });
    else if (barrier?.[1] !== undefined && barrier[2] !== undefined)
      faults.push({ kind: "barrier", point: barrier[1], path: barrier[2] });
    else
      return null;
  }
  return faults;
}
function pause2(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
function waitForPath(path) {
  while (!existsSync2(path))
    pause2(10);
}
function withFaults(rt, faults) {
  if (faults.length === 0)
    return rt;
  const seen = new Map;
  const spawnFaults = faults.filter((fault) => fault.kind === "git-failure" || fault.kind === "unexpected");
  const firing = (argv) => spawnFaults.find((fault) => {
    if (!argv.includes(fault.fragment))
      return false;
    const key = `${fault.kind}:${fault.fragment}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count === fault.occurrence;
  });
  return {
    ...rt,
    spawn(command, options) {
      const fault = command[0] === "git" ? firing(command.slice(1).join(" ")) : undefined;
      if (fault === undefined)
        return rt.spawn(command, options);
      if (fault.kind === "unexpected")
        throw new Error(`injected unexpected failure at ${fault.fragment}`);
      return { exitCode: 128, timedOut: false, spawnError: null, stdout: "", stderr: `fatal: injected git failure at ${fault.fragment}` };
    },
    faultPoint(name) {
      for (const fault of faults) {
        if (fault.kind === "halt" && fault.point === name)
          process.kill(process.pid, "SIGKILL");
        if (fault.kind === "pause" && fault.point === name)
          pause2(fault.milliseconds);
        if (fault.kind === "barrier" && fault.point === name)
          waitForPath(fault.path);
      }
      rt.faultPoint(name);
    }
  };
}

// packages/vault-steward/src/runtime.ts
import { createHash as createHash2, randomUUID as randomUUID2 } from "crypto";
import {
  chmodSync,
  closeSync,
  existsSync as existsSync3,
  fsyncSync,
  lstatSync,
  mkdirSync as mkdirSync2,
  openSync,
  readFileSync,
  realpathSync,
  renameSync as renameSync2,
  rmSync as rmSync2,
  writeFileSync
} from "fs";
import { dirname } from "path";
function decode(bytes) {
  return bytes ? new TextDecoder().decode(bytes) : "";
}
function createRuntime() {
  return {
    env: process.env,
    execPath: process.execPath,
    pid: process.pid,
    now: () => Date.now(),
    spawn(command, options) {
      try {
        const child = Bun.spawnSync(command, {
          cwd: options.cwd,
          stdout: "pipe",
          stderr: "pipe",
          ...options.stdin === undefined ? {} : { stdin: new TextEncoder().encode(options.stdin) },
          env: options.env ?? { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          ...options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs, killSignal: "SIGKILL" }
        });
        const timedOut = "exitedDueToTimeout" in child && child.exitedDueToTimeout === true;
        return {
          exitCode: timedOut ? null : child.exitCode,
          timedOut,
          spawnError: null,
          stdout: decode(child.stdout),
          stderr: decode(child.stderr)
        };
      } catch (error) {
        return { exitCode: null, timedOut: false, spawnError: error instanceof Error ? error.message : String(error), stdout: "", stderr: "" };
      }
    },
    realpath: (path) => realpathSync(path),
    exists: (path) => existsSync3(path),
    fileFacts(path) {
      try {
        const facts = lstatSync(path);
        const kind = facts.isSymbolicLink() ? "symlink" : facts.isFile() ? "file" : facts.isDirectory() ? "directory" : "other";
        return { kind, mode: facts.mode & 511, mtimeMs: facts.mtimeMs, errorCode: null };
      } catch (error) {
        const errorCode = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "UNKNOWN";
        return { kind: "missing", mode: 0, mtimeMs: 0, errorCode };
      }
    },
    readText: (path) => readFileSync(path, "utf8"),
    sha256File: (path) => createHash2("sha256").update(readFileSync(path)).digest("hex"),
    writePrivateText(path, text) {
      writeFileSync(path, text, { mode: 384 });
      chmodSync(path, 384);
    },
    privateDirectory(path) {
      mkdirSync2(path, { recursive: true, mode: 448 });
      if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory())
        throw new Error("Unsafe state directory");
      chmodSync(path, 448);
    },
    atomicPrivateJson(path, payload) {
      this.privateDirectory(dirname(path));
      const temporary = `${path}.${randomUUID2()}.tmp`;
      const descriptor = openSync(temporary, "wx", 384);
      try {
        writeFileSync(descriptor, `${JSON.stringify(payload)}
`);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync2(temporary, path);
      const directory = openSync(dirname(path), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    },
    makeDirectory: (path, mode) => mkdirSync2(path, { recursive: true, mode }),
    chmod: (path, mode) => chmodSync(path, mode),
    removeTree: (path) => rmSync2(path, { recursive: true, force: true }),
    faultPoint: () => {}
  };
}

// packages/vault-steward/src/legacy/main.ts
var schemaVersion2 = 1;

class LegacyRefusal extends Error {
  result;
  constructor(result) {
    super(result.code);
    this.result = result;
  }
}
function outcome(ok, command, code, runId, nextAction, extra = {}) {
  return { schemaVersion: schemaVersion2, ok, command, code, runId, changedState: "none", sideEffects: [], retrySafe: true, nextAction, ...extra };
}
function refuse2(command, code, runId, nextAction, extra = {}) {
  throw new LegacyRefusal(outcome(false, command, code, runId, nextAction, extra));
}
function flags(args, allowed, command) {
  const parsed = new Map;
  for (let index = 0;index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || !allowed.has(key) || value.startsWith("--")) {
      refuse2(command, "INVALID_USAGE", null, "Run vault-note-commits --help and use the documented flags.");
    }
    parsed.set(key, [...parsed.get(key) ?? [], value]);
  }
  return parsed;
}
function one(parsed, key, command) {
  const values = parsed.get(key) ?? [];
  const value = values[0];
  if (values.length !== 1 || value === undefined) {
    refuse2(command, "INVALID_USAGE", null, `Provide ${key} exactly once.`);
  }
  return value;
}
function preserved(facts, retrySafe, commit) {
  return {
    changedState: "partial",
    sideEffects: [commit ? "candidate-commit-preserved" : "candidate-worktree-preserved"],
    retrySafe,
    worktree: facts.worktree,
    commit,
    paths: facts.paths
  };
}
function beginCreated(facts) {
  return facts.worktreeCreated ? { changedState: "partial", sideEffects: ["candidate-worktree-created"], worktree: facts.worktree } : {};
}
var guardRepair = "Repair the installed reference-transaction hook with 'bun run guard:install' in the vault, then rerun finish with the same worktree.";
var guardRepairBegin = "Repair the installed reference-transaction hook with 'bun run guard:install' in the vault, then retry begin.";
var beginRefusal = (code, nextAction) => () => outcome(false, "begin", code, null, nextAction);
var finishPreserved = (code, nextAction, retrySafe, withCommit = true) => (facts) => outcome(false, "finish", code, facts.runId ?? null, nextAction, preserved(facts, retrySafe, withCommit ? facts.commit : undefined));
var legacyRender = {
  "config-home-invalid": beginRefusal("CONFIG_HOME_INVALID", "Set XDG_CONFIG_HOME to an absolute path or set HOME, then retry begin."),
  "config-absent": (facts) => outcome(false, "begin", "CONFIG_MISSING", null, `Create ${facts.detail} with the playground vault path, then retry begin.`),
  "config-unparseable": (facts) => outcome(false, "begin", "CONFIG_MISSING", null, `Create ${facts.detail} with the playground vault path, then retry begin.`),
  "config-off-schema": (facts) => outcome(false, "begin", "CONFIG_INVALID", null, `Repair ${facts.detail} to contain only schemaVersion 1 and one absolute vault path.`),
  "vault-not-found": beginRefusal("VAULT_NOT_FOUND", "Provide an existing vault checkout with --vault."),
  "not-canonical-main": beginRefusal("NOT_CANONICAL_MAIN", "Run begin from the root checkout while it has main checked out."),
  "path-form-invalid": beginRefusal("INVALID_PATH", "Use non-empty paths relative to the vault root."),
  "path-escapes-vault": beginRefusal("INVALID_PATH", "Keep every admitted path inside the vault."),
  "path-symlink-component": beginRefusal("SYMLINK_PATH_UNSUPPORTED", "Use a path whose existing components are not symbolic links."),
  "state-home-missing": (_facts, command) => outcome(false, command, "STATE_HOME_MISSING", null, "Set an absolute XDG_STATE_HOME or HOME, then retry."),
  "git-failed": (facts, command) => command === "begin" ? outcome(false, "begin", "GIT_FAILED", facts.runId ?? null, "Confirm the vault is a healthy local Git checkout, then retry begin.", beginCreated(facts)) : outcome(false, "finish", "GIT_FAILED", facts.runId ?? null, "Inspect the preserved candidate and local Git state before retrying finish.", {
    changedState: "partial",
    sideEffects: ["candidate-worktree-preserved"],
    retrySafe: false
  }),
  "candidate-not-found": () => outcome(false, "finish", "CANDIDATE_NOT_FOUND", null, "Run begin to create a new candidate."),
  "manifest-invalid": (facts) => outcome(false, "finish", "MANIFEST_INVALID", facts.runId ?? null, "Preserve the candidate and inspect its Git metadata before continuing.", {
    changedState: "partial",
    sideEffects: ["candidate-worktree-preserved"],
    retrySafe: false,
    worktree: facts.worktree
  }),
  "receipt-invalid": (facts) => outcome(false, "finish", "RECEIPT_INVALID", null, "Preserve the receipt and inspect its identity and local Git evidence before continuing.", {
    retrySafe: false,
    receipt: facts.receipt,
    worktree: facts.worktree
  }),
  "guard-incompatible": (facts, command) => command === "begin" ? outcome(false, "begin", "GUARD_INCOMPATIBLE", facts.runId ?? null, guardRepairBegin, { changedState: "none", sideEffects: [], retrySafe: true }) : outcome(false, "finish", "GUARD_INCOMPATIBLE", facts.runId ?? null, guardRepair, {
    changedState: "none",
    sideEffects: ["candidate-worktree-preserved"],
    retrySafe: true,
    worktree: facts.worktree,
    paths: facts.paths
  }),
  "candidate-changed-after-commit": finishPreserved("CANDIDATE_CHANGED_AFTER_COMMIT", "Inspect and restore the candidate to its committed state before retrying.", false),
  "candidate-history-invalid": finishPreserved("CANDIDATE_HISTORY_INVALID", "Inspect the candidate history before continuing.", false),
  "check-changed-candidate": finishPreserved("CHECK_CHANGED_CANDIDATE", "The checker changed the committed candidate. Inspect those changes before retrying.", false),
  "path-set-mismatch": finishPreserved("PATH_SET_MISMATCH", "Change exactly the paths admitted by begin, then retry finish.", true, false),
  "path-set-changed-by-checker": finishPreserved("PATH_SET_MISMATCH", "The checker changed the admitted file set. Inspect the candidate and restore the intended scope before retrying.", true, false),
  "check-failed": checkFailed,
  "rebased-check-failed": checkFailed,
  "format-failed": (facts) => outcome(false, "finish", "FORMAT_FAILED", facts.runId ?? null, "Fix the reported whitespace in the admitted candidate files, then retry finish.", facts.afterRebase ? { ...preserved(facts, true, facts.commit), diagnostics: facts.diagnostics } : { changedState: "partial", sideEffects: ["candidate-worktree-preserved"], worktree: facts.worktree, paths: facts.paths, diagnostics: facts.diagnostics }),
  "integration-busy": finishPreserved("INTEGRATION_BUSY", "Wait for the active finisher to release the local integration lock, then retry.", true, false),
  "canonical-not-ready": finishPreserved("CANONICAL_NOT_READY", "Restore a clean canonical main checkout, then retry finish.", true),
  "main-diverged": finishPreserved("MAIN_DIVERGED", "Preserve the candidate and reconcile canonical main before continuing.", false),
  "semantic-overlap": (facts) => outcome(false, "finish", "SEMANTIC_OVERLAP", facts.runId ?? null, `Resolve the concurrent changes to ${(facts.overlap ?? []).join(", ")} with Nathan.`, preserved(facts, false, facts.commit)),
  "rebase-failed": finishPreserved("REBASE_FAILED", "Preserve the candidate and inspect its relationship to canonical main.", false),
  "rebased-path-set-mismatch": finishPreserved("REBASED_PATH_SET_MISMATCH", "Preserve the candidate and inspect its rebased commit before continuing.", false),
  "integration-unproved": finishPreserved("INTEGRATION_UNPROVED", "Inspect canonical main and the candidate before taking another action.", false),
  "completion-record-failed": (facts) => outcome(false, "finish", "COMPLETION_RECORD_FAILED", facts.runId ?? null, facts.afterFastForward ? "The commit reached main but its receipt could not be saved. Inspect main and the preserved candidate before retrying." : "No note changed but its receipt could not be saved. Preserve the candidate and inspect local state before retrying.", preserved(facts, false, facts.commit)),
  unexpected: unexpectedFailure,
  "preview-not-found": unexpectedFailure,
  "preview-consumed": unexpectedFailure,
  "preview-stale": unexpectedFailure,
  "preview-invalid": unexpectedFailure,
  "recovery-unprovable": unexpectedFailure,
  "input-invalid": (_facts, command) => outcome(false, command, "INVALID_USAGE", null, "Run vault-note-commits --help and use the documented flags.")
};
function unexpectedFailure(facts, command) {
  return outcome(false, command, "UNEXPECTED_FAILURE", facts.runId ?? null, "Preserve any candidate worktree and inspect the local error before retrying.", { retrySafe: false, ...beginCreated(facts) });
}
function checkFailed(facts) {
  return outcome(false, "finish", "CHECK_FAILED", facts.runId ?? null, "Read the private checker diagnostics, fix the admitted files in the candidate, then retry finish.", {
    changedState: "partial",
    sideEffects: ["candidate-worktree-preserved", "checker-diagnostics-written"],
    worktree: facts.worktree,
    paths: facts.paths,
    diagnosticsPath: facts.diagnosticsPath
  });
}
function renderRefusal(command, refusal) {
  return legacyRender[refusal.reason](refusal.facts, command);
}
var observation;
function candidateRoot(rt, vault) {
  const root = stateRoot(rt);
  let resolved;
  try {
    resolved = rt.realpath(root);
  } catch {
    resolved = root;
  }
  return join4(resolved, vaultIdentity(vault));
}
function begin(rt, args) {
  const parsed = flags(args, new Set(["--vault", "--path"]), "begin");
  const vaultValues = parsed.get("--vault") ?? [];
  if (vaultValues.length > 1)
    refuse2("begin", "INVALID_USAGE", null, "Provide --vault at most once.");
  const vault = canonicalVault(rt, vaultValues[0] ?? configuredVault(rt));
  const requested = parsed.get("--path") ?? [];
  if (requested.length === 0)
    refuse2("begin", "INVALID_USAGE", null, "Provide at least one --path.");
  const plan = planCandidate(rt, vault, requested);
  observation = observeGuard(rt, { vault, candidateRoot: candidateRoot(rt, vault), runId: plan.runId });
  const { manifest } = createCandidate(rt, plan);
  return outcome(true, "begin", "CANDIDATE_READY", manifest.runId, "Edit only the admitted paths in the returned worktree, then run finish.", {
    changedState: "partial",
    sideEffects: ["candidate-worktree-created"],
    worktree: manifest.worktree,
    paths: manifest.paths
  });
}
function renderReceipt(rt, worktree, valid) {
  const { receipt, path } = valid;
  return outcome(true, "finish", "ALREADY_COMPLETED", receipt.runId, rt.exists(worktree) ? "Completion is recorded. Inspect the retained candidate before removing it; no new write was performed." : "The original finish completed. No new write was performed.", {
    originalCode: receipt.code,
    worktree,
    commit: receipt.commit,
    paths: receipt.paths,
    receipt: path
  });
}
function renderIntegration(rt, manifest, result, recovered = false) {
  if (result.kind === "receipt")
    return renderReceipt(rt, manifest.worktree, result.receipt);
  const { code, commit, receipt, removed } = result.completion;
  return outcome(true, "finish", code, manifest.runId, removed ? commit ? "Run remote sync separately when you want to publish main." : "No candidate changes were authored. This does not verify the freshness of canonical notes." : "Completion is recorded. Inspect the retained candidate before removing it.", {
    changedState: commit ? "complete" : "none",
    sideEffects: [...commit && !recovered ? ["canonical-main-fast-forwarded"] : [], "completion-reference-written", "completion-receipt-written", ...removed ? ["candidate-worktree-removed"] : []],
    worktree: manifest.worktree,
    commit,
    paths: manifest.paths,
    receipt
  });
}
function knownCandidateCommit(rt, manifest) {
  const head = gitQuiet(rt, manifest.worktree, ["rev-parse", "HEAD"]);
  const sha = head.stdout.trim();
  return head.exitCode === 0 && sha !== manifest.baseCommit ? sha : undefined;
}
function finish(rt, args) {
  const parsed = flags(args, new Set(["--worktree", "--message"]), "finish");
  const worktree = one(parsed, "--worktree", "finish");
  const message = one(parsed, "--message", "finish").trim();
  if (!message || message.includes(`
`))
    refuse2("finish", "INVALID_USAGE", null, "Provide one non-empty commit subject with --message.");
  if (!isAbsolute2(worktree) || resolve2(worktree) !== worktree)
    refuse2("finish", "INVALID_USAGE", null, "Use the exact absolute worktree path returned by begin.");
  const completed = readReceipt(rt, worktree);
  if (completed)
    return renderReceipt(rt, worktree, completed);
  const manifest = readManifest(rt, worktree);
  observation = observeGuard(rt, {
    vault: manifest.vault,
    candidateRoot: candidateRoot(rt, manifest.vault),
    runId: manifest.runId,
    candidateCommit: knownCandidateCommit(rt, manifest),
    facts: { worktree: manifest.worktree, paths: manifest.paths }
  });
  const state = validateCandidate(rt, manifest, message);
  const result = state.kind === "commit" ? integrate(rt, manifest, state.commit) : completeWithoutIntegration(rt, manifest, state.kind === "already-on-main" ? state.commit : undefined);
  return renderIntegration(rt, manifest, result, state.kind === "already-on-main");
}
var usage = `Vault Note Commits

Usage:
  vault-note-commits begin [--vault <path>] --path <relative-path> [--path <relative-path>...] [--json]
  vault-note-commits finish --worktree <path> --message <subject> [--json]

begin creates a detached candidate worktree from local main. finish admits exactly the declared paths,
runs bun run check and Git whitespace checks including new files, creates one commit,
and integrates it into a clean canonical main checkout.
Disjoint candidates rebase onto newer local main; overlapping paths stop for semantic resolution.
Unchanged candidates return NO_CHANGES without a commit. Partially changed declared sets still refuse.
Completion receipts are stored in private XDG state before candidate cleanup. Retry finish with the
same absolute worktree path to recover ALREADY_COMPLETED, originalCode, and the original commit.
Retries perform no new write. A crash before receipt persistence still requires inspection.
Without --vault, begin reads ~/.config/my-second-brain-playground/vault.json (or XDG_CONFIG_HOME).
Remote sync is a separate operation.`;
function runCommand(rt, command, args) {
  if (command === "begin")
    return begin(rt, args);
  if (command === "finish")
    return finish(rt, args);
  return refuse2("help", "INVALID_USAGE", null, "Run vault-note-commits --help.");
}
function failureResult(command, error) {
  const safeCommand = command === "begin" || command === "finish" ? command : "help";
  if (error instanceof LegacyRefusal)
    return error.result;
  if (error instanceof Refusal) {
    if (error.facts.guard)
      observation = error.facts.guard;
    return renderRefusal(safeCommand, error);
  }
  return outcome(false, safeCommand, "UNEXPECTED_FAILURE", null, "Preserve any candidate worktree and inspect the local error before retrying.", { retrySafe: false });
}
function withObservation(result) {
  if (!observation)
    return result;
  const { guard, warnings } = observation;
  result.guard = { installed: guard.installed, current: guard.current, selfTest: guard.selfTest, hookPath: guard.hookPath, branches: guard.branches, worktrees: guard.worktrees };
  if (warnings.length > 0)
    result.warnings = warnings.map((warning) => warning.code);
  return result;
}
function printWarnings() {
  for (const warning of observation?.warnings ?? [])
    console.error(`warning: ${warning.code} ${warning.detail}`);
}
function printFailure(result, json) {
  if (json)
    console.log(JSON.stringify(result));
  else
    console.error(`${result.code}: ${result.nextAction}`);
  if (result.diagnostics?.length)
    console.error(result.diagnostics.join(`
`));
  if (!json)
    printWarnings();
  process.exitCode = 1;
}
function main() {
  const raw = process.argv.slice(2);
  const json = raw.includes("--json");
  const args = raw.filter((argument) => argument !== "--json");
  const command = args.shift();
  if (command === "--help" || command === "-h" || command === undefined) {
    console.log(usage);
    return;
  }
  const faultsAllowed = import.meta.url.endsWith("/src/legacy/main.ts");
  const faults = faultsAllowed ? parseFaults(process.env.VAULT_STEWARD_FAULT) ?? [] : [];
  const rt = withFaults(createRuntime(), faults);
  try {
    const result = withObservation(runCommand(rt, command, args));
    console.log(json ? JSON.stringify(result) : `${result.code}: ${result.nextAction}`);
    if (!json)
      printWarnings();
  } catch (error) {
    printFailure(withObservation(failureResult(command, error)), json);
  }
}
main();
