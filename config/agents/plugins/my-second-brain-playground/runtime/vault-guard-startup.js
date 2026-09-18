// @bun
// packages/vault-steward/src/startup-audit.ts
import { readFileSync } from "fs";
import { join } from "path";
var auditBudgetMs = 2000;
function configuredVault(env) {
  if (!env.HOME)
    return null;
  try {
    const payload = JSON.parse(readFileSync(join(env.HOME, ".config", "my-second-brain-playground", "vault.json"), "utf8"));
    return typeof payload.vault === "string" && payload.vault ? payload.vault : null;
  } catch {
    return null;
  }
}
function declaresAudit(vault) {
  try {
    const manifest = JSON.parse(readFileSync(join(vault, "package.json"), "utf8"));
    return typeof manifest.scripts?.["guard:audit"] === "string";
  } catch {
    return false;
  }
}
function findingIds(stdout) {
  try {
    const envelope = JSON.parse(stdout);
    if (!Array.isArray(envelope.findings))
      return null;
    return envelope.findings.map((finding) => typeof finding?.id === "string" ? finding.id : "unknown");
  } catch {
    return null;
  }
}
function auditLine(env) {
  const vault = configuredVault(env);
  if (vault === null || !declaresAudit(vault))
    return null;
  let stdout;
  try {
    const child = Bun.spawnSync(["bun", "run", "--silent", "guard:audit", "--json"], {
      cwd: vault,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...env, GIT_TERMINAL_PROMPT: "0" },
      timeout: auditBudgetMs,
      killSignal: "SIGKILL"
    });
    if ("exitedDueToTimeout" in child && child.exitedDueToTimeout === true)
      return null;
    stdout = new TextDecoder().decode(child.stdout);
  } catch {
    return null;
  }
  const ids = findingIds(stdout);
  if (ids === null || ids.length === 0)
    return null;
  return `vault-guard: ${ids.length} finding(s) in ${vault}: ${ids.join(", ")} (run 'bun run guard:audit --json' there)`;
}
var line = auditLine(process.env);
if (line !== null)
  console.log(line);
