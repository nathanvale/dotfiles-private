#!/usr/bin/env bun

import { Buffer } from "node:buffer";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createVaultGitRuntimeSelectionFence } from "@side-quest/vault-git-transaction-manager";

import { SETUP_INPUT_CONTRACT_ID, SetupUsageError, parseSetupInvocation, setupCommandDiscovery } from "./command-contract.ts";
import {
  createVaultGitHostEnrollment,
  type VaultGitHostEnrollment,
  type VaultGitHostEnrollmentInput,
  type VaultGitHostEnrollmentResult,
} from "./vault-git-host-enrollment.ts";
import { inspectVaultGitWorkState } from "./vault-git-work-state.ts";

export interface SetupCliRuntime {
  readonly homeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly vaultGitHostEnrollment: VaultGitHostEnrollment;
  readonly readPrivateStdin?: () => Promise<string>;
}

export interface SetupCliOptions {
  readonly runtime?: Partial<SetupCliRuntime>;
  readonly stdout?: { write(value: string): unknown };
  readonly stderr?: { write(value: string): unknown };
}

export function createDefaultRuntime(overrides: Partial<SetupCliRuntime> = {}): SetupCliRuntime {
  const homeDir = overrides.homeDir ?? homedir();
  const env = overrides.env ?? process.env;
  const configRoot = join(env.XDG_CONFIG_HOME ?? join(homeDir, ".config"), "context", "vault-git");
  const dataRoot = join(env.XDG_DATA_HOME ?? join(homeDir, ".local", "share"), "context", "vault-git");
  const stateRoot = env.XDG_STATE_HOME ?? join(homeDir, ".local", "state");
  const sourceRepoRoot = resolve(import.meta.dir, "../../../..");
  return {
    homeDir,
    env,
    vaultGitHostEnrollment: overrides.vaultGitHostEnrollment ?? createVaultGitHostEnrollment({
      configRoot,
      dataRoot,
      selectorPath: join(homeDir, ".bun", "bin", "vault-git"),
      sourceRepoRoot,
      runtimeEntrypoint: join(sourceRepoRoot, ".agents", "runtime", "vault-git-transaction-manager", "src", "cli.ts"),
      inspectWorkState: async () => inspectVaultGitWorkState(stateRoot),
	  runtimeSelectionFence: createVaultGitRuntimeSelectionFence(stateRoot),
    }),
    readPrivateStdin: "readPrivateStdin" in overrides
      ? overrides.readPrivateStdin
      : async () => Bun.stdin.text(),
  };
}

export async function main(argv: readonly string[], options: SetupCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    stdout.write(helpText());
    return 0;
  }
  try {
    const invocation = parseSetupInvocation(argv);
    if (invocation.command === "commands") {
    stdout.write(`${JSON.stringify({ status: "ok", data: setupCommandDiscovery })}\n`);
      return 0;
    }
    const runtime = createDefaultRuntime(options.runtime);
    let result: VaultGitHostEnrollmentResult;
    if (invocation.domain !== "vault-git") result = await runtime.vaultGitHostEnrollment.inspect();
    else if (invocation.rollback) result = await runtime.vaultGitHostEnrollment.rollback(invocation.check);
    else if (invocation.inputStdin) {
      const input = await readVaultGitHostEnrollmentInput(runtime);
      result = invocation.check ? await runtime.vaultGitHostEnrollment.preview(input) : await runtime.vaultGitHostEnrollment.apply(input);
    } else result = await runtime.vaultGitHostEnrollment.inspect();
    const data = projectResult(result);
    if (invocation.json) stdout.write(`${JSON.stringify({ status: "ok", data })}\n`);
    else stdout.write(renderPlain(data));
    return exitCode(result);
  } catch (error) {
    const message = error instanceof SetupUsageError ? error.message : "Setup runtime failed";
    if (argv.includes("--json")) stdout.write(`${JSON.stringify({ status: "error", error: { code: error instanceof SetupUsageError ? "invalid_usage" : "runtime_failure", message } })}\n`);
    else stderr.write(`${message}\n`);
    return error instanceof SetupUsageError ? 2 : 1;
  }
}

function projectResult(result: VaultGitHostEnrollmentResult) {
  const nextAction = "nextAction" in result ? result.nextAction.actionId : "setup_healthy";
  const state = result.state === "ready" || result.state === "changes" ? "changes"
    : result.state === "needs_human" || result.state === "blocked" ? "blocked"
    : result.state === "not_enrolled" ? "clean_slate" : result.state;
  const station = result.station === "vault_git.host_enrollment_inputs_required" ? "sync.vault_git_inputs_required"
    : result.station === "vault_git.repository_ssh_prerequisite" ? "sync.vault_git_ssh_prerequisite"
    : result.station === "vault_git.host_enrollment_ready" ? "sync.vault_git_enrollment_ready"
    : result.station === "vault_git.runtime_selection_blocked" ? "sync.vault_git_selection_blocked"
    : result.station === "vault_git.rollback_ready" ? "sync.vault_git_rollback_ready"
    : result.station === "vault_git.rollback_applied" ? "sync.vault_git_rollback_applied"
    : result.station === "vault_git.rollback_blocked" ? "sync.vault_git_rollback_blocked"
    : "sync.vault_git_selected";
  return { command: "sync", scope: "user", state, station, next_action: nextAction, vault_git: result };
}

function exitCode(result: VaultGitHostEnrollmentResult): 0 | 1 {
  return result.state === "needs_human" || result.state === "ready" || result.state === "blocked" || result.state === "changes" ? 1 : 0;
}

function renderPlain(data: ReturnType<typeof projectResult>): string {
  return `Setup ${data.state}: ${data.station}\nNext action: ${data.next_action}\n`;
}

async function readVaultGitHostEnrollmentInput(runtime: SetupCliRuntime): Promise<VaultGitHostEnrollmentInput> {
  if (!runtime.readPrivateStdin) throw new SetupUsageError("Private Host Enrollment input is unavailable");
  const source = await runtime.readPrivateStdin();
  if (Buffer.byteLength(source, "utf8") > 16_384) throw new SetupUsageError("Private Host Enrollment input exceeds the 16,384-byte limit");
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new SetupUsageError("Private Host Enrollment input must be JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SetupUsageError("Private Host Enrollment input must be an object");
  const record = value as Record<string, unknown>;
  const expected = ["ssh_identity_file_path", "ssh_known_hosts_path", "ssh_public_key_path"];
  if (Object.keys(record).sort().join("\0") !== expected.join("\0") || !expected.every((key) => typeof record[key] === "string")) {
    throw new SetupUsageError("Private Host Enrollment input fields are invalid");
  }
  const paths = expected.map((key) => record[key] as string);
  if (paths.some((path) => path.includes("\n") || path.includes("\r") || path.length === 0)) throw new SetupUsageError("Private Host Enrollment input fields are invalid");
  return {
    sshIdentityFilePath: record.ssh_identity_file_path as string,
    sshPublicKeyPath: record.ssh_public_key_path as string,
    sshKnownHostsPath: record.ssh_known_hosts_path as string,
  };
}

function helpText(): string {
  return [
    `Usage: setup sync [--domain vault-git] [--check] [--rollback] [--input-stdin ${SETUP_INPUT_CONTRACT_ID}] [--json]`,
    "       setup commands --json",
    "",
  ].join("\n");
}

if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2));
  process.exitCode = exitCode;
}
